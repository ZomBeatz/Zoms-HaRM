/* Status: which devices are answering right now, grouped by where they are. */
import { useEffect } from 'react';
import { api, GET, loadLookups } from '../api/client';
import { S } from '../lib/state';
import { alertChime, look, setLook } from '../lib/look';
import { locPath } from '../lib/lookups';
import { clock, fmtMs, forHowLong, nz, prefGet, prefSet, timeAgo, utcDate, type Row } from '../lib/util';
import { anyModalOpen, toast } from '../ui/overlay';
import { Btn, Card, MenuButton, PageHead, Small, Table } from '../ui/bits';
import { editEntity } from '../lib/forms';
import { runAction } from '../lib/actions';
import { CertText, HistoryStrip, OnlinePill, ServicePill, StateBadge, onlineTitle, wakeDevice } from '../lib/status';
import { editAlerts, editNetwatch } from '../dialogs/watch';
import { Pending, useLoad } from '../app/router';
import { deviceCategory } from './Racks';

const svcDown = (d: Row) => (d.services || []).filter((sv: Row) => sv.state === 'down').length;

/* Group the devices by where they are (a VM by its host's place), in rack order, top first. */
function statusGroups(devices: Row[]): [string, Row[]][] {
  const byId = new Map(devices.map(d => [d.id, d]));
  const groups = new Map<string, Row[]>();
  for (const d of devices) {
    const host = d.host_id ? byId.get(d.host_id) : null;
    const loc = d.location_id || host?.location_id || null;
    const key = loc ? locPath(loc) : 'No location';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(d);
  }
  for (const list of groups.values()) {
    // Racked gear first (top of the rack first), then loose gear, then VMs by their host.
    const rank = (x: Row) => x.host_id ? 2 : x.rack_name ? 0 : 1;
    list.sort((a, b) => rank(a) - rank(b) || (a.rack_name || '').localeCompare(b.rack_name || '') || (b.rack_u || 0) - (a.rack_u || 0)
      || (a.host_name || '').localeCompare(b.host_name || '') || a.name.localeCompare(b.name));
  }
  return [...groups.entries()].sort(([a], [b]) => (+(a === 'No location') - +(b === 'No location')) || a.localeCompare(b));
}

function StatusTile({ d, after }: { d: Row; after: () => void }) {
  const [cat] = deviceCategory(d.device_type);
  const where = d.rack_name ? `${d.rack_name}${d.rack_u ? ` U${d.rack_u}` : ''}` : d.host_name ? `on ${d.host_name}` : '';
  const acts = [
    ...d.actions.slice(0, 3).map((a: Row) => <Small key={'a' + a.id} label={`▶ ${a.name}`} onClick={() => runAction(a, { after })} />),
    d.can_wake && d.state === 'down' ? <Small key="wake" label="⏻ Wake" onClick={() => wakeDevice(d.id, d.name)} /> : null,
    d.mgmt_url ? <a key="mgmt" className="button sm" href={d.mgmt_url} target="_blank" rel="noopener noreferrer">Manage ↗</a> : null,
  ].filter(Boolean);
  return (
    <div className={`st-tile cat-${cat} st-${d.state}${svcDown(d) ? ' st-svc-down' : ''}`}>
      <div className="st-head"><a className="st-name" href={`#/devices/${d.id}`}>{d.name}</a><OnlinePill st={d as any} /></div>
      <div className="st-line small">
        {d.address ? <span className="mono">{d.address}</span> : null}
        {d.state === 'up' && d.latency_ms != null ? <span className="muted">{` · ${fmtMs(d.latency_ms)}`}</span> : null}
        {d.state === 'down' && d.since ? <span className="bad-text" title={`No answer since ${clock(d.since)}`}>{` · ${forHowLong(d.since)}`}</span> : null}
      </div>
      <div className="muted small">{nz(d.device_type, where ? `· ${where}` : '')}</div>
      {d.others.length ? <div className="st-others">{d.others.map((o: Row, i: number) => (
        <span key={i} className="st-other small" title={onlineTitle(o as any)}>{o.label || o.address} <StateBadge state={o.state} /></span>
      ))}</div> : null}
      {d.services?.length ? <div className="st-others">{d.services.map((sv: Row) => (
        <span key={sv.id} className="st-other small">{sv.name} <ServicePill sv={sv as any} />
          {sv.cert_expires && (new Date(sv.cert_expires).getTime() - Date.now()) < 30 * 864e5 ? <> <span className="badge warn" title="Its certificate">Certificate <CertText date={sv.cert_expires} /></span></> : null}</span>
      ))}</div> : null}
      <HistoryStrip st={d as any} />
      {acts.length ? <div className="st-actions">{acts}</div> : null}
    </div>
  );
}

