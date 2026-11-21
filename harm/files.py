"""Files on a machine, in HaRM's page: browse, upload, download, edit, and run a command in a folder.

One SSH connection per open file browser, like the terminal: ssh runs `sh` on the machine and HaRM
sends it small scripts. Each answer comes back framed and base64-encoded, so file contents (and
whatever a command prints) can't be mistaken for HaRM's markers. It only works while HaRM is
unlocked, closes when HaRM locks or after 30 minutes unused, and at most 4 are open.

"Use sudo" runs an operation as root: the login's password is set once as a shell variable on the
machine (sent inside the encrypted connection, never on a command line) and handed to sudo -S.

Windows machines (OpenSSH Server) get WinSession instead: each operation is its own SSH connection
running PowerShell, and paths look like /C:/Users/name to the page ("/" lists the drives).
"""

import base64
import io
import json
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

    def _receive(self, part: str, chunks, what: str = "Uploading", unpack: bool = False) -> int:
        """A second SSH connection that writes what it's sent to `part` (the shell reads its own input a
        byte at a time, so file contents don't go through it). The path travels base64-encoded, so any
        login shell (bash, zsh, fish…) passes it on untouched. With unpack, `part` is a folder and what's
        sent is a tar archive, unpacked into it (made if it isn't there)."""
        if self.ended:
            raise FilesError(self.ended)
        host, port, user, password, key, legacy = self._login
        b64 = base64.b64encode(part.encode()).decode()
        inner = f'P=$(printf %s {b64} | base64 -d) && ' + ('mkdir -p -- "$P" && cd -- "$P" && tar -xf -' if unpack else 'cat > "$P"')
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
        self.check(err, code, what)
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

    def tar(self, folder: str, names: list[str], sink, sudo: bool = False) -> None:
        """A tar archive of `names` in `folder`, to sink in pieces (for a .zip download, or a copy)."""
        _, err, code = self.run(f"cd -- {q(folder)} && tar -cf - -- {' '.join(q(n) for n in names)}", sudo, timeout=None, sink=sink)
        self.check(err, code, "Packing it up")

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


def to_zip(tar_path: str, zip_path: str) -> int:
    """Turn a tar archive into a .zip (works on any computer without extra apps). Links are left out:
    a .zip can't hold them. Returns how many were left out."""
    import shutil
    import tarfile
    import zipfile
    skipped = 0
    with tarfile.open(tar_path) as tf, zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for m in tf:
            name = m.name.removeprefix("./")  # Windows' tar keeps the ./ HaRM puts before each name
            if not name.strip("/."):
                continue
            if m.isdir():
                zf.writestr(zipfile.ZipInfo(name.rstrip("/") + "/", time.localtime(m.mtime)[:6]), b"")
            elif m.isfile():
                zi = zipfile.ZipInfo(name, time.localtime(max(m.mtime, 315532800))[:6])
                zi.external_attr = (m.mode & 0xFFFF) << 16
                zi.compress_type = zipfile.ZIP_DEFLATED
                with tf.extractfile(m) as src, zf.open(zi, "w", force_zip64=m.size > 2**31) as dst:
                    shutil.copyfileobj(src, dst, 1024 * 1024)
            else:
                skipped += 1
    return skipped


def copy_between(src: "Session", folder: str, names: list[str], dst: "Session", dest: str, sudo: bool = False) -> int:
    """Copy files and folders from one machine to another, through HaRM: tar on one side, unpacked on the
    other, never stored here. Returns the bytes sent."""
    import queue
    pieces: queue.Queue = queue.Queue(maxsize=8)
    failed: list[Exception] = []

    def chunks():
        while (x := pieces.get()) is not None:
            yield x

    def pack():
        try:
            src.tar(folder, names, pieces.put, sudo)
        except Exception as e:  # noqa: BLE001  reported below
            failed.append(e)
        finally:
            pieces.put(None)

    t = threading.Thread(target=pack, daemon=True)
    t.start()
    try:
        size = dst._receive(dest, chunks(), "Copying", unpack=True)
    finally:
        while t.is_alive():  # let the packing side finish, so its connection stays usable
            try:
                pieces.get(timeout=1)
            except queue.Empty:
                pass
    if failed:
        raise failed[0] if isinstance(failed[0], FilesError) else FilesError(f"Copying failed: {failed[0]}")
    return size


