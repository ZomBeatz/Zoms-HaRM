"""Read a Proxmox VE cluster (or single node): nodes, VMs and containers, for import into HaRM.

Uses an API token (Datacenter > Permissions > API Tokens). A token with the PVEAuditor role is
enough: HaRM only reads. Redirects are never followed so the token can't leak to another host.
"""

import ipaddress
import json
import re
import ssl
import urllib.error
import urllib.request
from urllib.parse import quote, urlparse


class ProxmoxError(Exception):
    pass


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
    def __init__(self, url: str, token_id: str, secret: str, verify: bool):
        token_id, secret = (token_id or "").strip(), (secret or "").strip()
        if not re.match(r"^[^@\s]+@[^!\s]+![^=\s]+$", token_id):
            raise ProxmoxError("Token ID looks like user@realm!name, e.g. root@pam!harm")
        if not secret:
            raise ProxmoxError("Enter the token secret")
        self.base = base_url(url)
        self.auth = f"PVEAPIToken={token_id}={secret}"
        ctx = ssl.create_default_context()
        if not verify:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        self.opener = urllib.request.build_opener(_NoRedirect, urllib.request.HTTPSHandler(context=ctx))

    def get(self, path: str, timeout: float = 15):
        req = urllib.request.Request(self.base + "/api2/json" + path, headers={"Authorization": self.auth})
        try:
            with self.opener.open(req, timeout=timeout) as r:
                return (json.loads(r.read(20_000_000)) or {}).get("data")
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise ProxmoxError("Proxmox rejected the token. Check the token ID and secret")
            if e.code == 403:
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


def read(url: str, token_id: str, secret: str, verify: bool = False, with_ips: bool = True) -> dict:
    px = Proxmox(url, token_id, secret, verify)
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
    return {"cluster": cluster, "nodes": sorted(nodes, key=lambda n: n["name"] or ""), "guests": guests, "notes": notes}
