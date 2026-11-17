"""VNC in HaRM's page: the noVNC viewer in the browser, relayed to the machine through HaRM.

The browser can't open a plain TCP connection, so HaRM relays it: a WebSocket from the page (over
HaRM's own https) to the VNC port on your network. Opening one takes a ticket that's good for a
minute and only for the signed-in browser that asked for it; the relay ends when HaRM locks or
signs out, and only goes to an address and VNC port of the device it was opened from. What's
on the screen is never stored.

Through SSH, HaRM signs in to the machine (with its own key or the saved login) and runs ssh -W to
the VNC port on the machine itself, so the screen is encrypted all the way, and VNC servers that
only listen on localhost work too.
"""

import asyncio
import secrets
import threading
import time

from . import remote, sshkey

MAX_OPEN = 4
TICKET_SECONDS = 60
CHUNK = 64 * 1024

_lock = threading.Lock()
_tickets: dict[str, dict] = {}
_open: dict[str, str] = {}  # relay id -> owner


class VNCError(ValueError):
    pass


def ticket(owner: str, host: str, port: int, label: str, ssh: dict | None = None) -> str:
    """ssh, for a screen through SSH: {port, user, password, key}. Kept in memory for the ticket's minute."""
    now = time.monotonic()
    with _lock:
        for t in [t for t, v in _tickets.items() if v["until"] < now]:
            del _tickets[t]
        if len(_open) >= MAX_OPEN:
            raise VNCError(f"{MAX_OPEN} screens are open already. Close one first")
        t = secrets.token_urlsafe(24)
        _tickets[t] = {"owner": owner, "host": host, "port": port, "label": label, "ssh": ssh,
                       "until": now + TICKET_SECONDS}
    return t


def take(t: str, owner: str) -> dict | None:
    """A ticket works once, before it runs out, for the browser it was made for."""
    with _lock:
        v = _tickets.pop(t or "", None)
    if not v or v["owner"] != owner or v["until"] < time.monotonic():
        return None
    return v


def count() -> int:
    with _lock:
        return len(_open)


class _Tcp:
    async def open(self, host, port):
        self.reader, self.writer = await asyncio.wait_for(asyncio.open_connection(host, port), 10)

    async def read(self):
        return await self.reader.read(CHUNK)

    async def write(self, data):
        self.writer.write(data)
        await self.writer.drain()

    def close(self):
        self.writer.close()


class _Ssh:
    """ssh -W in a thread-friendly way (works with any event loop, Windows too)."""

    def __init__(self, ssh: dict):
        self.ssh, self.p = ssh, None

    async def open(self, host, port):
        self.keyfile = sshkey.KeyFile(self.ssh.get("key"))
        path = self.keyfile.__enter__()
        try:
            self.p = await asyncio.to_thread(remote.forward, host, self.ssh["port"], self.ssh["user"],
                                             self.ssh.get("password"), path, port)
        except remote.RemoteError:
            self.keyfile.close()
            raise OSError("ssh didn't start")
        # ssh only reads the key while signing in
        asyncio.get_running_loop().call_later(30, self.keyfile.close)

    async def read(self):
        return await asyncio.to_thread(self.p.stdout.read, CHUNK)

    async def write(self, data):
        await asyncio.to_thread(self.p.stdin.write, data)

    def close(self):
        if self.p:
            self.p.kill()
            self.p.wait()
        self.keyfile.close()


async def relay(ws, v: dict, owner: str, alive) -> None:
    """Pass bytes both ways until either side closes, or HaRM locks."""
    rid = secrets.token_hex(8)
    stream = _Ssh(v["ssh"]) if v.get("ssh") else _Tcp()
    try:
        await stream.open(v["host"], v["port"])
    except (OSError, asyncio.TimeoutError):
        await ws.close(1011, "Can't reach VNC on that address")
        return
    with _lock:
        _open[rid] = owner

    async def up():
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                return
            data = msg.get("bytes")
            if data:
                await stream.write(data)

    async def down():
        while True:
            data = await stream.read()
            if not data:
                return
            await ws.send_bytes(data)

    async def guard():
        while alive(owner):
            await asyncio.sleep(3)

    async def quietly(fn):
        try:
            await fn()
        except Exception:  # noqa: BLE001  a side closing is the normal way out
            pass

    tasks = [asyncio.create_task(quietly(x)) for x in (up, down, guard)]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for x in tasks:
            x.cancel()
        with _lock:
            _open.pop(rid, None)
        stream.close()
        try:
            await ws.close()
        except Exception:  # noqa: BLE001  the browser already went
            pass
