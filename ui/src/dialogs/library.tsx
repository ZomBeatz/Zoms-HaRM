/* The parts library (BuildCores OpenDB plus your custom parts): searching, details, custom parts,
 * and picking parts for a build or a CPU for a device. */
import { useEffect, useRef, useState } from 'react';
import { api, GET } from '../api/client';
import { S, rerender } from '../lib/state';
import { rackInLocation } from '../lib/lookups';
import { type Row } from '../lib/util';
import { confirmBox, modal, toast, type ModalCtl } from '../ui/overlay';
import { Btn, KV, Mono, Small, Spinner } from '../ui/bits';
import { FormCtl, FormGrid, formDialog, type Field, type Vals } from '../ui/form';
import { rackPicked } from '../lib/forms';

export async function pcMeta() {
  if (!S.pc) S.pc = await GET('/catalog/meta');
  return S.pc!;
}
export const catLabel = (k: string) => (S.pc?.categories.find((c: Row) => c.key === k) || {}).label || k;
export const SourceBadge = ({ src }: { src: string }) => <span className={`badge ${src === 'custom' ? 'info' : src === 'inventory' ? 'ok' : 'muted'}`}>
  {({ library: 'Library', custom: 'Custom', inventory: 'My inventory', manual: 'Manual' } as Record<string, string>)[src] || src}</span>;

