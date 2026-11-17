/* A machine's screen in HaRM (#/vnc?d=&h=&p=&c=&s=): the noVNC viewer, relayed through HaRM to the
 * VNC port on your network, or with s= (the SSH port) through SSH to the VNC port on the machine
 * itself, encrypted all the way. It closes when HaRM locks or you leave the page; nothing is stored.
 * A saved login fills in the VNC password only when the machine asks for it (and that's audited). */
import { useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc';
import { api } from '../api/client';
import { A, Btn, PageHead, Small } from '../ui/bits';
import { toast } from '../ui/overlay';

export default function Vnc({ q }: { q: URLSearchParams }) {
  const box = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const [label, setLabel] = useState(`${q.get('h')}:${q.get('p') || 5900}`);
  const [state, setState] = useState('Connecting…');
  const [ask, setAsk] = useState<string[] | null>(null);
  const [user, setUser] = useState('');
  const [pw, setPw] = useState('');
  const [run, setRun] = useState(0);
  const [viewOnly, setViewOnly] = useState(false);
  const [trust, setTrust] = useState(false);
  const [keyChanged, setKeyChanged] = useState(false);
  const [ssh, setSsh] = useState(!!q.get('s'));
  const saved = useRef('');  // 'sent' once the saved login's password was tried: if it's refused, ask next time
  useEffect(() => {
    let closed = false;
    setState(q.get('s') ? 'Signing in over SSH…' : 'Connecting…'); setAsk(null); setKeyChanged(false);
    (async () => {
      try {
        const r = await api('POST', '/vnc', { device_id: +(q.get('d') || 0), host: q.get('h'), port: +(q.get('p') || 5900),
          ...(q.get('s') ? { ssh_port: +(q.get('s') || 22), credential_id: +(q.get('c') || 0), trust_new_key: trust } : {}) });
        if (closed || !box.current) return;
        setLabel(r.label); setSsh(r.ssh); setState('Connecting…');
        const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/vnc/ws?t=${encodeURIComponent(r.ticket)}`;
        const c = new RFB(box.current, url, { wsProtocols: ['binary'] });
        c.scaleViewport = true;
        c.background = 'transparent';
        rfb.current = c;
        c.addEventListener('connect', () => { setState(''); c.focus(); });
        c.addEventListener('disconnect', (e: CustomEvent) => setState(e.detail.clean ? 'Disconnected.' : 'The connection was lost, or HaRM couldn’t reach VNC on that address.'));
        c.addEventListener('securityfailure', (e: CustomEvent) => setState(`The machine refused: ${e.detail.reason || 'wrong password?'}${saved.current === 'sent' ? ' Connect again to type the VNC password.' : ''}`));
        c.addEventListener('desktopname', (e: CustomEvent) => e.detail.name && setLabel(`${e.detail.name} · ${q.get('h')}`));
        c.addEventListener('credentialsrequired', async (e: CustomEvent) => {
          const types: string[] = e.detail.types || ['password'];
          if (q.get('c') && !types.includes('username') && !saved.current) {  // the saved login's password, revealed (and audited) only now
            try { const s = await api('POST', `/credentials/${q.get('c')}/reveal`); if (s.password) { saved.current = 'sent'; c.sendCredentials({ password: s.password }); return; } }
            catch { /* ask instead */ }
          }
          setAsk(types);
        });
      } catch (e) { setState((e as Error).message); setKeyChanged(/host key changed/i.test((e as Error).message)); }
    })();
    return () => { closed = true; rfb.current?.disconnect(); rfb.current = null; };
  }, [run]);  // eslint-disable-line react-hooks/exhaustive-deps
  const again = (t = false) => { if (saved.current === 'sent') saved.current = 'refused'; setTrust(t); setRun(n => n + 1); };
  const send = () => { rfb.current?.sendCredentials({ username: user, password: pw }); setPw(''); setAsk(null); };
  return <div className="term-page">
    <PageHead title={label} sub={<span>{ssh ? 'Screen (VNC) through SSH, encrypted' : 'Screen (VNC)'} · closes when HaRM locks · {q.get('d') ? <A href={`#/devices/${q.get('d')}`}>Back to the device</A> : null}</span>}>
      <Small label="Ctrl+Alt+Del" title="Sends Ctrl+Alt+Del to the machine" onClick={() => { rfb.current?.sendCtrlAltDel(); toast('Sent Ctrl+Alt+Del'); }} />
      <label className="check inline-check"><input type="checkbox" checked={viewOnly} onChange={e => { setViewOnly(e.target.checked); if (rfb.current) rfb.current.viewOnly = e.target.checked; }} />Only watch</label>
      <Small label="⛶ Full screen" onClick={() => box.current?.requestFullscreen?.()} />
      {state && !state.endsWith('…') ? <Btn label="⟳ Connect again" cls="primary" onClick={() => again()} />
        : <Small label="✕ Close" onClick={() => { history.length > 1 ? history.back() : (location.hash = '#/dashboard'); }} />}
    </PageHead>
    {state ? <p className={state.endsWith('…') ? 'muted' : 'warn-text'}>{state}</p> : null}
    {keyChanged ? <div className="notice warn"><b>The machine’s SSH key changed.</b> That’s normal after reinstalling it, but can also mean something is intercepting the connection.{' '}
      <Btn label="Trust the new key and connect" onClick={() => { toast('Trusting the new key'); again(true); }} /></div> : null}
    {ask ? <form className="notice inline" onSubmit={e => { e.preventDefault(); send(); }}>
      <span>The machine asks for its VNC password.</span>
      {ask.includes('username') ? <input aria-label="Username" placeholder="Username" value={user} onChange={e => setUser(e.target.value)} autoComplete="username" /> : null}
      <input type="password" aria-label="VNC password" placeholder="Password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="current-password" autoFocus />
      <Btn label="Connect" cls="primary" onClick={send} />
    </form> : null}
    <div className="term-box vnc-box" ref={box} />
  </div>;
}
