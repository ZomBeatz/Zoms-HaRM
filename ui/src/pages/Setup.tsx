/* The setup guide: locations, holders, networks and the first devices, a step at a time. */
import { useState } from 'react';
import { api, loadLookups } from '../api/client';
import { S } from '../lib/state';
import { locPath, rackHasUnits, rackInLocation } from '../lib/lookups';
import { prefDel, prefGet, prefSet, type Row } from '../lib/util';
import { toast } from '../ui/overlay';
import { A, Btn, Card, PageHead, type Kid } from '../ui/bits';
import { FormCtl, QuickForm, type Field, type Vals } from '../ui/form';
import { LABELS, rackPicked } from '../lib/forms';

function WizList<T extends Row>({ rows, fmt, empty }: { rows: T[]; fmt: (r: T) => Kid; empty: string }) {
  return rows.length ? <div className="wiz-list"><h4>{`Added so far (${rows.length})`}</h4><ul className="plain">{rows.map((r, i) => <li key={r.id ?? i}>{fmt(r)}</li>)}</ul></div>
    : <p className="muted small">{empty}</p>;
}

/* A form that adds one record and opens fresh for the next. */
function useQuick(entity: string, fields: Field[], rec: () => Row, onAdded: (r: Row, vals: Vals) => void, label: string) {
  const [n, setN] = useState(0);
  const [ctl, setCtl] = useState(() => new FormCtl(fields, rec()));
  const form = <QuickForm key={n} ctl={ctl} label={label} onSubmit={async vals => {
    const r = await api('POST', `/${entity}`, vals);
    await loadLookups();
    toast(`${LABELS[entity]} added`);
    onAdded(r, vals);
    setCtl(new FormCtl(fields, rec()));
    setN(x => x + 1);
  }} />;
  return { form, ctl };
}

const Box = ({ t, s }: { t: string; s: string }) => <div className="wd-box"><b>{t}</b><span>{s}</span></div>;
const Arrow = ({ c = '→' }: { c?: string }) => <span className="wd-arrow">{c}</span>;

function Welcome() {
  return <>
    <h2>Welcome to HaRM</h2>
    <p>HaRM keeps track of every piece of hardware you own: where it is, what’s inside it, how it’s networked, and how to log in to it. This guide sets up the basics. Skip anything you like and come back later from Help &gt; Setup guide.</p>
    <h4>How things fit together</h4>
    <div className="wiz-diagram"><Box t="Location" s="House > Basement" /><Arrow /><Box t="Holder" s="Rack A · Shelf 2 · a pile" /><Arrow /><Box t="Device" s="truenas, sw-core" /><Arrow /><Box t="Parts" s="drives, RAM, NICs" /></div>
    <div className="wiz-diagram"><Box t="Network" s="Servers · VLAN 10" /><Arrow c="↔" /><Box t="Interface" s="eno1 · 10.0.10.20" /><Arrow c="+" /><Box t="Services & logins" s="TrueNAS UI · admin" /></div>
    <ul>
      <li>Only a name is required anywhere. Fill in more whenever you like.</li>
      <li>Forms never lose your typing. Close one by accident and the changes come back when you reopen it.</li>
      <li>On your phone, <b>+ New &gt; Scan</b> reads serial numbers and part numbers straight off labels.</li>
    </ul>
  </>;
}

function Locations({ redraw }: { redraw: () => void }) {
  const qa = useQuick('locations', [
    { k: 'name', label: 'Name', required: true, ph: 'Basement' },
    { k: 'kind', label: 'Kind', list: 'location_kinds' },
    { k: 'parent_id', label: 'Inside of', type: 'fk', entity: 'locations', none: 'Top level' },
  ], () => ({}), redraw, 'Add location');
  return <>
    <h2>Where is your hardware?</h2>
    <p>Add the places your gear lives. Nest them if that helps: a building, then the rooms inside it. Tap a suggestion to start.</p>
    <div className="chips">{['Home', 'Office', 'Basement', 'Garage', 'Server closet', 'Office desk', 'Storage unit'].map(n => (
      <button key={n} type="button" className="chip" onClick={() => { qa.ctl.set({ name: n }); setTimeout(() => document.querySelector<HTMLInputElement>('.quick-add [data-k="name"] input')?.focus(), 0); }}>{n}</button>
    ))}</div>
    {qa.form}
    <WizList rows={S.lk.locations} fmt={l => <><b>{locPath(l.id)}</b>{l.kind ? ` · ${l.kind}` : ''}</>} empty="Nothing yet." />
  </>;
}

