/* Home: what needs you, and what you've got. */
import { useState } from 'react';
import { GET } from '../api/client';
import { clock, forHowLong, prefGet, prefSet, type Row } from '../lib/util';
import { A, Badge, Bar, Card, PageHead, WarrantyCell, type Kid } from '../ui/bits';
import { CertText } from '../lib/status';
import { NoteItem } from '../lib/notes';
import { Pending, useLoad } from '../app/router';

export function AuditList({ rows }: { rows: Row[] }) {
  return rows.length ? <ul className="plain audit">{rows.map((a, i) => (
    <li key={i}><span className="muted mono">{a.ts.slice(5, 16)}</span> <b>{a.action}</b> {a.entity ? `${a.entity}` : ''}{a.detail ? <span className="muted">{`: ${a.detail}`}</span> : ''}</li>
  ))}</ul> : <div className="empty">No activity yet.</div>;
}

function BarList({ rows, hrefOf, cls = '' }: { rows: Row[]; hrefOf?: (r: Row) => string; cls?: string }) {
  const max = Math.max(...rows.map(x => x.n), 1);
  return <div className="bars">{rows.map((r, i) => <Bar key={i} pct={(r.n / max) * 100} cls={cls} label={r.label} n={r.n} href={hrefOf?.(r)} title={r.capacities || undefined} />)}</div>;
}

const Stat = ({ n, label, href }: { n: Kid; label: string; href: string }) => <a className="stat" href={href}><div className="stat-n">{n}</div><div className="stat-l">{label}</div></a>;