export function fmtSpec(type: string, v: any): string {
  if (v == null || v === '') return '';
  if (type === 'bool') return v ? 'Yes' : 'No';
  if (type === 'm2') return v.map((m: Row) => `${(m.sizes || []).join('/')}${m.interface ? ` (${m.interface})` : ''}`).join(', ');
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

function LibraryUpdate({ m, onDone }: { m: ModalCtl; onDone?: () => void }) {
  const [msg, setMsg] = useState<React.ReactNode>(<><Spinner /> Starting…</>);
  useEffect(() => {
    api('POST', '/catalog/update').catch(e => setMsg(e.message));
    const poll = setInterval(async () => {
      if (!S.authed) return clearInterval(poll);
      let st: Row;
      try { st = await GET('/catalog/status'); } catch { return; }
      const j = st.job;
      if (j.phase === 'downloading') setMsg(<><Spinner />{` Downloading… ${(j.done / 1048576).toFixed(1)} MB`}</>);
      else if (j.phase === 'importing') setMsg(<><Spinner />{` Importing… ${j.done.toLocaleString()} parts`}</>);
      if (!j.running && (j.phase === 'done' || j.phase === 'failed')) {
        clearInterval(poll);
        if (j.phase === 'failed') { setMsg(<span className="bad-text">{`Update failed: ${j.error}`}</span>); return; }
        setMsg(`✓ Done: ${st.total.toLocaleString()} parts in your library.`);
        toast('Parts library updated');
        onDone?.();
      }
    }, 1000);
    return () => clearInterval(poll);
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div><p>{msg}</p>
      <p className="muted small">Downloading BuildCores OpenDB (about 16 MB) and importing ~30,000 parts. You can close this; it keeps going in the background.</p>
      <div className="actions"><Btn label="Close" onClick={() => m.close(true)} /></div>
    </div>
  );
}
export const startLibraryUpdate = (onDone?: () => void) => modal('Updating the parts library', m => <LibraryUpdate m={m} onDone={onDone} />);

export function LibraryEmptyCard({ after }: { after?: () => void }) {
  return (
    <div className="card onboarding">
      <h3>Set up the parts library</h3>
      <p>Download about 30,000 parts (CPUs, motherboards, memory, video cards, cases, power supplies, coolers, storage and fans) with the specs HaRM needs for compatibility checks. Source: BuildCores OpenDB, free for personal use. About 16 MB; it takes under a minute.</p>
      <Btn label="⬇ Download parts library" onClick={() => startLibraryUpdate(after || rerender)} cls="primary" />
      <p className="muted small">Prefer not to? You can still use your own inventory and custom parts.</p>
    </div>
  );
}

function PartRow({ p, addLabel, onAdd }: { p: Row; addLabel: string; onAdd?: (() => void) | null }) {
  return (
    <div className={'pick-row' + (p.issues?.length ? ' has-issues' : '')}>
      <div className="pick-main">
        <div><b>{p.name}</b> {p.source === 'custom' ? <SourceBadge src="custom" /> : null}{p.release_year ? <span className="muted small">{` ${p.release_year}`}</span> : null}</div>
        <div className="muted small">{p.summary || 'No specs'}</div>
        {p.issues?.length ? <div className="bad-text small">{'✗ ' + p.issues.join(' ')}</div> : null}
      </div>
      <div className="pick-actions">
        <Small label="Details" onClick={() => partDetail(p.id)} />
        {onAdd ? <Small label={addLabel} onClick={onAdd} cls={p.issues?.length ? '' : 'primary'} /> : null}
      </div>
    </div>
  );
}

/* Search box + results for one category. onAdd gets the chosen library part. */
export function LibrarySearch({ category, q = '', buildId = null, addLabel = 'Add', onAdd, categorySelect = false, source = '' }: {
  category: string; q?: string; buildId?: number | null; addLabel?: string; onAdd?: (p: Row, cat: string) => void; categorySelect?: boolean; source?: string;
}) {
  const [cat, setCat] = useState(category);
  const [src, setSrc] = useState(source);
  const [text, setText] = useState(q);
  const [onlyOk, setOnlyOk] = useState(true);
  const [res, setRes] = useState<Row | null>(null);
  const [err, setErr] = useState('');
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    setRes(null);
    const t = setTimeout(async () => {
      const qs = new URLSearchParams({ category: cat, q: text, limit: '60' });
      if (buildId) { qs.set('build_id', String(buildId)); qs.set('compatible', onlyOk ? '1' : '0'); }
      if (src) qs.set('source', src);
      try { const r = await GET('/catalog/search?' + qs); if (my === seq.current) { setRes(r); setErr(''); } }
      catch (e) { if (my === seq.current) setErr((e as Error).message); }
    }, text === q ? 0 : 250);
    return () => clearTimeout(t);
  }, [cat, src, text, onlyOk, buildId]);  // eslint-disable-line react-hooks/exhaustive-deps
  const note = res ? [res.more ? 'Showing the first 60; type more to narrow it down.' : '',
    res.hidden_incompatible ? `${res.hidden_incompatible} incompatible part${res.hidden_incompatible === 1 ? '' : 's'} hidden.` : ''].filter(Boolean).join(' ') : '';
  return (
    <div className="lib-search">
      <div className="toolbar">
        {categorySelect ? <select value={cat} onChange={e => setCat(e.target.value)}>
          {S.pc!.categories.filter((c: Row) => c.key !== 'other').map((c: Row) => <option key={c.key} value={c.key}>{c.label}</option>)}</select> : null}
        <input type="search" value={text} placeholder="Search by name, model or part number…" onChange={e => setText(e.target.value)} />
        {categorySelect ? <select value={src} onChange={e => setSrc(e.target.value)}>
          <option value="">All parts</option><option value="opendb">Library</option><option value="custom">My custom parts</option></select> : null}
        {buildId ? <label className="check inline-check"><input type="checkbox" checked={onlyOk} onChange={e => setOnlyOk(e.target.checked)} /><span>Only compatible</span></label> : null}
      </div>
      <div className="muted small pick-note">{note}</div>
      <div className="pick-list">
        {err ? <div className="form-error">{err}</div>
          : !res ? <div className="muted pad"><Spinner /> Searching…</div>
            : res.results.length ? res.results.map((p: Row) => <PartRow key={p.id} p={p} addLabel={addLabel} onAdd={onAdd ? () => onAdd(p, cat) : null} />)
              : <div className="empty">{text ? 'No matches.' : 'Nothing in this category yet.'}</div>}
      </div>
    </div>
  );
}

