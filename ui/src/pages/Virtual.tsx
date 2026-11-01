/* Virtual & Clusters: every VM and container, the hosts they run on, and clusters. */
import { useState } from 'react';
import { api, GET } from '../api/client';
import { S } from '../lib/state';
import { locPath } from '../lib/lookups';
import { gbText, isVirtual, nz, type Row } from '../lib/util';
import { choose } from '../ui/overlay';
import { A, Badge, Bar, Btn, Card, Dot, HelpLink, MenuButton, PageHead, Table } from '../ui/bits';
import { formDialog } from '../ui/form';
import { Placement, StatusSelect } from '../ui/tables';
import { deleteEntity, editEntity } from '../lib/forms';
import { JournalCard } from '../lib/notes';
import { BackLink, Pending, goBackOr, useLoad } from '../app/router';

function VmTable({ rows, back, showHost = true }: { rows: Row[]; back: () => void; showHost?: boolean }) {
  return <Table rows={rows} empty="No VMs or containers yet." onRow={r => { location.hash = `#/devices/${r.id}`; }} cols={[
    { label: '', get: r => <Dot on={r.status === 'Active'} />, sort: r => r.status, cls: 'narrow' },
    { label: 'Name', get: r => <div><A href={`#/devices/${r.id}`}>{r.name}</A><div className="muted small">{nz(r.device_type, r.vm_id ? `· ID ${r.vm_id}` : '')}</div></div> },
    showHost && { label: 'Host', get: r => r.host_id ? <A href={`#/devices/${r.host_id}`}>{r.host_name}</A> : <span className="warn-text small">not set</span>, sort: r => r.host_name || '' },
    { label: 'vCPU', get: r => r.vcpus ?? '', sort: r => r.vcpus || 0 },
    { label: 'Memory', get: r => gbText(r.vm_ram_gb), sort: r => r.vm_ram_gb || 0 },
    { label: 'Disk', get: r => gbText(r.vm_disk_gb), sort: r => r.vm_disk_gb || 0 },
    { label: 'IP', get: r => <span className="mono">{(r.ips || '').split(', ')[0]}</span> },
    { label: 'Status', get: r => <StatusSelect dev={r} after={back} />, sort: r => r.status },
  ]} />;
}

export function Virtual() {
  const q = useLoad(() => Promise.all([GET<Row[]>('/clusters'), GET<Row[]>('/devices')]));
  const F = S.filters.virtual = S.filters.virtual || {};
  const [needle, setNeedle] = useState<string>(F.q || '');
  if (!q.data) return <Pending q={q} />;
  const [clusters, devices] = q.data;
  const back = q.reload;
  const guests = devices.filter(isVirtual);
  const hosts = devices.filter(d => !isVirtual(d) && (devices.some(g => g.host_id === d.id) || /hypervisor/i.test(d.device_type || '')));
  const on = (h: Row) => guests.filter(g => g.host_id === h.id);
  const running = guests.filter(g => g.status === 'Active').length;
  const n = needle.toLowerCase();
  return <>
    <PageHead title="Virtual & Clusters" sub={`${guests.length} VMs and containers (${running} running) on ${hosts.length} host${hosts.length === 1 ? '' : 's'}`}>
      <HelpLink s="virtual" /><a className="button" href="#/discover">⌖ Import from Proxmox</a>
      <Btn label="+ Cluster" onClick={() => editEntity('clusters', {}, r => { location.hash = `#/clusters/${r.id}`; })} />
      <Btn label="+ VM" onClick={() => editEntity('devices', { device_type: 'Virtual Machine', status: 'Active', connected: true }, r => { location.hash = `#/devices/${r.id}`; })} cls="primary" />
    </PageHead>
    {clusters.length ? <div className="grid">{clusters.map(c => (
      <a key={c.id} className="card cluster-tile" href={`#/clusters/${c.id}`}><div className="cluster-kind">{c.kind || 'Cluster'}</div><h3>{c.name}</h3>
        <div className="muted">{`${c.node_count} node${c.node_count === 1 ? '' : 's'} · ${c.guest_count} guest${c.guest_count === 1 ? '' : 's'}`}</div></a>
    ))}</div> : null}
    {hosts.length ? <Card title="Hosts"><Table rows={hosts} onRow={r => { location.hash = `#/devices/${r.id}`; }} cols={[
      { label: 'Host', get: r => <A href={`#/devices/${r.id}`}>{r.name}</A> },
      { label: 'Cluster', get: r => r.cluster_id ? <A href={`#/clusters/${r.cluster_id}`}>{r.cluster_name}</A> : '' },
      { label: 'Guests', get: r => on(r).length, sort: r => on(r).length },
      { label: 'vCPU allocated', get: r => on(r).reduce((a, g) => a + (g.vcpus || 0), 0) },
      { label: 'Memory allocated', get: r => gbText(on(r).reduce((a, g) => a + (g.vm_ram_gb || 0), 0)) },
      { label: 'Status', get: r => <Badge status={r.status} /> },
    ]} /></Card> : null}
    <Card title="VMs & containers"><div>
      <div className="toolbar"><input type="search" placeholder="Filter VMs…" value={needle} onChange={e => { F.q = e.target.value; setNeedle(e.target.value); }} /></div>
      <VmTable rows={guests.filter(g => !n || [g.name, g.host_name, g.vm_id, g.ips, g.os].some(x => x && String(x).toLowerCase().includes(n)))} back={back} />
    </div></Card>
    {!guests.length && !clusters.length ? <div className="card onboarding"><h3>Track your virtual machines</h3>
      <p>Add each VM or container as a device that <b>runs on</b> a host, with its ID, vCPUs, memory and disk. Hosts then show what’s running on them and how much of their CPU and memory is claimed. Group hosts into a <b>cluster</b> (Proxmox, Kubernetes, vSphere…) to see everything together.</p>
      <p>Running Proxmox? <A href="#/discover">Discover &gt; Proxmox</A> imports the cluster, its nodes and every VM and container in one go.</p></div> : null}
  </>;
}

