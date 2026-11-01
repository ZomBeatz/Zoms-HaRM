/* Locations: the tree of places, and one place with what's loose in it. */
import { GET } from '../api/client';
import { S, aiOn } from '../lib/state';
import { nz, type Row } from '../lib/util';
import { A, Badge, Btn, Card, Dot, HelpLink, MenuButton, PageHead, Small, Table } from '../ui/bits';
import { StatusSelect } from '../ui/tables';
import { deleteEntity, editEntity } from '../lib/forms';
import { JournalCard } from '../lib/notes';
import { aiAssist } from '../dialogs/later';
import { BackLink, Pending, goBackOr, useLoad } from '../app/router';
import { RackTile } from './Racks';

export function Locations() {
  const q = useLoad(async () => { const rows: Row[] = await GET('/locations'); S.lk.locations = rows as any; return rows; });
  if (!q.data) return <Pending q={q} />;
  const rows = q.data;
  const children = (pid: number | null) => rows.filter(r => (r.parent_id || null) === pid).sort((a, b) => a.name.localeCompare(b.name));
  const node = (r: Row, depth: number): React.ReactNode[] => [
    <div key={r.id} className="tree-row">
      <div className="tree-name"><span className="tree-indent" style={{ width: `${depth * 22}px` }} /><A href={`#/locations/${r.id}`}><b>{r.name}</b></A>
        {r.kind ? <span className="badge muted">{r.kind}</span> : null}{r.address ? <span className="muted small">{r.address}</span> : null}</div>
      <div className="tree-meta muted small">{`${r.rack_count} holder${r.rack_count === 1 ? '' : 's'} · ${r.device_count} device${r.device_count === 1 ? '' : 's'}`}</div>
      <div className="row-actions">
        <Small label="+ Inside" onClick={() => editEntity('locations', { parent_id: r.id })} />
        <Small label="Edit" onClick={() => editEntity('locations', r)} />
        <Small label="Delete" onClick={() => deleteEntity('locations', r, null, 'Things inside it will keep existing without a location.')} cls="ghost-danger" />
      </div>
    </div>,
    ...children(r.id).flatMap(c => node(c, depth + 1)),
  ];
  return <>
    <PageHead title="Locations" sub="Sites, buildings, rooms, closets. Nest them however you like. Open one to see what’s loose in it.">
      <HelpLink s="piles" /><Btn label="+ Add location" onClick={() => editEntity('locations', {})} cls="primary" />
    </PageHead>
    {rows.length ? <div className="card tree">{children(null).flatMap(r => node(r, 0))}</div> : <div className="empty">No locations yet.</div>}
  </>;
}

export function Location({ id }: { id: number }) {
  const q = useLoad(() => GET(`/locations/${id}/contents`));
  if (!q.data) return <Pending q={q} />;
  const d = q.data, loc = d.location, back = q.reload;
  const chain: Row[] = [];
  for (let cur: Row | undefined = loc, guard = 0; cur && cur.parent_id && guard < 25; guard++) {
    const pid: number = cur.parent_id;
    cur = S.lk.locations.find(l => l.id === pid);
    if (cur) chain.unshift(cur);
  }
  return <>
    <div className="crumbs"><BackLink /><A href="#/locations">Locations</A>{chain.map(p => <span key={p.id}>{' › '}<A href={`#/locations/${p.id}`}>{p.name}</A></span>)}{' › '}{loc.name}</div>
    <PageHead title={loc.name} sub={nz(loc.kind, loc.address ? `· ${loc.address}` : '') || null}>
      <HelpLink s="piles" />
      <Btn label="+ Device here" onClick={() => editEntity('devices', { location_id: id, status: 'Active' }, back)} />
      <Btn label="+ Part here" onClick={() => editEntity('components', { location_id: id, status: 'In Stock', quantity: 1 }, back)} />
      {aiOn() ? <Btn label="🤖 AI Assist here" onClick={() => aiAssist({ location_id: id })} /> : null}
      <MenuButton label="⋯" items={[['✎ Edit…', () => editEntity('locations', loc, back)],
        ['🗑 Delete', () => deleteEntity('locations', loc, () => goBackOr('#/locations'), 'Things inside it will keep existing without a location.'), 'danger-item']]} />
    </PageHead>
    {loc.notes ? <div className="card notes">{loc.notes}</div> : null}
    <JournalCard entity="locations" entityId={id} notes={d.notes} after={back} />
    {d.children.length ? <Card title={`Inside ${loc.name}`} actions={<Small label="+ Add" onClick={() => editEntity('locations', { parent_id: id }, back)} />}>
      <ul className="plain">{d.children.map((c: Row) => <li key={c.id}><A href={`#/locations/${c.id}`}><b>{c.name}</b></A> {c.kind ? <span className="badge muted">{c.kind}</span> : null}{' '}
        <span className="muted small">{`${c.rack_count} holder${c.rack_count === 1 ? '' : 's'} · ${c.device_count} device${c.device_count === 1 ? '' : 's'}`}</span></li>)}</ul></Card> : null}
    <Card title="Racks, shelves & piles here" actions={<Small label="+ Add" onClick={() => editEntity('racks', { location_id: id, kind: 'Shelf' }, back)} />}>
      {d.racks.length ? <div className="tiles">{d.racks.map((r: Row) => <RackTile key={r.id} r={r} />)}</div> : <div className="empty">No holders here.</div>}</Card>
    <Card title="Loose devices" actions={<Small label="+ Device" onClick={() => editEntity('devices', { location_id: id, status: 'Active' }, back)} />}>
      <div><p className="muted small">Devices in this room that aren’t on a rack, shelf or in a bin: piles, desks, the floor. Use “Spot” to note where (“pile by the door”).</p>
        <Table rows={d.loose_devices} empty="Nothing loose here." cols={[
          { label: '', get: r => <Dot on={r.connected} />, sort: r => r.connected, cls: 'narrow' },
          { label: 'Device', get: r => <A href={`#/devices/${r.id}`}>{r.name}</A> },
          { label: 'Type', get: r => r.device_type || '' },
          { label: 'Status', get: r => <StatusSelect dev={r} after={back} />, sort: r => r.status },
          { label: 'Spot', get: r => r.position || <span className="muted">not noted</span> },
          { label: '', nosort: true, get: r => <Small label="Edit" onClick={() => editEntity('devices', r, back)} /> },
        ]} /></div></Card>
    <Card title="Loose parts" actions={<Small label="+ Part" onClick={() => editEntity('components', { location_id: id, status: 'In Stock', quantity: 1 }, back)} />}>
      <Table rows={d.loose_components} empty="No loose parts here." cols={[
        { label: 'Category', get: r => r.category },
        { label: 'Part', get: r => <A href={`#/components?id=${r.id}`}>{nz(r.manufacturer, r.model) || r.category}</A> },
        { label: 'Capacity', get: r => r.capacity || '' },
        { label: 'Qty', get: r => r.quantity },
        { label: 'Spot', get: r => r.position || '' },
        { label: 'Status', get: r => <Badge status={r.status} /> },
      ]} /></Card>
    {d.networks.length ? <Card title="Networks at this location"><ul className="plain">{d.networks.map((n: Row) => (
      <li key={n.id}><A href={`#/networks/${n.id}`}>{n.name}</A> <span className="muted mono small">{nz(n.cidr, n.vlan_id ? `VLAN ${n.vlan_id}` : '')}</span></li>
    ))}</ul></Card> : null}
  </>;
}

