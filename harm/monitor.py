"""Online checks: does each device answer on its addresses? Plus Wake-on-LAN.

A check knocks on a few TCP ports at once (the device's own services first, then common ones).
Any answer counts, even "connection refused", because only a running machine can refuse. If no
port answers, it falls back to one ping. Only the addresses recorded in HaRM are contacted.

Devices are checked when they're hooked up, not retired or sold, and "Check if it's online" is
on. The server checks every few minutes (Settings > Status), and more often while the Status
page is open. Each state change is kept for 30 days, for the history strip.

Services (a device's Network tab) are checked too, once their device answers: a web address must
send any HTTP reply below 500, and a port must accept the connection. After each check, alerts.py
sends the alerts that are due.
"""

import asyncio
import ipaddress
import json
import os
import re
import shutil
import socket
import ssl
import subprocess
import urllib.error
import urllib.parse
import urllib.request
import sys
import time
from datetime import datetime, timedelta, timezone

from . import alerts, db
from .models import iface_order

COMMON_PORTS = (22, 443, 80, 3389, 8006, 445, 8080)
MAX_PORTS = 7
MAX_ADDRESSES = 4  # per device: the main address and up to 3 more (iLO, iDRAC, a second NIC…)
TCP_TIMEOUT = 1.5
PARALLEL = 24
DEFAULT_INTERVAL = 5  # minutes
HISTORY_DAYS = 30
_NO_WINDOW = 0x08000000 if os.name == "nt" else 0  # don't flash a console window on Windows

_full_lock = asyncio.Lock()
_last_full = 0.0  # time.monotonic() of the last full check
_last_prune = 0.0
_sending: set = set()  # alert deliveries in flight (kept so they aren't garbage collected)
HTTP_TIMEOUT = 6


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")  # UTC, like created_at


def _parse(ts: str) -> datetime:
    return datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)


# Settings that apply on every device. The old environment settings still pick the defaults.
IDLE_MINUTES_DEFAULT = int(os.environ.get("HARM_IDLE_MINUTES", "30"))
SESSION_HOURS_DEFAULT = int(os.environ.get("HARM_MAX_SESSION_HOURS", "12"))
BACKUP_KEEP_DEFAULT = int(os.environ.get("HARM_BACKUP_KEEP", "14"))
CHOICES = {
    "idle_minutes": (5, 10, 15, 30, 60, 120, 240, 480, 0),  # 0: only when locked by hand (or the session limit)
    "session_hours": (4, 8, 12, 24, 72, 168),
    "backup_keep": (7, 14, 30, 90),
    "start_page": ("dashboard", "status", "devices", "tasks", "racks", "last"),
}


def settings(conn) -> dict:
    try:
        conf = json.loads(db.get_meta(conn, "app_settings") or "{}")
    except ValueError:
        conf = {}
    return {"status_interval": int(conf.get("status_interval", DEFAULT_INTERVAL)),
            "update_check": bool(conf.get("update_check", False)),
            "ai_enabled": bool(conf.get("ai_enabled", True)),
            "currency": str(conf.get("currency") or "USD"),
            "idle_minutes": int(conf.get("idle_minutes", IDLE_MINUTES_DEFAULT)),
            "session_hours": int(conf.get("session_hours", SESSION_HOURS_DEFAULT)),
            "backup_keep": int(conf.get("backup_keep", BACKUP_KEEP_DEFAULT)),
            "start_page": str(conf.get("start_page") or "dashboard")}


def save_settings(conn, changes: dict) -> dict:
    cur = settings(conn)
    if "status_interval" in changes:
        v = int(changes["status_interval"])
        if v not in (0, 1, 2, 5, 10, 15, 30, 60):
            raise ValueError("Check every 1, 2, 5, 10, 15, 30 or 60 minutes, or 0 for never")
        cur["status_interval"] = v
    if "update_check" in changes:
        cur["update_check"] = bool(changes["update_check"])
    if "ai_enabled" in changes:
        cur["ai_enabled"] = bool(changes["ai_enabled"])
    if "currency" in changes:
        v = str(changes["currency"]).strip().upper()
        if not re.fullmatch(r"[A-Z]{3}", v):
            raise ValueError("Currency: a three-letter code like USD, EUR or GBP")
        cur["currency"] = v
    for k, ok in CHOICES.items():
        if k in changes:
            v = changes[k] if k == "start_page" else int(changes[k])
            if v not in ok:
                raise ValueError(f"{k}: one of {', '.join(str(x) for x in ok)}")
            cur[k] = v
    db.set_meta(conn, "app_settings", json.dumps(cur))
    return cur