export default function Dashboard() {
  const q = useLoad(() => Promise.all([GET('/dashboard'), GET('/devices/summary'), GET('/update-check').catch(() => ({}))]));
  const [hideUpd, setHideUpd] = useState(false);
  if (!q.data) return <Pending q={q} />;
  const [d, sum, upd] = q.data;
  const c = d.counts;
  const back = q.reload;
  const isEmpty = c.devices === 0 && c.components === 0 && c.racks === 0;
  // One list of everything that needs a look, most urgent first.
  const att: [string, Kid][] = [];
  const item = (ico: string, body: Kid) => att.push([ico, body]);
  (d.offline || []).forEach((r: Row) => item('📶', <><A href={`#/devices/${r.id}`}>{r.label}</A> <span className="badge bad">Offline</span>
    <span className="muted">{r.since ? ` since ${clock(r.since)}, ${forHowLong(r.since)}` : ''}</span></>));
  (d.services_down || []).forEach((r: Row) => item('📶', <>{r.name} on <A href={`#/devices/${r.device_id}`}>{r.device_name}</A> <span className="badge bad">Not answering</span>
    <span className="muted">{r.detail ? ` ${r.detail}` : ''}</span></>));
  if (d.new_on_network) item('📶', <><A href="#/status">{`${d.new_on_network} new device${d.new_on_network === 1 ? '' : 's'} on the network`}</A> to add or ignore</>);
  (d.certs || []).forEach((r: Row) => item('🛡', <>The certificate for {r.name} on <A href={`#/devices/${r.device_id}`}>{r.device_name}</A> <CertText date={r.cert_expires} /></>));
  (d.power || []).forEach((r: Row) => item('🔌', <><A href={r.kind === 'rack' ? `#/racks/${r.id}` : `#/devices/${r.id}`}>{r.name}</A>{` is at ${Math.round(r.pct * 100)}% of its power (${r.used_w} of ${r.limit_w} W)`}</>));
  d.ip_conflicts.forEach((r: Row) => item('⚠', <><b className="mono bad-text">{r.label}</b>{` is used by more than one device: ${r.devices}`}</>));
  (d.needs_repair || []).forEach((r: Row) => item('🛠', <><A href={`#/devices/${r.id}`}>{r.label}</A> <Badge status={r.status} /></>));
  d.warranty_soon.forEach((r: Row) => item('🛡', <><A href={r.kind === 'device' ? `#/devices/${r.id}` : `#/components?id=${r.id}`}>{r.label}</A> warranty ends <WarrantyCell d={r.warranty_until} /></>));
  if (d.unconnected_active.length) {
    const n = d.unconnected_active.length;
    item('🔌', <>{`${n} active device${n > 1 ? 's are' : ' is'} marked not hooked up: `}
      {d.unconnected_active.slice(0, 6).map((r: Row, i: number) => <span key={r.id}>{i ? ', ' : ''}<A href={`#/devices/${r.id}`}>{r.label}</A></span>)}{n > 6 ? ' …' : ''}</>);
  }
  if (d.stale_credentials.length) item('🔑', <><A href="#/vault">{`${d.stale_credentials.length} login${d.stale_credentials.length > 1 ? 's' : ''}`}</A> not changed in over a year</>);
  const showUpd = upd.newer && !hideUpd && prefGet('harm-update-hidden') !== upd.latest;
  return <>
    <PageHead title="Home" sub={isEmpty ? 'Let’s get your hardware in here.' : 'What needs you, and what you’ve got.'}>
      {isEmpty ? <a className="button primary" href="#/setup">🧭 Setup guide</a> : null}
    </PageHead>
    {showUpd ? <div className="banner"><span>{`Zom’s HaRM ${upd.latest} is out.`}</span><a className="button sm primary" href={upd.url} target="_blank" rel="noopener">What’s new ↗</a>
      <button type="button" className="icon-btn banner-x" aria-label="Hide" onClick={() => { prefSet('harm-update-hidden', upd.latest); setHideUpd(true); }}>✕</button></div> : null}
    {isEmpty ? <div className="card onboarding">
      <h3>Getting started</h3>
      <ol>
        <li><A href="#/locations">Add a location</A>: your house, the basement, the closet.</li>
        <li><A href="#/racks">Add a rack or holder</A>: a 42U rack, a wire shelf, a bin of spare drives.</li>
        <li><A href="#/devices">Add devices</A>, or pull them in from your network with <A href="#/discover">Discover</A>.</li>
        <li><A href="#/components">Catalog spare parts</A> Drives, RAM, NICs, cables and see what fits where.</li>
      </ol>
      <p><a className="button primary" href="#/setup">🧭 Start the setup guide</a> <span className="muted small">Walks you through all of this in about 10 minutes.</span></p>
    </div> : <>
      <div className="stats">
        <Stat n={c.devices} label={`Devices · ${c.connected} hooked up`} href="#/devices" />
        <Stat n={d.open_tasks.length} label="Open tasks & issues" href="#/tasks" />
        <Stat n={c.spare_units} label="Spare parts" href="#/components" />
        {sum.totals.storage ? <Stat n={sum.totals.storage} label={`Raw storage · ${sum.totals.drives} drives`} href="#/devices" /> : null}
        {sum.totals.cores ? <Stat n={sum.totals.cores} label={`CPU cores${sum.totals.ram ? ' · ' + sum.totals.ram + ' RAM' : ''}`} href="#/devices" /> : null}
      </div>
      <div className="grid two">
        <Card title="Needs attention">{att.length ? <ul className="attention">{att.map(([ico, body], i) => <li key={i}><span className="a-ico">{ico}</span><span>{body}</span></li>)}</ul>
          : <div className="all-good">✓ Nothing needs attention.</div>}</Card>
        <Card title={`Tasks & issues${d.open_tasks.length ? ' · ' + d.open_tasks.length : ''}`}
          actions={<a className="button sm" href="#/tasks">{d.open_tasks.length > 8 ? `All ${d.open_tasks.length}` : 'Tasks page'}</a>}>
          {d.open_tasks.length ? <ul className="plain notes-list open">{d.open_tasks.slice(0, 8).map((n: Row) => <NoteItem key={n.id} n={n} after={back} showTarget />)}</ul>
            : <div className="empty">No open tasks. Add them from any device’s page, or on the Tasks page.</div>}</Card>
      </div>
      <div className="grid">
        {d.racks.some((r: Row) => r.height_u) ? <Card title="Rack space"><div className="bars">{d.racks.filter((r: Row) => r.height_u).map((r: Row) => {
          const pct = Math.min(100, Math.round((r.used_u / r.height_u) * 100));
          return <Bar key={r.id} href={`#/racks/${r.id}`} label={r.name} pct={pct} cls={pct > 85 ? 'hot' : ''} n={`${r.used_u}/${r.height_u}U`} />;
        })}</div></Card> : null}
        {d.spares_by_category.length ? <Card title="Spare parts on hand"><BarList rows={d.spares_by_category} hrefOf={() => '#/components'} cls="alt" /></Card> : null}
        {d.storage_installed.drives ? <Card title="Storage"><div>
          <div className="storage-total"><b>{d.storage_installed.total}</b><span className="muted">{` raw installed in ${d.storage_installed.drives} drives`}</span></div>
          <ul className="plain storage-groups">{d.storage_installed.groups.slice(0, 6).map((g: Row, i: number) => <li key={i}><b>{`${g.count} × ${g.capacity}`}</b>{` ${g.category}`}</li>)}</ul>
          {d.storage_spare.drives ? <p><A href="#/components">{`${d.storage_spare.total} spare`}</A><span className="muted">{` on the shelf in ${d.storage_spare.drives} drives`}</span></p> : null}
        </div></Card> : null}
      </div>
      <details className="more-stats"><summary>More: devices by status and type, recent activity</summary>
        <div className="grid">
          <Card title="Devices by status">{d.devices_by_status.length ? <BarList rows={d.devices_by_status} /> : <div className="empty">Nothing yet.</div>}</Card>
          <Card title="Devices by type">{d.devices_by_type.length ? <BarList rows={d.devices_by_type} /> : <div className="empty">Nothing yet.</div>}</Card>
          <Card title="Recent activity" actions={<a className="button sm" href="#/audit">Audit log</a>}><AuditList rows={d.recent} /></Card>
        </div>
      </details>
    </>}
  </>;
}
