"""Alerts: a message by ntfy, email or a webhook when a device or service stops answering, and
when it's back.

The background checker sends them, also while HaRM is locked, so their secrets (an ntfy token, the
email password, the webhook address) can't be locked with the master password like logins are.
They're encrypted with a key of their own, in alerts.key in HaRM's data folder. That file isn't in
backups: after restoring a backup on another computer, enter them again.
"""

import json
import os
import re
import smtplib
import ssl
import threading
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from urllib.parse import urlparse

from . import __version__, crypto, db

KEY_FILE = db.DB_PATH.parent / "alerts.key"
AAD = b"harm.alerts"
SECRETS = ("ntfy_token", "email_password", "webhook_url")
DELAYS = (0, 5, 10, 15, 30, 60)
SECURITY = ("starttls", "ssl", "none")
TIMEOUT = 15
BATCH = 3  # more changes than this in one check go out as one message (a power cut, a switch dying)
CERT_DAYS = 14  # a certificate alert this many days before it runs out
DEFAULTS = {"enabled": False, "delay": 5, "recovery": True, "services": True, "certs": True, "enabled_at": None,
            "quiet_on": False, "quiet_from": "22:00", "quiet_to": "07:00",
            "ntfy_on": False, "ntfy_url": "",
            "email_on": False, "email_host": "", "email_port": 587, "email_security": "starttls",
            "email_username": "", "email_from": "", "email_to": "",
            "webhook_on": False}
_EMAIL = re.compile(r"^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$")
TS = "%Y-%m-%d %H:%M:%S"
_TIME = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_held_lock = threading.Lock()


class AlertError(ValueError):
    pass


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


def config(conn) -> dict:
    try:
        saved = json.loads(db.get_meta(conn, "alerts") or "{}")
    except ValueError:
        saved = {}
    return {**DEFAULTS, **{k: v for k, v in saved.items() if k in DEFAULTS}}


def secrets(conn) -> dict:
    try:
        sealed = json.loads(db.get_meta(conn, "alerts_secrets") or "{}")
    except ValueError:
        return {}
    out = {}
    for k, v in sealed.items():
        try:
            out[k] = crypto.unseal(_key(), crypto.b64d(v), AAD + k.encode()).decode()
        except (crypto.DecryptError, OSError, ValueError):
            pass  # the key file was lost or replaced: that secret has to be entered again
    return out


def public(conn) -> dict:
    """The settings for the Settings page: never the secrets themselves, only whether each is saved."""
    sec = secrets(conn)
    return {**config(conn), **{f"has_{k}": bool(sec.get(k)) for k in SECRETS}}


def _url(v: str, what: str) -> str:
    v = (v or "").strip()
    u = urlparse(v)
    if u.scheme not in ("http", "https") or not u.netloc:
        raise AlertError(f"{what}: enter a web address starting with https:// (or http://)")
    return v


