/* PC Builder and the parts library page. */
import { api, GET, loadLookups } from '../api/client';
import { S } from '../lib/state';
import { rackInLocation } from '../lib/lookups';
import { money, type Row } from '../lib/util';
import { toast } from '../ui/overlay';
import { A, Badge, Bar, Btn, Card, HelpLink, PageHead, Small } from '../ui/bits';
import { formDialog } from '../ui/form';
import { deleteEntity, editEntity, rackPicked } from '../lib/forms';
import { LibraryEmptyCard, LibrarySearch, SourceBadge, customPartDialog, partDetail, pcMeta, pickPart, startLibraryUpdate } from '../dialogs/library';
import { BackLink, Pending, goBackOr, useLoad } from '../app/router';

const BUILD_PURPOSE_DEVICE: Record<string, string> = { 'NAS': 'NAS', 'Homelab server': 'Server', 'Hypervisor host': 'Hypervisor Host', 'Router / firewall': 'Firewall', 'Workstation': 'Workstation' };

export function Builds() {
  const q = useLoad(() => Promise.all([GET<Row[]>('/builds'), GET('/catalog/status'), pcMeta()]));
  if (!q.data) return <Pending q={q} />;
  const [rows, st] = q.data;
  const newBuild = () => editEntity('builds', { status: 'Planning' }, r => { location.hash = `#/builds/${r.id}`; });
  return <>
    <PageHead title="PC Builder" sub="Plan builds from the parts library, your spare parts and custom parts, with compatibility checks.">
      <HelpLink s="builder" /><a className="button" href="#/library">▦ Parts library</a><Btn label="+ New build" onClick={newBuild} cls="primary" />
    </PageHead>
    {st.total ? null : <LibraryEmptyCard />}
    {rows.length ? <div className="tiles">{rows.map(b => (
      <a key={b.id} className="tile" href={`#/builds/${b.id}`}>
        <div className="tile-head"><b>{b.name}</b><Badge status={b.status} /></div>
        <div className="muted small">{[b.purpose, b.device_name ? `→ ${b.device_name}` : ''].filter(Boolean).join(' · ') || ' '}</div>
        <div className="small">{`${b.item_count} part${b.item_count === 1 ? '' : 's'} · ${money(b.total_price)}${b.budget ? ` of ${money(b.budget)} budget` : ''}`}</div>
      </a>
    ))}</div> : <div className="card onboarding"><h3>No builds yet</h3>
      <p>A build is a parts list for one computer: a new gaming PC, a NAS from spare parts, or an upgrade to something you own. HaRM checks that everything fits together, and once it’s built, turns it into a device with its parts installed.</p>
      <Btn label="+ Start a build" onClick={newBuild} cls="primary" /></div>}
  </>;
}

const LV: Record<string, [string, string]> = { error: ['✗', 'bad-text'], warn: ['⚠', 'warn-text'], info: ['ℹ', 'muted'], ok: ['✓', 'ok-text'] };
const CheckLi = ({ c }: { c: Row }) => <li><span className={LV[c.level][1]}>{LV[c.level][0]}</span> {c.message}</li>;

