"""Parse output of the HaRM spec collectors (static/collect/) into HaRM records.

Returns {"device": {...}, "memory": [...], "disks": [...], "nics": [...], "gpus": [...]}
where memory/disks use inventory component field names.
"""

import json
import re

from .units import fmt_gb, snap_gb

JUNK = {"", "none", "not specified", "to be filled by o.e.m.", "default string", "system serial number",
        "system product name", "0", "00000000", "unknown", "o.e.m.", "not available", "123456789"}


def _clean(v) -> str | None:
    s = re.sub(r"\s+", " ", str(v or "")).strip()
    return None if s.lower() in JUNK else s


def _mem_capacity(size: str | None, size_bytes=None) -> str | None:
    if size_bytes:
        return fmt_gb(round(int(size_bytes) / 1073741824))
    m = re.match(r"(\d+)\s*(GB|MB|TB)", str(size or ""), re.I)
    if not m:
        return None
    n, u = int(m.group(1)), m.group(2).upper()
    return fmt_gb(n / 1024 if u == "MB" else n * 1000 if u == "TB" else n)


def _dimm_interface(typ: str | None, form: str | None, part: str | None) -> str | None:
    t = _clean(typ)
    if not t or not t.upper().startswith(("DDR", "LPDDR")):
        return None
    t = t.upper()
    if re.search(r"so-?dimm", str(form or ""), re.I):
        return f"{t} SODIMM"
    reg = bool(re.search(r"(R|L)DIMM|-?[0-9]R[0-9]?[- ]|registered", str(part or ""), re.I))
    return f"{t} {'RDIMM' if reg else 'DIMM'}"


def _group_dimms(dimms: list[dict]) -> list[dict]:
    """Identical modules (same part/size/type) become one component with a quantity."""
    groups: dict = {}
    for d in dimms:
        key = (d.get("manufacturer"), d.get("part_number"), d.get("capacity"), d.get("interface"), d.get("speed"))
        g = groups.setdefault(key, {**d, "quantity": 0, "serials": []})
        g["quantity"] += 1
        if d.get("serial"):
            g["serials"].append(d["serial"])
    out = []
    for g in groups.values():
        serials = g.pop("serials")
        g["serial"] = serials[0] if len(serials) == 1 else None
        if len(serials) > 1:
            g["notes"] = "Serials: " + ", ".join(serials)
        g.pop("slot", None)
        out.append(g)
    return out


def _disk(model, serial, size_bytes, rotational=None, transport=None, media=None, vendor=None) -> dict | None:
    model = _clean(model)
    if not size_bytes or int(size_bytes) < 8e9:  # skip USB sticks, card readers, zram
        return None
    t = (transport or "").lower()
    k = f"{t} {(media or '').lower()} {(model or '').lower()}"
    nvme = "nvme" in k
    hdd = rotational is True or "hdd" in k or ("ssd" not in k and not nvme and rotational is None and "unspecified" not in k and media and "hdd" in media.lower())
    if nvme:
        cat, iface, ff = "NVMe SSD", "NVMe M.2 (M-key)", "M.2 2280"
    elif hdd:
        cat, iface, ff = "HDD", "SAS" if "sas" in k else "SATA III", None
    else:
        cat, iface, ff = "SSD", "SAS" if "sas" in k else "SATA III", None
    manufacturer = None
    for brand in ("Samsung", "WDC", "Western Digital", "Seagate", "Toshiba", "HGST", "Crucial", "Micron", "Kingston",
                  "Intel", "SanDisk", "SK hynix", "Hitachi", "Corsair", "Sabrent", "Solidigm", "KIOXIA", "ADATA"):
        if model and model.lower().startswith(brand.lower()):
            manufacturer = "Western Digital" if brand == "WDC" else brand
            model = model[len(brand):].strip() or model
            break
    return {"category": cat, "manufacturer": manufacturer or _clean(vendor), "model": model,
            "serial": _clean(serial), "capacity": fmt_gb(snap_gb(int(size_bytes) / 1e9)),
            "interface": iface, "form_factor": ff, "quantity": 1}


def _nic(name, mac, addrs, speed=None, dhcp=None) -> dict | None:
    mac = _clean(mac)
    if not mac or mac.replace(":", "").replace("-", "").strip("0") == "":
        return None
    v4 = [a for a in addrs if ":" not in a.split("/")[0]]
    v6 = [a for a in addrs if ":" in a.split("/")[0] and not a.lower().startswith("fe80")]
    ip, subnet = (v4[0].split("/") + [None])[:2] if v4 else (None, None)
    kind = "Wi-Fi" if re.match(r"(wl|wlan|wi-?fi)", name or "", re.I) else "Ethernet"
    sp = None
    if speed:
        m = re.search(r"(\d+(?:\.\d+)?)\s*(G|M)", str(speed), re.I)
        if m:
            v = float(m.group(1)) * (1000 if m.group(2).upper() == "G" else 1)
        else:
            v = float(speed) if str(speed).isdigit() else None
        if v and v > 0:
            sp = f"{v / 1000:g}G" if v >= 1000 else f"{v:g}M"
    return {"name": name, "kind": kind, "mac": mac.replace("-", ":").upper(), "ip": ip,
            "subnet": f"/{subnet}" if subnet else None, "ipv6": v6[0] if v6 else None, "speed": sp,
            "assignment": "DHCP" if str(dhcp).lower() in ("enabled", "true", "1") else None}


