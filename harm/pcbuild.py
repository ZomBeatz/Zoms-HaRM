"""PC builder: parts library (BuildCores OpenDB + custom parts), spec
normalisation, and build compatibility checks.

Library data: BuildCores OpenDB, https://github.com/buildcores/buildcores-open-db,
licensed CC BY-NC-SA 4.0 (personal / non-commercial use). It is downloaded on
demand into the local database and is not shipped with HaRM.

    python -m harm.pcbuild update                 # download latest and import
    python -m harm.pcbuild update --file x.tar.gz # import a downloaded snapshot
"""

import json
import math
import os
import re
import sqlite3
import tarfile
import tempfile
import threading
import time
import urllib.request
from collections import defaultdict

OPENDB_TARBALL = "https://codeload.github.com/buildcores/buildcores-open-db/tar.gz/refs/heads/main"
OPENDB_COMMIT_API = "https://api.github.com/repos/buildcores/buildcores-open-db/commits/main"
OPENDB_ATTRIBUTION = ("Parts data from BuildCores OpenDB (github.com/buildcores/buildcores-open-db), "
                      "licensed CC BY-NC-SA 4.0. Normalised into HaRM's spec format.")
MAX_DOWNLOAD = 300 * 1024 * 1024
MAX_PART_FILE = 2 * 1024 * 1024

# OpenDB folder -> HaRM build category
OPENDB_DIRS = {
    "CPU": "cpu", "CPUCooler": "cooler", "Motherboard": "motherboard", "RAM": "memory",
    "Storage": "storage", "GPU": "gpu", "PCCase": "case", "PSU": "psu", "CaseFan": "fan",
    "NetworkCard": "nic",
}

CATEGORIES = [
    ("cpu", "CPU"), ("cooler", "CPU Cooler"), ("motherboard", "Motherboard"), ("memory", "Memory"),
    ("storage", "Storage"), ("gpu", "Video Card"), ("case", "Case"), ("psu", "Power Supply"),
    ("fan", "Case Fans"), ("nic", "Network / Expansion Card"), ("other", "Other"),
]
CATEGORY_KEYS = {k for k, _ in CATEGORIES}
SINGLE = {"cpu", "cooler", "motherboard", "case", "psu"}  # one per build (normally)

# Spec fields per category: (key, label, type). Types: num, text, bool, list, m2.
SPEC_FIELDS = {
    "cpu": [("socket", "Socket", "text"), ("cores", "Cores", "num"), ("threads", "Threads", "num"),
            ("base_ghz", "Base clock (GHz)", "num"), ("boost_ghz", "Boost clock (GHz)", "num"),
            ("tdp", "TDP (W)", "num"), ("memory_types", "Memory types", "list"),
            ("max_memory_gb", "Max memory (GB)", "num"), ("igpu", "Integrated graphics", "text"),
            ("includes_cooler", "Cooler included", "bool"), ("ecc", "ECC support", "bool")],
    "motherboard": [("socket", "Socket", "text"), ("form_factor", "Form factor", "text"),
                    ("chipset", "Chipset", "text"), ("ram_type", "Memory type", "text"),
                    ("ram_slots", "Memory slots", "num"), ("max_memory_gb", "Max memory (GB)", "num"),
                    ("m2_slots", "M.2 slots (sizes, comma-separated per slot)", "m2"),
                    ("sata_ports", "SATA ports", "num"), ("pcie_x16", "PCIe x16 slots", "num"),
                    ("pcie_other", "Other PCIe slots", "num"), ("ethernet", "Onboard Ethernet", "text"),
                    ("ecc", "ECC support", "bool")],
    "memory": [("ram_type", "Type", "text"), ("form_factor", "Form factor (DIMM / SO-DIMM)", "text"),
               ("modules", "Modules in kit", "num"), ("module_gb", "GB per module", "num"),
               ("speed", "Speed (MT/s)", "num"), ("cas", "CAS latency", "num"),
               ("ecc", "ECC", "bool"), ("registered", "Registered (RDIMM)", "bool")],
    "storage": [("storage_type", "Type (SSD / HDD)", "text"), ("capacity_gb", "Capacity (GB)", "num"),
                ("form_factor", "Form factor", "text"), ("interface", "Interface", "text"),
                ("nvme", "NVMe", "bool")],
    "gpu": [("chipset", "GPU", "text"), ("vram_gb", "Memory (GB)", "num"), ("tdp", "TDP (W)", "num"),
            ("length_mm", "Length (mm)", "num"), ("slot_width", "Slot width", "num"),
            ("power_8pin", "8-pin power connectors", "num"), ("power_6pin", "6-pin power connectors", "num"),
            ("power_12v", "12VHPWR / 12V-2x6 connectors", "num")],
    "case": [("form_factor", "Type", "text"), ("mb_form_factors", "Motherboards supported", "list"),
             ("psu_form_factors", "PSU form factors", "list"), ("psu_included", "PSU included", "bool"),
             ("max_gpu_mm", "Max GPU length (mm)", "num"), ("max_cooler_mm", "Max CPU cooler height (mm)", "num"),
             ("max_psu_mm", "Max PSU length (mm)", "num"), ("bays_35", '3.5" bays', "num"),
             ("bays_25", '2.5" bays', "num"), ("expansion_slots", "Expansion slots", "num")],
    "psu": [("wattage", "Wattage (W)", "num"), ("form_factor", "Form factor", "text"),
            ("efficiency", "Efficiency", "text"), ("modular", "Modular", "text"),
            ("length_mm", "Length (mm)", "num"), ("conn_eps", "EPS 8-pin (CPU)", "num"),
            ("conn_8pin", "PCIe 6+2-pin", "num"), ("conn_12v", "12VHPWR / 12V-2x6", "num"),
            ("conn_sata", "SATA power", "num")],
    "cooler": [("sockets", "Sockets", "list"), ("height_mm", "Height (mm)", "num"),
               ("water_cooled", "Liquid (AIO)", "bool"), ("radiator_mm", "Radiator (mm)", "num"),
               ("tdp_rating", "Rated for (W)", "num")],
    "fan": [("size_mm", "Size (mm)", "num"), ("quantity", "Fans in pack", "num"), ("pwm", "PWM", "bool")],
    "nic": [("speed", "Speed", "text"), ("ports", "Ports", "num"), ("interface", "Interface", "text"),
            ("tdp", "Power (W)", "num")],
    "other": [("interface", "Interface", "text"), ("tdp", "Power (W)", "num")],
}

