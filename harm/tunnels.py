"""A machine's web page through SSH (🔌 Connect > 🌐 Web page through SSH).

Admin pages often only listen on the machine itself (Cockpit, a database admin, a router behind it).
HaRM signs in over SSH with one connection (ssh -N -L) and opens a port of its own for a while, so
the page opens in a new tab at https://<HaRM's address>:<that port>/. Only the browser that opened
it can connect (its IP address), with HaRM's own HTTPS certificate; the rest of the way is inside
SSH. It closes when HaRM locks, after 30 minutes unused, or with Close. At most 4 are open.

The ports come from HARM_TUNNEL_PORTS (8078-8087 unless set), so Docker can publish them.
"""

import asyncio
import os
import secrets
import socket
import ssl
import subprocess
import threading
import time

from . import certs, remote, sshkey

MAX_OPEN = 4
IDLE = 30 * 60
CHUNK = 64 * 1024

_lock = threading.Lock()
_open: dict[str, "Tunnel"] = {}


class TunnelError(Exception):
    def __init__(self, msg: str, code: str = "error"):
        super().__init__(msg)
        self.code = code


def port_range() -> range:
    raw = os.environ.get("HARM_TUNNEL_PORTS", "8078-8087")
    try:
        a, _, b = raw.partition("-")
        lo, hi = int(a), int(b or a)
        if 0 < lo <= hi < 65536:
            return range(lo, hi + 1)
    except ValueError:
        pass
    return range(8078, 8088)


def _free_local_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _tls() -> ssl.SSLContext | None:
    if not (certs.CRT.exists() and certs.KEY.exists()):
        return None
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ctx.load_cert_chain(str(certs.CRT), str(certs.KEY))
    return ctx


def _to_https() -> ssl.SSLContext:
    """To the page's own HTTPS: its certificate is the machine's own (usually self-signed), and the
    connection to it already runs inside SSH, so it isn't checked."""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


class Tunnel:
    def __init__(self, owner: str, client: str, label: str, device_id: int, target: str, tport: int, https: bool):
        self.id = secrets.token_urlsafe(9)
        self.owner, self.client, self.label, self.device_id = owner, client, label, device_id
        self.target, self.tport, self.https = target, tport, https
        self.port = 0
        self.secure = False
        self.local = _free_local_port()
        self.last_used = time.monotonic()
        self.opened = time.time()
        self.conns = 0
        self.p: subprocess.Popen | None = None
        self.server: asyncio.base_events.Server | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.ended = ""

    def info(self) -> dict:
        return {"id": self.id, "label": self.label, "device_id": self.device_id, "port": self.port,
                "scheme": "https" if self.secure else "http", "target": f"{self.target}:{self.tport}",
                "https": self.https, "opened": self.opened}

    def start_ssh(self, host: str, port: int, user: str, password: str | None, key: str | None) -> None:
        """Sign in and forward a local port on this computer to the page. Waits until it works."""
        with sshkey.KeyFile(key) as key_path:
            args, env = remote._ssh_args(port, user, password, ["-N", "-o", "ExitOnForwardFailure=yes"], key_path)
            args += ["-L", f"127.0.0.1:{self.local}:{self.target}:{self.tport}", host]
            try:
                self.p = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                          env=env, start_new_session=True, creationflags=remote._NO_WINDOW)
            except OSError as e:
                raise TunnelError(f"Could not start ssh: {e}")
            until = time.monotonic() + 25
            while time.monotonic() < until:
                if self.p.poll() is not None:
                    err = self.p.stderr.read().decode(errors="replace")
                    raise TunnelError(str(remote._explain(subprocess.CompletedProcess(args, self.p.returncode, "", err),
                                                          "The connection")),
                                      "hostkey" if "host key" in err.lower() or "identification has changed" in err.lower() else "ssh")
                try:
                    socket.create_connection(("127.0.0.1", self.local), 0.5).close()
                    return
                except OSError:
                    time.sleep(0.2)
            self.stop_ssh()
            raise TunnelError("The machine didn't answer in time")

    def check_page(self) -> None:
        """A connection through the tunnel reaches the page (ssh only says so once one is opened)."""
        with socket.create_connection(("127.0.0.1", self.local), 5) as s:
            s.settimeout(0.6)
            try:
                if s.recv(1) == b"":
                    raise TunnelError(f"SSH works, but nothing answers on port {self.tport} at {self.target} "
                                      "(seen from the machine). Is the page running there?", "page")
            except (socket.timeout, TimeoutError):
                pass  # open and waiting for the browser to speak first: that's a web server

    def stop_ssh(self) -> None:
        if self.p and self.p.poll() is None:
            self.p.kill()
            try:
                self.p.wait(5)
            except subprocess.TimeoutExpired:
                pass

    async def listen(self, bind: str) -> None:
        ctx = _tls()
        self.secure = ctx is not None
        with _lock:
            used = {t.port for t in _open.values()}
        for port in port_range():
            if port in used:
                continue
            try:
                self.server = await asyncio.start_server(self._handle, bind, port, ssl=ctx)
                self.loop = asyncio.get_running_loop()
                self.port = port
                return
            except OSError:
                continue
        raise TunnelError(f"No free port for it: HaRM uses ports {port_range().start} to {port_range().stop - 1} "
                          "(HARM_TUNNEL_PORTS). Close a web page you opened, or free one")

    async def _handle(self, reader, writer) -> None:
        peer = (writer.get_extra_info("peername") or ("",))[0]
        if peer.removeprefix("::ffff:") != self.client.removeprefix("::ffff:") or self.ended:
            writer.close()
            return
        self.last_used = time.monotonic()
        try:
            r2, w2 = await asyncio.wait_for(asyncio.open_connection(
                "127.0.0.1", self.local, ssl=_to_https() if self.https else None,
                server_hostname=self.target if self.https else None), 15)
        except (OSError, asyncio.TimeoutError, ssl.SSLError):
            writer.close()
            return
        self.conns += 1

        async def pipe(src, dst):
            try:
                while data := await src.read(CHUNK):
                    self.last_used = time.monotonic()
                    dst.write(data)
                    await dst.drain()
            except (OSError, ssl.SSLError, asyncio.IncompleteReadError):
                pass
            finally:
                try:
                    dst.close()
                except Exception:  # noqa: BLE001  already gone
                    pass

        try:
            await asyncio.gather(pipe(reader, w2), pipe(r2, writer))
        finally:
            self.conns -= 1

    def end(self, why: str) -> None:
        if self.ended:
            return
        self.ended = why or "Closed"
        if self.server and self.loop:
            self.loop.call_soon_threadsafe(self.server.close)  # end() may come from another thread (logout)
        self.stop_ssh()
        with _lock:
            _open.pop(self.id, None)


