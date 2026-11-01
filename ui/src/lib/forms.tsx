/* The add and edit form of every kind of record, and the dialogs that open them. */
import { api, loadLookups } from '../api/client';
import { LOOKUPS, type EntityName } from '../api/types';
import { S, rerender } from './state';
import { locDescendants, rackById, rackHasUnits, rackInLocation } from './lookups';
import { isVirtual, slotKindOf, type Row } from './util';
import { confirmBox, toast } from '../ui/overlay';
import { MenuButton, Small } from '../ui/bits';
import { formDialog, type Field, type FormCtl } from '../ui/form';
import { libraryLookup } from '../dialogs/later';
import { scanLabel } from '../dialogs/scan';
import { ACTION_TEMPLATES } from './actions';

export const LABELS: Record<string, string> = {
  locations: 'Location', racks: 'Holder', devices: 'Device', device_slots: 'Slot / bay',
  components: 'Component', interfaces: 'Interface', services: 'Service',
  credentials: 'Credential', connections: 'Connection', networks: 'Network', clusters: 'Cluster', builds: 'Build', build_items: 'Build part', actions: 'Action',
};

/* Picking a holder moves the location to the holder's room. */
export function rackPicked(value: string, form: FormCtl) {
  const r = rackById(value);
  if (r && r.location_id && form.get('location_id') !== String(r.location_id)) form.set({ location_id: r.location_id });
}