M2_STD = [2230, 2242, 2260, 2280, 22110, 2580, 25110]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _num(v):
    try:
        f = float(v)
        return None if math.isnan(f) else (int(f) if f == int(f) else f)
    except (TypeError, ValueError):
        return None


def _key(s) -> str:
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())


def socket_key(s) -> str:
    s = re.sub(r"^\s*\d+\s*x\s*", "", str(s or ""), flags=re.I)
    s = re.sub(r"\s*narrow\s*$", "", s, flags=re.I)
    k = _key(s)
    k = {"lga1151v2": "lga1151", "tr4": "str4"}.get(k, k)
    return k


def ff_key(s) -> str:
    k = _key(s)
    return {"matx": "microatx", "uatx": "microatx", "thinminiitx": "miniitx", "mitx": "miniitx",
            "extendedatx": "eatx", "atxeps": "atx", "sfxl": "sfxl"}.get(k, k)


def m2_sizes(s) -> list[int]:
    """'2242-2260' / '2242/2260/2280' / 'M.2-2280' -> list of sizes."""
    nums = [int(n) for n in re.findall(r"\d{4,5}", str(s or ""))]
    out = set(nums)
    if "-" in str(s) and len(nums) == 2:
        lo, hi = nums
        width = str(lo)[:2]
        ln = lambda n: int(str(n)[2:])
        for std in M2_STD:
            if str(std)[:2] == width and ln(lo) <= ln(std) <= ln(hi):
                out.add(std)
    return sorted(out)


def _gb(text) -> float | None:
    m = re.search(r"(\d+(?:\.\d+)?)\s*(TB|GB|G|T)\b", str(text or ""), re.I)
    if not m:
        return None
    v = float(m.group(1))
    return v * 1000 if m.group(2).upper().startswith("T") else v


def _strip(d: dict) -> dict:
    return {k: v for k, v in d.items() if v not in (None, "", [], {})}


# ---------------------------------------------------------------------------
# OpenDB -> normalised specs
# ---------------------------------------------------------------------------

def normalize_opendb(cat: str, d: dict) -> dict:
    g = lambda *path, default=None: _dig(d, path, default)
    if cat == "cpu":
        igpu = g("specifications", "integratedGraphics", "model")
        s = {"socket": d.get("socket"), "cores": g("cores", "total"), "threads": g("cores", "threads"),
             "base_ghz": g("clocks", "performance", "base"), "boost_ghz": g("clocks", "performance", "boost"),
             "tdp": g("specifications", "tdp"), "ppt": g("specifications", "ppt") or None,
             "memory_types": g("specifications", "memory", "types") or [],
             "max_memory_gb": g("specifications", "memory", "maxSupport"),
             "igpu": None if not igpu or str(igpu).lower() == "none" else igpu,
             "includes_cooler": bool(g("specifications", "includesCooler")),
             "ecc": bool(g("specifications", "eccSupport")), "series": d.get("series")}
    elif cat == "motherboard":
        pcie = d.get("pcie_slots") or []
        s = {"socket": d.get("socket"), "form_factor": d.get("form_factor"), "chipset": d.get("chipset"),
             "ram_type": g("memory", "ram_type"), "ram_slots": g("memory", "slots"),
             "max_memory_gb": g("memory", "max"),
             "m2_slots": [{"sizes": m2_sizes(m.get("size")), "interface": m.get("interface") or ""}
                          for m in d.get("m2_slots") or []],
             "sata_ports": (g("storage_devices", "sata_6_gb_s") or 0) + (g("storage_devices", "sata_3_gb_s") or 0),
             "pcie_x16": sum(p.get("quantity") or 0 for p in pcie if p.get("lanes") == 16),
             "pcie_other": sum(p.get("quantity") or 0 for p in pcie if p.get("lanes") != 16),
             "pcie_slots": pcie,
             "ethernet": ", ".join(e.get("speed", "") for e in d.get("onboard_ethernet") or [] if e.get("speed")),
             "ecc": bool(d.get("ecc_support"))}
    elif cat == "memory":
        ff = d.get("form_factor") or ""
        s = {"ram_type": d.get("ram_type"), "form_factor": "SO-DIMM" if "so" in ff.lower() else "DIMM",
             "pins": ff, "modules": g("modules", "quantity"), "module_gb": g("modules", "capacity_gb"),
             "capacity_gb": d.get("capacity"), "speed": d.get("speed"), "cas": d.get("cas_latency"),
             "ecc": d.get("ecc") == "ECC", "registered": d.get("registered") == "Registered"}
    elif cat == "storage":
        s = {"storage_type": d.get("storage_type"), "capacity_gb": d.get("capacity"),
             "form_factor": d.get("form_factor"), "interface": d.get("interface"), "nvme": bool(d.get("nvme"))}
    elif cat == "gpu":
        pc = d.get("power_connectors") or {}
        s = {"chipset": d.get("chipset"), "chipset_manufacturer": d.get("chipset_manufacturer"),
             "vram_gb": d.get("memory"), "memory_type": d.get("memory_type"), "tdp": d.get("tdp"),
             "length_mm": d.get("length"), "slot_width": d.get("total_slot_width") or d.get("case_expansion_slot_width"),
             "interface": d.get("interface"),
             "power_8pin": pc.get("pcie_8_pin") or 0, "power_6pin": pc.get("pcie_6_pin") or 0,
             "power_12v": (pc.get("pcie_12VHPWR") or 0) + (pc.get("pcie_12V_2x6") or 0)}
    elif cat == "case":
        s = {"form_factor": d.get("form_factor"),
             "mb_form_factors": d.get("supported_motherboard_form_factors") or [],
             "psu_form_factors": d.get("supported_power_supply_form_factors") or [],
             "psu_included": bool(d.get("power_supply_included")),
             "max_gpu_mm": d.get("max_video_card_length"), "max_cooler_mm": d.get("max_cpu_cooler_height"),
             "max_psu_mm": d.get("max_psu_length"), "bays_35": d.get("internal_3_5_bays"),
             "bays_25": d.get("internal_2_5_bays"), "expansion_slots": d.get("expansion_slots")}
    elif cat == "psu":
        c = d.get("connectors") or {}
        s = {"wattage": d.get("wattage"), "form_factor": d.get("form_factor"),
             "efficiency": d.get("efficiency_rating"), "modular": d.get("modular"), "length_mm": d.get("length"),
             "conn_eps": c.get("eps_8_pin"), "conn_8pin": c.get("pcie_6_plus_2_pin"),
             "conn_12v": c.get("pcie_12vhpwr"), "conn_sata": c.get("sata")}
    elif cat == "cooler":
        s = {"sockets": d.get("cpu_sockets") or [], "height_mm": d.get("height"),
             "water_cooled": bool(d.get("water_cooled")), "radiator_mm": d.get("radiator_size") or None,
             "fanless": bool(d.get("fanless"))}
    elif cat == "fan":
        s = {"size_mm": d.get("size"), "quantity": d.get("quantity"), "pwm": bool(d.get("pwm"))}
    elif cat == "nic":
        name = g("metadata", "name") or ""
        s = _nic_from_name(name)
    else:
        s = {}
    return _strip(s)


