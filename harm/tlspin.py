"""HTTPS to boxes with self-signed certificates (Proxmox, UniFi), pinned on first use.

Their certificates can't be checked against a certificate authority, so without a pin anyone on
the network could pose as them and catch the token. HaRM remembers the certificate's SHA-256
fingerprint the first time it connects (like SSH host keys) and refuses a different one until
you say it's expected. The check happens on the same connection the token is sent over.
"""

import hashlib
import http.client
import ssl
import urllib.request


class PinMismatch(Exception):
    def __init__(self, seen: str):
        super().__init__("certificate changed")
        self.seen = seen


def opener(verify: bool, pin: str | None, *handlers):
    """An opener, and a dict that holds the fingerprint seen ("fp") once it has connected."""
    ctx = ssl.create_default_context()
    if not verify:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    seen: dict = {}

    class Conn(http.client.HTTPSConnection):
        def connect(self):
            super().connect()
            fp = hashlib.sha256(self.sock.getpeercert(binary_form=True) or b"").hexdigest()
            seen["fp"] = fp
            if pin and not verify and fp != pin:
                self.sock.close()
                raise PinMismatch(fp)

    class Handler(urllib.request.HTTPSHandler):
        def https_open(self, req):
            return self.do_open(Conn, req, context=ctx)

    return urllib.request.build_opener(*handlers, Handler(context=ctx)), seen


def pretty(fp: str) -> str:
    return ":".join(fp[i:i + 2] for i in range(0, min(len(fp), 32), 2)).upper() + "…" if fp else ""
