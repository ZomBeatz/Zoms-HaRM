"""Zom's HaRM: Hardware and Rack Manager. FastAPI application."""

import asyncio
import csv
import hashlib
import io
import ipaddress
import json
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
from contextlib import asynccontextmanager
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urlparse

import pyotp
from fastapi import Depends, FastAPI, HTTPException, Request, Response, WebSocket
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

from . import __version__, ai, aiproviders, alerts, certs, collect, crypto, db, discover, docker, machine, monitor, netwatch, pcbuild, power, proxmox, remote, sshkey, terminal, units, upkeep, vaultio, vnc
from .models import ENTITIES, ENUMS, iface_order

STATIC = Path(__file__).resolve().parent / "static"
# Changes whenever the frontend files change, so open tabs can offer a reload after an update.
APP_VERSION = format(int(max((p.stat().st_mtime for p in STATIC.glob("*.*")), default=0)), "x")
COOKIE = "harm_session"
# Lock timing (Settings > Locking and security). Kept in memory, since every request checks it.
_limits = {"idle": monitor.IDLE_MINUTES_DEFAULT * 60, "max": monitor.SESSION_HOURS_DEFAULT * 3600}


def _load_limits(conn) -> None:
    st = monitor.settings(conn)
    _limits.update(idle=st["idle_minutes"] * 60, max=st["session_hours"] * 3600)
MIN_PASSWORD = 10
APP_NAME = "Zom's HaRM"
# The demos (scripts/demo.py and the online one) use made-up addresses that could belong to real
# devices on the network they run on, so they never check, wake or run actions for real.
DEMO = os.environ.get("HARM_DEMO") == "1"
DEMO_NO_NETWORK = "The demo doesn't reach other devices. This works in HaRM on your own network."


BACKUP_DIR = db.DB_PATH.parent / "backups"


def auto_backup() -> str | None:
    """Daily snapshot into data/backups (secrets stay encrypted); keeps as many as Settings says."""
    BACKUP_DIR.mkdir(mode=0o700, exist_ok=True)
    target = BACKUP_DIR / f"harm-{datetime.now():%Y%m%d}.db"
    if target.exists():
        return None
    conn = db.connect()
    try:
        conn.execute("VACUUM INTO ?", (str(target),))
        keep = monitor.settings(conn)["backup_keep"]
    finally:
        conn.close()
    os.chmod(target, 0o600)
    for old in sorted(BACKUP_DIR.glob("harm-*.db"))[:-keep]:
        old.unlink(missing_ok=True)
    return target.name


COPY_KEEP = (7, 14, 30, 90)


def _copy_conf(conn) -> dict:
    try:
        return {"dir": "", "keep": 14, "last": None, **json.loads(db.get_meta(conn, "backup_copy") or "{}")}
    except ValueError:
        return {"dir": "", "keep": 14, "last": None}


def copy_backup() -> dict | None:
    """Copy the newest daily backup to the second place (a NAS share or USB drive mounted on this
    computer), and keep the newest `keep` there. Returns what happened, or None when it's not set up."""
    conn = db.connect()
    try:
        conf = _copy_conf(conn)
        if not conf["dir"]:
            return None
        target = Path(conf["dir"])
        result = {"at": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime()), "ok": False}
        try:
            auto_backup()
            newest = sorted(BACKUP_DIR.glob("harm-*.db"))[-1:]
            if not newest:
                raise OSError("There's no backup to copy yet")
            src = newest[0]
            if not target.is_dir():
                raise OSError(f"{target} isn't there. Is the drive or share connected?")
            dest = target / src.name
            if not dest.exists() or dest.stat().st_size != src.stat().st_size:
                tmp = target / (src.name + ".part")
                shutil.copyfile(src, tmp)
                os.replace(tmp, dest)
            for old in sorted(target.glob("harm-*.db"))[:-int(conf["keep"])]:
                old.unlink(missing_ok=True)
            result.update(ok=True, file=src.name, copies=len(list(target.glob("harm-*.db"))))
        except OSError as e:
            result["error"] = str(e.strerror or e) if isinstance(e, OSError) and e.strerror else str(e)
        conf["last"] = result
        db.set_meta(conn, "backup_copy", json.dumps(conf))
        conn.commit()
        return result
    finally:
        conn.close()


def _housekeeping(stop: threading.Event, backups: bool) -> None:
    """Hourly: forget expired sessions; make the daily backup if it's due, and copy it to the second place."""
    while not stop.is_set():
        purge_sessions()
        if backups:
            try:
                auto_backup()
                copy_backup()
            except Exception as e:  # never take the app down over a backup
                print(f"auto-backup failed: {e}")
        stop.wait(3600)


@asynccontextmanager
async def lifespan(_app):
    db.init()
    sshkey.sweep()
    conn = db.connect()
    try:
        _load_limits(conn)
    finally:
        conn.close()
    stop = threading.Event()
    threading.Thread(target=_housekeeping, args=(stop, os.environ.get("HARM_AUTO_BACKUP", "1") != "0"),
                     daemon=True).start()
    background = os.environ.get("HARM_MONITOR", "1") != "0" and not DEMO
    tasks = [asyncio.create_task(monitor.run_forever()), asyncio.create_task(netwatch.run_forever())] if background else []
    yield
    stop.set()
    for t in tasks:
        t.cancel()


app = FastAPI(title=APP_NAME, docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


# ---------------------------------------------------------------------------
# Security middleware
# ---------------------------------------------------------------------------

CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; "
       "media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; "
       "frame-ancestors 'none'; form-action 'self'")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    if request.url.path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS"):
        # CSRF: browsers cannot send custom headers cross-site without CORS preflight,
        # which this app never grants. SameSite=Strict on the cookie is the second layer.
        if request.headers.get("x-harm") != "1":
            return JSONResponse({"detail": "CSRF check failed"}, status_code=403)
        origin = request.headers.get("origin")
        if origin and urlparse(origin).netloc != request.headers.get("host"):
            return JSONResponse({"detail": "Cross-origin request refused"}, status_code=403)
    resp = await call_next(request)
    resp.headers["Content-Security-Policy"] = CSP
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Permissions-Policy"] = "camera=(self), microphone=(), geolocation=()"
    resp.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    if request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    elif request.url.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache"  # always revalidate after upgrades
    return resp


# ---------------------------------------------------------------------------
# Sessions (in memory; each holds the unwrapped data key)
# ---------------------------------------------------------------------------

_sessions: dict[str, dict] = {}
_sessions_lock = threading.Lock()


def _expired(s: dict, now: float) -> bool:
    return bool(_limits["idle"] and now - s["seen"] > _limits["idle"]) or now - s["created"] > _limits["max"]


def purge_sessions() -> None:
    """Forget expired sessions, so their unlocked data keys don't linger in memory."""
    now = time.time()
    with _sessions_lock:
        for t in [t for t, s in _sessions.items() if _expired(s, now)]:
            del _sessions[t]


def _new_session(dek: bytes, ip: str) -> str:
    purge_sessions()
    token = secrets.token_urlsafe(32)
    now = time.time()
    with _sessions_lock:
        _sessions[token] = {"dek": dek, "created": now, "seen": now, "ip": ip,
                            "totp_pending": None}
    return token


def _drop_all_sessions(keep: str | None = None) -> None:
    with _sessions_lock:
        for t in [t for t in _sessions if t != keep]:
            del _sessions[t]


def _lookup_session(request: Request) -> dict | None:
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    now = time.time()
    with _sessions_lock:
        s = _sessions.get(token)
        if not s:
            return None
        if _expired(s, now):
            del _sessions[token]
            return None
        s["seen"] = now
        return s


def require_session(request: Request) -> dict:
    s = _lookup_session(request)
    if not s:
        raise HTTPException(401, "Not authenticated")
    return s


def _set_cookie(request: Request, response: Response, token: str) -> None:
    secure_env = os.environ.get("HARM_SECURE_COOKIE", "auto").lower()
    secure = request.url.scheme == "https" if secure_env == "auto" else secure_env in ("1", "true", "yes")
    response.set_cookie(COOKIE, token, httponly=True, samesite="strict", secure=secure,
                        max_age=_limits["max"], path="/")


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "?"


# ---------------------------------------------------------------------------
# Login rate limiting
# ---------------------------------------------------------------------------

_fails: dict[str, tuple[int, float, float]] = {}  # ip -> (failures, locked until, last failure)
_fails_lock = threading.Lock()
FAIL_MEMORY = 3600  # failures older than an hour are forgotten


def _check_rate(ip: str) -> None:
    with _fails_lock:
        _count, until, _last = _fails.get(ip, (0, 0.0, 0.0))
    wait = until - time.time()
    if wait > 0:
        raise HTTPException(429, f"Too many failed attempts. Try again in {int(wait) + 1}s.")


def _record_fail(ip: str) -> None:
    with _fails_lock:
        now = time.time()
        count, _until, last = _fails.get(ip, (0, 0.0, 0.0))
        count = 1 if now - last > FAIL_MEMORY else count + 1
        until = now + min(900, 15 * 2 ** (count - 5)) if count >= 5 else 0.0
        _fails[ip] = (count, until, now)
        if len(_fails) > 10000:  # don't grow without bound under a flood of addresses
            for k in [k for k, v in _fails.items() if now - v[2] > FAIL_MEMORY]:
                del _fails[k]


def _record_ok(ip: str) -> None:
    with _fails_lock:
        _fails.pop(ip, None)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def get_db():
    conn = db.connect()
    try:
        yield conn
    finally:
        conn.close()


def audit(conn: sqlite3.Connection, request: Request, action: str, entity: str | None = None,
          entity_id: int | None = None, detail: str | None = None) -> None:
    conn.execute("INSERT INTO audit(action, entity, entity_id, detail, ip) VALUES (?,?,?,?,?)",
                 (action, entity, entity_id, detail, client_ip(request)))


async def body_json(request: Request) -> dict:
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON body")
    if not isinstance(data, dict):
        raise HTTPException(400, "JSON object expected")
    return data


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _coerce(conn, name: str, ftype: str, v):
    if ftype == "bool":
        return 1 if v in (True, 1, "1", "true", "on", "yes") else 0
    if v is None or (isinstance(v, str) and v.strip() == ""):
        return None
    try:
        if ftype == "text":
            v = str(v).strip()
            if len(v) > 20000:
                raise ValueError("too long")
            return v
        if ftype == "int":
            return int(v)
        if ftype == "real":
            return float(v)
        if ftype == "date":
            v = str(v).strip()
            if not _DATE_RE.match(v):
                raise ValueError("expected YYYY-MM-DD")
            date.fromisoformat(v)
            return v
        if ftype.startswith("fk:"):
            table = ftype[3:]
            v = int(v)
            if not conn.execute(f"SELECT 1 FROM {table} WHERE id = ?", (v,)).fetchone():
                raise ValueError(f"no such {table[:-1]}")
            return v
    except (TypeError, ValueError) as e:
        raise HTTPException(400, f"Invalid value for {name}: {e}")
    raise HTTPException(500, f"Unknown field type {ftype}")


def validate(conn, entity: str, body: dict, partial: bool) -> dict:
    spec = ENTITIES[entity]["fields"]
    out = {}
    for k, v in body.items():
        if k not in spec:
            raise HTTPException(400, f"Unknown field: {k}")
        out[k] = _coerce(conn, k, spec[k][0], v)
    for k, (_t, required) in spec.items():
        if required and (k in out or not partial) and out.get(k) in (None, ""):
            raise HTTPException(400, f"{k} is required")
    return out


def entity_or_404(entity: str) -> dict:
    if entity not in ENTITIES:
        raise HTTPException(404, "Unknown entity")
    return ENTITIES[entity]


def fetch_one(conn, entity: str, rid: int) -> dict:
    spec = ENTITIES[entity]
    row = conn.execute(f"SELECT * FROM ({spec['select']}) WHERE id = ?", (rid,)).fetchone()
    if not row:
        raise HTTPException(404, "Not found")
    return dict(row)


def fetch_list(conn, entity: str, filters: dict | None = None, q: str | None = None,
               limit: int = 5000) -> list[dict]:
    spec = ENTITIES[entity]
    where, args = [], []
    for k, v in (filters or {}).items():
        if k in spec["fields"] or k == "id":
            if v in ("null", "none"):
                where.append(f"t.{k} IS NULL")
            elif v == "notnull":
                where.append(f"t.{k} IS NOT NULL")
            else:
                where.append(f"t.{k} = ?")
                args.append(v)
    if q:
        like = f"%{q}%"
        where.append("(" + " OR ".join(f"t.{c} LIKE ?" for c in spec["search"]) + ")")
        args += [like] * len(spec["search"])
    sql = spec["select"]
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += f" ORDER BY {spec['order']} LIMIT {int(limit)}"
    return [dict(r) for r in conn.execute(sql, args).fetchall()]


# ---------------------------------------------------------------------------
# Entity-specific rules
# ---------------------------------------------------------------------------

def _rack_rules(conn, table: str, merged: dict, data: dict, rid: int | None) -> None:
    """Shared by devices and components: inherit location from the holder."""
    if data.get("rack_id") and "location_id" not in data:
        loc = conn.execute("SELECT location_id FROM racks WHERE id = ?",
                           (data["rack_id"],)).fetchone()
        if loc and loc["location_id"]:
            data["location_id"] = loc["location_id"]


VIRTUAL_TYPES = ("Virtual Machine", "Container")

IFACE_ORDER = iface_order()  # main address first, management ports last


def _device_rules(conn, data: dict, existing: dict | None) -> None:
    merged = {**(existing or {}), **data}
    rid = existing["id"] if existing else None
    if data.get("powered_by_id"):
        try:
            power.check_loop(conn, rid, data["powered_by_id"])
        except ValueError as e:
            raise HTTPException(400, f"powered_by_id: {e}")
    # Virtual machines / containers run on a host: no host loops, no rack space, and they live where the host lives.
    if data.get("host_id"):
        cur = data["host_id"]
        for _ in range(50):
            if rid and cur == rid:
                raise HTTPException(400, "A device can't run on itself (or on one of its own guests)")
            row = conn.execute("SELECT host_id, location_id FROM devices WHERE id = ?", (cur,)).fetchone()
            if not row or not row["host_id"]:
                break
            cur = row["host_id"]
        host = conn.execute("SELECT location_id FROM devices WHERE id = ?", (data["host_id"],)).fetchone()
        if host and "location_id" not in data:
            data["location_id"] = merged["location_id"] = host["location_id"]
    if merged.get("host_id") or merged.get("device_type") in VIRTUAL_TYPES:
        for k in ("rack_id", "rack_u"):
            if merged.get(k) is not None:
                data[k] = merged[k] = None
    _rack_rules(conn, "devices", merged, data, rid)
    if "rack_id" in data and data["rack_id"] is None:
        data["rack_u"] = None
        merged["rack_u"] = None
    rack_id, rack_u = merged.get("rack_id"), merged.get("rack_u")
    height = merged.get("u_height") or 1
    if height < 1 or height > 60:
        raise HTTPException(400, "u_height must be between 1 and 60")
    if merged.get("rack_face") not in (None, "front", "rear"):
        raise HTTPException(400, "rack_face must be 'front' or 'rear'")
    if rack_u is None:
        return
    if rack_id is None:
        raise HTTPException(400, "A rack unit needs a rack")
    rack = conn.execute("SELECT * FROM racks WHERE id = ?", (rack_id,)).fetchone()
    if not rack["height_u"]:
        raise HTTPException(400, f"'{rack['name']}' has no U height; use the position field instead")
    top = rack_u + height - 1
    if rack_u < 1 or top > rack["height_u"]:
        raise HTTPException(400, f"Device would span U{rack_u}-U{top}, outside "
                                 f"'{rack['name']}' (1-{rack['height_u']}U)")
    face = merged.get("rack_face") or "front"
    full = merged.get("full_depth", 1)
    others = conn.execute(
        "SELECT id, name, rack_u, u_height, rack_face, full_depth FROM devices "
        "WHERE rack_id = ? AND rack_u IS NOT NULL AND id != ?", (rack_id, rid or -1)).fetchall()
    for o in others:
        o_top = o["rack_u"] + o["u_height"] - 1
        if o_top < rack_u or o["rack_u"] > top:
            continue
        if full or o["full_depth"] or o["rack_face"] == face:
            raise HTTPException(409, f"Overlaps '{o['name']}' at U{o['rack_u']}"
                                     + (f"-U{o_top}" if o_top != o["rack_u"] else ""))


def _component_rules(conn, data: dict, existing: dict | None) -> None:
    merged = {**(existing or {}), **data}
    _rack_rules(conn, "components", merged, data, existing["id"] if existing else None)
    if "quantity" in data and (data["quantity"] is None or data["quantity"] < 0):
        raise HTTPException(400, "quantity must be 0 or more")
    # Status follows the device link: putting a part in a device makes it Installed,
    # taking it out puts it back In Stock (other statuses like RMA are left alone).
    status = merged.get("status")
    if merged.get("device_id") and status in (None, "", "In Stock"):
        data["status"] = "Installed"
    elif not merged.get("device_id") and status == "Installed":
        data["status"] = "In Stock"
    if data.get("capacity"):
        data["capacity"] = units.normalize_capacity(data["capacity"])
    # Bay placement only makes sense inside the device that owns the bay group.
    if not merged.get("device_id"):
        if merged.get("slot_id") or merged.get("bay") is not None:
            data["slot_id"], data["bay"] = None, None
    elif merged.get("slot_id"):
        sl = conn.execute("SELECT * FROM device_slots WHERE id = ?", (merged["slot_id"],)).fetchone()
        if not sl or sl["device_id"] != merged["device_id"]:
            data["slot_id"], data["bay"] = None, None
        elif merged.get("bay") is not None:
            first, q = sl["first_index"] or 0, merged.get("quantity") or 1
            start = merged["bay"]
            if start < first or start + q - 1 > first + sl["total"] - 1:
                raise HTTPException(400, f"Bay {start} is outside {sl['label'] or sl['interface']} "
                                         f"(bays {first} to {first + sl["total"] - 1})")
            for o in conn.execute("SELECT id, bay, quantity FROM components WHERE slot_id = ? AND bay IS NOT NULL "
                                  "AND id != ?", (sl["id"], (existing or {}).get("id", -1))).fetchall():
                if o["bay"] <= start + q - 1 and start <= o["bay"] + o["quantity"] - 1:
                    raise HTTPException(409, f"Bay {max(start, o['bay'])} already has a drive")


def _addr(name: str, value: str | None, allow_prefix: bool = False):
    """Parse an IP address (optionally with /prefix). Returns ip_interface or ip_address."""
    if value is None:
        return None
    try:
        if allow_prefix and "/" in value:
            return ipaddress.ip_interface(value)
        return ipaddress.ip_address(value)
    except ValueError:
        raise HTTPException(400, f"{name}: '{value}' is not a valid IP address")


def _net(value: str | None):
    if not value:
        return None
    try:
        return ipaddress.ip_network(value, strict=False)
    except ValueError:
        return None


def _best_network(conn, ip: str | None) -> int | None:
    """Most specific recorded network whose CIDR contains `ip`."""
    try:
        addr = ipaddress.ip_address(ip) if ip else None
    except ValueError:
        return None
    if addr is None:
        return None
    best = None
    for n in conn.execute("SELECT id, cidr FROM networks WHERE cidr IS NOT NULL").fetchall():
        net = _net(n["cidr"])
        if net and addr.version == net.version and addr in net:
            if best is None or net.prefixlen > best[1]:
                best = (n["id"], net.prefixlen)
    return best[0] if best else None


_MAC_HEX = re.compile(r"[^0-9a-fA-F]")


def _interface_rules(conn, data: dict, existing: dict | None) -> None:
    if data.get("is_primary"):
        did = data.get("device_id") or (existing or {}).get("device_id")
        conn.execute("UPDATE interfaces SET is_primary = 0 WHERE device_id = ? AND id != ?",
                     (did, (existing or {}).get("id") or -1))
    if data.get("ip"):
        a = _addr("IP address", data["ip"], allow_prefix=True)
        if isinstance(a, (ipaddress.IPv4Interface, ipaddress.IPv6Interface)):
            data["ip"] = str(a.ip)
            if not data.get("subnet") and not (existing or {}).get("subnet"):
                data["subnet"] = f"/{a.network.prefixlen}"
        else:
            data["ip"] = str(a)
    if data.get("ipv6"):
        a = _addr("IPv6 address", data["ipv6"], allow_prefix=True)
        if a.version != 6:
            raise HTTPException(400, "IPv6 address: that is an IPv4 address")
        data["ipv6"] = str(a.with_prefixlen if hasattr(a, "with_prefixlen") else a)
    if data.get("gateway"):
        data["gateway"] = str(_addr("Gateway", data["gateway"]))
    if data.get("mac"):
        hexes = _MAC_HEX.sub("", data["mac"])
        if len(hexes) == 12:  # normalise aa-bb.., aabb.ccdd.., AABBCCDDEEFF
            data["mac"] = ":".join(hexes[i:i + 2] for i in range(0, 12, 2)).upper()
    # An empty network means "work it out from the IP".
    if data.get("network_id") is None and ("network_id" in data or "ip" in data):
        ip = data.get("ip", (existing or {}).get("ip"))
        data["network_id"] = _best_network(conn, ip)


def _network_rules(conn, data: dict, existing: dict | None) -> None:
    net = None
    if data.get("cidr"):
        try:
            net = ipaddress.ip_network(data["cidr"], strict=False)
        except ValueError:
            raise HTTPException(400, f"CIDR: '{data['cidr']}' is not a valid network, e.g. 10.0.10.0/24")
        data["cidr"] = str(net)
    elif existing and "cidr" not in data:
        net = _net(existing.get("cidr"))
    if data.get("ipv6_prefix"):
        try:
            data["ipv6_prefix"] = str(ipaddress.IPv6Network(data["ipv6_prefix"], strict=False))
        except ValueError:
            raise HTTPException(400, "IPv6 prefix: not a valid IPv6 network, e.g. fd00:10::/64")
    vid = data.get("vlan_id")
    if vid is not None and not 1 <= vid <= 4094:
        raise HTTPException(400, "VLAN ID must be between 1 and 4094")
    for k, label in (("gateway", "Gateway"), ("dhcp_start", "DHCP start"), ("dhcp_end", "DHCP end")):
        if data.get(k):
            a = _addr(label, data[k])
            if net and (a.version != net.version or a not in net):
                raise HTTPException(400, f"{label} {a} is outside {net}")
            data[k] = str(a)


def _backfill_networks(conn) -> None:
    """Attach interfaces that have an IP but no network to the best matching network."""
    for r in conn.execute("SELECT id, ip FROM interfaces WHERE network_id IS NULL "
                          "AND ip IS NOT NULL").fetchall():
        nid = _best_network(conn, r["ip"])
        if nid:
            conn.execute("UPDATE interfaces SET network_id = ? WHERE id = ?", (nid, r["id"]))


def _parse_totp(value: str) -> str:
    v = value.strip()
    if v.lower().startswith("otpauth://"):
        try:
            v = pyotp.parse_uri(v).secret
        except Exception:
            raise HTTPException(400, "Invalid otpauth:// URI")
    v = v.replace(" ", "").upper()
    try:
        pyotp.TOTP(v).now()
    except Exception:
        raise HTTPException(400, "TOTP secret must be base32 or an otpauth:// URI")
    return v


def _encrypt_secrets(body: dict, dek: bytes) -> dict:
    out = {}
    for name in ENTITIES["credentials"]["secrets"]:
        if name not in body:
            continue
        v = body.pop(name)
        if v is None or str(v) == "":
            out[f"{name}_enc"] = None
            continue
        v = str(v)
        if len(v) > 20000:
            raise HTTPException(400, f"{name} is too long")
        if name == "totp_secret":
            v = _parse_totp(v)
        out[f"{name}_enc"] = crypto.seal(dek, v.encode(), f"credentials.{name}".encode())
    return out


def _decrypt(dek: bytes, blob, name: str) -> str | None:
    if blob is None:
        return None
    try:
        return crypto.unseal(dek, blob, f"credentials.{name}".encode()).decode()
    except crypto.DecryptError:
        return "<<decryption failed>>"


# ---------------------------------------------------------------------------
# Auth endpoints
# ---------------------------------------------------------------------------

def _is_setup(conn) -> bool:
    return db.get_meta(conn, "pw") is not None


@app.get("/api/auth/status")
def auth_status(request: Request, conn=Depends(get_db)):
    return {
        "app": APP_NAME,
        "setup": _is_setup(conn),
        "authenticated": _lookup_session(request) is not None,
        "totp_enabled": db.get_meta(conn, "totp") is not None,
        "idle_minutes": _limits["idle"] // 60,
        "site_name": monitor.settings(conn)["site_name"],  # shown on the lock screen, to tell HaRMs apart
        "version": APP_VERSION,
        "release": __version__,
    }


def _check_new_password(pw) -> str:
    if not isinstance(pw, str) or len(pw) < MIN_PASSWORD:
        raise HTTPException(400, f"Password must be at least {MIN_PASSWORD} characters")
    if len(pw) > 1024:
        raise HTTPException(400, "Password is too long")
    return pw


@app.post("/api/auth/setup")
async def auth_setup(request: Request, response: Response, conn=Depends(get_db)):
    body = await body_json(request)
    pw = _check_new_password(body.get("password"))
    if _is_setup(conn):
        raise HTTPException(409, "Already set up")
    dek = crypto.new_dek()
    rc = crypto.new_recovery_code()
    conn.execute("BEGIN IMMEDIATE")
    if _is_setup(conn):
        conn.rollback()
        raise HTTPException(409, "Already set up")
    db.set_meta(conn, "pw", json.dumps(crypto.wrap_dek(pw, dek, "pw")))
    db.set_meta(conn, "rc", json.dumps(crypto.wrap_dek(rc, dek, "rc")))
    audit(conn, request, "setup")
    conn.commit()
    _set_cookie(request, response, _new_session(dek, client_ip(request)))
    return {"recovery_code": rc}


