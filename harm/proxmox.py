"""Read a Proxmox VE cluster (or single node): nodes, VMs and containers, for import into HaRM.

Uses an API token (Datacenter > Permissions > API Tokens). A token with the PVEAuditor role is
enough: HaRM only reads. Redirects are never followed so the token can't leak to another host.
"""

import ipaddress
import json
import re
import ssl
import time
import urllib.error
import urllib.request
from urllib.parse import quote, urlencode, urlparse

from . import tlspin


class ProxmoxError(Exception):
    def __init__(self, msg: str, code: str = "error", seen: str = ""):
        super().__init__(msg)
        self.code = code
        self.seen = seen


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def base_url(url: str) -> str:
    url = (url or "").strip().rstrip("/")
    if not url:
        raise ProxmoxError("Enter the Proxmox address, e.g. https://192.168.1.20:8006")
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    u = urlparse(url)
    if not u.hostname:
        raise ProxmoxError("That Proxmox address is not valid")
    port = u.port or 8006
    return f"{u.scheme}://{u.hostname}:{port}" if ":" not in u.hostname else f"{u.scheme}://[{u.hostname}]:{port}"


class Proxmox:
    def __init__(self, url: str, token_id: str, secret: str, verify: bool, pin: str | None = None):
        token_id, secret = (token_id or "").strip(), (secret or "").strip()
        if not re.match(r"^[^@\s]+@[^!\s]+![^=\s]+$", token_id):
            raise ProxmoxError("Token ID looks like user@realm!name, e.g. root@pam!harm")
        if not secret:
            raise ProxmoxError("Enter the token secret")
        self.base = base_url(url)
        self.auth = f"PVEAPIToken={token_id}={secret}"
        self.opener, self._seen = tlspin.opener(verify, pin, _NoRedirect)

    @property
    def fingerprint(self) -> str:
        return self._seen.get("fp", "")

    def get(self, path: str, timeout: float = 15):
        return self._call("GET", path, None, timeout)

    def post(self, path: str, data: dict | None = None, timeout: float = 20):
        return self._call("POST", path, data or {}, timeout)

    def _call(self, method: str, path: str, data: dict | None, timeout: float):
        body = urlencode(data).encode() if data is not None else None
        req = urllib.request.Request(self.base + "/api2/json" + path, data=body, method=method,
                                     headers={"Authorization": self.auth})
        try:
            with self.opener.open(req, timeout=timeout) as r:
                return (json.loads(r.read(20_000_000)) or {}).get("data")
        except tlspin.PinMismatch as e:
            raise ProxmoxError("Proxmox's certificate changed since HaRM last connected. That's normal after "
                               "reinstalling Proxmox or renewing its certificate, but can also mean something is "
                               "intercepting the connection.", "pin", e.seen)
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise ProxmoxError("Proxmox rejected the token. Check the token ID and secret")
            if e.code == 403:
                if method == "POST":
                    raise ProxmoxError("The token isn't allowed to do that. In Proxmox, give it a role with VM.PowerMgmt "
                                       "(start and stop) and VM.Snapshot on / (see Help: Proxmox controls)")
                raise ProxmoxError("The token isn't allowed to read this. Give it the PVEAuditor role on / "
                                   "(and untick “Privilege Separation” or grant the role to the token too)")
            raise ProxmoxError(f"Proxmox answered HTTP {e.code} for {path}")
        except ssl.SSLCertVerificationError:
            raise ProxmoxError("Proxmox's certificate isn't trusted (it's self-signed by default). Untick “Verify certificate”")
        except (urllib.error.URLError, OSError) as e:
            raise ProxmoxError(f"Could not reach Proxmox: {getattr(e, 'reason', e)}")
        except ValueError:
            raise ProxmoxError("Proxmox did not return JSON. Is this the right address (port 8006)?")


def _gb(v) -> float | None:
    try:
        return round(int(v) / 1024 ** 3, 1) if v else None
    except (TypeError, ValueError):
        return None


def _ips_from_agent(data) -> list[str]:
    out = []
    for nic in (data or {}).get("result", []) if isinstance(data, dict) else []:
        if nic.get("name") == "lo":
            continue
        for a in nic.get("ip-addresses") or []:
            ip = a.get("ip-address")
            if a.get("ip-address-type") == "ipv4" and ip and not ip.startswith(("127.", "169.254.")):
                out.append(ip)
    return out


def _ips_from_lxc(data) -> list[str]:
    out = []
    for nic in data or []:
        if nic.get("name") == "lo":
            continue
        inet = nic.get("inet") or ""
        ip = inet.split("/")[0]
        try:
            if ip and ipaddress.ip_address(ip).version == 4 and not ip.startswith("127."):
                out.append(ip)
        except ValueError:
            pass
    return out


