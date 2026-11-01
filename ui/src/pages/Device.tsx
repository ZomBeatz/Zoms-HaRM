/* One device: what it is, where it is, what's inside, how it's networked, its logins and actions. */
import { useEffect, useState } from 'react';
import { api, GET, loadLookups } from '../api/client';
import type { Device, DeviceFull, SlotUsage } from '../api/types';
import { S } from '../lib/state';
import { locPath } from '../lib/lookups';
import { badgeClass, clock, fmtDay, fmtGB, fmtMs, forHowLong, isVirtual, money, nz, prefDel, prefGet, prefSet, splitTokens, STORAGE_CATS, timeAgo, type Row } from '../lib/util';
import { choose, copy, modal, toast, type ModalCtl } from '../ui/overlay';
import { A, Badge, Bar, Btn, Card, Dot, ExtLink, KV, MenuButton, PageHead, Small, Table, Tabs, WarrantyCell, usePopMenu, type Kid } from '../ui/bits';
import { formDialog } from '../ui/form';
import { ConnTable, CredTable, IfaceTable, Placement, StatusSelect } from '../ui/tables';
import { RowActions, deleteEntity, editCredential, editEntity, PART_CHIPS } from '../lib/forms';
import { JournalCard, isOpenTask } from '../lib/notes';
import { ActionExamples, ActionsTable, editAction } from '../lib/actions';
import { CertText, HistoryStrip, OnlinePill, ServicePill, StateBadge, checkDevice, onlineTitle, wakeDevice } from '../lib/status';
import { revealCredential } from '../dialogs/credential';
import { deletePart, installDialog, uninstallDialog } from '../dialogs/parts';
import { importSpecs, undoImport } from '../dialogs/import';
import { pickCPU } from '../dialogs/library';
import { printLabels } from '../dialogs/print';
import { BackLink, Pending, cleanHash, goBackOr, useLoad } from '../app/router';
import { PowerBar } from './Racks';

type Back = () => Promise<void>;

/* Raw → usable capacity for common layouts, for quick "what do I actually get" math. */
function RaidCalc({ groups }: { groups: Row[] }) {
  const sizes: number[] = [];
  for (const g of groups) for (let i = 0; i < g.count; i++) sizes.push(g.gb);
  const n = sizes.length;
  const min = Math.min(...sizes), sum = sizes.reduce((a, b) => a + b, 0);
  const layouts: [string, number, number, number][] = ([
    ['Individual disks / JBOD', sum, 0, 1], ['RAID 0 (stripe, no redundancy)', sum, 0, 2],
    ['RAID 1 / mirror (all disks copies)', min, n - 1, 2], ['RAID 10 / mirrored pairs', Math.floor(n / 2) * min, 1, 4],
    ['RAID 5 / RAIDZ1', (n - 1) * min, 1, 3], ['RAID 6 / RAIDZ2', (n - 2) * min, 2, 4], ['RAIDZ3', (n - 3) * min, 3, 5],
  ] as [string, number, number, number][]).filter(l => n >= l[3]);
  const [sel, setSel] = useState(() => String(Math.max(0, layouts.findIndex(l => l[0].startsWith(n >= 4 ? 'RAID 6' : n >= 3 ? 'RAID 5' : 'RAID 1')))));
  if (n < 2) return null;
  const [name, gb, fails] = layouts[+sel] || layouts[0];
  return (
    <div className="raid-calc"><label>If set up as </label>
      <select aria-label="Layout" value={sel} onChange={e => setSel(e.target.value)}>{layouts.map((l, i) => <option key={i} value={i}>{l[0]}</option>)}</select>
      <div className="raid-out"><b>{`≈ ${fmtGB(gb)} usable`}</b>{' '}
        <span className="muted small">{`(≈ ${(gb * 1e9 / 2 ** 40).toFixed(2)} TiB as most OSes show it) · `}
          {fails ? `survives ${name.startsWith('RAID 10') ? '1 disk per pair' : fails + ' disk failure' + (fails > 1 ? 's' : '')}` : 'no disk can fail'}</span>
        {new Set(sizes).size > 1 && !/JBOD|RAID 0/.test(name) ? <div className="warn-text small">{`Mixed sizes: redundant layouts use the smallest (${fmtGB(min)}) per disk.`}</div> : null}
      </div>
    </div>
  );
}

function StorageBody({ st, legacy, raid = true }: { st: Row; legacy?: string | null; raid?: boolean }) {
  if (!st || !st.drives) {
    return legacy
      ? <p>Noted: <b>{legacy}</b><span className="muted small"> (free-text note from before). Add the drives as parts, or use Import specs, to get real totals.</span></p>
      : <div className="empty">No drives recorded yet. Add them as parts (or use Import specs) and totals appear here.</div>;
  }
  return (
    <div>
      <div className="storage-total"><b>{st.total || 'None'}</b><span className="muted">{` raw across ${st.drives} drive${st.drives === 1 ? '' : 's'}`}</span></div>
      <ul className="plain storage-groups">{st.groups.map((g: Row, i: number) => <li key={i}><b>{`${g.count} × ${g.capacity}`}</b>{` ${g.category}`}<span className="muted">{` = ${fmtGB(g.gb * g.count)}`}</span></li>)}</ul>
      {st.unknown ? <p className="warn-text small">{`${st.unknown} drive(s) have no size set.`}</p> : null}
      {raid ? <RaidCalc groups={st.groups} /> : null}
    </div>
  );
}

