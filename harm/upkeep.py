"""Keeping machines healthy: the machine check and Docker read together, what needs attention across
every machine (for Home, Maintenance and alerts), and the optional background checks.

Background checks are off unless turned on in Settings. They need a login HaRM can use while it's
locked, so for each machine you choose, a copy of that login is encrypted with a key of its own
(background.key in the data folder, not in backups), like the alert passwords. Anyone with the
data folder can use those logins, so give HaRM a limited account for this. Background checks
only ever read: updates, restarts and power stay one click each.
"""

import asyncio
import json
import os
import time
from datetime import datetime, timedelta, timezone

from . import alerts, crypto, db, docker, machine, proxmox, remote

KEY_FILE = db.DB_PATH.parent / "background.key"
AAD = b"harm.background"
CHECK_TIMEOUT = 300
_bg_lock = asyncio.Lock()
_last_bg = 0.0


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def load(conn, key: str, default=None):
    try:
        v = json.loads(db.get_meta(conn, key) or "null")
    except ValueError:
        v = None
    return default if v is None else v


def save(conn, key: str, value) -> None:
    db.set_meta(conn, key, json.dumps(value) if value is not None else None)


def connection(conn, did: int) -> dict:
    """How HaRM reaches this machine over SSH (set on its Containers or Health tab)."""
    return load(conn, f"docker_conf:{did}", {})


def devices_with_connection(conn) -> list[dict]:
    rows = conn.execute("SELECT key FROM meta WHERE key LIKE 'docker_conf:%'").fetchall()
    ids = [int(r["key"].split(":")[1]) for r in rows if r["key"].split(":")[1].isdigit()]
    if not ids:
        return []
    q = ",".join("?" * len(ids))
    return [dict(r) for r in conn.execute(
        f"SELECT id, name, alerts, status FROM devices WHERE id IN ({q}) AND COALESCE(status, '') NOT IN ('Retired', 'Sold') "
        "ORDER BY name COLLATE NOCASE", ids)]


# --------------------------------------------------------------------------- one machine

def _split(output: str) -> tuple[str, str | None]:
    head, sep, rest = output.partition("HARM_DOCKER\n")
    return head, (rest if sep else None)


def script(backups: list[dict], with_docker: bool, limited_sudo: bool = False) -> str:
    s = machine.check_script(backups, limited_sudo)
    if with_docker:  # in a subshell: no Docker on the machine ends only this part
        s += f"echo HARM_DOCKER\n(\n{docker.LIST_SCRIPT})\n"
    return s


def store(conn, did: int, output: str) -> dict:
    """Save what a check read: the machine snapshot, the container list (keeping the update check),
    and SMART results into the matching drives' Health field. Returns the new machine snapshot."""
    head, dk = _split(output)
    backups = load(conn, f"machine_backups:{did}", [])
    snap = {**machine.parse(head, backups), "at": now()}
    save(conn, f"machine:{did}", snap)
    if dk is not None and "HARM_NO_DOCKER" not in dk:
        try:
            rows = docker.parse_list(dk)
        except docker.DockerError:
            rows = None
        if rows is not None:
            old = load(conn, f"docker:{did}", {})
            ran = {c["name"]: c.get("restarts", 0) for c in old.get("containers", []) if c.get("state") == "running"}
            save(conn, f"docker:{did}", {**old, "at": now(), "containers": rows, "was_running": ran})
    sync_drive_health(conn, did, snap)
    return snap


def sync_drive_health(conn, did: int, snap: dict) -> int:
    """Write each drive's SMART result into its part's Health field (matched by serial number)."""
    n = 0
    for d in snap.get("disks", []):
        h = machine.drive_health(d)
        if not h or not d.get("serial"):
            continue
        for r in conn.execute("SELECT id, health FROM components WHERE UPPER(TRIM(serial)) = ? AND "
                              "(device_id = ? OR device_id IS NULL OR device_id IN (SELECT id FROM devices WHERE host_id = ?))",
                              (d["serial"].upper(), did, did)):
            if (r["health"] or "") != h:
                conn.execute("UPDATE components SET health = ? WHERE id = ?", (h, r["id"]))
                n += 1
    return n


def container_problems(snap: dict | None) -> list[dict]:
    """Containers that stopped since the last read, keep restarting, or are unhealthy."""
    if not snap:
        return []
    was = snap.get("was_running") or {}
    out = []
    for c in snap.get("containers", []):
        key, name = f"ct:{c['name']}", c["name"]
        if c["state"] == "restarting" or (c["name"] in was and c.get("restarts", 0) - was[c["name"]] >= 3):
            out.append({"key": key, "level": "bad", "text": f"Container {name} keeps restarting", "container": name})
        elif c["state"] == "running" and c.get("health") == "unhealthy":
            out.append({"key": key, "level": "bad", "text": f"Container {name} is unhealthy", "container": name})
        elif c["state"] != "running" and c["name"] in was:
            out.append({"key": key, "level": "bad", "text": f"Container {name} stopped", "container": name})
    return out


