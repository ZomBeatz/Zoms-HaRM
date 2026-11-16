"""A terminal in HaRM's page: an SSH session to one of your machines, with a saved login.

The system `ssh` client runs on the HaRM server, in a pseudo-terminal on Linux and macOS (so
full-screen programs and resizing work), or with -tt on Windows. Its output reaches the page as
server-sent events, and keystrokes come back as small requests, so it needs nothing beyond HaRM's
own server and keeps HaRM's request checks. The password reaches ssh through the askpass helper,
like actions, never on a command line or in the page.

A terminal belongs to the sign-in that opened it: it closes when HaRM locks or signs out, after
30 minutes without typing, and when its page closes. At most a few are open at once. What's typed
and shown is never stored; opening and closing are recorded in the audit log.
"""

import codecs
import os
import secrets
import subprocess
import threading
import time

from . import remote, sshkey

MAX_OPEN = 4
IDLE = 30 * 60
KEEP = 400_000  # characters of output kept for a page that reconnects
_lock = threading.Lock()
_open: dict[str, "Session"] = {}


class TerminalError(Exception):
    pass


class Session:
    keyfile = None  # HaRM's key on disk while ssh may need it

    def __init__(self, owner: str, label: str, args: list[str], env: dict, cols: int, rows: int):
        self.id = secrets.token_urlsafe(16)
        self.owner, self.label = owner, label
        self.started = self.last_input = time.monotonic()
        self.chunks: list[tuple[int, str]] = []  # (sequence, text)
        self.seq = 0
        self.ended: str | None = None
        self.cond = threading.Condition()
        self._dec = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self.master = None
        if os.name == "nt":
            self.proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                         env=env, creationflags=remote._NO_WINDOW)
            src = self.proc.stdout
            read = lambda: src.read1(65536)  # noqa: E731
        else:
            import pty
            self.master, slave = pty.openpty()
            self._winsize(cols, rows)
            self.proc = subprocess.Popen(args, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True,
                                         close_fds=True)
            os.close(slave)
            read = lambda: os.read(self.master, 65536)  # noqa: E731
        threading.Thread(target=self._pump, args=(read,), daemon=True).start()

    def _winsize(self, cols: int, rows: int) -> None:
        if self.master is None:
            return
        import fcntl
        import struct
        import termios
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", max(2, min(rows, 500)), max(10, min(cols, 1000)), 0, 0))

    def _pump(self, read) -> None:
        while True:
            try:
                data = read()
            except OSError:
                data = b""
            if not data:
                break
            self._add(self._dec.decode(data))
        code = self.proc.wait()
        self.end("The connection closed." if code == 0 else f"The connection closed (ssh ended with code {code}).")

    def _add(self, text: str) -> None:
        if not text:
            return
        with self.cond:
            self.seq += 1
            self.chunks.append((self.seq, text))
            total = sum(len(t) for _, t in self.chunks)
            while total > KEEP and len(self.chunks) > 1:
                total -= len(self.chunks.pop(0)[1])
            self.cond.notify_all()

    def since(self, after: int, wait: float) -> tuple[list[tuple[int, str]], str | None]:
        with self.cond:
            if not self.ended and not any(s > after for s, _ in self.chunks):
                self.cond.wait(wait)
            return [c for c in self.chunks if c[0] > after], self.ended

    def write(self, text: str) -> None:
        if self.ended:
            raise TerminalError("This terminal has closed")
        self.last_input = time.monotonic()
        data = text.encode("utf-8")
        if self.master is not None:
            os.write(self.master, data)
        else:
            self.proc.stdin.write(data)
            self.proc.stdin.flush()

    def resize(self, cols: int, rows: int) -> None:
        if not self.ended:
            self._winsize(cols, rows)

    def end(self, why: str) -> None:
        with self.cond:
            if self.ended:
                return
            self.ended = why
            self.cond.notify_all()
        try:
            if self.proc.poll() is None:
                if os.name == "nt":
                    self.proc.kill()
                else:
                    os.killpg(self.proc.pid, 15)
        except OSError:
            pass
        if self.master is not None:
            try:
                os.close(self.master)
            except OSError:
                pass
        if self.keyfile:
            self.keyfile.close()
        with _lock:
            _open.pop(self.id, None)


def start(owner: str, label: str, host: str, port: int, user: str, password: str | None, cols: int, rows: int,
          legacy: bool = False, key: str | None = None) -> Session:
    if not remote.available()["ssh"]:
        raise TerminalError("The ssh client isn't installed on the HaRM server (package openssh-client)")
    try:
        remote.check_target(host, port, user)
    except remote.RemoteError as e:
        raise TerminalError(str(e))
    with _lock:
        mine = [s for s in _open.values() if not s.ended]
        if len(mine) >= MAX_OPEN:
            raise TerminalError(f"{MAX_OPEN} terminals are open already. Close one first")
    args = ["ssh", "-tt" if os.name == "nt" else "-t", "-p", str(port), "-l", user,
            "-o", "StrictHostKeyChecking=accept-new", "-o", f"UserKnownHostsFile={remote.KNOWN_HOSTS}",
            "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30", "-o", "NumberOfPasswordPrompts=1",
            *(remote.legacy_options() if legacy else [])]
    keyfile = sshkey.KeyFile(key)
    key_path = keyfile.__enter__()
    if key_path:
        args += ["-i", key_path]
    keep = ("PATH", "HOME", "USER", "LANG", "SSH_AUTH_SOCK", "SYSTEMROOT", "USERPROFILE", "USERNAME", "TEMP", "TMP", "APPDATA")
    env = {k: v for k, v in os.environ.items() if k.upper() in keep}
    env["TERM"] = "xterm-256color"
    if password:
        env.update(SSH_ASKPASS=str(remote._askpass()), SSH_ASKPASS_REQUIRE="force", HARM_SSH_PW=password)
    else:
        args += ["-o", "BatchMode=yes"]
    args += [host]
    try:
        s = Session(owner, label, args, env, cols, rows)
    except BaseException:
        keyfile.close()
        raise
    s.keyfile = keyfile  # ssh only reads it while signing in: deleted after 30 seconds, or when the terminal ends
    if key_path:
        threading.Timer(30, keyfile.close).start()
    with _lock:
        _open[s.id] = s
    return s


def get(sid: str, owner: str) -> Session:
    with _lock:
        s = _open.get(sid)
    if not s or s.owner != owner:
        raise TerminalError("That terminal has closed")
    return s


def close_owner(owner: str, why: str = "HaRM was locked, so the terminal closed.") -> None:
    with _lock:
        mine = [s for s in _open.values() if s.owner == owner]
    for s in mine:
        s.end(why)


def reap(alive) -> None:
    """Close terminals whose sign-in has ended or that nobody typed in for a while."""
    now = time.monotonic()
    with _lock:
        all_ = list(_open.values())
    for s in all_:
        if not alive(s.owner):
            s.end("HaRM was locked, so the terminal closed.")
        elif now - s.last_input > IDLE:
            s.end("Closed after 30 minutes without typing.")