function deviceChecklist(dev: Device, d: DeviceFull, actions: Record<string, () => void>) {
  const steps: [boolean, string, () => void, string?][] = [
    [!!dev.serial, 'Serial number / service tag', actions.edit],
    [!!(dev.location_id || dev.rack_id), 'Where it lives', actions.edit],
    [!!(d.cpus.items.length || d.memory.sticks || dev.cpu || dev.ram), 'CPU & memory', actions.importSpecs, 'Import specs'],
    [d.storage.drives > 0 || !/server|nas|san|das|desktop|workstation|hypervisor/i.test(dev.device_type || ''), 'Drives', actions.addDrive, 'Add drives'],
    [d.interfaces.length > 0, 'Network (IP / MAC)', actions.addIface, 'Add interface'],
    [d.credentials.length > 0, 'Login (iDRAC / iLO / OS)', actions.addLogin, 'Add login'],
  ];
  return steps;
}
function Checklist({ dev, d, actions }: { dev: Device; d: DeviceFull; actions: Record<string, () => void> }) {
  const key = `harm-checklist-hidden:${dev.id}`;
  const [hidden, setHidden] = useState(() => !!prefGet(key));
  const steps = deviceChecklist(dev, d, actions);
  const todo = steps.filter(x => !x[0]);
  if (hidden || !todo.length) return null;
  return (
    <div className="card checklist">
      <div className="card-head"><h3>{`Finish setting up · ${steps.length - todo.length}/${steps.length} done`}</h3>
        <Small label="Hide" onClick={() => { prefSet(key, '1'); setHidden(true); }} /></div>
      <div className="check-steps">{steps.map(([done, label, fn, btnLabel]) => (
        <div key={label} className={'check-step' + (done ? ' done' : '')}><span className="tick">{done ? '✓' : '○'}</span><span>{label}</span>
          {done ? null : <Small label={btnLabel || 'Add'} onClick={fn} />}</div>
      ))}</div>
    </div>
  );
}
void prefDel;

function SlotGrid({ sl, compsById, onEmpty, onFilled }: { sl: Row; compsById: Record<number, Row>; onEmpty: (n: number) => void; onFilled: (c: Row, n: number) => void }) {
  const first = sl.first_index || 0;
  return (
    <div className={'bays' + (sl.drive_bay ? ' drive' : ' slot-grid')}>
      {sl.bays.map((cid: number | null, i: number) => {
        const n = first + i;
        const c = cid && compsById[cid];
        if (!c) return <button key={i} type="button" className="bay empty" title={`${sl.drive_bay ? 'Bay' : 'Slot'} ${n}: empty, tap to add`} onClick={() => onEmpty(n)}>
          <span className="bay-n">{n}</span><span className="bay-cap">+</span></button>;
        const kind = /hdd/i.test(c.category) ? 'HDD' : /nvme/i.test(c.category) ? 'NVMe' : /ssd/i.test(c.category) ? 'SSD' : (c.interface || c.category || '').split(' ')[0];
        return <button key={i} type="button" className={`bay filled st-${badgeClass(c.status)}`} onClick={() => onFilled(c, n)}
          title={[`${sl.drive_bay ? 'Bay' : 'Slot'} ${n}`, c.capacity, c.category, nz(c.manufacturer, c.model), c.serial ? `S/N ${c.serial}` : '', c.status !== 'Installed' ? c.status : ''].filter(Boolean).join(' · ')}>
          <span className="bay-n">{n}</span><span className="bay-cap">{c.capacity || kind}</span><span className="bay-type">{kind}</span></button>;
      })}
      {sl.overflow ? <div className="bay-overflow warn-text small">{`+${sl.overflow} more than this group has room for`}</div> : null}
    </div>
  );
}

function partMenu(c: Row, where: string, back: Back, sl: Row | null = null, n: number | null = null) {
  // A bay showing one of "6 × 2 TB" acts on just that drive: split it off first.
  const one = async () => (c.quantity > 1 && sl) ? api('POST', `/components/${c.id}/split`, { slot_id: sl.id, bay: n }) : c;
  const act = (m: ModalCtl, fn: (x: Row) => unknown) => async () => { m.close(true); try { await fn(await one()); } catch (e) { toast((e as Error).message, 'bad'); } };
  modal(`${where}: ${c.capacity || ''} ${c.category}`.trim(), m => (
    <div>
      <KV pairs={[['Part', nz(c.manufacturer, c.model) || c.category], ['Size', c.capacity], ['Connection', c.interface], ['Form factor', c.form_factor],
        ['Serial', c.serial ? <span className="mono">{c.serial}</span> : ''], ['Status', <Badge status={c.status} />], ['Health', c.health],
        ['Group', c.quantity > 1 ? `One of ${c.quantity} identical drives recorded together. Actions here apply to this ${sl?.drive_bay === false ? 'slot' : 'bay'} only.` : '']]} />
      <div className="actions wrap">
        <Btn label="To spares" onClick={act(m, x => uninstallDialog(x, back))} />
        <Btn label="🗑 Delete" cls="ghost-danger" onClick={act(m, x => deletePart(x, back))} />
        {c.status !== 'Faulty' ? <Btn label="⚠ Mark failed" cls="ghost-danger" onClick={act(m, async x => {
          await api('PUT', `/components/${x.id}`, { status: 'Faulty' });
          await api('POST', '/notes', { entity: 'devices', entity_id: c.device_id, kind: 'issue', body: `${where}: ${c.capacity || ''} ${c.category} ${c.serial && c.quantity === 1 ? `(S/N ${c.serial}) ` : ''}marked failed. Replace it.`.replace(/\s+/g, ' ') });
          toast('Marked failed, and an issue was added to the device');
          back();
        })} /> : <Btn label="Mark OK again" onClick={act(m, async x => { await api('PUT', `/components/${x.id}`, { status: 'Installed' }); back(); })} />}
        <Btn label={c.quantity > 1 ? 'Edit this drive' : 'Edit'} cls="primary" onClick={act(m, x => editEntity('components', x, back))} />
      </div>
    </div>
  ));
}

