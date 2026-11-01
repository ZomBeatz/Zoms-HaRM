/* Export & Share: pick devices and what to include, then copy, download or print. */
import { useState } from 'react';
import { GET } from '../api/client';
import { S, aiOn } from '../lib/state';
import { locDescendants, locPath } from '../lib/lookups';
import { downloadText, prefGet, prefSet, type Row } from '../lib/util';
import { copy, toast } from '../ui/overlay';
import { Btn, Card, HelpLink, PageHead, Small } from '../ui/bits';
import { formDialog } from '../ui/form';
import { EXPORT_SECTIONS, exportCSV, exportMarkdown } from '../lib/export';
import { printLabels, printSheet } from '../dialogs/print';
import { Pending, useLoad } from '../app/router';

export default function Export({ q: qs }: { q: URLSearchParams }) {
  const q = useLoad(() => GET<Row[]>('/devices'));
  const F = S.filters.export = S.filters.export || {};
  // What to include, the title and the sell sheet's lines are remembered on this device.
  const saved: Row = (() => { try { return JSON.parse(prefGet('harm-export') || '{}'); } catch { return {}; } })();
  const remember = (c: Row) => prefSet('harm-export', JSON.stringify({ ...saved, ...c }));
  const [picked, setPicked] = useState<Set<number>>(() => {
    const pre = (qs.get('ids') || '').split(',').filter(Boolean).map(Number);
    return new Set(pre.length ? pre : (F.picked || []));
  });
  const [sec, setSec] = useState<Record<string, boolean>>(() => F.sec || saved.sec || Object.fromEntries(EXPORT_SECTIONS.map(([k, , on]) => [k, on])));
  const [title, setTitle] = useState<string>(F.title ?? saved.title ?? '');
  const [filters, setFilters] = useState({ loc: '', rack: '', type: '', status: '' });
  const [out, setOut] = useState<string | null>(null);
  if (!q.data) return <Pending q={q} />;
  const devices = q.data;
  F.sec = sec;
  if (JSON.stringify(saved.sec) !== JSON.stringify(sec)) remember({ sec });
  const pick = (next: Set<number>) => { F.picked = [...next]; setPicked(next); };
  const matches = (d: Row) => (!filters.loc || locDescendants(filters.loc).has(d.location_id)) && (!filters.rack || String(d.rack_id) === filters.rack)
    && (!filters.type || d.device_type === filters.type) && (!filters.status || d.status === filters.status);
  const vis = devices.filter(matches);
  const selectVisible = (on: boolean) => { const n = new Set(picked); for (const d of vis) on ? n.add(d.id) : n.delete(d.id); pick(n); };
  const sel = (label: string, key: keyof typeof filters, list: (string | { value: string; label: string })[]) => (
    <select aria-label={label} value={filters[key]} onChange={e => setFilters(f => ({ ...f, [key]: e.target.value }))}>
      <option value="">{label}</option>
      {list.map(o => typeof o === 'string' ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
  const getBundle = async (): Promise<Row[] | null> => {
    if (!picked.size) { toast('Select at least one device', 'bad'); return null; }
    return GET('/export/bundle?ids=' + [...picked].join(','));
  };
  const asMarkdown = async (then: (md: string) => void) => {
    const b = await getBundle(); if (!b) return;
    const md = exportMarkdown(b, sec, { title: F.title });
    setOut(md);
    then(md);
  };
  const sellSheet = async () => {
    const b = await getBundle(); if (!b) return;
    formDialog({
      title: 'Sell sheet',
      fields: [
        { k: 'title', label: 'Title', default: F.title || 'Hardware for sale', wide: true },
        { k: 'subtitle', label: 'Subtitle', ph: 'Local pickup, tested and working', wide: true, default: saved.subtitle },
        { k: 'condition', label: 'Condition', ph: 'Used, fully working', default: saved.condition, chips: ['Used, fully working', 'Refurbished', 'For parts / not working'], wide: true },
        ...b.map(d => ({ k: `p_${d.device.id}`, label: `Asking price: ${d.device.name}`, ph: '$250 or OBO' })),
        { k: 'footer', label: 'Contact line', ph: 'Contact: name, phone or email', wide: true, default: saved.footer },
      ],
      saveLabel: 'Create PDF',
      submit: async v => { remember({ subtitle: v.subtitle, condition: v.condition, footer: v.footer }); return v; },
      onDone: v => printSheet(b, { ...sec, location: false, basics: false, logins: false, purchase: false, slots: false, connections: false },
        { mode: 'sell', title: v.title, subtitle: v.subtitle, condition: v.condition, footer: v.footer,
          prices: Object.fromEntries(b.map(d => [d.device.id, v[`p_${d.device.id}`]])) }),
    });
  };
  return <>
    <PageHead title="Export & share" sub={`Pick devices and what to include. Copy it for a person${aiOn() ? ' or an AI assistant' : ''}, download it, or make a PDF.`}><HelpLink s="export" /></PageHead>
    <div className="grid two">
      <Card title="1. Devices"><div>
        <div className="toolbar">
          {sel('All locations', 'loc', S.lk.locations.map(l => ({ value: String(l.id), label: locPath(l.id) })))}
          {sel('All holders', 'rack', S.lk.racks.map(r => ({ value: String(r.id), label: r.name })))}
          {sel('All types', 'type', [...new Set(devices.map(d => d.device_type).filter(Boolean))].sort())}
          {sel('All statuses', 'status', S.enums.device_statuses)}
        </div>
        <div className="inline"><Small label="Select shown" onClick={() => selectVisible(true)} /><Small label="Clear shown" onClick={() => selectVisible(false)} />
          <span className="muted">{`${picked.size} selected`}</span></div>
        <div className="export-list">{vis.map(d => (
          <label key={d.id} className="check export-dev"><input type="checkbox" checked={picked.has(d.id)} onChange={e => {
            const n = new Set(picked); e.target.checked ? n.add(d.id) : n.delete(d.id); pick(n);
          }} /><span><b>{d.name}</b><span className="muted small">{' ' + [d.device_type, d.rack_name || d.location_name].filter(Boolean).join(' · ')}</span></span></label>
        ))}</div>
      </div></Card>
      <Card title="2. Include"><div>
        <div className="export-secs">{EXPORT_SECTIONS.map(([k, label]) => (
          <label key={k} className="check"><input type="checkbox" checked={!!sec[k]} onChange={e => setSec(s => ({ ...s, [k]: e.target.checked }))} /><span>{label}</span></label>
        ))}</div>
        <input placeholder="Title (optional)" value={title} onChange={e => { F.title = e.target.value; setTitle(e.target.value); remember({ title: e.target.value }); }} />
        <p className="muted small">Passwords and other secrets are never exported.</p>
      </div></Card>
    </div>
    <Card title="3. Get it"><div>
      <div className="export-actions">
        <Btn label={aiOn() ? '📋 Copy for AI / chat (Markdown)' : '📋 Copy as Markdown'} onClick={() => asMarkdown(md => copy(md, 'Markdown'))} cls="primary" />
        <Btn label="⬇ Markdown (.md)" onClick={() => asMarkdown(md => downloadText('harm-export.md', md, 'text/markdown'))} />
        <Btn label="⬇ Spreadsheet (.csv)" onClick={async () => { const b = await getBundle(); if (b) downloadText('harm-export.csv', exportCSV(b, sec), 'text/csv'); }} />
        <Btn label="⬇ JSON" onClick={async () => { const b = await getBundle(); if (b) downloadText('harm-export.json', JSON.stringify(b, null, 2), 'application/json'); }} />
        <Btn label="🖨 Spec sheet (PDF)" onClick={async () => { const b = await getBundle(); if (b) printSheet(b, sec, { title: F.title }); }} />
        <Btn label="🏷 Sell sheet (PDF)" onClick={sellSheet} />
        <Btn label="🔳 QR labels" onClick={() => { if (!picked.size) return toast('Select at least one device', 'bad'); printLabels([...picked]); }} />
      </div>
      <p className="muted small">PDFs open your browser’s print dialog: choose “Save as PDF” (on a phone: Share &gt; Print, then pinch out or Save).</p>
      {out != null ? <pre className="code export-out">{out}</pre> : null}
    </div></Card>
  </>;
}
