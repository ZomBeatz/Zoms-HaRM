/* Devices: the list, with filters and the hardware columns. */
import { useState } from 'react';
import { GET } from '../api/client';
import { S } from '../lib/state';
import { locPath } from '../lib/lookups';
import { fmtGB, isVirtual, nz, prefGet, prefSet, type Row } from '../lib/util';
import { A, Btn, Dot, PageHead, Small, Table } from '../ui/bits';
import { Placement, StatusSelect } from '../ui/tables';
import { editEntity } from '../lib/forms';
import { Pending, useLoad } from '../app/router';

/* "64 cores · 512 GB RAM · 120 TB" for a set of devices. */
export function fleetLine(ids: number[], sum: Row) {
  let cores = 0, ram = 0, st = 0, issues = 0, tasks = 0;
  for (const id of ids) {
    const x = sum.devices[id] || {};
    cores += x.cores || 0; ram += x.ram_gb || 0; st += x.storage_gb || 0; issues += x.issues || 0; tasks += x.tasks || 0;
  }
  return [cores ? `${cores} cores` : null, ram ? `${fmtGB(ram)} RAM` : null, st ? `${fmtGB(st)} raw storage` : null,
    issues ? `⚠ ${issues} open issue${issues > 1 ? 's' : ''}` : null, tasks ? `☐ ${tasks} open task${tasks > 1 ? 's' : ''}` : null].filter(Boolean);
}
export function TaskFlag({ x }: { x?: Row | null }) {
  if (!x || !(x.issues || x.tasks)) return null;
  return <span className={`badge ${x.issues ? 'warn' : 'info'}`} title={`${x.issues || 0} open issue(s), ${x.tasks || 0} open task(s)`}>
    {x.issues ? `⚠ ${x.issues}` : `☐ ${x.tasks}`}</span>;
}

const EXTRA = ['type', 'loc', 'rack', 'conn', 'kind'];

