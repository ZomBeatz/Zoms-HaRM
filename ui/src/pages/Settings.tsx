/* Settings: how HaRM looks, locks, connects and keeps your data. */
import { useEffect, useState } from 'react';
import { api, GET } from '../api/client';
import { S, rerender, useApp } from '../lib/state';
import { FMT, deviceWord, hasKeyboard, money, timeAgo, type Row } from '../lib/util';
import { alertChime, look, setLook, type Look } from '../lib/look';
import { copy, toast } from '../ui/overlay';
import { A, Badge, Btn, Card, KV, PageHead, Small, type Kid } from '../ui/bits';
import { formDialog } from '../ui/form';
import { editAlerts, editNetwatch, testAlerts } from '../dialogs/watch';
import { AiSettingsCard } from '../dialogs/ai';
import { installApp, phoneAppHelp } from '../dialogs/phone';
import { showRecoveryCode } from '../app/Auth';
import { lockNow } from '../app/session';
import { MODES, THEMES, applyTheme, themePrefs, themeUnlocked } from '../app/theme';
import { Pending, useLoad } from '../app/router';
import { ShortcutsList } from './Help';
import { asset } from '../lib/util';

function AppearanceCard() {
  const [, redraw] = useState(0);
  useApp(s => s.lkTick);
  const p = themePrefs();
  const scheme = document.documentElement.dataset.theme || 'dark';
  return (
    <Card title="Appearance"><div>
      <div className="theme-picks">{Object.entries(THEMES).filter(([k]) => themeUnlocked(k)).map(([k, t]) => (
        <button key={k} type="button" className={'theme-pick' + (p.theme === k ? ' on' : '')} onClick={() => { applyTheme(k); redraw(n => n + 1); }}>
          <img src={asset(t.icon)} alt="" /><span><b>{t.name}</b><small>{t.blurb}</small>
            <span className="swatches">{t.swatches[scheme].map(c => <i key={c} style={{ background: c }} />)}</span></span>
        </button>
      ))}</div>
      <div className="chips">{MODES.map(([k, l]) => <button key={k} type="button" className={'chip' + (p.mode === k ? ' on' : '')} onClick={() => { applyTheme(null, k); redraw(n => n + 1); }}>{l}</button>)}</div>
      <p className="muted small">{`Saved on this ${deviceWord()} only, so your phone and computer can each have their own. Match my ${deviceWord()} follows its light or dark setting.`}</p>
    </div></Card>
  );
}

/* A row of choices shown as chips (like Light / Dark). */
function Choice<T extends string>({ label, value, options, onPick, help }: { label: string; value: T; options: [T, string][]; onPick: (v: T) => void; help?: Kid }) {
  return <div className="setting-row"><span className="setting-label">{label}</span>
    <div className="chips">{options.map(([k, l]) => <button key={k} type="button" className={'chip' + (value === k ? ' on' : '')} onClick={() => onPick(k)}>{l}</button>)}</div>
    {help ? <small className="muted">{help}</small> : null}</div>;
}

