"""HaRM's own SSH key: one key pair for this HaRM, so machines can let it in without a password.

The private key is encrypted with the master key, like your logins, so HaRM can only use it while
unlocked. Background checks get their own copy only when you choose that (sealed with
background.key, see upkeep). For each connection it's written to a file only ssh can read and
deleted straight after. The public key goes into a machine's ~/.ssh/authorized_keys with one
click, and comes out again the same way.
"""

import json
import os
import shlex
import uuid
from datetime import datetime, timezone

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from . import crypto, db, remote

META = "ssh_key"
AAD = b"harm.ssh_key"


def generate(comment: str) -> tuple[str, str]:
    """A new ed25519 key pair: (private key in OpenSSH format, public key line)."""
    k = Ed25519PrivateKey.generate()
    priv = k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.OpenSSH,
                           serialization.NoEncryption()).decode()
    pub = k.public_key().public_bytes(serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH).decode()
    return priv, f"{pub} {comment}"


def _load(conn) -> dict | None:
    try:
        return json.loads(db.get_meta(conn, META) or "null")
    except ValueError:
        return None


def info(conn) -> dict | None:
    v = _load(conn)
    return {"public": v["pub"], "created": v["at"]} if v else None


def public(conn) -> str | None:
    v = _load(conn)
    return v["pub"] if v else None


def save(conn, dek: bytes, priv: str, pub: str, places: dict | None = None) -> None:
    """A new key starts with no places: machines only have the key it replaced."""
    db.set_meta(conn, META, json.dumps({"pub": pub, "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                                        "priv": crypto.b64e(crypto.seal(dek, priv.encode(), AAD)),
                                        "places": places or {}}))


def _place(did: int, user: str, host: str, port: int) -> str:
    return f"{did}|{user}@{host}:{port}"


def places(conn) -> dict:
    """Where this key was added: "device|user@host:port" -> when."""
    v = _load(conn)
    return (v or {}).get("places") or {}


def mark(conn, did: int, user: str, host: str, port: int, added: bool) -> None:
    v = _load(conn)
    if not v:
        return
    at = v.setdefault("places", {})
    if added:
        at[_place(did, user, host, port)] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    else:
        at.pop(_place(did, user, host, port), None)
    db.set_meta(conn, META, json.dumps(v))


def has(conn, did: int, user: str, host: str, port: int) -> str | None:
    return places(conn).get(_place(did, user, host, port))


def private(conn, dek: bytes | None) -> str | None:
    v = _load(conn)
    if not v or not dek:
        return None
    try:
        return crypto.unseal(dek, crypto.b64d(v["priv"]), AAD).decode()
    except (crypto.DecryptError, ValueError, KeyError):
        return None


def remove(conn) -> None:
    db.set_meta(conn, META, None)


def rewrap(conn, old: bytes, new: bytes) -> None:
    """After the master key changes (a new master password keeps the same key, so this is rarely needed)."""
    priv = private(conn, old)
    if priv:
        save(conn, new, priv, public(conn), places(conn))


# --------------------------------------------------------------------------- the key on disk, briefly

class KeyFile:
    """The private key in a file only this user can read, for one ssh run. Deleted on exit."""

    def __init__(self, priv: str | None):
        self.priv, self.path = priv, None

    def __enter__(self) -> str | None:
        if not self.priv:
            return None
        remote.SSH_DIR.mkdir(mode=0o700, exist_ok=True)
        self.path = remote.SSH_DIR / f"key-{uuid.uuid4().hex}"
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", newline="\n") as f:
            f.write(self.priv if self.priv.endswith("\n") else self.priv + "\n")
        return str(self.path)

    def __exit__(self, *exc) -> None:
        self.close()

    def close(self) -> None:
        if self.path:
            try:
                self.path.unlink()
            except OSError:
                pass
            self.path = None


def sweep() -> None:
    """Delete key files left behind if HaRM stopped mid-connection."""
    try:
        for p in remote.SSH_DIR.glob("key-*"):
            p.unlink()
    except OSError:
        pass


# --------------------------------------------------------------------------- on the machine

def _check(pub: str) -> str:
    if not pub or "\n" in pub or not pub.startswith("ssh-ed25519 "):
        raise ValueError("That isn't HaRM's key")
    return pub


def install_script(pub: str) -> str:
    """Adds the key to the login user's authorized_keys, once. Changes nothing else."""
    q = shlex.quote(_check(pub))
    return ("umask 077\n"
            'mkdir -p "$HOME/.ssh" && touch "$HOME/.ssh/authorized_keys" || exit 1\n'
            f'grep -qxF {q} "$HOME/.ssh/authorized_keys" || printf "%s\\n" {q} >> "$HOME/.ssh/authorized_keys" || exit 1\n'
            "echo HARM_RESULT=added\n")


def remove_script(pub: str) -> str:
    """Takes the key out of the login user's authorized_keys again, keeping every other line."""
    q = shlex.quote(_check(pub))
    return ('F="$HOME/.ssh/authorized_keys"; [ -f "$F" ] || { echo HARM_RESULT=removed; exit 0; }\n'
            'T=$(mktemp "$F.XXXXXX") || exit 1\n'
            f'grep -vxF {q} "$F" > "$T"; cat "$T" > "$F"; rm -f "$T"\n'
            "echo HARM_RESULT=removed\n")
