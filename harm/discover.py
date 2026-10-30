"""Network discovery: a LAN sweep run from the HaRM server, and a UniFi Network import.

Both return the same "host" shape so the review screen can treat them alike:
  {ip, mac, name, hostname, vendor, model, kind, online, connection, uplink, port,
   network, fixed_ip, ports: [{port, name}], source}
"""

import asyncio
import ipaddress
import json
import os
import re
import shutil
import socket
import ssl
import subprocess
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

# Ports probed on every address. A refused connection still proves the host is up.
PORT_HINTS = {
    22: "SSH", 53: "DNS", 80: "HTTP", 443: "HTTPS", 445: "SMB", 2049: "NFS", 3000: "Web app",
    3260: "iSCSI", 3389: "RDP", 5000: "Web (5000)", 5001: "Web (5001)", 5900: "VNC",
    8006: "Proxmox VE", 8080: "HTTP alt", 8123: "Home Assistant", 8443: "HTTPS alt",
    9090: "Cockpit", 9443: "Portainer", 32400: "Plex",
}
WEB_PORTS = {80: "http", 443: "https", 3000: "http", 5000: "http", 5001: "https", 8006: "https",
             8080: "http", 8123: "http", 8443: "https", 9090: "https", 9443: "https", 32400: "http"}
MAX_HOSTS = 1024
_CGNAT = ipaddress.ip_network("100.64.0.0/10")


class DiscoverError(Exception):
    pass


def norm_mac(mac: str | None) -> str | None:
    hexes = re.sub(r"[^0-9a-fA-F]", "", mac or "")
    if len(hexes) != 12 or hexes == "0" * 12:
        return None
    return ":".join(hexes[i:i + 2] for i in range(0, 12, 2)).upper()


# ---------------------------------------------------------------- LAN sweep

def check_range(cidr: str) -> ipaddress.IPv4Network:
    try:
        net = ipaddress.ip_network(cidr.strip(), strict=False)
    except ValueError:
        raise DiscoverError(f"'{cidr}' is not a valid range. Use CIDR form like 192.168.1.0/24")
    if net.version != 4:
        raise DiscoverError("Only IPv4 ranges can be swept")
    if not (net.is_private or net.subnet_of(_CGNAT)) or net.is_loopback:
        raise DiscoverError("Only private (home/lab) address ranges can be scanned")
    if net.num_addresses > MAX_HOSTS + 2:
        raise DiscoverError(f"That range has {net.num_addresses} addresses; scan /22 or smaller")
    return net


def local_subnets() -> list[dict]:
    """The server's own IPv4 subnets, as suggestions."""
    out = []
    if shutil.which("ip"):
        try:
            p = subprocess.run(["ip", "-j", "-4", "addr"], capture_output=True, text=True, timeout=5)
            for link in json.loads(p.stdout or "[]"):
                name = link.get("ifname", "")
                if name == "lo" or name.startswith(("docker", "br-", "veth", "virbr")):
                    continue
                for a in link.get("addr_info", []):
                    net = ipaddress.ip_network(f"{a['local']}/{a['prefixlen']}", strict=False)
                    if net.prefixlen < 22:
                        net = ipaddress.ip_network(f"{a['local']}/24", strict=False)
                    out.append({"cidr": str(net), "label": f"{name} ({a['local']})"})
        except (OSError, ValueError, KeyError, subprocess.TimeoutExpired):
            pass
    if not out:
        try:  # No packet is sent; this only asks the OS which source address it would use.
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("10.255.255.255", 1))
                ip = s.getsockname()[0]
            out.append({"cidr": str(ipaddress.ip_network(f"{ip}/24", strict=False)), "label": ip})
        except OSError:
            pass
    return out