export function customFields(cat: string): Field[] {
  const t: Record<string, Field['type']> = { num: 'number', bool: 'checkbox', text: 'text', list: 'text', m2: 'text' };
  return [
    { k: 'name', label: 'Name', required: true, wide: true, ph: 'e.g. Supermicro X11SCH-F' },
    { k: 'manufacturer', label: 'Manufacturer' },
    { k: 'part_numbers', label: 'Part number(s)', scan: true },
    { section: 'Specs used for compatibility checks (fill what you know)' },
    ...(S.pc!.spec_fields[cat] || []).map((f: Row) => ({
      k: 'spec_' + f.k, label: f.label, type: t[f.type], step: f.type === 'num' ? 'any' : undefined,
      help: f.type === 'list' ? 'Comma-separated' : f.type === 'm2' ? 'One entry per slot: 2280, 2280, 2242-2280' : undefined,
    })),
    { k: 'notes', label: 'Notes', type: 'textarea', wide: true },
  ];
}
const splitSpecs = (vals: Vals, cat: string) => {
  const specs: Row = {}, body: Row = { category: cat };
  for (const [k, v] of Object.entries(vals)) { if (k.startsWith('spec_')) specs[k.slice(5)] = v; else body[k] = v; }
  body.specs = specs;
  return body;
};

export async function customPartDialog(rec: Row, after?: ((r?: Row) => unknown) | null): Promise<void> {
  await pcMeta();
  const isNew = !rec.id;
  let cat = rec.category || 'cpu';
  if (!isNew) {
    const full = await GET(`/catalog/${rec.id}`);
    rec = { ...full, ...Object.fromEntries(Object.entries(full.form_specs || {}).map(([k, v]) => ['spec_' + k, v])) };
    cat = rec.category;
  }
  let dlg: { m: ModalCtl } | null = null;
  const catPick = isNew && !rec.lockCategory ? (
    <div className="field wide"><label>Category</label>
      <select defaultValue={cat} onChange={e => { dlg?.m.close(true); customPartDialog({ ...rec, category: e.target.value }, after); }}>
        {S.pc!.categories.map((c: Row) => <option key={c.key} value={c.key}>{c.label}</option>)}
      </select>
    </div>
  ) : null;
  dlg = formDialog({
    title: `${isNew ? 'New custom' : 'Edit custom'} part: ${catLabel(cat)}`,
    fields: customFields(cat), rec, wide: true,
    draftKey: `catalog:${rec.id || 'new-' + cat}`,
    top: catPick,
    submit: async vals => {
      const body = splitSpecs(vals, cat);
      const r = isNew ? await api('POST', '/catalog', body) : await api('PUT', `/catalog/${rec.id}`, body);
      toast(isNew ? 'Custom part saved' : 'Saved');
      return r;
    },
    onDone: r => (after || rerender)(r),
  });
}

