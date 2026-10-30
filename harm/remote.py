"""Run the spec collector on a machine over SSH, or on the HaRM server itself.

Uses the system `ssh` client. Passwords come from the vault and reach ssh through a
tiny askpass helper via the environment of that one process, and reach sudo over stdin.
They are never put on a command line. Host keys are pinned on first use in
data/ssh/known_hosts.
"""

import base64
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

from . import db

COLLECT = Path(__file__).resolve().parent / "static" / "collect"
SSH_DIR = db.DB_PATH.parent / "ssh"
KNOWN_HOSTS = SSH_DIR / "known_hosts"
TIMEOUT = 120
_HOST = re.compile(r"^[A-Za-z0-9._:\[\]-]{1,253}$")
_USER = re.compile(r"^[A-Za-z0-9._@\\$-]{1,128}$")


class RemoteError(Exception):
    def __init__(self, msg: str, code: str = "error"):
        super().__init__(msg)
        self.code = code


def available() -> dict:
    return {"ssh": shutil.which("ssh") is not None, "bash": shutil.which("bash") is not None}


def _askpass() -> Path:
    SSH_DIR.mkdir(mode=0o700, exist_ok=True)
    if os.name == "nt":
        # Windows OpenSSH runs the helper directly; Python prints the password from the environment.
        p = SSH_DIR / "askpass.cmd"
        body = f'@"{sys.executable}" -c "import os,sys; sys.stdout.write(os.environ.get(\'HARM_SSH_PW\',\'\') + chr(10))"\r\n'
        if not p.exists() or p.read_text() != body:
            p.write_text(body)
        return p
    p = SSH_DIR / "askpass.sh"
    body = '#!/bin/sh\nprintf \'%s\\n\' "$HARM_SSH_PW"\n'
    if not p.exists() or p.read_text() != body:
        p.write_text(body)
    p.chmod(0o700)
    return p


def _unix_command(sudo: bool) -> str:
    b64 = base64.b64encode((COLLECT / "harm-collect.sh").read_bytes()).decode()
    run = "sudo -S -p '' bash \"$S\"" if sudo else "bash \"$S\""
    inner = (f"S=$(mktemp) || exit 1; "
             f"(printf %s '{b64}' | base64 -d > \"$S\" 2>/dev/null) || printf %s '{b64}' | base64 -D > \"$S\"; "
             f"{run}; rc=$?; rm -f \"$S\"; exit $rc")
    # Wrapped in sh -c so it works whatever the login shell is (bash, zsh, fish…).
    return "sh -c " + shlex.quote(inner)


def _windows_command() -> str:
    boot = "$s=[Console]::In.ReadToEnd(); Invoke-Expression $s"
    return ("powershell -NoProfile -NonInteractive -EncodedCommand "
            + base64.b64encode(boot.encode("utf-16-le")).decode())


def _ssh(host, port, user, password, command, stdin_text):
    args = ["ssh", "-T", "-p", str(port), "-l", user,
            "-o", "StrictHostKeyChecking=accept-new", "-o", f"UserKnownHostsFile={KNOWN_HOSTS}",
            "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "LogLevel=ERROR",
            "-o", "NumberOfPasswordPrompts=1"]
    keep = ("PATH", "HOME", "USER", "LANG", "SSH_AUTH_SOCK", "SYSTEMROOT", "USERPROFILE", "USERNAME", "TEMP", "TMP", "APPDATA")
    env = {k: v for k, v in os.environ.items() if k.upper() in keep}
    if password:
        env.update(SSH_ASKPASS=str(_askpass()), SSH_ASKPASS_REQUIRE="force", HARM_SSH_PW=password)
    else:
        args += ["-o", "BatchMode=yes"]
    args += [host, command]
    try:
        return subprocess.run(args, input=stdin_text, capture_output=True, text=True,
                              timeout=TIMEOUT, env=env, start_new_session=True)
    except subprocess.TimeoutExpired:
        raise RemoteError("The machine took too long to answer (2 minutes)")
    except OSError as e:
        raise RemoteError(f"Could not start ssh: {e}")


def _explain(p: subprocess.CompletedProcess) -> RemoteError:
    err = (p.stderr or "").strip()
    low = err.lower()
    if "remote host identification has changed" in low or "host key verification failed" in low:
        return RemoteError("This machine's SSH host key changed since HaRM last connected. That is normal "
                           "after reinstalling it, but can also mean something is intercepting the connection.",
                           "hostkey")
    if "permission denied" in low or "authentication failed" in low:
        return RemoteError("Login refused: check the username and password (or SSH key)", "auth")
    if "could not resolve" in low or "name or service not known" in low:
        return RemoteError("That host name can't be found. Try the IP address", "host")
    if "timed out" in low or "no route" in low or "connection refused" in low:
        return RemoteError(f"Can't reach SSH on that address: {err.splitlines()[-1]}", "host")
    if "sorry, try again" in low or "incorrect password" in low or "a password is required" in low:
        return RemoteError("sudo refused the password. Untick 'Use sudo', or use an account that can sudo", "sudo")
    last = err.splitlines()[-1] if err else f"exit code {p.returncode}"
    return RemoteError(f"The collector failed: {last}")


def forget_host(host: str, port: int = 22) -> None:
    if not KNOWN_HOSTS.exists() or not shutil.which("ssh-keygen"):
        return
    name = host if port == 22 else f"[{host}]:{port}"
    subprocess.run(["ssh-keygen", "-R", name, "-f", str(KNOWN_HOSTS)], capture_output=True, timeout=10)


def collect_ssh(host: str, port: int, user: str, password: str | None, sudo: bool, os_hint: str) -> str:
    if not available()["ssh"]:
        raise RemoteError("The ssh client isn't installed on the HaRM server (package openssh-client)")
    host = (host or "").strip()
    user = (user or "").strip()
    if not _HOST.match(host) or host.startswith("-"):
        raise RemoteError("Enter a valid host name or IP address", "host")
    if not _USER.match(user) or user.startswith("-"):
        raise RemoteError("Enter a valid username", "auth")
    if not 0 < int(port) < 65536:
        raise RemoteError("Port must be 1–65535", "host")
    sudo = sudo and user != "root"
    if sudo and not password:
        sudo = False  # sudo without a password only works with NOPASSWD; try it non-interactively
    if os_hint != "windows":
        p = _ssh(host, port, user, password, _unix_command(sudo), (password + "\n") if sudo else "")
        if p.returncode == 0 and '"harm_collect"' in p.stdout:
            return p.stdout
        windows_like = re.search(r"is not recognized|'sh' is not|CommandNotFoundException", p.stderr + p.stdout)
        if os_hint == "unix" or not windows_like:
            if p.returncode == 0:
                raise RemoteError("The machine answered but the collector printed nothing usable")
            raise _explain(p)
    p = _ssh(host, port, user, password, _windows_command(),
             (COLLECT / "harm-collect.ps1").read_text(encoding="utf-8-sig"))
    if p.returncode == 0 and '"harm_collect"' in p.stdout:
        return p.stdout
    raise _explain(p)


def collect_local() -> str:
    if os.name == "nt":
        args = ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
                str(COLLECT / "harm-collect.ps1")]
    elif available()["bash"]:
        args = ["bash", str(COLLECT / "harm-collect.sh")]
    else:
        raise RemoteError("bash isn't available on the HaRM server")
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=TIMEOUT, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        raise RemoteError("The collector took too long")
    if '"harm_collect"' not in p.stdout:
        raise RemoteError(f"The collector failed: {(p.stderr or '').strip()[-300:]}")
    return p.stdout
