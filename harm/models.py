"""Entity definitions driving the generic CRUD API, plus suggestion lists."""

T, I, R, B, D = "text", "int", "real", "bool", "date"


def fk(table: str) -> str:
    return f"fk:{table}"


def f(ftype: str, required: bool = False) -> tuple[str, bool]:
    return (ftype, required)


def iface_order(alias: str = "") -> str:
    """ORDER BY for a device's interfaces: the main address first, management ports (iDRAC, iLO,
    IPMI…) last, unless one is marked main."""
    a = f"{alias}." if alias else ""
    name = f"LOWER(COALESCE({a}name, ''))"
    mgmt = " OR ".join(f"{name} GLOB '*{w}*'" for w in ("idrac", "ilo", "ipmi", "bmc", "mgmt", "management"))
    return f"{a}is_primary DESC, ({a}kind = 'IPMI / BMC' OR {mgmt}), {a}id"


ENTITIES: dict[str, dict] = {
    "locations": {
        "fields": {
            "name": f(T, True), "kind": f(T), "parent_id": f(fk("locations")),
            "address": f(T), "notes": f(T),
        },
        "search": ["name", "kind", "address", "notes"],
        "select": """SELECT t.*, p.name AS parent_name,
                       (SELECT COUNT(*) FROM devices d WHERE d.location_id = t.id) AS device_count,
                       (SELECT COUNT(*) FROM racks r WHERE r.location_id = t.id) AS rack_count
                     FROM locations t LEFT JOIN locations p ON p.id = t.parent_id""",
        "order": "t.name COLLATE NOCASE",
    },
    "racks": {
        "fields": {
            "name": f(T, True), "kind": f(T), "location_id": f(fk("locations")),
            "height_u": f(I), "numbering_desc": f(B), "width": f(T), "depth_mm": f(I),
            "manufacturer": f(T), "model": f(T), "notes": f(T),
        },
        "search": ["name", "kind", "manufacturer", "model", "notes"],
        "select": """SELECT t.*, l.name AS location_name,
                       (SELECT COUNT(*) FROM devices d WHERE d.rack_id = t.id) AS device_count,
                       (SELECT COALESCE(SUM(d.u_height), 0) FROM devices d
                          WHERE d.rack_id = t.id AND d.rack_u IS NOT NULL) AS used_u,
                       (SELECT COALESCE(SUM(c.quantity), 0) FROM components c
                          WHERE c.rack_id = t.id AND c.device_id IS NULL) AS component_count
                     FROM racks t LEFT JOIN locations l ON l.id = t.location_id""",
        "order": "t.name COLLATE NOCASE",
    },
    "devices": {
        "fields": {
            "name": f(T, True), "device_type": f(T), "manufacturer": f(T), "model": f(T),
            "serial": f(T), "asset_tag": f(T), "status": f(T), "connected": f(B),
            "hostname": f(T), "os": f(T), "cpu": f(T), "ram": f(T), "storage": f(T),
            "psu": f(T), "power_draw_w": f(I),
            "location_id": f(fk("locations")), "rack_id": f(fk("racks")),
            "rack_u": f(I), "u_height": f(I), "rack_face": f(T), "full_depth": f(B),
            "position": f(T), "mgmt_url": f(T),
            "purchase_date": f(D), "purchase_price": f(R), "vendor": f(T),
            "warranty_until": f(D), "tags": f(T), "notes": f(T),
            "msrp": f(R), "market_value": f(R), "value_checked": f(D),
            "host_id": f(fk("devices")), "cluster_id": f(fk("clusters")), "vm_id": f(T),
            "vcpus": f(I), "vm_ram_gb": f(R), "vm_disk_gb": f(R),
        },
        "search": ["name", "device_type", "manufacturer", "model", "serial", "asset_tag",
                   "hostname", "os", "tags", "notes"],
        "select": """SELECT t.*, l.name AS location_name, r.name AS rack_name, r.kind AS rack_kind,
                       hd.name AS host_name, cl.name AS cluster_name,
                       (SELECT GROUP_CONCAT(ip, ', ') FROM (SELECT i.ip FROM interfaces i
                          WHERE i.device_id = t.id AND i.ip IS NOT NULL AND i.ip != ''
                          ORDER BY """ + iface_order("i") + """)) AS ips
                     FROM devices t
                     LEFT JOIN locations l ON l.id = t.location_id
                     LEFT JOIN racks r ON r.id = t.rack_id
                     LEFT JOIN devices hd ON hd.id = t.host_id
                     LEFT JOIN clusters cl ON cl.id = t.cluster_id""",
        "order": "t.name COLLATE NOCASE",
    },
    "device_slots": {
        "fields": {
            "device_id": f(fk("devices"), True), "interface": f(T, True),
            "form_factor": f(T), "total": f(I), "notes": f(T),
            "label": f(T), "array_name": f(T), "first_index": f(I),
        },
        "search": ["interface", "form_factor", "notes"],
        "select": """SELECT t.*, d.name AS device_name FROM device_slots t
                     JOIN devices d ON d.id = t.device_id""",
        "order": "t.interface COLLATE NOCASE",
    },
    "components": {
        "fields": {
            "category": f(T, True), "manufacturer": f(T), "model": f(T), "part_number": f(T),
            "serial": f(T), "capacity": f(T), "interface": f(T), "form_factor": f(T),
            "speed": f(T), "quantity": f(I), "condition": f(T), "status": f(T),
            "device_id": f(fk("devices")), "location_id": f(fk("locations")),
            "rack_id": f(fk("racks")), "position": f(T), "health": f(T),
            "catalog_id": f(fk("catalog_parts")), "slot_id": f(fk("device_slots")), "bay": f(I),
            "purchase_date": f(D), "purchase_price": f(R), "vendor": f(T),
            "warranty_until": f(D), "tags": f(T), "notes": f(T),
            "msrp": f(R), "market_value": f(R), "value_checked": f(D),
        },
        "search": ["category", "manufacturer", "model", "part_number", "serial", "capacity",
                   "interface", "form_factor", "tags", "notes"],
        "select": """SELECT t.*, d.name AS device_name, l.name AS location_name, r.name AS rack_name
                     FROM components t
                     LEFT JOIN devices d ON d.id = t.device_id
                     LEFT JOIN locations l ON l.id = t.location_id
                     LEFT JOIN racks r ON r.id = t.rack_id""",
        "order": "t.category COLLATE NOCASE, t.manufacturer COLLATE NOCASE, t.model COLLATE NOCASE",
    },
    "networks": {
        "fields": {
            "name": f(T, True), "kind": f(T), "vlan_id": f(I), "cidr": f(T), "gateway": f(T),
            "ipv6_prefix": f(T), "dhcp_start": f(T), "dhcp_end": f(T), "dns_servers": f(T),
            "domain": f(T), "ssid": f(T), "location_id": f(fk("locations")), "notes": f(T),
        },
        "search": ["name", "kind", "cidr", "gateway", "ipv6_prefix", "domain", "ssid", "notes"],
        "select": """SELECT t.*, l.name AS location_name,
                       (SELECT COUNT(*) FROM interfaces i WHERE i.network_id = t.id) AS interface_count,
                       (SELECT COUNT(DISTINCT i.ip) FROM interfaces i
                          WHERE i.network_id = t.id AND i.ip IS NOT NULL) AS ip_count
                     FROM networks t LEFT JOIN locations l ON l.id = t.location_id""",
        "order": "t.vlan_id IS NULL, t.vlan_id, t.name COLLATE NOCASE",
    },
    "interfaces": {
        "fields": {
            "device_id": f(fk("devices"), True), "name": f(T), "kind": f(T),
            "network_id": f(fk("networks")), "assignment": f(T),
            "ip": f(T), "subnet": f(T), "gateway": f(T), "ipv6": f(T), "dns_servers": f(T),
            "dns_name": f(T), "mac": f(T), "speed": f(T), "mtu": f(I), "link_state": f(T),
            "vlan": f(T), "port_mode": f(T), "native_vlan": f(T), "tagged_vlans": f(T),
            "poe": f(T), "parent": f(T), "wifi_ssid": f(T), "notes": f(T), "is_primary": f(B),
        },
        "search": ["name", "mac", "ip", "ipv6", "vlan", "dns_name", "wifi_ssid", "notes"],
        "select": """SELECT t.*, d.name AS device_name, n.name AS network_name,
                       n.vlan_id AS network_vlan
                     FROM interfaces t
                     JOIN devices d ON d.id = t.device_id
                     LEFT JOIN networks n ON n.id = t.network_id""",
        "order": iface_order("t"),
    },
    "services": {
        "fields": {
            "device_id": f(fk("devices"), True), "name": f(T, True), "protocol": f(T),
            "port": f(I), "url": f(T), "version": f(T), "status": f(T), "notes": f(T),
        },
        "search": ["name", "url", "version", "notes"],
        "select": """SELECT t.*, d.name AS device_name FROM services t
                     JOIN devices d ON d.id = t.device_id""",
        "order": "t.name COLLATE NOCASE",
    },
    "credentials": {
        "fields": {
            "label": f(T, True), "kind": f(T), "username": f(T), "url": f(T),
            "device_id": f(fk("devices")), "service_id": f(fk("services")),
            "last_rotated": f(D),
        },
        # Plaintext names accepted on write; stored encrypted as <name>_enc.
        "secrets": ["password", "secret_notes", "totp_secret"],
        "search": ["label", "kind", "username", "url"],
        "select": """SELECT t.id, t.label, t.kind, t.username, t.url, t.device_id, t.service_id,
                       t.last_rotated, t.created_at, t.updated_at,
                       t.password_enc IS NOT NULL AS has_password,
                       t.secret_notes_enc IS NOT NULL AS has_secret_notes,
                       t.totp_secret_enc IS NOT NULL AS has_totp,
                       d.name AS device_name, s.name AS service_name
                     FROM credentials t
                     LEFT JOIN devices d ON d.id = t.device_id
                     LEFT JOIN services s ON s.id = t.service_id""",
        "order": "t.label COLLATE NOCASE",
    },
    "clusters": {
        "fields": {"name": f(T, True), "kind": f(T), "location_id": f(fk("locations")), "notes": f(T)},
        "search": ["name", "kind", "notes"],
        "select": """SELECT t.*, l.name AS location_name,
                       (SELECT COUNT(*) FROM devices d WHERE d.cluster_id = t.id AND d.host_id IS NULL) AS node_count,
                       (SELECT COUNT(*) FROM devices g JOIN devices h ON h.id = g.host_id
                          WHERE h.cluster_id = t.id OR g.cluster_id = t.id) AS guest_count
                     FROM clusters t LEFT JOIN locations l ON l.id = t.location_id""",
        "order": "t.name COLLATE NOCASE",
    },
    "builds": {
        "fields": {
            "name": f(T, True), "purpose": f(T), "status": f(T), "device_id": f(fk("devices")),
            "budget": f(R), "notes": f(T),
        },
        "search": ["name", "purpose", "notes"],
        "select": """SELECT t.*, d.name AS device_name,
                       (SELECT COUNT(*) FROM build_items i WHERE i.build_id = t.id) AS item_count,
                       (SELECT COALESCE(SUM(i.price * i.quantity), 0) FROM build_items i
                          WHERE i.build_id = t.id) AS total_price
                     FROM builds t LEFT JOIN devices d ON d.id = t.device_id""",
        "order": "t.updated_at DESC",
    },
    "build_items": {
        "fields": {
            "build_id": f(fk("builds"), True), "category": f(T, True),
            "catalog_id": f(fk("catalog_parts")), "component_id": f(fk("components")),
            "name": f(T), "quantity": f(I), "price": f(R), "acquire": f(T), "notes": f(T),
        },
        "search": ["name", "notes"],
        "select": "SELECT t.* FROM build_items t",
        "order": "t.id",
    },
    "notes": {
        "fields": {
            "entity": f(T, True), "entity_id": f(I, True), "kind": f(T), "body": f(T, True),
            "done": f(B), "pinned": f(B), "due": f(D),
        },
        "search": ["body"],
        "select": """SELECT t.*, COALESCE(d.name, r.name, l.name, n.name, b.name, k.name,
                       TRIM(COALESCE(c.manufacturer,'') || ' ' || COALESCE(c.model, c.category))) AS target_name
                     FROM notes t
                     LEFT JOIN devices d ON t.entity = 'devices' AND d.id = t.entity_id
                     LEFT JOIN racks r ON t.entity = 'racks' AND r.id = t.entity_id
                     LEFT JOIN locations l ON t.entity = 'locations' AND l.id = t.entity_id
                     LEFT JOIN networks n ON t.entity = 'networks' AND n.id = t.entity_id
                     LEFT JOIN builds b ON t.entity = 'builds' AND b.id = t.entity_id
                     LEFT JOIN components c ON t.entity = 'components' AND c.id = t.entity_id
                     LEFT JOIN clusters k ON t.entity = 'clusters' AND k.id = t.entity_id""",
        "order": "t.pinned DESC, t.created_at DESC, t.id DESC",
    },
    "connections": {
        "fields": {
            "a_device_id": f(fk("devices"), True), "a_port": f(T),
            "b_device_id": f(fk("devices")), "b_port": f(T), "b_endpoint": f(T),
            "medium": f(T), "cable_label": f(T), "length": f(T), "color": f(T),
            "speed": f(T), "notes": f(T),
        },
        "search": ["a_port", "b_port", "b_endpoint", "medium", "cable_label", "color", "notes"],
        "select": """SELECT t.*, a.name AS a_device_name, b.name AS b_device_name
                     FROM connections t
                     JOIN devices a ON a.id = t.a_device_id
                     LEFT JOIN devices b ON b.id = t.b_device_id""",
        "order": "a.name COLLATE NOCASE, t.a_port COLLATE NOCASE",
    },
}