/* Tap-to-fill choices for parts, by category. */
const HDD_SIZES = ['1 TB', '2 TB', '3 TB', '4 TB', '6 TB', '8 TB', '10 TB', '12 TB', '14 TB', '16 TB', '18 TB', '20 TB', '22 TB', '24 TB'];
const SSD_SIZES = ['120 GB', '240 GB', '256 GB', '480 GB', '500 GB', '512 GB', '960 GB', '1 TB', '1.92 TB', '2 TB', '3.84 TB', '4 TB', '8 TB'];
const DRIVE_MAKERS = ['Seagate', 'Western Digital', 'Toshiba', 'HGST', 'Samsung', 'Crucial', 'Intel', 'Micron'];
interface Chips { sizes?: string[]; iface?: string[]; ff?: string[]; makers?: string[]; speeds?: string[]; counts?: string[] }
export const PART_CHIPS: Record<string, Chips> = {
  'HDD': { sizes: HDD_SIZES, iface: ['SATA', 'SAS'], ff: ['3.5"', '2.5"'], makers: DRIVE_MAKERS, speeds: ['5400 RPM', '7200 RPM', '10K RPM', '15K RPM'] },
  'SSD': { sizes: SSD_SIZES, iface: ['SATA', 'SAS', 'U.2'], ff: ['2.5"', 'M.2 2280'], makers: DRIVE_MAKERS },
  'NVMe SSD': { sizes: ['256 GB', '512 GB', '1 TB', '2 TB', '4 TB', '8 TB'], iface: ['NVMe M.2 (M-key)', 'U.2'], ff: ['M.2 2280', 'M.2 2242', 'M.2 22110', 'U.2 2.5"'], makers: DRIVE_MAKERS },
  'USB / Flash': { sizes: ['16 GB', '32 GB', '64 GB', '128 GB', '256 GB', '512 GB', '1 TB', '2 TB', '4 TB'], iface: ['USB-A', 'USB-C'] },
  'RAM': { sizes: ['2 GB', '4 GB', '8 GB', '16 GB', '32 GB', '64 GB', '128 GB'], iface: ['DDR3 DIMM', 'DDR3 RDIMM', 'DDR4 DIMM', 'DDR4 RDIMM', 'DDR5 DIMM', 'DDR5 RDIMM', 'DDR4 SODIMM', 'DDR5 SODIMM'], ff: ['DIMM', 'SODIMM'], makers: ['Samsung', 'SK hynix', 'Micron', 'Kingston', 'Crucial', 'Corsair', 'G.Skill'], speeds: ['1333 MT/s', '1600 MT/s', '2133 MT/s', '2400 MT/s', '2666 MT/s', '3200 MT/s', '4800 MT/s', '5600 MT/s', '6000 MT/s'] },
  'CPU': { iface: ['AM4', 'AM5', 'LGA1151', 'LGA1200', 'LGA1700', 'LGA1851', 'LGA2011-3', 'LGA3647', 'LGA4189', 'SP3', 'SP5', 'C32 / G34'], makers: ['Intel', 'AMD'] },
  'GPU': { sizes: ['4 GB', '8 GB', '12 GB', '16 GB', '24 GB', '32 GB'], iface: ['PCIe x16'], ff: ['Full height', 'Low profile'], makers: ['NVIDIA', 'AMD', 'Intel', 'ASUS', 'MSI', 'Gigabyte', 'EVGA'] },
  'NIC': { iface: ['PCIe x4', 'PCIe x8', 'PCIe x16', 'PCIe x1', 'OCP 2.0', 'OCP 3.0', 'Mezzanine'], ff: ['Full height', 'Low profile'], makers: ['Intel', 'Mellanox', 'Broadcom', 'Chelsio', 'Solarflare'], speeds: ['1GbE', '2.5GbE', '10GbE', '25GbE', '40GbE', '100GbE'] },
  'HBA / RAID Card': { iface: ['PCIe x8', 'PCIe x4', 'PCIe x16', 'Mezzanine'], ff: ['Full height', 'Low profile'], makers: ['LSI / Broadcom', 'Dell PERC', 'HPE Smart Array', 'Adaptec'], speeds: ['6Gb/s', '12Gb/s'] },
  'PSU': { sizes: ['450 W', '550 W', '650 W', '750 W', '850 W', '1000 W', '1100 W', '1400 W'], iface: ['Hot-swap (server)', 'ATX', 'SFX'], ff: ['Redundant PSU', 'ATX', 'SFX', 'Flex ATX'] },
  'Transceiver (SFP)': { iface: ['SFP', 'SFP+', 'SFP28', 'QSFP+', 'QSFP28'], speeds: ['1G', '10G', '25G', '40G', '100G'], ff: ['SR (multimode)', 'LR (single-mode)', 'RJ45 copper'] },
  'Cable': { iface: ['Cat6', 'Cat6a', 'DAC', 'AOC', 'Fiber OM3', 'Fiber OM4', 'Fiber OS2', 'SFF-8087', 'SFF-8643', 'SFF-8088', 'C13/C14', 'C19/C20'], ff: ['0.5 m', '1 m', '2 m', '3 m', '5 m'] },
  'Motherboard': { iface: ['AM4', 'AM5', 'LGA1700', 'LGA1851', 'LGA2011-3', 'LGA3647', 'SP3'], ff: ['ATX', 'Micro ATX', 'Mini-ITX', 'EATX', 'SSI EEB', 'Proprietary'] },
};
const SLOT_KINDS: Record<string, Chips> = {
  'Drive bays': { iface: ['SAS', 'SATA', 'U.2 (NVMe)'], ff: ['3.5"', '2.5"'], counts: ['2', '4', '6', '8', '12', '24'] },
  'Memory slots': { iface: ['DDR3 DIMM', 'DDR3 RDIMM', 'DDR4 DIMM', 'DDR4 RDIMM', 'DDR5 DIMM', 'DDR5 RDIMM', 'DDR4 SODIMM', 'DDR5 SODIMM'], ff: ['DIMM', 'SODIMM'], counts: ['2', '4', '8', '12', '16', '24'] },
  'M.2 slots': { iface: ['NVMe M.2 (M-key)', 'M.2 SATA (B+M key)'], ff: ['M.2 2280', 'M.2 2242', 'M.2 22110'], counts: ['1', '2', '3', '4'] },
  'PCIe slots': { iface: ['PCIe x16', 'PCIe x8', 'PCIe x4', 'PCIe x1', 'OCP 3.0', 'Mezzanine'], ff: ['Full height', 'Low profile'], counts: ['1', '2', '3', '4', '6'] },
  'CPU sockets': { iface: ['AM4', 'AM5', 'LGA1151', 'LGA1200', 'LGA1700', 'LGA2011-3', 'LGA3647', 'SP3', 'C32 / G34'], counts: ['1', '2', '4'] },
  'Power supply bays': { iface: ['Hot-swap (server)', 'ATX', 'SFX'], counts: ['1', '2'] },
  'Network ports (SFP)': { iface: ['SFP', 'SFP+', 'SFP28', 'QSFP+', 'QSFP28'], counts: ['2', '4', '8', '24', '48'] },
  'Other': { iface: [], ff: [] },
};

const isPower = (v: Row) => /UPS|PDU/.test(v.device_type || '') || !!v.power_capacity_w;