export default function Devices() {
  const q = useLoad(() => Promise.all([GET<Row[]>('/devices'), GET('/devices/summary')]));
  const F = S.filters.devices;
  const [, redraw] = useState(0);
  const [open, setOpen] = useState(() => EXTRA.some(k => F[k]) || S.devFiltersOpen);
  const [detailed, setDetailed] = useState(() => prefGet('harm-dev-detailed') === '1');
  if (!q.data) return <Pending q={q} />;
  const [rows, sum] = q.data;
  const hw = (r: Row) => sum.devices[r.id] || {};
  const set = (k: string, v: string) => { F[k] = v; redraw(n => n + 1); };
  const sel = (key: string, label: string, list: (string | { value: string; label: string })[]) => (
    <select value={F[key] || ''} aria-label={label} onChange={e => set(key, e.target.value)}>
      <option value="">{label}</option>
      {list.map(o => typeof o === 'string' ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
  const types = [...new Set(rows.map(r => r.device_type).filter(Boolean))].sort();
  const nActive = EXTRA.filter(k => F[k]).length;
  const needle = (F.q || '').toLowerCase();
  const list = rows.filter(r =>
    (!F.type || r.device_type === F.type) && (!F.status || r.status === F.status) &&
    (!F.rack || String(r.rack_id) === F.rack) && (!F.loc || String(r.location_id) === F.loc) &&
    (!F.conn || String(r.connected) === F.conn) &&
    (!F.kind || (F.kind === 'virt') === isVirtual(r)) &&
    (!needle || [r.name, r.hostname, r.model, r.manufacturer, r.serial, r.asset_tag, r.ips, r.tags, r.os].some(x => x && String(x).toLowerCase().includes(needle))));
  S.devVisible = list.map(r => r.id);
  const line = fleetLine(S.devVisible, sum);
  return <>
    <PageHead title="Devices" sub={`${rows.length} device${rows.length === 1 ? '' : 's'}`}>
      <Btn label="⇪ Export / PDF" onClick={() => { location.hash = '#/export?ids=' + S.devVisible.join(','); }} />
      <Btn label="+ Add device" onClick={() => editEntity('devices', {}, r => { location.hash = `#/devices/${r.id}`; })} cls="primary" />
    </PageHead>
    <div className="toolbar">
      <input type="search" placeholder="Filter…" value={F.q || ''} onChange={e => set('q', e.target.value)} />
      {sel('status', 'All statuses', S.enums.device_statuses)}
      <Btn label={`Filters${nActive ? ` · ${nActive}` : ''}`} onClick={() => { S.devFiltersOpen = !open; setOpen(!open); }} />
      <label className="check inline-check view-toggle"><input type="checkbox" checked={detailed}
        onChange={e => { prefSet('harm-dev-detailed', e.target.checked ? '1' : '0'); setDetailed(e.target.checked); }} />Hardware columns</label>
    </div>
    <div className="toolbar extra-filters" hidden={!open}>
      {sel('type', 'All types', types)}
      {sel('loc', 'All locations', S.lk.locations.map(l => ({ value: String(l.id), label: locPath(l.id) })))}
      {sel('rack', 'All holders', S.lk.racks.map(r => ({ value: String(r.id), label: r.name })))}
      {sel('conn', 'Hooked up?', [{ value: '1', label: 'Hooked up' }, { value: '0', label: 'Not hooked up' }])}
      {sel('kind', 'Physical & virtual', [{ value: 'phys', label: 'Physical only' }, { value: 'virt', label: 'VMs & containers only' }])}
      <Small label="Clear filters" cls="ghost" onClick={() => { for (const k of [...EXTRA, 'status', 'q']) delete F[k]; redraw(n => n + 1); }} />
    </div>
    <div>
      {line.length ? <div className="fleet-line"><b>{`${list.length} device${list.length === 1 ? '' : 's'}`}</b>{' · '}{line.join(' · ')}</div> : null}
      <Table rows={list} empty={rows.length ? 'No devices match the filters.' : 'No devices yet. Add your first one.'} onRow={r => { location.hash = `#/devices/${r.id}`; }} cols={[
        { label: '', get: r => <Dot on={r.connected} />, sort: r => r.connected, cls: 'narrow' },
        { label: 'Name', get: r => <div><A href={`#/devices/${r.id}`}>{r.name}</A>
          {!detailed && (r.manufacturer || r.model || r.device_type) ? <div className="muted small">{[r.device_type, nz(r.manufacturer, r.model)].filter(Boolean).join(' · ')}</div> : null}</div>, sort: r => r.name },
        detailed && { label: 'Type', get: r => r.device_type || '' },
        { label: 'Status', get: r => <StatusSelect dev={r} after={q.reload} />, sort: r => r.status },
        detailed && { label: 'Model', get: r => nz(r.manufacturer, r.model) },
        detailed && { label: 'Cores', get: r => hw(r).cores || '', sort: r => hw(r).cores || 0 },
        detailed && { label: 'RAM', get: r => hw(r).ram || <span className="muted">{r.ram || ''}</span>, sort: r => hw(r).ram_gb || 0 },
        detailed && { label: 'Storage', get: r => hw(r).storage || '', sort: r => hw(r).storage_gb || 0 },
        { label: 'IP', get: r => <span className="mono">{detailed ? (r.ips || '') : (r.ips || '').split(', ')[0]}</span> },
        { label: 'Where', get: r => r.host_id ? <span>⧉ on <A href={`#/devices/${r.host_id}`}>{r.host_name || 'host'}</A></span>
          : r.rack_id ? <Placement d={r} /> : (r.location_id ? nz(locPath(r.location_id), r.position ? `· ${r.position}` : '') : '') },
        { label: '⚑', get: r => <TaskFlag x={hw(r)} />, sort: r => (hw(r).issues || 0) * 100 + (hw(r).tasks || 0) },
      ]} />
    </div>
  </>;
}
