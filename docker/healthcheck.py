"""Docker HEALTHCHECK: is HaRM answering? (HTTPS with HaRM's own certificate, or plain HTTP.)"""
import os
import ssl
import sys
import urllib.request

scheme = "https" if os.environ.get("HARM_TLS", "1") == "1" else "http"
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE  # local loopback check only
try:
    with urllib.request.urlopen(f"{scheme}://127.0.0.1:{os.environ.get('HARM_PORT', '8077')}/api/auth/status", context=ctx, timeout=5) as r:
        sys.exit(0 if r.status == 200 else 1)
except Exception:
    sys.exit(1)