export const FORMS: Record<string, (rec: Row) => Field[]> = {
  locations: rec => [
    { k: 'name', label: 'Name', required: true, ph: 'Basement lab' },
    { k: 'kind', label: 'Kind', list: 'location_kinds' },
    { k: 'parent_id', label: 'Inside of', type: 'fk', entity: 'locations', none: 'Top level',
      filter: l => !rec.id || !locDescendants(rec.id).has(l.id) },
    { k: 'address', label: 'Address / description' },
    { k: 'notes', label: 'Notes', type: 'textarea', wide: true },
  ],
  racks: () => [
    { k: 'name', label: 'Name', required: true, ph: 'Rack A · Wire shelf 2 · Pile by the door' },
    { k: 'kind', label: 'Kind', list: 'rack_kinds', default: 'Rack', help: 'Use Pile, Floor or Tote for loose stacks of gear.' },
    { k: 'location_id', label: 'Location', type: 'fk', entity: 'locations' },
    { k: 'height_u', label: 'Height (U)', type: 'number', min: 1, help: 'Only for racks/cabinets. Leave blank for shelves, bins and piles.' },
    { k: 'numbering_desc', label: 'Number U1 from the top', type: 'checkbox', showIf: v => !!v.height_u },
    { k: 'width', label: 'Width', ph: '19"' },
    { k: 'depth_mm', label: 'Depth (mm)', type: 'number', min: 0 },
    { k: 'power_budget_w', label: 'Power available (W)', type: 'number', min: 0,
      help: 'The circuit’s limit for the whole rack. A 15 A, 120 V circuit is 1,440 W at the safe 80%; a 16 A, 230 V one is about 2,900 W.' },
    { k: 'manufacturer', label: 'Manufacturer' },
    { k: 'model', label: 'Model' },
    { k: 'notes', label: 'Notes', type: 'textarea', wide: true },
  ],
  devices: () => [
    { k: 'name', label: 'Name', required: true, ph: 'pve-01, R515 #1, NAS' },
    { k: 'device_type', label: 'Type', list: 'device_types', chips: ['Server', 'Hypervisor Host', 'Virtual Machine', 'Container', 'NAS', 'Switch', 'Router', 'Desktop', 'Laptop', 'Phone', 'Tablet'] },
    { k: 'status', label: 'Status', type: 'select', options: S.enums.device_statuses, required: true, default: 'Active' },
    { k: 'connected', label: 'Hooked up (cabled & powered)', type: 'checkbox' },
    { k: 'watch', label: 'Check if it’s online', type: 'checkbox', default: true, help: 'While it’s hooked up, the Status page shows whether it answers.' },
    { k: 'alerts', label: 'Send alerts about it', type: 'checkbox', default: true, showIf: v => !!v.watch, help: 'When alerts are set up in Settings, you get one when it stops answering.' },
    { k: 'manufacturer', label: 'Manufacturer', chips: ['Dell', 'HPE', 'Supermicro', 'Lenovo', 'Cisco', 'Ubiquiti', 'Synology', 'Custom'] },
    { k: 'model', label: 'Model', scan: true, ph: 'PowerEdge R515' },
    { k: 'serial', label: 'Serial number / service tag', scan: true, wide: true, help: 'Dell’s service tag, HPE’s serial, etc.: whatever identifies this exact unit.', showIf: v => !isVirtual(v) },
    { k: 'host_id', label: 'Runs on (host)', type: 'fk', entity: 'devices', none: 'Not set', showIf: isVirtual,
      help: 'The physical machine (hypervisor) this VM or container runs on.' },
    { k: 'vm_id', label: 'VM / container ID', ph: '100', showIf: isVirtual },
    { k: 'vcpus', label: 'vCPUs', type: 'number', min: 0, showIf: isVirtual, chips: ['1', '2', '4', '8', '16'] },
    { k: 'vm_ram_gb', label: 'Memory (GB)', type: 'number', step: '0.5', min: 0, showIf: isVirtual, chips: ['1', '2', '4', '8', '16', '32'] },
    { k: 'vm_disk_gb', label: 'Disk (GB)', type: 'number', step: '1', min: 0, showIf: isVirtual, chips: ['32', '64', '128', '256', '500'] },
    { k: 'cluster_id', label: 'Cluster', type: 'fk', entity: 'clusters', none: 'Not in a cluster', adv: true,
      help: 'For hypervisor hosts and nodes: which cluster they belong to.' },
    { section: 'Where it lives' },
    { k: 'location_id', label: 'Location (room)', type: 'fk', entity: 'locations' },
    { k: 'rack_id', label: 'Rack / holder', type: 'fk', entity: 'racks', none: 'None (loose in the room)',
      scopeBy: ['location_id'], scope: rackInLocation, onChange: rackPicked, showIf: v => !isVirtual(v), clearWhenHidden: true,
      help: 'Only holders in the chosen location are listed.' },
    { k: 'rack_u', label: 'Lowest rack unit (U)', type: 'number', min: 1, showIf: v => rackHasUnits(v.rack_id), clearWhenHidden: true },
    { k: 'u_height', label: 'Height (U)', type: 'number', min: 1, default: 1, showIf: v => rackHasUnits(v.rack_id), chips: ['1', '2', '3', '4', '5'] },
    { k: 'rack_face', label: 'Mounted on', type: 'select', options: [{ value: 'front', label: 'Front' }, { value: 'rear', label: 'Rear' }], required: true, default: 'front', showIf: v => rackHasUnits(v.rack_id) },
    { k: 'full_depth', label: 'Full depth (blocks both faces)', type: 'checkbox', default: true, showIf: v => rackHasUnits(v.rack_id) },
    { k: 'position', label: 'Spot', ph: 'Top shelf left · pile by the door · under the desk', wide: true },
    { section: 'System', adv: true },
    { k: 'hostname', label: 'Hostname / FQDN', adv: true },
    { k: 'os', label: 'OS / firmware', ph: 'Proxmox VE 9.1', adv: true },
    { k: 'cpu', label: 'CPU', adv: true },
    { k: 'ram', label: 'RAM', ph: '128 GB DDR4 ECC', adv: true },
    { k: 'psu', label: 'Power supply', ph: '2x 750W redundant', adv: true },
    { k: 'power_draw_w', label: 'Typical draw (W)', type: 'number', min: 0, adv: true, help: 'Counts toward its rack’s and its UPS’s power budget while it’s hooked up.' },
    { k: 'power_capacity_w', label: 'Can supply (W)', type: 'number', min: 0, adv: true, showIf: isPower,
      help: 'For a UPS or PDU: the most it can power, in watts (a UPS’s W rating, not its VA).' },
    { k: 'powered_by_id', label: 'Plugged into', type: 'fk', entity: 'devices', none: 'Not set', adv: true,
      filter: isPower, help: 'The UPS or PDU it draws power from.' },
    { k: 'mgmt_url', label: 'Management URL (iDRAC, iLO, web UI)', ph: 'https://10.0.0.5', inputmode: 'url', adv: true, wide: true },
    { section: 'Tracking', adv: true },
    { k: 'asset_tag', label: 'Asset tag (your own label)', adv: true, help: 'Only if you stick your own inventory labels on things.' },
    { k: 'tags', label: 'Tags', ph: 'prod, homelab, k8s', adv: true },
    { k: 'purchase_date', label: 'Purchased', type: 'date', adv: true },
    { k: 'purchase_price', label: 'Price', type: 'number', step: '0.01', min: 0, adv: true },
    { k: 'msrp', label: 'Original price (new)', type: 'number', step: '0.01', min: 0, adv: true },
    { k: 'market_value', label: 'Current value', type: 'number', step: '0.01', min: 0, adv: true },
    { k: 'value_checked', label: 'Value checked on', type: 'date', adv: true },
    { k: 'vendor', label: 'Vendor', adv: true },
    { k: 'warranty_until', label: 'Warranty until', type: 'date', adv: true },
  ],
  device_slots: rec => {
    const guess = slotKindOf(rec.interface);
    return [
      { k: 'device_id', label: 'Device', type: 'fk', entity: 'devices', required: true },
      { k: '_kind', label: 'What kind of slot?', type: 'select', virtual: true, required: true, default: guess, options: Object.keys(SLOT_KINDS) },
      { k: 'label', label: 'Name this group', ph: 'Front bays, Rear 2.5" bays, CPU 1 DIMMs…', wide: true,
        chips: v => v._kind === 'Drive bays' ? ['Front bays', 'Rear bays', 'Internal', 'Flex bay', 'Boot drives'] : v._kind === 'Memory slots' ? ['CPU 1 slots', 'CPU 2 slots'] : [] },
      { k: 'interface', label: 'Accepts', required: true, wide: true, chipMulti: true,
        chips: v => SLOT_KINDS[v._kind]?.iface || [],
        help: 'Drive bays: tap every connection it takes (most server bays take SAS and SATA).' },
      { k: 'array_name', label: 'RAID / controller', wide: true, showIf: v => v._kind === 'Drive bays',
        chips: ['RAID 1', 'RAID 5', 'RAID 6', 'RAID 10', 'HBA / IT mode (passthrough)', 'ZFS pool', 'Onboard SATA', 'Not set up'], ph: 'PERC H700 · RAID 6',
        help: 'Which array or controller this group of bays belongs to. Two RAIDs? Make two groups.' },
      { k: 'first_index', label: 'Numbering starts at', type: 'number', min: 0, default: 0, chips: ['0', '1'], help: 'Dell numbers bays from 0, HPE from 1.' },
      { k: 'form_factor', label: 'Size / form factor', wide: true, chips: v => SLOT_KINDS[v._kind]?.ff || [] },
      { k: 'total', label: 'How many', type: 'number', min: 1, default: 1, chips: v => SLOT_KINDS[v._kind]?.counts || ['1', '2', '4', '8', '12'] },
      { k: 'notes', label: 'Notes', ph: 'Hot-swap, front', chips: ['Hot-swap', 'Front', 'Rear', 'Internal'], chipAppend: true },
    ];
  },
  components: () => [
    { k: 'category', label: 'What is it?', list: 'component_categories', required: true, wide: true,
      chips: ['HDD', 'SSD', 'NVMe SSD', 'RAM', 'CPU', 'GPU', 'NIC', 'HBA / RAID Card', 'PSU', 'Transceiver (SFP)', 'Cable'] },
    { k: 'manufacturer', label: 'Manufacturer', chips: v => PART_CHIPS[v.category]?.makers || [] },
    { k: 'model', label: 'Model', scan: true },
    { k: 'capacity', label: 'Size', ph: 'Tap a size or type one', wide: true,
      chips: v => PART_CHIPS[v.category]?.sizes || [], showIf: v => !PART_CHIPS[v.category] || !!PART_CHIPS[v.category].sizes || !v.category },
    { k: 'interface', label: 'Connection', wide: true, chips: v => PART_CHIPS[v.category]?.iface || [],
      help: 'How it plugs in. Used to match spare parts to free slots. (RAID isn’t a connection; that’s set up on the controller.)' },
    { k: 'form_factor', label: 'Form factor', chips: v => PART_CHIPS[v.category]?.ff || [] },
    { k: 'quantity', label: 'How many', type: 'number', min: 0, default: 1, chips: ['1', '2', '4', '6', '8', '12'] },
    { k: 'serial', label: 'Serial number', scan: true, showIf: v => !v.quantity || +v.quantity <= 1, help: 'For several identical parts, put serials in Notes.' },
    { k: 'catalog_id', type: 'hidden' },
    { section: 'Where it is' },
    { k: 'device_id', label: 'Installed in device', type: 'fk', entity: 'devices', none: 'Not installed (spare)',
      onChange: (value, form) => { const st = form.get('status'); if (value && st === 'In Stock') form.set({ status: 'Installed' }); else if (!value && st === 'Installed') form.set({ status: 'In Stock' }); } },
    { k: 'status', label: 'Status', type: 'select', options: S.enums.component_statuses, required: true, default: 'In Stock' },
    { k: 'location_id', label: 'Location (room)', type: 'fk', entity: 'locations', showIf: v => !v.device_id },
    { k: 'rack_id', label: 'Stored in (holder)', type: 'fk', entity: 'racks', none: 'None (loose in the room)',
      scopeBy: ['location_id'], scope: rackInLocation, onChange: rackPicked, showIf: v => !v.device_id, clearWhenHidden: true },
    { k: 'position', label: 'Spot', ph: 'Bin 4, anti-static bag', showIf: v => !v.device_id, clearWhenHidden: true },
    { section: 'Details', adv: true },
    { k: 'part_number', label: 'Part number', scan: true, adv: true },
    { k: 'speed', label: 'Speed / rating', ph: '7200 RPM, 3200 MT/s, 10GbE', adv: true, chips: v => PART_CHIPS[v.category]?.speeds || [] },
    { k: 'condition', label: 'Condition', list: 'component_conditions', adv: true, chips: ['New', 'Used - Good', 'Used - Fair', 'Faulty'] },
    { k: 'health', label: 'Health', ph: 'SMART OK, 21k hours', adv: true },
    { k: 'purchase_date', label: 'Purchased', type: 'date', adv: true },
    { k: 'purchase_price', label: 'Price (each)', type: 'number', step: '0.01', min: 0, adv: true },
    { k: 'msrp', label: 'Original price (new, each)', type: 'number', step: '0.01', min: 0, adv: true },
    { k: 'market_value', label: 'Current value (each)', type: 'number', step: '0.01', min: 0, adv: true },
    { k: 'value_checked', label: 'Value checked on', type: 'date', adv: true },
    { k: 'vendor', label: 'Vendor', adv: true },
    { k: 'warranty_until', label: 'Warranty until', type: 'date', adv: true },
    { k: 'tags', label: 'Tags', wide: true, adv: true },
    { k: 'notes', label: 'Notes', type: 'textarea', wide: true, adv: true },
  ],
  clusters: () => [
    { k: 'name', label: 'Name', required: true, ph: 'pve-cluster, k3s-home' },
    { k: 'kind', label: 'Kind', list: 'cluster_kinds', chips: ['Proxmox VE', 'Kubernetes', 'VMware vSphere', 'Docker Swarm', 'Ceph'] },
    { k: 'location_id', label: 'Location', type: 'fk', entity: 'locations' },
    { k: 'notes', label: 'Notes', type: 'textarea', wide: true, ph: 'Quorum, shared storage, HA groups…' },
  ],
  networks: () => [
    { section: 'Network' },
    { k: 'name', label: 'Name', required: true, ph: 'Servers, IoT, Management' },
    { k: 'kind', label: 'Purpose', list: 'network_kinds' },
    { k: 'vlan_id', label: 'VLAN ID', type: 'number', min: 1, ph: '10' },
    { k: 'cidr', label: 'Subnet (CIDR)', ph: '10.0.10.0/24', inputmode: 'decimal' },
    { k: 'gateway', label: 'Gateway', ph: '10.0.10.1', inputmode: 'decimal' },
    { k: 'location_id', label: 'Site / location', type: 'fk', entity: 'locations' },
    { section: 'DHCP & DNS' },
    { k: 'dhcp_start', label: 'DHCP pool start', ph: '10.0.10.100', inputmode: 'decimal' },
    { k: 'dhcp_end', label: 'DHCP pool end', ph: '10.0.10.199', inputmode: 'decimal' },
    { k: 'dns_servers', label: 'DNS servers', ph: '10.0.10.1, 1.1.1.1' },
    { k: 'domain', label: 'Search domain', ph: 'lab.home.arpa' },
    { k: 'ipv6_prefix', label: 'IPv6 prefix', ph: 'fd00:10::/64' },
    { k: 'ssid', label: 'Wi-Fi SSID (if wireless)' },
    { k: 'notes', label: 'Notes', type: 'textarea', wide: true, ph: 'Firewall rules, what lives here, ISP details…' },
  ],
  interfaces: () => {
    const trunk = (v: Row) => /trunk|hybrid/i.test(v.port_mode || '');
    return [
      { section: 'Interface' },
      { k: 'device_id', label: 'Device', type: 'fk', entity: 'devices', required: true },
      { k: 'name', label: 'Name', ph: 'eno1, mgmt, port 24, wlan0' },
      { k: 'is_primary', label: 'Main address for this device', type: 'checkbox',
        help: 'Used for quick links, logins and lists. Leave off for iDRAC / iLO / management ports.' },
      { k: 'kind', label: 'Kind', list: 'net_kinds' },
      { k: 'link_state', label: 'Link state', type: 'select', options: S.enums.link_states },
      { k: 'mac', label: 'MAC address', scan: true, ph: 'AA:BB:CC:DD:EE:FF' },
      { k: 'speed', label: 'Speed', ph: '1G, 2.5G, 10G' },
      { k: 'mtu', label: 'MTU', type: 'number', min: 68, ph: '1500 / 9000' },
      { k: 'poe', label: 'PoE', list: 'poe_options' },
      { k: 'parent', label: 'Member of / parent', ph: 'bond0, vmbr0, eth0' },
      { k: 'wifi_ssid', label: 'Wi-Fi SSID', showIf: v => /wi-?fi|wlan|wireless/i.test(v.kind || '') },
      { section: 'Addressing' },
      { k: 'assignment', label: 'Assignment', type: 'select', options: S.enums.ip_assignments },
      { k: 'network_id', label: 'Network', type: 'fk', entity: 'networks', none: 'Detect from IP' },
      { k: 'ip', label: 'IPv4 address', ph: '10.0.10.5 or 10.0.10.5/24', inputmode: 'decimal' },
      { k: 'subnet', label: 'Subnet / prefix', ph: '/24' },
      { k: 'gateway', label: 'Gateway', inputmode: 'decimal' },
      { k: 'ipv6', label: 'IPv6 address', ph: 'fd00:10::5/64' },
      { k: 'dns_servers', label: 'DNS servers', ph: '10.0.10.1' },
      { k: 'dns_name', label: 'DNS name', ph: 'nas.lab.home.arpa' },
      { section: 'VLANs & switching' },
      { k: 'port_mode', label: 'Port mode', type: 'select', options: S.enums.port_modes },
      { k: 'vlan', label: 'Access VLAN', ph: '10', showIf: v => !trunk(v) },
      { k: 'native_vlan', label: 'Native / untagged VLAN', showIf: trunk },
      { k: 'tagged_vlans', label: 'Tagged VLANs', ph: '10, 20, 30-40', showIf: trunk },
      { k: 'notes', label: 'Notes', wide: true },
    ];
  },
  builds: () => [
    { k: 'name', label: 'Name', required: true, ph: 'Gaming rig 2026, NAS from spares' },
    { k: 'purpose', label: 'Purpose', list: 'build_purposes' },
    { k: 'status', label: 'Status', type: 'select', options: S.enums.build_statuses, required: true, default: 'Planning' },
    { k: 'budget', label: 'Budget', type: 'number', step: '0.01', min: 0 },
    { k: 'device_id', label: 'Linked device (for upgrades / once built)', type: 'fk', entity: 'devices', none: 'None', wide: true },
    { k: 'notes', label: 'Notes', type: 'textarea', wide: true },
  ],
  services: () => [
    { k: 'device_id', label: 'Device', type: 'fk', entity: 'devices', required: true },
    { k: 'name', label: 'Service', required: true, ph: 'Proxmox UI, Plex, SSH' },
    { k: 'protocol', label: 'Protocol', list: 'protocols' },
    { k: 'port', label: 'Port', type: 'number', min: 0 },
    { k: 'url', label: 'URL', ph: 'https://…', wide: true, inputmode: 'url' },
    { k: 'version', label: 'Version' },
    { k: 'status', label: 'Status', list: 'service_statuses' },
    { k: 'notes', label: 'Notes', type: 'textarea', wide: true },
  ],
  credentials: () => [
    { k: 'label', label: 'Label', required: true, ph: 'iDRAC root, pfSense admin' },
    { k: 'kind', label: 'Kind', list: 'credential_kinds' },
    { k: 'username', label: 'Username', raw: true },
    { k: 'password', label: 'Password / secret', type: 'password', wide: true },
    { k: 'url', label: 'URL / host', wide: true, inputmode: 'url' },
    { k: 'device_id', label: 'Device', type: 'fk', entity: 'devices' },
    { k: 'service_id', label: 'Service', type: 'fk', entity: 'services' },
    { k: 'totp_secret', label: '2FA / TOTP secret (base32 or otpauth://)', type: 'password', wide: true },
    { k: 'last_rotated', label: 'Last rotated', type: 'date' },
    { k: 'secret_notes', label: 'Secret notes (encrypted): recovery codes, keys…', type: 'textarea', raw: true, secret: true, wide: true, rows: 4 },
  ],
  actions: () => [
    { k: 'name', label: 'Name', required: true, ph: 'Quiet the fans, Update, Restart' },
    { k: 'device_id', label: 'Device', type: 'fk', entity: 'devices', none: 'None (enter addresses below)' },
    { k: 'hosts', label: 'Send to', type: 'textarea', rows: 2, wide: true, ph: '10.0.0.21',
      help: 'Leave empty to use the device’s main address. For its management port (iLO, iDRAC) or several machines, enter the addresses, one per line.' },
    { k: 'credential_id', label: 'Login', type: 'fk', entity: 'credentials', none: 'None (use this computer’s SSH key)',
      help: 'A saved login from the Vault. HaRM uses its password to connect, and for sudo.' },
    { k: 'username', label: 'Username', raw: true, ph: 'root, Administrator', help: 'Only needed without a login, or to use another user.' },
    { k: 'port', label: 'SSH port', type: 'number', min: 1, ph: '22' },
    { k: 'mode', label: 'How to send it', type: 'select', required: true, default: 'script', wide: true, options: [
      { value: 'script', label: 'As one shell script (Linux, macOS, Proxmox, TrueNAS, Synology)' },
      { value: 'lines', label: 'One command per line (iLO, iDRAC, switches, Windows)' }] },
    { k: 'command', label: 'Commands', type: 'textarea', required: true, wide: true, rows: 8, raw: true,
      ph: 'uptime\ndf -h', help: 'Lines starting with # are notes and aren’t sent when sending one command per line.' },
    { k: 'sudo', label: 'Run with sudo', type: 'checkbox', showIf: v => v.mode !== 'lines', clearWhenHidden: true },
    { k: 'legacy_ssh', label: 'Older SSH (iLO, iDRAC, old switches)', type: 'checkbox',
      help: 'Turns on the older ways of connecting that old management ports need.' },
    { k: 'confirm', label: 'Ask before running', type: 'checkbox', help: 'For things like restarting or shutting down.' },
    { k: 'pinned', label: 'Show a button on the Status page', type: 'checkbox', default: true },
    { k: 'ssh_options', label: 'Other SSH settings', wide: true, raw: true, adv: true, ph: '-o KexAlgorithms=+diffie-hellman-group14-sha1',
      help: 'Paste the -o settings from an ssh command that works. Only connection settings are allowed.' },
    { k: 'notes', label: 'Notes', type: 'textarea', wide: true, adv: true },
  ],
  connections: () => [
    { k: 'a_device_id', label: 'From device', type: 'fk', entity: 'devices', required: true },
    { k: 'a_port', label: 'From port', ph: 'eth0, port 12, SFP+ 1' },
    { k: 'b_device_id', label: 'To device', type: 'fk', entity: 'devices', none: 'Untracked endpoint' },
    { k: 'b_port', label: 'To port', showIf: v => !!v.b_device_id },
    { k: 'b_endpoint', label: 'Untracked endpoint', ph: 'ISP modem, wall jack 3B', wide: true, showIf: v => !v.b_device_id, clearWhenHidden: true },
    { k: 'medium', label: 'Medium / cable', list: 'mediums' },
    { k: 'speed', label: 'Link speed' },
    { k: 'cable_label', label: 'Cable label', scan: true },
    { k: 'length', label: 'Length', ph: '1 m' },
    { k: 'color', label: 'Color' },
    { k: 'notes', label: 'Notes', wide: true },
  ],
};