def problems(conn, did: int) -> list[dict]:
    labels = load(conn, f"machine_labels:{did}", {})
    return machine.problems(load(conn, f"machine:{did}"), labels) + container_problems(load(conn, f"docker:{did}"))


def track(conn, did: int, logs: dict | None = None) -> list[dict]:
    """Alerts for problems found since the last check (once each), and when they clear."""
    conf = alerts.config(conn)
    dev = conn.execute("SELECT name, alerts FROM devices WHERE id = ?", (did,)).fetchone()
    found = {p["key"]: p for p in problems(conn, did) if p["level"] in ("bad", "warn")}
    before = set(load(conn, f"machine_alerted:{did}", []))
    save(conn, f"machine_alerted:{did}", sorted(found))
    if not (conf["enabled"] and conf.get("machines", True) and dev and dev["alerts"]):
        return []
    events = []
    for k, p in found.items():
        if k in before:
            continue
        msg = p["text"] + "."
        tail = (logs or {}).get(p.get("container") or "")
        if tail:
            msg += "\n\nLast lines of its log:\n" + tail
        events.append({"kind": "machine", "state": "down", "device": dev["name"], "device_id": did,
                       "title": f"{dev['name']}: {p['text']}", "message": msg})
    if conf["recovery"]:
        for k in before - set(found):
            events.append({"kind": "machine", "state": "up", "device": dev["name"], "device_id": did,
                           "title": f"{dev['name']}: fixed", "message": f"The problem HaRM found earlier ({k.split(':', 1)[-1]}) is gone."})
    return events


def logs_script(names: list[str]) -> str:
    parts = [docker._NEED_DOCKER]
    for n in names[:5]:
        if docker._NAME.match(n):
            parts.append(f"echo HARM_LOG={n}\ndocker logs --tail 12 {n} 2>&1 | cut -c1-200\n")
    return "".join(parts)


def parse_logs(output: str) -> dict:
    out, cur = {}, None
    for ln in output.splitlines():
        if ln.startswith("HARM_LOG="):
            cur = ln[9:]
            out[cur] = []
        elif cur:
            out[cur].append(ln)
    return {k: "\n".join(v[-12:]) for k, v in out.items()}


async def run(host, port, user, pw, sudo, text, timeout=CHECK_TIMEOUT) -> dict:
    return await asyncio.to_thread(remote.run_action, host, port, user, pw, "script", text, sudo, False, None, timeout)


async def check_one(conn, did: int, user: str, pw: str | None, conf: dict, limited_sudo: bool = False) -> tuple[dict, list[dict]]:
    """Check a machine (and read its containers). Returns the snapshot and the alerts it caused."""
    backups = load(conn, f"machine_backups:{did}", [])
    with_docker = load(conn, f"docker:{did}") is not None
    r = await run(conf["host"], int(conf.get("port") or 22), user, pw, bool(conf.get("sudo")), script(backups, with_docker, limited_sudo))
    snap = store(conn, did, r["output"])
    logs = {}
    new_ct = [p["container"] for p in container_problems(load(conn, f"docker:{did}"))
              if p["key"] not in set(load(conn, f"machine_alerted:{did}", []))]
    if new_ct:
        try:
            lr = await run(conf["host"], int(conf.get("port") or 22), user, pw, bool(conf.get("sudo")), logs_script(new_ct), 60)
            logs = parse_logs(lr["output"])
        except remote.RemoteError:
            pass
    return snap, track(conn, did, logs)


# --------------------------------------------------------------------------- the background login

def _key() -> bytes:
    if not KEY_FILE.exists():
        KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as f:
                f.write(os.urandom(32))
        except FileExistsError:
            pass
    return KEY_FILE.read_bytes()


def bg_logins(conn) -> dict:
    return load(conn, "bg_logins", {})


def bg_set(conn, did: int, user: str, pw: str | None, label: str, sudo: str = "none") -> None:
    """sudo: "all" (the whole check, like the one-click check), "limited" (only smartctl and apt-get
    update, allowed without a password) or "none"."""
    sealed = crypto.seal(_key(), json.dumps({"user": user, "pw": pw, "sudo": sudo}).encode(), AAD + str(did).encode())
    save(conn, "bg_logins", {**bg_logins(conn), str(did): {"sealed": crypto.b64e(sealed), "label": label, "at": now()}})


