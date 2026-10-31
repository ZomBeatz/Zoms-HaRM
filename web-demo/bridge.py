"""Runs HaRM's real server inside the browser (Pyodide) for the online demo.

worker.js loads this after unpacking the harm package. Requests from the page arrive in handle()
and go straight into the FastAPI app, so the demo always behaves like the code it was built from.
"""

import asyncio
import json
import os
import time

os.environ.update(HARM_DB="/data/harm.db", HARM_AUTO_BACKUP="0", HARM_IDLE_MINUTES="1440",
                  HARM_MAX_SESSION_HOURS="72", HARM_SECURE_COOKIE="0", HARM_DEMO="1")

# Pyodide can't start threads, so work that HaRM hands to a thread runs inline instead.
import anyio.to_thread  # noqa: E402


async def _inline(func, *args, **_kw):
    return func(*args)


async def _inline_kw(func, /, *args, **kwargs):
    return func(*args, **kwargs)


anyio.to_thread.run_sync = _inline
asyncio.to_thread = _inline_kw

# Pyodide's hashlib has no scrypt; cryptography's gives the same bytes, so saved vaults still open.
import hashlib  # noqa: E402

if not hasattr(hashlib, "scrypt"):
    from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

    def _scrypt(password, *, salt, n, r, p, maxmem=0, dklen=64):
        return Scrypt(salt=salt, length=dklen, n=n, r=r, p=p).derive(password)

    hashlib.scrypt = _scrypt

# The pages themselves are served by GitHub, but HaRM's app expects its static folder to exist.
os.makedirs(os.path.join(os.path.dirname(__file__), "harm", "static"), exist_ok=True)
from harm import db, main  # noqa: E402

PASSWORD = "demo-password"
NEEDS_LAN = "This needs HaRM running on your own network. The online demo can't reach other devices or the internet."
# Endpoints that talk to other machines, programs or AI services: answered with NEEDS_LAN.
OFFLINE = [("POST", "/api/scan"), ("POST", "/api/ai/ask"), ("POST", "/api/catalog/update"),
           ("POST", "/api/discover/scan"), ("POST", "/api/discover/unifi"), ("POST", "/api/discover/proxmox"),
           ("GET", "/api/update-check")]

_cookies: dict[str, str] = {}


def _offline(method: str, path: str) -> bool:
    if method == "POST" and path.startswith("/api/devices/") and path.endswith(("/collect", "/wake")):
        return True
    if method == "POST" and path.startswith("/api/actions/") and path.endswith("/run"):
        return True
    return (method, path.rstrip("/")) in OFFLINE


def _keep_cookies(headers) -> None:
    """A tiny cookie jar: the page never sees the session cookie, the bridge sends it back itself."""
    for k, v in headers:
        if k.lower() != b"set-cookie":
            continue
        pair, _, attrs = v.decode().partition(";")
        name, _, value = pair.strip().partition("=")
        gone = "max-age=0" in attrs.lower().replace(" ", "") or not value or value == '""'
        if gone:
            _cookies.pop(name, None)
        else:
            _cookies[name] = value


async def handle(method: str, url: str, headers: list, body: bytes = b"") -> tuple:
    """Answer one request; returns (status, [[name, value], ...], body bytes)."""
    path, _, query = url.partition("?")
    if _offline(method, path):
        return 501, [["content-type", "application/json"]], json.dumps({"detail": NEEDS_LAN}).encode()
    if method == "POST" and path == "/api/status/check":
        _touch_status(0)  # the demo can't reach its made-up devices: they keep their made-up states
        return 200, [["content-type", "application/json"]], b'{"checked": true, "changes": []}'

    hdrs = [(k.lower().encode(), v.encode()) for k, v in headers if k.lower() not in ("cookie", "host", "origin")]
    hdrs.append((b"host", b"demo.harm"))
    if _cookies:
        hdrs.append((b"cookie", "; ".join(f"{k}={v}" for k, v in _cookies.items()).encode()))
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method, "scheme": "https",
             "path": path, "raw_path": path.encode(), "query_string": query.encode(), "root_path": "",
             "headers": hdrs, "client": ("127.0.0.1", 0), "server": ("demo.harm", 443)}
    sent = False
    out = {"status": 500, "headers": [], "body": bytearray()}

    async def receive():
        nonlocal sent
        if sent:
            await asyncio.sleep(3600)  # nothing more is coming; the app only waits here for a disconnect
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": bytes(body or b""), "more_body": False}

    async def send(msg):
        if msg["type"] == "http.response.start":
            out["status"] = msg["status"]
            out["headers"] = msg.get("headers", [])
        elif msg["type"] == "http.response.body":
            out["body"] += msg.get("body", b"")

    try:
        await main.app(scope, receive, send)
    except Exception as e:  # show it like a server error instead of breaking the page
        return 500, [["content-type", "application/json"]], json.dumps({"detail": f"Demo error: {e}"}).encode()
    _keep_cookies(out["headers"])
    keep = [[k.decode(), v.decode()] for k, v in out["headers"] if k.lower() != b"set-cookie"]
    return out["status"], keep, bytes(out["body"])


def _touch_status(minutes_ago: int) -> None:
    """Move the made-up online history so its newest check was minutes_ago, keeping the gaps."""
    conn = db.connect()
    try:
        last = conn.execute("SELECT MAX(checked_at) FROM device_status").fetchone()[0]
        if not last:
            return
        shift = conn.execute("SELECT CAST(strftime('%s', 'now') AS INTEGER) - ? * 60 - CAST(strftime('%s', ?) AS INTEGER)",
                             (minutes_ago, last)).fetchone()[0]
        mod = f"{int(shift):+d} seconds"
        conn.execute("UPDATE device_status SET checked_at = datetime(checked_at, ?), changed_at = datetime(changed_at, ?)", (mod, mod))
        conn.execute("UPDATE status_events SET at = datetime(at, ?)", (mod,))
        conn.execute("UPDATE service_status SET checked_at = datetime(checked_at, ?), changed_at = datetime(changed_at, ?), "
                     "cert_expires = date(cert_expires, ?)", (mod, mod, mod))
        conn.execute("UPDATE service_events SET at = datetime(at, ?)", (mod,))
        conn.execute("UPDATE net_seen SET first_seen = datetime(first_seen, ?), last_seen = datetime(last_seen, ?)", (mod, mod))
        nw = db.get_meta(conn, "netwatch")
        if nw:
            conf = json.loads(nw)
            for k in ("baseline_at", "last_scan"):
                if conf.get(k):
                    conf[k] = conn.execute("SELECT datetime(?, ?)", (conf[k], mod)).fetchone()[0]
            db.set_meta(conn, "netwatch", json.dumps(conf))
        conn.commit()
    finally:
        conn.close()


def snapshot() -> bytes:
    """The whole database as bytes, for the browser to keep between visits."""
    conn = db.connect()
    try:
        return conn.serialize()
    finally:
        conn.close()


async def start() -> None:
    """Open (and upgrade, if HaRM's schema changed) the demo database, then sign in."""
    db.init()
    _touch_status(1)
    t = time.time()
    status, _, body = await handle("POST", "/api/auth/login", [["content-type", "application/json"], ["x-harm", "1"]],
                                   json.dumps({"password": PASSWORD}).encode())
    if status != 200:
        raise RuntimeError(f"Demo sign-in failed ({status}): {body[:200]!r}")
    print(f"HaRM demo ready (sign-in {time.time() - t:.1f}s)")