def save(conn, body: dict) -> dict:
    cur = config(conn)
    new = dict(cur)
    for k in DEFAULTS:
        if k in body and k != "enabled_at":
            new[k] = body[k]
    for k in ("enabled", "recovery", "services", "certs", "quiet_on", "ntfy_on", "email_on", "webhook_on"):
        new[k] = bool(new[k])
    try:
        new["delay"] = int(new["delay"])
        new["email_port"] = int(new["email_port"] or 587)
    except (TypeError, ValueError):
        raise AlertError("Wait and port must be numbers")
    if new["delay"] not in DELAYS:
        raise AlertError("Wait 0, 5, 10, 15, 30 or 60 minutes")
    if not 0 < new["email_port"] < 65536:
        raise AlertError("email_port: must be 1 to 65535")
    for k in ("quiet_from", "quiet_to"):
        new[k] = str(new[k] or "").strip()[:5]
        if not _TIME.match(new[k]):
            raise AlertError(f"{k}: enter a time like 22:00")
    if new["email_security"] not in SECURITY:
        raise AlertError("email_security: starttls, ssl or none")
    for k in ("ntfy_url", "email_host", "email_username", "email_from", "email_to"):
        new[k] = str(new[k] or "").strip()
    sec = secrets(conn)
    for k in SECRETS:  # an empty field keeps what's saved; "clear" removes it
        if isinstance(body.get(k), str) and body[k].strip():
            sec[k] = body[k].strip()
    for k in body.get("clear") or []:
        sec.pop(k, None)
    if new["ntfy_on"]:
        new["ntfy_url"] = _url(new["ntfy_url"], "ntfy_url")
        if not urlparse(new["ntfy_url"]).path.strip("/"):
            raise AlertError("ntfy_url: add the topic to the address, like https://ntfy.sh/my-harm-alerts")
    if new["email_on"]:
        if not new["email_host"]:
            raise AlertError("email_host: enter the mail server, like smtp.gmail.com")
        tos = [t.strip() for t in re.split(r"[,;\s]+", new["email_to"]) if t.strip()]
        if not tos or not all(_EMAIL.match(t) for t in tos):
            raise AlertError("email_to: enter the address (or addresses) to send to")
        if new["email_from"] and not _EMAIL.match(new["email_from"]):
            raise AlertError("email_from: that doesn't look like an email address")
        if not (new["email_from"] or _EMAIL.match(new["email_username"])):
            raise AlertError("email_from: enter the address the alerts come from")
    if new["webhook_on"]:
        if not sec.get("webhook_url"):
            raise AlertError("webhook_url: enter the webhook address")
        sec["webhook_url"] = _url(sec["webhook_url"], "webhook_url")
    if new["enabled"] and not (new["ntfy_on"] or new["email_on"] or new["webhook_on"]):
        raise AlertError("Turn on at least one way to send them: ntfy, email or a webhook")
    if new["enabled"] and not cur["enabled"]:
        new["enabled_at"] = datetime.now(timezone.utc).strftime(TS)  # no alerts about what was already down
    db.set_meta(conn, "alerts", json.dumps(new))
    db.set_meta(conn, "alerts_secrets", json.dumps({k: crypto.b64e(crypto.seal(_key(), v.encode(), AAD + k.encode()))
                                                    for k, v in sec.items() if v}))
    return public(conn)


# --------------------------------------------------------------------------- what's due

def _local(ts: str) -> str:
    return datetime.strptime(ts, TS).replace(tzinfo=timezone.utc).astimezone().strftime("%H:%M")