def _nic_from_name(name: str) -> dict:
    s = {}
    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:G|Gb|Gbe|Gbps|Gb/s|Gigabit)\b", name, re.I)
    if m:
        s["speed"] = f"{m.group(1)} Gb/s"
    elif re.search(r"gigabit", name, re.I):
        s["speed"] = "1 Gb/s"
    m = re.search(r"(\d+)\s*x\s*(?:\d|Gigabit|SFP|RJ)", name, re.I)
    if m:
        s["ports"] = int(m.group(1))
    m = re.search(r"PCIe?\s*(?:\d\.\d\s*)?x\s*(\d+)", name, re.I)
    if m:
        s["interface"] = f"PCIe x{m.group(1)}"
    return s


def _dig(d, path, default=None):
    for p in path:
        if not isinstance(d, dict):
            return default
        d = d.get(p)
    return default if d is None else d


# ---------------------------------------------------------------------------
# Inventory components -> build category + specs
# ---------------------------------------------------------------------------

COMPONENT_CATEGORY = {
    "hdd": "storage", "ssd": "storage", "nvmessd": "storage", "usbflash": "storage",
    "ram": "memory", "cpu": "cpu", "gpu": "gpu", "psu": "psu", "motherboard": "motherboard",
    "coolerfan": "cooler", "nic": "nic", "transceiversfp": "nic",
}


def component_category(comp: dict, catalog_cat: str | None = None) -> str:
    if catalog_cat:
        return catalog_cat
    return COMPONENT_CATEGORY.get(_key(comp.get("category")), "other")


def infer_component_specs(comp: dict, catalog_specs: dict | None = None) -> dict:
    cat = component_category(comp)
    iface, ff, cap = comp.get("interface") or "", comp.get("form_factor") or "", comp.get("capacity") or ""
    both = f"{iface} {ff}"
    s: dict = {}
    if cat == "memory":
        m = re.search(r"DDR\d", both, re.I)
        s = {"ram_type": m.group(0).upper() if m else None,
             "form_factor": "SO-DIMM" if re.search(r"so-?dimm", both, re.I) else "DIMM",
             "modules": 1, "module_gb": _gb(cap), "capacity_gb": _gb(cap),
             "registered": bool(re.search(r"rdimm|registered|lrdimm", both, re.I)),
             "speed": _num(re.sub(r"\D", "", comp.get("speed") or "")[:5]) if comp.get("speed") else None}
    elif cat == "cpu":
        m = re.search(r"LGA\s?\d{3,4}(?:-\d)?|AM\d\+?|sTRX?\d|SP\d|TR4|FM\d\+?", both, re.I)
        s = {"socket": m.group(0) if m else None}
    elif cat == "storage":
        k = _key(both)
        size = re.search(r"(22\d{2,3}|2230|2242)", ff)
        s = {"storage_type": "HDD" if _key(comp.get("category")) == "hdd" else "SSD",
             "capacity_gb": _gb(cap),
             "form_factor": f"M.2-{size.group(1)}" if "m2" in k and size else (ff or None),
             "interface": iface or None, "nvme": "nvme" in k}
    elif cat == "psu":
        m = re.search(r"(\d{3,4})\s*W", cap, re.I)
        s = {"wattage": int(m.group(1)) if m else None}
    elif cat == "nic":
        s = {"interface": iface or None}
    return {**_strip(s), **(catalog_specs or {})}