/* Settings > Appearance > Reading and comfort: saved on this device, like the theme. */
function ComfortCard() {
  const [l, setL] = useState(look);
  const pick = (c: Partial<Look>) => { setLook(c); setL(look()); rerender(); };
  return (
    <Card title="Reading and comfort"><div>
      <Choice label="Text size" value={l.text} options={[['normal', 'Normal'], ['large', 'Large'], ['larger', 'Larger']]} onPick={v => pick({ text: v })} />
      <Choice label="Spacing" value={l.density} options={[['comfy', 'Comfortable'], ['compact', 'Compact']]} onPick={v => pick({ density: v })}
        help="Compact fits more rows of a table on the screen." />
      <Choice label="Dates" value={l.dates} onPick={v => pick({ dates: v })}
        options={[['iso', '2026-11-20'], ['local', new Date(2026, 10, 20).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })],
          ['dmy', '20/11/2026'], ['mdy', '11/20/2026']]} />
      <Choice label="Clock" value={l.clock} options={[['auto', 'Like my ' + deviceWord()], ['12', '1:30 PM'], ['24', '13:30']]} onPick={v => pick({ clock: v })} />
      <Choice label="Lengths" value={l.length} options={[['mm', 'Millimetres'], ['in', 'Inches']]} onPick={v => pick({ length: v })}
        help="Rack depth and PC part sizes. Fan and radiator sizes stay in mm." />
      <Choice label="Motion" value={l.motion} options={[['auto', 'Like my ' + deviceWord()], ['reduce', 'Less motion']]} onPick={v => { pick({ motion: v }); applyTheme(); }}
        help="Less motion stops animated logos and fades." />
      <label className="check"><input type="checkbox" checked={l.sound} onChange={e => { pick({ sound: e.target.checked }); if (e.target.checked) alertChime(); }} />
        <span>Sound when something goes offline</span></label>
      <p className="muted small">{`While the Status page is open. On phones it buzzes too. These are saved on this ${deviceWord()} only.`}</p>
    </div></Card>
  );
}

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'JPY', 'CNY', 'INR', 'SGD', 'HKD', 'BRL', 'MXN', 'ZAR'];
const START_PAGES: [string, string][] = [['dashboard', 'Home'], ['status', 'Status'], ['devices', 'Devices'], ['tasks', 'Tasks & notes'], ['racks', 'Racks & storage'], ['last', 'Where I left off']];

