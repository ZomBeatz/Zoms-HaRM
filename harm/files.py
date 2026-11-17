"""Files on a machine, in HaRM's page: browse, upload, download, edit, and run a command in a folder.

One SSH connection per open file browser, like the terminal: ssh runs `sh` on the machine and HaRM
sends it small scripts. Each answer comes back framed and base64-encoded, so file contents (and
whatever a command prints) can't be mistaken for HaRM's markers. It only works while HaRM is
unlocked, closes when HaRM locks or after 30 minutes unused, and at most 4 are open.

"Use sudo" runs an operation as root: the login's password is set once as a shell variable on the
machine (sent inside the encrypted connection, never on a command line) and handed to sudo -S.
"""

import base64
import io
import secrets
import shlex
import subprocess
import threading
import time

from . import remote, sshkey

MAX_OPEN = 4
IDLE = 30 * 60
UPLOAD_CHUNK = 1024 * 1024  # bytes handed to the upload connection at a time
TEXT_MAX = 1024 * 1024
LIST_MAX = 5000
RUN_SECONDS = 120

_lock = threading.Lock()
_open: dict[str, "Session"] = {}


class FilesError(Exception):
    def __init__(self, msg: str, code: str = "error"):
        super().__init__(msg)
        self.code = code


q = shlex.quote


# The listing: python3 where there is one (nearly everywhere), else GNU find. One NUL-ended record per
# entry: type, target type (for links), size, modified, mode, owner, group, name, link target.
_LIST_PY = r'''
import os, stat, sys
try:
    import grp, pwd
except ImportError:
    grp = pwd = None
def nm(f, i):
    try:
        return f(i)[0]
    except Exception:
        return str(i)
out = sys.stdout.buffer
n = 0
for e in os.scandir("."):
    try:
        st = e.stat(follow_symlinks=False)
    except OSError:
        continue
    m = st.st_mode
    t = "d" if stat.S_ISDIR(m) else "l" if stat.S_ISLNK(m) else "f" if stat.S_ISREG(m) else "o"
    to, link = t, b""
    if t == "l":
        try:
            link = os.fsencode(os.readlink(e.name))
            to = "d" if os.path.isdir(e.name) else "f"
        except OSError:
            to = "N"
    u = nm(pwd.getpwuid, st.st_uid) if pwd else str(st.st_uid)
    g = nm(grp.getgrgid, st.st_gid) if grp else str(st.st_gid)
    out.write(f"{t}\t{to}\t{st.st_size}\t{int(st.st_mtime)}\t{stat.S_IMODE(m):o}\t{u}\t{g}\t".encode()
              + os.fsencode(e.name) + b"\t" + link + b"\0")
    n += 1
    if n >= LIMIT:
        break
'''


def _list_script(path: str) -> str:
    py = _LIST_PY.replace("LIMIT", str(LIST_MAX))
    return (f"cd -- {q(path)} || exit 3\npwd -P\n"
            "if command -v python3 >/dev/null 2>&1; then python3 -c " + q(py) + "\n"
            "else find . -mindepth 1 -maxdepth 1 -printf '%y\\t%Y\\t%s\\t%T@\\t%m\\t%u\\t%g\\t%f\\t%l\\0' | head -c 20000000; fi\n")


def _parse_list(raw: bytes) -> tuple[str, list[dict]]:
    head, _, body = raw.partition(b"\n")
    out = []
    for rec in body.split(b"\0"):
        parts = rec.split(b"\t")
        if len(parts) < 9:
            continue
        t, to, size, mtime, mode, user, group = (p.decode(errors="replace") for p in parts[:7])
        name = b"\t".join(parts[7:-1]).decode(errors="replace")
        if name in (".", ".."):
            continue
        t = {"d": "d", "f": "f", "l": "l"}.get(t, "o")
        out.append({"name": name, "type": t, "to": {"d": "d", "f": "f"}.get(to, "") if t == "l" else t,
                    "size": int(size or 0), "mtime": int(float(mtime or 0)), "mode": mode, "owner": user,
                    "group": group, "link": parts[-1].decode(errors="replace")})
    return head.decode(errors="replace").strip(), out