def component_fields_from_catalog(cat: str, name: str, manufacturer: str | None,
                                  part_numbers: str | None, specs: dict) -> dict:
    """Map a library part to HaRM's inventory component fields/vocabulary."""
    model = name
    if manufacturer and model.lower().startswith(manufacturer.lower()):
        model = model[len(manufacturer):].strip()
    f = {"manufacturer": manufacturer, "model": model[:200],
         "part_number": (part_numbers or "").split(",")[0].strip() or None}
    if cat == "memory":
        t = specs.get("ram_type") or "DDR"
        f.update(category="RAM", capacity=f"{_fmt_gb(specs.get('module_gb'))}" if specs.get("module_gb") else None,
                 interface=f"{t} {'SODIMM' if specs.get('form_factor') == 'SO-DIMM' else ('RDIMM' if specs.get('registered') else 'DIMM')}",
                 form_factor="SODIMM" if specs.get("form_factor") == "SO-DIMM" else "DIMM",
                 speed=f"{specs['speed']} MT/s" if specs.get("speed") else None)
    elif cat == "storage":
        k = _key(specs.get("interface"))
        sizes = m2_sizes(specs.get("form_factor"))
        if "nvme" in k or specs.get("nvme") or ("m2" in k and "pcie" in k):
            iface = "NVMe M.2 (M-key)"
        elif "m2" in k:
            iface = "M.2 SATA (B+M key)"
        elif k.startswith("sas"):
            iface = "SAS3 (12Gb)" if "12" in k else "SAS2 (6Gb)"
        elif k.startswith("sata"):
            iface = "SATA III"
        else:
            iface = specs.get("interface")
        ff = f"M.2 {sizes[0]}" if sizes and "m2" in _key(specs.get("form_factor")) else specs.get("form_factor")
        f.update(category="NVMe SSD" if iface == "NVMe M.2 (M-key)" else
                 ("HDD" if (specs.get("storage_type") or "").upper() == "HDD" else "SSD"),
                 capacity=_fmt_gb(specs.get("capacity_gb")), interface=iface, form_factor=ff)
    elif cat == "cpu":
        f.update(category="CPU", interface=specs.get("socket"),
                 speed=f"{specs['boost_ghz']} GHz boost" if specs.get("boost_ghz") else None,
                 capacity=f"{specs['cores']}C/{specs.get('threads') or specs['cores']}T" if specs.get("cores") else None)
    elif cat == "gpu":
        f.update(category="GPU", interface="PCIe x16", capacity=f"{specs['vram_gb']} GB" if specs.get("vram_gb") else None,
                 form_factor=f"{specs['length_mm']} mm" if specs.get("length_mm") else None)
    elif cat == "psu":
        f.update(category="PSU", capacity=f"{specs['wattage']} W" if specs.get("wattage") else None,
                 form_factor=specs.get("form_factor"), speed=specs.get("efficiency"))
    elif cat == "motherboard":
        # No interface: a board doesn't occupy a slot (its socket would otherwise count as a CPU).
        f.update(category="Motherboard", form_factor=specs.get("form_factor"),
                 speed=" ".join(x for x in (specs.get("socket"), specs.get("chipset")) if x) or None)
    elif cat in ("cooler", "fan"):
        f.update(category="Cooler / Fan",
                 form_factor=f"{specs['size_mm']} mm" if specs.get("size_mm") else (f"{specs['radiator_mm']} mm radiator" if specs.get("radiator_mm") else None))
    elif cat == "nic":
        f.update(category="NIC", interface=specs.get("interface"), speed=specs.get("speed"))
    else:
        f.update(category="Other", interface=specs.get("interface"))
    return {k: v for k, v in f.items() if v not in (None, "")}


def _fmt_gb(gb) -> str | None:
    if not gb:
        return None
    return f"{gb / 1000:g} TB" if gb >= 1000 else f"{gb:g} GB"


# ---------------------------------------------------------------------------
# Display summary
# ---------------------------------------------------------------------------

def summarize(cat: str, s: dict) -> str:
    j = lambda *xs: " · ".join(str(x) for x in xs if x not in (None, "", 0, False))
    if cat == "cpu":
        ct = f"{s['cores']}C/{s.get('threads') or s['cores']}T" if s.get("cores") else None
        return j(s.get("socket"), ct, f"{s['boost_ghz']} GHz" if s.get("boost_ghz") else None,
                 f"{s['tdp']} W" if s.get("tdp") else None, "/".join(s.get("memory_types") or []) or None,
                 "iGPU" if s.get("igpu") else "no iGPU" if "igpu" in s or s.get("socket") else None)
    if cat == "motherboard":
        return j(s.get("socket"), s.get("form_factor"), s.get("chipset"),
                 f"{s.get('ram_type')} ×{s['ram_slots']}" if s.get("ram_slots") else s.get("ram_type"),
                 f"{len(s['m2_slots'])}× M.2" if s.get("m2_slots") else None,
                 f"{s['sata_ports']}× SATA" if s.get("sata_ports") else None)
    if cat == "memory":
        kit = f"{s['modules']}×{s['module_gb']:g} GB" if s.get("modules") and s.get("module_gb") else _fmt_gb(s.get("capacity_gb"))
        return j(f"{s.get('ram_type')}-{s['speed']}" if s.get("speed") else s.get("ram_type"), kit,
                 f"CL{s['cas']}" if s.get("cas") else None, s.get("form_factor") if s.get("form_factor") != "DIMM" else None,
                 "ECC" if s.get("ecc") else None, "RDIMM" if s.get("registered") else None)
    if cat == "storage":
        return j(_fmt_gb(s.get("capacity_gb")), s.get("form_factor"), s.get("interface"),
                 "NVMe" if s.get("nvme") and "nvme" not in str(s.get("interface")).lower() else None)
    if cat == "gpu":
        return j(s.get("chipset"), f"{s['vram_gb']} GB" if s.get("vram_gb") else None,
                 f"{s['tdp']} W" if s.get("tdp") else None, f"{s['length_mm']} mm" if s.get("length_mm") else None)
    if cat == "case":
        return j(s.get("form_factor"), f"GPU ≤{s['max_gpu_mm']} mm" if s.get("max_gpu_mm") else None,
                 f"cooler ≤{s['max_cooler_mm']} mm" if s.get("max_cooler_mm") else None,
                 "PSU included" if s.get("psu_included") else None)
    if cat == "psu":
        return j(f"{s['wattage']} W" if s.get("wattage") else None, s.get("form_factor"), s.get("efficiency"), s.get("modular"))
    if cat == "cooler":
        kind = f"AIO {s['radiator_mm']} mm" if s.get("water_cooled") and s.get("radiator_mm") else ("AIO" if s.get("water_cooled") else "Air")
        return j(kind, f"{s['height_mm']} mm tall" if s.get("height_mm") and not s.get("water_cooled") else None,
                 f"{len(s.get('sockets') or [])} sockets" if s.get("sockets") else None)
    if cat == "fan":
        return j(f"{s['size_mm']} mm" if s.get("size_mm") else None, f"{s['quantity']}-pack" if (s.get("quantity") or 1) > 1 else None, "PWM" if s.get("pwm") else None)
    return j(s.get("speed"), s.get("interface"), f"{s['ports']} ports" if s.get("ports") else None)