function addToBay(dev: Device, sl: Row, n: number, back: Back) {
  const accepts = splitTokens(sl.interface).filter(Boolean);
  const empty = sl.bays.filter((b: unknown) => b == null).length;
  const isDrive = sl.drive_bay;
  const isMem = /ddr|dimm/i.test(sl.interface);
  const cat = isDrive ? 'HDD' : isMem ? 'RAM' : null;
  formDialog({
    title: `${isDrive ? 'Bay' : 'Slot'} ${n}${sl.label ? ` · ${sl.label}` : ''}: add ${isDrive ? 'a drive' : isMem ? 'memory' : 'a part'}`,
    fields: [
      { k: 'category', label: 'What is it?', required: true, default: cat, chips: isDrive ? ['HDD', 'SSD', 'NVMe SSD'] : isMem ? ['RAM'] : ['GPU', 'NIC', 'HBA / RAID Card', 'Other'] },
      { k: 'capacity', label: 'Size', required: isDrive || isMem, chips: v => PART_CHIPS[v.category]?.sizes || [] },
      { k: 'interface', label: 'Connection', default: accepts.length === 1 ? accepts[0] : (isMem ? sl.interface : null),
        chips: v => accepts.length > 1 ? accepts : (PART_CHIPS[v.category]?.iface || accepts) },
      { k: 'manufacturer', label: 'Manufacturer', chips: v => PART_CHIPS[v.category]?.makers || [] },
      { k: 'model', label: 'Model', scan: true },
      { k: 'serial', label: 'Serial number', scan: true, showIf: v => +v.quantity <= 1 },
      { k: 'quantity', label: 'How many identical ones', type: 'number', min: 1, default: 1, chips: empty > 1 ? ['1', String(empty)] : null,
        help: empty > 1 ? `${empty} empty in this group. More than 1 fills the empty ${isDrive ? 'bays' : 'slots'} in order.` : null },
    ],
    saveLabel: 'Add',
    submit: v => api('POST', '/components', {
      ...v, device_id: dev.id, status: 'Installed', slot_id: sl.id, form_factor: sl.form_factor || null,
      bay: +v.quantity > 1 ? null : n,
    }),
    onDone: () => { toast('Added'); back(); },
  });
}

function SparesTable({ rows, onInstall }: { rows: Row[]; onInstall: (c: Row) => void }) {
  return <Table rows={rows} cols={[
    { label: 'Part', get: c => nz(c.manufacturer, c.model) || c.category },
    { label: 'Size', get: c => c.capacity || '' },
    { label: 'Connection', get: c => nz(c.interface, c.form_factor) },
    { label: 'Qty', get: c => c.quantity },
    { label: 'Stored', get: c => [c.rack_name, c.position].filter(Boolean).join(' · ') || c.location_name || '' },
    { label: '', nosort: true, get: c => <Small label="Install" onClick={() => onInstall(c)} cls="primary" /> },
  ]} />;
}

function sparesFor(sl: Row, dev: Device, back: Back) {
  modal(`Spares that fit ${sl.label || sl.interface}`, m => <SparesTable rows={sl.compatible} onInstall={c => { m.close(true); installDialog(c, dev.id, back); }} />, { wide: true });
}

function BayGroups({ dev, d, slots, back }: { dev: Device; d: DeviceFull; slots: SlotUsage[]; back: Back }) {
  const compsById = Object.fromEntries(d.components.map((c) => [c.id, c]));
  return <>{slots.map(sl => {
    const st = sl.storage;
    const used = sl.bays.filter(Boolean).length;
    return (
      <div key={sl.id} className="bay-group">
        <div className="bay-head">
          <div><b>{sl.label || (sl.drive_bay ? 'Drive bays' : sl.interface)}</b>
            <span className="muted small">{' ' + [sl.form_factor, sl.drive_bay ? `accepts ${splitTokens(sl.interface).join(' & ')}` : (sl.label ? sl.interface : null), `${used}/${sl.total} used`].filter(Boolean).join(' · ')}</span>
            {sl.array_name ? <div><span className="badge info">{sl.array_name}</span></div> : null}
            {sl.notes ? <div className="muted small">{sl.notes}</div> : null}</div>
          <div className="row-actions">
            {sl.compatible.length && used < (sl.total ?? 0) ? <Small label={`${sl.compatible.length} spare${sl.compatible.length > 1 ? 's' : ''} fit`} onClick={() => sparesFor(sl, dev, back)} cls="info" /> : null}
            <Small label="Edit" onClick={() => editEntity('device_slots', sl, back)} />
            <Small label="Delete" onClick={() => deleteEntity('device_slots', sl, back, 'Drives in it stay installed in the device.')} cls="ghost-danger" />
          </div>
        </div>
        <SlotGrid sl={sl} compsById={compsById} onEmpty={n => addToBay(dev, sl, n, back)} onFilled={(c, n) => partMenu(c, `${sl.label || 'Bay'} ${n}`, back, sl, n)} />
        {st && st.drives ? <div className="bay-foot"><b>{st.total}</b><span className="muted">{` raw · ${st.groups.map((g: Row) => `${g.count}× ${g.capacity}`).join(', ')}`}</span><RaidCalc groups={st.groups} /></div> : null}
      </div>
    );
  })}</>;
}

function CpuCard({ dev, d, back }: { dev: Device; d: DeviceFull; back: Back }) {
  const c = d.cpus;
  const sockets = d.slots.filter((s) => /cpu|socket|lga|am\d|sp\d|c32|g34|str/i.test(`${s.interface} ${s.label || ''}`) && !/ddr|dimm|pcie|m\.2|sas|sata/i.test(s.interface));
  const sockTotal = sockets.reduce((a: number, s: Row) => a + s.total, 0);
  const comp = (id: number) => d.components.find((k) => k.id === id)!;  // CPU lines come from these parts
  return (
    <Card title="Processors" actions={<Small label="+ Add CPU" onClick={() => pickCPU(dev, back)} />}>
      {c.items.length ? <div>
        <div className="storage-total"><b>{`${c.cores || '?'} cores`}</b><span className="muted">{` / ${c.threads || '?'} threads total${c.sockets > 1 ? ` across ${c.sockets} CPUs` : ''}`}</span></div>
        <ul className="plain storage-groups">{c.items.map((x: Row) => (
          <li key={x.id} className="cpu-line">
            <div><b>{`${x.qty > 1 ? x.qty + ' × ' : ''}${x.name}`}</b></div>
            <div className="muted small">{[x.cores ? `${x.cores} cores / ${x.threads || x.cores} threads${x.qty > 1 ? ' each' : ''}` : 'core count unknown: edit it or pick it from the library',
              x.base_ghz ? `${x.base_ghz} GHz${x.boost_ghz ? ` (boost ${x.boost_ghz} GHz)` : ''}` : null, x.socket].filter(Boolean).join(' · ')}</div>
            <div className="row-actions"><Small label="Edit" onClick={() => editEntity('components', comp(x.id), back)} /><Small label="To spares" onClick={() => uninstallDialog(comp(x.id), back)} /><Small label="Delete" cls="ghost-danger" onClick={() => deletePart(comp(x.id), back)} /></div>
          </li>
        ))}</ul>
        {sockTotal ? <p className={(c.sockets > sockTotal ? 'bad-text' : 'muted') + ' small'}>{`${c.sockets} of ${sockTotal} CPU socket${sockTotal > 1 ? 's' : ''} filled`}</p> : null}
      </div> : <div>{dev.cpu ? <p>Noted: <b>{dev.cpu}</b></p> : null}
        <p className="muted small">Add the CPU to see cores and threads. Pick it from the library (servers like Opteron and Xeon are included), or enter its specs.</p></div>}
    </Card>
  );
}