def _arp_table() -> dict[str, str]:
    table = {}
    if os.name == "nt" or not os.path.exists("/proc/net/arp"):
        # Windows / macOS: parse `arp -a` ("192.168.1.5   aa-bb-cc-dd-ee-ff   dynamic" or "? (192.168.1.5) at aa:bb:…")
        try:
            out = subprocess.run(["arp", "-a"], capture_output=True, text=True, timeout=10).stdout
        except (OSError, subprocess.TimeoutExpired):
            return table
        for m in re.finditer(r"(\d+\.\d+\.\d+\.\d+)\)?\s+(?:at\s+)?([0-9a-fA-F]{1,2}(?:[:-][0-9a-fA-F]{1,2}){5})", out):
            mac = norm_mac("".join(x.zfill(2) for x in re.split(r"[:-]", m.group(2))))
            if mac and mac != "FF:FF:FF:FF:FF:FF":
                table[m.group(1)] = mac
        return table
    try:
        with open("/proc/net/arp") as f:
            next(f, None)
            for line in f:
                parts = line.split()
                if len(parts) >= 4 and parts[2] != "0x0":
                    mac = norm_mac(parts[3])
                    if mac:
                        table[parts[0]] = mac
    except OSError:
        pass
    return table


async def _probe(ip: str, port: int, timeout: float) -> str | None:
    try:
        _r, w = await asyncio.wait_for(asyncio.open_connection(ip, port), timeout)
    except ConnectionRefusedError:
        return "closed"
    except (asyncio.TimeoutError, OSError):
        return None
    w.close()
    try:
        await asyncio.wait_for(w.wait_closed(), 1)
    except (asyncio.TimeoutError, OSError):
        pass
    return "open"


async def _ping(ip: str) -> bool:
    try:
        args = ["ping", "-n", "1", "-w", "1000", ip] if os.name == "nt" else ["ping", "-c", "1", "-W", "1", "-n", ip]
        p = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        return await asyncio.wait_for(p.wait(), 3) == 0
    except (OSError, asyncio.TimeoutError):
        return False


async def scan(cidr: str, timeout: float = 0.8) -> dict:
    net = check_range(cidr)
    started = time.monotonic()
    addrs = [str(a) for a in (net.hosts() if net.num_addresses > 2 else net)]
    conn_sem, ping_sem = asyncio.Semaphore(384), asyncio.Semaphore(64)
    can_ping = shutil.which("ping") is not None

    async def port(ip, p):
        async with conn_sem:
            return await _probe(ip, p, timeout)

    async def host(ip):
        res = await asyncio.gather(*(port(ip, p) for p in PORT_HINTS))
        open_ports = [p for p, r in zip(PORT_HINTS, res) if r == "open"]
        seen = any(r is not None for r in res)
        if not seen and can_ping:
            async with ping_sem:
                seen = await _ping(ip)
        return ip, seen, open_ports

    results = await asyncio.gather(*(host(ip) for ip in addrs))
    arp = _arp_table()
    alive = {ip: ports for ip, seen, ports in results if seen or ip in arp}

    loop = asyncio.get_running_loop()
    names: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=32) as pool:
        async def rdns(ip):
            try:
                names[ip] = (await asyncio.wait_for(
                    loop.run_in_executor(pool, socket.gethostbyaddr, ip), 2))[0]
            except (OSError, asyncio.TimeoutError):
                pass
        await asyncio.gather(*(rdns(ip) for ip in alive))
        pool.shutdown(wait=False, cancel_futures=True)

    hosts = []
    for ip in sorted(alive, key=lambda a: int(ipaddress.ip_address(a))):
        hn = names.get(ip)
        hosts.append({
            "ip": ip, "mac": arp.get(ip), "hostname": hn, "name": hn.split(".")[0] if hn else None,
            "vendor": None, "model": None, "kind": "host", "online": True, "connection": None,
            "uplink": None, "port": None, "network": None, "fixed_ip": False, "source": "scan",
            "ports": [{"port": p, "name": PORT_HINTS[p]} for p in alive[ip]],
        })
    notes = []
    if not arp:
        notes.append("No MAC addresses: the HaRM server is not on the same LAN segment as these "
                     "hosts (or runs in a container), so matching uses IPs and names only.")
    if not can_ping:
        notes.append("'ping' is not installed on the server, so hosts with every probed port "
                     "firewalled may be missed.")
    return {"cidr": str(net), "hosts": hosts, "elapsed": round(time.monotonic() - started, 1),
            "scanned": len(addrs), "notes": notes}