# --------------------------------------------------------------------------- probing

def _host(ip: str) -> str | None:
    """'10.0.0.5/24' → '10.0.0.5'; None for anything that isn't an address."""
    try:
        return str(ipaddress.ip_interface(ip.strip()).ip)
    except ValueError:
        return None


async def _tcp(host: str, port: int):
    t0 = time.monotonic()
    try:
        _r, w = await asyncio.wait_for(asyncio.open_connection(host, port), TCP_TIMEOUT)
        w.close()
        try:
            await w.wait_closed()
        except Exception:
            pass
    except ConnectionRefusedError:
        pass  # refused still means a machine answered
    except (asyncio.TimeoutError, OSError):
        return None
    return round((time.monotonic() - t0) * 1000, 1), f"port {port}"


async def _any_port(host: str, ports) -> tuple | None:
    tasks = [asyncio.ensure_future(_tcp(host, p)) for p in ports]
    try:
        for fut in asyncio.as_completed(tasks):
            r = await fut
            if r:
                return r
        return None
    finally:
        for t in tasks:
            t.cancel()


def _ping_sync(host: str) -> tuple | None:
    exe = shutil.which("ping")
    if not exe:
        return None
    if os.name == "nt":
        args = [exe, "-n", "1", "-w", "1000", host]
    elif sys.platform == "darwin":
        args = [exe, "-c", "1", "-t", "1", host]
    else:
        args = [exe, "-c", "1", "-W", "1", host]
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=4, stdin=subprocess.DEVNULL,
                           creationflags=_NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired):
        return None
    out = p.stdout or ""
    # Windows ping exits 0 for "Destination host unreachable" from the router; a real reply has a TTL.
    if p.returncode != 0 or (os.name == "nt" and "TTL=" not in out.upper()):
        return None
    m = re.search(r"time[=<]\s*([\d.]+)\s*ms", out)
    return (float(m.group(1)) if m else None), "ping"


async def probe(host: str, ports=COMMON_PORTS) -> dict:
    r = await _any_port(host, ports)
    if not r:
        r = await asyncio.to_thread(_ping_sync, host)
    if r:
        return {"state": "up", "latency_ms": r[0], "method": r[1]}
    return {"state": "down", "latency_ms": None, "method": None}


# --------------------------------------------------------------------------- which devices

_WATCHED = "d.watch = 1 AND d.connected = 1 AND COALESCE(d.status, '') NOT IN ('Retired', 'Sold')"


def targets(conn, device_id: int | None = None) -> dict[int, dict]:
    """{device id: {addresses: [...main first], ports: [...]}} for the devices that get checked."""
    where = _WATCHED + (" AND d.id = ?" if device_id else "")
    rows = conn.execute(
        f"SELECT d.id, i.ip FROM devices d JOIN interfaces i ON i.device_id = d.id "
        f"WHERE {where} AND i.ip IS NOT NULL AND i.ip != '' ORDER BY d.id, {iface_order('i')}",
        (device_id,) if device_id else ()).fetchall()
    out: dict[int, dict] = {}
    for r in rows:
        ip = _host(r["ip"])
        t = out.setdefault(r["id"], {"addresses": [], "ports": []})
        if ip and ip not in t["addresses"] and len(t["addresses"]) < MAX_ADDRESSES:
            t["addresses"].append(ip)
    svc = conn.execute("SELECT device_id, port FROM services WHERE port BETWEEN 1 AND 65535 "
                       "AND UPPER(COALESCE(protocol, 'TCP')) NOT IN ('UDP', 'SNMP') ORDER BY id").fetchall()
    for r in svc:
        t = out.get(r["device_id"])
        if t and r["port"] not in t["ports"] and len(t["ports"]) < 4:
            t["ports"].append(r["port"])
    for t in out.values():
        t["ports"] = (t["ports"] + [p for p in COMMON_PORTS if p not in t["ports"]])[:MAX_PORTS]
    return {k: v for k, v in out.items() if v["addresses"]}


_SVC_SKIP = ("UDP", "SNMP")