def _span(a: str, b: datetime) -> str:
    m = max(0, int((b - datetime.strptime(a, TS).replace(tzinfo=timezone.utc)).total_seconds() // 60))
    if m < 60:
        return f"{m} min" if m else "under a minute"
    if m < 48 * 60:
        return f"{m // 60} h {m % 60} min" if m % 60 else f"{m // 60} h"
    return f"{m // 1440} days"


def due(conn) -> list[dict]:
    """The alerts to send after a check, marked as sent so each goes out once."""
    from . import monitor
    conf = config(conn)
    if not conf["enabled"]:
        return []
    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(minutes=conf["delay"])).strftime(TS)
    since = conf["enabled_at"] or "0"
    names = {r["id"]: dict(r) for r in conn.execute("SELECT id, name, alerts FROM devices")}
    events = []
    main_up = {}
    for did, t in monitor.targets(conn).items():
        dev, addr = names[did], t["addresses"][0]
        st = conn.execute("SELECT * FROM device_status WHERE device_id = ? AND address = ?", (did, addr)).fetchone()
        if not st:
            continue
        main_up[did] = st["state"] == "up"
        if st["state"] == "down" and not st["alerted"] and dev["alerts"] and since <= st["changed_at"] <= cutoff:
            conn.execute("UPDATE device_status SET alerted = 1 WHERE device_id = ? AND address = ?", (did, addr))
            events.append({"kind": "device", "state": "down", "device": dev["name"], "device_id": did, "address": addr,
                           "title": f"{dev['name']} is offline",
                           "message": f"No answer from {addr} since {_local(st['changed_at'])}."})
        elif st["state"] == "up" and st["alerted"]:
            conn.execute("UPDATE device_status SET alerted = 0 WHERE device_id = ? AND address = ?", (did, addr))
            if conf["recovery"]:
                down = conn.execute("SELECT at FROM status_events WHERE device_id = ? AND address = ? AND state = 'down' "
                                    "ORDER BY at DESC, id DESC LIMIT 1", (did, addr)).fetchone()
                events.append({"kind": "device", "state": "up", "device": dev["name"], "device_id": did, "address": addr,
                               "title": f"{dev['name']} is back online",
                               "message": f"{addr} answers again" + (f", after {_span(down['at'], now)}." if down else ".")})
    if conf["services"]:
        for r in conn.execute("SELECT st.*, s.name, s.url, s.port FROM service_status st JOIN services s ON s.id = st.service_id"):
            dev = names.get(r["device_id"])
            if not dev or not main_up.get(r["device_id"]):
                continue  # the device's own alert covers it
            where = r["url"] or (f"port {r['port']}" if r["port"] else "")
            if r["state"] == "down" and not r["alerted"] and dev["alerts"] and since <= r["changed_at"] <= cutoff:
                conn.execute("UPDATE service_status SET alerted = 1 WHERE service_id = ?", (r["service_id"],))
                events.append({"kind": "service", "state": "down", "device": dev["name"], "device_id": r["device_id"],
                               "service": r["name"], "address": where,
                               "title": f"{r['name']} on {dev['name']} isn't answering",
                               "message": f"{where}: {r['detail'] or 'no answer'}, since {_local(r['changed_at'])}."})
            elif r["state"] == "up" and r["alerted"]:
                conn.execute("UPDATE service_status SET alerted = 0 WHERE service_id = ?", (r["service_id"],))
                if conf["recovery"]:
                    events.append({"kind": "service", "state": "up", "device": dev["name"], "device_id": r["device_id"],
                                   "service": r["name"], "address": where,
                                   "title": f"{r['name']} on {dev['name']} is answering again", "message": f"{where} answers again."})
    if conf["certs"]:
        soon = (now + timedelta(days=CERT_DAYS)).strftime("%Y-%m-%d")
        for r in conn.execute("SELECT st.service_id, st.cert_expires, st.cert_alerted, s.name, s.url, d.name AS device "
                              "FROM service_status st JOIN services s ON s.id = st.service_id JOIN devices d ON d.id = st.device_id "
                              "WHERE st.cert_expires IS NOT NULL AND st.cert_expires <= ?", (soon,)):
            if r["cert_alerted"] == r["cert_expires"]:
                continue
            conn.execute("UPDATE service_status SET cert_alerted = ? WHERE service_id = ?", (r["cert_expires"], r["service_id"]))
            d = datetime.strptime(r["cert_expires"], "%Y-%m-%d")
            when = f"{d:%b} {d.day}, {d.year}"
            gone = r["cert_expires"] < now.strftime("%Y-%m-%d")
            events.append({"kind": "certificate", "state": "down", "device": r["device"], "service": r["name"], "address": r["url"],
                           "title": f"The certificate for {r['name']} on {r['device']} {'ran out' if gone else 'runs out soon'}",
                           "message": f"{r['url']}: {'it ran out on' if gone else 'it runs out on'} {when}. Renew it, or browsers and apps will refuse the connection."})
    return events


# --------------------------------------------------------------------------- sending

def _post(url: str, body: bytes, headers: dict) -> None:
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"User-Agent": f"Zoms-HaRM/{__version__}", **headers})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        r.read(2000)


def _ntfy(conf, sec, title, message, urgent):
    u = urlparse(conf["ntfy_url"])
    topic = u.path.strip("/")
    body = {"topic": topic, "title": title, "message": message, "priority": 4 if urgent else 3,
            "tags": ["rotating_light" if urgent else "white_check_mark"]}
    headers = {"Content-Type": "application/json"}
    if sec.get("ntfy_token"):
        headers["Authorization"] = f"Bearer {sec['ntfy_token']}"
    _post(f"{u.scheme}://{u.netloc}/", json.dumps(body).encode(), headers)


def _email(conf, sec, title, message, _urgent):
    msg = EmailMessage()
    msg["Subject"] = title
    msg["From"] = conf["email_from"] or conf["email_username"]
    msg["To"] = ", ".join(t for t in re.split(r"[,;\s]+", conf["email_to"]) if t)
    msg.set_content(f"{message}\n\nSent by Zom's HaRM.")
    ctx = ssl.create_default_context()
    if conf["email_security"] == "ssl":
        smtp = smtplib.SMTP_SSL(conf["email_host"], conf["email_port"], timeout=TIMEOUT, context=ctx)
    else:
        smtp = smtplib.SMTP(conf["email_host"], conf["email_port"], timeout=TIMEOUT)
    with smtp:
        if conf["email_security"] == "starttls":
            smtp.starttls(context=ctx)
        if conf["email_username"]:
            smtp.login(conf["email_username"], sec.get("email_password") or "")
        smtp.send_message(msg)


def _webhook(conf, sec, title, message, urgent, extra=None):
    text = f"{title}\n{message}"
    body = {"title": title, "message": message, "text": text, "content": text,
            "state": "down" if urgent else "up", **(extra or {})}
    _post(sec["webhook_url"], json.dumps(body).encode(), {"Content-Type": "application/json"})


