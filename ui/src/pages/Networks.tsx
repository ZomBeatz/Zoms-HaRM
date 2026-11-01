/* Networks & IPs: every subnet, and one network's map of addresses. */
import { GET, openDownload } from '../api/client';
import { locPath } from '../lib/lookups';
import type { Row } from '../lib/util';
import { A, Bar, Btn, Card, HelpLink, KV, MenuButton, Mono, PageHead, Small, Table } from '../ui/bits';
import { RowActions, deleteEntity, editEntity } from '../lib/forms';
import { BackLink, Pending, goBackOr, useLoad } from '../app/router';

export function Networks() {
  const q = useLoad(() => GET<Row[]>('/networks'));
  if (!q.data) return <Pending q={q} />;
  const add = () => editEntity('networks', {});
  return <>
    <PageHead title="Networks & IPs" sub="Subnets, VLANs and Wi-Fi networks, and which device has which address.">
      <HelpLink s="networks" /><a className="button" href="#/discover">⌖ Discover</a>
      <MenuButton label="⋯" items={[['⇩ Export CSV', () => openDownload('/api/export/networks.csv')]]} />
      <Btn label="+ Add network" onClick={add} cls="primary" />
    </PageHead>
    {q.data.length ? <Card title="Networks"><Table rows={q.data} onRow={r => { location.hash = `#/networks/${r.id}`; }} cols={[
      { label: 'VLAN', get: r => r.vlan_id ?? '', sort: r => r.vlan_id ?? 99999 },
      { label: 'Name', get: r => <A href={`#/networks/${r.id}`}>{r.name}</A> },
      { label: 'Purpose', get: r => r.kind || '' },
      { label: 'Subnet', get: r => <Mono v={r.cidr} /> },
      { label: 'Gateway', get: r => <Mono v={r.gateway} /> },
      { label: 'DHCP pool', get: r => r.dhcp_start ? <Mono v={`${r.dhcp_start} to ${r.dhcp_end || '?'}`} /> : '' },
      { label: 'DNS / domain', get: r => [r.dns_servers, r.domain].filter(Boolean).join(' · ') },
      { label: 'IPs used', get: r => r.ip_count, sort: r => r.ip_count },
      { label: '', nosort: true, get: r => <RowActions entity="networks" r={r} /> },
    ]} /></Card> : <div className="card onboarding"><h3>No networks yet</h3>
      <p>Add each subnet or VLAN you run, e.g. “Servers · VLAN 10 · 10.0.10.0/24”. Device interfaces with an address in that range link to it automatically, and every network gets an IP map showing conflicts and free addresses.</p>
      <Btn label="+ Add your first network" onClick={add} cls="primary" /></div>}
  </>;
}

export function Network({ id }: { id: number }) {
  const q = useLoad(() => GET(`/networks/${id}/ipmap`));
  if (!q.data) return <Pending q={q} />;
  const d = q.data, n = d.network, st = d.stats, back = q.reload;
  const usage = st.hosts ? <div>
    <Bar pct={(st.used / st.hosts) * 100} cls={st.used / st.hosts > 0.85 ? 'hot' : ''} n={`${st.used}/${st.hosts}`} />
    <KV pairs={[['Usable addresses', st.hosts], ['Recorded in HaRM', st.used], ['DHCP pool size', st.dhcp_size || '']]} />
    {d.next_free.length ? <><h4>Next free static addresses (tap to assign)</h4>
      <div className="chips">{d.next_free.map((ip: string) => <button key={ip} type="button" className="chip mono" onClick={() => editEntity('interfaces', {
        network_id: id, ip, assignment: 'Static', subnet: n.cidr ? '/' + n.cidr.split('/')[1] : null, gateway: n.gateway, dns_servers: n.dns_servers, vlan: n.vlan_id,
      }, back)}>{ip}</button>)}</div></> : null}
  </div> : <div className="empty">Add a subnet (CIDR) to see usage and free addresses.</div>;
  return <>
    <div className="crumbs"><BackLink /><A href="#/networks">Networks &amp; IPs</A>{' › '}{n.name}</div>
    <PageHead title={n.name} sub={[n.kind, n.vlan_id ? `VLAN ${n.vlan_id}` : '', n.cidr].filter(Boolean).join(' · ') || null}>
      <HelpLink s="networks" /><Btn label="Edit" onClick={() => editEntity('networks', n, back)} />
      <MenuButton label="⋯" items={[['🗑 Delete', () => deleteEntity('networks', n, () => goBackOr('#/networks'), 'Interfaces keep their addresses but lose the link to this network.'), 'danger-item']]} />
    </PageHead>
    {d.conflicts.length ? <div className="card alert"><b>⚠ Address conflicts: </b>{d.conflicts.join(', ')} are recorded on more than one interface.</div> : null}
    <div className="grid two">
      <Card title="Details"><KV pairs={[
        ['Subnet', <Mono v={n.cidr} />], ['Gateway', <Mono v={n.gateway} />],
        ['DHCP pool', n.dhcp_start ? <Mono v={`${n.dhcp_start} to ${n.dhcp_end || '?'}`} /> : ''],
        ['DNS servers', <Mono v={n.dns_servers} />], ['Search domain', n.domain], ['IPv6 prefix', <Mono v={n.ipv6_prefix} />],
        ['Wi-Fi SSID', n.ssid], ['Location', n.location_id ? <A href={`#/locations/${n.location_id}`}>{locPath(n.location_id)}</A> : ''],
      ]} /></Card>
      <Card title="Usage">{usage}</Card>
    </div>
    {n.notes ? <Card title="Notes"><div className="notes">{n.notes}</div></Card> : null}
    <Card title="Addresses in use" actions={<Small label="+ Add address" onClick={() => editEntity('interfaces', { network_id: id, assignment: 'Static' }, back)} />}>
      <Table rows={d.entries} empty="No device has an address in this network yet." cols={[
        { label: 'IP', get: r => <span className={'mono' + (r.duplicate ? ' bad-text' : '')}>{r.ip}{r.duplicate ? ' ⚠ duplicate' : ''}</span> },
        { label: 'Device', get: r => <A href={`#/devices/${r.device_id}`}>{r.device_name}</A> },
        { label: 'Interface', get: r => r.name || '' },
        { label: 'Assignment', get: r => <span className="inline">{r.assignment || ''}
          {r.in_dhcp_range && /static/i.test(r.assignment || '') ? <span className="badge warn">inside DHCP pool</span> : null}
          {r.outside ? <span className="badge bad">outside subnet</span> : null}</span> },
        { label: 'MAC', get: r => <Mono v={r.mac} /> },
        { label: 'DNS name', get: r => r.dns_name || '' },
        { label: '', nosort: true, get: r => <RowActions entity="interfaces" r={r} after={back} /> },
      ]} /></Card>
  </>;
}