export function Cluster({ id }: { id: number }) {
  const q = useLoad(() => GET(`/clusters/${id}/full`));
  if (!q.data) return <Pending q={q} />;
  const d = q.data, c = d.cluster, back = q.reload;
  const cap = d.capacity, used = d.allocated;
  const meter = (label: string, u: number, total: number, unit: string) => {
    const pct = total ? Math.round((u / total) * 100) : 0;
    return <Bar label={label} pct={pct} cls={pct > 100 ? 'hot' : ''} n={total ? `${u}${unit} / ${total}${unit}` : `${u}${unit} allocated`} />;
  };
  const addNode = async () => {
    const k = await choose('Add a node', 'Pick an existing device or add a new one.', [['existing', 'Existing device'], ['new', 'New device', 'primary']]);
    if (k === 'new') editEntity('devices', { device_type: 'Hypervisor Host', status: 'Active', cluster_id: id }, back);
    if (k === 'existing') {
      const opts = S.lk.devices.filter(x => !x.host_id && x.cluster_id !== id);
      formDialog({ title: `Add a node to ${c.name}`, fields: [{ k: 'device_id', label: 'Device', type: 'select', required: true, options: opts.map(x => ({ value: x.id, label: x.name })) }],
        submit: v => api('PUT', `/devices/${v.device_id}`, { cluster_id: id }), onDone: back });
    }
  };
  const stat = (n: React.ReactNode, l: string) => <div className="stat"><div className="stat-n">{n}</div><div className="stat-l">{l}</div></div>;
  return <>
    <div className="crumbs"><BackLink /><A href="#/virtual">Virtual &amp; Clusters</A>{' › '}{c.name}</div>
    <PageHead title={c.name} sub={nz(c.kind, c.location_name ? `· ${c.location_name}` : '') || null}>
      <Btn label="+ Add node" onClick={addNode} />
      <Btn label="Edit" onClick={() => editEntity('clusters', c, back)} />
      <MenuButton label="⋯" items={[['🗑 Delete cluster', () => deleteEntity('clusters', c, () => goBackOr('#/virtual'), 'Its hosts and VMs stay; they just leave the cluster.'), 'danger-item']]} />
    </PageHead>
    <div className="stats">
      {stat(d.nodes.length, 'Nodes')}
      {stat(d.guests.length, `VMs & containers · ${d.guests.filter((g: Row) => g.status === 'Active').length} running`)}
      {cap.cores ? stat(cap.cores, `Cores · ${cap.threads} threads`) : null}
      {cap.ram_gb ? stat(gbText(cap.ram_gb), 'Memory') : null}
    </div>
    <Card title="Resources claimed by guests"><div className="bars">
      {meter('CPU', used.vcpus, cap.threads, ' vCPU')}{meter('Memory', +used.ram_gb.toFixed(1), +cap.ram_gb.toFixed(1), ' GB')}
      {meter('Disk', +used.disk_gb.toFixed(0), +cap.storage_gb.toFixed(0), ' GB')}
    </div></Card>
    <Card title="Nodes"><Table rows={d.nodes} empty="No nodes yet. Add the hosts that make up this cluster." onRow={r => { location.hash = `#/devices/${r.id}`; }} cols={[
      { label: '', get: r => <Dot on={r.connected} />, cls: 'narrow' },
      { label: 'Node', get: r => <A href={`#/devices/${r.id}`}>{r.name}</A> },
      { label: 'Guests', get: r => d.guests.filter((g: Row) => g.host_id === r.id).length },
      { label: 'IP', get: r => <span className="mono">{(r.ips || '').split(', ')[0]}</span> },
      { label: 'Where', get: r => r.rack_id ? <Placement d={r} /> : (r.location_id ? locPath(r.location_id) : '') },
      { label: 'Status', get: r => <StatusSelect dev={r} after={back} />, sort: r => r.status },
    ]} /></Card>
    <Card title="VMs & containers"><VmTable rows={d.guests} back={back} /></Card>
    <JournalCard entity="clusters" entityId={id} notes={d.notes} after={back} />
  </>;
}
