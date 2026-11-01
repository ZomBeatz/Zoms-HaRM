/* The uptime report: how much of the last day, week or month each device and service answered. */
import { GET } from '../api/client';
import { duration, prefGet, prefSet, type Row } from '../lib/util';
import { A, Bar, Card, PageHead, Table, type Col } from '../ui/bits';
import { Pending, useLoad } from '../app/router';

function PctCell({ x }: { x: Row }) {
  if (x.uptime == null) return null;
  const p = x.uptime * 100;
  return <Bar pct={p} cls={p < 99 ? 'over' : p < 99.9 ? 'hot' : 'good'} n={`${p >= 99.95 || p === 0 ? Math.round(p) : p.toFixed(p >= 99 ? 2 : 1)}%`} />;
}
const kind = (x: Row) => /container/i.test(x.device_type || '') ? 'Container' : /virtual/i.test(x.device_type || '') ? 'VM' : '';

export default function Uptime({ q: qs }: { q: URLSearchParams }) {
  const days = +(qs.get('days') || prefGet('harm-uptime-days') || 7);
  const q = useLoad(() => GET(`/status/report?days=${days}`));
  if (!q.data) return <Pending q={q} />;
  const r = q.data;
  const common: Col<Row>[] = [
    { label: 'Answered', get: x => <PctCell x={x} />, sort: x => x.uptime ?? 2 },
    { label: 'Outages', get: x => x.outages || '', sort: x => x.outages },
    { label: 'Longest', get: x => duration(x.longest_s), sort: x => x.longest_s },
    { label: 'Down in total', get: x => duration(x.down_s), sort: x => x.down_s },
  ];
  return <>
    <PageHead title="Uptime report" sub="How much of the time each device and service answered, worst first.">
      <select aria-label="Period" value={days} onChange={e => { prefSet('harm-uptime-days', e.target.value); location.hash = `#/uptime?days=${e.target.value}`; }}>
        {[[1, 'Last 24 hours'], [7, 'Last 7 days'], [30, 'Last 30 days']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <a className="button" href="#/status">📶 Status</a>
    </PageHead>
    <Card title={`Devices · ${r.devices.length}`}><Table rows={r.devices} empty="Nothing checked yet in this period. Devices show here once HaRM has checked them." cols={[
      { label: 'Device', get: x => <span><A href={`#/devices/${x.id}`}>{x.name}</A>{kind(x) ? <span className="muted small">{` ${kind(x)}${x.host_name ? ` on ${x.host_name}` : ''}`}</span> : null}</span>, sort: x => x.name },
      ...common,
    ]} /></Card>
    <Card title={`Services · ${r.services.length}`}><Table rows={r.services} empty="No services checked yet. Add web addresses or ports on a device’s Network tab, including the ones your Docker containers publish." cols={[
      { label: 'Service', get: x => <span>{x.name} on <A href={`#/devices/${x.device_id}`}>{x.device_name}</A>{kind(x) ? <span className="muted small">{` (${kind(x)})`}</span> : null}</span>, sort: x => x.name },
      ...common,
    ]} /></Card>
    <p className="muted small">Only time HaRM was checking counts: if the HaRM computer was off, that time is left out. History is kept for 30 days.</p>
  </>;
}