function MemoryCard({ dev, d, back }: { dev: Device; d: DeviceFull; back: Back }) {
  const mem = d.memory;
  const memSlots = d.slots.filter((s) => /ddr|dimm/i.test(s.interface));
  const compsById = Object.fromEntries(d.components.map((c) => [c.id, c]));
  return (
    <Card title="Memory" actions={<>
      <Small label="+ Add memory" onClick={() => editEntity('components', { device_id: dev.id, status: 'Installed', category: 'RAM', quantity: 1 }, back)} />
      {memSlots.length ? null : <Small label="+ Slots" onClick={() => editEntity('device_slots', { device_id: dev.id, total: 8, interface: 'DDR4 DIMM' }, back)} />}</>}>
      <div>
        {mem.sticks ? <>
          <div className="storage-total"><b>{mem.total || '?'}</b><span className="muted">{` across ${mem.sticks} stick${mem.sticks === 1 ? '' : 's'}`}</span></div>
          <ul className="plain storage-groups">{mem.groups.map((g: Row, i: number) => <li key={i}><b>{`${g.count} × ${g.capacity}`}</b>{` ${[g.interface, g.speed].filter(Boolean).join(' · ')}`}
            {g.gb ? <span className="muted">{` = ${fmtGB(g.gb * g.count)}`}</span> : null}</li>)}</ul>
        </> : <div>{dev.ram ? <p>Noted: <b>{dev.ram}</b></p> : null}
          <p className="muted small">Add memory sticks (or use Import specs) to see the breakdown. Add memory slots to see which are free.</p></div>}
        {memSlots.map((sl: Row) => (
          <div key={sl.id} className="bay-group">
            <div className="bay-head"><div><b>{sl.label || 'Memory slots'}</b><span className="muted small">{` ${sl.interface} · ${sl.bays.filter(Boolean).length}/${sl.total} used`}</span></div>
              <div className="row-actions"><Small label="Edit" onClick={() => editEntity('device_slots', sl, back)} /></div></div>
            <SlotGrid sl={sl} compsById={compsById} onEmpty={n => addToBay(dev, sl, n, back)} onFilled={(c, n) => partMenu(c, `${sl.label || 'Slot'} ${n}`, back, sl, n)} />
          </div>
        ))}
      </div>
    </Card>
  );
}

function StorageCard({ dev, d, back }: { dev: Device; d: DeviceFull; back: Back }) {
  const bays = d.slots.filter((s) => s.drive_bay);
  const inBays = new Set(bays.flatMap((s: Row) => s.bays.filter(Boolean)));
  const loose = d.components.filter((c) => STORAGE_CATS.test(c.category) && !inBays.has(c.id));
  return (
    <Card title="Storage" actions={<>
      <Small label="+ Drive bays" onClick={() => editEntity('device_slots', { device_id: dev.id, total: 4, _kind: 'Drive bays', interface: 'SAS/SATA', form_factor: '3.5"' }, back)} />
      <Small label="+ Drives" onClick={() => editEntity('components', { device_id: dev.id, status: 'Installed', category: 'HDD', quantity: 1 }, back)} /></>}>
      <div>
        <StorageBody st={d.storage} legacy={dev.storage} raid={!bays.length} />
        {bays.length ? <BayGroups dev={dev} d={d} slots={bays} back={back} />
          : d.storage.drives ? <p className="muted small">Tip: add the drive bays (front/rear, how many, SAS/SATA, which RAID) to see each bay and what’s in it.</p> : null}
        {bays.length && loose.length ? <p className="muted small">{`${loose.reduce((a: number, c: Row) => a + c.quantity, 0)} drive(s) aren’t in any bay group: `}
          {loose.map((c: Row) => <Small key={c.id} label={`${c.quantity > 1 ? c.quantity + '× ' : ''}${c.capacity || c.category}`} onClick={() => partMenu(c, 'Drive', back)} />)}</p> : null}
      </div>
    </Card>
  );
}

function DevicePowerCard({ p }: { p: Row | null }) {
  if (!p) return null;
  return (
    <Card title="Power"><div>
      <PowerBar used={p.load_w} limit={p.capacity_w} level={p.level} />
      {!p.capacity_w ? <p className="muted small">Add what it can supply under <b>Edit &gt; More details &gt; Can supply</b>.</p> : null}
      <Table rows={p.devices} empty="Nothing is plugged into it yet. Set “Plugged into” on each device." cols={[
        { label: 'Plugged in', get: r => <A href={`#/devices/${r.id}`}>{r.name}</A> },
        { label: 'Typical draw', get: r => r.draw_w != null ? `${r.draw_w} W` : <span className="muted">Not set</span> },
        { label: '', get: r => r.connected ? '' : <span className="muted small">Not hooked up, not counted</span> },
      ]} />
    </div></Card>
  );
}