_last_totp_counter = {"value": -1}


def _verify_login_totp(conn, dek: bytes, code) -> bool:
    blob = db.get_meta(conn, "totp")
    if blob is None:
        return True
    if not code:
        return False
    try:
        secret = crypto.unseal(dek, crypto.b64d(blob), b"meta.totp").decode()
    except crypto.DecryptError:
        return False
    totp = pyotp.TOTP(secret)
    code = re.sub(r"\s", "", str(code))
    now = time.time()
    for offset in (-1, 0, 1):
        t = now + offset * totp.interval
        counter = totp.timecode(datetime.fromtimestamp(t))
        if secrets.compare_digest(totp.at(t), code) and counter > _last_totp_counter["value"]:
            _last_totp_counter["value"] = counter  # block replay of a used code
            return True
    return False


@app.post("/api/auth/login")
async def auth_login(request: Request, response: Response, conn=Depends(get_db)):
    ip = client_ip(request)
    _check_rate(ip)
    body = await body_json(request)
    rec = db.get_meta(conn, "pw")
    if rec is None:
        raise HTTPException(409, "Not set up yet")
    dek = crypto.unwrap_dek(str(body.get("password", "")), json.loads(rec), "pw")
    if dek is None or not _verify_login_totp(conn, dek, body.get("totp")):
        _record_fail(ip)
        audit(conn, request, "login_failed")
        conn.commit()
        raise HTTPException(401, "Invalid password or 2FA code")
    _record_ok(ip)
    audit(conn, request, "login")
    conn.commit()
    _set_cookie(request, response, _new_session(dek, ip))
    return {"ok": True}


@app.post("/api/auth/logout")
def auth_logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE)
    if token:
        with _sessions_lock:
            _sessions.pop(token, None)
        terminal.close_owner(_owner(request))
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@app.post("/api/auth/change-password")
async def change_password(request: Request, s=Depends(require_session), conn=Depends(get_db)):
    ip = client_ip(request)
    _check_rate(ip)
    body = await body_json(request)
    new = _check_new_password(body.get("new_password"))
    if crypto.unwrap_dek(str(body.get("current_password", "")),
                         json.loads(db.get_meta(conn, "pw")), "pw") is None:
        _record_fail(ip)
        raise HTTPException(403, "Current password is incorrect")
    db.set_meta(conn, "pw", json.dumps(crypto.wrap_dek(new, s["dek"], "pw")))
    audit(conn, request, "password_changed", detail="other sessions signed out")
    conn.commit()
    _drop_all_sessions(keep=request.cookies.get(COOKIE))
    return {"ok": True}


@app.post("/api/auth/recover")
async def recover(request: Request, response: Response, conn=Depends(get_db)):
    """Reset the master password with the recovery code. Disables 2FA."""
    ip = client_ip(request)
    _check_rate(ip)
    body = await body_json(request)
    new = _check_new_password(body.get("new_password"))
    rec = db.get_meta(conn, "rc")
    if rec is None:
        raise HTTPException(409, "No recovery code configured")
    code = crypto.normalize_recovery_code(str(body.get("recovery_code", "")))
    dek = crypto.unwrap_dek(code, json.loads(rec), "rc")
    if dek is None:
        _record_fail(ip)
        audit(conn, request, "recovery_failed")
        conn.commit()
        raise HTTPException(401, "Invalid recovery code")
    _record_ok(ip)
    new_rc = crypto.new_recovery_code()
    db.set_meta(conn, "pw", json.dumps(crypto.wrap_dek(new, dek, "pw")))
    db.set_meta(conn, "rc", json.dumps(crypto.wrap_dek(new_rc, dek, "rc")))
    db.set_meta(conn, "totp", None)
    audit(conn, request, "recovered", detail="password reset via recovery code; 2FA disabled")
    conn.commit()
    _drop_all_sessions()
    _set_cookie(request, response, _new_session(dek, ip))
    return {"recovery_code": new_rc}


async def _confirm_password(request: Request, conn, body: dict) -> None:
    ip = client_ip(request)
    _check_rate(ip)
    if crypto.unwrap_dek(str(body.get("password", "")),
                         json.loads(db.get_meta(conn, "pw")), "pw") is None:
        _record_fail(ip)
        raise HTTPException(403, "Password is incorrect")


@app.post("/api/auth/recovery-code")
async def regenerate_recovery(request: Request, s=Depends(require_session), conn=Depends(get_db)):
    await _confirm_password(request, conn, await body_json(request))
    rc = crypto.new_recovery_code()
    db.set_meta(conn, "rc", json.dumps(crypto.wrap_dek(rc, s["dek"], "rc")))
    audit(conn, request, "recovery_code_regenerated")
    conn.commit()
    return {"recovery_code": rc}


@app.post("/api/auth/totp/begin")
def totp_begin(s=Depends(require_session)):
    secret = pyotp.random_base32()
    s["totp_pending"] = secret
    uri = pyotp.TOTP(secret).provisioning_uri(name="admin", issuer_name=APP_NAME)
    return {"secret": secret, "uri": uri}


@app.post("/api/auth/totp/enable")
async def totp_enable(request: Request, s=Depends(require_session), conn=Depends(get_db)):
    body = await body_json(request)
    secret = s.get("totp_pending")
    if not secret:
        raise HTTPException(400, "Start 2FA setup first")
    if not pyotp.TOTP(secret).verify(re.sub(r"\s", "", str(body.get("code", ""))), valid_window=1):
        raise HTTPException(400, "Code did not match. Check your device clock and try again.")
    db.set_meta(conn, "totp", crypto.b64e(crypto.seal(s["dek"], secret.encode(), b"meta.totp")))
    s["totp_pending"] = None
    audit(conn, request, "totp_enabled")
    conn.commit()
    return {"ok": True}


@app.post("/api/auth/totp/disable")
async def totp_disable(request: Request, s=Depends(require_session), conn=Depends(get_db)):
    await _confirm_password(request, conn, await body_json(request))
    db.set_meta(conn, "totp", None)
    audit(conn, request, "totp_disabled")
    conn.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Meta, dashboard, search, audit, backup
# ---------------------------------------------------------------------------

@app.get("/api/meta/enums")
def enums(_s=Depends(require_session)):
    return ENUMS


@app.get("/api/dashboard")
def dashboard(_s=Depends(require_session), conn=Depends(get_db)):
    def scalar(sql, *a):
        return conn.execute(sql, a).fetchone()[0]

    def group(sql):
        return [dict(r) for r in conn.execute(sql).fetchall()]

    counts = {e: scalar(f"SELECT COUNT(*) FROM {e}") for e in
              ("locations", "racks", "devices", "components", "credentials", "services",
               "interfaces", "connections", "networks")}
    counts["spare_units"] = scalar(
        "SELECT COALESCE(SUM(quantity),0) FROM components WHERE device_id IS NULL "
        "AND status = 'In Stock'")
    counts["connected"] = scalar("SELECT COUNT(*) FROM devices WHERE connected = 1")
    return {
        "counts": counts,
        "devices_by_status": group("SELECT status AS label, COUNT(*) AS n FROM devices "
                                   "GROUP BY status ORDER BY n DESC"),
        "devices_by_type": group("SELECT COALESCE(device_type,'Unspecified') AS label, "
                                 "COUNT(*) AS n FROM devices GROUP BY label ORDER BY n DESC"),
        "spares_by_category": group(
            "SELECT category AS label, SUM(quantity) AS n, "
            "GROUP_CONCAT(DISTINCT capacity) AS capacities FROM components "
            "WHERE device_id IS NULL AND status = 'In Stock' GROUP BY category ORDER BY n DESC"),
        "racks": fetch_list(conn, "racks"),
        "warranty_soon": group(
            "SELECT 'device' AS kind, id, name AS label, warranty_until FROM devices "
            "WHERE warranty_until IS NOT NULL AND warranty_until <= date('now','+90 days') "
            "AND status NOT IN ('Retired','Sold') "
            "UNION ALL SELECT 'component', id, "
            "TRIM(COALESCE(manufacturer,'')||' '||COALESCE(model,category)), warranty_until "
            "FROM components WHERE warranty_until IS NOT NULL "
            "AND warranty_until <= date('now','+90 days') AND status != 'Disposed' "
            "ORDER BY warranty_until LIMIT 20"),
        "stale_credentials": [dict(r) for r in _old_logins(conn)[:20]],
        "needs_repair": group(
            "SELECT id, name AS label, status FROM devices WHERE status IN ('Broken', 'In Repair') "
            "ORDER BY status, name LIMIT 20"),
        "unconnected_active": group(
            "SELECT id, name AS label FROM devices WHERE connected = 0 AND status = 'Active' "
            "ORDER BY name LIMIT 20"),
        "ip_conflicts": group(
            "SELECT i.ip AS label, COUNT(*) AS n, GROUP_CONCAT(d.name, ', ') AS devices, "
            "MIN(i.device_id) AS device_id FROM interfaces i JOIN devices d ON d.id = i.device_id "
            "WHERE i.ip IS NOT NULL AND i.ip != '' GROUP BY i.ip HAVING COUNT(*) > 1 LIMIT 20"),
        "storage_installed": storage_summary(fetch_list(conn, "components", {"device_id": "notnull"})),
        "storage_spare": storage_summary([c for c in fetch_list(conn, "components", {"device_id": "null"})
                                          if c["status"] == "In Stock"]),
        "open_tasks": [n for n in fetch_list(conn, "notes", {"done": "0"}, limit=500) if n["kind"] in ("task", "issue")][:40],
        "recent": group("SELECT * FROM audit ORDER BY id DESC LIMIT 12"),
        "offline": monitor.offline(conn),
        "services_down": monitor.services_down(conn),
        "certs": monitor.certs_expiring(conn, 30),
        "power": power.warnings(conn),
        "new_on_network": len(netwatch.pending(conn)),
        "maintenance": maintenance_summary(conn),
    }


@app.get("/api/search")
def search(q: str = "", _s=Depends(require_session), conn=Depends(get_db)):
    q = q.strip()
    if len(q) < 2:
        return []
    out = []

    def add(kind, rows, label, sub, link):
        for r in rows:
            out.append({"kind": kind, "id": r["id"], "label": label(r), "sub": sub(r),
                        "link": link(r)})

    add("Device", fetch_list(conn, "devices", q=q, limit=25), lambda r: r["name"],
        lambda r: " · ".join(x for x in (r["device_type"], r["model"], r["ips"]) if x),
        lambda r: f"#/devices/{r['id']}")
    add("IP / Interface", fetch_list(conn, "interfaces", q=q, limit=25),
        lambda r: r["ip"] or r["mac"] or r["name"] or "interface",
        lambda r: f"{r['device_name']} · {r['name'] or ''}",
        lambda r: f"#/devices/{r['device_id']}?tab=network&edit=interfaces-{r['id']}")
    add("Service", fetch_list(conn, "services", q=q, limit=25), lambda r: r["name"],
        lambda r: f"{r['device_name']}" + (f" :{r['port']}" if r["port"] else ""),
        lambda r: f"#/devices/{r['device_id']}?tab=network&edit=services-{r['id']}")
    add("Component", fetch_list(conn, "components", q=q, limit=25),
        lambda r: " ".join(x for x in (r["manufacturer"], r["model"], r["capacity"]) if x) or r["category"],
        lambda r: f"{r['category']} · {r['status']}" + (f" · in {r['device_name']}" if r["device_name"] else ""),
        lambda r: f"#/components?id={r['id']}")
    add("Rack / Holder", fetch_list(conn, "racks", q=q, limit=25), lambda r: r["name"],
        lambda r: f"{r['kind']} · {r['location_name'] or ''}", lambda r: f"#/racks/{r['id']}")
    add("Location", fetch_list(conn, "locations", q=q, limit=25), lambda r: r["name"],
        lambda r: r["kind"] or "", lambda r: f"#/locations/{r['id']}")
    note_links = {"devices": "#/devices/{}?tab=overview", "racks": "#/racks/{}", "locations": "#/locations/{}",
                  "networks": "#/networks/{}", "builds": "#/builds/{}", "components": "#/components?id={}",
                  "clusters": "#/clusters/{}"}
    add("Note", fetch_list(conn, "notes", q=q, limit=25), lambda r: (r["body"][:80] + ("…" if len(r["body"]) > 80 else "")),
        lambda r: f"{r['kind']} · {r['target_name'] or ''}", lambda r: note_links[r["entity"]].format(r["entity_id"]))
    add("Cluster", fetch_list(conn, "clusters", q=q, limit=25), lambda r: r["name"],
        lambda r: " · ".join(x for x in (r["kind"], f"{r['node_count']} nodes") if x), lambda r: f"#/clusters/{r['id']}")
    add("Network", fetch_list(conn, "networks", q=q, limit=25), lambda r: r["name"],
        lambda r: " · ".join(x for x in (r["cidr"], f"VLAN {r['vlan_id']}" if r["vlan_id"] else None) if x),
        lambda r: f"#/networks/{r['id']}")
    add("Credential", fetch_list(conn, "credentials", q=q, limit=25), lambda r: r["label"],
        lambda r: " · ".join(x for x in (r["username"], r["device_name"]) if x),
        lambda r: f"#/devices/{r['device_id']}?tab=logins&open={r['id']}" if r["device_id"] else f"#/vault?open={r['id']}")
    return out


@app.get("/api/audit")
def audit_log(limit: int = 300, _s=Depends(require_session), conn=Depends(get_db)):
    limit = max(1, min(limit, 5000))
    return [dict(r) for r in conn.execute(
        "SELECT * FROM audit ORDER BY id DESC LIMIT ?", (limit,)).fetchall()]