export function Build({ id }: { id: number }) {
  const q = useLoad(() => Promise.all([GET(`/builds/${id}/full`), pcMeta()]));
  if (!q.data) return <Pending q={q} />;
  const [d] = q.data;
  const b = d.build, st = d.stats, back = q.reload;
  const itemIssues = (itemId: number) => d.checks.filter((c: Row) => (c.level === 'error' || c.level === 'warn') && c.items.includes(itemId));
  const put = async (itemId: number, patch: Row) => { try { await api('PUT', `/build_items/${itemId}`, patch); back(); } catch (e) { toast((e as Error).message, 'bad'); } };
  const status = st.errors ? <div className="compat bad">{`✗ ${st.errors} compatibility problem${st.errors > 1 ? 's' : ''}`}</div>
    : st.warnings ? <div className="compat warn">{`⚠ No blockers, ${st.warnings} thing${st.warnings > 1 ? 's' : ''} to check`}</div>
      : d.items.length ? <div className="compat ok">✓ No compatibility problems found</div> : <div className="compat">Add parts to check compatibility</div>;
  const rows: React.ReactNode[] = [];
  for (const c of S.pc!.categories) {
    const its = d.items.filter((i: Row) => i.category === c.key);
    const single = S.pc!.single.includes(c.key);
    const chooseBtn = <Small label={its.length ? `+ Add another` : `+ Choose ${c.label}`} onClick={() => pickPart(b, c.key, null, back)} cls={its.length ? '' : 'primary'} />;
    if (!its.length) { rows.push(<tr key={c.key} className="empty-slot"><th>{c.label}</th><td colSpan={5}>{chooseBtn}</td></tr>); continue; }
    its.forEach((it: Row, idx: number) => {
      const issues = itemIssues(it.id);
      const worst = issues.some((x: Row) => x.level === 'error') ? 'error' : issues.length ? 'warn' : null;
      const nameEl = it.catalog_id ? <a href="#" onClick={e => { e.preventDefault(); partDetail(it.catalog_id); }}>{it.name}</a>
        : it.component_id ? <A href={`#/components?id=${it.component_id}`}>{it.name}</A> : <span>{it.name}</span>;
      rows.push(
        <tr key={it.id} className={worst ? `has-${worst}` : ''}>
          <th>{idx === 0 ? c.label : ''}</th>
          <td className="part-cell">
            <div>{worst ? <span className={worst === 'error' ? 'bad-text' : 'warn-text'} title={issues.map((x: Row) => x.message).join('\n')}>{worst === 'error' ? '✗ ' : '⚠ '}</span> : null}{nameEl} <SourceBadge src={it.source} /></div>
            <div className="muted small">{it.summary || (it.source === 'manual' ? 'No specs' : '')}</div>
            {it.component_id && it.comp_device_id ? <div className="warn-text small">Currently installed in another device</div> : null}
          </td>
          <td data-label="Status"><select className={'acq ' + (it.acquire || '').toLowerCase()} value={it.acquire || ''} aria-label="Have / need" onChange={e => put(it.id, { acquire: e.target.value })}>
            {S.enums.acquire_states.map(a => <option key={a} value={a}>{a}</option>)}</select></td>
          <td data-label="Qty"><input type="number" min={1} defaultValue={it.qty} className="qty" aria-label="Quantity" onBlur={e => { if (e.target.value !== String(it.qty)) put(it.id, { quantity: e.target.value }); }} /></td>
          <td data-label="Price"><input type="number" min={0} step="0.01" defaultValue={it.price ?? ''} placeholder="$" className="price" aria-label="Price each" onBlur={e => { if (e.target.value !== String(it.price ?? '')) put(it.id, { price: e.target.value }); }} /></td>
          <td className="row-actions">
            {single ? <Small label="Swap" onClick={() => pickPart(b, c.key, it, back)} /> : null}
            <Small label="Remove" onClick={async () => { await api('DELETE', `/build_items/${it.id}`); back(); }} cls="ghost-danger" />
          </td>
        </tr>);
    });
    if (!single) rows.push(<tr key={c.key + '-add'} className="add-row"><th /><td colSpan={5}>{chooseBtn}</td></tr>);
  }
  const passed = d.checks.filter((c: Row) => c.level === 'ok');
  const toDevice = () => formDialog({
    title: 'Create a device from this build',
    fields: [
      { k: 'name', label: 'Device name', required: true, default: b.name },
      { k: 'device_type', label: 'Type', list: 'device_types', default: BUILD_PURPOSE_DEVICE[b.purpose] || 'Desktop' },
      { k: 'location_id', label: 'Location (room)', type: 'fk', entity: 'locations' },
      { k: 'rack_id', label: 'Rack / holder', type: 'fk', entity: 'racks', none: 'None (loose in the room)', scopeBy: ['location_id'], scope: rackInLocation, onChange: rackPicked },
      { k: 'install_inventory', label: 'Install the parts from my inventory into it', type: 'checkbox', default: true, wide: true },
      { k: 'create_components', label: 'Record library/custom parts as installed components', type: 'checkbox', default: true, wide: true },
    ],
    extra: <p className="muted small">Also adds the motherboard’s memory, M.2, SATA and PCIe slots to the device, so spare-part matching works for future upgrades.</p>,
    saveLabel: 'Create device',
    submit: v => api('POST', `/builds/${id}/to-device`, v),
    onDone: async r => { await loadLookups(); toast(`Device created: ${r.slots} slots, ${r.installed + r.created} parts`); location.hash = `#/devices/${r.device_id}`; },
  });
  return <>
    <div className="crumbs"><BackLink /><A href="#/builds">PC Builder</A>{' › '}{b.name}</div>
    <PageHead title={<span>{b.name} <Badge status={b.status} /></span>} sub={b.purpose || null}>
      <HelpLink s="builder" />
      {b.device_id ? <a className="button" href={`#/devices/${b.device_id}`}>{`→ ${b.device_name || 'Device'}`}</a> : <Btn label="🖥 Create device" onClick={toDevice} cls={d.items.length ? 'primary' : ''} />}
      <Btn label="Edit" onClick={() => editEntity('builds', b, back)} />
      <Btn label="Duplicate" onClick={async () => { const n = await api('POST', `/builds/${id}/duplicate`); location.hash = `#/builds/${n.id}`; }} />
      <Btn label="Delete" onClick={() => deleteEntity('builds', b, () => goBackOr('#/builds'))} cls="ghost-danger" />
    </PageHead>
    <div className="build-summary card">
      {status}
      <div className="bs-stat"><b>{st.est_watts ? `~${st.est_watts} W` : 'None'}</b><span>{st.recommended_psu ? `estimated draw · ${st.recommended_psu} W+ PSU` : 'estimated draw'}</span></div>
      <div className="bs-stat"><b>{money(st.total_price)}</b><span>{st.to_buy_price ? `${money(st.to_buy_price)} still to buy` : 'total'}</span></div>
      <div className="bs-stat"><b>{`${st.have}/${d.items.length}`}</b><span>{`parts on hand${st.ordered ? ` · ${st.ordered} ordered` : ''}`}</span></div>
      {b.budget ? <div className="bs-budget"><Bar pct={(st.total_price / b.budget) * 100} cls={st.total_price > b.budget ? 'hot' : ''} n={`${money(st.total_price)} / ${money(b.budget)}`} /></div> : null}
    </div>
    {b.notes ? <div className="card notes">{b.notes}</div> : null}
    <div className="card"><div className="table-wrap"><table className="build-table">
      <thead><tr><th>Component</th><th>Part</th><th>Status</th><th>Qty</th><th>Price each</th><th /></tr></thead>
      <tbody>{rows}</tbody>
    </table></div></div>
    <Card title="Compatibility"><div>
      <ul className="plain checks">{d.checks.filter((c: Row) => c.level !== 'ok').map((c: Row, i: number) => <CheckLi key={i} c={c} />)}</ul>
      {passed.length ? <details><summary>{`${passed.length} check${passed.length > 1 ? 's' : ''} passed`}</summary><ul className="plain checks">{passed.map((c: Row, i: number) => <CheckLi key={i} c={c} />)}</ul></details> : null}
      <p className="muted small">Checks: socket, memory type/slots/capacity, ECC/RDIMM, case fit for board, GPU length and cooler height, PSU form factor/length/wattage/connectors, M.2 and SATA capacity, drive bays, video output. Library data can have gaps; double-check anything critical.</p>
    </div></Card>
  </>;
}