# ---------------------------------------------------------------- UniFi

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow redirects: the API key must not be sent anywhere else."""
    def redirect_request(self, *a, **k):
        return None


def _base_url(url: str) -> str:
    url = (url or "").strip().rstrip("/")
    if not url:
        raise DiscoverError("Enter the gateway address, e.g. https://192.168.1.1")
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    u = urlparse(url)
    if not u.hostname:
        raise DiscoverError("That gateway address is not valid")
    return f"{u.scheme}://{u.netloc}"


class UniFi:
    def __init__(self, url: str, api_key: str, verify: bool):
        self.base = _base_url(url)
        self.key = api_key
        ctx = ssl.create_default_context()
        if not verify:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        self.opener = urllib.request.build_opener(_NoRedirect, urllib.request.HTTPSHandler(context=ctx))

    def get(self, path: str):
        req = urllib.request.Request(self.base + path,
                                     headers={"X-API-KEY": self.key, "Accept": "application/json"})
        try:
            with self.opener.open(req, timeout=15) as r:
                return json.loads(r.read(30_000_000) or b"null")
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise DiscoverError("The gateway rejected the API key")
            if e.code == 404:
                raise FileNotFoundError(path)
            if 300 <= e.code < 400:
                raise DiscoverError("The gateway redirected the request. Check the address "
                                    "(UniFi OS consoles use https://<gateway-ip>)")
            raise DiscoverError(f"Gateway answered HTTP {e.code}")
        except ssl.SSLCertVerificationError:
            raise DiscoverError("The gateway's certificate isn't trusted. UniFi consoles use a "
                                "self-signed certificate; untick 'Verify certificate'")
        except (urllib.error.URLError, OSError) as e:
            reason = getattr(e, "reason", e)
            raise DiscoverError(f"Could not reach the gateway: {reason}")
        except ValueError:
            raise DiscoverError("The gateway did not return JSON. Is this a UniFi console?")

    def paged(self, path: str) -> list:
        out, offset = [], 0
        while True:
            sep = "&" if "?" in path else "?"
            page = self.get(f"{path}{sep}offset={offset}&limit=200") or {}
            data = page.get("data") or []
            out.extend(data)
            offset += len(data)
            if not data or offset >= (page.get("totalCount") or 0) or len(out) > 5000:
                return out

    def legacy(self, site_ref: str, path: str) -> list:
        """Older API endpoints give richer detail; API keys work on them on recent firmware."""
        try:
            d = self.get(f"/proxy/network/api/s/{site_ref}/{path}")
            return d.get("data") or [] if isinstance(d, dict) else []
        except (DiscoverError, FileNotFoundError):
            return []


def _ip_ok(v) -> str | None:
    try:
        return str(ipaddress.ip_address(v)) if v else None
    except ValueError:
        return None


def unifi_import(url: str, api_key: str, site: str = "", verify: bool = False) -> dict:
    if not api_key:
        raise DiscoverError("Enter an API key")
    u = UniFi(url, api_key, verify)
    try:
        sites = u.paged("/proxy/network/integration/v1/sites")
    except FileNotFoundError:
        raise DiscoverError("This console has no UniFi Network integration API. "
                            "Update UniFi Network to 9.0 or newer.")
    if not sites:
        raise DiscoverError("No sites found on this console")
    want = (site or "").strip().lower()
    chosen = next((s for s in sites if want and want in (str(s.get("name", "")).lower(),
                                                          str(s.get("internalReference", "")).lower())),
                  sites[0])
    sid, ref = chosen["id"], chosen.get("internalReference") or "default"
    base = f"/proxy/network/integration/v1/sites/{sid}"
    devices = u.paged(f"{base}/devices")
    clients = u.paged(f"{base}/clients")
    dev_names = {d.get("id"): d.get("name") or d.get("model") for d in devices}

    hosts: dict[str, dict] = {}

    def put(h):
        key = h["mac"] or h["ip"]
        if not key:
            return
        if key in hosts:
            for k, v in h.items():
                if v not in (None, "", [], False) and hosts[key].get(k) in (None, "", [], False):
                    hosts[key][k] = v
        else:
            hosts[key] = h

    def blank(**kw):
        h = {"ip": None, "mac": None, "name": None, "hostname": None, "vendor": None, "model": None,
             "kind": "client", "online": False, "connection": None, "uplink": None, "port": None,
             "network": None, "fixed_ip": False, "ports": [], "source": "unifi"}
        h.update(kw)
        return h

    for d in devices:
        put(blank(ip=_ip_ok(d.get("ipAddress")), mac=norm_mac(d.get("macAddress")), name=d.get("name"),
                  vendor="Ubiquiti", model=d.get("model"), kind="network-device",
                  online=str(d.get("state", "")).upper() == "ONLINE"))
    for c in clients:
        t = str(c.get("type", "")).upper()
        put(blank(ip=_ip_ok(c.get("ipAddress")), mac=norm_mac(c.get("macAddress")), name=c.get("name"),
                  online=True, connection={"WIRED": "Wired", "WIRELESS": "Wi-Fi", "VPN": "VPN"}.get(t, t.title() or None),
                  uplink=dev_names.get(c.get("uplinkDeviceId"))))
    # Richer detail (vendor, hostname, switch port, reservations) where the console allows it.
    for c in u.legacy(ref, "stat/sta"):
        put(blank(ip=_ip_ok(c.get("ip")), mac=norm_mac(c.get("mac")), name=c.get("name"),
                  hostname=c.get("hostname"), vendor=c.get("oui"), online=True,
                  connection="Wired" if c.get("is_wired") else ("Wi-Fi" if c.get("essid") else None),
                  uplink=c.get("last_uplink_name") or c.get("sw_name"), port=c.get("sw_port"),
                  network=c.get("network") or c.get("essid"),
                  fixed_ip=bool(c.get("use_fixedip"))))
    for c in u.legacy(ref, "rest/user"):  # known clients, including ones that are offline now
        if not (c.get("use_fixedip") or c.get("name")):
            continue
        put(blank(ip=_ip_ok(c.get("fixed_ip") if c.get("use_fixedip") else c.get("last_ip")),
                  mac=norm_mac(c.get("mac")), name=c.get("name"), hostname=c.get("hostname"),
                  vendor=c.get("oui"), fixed_ip=bool(c.get("use_fixedip"))))

    networks = []
    for n in u.legacy(ref, "rest/networkconf"):
        if n.get("purpose") not in ("corporate", "guest", "vlan-only") or not n.get("ip_subnet"):
            continue
        try:
            iface = ipaddress.ip_interface(n["ip_subnet"])
        except ValueError:
            continue
        networks.append({
            "name": n.get("name") or str(iface.network),
            "kind": "Guest" if n.get("purpose") == "guest" else None,
            "vlan_id": int(n["vlan"]) if n.get("vlan_enabled") and str(n.get("vlan", "")).isdigit() else None,
            "cidr": str(iface.network), "gateway": str(iface.ip),
            "dhcp_start": _ip_ok(n.get("dhcpd_start")) if n.get("dhcpd_enabled") else None,
            "dhcp_end": _ip_ok(n.get("dhcpd_stop")) if n.get("dhcpd_enabled") else None,
            "domain": n.get("domain_name") or None,
        })

    ordered = sorted(hosts.values(), key=lambda h: (
        h["kind"] != "network-device", h["ip"] is None,
        int(ipaddress.ip_address(h["ip"])) if h["ip"] else 0))
    notes = []
    if not any(h["vendor"] and h["kind"] == "client" for h in ordered):
        notes.append("Only the basic client list was available; vendor names, switch ports and "
                     "offline reserved clients need a newer UniFi Network version.")
    return {"site": {"name": chosen.get("name"), "ref": ref},
            "sites": [{"name": s.get("name"), "ref": s.get("internalReference")} for s in sites],
            "hosts": ordered, "networks": networks, "notes": notes}


BMC_NAME = re.compile(r"idrac|\bilo\b|ilo\d|-ilo|ipmi|\bbmc\b|-bmc|\bimm\b|xcc", re.I)


def is_bmc(h: dict) -> bool:
    return bool(BMC_NAME.search(" ".join(str(h.get(k) or "") for k in ("hostname", "name"))))


# Client devices recognised from their names (hostname, UniFi name) and vendor. First match wins.
CLIENT_TYPES = [
    ("Tablet", r"ipad|\btab\b|galaxy[-_ ]?tab|tablet|kindle|fire[-_ ]?hd|surface[-_ ]?(go|pro)|lenovo[-_ ]?tab"),
    ("Wearable", r"watch|fitbit|garmin|whoop|oura"),
    ("Phone", r"iphone|\bphone\b|android|pixel[-_ ]?\d|oneplus|galaxy[-_ ]?(s|a|z|note)\d|\bs\d{2}[-_ ]?(ultra|plus|fe)?\b"
              r"|(^|[-_ ])(z[-_ ]?)?(fold|flip)\d?|motorola|moto[-_ ]?g|redmi|xiaomi|huawei|nokia|sm-[sganf]\d{3}"),
    ("TV / Streaming", r"\btv\b|[-_]tv|tv[-_]|roku|chromecast|fire[-_ ]?(tv|stick)|apple[-_ ]?tv|shield|bravia|webos|tizen"
                       r"|vizio|google[-_ ]?tv|lgwebos|hisense|tcl"),
    ("Game Console", r"playstation|\bps[345]\b|xbox|nintendo|steam[-_ ]?deck"),
    ("Smart Home", r"echo|alexa|\bnest\b|google[-_ ]?home|homepod|philips[-_ ]?hue|\bhue\b|\bring\b|wyze|tuya|\besp[-_]|shelly"
                   r"|sonos|kasa|tapo|ecobee|thermostat|doorbell|smart[-_ ]?plug|myq|meross|govee|wiz[-_]|switchbot|roomba|irobot"),
    ("Camera / NVR", r"camera|\bcam\b|[-_]cam|cam[-_]|\bnvr\b|reolink|hikvision|dahua|amcrest|\bg[345][-_ ]"),
    ("Printer", r"printer|\bepson|brother|canon|laserjet|officejet|\bhp[-_]"),
    ("Laptop", r"macbook|laptop|thinkpad|\bxps\b|zenbook|chromebook|\bspectre\b|\bnotebook\b"),
    ("Desktop", r"desktop|\bimac\b|mac[-_ ]?mini|\bpc\b|[-_]pc$|gaming"),
    ("NAS", r"synology|diskstation|\bqnap|truenas|unraid|\bnas\b"),
    ("SBC (Raspberry Pi etc.)", r"raspberry|\bpi\d?\b|raspberrypi"),
]


def guess_type(h: dict) -> str | None:
    if is_bmc(h):
        return None  # a server's management port: attach it to the server, not a new device
    text = " ".join(str(h.get(k) or "") for k in ("model", "hostname", "name")).upper()
    if re.search(r"\bUSW|\bUS-\d|SWITCH", text) and "NINTENDO" not in text:
        return "Switch"
    if re.search(r"\bU6|\bU7|\bUAP|\bUAL|\bE7\b|ACCESS.?POINT", text):
        return "Access Point"
    if re.search(r"\bUDM|\bUCG|\bUXG|\bUSG|\bUDR|\bUDW|\bEFG|DREAM ?MACHINE|CLOUD GATEWAY|\bUNIFI\b", text):
        return "Router"
    if re.search(r"\bUNVR|\bNVR\b|CAMERA", text):
        return "Camera / NVR"
    if re.search(r"\bUPS\b", text):
        return "UPS"
    if h.get("kind") == "network-device":
        return "Other"
    names = " ".join(str(h.get(k) or "") for k in ("hostname", "name", "model", "vendor")).lower()
    for kind, rx in CLIENT_TYPES:
        if re.search(rx, names):
            return kind
    ports = {p["port"] for p in h.get("ports") or []}
    if 8006 in ports:
        return "Hypervisor Host"
    if 3389 in ports:
        return "Desktop"
    if ports & {5000, 5001, 2049, 3260}:
        return "NAS"
    if 22 in ports and len(ports) > 1:
        return "Server"
    return None


# ---------------------------------------------------------------- any router: pasted client / lease lists

_IP4 = re.compile(r"(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])")
_MAC = re.compile(r"(?<![0-9A-Fa-f:.-])([0-9A-Fa-f]{1,2}(?:[:-][0-9A-Fa-f]{1,2}){5}|[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4})(?![0-9A-Fa-f:.-])")
_STOP = {"dynamic", "static", "reachable", "stale", "permanent", "ether", "bound", "active", "expired", "free", "online",
         "offline", "lease", "leases", "interface", "address", "hostname", "host", "name", "mac", "ip", "type", "lan", "wan",
         "wifi", "wired", "wireless", "ethernet", "yes", "no", "never", "infinite", "none", "unknown", "delay", "probe",
         "incomplete", "dev", "lladdr", "router", "client", "clients", "status", "expires", "ends", "starts", "at", "on", "is",
         "via", "bridge", "br0", "br-lan", "eth0", "eth1", "lan1", "wlan0", "vlan", "dhcp", "manual", "reserved", "true", "false"}


def _mac_norm(m: str) -> str | None:
    m = m.replace(".", "")
    if ":" in m or "-" in m:
        m = "".join(x.zfill(2) for x in re.split(r"[:-]", m))
    return norm_mac(m)


def _host_token(tokens: list[str]) -> str | None:
    for t in tokens:
        t = t.strip("\"';,()[]{}*<>")
        if not t or t.lower() in _STOP or _IP4.fullmatch(t) or _MAC.fullmatch(t):
            continue
        if re.fullmatch(r"[A-Za-z][A-Za-z0-9._'-]{1,62}", t) and not re.fullmatch(r"[0-9a-fA-F]{12}", t):
            return t
    return None


def parse_client_list(text: str) -> dict:
    """Pull IP / MAC / name triples out of almost any router's client or DHCP lease list:
    copied web tables, dnsmasq/OpenWrt/Pi-hole leases, ISC dhcpd.leases, MikroTik, CSV exports, `arp -a`."""
    text = (text or "")[:2_000_000]
    found: dict[str, dict] = {}

    def add(ip, mac, name):
        try:
            ip = str(ipaddress.ip_address(ip)) if ip else None
        except ValueError:
            ip = None
        if ip and (ip.startswith(("0.", "127.", "255.", "224.")) or ip.endswith(".255")):
            ip = None
        mac = _mac_norm(mac) if mac else None
        if mac == "FF:FF:FF:FF:FF:FF":
            mac = None
        if not (ip or mac):
            return
        key = mac or ip
        h = found.setdefault(key, {"ip": None, "mac": None, "name": None, "hostname": None})
        h["ip"] = h["ip"] or ip
        h["mac"] = h["mac"] or mac
        if name and not h["name"]:
            h["name"] = h["hostname"] = name

    # ISC dhcpd.leases blocks (pfSense/OPNsense "dhcpd.leases" files)
    for m in re.finditer(r"lease\s+([\d.]+)\s*\{(.*?)\}", text, re.S):
        mac = re.search(r"hardware ethernet\s+([0-9a-fA-F:]+)", m.group(2))
        name = re.search(r'client-hostname\s+"([^"]+)"', m.group(2))
        add(m.group(1), mac.group(1) if mac else None, name.group(1) if name else None)
    if found:
        return _client_result(found)

    lines = [l for l in text.splitlines() if l.strip()]
    # CSV / TSV with a header row
    if lines and re.search(r"(ip|address)", lines[0], re.I) and re.search(r"[,;\t]", lines[0]):
        import csv
        delim = max([",", ";", "\t"], key=lines[0].count)
        rows = list(csv.reader(lines, delimiter=delim))
        head = [h.strip().lower() for h in rows[0]]
        col = lambda *names: next((i for i, h in enumerate(head) if any(n in h for n in names)), None)
        ci, cm, cn = col("ip"), col("mac", "hardware", "hwaddr"), col("hostname", "host name", "name", "client", "device")
        if ci is not None or cm is not None:
            for r in rows[1:]:
                g = lambda i: r[i].strip() if i is not None and i < len(r) else None
                add(g(ci), g(cm), g(cn))
            if found:
                return _client_result(found)
    # Line by line: any line with an IP and/or MAC, plus a name-like word
    for line in lines:
        if re.match(r"\s*interface:", line, re.I):  # `arp -a` header naming this PC's own address
            continue
        ip, mac = _IP4.search(line), _MAC.search(line)
        if not (ip or mac):
            continue
        add(ip.group(1) if ip else None, mac.group(1) if mac else None, _host_token(line.split()))
    return _client_result(found)


def _client_result(found: dict) -> dict:
    hosts = []
    for h in found.values():
        hosts.append({**h, "vendor": None, "model": None, "kind": "client", "online": None, "connection": None,
                      "uplink": None, "port": None, "network": None, "fixed_ip": False, "ports": [], "source": "list"})
    hosts.sort(key=lambda h: int(ipaddress.ip_address(h["ip"])) if h["ip"] else 1 << 33)
    return {"hosts": hosts, "notes": [] if hosts else ["No IP or MAC addresses found in that text."]}