/* Fields carried into the next form by "Save & add another". */
const STICKY: Record<string, string[]> = {
  devices: ['device_type', 'status', 'location_id', 'rack_id', 'manufacturer', 'connected', 'vendor', 'purchase_date'],
  components: ['category', 'status', 'device_id', 'condition', 'location_id', 'rack_id', 'position', 'manufacturer', 'model',
    'part_number', 'capacity', 'interface', 'form_factor', 'speed', 'vendor', 'purchase_date', 'purchase_price', 'warranty_until'],
  interfaces: ['device_id', 'kind', 'network_id', 'assignment', 'port_mode', 'speed'],
  locations: ['parent_id', 'kind'],
  racks: ['location_id', 'kind', 'height_u'],
  networks: ['location_id', 'kind'],
  services: ['device_id', 'protocol'],
  connections: ['a_device_id', 'medium', 'speed', 'color'],
  device_slots: ['device_id'],
  credentials: ['device_id', 'kind'],
  actions: ['device_id', 'credential_id', 'mode', 'legacy_ssh', 'port'],
};
/* Fields a label scan can fill. */
const SCAN_TARGETS: Record<string, string[]> = {
  devices: ['serial', 'model', 'manufacturer', 'asset_tag'],
  components: ['serial', 'part_number', 'model', 'manufacturer', 'capacity'],
  interfaces: ['mac', 'name'],
};
type After = ((r?: any) => unknown) | null | undefined;