export async function partDetail(id: number) {
  await pcMeta();
  const p = await GET(`/catalog/${id}`);
  const fields: Row[] = S.pc!.spec_fields[p.category] || [];
  const rows: [string, string][] = fields.map(f => [f.label, fmtSpec(f.type, p.specs[f.k])]);
  let m: ModalCtl;
  const toBuild = async () => {
    const builds: Row[] = await GET('/builds');
    formDialog({
      title: 'Add to a build',
      fields: [{ k: 'build_id', label: 'Build', type: 'select', required: true, options: [{ value: 'new', label: '+ New build' }, ...builds.map(b => ({ value: String(b.id), label: b.name }))] },
        { k: 'quantity', label: 'Quantity', type: 'number', min: 1, default: 1 }],
      rec: { build_id: builds[0] ? String(builds[0].id) : 'new' },
      saveLabel: 'Add',
      submit: async v => {
        let bid = v.build_id;
        if (bid === 'new') bid = (await api('POST', '/builds', { name: `New build (${p.name.slice(0, 40)})`, status: 'Planning' })).id;
        await api('POST', '/build_items', { build_id: +bid, category: p.category, catalog_id: p.id, quantity: v.quantity || 1, acquire: 'Need' });
        return bid;
      },
      onDone: bid => { m.close(true); location.hash = `#/builds/${bid}`; },
    });
  };
  const toInventory = () => formDialog({
    title: `Add to inventory: ${p.name}`,
    fields: [
      { k: 'quantity', label: p.category === 'memory' ? 'Kits' : 'Quantity', type: 'number', min: 1, default: 1, help: p.category === 'memory' ? 'Inventory counts individual sticks.' : undefined },
      { k: 'status', label: 'Status', type: 'select', options: S.enums.component_statuses, required: true, default: 'In Stock' },
      { k: 'condition', label: 'Condition', list: 'component_conditions' },
      { k: 'purchase_price', label: 'Price (each)', type: 'number', step: '0.01', min: 0 },
      { k: 'location_id', label: 'Location (room)', type: 'fk', entity: 'locations' },
      { k: 'rack_id', label: 'Stored in (holder)', type: 'fk', entity: 'racks', none: 'None (loose in the room)', scopeBy: ['location_id'], scope: rackInLocation, onChange: rackPicked },
      { k: 'position', label: 'Spot' },
    ],
    saveLabel: 'Add to inventory',
    submit: v => api('POST', `/catalog/${p.id}/to-inventory`, v),
    onDone: c => { toast('Added to inventory'); m.close(true); location.hash = `#/components?id=${c.id}`; },
  });
  m = modal(p.name, (
    <div className="part-detail">
      <div className="inline"><SourceBadge src={p.source === 'custom' ? 'custom' : 'library'} /><span className="badge muted">{catLabel(p.category)}</span>
        {p.inventory_count ? <span className="badge ok">{`${p.inventory_count} in your inventory`}</span> : null}</div>
      <KV pairs={[['Manufacturer', p.manufacturer], ['Part numbers', p.part_numbers ? <Mono v={p.part_numbers} /> : ''], ['Released', p.release_year], ...rows, ['Notes', p.notes]]} />
      <div className="actions wrap">
        {p.source === 'custom' ? <Btn label="Delete" cls="ghost-danger" onClick={async () => {
          if (!await confirmBox(`Delete custom part "${p.name}"? Builds keep its name.`)) return;
          await api('DELETE', `/catalog/${p.id}`); toast('Deleted'); m.close(true); rerender();
        }} /> : null}
        {p.source === 'custom' ? <Btn label="Edit" onClick={() => { m.close(true); customPartDialog({ id: p.id }); }} />
          : <Btn label="Make custom copy" onClick={async () => { const c = await api('POST', `/catalog/${p.id}/copy`); m.close(true); customPartDialog({ id: c.id }); }} />}
        <Btn label="Add to inventory" onClick={toInventory} />
        <Btn label="Add to build" onClick={toBuild} cls="primary" />
      </div>
    </div>
  ), { wide: true });
}

/* "Find in library" on a part's form: fill its fields from a library part. */
export async function libraryLookup(form: FormCtl) {
  await pcMeta();
  const map: Record<string, string> = { HDD: 'storage', SSD: 'storage', 'NVMe SSD': 'storage', RAM: 'memory', CPU: 'cpu', GPU: 'gpu', PSU: 'psu',
    Motherboard: 'motherboard', 'Cooler / Fan': 'cooler', NIC: 'nic' };
  const cat = map[form.get('category')] || 'storage';
  const q = form.get('part_number') || form.get('model') || '';
  const m = modal('Find in parts library', <LibrarySearch category={cat} q={q} categorySelect addLabel="Use this" onAdd={async p => {
    const f = await GET(`/catalog/${p.id}/component-fields`);
    delete f.quantity;
    form.set(f);
    m.close(true);
    toast('Filled from the library');
  }} />, { wide: true });
}

