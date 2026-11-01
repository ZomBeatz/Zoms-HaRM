/* Names and paths from the lookup lists every page shares (locations, racks, devices…). */
import { S } from './state';
import type { Row } from './util';
import { nz } from './util';

export function locPath(id: number | null | undefined) {
  const parts: string[] = [];
  let cur = S.lk.locations.find(l => l.id === id), guard = 0;
  while (cur && guard++ < 25) {
    parts.unshift(cur.name);
    const parent: number | null = cur.parent_id;
    cur = S.lk.locations.find(l => l.id === parent);
  }
  return parts.join(' > ');
}

export function lkLabel(entity: string, r: Row): string {
  if (entity === 'racks') return `${r.name} (${nz(r.kind, r.location_name ? '· ' + r.location_name : '')})`;
  if (entity === 'locations') return locPath(r.id);
  if (entity === 'services') return `${r.name} (${r.device_name})`;
  if (entity === 'devices') return r.name + (r.device_type ? ` (${r.device_type})` : '');
  if (entity === 'networks') return r.name + (r.vlan_id ? ` · VLAN ${r.vlan_id}` : '') + (r.cidr ? ` · ${r.cidr}` : '');
  if (entity === 'credentials') return r.label + (r.username ? ` · ${r.username}` : '') + (r.device_name ? ` (${r.device_name})` : '');
  return r.name;
}

/* Location `id` plus every location nested inside it. */
export function locDescendants(id: number | string) {
  const out = new Set([Number(id)]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const l of S.lk.locations) {
      if (l.parent_id && out.has(l.parent_id) && !out.has(l.id)) { out.add(l.id); grew = true; }
    }
  }
  return out;
}
export const rackById = (id: unknown) => S.lk.racks.find(r => String(r.id) === String(id));
export const rackHasUnits = (id: unknown) => !!(id && rackById(id)?.height_u);
export const rackInLocation = (r: Row, v: Row) => !v.location_id || locDescendants(v.location_id).has(r.location_id);