export function editEntity(entity: string, rec: Row | null, after?: After, { autoScan = false, notice = null }: { autoScan?: boolean; notice?: string | null } = {}) {
  rec = rec || {};
  const isNew = !rec.id;
  // Drafts for new records are kept per context, so a half-typed part for one device
  // never shows up (or gets saved) when adding a part to a different device.
  const ctx = isNew ? Object.keys(rec).filter(k => k.endsWith('_id') && rec![k] != null).sort().map(k => `${k}=${rec![k]}`).join('&') : '';
  const r0 = rec;
  const dlg = formDialog({
    title: (isNew ? 'Add ' : 'Edit ') + LABELS[entity].toLowerCase(),
    fields: FORMS[entity](rec),
    rec,
    notice,
    preset: isNew ? rec : null,
    draftKey: `${entity}:${rec.id || 'new'}${ctx ? ':' + ctx : ''}`,
    again: isNew && STICKY[entity] ? { label: 'Save & add another' } : null,
    scanTargets: SCAN_TARGETS[entity],
    headButtons: entity === 'components' ? form => <button type="button" className="sm" onClick={() => libraryLookup(form)}>▦ Find in library</button>
      : entity === 'actions' && isNew ? form => <MenuButton label="Start from an example ▾" cls="sm"
        items={ACTION_TEMPLATES.map(t => [t.name, () => form.set({ sudo: false, legacy_ssh: false, confirm: false, notes: '', ...t })])} /> : undefined,
    submit: async vals => {
      const r = isNew ? await api('POST', `/${entity}`, vals) : await api('PUT', `/${entity}/${r0.id}`, vals);
      if ((LOOKUPS as readonly string[]).includes(entity)) await loadLookups();
      return r;
    },
    onDone: async (r, { again, vals }) => {
      const label = r && (r.name || r.label || [r.manufacturer, r.model, r.capacity].filter(Boolean).join(' ') || r.category || r.ip);
      if (again) {
        const next: Row = {};
        for (const k of STICKY[entity]) if (vals[k] != null && vals[k] !== '') next[k] = vals[k];
        rerender();
        editEntity(entity, next, after, { autoScan, notice: `✓ Saved “${label || LABELS[entity]}”. Fill in the next one, or Cancel when you’re done.` });
      } else {
        const msg = `${isNew ? 'Added' : 'Saved'} ${label ? `“${label}”` : ''}`;
        await (after || rerender)(r);
        await new Promise(res => setTimeout(res, 0));  // let any navigation settle
        const prev = S.hist[S.hist.length - 2];
        if (prev && prev.hash !== location.hash) toast(msg, 'ok', { label: `← Back to ${prev.title || 'previous page'}`, onClick: () => history.back() });
        else toast(msg);
      }
    },
  });
  if (autoScan) scanLabel(dlg.form, SCAN_TARGETS[entity] || []);
  return dlg;
}