def _gpu(raw) -> dict | None:
    raw = _clean(raw)
    if not raw:
        return None
    m = re.search(r"\[([^\]]*(?:GeForce|Radeon|Quadro|Tesla|RTX|GTX|Arc|FirePro|Instinct)[^\]]*)\]", raw)
    name = m.group(1) if m else re.sub(r"\(rev [^)]*\)|\(R\)|\(TM\)", "", raw).strip()
    maker = next((v for k, v in (("nvidia", "NVIDIA"), ("amd", "AMD"), ("ati", "AMD"), ("intel", "Intel"),
                                 ("matrox", "Matrox"), ("aspeed", "ASPEED")) if k in raw.lower()), None)
    if maker and name.lower().startswith(maker.lower()):
        name = name[len(maker):].strip()
    integrated = bool(re.search(r"aspeed|matrox|uhd|iris|raphael|renoir|cezanne|phoenix|radeon (graphics|\d{3}m)|"
                                r"vega \d+ graphics|llvmpipe|virtual|qxl|vmware|basic display|hd graphics|g200", raw, re.I))
    return {"category": "GPU", "manufacturer": maker, "model": name, "interface": None if integrated else "PCIe x16",
            "quantity": 1, "integrated": integrated}


def parse(text: str) -> dict:
    text = (text or "").strip()
    start = text.find("{")
    if start < 0:
        raise ValueError("Paste the full output of the HaRM collector (it starts with {\"harm_collect\"…)")
    try:
        d = json.loads(text[start:text.rfind("}") + 1])
    except ValueError:
        raise ValueError("That isn't valid collector output. Copy everything it printed, from { to }.")
    if not isinstance(d, dict) or not d.get("harm_collect"):
        raise ValueError("That JSON didn't come from the HaRM collector")
    plat = d.get("platform")
    if plat == "macos":
        return _parse_macos(d)
    sysi, cpu = d.get("system") or {}, d.get("cpu") or {}
    out = {"platform": plat, "device": {}, "memory": [], "disks": [], "nics": [], "gpus": []}
    dev = out["device"]
    dev["hostname"] = _clean(d.get("hostname"))
    dev["os"] = _clean(d.get("os"))
    dev["manufacturer"] = _clean(sysi.get("manufacturer"))
    dev["model"] = _clean(sysi.get("product")) or _clean(sysi.get("board"))
    dev["serial"] = _clean(sysi.get("serial"))
    cpu_name = _clean(cpu.get("model"))
    if cpu_name:
        cpu_name = re.sub(r"\s+\d+-Core Processor$|\(R\)|\(TM\)|CPU\s+@.*$", "", cpu_name).strip()
        threads, sockets = cpu.get("threads") or 0, cpu.get("sockets") or 1
        cores = cpu.get("cores") or ((cpu.get("cores_per_socket") or 0) * sockets)
        dev["cpu"] = (f"{sockets}× " if sockets and sockets > 1 else "") + cpu_name + (f" ({cores}C/{threads}T)" if cores and threads else "")
        out["cpu_info"] = {"model": cpu_name, "sockets": sockets or 1,
                           "cores_each": (cores // sockets) if cores and sockets else None,
                           "threads_each": (threads // sockets) if threads and sockets else None}
    total = d.get("mem_total_bytes") or (d.get("mem_total_kb") or 0) * 1024
    dimms = []
    for m in d.get("dimms") or []:
        cap = _mem_capacity(m.get("size"), m.get("size_bytes"))
        if not cap:
            continue
        speed = m.get("speed")
        dimms.append({"category": "RAM", "manufacturer": _clean(m.get("manufacturer")),
                      "part_number": _clean(m.get("part")), "model": _clean(m.get("part")),
                      "serial": _clean(m.get("serial")), "capacity": cap,
                      "interface": _dimm_interface(m.get("type"), m.get("form"), m.get("part")),
                      "form_factor": "SODIMM" if re.search(r"so-?dimm", str(m.get("form")), re.I) else "DIMM",
                      "speed": f"{re.sub(r'[^0-9]', '', str(speed))} MT/s" if speed and re.search(r"\d", str(speed)) else None})
    out["memory"] = _group_dimms(dimms)
    installed = sum(float(re.match(r"[\d.]+", m["capacity"]).group(0)) * m["quantity"] for m in out["memory"]
                    if m["capacity"].endswith("GB"))
    if installed:
        typ = next((m["interface"].split()[0] for m in out["memory"] if m.get("interface")), "")
        dev["ram"] = f"{installed:g} GB {typ}".strip()
    elif total:
        # The OS reports usable memory (a bit under what's installed); snap to a real size.
        gib = total / 1073741824
        sizes = [1, 2, 3, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096]
        dev["ram"] = f"{next((x for x in sizes if gib <= x <= gib * 1.08), round(gib)):g} GB"
    # disks
    if plat == "windows":
        for x in d.get("disks") or []:
            k = _disk(x.get("model"), x.get("serial"), x.get("size_bytes"),
                      rotational=True if str(x.get("media")).upper() == "HDD" else (False if str(x.get("media")).upper() == "SSD" else None),
                      transport=x.get("bus"), media=x.get("media"))
            if k:
                out["disks"].append(k)
        for n in d.get("nics") or []:
            k = _nic(n.get("name"), n.get("mac"), (n.get("ipv4") or []) + (n.get("ipv6") or []), n.get("speed"), n.get("dhcp"))
            if k:
                out["nics"].append(k)
    else:
        for x in (d.get("lsblk") or {}).get("blockdevices") or []:
            if x.get("type") != "disk" or re.match(r"(zram|loop|ram|sr)", x.get("name") or ""):
                continue
            k = _disk(x.get("model"), x.get("serial"), x.get("size"), rotational=x.get("rota"),
                      transport=x.get("tran"), vendor=x.get("vendor"))
            if k:
                out["disks"].append(k)
        speeds = {l.get("name"): l.get("speed") for l in d.get("links") or []}
        physical = {l.get("name") for l in d.get("links") or [] if l.get("physical")}
        for i in d.get("ip") or []:
            name = i.get("ifname")
            if name == "lo" or (physical and name not in physical):
                continue
            addrs = [f"{a.get('local')}/{a.get('prefixlen')}" for a in i.get("addr_info") or [] if a.get("local")]
            dyn = any(a.get("dynamic") for a in i.get("addr_info") or [] if a.get("family") == "inet")
            k = _nic(name, i.get("address"), addrs, speeds.get(name), "true" if dyn else None)
            if k:
                out["nics"].append(k)
    out["gpus"] = [g for g in (_gpu(x) for x in d.get("gpus") or []) if g]
    if out["disks"]:
        total_gb = sum(float(re.match(r"[\d.]+", x["capacity"]).group(0)) * (1000 if x["capacity"].endswith("TB") else 1) for x in out["disks"])
        dev["storage_total"] = fmt_gb(total_gb)
    out["device"] = {k: v for k, v in dev.items() if v}
    return out


def _parse_macos(d: dict) -> dict:
    p = d.get("profile") or {}
    hw = (p.get("SPHardwareDataType") or [{}])[0]
    out = {"platform": "macos", "device": {}, "memory": [], "disks": [], "nics": [], "gpus": []}
    dev = out["device"]
    dev.update(hostname=_clean(d.get("hostname")), os=_clean(d.get("os")), manufacturer="Apple",
               model=_clean(hw.get("machine_name")) and f"{hw.get('machine_name')} ({hw.get('machine_model')})",
               serial=_clean(hw.get("serial_number")), cpu=_clean(hw.get("chip_type") or hw.get("cpu_type")),
               ram=_clean(hw.get("physical_memory")))
    for section in ("SPNVMeDataType", "SPSerialATADataType"):
        for ctrl in p.get(section) or []:
            for x in ctrl.get("_items") or []:
                k = _disk(x.get("device_model") or x.get("_name"), x.get("device_serial"), x.get("size_in_bytes"),
                          rotational=False if "nvme" in section.lower() or "ssd" in str(x.get("spsata_medium_type", "")).lower() else None,
                          transport="nvme" if section == "SPNVMeDataType" else "sata")
                if k:
                    out["disks"].append(k)
    for n in p.get("SPNetworkDataType") or []:
        eth = n.get("Ethernet") or {}
        addrs = [f"{a}/24" for a in (n.get("IPv4") or {}).get("Addresses") or []]
        k = _nic(n.get("interface") or n.get("_name"), eth.get("MAC Address"), addrs)
        if k:
            k["kind"] = "Wi-Fi" if "wi-fi" in str(n.get("_name")).lower() else k["kind"]
            out["nics"].append(k)
    for g in p.get("SPDisplaysDataType") or []:
        k = _gpu(g.get("sppci_model") or g.get("_name"))
        if k:
            out["gpus"].append(k)
    out["device"] = {k: v for k, v in dev.items() if v}
    return out