class Session:
    def __init__(self, owner: str, label: str, host: str, port: int, user: str, password: str | None,
                 key: str | None, legacy: bool = False):
        self.id = secrets.token_urlsafe(12)
        self.owner, self.label, self.user = owner, label, user
        self._login = (host, port, user, password, key, legacy)  # for upload connections, while open
        self.has_password = bool(password)
        self.tok = "HARM" + secrets.token_hex(8)
        self.lock = threading.Lock()
        self.last_used = time.monotonic()
        self.ended = ""
        self.keyfile = sshkey.KeyFile(key)
        key_path = self.keyfile.__enter__()
        args, env = remote._ssh_args(port, user, password, remote.legacy_options() if legacy else [], key_path)
        args += [host, "sh"]
        try:
            self.p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      bufsize=0, env=env, start_new_session=True, creationflags=remote._NO_WINDOW)
        except OSError as e:
            self.keyfile.close()
            raise FilesError(f"Could not start ssh: {e}")
        self.out = io.BufferedReader(self.p.stdout, 65536)
        self.err = b""
        threading.Thread(target=self._drain_err, daemon=True).start()
        threading.Timer(30, self.keyfile.close).start()  # ssh only reads it while signing in
        pw = f"HARM_PW={q(password)}\n" if password else "HARM_PW=\n"
        self._send(pw + "HARM_E=$(mktemp) && HARM_R=$(mktemp) || exit 1\n"
                   "trap 'rm -f \"$HARM_E\" \"$HARM_R\"' EXIT\n"
                   "harm_sudo() { if [ -n \"$HARM_PW\" ]; then printf '%s\\n' \"$HARM_PW\" | sudo -S -p '' \"$@\"; "
                   "else sudo -n \"$@\"; fi; }\ncd 2>/dev/null\n")
        try:
            self.home = self.run("pwd -P", timeout=30)[0].decode(errors="replace").strip() or "/"
        except FilesError as e:
            self.end("")
            raise FilesError(self._why(str(e)), "hostkey" if "host key" in self._why(str(e)) else "connect")

    def _drain_err(self) -> None:
        for chunk in iter(lambda: self.p.stderr.read(4096), b""):
            self.err = (self.err + chunk)[-4096:]

    def _why(self, fallback: str) -> str:
        """ssh's own reason, worded like the rest of HaRM, when it didn't connect."""
        time.sleep(0.2)
        err = self.err.decode(errors="replace")
        if not err.strip():
            return fallback
        return str(remote._explain(subprocess.CompletedProcess([], 255, "", err), "The connection"))

    def _send(self, text: str) -> None:
        try:
            self.p.stdin.write(text.encode())
        except (BrokenPipeError, OSError, ValueError):
            raise FilesError("The connection to the machine closed")

    def run(self, script: str, sudo: bool = False, timeout: float | None = 120, sink=None) -> tuple[bytes, bytes, int]:
        """Run a script on the machine: (stdout, stderr, exit code). With sink, stdout goes to it in pieces."""
        if self.ended:
            raise FilesError(self.ended or "This file browser has closed")
        if sudo:
            script = "harm_sudo sh -c " + q(script)
        t = self.tok
        with self.lock:
            self.last_used = time.monotonic()
            self._send(f"printf '\\n%s START\\n' {t}\n"
                       f"{{ ( {script}\n) </dev/null 2>\"$HARM_E\"; echo $? > \"$HARM_R\"; }} | base64\n"
                       f"printf '%s ERR\\n' {t}; head -c 65536 \"$HARM_E\" | base64\n"
                       f"printf '%s END %s\\n' {t} \"$(cat \"$HARM_R\")\"\n")
            timer = threading.Timer(timeout, self.end, ("The machine took too long to answer, so the file browser closed.",)) if timeout else None
            if timer:
                timer.start()
            try:
                out, err, part = [], [], "pre"
                while True:
                    line = self.out.readline()
                    if not line:
                        raise FilesError(self.ended or "The connection to the machine closed")
                    s = line.strip()
                    if s == f"{t} START".encode():
                        part = "out"
                    elif s == f"{t} ERR".encode():
                        part = "err"
                    elif s.startswith(f"{t} END".encode()):
                        rc = s.split()[-1]
                        code = int(rc) if rc.isdigit() else 1
                        break
                    elif part == "out" and s:
                        data = base64.b64decode(s)
                        if sink:
                            sink(data)
                        else:
                            out.append(data)
                    elif part == "err" and s:
                        err.append(base64.b64decode(s))
            finally:
                if timer:
                    timer.cancel()
            self.last_used = time.monotonic()
        return b"".join(out), b"".join(err), code

    def check(self, err: bytes, code: int, what: str) -> None:
        if code == 0:
            return
        text = err.decode(errors="replace").strip()
        low = text.lower()
        if "sorry, try again" in low or "incorrect password" in low or "a password is required" in low:
            raise FilesError("sudo refused: this login can't use sudo, or needs its password saved in HaRM", "sudo")
        if "permission denied" in low or "operation not permitted" in low:
            raise FilesError(f"{what}: permission denied. Tick “Use sudo” to do it as root", "denied")
        if "no such file" in low:
            raise FilesError(f"{what}: that file or folder isn’t there", "missing")
        raise FilesError(f"{what} failed: {(text.splitlines() or [f'exit code {code}'])[-1][:300]}")

    # ------------------------------------------------------------------ operations

    def listdir(self, path: str, sudo: bool = False) -> dict:
        out, err, code = self.run(_list_script(path or self.home), sudo)
        if code == 3:
            raise FilesError("That folder can't be opened" + ("" if sudo else ". Tick “Use sudo” if only root can read it"), "missing")
        self.check(err, code, "Reading the folder")
        where, entries = _parse_list(out)
        return {"path": where or path, "entries": entries, "cut": len(entries) >= LIST_MAX}

    def read_text(self, path: str, sudo: bool = False) -> str:
        out, err, code = self.run(f"head -c {TEXT_MAX + 1} -- {q(path)}", sudo)
        self.check(err, code, "Opening the file")
        if len(out) > TEXT_MAX:
            raise FilesError("That file is over 1 MB: download it instead", "big")
        if b"\0" in out:
            raise FilesError("That isn't a text file: download it instead", "binary")
        return out.decode("utf-8", errors="replace")

    def download(self, path: str, sink, sudo: bool = False) -> None:
        _, err, code = self.run(f"cat -- {q(path)}", sudo, timeout=None, sink=sink)
        self.check(err, code, "Downloading")

    def _receive(self, part: str, chunks) -> int:
        """A second SSH connection that writes what it's sent to `part` (the shell reads its own input a
        byte at a time, so file contents don't go through it). The path travels base64-encoded, so any
        login shell (bash, zsh, fish…) passes it on untouched."""
        if self.ended:
            raise FilesError(self.ended)
        host, port, user, password, key, legacy = self._login
        b64 = base64.b64encode(part.encode()).decode()
        inner = f'P=$(printf %s {b64} | base64 -d) && cat > "$P"'
        size = 0
        with sshkey.KeyFile(key) as key_path:
            args, env = remote._ssh_args(port, user, password, remote.legacy_options() if legacy else [], key_path)
            try:
                p = subprocess.Popen(args + [host, "sh -c " + q(inner)], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.PIPE, env=env, start_new_session=True, creationflags=remote._NO_WINDOW)
            except OSError as e:
                raise FilesError(f"Could not start ssh: {e}")
            try:
                for data in chunks:
                    p.stdin.write(data)
                    size += len(data)
                    self.last_used = time.monotonic()
                p.stdin.close()
            except (BrokenPipeError, OSError):
                pass  # it stopped: its reason is on stderr
            err = p.stderr.read()
            code = p.wait()
        self.check(err, code, "Uploading")
        return size

    def upload(self, path: str, chunks, sudo: bool = False) -> int:
        """Write the file beside it (or to a temporary file, with sudo), then put it in place."""
        part = f"{path}.harm-part-{secrets.token_hex(4)}"
        if sudo:
            out, err, code = self.run("mktemp")
            self.check(err, code, "Uploading")
            part = out.decode().strip()
        try:
            size = self._receive(part, chunks)
            # Copying onto a file that's there keeps its owner and permissions (a script stays executable).
            if sudo:
                _, err, code = self.run(f"cp -- {q(part)} {q(path)}", True)
            else:
                _, err, code = self.run(f"if [ -e {q(path)} ]; then cp -- {q(part)} {q(path)}; else mv -f -- {q(part)} {q(path)}; fi")
            self.check(err, code, "Uploading")
        finally:
            if not self.ended:
                self.run(f"rm -f -- {q(part)}")
        return size

    def mkdir(self, path: str, sudo: bool = False) -> None:
        self.check(*self.run(f"mkdir -- {q(path)}", sudo)[1:], "Making the folder")

    def rename(self, path: str, to: str, sudo: bool = False) -> None:
        _, err, code = self.run(f"if [ -e {q(to)} ]; then echo 'Something with that name is already there' >&2; exit 4; fi\n"
                                f"mv -- {q(path)} {q(to)}", sudo)
        if code == 4:
            raise FilesError("Something with that name is already there", "exists")
        self.check(err, code, "Renaming")

    def delete(self, path: str, sudo: bool = False) -> None:
        if path.rstrip("/") in ("", "/", self.home.rstrip("/")):
            raise FilesError("HaRM won't delete / or the home folder", "refused")
        self.check(*self.run(f"rm -rf -- {q(path)}", sudo)[1:], "Deleting")

    def command(self, folder: str, cmd: str, sudo: bool = False) -> dict:
        """A command in a folder, as one non-interactive shell: its output and exit code."""
        inner = f"cd -- {q(folder)} && {{ {cmd}\n}}"
        script = (f"if command -v timeout >/dev/null 2>&1; then timeout {RUN_SECONDS} sh -c {q(inner)}; "
                  f"else sh -c {q(inner)}; fi 2>&1")
        out, err, code = self.run(script, sudo, timeout=RUN_SECONDS + 30)
        text = (out + err).decode(errors="replace")
        if len(text) > remote.OUTPUT_MAX:
            text = text[:remote.OUTPUT_MAX] + "\n… (cut off: the output was too long)"
        if code == 124:
            text += f"\nStopped after {RUN_SECONDS} seconds. Use the terminal for longer or interactive commands."
        return {"output": text, "exit_code": code}

    def end(self, why: str) -> None:
        if self.ended:
            return
        self.ended = why or "This file browser has closed"
        try:
            self.p.kill()
            self.p.wait(5)
        except (OSError, subprocess.TimeoutExpired):
            pass
        self.keyfile.close()
        with _lock:
            _open.pop(self.id, None)