def read(url: str, token_id: str, secret: str, verify: bool = False, with_ips: bool = True, pin: str | None = None) -> dict:
    px = Proxmox(url, token_id, secret, verify, pin)
    status = px.get("/cluster/status") or []
    resources = px.get("/cluster/resources") or []
    cluster = next((s.get("name") for s in status if s.get("type") == "cluster"), None)
    node_ips = {s.get("name"): s.get("ip") for s in status if s.get("type") == "node"}
    nodes = []
    for r in resources:
        if r.get("type") == "node":
            nodes.append({"name": r.get("node"), "ip": node_ips.get(r.get("node")), "online": r.get("status") == "online",
                          "cpus": r.get("maxcpu"), "ram_gb": _gb(r.get("maxmem")), "disk_gb": _gb(r.get("maxdisk"))})
    guests, notes = [], []
    for r in resources:
        if r.get("type") not in ("qemu", "lxc"):
            continue
        guests.append({
            "vmid": str(r.get("vmid")), "name": r.get("name") or f"{r.get('type')}-{r.get('vmid')}", "node": r.get("node"),
            "kind": "Virtual Machine" if r["type"] == "qemu" else "Container", "type": r["type"],
            "running": r.get("status") == "running", "template": bool(r.get("template")),
            "vcpus": int(r["maxcpu"]) if r.get("maxcpu") else None, "ram_gb": _gb(r.get("maxmem")),
            "disk_gb": _gb(r.get("maxdisk")), "ips": [],
        })
    if with_ips:
        asked = 0
        for g in guests:
            if not g["running"] or g["template"] or asked >= 80:
                continue
            asked += 1
            path = (f"/nodes/{quote(g['node'])}/qemu/{g['vmid']}/agent/network-get-interfaces" if g["type"] == "qemu"
                    else f"/nodes/{quote(g['node'])}/lxc/{g['vmid']}/interfaces")
            try:
                data = px.get(path, timeout=4)
                g["ips"] = _ips_from_agent(data) if g["type"] == "qemu" else _ips_from_lxc(data)
            except ProxmoxError:
                pass  # no guest agent / older Proxmox: fine, IPs just stay empty
        if guests and not any(g["ips"] for g in guests if g["type"] == "qemu"):
            notes.append("VM IP addresses come from the QEMU guest agent; install it in your VMs to have them filled in.")
    guests.sort(key=lambda g: (g["node"] or "", int(g["vmid"]) if g["vmid"].isdigit() else 0))
    return {"cluster": cluster, "nodes": sorted(nodes, key=lambda n: n["name"] or ""), "guests": guests, "notes": notes,
            "fingerprint": px.fingerprint}


# --------------------------------------------------------------------------- live state and controls

OPS = ("start", "shutdown", "reboot", "stop", "snapshot")


def live(px: Proxmox) -> list[dict]:
    """Every VM and container with what it's doing now."""
    out = []
    for r in px.get("/cluster/resources?type=vm") or []:
        if r.get("type") not in ("qemu", "lxc"):
            continue
        out.append({"vmid": str(r.get("vmid")), "name": r.get("name") or f"{r['type']}-{r.get('vmid')}",
                    "node": r.get("node"), "type": r["type"], "status": r.get("status") or "unknown",
                    "template": bool(r.get("template")), "cpu": round((r.get("cpu") or 0) * 100, 1),
                    "cpus": r.get("maxcpu"), "mem": r.get("mem") or 0, "maxmem": r.get("maxmem") or 0,
                    "uptime": r.get("uptime") or 0, "lock": r.get("lock") or ""})
    return sorted(out, key=lambda g: (g["node"] or "", int(g["vmid"]) if g["vmid"].isdigit() else 0))


def backups(px: Proxmox) -> dict[str, dict]:
    """The newest backup of each VM or container ({vmid: {at, storage, size}}), from every storage
    that holds backups. Shared storage shows on each node, so each file is counted once."""
    newest, seen = {}, set()
    for n in px.get("/nodes") or []:
        node = n.get("node")
        if not node or n.get("status") not in (None, "online"):
            continue
        for st in px.get(f"/nodes/{quote(node)}/storage?content=backup") or []:
            name = st.get("storage")
            if not name or not st.get("active", 1):
                continue
            try:
                items = px.get(f"/nodes/{quote(node)}/storage/{quote(name)}/content?content=backup", timeout=30) or []
            except ProxmoxError:
                continue
            for it in items:
                vol, vmid, ct = it.get("volid"), str(it.get("vmid") or ""), int(it.get("ctime") or 0)
                if not vol or not vmid or vol in seen:
                    continue
                seen.add(vol)
                if ct > newest.get(vmid, {}).get("ctime", 0):
                    newest[vmid] = {"ctime": ct, "storage": name, "size": it.get("size") or 0}
    return newest


def _wait(px: Proxmox, node: str, upid, seconds: int) -> dict:
    """Wait for a Proxmox task to finish (or give up waiting; it carries on either way)."""
    if not isinstance(upid, str) or not upid.startswith("UPID:"):
        return {"done": True, "ok": True}
    for _ in range(seconds):
        st = px.get(f"/nodes/{quote(node)}/tasks/{quote(upid, safe='')}/status") or {}
        if st.get("status") == "stopped":
            return {"done": True, "ok": st.get("exitstatus") == "OK", "detail": st.get("exitstatus") or ""}
        time.sleep(1)
    return {"done": False, "ok": True}


def guest_op(px: Proxmox, node: str, kind: str, vmid: str, op: str, note: str = "") -> dict:
    if op not in OPS or kind not in ("qemu", "lxc") or not re.match(r"^\d{1,9}$", vmid or "") \
            or not re.match(r"^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$", node or ""):
        raise ProxmoxError("Unknown VM or operation")
    base = f"/nodes/{quote(node)}/{kind}/{vmid}"
    if op == "snapshot":
        name = "harm-" + time.strftime("%Y%m%d-%H%M%S")
        upid = px.post(f"{base}/snapshot", {"snapname": name, "description": note or "Taken from Zom's HaRM"})
        return {**_wait(px, node, upid, 120), "snapshot": name}
    upid = px.post(f"{base}/status/{op}", {"timeout": 120} if op == "shutdown" else {})
    return _wait(px, node, upid, 30 if op in ("start", "stop") else 10)
