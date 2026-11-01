/* Export & Share: devices as Markdown (for a person or an AI chat) and as a spreadsheet. */
import { money, nz, type Row } from './util';

export const EXPORT_SECTIONS: [string, string, boolean][] = [
  ['basics', 'Basics (type, model, status)', true], ['serial', 'Serial / service tag', true],
  ['location', 'Location & rack position', true], ['hardware', 'CPU, RAM, PSU, OS', true],
  ['storage', 'Storage & drives', true], ['parts', 'Other installed parts', true],
  ['network', 'Network (IPs, MACs, VLANs)', true], ['services', 'Services', true],
  ['slots', 'Slots & bays', false], ['connections', 'Cabling', false],
  ['logins', 'Login names (never passwords)', false], ['purchase', 'Purchase & warranty', false], ['notes', 'Notes', true],
];
export type Sections = Record<string, boolean>;

export function exportMarkdown(bundle: Row[], sec: Sections, opts: { title?: string; now?: Date } = {}) {
  const L: string[] = [];
  const row = (k: string, v: unknown) => { if (v != null && v !== '') L.push(`- **${k}:** ${v}`); };
  L.push(`# ${opts.title || 'Hardware inventory'}`, '', `_${bundle.length} device${bundle.length === 1 ? '' : 's'} · exported ${(opts.now || new Date()).toLocaleString()} from Zom's HaRM_`, '');
  for (const d of bundle) {
    const v = d.device;
    L.push(`## ${v.name}`, '');
    if (sec.basics) { row('Type', v.device_type); row('Make / model', nz(v.manufacturer, v.model)); row('Status', `${v.status}${v.connected ? ', hooked up' : ', not hooked up'}`); }
    if (sec.serial) row('Serial / service tag', v.serial);
    if (sec.location) {
      row('Location', v.location_path);
      row('Rack / holder', v.rack_name ? `${v.rack_name}${v.rack_u ? ` U${v.rack_u}${v.u_height > 1 ? '-' + (v.rack_u + v.u_height - 1) : ''} (${v.rack_face})` : ''}` : null);
      row('Spot', v.position);
    }
    if (sec.hardware) { row('Hostname', v.hostname); row('OS', v.os); row('CPU', v.cpu); row('RAM', v.ram); row('PSU', v.psu); row('Management URL', v.mgmt_url); }
    if (sec.purchase) { row('Purchased', nz(v.purchase_date, v.vendor ? `from ${v.vendor}` : '')); row('Price', v.purchase_price != null ? money(v.purchase_price) : null); row('Warranty until', v.warranty_until); }
    if (sec.storage && d.storage.drives) {
      L.push('', `**Storage:** ${d.storage.total} raw (${d.storage.drives} drives)`);
      for (const g of d.storage.groups) L.push(`- ${g.count} × ${g.capacity} ${g.category}`);
    }
    const storageCats = /^(hdd|ssd|nvme ssd|usb \/ flash)$/i;
    const parts = d.components.filter((c: Row) => sec.parts && !(sec.storage && storageCats.test(c.category)));
    if (parts.length) {
      L.push('', '**Parts:**');
      for (const c of parts) L.push(`- ${c.quantity > 1 ? c.quantity + ' × ' : ''}${[c.category, c.manufacturer, c.model, c.capacity, c.interface].filter(Boolean).join(' · ')}${sec.serial && c.serial ? ` (S/N ${c.serial})` : ''}`);
    }
    if (sec.network && d.interfaces.length) {
      L.push('', '**Network:**', '', '| Interface | Network | IP | MAC | VLAN | Speed |', '|---|---|---|---|---|---|');
      for (const i of d.interfaces) L.push(`| ${i.name || ''} | ${i.network_name || ''} | ${i.ip ? i.ip + (i.subnet && String(i.subnet).startsWith('/') ? i.subnet : '') : ''} | ${i.mac || ''} | ${i.port_mode && /trunk/i.test(i.port_mode) ? `trunk ${i.native_vlan || ''}/${i.tagged_vlans || ''}` : (i.vlan || '')} | ${i.speed || ''} |`);
    }
    if (sec.services && d.services.length) {
      L.push('', '**Services:**');
      for (const s of d.services) L.push(`- ${s.name}${s.port ? ` (${nz(s.protocol, s.port)})` : ''}${s.url ? ` ${s.url}` : ''}${s.version ? ` v${s.version}` : ''}`);
    }
    if (sec.slots && d.slots.length) {
      L.push('', '**Slots & bays:**');
      for (const s of d.slots) L.push(`- ${s.interface}${s.form_factor ? ' ' + s.form_factor : ''}: ${s.used}/${s.total} used${s.notes ? ` (${s.notes})` : ''}`);
    }
    if (sec.connections && d.connections.length) {
      L.push('', '**Cabling:**');
      for (const c of d.connections) L.push(`- ${c.a_device_name}:${c.a_port || '?'} → ${c.b_device_name ? `${c.b_device_name}:${c.b_port || '?'}` : c.b_endpoint || '?'}${c.medium ? ` (${c.medium})` : ''}`);
    }
    if (sec.logins && d.credentials.length) {
      L.push('', '**Logins (names only):**');
      for (const c of d.credentials) L.push(`- ${c.label}${c.username ? `: ${c.username}` : ''}${c.url ? ` @ ${c.url}` : ''}`);
    }
    if (sec.notes && v.notes) L.push('', '**Notes:**', '', v.notes);
    if (sec.notes && d.notes?.length) {
      const open = d.notes.filter((n: Row) => (n.kind === 'task' || n.kind === 'issue') && !n.done);
      const log = d.notes.filter((n: Row) => !open.includes(n)).slice(0, 10);
      if (open.length) { L.push('', '**Open tasks / issues:**'); for (const n of open) L.push(`- [ ] ${n.kind === 'issue' ? '⚠ ' : ''}${n.body}`); }
      if (log.length) { L.push('', '**Notes & history:**'); for (const n of log) L.push(`- ${n.created_at.slice(0, 10)} (${n.kind}${n.done ? ', done' : ''}): ${n.body.replace(/\n/g, ' ')}`); }
    }
    L.push('');
  }
  return L.join('\n');
}

