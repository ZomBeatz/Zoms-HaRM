/* Settings for keeping watch: alerts (ntfy, email, webhook) and the new-device watch. */
import { api, GET } from '../api/client';
import { rerender } from '../lib/state';
import { timeAgo, type Row } from '../lib/util';
import { toast } from '../ui/overlay';
import { A } from '../ui/bits';
import { formDialog, type Field } from '../ui/form';

type After = (() => unknown) | null | undefined;

export async function editAlerts(after?: After) {
  let a: Row;
  try { a = await GET('/alerts'); } catch (e) { toast((e as Error).message, 'bad'); return; }
  const kept = (has: unknown) => has ? 'Saved. Leave it empty to keep it.' : null;
  formDialog({
    title: 'Alerts', rec: { ...a, delay: String(a.delay ?? 5) }, saveLabel: 'Save',
    fields: [
      { k: 'enabled', wide: true, label: 'Send alerts', type: 'checkbox' },
      { k: 'delay', label: 'When a device stops answering', type: 'select', required: true, options: [
        { value: '0', label: 'Alert right away' }, { value: '5', label: 'Wait 5 minutes' }, { value: '10', label: 'Wait 10 minutes' },
        { value: '15', label: 'Wait 15 minutes' }, { value: '30', label: 'Wait 30 minutes' }, { value: '60', label: 'Wait an hour' }],
        help: 'Waiting skips short blips, like a restart.' },
      { k: 'recovery', wide: true, label: 'Also tell me when it’s back', type: 'checkbox' },
      { k: 'services', wide: true, label: 'Also when a service stops answering', type: 'checkbox', help: 'A web page or port on a device’s Network tab, while the device itself answers.' },
      { k: 'certs', wide: true, label: 'Also when a certificate runs out soon', type: 'checkbox', help: 'Two weeks before an https service’s certificate runs out, once.' },
      { section: 'Quiet hours' },
      { k: 'quiet_on', wide: true, label: 'Hold alerts during quiet hours', type: 'checkbox', help: 'What happens overnight arrives as one message when quiet hours end.' },
      { k: 'quiet_from', label: 'From', type: 'time', showIf: v => v.quiet_on },
      { k: 'quiet_to', label: 'Until', type: 'time', showIf: v => v.quiet_on },
      { section: 'ntfy (notifications on your phone)' },
      { k: 'ntfy_on', wide: true, label: 'Send by ntfy', type: 'checkbox', help: 'Install the ntfy app and subscribe to a topic name only you know. ntfy.sh is free; you can also run your own server.' },
      { k: 'ntfy_url', label: 'Server and topic', wide: true, inputmode: 'url', ph: 'https://ntfy.sh/a-long-name-only-you-know', showIf: v => v.ntfy_on },
      { k: 'ntfy_token', noGenerate: true, label: 'Access token (optional)', type: 'password', wide: true, showIf: v => v.ntfy_on, help: kept(a.has_ntfy_token) || 'Only for a server or topic that needs one.' },
      { section: 'Email' },
      { k: 'email_on', wide: true, label: 'Send by email', type: 'checkbox' },
      { k: 'email_host', label: 'Mail server', ph: 'smtp.gmail.com', showIf: v => v.email_on },
      { k: 'email_port', label: 'Port', type: 'number', min: 1, ph: '587', showIf: v => v.email_on },
      { k: 'email_security', label: 'Security', type: 'select', required: true, wide: true, showIf: v => v.email_on, options: [
        { value: 'starttls', label: 'STARTTLS (usually port 587)' }, { value: 'ssl', label: 'SSL/TLS (usually port 465)' },
        { value: 'none', label: 'None (port 25, a mail server on your own network only)' }] },
      { k: 'email_username', label: 'Username', raw: true, showIf: v => v.email_on },
      { k: 'email_password', noGenerate: true, label: 'Password', type: 'password', showIf: v => v.email_on,
        help: kept(a.has_email_password) || 'For Gmail and Outlook, make an app password in your account’s security settings.' },
      { k: 'email_from', label: 'From', ph: 'harm@example.com', showIf: v => v.email_on, help: 'Leave empty to use the username.' },
      { k: 'email_to', label: 'Send to', ph: 'you@example.com', showIf: v => v.email_on, help: 'Several addresses: separate them with commas.' },
      { section: 'Webhook' },
      { k: 'webhook_on', wide: true, label: 'Send to a webhook', type: 'checkbox', help: 'Home Assistant, Discord, Slack, Gotify or your own script. HaRM posts JSON with the title and message.' },
      { k: 'webhook_url', noGenerate: true, label: 'Webhook address', type: 'password', wide: true, showIf: v => v.webhook_on,
        help: kept(a.has_webhook_url) || 'Kept secret like a password: anyone with it could post to your channel.' },
    ],
    submit: v => {
      const body: Row = { ...v, delay: +v.delay, email_port: +(v.email_port || 587) };
      for (const k of ['ntfy_token', 'email_password', 'webhook_url']) if (!body[k]) delete body[k];
      return api('POST', '/alerts', body);
    },
    onDone: async r => {
      toast(r.enabled ? 'Alerts are on. Send a test to check they arrive.' : 'Saved');
      (after || rerender)();
    },
  });
}