/* Devices the new-device watch found that HaRM doesn't know yet: add each one, or ignore it. */
function NewDevicesCard({ list, after }: { list: Row[]; after: () => void }) {
  if (!list.length) return null;
  const mark = async (x: Row, status: string) => { try { await api('POST', `/netwatch/${x.id}`, { status }); after(); } catch (e) { toast((e as Error).message, 'bad'); } };
  const add = (x: Row) => editEntity('devices', { name: (x.hostname || '').split('.')[0] || `Device at ${x.ip}`, status: 'Active', connected: true }, async r => {
    try {
      await api('POST', '/interfaces', { device_id: r.id, ip: x.ip, mac: x.mac || null, is_primary: true });
      await api('POST', `/netwatch/${x.id}`, { status: 'added' });
    } catch (e) { toast((e as Error).message, 'bad'); }
    await loadLookups();
    location.hash = `#/devices/${r.id}`;
  });
  return (
    <Card title={`New on the network · ${list.length}`} actions={<Small label="⚙ Watch settings" onClick={() => editNetwatch(after)} />}>
      <div>
        <p className="muted small">Addresses HaRM doesn’t know yet, on the networks it watches. Add each one, or ignore it if it’s a visitor.</p>
        <Table rows={list} cols={[
          { label: 'Address', get: x => <span className="mono">{x.ip}</span> },
          { label: 'Name', get: x => x.hostname || <span className="muted">Unknown</span> },
          { label: 'MAC', get: x => x.mac ? <span className="mono small">{x.mac}</span> : '' },
          { label: 'Network', get: x => x.network || '' },
          { label: 'First seen', get: x => timeAgo(x.first_seen) },
          { label: '', nosort: true, get: x => <div className="row-actions"><Small label="+ Add…" onClick={() => add(x)} cls="primary" /><Small label="Ignore" onClick={() => mark(x, 'ignored')} /></div> },
        ]} />
      </div>
    </Card>
  );
}

