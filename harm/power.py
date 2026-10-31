"""Power budget: how much each UPS or PDU is asked to supply, and how much each rack draws.

A device's "Typical draw" counts while it's hooked up. A UPS or PDU's load is everything plugged
into it, including what's plugged into a PDU that's plugged into it. Over 80% is a warning (a UPS
should keep headroom, and a circuit should stay under 80% for continuous loads); 100% is over.
"""

WARN = 0.8


def _devices(conn) -> dict[int, dict]:
    return {r["id"]: dict(r) for r in conn.execute(
        "SELECT id, name, device_type, rack_id, connected, power_draw_w, power_capacity_w, powered_by_id FROM devices")}


def _level(pct: float | None) -> str:
    return "" if pct is None else "over" if pct >= 1 else "warn" if pct >= WARN else "ok"


def summary(conn) -> dict:
    devs = _devices(conn)
    children: dict[int, list] = {}
    for d in devs.values():
        if d["powered_by_id"] in devs:
            children.setdefault(d["powered_by_id"], []).append(d)

    def load(sid: int, seen: frozenset) -> tuple[int, list]:
        """(watts, devices without a draw) of everything plugged into sid, through PDUs too."""
        watts, unknown = 0, []
        for c in children.get(sid, []):
            if not c["connected"] or c["id"] in seen:
                continue
            sub_w, sub_u = load(c["id"], seen | {c["id"]})
            if c["power_draw_w"] is None and not children.get(c["id"]):
                unknown.append(c["name"])
            watts += (c["power_draw_w"] or 0) + sub_w
            unknown += sub_u
        return watts, unknown

    supplies = []
    for d in devs.values():
        if not d["power_capacity_w"] and not children.get(d["id"]):
            continue
        w, unknown = load(d["id"], frozenset({d["id"]}))
        cap = d["power_capacity_w"]
        pct = w / cap if cap else None
        supplies.append({"id": d["id"], "name": d["name"], "device_type": d["device_type"], "rack_id": d["rack_id"],
                         "capacity_w": cap, "load_w": w, "pct": round(pct, 3) if pct is not None else None, "level": _level(pct),
                         "devices": [{"id": c["id"], "name": c["name"], "draw_w": c["power_draw_w"], "connected": c["connected"]}
                                     for c in sorted(children.get(d["id"], []), key=lambda c: c["name"].lower())],
                         "without_draw": unknown})
    racks = []
    for r in conn.execute("SELECT id, name, power_budget_w FROM racks"):
        inside = [d for d in devs.values() if d["rack_id"] == r["id"] and d["connected"]]
        if not inside and not r["power_budget_w"]:
            continue
        # A PDU's own draw is what's plugged into it, so only count devices' own draw (no double counting).
        w = sum(d["power_draw_w"] or 0 for d in inside)
        budget = r["power_budget_w"]
        pct = w / budget if budget else None
        racks.append({"id": r["id"], "name": r["name"], "budget_w": budget, "draw_w": w,
                      "pct": round(pct, 3) if pct is not None else None, "level": _level(pct),
                      "without_draw": [d["name"] for d in inside if d["power_draw_w"] is None and not d["power_capacity_w"]]})
    return {"supplies": sorted(supplies, key=lambda s: s["name"].lower()), "racks": racks}


def warnings(conn) -> list[dict]:
    s = summary(conn)
    out = [{"kind": "supply", "id": x["id"], "name": x["name"], "used_w": x["load_w"], "limit_w": x["capacity_w"],
            "pct": x["pct"], "level": x["level"]} for x in s["supplies"] if x["level"] in ("warn", "over")]
    out += [{"kind": "rack", "id": x["id"], "name": x["name"], "used_w": x["draw_w"], "limit_w": x["budget_w"],
             "pct": x["pct"], "level": x["level"]} for x in s["racks"] if x["level"] in ("warn", "over")]
    return out


def check_loop(conn, device_id: int | None, powered_by: int | None) -> None:
    """A device can't be plugged into itself, or into something that's plugged into it."""
    cur, seen = powered_by, set()
    while cur:
        if cur == device_id or cur in seen:
            raise ValueError("That would plug it into itself")
        seen.add(cur)
        r = conn.execute("SELECT powered_by_id FROM devices WHERE id = ?", (cur,)).fetchone()
        cur = r["powered_by_id"] if r else None