/* Settings for everyone, on every device: currency and the first page. */
function EveryoneCard({ app, save }: { app: Row; save: (c: Row) => Promise<void> }) {
  const name = (c: string) => { try { return new Intl.DisplayNames(undefined, { type: 'currency' }).of(c); } catch { return c; } };
  const list = CURRENCIES.includes(app.currency) ? CURRENCIES : [app.currency, ...CURRENCIES];
  return (
    <Card title="On every device"><div>
      <label className="disc-field"><span>Currency</span>
        <select aria-label="Currency" value={app.currency} onChange={e => save({ currency: e.target.value })}>
          {list.map(c => <option key={c} value={c}>{`${c} · ${name(c)}`}</option>)}</select>
        <small className="muted">{`Prices and values show as ${money(1234.5)}. Amounts already saved aren’t converted.`}</small></label>
      <label className="disc-field"><span>Start on</span>
        <select aria-label="Start page" value={app.start_page} onChange={e => save({ start_page: e.target.value })}>
          {START_PAGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <small className="muted">The page HaRM opens on. A wall display might start on Status.</small></label>
    </div></Card>
  );
}

const IDLE: [number, string][] = [[5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [120, '2 hours'],
  [240, '4 hours'], [480, '8 hours'], [0, 'Only when I lock it']];
const SESSION: [number, string][] = [[4, '4 hours'], [8, '8 hours'], [12, '12 hours'], [24, '1 day'], [72, '3 days'], [168, '1 week']];

/* The settings page's filter box: hides cards that don't mention what's typed. */
function useSettingsFilter(text: string) {
  useEffect(() => {
    const t = text.trim().toLowerCase();
    const view = document.getElementById('view');
    if (!view) return;
    for (const card of view.querySelectorAll<HTMLElement>('.settings-groups .card')) card.hidden = !!t && !card.innerText.toLowerCase().includes(t);
    for (const h of view.querySelectorAll<HTMLElement>('.settings-groups h2.settings-group')) {
      const grid = h.nextElementSibling as HTMLElement | null;
      const any = !!grid && [...grid.querySelectorAll<HTMLElement>('.card')].some(c => !c.hidden);
      h.hidden = !!t && !any && !h.innerText.toLowerCase().includes(t);
      if (grid) grid.hidden = h.hidden;
      if (t && h.innerText.toLowerCase().includes(t) && grid) grid.querySelectorAll<HTMLElement>('.card').forEach(c => { c.hidden = false; });
    }
  });
}

function Group({ title, children }: { title: string; children: Kid }) {
  return <><h2 className="settings-group">{title}</h2><div className="grid two">{children}</div></>;
}

/* Settings > About: an opt-in check for a newer release on GitHub. */
function UpdateCheckRow({ app, save }: { app: Row; save: (c: Row) => Promise<void> }) {
  const [out, setOut] = useState<Kid>('');
  useEffect(() => {
    setOut('');
    if (!app.update_check) return;
    GET('/update-check').then(u => {
      if (u.error) setOut(u.error + '.');
      else if (u.newer) setOut(<><b>{`Version ${u.latest} is out. `}</b><a href={u.url} target="_blank" rel="noopener">What’s new and download ↗</a></>);
      else if (u.latest) setOut('You have the newest version.');
    }).catch(() => { /* offline: say nothing */ });
  }, [app.update_check]);
  return <div>
    <label className="check"><input type="checkbox" checked={!!app.update_check} onChange={e => save({ update_check: e.target.checked })} /><span>Check for new versions</span></label>
    <p className="muted small">Asks GitHub about twice a day. Nothing else is sent. <span className="muted small">{out}</span></p>
  </div>;
}

/* An email to ZomBeatz Media with the version and device filled in. */
function sendFeedback() {
  const ua = navigator.userAgent;
  const system = /Android/.test(ua) ? 'Android' : /iPhone/.test(ua) ? 'iPhone' : deviceWord() === 'tablet' && /Mac|iPad/.test(ua) ? 'iPad'
    : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'an unknown system';
  const v = S.auth?.release || '';
  const body = ['What happened, or what would you like?', '', '', 'Steps, if something went wrong:', '1. ', '', '---',
    `Zom's HaRM ${v}, a browser on ${system} (this ${deviceWord()}).`].join('\n');
  location.href = `mailto:info@zombeatzmedia.com?subject=${encodeURIComponent(`Zom's HaRM feedback (${v})`)}&body=${encodeURIComponent(body)}`;
}

const ENTS = ['devices', 'components', 'racks', 'locations', 'networks', 'interfaces', 'services', 'connections', 'device_slots', 'credentials'];

export default function Settings() {
  const [find, setFind] = useState('');
  useSettingsFilter(find);
  const q = useLoad(async () => {
    const [auth, caps, app, alerts, netwatch, backupCopy] = await Promise.all([api('GET', '/auth/status'), GET('/meta/capabilities'),
      GET('/settings/app').catch(() => ({})), GET('/alerts').catch(() => ({})), GET('/netwatch').catch(() => ({})), GET('/backup-copy').catch(() => ({}))]);
    S.auth = auth; S.caps = caps;
    FMT.currency = caps.currency || 'USD';
    return { auth, caps, app, alerts, netwatch, backupCopy };
  });
  const installPrompt = useApp(s => s.installPrompt);
  if (!q.data) return <Pending q={q} />;
  const { auth, caps, app, alerts: a, netwatch: n, backupCopy: c } = q.data;
  const back = q.reload;
  const saveApp = async (changes: Row) => {
    try { await api('POST', '/settings/app', changes); toast('Saved'); back(); } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const setUp2fa = async () => {
    const t = await api('POST', '/auth/totp/begin');
    formDialog({
      title: 'Set up 2FA', saveLabel: 'Turn on',
      top: <div className="field wide">
        <p>Add this key to your authenticator app (choose “enter a setup key”, time-based):</p>
        <div className="recovery"><code>{t.secret.match(/.{1,4}/g).join(' ')}</code><Small label="Copy" onClick={() => copy(t.secret, 'Key')} /></div>
        <details><summary>otpauth:// link</summary><code className="wrap small">{t.uri}</code></details>
      </div>,
      fields: [{ k: 'code', label: 'Enter the 6-digit code from your app', required: true }],
      submit: v => api('POST', '/auth/totp/enable', v),
      onDone: () => { toast('2FA is on'); back(); },
    });
  };
  const ways = [a.ntfy_on && 'ntfy', a.email_on && 'email', a.webhook_on && 'a webhook'].filter(Boolean);
  const wait = !a.delay ? 'right away' : `after ${a.delay} minutes`;
  const recent: Row[] = (a.recent || []).slice(0, 5);
  const netNames = (n.all_networks || []).filter((x: Row) => (n.networks || []).includes(x.id)).map((x: Row) => x.name);
  const cur = app?.status_interval ?? 5;
  return <>
    <PageHead title="Settings" sub="How HaRM looks, locks, connects and keeps your data.">
      <input type="search" className="settings-find" placeholder="Find a setting…" aria-label="Find a setting" value={find} onChange={e => setFind(e.target.value)} />
    </PageHead>
    <div className="settings-groups">
    <Group title="Appearance"><AppearanceCard /><ComfortCard /><EveryoneCard app={app} save={saveApp} /></Group>
    <Group title="Locking and security">
      <Card title="Locking"><div>
        <p>{`${app.idle_minutes ? `Locked after ${IDLE.find(([m]) => m === app.idle_minutes)?.[1] ?? `${app.idle_minutes} minutes`} without use` : 'Locked when you lock it'}, after ${SESSION.find(([h]) => h === app.session_hours)?.[1] ?? `${app.session_hours} hours`} in any case, and whenever the HaRM server restarts. Unlocking needs your master password${auth.totp_enabled ? ' and a 2FA code' : ''}.`}</p>
        <div className="inline">
          <label className="disc-field"><span>Lock when not used for</span>
            <select aria-label="Lock when not used for" value={app.idle_minutes} onChange={e => saveApp({ idle_minutes: +e.target.value })}>
              {IDLE.map(([m, l]) => <option key={m} value={m}>{l}</option>)}</select></label>
          <label className="disc-field"><span>Sign in again after</span>
            <select aria-label="Sign in again after" value={app.session_hours} onChange={e => saveApp({ session_hours: +e.target.value })}>
              {SESSION.map(([h, l]) => <option key={h} value={h}>{l}</option>)}</select></label>
        </div>
        <Btn label="🔒 Lock now" onClick={lockNow} />
      </div></Card>
      <Card title="Master password"><div>
        <p>Unlocks HaRM and the saved logins inside it. Changing it keeps every saved login.</p>
        <Btn label="Change password…" onClick={() => formDialog({
          title: 'Change master password',
          fields: [
            { k: 'current_password', label: 'Current password', type: 'password', required: true },
            { k: 'new_password', label: 'New password (10+ characters)', type: 'password', required: true },
            { k: 'confirm', label: 'Confirm new password', type: 'password', required: true },
          ],
          submit: v => {
            if (v.new_password !== v.confirm) throw new Error('The two new passwords don’t match.');
            return api('POST', '/auth/change-password', { current_password: v.current_password, new_password: v.new_password });
          },
          onDone: () => toast('Password changed'),
        })} />
      </div></Card>
      <Card title="Two-factor authentication">{auth.totp_enabled ? <div>
        <p><Badge status="Active" /> Unlocking requires a code from your authenticator app.</p>
        <Btn label="Turn off 2FA" cls="ghost-danger" onClick={() => formDialog({
          title: 'Turn off 2FA', fields: [{ k: 'password', label: 'Master password', type: 'password' }], saveLabel: 'Turn off',
          submit: v => api('POST', '/auth/totp/disable', v), onDone: () => { toast('2FA turned off'); back(); },
        })} />
      </div> : <div>
        <p>Add a second factor (any TOTP app: Aegis, 2FAS, Bitwarden, 1Password, Google Authenticator).</p>
        <Btn label="Set up 2FA" onClick={setUp2fa} cls="primary" />
      </div>}</Card>
      <Card title="Recovery code"><div>
        <p>Unlocks HaRM if you forget the master password. Without your password or recovery code, saved logins can’t be recovered.</p>
        <Btn label="New recovery code…" onClick={() => formDialog({
          title: 'New recovery code', fields: [{ k: 'password', label: 'Master password', type: 'password', required: true }], saveLabel: 'Make a new code',
          submit: v => api('POST', '/auth/recovery-code', v), onDone: r => showRecoveryCode(r.recovery_code),
        })} />
        <p className="muted small">The old code stops working as soon as you make a new one.</p>
      </div></Card>
    </Group>
    <Group title="Phones & tablets">
      <Card title="Phone app"><div>
        <p>Put HaRM on your phone’s home screen so it opens like an app, with shortcuts for scanning, devices and tasks. Both need to be on the same Wi‑Fi.</p>
        <div className="inline"><Btn label="How to connect a phone…" onClick={phoneAppHelp} cls="primary" />
          <button type="button" className="install-btn" hidden={!installPrompt} onClick={installApp}>⤓ Install on this device</button>
          {caps.ca_cert ? <a className="button" href="/harm-ca.crt" download="harm-ca.crt">⬇ Certificate</a> : null}</div>
      </div></Card>
      <Card title="Camera and scanning"><div>
        <KV pairs={[
          ['This connection', window.isSecureContext ? <span className="ok-text">✓ Secure (HTTPS or this computer)</span> : <span className="warn-text">Plain HTTP</span>],
          ['Live camera scanning', window.isSecureContext && !!navigator.mediaDevices && 'getUserMedia' in navigator.mediaDevices ? 'Available' : 'Needs HTTPS'],
          ['Photo scanning', 'Available'],
          ['Text recognition (server)', caps.ocr ? 'Available' : <span className="warn-text">Not installed (install tesseract)</span>],
          ['Barcode reader (server)', caps.barcodes ? 'Available' : 'Not installed (the phone reads barcodes itself)'],
          ['Address', <span className="mono">{location.origin}</span>],
        ]} />
        <p><a className="button" href="#/help?s=mobile">How scanning works</a></p>
      </div></Card>
    </Group>
    <Group title="Status and actions">
      <Card title="Online checks"><div>
        <p>HaRM checks whether each hooked-up device answers on its addresses, and shows it on the <A href="#/status">Status</A> page.</p>
        <label className="disc-field"><span>Check</span><select aria-label="Check every" value={cur} onChange={e => saveApp({ status_interval: +e.target.value })}>
          {[[1, 'Every minute'], [2, 'Every 2 minutes'], [5, 'Every 5 minutes'], [10, 'Every 10 minutes'], [15, 'Every 15 minutes'],
            [30, 'Every 30 minutes'], [60, 'Every hour'], [0, 'Never (only when I press Check now)']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <p className="muted small">Only the addresses you’ve recorded are contacted. Turn it off for one device with “Check if it’s online” when you edit it.</p>
      </div></Card>
      <Card title="Alerts"><div>
        {a.enabled && ways.length
          ? <p><span className="badge ok">On</span>{` By ${ways.join(' and ')}, ${wait} when a device${a.services ? ' or service' : ''} stops answering${a.recovery ? ', and when it’s back' : ''}.`}</p>
          : <p><span className="badge muted">Off</span> Get a message on your phone (ntfy), by email or by webhook when a device or service stops answering.</p>}
        {a.enabled && a.quiet_on ? <p className="muted small">{`Quiet from ${a.quiet_from} to ${a.quiet_to}: alerts are held and sent together after.`}</p> : null}
        <div className="inline"><Btn label="🔔 Set up alerts…" onClick={() => editAlerts(back)} cls="primary" />{ways.length ? <Btn label="Send a test" onClick={testAlerts} /> : null}</div>
        {recent.length ? <ul className="plain alert-log">{recent.map((r, i) => (
          <li key={i} className="small"><span className={r.ok ? 'ok-text' : 'bad-text'}>{r.ok ? '✓ ' : '✗ '}</span><b>{r.channel}</b>{` · ${r.title} · `}
            <span className="muted">{timeAgo(r.at)}</span>{r.error ? <div className="bad-text">{r.error}</div> : null}</li>
        ))}</ul> : null}
        <p className="muted small">Alerts are sent while HaRM is locked too, so their passwords are kept encrypted with a key of their own (alerts.key in HaRM’s data folder), not with your master password.</p>
      </div></Card>
      <Card title="New devices on the network"><div>
        {n.enabled ? <p><span className="badge ok">On</span>{` Watching ${netNames.join(', ')} every ${n.interval >= 60 ? `${n.interval / 60} hour${n.interval > 60 ? 's' : ''}` : `${n.interval} minutes`}.`}
          {n.last_scan ? <span className="muted small">{` Last scan ${timeAgo(n.last_scan)}.`}</span> : null}</p>
          : <p><span className="badge muted">Off</span> Scan the networks you pick now and then, and list (or alert about) any device HaRM doesn’t know. Leave the guest Wi-Fi out.</p>}
        {n.last_error ? <p className="bad-text small">{n.last_error}</p> : null}
        {(n.pending || []).length ? <p><A href="#/status">{`${n.pending.length} new device${n.pending.length === 1 ? '' : 's'} to look at`}</A></p> : null}
        <div className="inline"><Btn label="📶 Watch for new devices…" onClick={() => editNetwatch(back)} cls="primary" />
          {n.enabled ? <Btn label="Scan now" onClick={async () => {
            toast('Scanning…');
            try { const r = await api('POST', '/netwatch/scan', {}); toast(r.baseline ? 'First scan done: HaRM learned what’s there.' : r.new.length ? `${r.new.length} new device${r.new.length === 1 ? '' : 's'} found` : 'Nothing new'); }
            catch (e) { toast((e as Error).message, 'bad'); }
            back();
          }} /> : null}</div>
      </div></Card>
      <Card title="Actions"><div>
        <p>Saved commands HaRM sends to your devices over SSH with one click. They use the logins in your Vault, so they only run while HaRM is unlocked.</p>
        <a className="button" href="#/actions">⚡ Actions</a>
      </div></Card>
    </Group>
    <Group title="AI Assist">
      <Card title="AI features"><div>
        <p>{app.ai_enabled
          ? 'On: 🤖 AI Assist turns photos of your hardware into inventory, with any AI app or a service you pick below.'
          : 'Off: HaRM shows no AI buttons, and the server refuses AI requests. Your saved AI settings are kept for if you turn it back on.'}</p>
        <label className="check"><input type="checkbox" checked={app.ai_enabled !== false} onChange={async e => {
          const on = e.target.checked;
          try {
            await api('POST', '/settings/app', { ai_enabled: on });
            S.caps.ai = on;
            useApp.setState(st => ({ lkTick: st.lkTick + 1 }));
            toast(on ? 'AI features are on' : 'AI features are off');
            back();
          } catch (x) { toast((x as Error).message, 'bad'); }
        }} /><span>Use AI features</span></label>
      </div></Card>
      {app.ai_enabled !== false ? <AiSettingsCard /> : null}
    </Group>
    <Group title="Data & backups">
      <Card title="Automatic backups"><div>
        <p>HaRM saves a copy every day. Saved logins stay encrypted inside.</p>
        <label className="disc-field"><span>Keep</span>
          <select aria-label="Backups to keep" value={app.backup_keep} onChange={e => saveApp({ backup_keep: +e.target.value })}>
            {[7, 14, 30, 90].map(n => <option key={n} value={n}>{`The last ${n} days`}</option>)}</select></label>
        {caps.backups?.length ? <ul className="plain">{caps.backups.slice(0, 5).map((b: Row) => <li key={b.name} className="mono small">{`${b.name} · ${(b.size / 1e6).toFixed(1)} MB`}</li>)}</ul>
          : <p className="muted small">The first one is made a few seconds after the server starts.</p>}
        <p className="muted small">{`Kept on the HaRM computer in ${caps.backup_dir || 'data/backups'}. Copy that folder to another disk now and then.`}</p>
      </div></Card>
      <Card title="Copy to a second place"><div>
        <p>Each day’s backup is also copied to another disk, so one dead drive can’t take everything with it.</p>
        {c.dir ? <p><span className="badge ok">On</span> To <span className="mono">{c.dir}</span>{`, keeping the last ${c.keep}.`}</p> : <p><span className="badge muted">Off</span></p>}
        {c.last ? <p className="small">{c.last.ok ? <span className="ok-text">{`✓ Copied ${c.last.file} ${timeAgo(c.last.at)}`}</span> : <span className="bad-text">{`✗ ${timeAgo(c.last.at)}: ${c.last.error}`}</span>}</p> : null}
        <div className="inline"><Btn label="Choose a folder…" cls="primary" onClick={() => formDialog({
          title: 'Copy backups to a second place', rec: { dir: c.dir || '', keep: String(c.keep || 14) },
          fields: [
            { k: 'dir', label: 'Folder on the HaRM computer', wide: true, raw: true, ph: caps.platform === 'windows' ? 'D:\\HaRM backups' : '/mnt/nas/harm-backups',
              help: 'A NAS share or USB drive connected to the computer HaRM runs on. Leave it empty to stop copying. In Docker, mount the folder into the container first.' },
            { k: 'keep', label: 'Keep', type: 'select', required: true, options: [7, 14, 30, 90].map(x => ({ value: String(x), label: `The last ${x} copies` })) },
          ],
          submit: v => api('POST', '/backup-copy', { dir: v.dir || '', keep: +v.keep }),
          onDone: async r => { toast(r.dir ? 'Saved. Copying now…' : 'Copying is off'); if (r.dir) await api('POST', '/backup-copy/run', {}).catch(() => {}); back(); },
        })} />
          {c.dir ? <Btn label="Copy now" onClick={async () => {
            try { const r = await api('POST', '/backup-copy/run', {}); toast(r.ok ? `Copied ${r.file}` : r.error, r.ok ? 'ok' : 'bad'); } catch (e) { toast((e as Error).message, 'bad'); }
            back();
          }} /> : null}</div>
        <p className="muted small">Logins stay encrypted in the copies, like in every backup.</p>
      </div></Card>
      <Card title="Download a backup"><div>
        <p>The whole database in one file. Saved logins stay encrypted and only open with your master password or recovery code.</p>
        <a className="button primary" href="/api/backup">⬇ Download backup (.db)</a>
      </div></Card>
      <Card title="Export CSV"><div>
        <div className="export-links">{ENTS.map(e => <a key={e} className="button sm" href={`/api/export/${e}.csv`}>{e.replace('_', ' ')}</a>)}</div>
        <p className="muted small">The logins file has names and usernames only, never passwords. More ways out: <A href="#/export">Export &amp; Share</A>.</p>
      </div></Card>
    </Group>
    {hasKeyboard() ? <Group title="Shortcuts"><Card title="Keyboard shortcuts"><div><ShortcutsList /></div></Card></Group> : null}
    <Group title="About">
      <Card title="About Zom’s HaRM"><div className="about-row">
        <img src={asset('icon.svg')} alt="" width={48} height={48} />
        <div>
          <p><b>Zom’s HaRM</b> {auth.release || ''}</p>
          <p className="muted small">Hardware and rack manager, kept on your own computer. Made by ZomBeatz Media.</p>
          <p className="muted small">Free and open source under the MIT license. <a href="https://github.com/ZomBeatz/Zoms-HaRM" target="_blank" rel="noopener">See the code</a>{' · '}
            <a href="https://github.com/ZomBeatz/Zoms-HaRM/blob/main/CHANGELOG.md" target="_blank" rel="noopener">What’s new</a></p>
          <UpdateCheckRow app={app} save={saveApp} />
          <div className="inline">
            <Btn label="💬 Send feedback" onClick={sendFeedback} />
            <a className="button" href="https://docs.zombeatzmedia.com/harm/" target="_blank" rel="noopener">Read the guide</a>
            <a className="button" href="#/setup">🧭 Setup guide</a>
          </div>
        </div>
      </div></Card>
    </Group>
    </div>
  </>;
}