# ---------------------------------------------------------------------------
# Custom part spec validation
# ---------------------------------------------------------------------------

def clean_specs(cat: str, raw) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("specs must be an object")
    out = {}
    for key, _label, typ in SPEC_FIELDS.get(cat, []):
        v = raw.get(key)
        if v in (None, "", []):
            continue
        if typ == "num":
            n = _num(v)
            if n is None:
                raise ValueError(f"{_label} must be a number")
            out[key] = n
        elif typ == "bool":
            out[key] = v in (True, 1, "1", "true", "on", "yes")
        elif typ == "list":
            items = v if isinstance(v, list) else str(v).split(",")
            out[key] = [str(x).strip()[:60] for x in items if str(x).strip()][:40]
        elif typ == "m2":
            if isinstance(v, list):
                out[key] = [{"sizes": [int(x) for x in (m.get("sizes") or [])], "interface": str(m.get("interface") or "")[:60]}
                            for m in v if isinstance(m, dict)][:16]
            else:
                out[key] = [{"sizes": m2_sizes(part) or [2280], "interface": ""} for part in str(v).split(",") if part.strip()][:16]
        else:
            out[key] = str(v).strip()[:200]
    return out


def specs_for_form(cat: str, specs: dict) -> dict:
    """Specs as the custom-part form shows them (lists joined, M.2 as text)."""
    out = dict(specs)
    for key, _l, typ in SPEC_FIELDS.get(cat, []):
        v = specs.get(key)
        if typ == "list" and isinstance(v, list):
            out[key] = ", ".join(v)
        elif typ == "m2" and isinstance(v, list):
            out[key] = ", ".join("/".join(str(x) for x in m.get("sizes") or []) or "2280" for m in v)
    return out


# ---------------------------------------------------------------------------
# Compatibility
# ---------------------------------------------------------------------------

def estimate_power(items: list[dict]) -> int:
    w = 0.0
    for it in items:
        s, q, cat = it["specs"], it["qty"], it["category"]
        if cat == "cpu":
            w += (s.get("ppt") or (s.get("tdp") or 65) * 1.3) * q
        elif cat == "gpu":
            w += (s.get("tdp") or 150) * q
        elif cat == "motherboard":
            w += 50
        elif cat == "memory":
            w += 4 * (s.get("modules") or 1) * q
        elif cat == "storage":
            w += (9 if (s.get("storage_type") or "").upper() == "HDD" else 5) * q
        elif cat == "fan":
            w += 3 * (s.get("quantity") or 1) * q
        elif cat == "cooler":
            w += 15 if s.get("water_cooled") else 5
        elif cat in ("nic", "other"):
            w += (s.get("tdp") or 12) * q
    return int(round(w))


