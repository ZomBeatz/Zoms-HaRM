/* Spare Parts: drives, memory, cards and cables, on the shelf or inside a device. */
import { useEffect, useState } from 'react';
import { GET, openDownload } from '../api/client';
import { S, aiOn } from '../lib/state';
import { fmtGB, nz, parseSizeGB, STORAGE_CATS, type Row } from '../lib/util';
import { Badge, Btn, HelpLink, MenuButton, PageHead, Small, Table } from '../ui/bits';
import { CompWhere } from '../ui/tables';
import { deleteEntity, editEntity } from '../lib/forms';
import { installDialog, uninstallDialog } from '../dialogs/parts';
import { aiAssist } from '../dialogs/later';
import { Pending, cleanHash, useLoad } from '../app/router';

/* "Drives here: 12 × 4 TB HDD, 6 × 1 TB HDD = 54 TB" for the parts shown. */
export function storageSummary(list: Row[]) {
  const groups = new Map<string, number>();
  let total = 0, n = 0;
  for (const r of list) {
    if (!STORAGE_CATS.test(r.category)) continue;
    const gb = parseSizeGB(r.capacity);
    n += r.quantity;
    if (!gb) continue;
    const key = `${r.capacity} ${r.category}`;
    groups.set(key, (groups.get(key) || 0) + r.quantity);
    total += gb * r.quantity;
  }
  if (!n) return null;
  const parts = [...groups].sort((a, b) => (parseSizeGB(b[0].split(' ').slice(0, 2).join(' ')) || 0) - (parseSizeGB(a[0].split(' ').slice(0, 2).join(' ')) || 0))
    .map(([k, c]) => `${c} × ${k}`).join(' · ');
  return { total: fmtGB(total), n, parts };
}

const TABS: [string, string, (r: Row) => boolean][] = [['spares', 'Spares in stock', r => !r.device_id && r.status === 'In Stock'],
  ['installed', 'Installed', r => !!r.device_id], ['other', 'RMA / faulty / reserved', r => !r.device_id && r.status !== 'In Stock'],
  ['all', 'All', () => true]];

export default function Components({ q: qs }: { q: URLSearchParams }) {
  const q = useLoad(() => GET<Row[]>('/components'));
  const F = S.filters.components;
  const [, redraw] = useState(0);
  const [hl] = useState(() => qs.get('id'));
  const set = (k: string, v: string) => { F[k] = v; redraw(n => n + 1); };
  useEffect(() => {
    const hit = q.data && hl ? q.data.find(r => String(r.id) === hl) : null;
    if (hit) { F.tab = TABS.find(t => t[2](hit))![0]; redraw(n => n + 1); cleanHash('#/components'); editEntity('components', hit, q.reload); }
  }, [!!q.data]);  // eslint-disable-line react-hooks/exhaustive-deps
  if (!q.data) return <Pending q={q} />;
  const rows = q.data;
  const cats = [...new Set(rows.map(r => r.category))].sort();
  const ifaces = [...new Set(rows.map(r => r.interface).filter(Boolean))].sort();
  const tf = (TABS.find(t => t[0] === F.tab) || TABS[0])[2];
  const needle = (F.q || '').toLowerCase();
  const list = rows.filter(r => tf(r) && (!F.cat || r.category === F.cat) && (!F.iface || r.interface === F.iface) &&
    (!needle || [r.manufacturer, r.model, r.part_number, r.serial, r.capacity, r.interface, r.form_factor, r.tags, r.notes, r.device_name].some(x => x && x.toLowerCase().includes(needle))));
  const sum = storageSummary(list);
  return <>
    <PageHead title="Spare Parts" sub="Drives, memory, cards, cables: everything on the shelf or inside a device.">
      <HelpLink s="parts" />
      {aiOn() ? <Btn label="🤖 AI Assist" onClick={() => aiAssist()} /> : null}
      <MenuButton label="⋯" items={[['⇩ Export CSV', () => openDownload('/api/export/components.csv')]]} />
      <Btn label="+ Add part" onClick={() => editEntity('components', { status: 'In Stock', quantity: 1 })} cls="primary" />
    </PageHead>
    <div className="tabs">{TABS.map(([k, label, fn]) => (
      <button key={k} type="button" className={F.tab === k ? 'active' : ''} onClick={() => set('tab', k)}>{`${label} (${rows.filter(fn).reduce((a, r) => a + r.quantity, 0)})`}</button>
    ))}</div>
    <div className="toolbar">
      <input type="search" placeholder="Filter…" value={F.q || ''} onChange={e => set('q', e.target.value)} />
      <select value={F.cat || ''} onChange={e => set('cat', e.target.value)}><option value="">All categories</option>{cats.map(c => <option key={c} value={c}>{c}</option>)}</select>
      <select value={F.iface || ''} onChange={e => set('iface', e.target.value)}><option value="">All interfaces</option>{ifaces.map(c => <option key={c} value={c}>{c}</option>)}</select>
    </div>
    <div className="storage-sum">{sum ? <><b>{`💾 ${sum.total} of drives`}</b>{` in ${sum.n} drive${sum.n === 1 ? '' : 's'}: `}{sum.parts}</> : null}</div>
    <Table rows={list} empty={rows.length ? 'No parts match.' : 'No parts cataloged yet.'} rowClass={r => hl === String(r.id) ? 'hl' : ''} cols={[
      { label: 'Category', get: r => r.category },
      { label: 'Part', get: r => <span><b>{nz(r.manufacturer, r.model) || 'None'}</b>{r.part_number ? <div className="muted small mono">{r.part_number}</div> : null}</span> },
      { label: 'Capacity', get: r => r.capacity || '' },
      { label: 'Interface', get: r => nz(r.interface, r.form_factor) },
      { label: 'Speed', get: r => r.speed || '' },
      { label: 'Qty', get: r => r.quantity, sort: r => r.quantity },
      { label: 'Status', get: r => <Badge status={r.status} /> },
      { label: 'Condition', get: r => r.condition || '' },
      { label: 'Where', get: r => <CompWhere r={r} /> },
      { label: 'Serial', get: r => <span className="mono small">{r.serial || ''}</span> },
      { label: '', nosort: true, get: r => <div className="row-actions">
        {r.device_id ? <Small label="Remove" onClick={() => uninstallDialog(r)} /> : (r.quantity > 0 ? <Small label="Install" onClick={() => installDialog(r)} cls="primary" /> : null)}
        <Small label="Edit" onClick={() => editEntity('components', r)} />
        <Small label="Delete" onClick={() => deleteEntity('components', r)} cls="ghost-danger" />
      </div> },
    ]} />
  </>;
}