def start(owner: str, label: str, host: str, port: int, user: str, password: str | None, key: str | None,
          legacy: bool = False) -> Session:
    if not remote.available()["ssh"]:
        raise FilesError("The ssh client isn't installed on the HaRM server (package openssh-client)")
    try:
        remote.check_target(host, port, user)
    except remote.RemoteError as e:
        raise FilesError(str(e))
    with _lock:
        if len(_open) >= MAX_OPEN:
            raise FilesError(f"{MAX_OPEN} file browsers are open already. Close one first")
    s = Session(owner, label, host, port, user, password, key, legacy)
    with _lock:
        _open[s.id] = s
    return s


def get(sid: str, owner: str) -> Session:
    with _lock:
        s = _open.get(sid)
    if not s or s.owner != owner:
        raise FilesError("That file browser has closed. Open it again", "closed")
    return s


def close_owner(owner: str) -> None:
    with _lock:
        mine = [s for s in _open.values() if s.owner == owner]
    for s in mine:
        s.end("HaRM was locked, so the file browser closed.")


def reap(alive) -> None:
    now = time.monotonic()
    with _lock:
        all_ = list(_open.values())
    for s in all_:
        if not alive(s.owner):
            s.end("HaRM was locked, so the file browser closed.")
        elif now - s.last_used > IDLE and not s.lock.locked():
            s.end("Closed after 30 minutes unused.")


def _reaper(alive) -> None:
    while True:
        time.sleep(60)
        try:
            reap(alive)
        except Exception:  # noqa: BLE001  keep reaping
            pass


_started = False


def start_reaper(alive) -> None:
    global _started
    if not _started:
        _started = True
        threading.Thread(target=_reaper, args=(alive,), daemon=True).start()