/* VMs and containers on a host, with how much of the host they claim. */
function GuestsCard({ dev, d, back }: { dev: Device; d: DeviceFull; back: Back }) {
  const t = d.guest_totals;
  const threads = d.cpus.threads || d.cpus.cores || 0;
  const ramGb = d.memory.total_gb || 0;
  const meter = (label: string, used: number, cap: number, unit: string) => {
    if (!cap) return <div className="muted small">{`${label}: ${used || 0}${unit} allocated (add the host’s ${label === 'CPU' ? 'CPU' : 'memory'} under Hardware to compare)`}</div>;
    const pct = Math.round((used / cap) * 100);
    return <Bar label={label} pct={pct} cls={pct > 100 ? 'hot' : ''} n={`${used}${unit} / ${cap}${unit}${pct > 100 ? ` (${(used / cap).toFixed(1)}× overcommitted)` : ''}`} />;
  };
  return (
    <Card title={`VMs & containers on ${dev.name}`} actions={<>
      <Small label="+ Add VM" onClick={() => editEntity('devices', { host_id: dev.id, device_type: 'Virtual Machine', status: 'Active', connected: true, cluster_id: dev.cluster_id }, back)} />
      <Small label="+ Container" onClick={() => editEntity('devices', { host_id: dev.id, device_type: 'Container', status: 'Active', connected: true, cluster_id: dev.cluster_id }, back)} /></>}>
      <div>
        {t.count ? <div className="bars">{meter('CPU', t.vcpus, threads, ' vCPU')}{meter('Memory', +t.ram_gb.toFixed(1), +ramGb.toFixed(1), ' GB')}</div> : null}
        <Table rows={d.guests} empty="No VMs or containers recorded on this host yet. Add them here, or import them from Proxmox in Discover." onRow={r => { location.hash = `#/devices/${r.id}`; }} cols={[
          { label: '', get: r => <Dot on={r.status === 'Active'} />, sort: r => r.status, cls: 'narrow' },
          { label: 'Name', get: r => <div><A href={`#/devices/${r.id}`}>{r.name}</A><div className="muted small">{nz(r.device_type, r.vm_id ? `· ID ${r.vm_id}` : '')}</div></div> },
          { label: 'vCPU', get: r => r.vcpus ?? '', sort: r => r.vcpus || 0 },
          { label: 'Memory', get: r => r.vm_ram_gb != null ? `${r.vm_ram_gb} GB` : '', sort: r => r.vm_ram_gb || 0 },
          { label: 'Disk', get: r => r.vm_disk_gb != null ? `${r.vm_disk_gb} GB` : '', sort: r => r.vm_disk_gb || 0 },
          { label: 'IP', get: r => <span className="mono">{(r.ips || '').split(', ')[0]}</span> },
          { label: 'Status', get: r => <StatusSelect dev={r} after={back} />, sort: r => r.status },
        ]} />
      </div>
    </Card>
  );
}

/* The 🌐 address: one tap copies it; with several, a menu to copy one or pick the main one. */
function IpFact({ ips, main, isMgmt, setPrimary }: { ips: Row[]; main: Row; isMgmt: (i: Row) => boolean; setPrimary: (i: Row) => void }) {
  const pop = usePopMenu();
  if (ips.length < 2) return <button type="button" className="fact mono" title="Copy IP" onClick={() => copy(main.ip, 'IP')}><span>🌐</span>{main.ip}</button>;
  return (
    <span className="qa pop" ref={pop.wrap}>
      <button type="button" className="fact mono" title="All addresses" onClick={pop.toggle}><span>🌐</span>{main.ip}<span className="muted small">{` +${ips.length - 1} ▾`}</span></button>
      <div className="qa-menu pop-menu ip-menu" hidden={!pop.open} role="menu">
        <div className="qa-group">Addresses: tap to copy</div>
        {ips.map(i => (
          <div key={i.id} className="ip-row">
            <button type="button" role="menuitem" className="ip-copy" onClick={() => { pop.setOpen(false); copy(i.ip, 'IP'); }}>
              <span className="mono">{i.ip}</span><span className="muted small">{nz(i.name, isMgmt(i) ? '· management' : '', i.id === main.id ? '· main' : '')}</span></button>
            {i.id === main.id && i.is_primary ? <span className="ip-star" title="Main address">★</span>
              : <button type="button" className="sm ghost" title="Use this as the main address (quick links, logins, lists)" onClick={() => { pop.setOpen(false); setPrimary(i); }}>☆ Main</button>}
          </div>
        ))}
      </div>
    </span>
  );
}

const Fact = ({ ico, title, children }: { ico: string; title?: string; children: Kid }) => <span className="fact" title={title}><span>{ico}</span>{children}</span>;

