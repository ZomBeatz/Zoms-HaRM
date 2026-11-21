/* Find screens (🔌 Connect > 🔍 Find screens): which VNC servers a machine runs, and a one-click setup:
 * x11vnc on X11 desktops and wayvnc on Sway and other wlroots desktops, shared only on the machine itself
 * (reached through HaRM's SSH tunnel), or GNOME's own screen sharing. */
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { type Row } from '../lib/util';
import { choose, modal, toast, type ModalCtl } from '../ui/overlay';
import { Btn, Spinner } from '../ui/bits';

interface Opts { dev: Row; host: string; port: number; cred: number; user: string; saved?: Row | null; open: (port: number, vcred?: number) => void }

export function screensDialog(o: Opts) {
  modal(`Screens on ${o.dev.name}`, (m: ModalCtl) => <Screens m={m} o={o} />);
}

function Screens({ m, o }: { m: ModalCtl; o: Opts }) {
  const [v, setV] = useState<Row | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [run, setRun] = useState(0);
  const [trust, setTrust] = useState(false);
  const body = { host: o.host, port: o.port, credential_id: o.cred, trust_new_key: trust };
  useEffect(() => {
    setV(null); setErr('');
    api('POST', `/devices/${o.dev.id}/screens`, body).then(setV).catch(e => setErr((e as Error).message));
  }, [run]);  // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div className="disc-form">
    <p className="warn-text">{err}</p>
    <div className="actions">{/host key changed/i.test(err) ? <Btn label="Trust the new key and check" onClick={() => { setTrust(true); setRun(n => n + 1); }} /> : null}
      <Btn label="⟳ Check again" onClick={() => setRun(n => n + 1)} /><Btn label="Close" cls="primary" onClick={() => m.close(true)} /></div>
  </div>;
  if (!v) return <div className="muted"><Spinner /> {`Looking at ${o.host} over SSH…`}</div>;
  const saved = v.saved;
  const how: string = v.how || saved?.how || 'x11vnc';
  const program = how === 'gnome' ? 'GNOME Remote Desktop' : how;
  const steps = how === 'gnome' ? <>
    <p>{`HaRM signs in to ${o.host} as ${o.user} (the desktop’s user) and turns on GNOME’s own screen sharing over VNC, with:`}</p>
    <ul>
      <li>a new VNC password, saved in the vault as <b>{`VNC screen (${o.dev.name})`}</b>,</li>
      <li>control of the mouse and keyboard (not only watching).</li>
    </ul>
    <p className="muted small">GNOME shares it on the network (port 5900), not only on the machine: HaRM still opens it through SSH. A firewall on the machine can keep others out. Take it out again here.</p></>
    : how === 'wayvnc' ? <>
      <p>{`HaRM signs in to ${o.host} as ${o.user} (the desktop’s user) and:`}</p>
      <ul>
        <li>{v.wayvnc ? 'uses the wayvnc that’s installed' : <>installs <b>wayvnc</b> with {v.pm} (with sudo)</>},</li>
        <li>{'runs it as your user’s service, '}<span className="mono">zoms-harm-vnc</span>{', sharing the desktop on the machine itself only (127.0.0.1), so it can only be reached through SSH,'}</li>
        <li>with a new password, saved in the vault as <b>{`VNC screen (${o.dev.name})`}</b>.</li>
      </ul>
      <p className="muted small">It needs wayvnc 0.7 or newer. It starts when you sign in to the desktop. Take it out again here.</p></>
    : <>
      <p>{`HaRM signs in to ${o.host} as ${o.user} and, with sudo:`}</p>
      <ul>
        <li>installs <b>x11vnc</b> with {v.pm} (if it isn’t there yet),</li>
        <li>{'runs it as a service, '}<span className="mono">zoms-harm-vnc</span>{', sharing the desktop on the machine itself only (127.0.0.1), so it can only be reached through SSH,'}</li>
        <li>with a new VNC password, saved in the vault as <b>{`VNC screen (${o.dev.name})`}</b>.</li>
      </ul>
      <p className="muted small">Anyone who can sign in to the machine could also connect to it, with that password. Take it out again here.</p></>;
  const setup = async (remove: boolean) => {
    const sure = remove
      ? await choose('Take out HaRM’s screen sharing?', how === 'gnome'
        ? `HaRM turns off GNOME’s screen sharing over VNC on ${o.host} and deletes its VNC password from the vault.`
        : `HaRM stops and removes its ${program} service on ${o.host} and deletes its VNC password from the vault. The ${program} program stays installed.`,
        [['no', 'Cancel'], ['yes', 'Take it out', 'danger']])
      : await choose('Set up screen sharing?', steps, [['no', 'Cancel'], ['yes', 'Set it up', 'primary']]);
    if (sure !== 'yes') return;
    setBusy(remove ? 'Taking it out…' : 'Setting it up (installing can take a minute)…');
    try {
      const r = await api('POST', `/devices/${o.dev.id}/screens/setup`, { ...body, remove });
      if (remove) { toast('Took it out'); setRun(n => n + 1); }
      else {
        toast('Screen sharing is set up');
        if (await choose('Screen sharing is set up', `${program} shares the desktop on port ${r.port}${how === 'gnome' ? '' : ', only on the machine'}. Open it now?`,
          [['no', 'Later'], ['yes', '🖥 Open the screen', 'primary']]) === 'yes') { m.close(true); o.open(r.port, r.credential_id); return; }
        setRun(n => n + 1);
      }
    } catch (e) { toast((e as Error).message, 'bad'); }
    setBusy('');
  };
  const savedPort = saved && v.harm ? saved.port : null;
  return <div className="disc-form">
    {v.ports.length ? <>
      <p>{`VNC on ${o.host}:`}</p>
      <ul className="plain-list">{v.ports.map((p: Row) => <li key={p.port} className="inline">
        <Btn label={`🖥 Open port ${p.port}`} onClick={() => { m.close(true); o.open(p.port, p.port === savedPort ? saved.credential_id : undefined); }} />
        <span className="muted small">{p.port === savedPort ? 'Set up by HaRM. ' : ''}{p.local ? 'Only on the machine: reached through SSH.' : 'Open on the network too.'}
          {` Display :${p.port - 5900}.`}</span></li>)}</ul>
    </> : <p>{`Nothing on ${o.host} shares its screen over VNC yet (ports 5900–5999).`}</p>}
    {v.running.length ? <p className="muted small">{`Running: ${v.running.join(', ')}.`}</p> : null}
    {v.harm ? <p className="small">{`HaRM’s screen sharing (${program}) is set up here${v.harm === 'active' ? '' : `, but it’s ${v.harm}`}. `}
      <a href="#" onClick={e => { e.preventDefault(); setup(true); }}>Take it out</a>
      {v.harm !== 'active' && v.can_setup ? <>{' · '}<a href="#" onClick={e => { e.preventDefault(); setup(false); }}>Set it up again</a></> : null}</p>
      : v.can_setup ? <div className="notice">
        <p>{v.ports.length ? 'Or let HaRM set up its own: ' : 'HaRM can set it up: '}<b>{program}</b>{how === 'gnome' ? ', GNOME’s own screen sharing.' : ', sharing this machine’s desktop only through SSH.'}</p>
        <Btn label={busy || '🔧 Set up screen sharing'} cls="primary" disabled={!!busy} onClick={() => setup(false)} />
      </div>
      : v.advice ? <p className="muted">{v.advice}</p> : null}
    {busy && v.harm ? <p className="muted"><Spinner /> {busy}</p> : null}
    <div className="actions"><Btn label="⟳ Check again" disabled={!!busy} onClick={() => setRun(n => n + 1)} /><Btn label="Close" cls="primary" disabled={!!busy} onClick={() => m.close(true)} /></div>
  </div>;
}