# ---------------------------------------------------------------------------- Windows

def win_path(p: str) -> str:
    """/C:/Users/name (as the page has it) to C:\\Users\\name; "/" (the drives) to ""."""
    p = p.strip("/")
    if not p:
        return ""
    w = p.replace("/", "\\")
    return w + "\\" if len(w) == 2 and w[1] == ":" else w


def from_win(w: str) -> str:
    return "/" + w.replace("\\", "/").rstrip("/")


def psq(text: str) -> str:
    """A PowerShell string that's taken as it is (PowerShell also ends strings at curly quotes)."""
    for ch in "'\u2018\u2019\u201a\u201b":
        text = text.replace(ch, ch * 2)
    return "'" + text + "'"


# The command line is short and fixed: it reads the real script (base64, UTF-8) from the first line it's
# sent, so scripts can be any length and any language. Lines after that are data for the script.
_PS_BOOT = ("$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()));"
            "& ([scriptblock]::Create($s))")
PS_COMMAND = ("powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "
              + base64.b64encode(_PS_BOOT.encode("utf-16-le")).decode())
# Everything a script prints is base64 lines, so whatever PowerShell's own output encoding is can't change it.
_PS_HEAD = r"""$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$in=[Console]::In
function Done($c){[Console]::Out.Flush();[Environment]::Exit($c)}
function Out64([byte[]]$b){[Console]::Out.WriteLine([Convert]::ToBase64String($b))}
function OutText([string]$t){Out64 ([Text.Encoding]::UTF8.GetBytes($t+"`n"))}
function Fail($m,$c=1){[Console]::Error.WriteLine($m);Done $c}
function Pump($from){$b=New-Object byte[] 49152;while(($n=$from.Read($b,0,$b.Length)) -gt 0){[Console]::Out.WriteLine([Convert]::ToBase64String($b,0,$n))}}
function Sink($to){while(($l=$in.ReadLine()) -ne $null){if($l){$x=[Convert]::FromBase64String($l);$to.Write($x,0,$x.Length)}}}
function Tar($a){$i=New-Object Diagnostics.ProcessStartInfo 'tar.exe';$i.Arguments=$a;$i.UseShellExecute=$false
$i.RedirectStandardInput=$true;$i.RedirectStandardOutput=$true;$i.RedirectStandardError=$true;$t=[Diagnostics.Process]::Start($i)
$t | Add-Member -NotePropertyName Err -NotePropertyValue $t.StandardError.ReadToEndAsync();$t}
try{
"""
_PS_TAIL = "\n}catch{Fail $_.Exception.Message}\nDone 0\n"

_PS_LIST = r"""$p=PATH
if($p -eq ''){OutText '/';OutText (ConvertTo-Json -Compress -InputObject @(Get-PSDrive -PSProvider FileSystem | ForEach-Object{
 @{n=$_.Name+':';t='d';to='d';s=0;m=0;a='drive';k="$($_.Description)"}}));Done 0}
if(-not (Test-Path -LiteralPath $p -PathType Container)){Fail 'not a folder' 3}
$r=@(Get-ChildItem -LiteralPath $p -Force | Select-Object -First LIMIT | ForEach-Object{$l=[bool]($_.Attributes -band 1024);$d=$_.PSIsContainer
 @{n=$_.Name;t=$(if($l){'l'}elseif($d){'d'}else{'f'});to=$(if($d){'d'}else{'f'});s=$(if($d){0}else{$_.Length})
 m=[int64]($_.LastWriteTimeUtc-[datetime]'1970-01-01').TotalSeconds;a=$_.Mode;k="$($_.Target)"}})
OutText (Get-Item -LiteralPath $p -Force).FullName
OutText (ConvertTo-Json -Compress -InputObject $r)"""


def _win_args(folder: str, names: list[str]) -> str:
    """tar.exe's command line: Windows names can't hold a double quote, and .\\ keeps a name like -x a name."""
    return f'-C "{folder.rstrip(chr(92))}\\." ' + " ".join(f'".\\{n}"' for n in names)