export function Library() {
  const q = useLoad(() => Promise.all([GET('/catalog/status'), pcMeta()]));
  if (!q.data) return <Pending q={q} />;
  const [st] = q.data;
  const F = S.filters.library = S.filters.library || { cat: 'cpu' };
  const counts: Record<string, number> = {};
  for (const r of st.counts) counts[r.category] = (counts[r.category] || 0) + r.n;
  const src = st.source;
  return <>
    <PageHead title="Parts Library" sub={st.total ? `${st.total.toLocaleString()} parts to plan builds with and catalog your inventory.` : 'Specs for PC parts, used for builds and compatibility checks.'}>
      <HelpLink s="library" />
      <Btn label="+ Custom part" onClick={() => customPartDialog({ category: F.cat }, q.reload)} />
      <Btn label={st.total ? '⟳ Update library' : '⬇ Download library'} onClick={() => startLibraryUpdate(q.reload)} cls={st.total ? '' : 'primary'} />
    </PageHead>
    {st.total ? null : <LibraryEmptyCard after={q.reload} />}
    <div className="card"><LibrarySearch category={F.cat} categorySelect /></div>
    <div className="card muted small attribution">
      <p>{S.pc!.attribution}</p>
      {src ? <p>{`Last imported ${src.at}${src.ref ? ` (source ${src.ref})` : ''}: ${src.imported.toLocaleString()} parts.`}</p> : null}
      <p>{'In the library: '}{S.pc!.categories.filter((c: Row) => counts[c.key]).map((c: Row) => `${c.label} ${counts[c.key].toLocaleString()}`).join(' · ') || 'nothing yet'}.</p>
    </div>
  </>;
}
