/* Racks & Storage: every holder, and a rack's front and rear with what's in each unit. */
import { useState } from 'react';
import { api, GET, loadLookups } from '../api/client';
import { S } from '../lib/state';
import { locPath } from '../lib/lookups';
import { badgeClass, nz, type Row } from '../lib/util';
import { modal, toast } from '../ui/overlay';
import { A, Badge, Bar, Btn, Card, Dot, HelpLink, MenuButton, PageHead, Small, Table } from '../ui/bits';
import { StatusSelect } from '../ui/tables';
import { deleteEntity, editEntity } from '../lib/forms';
import { JournalCard } from '../lib/notes';
import { aiAssist } from '../dialogs/ai';
import { BackLink, Pending, goBackOr, useLoad } from '../app/router';
import { TaskFlag } from './Devices';

// Kinds of device for the rack drawing, in the design system's category order (--zb-cat-1 to 6, then Other).
const DEVICE_CATEGORIES: [string, string[]][] = [
  ['Servers and computers', ['Server', 'Hypervisor Host', 'Workstation', 'Desktop', 'Laptop', 'Mini PC', 'SBC (Raspberry Pi etc.)']],
  ['Network', ['Switch', 'Router', 'Firewall', 'Access Point', 'Modem / ONT', 'Patch Panel']],
  ['Storage', ['NAS', 'SAN / DAS']],
  ['Power', ['UPS', 'PDU']],
  ['Other gear', ['KVM', 'Console Server', 'Printer', 'Camera / NVR', 'IoT', 'Monitor', 'Phone', 'Tablet', 'TV / Streaming', 'Game Console', 'Smart Home', 'Wearable']],
  ['Accessories', ['Cable Manager', 'Shelf / Tray']],
];
export function deviceCategory(type: string | null | undefined): [number | 'other', string] {
  const i = DEVICE_CATEGORIES.findIndex(([, types]) => types.includes(type || ''));
  return i < 0 ? ['other', 'Other'] : [i + 1, DEVICE_CATEGORIES[i][0]];
}

export function RackTile({ r }: { r: Row }) {
  const pct = r.height_u ? Math.min(100, Math.round((r.used_u / r.height_u) * 100)) : null;
  return (
    <a className="tile" href={`#/racks/${r.id}`}>
      <div className="tile-head"><b>{r.name}</b><span className="badge muted">{r.kind}</span></div>
      <div className="muted small">{r.location_id ? locPath(r.location_id) : 'No location'}</div>
      {pct != null ? <Bar pct={pct} cls={pct > 85 ? 'hot' : ''} n={`${r.used_u}/${r.height_u}U`} /> : null}
      <div className="small">{`${r.device_count} device${r.device_count === 1 ? '' : 's'} · ${r.component_count} spare part${r.component_count === 1 ? '' : 's'}`}</div>
    </a>
  );
}

export function Racks() {
  const q = useLoad(() => GET<Row[]>('/racks'));
  if (!q.data) return <Pending q={q} />;
  return <>
    <PageHead title="Racks & Storage" sub="Racks, cabinets, shelves, bins, totes and piles: anything that holds hardware.">
      <HelpLink s="piles" />
      <Btn label="+ Add holder" onClick={() => editEntity('racks', { kind: 'Rack', height_u: 42 }, r => { location.hash = `#/racks/${r.id}`; })} cls="primary" />
    </PageHead>
    {q.data.length ? <div className="tiles">{q.data.map(r => <RackTile key={r.id} r={r} />)}</div>
      : <div className="empty">No racks or holders yet. Loose gear can live directly in a location.</div>}
  </>;
}

/* A bar of watts used against a limit, with the numbers (and the word when it's high). */
export function PowerBar({ used, limit, level }: { used: number; limit?: number | null; level?: string }) {
  const pct = limit ? Math.round((used / limit) * 100) : null;
  return <Bar pct={pct || 0} cls={level === 'over' ? 'over' : level === 'warn' ? 'hot' : ''} n={<>
    {limit ? `${used.toLocaleString()} of ${limit.toLocaleString()} W · ${pct}%` : `${used.toLocaleString()} W`}
    {level === 'over' ? <span className="bad-text"> Over</span> : level === 'warn' ? <span className="warn-text"> Near the limit</span> : null}</>} />;
}
function RackPowerCard({ pw }: { pw: Row | null }) {
  const r = pw?.rack;
  const sup: Row[] = pw?.supplies || [];
  if (!r && !sup.length) return null;
  return (
    <Card title="Power"><div>
      {r ? <div><div className="small">Everything hooked up in this rack</div><PowerBar used={r.draw_w} limit={r.budget_w} level={r.level} />
        {!r.budget_w ? <p className="muted small">Add the circuit’s limit with <b>Edit &gt; Power available</b> to see how close it is.</p> : null}
        {r.without_draw.length ? <p className="muted small">{`No typical draw yet: ${r.without_draw.join(', ')}.`}</p> : null}</div> : null}
      {sup.map(x => <div key={x.id} className="power-supply"><div className="small"><A href={`#/devices/${x.id}`}>{x.name}</A>{` powers ${x.devices.length} device${x.devices.length === 1 ? '' : 's'}`}</div>
        <PowerBar used={x.load_w} limit={x.capacity_w} level={x.level} /></div>)}
    </div></Card>
  );
}