def check_build(items: list[dict]) -> tuple[list[dict], dict]:
    """items: [{id, category, name, qty, specs}] -> (checks, stats).
    Each check: {level: error|warn|info|ok, message, items: [ids]}."""
    checks: list[dict] = []

    def add(level, msg, *its):
        checks.append({"level": level, "message": msg, "items": [i["id"] for i in its if i]})

    by = defaultdict(list)
    for it in items:
        by[it["category"]].append(it)
    first = lambda c: by[c][0] if by[c] else None
    cpu, mb, case, psu, cooler = first("cpu"), first("motherboard"), first("case"), first("psu"), first("cooler")
    S = lambda it: it["specs"] if it else {}

    dual_socket = bool(mb and re.match(r"\s*2\s*x", str(S(mb).get("socket") or ""), re.I))
    for c, label in (("cpu", "CPUs"), ("motherboard", "motherboards"), ("case", "cases"), ("psu", "power supplies"), ("cooler", "CPU coolers")):
        n = sum(i["qty"] for i in by[c])
        if n > 1 and not (c in ("cpu", "cooler") and dual_socket and n == 2):
            add("warn", f"This build has {n} {label}. Only one is normally used.", *by[c])

    # --- CPU ↔ motherboard
    if cpu and mb and S(cpu).get("socket") and S(mb).get("socket"):
        if socket_key(S(cpu)["socket"]) != socket_key(S(mb)["socket"]):
            add("error", f"CPU socket {S(cpu)['socket']} doesn't match the motherboard socket {S(mb)['socket']}.", cpu, mb)
        else:
            add("ok", f"CPU and motherboard share socket {S(mb)['socket']}.", cpu, mb)

    # --- cooler
    sock = S(cpu).get("socket") or S(mb).get("socket")
    if cooler:
        socks = S(cooler).get("sockets") or []
        if sock and socks:
            if socket_key(sock) not in {socket_key(x) for x in socks}:
                add("error", f"The CPU cooler doesn't list support for socket {sock}.", cooler, cpu or mb)
            else:
                add("ok", f"CPU cooler supports socket {sock}.", cooler)
    elif cpu:
        if S(cpu).get("includes_cooler"):
            add("info", "No cooler chosen: the CPU's included cooler will be used.", cpu)
        elif S(cpu):
            add("warn", "No CPU cooler: this CPU doesn't come with one.", cpu)

    # --- memory
    mems = by["memory"]
    if mems:
        types = {S(m).get("ram_type") for m in mems if S(m).get("ram_type")}
        if len(types) > 1:
            add("error", f"Mixed memory types in the build: {', '.join(sorted(types))}.", *mems)
        mtype = next(iter(types)) if len(types) == 1 else None
        if mtype and mb and S(mb).get("ram_type") and _key(S(mb)["ram_type"]) != _key(mtype):
            add("error", f"{mtype} memory won't fit a {S(mb)['ram_type']} motherboard.", mb, *mems)
        elif mtype and mb and S(mb).get("ram_type"):
            add("ok", f"Memory type {mtype} matches the motherboard.", mb, *mems)
        cpu_types = S(cpu).get("memory_types") or []
        if mtype and cpu_types and _key(mtype) not in {_key(t) for t in cpu_types}:
            add("error", f"The CPU supports {'/'.join(cpu_types)}, not {mtype}.", cpu, *mems)
        sodimm = [m for m in mems if S(m).get("form_factor") == "SO-DIMM"]
        if sodimm and mb and "itx" not in ff_key(S(mb).get("form_factor")) and S(mb).get("form_factor"):
            add("error", "SO-DIMM (laptop-size) memory doesn't fit desktop DIMM slots.", mb, *sodimm)
        elif sodimm and mb:
            add("warn", "SO-DIMM memory: make sure this board actually has SO-DIMM slots.", mb, *sodimm)
        modules = sum((S(m).get("modules") or 1) * m["qty"] for m in mems)
        total_gb = sum((S(m).get("capacity_gb") or (S(m).get("module_gb") or 0) * (S(m).get("modules") or 1)) * m["qty"] for m in mems)
        if mb and S(mb).get("ram_slots"):
            if modules > S(mb)["ram_slots"]:
                add("error", f"{modules} memory modules but the motherboard has {S(mb)['ram_slots']} slots.", mb, *mems)
            else:
                add("ok", f"{modules} of {S(mb)['ram_slots']} memory slots used.", mb, *mems)
        if total_gb and mb and S(mb).get("max_memory_gb") and total_gb > S(mb)["max_memory_gb"]:
            add("error", f"{total_gb:g} GB of memory exceeds the motherboard's {S(mb)['max_memory_gb']} GB maximum.", mb, *mems)
        if total_gb and cpu and S(cpu).get("max_memory_gb") and total_gb > S(cpu)["max_memory_gb"]:
            add("warn", f"{total_gb:g} GB exceeds the CPU's rated {S(cpu)['max_memory_gb']} GB maximum.", cpu, *mems)
        if any(S(m).get("registered") for m in mems) and mb and not S(mb).get("ecc"):
            add("warn", "Registered (RDIMM) memory needs a server/workstation board; most desktop boards won't boot with it.", mb, *mems)
        if any(S(m).get("ecc") for m in mems) and ((cpu and not S(cpu).get("ecc")) or (mb and not S(mb).get("ecc"))):
            add("info", "ECC memory will run without error correction unless both the CPU and motherboard support ECC.", *mems)
        speeds = {S(m).get("speed") for m in mems if S(m).get("speed")}
        if len(speeds) > 1:
            add("info", f"Mixed memory speeds; all modules will run at the slowest ({min(speeds)} MT/s).", *mems)
        if len(mems) > 1 or any(m["qty"] > 1 for m in mems):
            add("info", "Mixing separate memory kits can be unstable; one matched kit is safest.", *mems)

    # --- case
    if case and mb and S(case).get("mb_form_factors") and S(mb).get("form_factor"):
        ok = ff_key(S(mb)["form_factor"]) in {ff_key(x) for x in S(case)["mb_form_factors"]}
        add("ok" if ok else "error",
            f"The case {'supports' if ok else 'does not support'} {S(mb)['form_factor']} motherboards.", case, mb)
    for g in by["gpu"]:
        L, mx = S(g).get("length_mm"), S(case).get("max_gpu_mm")
        if L and mx:
            if L > mx:
                add("error", f"Video card is {L} mm long; the case fits up to {mx} mm.", g, case)
            elif L > mx - 10:
                add("warn", f"Video card ({L} mm) only just fits the case ({mx} mm max). Check front fans/radiators.", g, case)
            else:
                add("ok", f"Video card length {L} mm fits (case max {mx} mm).", g, case)
    if cooler and case:
        hgt, mx = S(cooler).get("height_mm"), S(case).get("max_cooler_mm")
        if S(cooler).get("water_cooled"):
            if S(cooler).get("radiator_mm"):
                add("info", f"Check the case has room for a {S(cooler)['radiator_mm']} mm radiator (not in the library data).", cooler, case)
        elif hgt and mx:
            add("error" if hgt > mx else "ok",
                f"CPU cooler is {hgt} mm tall; the case allows {mx} mm.", cooler, case)

    # --- PSU
    if case and psu and S(case).get("psu_included"):
        add("warn", "The case already includes a power supply, and the build also has one.", case, psu)
    elif case and psu and S(case).get("psu_form_factors") and S(psu).get("form_factor"):
        cff = {ff_key(x) for x in S(case)["psu_form_factors"]}
        pff = ff_key(S(psu)["form_factor"])
        if pff in cff:
            add("ok", f"{S(psu)['form_factor']} power supply fits the case.", psu, case)
        elif pff in ("sfx", "sfxl") and "atx" in cff:
            add("warn", f"{S(psu)['form_factor']} power supply in an ATX case needs an SFX-to-ATX bracket.", psu, case)
        else:
            add("error", f"The case takes {', '.join(S(case)['psu_form_factors'])} power supplies, not {S(psu)['form_factor']}.", psu, case)
    if case and psu and S(psu).get("length_mm") and S(case).get("max_psu_mm") and S(psu)["length_mm"] > S(case)["max_psu_mm"]:
        add("error", f"Power supply is {S(psu)['length_mm']} mm long; the case fits {S(case)['max_psu_mm']} mm.", psu, case)

    est = estimate_power(items)
    rec = int(math.ceil(est * 1.3 / 50.0) * 50) if est else 0
    watt = S(psu).get("wattage")
    if psu and watt and est:
        if watt < est:
            add("error", f"Power supply ({watt} W) is below the estimated peak draw (~{est} W).", psu)
        elif watt < est * 1.25:
            add("warn", f"Power supply ({watt} W) has little headroom over the estimated ~{est} W. {rec} W+ recommended.", psu)
        else:
            add("ok", f"Power supply ({watt} W) covers the estimated ~{est} W with headroom.", psu)
    gpus = by["gpu"]
    if psu and gpus:
        need12 = sum((S(g).get("power_12v") or 0) * g["qty"] for g in gpus)
        need8 = sum(((S(g).get("power_8pin") or 0) + (S(g).get("power_6pin") or 0)) * g["qty"] for g in gpus)
        have12, have8 = S(psu).get("conn_12v"), S(psu).get("conn_8pin")
        if need12 and have12 is not None and have12 < need12:
            add("warn", "The video card uses a 12VHPWR/12V-2x6 connector the PSU doesn't have natively; use the adapter that comes with the card (needs spare PCIe 8-pins).", psu, *gpus)
        if need8 and have8 is not None and have8 < need8:
            add("warn", f"The video card needs {need8} PCIe power connectors; the PSU lists {have8}.", psu, *gpus)
    if mb and gpus and S(mb).get("pcie_x16") is not None:
        n = sum(g["qty"] for g in gpus)
        if n > max(S(mb)["pcie_x16"], 0):
            add("warn", f"{n} video cards but the motherboard has {S(mb)['pcie_x16']} full-length (x16) slots.", mb, *gpus)

    # --- storage
    drives = by["storage"]
    m2 = [d for d in drives for _ in range(d["qty"]) if "m2" in _key(S(d).get("form_factor")) or "m2" in _key(S(d).get("interface"))]
    sata = [d for d in drives for _ in range(d["qty"]) if "sata" in _key(S(d).get("interface")) and "m2" not in _key(S(d).get("interface")) and "m2" not in _key(S(d).get("form_factor"))]
    sas = [d for d in drives if "sas" in _key(S(d).get("interface"))]
    if m2 and mb and "m2_slots" in S(mb):
        slots = [set(s.get("sizes") or [2280]) for s in S(mb)["m2_slots"]]
        left = list(slots)
        fails = []
        for d in sorted(m2, key=lambda d: len([s for s in slots if (m2_sizes(S(d).get("form_factor")) or [2280])[0] in s])):
            size = (m2_sizes(S(d).get("form_factor")) or [2280])[0]
            hit = next((s for s in left if size in s), None)
            if hit is None:
                fails.append(d)
            else:
                left.remove(hit)
        if fails:
            add("error", f"Not enough suitable M.2 slots: {len(m2)} M.2 drive(s), board has {len(slots)} slot(s)"
                + (" of matching size." if len(m2) <= len(slots) else "."), mb, *fails)
        else:
            add("ok", f"{len(m2)} M.2 drive(s) fit the board's {len(slots)} M.2 slot(s).", mb, *m2)
    if sata and mb and S(mb).get("sata_ports") is not None:
        if len(sata) > S(mb)["sata_ports"]:
            add("error", f"{len(sata)} SATA drives but the motherboard has {S(mb)['sata_ports']} SATA ports. Add an HBA or SATA card.", mb, *sata)
        else:
            add("ok", f"{len(sata)} of {S(mb)['sata_ports']} SATA ports used.", mb, *sata)
    if sas and not any(re.search(r"hba|sas|raid|lsi|broadcom", (i["name"] or ""), re.I) for i in by["nic"] + by["other"]):
        add("warn", "SAS drives need an HBA or RAID card; none is in the build.", *sas)
    n35 = sum(d["qty"] for d in drives if '3.5' in str(S(d).get("form_factor")))
    if case and n35 and S(case).get("bays_35") is not None and n35 > S(case)["bays_35"]:
        add("warn", f'{n35} 3.5" drives but the case lists {S(case)["bays_35"]} 3.5" bays.', case)

    # --- graphics output
    if cpu and not gpus and S(cpu) and not S(cpu).get("igpu"):
        add("warn", "No video output: this CPU has no integrated graphics and there's no video card (fine for a headless server with IPMI).", cpu)

    # --- missing / unknown
    have = {it["category"] for it in items}
    for c, label in (("cpu", "CPU"), ("motherboard", "motherboard"), ("memory", "memory"), ("storage", "storage"), ("case", "case")):
        if c not in have:
            add("info", f"No {label} yet.")
    if "psu" not in have and not S(case).get("psu_included"):
        add("info", "No power supply yet.")
    for it in items:
        if not it["specs"] and it["category"] != "other":
            add("info", f"No specs for “{it['name']}”, so it can't be checked. Link it to a library part or add specs.", it)

    order = {"error": 0, "warn": 1, "info": 2, "ok": 3}
    checks.sort(key=lambda c: order[c["level"]])
    stats = {"est_watts": est, "recommended_psu": rec,
             "errors": sum(c["level"] == "error" for c in checks),
             "warnings": sum(c["level"] == "warn" for c in checks)}
    return checks, stats