function Holders({ redraw }: { redraw: () => void }) {
  const hasUnits = (v: Vals) => /rack|cabinet/i.test(v.kind || '');
  const qa = useQuick('racks', [
    { k: 'name', label: 'Name', required: true, ph: 'Rack A · Shelf 2 · Pile by the door' },
    { k: 'kind', label: 'Kind', type: 'select', options: S.enums.rack_kinds, required: true, default: 'Rack' },
    { k: 'location_id', label: 'Location', type: 'fk', entity: 'locations' },
    { k: 'height_u', label: 'Height (U)', type: 'number', min: 1, default: 42, showIf: hasUnits, clearWhenHidden: true },
  ], () => ({}), redraw, 'Add holder');
  return <>
    <h2>What holds your hardware?</h2>
    <p>A “holder” is anything gear sits in or on. Pick the kind that matches:</p>
    <dl className="kv">
      <dt>Rack / Cabinet</dt><dd>Has numbered rack units. You get a front and rear rack diagram.</dd>
      <dt>Shelf / Bin / Tote / Drawer</dt><dd>Storage without unit numbers: spare drives in a bin, switches on a shelf.</dd>
      <dt>Pile / Floor</dt><dd>A heap of gear in a corner that you want to keep together as a group.</dd>
    </dl>
    <div className="tip"><b>Gear piled in random rooms? </b>You don’t have to create anything for it. Give the device a Location and leave the holder empty; it shows as <i>loose</i> on that room’s page, with a “Spot” note like “pile by the door”. Make a Pile holder only when you want a specific pile grouped.</div>
    {qa.form}
    <WizList rows={S.lk.racks} fmt={r => <><b>{r.name}</b>{` · ${r.kind}`}{r.location_id ? ` · ${locPath(r.location_id)}` : ''}{r.height_u ? ` · ${r.height_u}U` : ''}</>} empty="Nothing yet. You can skip this if everything is loose." />
  </>;
}

function Networks({ redraw }: { redraw: () => void }) {
  const qa = useQuick('networks', [
    { k: 'name', label: 'Name', required: true, ph: 'Home LAN, Servers, IoT' },
    { k: 'vlan_id', label: 'VLAN ID', type: 'number', min: 1 },
    { k: 'cidr', label: 'Subnet', ph: '192.168.1.0/24', inputmode: 'decimal' },
    { k: 'gateway', label: 'Gateway', ph: '192.168.1.1', inputmode: 'decimal' },
    { k: 'dhcp_start', label: 'DHCP pool start', inputmode: 'decimal' },
    { k: 'dhcp_end', label: 'DHCP pool end', inputmode: 'decimal' },
  ], () => ({}), redraw, 'Add network');
  return <>
    <h2>Your networks (optional)</h2>
    <p>Add each subnet or VLAN. When you later give a device an IP address, HaRM links it to the right network, warns about duplicates, and suggests free addresses. Not sure? Skip this; your router’s settings page lists these.</p>
    {qa.form}
    <WizList rows={S.lk.networks} fmt={n => <><b>{n.name}</b>{n.vlan_id ? ` · VLAN ${n.vlan_id}` : ''}{n.cidr ? ` · ${n.cidr}` : ''}</>} empty="Nothing yet." />
  </>;
}

function Devices({ redraw }: { redraw: () => void }) {
  const qa = useQuick('devices', [
    { k: 'name', label: 'Name', required: true, ph: 'nas-01, old-thinkpad, sw-core' },
    { k: 'device_type', label: 'Type', list: 'device_types' },
    { k: 'location_id', label: 'Location', type: 'fk', entity: 'locations' },
    { k: 'rack_id', label: 'Holder', type: 'fk', entity: 'racks', none: 'None (loose in the room)', scopeBy: ['location_id'], scope: rackInLocation, onChange: rackPicked },
    { k: 'rack_u', label: 'Lowest rack unit (U)', type: 'number', min: 1, showIf: v => rackHasUnits(v.rack_id), clearWhenHidden: true },
    { k: 'u_height', label: 'Height (U)', type: 'number', min: 1, default: 1, showIf: v => rackHasUnits(v.rack_id) },
    { k: 'position', label: 'Spot', ph: 'pile by the door', showIf: v => !rackHasUnits(v.rack_id), clearWhenHidden: true },
    { k: 'serial', label: 'Serial number', scan: true },
    { k: 'connected', label: 'Hooked up (cabled & powered)', type: 'checkbox' },
  ], () => S.wizSticky || {}, (_r, vals) => { S.wizSticky = { location_id: vals.location_id, rack_id: vals.rack_id, device_type: vals.device_type }; redraw(); }, 'Add device');
  return <>
    <h2>Add your devices</h2>
    <p>Quick-add the main things now: servers, switches, the router, the NAS, even the laptop in the closet. Location and holder stay filled in between adds. IPs, logins, drive bays and more go on each device’s own page later.</p>
    {qa.form}
    <WizList rows={S.lk.devices.slice(-15).reverse()} fmt={d => <><A href={`#/devices/${d.id}`}><b>{d.name}</b></A>{d.device_type ? ` · ${d.device_type}` : ''}
      {d.rack_name ? ` · ${d.rack_name}` : (d.location_name ? ` · ${d.location_name} (loose)` : '')}</>} empty="Nothing yet." />
  </>;
}