export default function Status() {
  const q = useLoad(async () => {
    const [d, nw] = await Promise.all([GET('/status'), GET('/netwatch').catch(() => ({ pending: [] }))]);
    // Tell about changes since the last look (while the page stays open).
    if (S.statusPrev) {
      let wentDown = false;
      for (const x of d.devices) {
        const was = S.statusPrev.get(x.id);
        if (was === 'up' && x.state === 'down') wentDown = true;
        if (was === 'up' && x.state === 'down') toast(`${x.name} is offline`, 'bad', { label: 'Open', onClick: () => { location.hash = `#/devices/${x.id}`; } });
        if (was === 'down' && x.state === 'up') toast(`${x.name} is back online`);
        for (const sv of x.services || []) {
          const before = S.statusPrevSvc?.get(sv.id);
          if (before === 'up' && sv.state === 'down') { wentDown = true; toast(`${sv.name} on ${x.name} isn’t answering`, 'bad'); }
        }
      }
      if (wentDown && look().sound) alertChime();
    }
    S.statusPrev = new Map(d.devices.map((x: Row) => [x.id, x.state]));
    S.statusPrevSvc = new Map(d.devices.flatMap((x: Row) => (x.services || []).map((sv: Row) => [sv.id, sv.state])));
    return { d, nw };
  });
  const reload = q.reload;
  // Fresh results now if they're over a minute old, then every 30 seconds while this page is open.
  useEffect(() => {
    const tick = async () => {
      if (!S.authed || document.hidden || anyModalOpen()) return;
      try { const r = await api('POST', '/status/check', { max_age: 55 }); if (r.checked) reload(); } catch { /* try again next time */ }
    };
    const timer = setInterval(tick, 30000);
    const first = setTimeout(() => {
      const last = q.data?.d.last_check;
      if (!last || (Date.now() - utcDate(last).getTime()) > 60000) tick();
    }, 300);
    // Wall display (Settings): no sidebar or bars from the start; the first tap also fills the screen.
    const goFull = () => { if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {}); };
    if (look().wall) { document.body.classList.add('wall'); document.addEventListener('click', goFull, { once: true }); }
    return () => { clearInterval(timer); clearTimeout(first); document.body.classList.remove('wall'); document.removeEventListener('click', goFull); };
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  if (!q.data) return <Pending q={q} />;
  const { d, nw } = q.data;
  const filter = prefGet('harm-status-filter') || 'all';
  const counts = { up: 0, down: 0, other: 0 };
  for (const x of d.devices) counts[x.state === 'up' ? 'up' : x.state === 'down' ? 'down' : 'other']++;
  const shown = d.devices.filter((x: Row) => filter === 'all' || (filter === 'down' ? x.state === 'down' || svcDown(x) : ['up', 'down', 'unknown'].includes(x.state)));
  const checkNow = async () => {
    toast('Checking every device…');
    try { await api('POST', '/status/check', { max_age: 0 }); } catch (e) { toast((e as Error).message, 'bad'); }
    reload();
  };
  const wall = () => {
    const on = !document.body.classList.contains('wall');
    document.body.classList.toggle('wall', on);
    if (on && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };
  const every = d.status_interval ? `HaRM checks every ${d.status_interval === 1 ? 'minute' : `${d.status_interval} minutes`}, and every minute while this page is open.`
    : 'Automatic checks are off. Press Check now, or turn them on in Settings.';
  const stat = (n: number, label: string, cls: string) => <div className={`stat ${cls}`}><div className="stat-n">{n}</div><div className="stat-l">{label}</div></div>;
  const leaveWall = () => {
    if (look().wall) { setLook({ wall: false }); toast('Wall display is off on this device'); }
    document.body.classList.remove('wall');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };
  return <>
    <button type="button" className="wall-exit sm" onClick={leaveWall}>{look().wall ? 'Leave wall display' : 'Exit full screen'}</button>
    <PageHead title="Status" sub={d.last_check ? `Which devices are answering. Last checked ${timeAgo(d.last_check)}.` : 'Which devices are answering right now.'}>
      <select aria-label="Show" value={filter} onChange={e => { prefSet('harm-status-filter', e.target.value); reload(); }}>
        {[['all', 'All devices'], ['checked', 'Only the ones checked'], ['down', 'Only problems']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <a className="button" href="#/uptime">📊 Uptime</a>
      <Btn label="⟳ Check now" onClick={checkNow} cls="primary" />
      <MenuButton label="⋯" items={[
        ['⛶ Full screen (for a wall screen)', wall],
        ['⚙ How often to check…', () => { location.hash = '#/settings'; }],
        ['🔔 Alerts…', () => editAlerts(reload)],
        ['📶 Watch for new devices…', () => editNetwatch(reload)],
        ['📊 Uptime report', () => { location.hash = '#/uptime'; }],
        ['⚡ Actions', () => { location.hash = '#/actions'; }],
        ['❓ How this works', () => { location.hash = '#/help?s=status'; }],
      ]} />
    </PageHead>
    {d.devices.length ? <div className="stats st-stats">{stat(counts.up, 'Online', 'st-up')}{stat(counts.down, 'Offline', counts.down ? 'st-down' : '')}{stat(counts.other, 'Not checked', '')}</div> : null}
    <NewDevicesCard list={nw.pending || []} after={reload} />
    {!d.status_interval ? <div className="banner">Automatic checks are off, so this page only changes when you press Check now. <a className="button sm" href="#/settings">Settings</a></div> : null}
    {!d.devices.length ? <div className="empty-state"><div className="empty-ico">📶</div>
      <p>Devices show up here once they have an IP address. HaRM then checks whether each one answers.</p><a className="button primary" href="#/devices">Go to Devices</a></div>
      : !shown.length ? <div className="all-good">{filter === 'down' ? '✓ Everything that’s checked is online and answering.' : 'Nothing to show with this filter.'}</div>
        : statusGroups(shown).map(([name, list]) => {
          const down = list.filter(x => x.state === 'down').length;
          const svc = list.reduce((n, x) => n + svcDown(x), 0);
          return (
            <section key={name} className="st-group">
              <h2 className="st-group-head">{name}<span className="muted small">{` ${list.length} device${list.length === 1 ? '' : 's'}`}</span>
                {down ? <span className="badge bad">{`${down} offline`}</span> : null}
                {svc ? <span className="badge warn">{`${svc} service${svc === 1 ? '' : 's'} not answering`}</span> : null}</h2>
              <div className="st-grid">{list.map(x => <StatusTile key={x.id} d={x} after={reload} />)}</div>
            </section>
          );
        })}
    <p className="muted small st-foot">{every}{d.without_address ? ` ${d.without_address} device${d.without_address === 1 ? ' has' : 's have'} no IP address and ${d.without_address === 1 ? 'isn’t' : 'aren’t'} shown.` : ''}</p>
  </>;
}