def candidate_issues(items: list[dict], cand: dict) -> list[str]:
    """Errors a candidate part would introduce into the build."""
    base = [i for i in items if not (cand["category"] in SINGLE and i["category"] == cand["category"])]
    cand = {**cand, "id": "cand"}
    checks, _ = check_build(base + [cand])
    return [c["message"] for c in checks if c["level"] == "error" and "cand" in c["items"]]


# ---------------------------------------------------------------------------
# Library import
# ---------------------------------------------------------------------------

JOB: dict = {"running": False, "phase": None, "done": 0, "error": None, "finished_at": None}
_job_lock = threading.Lock()


def _upsert(conn, cat: str, d: dict) -> None:
    md = d.get("metadata") or {}
    name = (md.get("name") or "").strip()
    sid = d.get("opendb_id")
    if not name or not sid:
        return
    specs = normalize_opendb(cat, d)
    pns = ", ".join(str(p) for p in (md.get("part_numbers") or []) if p)[:500]
    year = md.get("releaseYear")
    year = year if isinstance(year, int) and 1980 <= year <= 2100 else None  # data has typos like 20117
    conn.execute(
        "INSERT INTO catalog_parts (source, source_id, category, name, manufacturer, part_numbers, release_year, specs) "
        "VALUES ('opendb', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source, source_id) DO UPDATE SET "
        "category = excluded.category, name = excluded.name, manufacturer = excluded.manufacturer, "
        "part_numbers = excluded.part_numbers, release_year = excluded.release_year, specs = excluded.specs, "
        "updated_at = datetime('now')",
        (sid, cat, name[:300], (md.get("manufacturer") or "")[:100] or None, pns or None, year, json.dumps(specs)))