ENUMS = {
    "location_kinds": ["Site", "Building", "Floor", "Room", "Closet", "Garage", "Office",
                       "Storage Unit", "Area", "Other"],
    "rack_kinds": ["Rack", "Cabinet", "Wall-mount Rack", "Open Frame Rack", "Shelf",
                   "Wire Shelving", "Bin", "Tote", "Drawer", "Desk", "Closet", "Box",
                   "Pile", "Floor", "Other"],
    "device_types": ["Server", "Hypervisor Host", "NAS", "SAN / DAS", "Switch", "Router",
                     "Firewall", "Access Point", "Modem / ONT", "PDU", "UPS", "Patch Panel",
                     "KVM", "Console Server", "Desktop", "Workstation", "Laptop", "Mini PC",
                     "SBC (Raspberry Pi etc.)", "Printer", "Camera / NVR", "IoT", "Monitor",
                     "Phone", "Tablet", "TV / Streaming", "Game Console", "Smart Home", "Wearable",
                     "Virtual Machine", "Container", "Cable Manager", "Shelf / Tray", "Other"],
    "cluster_kinds": ["Proxmox VE", "Kubernetes", "VMware vSphere", "Hyper-V", "XCP-ng", "Docker Swarm",
                      "Nomad", "Ceph", "TrueNAS", "Other"],
    "device_statuses": ["Active", "Standby", "Testing", "Spare", "In Repair", "Broken",
                        "Retired", "Sold"],
    "component_categories": ["HDD", "SSD", "NVMe SSD", "RAM", "CPU", "GPU", "NIC",
                             "HBA / RAID Card", "PSU", "Motherboard", "Cooler / Fan",
                             "Transceiver (SFP)", "Cable", "Adapter / Riser", "Caddy / Tray",
                             "Rail Kit", "Battery", "USB / Flash", "Other"],
    "component_statuses": ["In Stock", "Installed", "Reserved", "RMA", "Faulty", "Disposed"],
    "component_conditions": ["New", "Used - Good", "Used - Fair", "Refurbished", "Faulty",
                             "Unknown"],
    "interfaces": ["SATA", "SATA III", "SAS", "SAS2 (6Gb)", "SAS3 (12Gb)", "NVMe M.2 (M-key)",
                   "M.2 SATA (B+M key)", "U.2", "U.3", "mSATA", "PCIe x1", "PCIe x4", "PCIe x8",
                   "PCIe x16", "OCP 2.0", "OCP 3.0", "DDR3 DIMM", "DDR4 DIMM", "DDR4 RDIMM",
                   "DDR5 DIMM", "DDR5 RDIMM", "DDR3 SODIMM", "DDR4 SODIMM", "DDR5 SODIMM",
                   "LGA1151", "LGA1200", "LGA1700", "LGA1851", "LGA2011-3", "LGA3647",
                   "LGA4189", "AM4", "AM5", "SP3", "SP5", "SFP", "SFP+", "SFP28", "QSFP+",
                   "QSFP28", "RJ45", "USB-A", "USB-C", "Thunderbolt", "Molex", "ATX 24-pin",
                   "EPS 8-pin", "PCIe 8-pin", "12VHPWR", "C13/C14", "C19/C20"],
    "form_factors": ['3.5"', '2.5"', '2.5" 7mm', '2.5" 15mm', "M.2 2230", "M.2 2242",
                     "M.2 2260", "M.2 2280", "M.2 22110", "Full Height PCIe",
                     "Low Profile PCIe", "DIMM", "SODIMM", "ATX", "SFX", "Flex ATX",
                     "Redundant PSU", "1U", "2U", "4U"],
    "mediums": ["Cat5e", "Cat6", "Cat6a", "Cat7", "Cat8", "DAC", "AOC", "Fiber OM3",
                "Fiber OM4", "Fiber OS2", "Coax", "USB", "HDMI", "DisplayPort",
                "Serial / Console", "Power C13/C14", "Power C19/C20", "Power NEMA 5-15",
                "SATA", "SAS (SFF-8087)", "SAS (SFF-8643)", "SAS (SFF-8088)",
                "SAS (SFF-8644)", "Thunderbolt", "Wireless"],
    "net_kinds": ["Ethernet", "SFP", "SFP+", "SFP28", "QSFP", "Wi-Fi", "IPMI / BMC",
                  "Bond / LAG", "VLAN", "Bridge", "Virtual", "WireGuard / VPN", "USB",
                  "Other"],
    "network_kinds": ["LAN", "Management", "Servers", "Storage", "IoT", "Guest", "Cameras",
                      "DMZ", "Lab", "Wi-Fi", "VPN", "WAN", "Transit", "Other"],
    "ip_assignments": ["Static", "DHCP reservation", "DHCP", "SLAAC", "Link-local",
                       "Unassigned"],
    "port_modes": ["Access", "Trunk", "Hybrid", "Routed"],
    "link_states": ["Up", "Down", "Disabled", "Unused"],
    "poe_options": ["None", "PoE (802.3af)", "PoE+ (802.3at)", "PoE++ (802.3bt)",
                    "Passive 24V", "PoE powered device"],
    "credential_kinds": ["SSH", "Web UI", "IPMI / BMC", "Console", "OS Account", "SNMP",
                         "API Key", "Wi-Fi PSK", "Database", "VPN", "Recovery Codes",
                         "Encryption Key", "Other"],
    "service_statuses": ["Running", "Stopped", "Planned", "Deprecated"],
    "build_statuses": ["Planning", "Ordering", "Building", "Built", "Shelved"],
    "build_purposes": ["Gaming PC", "Workstation", "Homelab server", "NAS", "Hypervisor host",
                       "Router / firewall", "HTPC / media", "Office PC", "Upgrade", "Parts-bin build"],
    "acquire_states": ["Have", "Need", "Ordered"],
    "protocols": ["TCP", "UDP", "TCP/UDP", "HTTP", "HTTPS", "SSH", "SMB", "NFS", "iSCSI",
                  "SNMP", "Other"],
}