function Elevation({ rack, devices, face, onEmpty }: { rack: Row; devices: Row[]; face: string; onEmpty: (u: number, face: string) => void }) {
  const H = rack.height_u;
  const rowOf = (u: number) => rack.numbering_desc ? u : H - u + 1;
  const cells: React.ReactNode[] = [];
  for (let u = 1; u <= H; u++) {
    cells.push(<div key={'l' + u} className="u-label" style={{ gridRow: String(rowOf(u)), gridColumn: '1' }}>{u}</div>,
      <button key={'s' + u} type="button" className="u-slot" title={`U${u}: empty`} style={{ gridRow: String(rowOf(u)), gridColumn: '2' }} onClick={() => onEmpty(u, face)} />,
      <div key={'r' + u} className="u-label" style={{ gridRow: String(rowOf(u)), gridColumn: '3' }}>{u}</div>);
  }
  for (const d of devices) {
    if (!d.rack_u) continue;
    const mine = d.rack_face === face;
    if (!mine && !d.full_depth) continue;
    const top = d.rack_u + d.u_height - 1;
    const start = Math.min(rowOf(d.rack_u), rowOf(top));
    cells.push(
      <a key={'d' + d.id} className={`u-dev cat-${deviceCategory(d.device_type)[0]}${mine ? '' : ' ghost'}${d.connected ? '' : ' unplugged'} st-${badgeClass(d.status)}${d._online === 'down' ? ' net-down-dev' : ''}`}
        href={`#/devices/${d.id}`} style={{ gridRow: `${start} / span ${d.u_height}`, gridColumn: '2' }}
        title={`${d.name}, U${d.rack_u}${d.u_height > 1 ? '-' + top : ''}${mine ? '' : ` (mounted ${d.rack_face}, full depth)`}`}>
        <span className="u-dev-name">{d.name}</span>
        {d.u_height > 1 || d.device_type ? <span className="u-dev-sub">{nz(d.device_type, d.model)}</span> : null}
        {d.status !== 'Active' ? <span className="u-dev-status">{d.status}</span> : null}
        {mine && d._online === 'down' ? <span className="u-dev-net net-down">Offline</span> : null}
        {mine ? <TaskFlag x={d._sum} /> : null}<Dot on={d.connected} />
      </a>);
  }
  const kinds = [...new Map(devices.filter(d => d.rack_u && (d.rack_face === face || d.full_depth))
    .map(d => deviceCategory(d.device_type)).map(c => [c[0], c])).values()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return (
    <div className="rack-col"><div className="rack-face-label">{face === 'front' ? 'Front' : 'Rear'}</div>
      <div className="rack-frame"><div className="rack-grid" style={{ gridTemplateRows: `repeat(${H}, var(--u))` }}>{cells}</div></div>
      {kinds.length ? <div className="cat-legend" aria-label="Kinds of device">{kinds.map(([n, label]) => <span key={String(n)} className={`cat-${n}`}><i />{label}</span>)}</div> : null}
      {devices.some(d => d._online === 'down' && d.rack_face === face) ? <div className="muted small rack-net-note">Outlined in red: not answering right now (<A href="#/status">Status</A>).</div> : null}
    </div>
  );
}

function PlaceDialog({ u, face, rack, m, back }: { u: number; face: string; rack: Row; m: { close: (f?: boolean) => void }; back: () => void }) {
  const cands = S.lk.devices.filter(d => !d.rack_u && d.id);
  const [pick, setPick] = useState('');
  const [height, setHeight] = useState('1');
  const [err, setErr] = useState('');
  return (
    <div>
      <p><Btn label={`+ New device at U${u}`} cls="primary" onClick={() => {
        m.close();
        editEntity('devices', { rack_id: rack.id, rack_u: u, rack_face: face, u_height: 1, location_id: rack.location_id, status: 'Active', full_depth: true }, back);
      }} /></p>
      {cands.length ? <div>
        <h4>Or place an existing device</h4>
        <div className="form-grid">
          <div className="field wide"><label>Device</label><select value={pick} onChange={e => {
            setPick(e.target.value);
            const d = cands.find(x => String(x.id) === e.target.value);
            if (d) setHeight(String(d.u_height || 1));
          }}><option value="">Choose a device</option>{cands.map(d => <option key={d.id} value={d.id}>{d.name + (d.rack_id ? ` (in ${d.rack_name})` : '')}</option>)}</select></div>
          <div className="field"><label>Height (U)</label><input type="number" min={1} value={height} onChange={e => setHeight(e.target.value)} /></div>
        </div>
        <div className="form-error">{err}</div>
        <div className="actions"><Btn label="Place here" cls="primary" onClick={async () => {
          if (!pick) return setErr('Choose a device');
          try {
            await api('PUT', `/devices/${pick}`, { rack_id: rack.id, rack_u: u, rack_face: face, u_height: height || 1 });
            await loadLookups(); m.close(); toast('Placed'); back();
          } catch (e) { setErr((e as Error).message); }
        }} /></div>
      </div> : null}
    </div>
  );
}

export function Rack({ id }: { id: number }) {
  const q = useLoad(async () => {
    const [layout, notes, sum] = await Promise.all([GET(`/racks/${id}/layout`), GET(`/notes?entity=racks&entity_id=${id}`), GET('/devices/summary')]);
    for (const d of layout.devices) { d._sum = sum.devices[d.id]; d._online = (layout.online || {})[d.id]; }
    return { ...layout, notes };
  });
  if (!q.data) return <Pending q={q} />;
  const { rack, devices, components, power: pw, notes } = q.data;
  const back = q.reload;
  const unplaced = devices.filter((d: Row) => !d.rack_u);
  const onEmpty = (u: number, face: string) => modal(`U${u} (${face})`, m => <PlaceDialog u={u} face={face} rack={rack} m={m} back={back} />);
  const contents = <div>
    <JournalCard entity="racks" entityId={id} notes={notes} after={back} />
    <Card title={rack.height_u ? 'In this holder without a U position' : 'Devices here'}
      actions={<Small label="+ Device" onClick={() => editEntity('devices', { rack_id: id, location_id: rack.location_id, status: 'Active', full_depth: true }, back)} />}>
      <Table rows={rack.height_u ? unplaced : devices} empty="None." cols={[
        { label: '', get: r => <Dot on={r.connected} />, cls: 'narrow' },
        { label: 'Device', get: r => <A href={`#/devices/${r.id}`}>{r.name}</A> },
        { label: 'Type', get: r => r.device_type || '' },
        { label: 'Status', get: r => <StatusSelect dev={r} after={back} />, sort: r => r.status },
        { label: 'Position', get: r => r.position || '' },
      ]} /></Card>
    <Card title="Spare parts stored here" actions={<Small label="+ Part" onClick={() => editEntity('components', { rack_id: id, location_id: rack.location_id, status: 'In Stock', quantity: 1 }, back)} />}>
      <Table rows={components} empty="No parts stored here." cols={[
        { label: 'Category', get: r => r.category },
        { label: 'Part', get: r => <A href={`#/components?id=${r.id}`}>{nz(r.manufacturer, r.model) || r.category}</A> },
        { label: 'Capacity', get: r => r.capacity || '' },
        { label: 'Interface', get: r => nz(r.interface, r.form_factor) },
        { label: 'Qty', get: r => r.quantity },
        { label: 'Position', get: r => r.position || '' },
        { label: 'Status', get: r => <Badge status={r.status} /> },
      ]} /></Card>
  </div>;
  return <>
    <div className="crumbs"><BackLink /><A href="#/racks">Racks &amp; Storage</A>{' › '}{rack.name}</div>
    <PageHead title={rack.name} sub={nz(rack.kind, rack.height_u ? `· ${rack.height_u}U` : '', rack.location_id ? '· ' + locPath(rack.location_id) : '', rack.manufacturer ? '· ' + nz(rack.manufacturer, rack.model) : '')}>
      <Btn label="🤖 AI Assist here" onClick={() => aiAssist({ rack_id: id, location_id: rack.location_id })} />
      <Btn label="Edit" onClick={() => editEntity('racks', rack, back)} />
      <MenuButton label="⋯" items={[['🗑 Delete', () => deleteEntity('racks', rack, () => goBackOr('#/racks'), 'Devices and parts inside will stay, but lose their holder.'), 'danger-item']]} />
    </PageHead>
    {rack.notes ? <div className="card notes">{rack.notes}</div> : null}
    {rack.height_u ? (
      <div className="rack-layout">
        <div className="rack-pair"><Elevation rack={rack} devices={devices} face="front" onEmpty={onEmpty} /><Elevation rack={rack} devices={devices} face="rear" onEmpty={onEmpty} /></div>
        <div className="rack-side">
          <p className="muted small">Click an empty unit to add or place a device there. Faded blocks are full-depth devices mounted on the other face. Striped blocks are not hooked up.</p>
          <RackPowerCard pw={pw} />{contents}
        </div>
      </div>
    ) : <><RackPowerCard pw={pw} />{contents}</>}
  </>;
}
