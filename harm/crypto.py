"""Key derivation and authenticated encryption for the HaRM vault.

Design:
  * A random 256-bit data encryption key (DEK) encrypts every secret field
    with AES-256-GCM.
  * The DEK is never stored in plaintext. It is wrapped twice: once with a key
    derived from the master password and once with a key derived from the
    one-time recovery code (scrypt for both).
  * The same scrypt output also yields an auth key; only its SHA-256 digest is
    stored, so the password can be verified without holding the DEK.
"""

import base64
import hashlib
import hmac
import os
import secrets

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

KDF_PARAMS = {"n": 2**16, "r": 8, "p": 1}
_MAXMEM = 256 * 1024 * 1024


class DecryptError(Exception):
    pass


def b64e(b: bytes) -> str:
    return base64.b64encode(b).decode()


def b64d(s: str) -> bytes:
    return base64.b64decode(s)


def derive(secret: str, salt: bytes, params: dict = KDF_PARAMS) -> tuple[bytes, bytes]:
    """Return (key-encryption key, auth key) for a password or recovery code."""
    raw = hashlib.scrypt(
        secret.encode(), salt=salt, n=params["n"], r=params["r"], p=params["p"],
        maxmem=_MAXMEM, dklen=64,
    )
    return raw[:32], raw[32:]


def seal(key: bytes, plaintext: bytes, aad: bytes) -> bytes:
    nonce = os.urandom(12)
    return nonce + AESGCM(key).encrypt(nonce, plaintext, aad)


def unseal(key: bytes, blob: bytes, aad: bytes) -> bytes:
    try:
        return AESGCM(key).decrypt(blob[:12], blob[12:], aad)
    except (InvalidTag, ValueError) as e:
        raise DecryptError from e


def wrap_dek(secret: str, dek: bytes, purpose: str) -> dict:
    """Wrap the DEK under a password/recovery code. Returns a JSON-able record."""
    salt = os.urandom(16)
    kek, auth = derive(secret, salt)
    return {
        "salt": b64e(salt),
        "kdf": KDF_PARAMS,
        "auth": b64e(hashlib.sha256(auth).digest()),
        "wrapped": b64e(seal(kek, dek, f"harm-dek:{purpose}".encode())),
    }


def unwrap_dek(secret: str, record: dict, purpose: str) -> bytes | None:
    """Return the DEK if `secret` is correct, else None."""
    kek, auth = derive(secret, b64d(record["salt"]), record["kdf"])
    if not hmac.compare_digest(hashlib.sha256(auth).digest(), b64d(record["auth"])):
        return None
    try:
        return unseal(kek, b64d(record["wrapped"]), f"harm-dek:{purpose}".encode())
    except DecryptError:
        return None


def new_dek() -> bytes:
    return os.urandom(32)


_RC_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def new_recovery_code() -> str:
    raw = "".join(secrets.choice(_RC_ALPHABET) for _ in range(30))
    return "-".join(raw[i:i + 5] for i in range(0, 30, 5))


def normalize_recovery_code(code: str) -> str:
    raw = "".join(ch for ch in code.upper() if ch.isalnum())
    return "-".join(raw[i:i + 5] for i in range(0, len(raw), 5))