def service_targets(conn, device_ids) -> list[dict]:
    """The services to check: running (or no status), with a web address or a TCP port."""
    if not device_ids:
        return []
    ids = list(device_ids)
    rows = conn.execute(
        f"SELECT id, device_id, name, protocol, port, url FROM services WHERE device_id IN ({','.join('?' * len(ids))}) "
        "AND COALESCE(status, '') IN ('', 'Running') ORDER BY device_id, id", ids).fetchall()
    out = []
    for r in rows:
        url = (r["url"] or "").strip()
        if re.match(r"^https?://", url, re.I):
            out.append({**dict(r), "how": "http", "url": url})
        elif r["port"] and 0 < r["port"] < 65536 and (r["protocol"] or "TCP").upper() not in _SVC_SKIP:
            out.append({**dict(r), "how": "tcp"})
    return out


def _why(reason) -> str:
    """A web check's failure in plain words."""
    if isinstance(reason, ConnectionRefusedError):
        return "connection refused"
    if isinstance(reason, (socket.timeout, TimeoutError)) or "timed out" in str(reason):
        return "no answer"
    if isinstance(reason, socket.gaierror):
        return "name not found"
    if isinstance(reason, ssl.SSLError):
        return "the secure connection failed"
    if isinstance(reason, OSError) and reason.strerror:
        return reason.strerror.lower()
    return str(reason)[:200]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **kw):
        return None  # a redirect is an answer; don't follow it


def _http_sync(url: str) -> dict:
    """Any HTTP reply below 500 counts: a login page, 401 or 404 still means the service is there.
    Certificates aren't checked here (home-lab services usually have their own)."""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=ctx), _NoRedirect)
    t0 = time.monotonic()
    try:
        r = opener.open(urllib.request.Request(url, headers={"User-Agent": "Zoms-HaRM status check"}), timeout=HTTP_TIMEOUT)
        code = r.status
        r.close()
    except urllib.error.HTTPError as e:
        code = e.code
    except (urllib.error.URLError, OSError, ValueError) as e:
        return {"state": "down", "code": None, "latency_ms": None, "detail": _why(getattr(e, "reason", e))}
    ms = round((time.monotonic() - t0) * 1000, 1)
    if code >= 500:
        return {"state": "down", "code": code, "latency_ms": ms, "detail": f"HTTP {code}"}
    return {"state": "up", "code": code, "latency_ms": ms, "detail": f"HTTP {code}",
            "cert_expires": _cert_expiry(url) if url.lower().startswith("https://") else None}


def _cert_expiry(url: str) -> str | None:
    """The date (YYYY-MM-DD, UTC) the service's certificate runs out, whoever issued it."""
    from cryptography import x509
    u = urllib.parse.urlsplit(url)
    host, port = u.hostname, u.port or 443
    if not host:
        return None
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        ipaddress.ip_address(host)
        sni = None
    except ValueError:
        sni = host
    try:
        with socket.create_connection((host, port), timeout=HTTP_TIMEOUT) as raw, ctx.wrap_socket(raw, server_hostname=sni) as tls:
            der = tls.getpeercert(binary_form=True)
        return x509.load_der_x509_certificate(der).not_valid_after_utc.strftime("%Y-%m-%d") if der else None
    except (OSError, ValueError):
        return None


async def _port_open(host: str, port: int) -> dict:
    t0 = time.monotonic()
    try:
        _r, w = await asyncio.wait_for(asyncio.open_connection(host, port), TCP_TIMEOUT * 2)
        w.close()
        try:
            await w.wait_closed()
        except Exception:
            pass
    except ConnectionRefusedError:
        return {"state": "down", "code": None, "latency_ms": None, "detail": f"port {port} refused the connection"}
    except (asyncio.TimeoutError, OSError):
        return {"state": "down", "code": None, "latency_ms": None, "detail": f"no answer on port {port}"}
    return {"state": "up", "code": None, "latency_ms": round((time.monotonic() - t0) * 1000, 1), "detail": f"port {port}"}


async def check_service(svc: dict, host: str | None) -> dict:
    if svc["how"] == "http":
        return await asyncio.to_thread(_http_sync, svc["url"])
    if not host:
        return {"state": "unknown", "code": None, "latency_ms": None, "detail": "the device has no address"}
    return await _port_open(host, svc["port"])


