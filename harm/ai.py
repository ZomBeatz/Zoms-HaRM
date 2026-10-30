"""AI Assist: a prompt you give any AI chat (with photos), and a parser for what it sends back.

HaRM never talks to an AI service itself. The user pastes the prompt and their photos into the
assistant they already use (ideally one with web search, for prices), then pastes the reply into
HaRM, which validates it and shows a preview before anything is saved.
"""

import json
import re
from datetime import date

from . import units
from .models import ENUMS

FORMAT_VERSION = 1
MAX_ITEMS = 300

DEVICE_TYPES = ENUMS["device_types"]
PART_CATEGORIES = ENUMS["component_categories"]
CONDITIONS = ENUMS["component_conditions"]


def build_prompt(hint: str = "", where: str = "", currency: str = "USD") -> str:
    today = date.today().isoformat()
    lines = [
        "You are helping me catalog computer and networking hardware into my inventory app, HaRM.",
        "I'm attaching photos. Identify every distinct piece of hardware you can see and research it.",
    ]
    if where:
        lines.append(f"Everything in these photos is stored at: {where}.")
    if hint.strip():
        lines.append(f"Context from me: {hint.strip()}")
    lines += [
        "",
        "For each item:",
        "1. Read labels exactly as printed: serial numbers (S/N, service tag), part numbers (P/N), model numbers, "
        "capacities. Never guess a serial or part number. If a label is unreadable, leave it empty and add a todo.",
        "2. Identify the manufacturer, model, and key specs (capacity, interface, form factor, speed, CPU/RAM for "
        "computers).",
        f"3. If you can browse the web: find the original list price when new (msrp), and today's typical used "
        f"price (market_value) from recent sold listings (eBay sold, etc.), both in {currency}. Cite the pages in "
        "\"sources\" and explain briefly in \"value_notes\". If you can't browse, give your best estimate and say so.",
        "4. Rate your confidence in the identification: high, medium or low.",
        "5. Add todos: concrete next steps for me, such as \"Scan the service tag on the rear pull-out tab\", "
        "\"Test drive health (SMART)\", \"Check which caddy it needs\", \"Photograph the label on the bottom\".",
        "6. Group identical items (same model, no individual serials visible) into one entry with a quantity.",
        "",
        "Reply with ONLY a JSON object in exactly this format (no extra text before or after it):",
        "```json",
        json.dumps({
            "harm_ai": FORMAT_VERSION,
            "summary": "One sentence about what's in the photos",
            "items": [{
                "type": "device or part",
                "name": "Short name, e.g. Dell PowerEdge R515 (devices only)",
                "category": "For devices: a device type; for parts: a part category (lists below)",
                "manufacturer": "", "model": "", "part_number": "", "serial": "",
                "quantity": 1,
                "capacity": "e.g. 4 TB, 16 GB (parts)", "interface": "e.g. SATA, SAS3 (12Gb), DDR4 RDIMM",
                "form_factor": "e.g. 3.5\", 2.5\", M.2 2280", "speed": "e.g. 7200 RPM, 2666 MT/s",
                "condition": "New, Used - Good, Used - Fair, Faulty or Unknown",
                "specs": {"cpu": "", "ram": "", "storage": "", "psu": "", "os": ""},
                "release_year": 2012,
                "msrp": 0, "market_value": 0, "currency": currency,
                "value_notes": "Where the numbers come from",
                "sources": ["https://..."],
                "confidence": "high, medium or low",
                "visible_labels": ["Text you read off labels"],
                "notes": "Anything else useful",
                "todo": ["Next steps for this item"],
            }],
            "todo": ["Next steps for the whole batch"],
        }, indent=2),
        "```",
        "Leave fields empty (\"\" or null) when they don't apply or you don't know. \"specs\" is only for "
        "devices (whole computers, servers, switches, NAS…).",
        "",
        "Device types: " + ", ".join(DEVICE_TYPES),
        "Part categories: " + ", ".join(PART_CATEGORIES),
        "Common interfaces: " + ", ".join(ENUMS["interfaces"][:24]),
        f"Today's date is {today}.",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------- parsing

def _extract_json(text: str) -> dict:
    text = text.strip()
    candidates = re.findall(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if "{" in text:
        candidates.append(text[text.index("{"): text.rindex("}") + 1])
    for c in candidates:
        for attempt in (c, _repair(c)):
            try:
                d = json.loads(attempt)
            except ValueError:
                continue
            if isinstance(d, dict):
                return d
    raise ValueError("Couldn't find the JSON in that reply. Paste the AI's whole answer (it starts with {\"harm_ai\"…).")


def _repair(c: str) -> str:
    """Fix the JSON slips AI replies commonly make."""
    c = c.replace("\u201c", '"').replace("\u201d", '"')            # “smart quotes”
    c = re.sub(r",\s*([}\]])", r"\1", c)                          # trailing commas
    c = re.sub(r'(?<=\d)"(?="\s*[,}\]])', r'\\"', c)               # 3.5"  (inch mark before the closing quote)
    c = re.sub(r'(?<=\d)"(?=\s*[A-Za-z(])', r'\\"', c)              # 2.5" SFF  (inch mark mid-string)
    return c


def _s(v, n: int = 300) -> str | None:
    if v is None or isinstance(v, (dict, list)):
        return None
    v = str(v).strip()
    return v[:n] if v and v.lower() not in ("null", "none", "n/a", "unknown", "-") else None


def _money(v) -> float | None:
    if v in (None, ""):
        return None
    if isinstance(v, (int, float)):
        return round(float(v), 2) if v > 0 else None
    m = re.search(r"(\d[\d,]*\.?\d*)", str(v))
    try:
        n = float(m.group(1).replace(",", "")) if m else 0
    except ValueError:
        return None
    return round(n, 2) if n > 0 else None


def _pick(value: str | None, options: list[str]) -> str | None:
    """Match free text to one of HaRM's list values (case-insensitive, then loose)."""
    if not value:
        return None
    low = value.lower().strip()
    for o in options:
        if o.lower() == low:
            return o
    for o in options:
        ol = o.lower()
        if low in ol or ol in low or ol.split(" ")[0] == low.split(" ")[0]:
            return o
    return None


PART_HINTS = [
    (r"nvme", "NVMe SSD"), (r"\bssd\b|solid state", "SSD"), (r"\bhdd\b|hard (disk|drive)|\b\d{4,5} ?rpm", "HDD"),
    (r"\bram\b|dimm|memory|ddr\d", "RAM"), (r"\bcpu\b|processor|xeon|opteron|epyc|ryzen|core i\d", "CPU"),
    (r"\bgpu\b|graphics|geforce|radeon|quadro", "GPU"), (r"\bnic\b|network (card|adapter)|ethernet|connectx|x520|i350", "NIC"),
    (r"\bhba\b|raid (card|controller)|perc|lsi|megaraid", "HBA / RAID Card"), (r"\bpsu\b|power supply", "PSU"),
    (r"motherboard|mainboard", "Motherboard"), (r"\bfan\b|cooler|heatsink", "Cooler / Fan"),
    (r"sfp|transceiver|qsfp", "Transceiver (SFP)"), (r"cable", "Cable"), (r"caddy|tray|sled", "Caddy / Tray"),
    (r"rail", "Rail Kit"), (r"battery|bbu", "Battery"), (r"usb|flash drive|thumb", "USB / Flash"),
]


def _part_category(raw: str | None, text: str) -> str:
    c = _pick(raw, PART_CATEGORIES)
    if c:
        return c
    for rx, cat in PART_HINTS:
        if re.search(rx, f"{raw or ''} {text}", re.I):
            return cat
    return "Other"


def normalize(data: dict) -> dict:
    if not isinstance(data.get("items"), list):
        raise ValueError("The reply has no \"items\" list. Ask the AI to answer in the requested JSON format.")
    items, warnings = [], []
    for n, raw in enumerate(data["items"][:MAX_ITEMS], 1):
        if not isinstance(raw, dict):
            continue
        kind = "device" if str(raw.get("type", "")).lower().startswith("dev") else "part"
        text = " ".join(str(raw.get(k) or "") for k in ("name", "category", "model", "manufacturer"))
        it = {
            "kind": kind,
            "manufacturer": _s(raw.get("manufacturer"), 100),
            "model": _s(raw.get("model"), 200),
            "part_number": _s(raw.get("part_number"), 100),
            "serial": _s(raw.get("serial"), 100),
            "quantity": max(1, min(10000, int(raw.get("quantity") or 1))) if str(raw.get("quantity") or 1).isdigit() else 1,
            "condition": _pick(_s(raw.get("condition")), CONDITIONS),
            "msrp": _money(raw.get("msrp")),
            "market_value": _money(raw.get("market_value")),
            "currency": (_s(raw.get("currency"), 8) or "USD").upper(),
            "value_notes": _s(raw.get("value_notes"), 1000),
            "sources": [s for s in (raw.get("sources") or []) if isinstance(s, str) and re.match(r"https?://", s)][:8],
            "confidence": (_s(raw.get("confidence"), 10) or "medium").lower(),
            "labels": [str(x)[:200] for x in (raw.get("visible_labels") or []) if x][:12],
            "notes": _s(raw.get("notes"), 2000),
            "todo": [str(t).strip()[:300] for t in (raw.get("todo") or []) if str(t).strip()][:12],
            "release_year": int(raw["release_year"]) if str(raw.get("release_year") or "").isdigit() else None,
        }
        if it["confidence"] not in ("high", "medium", "low"):
            it["confidence"] = "medium"
        if kind == "device":
            it["device_type"] = _pick(_s(raw.get("category")), DEVICE_TYPES)
            it["name"] = _s(raw.get("name"), 200) or " ".join(x for x in (it["manufacturer"], it["model"]) if x) or f"Item {n}"
            specs = raw.get("specs") if isinstance(raw.get("specs"), dict) else {}
            for k in ("cpu", "ram", "storage", "psu", "os"):
                it[k] = _s(specs.get(k), 300)
        else:
            it["category"] = _part_category(_s(raw.get("category")), text)
            cap = _s(raw.get("capacity"), 40)
            it["capacity"] = units.normalize_capacity(cap) if cap else None
            it["interface"] = _s(raw.get("interface"), 60)
            it["form_factor"] = _s(raw.get("form_factor"), 40)
            it["speed"] = _s(raw.get("speed"), 60)
            it["name"] = " ".join(x for x in (it["manufacturer"], it["model"], it["capacity"]) if x) or it["category"]
        if it["currency"] != "USD" and (it["msrp"] or it["market_value"]):
            warnings.append(f"{it['name']}: prices are in {it['currency']}; HaRM stores the numbers as given.")
        items.append(it)
    if not items:
        raise ValueError("The reply didn't contain any items.")
    if len(data["items"]) > MAX_ITEMS:
        warnings.append(f"Only the first {MAX_ITEMS} items were read.")
    return {"summary": _s(data.get("summary"), 500), "items": items, "warnings": warnings,
            "todo": [str(t).strip()[:300] for t in (data.get("todo") or []) if str(t).strip()][:20]}


def parse(text: str) -> dict:
    return normalize(_extract_json(text))


def research_note(it: dict) -> str | None:
    """A readable journal entry with what the AI found (sources, value reasoning, labels)."""
    parts = []
    if it.get("release_year"):
        parts.append(f"Released around {it['release_year']}.")
    if it.get("msrp") or it.get("market_value"):
        cur = it.get("currency") or "USD"
        bits = []
        if it.get("msrp"):
            bits.append(f"new about {it['msrp']:,.2f} {cur}")
        if it.get("market_value"):
            bits.append(f"worth about {it['market_value']:,.2f} {cur} used")
        parts.append("Value: " + ", ".join(bits) + ".")
    if it.get("value_notes"):
        parts.append(it["value_notes"])
    if it.get("labels"):
        parts.append("Labels read: " + " · ".join(it["labels"]))
    if it.get("notes"):
        parts.append(it["notes"])
    if it.get("sources"):
        parts.append("Sources: " + " ".join(it["sources"]))
    if not parts:
        return None
    return f"🤖 AI Assist ({it.get('confidence', 'medium')} confidence): " + "\n".join(parts)