def bg_forget(conn, did: int) -> None:
    logins = bg_logins(conn)
    logins.pop(str(did), None)
    save(conn, "bg_logins", logins or None)


def bg_get(conn, did: int) -> dict | None:
    item = bg_logins(conn).get(str(did))
    if not item:
        return None
    try:
        v = json.loads(crypto.unseal(_key(), crypto.b64d(item["sealed"]), AAD + str(did).encode()))
        return {"user": v["user"], "pw": v.get("pw"), "sudo": v.get("sudo", "none")}
    except (crypto.DecryptError, OSError, ValueError, KeyError):
        return None  # the key file was lost or replaced: turn it on again for that machine


def bg_set_proxmox(conn, secret: str | None) -> None:
    save(conn, "bg_proxmox", crypto.b64e(crypto.seal(_key(), secret.encode(), AAD + b"proxmox")) if secret else None)


def bg_proxmox(conn) -> str | None:
    v = load(conn, "bg_proxmox")
    if not v:
        return None
    try:
        return crypto.unseal(_key(), crypto.b64d(v), AAD + b"proxmox").decode()
    except (crypto.DecryptError, OSError, ValueError):
        return None


# --------------------------------------------------------------------------- Proxmox, read

def pve_client(conn, secret: str) -> proxmox.Proxmox:
    conf = load(conn, "proxmox", {})
    if not conf.get("url") or not conf.get("token_id"):
        raise proxmox.ProxmoxError("Connect Proxmox first, in Discover > Proxmox")
    return proxmox.Proxmox(conf["url"], conf["token_id"], secret, bool(conf.get("verify")), conf.get("fingerprint") or None)


def pve_read(conn, secret: str) -> dict:
    px = pve_client(conn, secret)
    guests = proxmox.live(px)
    try:
        bk, bk_err = proxmox.backups(px), ""
    except proxmox.ProxmoxError as e:
        bk, bk_err = {}, str(e)
    snap = {"at": now(), "guests": guests, "backups": bk, "backups_error": bk_err}
    save(conn, "proxmox_live", snap)
    return snap


def pve_problems(conn, days: int) -> list[dict]:
    snap = load(conn, "proxmox_live")
    if not snap or not days:
        return []
    old = time.time() - days * 86400
    out = []
    for g in snap.get("guests", []):
        if g.get("template"):
            continue
        b = (snap.get("backups") or {}).get(g["vmid"])
        if b and b["ctime"] < old:
            age = (time.time() - b["ctime"]) / 86400
            out.append({"key": f"pve-backup:{g['vmid']}", "level": "warn", "vmid": g["vmid"],
                        "text": f"{g['name']} ({g['vmid']}): the newest Proxmox backup is {age:.0f} days old"})
    return out


# --------------------------------------------------------------------------- background

async def run_due(settings: dict) -> None:
    """Called by the background checker: check every machine with a background login when it's time."""
    global _last_bg
    if not settings.get("bg_checks") or _bg_lock.locked():
        return
    if _last_bg and time.monotonic() - _last_bg < settings.get("bg_hours", 6) * 3600:
        return
    async with _bg_lock:
        _last_bg = time.monotonic()
        await run_background()


async def run_background() -> list[str]:
    """Read every machine that has a background login. Only ever reads."""
    conn = db.connect()
    events, done = [], []
    try:
        for dev in devices_with_connection(conn):
            login = bg_get(conn, dev["id"])
            conf = connection(conn, dev["id"])
            if not login or not conf.get("host"):
                continue
            try:
                _, ev = await check_one(conn, dev["id"], login["user"], login["pw"],
                                        {**conf, "sudo": login["sudo"] == "all"}, login["sudo"] == "limited")
                events += ev
                done.append(dev["name"])
            except (remote.RemoteError, machine.MachineError) as e:
                save(conn, f"machine_error:{dev['id']}", {"at": now(), "error": str(e)})
            conn.commit()
        secret = bg_proxmox(conn)
        if secret:
            try:
                await asyncio.to_thread(pve_read, conn, secret)
            except proxmox.ProxmoxError:
                pass
        save(conn, "bg_last", {"at": now(), "machines": done})
        conn.commit()
    finally:
        conn.close()
    if events:
        await asyncio.to_thread(alerts.deliver, events)
    return done


def next_run(settings: dict) -> str | None:
    if not settings.get("bg_checks") or not _last_bg:
        return None
    left = max(0, settings.get("bg_hours", 6) * 3600 - (time.monotonic() - _last_bg))
    return (datetime.now(timezone.utc) + timedelta(seconds=left)).strftime("%Y-%m-%d %H:%M:%S")