export async function testAlerts() {
  toast('Sending a test…');
  try {
    const r = await api('POST', '/alerts/test', {});
    const bad = r.results.filter((x: Row) => !x.ok);
    if (!bad.length) toast(`✓ Test sent by ${r.results.map((x: Row) => x.channel).join(' and ')}. Check it arrived.`);
    else toast(bad.map((x: Row) => `${x.channel}: ${x.error}`).join(' · '), 'bad');
  } catch (e) { toast((e as Error).message, 'bad'); }
  rerender();
}

/* Settings for the new-device watch: which networks (leave the guest Wi-Fi out), how often, alerts. */
export async function editNetwatch(after?: After) {
  let nw: Row;
  try { nw = await GET('/netwatch'); } catch (e) { toast((e as Error).message, 'bad'); return; }
  const nets: Row[] = nw.all_networks || [];
  const suggested = (n: Row) => !/guest|iot|wan|vpn|transit|dmz|wi-?fi/i.test(`${n.kind} ${n.name}`);
  const picked = new Set(nw.networks.length || nw.enabled ? nw.networks : nets.filter(n => n.cidr && suggested(n)).map(n => n.id));
  const netFields: Field[] = nets.length ? nets.map(n => ({ k: `net_${n.id}`, type: 'checkbox' as const, wide: true,
    label: `${n.name}${n.vlan_id ? ` · VLAN ${n.vlan_id}` : ''}${n.cidr ? ` · ${n.cidr}` : ' (no address range)'}`,
    help: !n.cidr ? 'Add its address range on its page to watch it.' : !suggested(n) ? 'Guest, IoT and Wi-Fi networks are usually left out: visitors come and go.' : null }))
    : [{ k: '_none', type: 'hidden' }];
  formDialog({
    title: 'Watch for new devices', saveLabel: 'Save',
    rec: { enabled: nw.enabled, interval: String(nw.interval), alert: nw.alert, ...Object.fromEntries(nets.map(n => [`net_${n.id}`, picked.has(n.id)])) },
    fields: [
      { k: 'enabled', label: 'Watch for new devices', type: 'checkbox', wide: true,
        help: 'HaRM scans the networks you tick now and then, and lists any address it doesn’t know. The first scan only learns what’s already there.' },
      { k: 'interval', label: 'Scan', type: 'select', required: true, options: [
        { value: '15', label: 'Every 15 minutes' }, { value: '30', label: 'Every 30 minutes' }, { value: '60', label: 'Every hour' },
        { value: '120', label: 'Every 2 hours' }, { value: '360', label: 'Every 6 hours' }] },
      { k: 'alert', label: 'Send an alert for each new one', type: 'checkbox', wide: true, help: 'Uses the ways set up in Alerts, and their quiet hours.' },
      { section: 'Networks to watch' },
      ...netFields,
    ],
    extra: nets.length ? <p className="muted small">{nw.last_scan ? `Last scan ${timeAgo(nw.last_scan)}.` : ''}{nw.last_error ? <span className="bad-text">{` ${nw.last_error}`}</span> : ''}</p>
      : <p>Add your networks first, with their address ranges: <A href="#/networks">Networks &amp; IPs</A>.</p>,
    submit: v => api('POST', '/netwatch', { enabled: v.enabled, alert: v.alert, interval: +v.interval,
      networks: nets.filter(n => v[`net_${n.id}`]).map(n => n.id) }),
    onDone: async r => {
      toast(r.enabled ? 'Watching. The first scan learns what’s there; new devices after that show on the Status page.' : 'Saved');
      if (r.enabled) api('POST', '/netwatch/scan', {}).catch(() => {});
      (after || rerender)();
    },
  });
}