export async function editCredential(rec: Row, after?: After) {
  if (rec && rec.id) {
    const sec = await api('POST', `/credentials/${rec.id}/reveal`);
    rec = { ...rec, password: sec.password, totp_secret: sec.totp_secret, secret_notes: sec.secret_notes };
  }
  editEntity('credentials', rec, after);
}

export async function deleteEntity(entity: EntityName | string, rec: Row, after?: After, warn = '') {
  const name = rec.name || rec.label || rec.model || rec.interface || rec.a_port || rec.ip || `#${rec.id}`;
  if (!await confirmBox(`Delete ${LABELS[entity].toLowerCase()} "${name}"? ${warn}`)) return;
  try {
    await api('DELETE', `/${entity}/${rec.id}`);
    toast('Deleted');
    if ((LOOKUPS as readonly string[]).includes(entity)) await loadLookups();
    (after || rerender)();
  } catch (e) { toast((e as Error).message, 'bad'); }
}

export function RowActions({ entity, r, after }: { entity: string; r: Row; after?: After }) {
  return (
    <div className="row-actions">
      <Small label="Edit" onClick={() => entity === 'credentials' ? editCredential(r, after) : editEntity(entity, r, after)} />
      <Small label="Delete" onClick={() => deleteEntity(entity, r, after)} cls="ghost-danger" />
    </div>
  );
}