function Security() {
  const secure = window.isSecureContext;
  return <>
    <h2>Keep it safe, use it anywhere</h2>
    <div className="grid two">
      <Card title="Recovery code"><p>You saw a recovery code when you created your password. It is the only way back in if you forget the password. Store it offline. Lost it? Make a new one in <A href="#/settings">Settings</A>.</p></Card>
      <Card title="Two-factor unlock"><div><p>{S.auth?.totp_enabled ? '2FA is on.' : 'Recommended: require a code from an authenticator app to unlock HaRM.'}</p>
        {S.auth?.totp_enabled ? null : <a className="button primary" href="#/settings">Turn on 2FA in Settings</a>}</div></Card>
      <Card title="Backups"><p>Download a backup from <A href="#/settings">Settings</A> now and then. Logins inside it stay encrypted.</p></Card>
      <Card title="Phone & scanning"><div><p>{secure ? '✓ This connection is HTTPS, so live camera scanning works.' : 'You’re on plain HTTP. Photo scanning works, but live camera scanning needs HTTPS.'}</p>
        <a className="button" href="#/help?s=mobile">How to use HaRM on your phone</a></div></Card>
    </div>
  </>;
}

function Done() {
  const go = (href: string, t: string, s: string) => <a className="tile" href={href}><b>{t}</b><span className="muted small">{s}</span></a>;
  return <>
    <h2>You’re set up 🎉</h2>
    <p>Good next steps:</p>
    <div className="tiles">
      {go('#/devices', 'Fill in device details', 'IPs, services, logins, drive bays')}
      {go('#/components', 'Catalog spare parts', 'Scan drives and RAM; see what fits where')}
      {go('#/racks', 'Check your racks', 'Click empty units to place gear')}
      {go('#/networks', 'Plan IP addresses', 'Free IPs, conflicts, VLANs')}
      {go('#/help', 'Read the guide', 'Every feature, explained')}
    </div>
  </>;
}

const WIZ: { title: string; optional?: boolean; Step: (p: { redraw: () => void }) => React.ReactNode }[] = [
  { title: 'Welcome', Step: Welcome },
  { title: 'Locations', Step: Locations },
  { title: 'Racks, shelves & piles', Step: Holders },
  { title: 'Networks', optional: true, Step: Networks },
  { title: 'Devices', Step: Devices },
  { title: 'Security & phone', Step: Security },
  { title: 'Done', Step: Done },
];

export default function Setup() {
  const [step, setStep] = useState(() => Math.max(0, Math.min(+(prefGet('harm-wiz-step') || 0) || 0, WIZ.length - 1)));
  const [, setN] = useState(0);
  const goto = (n: number) => { prefSet('harm-wiz-step', String(n)); setStep(n); window.scrollTo(0, 0); };
  const last = step === WIZ.length - 1;
  const { Step } = WIZ[step];
  return <>
    <PageHead title="Setup guide" sub={`Step ${step + 1} of ${WIZ.length}: ${WIZ[step].title}`}><a className="button" href="#/help">Full guide</a></PageHead>
    <ol className="wiz-steps">{WIZ.map((w, i) => (
      <li key={i} className={i === step ? 'cur' : (i < step ? 'done' : '')}><button type="button" onClick={() => goto(i)}><span className="n">{i < step ? '✓' : i + 1}</span><span className="t">{w.title}</span></button></li>
    ))}</ol>
    <div className="card wiz-card">
      <div className="wiz-body"><Step key={step} redraw={() => setN(n => n + 1)} /></div>
      <div className="wiz-nav">
        {step > 0 ? <Btn label="← Back" onClick={() => goto(step - 1)} /> : <span />}
        <div className="grow" />
        {last ? <a className="button primary" href="#/dashboard" onClick={() => prefDel('harm-wiz-step')}>Go to dashboard</a>
          : <>{WIZ[step].optional ? <Btn label="Skip" onClick={() => goto(step + 1)} /> : null}
            <Btn label={step === 0 ? 'Let’s start →' : 'Next →'} onClick={() => goto(step + 1)} cls="primary" /></>}
      </div>
    </div>
  </>;
}
