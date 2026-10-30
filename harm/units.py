"""Storage / memory size parsing, formatting and snapping to marketed sizes."""

import re

# Marketed drive sizes, in GB (decimal, as printed on the label).
STD_SIZES_GB = [16, 32, 60, 64, 80, 100, 120, 128, 146, 160, 200, 240, 250, 256, 300, 320, 400, 450,
                480, 500, 512, 600, 640, 750, 800, 900, 960] + [
    t * 1000 for t in (1, 1.2, 1.6, 1.8, 1.92, 2, 2.4, 3, 3.84, 4, 5, 6, 7.68, 8, 10, 12, 14, 15.36,
                       16, 18, 20, 22, 24, 26, 28, 30, 30.72, 32)]

_SIZE_RE = re.compile(r"^\s*(\d+(?:[.,]\d+)?)\s*(tib|tb|t|gib|gb|g|mib|mb|m)?\s*$", re.I)
_UNIT_GB = {"t": 1000, "tb": 1000, "tib": 1099.511627776, "g": 1, "gb": 1, "gib": 1.073741824,
            "m": 0.001, "mb": 0.001, "mib": 0.001048576}


def parse_gb(text) -> float | None:
    """'4TB' / '1 tb' / '500GB' / '931.5 GiB' -> GB. Only whole-value sizes are parsed."""
    if text is None:
        return None
    m = _SIZE_RE.match(str(text))
    if not m or not m.group(2):
        return None
    return float(m.group(1).replace(",", ".")) * _UNIT_GB[m.group(2).lower()]


def find_gb(text) -> float | None:
    """First size anywhere in free text (e.g. '2x 8TB WD Red' -> 8000)."""
    m = re.search(r"(\d+(?:\.\d+)?)\s*(TiB|TB|T|GiB|GB|G)\b", str(text or ""), re.I)
    return float(m.group(1)) * _UNIT_GB[m.group(2).lower()] if m else None


def fmt_gb(gb) -> str | None:
    if gb is None:
        return None
    if gb >= 1000:
        return f"{round(gb / 1000, 2):g} TB"
    return f"{round(gb, 1):g} GB"


def snap_gb(gb: float, tolerance: float = 0.04) -> float:
    """Snap a measured size to the nearest marketed size (a '4 TB' drive reports 4.0e12 bytes,
    a '1 TB' one may report 0.93 TiB)."""
    best = min(STD_SIZES_GB, key=lambda s: abs(s - gb) / s)
    return best if abs(best - gb) / best <= tolerance else round(gb)


def normalize_capacity(text):
    """Canonical '4 TB' / '500 GB' for anything that is just a size; other text unchanged."""
    gb = parse_gb(text)
    return fmt_gb(gb) if gb else text
