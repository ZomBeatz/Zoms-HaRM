"""VNC in HaRM's page: the noVNC viewer in the browser, relayed to the machine through HaRM.

The browser can't open a plain TCP connection, so HaRM relays it: a WebSocket from the page (over
HaRM's own https) to the VNC port on your network. Opening one takes a ticket that's good for a
minute and only for the signed-in browser that asked for it; the relay ends when HaRM locks or
signs out, and only goes to an address and VNC port of the device it was opened from. What's
on the screen is never stored.
"""

import asyncio
import secrets
import threading
import time

MAX_OPEN = 4
TICKET_SECONDS = 60
CHUNK = 64 * 1024

_lock = threading.Lock()
_tickets: dict[str, dict] = {}
_open: dict[str, str] = {}  # relay id -> owner


class VNCError(ValueError):
    pass


def ticket(owner: str, host: str, port: int, label: str) -> str:
    now = time.monotonic()
    with _lock:
        for t in [t for t, v in _tickets.items() if v["until"] < now]:
            del _tickets[t]
        if len(_open) >= MAX_OPEN:
            raise VNCError(f"{MAX_OPEN} screens are open already. Close one first")
        t = secrets.token_urlsafe(24)
        _tickets[t] = {"owner": owner, "host": host, "port": port, "label": label, "until": now + TICKET_SECONDS}
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


async def relay(ws, host: str, port: int, owner: str, alive) -> None:
    """Pass bytes both ways until either side closes, or HaRM locks."""
    rid = secrets.token_hex(8)
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), 10)
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
                writer.write(data)
                await writer.drain()

    async def down():
        while True:
            data = await reader.read(CHUNK)
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
        writer.close()
        try:
            await ws.close()
        except Exception:  # noqa: BLE001  the browser already went
            pass