@app.get("/api/backup")
def backup(request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    """Consistent SQLite snapshot. Secrets inside remain encrypted."""
    tmpdir = tempfile.mkdtemp(prefix="harm-backup-")
    path = os.path.join(tmpdir, "harm.db")
    conn.execute("VACUUM INTO ?", (path,))
    audit(conn, request, "backup_downloaded")
    conn.commit()

    def cleanup():
        try:
            os.remove(path)
            os.rmdir(tmpdir)
        except OSError:
            pass

    name = f"harm-backup-{datetime.now():%Y%m%d-%H%M%S}.db"
    return FileResponse(path, filename=name, media_type="application/octet-stream",
                        background=BackgroundTask(cleanup))


@app.get("/api/export/{entity}.csv")
def export_csv(entity: str, request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    entity_or_404(entity)
    rows = fetch_list(conn, entity, limit=1_000_000)
    buf = io.StringIO()
    if rows:
        w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
        w.writeheader()
        for r in rows:
            # Neutralise spreadsheet formula injection.
            w.writerow({k: ("'" + v if isinstance(v, str) and v[:1] in "=+-@\t\r" else v)
                        for k, v in r.items()})
    audit(conn, request, "export", entity)
    conn.commit()
    return Response(buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="harm-{entity}.csv"'})


# ---------------------------------------------------------------------------
# Rich views
# ---------------------------------------------------------------------------

def _norm(s: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


_PCIE = re.compile(r"^pcie?(?:\d+)?x(\d+)$")


def _iface_fits_one(s: str, c: str) -> bool:
    if not s or not c:
        return False
    ps, pc = _PCIE.match(s), _PCIE.match(c)
    if ps and pc:
        return int(pc.group(1)) <= int(ps.group(1))
    if s == c or s.startswith(c) or c.startswith(s):
        return True
    if s.startswith("sas") and c.startswith("sata"):  # SAS backplanes accept SATA drives
        return True
    if s.startswith("u3") and (c.startswith("u2") or c.startswith("sas") or c.startswith("sata")):
        return True
    return False


def iface_fits(slot_iface: str | None, comp_iface: str | None) -> bool:
    """Could a component with `comp_iface` go in a slot offering `slot_iface`?
    Slots may accept several connections: "SAS/SATA", "SATA, NVMe"."""
    c = _norm(comp_iface)
    parts = [p for p in re.split(r"\s*(?:/|,|\+|&|\band\b)\s*", slot_iface or "") if p.strip()] or [slot_iface]
    return any(_iface_fits_one(_norm(p), c) for p in parts)


def ff_fits(slot_ff: str | None, comp_ff: str | None) -> bool:
    s, c = _norm(slot_ff), _norm(comp_ff)
    return not s or not c or s == c or c.startswith(s) or s.startswith(c)


STORAGE_CATEGORIES = {"hdd", "ssd", "nvmessd", "usbflash"}


def is_drive_bay(sl: dict) -> bool:
    i = (sl.get("interface") or "").lower()
    return bool(re.search(r"sas|sata|u\.?[23]|bay|drive", i)) and "m.2" not in i and "m2" not in _norm(i)[:3]


def slot_fits(sl: dict, c: dict) -> bool:
    if c.get("slot_id"):
        return c["slot_id"] == sl["id"]
    if not ff_fits(sl["form_factor"], c["form_factor"]):
        return False
    if iface_fits(sl["interface"], c["interface"]):
        return True
    # A drive with no connection recorded still belongs in a drive bay.
    return not c.get("interface") and _norm(c.get("category")) in STORAGE_CATEGORIES and is_drive_bay(sl)


def _slots_with_usage(conn, device_id: int) -> list[dict]:
    """Slots with usage, a bay-by-bay map, and the parts in each (for per-array totals)."""
    slots = fetch_list(conn, "device_slots", {"device_id": device_id})
    installed = fetch_list(conn, "components", {"device_id": device_id})
    spares = fetch_list(conn, "components", {"device_id": "null", "status": "In Stock"})
    for sl in slots:
        sl["bays"] = [None] * max(sl["total"] or 0, 0)
        sl["overflow"] = 0
        sl["placed"] = {}  # component id -> units in this slot
    by_id = {sl["id"]: sl for sl in slots}

    def put(sl, c, idx=None, units=1):
        for _ in range(units):
            if idx is not None and 0 <= idx < len(sl["bays"]) and sl["bays"][idx] is None:
                sl["bays"][idx] = c["id"]
                idx += 1
            else:
                free = next((i for i, b in enumerate(sl["bays"]) if b is None), None)
                if free is None:
                    sl["overflow"] += 1
                else:
                    sl["bays"][free] = c["id"]
                idx = None
            sl["placed"][c["id"]] = sl["placed"].get(c["id"], 0) + 1

    # 1) Parts placed in a specific bay, 2) older parts matched by fit (they keep the bays they
    # were shown in), 3) parts assigned to a group without a bay number fill what's left.
    pinned = [c for c in installed if c.get("slot_id") in by_id]
    for c in pinned:
        if c["bay"] is not None:
            sl = by_id[c["slot_id"]]
            put(sl, c, c["bay"] - (sl["first_index"] or 0), c["quantity"])
    order = sorted(slots, key=lambda sl: (not sl["form_factor"], len(_norm(sl["interface"])) * -1))
    for c in installed:
        if c.get("slot_id") in by_id:
            continue
        units = c["quantity"]
        cands = [sl for sl in order if slot_fits(sl, {**c, "slot_id": None})]
        for sl in cands:
            free = sum(1 for b in sl["bays"] if b is None)
            take = min(units, free)
            if take:
                put(sl, c, None, take)
                units -= take
        if units and cands:  # more installed than slots: show the overflow
            put(cands[0], c, None, units)
    for c in pinned:
        if c["bay"] is None:
            put(by_id[c["slot_id"]], c, None, c["quantity"])
    comp_by_id = {c["id"]: c for c in installed}
    for sl in slots:
        sl["used"] = sum(1 for b in sl["bays"] if b is not None) + sl["overflow"]
        parts = [{**comp_by_id[cid], "quantity": n} for cid, n in sl.pop("placed").items()]
        sl["storage"] = storage_summary(parts) if is_drive_bay(sl) else None
        sl["drive_bay"] = is_drive_bay(sl)
        sl["compatible"] = [c for c in spares if c["quantity"] > 0 and slot_fits(sl, {**c, "slot_id": None})]
    return slots


def storage_summary(comps: list[dict]) -> dict:
    """Drives grouped by size with raw totals, for quick capacity math."""
    groups: dict = {}
    total = 0.0
    count = 0
    unknown = 0
    for c in comps:
        if _norm(c.get("category")) not in STORAGE_CATEGORIES:
            continue
        gb = units.parse_gb(c.get("capacity")) or units.find_gb(c.get("capacity"))
        q = c.get("quantity") or 0
        count += q
        if not gb:
            unknown += q
            continue
        key = (units.fmt_gb(gb), c.get("category"))
        g = groups.setdefault(key, {"capacity": key[0], "category": key[1], "gb": gb, "count": 0})
        g["count"] += q
        total += gb * q
    return {"groups": sorted(groups.values(), key=lambda g: (-g["gb"], g["category"] or "")),
            "total_gb": total, "total": units.fmt_gb(total) if total else None, "drives": count, "unknown": unknown}


def memory_summary(comps: list[dict]) -> dict:
    groups: dict = {}
    total = 0.0
    sticks = 0
    for c in comps:
        if _norm(c.get("category")) != "ram":
            continue
        gb = units.parse_gb(c.get("capacity")) or units.find_gb(c.get("capacity"))
        q = c.get("quantity") or 0
        sticks += q
        key = (units.fmt_gb(gb) if gb else "?", c.get("interface") or "", c.get("speed") or "")
        g = groups.setdefault(key, {"capacity": key[0], "interface": key[1], "speed": key[2], "gb": gb or 0, "count": 0})
        g["count"] += q
        total += (gb or 0) * q
    return {"groups": sorted(groups.values(), key=lambda g: -g["gb"]), "total_gb": total,
            "total": units.fmt_gb(total) if total else None, "sticks": sticks}


def cpu_summary(conn, comps: list[dict]) -> dict:
    items, cores, threads = [], 0, 0
    for c in comps:
        if _norm(c.get("category")) != "cpu":
            continue
        specs = {}
        if c.get("catalog_id"):
            r = conn.execute("SELECT specs FROM catalog_parts WHERE id = ?", (c["catalog_id"],)).fetchone()
            specs = json.loads(r["specs"]) if r else {}
        m = re.match(r"\s*(\d+)\s*C\s*/\s*(\d+)\s*T", c.get("capacity") or "", re.I)
        cc = specs.get("cores") or (int(m.group(1)) if m else None)
        tt = specs.get("threads") or (int(m.group(2)) if m else cc)
        q = c.get("quantity") or 1
        cores += (cc or 0) * q
        threads += (tt or 0) * q
        items.append({"id": c["id"], "name": " ".join(x for x in (c.get("manufacturer"), c.get("model")) if x) or "CPU",
                      "qty": q, "cores": cc, "threads": tt, "base_ghz": specs.get("base_ghz"),
                      "boost_ghz": specs.get("boost_ghz"), "socket": specs.get("socket") or c.get("interface"),
                      "catalog_id": c.get("catalog_id")})
    return {"items": items, "cores": cores, "threads": threads, "sockets": sum(i["qty"] for i in items)}


@app.get("/api/devices/{did}/full")
def device_full(did: int, _s=Depends(require_session), conn=Depends(get_db)):
    dev = fetch_one(conn, "devices", did)
    conns = [dict(r) for r in conn.execute(
        ENTITIES["connections"]["select"] + " WHERE t.a_device_id = ? OR t.b_device_id = ? "
        "ORDER BY t.a_port", (did, did)).fetchall()]
    return {
        "device": dev,
        "rack": fetch_one(conn, "racks", dev["rack_id"]) if dev["rack_id"] else None,
        "interfaces": fetch_list(conn, "interfaces", {"device_id": did}),
        "services": fetch_list(conn, "services", {"device_id": did}),
        "credentials": fetch_list(conn, "credentials", {"device_id": did}),
        "components": (comps := fetch_list(conn, "components", {"device_id": did})),
        "storage": storage_summary(comps),
        "memory": memory_summary(comps),
        "cpus": cpu_summary(conn, comps),
        "notes": fetch_list(conn, "notes", {"entity": "devices", "entity_id": did}),
        "slots": _slots_with_usage(conn, did),
        "connections": conns,
        "builds": [dict(r) for r in conn.execute("SELECT id, name, status FROM builds WHERE device_id = ?", (did,))],
        "guests": (guests := fetch_list(conn, "devices", {"host_id": did})),
        "guest_totals": {"count": len(guests), "vcpus": sum(g["vcpus"] or 0 for g in guests),
                         "ram_gb": sum(g["vm_ram_gb"] or 0 for g in guests), "disk_gb": sum(g["vm_disk_gb"] or 0 for g in guests),
                         "running": sum(1 for g in guests if g["status"] == "Active")},
        "cluster": fetch_one(conn, "clusters", dev["cluster_id"]) if dev["cluster_id"] else None,
        "online": monitor.device_state(conn, dev),
        "actions": fetch_list(conn, "actions", {"device_id": did}),
        "can_wake": _wake_targets(conn, did) is not None,
        "power": next((x for x in power.summary(conn)["supplies"] if x["id"] == did), None),
        "docker": docker_summary(conn, did),
        "machine": upkeep.load(conn, f"machine:{did}") is not None,
    }


@app.get("/api/devices/summary")
def devices_summary(_s=Depends(require_session), conn=Depends(get_db)):
    """Per-device hardware totals and open tasks, plus fleet totals."""
    by: dict[int, list] = {}
    for c in fetch_list(conn, "components", {"device_id": "notnull"}, limit=100000):
        by.setdefault(c["device_id"], []).append(c)
    out: dict = {}
    for did, cs in by.items():
        st, mem, cpu = storage_summary(cs), memory_summary(cs), cpu_summary(conn, cs)
        out[did] = {"storage_gb": st["total_gb"], "storage": st["total"], "drives": st["drives"],
                    "ram_gb": mem["total_gb"], "ram": mem["total"], "cores": cpu["cores"], "threads": cpu["threads"]}
    for r in conn.execute("SELECT entity_id, SUM(kind = 'issue') AS issues, SUM(kind = 'task') AS tasks FROM notes "
                          "WHERE entity = 'devices' AND done = 0 AND kind IN ('task', 'issue') GROUP BY entity_id"):
        out.setdefault(r["entity_id"], {}).update(issues=r["issues"], tasks=r["tasks"])
    vm = {"count": 0, "vcpus": 0, "ram_gb": 0.0}
    for r in conn.execute("SELECT id, vcpus, vm_ram_gb FROM devices WHERE host_id IS NOT NULL OR device_type IN (?, ?)", VIRTUAL_TYPES):
        out.setdefault(r["id"], {}).update(vcpus=r["vcpus"], vm_ram=units.fmt_gb(r["vm_ram_gb"]) if r["vm_ram_gb"] else None,
                                           virtual=True)
        vm["count"] += 1
        vm["vcpus"] += r["vcpus"] or 0
        vm["ram_gb"] += r["vm_ram_gb"] or 0
    tot = lambda k: sum(v.get(k) or 0 for v in out.values())
    return {"devices": out, "virtual": {**vm, "ram": units.fmt_gb(vm["ram_gb"]) if vm["ram_gb"] else None},
            "totals": {"cores": tot("cores"), "threads": tot("threads"),
                                       "ram": units.fmt_gb(tot("ram_gb")) if tot("ram_gb") else None,
                                       "storage": units.fmt_gb(tot("storage_gb")) if tot("storage_gb") else None,
                                       "drives": tot("drives"), "issues": tot("issues"), "tasks": tot("tasks")}}


@app.get("/api/clusters/{cid}/full")
def cluster_full(cid: int, _s=Depends(require_session), conn=Depends(get_db)):
    """A cluster's member hosts, the guests running on them, and combined resources."""
    cl = fetch_one(conn, "clusters", cid)
    nodes = fetch_list(conn, "devices", {"cluster_id": cid, "host_id": "null"})
    node_ids = [n["id"] for n in nodes]
    guests = [g for g in fetch_list(conn, "devices", {"host_id": "notnull"}, limit=100000)
              if g["host_id"] in node_ids or g["cluster_id"] == cid]
    cap = {"threads": 0, "cores": 0, "ram_gb": 0.0, "storage_gb": 0.0}
    for nid in node_ids:
        comps = fetch_list(conn, "components", {"device_id": nid})
        c, m, st = cpu_summary(conn, comps), memory_summary(comps), storage_summary(comps)
        cap["threads"] += c["threads"] or 0
        cap["cores"] += c["cores"] or 0
        cap["ram_gb"] += m["total_gb"] or 0
        cap["storage_gb"] += st["total_gb"] or 0
    used = {"vcpus": sum(g["vcpus"] or 0 for g in guests), "ram_gb": sum(g["vm_ram_gb"] or 0 for g in guests),
            "disk_gb": sum(g["vm_disk_gb"] or 0 for g in guests)}
    return {"cluster": cl, "nodes": nodes, "guests": guests, "capacity": cap, "allocated": used,
            "notes": fetch_list(conn, "notes", {"entity": "clusters", "entity_id": cid})}


@app.post("/api/specs/parse")
async def specs_parse(request: Request, _s=Depends(require_session)):
    """Parse pasted output from the HaRM spec collector scripts."""
    body = await body_json(request)
    try:
        r = collect.parse(str(body.get("text") or "")[:2_000_000])
    except ValueError as e:
        raise HTTPException(400, str(e))
    cpu = r.get("cpu_info") or {}
    if cpu.get("model"):
        conn = db.connect()
        try:
            r["cpus"] = [_match_cpu(conn, cpu)]
        finally:
            conn.close()
    return r


@app.get("/api/devices/{did}/collect-targets")
def collect_targets(did: int, _s=Depends(require_session), conn=Depends(get_db)):
    """Addresses and saved logins that could be used to read this device's specs over SSH."""
    dev = fetch_one(conn, "devices", did)
    hosts = [r["ip"].split("/")[0].strip() for r in conn.execute(
        "SELECT ip FROM interfaces WHERE device_id = ? AND ip IS NOT NULL AND ip != '' "
        f"ORDER BY {IFACE_ORDER}", (did,))]
    if dev["hostname"]:
        hosts.append(dev["hostname"])
    creds = [dict(r) for r in conn.execute(
        "SELECT id, label, kind, username, url, password_enc IS NOT NULL AS has_password FROM credentials "
        "WHERE device_id = ? OR service_id IN (SELECT id FROM services WHERE device_id = ?) "
        "ORDER BY (kind LIKE '%SSH%') DESC, (kind LIKE '%OS%') DESC, id", (did, did))]
    for c in creds:  # an SSH login's own address is the best guess
        h = c["url"] and (_url_host(c["url"]) if "://" in c["url"] else c["url"].split(":")[0])
        if h and h not in hosts and re.search(r"ssh|os", c["kind"] or "", re.I):
            hosts.insert(0, h)
    return {"hosts": list(dict.fromkeys(hosts)), "credentials": creds, **remote.available(),
            "is_windows": bool(re.search(r"windows", dev["os"] or "", re.I))}


# ---------------------------------------------------------------------------
# Docker containers on a device (harm/docker.py). The last list read is kept, so the device page and
# Status show it without connecting; reading again and every operation is one click, while unlocked.
# ---------------------------------------------------------------------------

def _docker_get(conn, did: int) -> tuple[dict, dict | None]:
    def load(key):
        try:
            return json.loads(db.get_meta(conn, key) or "null")
        except ValueError:
            return None
    return load(f"docker_conf:{did}") or {}, load(f"docker:{did}")


async def _docker_run(conn, s, conf: dict, script: str, trust: bool = False) -> dict:
    host, port = str(conf.get("host") or ""), int(conf.get("port") or 22)
    row = conn.execute("SELECT * FROM credentials WHERE id = ?", (conf.get("credential_id"),)).fetchone() \
        if conf.get("credential_id") else None
    if not row or not row["username"]:
        raise HTTPException(400, "Pick a saved login with a username for this device")
    pw = _decrypt(s["dek"], row["password_enc"], "password")
    if pw and pw.startswith("<<"):
        pw = None
    try:
        if trust:
            await asyncio.to_thread(remote.forget_host, host, port)
        r = await asyncio.to_thread(remote.run_action, host, port, row["username"], pw, "script", script, bool(conf.get("sudo")),
                                    key=_hkey(conn, s))
    except remote.RemoteError as e:
        raise HTTPException(409 if e.code == "hostkey" else 400, str(e))
    try:
        docker._check(r["output"])
    except docker.DockerError as e:
        raise HTTPException(400, str(e))
    return r


def _docker_save(conn, did: int, snap: dict) -> dict:
    db.set_meta(conn, f"docker:{did}", json.dumps(snap))
    return snap


def docker_summary(conn, did: int) -> dict | None:
    """For Status and Home: how many containers, which aren't running or healthy, and when it was read."""
    _, snap = _docker_get(conn, did)
    if not snap:
        return None
    bad = [c["name"] for c in snap.get("containers", []) if c["state"] != "running" or c.get("health") == "unhealthy"]
    ups = sorted({c["name"] for c in snap.get("containers", []) if (snap.get("updates") or {}).get(c["image"]) == "update"})
    return {"at": snap.get("at"), "total": len(snap.get("containers", [])), "problems": bad, "updates": ups}


@app.get("/api/devices/{did}/docker")
def docker_get(did: int, _s=Depends(require_session), conn=Depends(get_db)):
    fetch_one(conn, "devices", did)
    conf, snap = _docker_get(conn, did)
    return {"conf": conf, "snap": snap}


@app.post("/api/devices/{did}/docker/read")
async def docker_read(did: int, request: Request, s=Depends(require_session), conn=Depends(get_db)):
    """List the containers (and remember how to reach this device's Docker)."""
    dev = fetch_one(conn, "devices", did)
    if DEMO:
        raise HTTPException(501, DEMO_NO_NETWORK)
    body = await body_json(request)
    conf, snap = _docker_get(conn, did)
    if "host" in body:
        conf = {"host": str(body.get("host") or "").strip(), "port": int(body.get("port") or 22),
                "credential_id": _coerce(conn, "credential_id", "fk:credentials", body.get("credential_id")),
                "sudo": bool(body.get("sudo"))}
    if not conf.get("host"):
        raise HTTPException(400, "host: enter the address to reach it over SSH")
    r = await _docker_run(conn, s, conf, docker.LIST_SCRIPT, bool(body.get("trust_new_key")))
    db.set_meta(conn, f"docker_conf:{did}", json.dumps(conf))
    snap = _docker_save(conn, did, {**(snap or {}), "at": monitor._now(), "containers": docker.parse_list(r["output"])})
    audit(conn, request, "docker-read", "devices", did, f"{dev['name']}: {len(snap['containers'])} containers")
    conn.commit()
    return {"conf": conf, "snap": snap}


@app.post("/api/devices/{did}/docker/check")
async def docker_check(did: int, request: Request, s=Depends(require_session), conn=Depends(get_db)):
    """Ask the registries whether each image has a newer version (nothing is downloaded)."""
    fetch_one(conn, "devices", did)
    if DEMO:
        raise HTTPException(501, DEMO_NO_NETWORK)
    conf, snap = _docker_get(conn, did)
    if not conf or not snap:
        raise HTTPException(400, "Read the containers first")
    r = await _docker_run(conn, s, conf, docker.CHECK_SCRIPT + "echo HARM_LIST\n" + docker.LIST_SCRIPT)
    check, _, listing = r["output"].partition("HARM_LIST")
    updates, versions = docker.parse_check(check)
    snap = _docker_save(conn, did, {**snap, "at": monitor._now(), "containers": docker.parse_list(listing),
                                    "updates": updates, "versions": versions, "checked_at": monitor._now()})
    conn.commit()
    return {"conf": conf, "snap": snap}


@app.post("/api/devices/{did}/docker/op")
async def docker_op(did: int, request: Request, s=Depends(require_session), conn=Depends(get_db)):
    """One operation on one container: update, restart, stop, start or logs. Then the list is read again."""
    dev = fetch_one(conn, "devices", did)
    if DEMO:
        raise HTTPException(501, DEMO_NO_NETWORK)
    body = await body_json(request)
    conf, snap = _docker_get(conn, did)
    op = str(body.get("op") or "")
    c = next((x for x in (snap or {}).get("containers", []) if x["name"] == body.get("name")), None)
    if not c or op not in docker.OPS:
        raise HTTPException(400, "Unknown container or operation. Read the containers again")
    try:
        script = docker.op_script(c, op)
    except docker.DockerError as e:
        raise HTTPException(400, str(e))
    if op == "logs":
        r = await _docker_run(conn, s, conf, script)
        return {"ok": r["ok"], "output": r["output"]}
    r = await _docker_run(conn, s, conf, f"(\n{script})\nrc=$?\necho HARM_LIST\n{docker.LIST_SCRIPT}exit $rc\n")
    out, _, listing = r["output"].partition("HARM_LIST")
    snap = {**snap, "at": monitor._now(), "containers": docker.parse_list(listing)}
    if op == "update" and r["ok"] and "HARM_RESULT=pulled-only" not in out:
        snap["updates"] = {**(snap.get("updates") or {}), c["image"]: "current"}
    _docker_save(conn, did, snap)
    if r["ok"]:
        v = ((snap.get("versions") or {}).get(c["image"]) or {})
        did_note(conn, did, {"update": f"Updated container {c['name']}" + (f" to {v['new']}" if v.get("new") else "")
                             + (" (already up to date)" if "HARM_RESULT=same" in out else "") + ".",
                             "restart": f"Restarted container {c['name']}.", "stop": f"Stopped container {c['name']}.",
                             "start": f"Started container {c['name']}."}[op])
    audit(conn, request, f"docker-{op}", "devices", did, f"{dev['name']}: {c['name']} ({'worked' if r['ok'] else 'failed'})")
    conn.commit()
    return {"ok": r["ok"], "message": docker.op_result(op, out) if r["ok"] else "", "output": out.strip(), "snap": snap}


@app.post("/api/devices/{did}/docker/prune")
async def docker_prune(did: int, request: Request, s=Depends(require_session), conn=Depends(get_db)):
    """Delete images no container uses any more (left over after updates)."""
    dev = fetch_one(conn, "devices", did)
    if DEMO:
        raise HTTPException(501, DEMO_NO_NETWORK)
    conf, _ = _docker_get(conn, did)
    r = await _docker_run(conn, s, conf, docker.PRUNE_SCRIPT)
    m = re.search(r"Total reclaimed space:\s*(.+)", r["output"])
    if r["ok"]:
        did_note(conn, did, "Cleaned up old Docker images" + (f" ({m.group(1).strip()} freed)." if m else "."))
    audit(conn, request, "docker-prune", "devices", did, dev["name"])
    conn.commit()
    return {"ok": r["ok"], "freed": m.group(1).strip() if m else "", "output": r["output"]}


# ---------------------------------------------------------------------------
# Machine health and updates (harm/machine.py, harm/upkeep.py), over the same SSH connection as
# Docker. Checking only reads; installing updates and restarting are one click each.
# ---------------------------------------------------------------------------

def did_note(conn, did: int | None, text: str) -> None:
    """The maintenance log: what HaRM did, as a "Did" note on the device (Settings can turn it off)."""
    if did and monitor.settings(conn)["auto_log"]:
        conn.execute("INSERT INTO notes (entity, entity_id, kind, body) VALUES ('devices', ?, 'action', ?)", (did, text[:2000]))


def _machine_login(conn, s, conf: dict) -> tuple[str, str | None]:
    row = conn.execute("SELECT * FROM credentials WHERE id = ?", (conf.get("credential_id"),)).fetchone() \
        if conf.get("credential_id") else None
    if not row or not row["username"]:
        raise HTTPException(400, "Pick a saved login with a username for this device")
    pw = _decrypt(s["dek"], row["password_enc"], "password")
    return row["username"], (None if pw and pw.startswith("<<") else pw)


def _machine_view(conn, did: int) -> dict:
    conf = upkeep.connection(conn, did)
    bg = upkeep.bg_logins(conn).get(str(did))
    return {"conf": conf, "snap": upkeep.load(conn, f"machine:{did}"), "labels": upkeep.load(conn, f"machine_labels:{did}", {}),
            "backups": upkeep.load(conn, f"machine_backups:{did}", []), "problems": upkeep.problems(conn, did),
            "error": upkeep.load(conn, f"machine_error:{did}"),
            "background": {"on": bool(bg), "label": (bg or {}).get("label", ""), "since": (bg or {}).get("at")}}


async def _machine_check(conn, s, did: int, conf: dict, trust: bool = False) -> None:
    user, pw = _machine_login(conn, s, conf)
    try:
        if trust:
            await asyncio.to_thread(remote.forget_host, conf["host"], int(conf.get("port") or 22))
        _, events = await upkeep.check_one(conn, did, user, pw, conf, key=_hkey(conn, s))
    except remote.RemoteError as e:
        raise HTTPException(409 if e.code == "hostkey" else 400, str(e))
    except machine.MachineError as e:
        raise HTTPException(400, str(e))
    upkeep.save(conn, f"machine_error:{did}", None)
    if events:
        task = asyncio.ensure_future(asyncio.to_thread(alerts.deliver, events))
        monitor._sending.add(task)
        task.add_done_callback(monitor._sending.discard)


@app.get("/api/devices/{did}/machine")
def machine_get(did: int, _s=Depends(require_session), conn=Depends(get_db)):
    fetch_one(conn, "devices", did)
    return _machine_view(conn, did)


@app.post("/api/devices/{did}/machine/check")
async def machine_check(did: int, request: Request, s=Depends(require_session), conn=Depends(get_db)):
    """Read the machine's health, updates and backups (and its containers, if HaRM reads them)."""
    dev = fetch_one(conn, "devices", did)
    if DEMO:
        raise HTTPException(501, DEMO_NO_NETWORK)
    body = await body_json(request)
    conf = upkeep.connection(conn, did)
    if "host" in body:
        conf = {"host": str(body.get("host") or "").strip(), "port": int(body.get("port") or 22),
                "credential_id": _coerce(conn, "credential_id", "fk:credentials", body.get("credential_id")),
                "sudo": bool(body.get("sudo"))}
    if not conf.get("host"):
        raise HTTPException(400, "host: enter the address to reach it over SSH")
    await _machine_check(conn, s, did, conf, bool(body.get("trust_new_key")))
    db.set_meta(conn, f"docker_conf:{did}", json.dumps(conf))
    audit(conn, request, "machine-check", "devices", did, dev["name"])
    conn.commit()
    return _machine_view(conn, did)


@app.post("/api/devices/{did}/machine/labels")
async def machine_labels(did: int, request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    """What a disk, volume or pool really is ("12 × 4 TB in RAID 6"), shown over what the system reports."""
    fetch_one(conn, "devices", did)
    body = await body_json(request)
    key = str(body.get("key") or "")
    if not re.match(r"^(vol|disk|pool|md):.{1,250}$", key):
        raise HTTPException(400, "Unknown disk or volume")
    labels = upkeep.load(conn, f"machine_labels:{did}", {})
    item = {"name": " ".join(str(body.get("name") or "").split())[:80], "real": " ".join(str(body.get("real") or "").split())[:120],
            "ignore": bool(body.get("ignore"))}
    if any(item.values()):
        labels[key] = item
    else:
        labels.pop(key, None)
    upkeep.save(conn, f"machine_labels:{did}", labels or None)
    conn.commit()
    return _machine_view(conn, did)


@app.post("/api/devices/{did}/machine/backups")
async def machine_backups(did: int, request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    """The backups to watch on this machine: folders that should get new files, and ZFS snapshots."""
    fetch_one(conn, "devices", did)
    body = await body_json(request)
    try:
        items = machine.clean_backups(body.get("backups") or [])
    except machine.MachineError as e:
        raise HTTPException(400, str(e))
    upkeep.save(conn, f"machine_backups:{did}", items or None)
    snap = upkeep.load(conn, f"machine:{did}")
    if snap:  # folders added now are read on the next check
        snap["backups"] = machine.backup_status(items, snap.get("folders") or {}, snap.get("snapshots") or {})
        upkeep.save(conn, f"machine:{did}", snap)
    conn.commit()
    return _machine_view(conn, did)


async def _machine_change(conn, s, request, did: int, what: str, script: str, timeout: int) -> dict:
    dev = fetch_one(conn, "devices", did)
    if DEMO:
        raise HTTPException(501, DEMO_NO_NETWORK)
    conf = upkeep.connection(conn, did)
    if not conf.get("host"):
        raise HTTPException(400, "Check the machine first")
    user, pw = _machine_login(conn, s, conf)
    try:
        r = await upkeep.run(conf["host"], int(conf.get("port") or 22), user, pw, bool(conf.get("sudo")), script, timeout, _hkey(conn, s))
    except remote.RemoteError as e:
        raise HTTPException(409 if e.code == "hostkey" else 400, str(e))
    why = machine.explain(r["output"])
    if why:
        raise HTTPException(400, why)
    audit(conn, request, f"machine-{what}", "devices", did, f"{dev['name']} ({'worked' if r['ok'] else 'failed'})")
    return r


@app.post("/api/devices/{did}/machine/upgrade")
async def machine_upgrade(did: int, request: Request, s=Depends(require_session), conn=Depends(get_db)):
    """Install the waiting OS updates (apt, dnf, pacman or apk), then check again."""
    before = (upkeep.load(conn, f"machine:{did}") or {}).get("updates") or {}
    r = await _machine_change(conn, s, request, did, "upgrade", machine.UPGRADE_SCRIPT, 1800)
    if r["ok"]:
        n = before.get("count") or 0
        names = ", ".join(p["name"] for p in (before.get("packages") or [])[:8])
        did_note(conn, did, f"Installed {n} update{'s' if n != 1 else ''}" + (f" ({names}{'…' if n > 8 else ''})" if names else "")
                 + (". Needs a restart to finish." if "HARM_REBOOT=1" in r["output"] else "."))
        try:
            await _machine_check(conn, s, did, upkeep.connection(conn, did))
        except HTTPException:
            pass
    conn.commit()
    return {"ok": r["ok"], "output": r["output"][-20000:], **_machine_view(conn, did)}


@app.post("/api/devices/{did}/machine/reboot")
async def machine_reboot(did: int, request: Request, s=Depends(require_session), conn=Depends(get_db)):
    r = await _machine_change(conn, s, request, did, "reboot", machine.REBOOT_SCRIPT, 60)
    if r["ok"]:
        did_note(conn, did, "Restarted the machine.")
        snap = upkeep.load(conn, f"machine:{did}")
        if snap:
            upkeep.save(conn, f"machine:{did}", {**snap, "restarted_at": upkeep.now()})
    conn.commit()
    return {"ok": r["ok"], "output": r["output"]}


@app.post("/api/devices/{did}/background")
async def machine_background(did: int, request: Request, s=Depends(require_session), conn=Depends(get_db)):
    """Turn background checks on for this machine with a login (copied, encrypted with background.key), or off."""
    dev = fetch_one(conn, "devices", did)
    body = await body_json(request)
    if not body.get("on"):
        upkeep.bg_forget(conn, did)
        audit(conn, request, "background-off", "devices", did, dev["name"])
        conn.commit()
        return _machine_view(conn, did)
    conf = upkeep.connection(conn, did)
    if not conf.get("host"):
        raise HTTPException(400, "Check the machine once first, so HaRM knows how to reach it")
    cid = _coerce(conn, "credential_id", "fk:credentials", body.get("credential_id")) or conf.get("credential_id")
    user, pw = _machine_login(conn, s, {"credential_id": cid})
    if body.get("use_key"):  # sign in with HaRM's key: no password is copied
        priv = _hkey(conn, s)
        if not priv:
            raise HTTPException(400, "Make HaRM's SSH key first, in Settings > Locking and security")
        upkeep.bg_set_key(conn, priv)
        pw = None
    label = conn.execute("SELECT label FROM credentials WHERE id = ?", (cid,)).fetchone()["label"]
    sudo = str(body.get("sudo") or "none")
    if sudo not in ("all", "limited", "none"):
        raise HTTPException(400, "sudo: all, limited or none")
    upkeep.bg_set(conn, did, user, pw, f"{label} ({user}{', SSH key' if body.get('use_key') else ''})", sudo)
    audit(conn, request, "background-on", "devices", did, f"{dev['name']}: {label}")
    conn.commit()
    return _machine_view(conn, did)


def _maintenance(conn) -> dict:
    """Everything across machines that needs attention or an update, for Maintenance and Home."""
    st = monitor.settings(conn)
    machines, containers = [], []
    for dev in upkeep.devices_with_connection(conn):
        did = dev["id"]
        snap = upkeep.load(conn, f"machine:{did}")
        dk = upkeep.load(conn, f"docker:{did}")
        u = (snap or {}).get("updates") or {}
        machines.append({"id": did, "name": dev["name"], "at": (snap or {}).get("at"), "os": ((snap or {}).get("os") or {}).get("name"),
                         "problems": upkeep.problems(conn, did), "error": upkeep.load(conn, f"machine_error:{did}"),
                         "updates": {"count": u.get("count", 0), "security": u.get("security", 0), "manager": u.get("manager"),
                                     "packages": (u.get("packages") or [])[:60]},
                         "reboot": ((snap or {}).get("reboot") or {}).get("needed", False) and not (snap or {}).get("restarted_at"),
                         "uptime_s": (snap or {}).get("uptime_s"), "backups": (snap or {}).get("backups", []),
                         "background": str(did) in upkeep.bg_logins(conn), "docker_at": (dk or {}).get("checked_at")})
        for c in (dk or {}).get("containers", []):
            if (dk.get("updates") or {}).get(c["image"]) == "update":
                containers.append({"device_id": did, "device": dev["name"], "name": c["name"], "image": c["image"],
                                   "project": c.get("project"), **((dk.get("versions") or {}).get(c["image"]) or {})})
    pve = upkeep.load(conn, "proxmox_live")
    pve_probs = upkeep.pve_problems(conn, st["pve_backup_days"])
    return {"machines": machines, "containers": containers, "proxmox": pve, "proxmox_problems": pve_probs,
            "old_logins": [dict(r) for r in _old_logins(conn)], "password_days": st["password_days"],
            "proxmox_ready": bool(_pve_conf(conn).get("url") and db.get_meta(conn, "proxmox_secret")),
            "background": {"on": st["bg_checks"], "hours": st["bg_hours"], "last": upkeep.load(conn, "bg_last"),
                           "next": upkeep.next_run(st), "proxmox": bool(upkeep.load(conn, "bg_proxmox"))}}


def _old_logins(conn) -> list:
    """Logins with a password that hasn't changed in a while (Settings > Status and actions > Maintenance).
    One never marked as changed counts from when it was saved."""
    days = monitor.settings(conn)["password_days"]
    if not days:
        return []
    return conn.execute(
        "SELECT c.id, c.label, c.username, c.kind, c.device_id, d.name AS device, "
        "COALESCE(c.last_rotated, date(c.created_at)) AS last_rotated, c.last_rotated IS NULL AS no_date "
        "FROM credentials c LEFT JOIN devices d ON d.id = c.device_id "
        "WHERE c.password_enc IS NOT NULL AND COALESCE(c.last_rotated, date(c.created_at)) <= date('now', ?) "
        "ORDER BY 7 LIMIT 200", (f"-{days} days",)).fetchall()


def maintenance_summary(conn) -> dict:
    m = _maintenance(conn)
    items = [{**p, "device": x["name"], "device_id": x["id"]} for x in m["machines"] for p in x["problems"] if p["level"] != "info"]
    items += [{**p, "device": "Proxmox"} for p in m["proxmox_problems"]]
    return {"problems": sorted(items, key=lambda p: p["level"] != "bad")[:20],
            "updates": sum(1 for x in m["machines"] if x["updates"]["count"]) + len({c["device_id"] for c in m["containers"]}),
            "security": sum(x["updates"]["security"] for x in m["machines"]),
            "containers": len(m["containers"]), "reboot": sum(1 for x in m["machines"] if x["reboot"])}


@app.get("/api/maintenance")
def maintenance(_s=Depends(require_session), conn=Depends(get_db)):
    return _maintenance(conn)


@app.post("/api/maintenance/check-all")
async def maintenance_check_all(request: Request, s=Depends(require_session), conn=Depends(get_db)):
    """Check every machine HaRM can reach (and ask registries about their containers' images)."""
    if DEMO:
        raise HTTPException(501, DEMO_NO_NETWORK)
    body = await body_json(request)
    results = []
    for dev in upkeep.devices_with_connection(conn):
        conf = upkeep.connection(conn, dev["id"])
        if not conf.get("host") or not conf.get("credential_id"):
            continue
        try:
            await _machine_check(conn, s, dev["id"], conf)
            if body.get("images", True) and upkeep.load(conn, f"docker:{dev['id']}") is not None:
                r = await _docker_run(conn, s, conf, docker.CHECK_SCRIPT)
                updates, versions = docker.parse_check(r["output"])
                snap = upkeep.load(conn, f"docker:{dev['id']}", {})
                _docker_save(conn, dev["id"], {**snap, "updates": updates, "versions": versions, "checked_at": monitor._now()})
            results.append({"device": dev["name"], "ok": True})
        except HTTPException as e:
            upkeep.save(conn, f"machine_error:{dev['id']}", {"at": upkeep.now(), "error": e.detail})
            results.append({"device": dev["name"], "ok": False, "error": e.detail})
        conn.commit()
    if _pve_conf(conn).get("url") and db.get_meta(conn, "proxmox_secret"):
        try:
            await asyncio.to_thread(upkeep.pve_read, conn, _pve_secret(conn, s))
        except proxmox.ProxmoxError as e:
            results.append({"device": "Proxmox", "ok": False, "error": str(e)})
    audit(conn, request, "check-all", None, None, f"{sum(r['ok'] for r in results)} of {len(results)} machines checked")
    conn.commit()
    return {"results": results, **_maintenance(conn)}


# ---------------------------------------------------------------------------
# Proxmox: live state, backups and one-click power and snapshots, with the token saved in Discover.
# ---------------------------------------------------------------------------

def _pve_secret(conn, s) -> str:
    blob = db.get_meta(conn, "proxmox_secret")
    if not blob:
        raise HTTPException(400, "Connect Proxmox first, in Discover > Proxmox, with “remember” on")
    try:
        return crypto.unseal(s["dek"], crypto.b64d(blob), PVE_AAD).decode()
    except crypto.DecryptError:
        raise HTTPException(400, "The saved Proxmox token can't be read. Enter it again in Discover > Proxmox")


def _pve_error(e: proxmox.ProxmoxError) -> HTTPException:
    return HTTPException(409 if e.code == "pin" else 400, str(e))


@app.post("/api/proxmox/live")
async def proxmox_live(request: Request, s=Depends(require_session), conn=Depends(get_db)):
    if DEMO:
        raise HTTPException(501, DEMO_NO_NETWORK)
    body = await body_json(request)
    if body.get("trust_new_cert"):
        conf = _pve_conf(conn)
        conf.pop("fingerprint", None)
        db.set_meta(conn, "proxmox", json.dumps(conf))
    secret = _pve_secret(conn, s)
    try:
        snap = await asyncio.to_thread(upkeep.pve_read, conn, secret)
    except proxmox.ProxmoxError as e:
        raise _pve_error(e)
    conf = _pve_conf(conn)
    if not conf.get("fingerprint"):  # pinned on first use
        try:
            px = upkeep.pve_client(conn, secret)
            px.get("/version")
            db.set_meta(conn, "proxmox", json.dumps({**conf, "fingerprint": px.fingerprint}))
        except proxmox.ProxmoxError:
            pass
    conn.commit()
    return {**_maintenance(conn), "proxmox": snap}


@app.post("/api/background/proxmox")
async def background_proxmox(request: Request, s=Depends(require_session), conn=Depends(get_db)):
    """Read Proxmox in the background too: a copy of the token, encrypted with background.key."""
    body = await body_json(request)
    upkeep.bg_set_proxmox(conn, _pve_secret(conn, s) if body.get("on") else None)
    audit(conn, request, "background-proxmox", None, None, "on" if body.get("on") else "off")
    conn.commit()
    return {"on": bool(body.get("on"))}


@app.post("/api/proxmox/op")
async def proxmox_op(request: Request, s=Depends(require_session), conn=Depends(get_db)):
    """Start, shut down, reboot, stop or snapshot one VM or container."""
    if DEMO:
        raise HTTPException(501, DEMO_NO_NETWORK)
    body = await body_json(request)
    node, kind, vmid, op = (str(body.get(k) or "") for k in ("node", "type", "vmid", "op"))
    try:
        px = upkeep.pve_client(conn, _pve_secret(conn, s))
        r = await asyncio.to_thread(proxmox.guest_op, px, node, kind, vmid, op, str(body.get("note") or "")[:200])
        snap = await asyncio.to_thread(upkeep.pve_read, conn, _pve_secret(conn, s))
    except proxmox.ProxmoxError as e:
        raise _pve_error(e)
    g = next((x for x in snap["guests"] if x["vmid"] == vmid), {"name": vmid})
    host = conn.execute("SELECT id FROM devices WHERE LOWER(name) = ? OR LOWER(hostname) = ?", (node.lower(), node.lower())).fetchone()
    dev = conn.execute("SELECT id FROM devices WHERE vm_id = ? AND (host_id = ? OR ? IS NULL)",
                       (vmid, host["id"] if host else None, host["id"] if host else None)).fetchone()
    words = {"start": "Started", "shutdown": "Shut down", "reboot": "Rebooted", "stop": "Stopped (forced)",
             "snapshot": f"Took snapshot {r.get('snapshot', '')} of"}[op]
    if r["ok"]:
        did_note(conn, dev["id"] if dev else (host["id"] if host else None), f"{words} {g['name']} ({vmid}) on Proxmox.")
    audit(conn, request, f"proxmox-{op}", "devices", dev["id"] if dev else None, f"{g['name']} ({vmid}) on {node}: "
          f"{'worked' if r['ok'] else r.get('detail') or 'failed'}")
    conn.commit()
    return {**r, "proxmox": snap}


# ---------------------------------------------------------------------------
# A terminal in the page (harm/terminal.py): SSH with a saved login, while unlocked.
# ---------------------------------------------------------------------------

def _owner(request: Request) -> str:
    return hashlib.sha256((request.cookies.get(COOKIE) or "").encode()).hexdigest()


def _owner_alive(owner: str) -> bool:
    now = time.time()
    with _sessions_lock:
        return any(hashlib.sha256(t.encode()).hexdigest() == owner and not _expired(s, now) for t, s in _sessions.items())


def _vnc_ports(conn, did: int) -> set[int]:
    """The ports VNC may be opened on for this device: 5900-5999, and its services called VNC."""
    ports = {r["port"] for r in conn.execute("SELECT port FROM services WHERE device_id = ? AND port IS NOT NULL "
                                             "AND (name LIKE '%vnc%' OR url LIKE 'vnc:%')", (did,))}
    return ports | set(range(5900, 6000))


@app.post("/api/vnc")
async def vnc_open(request: Request, s=Depends(require_session), conn=Depends(get_db)):
    """A one-minute ticket for the page to open a VNC screen on one of this device's addresses."""
    if not monitor.settings(conn)["terminal"]:
        raise HTTPException(403, "The terminal and screen in HaRM are turned off in Settings > Locking and security")
    if DEMO:
        raise HTTPException(501, DEMO_NO_NETWORK)
    body = await body_json(request)
    did = _coerce(conn, "device_id", "fk:devices", body.get("device_id"))
    if not did:
        raise HTTPException(400, "Open VNC from a device")
    dev = fetch_one(conn, "devices", did)
    host, port = str(body.get("host") or "").strip(), int(body.get("port") or 5900)
    if host not in collect_targets(did, s, conn)["hosts"]:
        raise HTTPException(400, "That isn't one of this device's addresses (add it on its Network tab)")
    if port not in _vnc_ports(conn, did):
        raise HTTPException(400, "VNC opens on ports 5900 to 5999, or a service on this device named VNC")
    try:
        t = vnc.ticket(_owner(request), host, port, f"{dev['name']} ({host}:{port})")
    except vnc.VNCError as e:
        raise HTTPException(400, str(e))
    audit(conn, request, "vnc-open", "devices", did, f"{dev['name']}: {host}:{port}")
    conn.commit()
    return {"ticket": t, "label": f"{dev['name']} · {host}:{port}"}


@app.websocket("/api/vnc/ws")
async def vnc_socket(ws: WebSocket, t: str = ""):
    origin = urlparse(ws.headers.get("origin") or "").netloc
    if not origin or origin != ws.headers.get("host"):
        await ws.close(1008)  # only HaRM's own page
        return
    owner = hashlib.sha256((ws.cookies.get(COOKIE) or "").encode()).hexdigest()
    v = vnc.take(t, owner) if _owner_alive(owner) else None
    if not v:
        await ws.close(1008)
        return
    asked = [p.strip() for p in (ws.headers.get("sec-websocket-protocol") or "").split(",") if p.strip()]
    await ws.accept(subprotocol="binary" if "binary" in asked else None)
    await vnc.relay(ws, v["host"], v["port"], owner, _owner_alive)


@app.post("/api/terminal")
async def terminal_open(request: Request, s=Depends(require_session), conn=Depends(get_db)):
    if not monitor.settings(conn)["terminal"]:
        raise HTTPException(403, "The terminal is turned off in Settings > Locking and security")
    if DEMO:
        raise HTTPException(501, DEMO_NO_NETWORK)
    body = await body_json(request)
    did = _coerce(conn, "device_id", "fk:devices", body.get("device_id"))
    dev = fetch_one(conn, "devices", did) if did else None
    host, port = str(body.get("host") or "").strip(), int(body.get("port") or 22)
    user, pw = str(body.get("username") or "").strip(), None
    if body.get("credential_id"):
        row = conn.execute("SELECT * FROM credentials WHERE id = ?", (body["credential_id"],)).fetchone()
        if not row:
            raise HTTPException(400, "That login doesn't exist any more")
        user = user or row["username"] or ""
        pw = _decrypt(s["dek"], row["password_enc"], "password")
        if pw and pw.startswith("<<"):
            pw = None
    if not host or not user:
        raise HTTPException(400, "Enter the address and pick a login (or a username)")
    terminal.reap(_owner_alive)
    try:
        if body.get("trust_new_key"):
            await asyncio.to_thread(remote.forget_host, host, port)
        t = await asyncio.to_thread(terminal.start, _owner(request), f"{user}@{host}", host, port, user, pw,
                                    int(body.get("cols") or 100), int(body.get("rows") or 30), bool(body.get("legacy")), _hkey(conn, s))
    except terminal.TerminalError as e:
        raise HTTPException(400, str(e))
    audit(conn, request, "terminal-open", "devices" if dev else None, did, f"{dev['name'] + ': ' if dev else ''}{user}@{host}:{port}")
    conn.commit()
    return {"id": t.id, "label": t.label}


def _term(request: Request, tid: str) -> "terminal.Session":
    try:
        return terminal.get(tid, _owner(request))
    except terminal.TerminalError as e:
        raise HTTPException(404, str(e))


@app.get("/api/terminal/{tid}/stream")
async def terminal_stream(tid: str, request: Request, after: int = 0, _s=Depends(require_session)):
    """What the machine prints, as server-sent events (the page reconnects with ?after= if it drops)."""
    t = _term(request, tid)
    owner = _owner(request)
    try:  # a browser that reconnects says what it already has
        after = max(after, int(request.headers.get("last-event-id") or 0))
    except ValueError:
        pass

    async def events():
        last = after
        yield "retry: 2000\n\n"
        while True:
            if await request.is_disconnected():
                return
            if not _owner_alive(owner):
                t.end("HaRM was locked, so the terminal closed.")
            chunks, ended = await asyncio.to_thread(t.since, last, 10)
            for seq, text in chunks:
                last = seq
                yield f"id: {seq}\ndata: {json.dumps(text)}\n\n"
            if ended:
                yield f"event: end\ndata: {json.dumps(ended)}\n\n"
                return
            if not chunks:
                yield ": still here\n\n"

    return StreamingResponse(events(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no"})


@app.post("/api/terminal/{tid}/input")
async def terminal_input(tid: str, request: Request, _s=Depends(require_session)):
    body = await body_json(request)
    t = _term(request, tid)
    try:
        t.write(str(body.get("d") or "")[:65536])
    except (terminal.TerminalError, OSError) as e:
        raise HTTPException(410, str(e))
    return {"ok": True}


@app.post("/api/terminal/{tid}/resize")
async def terminal_resize(tid: str, request: Request, _s=Depends(require_session)):
    body = await body_json(request)
    try:
        _term(request, tid).resize(int(body.get("cols") or 80), int(body.get("rows") or 24))
    except (ValueError, OSError):
        pass
    return {"ok": True}


@app.post("/api/terminal/{tid}/close")
async def terminal_close(tid: str, request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    try:
        t = terminal.get(tid, _owner(request))
    except terminal.TerminalError:
        return {"ok": True}
    t.end("You closed the terminal.")
    audit(conn, request, "terminal-close", None, None, t.label)
    conn.commit()
    return {"ok": True}


@app.post("/api/devices/{did}/collect")
async def collect_remote(did: int, request: Request, s=Depends(require_session), conn=Depends(get_db)):
    """Run the spec collector over SSH (or on this server) and return its output for the preview."""
    dev = fetch_one(conn, "devices", did)
    if DEMO:
        raise HTTPException(501, DEMO_NO_NETWORK)
    body = await body_json(request)
    try:
        if body.get("mode") == "local":
            out = await asyncio.to_thread(remote.collect_local)
            where = "the HaRM server"
        else:
            user, pw = str(body.get("username") or ""), body.get("password") or None
            cid = body.get("credential_id")
            if cid:
                row = conn.execute("SELECT * FROM credentials WHERE id = ?", (int(cid),)).fetchone()
                if not row:
                    raise HTTPException(404, "That login no longer exists")
                user = user or row["username"] or ""
                pw = _decrypt(s["dek"], row["password_enc"], "password")
                if pw and pw.startswith("<<"):
                    pw = None
            host, port = str(body.get("host") or ""), int(body.get("port") or 22)
            if body.get("trust_new_key"):
                await asyncio.to_thread(remote.forget_host, host, port)
            out = await asyncio.to_thread(remote.collect_ssh, host, port, user, pw,
                                          bool(body.get("sudo", True)), str(body.get("os") or "auto"), _hkey(conn, s))
            where = f"{user}@{host}"
    except remote.RemoteError as e:
        audit(conn, request, "collect-failed", "devices", did, f"{dev['name']}: {e}")
        conn.commit()
        return JSONResponse({"detail": str(e), "code": e.code}, status_code=400)
    except ValueError:
        raise HTTPException(400, "Port must be a number")
    audit(conn, request, "collect", "devices", did, f"{dev['name']} via {where}")
    conn.commit()
    return {"output": out[:2_000_000]}


def _match_cpu(conn, cpu: dict) -> dict:
    """Turn the collector's CPU into a part, linked to the parts library when it's there."""
    model = re.sub(r"\(R\)|\(TM\)|\bCPU\b|@.*$|\d+-Core Processor|Processor", " ", cpu["model"], flags=re.I)
    model = re.sub(r"\s+", " ", model).strip()
    toks = [t for t in re.split(r"[\s-]+", model) if len(t) > 1 and t.lower() not in ("amd", "intel", "core", "gen", "th")]
    best = None
    if toks:
        key = toks[-1]  # the model number, e.g. 4234, E5-2680, 7950X3D
        for row in conn.execute("SELECT * FROM catalog_parts WHERE category = 'cpu' AND name LIKE ? LIMIT 50",
                                (f"%{key}%",)).fetchall():
            name = row["name"].lower()
            # Prefer the plain retail entry over OEM/tray duplicates and long names.
            score = sum(1 for t in toks if t.lower() in name) - (0.5 if "oem" in name or "tray" in name else 0) \
                - len(name) / 1000
            if (cpu.get("cores_each") and json.loads(row["specs"]).get("cores") not in (None, cpu["cores_each"])):
                continue
            if best is None or score > best[0]:
                best = (score, row)
    sockets = cpu.get("sockets") or 1
    if best and best[0] >= max(1, len(toks) - 1):
        row = best[1]
        return {"category": "CPU", "manufacturer": row["manufacturer"], "model": row["name"].replace((row["manufacturer"] or "") + " ", "", 1),
                "catalog_id": row["id"], "quantity": sockets, "interface": json.loads(row["specs"]).get("socket"),
                "library_match": row["name"]}
    maker = "AMD" if "amd" in cpu["model"].lower() else "Intel" if "intel" in cpu["model"].lower() else None
    return {"category": "CPU", "manufacturer": maker, "model": model.replace(maker or "", "").strip() or model,
            "quantity": sockets, "capacity": f"{cpu['cores_each']}C/{cpu['threads_each']}T" if cpu.get("cores_each") else None,
            "custom_specs": {"cores": cpu.get("cores_each"), "threads": cpu.get("threads_each")}}


@app.get("/api/export/bundle")
def export_bundle(request: Request, ids: str, _s=Depends(require_session), conn=Depends(get_db)):
    """Full records for chosen devices (never includes passwords or secrets)."""
    out = []
    for raw in ids.split(",")[:500]:
        if raw.strip().isdigit():
            try:
                d = device_full(int(raw), _s, conn)
            except HTTPException:
                continue
            dev = d["device"]
            dev["location_path"] = _location_path(conn, dev["location_id"])
            out.append(d)
    audit(conn, request, "export", "devices", None, f"{len(out)} device(s)")
    conn.commit()
    return out


def _location_path(conn, lid) -> str | None:
    parts, guard = [], 0
    while lid and guard < 25:
        r = conn.execute("SELECT name, parent_id FROM locations WHERE id = ?", (lid,)).fetchone()
        if not r:
            break
        parts.insert(0, r["name"])
        lid, guard = r["parent_id"], guard + 1
    return " > ".join(parts) or None


@app.get("/api/components/{cid}/fits")
def component_fits(cid: int, _s=Depends(require_session), conn=Depends(get_db)):
    """Devices with a free slot this component could go into."""
    comp = fetch_one(conn, "components", cid)
    out = []
    for sl in fetch_list(conn, "device_slots"):
        if not (iface_fits(sl["interface"], comp["interface"])
                and ff_fits(sl["form_factor"], comp["form_factor"])):
            continue
        n = next(x["used"] for x in _slots_with_usage(conn, sl["device_id"]) if x["id"] == sl["id"])
        if n < sl["total"]:
            out.append({"device_id": sl["device_id"], "device_name": sl["device_name"],
                        "slot": sl["interface"] + (f" {sl['form_factor']}" if sl["form_factor"] else ""),
                        "free": sl["total"] - n})
    return out


@app.get("/api/racks/{rid}/layout")
def rack_layout(rid: int, _s=Depends(require_session), conn=Depends(get_db)):
    return {
        "rack": fetch_one(conn, "racks", rid),
        "devices": fetch_list(conn, "devices", {"rack_id": rid}),
        "components": fetch_list(conn, "components", {"rack_id": rid, "device_id": "null"}),
        "online": {d["id"]: monitor.device_state(conn, d, with_history=False)["state"]
                   for d in fetch_list(conn, "devices", {"rack_id": rid})},
        "power": (p := power.summary(conn)) and {"rack": next((r for r in p["racks"] if r["id"] == rid), None),
                                                  "supplies": [x for x in p["supplies"] if x["rack_id"] == rid]},
    }


@app.post("/api/components/{cid}/install")
async def component_install(cid: int, request: Request, _s=Depends(require_session),
                            conn=Depends(get_db)):
    body = await body_json(request)
    comp = fetch_one(conn, "components", cid)
    if comp["device_id"]:
        raise HTTPException(400, f"Already installed in {comp['device_name']}")
    dev_id = _coerce(conn, "device_id", "fk:devices", body.get("device_id"))
    if dev_id is None:
        raise HTTPException(400, "device_id is required")
    qty = _coerce(conn, "quantity", "int", body.get("quantity", 1))
    if not qty or qty < 1 or qty > comp["quantity"]:
        raise HTTPException(400, f"quantity must be between 1 and {comp['quantity']}")
    dev = fetch_one(conn, "devices", dev_id)
    target = cid
    if qty < comp["quantity"]:
        conn.execute("UPDATE components SET quantity = quantity - ?, updated_at = datetime('now') "
                     "WHERE id = ?", (qty, cid))
        cols = [c for c in ENTITIES["components"]["fields"]]
        cur = conn.execute(
            f"INSERT INTO components ({', '.join(cols)}) "
            f"SELECT {', '.join(cols)} FROM components WHERE id = ?", (cid,))
        target = cur.lastrowid
    conn.execute(
        "UPDATE components SET device_id = ?, quantity = ?, status = 'Installed', rack_id = NULL, "
        "position = NULL, location_id = ?, updated_at = datetime('now') WHERE id = ?",
        (dev_id, qty, dev["location_id"], target))
    audit(conn, request, "install", "components", target, f"into device #{dev_id} ({dev['name']})")
    conn.commit()
    return fetch_one(conn, "components", target)


@app.post("/api/components/{cid}/split")
async def component_split(cid: int, request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    """Take one unit out of a group of identical parts (e.g. one drive of '6 × 2 TB')
    so it can be marked failed, moved or edited on its own, optionally pinned to a bay."""
    body = await body_json(request)
    comp = fetch_one(conn, "components", cid)
    slot_id = _coerce(conn, "slot_id", "fk:device_slots", body.get("slot_id"))
    bay = _coerce(conn, "bay", "int", body.get("bay"))
    if comp["quantity"] <= 1:
        if slot_id:
            conn.execute("UPDATE components SET slot_id = ?, bay = ? WHERE id = ?", (slot_id, bay, cid))
            conn.commit()
        return fetch_one(conn, "components", cid)
    cols = list(ENTITIES["components"]["fields"])
    conn.execute("UPDATE components SET quantity = quantity - 1, updated_at = datetime('now') WHERE id = ?", (cid,))
    new_id = conn.execute(f"INSERT INTO components ({', '.join(cols)}) SELECT {', '.join(cols)} FROM components WHERE id = ?",
                          (cid,)).lastrowid
    conn.execute("UPDATE components SET quantity = 1, serial = NULL, slot_id = COALESCE(?, slot_id), bay = ? WHERE id = ?",
                 (slot_id, bay, new_id))
    audit(conn, request, "split", "components", cid, f"one unit → #{new_id}")
    conn.commit()
    return fetch_one(conn, "components", new_id)


@app.post("/api/components/{cid}/uninstall")
async def component_uninstall(cid: int, request: Request, _s=Depends(require_session),
                              conn=Depends(get_db)):
    body = await body_json(request)
    comp = fetch_one(conn, "components", cid)
    if not comp["device_id"]:
        raise HTTPException(400, "Component is not installed")
    rack_id = _coerce(conn, "rack_id", "fk:racks", body.get("rack_id"))
    loc_id = _coerce(conn, "location_id", "fk:locations", body.get("location_id"))
    if rack_id and not loc_id:
        r = conn.execute("SELECT location_id FROM racks WHERE id = ?", (rack_id,)).fetchone()
        loc_id = r["location_id"]
    status = _coerce(conn, "status", "text", body.get("status")) or "In Stock"
    position = _coerce(conn, "position", "text", body.get("position"))
    conn.execute(
        "UPDATE components SET device_id = NULL, slot_id = NULL, bay = NULL, status = ?, rack_id = ?, "
        "location_id = COALESCE(?, location_id), position = ?, updated_at = datetime('now') "
        "WHERE id = ?", (status, rack_id, loc_id, position, cid))
    audit(conn, request, "uninstall", "components", cid, f"from device #{comp['device_id']}")
    conn.commit()
    return fetch_one(conn, "components", cid)


def _secrets_of(dek: bytes, row) -> dict:
    out = {
        "password": _decrypt(dek, row["password_enc"], "password"),
        "secret_notes": _decrypt(dek, row["secret_notes_enc"], "secret_notes"),
        "totp_secret": _decrypt(dek, row["totp_secret_enc"], "totp_secret"),
        "totp_code": None,
        "totp_remaining": None,
    }
    if out["totp_secret"] and not out["totp_secret"].startswith("<<"):
        t = pyotp.TOTP(out["totp_secret"])
        out["totp_code"] = t.now()
        out["totp_remaining"] = t.interval - int(time.time()) % t.interval
    return out


_WEB_KINDS = re.compile(r"web|ui|ipmi|bmc|idrac|ilo|imm|xcc|management|portal|admin|console", re.I)
_SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*://", re.I)


def _launch_targets(conn, row) -> list[dict]:
    """Ways to open what this login is for: web pages, SSH, RDP. Never includes the secret."""
    kind = row["kind"] or ""
    dev = conn.execute("SELECT * FROM devices WHERE id = ?", (row["device_id"],)).fetchone() if row["device_id"] else None
    svc = conn.execute("SELECT * FROM services WHERE id = ?", (row["service_id"],)).fetchone() if row["service_id"] else None
    if svc and not dev:
        dev = conn.execute("SELECT * FROM devices WHERE id = ?", (svc["device_id"],)).fetchone()
    ip = None
    if dev:
        r = conn.execute("SELECT ip FROM interfaces WHERE device_id = ? AND ip IS NOT NULL AND ip != '' "
                         f"ORDER BY {IFACE_ORDER} LIMIT 1", (dev["id"],)).fetchone()
        ip = r["ip"] if r else None
    dev_host = ip or (dev["hostname"] if dev else None)
    out, seen = [], set()

    def web(url, label):
        if url and _SCHEME.match(url) and url.lower().startswith(("http://", "https://")) and url not in seen:
            seen.add(url)
            out.append({"type": "web", "url": url, "label": label})

    cred_url = (row["url"] or "").strip()
    bare = cred_url if cred_url and not _SCHEME.match(cred_url) else None
    is_ssh = "ssh" in kind.lower() or (svc and (svc["protocol"] or "").upper() == "SSH")
    is_os = re.search(r"os account|rdp|remote desktop", kind, re.I)
    windows = bool(dev and re.search(r"windows", dev["os"] or "", re.I))
    web(cred_url, "Open login page")
    if svc:
        web(svc["url"], f"Open {svc['name']}")
    if _WEB_KINDS.search(kind) and not is_ssh:
        if bare:
            web(f"https://{bare}", f"Open https://{bare}")
        if dev:
            web(dev["mgmt_url"], "Open management page")
        if not out and dev_host:
            web(f"https://{dev_host}", f"Open https://{dev_host}")
    ssh_host = (_url_host(cred_url) if cred_url.lower().startswith("ssh://") else bare) or dev_host
    if ssh_host and (is_ssh or (is_os and not windows)):
        port = svc["port"] if svc and is_ssh and svc["port"] else 22
        out.append({"type": "ssh", "host": ssh_host, "port": port})
    if ssh_host and (re.search(r"rdp|remote desktop", kind, re.I) or (is_os and windows)):
        out.append({"type": "rdp", "host": ssh_host})
    return out


@app.post("/api/credentials/{cid}/reveal")
def credential_reveal(cid: int, request: Request, s=Depends(require_session),
                      conn=Depends(get_db)):
    row = conn.execute("SELECT * FROM credentials WHERE id = ?", (cid,)).fetchone()
    if not row:
        raise HTTPException(404, "Not found")
    out = _secrets_of(s["dek"], row)
    out["targets"] = _launch_targets(conn, row)
    audit(conn, request, "reveal", "credentials", cid, row["label"])
    conn.commit()
    return out


# ---------------------------------------------------------------------------
# Logins in and out (harm/vaultio.py): Bitwarden or Vaultwarden JSON, and changing a password on a machine.
# ---------------------------------------------------------------------------

def _bitwarden_items(conn, body: dict) -> list[dict]:
    raw = body.get("data")
    if isinstance(raw, str):
        if len(raw) > 20_000_000:
            raise HTTPException(400, "That file is too big")
        try:
            raw = json.loads(raw)
        except ValueError:
            raise HTTPException(400, "That file isn't JSON. In Bitwarden: Tools > Export vault, file format .json")
    try:
        items = vaultio.parse_bitwarden(raw)
    except vaultio.VaultIOError as e:
        raise HTTPException(400, str(e))
    vaultio.match_devices(items, fetch_list(conn, "devices", limit=5000))
    have = {(r["label"].lower(), (r["username"] or "").lower()) for r in conn.execute("SELECT label, username FROM credentials")}
    for i, it in enumerate(items):
        it["i"] = i
        it["duplicate"] = (it["label"].lower(), it["username"].lower()) in have
    return items


@app.post("/api/vault/bitwarden/preview")
async def bitwarden_preview(request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    """What a Bitwarden export holds, with the device each login seems to belong to. Secrets stay out of the answer."""
    items = _bitwarden_items(conn, await body_json(request))
    return {"items": [{k: it[k] for k in ("i", "label", "username", "url", "folder", "device", "duplicate")}
                      | {"has_password": bool(it["password"]), "has_totp": bool(it["totp"])} for it in items]}


@app.post("/api/vault/bitwarden/import")
async def bitwarden_import(request: Request, s=Depends(require_session), conn=Depends(get_db)):
    body = await body_json(request)
    items = _bitwarden_items(conn, body)
    picks = {int(p["i"]): p.get("device_id") for p in body.get("picks") or [] if isinstance(p, dict) and str(p.get("i", "")).isdigit()}
    n = 0
    for it in items:
        if it["i"] not in picks:
            continue
        did = _coerce(conn, "device_id", "fk:devices", picks[it["i"]]) if picks[it["i"]] else None
        sec = {"password": it["password"], "secret_notes": it["notes"]}
        try:
            sec["totp_secret"] = it["totp"]
            enc = _encrypt_secrets(sec, s["dek"])
        except HTTPException:  # a 2FA value HaRM can't use: keep it in the notes instead
            sec = {"password": it["password"], "secret_notes": "\n".join(x for x in (it["notes"], f"2FA: {it['totp']}") if x)}
            enc = _encrypt_secrets(sec, s["dek"])
        cols = {"label": it["label"], "username": it["username"] or None,
                "url": it["url"] or None, "device_id": did, **{k: v for k, v in enc.items() if v is not None}}
        cols = {k: v for k, v in cols.items() if v is not None}
        conn.execute(f"INSERT INTO credentials ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", list(cols.values()))
        n += 1
    audit(conn, request, "import", "credentials", None, f"Bitwarden: {n} logins")
    conn.commit()
    return {"imported": n}


@app.post("/api/vault/bitwarden/export")
async def bitwarden_export(request: Request, s=Depends(require_session), conn=Depends(get_db)):
    """Every login as a Bitwarden JSON file, after the master password is entered again."""
    body = await body_json(request)
    _check_rate(client_ip(request))
    rec = db.get_meta(conn, "pw")
    if not rec or crypto.unwrap_dek(str(body.get("password") or ""), json.loads(rec), "pw") is None:
        _record_fail(client_ip(request))
        audit(conn, request, "export_failed", "credentials")
        conn.commit()
        raise HTTPException(403, "That's not the master password")
    creds = []
    for r in conn.execute("SELECT c.*, d.name AS device_name FROM credentials c LEFT JOIN devices d ON d.id = c.device_id ORDER BY c.label"):
        creds.append({**dict(r), **_secrets_of(s["dek"], r)})
    audit(conn, request, "export", "credentials", None, f"Bitwarden JSON: {len(creds)} logins")
    conn.commit()
    return vaultio.to_bitwarden(creds)


def _hkey(conn, s) -> str | None:
    """HaRM's own SSH key, if it has one (tried before a saved password)."""
    return sshkey.private(conn, s.get("dek"))


@app.get("/api/ssh-key")
def ssh_key_info(s=Depends(require_session), conn=Depends(get_db)):
    return {"key": sshkey.info(conn), "background": upkeep.load(conn, "bg_ssh_key") is not None}


@app.post("/api/ssh-key")
async def ssh_key_make(request: Request, s=Depends(require_session), conn=Depends(get_db)):
    """Make HaRM's key pair. A new one replaces the old, so machines need the new public key."""
    body = await body_json(request)
    if sshkey.info(conn) and not body.get("replace"):
        raise HTTPException(409, "HaRM has a key already")
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", monitor.settings(conn)["site_name"] or "").strip("-")[:40]
    priv, pub = sshkey.generate(f"zoms-harm{'@' + name if name else ''}")
    sshkey.save(conn, s["dek"], priv, pub)
    if upkeep.load(conn, "bg_ssh_key") is not None:
        upkeep.bg_set_key(conn, priv)
    audit(conn, request, "ssh-key-new" if body.get("replace") else "ssh-key-made", None, None, pub.split()[-1])
    conn.commit()
    return {"key": sshkey.info(conn), "background": upkeep.load(conn, "bg_ssh_key") is not None}


@app.delete("/api/ssh-key")
def ssh_key_delete(request: Request, s=Depends(require_session), conn=Depends(get_db)):
    sshkey.remove(conn)
    upkeep.bg_set_key(conn, None)
    audit(conn, request, "ssh-key-deleted")
    conn.commit()
    return {"key": None, "background": False}


@app.post("/api/devices/{did}/ssh-key")
async def ssh_key_machine(did: int, request: Request, s=Depends(require_session), conn=Depends(get_db)):
    """Add HaRM's public key to a login's authorized_keys on the machine (or take it out), then check it."""
    dev = fetch_one(conn, "devices", did)
    if DEMO:
        raise HTTPException(501, DEMO_NO_NETWORK)
    body = await body_json(request)
    pub, priv = sshkey.public(conn), _hkey(conn, s)
    if not pub or not priv:
        raise HTTPException(400, "Make HaRM's SSH key first, in Settings > Locking and security")
    host, port = str(body.get("host") or "").strip(), int(body.get("port") or 22)
    if not host:
        raise HTTPException(400, "Enter the machine's address")
    user, pw = _machine_login(conn, s, {"credential_id": body.get("credential_id")})
    remove = bool(body.get("remove"))
    try:
        if body.get("trust_new_key"):
            await asyncio.to_thread(remote.forget_host, host, port)
        r = await asyncio.to_thread(remote.run_action, host, port, user, pw, "script",
                                    sshkey.remove_script(pub) if remove else sshkey.install_script(pub), False, False, None, 60,
                                    key=priv)
    except remote.RemoteError as e:
        raise HTTPException(409 if e.code == "hostkey" else 400, str(e))
    if f"HARM_RESULT={'removed' if remove else 'added'}" not in r["output"]:
        raise HTTPException(400, "The machine didn't take it: " + (r["output"].strip().splitlines() or ["no answer"])[-1][:300])
    works = None
    if not remove:  # does it let HaRM in with only the key?
        try:
            t = await asyncio.to_thread(remote.run_action, host, port, user, None, "script", "true\n", False, False,
                                        "-o IdentitiesOnly=yes -o PreferredAuthentications=publickey", 30, key=priv)
            works = t["ok"]
        except remote.RemoteError:
            works = False
    what = "Took HaRM's SSH key out of" if remove else "Added HaRM's SSH key to"
    audit(conn, request, "ssh-key-removed" if remove else "ssh-key-added", "devices", did, f"{dev['name']}: {user}@{host}")
    did_note(conn, did, f"{what} {user}'s authorized_keys on {host}.")
    conn.commit()
    return {"ok": True, "works": works}


@app.post("/api/credentials/{cid}/change-on-machine")
async def credential_change(cid: int, request: Request, s=Depends(require_session), conn=Depends(get_db)):
    """Change this login's password on a Linux machine over SSH, then keep the new one here."""
    if DEMO:
        raise HTTPException(501, DEMO_NO_NETWORK)
    row = conn.execute("SELECT * FROM credentials WHERE id = ?", (cid,)).fetchone()
    if not row:
        raise HTTPException(404, "Not found")
    body = await body_json(request)
    new = str(body.get("new_password") or "")
    why = vaultio.strong_enough(new)
    if why:
        raise HTTPException(400, why)
    host, port = str(body.get("host") or "").strip(), int(body.get("port") or 22)
    if not host:
        raise HTTPException(400, "Enter the machine's address")
    try:
        script = vaultio.change_script(row["username"] or "")
    except vaultio.VaultIOError as e:
        raise HTTPException(400, str(e))
    via = conn.execute("SELECT * FROM credentials WHERE id = ?", (body.get("via_credential_id") or cid,)).fetchone()
    if not via or not via["username"]:
        raise HTTPException(400, "Pick the login to connect with")
    old = _decrypt(s["dek"], row["password_enc"], "password")
    via_pw = _decrypt(s["dek"], via["password_enc"], "password")
    try:
        r = await asyncio.to_thread(remote.run_action, host, port, via["username"], via_pw, "script", script,
                                    bool(body.get("sudo")), False, None, 60, vaultio.change_input(new), _hkey(conn, s))
    except remote.RemoteError as e:
        raise HTTPException(409 if e.code == "hostkey" else 400, str(e))
    problem = vaultio.change_result(r["output"])
    if problem:
        audit(conn, request, "password-change-failed", "credentials", cid, f"{row['label']} on {host}")
        conn.commit()
        raise HTTPException(400, problem)
    # The machine has the new password now: keep it before anything else can go wrong.
    notes = vaultio.previous_note(old, _decrypt(s["dek"], row["secret_notes_enc"], "secret_notes"))
    enc = _encrypt_secrets({"password": new, "secret_notes": notes}, s["dek"])
    conn.execute("UPDATE credentials SET password_enc = ?, secret_notes_enc = ?, last_rotated = date('now'), "
                 "updated_at = datetime('now') WHERE id = ?", (enc["password_enc"], enc["secret_notes_enc"], cid))
    audit(conn, request, "password-changed", "credentials", cid, f"{row['label']} ({row['username']}) on {host}")
    did_note(conn, row["device_id"], f"Changed the password of {row['username']} on {host}.")
    conn.commit()
    works = None
    if body.get("check", True):  # can the login sign in with it?
        try:
            t = await asyncio.to_thread(remote.run_action, host, port, row["username"], new, "script", "true\n", False, False,
                                        "-o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive", 30)
            works = t["ok"]
        except remote.RemoteError:
            works = False
    return {"ok": True, "works": works}

# ---------------------------------------------------------------------------
# PC builder & parts library
# ---------------------------------------------------------------------------

def _catalog_dict(r) -> dict:
    d = dict(r)
    d["specs"] = json.loads(d.get("specs") or "{}")
    d["summary"] = pcbuild.summarize(d["category"], d["specs"])
    return d


@app.get("/api/catalog/meta")
def catalog_meta(_s=Depends(require_session)):
    return {
        "categories": [{"key": k, "label": l} for k, l in pcbuild.CATEGORIES],
        "single": sorted(pcbuild.SINGLE),
        "spec_fields": {c: [{"k": k, "label": l, "type": t} for k, l, t in f] for c, f in pcbuild.SPEC_FIELDS.items()},
        "attribution": pcbuild.OPENDB_ATTRIBUTION,
    }


@app.get("/api/catalog/status")
def catalog_status(_s=Depends(require_session), conn=Depends(get_db)):
    rows = conn.execute("SELECT category, source, COUNT(*) AS n FROM catalog_parts GROUP BY category, source").fetchall()
    src = db.get_meta(conn, "catalog_source")
    return {"counts": [dict(r) for r in rows], "total": sum(r["n"] for r in rows),
            "source": json.loads(src) if src else None, "job": pcbuild.JOB}


@app.post("/api/catalog/update")
def catalog_update(request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    started = pcbuild.start_update(db.connect)
    if started:
        audit(conn, request, "catalog_update_started")
        conn.commit()
    return {"started": started, "job": pcbuild.JOB}


def _build_items(conn, bid: int) -> list[dict]:
    rows = conn.execute(
        """SELECT i.*, c.category AS cat_category, c.specs AS cat_specs, c.source AS cat_source,
                  comp.category AS comp_category, comp.manufacturer AS comp_manufacturer,
                  comp.model AS comp_model, comp.capacity AS comp_capacity, comp.interface AS comp_interface,
                  comp.form_factor AS comp_form_factor, comp.speed AS comp_speed,
                  comp.quantity AS comp_quantity, comp.status AS comp_status,
                  comp.device_id AS comp_device_id, cc.specs AS comp_cat_specs, cc.category AS comp_cat_category
           FROM build_items i
           LEFT JOIN catalog_parts c ON c.id = i.catalog_id
           LEFT JOIN components comp ON comp.id = i.component_id
           LEFT JOIN catalog_parts cc ON cc.id = comp.catalog_id
           WHERE i.build_id = ? ORDER BY i.id""", (bid,)).fetchall()
    out = []
    for r in rows:
        r = dict(r)
        if r["catalog_id"]:
            specs = json.loads(r["cat_specs"] or "{}")
            source = "custom" if r["cat_source"] == "custom" else "library"
        elif r["component_id"]:
            comp = {k[5:]: v for k, v in r.items() if k.startswith("comp_")}
            specs = pcbuild.infer_component_specs(comp, json.loads(r["comp_cat_specs"]) if r["comp_cat_specs"] else None)
            source = "inventory"
        else:
            specs, source = {}, "manual"
        out.append({
            "id": r["id"], "category": r["category"], "name": r["name"] or "Unnamed part",
            "qty": r["quantity"] or 1, "price": r["price"], "acquire": r["acquire"], "notes": r["notes"],
            "catalog_id": r["catalog_id"], "component_id": r["component_id"],
            "comp_status": r["comp_status"], "comp_device_id": r["comp_device_id"],
            "comp_quantity": r["comp_quantity"], "source": source, "specs": specs,
            "summary": pcbuild.summarize(r["category"], specs),
        })
    return out


@app.get("/api/builds/{bid}/full")
def build_full(bid: int, _s=Depends(require_session), conn=Depends(get_db)):
    build = fetch_one(conn, "builds", bid)
    items = _build_items(conn, bid)
    checks, stats = pcbuild.check_build(items)
    total = sum((i["price"] or 0) * i["qty"] for i in items)
    to_buy = sum((i["price"] or 0) * i["qty"] for i in items if i["acquire"] != "Have")
    stats.update(total_price=total, to_buy_price=to_buy,
                 have=sum(1 for i in items if i["acquire"] == "Have"),
                 need=sum(1 for i in items if i["acquire"] == "Need"),
                 ordered=sum(1 for i in items if i["acquire"] == "Ordered"))
    return {"build": build, "items": items, "checks": checks, "stats": stats}


@app.get("/api/catalog/search")
def catalog_search(category: str, q: str = "", build_id: int | None = None, compatible: int = 0,
                   source: str = "", limit: int = 50, _s=Depends(require_session), conn=Depends(get_db)):
    limit = max(1, min(limit, 200))
    where, args = ["category = ?"], [category]
    for tok in q.split()[:8]:
        where.append("(name LIKE ? OR part_numbers LIKE ? OR manufacturer LIKE ?)")
        args += [f"%{tok}%"] * 3
    if source in ("custom", "opendb"):
        where.append("source = ?")
        args.append(source)
    scan = 2000 if (compatible and build_id) else limit + 1
    rows = conn.execute(
        f"SELECT * FROM catalog_parts WHERE {' AND '.join(where)} "
        f"ORDER BY source = 'custom' DESC, release_year IS NULL, release_year DESC, name LIMIT {scan}", args).fetchall()
    items = _build_items(conn, build_id) if build_id else None
    results, hidden = [], 0
    for r in rows:
        d = _catalog_dict(r)
        if items is not None:
            d["issues"] = pcbuild.candidate_issues(items, {"category": category, "name": d["name"], "qty": 1, "specs": d["specs"]})
            if compatible and d["issues"]:
                hidden += 1
                continue
        results.append(d)
        if len(results) > limit:
            break
    more = len(results) > limit
    return {"results": results[:limit], "more": more, "hidden_incompatible": hidden}


@app.get("/api/builds/{bid}/inventory")
def build_inventory(bid: int, category: str, _s=Depends(require_session), conn=Depends(get_db)):
    """Spare parts on hand that belong in `category`, with fit checks against the build."""
    fetch_one(conn, "builds", bid)
    items = _build_items(conn, bid)
    used = {i["component_id"] for i in items if i["component_id"]}
    out = []
    for c in fetch_list(conn, "components", {"device_id": "null"}):
        if c["status"] in ("Disposed",) or c["id"] in used or c["quantity"] < 1:
            continue
        cat_specs, cat_cat = None, None
        if c["catalog_id"]:
            cr = conn.execute("SELECT category, specs FROM catalog_parts WHERE id = ?", (c["catalog_id"],)).fetchone()
            if cr:
                cat_cat, cat_specs = cr["category"], json.loads(cr["specs"] or "{}")
        if pcbuild.component_category(c, cat_cat) != category:
            continue
        specs = pcbuild.infer_component_specs(c, cat_specs)
        c["specs"], c["summary"] = specs, pcbuild.summarize(category, specs)
        c["issues"] = pcbuild.candidate_issues(items, {"category": category, "name": c["model"] or c["category"], "qty": 1, "specs": specs})
        out.append(c)
    return out


def _custom_payload(body: dict) -> dict:
    cat = body.get("category")
    if cat not in pcbuild.CATEGORY_KEYS:
        raise HTTPException(400, "Choose a valid category")
    name = str(body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "Name is required")
    try:
        specs = pcbuild.clean_specs(cat, body.get("specs") or {})
    except ValueError as e:
        raise HTTPException(400, str(e))
    t = lambda k, n=300: (str(body.get(k)).strip()[:n] or None) if body.get(k) else None
    return {"category": cat, "name": name[:300], "manufacturer": t("manufacturer", 100),
            "part_numbers": t("part_numbers", 500), "notes": t("notes", 5000),
            "release_year": _coerce(None, "release_year", "int", body.get("release_year")),
            "specs": json.dumps(specs)}


@app.post("/api/catalog")
async def catalog_create(request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    p = _custom_payload(await body_json(request))
    cur = conn.execute(
        "INSERT INTO catalog_parts (source, source_id, category, name, manufacturer, part_numbers, notes, release_year, specs) "
        "VALUES ('custom', ?, ?, ?, ?, ?, ?, ?, ?)",
        (secrets.token_hex(8), p["category"], p["name"], p["manufacturer"], p["part_numbers"], p["notes"],
         p["release_year"], p["specs"]))
    audit(conn, request, "create", "catalog_parts", cur.lastrowid, p["name"])
    conn.commit()
    return _catalog_dict(conn.execute("SELECT * FROM catalog_parts WHERE id = ?", (cur.lastrowid,)).fetchone())


def _catalog_or_404(conn, cid: int):
    r = conn.execute("SELECT * FROM catalog_parts WHERE id = ?", (cid,)).fetchone()
    if not r:
        raise HTTPException(404, "Not found")
    return r


@app.get("/api/catalog/{cid}")
def catalog_get(cid: int, _s=Depends(require_session), conn=Depends(get_db)):
    d = _catalog_dict(_catalog_or_404(conn, cid))
    d["form_specs"] = pcbuild.specs_for_form(d["category"], d["specs"])
    d["inventory_count"] = conn.execute("SELECT COALESCE(SUM(quantity),0) FROM components WHERE catalog_id = ?", (cid,)).fetchone()[0]
    return d


@app.put("/api/catalog/{cid}")
async def catalog_update_part(cid: int, request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    if _catalog_or_404(conn, cid)["source"] != "custom":
        raise HTTPException(400, "Library parts are read-only. Make a custom copy to change specs.")
    p = _custom_payload(await body_json(request))
    conn.execute("UPDATE catalog_parts SET category=?, name=?, manufacturer=?, part_numbers=?, notes=?, "
                 "release_year=?, specs=?, updated_at=datetime('now') WHERE id=?",
                 (p["category"], p["name"], p["manufacturer"], p["part_numbers"], p["notes"], p["release_year"], p["specs"], cid))
    audit(conn, request, "update", "catalog_parts", cid, p["name"])
    conn.commit()
    return catalog_get(cid, _s, conn)


@app.delete("/api/catalog/{cid}")
def catalog_delete(cid: int, request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    r = _catalog_or_404(conn, cid)
    if r["source"] != "custom":
        raise HTTPException(400, "Only custom parts can be deleted")
    # Keep build lines readable after the part is gone.
    conn.execute("UPDATE build_items SET name = COALESCE(name, ?) WHERE catalog_id = ?", (r["name"], cid))
    conn.execute("DELETE FROM catalog_parts WHERE id = ?", (cid,))
    audit(conn, request, "delete", "catalog_parts", cid, r["name"])
    conn.commit()
    return {"ok": True}


@app.post("/api/catalog/{cid}/copy")
def catalog_copy(cid: int, request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    r = _catalog_or_404(conn, cid)
    cur = conn.execute(
        "INSERT INTO catalog_parts (source, source_id, category, name, manufacturer, part_numbers, release_year, specs, notes) "
        "VALUES ('custom', ?, ?, ?, ?, ?, ?, ?, ?)",
        (secrets.token_hex(8), r["category"], f"{r['name']} (custom)", r["manufacturer"], r["part_numbers"],
         r["release_year"], r["specs"], r["notes"]))
    audit(conn, request, "create", "catalog_parts", cur.lastrowid, f"copy of #{cid}")
    conn.commit()
    return catalog_get(cur.lastrowid, _s, conn)


@app.get("/api/catalog/{cid}/component-fields")
def catalog_component_fields(cid: int, _s=Depends(require_session), conn=Depends(get_db)):
    """Inventory form values for a library part (used by "Find in library")."""
    r = _catalog_dict(_catalog_or_404(conn, cid))
    return {**pcbuild.component_fields_from_catalog(r["category"], r["name"], r["manufacturer"], r["part_numbers"], r["specs"]),
            "catalog_id": cid}


@app.post("/api/catalog/{cid}/to-inventory")
async def catalog_to_inventory(cid: int, request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    body = await body_json(request)
    r = _catalog_dict(_catalog_or_404(conn, cid))
    qty = _coerce(conn, "quantity", "int", body.get("quantity", 1)) or 1
    if qty < 1:
        raise HTTPException(400, "quantity must be at least 1")
    f = pcbuild.component_fields_from_catalog(r["category"], r["name"], r["manufacturer"], r["part_numbers"], r["specs"])
    if r["category"] == "memory":
        qty *= r["specs"].get("modules") or 1  # inventory counts individual sticks
    data = {**f, "quantity": qty, "catalog_id": cid,
            "status": _coerce(conn, "status", "text", body.get("status")) or "In Stock",
            "condition": _coerce(conn, "condition", "text", body.get("condition")),
            "location_id": _coerce(conn, "location_id", "fk:locations", body.get("location_id")),
            "rack_id": _coerce(conn, "rack_id", "fk:racks", body.get("rack_id")),
            "position": _coerce(conn, "position", "text", body.get("position")),
            "purchase_price": _coerce(conn, "purchase_price", "real", body.get("purchase_price"))}
    _component_rules(conn, data, None)
    data = {k: v for k, v in data.items() if v is not None}
    cur = conn.execute(f"INSERT INTO components ({', '.join(data)}) VALUES ({', '.join('?' for _ in data)})", list(data.values()))
    audit(conn, request, "create", "components", cur.lastrowid, f"from library: {r['name']}")
    conn.commit()
    return fetch_one(conn, "components", cur.lastrowid)


PURPOSE_TO_TYPE = {"nas": "NAS", "homelabserver": "Server", "hypervisorhost": "Hypervisor Host",
                   "routerfirewall": "Firewall", "workstation": "Workstation", "htpcmedia": "Mini PC"}


@app.post("/api/builds/{bid}/to-device")
async def build_to_device(bid: int, request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    """Turn a finished build into a device: specs summary, slots from the motherboard,
    inventory parts installed, and (optionally) library parts recorded as components."""
    body = await body_json(request)
    build = fetch_one(conn, "builds", bid)
    if build["device_id"]:
        raise HTTPException(400, "This build is already linked to a device")
    items = _build_items(conn, bid)
    by: dict[str, list] = {}
    for i in items:
        by.setdefault(i["category"], []).append(i)
    one = lambda c: (by.get(c) or [None])[0]
    cpu, mb, psu = one("cpu"), one("motherboard"), one("psu")
    mems, drives = by.get("memory", []), by.get("storage", [])
    ram_gb = sum((m["specs"].get("capacity_gb") or (m["specs"].get("module_gb") or 0) * (m["specs"].get("modules") or 1)) * m["qty"] for m in mems)
    ram_type = next((m["specs"].get("ram_type") for m in mems if m["specs"].get("ram_type")), "")
    storage = ", ".join(f"{d['qty']}× {pcbuild._fmt_gb(d['specs'].get('capacity_gb')) or d['name']}"
                        f"{' ' + d['specs']['form_factor'] if d['specs'].get('form_factor') else ''}" for d in drives)
    dev = {
        "name": _coerce(conn, "name", "text", body.get("name")) or build["name"],
        "device_type": _coerce(conn, "device_type", "text", body.get("device_type"))
        or PURPOSE_TO_TYPE.get(re.sub(r"[^a-z]", "", (build["purpose"] or "").lower()), "Desktop"),
        "status": "Active", "connected": 0,
        "location_id": _coerce(conn, "location_id", "fk:locations", body.get("location_id")),
        "rack_id": _coerce(conn, "rack_id", "fk:racks", body.get("rack_id")),
        "position": _coerce(conn, "position", "text", body.get("position")),
        "cpu": cpu["name"] if cpu else None,
        "ram": f"{ram_gb:g} GB {ram_type}".strip() if ram_gb else None,
        "storage": storage or None, "psu": psu["name"] if psu else None,
        "purchase_price": sum((i["price"] or 0) * i["qty"] for i in items) or None,
        "notes": f"Built from PC build “{build['name']}”.",
    }
    _device_rules(conn, dev, None)
    dev = {k: v for k, v in dev.items() if v is not None}
    did = conn.execute(f"INSERT INTO devices ({', '.join(dev)}) VALUES ({', '.join('?' for _ in dev)})", list(dev.values())).lastrowid
    loc = conn.execute("SELECT location_id FROM devices WHERE id = ?", (did,)).fetchone()["location_id"]

    # Slots from the motherboard and CPU socket, so spare-part matching works later.
    slots = []
    if mb:
        s = mb["specs"]
        if s.get("socket"):
            slots.append((s["socket"], None, 2 if re.match(r"\s*2\s*x", s["socket"], re.I) else 1, "CPU socket"))
        if s.get("ram_slots"):
            slots.append((f"{s.get('ram_type') or 'DDR'} DIMM", "DIMM", s["ram_slots"], "Memory slots"))
        groups: dict = {}
        for m in s.get("m2_slots") or []:
            sizes = tuple(m.get("sizes") or [2280])
            iface = "M.2 SATA (B+M key)" if "sata" in (m.get("interface") or "").lower() and "pcie" not in (m.get("interface") or "").lower() else "NVMe M.2 (M-key)"
            groups[(iface, sizes)] = groups.get((iface, sizes), 0) + 1
        for (iface, sizes), n in groups.items():
            slots.append((iface, f"M.2 {sizes[0]}" if len(sizes) == 1 else None, n, "Sizes: " + "/".join(map(str, sizes))))
        if s.get("sata_ports"):
            slots.append(("SATA III", None, s["sata_ports"], "Onboard SATA ports"))
        lanes: dict = {}
        for p in s.get("pcie_slots") or []:
            if p.get("lanes"):
                lanes[p["lanes"]] = lanes.get(p["lanes"], 0) + (p.get("quantity") or 0)
        if not lanes and s.get("pcie_x16"):
            lanes[16] = s["pcie_x16"]
        for ln, n in sorted(lanes.items(), reverse=True):
            if n:
                slots.append((f"PCIe x{ln}", None, n, None))
    for iface, ff, total, notes in slots:
        conn.execute("INSERT INTO device_slots (device_id, interface, form_factor, total, notes) VALUES (?,?,?,?,?)",
                     (did, iface, ff, total, notes))

    installed = created = 0
    make = body.get("create_components", True) not in (False, 0, "0", "false")
    use_inv = body.get("install_inventory", True) not in (False, 0, "0", "false")
    for i in items:
        if i["component_id"] and use_inv and not i["comp_device_id"]:
            cq = i["comp_quantity"] or 1
            target = i["component_id"]
            if i["qty"] < cq:  # split a stack, install only what the build uses
                conn.execute("UPDATE components SET quantity = quantity - ? WHERE id = ?", (i["qty"], target))
                cols = list(ENTITIES["components"]["fields"])
                target = conn.execute(f"INSERT INTO components ({', '.join(cols)}) SELECT {', '.join(cols)} "
                                      f"FROM components WHERE id = ?", (i["component_id"],)).lastrowid
            conn.execute("UPDATE components SET device_id = ?, quantity = ?, status = 'Installed', rack_id = NULL, "
                         "position = NULL, location_id = ?, updated_at = datetime('now') WHERE id = ?",
                         (did, min(i["qty"], cq), loc, target))
            installed += 1
        elif i["catalog_id"] and make and i["category"] != "case":
            row = conn.execute("SELECT * FROM catalog_parts WHERE id = ?", (i["catalog_id"],)).fetchone()
            if not row:
                continue
            f = pcbuild.component_fields_from_catalog(row["category"], row["name"], row["manufacturer"], row["part_numbers"], i["specs"])
            qty = i["qty"] * ((i["specs"].get("modules") or 1) if i["category"] == "memory" else 1)
            data = {**f, "quantity": qty, "status": "Installed", "condition": "New", "device_id": did,
                    "location_id": loc, "catalog_id": i["catalog_id"], "purchase_price": i["price"]}
            data = {k: v for k, v in data.items() if v is not None}
            conn.execute(f"INSERT INTO components ({', '.join(data)}) VALUES ({', '.join('?' for _ in data)})", list(data.values()))
            created += 1
    conn.execute("UPDATE builds SET device_id = ?, status = 'Built', updated_at = datetime('now') WHERE id = ?", (did, bid))
    audit(conn, request, "build_to_device", "builds", bid, f"device #{did}; {installed} installed, {created} recorded")
    conn.commit()
    return {"device_id": did, "installed": installed, "created": created, "slots": len(slots)}


@app.post("/api/builds/{bid}/duplicate")
def build_duplicate(bid: int, request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    b = fetch_one(conn, "builds", bid)
    nid = conn.execute("INSERT INTO builds (name, purpose, status, budget, notes) VALUES (?,?,?,?,?)",
                       (f"{b['name']} (copy)", b["purpose"], "Planning", b["budget"], b["notes"])).lastrowid
    conn.execute("INSERT INTO build_items (build_id, category, catalog_id, component_id, name, quantity, price, acquire, notes) "
                 "SELECT ?, category, catalog_id, NULL, name, quantity, price, "
                 "CASE WHEN component_id IS NULL THEN acquire ELSE 'Need' END, notes "
                 "FROM build_items WHERE build_id = ? AND (catalog_id IS NOT NULL OR component_id IS NULL)", (nid, bid))
    audit(conn, request, "create", "builds", nid, f"copy of #{bid}")
    conn.commit()
    return fetch_one(conn, "builds", nid)


@app.get("/api/networks/{nid}/ipmap")
def network_ipmap(nid: int, _s=Depends(require_session), conn=Depends(get_db)):
    """Every address used in a network, conflicts, and the next free addresses."""
    netrow = fetch_one(conn, "networks", nid)
    net = _net(netrow["cidr"])
    dhcp = None
    try:
        if netrow["dhcp_start"] and netrow["dhcp_end"]:
            dhcp = (ipaddress.ip_address(netrow["dhcp_start"]), ipaddress.ip_address(netrow["dhcp_end"]))
    except ValueError:
        pass
    entries = []
    for r in fetch_list(conn, "interfaces", {"ip": "notnull"}):
        try:
            a = ipaddress.ip_address(r["ip"])
        except ValueError:
            continue
        inside = bool(net and a.version == net.version and a in net)
        if r["network_id"] != nid and not inside:
            continue
        r["_sort"] = int(a)
        r["outside"] = not inside if net else False
        r["in_dhcp_range"] = bool(dhcp and a.version == dhcp[0].version and dhcp[0] <= a <= dhcp[1])
        entries.append(r)
    entries.sort(key=lambda r: r["_sort"])
    counts: dict[str, int] = {}
    for r in entries:
        counts[r["ip"]] = counts.get(r["ip"], 0) + 1
    for r in entries:
        r["duplicate"] = counts[r["ip"]] > 1
        del r["_sort"]
    stats, next_free = {}, []
    if net:
        used = {ipaddress.ip_address(ip) for ip in counts}
        reserved = set(used)
        if netrow["gateway"]:
            reserved.add(ipaddress.ip_address(netrow["gateway"]))
        hosts = net.num_addresses - (2 if net.version == 4 and net.prefixlen < 31 else 0)
        dhcp_size = int(dhcp[1]) - int(dhcp[0]) + 1 if dhcp and dhcp[1] >= dhcp[0] else 0
        for i, h in enumerate(net.hosts()):
            if i > 65536 or len(next_free) >= 12:
                break
            if h in reserved or (dhcp and dhcp[0] <= h <= dhcp[1]):
                continue
            next_free.append(str(h))
        stats = {"hosts": hosts, "used": len(used & set(net.hosts())) if hosts <= 65536 else len(used),
                 "dhcp_size": dhcp_size}
    return {"network": netrow, "entries": entries, "stats": stats, "next_free": next_free,
            "conflicts": sorted(ip for ip, n in counts.items() if n > 1)}


@app.get("/api/locations/{lid}/contents")
def location_contents(lid: int, _s=Depends(require_session), conn=Depends(get_db)):
    """What is in a location: sub-locations, holders, and loose devices and parts."""
    loc = fetch_one(conn, "locations", lid)
    return {
        "location": loc,
        "children": fetch_list(conn, "locations", {"parent_id": lid}),
        "racks": fetch_list(conn, "racks", {"location_id": lid}),
        "loose_devices": fetch_list(conn, "devices", {"location_id": lid, "rack_id": "null"}),
        "loose_components": fetch_list(conn, "components",
                                       {"location_id": lid, "rack_id": "null", "device_id": "null"}),
        "networks": fetch_list(conn, "networks", {"location_id": lid}),
        "notes": fetch_list(conn, "notes", {"entity": "locations", "entity_id": lid}),
    }


SCAN_MAX_BYTES = 15 * 1024 * 1024


def _tools() -> dict:
    return {"ocr": shutil.which("tesseract") is not None,
            "barcodes": shutil.which("zbarimg") is not None}


def _phone_urls(request: Request) -> list[str]:
    """Addresses a phone can use: the names on HaRM's certificate (they're what phones must use anyway)."""
    port = request.url.port or (443 if request.url.scheme == "https" else 80)
    names = [n for n in sorted(certs.cert_names()) if n not in ("localhost", "127.0.0.1", "::1")]
    names.sort(key=lambda n: (not re.match(r"^\d+\.\d+\.\d+\.\d+$", n), n))  # IPs first
    suffix = "" if port in (80, 443) else f":{port}"
    return [f"https://{n}{suffix}" for n in names]


@app.get("/api/meta/capabilities")
def capabilities(request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    backups = sorted(BACKUP_DIR.glob("harm-*.db"), reverse=True) if BACKUP_DIR.exists() else []
    collect_dir = STATIC / "collect"
    sha = {f.suffix[1:]: hashlib.sha256(f.read_bytes()).hexdigest() for f in collect_dir.glob("harm-collect.*")}
    return {**_tools(), "ca_cert": (db.DB_PATH.parent / "tls" / "harm-ca.crt").is_file(), "collect_sha256": sha,
            "phone_urls": _phone_urls(request),
            "backups": [{"name": b.name, "size": b.stat().st_size} for b in backups], "backup_dir": str(BACKUP_DIR),
            "platform": "windows" if os.name == "nt" else "unix",
            **{k: v for k, v in monitor.settings(conn).items() if k in ("currency", "start_page", *monitor.NEW_ITEM_DEFAULTS)},
            "ai": monitor.settings(conn)["ai_enabled"], "terminal": monitor.settings(conn)["terminal"]}


def _run_scan(path: str) -> dict:
    tools = _tools()
    out = {"barcodes": [], "text": "", "ocr": tools["ocr"], "barcode_reader": tools["barcodes"]}
    if tools["barcodes"]:
        try:
            p = subprocess.run(["zbarimg", "-q", path], capture_output=True, text=True, timeout=20)
            for line in p.stdout.splitlines():
                fmt, _, value = line.partition(":")
                if value.strip():
                    out["barcodes"].append({"format": fmt, "value": value.strip()})
        except (subprocess.TimeoutExpired, OSError):
            pass
    if tools["ocr"]:
        try:
            # psm 11 = sparse text, which suits labels better than page layout analysis.
            p = subprocess.run(["tesseract", path, "stdout", "--psm", "11"],
                               capture_output=True, text=True, timeout=40)
            out["text"] = p.stdout
        except (subprocess.TimeoutExpired, OSError):
            pass
    return out


@app.post("/api/scan")
async def scan_image(request: Request, _s=Depends(require_session)):
    """Read barcodes and text from a photo of a label. The photo is not stored."""
    size, chunks = 0, []
    async for chunk in request.stream():
        size += len(chunk)
        if size > SCAN_MAX_BYTES:
            raise HTTPException(413, "Image too large (15 MB max)")
        chunks.append(chunk)
    data = b"".join(chunks)
    if data[:3] == b"\xff\xd8\xff":
        ext = ".jpg"
    elif data[:8] == b"\x89PNG\r\n\x1a\n":
        ext = ".png"
    elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        ext = ".webp"
    else:
        raise HTTPException(415, "Send a JPEG, PNG or WebP image")
    fd, path = tempfile.mkstemp(prefix="harm-scan-", suffix=ext)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        return await asyncio.to_thread(_run_scan, path)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# AI Assist (prompt for any AI chat + importer for its reply)
# ---------------------------------------------------------------------------

def _where_text(conn, location_id, rack_id, position) -> str:
    bits = []
    if location_id:
        bits.append(_location_path(conn, location_id) or "")
    if rack_id:
        r = conn.execute("SELECT name FROM racks WHERE id = ?", (rack_id,)).fetchone()
        if r:
            bits.append(r["name"])
    if position:
        bits.append(str(position))
    return " > ".join(b for b in bits if b)


def require_ai(_s=Depends(require_session), conn=Depends(get_db)):
    """Settings > AI Assist can turn every AI feature off; then the AI endpoints refuse too."""
    if not monitor.settings(conn)["ai_enabled"]:
        raise HTTPException(403, "AI features are turned off in Settings > AI Assist.")


@app.post("/api/ai/prompt", dependencies=[Depends(require_ai)])
async def ai_prompt(request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    body = await body_json(request)
    loc = _coerce(conn, "location_id", "fk:locations", body.get("location_id"))
    rack = _coerce(conn, "rack_id", "fk:racks", body.get("rack_id"))
    where = _where_text(conn, loc, rack, _coerce(conn, "position", "text", body.get("position")))
    return {"prompt": ai.build_prompt(str(body.get("hint") or "")[:1000], where)}


@app.post("/api/ai/parse", dependencies=[Depends(require_ai)])
async def ai_parse(request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    body = await body_json(request)
    try:
        out = ai.parse(str(body.get("text") or "")[:2_000_000])
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _flag_duplicates(conn, out)


def _flag_duplicates(conn, out: dict) -> dict:
    """Mark items whose serial is already in HaRM."""
    for it in out["items"]:
        it["duplicate"] = None
        if it.get("serial"):
            sn = it["serial"].upper()
            d = conn.execute("SELECT id, name FROM devices WHERE UPPER(serial) = ?", (sn,)).fetchone()
            c = conn.execute("SELECT id, COALESCE(model, category) AS name FROM components WHERE UPPER(serial) = ?", (sn,)).fetchone()
            if d:
                it["duplicate"] = {"link": f"#/devices/{d['id']}", "name": d["name"]}
            elif c:
                it["duplicate"] = {"link": f"#/components?id={c['id']}", "name": c["name"]}
    return out


def _ai_conf(conn) -> dict:
    try:
        return json.loads(db.get_meta(conn, "ai_conf") or "{}")
    except ValueError:
        return {}


def _ai_key(conn, dek: bytes, provider: str) -> str | None:
    blob = db.get_meta(conn, f"ai_key:{provider}")
    if not blob:
        return None
    try:
        return crypto.unseal(dek, crypto.b64d(blob), f"meta.ai_key:{provider}".encode()).decode()
    except crypto.DecryptError:
        return None


@app.get("/api/ai/config")
def ai_config_get(_s=Depends(require_session), conn=Depends(get_db)):
    conf = _ai_conf(conn)
    return {"provider": conf.get("provider") or "", "model": conf.get("model") or "", "base_url": conf.get("base_url") or "",
            "web": conf.get("web", True), "providers": aiproviders.PROVIDERS,
            "has_key": {p: bool(db.get_meta(conn, f"ai_key:{p}")) for p in aiproviders.PROVIDERS}}


@app.post("/api/ai/config")
async def ai_config_set(request: Request, s=Depends(require_session), conn=Depends(get_db)):
    body = await body_json(request)
    provider = str(body.get("provider") or "")
    if provider and provider not in aiproviders.PROVIDERS:
        raise HTTPException(400, "Unknown AI service")
    conf = {"provider": provider, "model": str(body.get("model") or "").strip()[:120],
            "base_url": str(body.get("base_url") or "").strip()[:300], "web": bool(body.get("web", True))}
    if conf["base_url"] and urlparse(conf["base_url"]).scheme not in ("http", "https"):
        raise HTTPException(400, "The service address must start with http:// or https://")
    db.set_meta(conn, "ai_conf", json.dumps(conf))
    if provider and body.get("api_key"):
        key = str(body["api_key"]).strip()[:500]
        db.set_meta(conn, f"ai_key:{provider}", crypto.b64e(crypto.seal(s["dek"], key.encode(), f"meta.ai_key:{provider}".encode())))
    if provider and body.get("clear_key"):
        db.set_meta(conn, f"ai_key:{provider}", None)
    audit(conn, request, "update", "settings", None, f"AI Assist: {provider or 'off'}")
    conn.commit()
    return ai_config_get(s, conn)


AI_MAX_BYTES = 25 * 1024 * 1024


@app.post("/api/ai/ask", dependencies=[Depends(require_ai)])
async def ai_ask(request: Request, s=Depends(require_session), conn=Depends(get_db)):
    """Send photos to the configured AI service and return its reply, parsed for the preview."""
    size, chunks = 0, []
    async for chunk in request.stream():
        size += len(chunk)
        if size > AI_MAX_BYTES:
            raise HTTPException(413, "Too much image data (25 MB max). Use fewer or smaller photos.")
        chunks.append(chunk)
    try:
        body = json.loads(b"".join(chunks))
    except ValueError:
        raise HTTPException(400, "Invalid JSON body")
    images = [i for i in (body.get("images") or []) if isinstance(i, str) and i.startswith("data:image/")][:10]
    conf = _ai_conf(conn)
    loc = _coerce(conn, "location_id", "fk:locations", body.get("location_id"))
    rack = _coerce(conn, "rack_id", "fk:racks", body.get("rack_id"))
    where = _where_text(conn, loc, rack, _coerce(conn, "position", "text", body.get("position")))
    prompt = ai.build_prompt(str(body.get("hint") or "")[:1000], where)
    key = _ai_key(conn, s["dek"], conf.get("provider") or "")
    try:
        res = await asyncio.to_thread(aiproviders.ask, conf, key, prompt, images)
    except aiproviders.AIError as e:
        raise HTTPException(502, str(e))
    audit(conn, request, "ai-ask", "ai-assist", None, f"{conf.get('provider')} · {len(images)} photo(s)")
    conn.commit()
    try:
        out = _flag_duplicates(conn, ai.parse(res["text"]))
    except ValueError as e:
        return JSONResponse({"detail": f"The AI answered, but not in HaRM's format: {e}", "raw": res["text"][:200_000]}, status_code=422)
    out.update(raw=res["text"][:200_000], web=res["web"], note=res["note"], provider=conf.get("provider"))
    if res["note"]:
        out["warnings"].insert(0, res["note"])
    return out


@app.post("/api/ai/import", dependencies=[Depends(require_ai)])
async def ai_import(request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    body = await body_json(request)
    items = body.get("items") or []
    if not isinstance(items, list) or not items or len(items) > ai.MAX_ITEMS:
        raise HTTPException(400, "Nothing to add")
    loc = _coerce(conn, "location_id", "fk:locations", body.get("location_id"))
    rack = _coerce(conn, "rack_id", "fk:racks", body.get("rack_id"))
    position = _coerce(conn, "position", "text", body.get("position"))
    dev_status = body.get("device_status") if body.get("device_status") in ENUMS["device_statuses"] else "Spare"
    want_tasks, want_notes = bool(body.get("tasks", True)), bool(body.get("notes", True))
    today = date.today().isoformat()
    created, n_tasks = [], 0

    def money(v):
        return ai._money(v)

    for raw in items:
        if not isinstance(raw, dict):
            continue
        it = {k: raw.get(k) for k in raw}
        t = lambda k, n=300: ai._s(it.get(k), n)
        common = {"manufacturer": t("manufacturer", 100), "model": t("model", 200), "serial": t("serial", 100),
                  "msrp": money(it.get("msrp")), "market_value": money(it.get("market_value")),
                  "value_checked": today if money(it.get("market_value")) else None,
                  "location_id": loc, "rack_id": rack, "position": position}
        if it.get("kind") == "device":
            rid = _insert(conn, "devices", {**common, "name": t("name", 200) or "New device",
                                            "device_type": t("device_type", 60), "status": dev_status,
                                            "cpu": t("cpu"), "ram": t("ram"), "storage": t("storage"), "psu": t("psu"), "os": t("os")})
            entity, link = "devices", f"#/devices/{rid}"
        else:
            qty = it.get("quantity") if isinstance(it.get("quantity"), int) and 0 < it["quantity"] <= 10000 else 1
            rid = _insert(conn, "components", {**common, "category": t("category", 60) or "Other",
                                               "part_number": t("part_number", 100), "capacity": t("capacity", 40),
                                               "interface": t("interface", 60), "form_factor": t("form_factor", 40),
                                               "speed": t("speed", 60), "quantity": qty, "status": "In Stock",
                                               "condition": t("condition", 40)})
            entity, link = "components", f"#/components?id={rid}"
        if want_notes:
            note = ai.research_note(it)
            if note:
                _insert(conn, "notes", {"entity": entity, "entity_id": rid, "kind": "note", "body": note[:20000]})
        if want_tasks:
            for todo in (it.get("todo") or [])[:12]:
                if str(todo).strip():
                    _insert(conn, "notes", {"entity": entity, "entity_id": rid, "kind": "task", "body": str(todo).strip()[:300]})
                    n_tasks += 1
        created.append({"kind": entity, "id": rid, "name": t("name", 200) or "item", "link": link})
    batch = [str(x).strip()[:300] for x in (body.get("batch_todo") or []) if str(x).strip()][:20]
    if want_tasks and batch and created:
        target = ("racks", rack) if rack else (("locations", loc) if loc else (created[0]["kind"], created[0]["id"]))
        for todo in batch:
            _insert(conn, "notes", {"entity": target[0], "entity_id": target[1], "kind": "task", "body": todo})
            n_tasks += 1
    audit(conn, request, "import", "ai-assist", None, f"{len(created)} items, {n_tasks} tasks")
    conn.commit()
    return {"created": created, "tasks": n_tasks}


# ---------------------------------------------------------------------------
# Network discovery (LAN sweep + UniFi import)
# ---------------------------------------------------------------------------

_SCAN_LOCK = asyncio.Lock()
UNIFI_AAD = b"meta.unifi_key"


def _insert(conn, entity: str, body: dict) -> int:
    """Validated insert used by importers (same rules as the generic create)."""
    data = validate(conn, entity, body, partial=False)
    _apply_rules(conn, entity, data, None)
    data = {k: v for k, v in data.items() if v is not None}
    cols = list(data)
    cur = conn.execute(f"INSERT INTO {entity} ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
                       [data[c] for c in cols])
    return cur.lastrowid


def _update(conn, entity: str, rid: int, body: dict) -> None:
    existing = fetch_one(conn, entity, rid)
    data = validate(conn, entity, body, partial=True)
    _apply_rules(conn, entity, data, existing)
    if data:
        conn.execute(f"UPDATE {entity} SET {', '.join(f'{k} = ?' for k in data)}, "
                     "updated_at = datetime('now') WHERE id = ?", [*data.values(), rid])


def _ignored(conn) -> set[str]:
    try:
        return set(json.loads(db.get_meta(conn, "discover_ignored") or "[]"))
    except ValueError:
        return set()


def _url_host(u: str | None) -> str | None:
    if not u:
        return None
    if "://" not in u:
        u = "//" + u
    try:
        return (urlparse(u).hostname or "").lower() or None
    except ValueError:
        return None


def _match_hosts(conn, hosts: list[dict]) -> None:
    """Mark each discovered host as known (and how) or new."""
    by_mac, by_ip = {}, {}
    for r in conn.execute("SELECT i.id, i.device_id, i.ip, i.mac, i.name, d.name AS device_name "
                          "FROM interfaces i JOIN devices d ON d.id = i.device_id"):
        if r["mac"]:
            by_mac.setdefault(discover.norm_mac(r["mac"]), r)
        if r["ip"]:
            by_ip.setdefault(r["ip"], r)
    by_name, by_mgmt = {}, {}
    for d in conn.execute("SELECT id, name, hostname, mgmt_url FROM devices"):
        for n in (d["name"], d["hostname"], (d["hostname"] or "").split(".")[0]):
            if n:
                by_name.setdefault(n.strip().lower(), d)
        host = _url_host(d["mgmt_url"])
        if host:
            by_mgmt.setdefault(host, d)
    ignored = _ignored(conn)
    for h in hosts:
        m = None
        r = by_mac.get(h["mac"]) if h["mac"] else None
        if r:
            m = {"how": "MAC", "interface_id": r["id"], "iface_ip": r["ip"]}
        elif h["ip"] and h["ip"] in by_ip:
            r = by_ip[h["ip"]]
            m = {"how": "IP", "interface_id": r["id"], "iface_ip": r["ip"]}
        if r:
            m.update(device_id=r["device_id"], device_name=r["device_name"])
        elif h["ip"] and h["ip"] in by_mgmt:
            d = by_mgmt[h["ip"]]
            m = {"how": "management URL", "device_id": d["id"], "device_name": d["name"], "mgmt": True}
        else:
            for n in (h.get("hostname"), (h.get("hostname") or "").split(".")[0], h.get("name")):
                d = by_name.get((n or "").strip().lower())
                if d:
                    m = {"how": "name", "device_id": d["id"], "device_name": d["name"]}
                    break
        if m:
            m["ip_changed"] = bool(m.get("iface_ip") and h["ip"] and m["iface_ip"] != h["ip"])
        h["match"] = m
        h["ignored"] = bool((h["mac"] and h["mac"] in ignored) or (h["ip"] and h["ip"] in ignored))
        h["type_guess"] = discover.guess_type(h)
        h["bmc"] = discover.is_bmc(h) or bool(m and m.get("mgmt"))


def _unifi_conf(conn) -> dict:
    try:
        return json.loads(db.get_meta(conn, "unifi") or "{}")
    except ValueError:
        return {}


@app.get("/api/discover/config")
def discover_config(_s=Depends(require_session), conn=Depends(get_db)):
    conf = _unifi_conf(conn)
    nets = [{"cidr": r["cidr"], "label": r["name"]} for r in
            conn.execute("SELECT name, cidr FROM networks WHERE cidr IS NOT NULL ORDER BY name")]
    return {"unifi": {"url": conf.get("url", ""), "site": conf.get("site", ""),
                      "verify": bool(conf.get("verify")), "has_key": bool(db.get_meta(conn, "unifi_key"))},
            "proxmox": {**{"url": "", "token_id": "", "verify": False}, **_pve_conf(conn), "has_secret": bool(db.get_meta(conn, "proxmox_secret"))},
            "subnets": discover.local_subnets(), "networks": nets, "ignored": len(_ignored(conn)),
            "ping": shutil.which("ping") is not None}


@app.post("/api/discover/scan")
async def discover_scan(request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    body = await body_json(request)
    if _SCAN_LOCK.locked():
        raise HTTPException(409, "A scan is already running")
    async with _SCAN_LOCK:
        try:
            out = await discover.scan(str(body.get("cidr") or ""))
        except discover.DiscoverError as e:
            raise HTTPException(400, str(e))
    _match_hosts(conn, out["hosts"])
    audit(conn, request, "scan", "networks", None, f"Swept {out['cidr']}: {len(out['hosts'])} hosts")
    conn.commit()
    return out


@app.post("/api/discover/unifi")
async def discover_unifi(request: Request, s=Depends(require_session), conn=Depends(get_db)):
    body = await body_json(request)
    key = str(body.get("api_key") or "").strip()
    if not key and db.get_meta(conn, "unifi_key"):
        try:
            key = crypto.unseal(s["dek"], crypto.b64d(db.get_meta(conn, "unifi_key")), UNIFI_AAD).decode()
        except crypto.DecryptError:
            key = ""
    url, site, verify = str(body.get("url") or ""), str(body.get("site") or ""), bool(body.get("verify"))
    conf = _unifi_conf(conn)
    try:
        same = conf.get("url") == discover._base_url(url)
    except discover.DiscoverError as e:
        raise HTTPException(400, str(e))
    pin = conf.get("fingerprint") if same and not body.get("trust_new_cert") else None
    try:
        out = await asyncio.to_thread(discover.unifi_import, url, key, site, verify, pin)
    except discover.DiscoverError as e:
        raise HTTPException(409 if e.code == "pin" else 400, str(e))
    db.set_meta(conn, "unifi", json.dumps({"url": discover._base_url(url), "site": site, "verify": verify,
                                           "fingerprint": out.pop("fingerprint", "") or conf.get("fingerprint", "")}))
    if body.get("remember") and body.get("api_key"):
        db.set_meta(conn, "unifi_key", crypto.b64e(crypto.seal(s["dek"], key.encode(), UNIFI_AAD)))
    elif body.get("remember") is False:
        db.set_meta(conn, "unifi_key", None)
    _match_hosts(conn, out["hosts"])
    have = {r["cidr"] for r in conn.execute("SELECT cidr FROM networks WHERE cidr IS NOT NULL")}
    for n in out["networks"]:
        n["exists"] = n["cidr"] in have
    audit(conn, request, "scan", "networks", None, f"UniFi import: {len(out['hosts'])} clients")
    conn.commit()
    return out


@app.post("/api/discover/clients")
async def discover_clients(request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    """Any router: read a pasted client list / DHCP lease table."""
    body = await body_json(request)
    out = discover.parse_client_list(str(body.get("text") or ""))
    _match_hosts(conn, out["hosts"])
    return out


@app.post("/api/discover/ignore")
async def discover_ignore(request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    body = await body_json(request)
    keys = {discover.norm_mac(str(k)) or str(k).strip() for k in body.get("keys") or [] if k}
    ign = _ignored(conn)
    ign = (ign | keys) if body.get("ignore", True) else (ign - keys)
    db.set_meta(conn, "discover_ignored", json.dumps(sorted(ign)[-3000:]))
    conn.commit()
    return {"ignored": len(ign)}


def _import_iface(conn, did: int, h: dict, mgmt: bool) -> str:
    mac, ip = discover.norm_mac(h.get("mac")), h.get("ip")
    row = None
    if mac:
        row = conn.execute("SELECT * FROM interfaces WHERE device_id = ? AND mac = ?", (did, mac)).fetchone()
    if not row and ip:
        row = conn.execute("SELECT * FROM interfaces WHERE device_id = ? AND ip = ?", (did, ip)).fetchone()
    if row:
        upd = {}
        if ip and row["ip"] != ip:
            upd["ip"] = ip
        if mac and not row["mac"]:
            upd["mac"] = mac
        if h.get("hostname") and not row["dns_name"]:
            upd["dns_name"] = h["hostname"]
        if upd:
            _update(conn, "interfaces", row["id"], upd)
            return "updated"
        return "same"
    wifi = h.get("connection") == "Wi-Fi"
    where = " ".join(str(x) for x in (h.get("uplink"), f"port {h['port']}" if h.get("port") else None) if x)
    _insert(conn, "interfaces", {
        "device_id": did, "name": "BMC" if mgmt else ("Wi-Fi" if wifi else "LAN"),
        "kind": "IPMI / BMC" if mgmt else ("Wi-Fi" if wifi else "Ethernet"),
        "ip": ip, "mac": mac, "dns_name": h.get("hostname"), "link_state": "Up" if h.get("online") else None,
        "assignment": "DHCP reservation" if h.get("fixed_ip") else ("DHCP" if h.get("source") == "unifi" else None),
        "wifi_ssid": h.get("network") if wifi else None,
        "notes": f"Uplink: {where}" if where else None,
    })
    return "added"


def _import_services(conn, did: int, h: dict) -> int:
    have = {r["port"] for r in conn.execute("SELECT port FROM services WHERE device_id = ?", (did,))}
    n = 0
    for p in h.get("ports") or []:
        port = int(p.get("port") or 0)
        if not port or port in have or port in (53, 445, 2049, 3260):
            continue
        scheme = discover.WEB_PORTS.get(port)
        _insert(conn, "services", {
            "device_id": did, "name": discover.PORT_HINTS.get(port, f"Port {port}"),
            "protocol": {22: "SSH", 3389: "TCP"}.get(port, scheme.upper() if scheme else "TCP"),
            "port": port, "status": "Running",
            "url": f"{scheme}://{h['ip']}{'' if (scheme, port) in (('http', 80), ('https', 443)) else f':{port}'}"
            if scheme and h.get("ip") else None,
        })
        n += 1
    return n


@app.post("/api/discover/import")
async def discover_apply(request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    body = await body_json(request)
    items, nets = body.get("items") or [], body.get("networks") or []
    if len(items) > 1000 or len(nets) > 200:
        raise HTTPException(400, "Too many items")
    loc = _coerce(conn, "location_id", "fk:locations", body.get("location_id"))
    with_services = bool(body.get("services", True))
    counts = {"networks": 0, "devices": 0, "linked": 0, "interfaces": 0, "services": 0}
    have = {r["cidr"]: r["id"] for r in conn.execute("SELECT id, cidr FROM networks WHERE cidr IS NOT NULL")}
    for n in nets:
        if n.get("cidr") in have:
            continue
        _insert(conn, "networks", {k: n.get(k) for k in
                                   ("name", "kind", "vlan_id", "cidr", "gateway", "dhcp_start", "dhcp_end", "domain")})
        counts["networks"] += 1
    if counts["networks"]:
        _backfill_networks(conn)
    for it in items:
        h = it.get("host") or {}
        if h.get("ip") and not discover._ip_ok(h["ip"]):
            raise HTTPException(400, f"Bad IP {h['ip']}")
        if it.get("action") == "new":
            label = h.get("name") or (h.get("hostname") or "").split(".")[0] or h.get("ip") or h.get("mac")
            did = _insert(conn, "devices", {
                "name": str(label)[:200], "hostname": h.get("hostname"),
                "device_type": it.get("device_type") or discover.guess_type(h),
                "manufacturer": h.get("vendor"), "model": h.get("model"),
                "status": "Active", "connected": 1, "location_id": loc,
            })
            counts["devices"] += 1
        elif it.get("action") == "link":
            did = int(it.get("device_id") or 0)
            fetch_one(conn, "devices", did)
            counts["linked"] += 1
        else:
            continue
        if _import_iface(conn, did, h, bool(it.get("mgmt"))) != "same":
            counts["interfaces"] += 1
        if with_services and not it.get("mgmt"):
            counts["services"] += _import_services(conn, did, h)
    audit(conn, request, "import", "devices", None,
          ", ".join(f"{v} {k}" for k, v in counts.items() if v) or "nothing")
    conn.commit()
    return counts


# ---------------------------------------------------------------------------
# Proxmox import (cluster, nodes, VMs and containers)
# ---------------------------------------------------------------------------

PVE_AAD = b"meta.proxmox_secret"


def _pve_conf(conn) -> dict:
    try:
        return json.loads(db.get_meta(conn, "proxmox") or "{}")
    except ValueError:
        return {}


def _device_by_name_or_ip(conn, name: str | None, ip: str | None):
    if name:
        n = name.strip().lower()
        r = conn.execute("SELECT id, name FROM devices WHERE host_id IS NULL AND (LOWER(name) = ? OR LOWER(hostname) = ? "
                         "OR LOWER(hostname) LIKE ?)", (n, n, n + ".%")).fetchone()
        if r:
            return r
    if ip:
        r = conn.execute("SELECT d.id, d.name FROM interfaces i JOIN devices d ON d.id = i.device_id WHERE i.ip = ?", (ip,)).fetchone()
        if r:
            return r
    return None


@app.post("/api/discover/proxmox")
async def discover_proxmox(request: Request, s=Depends(require_session), conn=Depends(get_db)):
    body = await body_json(request)
    conf = _pve_conf(conn)
    url, token_id = str(body.get("url") or conf.get("url") or ""), str(body.get("token_id") or conf.get("token_id") or "")
    secret = str(body.get("secret") or "").strip()
    if not secret and db.get_meta(conn, "proxmox_secret"):
        try:
            secret = crypto.unseal(s["dek"], crypto.b64d(db.get_meta(conn, "proxmox_secret")), PVE_AAD).decode()
        except crypto.DecryptError:
            secret = ""
    verify = bool(body.get("verify"))
    try:
        same = conf.get("url") == proxmox.base_url(url)
    except proxmox.ProxmoxError as e:
        raise HTTPException(400, str(e))
    pin = conf.get("fingerprint") if same and not body.get("trust_new_cert") else None
    try:
        out = await asyncio.to_thread(proxmox.read, url, token_id, secret, verify, True, pin)
    except proxmox.ProxmoxError as e:
        raise HTTPException(409 if e.code == "pin" else 400, str(e))
    db.set_meta(conn, "proxmox", json.dumps({"url": proxmox.base_url(url), "token_id": token_id, "verify": verify,
                                             "fingerprint": out.pop("fingerprint", "") or conf.get("fingerprint", "")}))
    if body.get("remember", True) and body.get("secret"):
        db.set_meta(conn, "proxmox_secret", crypto.b64e(crypto.seal(s["dek"], secret.encode(), PVE_AAD)))
    if out["cluster"]:
        r = conn.execute("SELECT id, name FROM clusters WHERE LOWER(name) = ?", (out["cluster"].lower(),)).fetchone()
        out["cluster_match"] = dict(r) if r else None
    node_dev = {}
    for n in out["nodes"]:
        r = _device_by_name_or_ip(conn, n["name"], n["ip"])
        n["match"] = dict(r) if r else None
        node_dev[n["name"]] = r["id"] if r else None
    for g in out["guests"]:
        host = node_dev.get(g["node"])
        r = None
        if host:
            r = conn.execute("SELECT id, name FROM devices WHERE host_id = ? AND vm_id = ?", (host, g["vmid"])).fetchone()
        if not r:
            r = conn.execute("SELECT id, name FROM devices WHERE LOWER(name) = ? AND (host_id IS NOT NULL OR device_type IN (?, ?))",
                             (g["name"].lower(), *VIRTUAL_TYPES)).fetchone()
        g["match"] = dict(r) if r else None
    audit(conn, request, "scan", "devices", None, f"Proxmox read: {len(out['nodes'])} nodes, {len(out['guests'])} guests")
    conn.commit()
    return out


@app.post("/api/discover/proxmox/import")
async def discover_proxmox_import(request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    body = await body_json(request)
    nodes, guests = body.get("nodes") or [], body.get("guests") or []
    if len(nodes) > 200 or len(guests) > 5000:
        raise HTTPException(400, "Too many items")
    counts = {"clusters": 0, "hosts_added": 0, "hosts_linked": 0, "guests_added": 0, "guests_updated": 0, "interfaces": 0}
    cluster_id = None
    cname = ai._s(body.get("cluster"), 200)
    if cname:
        r = conn.execute("SELECT id FROM clusters WHERE LOWER(name) = ?", (cname.lower(),)).fetchone()
        cluster_id = r["id"] if r else _insert(conn, "clusters", {"name": cname, "kind": "Proxmox VE"})
        counts["clusters"] += 0 if r else 1
    loc = _coerce(conn, "location_id", "fk:locations", body.get("location_id"))
    host_of: dict[str, int] = {}

    def add_ip(did, ip, name):
        if not ip or not discover._ip_ok(ip):
            return
        if conn.execute("SELECT 1 FROM interfaces WHERE device_id = ? AND ip = ?", (did, ip)).fetchone():
            return
        first = not conn.execute("SELECT 1 FROM interfaces WHERE device_id = ?", (did,)).fetchone()
        _insert(conn, "interfaces", {"device_id": did, "name": name, "kind": "Ethernet", "ip": ip, "is_primary": first})
        counts["interfaces"] += 1

    for n in nodes:
        name = ai._s(n.get("name"), 200)
        if not name:
            continue
        if n.get("device_id"):
            did = int(n["device_id"])
            fetch_one(conn, "devices", did)
            upd = {"cluster_id": cluster_id} if cluster_id else {}
            dev = conn.execute("SELECT device_type FROM devices WHERE id = ?", (did,)).fetchone()
            if not dev["device_type"] or dev["device_type"] == "Server":
                upd["device_type"] = "Hypervisor Host"
            if upd:
                _update(conn, "devices", did, upd)
            counts["hosts_linked"] += 1
        elif n.get("create"):
            did = _insert(conn, "devices", {"name": name, "hostname": name, "device_type": "Hypervisor Host", "status": "Active",
                                            "connected": 1, "cluster_id": cluster_id, "location_id": loc, "os": "Proxmox VE"})
            counts["hosts_added"] += 1
        else:
            continue
        add_ip(did, n.get("ip"), "vmbr0")
        host_of[name] = did

    for g in guests:
        host = host_of.get(g.get("node"))
        fields = {"name": ai._s(g.get("name"), 200) or f"VM {g.get('vmid')}", "device_type": g.get("kind") if g.get("kind") in VIRTUAL_TYPES else "Virtual Machine",
                  "vm_id": ai._s(g.get("vmid"), 20), "vcpus": g.get("vcpus") if isinstance(g.get("vcpus"), int) else None,
                  "vm_ram_gb": g.get("ram_gb") if isinstance(g.get("ram_gb"), (int, float)) else None,
                  "vm_disk_gb": g.get("disk_gb") if isinstance(g.get("disk_gb"), (int, float)) else None,
                  "status": "Active" if g.get("running") else "Standby", "connected": 1 if g.get("running") else 0,
                  "host_id": host, "cluster_id": cluster_id}
        if g.get("device_id"):
            did = int(g["device_id"])
            fetch_one(conn, "devices", did)
            _update(conn, "devices", did, {k: v for k, v in fields.items() if v is not None and k != "name"})
            counts["guests_updated"] += 1
        elif g.get("create"):
            did = _insert(conn, "devices", {k: v for k, v in fields.items() if v is not None})
            counts["guests_added"] += 1
        else:
            continue
        for i, ip in enumerate((g.get("ips") or [])[:4]):
            add_ip(did, ip, f"net{i}")
    audit(conn, request, "import", "devices", None, "Proxmox: " + ", ".join(f"{v} {k}" for k, v in counts.items() if v))
    conn.commit()
    return counts


# ---------------------------------------------------------------------------
# Generic CRUD
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Online status, Wake-on-LAN and saved actions
# ---------------------------------------------------------------------------

def _status_row(conn, d: dict) -> dict:
    return {k: d[k] for k in ("id", "name", "device_type", "status", "connected", "watch", "location_id",
                              "location_name", "rack_id", "rack_name", "rack_u", "u_height", "host_id",
                              "host_name", "mgmt_url", "manufacturer", "model")} | monitor.device_state(conn, d)


@app.get("/api/status")
def status_board(_s=Depends(require_session), conn=Depends(get_db)):
    """Every device with an address, and whether it's answering."""
    devices = fetch_list(conn, "devices", limit=5000)
    with_ip = [d for d in devices if d["ips"]]
    actions: dict[int, list] = {}
    for a in fetch_list(conn, "actions", limit=5000):
        if a["device_id"] and a["pinned"]:
            actions.setdefault(a["device_id"], []).append({"id": a["id"], "name": a["name"], "confirm": a["confirm"]})
    wakeable = {r[0] for r in conn.execute("SELECT DISTINCT device_id FROM interfaces WHERE mac IS NOT NULL AND mac != ''")}
    rows = [_status_row(conn, d) | {"actions": actions.get(d["id"], []), "can_wake": d["id"] in wakeable,
                                    "containers": docker_summary(conn, d["id"]),
                                    "health": [p for p in upkeep.problems(conn, d["id"]) if p["level"] != "info"]} for d in with_ip]
    last = conn.execute("SELECT MAX(checked_at) FROM device_status").fetchone()[0]
    return {"devices": rows, "without_address": len(devices) - len(with_ip), "last_check": last,
            "checking": monitor._full_lock.locked(), **monitor.settings(conn)}


@app.get("/api/services/board")
def services_board(sess=Depends(require_session), conn=Depends(get_db)):
    """Every service, with whether it answers, for the Services page (cards or a list)."""
    rows = []
    status = {r["service_id"]: dict(r) for r in conn.execute("SELECT * FROM service_status")}
    devs = {d["id"]: d for d in fetch_list(conn, "devices", limit=5000)}
    for s in fetch_list(conn, "services", limit=5000):
        d = devs.get(s["device_id"]) or {}
        st = status.get(s["id"]) or {}
        try:
            buttons = json.loads(s["buttons"] or "[]")
        except ValueError:
            buttons = []
        rows.append({**s, "buttons": buttons, "state": st.get("state"), "latency_ms": st.get("latency_ms"), "detail": st.get("detail"),
                     "checked_at": st.get("checked_at"), "changed_at": st.get("changed_at"), "cert_expires": st.get("cert_expires"),
                     "location_id": d.get("location_id"), "location_name": d.get("location_name"),
                     "device_status": d.get("status"), "host": ((d.get("ips") or "").split(",")[0].split("/")[0].strip() or d.get("hostname") or None)})
    actions = [{"id": a["id"], "name": a["name"], "confirm": a["confirm"], "device_id": a["device_id"]}
               for a in fetch_list(conn, "actions", limit=5000)]
    # Buttons that show their result: the last line of that action's newest run (it runs only when pressed).
    shown = {b["action_id"] for r in rows for b in r["buttons"] if b.get("kind") == "action" and b.get("show")}
    results = {}
    for aid in shown:
        run = conn.execute("SELECT ok, at, output_enc FROM action_runs WHERE action_id = ? ORDER BY id DESC LIMIT 1", (aid,)).fetchone()
        if run:
            try:
                text = crypto.unseal(sess["dek"], run["output_enc"], RUN_AAD).decode() if run["output_enc"] else ""
            except crypto.DecryptError:
                text = ""
            line = next((ln.strip() for ln in reversed(text.splitlines()) if ln.strip() and not ln.startswith("> ")), "")
            results[aid] = {"ok": bool(run["ok"]), "at": run["at"], "line": line[:80]}
    for r in rows:
        for b in r["buttons"]:
            if b.get("show") and b.get("action_id") in results:
                b["result"] = results[b["action_id"]]
    return {"services": rows, "actions": actions, "colors": SERVICE_COLORS, "layouts": _service_layouts(conn)}


def _service_layouts(conn) -> list:
    try:
        return json.loads(db.get_meta(conn, "service_layouts") or "[]")
    except ValueError:
        return []


@app.put("/api/services/layouts")
async def service_layouts_save(request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    """Named Services layouts (how cards look, and the filters), kept in HaRM so every device can pick them."""
    body = await body_json(request)
    items = body.get("layouts")
    if not isinstance(items, list) or len(items) > 20:
        raise HTTPException(400, "Up to 20 saved layouts")
    out, names = [], set()
    for it in items:
        name = " ".join(str((it or {}).get("name") or "").split())[:40] if isinstance(it, dict) else ""
        view, filters = it.get("view") if name else None, it.get("filters") or {}
        if not name or not isinstance(view, dict) or not isinstance(filters, dict) or name.lower() in names:
            raise HTTPException(400, "Each layout needs its own name")
        if len(json.dumps(view)) + len(json.dumps(filters)) > 4000:
            raise HTTPException(400, "That layout is too big")
        names.add(name.lower())
        out.append({"name": name, "view": view, "filters": filters})
    db.set_meta(conn, "service_layouts", json.dumps(out) if out else None)
    conn.commit()
    return {"layouts": out}


@app.post("/api/status/check")
async def status_check(request: Request, _s=Depends(require_session)):
    """Check now: one device, or all of them (skipped if a check finished less than max_age seconds ago)."""
    body = await body_json(request)
    did = body.get("device_id")
    if DEMO:  # made-up devices keep their made-up states; only the time of the check moves
        conn = db.connect()
        try:
            for table in ("device_status", "service_status"):
                conn.execute(f"UPDATE {table} SET checked_at = ?" + (" WHERE device_id = ?" if did else ""),
                             (monitor._now(), int(did)) if did else (monitor._now(),))
            conn.commit()
        finally:
            conn.close()
        return {"checked": True, "changes": []}
    if did:
        conn = db.connect()
        try:
            fetch_one(conn, "devices", int(did))
        finally:
            conn.close()
        changes = await monitor.check(int(did))
        return {"checked": True, "changes": changes}
    ran = await monitor.check_if_older(float(body.get("max_age") or 0))
    return {"checked": ran}


def _wake_targets(conn, did: int) -> tuple[str, list[str]] | None:
    """The MAC to wake (the main interface's, else any) and the broadcast addresses to send it to."""
    rows = conn.execute(
        f"SELECT i.mac, i.ip, i.subnet, n.cidr FROM interfaces i LEFT JOIN networks n ON n.id = i.network_id "
        f"WHERE i.device_id = ? AND i.mac IS NOT NULL AND i.mac != '' ORDER BY {iface_order('i')}", (did,)).fetchall()
    if not rows:
        return None
    main = rows[0]
    casts = [b for r in rows if (b := monitor.broadcast_of(r["ip"], r["subnet"], r["cidr"]))]
    return main["mac"], casts


@app.post("/api/devices/{did}/wake")
def device_wake(did: int, request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    dev = fetch_one(conn, "devices", did)
    if DEMO:
        raise HTTPException(501, DEMO_NO_NETWORK)
    t = _wake_targets(conn, did)
    if not t:
        raise HTTPException(400, "Add the device's MAC address (Network tab) so HaRM can wake it")
    try:
        sent = monitor.wake(t[0], t[1])
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))
    audit(conn, request, "wake", "devices", did, f"{dev['name']} ({t[0]})")
    conn.commit()
    return {"mac": t[0], "sent_to": sent}


ACTION_MODES = ("script", "lines")
RUN_AAD = b"action_runs.output"


def _action_hosts(text: str | None) -> list[str]:
    return [h.strip() for h in re.split(r"[\s,;]+", text or "") if h.strip()]


SERVICE_COLORS = ("blue", "orange", "green", "purple", "red", "teal", "yellow", "gray")
# What a card's own button may open: web pages, and the apps for SSH, file shares and remote desktops.
BUTTON_SCHEMES = ("http", "https", "ssh", "sftp", "smb", "vnc", "rdp")


def _service_rules(conn, data: dict) -> None:
    """Card settings: a known icon and color, lists as words, and buttons that can only open a link,
    copy text, or run one of your saved actions (which keep their own confirm and unlock rules)."""
    if data.get("icon") and not re.match(r"^[a-z0-9-]{1,32}$", data["icon"]):
        raise HTTPException(400, "icon: pick one from the list")
    if data.get("color") and data["color"] not in SERVICE_COLORS:
        raise HTTPException(400, f"color: one of {', '.join(SERVICE_COLORS)}")
    if "lists" in data and data["lists"] is not None:
        words = list(dict.fromkeys(w.strip()[:30] for w in re.split(r"[,\n]", data["lists"]) if w.strip()))
        data["lists"] = ", ".join(words[:12]) or None
    if "buttons" in data and data["buttons"]:
        try:
            raw = json.loads(data["buttons"])
        except ValueError:
            raise HTTPException(400, "buttons: not readable")
        if not isinstance(raw, list) or len(raw) > 8:
            raise HTTPException(400, "buttons: up to 8")
        out = []
        for b in raw:
            if not isinstance(b, dict):
                raise HTTPException(400, "buttons: not readable")
            label = " ".join(str(b.get("label") or "").split())[:30]
            kind = b.get("kind")
            if not label:
                raise HTTPException(400, "buttons: give each button a name")
            if kind in ("link", "copy"):
                val = str(b.get("value") or "").strip()[:500]
                if not val:
                    raise HTTPException(400, f"buttons: “{label}” needs {'an address' if kind == 'link' else 'something to copy'}")
                if kind == "link" and urlparse(val).scheme.lower() not in BUTTON_SCHEMES:
                    raise HTTPException(400, f"buttons: “{label}” must start with {', '.join(s + '://' for s in BUTTON_SCHEMES)}")
                out.append({"kind": kind, "label": label, "value": val})
            elif kind == "action":
                aid = b.get("action_id")
                if not isinstance(aid, int) or not conn.execute("SELECT 1 FROM actions WHERE id = ?", (aid,)).fetchone():
                    raise HTTPException(400, f"buttons: “{label}” runs an action that doesn't exist")
                out.append({"kind": "action", "label": label, "action_id": aid, **({"show": True} if b.get("show") else {})})
            else:
                raise HTTPException(400, "buttons: a button opens a link, copies text or runs an action")
        data["buttons"] = json.dumps(out) if out else None


def _action_rules(conn, data: dict, existing: dict | None) -> None:
    merged = {**(existing or {}), **data}
    if merged.get("mode") not in ACTION_MODES:
        if "mode" in data and data["mode"] is not None:
            raise HTTPException(400, "mode must be script or lines")
        data["mode"] = "script"
    hosts = _action_hosts(merged.get("hosts"))
    if "hosts" in data:
        data["hosts"] = "\n".join(hosts) or None
    if not hosts and not merged.get("device_id"):
        raise HTTPException(400, "hosts: pick a device or enter an address to send it to")
    for h in hosts:
        if not remote._HOST.match(h) or h.startswith("-"):
            raise HTTPException(400, f"hosts: “{h}” isn't a valid host name or IP address")
    if merged.get("port") is not None and not 0 < merged["port"] < 65536:
        raise HTTPException(400, "port: must be 1 to 65535")
    if merged.get("username") and not remote._USER.match(merged["username"]):
        raise HTTPException(400, "username: that doesn't look like a username")
    try:
        remote.parse_ssh_options(merged.get("ssh_options"))
    except remote.RemoteError as e:
        raise HTTPException(400, f"ssh_options: {e}")


def _action_addresses(conn, a: dict) -> list[str]:
    hosts = _action_hosts(a["hosts"])
    if hosts or not a["device_id"]:
        return hosts
    st = monitor.device_state(conn, {"id": a["device_id"], "watch": 1, "connected": 1, "status": ""}, with_history=False)
    return [st["address"]] if st["address"] else []


@app.post("/api/actions/{aid}/run")
async def action_run(aid: int, request: Request, s=Depends(require_session), conn=Depends(get_db)):
    """Run a saved action on each of its addresses (or only the one asked for)."""
    a = fetch_one(conn, "actions", aid)
    if DEMO:
        raise HTTPException(501, DEMO_NO_NETWORK)
    body = await body_json(request)
    hosts = _action_addresses(conn, a)
    if body.get("host"):
        if body["host"] not in hosts:
            raise HTTPException(400, "That address isn't one of this action's")
        hosts = [body["host"]]
    if not hosts:
        raise HTTPException(400, "This action has no address to send it to. Add one, or give the device an IP address")
    user, pw = a["username"] or "", None
    if a["credential_id"]:
        row = conn.execute("SELECT * FROM credentials WHERE id = ?", (a["credential_id"],)).fetchone()
        if row:
            user = user or row["username"] or ""
            pw = _decrypt(s["dek"], row["password_enc"], "password")
            if pw and pw.startswith("<<"):
                pw = None
    port = a["port"] or 22
    trust = bool(body.get("trust_new_key"))
    key = _hkey(conn, s)

    async def one(host):
        try:
            if trust:
                await asyncio.to_thread(remote.forget_host, host, port)
            r = await asyncio.to_thread(remote.run_action, host, port, user, pw, a["mode"], a["command"],
                                        bool(a["sudo"]), bool(a["legacy_ssh"]), a["ssh_options"], key=key)
            return {"host": host, **r}
        except remote.RemoteError as e:
            return {"host": host, "ok": False, "exit_code": None, "output": "", "ms": None, "error": str(e), "code": e.code}

    results = await asyncio.gather(*(one(h) for h in hosts[:16]))
    for r in results:
        out = r["output"] or r.get("error") or ""
        conn.execute("INSERT INTO action_runs (action_id, host, ok, exit_code, ms, output_enc) VALUES (?,?,?,?,?,?)",
                     (aid, r["host"], int(r["ok"]), r["exit_code"], r["ms"],
                      crypto.seal(s["dek"], out.encode(), RUN_AAD) if out else None))
    # Keep the newest 50 runs of each action.
    conn.execute("DELETE FROM action_runs WHERE action_id = ? AND id NOT IN "
                 "(SELECT id FROM action_runs WHERE action_id = ? ORDER BY id DESC LIMIT 50)", (aid, aid))
    ok = sum(1 for r in results if r["ok"])
    if a["device_id"]:
        did_note(conn, a["device_id"], f"Ran “{a['name']}”" + (f" on {', '.join(r['host'] for r in results)}" if len(results) > 1 else "")
                 + (": it worked." if ok == len(results) else f": {len(results) - ok} of {len(results)} failed."))
    audit(conn, request, "run-action", "actions", aid,
          f"{a['name']} on {', '.join(r['host'] for r in results)}: {ok} of {len(results)} worked")
    conn.commit()
    return {"action": a["name"], "results": results}


@app.get("/api/actions/{aid}/runs")
def action_runs(aid: int, s=Depends(require_session), conn=Depends(get_db)):
    fetch_one(conn, "actions", aid)
    out = []
    for r in conn.execute("SELECT * FROM action_runs WHERE action_id = ? ORDER BY id DESC LIMIT 20", (aid,)):
        r = dict(r)
        blob = r.pop("output_enc")
        try:
            r["output"] = crypto.unseal(s["dek"], blob, RUN_AAD).decode() if blob else ""
        except crypto.DecryptError:
            r["output"] = "(can't be read)"
        out.append(r)
    return out


@app.get("/api/status/report")
def status_report(days: int = 7, _s=Depends(require_session), conn=Depends(get_db)):
    if days not in (1, 7, 30):
        raise HTTPException(400, "days must be 1, 7 or 30")
    return monitor.report(conn, days)


@app.get("/api/power")
def power_summary(_s=Depends(require_session), conn=Depends(get_db)):
    return power.summary(conn)


# ---------------------------------------------------------------------------
# Watching for new devices on the network
# ---------------------------------------------------------------------------

@app.get("/api/netwatch")
def netwatch_get(_s=Depends(require_session), conn=Depends(get_db)):
    nets = [dict(r) for r in conn.execute("SELECT id, name, kind, vlan_id, cidr FROM networks ORDER BY vlan_id, name")]
    return {**netwatch.config(conn), "all_networks": nets, "pending": netwatch.pending(conn)}


@app.post("/api/netwatch")
async def netwatch_set(request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    if DEMO:
        raise HTTPException(501, DEMO_NO_NETWORK)
    body = await body_json(request)
    try:
        out = netwatch.save(conn, body)
    except (TypeError, ValueError) as e:
        raise HTTPException(400, str(e))
    audit(conn, request, "settings", "networks", None,
          f"new-device watch {'on' if out['enabled'] else 'off'}: {len(out['networks'])} network(s)")
    conn.commit()
    return out


@app.post("/api/netwatch/scan")
async def netwatch_scan(_s=Depends(require_session)):
    if DEMO:
        raise HTTPException(501, DEMO_NO_NETWORK)
    if netwatch._lock.locked():
        raise HTTPException(409, "A scan is already running")
    return await netwatch.scan_now()


@app.post("/api/netwatch/{sid}")
async def netwatch_mark(sid: int, request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    body = await body_json(request)
    try:
        netwatch.mark(conn, sid, str(body.get("status")))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except LookupError as e:
        raise HTTPException(404, str(e))
    conn.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Copying backups to a second place
# ---------------------------------------------------------------------------

@app.get("/api/backup-copy")
def backup_copy_get(_s=Depends(require_session), conn=Depends(get_db)):
    return _copy_conf(conn)


@app.post("/api/backup-copy")
async def backup_copy_set(request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    if DEMO:
        raise HTTPException(501, DEMO_NO_NETWORK)
    body = await body_json(request)
    conf = _copy_conf(conn)
    folder = str(body.get("dir") or "").strip()
    keep = int(body.get("keep") or conf["keep"])
    if keep not in COPY_KEEP:
        raise HTTPException(400, "keep: 7, 14, 30 or 90")
    if folder:
        p = Path(folder).expanduser()
        if not p.is_absolute():
            raise HTTPException(400, "dir: enter the whole path, like /mnt/nas/harm-backups or D:\\HaRM backups")
        if not p.is_dir():
            raise HTTPException(400, f"dir: {p} doesn't exist on the HaRM computer. Connect the drive or share, or create the folder")
        if p.resolve() == BACKUP_DIR.resolve():
            raise HTTPException(400, "dir: that's where HaRM already keeps its backups. Pick another disk")
        try:
            probe = p / ".harm-write-test"
            probe.write_bytes(b"ok")
            probe.unlink()
        except OSError as e:
            raise HTTPException(400, f"dir: HaRM can't write there ({e.strerror or e})")
        folder = str(p)
    conf.update(dir=folder, keep=keep)
    db.set_meta(conn, "backup_copy", json.dumps(conf))
    audit(conn, request, "settings", None, None, f"backup copies: {folder or 'off'}")
    conn.commit()
    return conf


@app.post("/api/backup-copy/run")
async def backup_copy_run(_s=Depends(require_session)):
    if DEMO:
        raise HTTPException(501, DEMO_NO_NETWORK)
    r = await asyncio.to_thread(copy_backup)
    if r is None:
        raise HTTPException(400, "Choose a folder first")
    return r


# ---------------------------------------------------------------------------
# Alerts (ntfy, email, webhook)
# ---------------------------------------------------------------------------

@app.get("/api/alerts")
def alerts_get(_s=Depends(require_session), conn=Depends(get_db)):
    return {**alerts.public(conn), "recent": alerts.recent(conn)}


@app.post("/api/alerts")
async def alerts_set(request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    if DEMO:
        raise HTTPException(501, DEMO_NO_NETWORK)
    body = await body_json(request)
    try:
        out = alerts.save(conn, body)
    except alerts.AlertError as e:
        raise HTTPException(400, str(e))
    audit(conn, request, "settings", None, None, "alerts: " + ", ".join(
        f"{k} on" for k in ("enabled", "ntfy_on", "email_on", "webhook_on") if out[k]) or "alerts off")
    conn.commit()
    return out


@app.post("/api/alerts/test")
async def alerts_test(request: Request, _s=Depends(require_session)):
    if DEMO:
        raise HTTPException(501, DEMO_NO_NETWORK)
    body = await body_json(request)
    results = await asyncio.to_thread(alerts.send, "Test from Zom's HaRM",
                                      "Alerts work. You'll get one like this when a device stops answering.", False,
                                      {"kind": "test"}, body.get("channel"))
    if not results:
        raise HTTPException(400, "Turn on ntfy, email or a webhook first, and save")
    return {"results": results}


# ---------------------------------------------------------------------------
# App settings and the new-version check
# ---------------------------------------------------------------------------

@app.get("/api/settings/app")
def app_settings_get(_s=Depends(require_session), conn=Depends(get_db)):
    return monitor.settings(conn)


@app.post("/api/settings/app")
async def app_settings_set(request: Request, _s=Depends(require_session), conn=Depends(get_db)):
    body = await body_json(request)
    try:
        out = monitor.save_settings(conn, body)
    except (TypeError, ValueError) as e:
        raise HTTPException(400, str(e))
    _load_limits(conn)
    audit(conn, request, "settings", None, None, ", ".join(f"{k} = {v}" for k, v in body.items()))
    conn.commit()
    return out


RELEASES_API = "https://api.github.com/repos/ZomBeatz/Zoms-HaRM/releases/latest"
_update_cache: dict = {}


def _version_tuple(v: str) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", v)[:3])


def _latest_release() -> dict:
    """The newest published release on GitHub, asked at most twice a day."""
    if _update_cache.get("at", 0) > time.time() - 12 * 3600:
        return _update_cache["data"]
    import urllib.request
    req = urllib.request.Request(RELEASES_API, headers={"Accept": "application/vnd.github+json",
                                                        "User-Agent": f"Zoms-HaRM/{__version__}"})
    with urllib.request.urlopen(req, timeout=8) as r:
        rel = json.loads(r.read())
    data = {"latest": str(rel.get("tag_name") or "").lstrip("v"), "url": rel.get("html_url"),
            "published": rel.get("published_at")}
    _update_cache.update(at=time.time(), data=data)
    return data


@app.get("/api/update-check")
async def update_check(_s=Depends(require_session), conn=Depends(get_db)):
    if not monitor.settings(conn)["update_check"]:
        return {"enabled": False, "current": __version__}
    try:
        rel = await asyncio.to_thread(_latest_release)
    except Exception:
        return {"enabled": True, "current": __version__, "error": "Couldn't reach GitHub to check"}
    newer = bool(rel["latest"]) and _version_tuple(rel["latest"]) > _version_tuple(__version__)
    return {"enabled": True, "current": __version__, **rel, "newer": newer}


@app.get("/api/{entity}")
def list_entity(entity: str, request: Request, _s=Depends(require_session),
                conn=Depends(get_db)):
    entity_or_404(entity)
    params = dict(request.query_params)
    q = params.pop("q", None)
    return fetch_list(conn, entity, params, q)


@app.get("/api/{entity}/{rid}")
def get_entity(entity: str, rid: int, _s=Depends(require_session), conn=Depends(get_db)):
    entity_or_404(entity)
    return fetch_one(conn, entity, rid)


def _apply_rules(conn, entity: str, data: dict, existing: dict | None) -> None:
    if entity == "devices":
        _device_rules(conn, data, existing)
    elif entity == "components":
        _component_rules(conn, data, existing)
    elif entity == "locations" and existing and data.get("parent_id"):
        # Prevent cycles in the location tree.
        cur = data["parent_id"]
        while cur:
            if cur == existing["id"]:
                raise HTTPException(400, "A location cannot be inside itself")
            r = conn.execute("SELECT parent_id FROM locations WHERE id = ?", (cur,)).fetchone()
            cur = r["parent_id"] if r else None
    elif entity == "interfaces":
        _interface_rules(conn, data, existing)
    elif entity == "networks":
        _network_rules(conn, data, existing)
    elif entity == "build_items":
        _build_item_rules(conn, data, existing)
    elif entity == "notes":
        _note_rules(conn, data, existing)
    elif entity == "builds":
        if "status" in data and not data["status"]:
            data["status"] = "Planning"
    elif entity == "actions":
        _action_rules(conn, data, existing)
    elif entity == "services":
        _service_rules(conn, data)
    elif entity == "connections":
        merged = {**(existing or {}), **data}
        if not merged.get("b_device_id") and not merged.get("b_endpoint"):
            raise HTTPException(400, "Choose a far-end device or describe the endpoint")


NOTE_TARGETS = {"devices", "racks", "locations", "components", "networks", "builds", "clusters"}
NOTE_KINDS = {"note", "task", "action", "issue"}


def _note_rules(conn, data: dict, existing: dict | None) -> None:
    merged = {**(existing or {}), **data}
    if merged.get("entity") not in NOTE_TARGETS:
        raise HTTPException(400, "Notes can be attached to devices, racks, locations, parts, networks, builds or clusters")
    if not conn.execute(f"SELECT 1 FROM {merged['entity']} WHERE id = ?", (merged.get("entity_id"),)).fetchone():
        raise HTTPException(400, "That item no longer exists")
    if merged.get("kind") not in NOTE_KINDS:
        data["kind"] = "note" if not merged.get("kind") else None
        if data["kind"] is None:
            raise HTTPException(400, "kind must be note, task, action or issue")
    if "done" in data:
        was = bool((existing or {}).get("done"))
        if data["done"] and not was:
            data["done_at"] = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())  # UTC, like created_at
        elif not data["done"]:
            data["done_at"] = None


def _build_item_rules(conn, data: dict, existing: dict | None) -> None:
    merged = {**(existing or {}), **data}
    if merged.get("category") not in pcbuild.CATEGORY_KEYS:
        raise HTTPException(400, "Unknown build category")
    if not (merged.get("catalog_id") or merged.get("component_id") or merged.get("name")):
        raise HTTPException(400, "Pick a library part, an inventory part, or give it a name")
    if merged.get("acquire") not in (None, "Have", "Need", "Ordered"):
        raise HTTPException(400, "acquire must be Have, Need or Ordered")
    if "quantity" in data and (data["quantity"] is None or data["quantity"] < 1):
        raise HTTPException(400, "quantity must be at least 1")
    if existing is None:
        if not data.get("name"):
            if data.get("catalog_id"):
                data["name"] = conn.execute("SELECT name FROM catalog_parts WHERE id = ?", (data["catalog_id"],)).fetchone()["name"]
            elif data.get("component_id"):
                c = conn.execute("SELECT category, manufacturer, model, capacity FROM components WHERE id = ?",
                                 (data["component_id"],)).fetchone()
                data["name"] = " ".join(x for x in (c["manufacturer"], c["model"], c["capacity"]) if x) or c["category"]
        if data.get("component_id") and not data.get("acquire"):
            data["acquire"] = "Have"


def _label(entity: str, row: dict) -> str:
    for k in ("name", "label", "model", "category", "a_port"):
        if row.get(k):
            return str(row[k])
    return f"#{row.get('id')}"


@app.post("/api/{entity}")
async def create_entity(entity: str, request: Request, s=Depends(require_session),
                        conn=Depends(get_db)):
    entity_or_404(entity)
    body = await body_json(request)
    enc = _encrypt_secrets(body, s["dek"]) if entity == "credentials" else {}
    data = validate(conn, entity, body, partial=False)
    _apply_rules(conn, entity, data, None)
    data = {k: v for k, v in data.items() if v is not None}
    data.update({k: v for k, v in enc.items() if v is not None})
    if not data:
        raise HTTPException(400, "Nothing to save")
    cols = list(data)
    cur = conn.execute(
        f"INSERT INTO {entity} ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
        [data[c] for c in cols])
    if entity == "networks":
        _backfill_networks(conn)
    if entity == "build_items":
        conn.execute("UPDATE builds SET updated_at = datetime('now') WHERE id = ?", (data["build_id"],))
    row = fetch_one(conn, entity, cur.lastrowid)
    audit(conn, request, "create", entity, row["id"], _label(entity, row))
    conn.commit()
    return row


@app.put("/api/{entity}/{rid}")
async def update_entity(entity: str, rid: int, request: Request, s=Depends(require_session),
                        conn=Depends(get_db)):
    entity_or_404(entity)
    existing = fetch_one(conn, entity, rid)
    body = await body_json(request)
    enc = _encrypt_secrets(body, s["dek"]) if entity == "credentials" else {}
    data = validate(conn, entity, body, partial=True)
    _apply_rules(conn, entity, data, existing)
    data.update(enc)
    if data:
        sets = ", ".join(f"{k} = ?" for k in data)
        conn.execute(f"UPDATE {entity} SET {sets}, updated_at = datetime('now') WHERE id = ?",
                     [*data.values(), rid])
    if entity == "networks":
        _backfill_networks(conn)
    row = fetch_one(conn, entity, rid)
    changed = sorted(data)
    audit(conn, request, "update", entity, rid,
          f"{_label(entity, row)}: {', '.join(changed)}" if changed else _label(entity, row))
    conn.commit()
    return row


@app.delete("/api/{entity}/{rid}")
def delete_entity(entity: str, rid: int, request: Request, _s=Depends(require_session),
                  conn=Depends(get_db)):
    entity_or_404(entity)
    row = fetch_one(conn, entity, rid)
    if entity == "racks":
        conn.execute("UPDATE devices SET rack_u = NULL WHERE rack_id = ?", (rid,))
    if entity == "devices" and request.query_params.get("parts") == "delete":
        # Deleted with it (they were added by mistake, or the device is gone for good).
        conn.execute("DELETE FROM components WHERE device_id = ?", (rid,))
    elif entity == "devices":
        # Parts inside a deleted device go back to stock where the device was.
        conn.execute("UPDATE components SET status = 'In Stock', location_id = ?, rack_id = ?, slot_id = NULL, "
                     "bay = NULL WHERE device_id = ?", (row["location_id"], row["rack_id"], rid))
    if entity == "device_slots":
        conn.execute("UPDATE components SET slot_id = NULL, bay = NULL WHERE slot_id = ?", (rid,))
    if entity == "build_items":
        conn.execute("UPDATE builds SET updated_at = datetime('now') WHERE id = ?", (row["build_id"],))
    if entity in NOTE_TARGETS:
        conn.execute("DELETE FROM notes WHERE entity = ? AND entity_id = ?", (entity, rid))
    conn.execute(f"DELETE FROM {entity} WHERE id = ?", (rid,))
    audit(conn, request, "delete", entity, rid, _label(entity, row))
    conn.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------

@app.get("/sw.js")
def service_worker():
    """Served from the root so it can control the whole app (needed for 'Install app')."""
    return FileResponse(STATIC / "sw.js", media_type="text/javascript",
                        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})


# iPhone/iPad and some browsers look for these at fixed root addresses.
@app.get("/apple-touch-icon.png")
@app.get("/apple-touch-icon-precomposed.png")
@app.get("/apple-touch-icon-180x180.png")
def apple_touch_icon():
    return FileResponse(STATIC / "apple-touch-icon.png", media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/favicon.ico")
def favicon():
    return FileResponse(STATIC / "favicon.ico", media_type="image/x-icon", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/harm-ca.crt")
def ca_certificate():
    """HaRM's local certificate authority (public part only), so phones can trust HTTPS."""
    path = db.DB_PATH.parent / "tls" / "harm-ca.crt"
    if not path.is_file():
        raise HTTPException(404, "No local certificate authority. Run scripts/make-cert.sh first.")
    return FileResponse(path, media_type="application/x-x509-ca-cert", filename="harm-ca.crt")


app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
def index():
    # The interface is built from ui/ into static/app/ (npm run build) and committed with the code.
    return FileResponse(STATIC / "app" / "index.html", headers={"Cache-Control": "no-cache"})