def _explain(e: Exception) -> str:
    if isinstance(e, urllib.error.HTTPError):
        return f"The server answered {e.code} {e.reason}" + (" (check the token)" if e.code in (401, 403) else "")
    if isinstance(e, smtplib.SMTPAuthenticationError):
        return "The mail server refused the username or password"
    if isinstance(e, urllib.error.URLError):
        return f"Couldn't reach it: {e.reason}"
    return str(e) or e.__class__.__name__


def send(title: str, message: str, urgent: bool = True, extra: dict | None = None, only: str | None = None) -> list[dict]:
    """Send one message on every channel that's on (or only one). Each attempt goes in the log."""
    conn = db.connect()
    try:
        conf, sec = config(conn), secrets(conn)
        results = []
        for name, on, fn in (("ntfy", conf["ntfy_on"], _ntfy), ("email", conf["email_on"], _email),
                             ("webhook", conf["webhook_on"] and sec.get("webhook_url"), _webhook)):
            if not on or (only and only != name):
                continue
            try:
                fn(conf, sec, title, message, urgent, extra) if fn is _webhook else fn(conf, sec, title, message, urgent)
                results.append({"channel": name, "ok": True})
            except Exception as e:  # report every failure; never take the checker down
                results.append({"channel": name, "ok": False, "error": _explain(e)[:300]})
        for r in results:
            conn.execute("INSERT INTO alert_log (channel, title, ok, error) VALUES (?,?,?,?)",
                         (r["channel"], title, int(r["ok"]), r.get("error")))
        conn.execute("DELETE FROM alert_log WHERE id NOT IN (SELECT id FROM alert_log ORDER BY id DESC LIMIT 200)")
        conn.commit()
        return results
    finally:
        conn.close()


def in_quiet_hours(conf: dict, now: datetime | None = None) -> bool:
    if not conf.get("quiet_on"):
        return False
    t = (now or datetime.now().astimezone()).strftime("%H:%M")
    a, b = conf["quiet_from"], conf["quiet_to"]
    return a <= t < b if a < b else (t >= a or t < b)


def _held(conn) -> list:
    try:
        return json.loads(db.get_meta(conn, "alerts_held") or "[]")
    except ValueError:
        return []


def deliver(events: list[dict]) -> None:
    """Send alerts: held during quiet hours (then sent together), one message each, or one message
    together when a lot changed at once."""
    with _held_lock:
        conn = db.connect()
        try:
            conf = config(conn)
            held = _held(conn)
            if in_quiet_hours(conf):
                if events:
                    db.set_meta(conn, "alerts_held", json.dumps((held + events)[-200:]))
                    conn.commit()
                return
            if held:
                db.set_meta(conn, "alerts_held", None)
                conn.commit()
        finally:
            conn.close()
    if held:
        lines = "\n".join(f"• {e['title']}" for e in held + events)
        downs = sum(1 for e in held + events if e["state"] != "up")
        send(f"HaRM: {len(held) + len(events)} alert{'s' if len(held) + len(events) != 1 else ''} from quiet hours",
             lines, downs > 0, {"kind": "summary", "count": len(held) + len(events)})
        return
    _send_events(events)


def flush_held() -> None:
    """After quiet hours end, send what was held (called by the background checker)."""
    conn = db.connect()
    try:
        waiting = bool(_held(conn)) and not in_quiet_hours(config(conn))
    finally:
        conn.close()
    if waiting:
        deliver([])


def _send_events(events: list[dict]) -> None:
    if len(events) <= BATCH:
        for e in events:
            send(e["title"], e["message"], e["state"] != "up",
                 {k: e.get(k) for k in ("kind", "device", "service", "address")})
        return
    downs = sum(1 for e in events if e["state"] != "up")
    ups = len(events) - downs
    title = ", ".join(p for p in (f"{downs} problem{'s' if downs != 1 else ''}" if downs else "", f"{ups} back" if ups else "") if p)
    send(f"HaRM: {title}", "\n".join(f"• {e['title']}" for e in events), downs > 0, {"kind": "summary", "count": len(events)})


def recent(conn, limit: int = 8) -> list[dict]:
    return [dict(r) for r in conn.execute("SELECT * FROM alert_log ORDER BY id DESC LIMIT ?", (limit,))]