/* Choosing a part for one row of a build: from the library, your spare parts, or a new custom part. */
function PartPicker({ build, cat, replace, m, after }: { build: Row; cat: string; replace?: Row | null; m: ModalCtl; after: () => void }) {
  const [tab, setTab] = useState('library');
  const [st, setSt] = useState<Row | null>(null);
  const [inv, setInv] = useState<Row[] | null>(null);
  const [ctl] = useState(() => new FormCtl(customFields(cat), {}));
  const [err, setErr] = useState('');
  const label = catLabel(cat);
  useEffect(() => { GET('/catalog/status').then(setSt); }, []);
  useEffect(() => { if (tab === 'inventory' && !inv) GET(`/builds/${build.id}/inventory?category=${cat}`).then(setInv); }, [tab]);  // eslint-disable-line react-hooks/exhaustive-deps
  const addItem = async (payload: Row) => {
    try {
      if (replace) await api('DELETE', `/build_items/${replace.id}`);
      await api('POST', '/build_items', { build_id: build.id, category: cat, quantity: replace?.qty || 1, ...payload });
      m.close(true);
      toast(`${label} ${replace ? 'swapped' : 'added'}`);
      after();
    } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const tabs: [string, string][] = [['library', 'Parts library'], ['inventory', 'My spare parts'], ['custom', 'Custom part']];
  let body: React.ReactNode = null;
  if (tab === 'library') {
    const custom = st?.counts.some((c: Row) => c.category === cat && c.source === 'custom');
    body = !st ? null : st.total || custom ? <LibrarySearch category={cat} buildId={build.id} onAdd={p => addItem({ catalog_id: p.id, acquire: 'Need' })} />
      : <LibraryEmptyCard after={() => { m.close(true); pickPart(build, cat, replace, after); }} />;
  } else if (tab === 'inventory') {
    body = !inv ? <div className="muted pad"><Spinner /> Loading…</div> : inv.length ? (
      <div className="pick-list">{inv.map(c => (
        <div key={c.id} className={'pick-row' + (c.issues.length ? ' has-issues' : '')}>
          <div className="pick-main">
            <b>{[c.manufacturer, c.model, c.capacity].filter(Boolean).join(' ') || c.category}</b>
            <div className="muted small">{[c.summary, `${c.quantity} on hand`, c.rack_name || c.location_name, c.condition].filter(Boolean).join(' · ')}</div>
            {c.issues.length ? <div className="bad-text small">{'✗ ' + c.issues.join(' ')}</div> : null}
            {!Object.keys(c.specs).length ? <div className="warn-text small">No specs known. Use “Find in library” on this part to enable checks.</div> : null}
          </div>
          <div className="pick-actions"><Small label="Use" onClick={() => addItem({ component_id: c.id, acquire: 'Have' })} cls={c.issues.length ? '' : 'primary'} /></div>
        </div>
      ))}</div>
    ) : <div className="empty">{`No spare ${label.toLowerCase()} in your inventory. Parts already installed in a device aren’t listed.`}</div>;
  } else {
    body = (
      <form onSubmit={async e => {
        e.preventDefault();
        if (!(e.currentTarget as HTMLFormElement).reportValidity()) return;
        try { const p = await api('POST', '/catalog', splitSpecs(ctl.values(), cat)); await addItem({ catalog_id: p.id, acquire: 'Need' }); }
        catch (x) { setErr((x as Error).message); }
      }}>
        <p className="muted small">For anything not in the library. It’s saved to your custom parts so you can reuse it.</p>
        <FormGrid ctl={ctl} />
        <div className="form-error">{err}</div>
        <div className="actions"><button type="submit" className="primary">{`Add custom ${label}`}</button></div>
      </form>
    );
  }
  return (
    <div>
      <div className="tabs">{tabs.map(([k, t]) => <button key={k} type="button" className={k === tab ? 'active' : ''} onClick={() => setTab(k)}>{t}</button>)}</div>
      {body}
    </div>
  );
}
export async function pickPart(build: Row, cat: string, replace: Row | null | undefined, after: () => void) {
  await pcMeta();
  modal(`${replace ? 'Swap' : 'Choose'} ${catLabel(cat)}`, m => <PartPicker build={build} cat={cat} replace={replace} m={m} after={after} />, { wide: true, cls: 'picker' });
}

/* Adding a CPU to a device: from the library (with how many), or by entering its specs. */
export async function pickCPU(dev: Row, back: () => void) {
  await pcMeta();
  const howMany = (fields: Row) => formDialog({
    title: 'How many of this CPU?',
    fields: [{ k: 'quantity', label: 'Number of CPUs (sockets filled)', type: 'number', min: 1, default: 1, chips: ['1', '2', '4'] }],
    saveLabel: 'Add',
    submit: v => api('POST', '/components', { ...fields, quantity: v.quantity || 1, device_id: dev.id, status: 'Installed' }),
    onDone: () => { toast('CPU added'); back(); },
  });
  const ctl = new FormCtl([
    { k: 'name', label: 'Model', required: true, ph: 'Opteron 4234, Xeon E5-2680 v4' },
    { k: 'manufacturer', label: 'Maker', chips: ['AMD', 'Intel'] },
    { k: 'cores', label: 'Cores per CPU', type: 'number', min: 1, required: true, chips: ['2', '4', '6', '8', '10', '12', '16'] },
    { k: 'threads', label: 'Threads per CPU', type: 'number', min: 1, help: 'Same as cores if it has no Hyper-Threading/SMT.' },
    { k: 'base_ghz', label: 'Clock (GHz)', type: 'number', step: 'any' },
    { k: 'socket', label: 'Socket', chips: ['C32', 'G34', 'LGA 1366', 'LGA 2011', 'LGA 2011-3', 'LGA 3647', 'SP3', 'AM4', 'AM5', 'LGA 1700'] },
    { k: 'quantity', label: 'How many CPUs', type: 'number', min: 1, default: 1, chips: ['1', '2', '4'] },
  ], {});
  const m = modal(`Add a CPU to ${dev.name}`, (
    <div>
      <p className="muted small">Search by model number (e.g. 4234, E5-2680, 7950X3D). Built-in entries cover common server CPUs.</p>
      <LibrarySearch category="cpu" q={(dev.cpu || '').match(/\b[A-Z]?\d{4}[A-Z0-9-]*\b/i)?.[0] || ''} addLabel="Use"
        onAdd={async p => { const f = await GET(`/catalog/${p.id}/component-fields`); m.close(true); howMany(f); }} />
      <details className="cpu-manual-wrap"><summary>Not listed? Enter its specs</summary>
        <div className="cpu-manual">
          <FormGrid ctl={ctl} />
          <div className="actions"><Btn label="Add CPU" cls="primary" onClick={async () => {
            const v = ctl.values();
            if (!v.name || !v.cores) return toast('Model and cores are needed', 'bad');
            try {
              const part = await api('POST', '/catalog', { category: 'cpu', name: v.name, manufacturer: v.manufacturer,
                specs: { cores: v.cores, threads: v.threads || v.cores, base_ghz: v.base_ghz, socket: v.socket } });
              await api('POST', '/components', { category: 'CPU', manufacturer: v.manufacturer, model: v.name.replace(new RegExp(`^${v.manufacturer || '#'}\\s*`, 'i'), ''),
                catalog_id: part.id, interface: v.socket, capacity: `${v.cores}C/${v.threads || v.cores}T`, quantity: v.quantity || 1, device_id: dev.id, status: 'Installed' });
              m.close(true); toast('CPU added (also saved to your custom parts)'); back();
            } catch (e) { toast((e as Error).message, 'bad'); }
          }} /></div>
        </div>
      </details>
    </div>
  ), { wide: true });
}
