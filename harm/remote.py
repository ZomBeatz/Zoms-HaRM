"""Run commands on other machines over SSH: the spec collector, and saved actions.

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
import time
from pathlib import Path

from . import db

COLLECT = Path(__file__).resolve().parent / "static" / "collect"
SSH_DIR = db.DB_PATH.parent / "ssh"
KNOWN_HOSTS = SSH_DIR / "known_hosts"
TIMEOUT = 120
OUTPUT_MAX = 200_000
_NO_WINDOW = 0x08000000 if os.name == "nt" else 0  # don't flash a console window on Windows
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


def _unix_command(sudo: bool, script: bytes | None = None) -> str:
    """A command that unpacks a script into a temporary file on the machine and runs it. The script
    travels inside the command, so stdin carries only the sudo password (never run as a command)."""
    if script is None:
        script, shell = (COLLECT / "harm-collect.sh").read_bytes(), "bash"
    else:
        shell = "bash" if re.match(rb"#!\s*\S*bash", script) else "sh"
    b64 = base64.b64encode(script).decode()
    run = f"sudo -S -p '' {shell} \"$S\"" if sudo else f"{shell} \"$S\""
    inner = (f"S=$(mktemp) || exit 1; "
             f"(printf %s '{b64}' | base64 -d > \"$S\" 2>/dev/null) || printf %s '{b64}' | base64 -D > \"$S\"; "
             f"{run}; rc=$?; rm -f \"$S\"; exit $rc")
    # Wrapped in sh -c so it works whatever the login shell is (bash, zsh, fish…).
    return "sh -c " + shlex.quote(inner)


def _windows_command() -> str:
    boot = "$s=[Console]::In.ReadToEnd(); Invoke-Expression $s"
    return ("powershell -NoProfile -NonInteractive -EncodedCommand "
            + base64.b64encode(boot.encode("utf-16-le")).decode())


def _ssh(host, port, user, password, command, stdin_text, extra=(), timeout=TIMEOUT):
    args = ["ssh", "-T", "-p", str(port), "-l", user,
            "-o", "StrictHostKeyChecking=accept-new", "-o", f"UserKnownHostsFile={KNOWN_HOSTS}",
            "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "LogLevel=ERROR",
            "-o", "NumberOfPasswordPrompts=1", *extra]
    keep = ("PATH", "HOME", "USER", "LANG", "SSH_AUTH_SOCK", "SYSTEMROOT", "USERPROFILE", "USERNAME", "TEMP", "TMP", "APPDATA")
    env = {k: v for k, v in os.environ.items() if k.upper() in keep}
    if password:
        env.update(SSH_ASKPASS=str(_askpass()), SSH_ASKPASS_REQUIRE="force", HARM_SSH_PW=password)
    else:
        args += ["-o", "BatchMode=yes"]
    args += [host, command]
    try:
        return subprocess.run(args, input=stdin_text, capture_output=True, text=True, errors="replace",
                              timeout=timeout, env=env, start_new_session=True, creationflags=_NO_WINDOW)
    except subprocess.TimeoutExpired:
        raise RemoteError(f"The machine took too long to answer ({timeout // 60} minutes)", "timeout")
    except OSError as e:
        raise RemoteError(f"Could not start ssh: {e}")


def _explain(p: subprocess.CompletedProcess, what: str = "The collector") -> RemoteError:
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
    if "no matching" in low and ("key exchange" in low or "host key" in low or "cipher" in low):
        return RemoteError("This machine only speaks an older kind of SSH. Tick “Older SSH (iLO, iDRAC, old switches)” "
                           f"and try again. ({last})", "legacy")
    return RemoteError(f"{what} failed: {last}")


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
        raise RemoteError("Port must be 1 to 65535", "host")
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


# ---------------------------------------------------------------------------
# Saved actions
# ---------------------------------------------------------------------------

# Older SSH for old management ports (HPE iLO 4, Dell iDRAC 7/8, older switches). Only the
# algorithms this computer's ssh still knows are added: naming an unknown one stops ssh.
_LEGACY = {
    "KexAlgorithms": ("kex", ["diffie-hellman-group14-sha1", "diffie-hellman-group1-sha1",
                              "diffie-hellman-group-exchange-sha1"]),
    "HostKeyAlgorithms": ("key", ["ssh-rsa", "ssh-dss"]),
    "PubkeyAcceptedAlgorithms": ("key", ["ssh-rsa"]),
    "Ciphers": ("cipher", ["aes128-cbc", "aes256-cbc", "3des-cbc"]),
}
_supported_cache: dict[str, set] = {}
SSH_OPTIONS = {"kexalgorithms": "KexAlgorithms", "hostkeyalgorithms": "HostKeyAlgorithms",
               "pubkeyacceptedalgorithms": "PubkeyAcceptedAlgorithms",
               "pubkeyacceptedkeytypes": "PubkeyAcceptedAlgorithms", "ciphers": "Ciphers", "macs": "MACs",
               "connecttimeout": "ConnectTimeout", "serveraliveinterval": "ServerAliveInterval"}
_OPT_VALUE = re.compile(r"^[A-Za-z0-9@.,+_^=-]{1,400}$")


def _supported(kind: str) -> set:
    if kind not in _supported_cache:
        try:
            p = subprocess.run(["ssh", "-Q", kind], capture_output=True, text=True, timeout=10,
                               creationflags=_NO_WINDOW)
            _supported_cache[kind] = set(p.stdout.split())
        except (OSError, subprocess.TimeoutExpired):
            _supported_cache[kind] = set()
    return _supported_cache[kind]


def legacy_options() -> list[str]:
    out = []
    for opt, (kind, algs) in _LEGACY.items():
        have = _supported(kind)
        ok = [a for a in algs if a in have] if have else []
        if ok:
            out += ["-o", f"{opt}=+{','.join(ok)}"]
    return out


def parse_ssh_options(text: str | None) -> list[str]:
    """Extra SSH settings, as pasted from a command (-o KexAlgorithms=+…) or one per line.
    Only connection settings are allowed: nothing that could run a program on this computer."""
    args = []
    toks = shlex.split((text or "").replace("\n", " "), posix=True) if text else []
    i = 0
    while i < len(toks):
        t = toks[i]
        if t == "-o":
            i += 1
            t = toks[i] if i < len(toks) else ""
        elif t.startswith("-o"):
            t = t[2:]
        key, sep, val = t.partition("=")
        if not sep and i + 1 < len(toks) and "=" not in toks[i + 1] and toks[i + 1] != "-o":
            i += 1
            val = toks[i]
        name = SSH_OPTIONS.get(key.strip().lower())
        if not name:
            raise RemoteError(f"HaRM doesn't allow the SSH setting “{key}”. Allowed: "
                              + ", ".join(sorted(set(SSH_OPTIONS.values()))), "options")
        if not _OPT_VALUE.match(val.strip()):
            raise RemoteError(f"The value for {name} doesn't look right", "options")
        args += ["-o", f"{name}={val.strip()}"]
        i += 1
    return args


def check_target(host: str, port: int, user: str) -> None:
    if not _HOST.match(host or "") or host.startswith("-"):
        raise RemoteError(f"“{host}” isn't a valid host name or IP address", "host")
    if not _USER.match(user or "") or user.startswith("-"):
        raise RemoteError("Enter a valid username (or pick a saved login)", "auth")
    if not 0 < int(port) < 65536:
        raise RemoteError("Port must be 1 to 65535", "host")


def _clip(text: str) -> str:
    return text if len(text) <= OUTPUT_MAX else text[:OUTPUT_MAX] + "\n… (cut off: the output was too long)"


def run_action(host: str, port: int, user: str, password: str | None, mode: str, command: str,
               sudo: bool = False, legacy: bool = False, options: str | None = None,
               timeout: int = TIMEOUT) -> dict:
    """Run a saved action on one machine. 'script' sends the whole text as one shell script;
    'lines' sends each line as its own command (for iLO, iDRAC, switches and Windows, which
    have no Unix shell). Returns {ok, exit_code, output, ms}."""
    if not available()["ssh"]:
        raise RemoteError("The ssh client isn't installed on the HaRM server (package openssh-client)")
    check_target(host, port, user)
    extra = (legacy_options() if legacy else []) + parse_ssh_options(options)
    t0 = time.monotonic()
    if mode == "lines":
        lines = [ln.strip() for ln in command.splitlines() if ln.strip() and not ln.strip().startswith("#")]
        if not lines:
            raise RemoteError("There are no commands to send (lines starting with # are skipped)", "command")
        out, rc = [], 0
        for ln in lines:
            p = _ssh(host, port, user, password, ln, "", extra, timeout)
            if p.returncode == 255 and not p.stdout:
                raise _explain(p, "The connection")
            out.append(f"> {ln}\n{p.stdout}{p.stderr}".rstrip() + "\n")
            rc = p.returncode
            if rc != 0:
                out.append(f"Stopped here: that command ended with code {rc}.\n")
                break
        return {"ok": rc == 0, "exit_code": rc, "output": _clip("\n".join(out)),
                "ms": int((time.monotonic() - t0) * 1000)}
    sudo = sudo and user != "root"
    if sudo and not password:
        cmd = _unix_command(False, command.encode()).replace("sh -c ", "sudo -n sh -c ", 1)
        stdin = ""
    else:
        cmd = _unix_command(sudo, command.encode())
        stdin = (password + "\n") if sudo else ""
    p = _ssh(host, port, user, password, cmd, stdin, extra, timeout)
    if p.returncode == 255 and not p.stdout:
        raise _explain(p, "The connection")
    err = p.stderr or ""
    if sudo and re.search(r"sorry, try again|incorrect password|a password is required", err, re.I):
        raise RemoteError("sudo refused the password. Untick “Run with sudo”, or use an account that can sudo", "sudo")
    return {"ok": p.returncode == 0, "exit_code": p.returncode, "output": _clip((p.stdout or "") + err),
            "ms": int((time.monotonic() - t0) * 1000)}