/* A cell that a spreadsheet won't run as a formula. */
export const csvCell = (v: unknown) => {
  let x = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(x)) x = "'" + x;
  return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
};

export function exportCSV(bundle: Row[], sec: Sections) {
  const cols: [string, string][] = [['name', 'Name'], ['device_type', 'Type'], ['manufacturer', 'Manufacturer'], ['model', 'Model'], ['status', 'Status']];
  if (sec.serial) cols.push(['serial', 'Serial / service tag']);
  if (sec.location) cols.push(['location_path', 'Location'], ['rack_name', 'Rack'], ['rack_u', 'U'], ['position', 'Spot']);
  if (sec.hardware) cols.push(['hostname', 'Hostname'], ['os', 'OS'], ['cpu', 'CPU'], ['ram', 'RAM'], ['psu', 'PSU']);
  if (sec.purchase) cols.push(['purchase_date', 'Purchased'], ['purchase_price', 'Price'], ['warranty_until', 'Warranty']);
  const head = [...cols.map(c => c[1]), ...(sec.storage ? ['Storage (raw)', 'Drives'] : []), ...(sec.network ? ['IPs', 'MACs'] : [])];
  const lines = [head.map(csvCell).join(',')];
  for (const d of bundle) {
    const v = d.device;
    lines.push([...cols.map(c => csvCell(v[c[0]])),
      ...(sec.storage ? [csvCell(d.storage.total), csvCell(d.storage.groups.map((g: Row) => `${g.count}x ${g.capacity}`).join('; '))] : []),
      ...(sec.network ? [csvCell(d.interfaces.map((i: Row) => i.ip).filter(Boolean).join('; ')), csvCell(d.interfaces.map((i: Row) => i.mac).filter(Boolean).join('; '))] : [])].join(','));
  }
  return lines.join('\n');
}