def import_tarball(conn: sqlite3.Connection, path: str, progress=None) -> int:
    """Stream-read an OpenDB tarball. Only JSON files under open-db/<Category>/ are
    parsed; nothing is written to disk and nothing in the archive is executed."""
    pat = re.compile(r"^[^/]+/open-db/(" + "|".join(OPENDB_DIRS) + r")/[A-Za-z0-9_-]+\.json$")
    n = 0
    with tarfile.open(path, "r:gz") as tf:
        for m in tf:
            if not m.isfile() or m.size > MAX_PART_FILE:
                continue
            mm = pat.match(m.name)
            if not mm:
                continue
            fh = tf.extractfile(m)
            if fh is None:
                continue
            try:
                d = json.loads(fh.read())
            except (ValueError, UnicodeDecodeError):
                continue
            if isinstance(d, dict):
                _upsert(conn, OPENDB_DIRS[mm.group(1)], d)
                n += 1
                if n % 1000 == 0:
                    conn.commit()
                    if progress:
                        progress(n)
    conn.commit()
    return n


def download_tarball(dest: str, progress=None) -> None:
    req = urllib.request.Request(OPENDB_TARBALL, headers={"User-Agent": "zoms-harm"})
    size = 0
    with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as out:
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_DOWNLOAD:
                raise RuntimeError("Download too large")
            out.write(chunk)
            if progress:
                progress(size)


def latest_commit() -> str | None:
    try:
        req = urllib.request.Request(OPENDB_COMMIT_API, headers={"User-Agent": "zoms-harm", "Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=15) as r:
            return (json.loads(r.read()).get("sha") or "")[:12] or None
    except Exception:
        return None


def run_update(connect, file: str | None = None) -> None:
    """Download (unless `file` given) and import. Updates JOB as it goes."""
    tmpdir = None
    try:
        path = file
        if path is None:
            tmpdir = tempfile.mkdtemp(prefix="harm-opendb-")
            path = os.path.join(tmpdir, "opendb.tar.gz")
            JOB.update(phase="downloading", done=0)
            download_tarball(path, lambda b: JOB.update(done=b))
        JOB.update(phase="importing", done=0)
        conn = connect()
        try:
            n = import_tarball(conn, path, lambda k: JOB.update(done=k))
            from . import db
            db.set_meta(conn, "catalog_source", json.dumps({
                "name": "BuildCores OpenDB", "ref": latest_commit() if file is None else os.path.basename(file),
                "imported": n, "at": time.strftime("%Y-%m-%d %H:%M:%S")}))
            conn.commit()
        finally:
            conn.close()
        JOB.update(phase="done", done=n, error=None)
    except Exception as e:  # surfaced to the UI
        JOB.update(phase="failed", error=str(e))
    finally:
        JOB.update(running=False, finished_at=time.time())
        if tmpdir:
            for f in os.listdir(tmpdir):
                os.remove(os.path.join(tmpdir, f))
            os.rmdir(tmpdir)


def start_update(connect) -> bool:
    with _job_lock:
        if JOB["running"]:
            return False
        JOB.update(running=True, phase="starting", done=0, error=None)
    threading.Thread(target=run_update, args=(connect,), daemon=True).start()
    return True


if __name__ == "__main__":
    import argparse
    from . import db
    ap = argparse.ArgumentParser(description="Manage HaRM's parts library")
    sub = ap.add_subparsers(dest="cmd", required=True)
    up = sub.add_parser("update", help="download BuildCores OpenDB and import it")
    up.add_argument("--file", help="import an already-downloaded .tar.gz instead")
    a = ap.parse_args()
    db.init()
    JOB["running"] = True
    run_update(db.connect, a.file)
    print(JOB["error"] or f"Imported {JOB['done']} parts. {OPENDB_ATTRIBUTION}")
