"""Watch for new devices: now and then, scan the networks you picked and tell you about addresses
HaRM doesn't know yet (a new phone, a guest's laptop, something plugged in that shouldn't be).

Only the networks ticked in Settings are scanned, so a guest Wi-Fi can be left out. The first scan
after turning it on (or changing the networks) only learns what's there; later scans list and
alert about what's new. A device is known when one of its interfaces has that MAC or IP.
"""

import asyncio
import json
import time
from datetime import datetime, timezone

from . import alerts, db, discover

DEFAULTS = {"enabled": False, "networks": [], "interval": 30, "alert": True, "baseline_at": None, "last_scan": None,
            "last_error": None}
INTERVALS = (15, 30, 60, 120, 360)
_lock = asyncio.Lock()
_last = 0.0


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def config(conn) -> dict:
    try:
        saved = json.loads(db.get_meta(conn, "netwatch") or "{}")
    except ValueError:
        saved = {}
    return {**DEFAULTS, **{k: v for k, v in saved.items() if k in DEFAULTS}}


def _store(conn, conf: dict) -> None:
    db.set_meta(conn, "netwatch", json.dumps(conf))


def save(conn, body: dict) -> dict:
    cur = config(conn)
    new = dict(cur)
    if "enabled" in body:
        new["enabled"] = bool(body["enabled"])
    if "alert" in body:
        new["alert"] = bool(body["alert"])
    if "interval" in body:
        new["interval"] = int(body["interval"])
        if new["interval"] not in INTERVALS:
            raise ValueError("Scan every 15, 30, 60, 120 or 360 minutes")
    if "networks" in body:
        ids = sorted({int(x) for x in body["networks"] or []})
        for nid in ids:
            r = conn.execute("SELECT name, cidr FROM networks WHERE id = ?", (nid,)).fetchone()
            if not r:
                raise ValueError("That network no longer exists")
            if not r["cidr"]:
                raise ValueError(f"“{r['name']}” has no address range (like 192.168.1.0/24). Add one on its page first")
            try:
                discover.check_range(r["cidr"])
            except discover.DiscoverError as e:
                raise ValueError(f"“{r['name']}”: {e}")
        new["networks"] = ids
    if new["enabled"] and not new["networks"]:
        raise ValueError("Pick at least one network to watch")
    if new["enabled"] and (not cur["enabled"] or new["networks"] != cur["networks"]):
        new["baseline_at"] = None  # the next scan only learns what's there
    _store(conn, new)
    return new


def _known(conn) -> tuple[set, set]:
    macs, ips = set(), set()
    for r in conn.execute("SELECT ip, mac FROM interfaces"):
        if r["mac"]:
            macs.add(discover.norm_mac(r["mac"]))
        if r["ip"]:
            ips.add(r["ip"].split("/")[0])
    try:
        ignored = set(json.loads(db.get_meta(conn, "discover_ignored") or "[]"))
    except ValueError:
        ignored = set()
    return macs | {i for i in ignored if ":" in i}, ips | {i for i in ignored if ":" not in i}


async def scan_now() -> dict:
    """Scan the watched networks once. Returns what's new this time."""
    global _last
    async with _lock:
        conn = db.connect()
        try:
            conf = config(conn)
            nets = [dict(r) for r in conn.execute(
                f"SELECT id, name, cidr FROM networks WHERE id IN ({','.join('?' * len(conf['networks'])) or 'NULL'})",
                conf["networks"])]
        finally:
            conn.close()
        found, errors = [], []
        for n in nets:
            try:
                out = await discover.scan(n["cidr"])
                found += [{**h, "network_id": n["id"], "network": n["name"]} for h in out["hosts"]]
            except Exception as e:  # one bad network shouldn't stop the others
                errors.append(f"{n['name']}: {e}")
        _last = time.monotonic()
        conn = db.connect()
        try:
            conf = config(conn)
            baseline = conf["baseline_at"] is None
            macs, ips = _known(conn)
            now, new = _now(), []
            for h in found:
                mac = discover.norm_mac(h.get("mac")) if h.get("mac") else None
                if (mac and mac in macs) or h["ip"] in ips:
                    continue
                key = mac or h["ip"]
                row = conn.execute("SELECT id, status FROM net_seen WHERE key = ?", (key,)).fetchone()
                if row:
                    conn.execute("UPDATE net_seen SET ip = ?, hostname = COALESCE(?, hostname), last_seen = ? WHERE id = ?",
                                 (h["ip"], h.get("hostname"), now, row["id"]))
                    continue
                cur = conn.execute("INSERT INTO net_seen (key, ip, mac, hostname, network_id, status, first_seen, last_seen) "
                                   "VALUES (?,?,?,?,?,?,?,?)", (key, h["ip"], mac, h.get("hostname"), h["network_id"],
                                                                "seen" if baseline else "new", now, now))
                if not baseline:
                    new.append({"id": cur.lastrowid, "ip": h["ip"], "mac": mac, "hostname": h.get("hostname"), "network": h["network"]})
            conf.update(last_scan=now, last_error="; ".join(errors) or None, baseline_at=conf["baseline_at"] or now)
            _store(conn, conf)
            conn.commit()
            send = conf["alert"] and new
        finally:
            conn.close()
        if send:
            await asyncio.to_thread(alerts.deliver, [{
                "kind": "new_device", "state": "new", "address": n["ip"],
                "title": f"New on {n['network']}: {n['hostname'] or n['ip']}",
                "message": ", ".join(x for x in (n["ip"], n["mac"], n["hostname"]) if x)
                + ". Add it or ignore it on HaRM's Status page."} for n in new])
        return {"new": new, "baseline": baseline, "errors": errors}


def pending(conn) -> list[dict]:
    """New devices waiting for you to add or ignore them (ones added since are dropped)."""
    macs, ips = _known(conn)
    out = []
    for r in conn.execute("SELECT s.*, n.name AS network FROM net_seen s LEFT JOIN networks n ON n.id = s.network_id "
                          "WHERE s.status = 'new' ORDER BY s.first_seen DESC"):
        if (r["mac"] and r["mac"] in macs) or r["ip"] in ips:
            conn.execute("UPDATE net_seen SET status = 'added' WHERE id = ?", (r["id"],))
            continue
        out.append(dict(r))
    conn.commit()
    return out


def mark(conn, sid: int, status: str) -> None:
    if status not in ("ignored", "added", "seen"):
        raise ValueError("status must be ignored, added or seen")
    if not conn.execute("UPDATE net_seen SET status = ? WHERE id = ?", (status, sid)).rowcount:
        raise LookupError("That device is no longer in the list")


async def run_forever() -> None:
    await asyncio.sleep(20)
    while True:
        try:
            conn = db.connect()
            try:
                conf = config(conn)
            finally:
                conn.close()
            if conf["enabled"] and conf["networks"] and (not _last or time.monotonic() - _last >= conf["interval"] * 60):
                await scan_now()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"new-device watch failed: {e}")
        await asyncio.sleep(60)
