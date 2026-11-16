"""Logins in and out of HaRM: Bitwarden's (and Vaultwarden's) JSON export, and changing a
machine's password over SSH.

Bitwarden exports logins as JSON (Tools > Export vault > .json). An "encrypted" export can't be
read without Bitwarden itself, so HaRM asks for the plain one; it never stays on the server, and
each login is encrypted with your master password as soon as it's saved. HaRM's own export is the
same format, so Bitwarden and Vaultwarden can import it.
"""

import re
import shlex
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse

MAX_ITEMS = 5000


class VaultIOError(ValueError):
    pass


def _host(uri: str) -> str:
    uri = (uri or "").strip()
    if not uri:
        return ""
    u = urlparse(uri if "://" in uri else f"x://{uri}")
    return (u.hostname or "").lower()


def parse_bitwarden(data) -> list[dict]:
    """The logins in a Bitwarden JSON export: [{label, username, password, url, totp, notes, folder}]."""
    if not isinstance(data, dict) or "items" not in data:
        raise VaultIOError("That isn't a Bitwarden export. In Bitwarden: Tools > Export vault, file format .json")
    if data.get("encrypted"):
        raise VaultIOError("That export is encrypted, which only Bitwarden can read. Export again as plain .json "
                           "(not “.json (Encrypted)”), import it, then delete the file")
    folders = {f.get("id"): f.get("name") for f in data.get("folders") or [] if isinstance(f, dict)}
    out = []
    for it in (data.get("items") or [])[:MAX_ITEMS]:
        if not isinstance(it, dict) or it.get("type") != 1 or not isinstance(it.get("login"), dict):
            continue  # cards, identities and secure notes stay in Bitwarden
        lg = it["login"]
        uris = [u.get("uri") for u in lg.get("uris") or [] if isinstance(u, dict) and u.get("uri")]
        extra = [f"{f.get('name')}: {f.get('value')}" for f in it.get("fields") or []
                 if isinstance(f, dict) and f.get("name") and f.get("value") and f.get("type") != 1]
        notes = "\n".join(x for x in [it.get("notes") or "", *extra, *[f"Also: {u}" for u in uris[1:]]] if x)
        out.append({"label": str(it.get("name") or "Login")[:200], "username": str(lg.get("username") or "")[:200],
                    "password": str(lg.get("password") or ""), "url": str(uris[0] if uris else "")[:500],
                    "totp": str(lg.get("totp") or ""), "notes": notes[:10000], "folder": folders.get(it.get("folderId")) or ""})
    return out


def match_devices(items: list[dict], devices: list[dict]) -> None:
    """Suggest the device each login belongs to: its address or host name in the login's URL, or its name."""
    by_host = {}
    for d in devices:
        for ip in re.split(r"[,\s]+", d.get("ips") or ""):
            ip = ip.split("/")[0].strip().lower()
            if ip:
                by_host[ip] = d
        for n in (d.get("hostname"), d.get("name")):
            if n:
                by_host[n.lower()] = d
                by_host[n.lower().split(".")[0]] = d
    for it in items:
        h = _host(it["url"])
        d = (by_host.get(h) or by_host.get(h.split(".")[0])) if h else None
        if not d:
            words = re.findall(r"[a-z0-9-]{3,}", it["label"].lower())
            d = next((by_host[w] for w in words if w in by_host), None)
        it["device"] = {"id": d["id"], "name": d["name"]} if d else None


def to_bitwarden(creds: list[dict]) -> dict:
    """HaRM's logins as a Bitwarden JSON export (in a folder called HaRM)."""
    folder = str(uuid.uuid4())
    items = []
    for c in creds:
        notes = "\n".join(x for x in (c.get("secret_notes") or "", f"HaRM device: {c['device_name']}" if c.get("device_name") else "",
                                      f"Kind: {c['kind']}" if c.get("kind") else "") if x)
        items.append({"id": str(uuid.uuid4()), "organizationId": None, "folderId": folder, "type": 1, "reprompt": 0,
                      "name": c.get("label") or "Login", "notes": notes or None, "favorite": False,
                      "login": {"username": c.get("username") or None, "password": c.get("password") or None,
                                "totp": c.get("totp_secret") or None,
                                "uris": [{"match": None, "uri": c["url"]}] if c.get("url") else []},
                      "collectionIds": None})
    return {"encrypted": False, "folders": [{"id": folder, "name": "HaRM"}], "items": items}


# --------------------------------------------------------------------------- changing a machine's password

_USER = re.compile(r"^[a-z_][a-z0-9_.-]{0,31}\$?$", re.I)


def change_script(user: str) -> str:
    """Sets a Linux user's password with chpasswd. The new password arrives on stdin (after sudo's),
    never on a command line, and is never printed."""
    if not _USER.match(user or ""):
        raise VaultIOError("HaRM can only change the password of a Linux user name like admin or harm-check")
    return ('if [ "$(id -u)" != 0 ]; then echo HARM_NOT_ROOT; exit 4; fi\n'
            'command -v chpasswd >/dev/null 2>&1 || { echo HARM_NO_CHPASSWD; exit 5; }\n'
            f'id {shlex.quote(user)} >/dev/null 2>&1 || {{ echo HARM_NO_USER; exit 6; }}\n'
            # sudo may or may not have read its password line first: take only the marked one.
            'NEWPW=""; while IFS= read -r L; do case "$L" in HARM_NEWPW:*) NEWPW=${L#HARM_NEWPW:}; break;; esac; done\n'
            '[ -n "$NEWPW" ] || exit 7\n'
            f'printf "%s:%s\\n" {shlex.quote(user)} "$NEWPW" | chpasswd || exit 1\n'
            'echo HARM_RESULT=changed\n')


def change_input(new_password: str) -> str:
    return f"HARM_NEWPW:{new_password}\n"


def change_result(output: str) -> str | None:
    if "HARM_RESULT=changed" in output:
        return None
    for code, why in (("HARM_NOT_ROOT", "That needs root. Tick “Use sudo”, or connect with a login that can"),
                      ("HARM_NO_CHPASSWD", "This machine has no chpasswd (HaRM changes passwords on Linux only)"),
                      ("HARM_NO_USER", "There's no such user on that machine")):
        if code in output:
            return why
    return "The machine didn't change the password"


def strong_enough(pw: str) -> str | None:
    if len(pw) < 12:
        return "Use at least 12 characters"
    if "\n" in pw or "\r" in pw or ":" in pw:
        return "The password can't contain a line break or a colon"
    return None


def previous_note(old: str | None, notes: str | None) -> str:
    """Keeps the old password in the login's secret notes, in case something else still uses it."""
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    lines = [ln for ln in (notes or "").splitlines() if not ln.startswith("Previous password (until ")]
    if old:
        lines.append(f"Previous password (until {stamp}): {old}")
    return "\n".join(lines)