def _record_service(conn, svc: dict, res: dict) -> None:
    now = _now()
    prev = conn.execute("SELECT state, cert_expires FROM service_status WHERE service_id = ?", (svc["id"],)).fetchone()
    cert = res.get("cert_expires") or (prev["cert_expires"] if prev and res["state"] != "up" else None)
    if prev and prev["state"] == res["state"]:
        conn.execute("UPDATE service_status SET code = ?, latency_ms = ?, detail = ?, checked_at = ?, cert_expires = ? WHERE service_id = ?",
                     (res["code"], res["latency_ms"], res["detail"], now, cert, svc["id"]))
        return
    if prev:
        conn.execute("UPDATE service_status SET state = ?, code = ?, latency_ms = ?, detail = ?, checked_at = ?, changed_at = ?, "
                     "cert_expires = ? WHERE service_id = ?",
                     (res["state"], res["code"], res["latency_ms"], res["detail"], now, now, cert, svc["id"]))
    else:
        conn.execute("INSERT INTO service_status (service_id, device_id, state, code, latency_ms, detail, checked_at, changed_at, "
                     "cert_expires) VALUES (?,?,?,?,?,?,?,?,?)", (svc["id"], svc["device_id"], res["state"], res["code"],
                                                                  res["latency_ms"], res["detail"], now, now, cert))
    if res["state"] in ("up", "down"):  # history for the uptime report ("unknown" isn't a state of the service)
        conn.execute("INSERT INTO service_events (service_id, state, at) VALUES (?,?,?)", (svc["id"], res["state"], now))


def _record(conn, device_id: int, results: dict[str, dict]) -> list[dict]:
    """Save a device's results; return the addresses whose state changed."""
    now = _now()
    changed = []
    old = {r["address"]: dict(r) for r in conn.execute(
        "SELECT * FROM device_status WHERE device_id = ?", (device_id,))}
    for addr, res in results.items():
        prev = old.get(addr)
        if prev and prev["state"] == res["state"]:
            conn.execute("UPDATE device_status SET latency_ms = ?, method = ?, checked_at = ? "
                         "WHERE device_id = ? AND address = ?",
                         (res["latency_ms"], res["method"], now, device_id, addr))
            continue
        conn.execute("INSERT OR REPLACE INTO device_status (device_id, address, state, latency_ms, method, "
                     "checked_at, changed_at) VALUES (?,?,?,?,?,?,?)",
                     (device_id, addr, res["state"], res["latency_ms"], res["method"], now, now))
        conn.execute("INSERT INTO status_events (device_id, address, state, at) VALUES (?,?,?,?)",
                     (device_id, addr, res["state"], now))
        if prev:
            changed.append({"device_id": device_id, "address": addr, "state": res["state"]})
    gone = [a for a in old if a not in results]
    for a in gone:  # an address was removed or changed
        conn.execute("DELETE FROM device_status WHERE device_id = ? AND address = ?", (device_id, a))
    return changed


async def check(device_id: int | None = None) -> list[dict]:
    """Check one device, or every watched device. Returns the state changes."""
    global _last_full
    conn = db.connect()
    try:
        todo = targets(conn, device_id)
    finally:
        conn.close()
    sem = asyncio.Semaphore(PARALLEL)

    async def one(addr, ports):
        async with sem:
            return await probe(addr, ports)

    async def run():
        jobs = {(did, a): asyncio.ensure_future(one(a, t["ports"])) for did, t in todo.items() for a in t["addresses"]}
        if jobs:
            await asyncio.wait(jobs.values())
        results: dict[int, dict] = {}
        for (did, a), fut in jobs.items():
            results.setdefault(did, {})[a] = fut.result()
        # Services, for devices whose main address answered (a machine that's off has no services).
        conn = db.connect()
        try:
            svcs = service_targets(conn, todo)
        finally:
            conn.close()

        async def svc_one(svc):
            t = todo[svc["device_id"]]
            main = t["addresses"][0]
            if results[svc["device_id"]][main]["state"] != "up":
                return svc, {"state": "unknown", "code": None, "latency_ms": None, "detail": "the device isn't answering"}
            async with sem:
                return svc, await check_service(svc, main)

        svc_results = await asyncio.gather(*(svc_one(x) for x in svcs))
        conn = db.connect()
        try:
            changes = []
            for did, res in results.items():
                changes += _record(conn, did, res)
            for svc, res in svc_results:
                _record_service(conn, svc, res)
            if device_id is None:  # devices no longer watched keep no stale "Online"
                ids = list(todo) or [0]
                conn.execute(f"DELETE FROM device_status WHERE device_id NOT IN ({','.join('?' * len(ids))})", ids)
                sids = [x["id"] for x in svcs] or [0]
                conn.execute(f"DELETE FROM service_status WHERE service_id NOT IN ({','.join('?' * len(sids))})", sids)
            else:
                sids = [x["id"] for x in svcs] or [0]
                conn.execute(f"DELETE FROM service_status WHERE device_id = ? AND service_id NOT IN ({','.join('?' * len(sids))})",
                             [device_id, *sids])
            events = alerts.due(conn)
            conn.commit()
        finally:
            conn.close()
        if events:  # sent in the background, so a slow mail server never holds up the checks
            task = asyncio.ensure_future(asyncio.to_thread(alerts.deliver, events))
            _sending.add(task)
            task.add_done_callback(_sending.discard)
        return changes

    if device_id is not None:
        return await run()
    async with _full_lock:
        changes = await run()
        _last_full = time.monotonic()
        return changes


