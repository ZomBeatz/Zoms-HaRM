/* Tables that several pages share: logins, cables, network interfaces, where things are. */
import { api, loadLookups } from '../api/client';
import { S, rerender } from '../lib/state';
import { locPath } from '../lib/lookups';
import { badgeClass as badgeCls, fmtDay, nz, type Row } from '../lib/util';
import { copy, toast } from './overlay';
import { A, ExtLink, Mono, Small, Table } from './bits';
import { RowActions, deleteEntity, editCredential } from '../lib/forms';
import { revealCredential } from '../dialogs/credential';

type After = (() => unknown) | null | undefined;

export function CredTable({ rows, after }: { rows: Row[]; after?: After }) {
  return <Table rows={rows} empty="No logins stored." cols={[
    { label: 'Label', get: r => <a href="#" onClick={e => { e.preventDefault(); revealCredential(r); }}>{r.label}</a> },
    { label: 'Kind', get: r => r.kind || '' },
    { label: 'Username', get: r => r.username ? <span className="inline"><code>{r.username}</code><Small label="Copy" onClick={() => copy(r.username, 'Username')} /></span> : '' },
    { label: 'Device', get: r => r.device_id ? <A href={`#/devices/${r.device_id}`}>{r.device_name}</A> : '' },
    { label: 'URL', get: r => <ExtLink url={r.url} /> },
    { label: '2FA', get: r => r.has_totp ? '✓' : '' },
    { label: 'Rotated', get: r => fmtDay(r.last_rotated) },
    { label: '', nosort: true, get: r => (
      <div className="row-actions">
        <Small label="Open ↗" onClick={() => revealCredential(r)} cls="primary" />
        {r.has_password ? <Small label="Copy pw" onClick={async () => {
          try { const s = await api('POST', `/credentials/${r.id}/reveal`); copy(s.password, 'Password'); } catch (e) { toast((e as Error).message, 'bad'); }
        }} /> : null}
        <Small label="Edit" onClick={() => editCredential(r, after)} />
        <Small label="Delete" onClick={() => deleteEntity('credentials', r, after)} cls="ghost-danger" />
      </div>
    ) },
  ]} />;
}

export function ConnTable({ rows, after, perspective }: { rows: Row[]; after?: After; perspective?: number }) {
  const flip = (r: Row) => perspective && r.b_device_id === perspective && r.a_device_id !== perspective;
  return <Table rows={rows} empty="No cables recorded." cols={[
    { label: 'From', get: r => flip(r) ? <span>{r.b_port || 'None'}</span>
      : <span>{perspective ? '' : <A href={`#/devices/${r.a_device_id}`}>{r.a_device_name}</A>}{perspective ? '' : ' : '}{r.a_port || 'None'}</span> },
    { label: 'To', get: r => flip(r) ? <span><A href={`#/devices/${r.a_device_id}`}>{r.a_device_name}</A>{' : '}{r.a_port || 'None'}</span>
      : r.b_device_id ? <span><A href={`#/devices/${r.b_device_id}`}>{r.b_device_name}</A>{' : '}{r.b_port || 'None'}</span> : <span className="muted">{r.b_endpoint || ''}</span> },
    { label: 'Medium', get: r => r.medium || '' },
    { label: 'Speed', get: r => r.speed || '' },
    { label: 'Label', get: r => r.cable_label || '' },
    { label: 'Length', get: r => r.length || '' },
    { label: 'Color', get: r => r.color || '' },
    { label: '', nosort: true, get: r => <RowActions entity="connections" r={r} after={after} /> },
  ]} />;
}

export function IfaceTable({ rows, after }: { rows: Row[]; after?: After }) {
  return <Table rows={rows} empty="No interfaces recorded." cols={[
    { label: 'Name', get: r => <span><b>{r.name || 'None'}</b>{r.is_primary ? <span className="ip-star" title="Main address"> ★</span> : null}
      {r.kind ? <div className="muted small">{r.kind}</div> : null}</span> },
    { label: 'Network', get: r => r.network_id ? <A href={`#/networks/${r.network_id}`}>{r.network_name + (r.network_vlan ? ` · VLAN ${r.network_vlan}` : '')}</A> : '' },
    { label: 'Address', get: r => <div>
      {r.ip ? <Mono v={r.ip + (r.subnet && String(r.subnet).startsWith('/') ? r.subnet : '')} /> : null}
      {r.ipv6 ? <div className="mono small muted">{r.ipv6}</div> : null}
      {r.assignment ? <div><span className="badge muted">{r.assignment}</span></div> : null}</div> },
    { label: 'MAC', get: r => <Mono v={r.mac} /> },
    { label: 'VLANs', get: r => /trunk|hybrid/i.test(r.port_mode || '')
      ? `${r.port_mode}: native ${r.native_vlan || 'None'}, tagged ${r.tagged_vlans || 'None'}`
      : nz(r.port_mode, r.vlan ? `VLAN ${r.vlan}` : '') },
    { label: 'Link', get: r => [r.speed, r.mtu ? `MTU ${r.mtu}` : '', r.poe && r.poe !== 'None' ? r.poe : '', r.link_state, r.parent ? `in ${r.parent}` : ''].filter(Boolean).join(' · ') },
    { label: 'DNS / SSID', get: r => [r.dns_name, r.wifi_ssid ? `SSID ${r.wifi_ssid}` : ''].filter(Boolean).join(' · ') },
    { label: '', nosort: true, get: r => <RowActions entity="interfaces" r={r} after={after} /> },
  ]} />;
}

/* Where a device is in its rack: "Rack A · U12-13 (rear)". */
export function Placement({ d }: { d: Row }) {
  if (!d.rack_id) return <>{d.position || ''}</>;
  const where = d.rack_u ? ` · U${d.rack_u}${d.u_height > 1 ? '-' + (d.rack_u + d.u_height - 1) : ''}${d.rack_face === 'rear' ? ' (rear)' : ''}` : (d.position ? ` · ${d.position}` : '');
  return <span><A href={`#/racks/${d.rack_id}`}>{d.rack_name}</A>{where}</span>;
}

export function CompWhere({ r }: { r: Row }) {
  if (r.device_id) return <span>in <A href={`#/devices/${r.device_id}`}>{r.device_name}</A></span>;
  if (r.rack_id) return <span><A href={`#/racks/${r.rack_id}`}>{r.rack_name}</A>{r.position ? ` · ${r.position}` : ''}</span>;
  return <>{nz(r.location_id ? locPath(r.location_id) : '', r.position)}</>;
}

/* One-tap status change for a device. */
export function StatusSelect({ dev, after }: { dev: Row; after?: After }) {
  return (
    <select className={`status-pill ${badgeCls(dev.status)}`} aria-label={`Status of ${dev.name}`} value={dev.status || ''}
      onClick={e => e.stopPropagation()}
      onChange={async e => {
        const v = e.target.value;
        try {
          await api('PUT', `/devices/${dev.id}`, { status: v });
          toast(`${dev.name}: ${v}`);
          await loadLookups();
          (after || rerender)();
        } catch (x) { toast((x as Error).message, 'bad'); }
      }}>
      {S.enums.device_statuses.map(st => <option key={st} value={st}>{st}</option>)}
    </select>
  );
}