class WinSession:
    """Files on a Windows machine with OpenSSH Server, the same operations as Session (no sudo there)."""
    windows = True

    def __init__(self, owner: str, label: str, host: str, port: int, user: str, password: str | None,
                 key: str | None, legacy: bool = False):
        self.id = secrets.token_urlsafe(12)
        self.owner, self.label, self.user = owner, label, user
        self._login = (host, port, user, password, key, legacy)
        self.has_password = False  # nothing for sudo
        self.lock = threading.Lock()
        self.last_used = time.monotonic()
        self.ended = ""
        try:
            out, err, code = self.ps("OutText $HOME", timeout=30)
        except FilesError as e:
            raise FilesError(str(e), "hostkey" if "host key" in str(e) else "connect")
        if code or not out.strip():
            raise FilesError("PowerShell didn't start on the machine. Is it a Windows machine with OpenSSH Server?"
                             + (f" ({err.decode(errors='replace').strip().splitlines()[-1][:200]})" if err.strip() else ""), "connect")
        self.home = from_win(out.decode(errors="replace").strip()) or "/"

    def ps(self, script: str, timeout: float | None = 120, sink=None, chunks=()) -> tuple[bytes, bytes, int]:
        """Run a PowerShell script on the machine: (what it printed, its errors, exit code). With sink, what
        it prints goes there in pieces; chunks are sent to it, for Sink."""
        if self.ended:
            raise FilesError(self.ended)
        host, port, user, password, key, legacy = self._login
        out, err = [], [b""]
        timed = []
        with sshkey.KeyFile(key) as key_path:
            args, env = remote._ssh_args(port, user, password, remote.legacy_options() if legacy else [], key_path)
            try:
                p = subprocess.Popen(args + [host, PS_COMMAND], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, env=env, start_new_session=True, creationflags=remote._NO_WINDOW)
            except OSError as e:
                raise FilesError(f"Could not start ssh: {e}")

            def feed():
                try:
                    p.stdin.write(base64.b64encode((_PS_HEAD + script + _PS_TAIL).encode()) + b"\n")
                    for data in chunks:
                        for i in range(0, len(data), 49152):
                            p.stdin.write(base64.b64encode(data[i:i + 49152]) + b"\n")
                        self.last_used = time.monotonic()
                    p.stdin.close()
                except (BrokenPipeError, OSError, ValueError):
                    pass

            def drain():
                for chunk in iter(lambda: p.stderr.read(4096), b""):
                    err[0] = (err[0] + chunk)[-65536:]

            def stop():
                timed.append(1)
                p.kill()
            threads = [threading.Thread(target=feed, daemon=True), threading.Thread(target=drain, daemon=True)]
            for t in threads:
                t.start()
            timer = threading.Timer(timeout, stop) if timeout else None
            if timer:
                timer.start()
            try:
                for line in p.stdout:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        data = base64.b64decode(line, validate=True)
                    except ValueError:
                        continue  # something that isn't the script's (a login banner)
                    self.last_used = time.monotonic()
                    if sink:
                        sink(data)
                    else:
                        out.append(data)
                code = p.wait()
                for t in threads:
                    t.join(5)
            finally:
                if timer:
                    timer.cancel()
        self.last_used = time.monotonic()
        if timed:
            raise FilesError("The machine took too long to answer")
        if code == 255 and not out:
            raise FilesError(str(remote._explain(subprocess.CompletedProcess([], 255, "", err[0].decode(errors="replace")), "The connection")))
        return b"".join(out), err[0], code

    def check(self, err: bytes, code: int, what: str) -> None:
        if code == 0:
            return
        text = err.decode(errors="replace").strip()
        low = text.lower()
        if "access to the path" in low and "denied" in low or "unauthorizedaccess" in low:
            raise FilesError(f"{what}: Windows says this login isn’t allowed to. Sign in with an administrator login", "denied")
        if "cannot find" in low or "could not find" in low or "does not exist" in low:
            raise FilesError(f"{what}: that file or folder isn’t there", "missing")
        if "being used by another process" in low:
            raise FilesError(f"{what}: a program on the machine has that file open", "busy")
        raise FilesError(f"{what} failed: {(text.splitlines() or [f'exit code {code}'])[-1][:300]}")

    def _p(self, path: str) -> str:
        return psq(win_path(path))

    def listdir(self, path: str, sudo: bool = False) -> dict:
        out, err, code = self.ps(_PS_LIST.replace("PATH", self._p(path or self.home)).replace("LIMIT", str(LIST_MAX)))
        if code == 3:
            raise FilesError("That folder can't be opened", "missing")
        self.check(err, code, "Reading the folder")
        head, _, body = out.decode(errors="replace").partition("\n")
        try:
            raw = json.loads(body.strip() or "[]")
        except ValueError:
            raise FilesError("The machine's answer didn't make sense")
        entries = [{"name": e.get("n") or "", "type": e.get("t") or "f", "to": e.get("to") or "", "size": int(e.get("s") or 0),
                    "mtime": int(e.get("m") or 0), "mode": str(e.get("a") or ""), "owner": "", "group": "",
                    "link": str(e.get("k") or "")} for e in (raw if isinstance(raw, list) else [raw]) if isinstance(e, dict)]
        where = head.strip()
        return {"path": "/" if where == "/" else from_win(where), "entries": entries, "cut": len(entries) >= LIST_MAX, "windows": True}

    def read_text(self, path: str, sudo: bool = False) -> str:
        out, err, code = self.ps(f"$p={self._p(path)};$f=Get-Item -LiteralPath $p -Force\n"
                                 f"if($f.PSIsContainer){{Fail 'That is a folder'}};if($f.Length -gt {TEXT_MAX}){{Done 5}}\n"
                                 "Out64 ([IO.File]::ReadAllBytes($p))")
        if code == 5:
            raise FilesError("That file is over 1 MB: download it instead", "big")
        self.check(err, code, "Opening the file")
        if out[:3] == b"\xef\xbb\xbf":
            out = out[3:]
        if b"\0" in out:
            raise FilesError("That isn't a text file: download it instead", "binary")
        return out.decode("utf-8", errors="replace")

    def download(self, path: str, sink, sudo: bool = False) -> None:
        _, err, code = self.ps(f"$f=[IO.File]::OpenRead({self._p(path)});Pump $f;$f.Close()", timeout=None, sink=sink)
        self.check(err, code, "Downloading")

    def _receive(self, part: str, chunks, what: str = "Uploading", unpack: bool = False) -> int:
        size = [0]

        def counted():
            for data in chunks:
                size[0] += len(data)
                yield data
        if unpack:
            script = (f"$p={self._p(part)};[void][IO.Directory]::CreateDirectory($p)\n"
                      f"$t=Tar ('-xf - '+{psq(_win_args(win_path(part), []))});Sink $t.StandardInput.BaseStream;$t.StandardInput.Close()\n"
                      "$t.WaitForExit();if($t.ExitCode){Fail $t.Err.Result}")
        else:
            script = f"$f=[IO.File]::Create({self._p(part)});Sink $f;$f.Close()"
        _, err, code = self.ps(script, timeout=None, chunks=counted())
        self.check(err, code, what)
        return size[0]

    def upload(self, path: str, chunks, sudo: bool = False) -> int:
        """Into a file beside it, then put in place: copied onto a file that's there, so it keeps its permissions."""
        size = [0]

        def counted():
            for data in chunks:
                size[0] += len(data)
                yield data
        part = f"{win_path(path)}.harm-part-{secrets.token_hex(4)}"
        _, err, code = self.ps(f"$p={self._p(path)};$q={psq(part)};$f=[IO.File]::Create($q)\n"
                               "try{Sink $f;$f.Close()\nif(Test-Path -LiteralPath $p){[IO.File]::Copy($q,$p,$true);[IO.File]::Delete($q)}else{[IO.File]::Move($q,$p)}}\n"
                               "catch{$f.Close();[IO.File]::Delete($q);throw}", timeout=None, chunks=counted())
        self.check(err, code, "Uploading")
        return size[0]

    def tar(self, folder: str, names: list[str], sink, sudo: bool = False) -> None:
        if not win_path(folder):
            raise FilesError("Pick something inside a drive")
        _, err, code = self.ps(f"$t=Tar ('-cf - '+{psq(_win_args(win_path(folder), names))});$t.StandardInput.Close()\n"
                               "Pump $t.StandardOutput.BaseStream;$t.WaitForExit();if($t.ExitCode){Fail $t.Err.Result}",
                               timeout=None, sink=sink)
        self.check(err, code, "Packing it up")

    def mkdir(self, path: str, sudo: bool = False) -> None:
        self.check(*self.ps(f"$p={self._p(path)};if(Test-Path -LiteralPath $p){{Fail 'Something with that name is already there'}}\n"
                            "[void][IO.Directory]::CreateDirectory($p)")[1:], "Making the folder")

    def rename(self, path: str, to: str, sudo: bool = False) -> None:
        _, err, code = self.ps(f"$p={self._p(path)};$to={self._p(to)};if(Test-Path -LiteralPath $to){{Done 4}}\n"
                               "if((Get-Item -LiteralPath $p -Force).PSIsContainer){[IO.Directory]::Move($p,$to)}else{[IO.File]::Move($p,$to)}")
        if code == 4:
            raise FilesError("Something with that name is already there", "exists")
        self.check(err, code, "Renaming")

    def delete(self, path: str, sudo: bool = False) -> None:
        w = win_path(path)
        if len(w) <= 3 or path.rstrip("/").lower() == self.home.rstrip("/").lower():
            raise FilesError("HaRM won't delete a whole drive or the home folder", "refused")
        self.check(*self.ps(f"Remove-Item -LiteralPath {psq(w)} -Recurse -Force")[1:], "Deleting")

    def command(self, folder: str, cmd: str, sudo: bool = False) -> dict:
        """A PowerShell command in a folder: what it printed and its exit code."""
        script = (f"Set-Location -LiteralPath {self._p(folder)};$m=New-Object IO.MemoryStream;Sink $m\n"
                  "$c=[Text.Encoding]::UTF8.GetString($m.ToArray())\n"
                  "$ErrorActionPreference='Continue';$global:LASTEXITCODE=0;$ok=$true\n"
                  "try{$o=& ([scriptblock]::Create($c)) 2>&1 | Out-String -Width 250}catch{$o=\"$_\";$ok=$false}\n"
                  "OutText $o;Done $(if(-not $ok){1}elseif($LASTEXITCODE){$LASTEXITCODE}else{0})")
        try:
            out, err, code = self.ps(script, timeout=RUN_SECONDS, chunks=[cmd.encode()])
        except FilesError as e:
            if "too long" not in str(e):
                raise
            return {"output": f"Stopped after {RUN_SECONDS} seconds. Use the terminal for longer or interactive commands.", "exit_code": 124}
        text = (out + err).decode(errors="replace").rstrip()
        if len(text) > remote.OUTPUT_MAX:
            text = text[:remote.OUTPUT_MAX] + "\n… (cut off: the output was too long)"
        return {"output": text, "exit_code": code}

    def end(self, why: str) -> None:
        if self.ended:
            return
        self.ended = why or "This file browser has closed"
        with _lock:
            _open.pop(self.id, None)


def start(owner: str, label: str, host: str, port: int, user: str, password: str | None, key: str | None,
          legacy: bool = False, windows: bool = False) -> "Session | WinSession":
    if not remote.available()["ssh"]:
        raise FilesError("The ssh client isn't installed on the HaRM server (package openssh-client)")
    try:
        remote.check_target(host, port, user)
    except remote.RemoteError as e:
        raise FilesError(str(e))
    with _lock:
        if len(_open) >= MAX_OPEN:
            raise FilesError(f"{MAX_OPEN} file browsers are open already. Close one first")
    s = (WinSession if windows else Session)(owner, label, host, port, user, password, key, legacy)
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


def close_all() -> None:
    """When HaRM stops: its ssh connections would outlive it otherwise (they run in their own session)."""
    with _lock:
        all_ = list(_open.values())
    for s in all_:
        s.end("HaRM stopped")


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