export default function Device({ id, q: qs }: { id: number; q: URLSearchParams }) {
  const q = useLoad(() => GET<DeviceFull>(`/devices/${id}/full`));
  const [tabReq, setTabReq] = useState({ t: qs.get('tab'), n: 0 });
  const setTab = (t: string) => setTabReq(r => ({ t, n: r.n + 1 }));
  // Links from search open the item itself: #/devices/5?tab=network&edit=interfaces-12, ?open=<login id>
  useEffect(() => {
    const d = q.data;
    if (!d || !(qs.get('edit') || qs.get('open'))) return;
    const [ent, rid] = (qs.get('edit') || '').split('-');
    const rec = ent === 'interfaces' ? d.interfaces.find((r) => String(r.id) === rid)
      : ent === 'services' ? d.services.find((r) => String(r.id) === rid) : null;
    const cred = qs.get('open') ? d.credentials.find((c) => String(c.id) === qs.get('open')) : null;
    cleanHash(`#/devices/${id}`);
    qs.delete('edit'); qs.delete('open');
    if (rec) editEntity(ent, rec, q.reload);
    if (cred) revealCredential(cred);
  }, [q.data]);  // eslint-disable-line react-hooks/exhaustive-deps
  if (!q.data) return <Pending q={q} />;
  const d = q.data;
  const dev = d.device;
  const back = q.reload;
  const preset = { device_id: id };
  const actions = {
    edit: () => editEntity('devices', dev, back),
    importSpecs: () => importSpecs(dev, d, back),
    addDrive: () => editEntity('components', { device_id: id, status: 'Installed', category: 'HDD', quantity: 1 }, back),
    addIface: () => editEntity('interfaces', preset, back),
    addLogin: () => editCredential({ ...preset, label: `${dev.name} admin` }, back),
  };
  const toggleConnected = async () => {
    try { await api('PUT', `/devices/${id}`, { connected: !dev.connected }); await loadLookups(); back(); } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const clone = () => {
    const copyRec: Row = { ...dev };
    for (const k of ['id', 'serial', 'asset_tag', 'rack_u', 'hostname', 'created_at', 'updated_at']) delete copyRec[k];
    copyRec.name = dev.name.replace(/#(\d+)$/, (_m: string, n: string) => `#${+n + 1}`);
    if (copyRec.name === dev.name) copyRec.name += ' (copy)';
    editEntity('devices', copyRec, r => { location.hash = `#/devices/${r.id}`; });
  };
  const rackInfo = dev.rack_id ? <span><A href={`#/racks/${dev.rack_id}`}>{dev.rack_name}</A>
    {dev.rack_u ? `, U${dev.rack_u}${(dev.u_height ?? 1) > 1 ? ' to U' + (dev.rack_u + (dev.u_height ?? 1) - 1) : ''}, ${dev.rack_face}${dev.full_depth ? ', full depth' : ''}` : ' (no U position)'}</span> : '';

  const isCpuSlot = (sl: Row) => !/ddr|dimm|pcie|m\.2|sas|sata|u\.2|ocp|sfp|mezz/i.test(sl.interface) && /lga|am\d|sp\d|c32|g34|str|socket|fm\d/i.test(`${sl.interface} ${sl.label || ''}`);
  const otherSlots = d.slots.filter((sl) => !sl.drive_bay && !/ddr|dimm/i.test(sl.interface) && !isCpuSlot(sl));

  // The device's main address: the one marked primary, else the first that isn't a management port (iDRAC/iLO/IPMI).
  const ips = d.interfaces.filter((i) => i.ip);
  const isMgmt = (i: Row) => i.kind === 'IPMI / BMC' || /idrac|ilo|ipmi|bmc|mgmt|management/i.test(i.name || '');
  const mainIface = ips.find((i: Row) => i.is_primary) || ips.find((i: Row) => !isMgmt(i)) || ips[0];
  const setPrimary = async (i: Row) => { try { await api('PUT', `/interfaces/${i.id}`, { is_primary: true }); toast(`${i.ip} is now the main address`); back(); } catch (e) { toast((e as Error).message, 'bad'); } };
  const openNotes = d.notes.filter(isOpenTask);
  const on = d.online;
  const hwCount = d.components.reduce((n: number, c: Row) => n + (c.quantity || 1), 0);
  const virtual = isVirtual(dev);
  const showGuests = !virtual && (d.guests.length > 0 || /hypervisor|server|nas|mini pc|desktop|workstation/i.test(dev.device_type || ''));
  // With parts inside, ask where they go: to Spare Parts (pulled for reuse), or deleted along with it.
  const deleteDev = async () => {
    if (!d.components.length) return deleteEntity('devices', dev, () => goBackOr('#/devices'), 'Its interfaces, services, slots and cable records will be deleted.');
    const n = d.components.reduce((a, c) => a + (c.quantity || 1), 0);
    const pick = await choose(`Delete "${dev.name}"?`, `Its interfaces, services, slots and cable records will be deleted. It has ${n} part${n === 1 ? '' : 's'} inside.`,
      [['no', 'Cancel'], ['spares', 'Delete, parts to Spare Parts'], ['all', 'Delete it and its parts', 'danger']]);
    if (pick !== 'spares' && pick !== 'all') return;
    try {
      await api('DELETE', `/devices/${id}${pick === 'all' ? '?parts=delete' : ''}`);
      toast('Deleted');
      await loadLookups();
      goBackOr('#/devices');
    } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const check = async () => { await checkDevice(id, dev.name); back(); };
  const powerName = dev.powered_by_id ? S.lk.devices.find(x => x.id === dev.powered_by_id)?.name || 'device' : '';

  return <>
    <div className="crumbs"><BackLink /><A href="#/devices">Devices</A>{' › '}{dev.name}</div>
    <PageHead title={<span>{dev.name}</span>} sub={nz(dev.device_type, dev.manufacturer, dev.model) || null}>
      <StatusSelect dev={dev} after={back} />
      <button type="button" className={'toggle ' + (dev.connected ? 'on' : 'off')} onClick={toggleConnected}><Dot on={dev.connected} />{dev.connected ? 'Hooked up' : 'Not hooked up'}</button>
      <Btn label="Edit" onClick={actions.edit} cls="primary" />
      <MenuButton label="⋯" items={[
        ['⇩ Import specs…', actions.importSpecs],
        S.lastImport[id] ? ['↶ Undo last import', () => undoImport(id, back)] : null,
        ['⟳ Check if it’s online', check],
        d.can_wake ? ['⏻ Wake up (Wake-on-LAN)', () => wakeDevice(id, dev.name)] : null,
        ['⚡ New action…', () => editAction({ device_id: id }, back)],
        ['📝 Add note or task', () => { setTab('overview'); setTimeout(() => document.querySelector<HTMLTextAreaElement>('.note-input')?.focus(), 50); }],
        ['⇪ Export / PDF / sell sheet', () => { location.hash = `#/export?ids=${id}`; }],
        ['🏷 Print label…', () => printLabels([id])],
        ['⎘ Clone…', clone],
        ['🗑 Delete', deleteDev, 'danger-item'],
      ]} />
    </PageHead>
    <div className="facts">
      {['up', 'down', 'unknown'].includes(on.state) ? <button type="button" className="fact" title={`${onlineTitle(on)}. Tap to check now.`} onClick={check}>
        <OnlinePill st={on} /><span className="muted small">{on.state === 'up' && on.latency_ms != null ? fmtMs(on.latency_ms) : on.state === 'down' && on.since ? forHowLong(on.since) : ''}</span></button> : null}
      {dev.location_id || dev.rack_id ? <Fact ico="📍" title="Where it is"><span>
        {dev.rack_id ? <A href={`#/racks/${dev.rack_id}`}>{dev.rack_name}</A> : <A href={`#/locations/${dev.location_id}`}>{locPath(dev.location_id)}</A>}
        {dev.rack_u ? ` · U${dev.rack_u}` : (dev.position ? ` · ${dev.position}` : '')}</span></Fact> : null}
      {dev.host_id ? <Fact ico="🖥" title="Host"><span>Runs on <A href={`#/devices/${dev.host_id}`}>{dev.host_name || 'host'}</A>{dev.vm_id ? ` · ID ${dev.vm_id}` : ''}</span></Fact> : null}
      {dev.cluster_id ? <Fact ico="🧩" title="Cluster"><A href={`#/clusters/${dev.cluster_id}`}>{dev.cluster_name || 'cluster'}</A></Fact> : null}
      {mainIface ? <IpFact ips={ips} main={mainIface} isMgmt={isMgmt} setPrimary={setPrimary} /> : null}
      {dev.mgmt_url ? <Fact ico="🖥" title={dev.mgmt_url}><a href={dev.mgmt_url} target="_blank" rel="noopener noreferrer">Management ↗</a></Fact> : null}
      {d.credentials.slice(0, 3).map((c: Row) => <button key={c.id} type="button" className="fact" title="Open / reveal this login" onClick={() => revealCredential(c)}><span>🔑</span>{c.label}</button>)}
      {openNotes.length ? <button type="button" className="fact" title="Open tasks and issues" onClick={() => setTab('overview')}><span>⚑</span><span className="warn-text">{`${openNotes.length} open`}</span></button> : null}
    </div>
    <Checklist dev={dev} d={d} actions={actions} />
    <Tabs k="device" want={tabReq.t} wantKey={tabReq.n} defs={[
      ['overview', 'Overview', null, () => <>
        <JournalCard entity="devices" entityId={id} notes={d.notes} after={back} />
        <DevicePowerCard p={d.power} />
        <div className="grid two">
          <Card title="Details"><KV pairs={[
            ...(virtual ? [['Runs on', dev.host_id ? <A href={`#/devices/${dev.host_id}`}>{dev.host_name || 'host'}</A> : 'Not set'], ['VM / container ID', dev.vm_id],
              ['vCPUs', dev.vcpus], ['Memory', dev.vm_ram_gb != null ? `${dev.vm_ram_gb} GB` : ''], ['Disk', dev.vm_disk_gb != null ? `${dev.vm_disk_gb} GB` : '']] as [Kid, Kid][] : []),
            ['Cluster', dev.cluster_id ? <A href={`#/clusters/${dev.cluster_id}`}>{dev.cluster_name || 'cluster'}</A> : ''],
            ['Serial / service tag', dev.serial ? <span className="inline"><span className="mono">{dev.serial}</span><Small label="Copy" onClick={() => copy(dev.serial ?? '', 'Serial')} /></span> : ''],
            ['Hostname', dev.hostname ? <span className="mono">{dev.hostname}</span> : ''],
            ['OS / firmware', dev.os],
            ['CPU', d.cpus.items.length ? `${d.cpus.items.map((x: Row) => (x.qty > 1 ? x.qty + '× ' : '') + x.name).join(', ')} · ${d.cpus.cores} cores / ${d.cpus.threads} threads` : dev.cpu],
            ['RAM', d.memory.sticks ? `${d.memory.total} (${d.memory.groups.map((g: Row) => `${g.count}× ${g.capacity}`).join(', ')})` : dev.ram],
            ['Storage', d.storage.drives ? `${d.storage.total} raw in ${d.storage.drives} drives` : null],
            ['Power supply', dev.psu], ['Typical draw', dev.power_draw_w != null ? `${dev.power_draw_w} W` : ''],
            ['Can supply', dev.power_capacity_w != null ? `${dev.power_capacity_w} W` : ''],
            ['Plugged into', dev.powered_by_id ? <A href={`#/devices/${dev.powered_by_id}`}>{powerName}</A> : ''],
            ['Asset tag', dev.asset_tag],
            ['Tags', dev.tags ? <span>{dev.tags.split(',').map((t: string) => t.trim()).filter(Boolean).map((t: string) => <span key={t} className="tag">{t}</span>)}</span> : ''],
            ['PC build', d.builds.length ? <span>{d.builds.map((b) => <A key={b.id} href={`#/builds/${b.id}`}>{b.name}</A>)}</span> : ''],
          ]} /></Card>
          <Card title="Location & purchase"><KV pairs={[
            ['Location', dev.location_id ? <A href={`#/locations/${dev.location_id}`}>{locPath(dev.location_id)}</A> : ''],
            ['Rack / holder', rackInfo],
            ['Spot', dev.position],
            ['Purchased', nz(fmtDay(dev.purchase_date), dev.vendor ? `from ${dev.vendor}` : '')],
            ['Price', money(dev.purchase_price)],
            ['Original price', money(dev.msrp)],
            ['Current value', dev.market_value != null ? `${money(dev.market_value)}${dev.value_checked ? ` (checked ${fmtDay(dev.value_checked)})` : ''}` : ''],
            ['Warranty until', <WarrantyCell d={dev.warranty_until} />],
            ['Added', dev.created_at], ['Updated', dev.updated_at],
          ]} /></Card>
        </div>
      </>],
      ...(showGuests ? [['vms', 'VMs', d.guests.length || null, () => <GuestsCard dev={dev} d={d} back={back} />] as [string, Kid, number | null, () => Kid]] : []),
      ...(virtual ? [] : [['hardware', 'Hardware', hwCount || null, () => <>
        <div className="grid two hw"><CpuCard dev={dev} d={d} back={back} /><MemoryCard dev={dev} d={d} back={back} /></div>
        <StorageCard dev={dev} d={d} back={back} />
        <Card title="All installed parts" actions={<Small label="+ Add part" onClick={() => editEntity('components', { device_id: id, status: 'Installed', quantity: 1 }, back)} />}>
          <Table rows={d.components} empty="No parts recorded inside this device." cols={[
            { label: 'What', get: r => r.category },
            { label: 'Part', get: r => nz(r.manufacturer, r.model) },
            { label: 'Size', get: r => r.capacity || '' },
            { label: 'Connection', get: r => nz(r.interface, r.form_factor) },
            { label: 'Serial', get: r => <span className="mono">{r.serial || ''}</span> },
            { label: 'Qty', get: r => r.quantity },
            { label: 'Health', get: r => r.health || '' },
            { label: '', nosort: true, get: r => <div className="row-actions"><Small label="Edit" onClick={() => editEntity('components', r, back)} /><Small label="To spares" onClick={() => uninstallDialog(r, back)} /><Small label="Delete" cls="ghost-danger" onClick={() => deletePart(r, back)} /></div> },
          ]} /></Card>
        <Card title="Expansion & other slots" actions={<Small label="+ Add" onClick={() => editEntity('device_slots', { ...preset, total: 1, _kind: 'PCIe slots' }, back)} />}>
          {otherSlots.length ? <div className="slots">{otherSlots.map((sl: Row) => <OtherSlot key={sl.id} sl={sl} id={id} back={back} />)}</div>
            : <div className="empty">PCIe, M.2, CPU sockets, PSU bays… Record them to see which spare parts fit.</div>}</Card>
      </>] as [string, Kid, number | null, () => Kid]]),
      ['network', 'Network', (d.interfaces.length + d.services.length + d.connections.length) || null, () => <>
        <Card title="Network interfaces" actions={<Small label="+ Add" onClick={actions.addIface} />}><IfaceTable rows={d.interfaces} after={back} /></Card>
        <Card title="Services" actions={<Small label="+ Add" onClick={() => editEntity('services', preset, back)} />}>
          <Table rows={d.services} empty="No services recorded." cols={[
            { label: 'Service', get: r => r.name },
            { label: 'Port', get: r => nz(r.protocol, r.port) },
            { label: 'URL', get: r => <ExtLink url={r.url} /> },
            { label: 'Version', get: r => r.version || '' },
            { label: 'Status', get: r => <Badge status={r.status} /> },
            { label: 'Answering', get: r => { const sv = (on.services || []).find((x: Row) => x.id === r.id); return sv ? <ServicePill sv={sv} /> : ''; } },
            { label: '', nosort: true, get: r => <RowActions entity="services" r={r} after={back} /> },
          ]} /></Card>
        <Card title="Cables & connections" actions={<Small label="+ Add" onClick={() => editEntity('connections', { a_device_id: id }, back)} />}>
          <ConnTable rows={d.connections} after={back} perspective={id} /></Card>
      </>],
      ['logins', 'Logins', d.credentials.length || null, () => <Card title="Logins" actions={<Small label="+ Add" onClick={actions.addLogin} />}><CredTable rows={d.credentials} after={back} /></Card>],
      ['actions', 'Actions', d.actions.length || null, () => <>
        <Card title="Actions" actions={<Small label="+ Add" onClick={() => editAction({ device_id: id }, back)} />}>
          {d.actions.length ? <ActionsTable rows={d.actions} after={back} showDevice={false} /> : <div>
            <p className="muted">Commands you send to this device with one click. Start from an example:</p>
            <ActionExamples preset={{ device_id: id }} after={back} /></div>}</Card>
        <Card title="Online" actions={<><Small label="⟳ Check now" onClick={check} />{d.can_wake ? <Small label="⏻ Wake" onClick={() => wakeDevice(id, dev.name)} /> : null}</>}>
          {on.address ? <div>
            <Table rows={[{ ...on, label: 'main', id: 'main' }, ...on.others.map((o, i) => ({ ...o, id: 'o' + i }))]} cols={[
              { label: 'Address', get: r => <span><span className="mono">{r.address}</span>{r.label ? <span className="muted small">{` ${r.label}`}</span> : null}</span> },
              { label: 'State', get: r => <span title={onlineTitle(r as any)}><StateBadge state={r.state} /></span> },
              { label: 'Answer', get: r => r.state === 'up' ? nz(fmtMs(r.latency_ms), r.method ? `on ${r.method}` : '') : r.state === 'down' && r.since ? `none since ${clock(r.since)}` : '' },
              { label: 'Checked', get: r => r.checked_at ? timeAgo(r.checked_at) : '' },
            ]} />
            <HistoryStrip st={on} />
            {on.services?.length ? <Table rows={on.services} cols={[
              { label: 'Service', get: r => r.name },
              { label: 'State', get: r => <ServicePill sv={r as any} /> },
              { label: 'Answer', get: r => nz(r.detail, r.state === 'up' && r.latency_ms != null ? `· ${fmtMs(r.latency_ms)}` : '') },
              { label: 'Certificate', get: r => <CertText date={r.cert_expires} /> },
              { label: 'Checked', get: r => r.checked_at ? timeAgo(r.checked_at) : '' },
            ]} /> : null}
            {['off', 'unwatched'].includes(on.state) ? <p className="muted small">{onlineTitle(on)}.</p> : null}
          </div> : <div className="empty">Add an IP address on the Network tab, and HaRM checks whether it answers.</div>}
        </Card>
      </>],
    ]} />
  </>;
}

function OtherSlot({ sl, id, back }: { sl: Row; id: number; back: Back }) {
  const [open, setOpen] = useState(false);
  const pct = sl.total ? Math.min(100, (sl.used / sl.total) * 100) : 0;
  const free = sl.total - sl.used;
  return (
    <div className="slot">
      <div className="slot-head">
        <div><b>{sl.interface}</b>{sl.form_factor ? ` · ${sl.form_factor}` : ''}{sl.notes ? <div className="muted small">{sl.notes}</div> : null}</div>
        <div className="row-actions">
          {sl.compatible.length && free > 0 ? <Small label={`${sl.compatible.length} spare${sl.compatible.length > 1 ? 's' : ''} fit`} onClick={() => setOpen(o => !o)} cls="info" /> : null}
          <Small label="Edit" onClick={() => editEntity('device_slots', sl, back)} />
          <Small label="Delete" onClick={() => deleteEntity('device_slots', sl, back)} cls="ghost-danger" />
        </div>
      </div>
      <Bar pct={pct} cls={sl.used > sl.total ? 'hot' : ''} n={`${sl.used}/${sl.total} used`} />
      {/^raid$/i.test(sl.interface || '') ? <div className="warn-text small">“Raid” isn’t a connection type (RAID is set up on the controller). Edit this and pick SAS or SATA so spare drives match properly.</div> : null}
      <div className="compat" hidden={!open}>
        {sl.compatible.length ? <SparesTable rows={sl.compatible} onInstall={c => installDialog(c, id, back)} /> : <div className="empty">No compatible spares in stock.</div>}
      </div>
    </div>
  );
}

export { Placement };