async def open_tunnel(owner: str, client: str, bind: str, label: str, device_id: int, host: str, port: int,
                      user: str, password: str | None, key: str | None, target: str, tport: int, https: bool) -> Tunnel:
    if not remote.available()["ssh"]:
        raise TunnelError("The ssh client isn't installed on the HaRM server (package openssh-client)")
    try:
        remote.check_target(host, port, user)
        remote.check_target(target, tport, user)
    except remote.RemoteError as e:
        raise TunnelError(str(e))
    with _lock:
        if len(_open) >= MAX_OPEN:
            raise TunnelError(f"{MAX_OPEN} web pages are open through SSH already. Close one first")
    t = Tunnel(owner, client, label, device_id, target, tport, https)
    await asyncio.to_thread(t.start_ssh, host, port, user, password, key)
    try:
        await asyncio.to_thread(t.check_page)
        await t.listen(bind)
    except BaseException:
        t.stop_ssh()
        raise
    with _lock:
        _open[t.id] = t
    return t


def mine(owner: str) -> list[Tunnel]:
    with _lock:
        return [t for t in _open.values() if t.owner == owner]


def close(tid: str, owner: str) -> Tunnel | None:
    with _lock:
        t = _open.get(tid)
    if not t or t.owner != owner:
        return None
    t.end("Closed")
    return t


def close_owner(owner: str) -> None:
    for t in mine(owner):
        t.end("HaRM was locked")


def close_all() -> None:
    """When HaRM stops: its ssh connections would outlive it otherwise (they run in their own session)."""
    with _lock:
        all_ = list(_open.values())
    for t in all_:
        t.end("HaRM stopped")


def reap(alive) -> None:
    now = time.monotonic()
    with _lock:
        all_ = list(_open.values())
    for t in all_:
        if not alive(t.owner):
            t.end("HaRM was locked")
        elif t.p and t.p.poll() is not None:
            t.end("The SSH connection closed")
        elif not t.conns and now - t.last_used > IDLE:
            t.end("Closed after 30 minutes unused")


_started = False


def start_reaper(alive) -> None:
    global _started
    if _started:
        return
    _started = True

    async def loop():
        while True:
            await asyncio.sleep(20)
            try:
                reap(alive)
            except Exception:  # noqa: BLE001  keep reaping
                pass

    asyncio.get_running_loop().create_task(loop())