def seconds_since_full() -> float:
    return time.monotonic() - _last_full if _last_full else float("inf")


async def check_if_older(max_age: float) -> bool:
    """A full check, unless one finished less than max_age seconds ago (or one is running)."""
    if _full_lock.locked() or seconds_since_full() < max_age:
        return False
    await check()
    return True


def prune(conn) -> None:
    old = (datetime.now(timezone.utc) - timedelta(days=HISTORY_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
    conn.execute("DELETE FROM status_events WHERE at < ?", (old,))
    conn.execute("DELETE FROM service_events WHERE at < ?", (old,))


async def run_forever() -> None:
    """The background checker. Reads the interval each time, so a change in Settings applies at once."""
    global _last_prune
    await asyncio.sleep(5)
    while True:
        try:
            conn = db.connect()
            try:
                mins = settings(conn)["status_interval"]
                if time.monotonic() - _last_prune > 3600:
                    prune(conn)
                    conn.commit()
                    _last_prune = time.monotonic()
            finally:
                conn.close()
            if mins and seconds_since_full() >= mins * 60 - 5:
                await check()
            await asyncio.to_thread(alerts.flush_held)  # quiet hours over: send what was held
        except asyncio.CancelledError:
            raise
        except Exception as e:  # never take the app down over a check
            print(f"online check failed: {e}")
        await asyncio.sleep(15)


# --------------------------------------------------------------------------- reading it back

def _strip(events: list[dict], before: str | None, now: datetime, hours: int = 24) -> tuple[list, float | None]:
    """24 hourly buckets ('up', 'down', 'mixed' or None) and the share of known time that was up."""
    start = now - timedelta(hours=hours)
    state = before
    timeline = [(start, state)] + [(_parse(e["at"]), e["state"]) for e in events]
    buckets, up_s, known_s = [], 0.0, 0.0
    for b in range(hours):
        b0, b1 = start + timedelta(hours=b), start + timedelta(hours=b + 1)
        seen = set()
        for i, (t, st) in enumerate(timeline):
            t_end = timeline[i + 1][0] if i + 1 < len(timeline) else now
            lo, hi = max(t, b0), min(t_end, b1)
            if hi <= lo:
                continue
            seen.add(st)
            if st:
                known_s += (hi - lo).total_seconds()
                if st == "up":
                    up_s += (hi - lo).total_seconds()
        seen.discard(None)
        buckets.append(None if not seen else seen.pop() if len(seen) == 1 else "mixed")
    return buckets, (round(up_s / known_s, 4) if known_s else None)


def history(conn, device_id: int, address: str) -> tuple[list, float | None]:
    now = datetime.now(timezone.utc)
    since = (now - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
    before = conn.execute("SELECT state FROM status_events WHERE device_id = ? AND address = ? AND at < ? "
                          "ORDER BY at DESC, id DESC LIMIT 1", (device_id, address, since)).fetchone()
    events = [dict(r) for r in conn.execute(
        "SELECT state, at FROM status_events WHERE device_id = ? AND address = ? AND at >= ? ORDER BY at, id",
        (device_id, address, since))]
    return _strip(events, before["state"] if before else None, now)


def watched(dev: dict) -> bool:
    return bool(dev.get("watch")) and bool(dev.get("connected")) and dev.get("status") not in ("Retired", "Sold")


def device_state(conn, dev: dict, with_history: bool = True) -> dict:
    """The device's online state: its main address first, then the others (management ports…)."""
    addrs = [dict(r) for r in conn.execute(
        f"SELECT ip, name, kind FROM interfaces WHERE device_id = ? AND ip IS NOT NULL AND ip != '' "
        f"ORDER BY {iface_order()}", (dev["id"],))]
    status = {r["address"]: dict(r) for r in conn.execute("SELECT * FROM device_status WHERE device_id = ?", (dev["id"],))}
    seen, rows = set(), []
    for a in addrs:
        ip = _host(a["ip"])
        if not ip or ip in seen or len(rows) >= MAX_ADDRESSES:
            continue
        seen.add(ip)
        st = status.get(ip)
        mgmt = a["kind"] == "IPMI / BMC" or bool(re.search(r"idrac|ilo|ipmi|bmc|mgmt|management", a["name"] or "", re.I))
        rows.append({"address": ip, "label": a["name"] or "", "management": mgmt,
                     "state": st["state"] if st else "unknown", "latency_ms": st["latency_ms"] if st else None,
                     "method": st["method"] if st else None, "checked_at": st["checked_at"] if st else None,
                     "since": st["changed_at"] if st else None})
    main = rows[0] if rows else None
    if not rows:
        state = "no-address"
    elif not watched(dev):
        state = "off" if not dev.get("connected") or dev.get("status") in ("Retired", "Sold") else "unwatched"
    else:
        state = main["state"]
    services = [dict(r) for r in conn.execute(
        "SELECT s.id, s.name, s.url, s.port, st.state, st.code, st.latency_ms, st.detail, st.checked_at, st.changed_at AS since, "
        "st.cert_expires "
        "FROM service_status st JOIN services s ON s.id = st.service_id WHERE st.device_id = ? ORDER BY s.name", (dev["id"],))]
    out = {"state": state, "address": main["address"] if main else None, "services": services if state in ("up", "down") else [],
           "latency_ms": main["latency_ms"] if main else None, "since": main["since"] if main else None,
           "checked_at": main["checked_at"] if main else None, "method": main["method"] if main else None,
           "others": rows[1:] if state not in ("off", "unwatched") else [], "strip": None, "uptime": None}
    if with_history and main and state in ("up", "down"):
        out["strip"], out["uptime"] = history(conn, dev["id"], main["address"])
    return out


def offline(conn) -> list[dict]:
    """Watched devices whose main address isn't answering, for Home's "Needs attention"."""
    out = []
    for d in conn.execute(f"SELECT d.id, d.name, d.watch, d.connected, d.status FROM devices d WHERE {_WATCHED} "
                          "AND EXISTS (SELECT 1 FROM device_status s WHERE s.device_id = d.id AND s.state = 'down') "
                          "ORDER BY d.name").fetchall():
        st = device_state(conn, dict(d), with_history=False)
        if st["state"] == "down":
            out.append({"id": d["id"], "label": d["name"], "address": st["address"], "since": st["since"]})
    return out


def services_down(conn) -> list[dict]:
    """Services that stopped answering on a device that does answer, for Home's "Needs attention"."""
    return [dict(r) for r in conn.execute(
        f"SELECT s.id, s.name, d.id AS device_id, d.name AS device_name, st.detail, st.changed_at AS since "
        f"FROM service_status st JOIN services s ON s.id = st.service_id JOIN devices d ON d.id = st.device_id "
        f"WHERE st.state = 'down' AND {_WATCHED} ORDER BY d.name, s.name")]


def certs_expiring(conn, days: int = 30) -> list[dict]:
    """HTTPS services whose certificate runs out within `days` (or already has)."""
    until = (datetime.now(timezone.utc) + timedelta(days=days)).strftime("%Y-%m-%d")
    return [dict(r) for r in conn.execute(
        "SELECT s.id, s.name, s.url, d.id AS device_id, d.name AS device_name, st.cert_expires "
        "FROM service_status st JOIN services s ON s.id = st.service_id JOIN devices d ON d.id = st.device_id "
        "WHERE st.cert_expires IS NOT NULL AND st.cert_expires <= ? ORDER BY st.cert_expires", (until,))]


# --------------------------------------------------------------------------- the uptime report

def _uptime(events: list, before: str | None, start: datetime, now: datetime) -> dict:
    """Seconds up and down in [start, now], outages that started in it, and the longest one."""
    timeline = [(start, before)] + [(_parse(at), st) for st, at in events]
    up = down = longest = 0.0
    outages = 0
    run = 0.0
    for i, (t, st) in enumerate(timeline):
        end = timeline[i + 1][0] if i + 1 < len(timeline) else now
        secs = max(0.0, (end - t).total_seconds())
        if st == "down":
            down += secs
            run += secs
            if i == 0 or timeline[i - 1][1] != "down":
                outages += 1
            longest = max(longest, run)
        else:
            run = 0.0
            if st == "up":
                up += secs
    known = up + down
    return {"uptime": round(up / known, 5) if known else None, "outages": outages,
            "down_s": int(down), "longest_s": int(longest), "known_s": int(known)}


def report(conn, days: int) -> dict:
    """Uptime over the last `days` days for every checked device (by its main address) and service."""
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=days)
    since = start.strftime("%Y-%m-%d %H:%M:%S")

    def window(table, where, args):
        before = conn.execute(f"SELECT state FROM {table} WHERE {where} AND at < ? ORDER BY at DESC, id DESC LIMIT 1",
                              (*args, since)).fetchone()
        ev = conn.execute(f"SELECT state, at FROM {table} WHERE {where} AND at >= ? ORDER BY at, id", (*args, since)).fetchall()
        return _uptime([(r["state"], r["at"]) for r in ev], before["state"] if before else None, start, now)

    info = {r["id"]: dict(r) for r in conn.execute(
        "SELECT d.id, d.name, d.device_type, h.name AS host_name FROM devices d LEFT JOIN devices h ON h.id = d.host_id")}
    devices = []
    for did, t in targets(conn).items():
        u = window("status_events", "device_id = ? AND address = ?", (did, t["addresses"][0]))
        if u["known_s"]:
            devices.append({**info[did], "address": t["addresses"][0], **u})
    services = []
    for r in conn.execute("SELECT s.id, s.name, s.url, s.port, d.id AS device_id, d.name AS device_name, d.device_type "
                          "FROM service_status st JOIN services s ON s.id = st.service_id JOIN devices d ON d.id = s.device_id"):
        u = window("service_events", "service_id = ?", (r["id"],))
        if u["known_s"]:
            services.append({**dict(r), **u})
    key = lambda x: (x["uptime"] if x["uptime"] is not None else 2, -x["down_s"])
    return {"days": days, "devices": sorted(devices, key=key), "services": sorted(services, key=key)}


# --------------------------------------------------------------------------- Wake-on-LAN

_MAC = re.compile(r"^[0-9a-f]{12}$")


def wake(mac: str, broadcasts: list[str]) -> list[str]:
    """Send the Wake-on-LAN magic packet to each broadcast address. Returns where it went."""
    hexmac = re.sub(r"[^0-9a-fA-F]", "", mac or "").lower()
    if not _MAC.match(hexmac):
        raise ValueError("That MAC address doesn't look right")
    packet = bytes.fromhex("ff" * 6 + hexmac * 16)
    sent = []
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        for addr in dict.fromkeys(broadcasts + ["255.255.255.255"]):
            for port in (9, 7):
                try:
                    s.sendto(packet, (addr, port))
                    sent.append(f"{addr}:{port}")
                except OSError:
                    pass
    if not sent:
        raise OSError("This computer couldn't send the wake-up packet")
    return sent


def broadcast_of(ip: str | None, subnet: str | None, cidr: str | None) -> str | None:
    """The broadcast address for an interface, from its subnet mask or its network's CIDR."""
    host = _host(ip or "")
    for net in (f"{host}/{subnet.strip().lstrip('/')}" if host and subnet else None, cidr):
        if not net:
            continue
        try:
            n = ipaddress.ip_interface(net).network if "/" in net else None
        except ValueError:
            continue
        if n and n.version == 4 and n.prefixlen < 31 and (not host or ipaddress.ip_address(host) in n):
            return str(n.broadcast_address)
    return None
