/* A machine's screen in HaRM (#/vnc?d=&h=&p=&c=&s=&vc=): the noVNC viewer, relayed through HaRM to the
 * VNC port on your network, or with s= (the SSH port) through SSH to the VNC port on the machine
 * itself, encrypted all the way. It closes when HaRM locks or you leave the page; nothing is stored.
 * A saved login fills in the VNC password only when the machine asks for it (and that's audited):
 * vc= (the screen HaRM set up, from Find screens) first, else the SSH login c=. */
import { useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc';
import { api, GET } from '../api/client';
import { A, Btn, PageHead, Small } from '../ui/bits';
import { copy, toast } from '../ui/overlay';
import { screensDialog } from '../dialogs/screens';

/* The X keysym for a character, for typing text into the screen. */
const keysym = (ch: string) => {
  const c = ch.codePointAt(0)!;
  if (ch === '\n') return 0xff0d;  // Return
  if (ch === '\t') return 0xff09;  // Tab
  return c < 0x100 ? c : 0x01000000 | c;
};

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
  const [noScreen, setNoScreen] = useState(false);
  const [ssh, setSsh] = useState(!!q.get('s'));
  const [clip, setClip] = useState(false);
  const [toSend, setToSend] = useState('');
  const [fromIt, setFromIt] = useState('');
  const [live, setLive] = useState(false);
  const saved = useRef('');  // 'sent' once the saved login's password was tried: if it's refused, ask next time
  useEffect(() => {
    let closed = false;
    setState(q.get('s') ? 'Signing in over SSH…' : 'Connecting…'); setAsk(null); setKeyChanged(false); setNoScreen(false); setLive(false);
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
        c.addEventListener('connect', () => { setState(''); setLive(true); c.focus(); });
        c.addEventListener('disconnect', (e: CustomEvent) => { setLive(false); setState(e.detail.clean ? 'Disconnected.' : 'The connection was lost, or HaRM couldn’t reach VNC on that address.'); });
        c.addEventListener('securityfailure', (e: CustomEvent) => setState(`The machine refused: ${e.detail.reason || 'wrong password?'}${saved.current === 'sent' ? ' Connect again to type the VNC password.' : ''}`));
        c.addEventListener('desktopname', (e: CustomEvent) => e.detail.name && setLabel(`${e.detail.name} · ${q.get('h')}`));
        c.addEventListener('clipboard', (e: CustomEvent) => { setFromIt(e.detail.text || ''); });
        c.addEventListener('credentialsrequired', async (e: CustomEvent) => {
          const types: string[] = e.detail.types || ['password'];
          // The saved password, revealed (and audited) only now: the screen's own login, else the SSH login's.
          const from = q.get('vc') || (!types.includes('username') ? q.get('c') : null);
          if (from && !saved.current) {
            try {
              const s = await api('POST', `/credentials/${from}/reveal`);
              if (s.password && (!types.includes('username') || s.username)) {
                saved.current = 'sent'; c.sendCredentials({ username: s.username || '', password: s.password }); return;
              }
            } catch { /* ask instead */ }
          }
          setAsk(types);
        });
      } catch (e) {
        const m = (e as Error).message;
        setState(m); setKeyChanged(/host key changed/i.test(m)); setNoScreen(/nothing answers on VNC/i.test(m));
      }
    })();
    return () => { closed = true; rfb.current?.disconnect(); rfb.current = null; };
  }, [run, q.toString()]);  // eslint-disable-line react-hooks/exhaustive-deps
  const again = (t = false) => { if (saved.current === 'sent') saved.current = 'refused'; setTrust(t); setRun(n => n + 1); };
  const send = () => { rfb.current?.sendCredentials({ username: user, password: pw }); setPw(''); setAsk(null); };
  const findScreens = async () => {
    const d = q.get('d');
    try {
      const [dev, t] = await Promise.all([GET(`/devices/${d}`), GET(`/devices/${d}/collect-targets`)]);
      const c = t.credentials.find((x: { id: number }) => String(x.id) === q.get('c'));
      screensDialog({ dev, host: q.get('h') || '', port: +(q.get('s') || 22), cred: +(q.get('c') || 0), user: c?.username || '', saved: t.screen,
        open: (vp: number, vcred?: number) => {
          const n = new URLSearchParams(q); n.set('p', String(vp)); if (vcred) n.set('vc', String(vcred)); else n.delete('vc');
          location.hash = `#/vnc?${n}`;
        } });
    } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const pasteIn = () => { rfb.current?.clipboardPasteFrom(toSend); toast('Sent to the machine’s clipboard: paste it there'); };
  const typeIn = () => {
    const c = rfb.current;
    if (!c) return;
    const text = toSend.slice(0, 2000);
    for (const ch of text) c.sendKey(keysym(ch), null);
    c.focus();
    toast(`Typed ${text.length} character${text.length === 1 ? '' : 's'}`);
  };
  return <div className="term-page">
    <PageHead title={label} sub={<span>{ssh ? 'Screen (VNC) through SSH, encrypted' : 'Screen (VNC)'} · closes when HaRM locks · {q.get('d') ? <A href={`#/devices/${q.get('d')}`}>Back to the device</A> : null}</span>}>
      <Small label="Ctrl+Alt+Del" title="Sends Ctrl+Alt+Del to the machine" disabled={!live} onClick={() => { rfb.current?.sendCtrlAltDel(); toast('Sent Ctrl+Alt+Del'); }} />
      <Small label="📋 Clipboard" title="Send text to the machine, or copy what it copied" onClick={() => setClip(x => !x)} cls={clip ? 'on' : ''} />
      <label className="check inline-check"><input type="checkbox" checked={viewOnly} onChange={e => { setViewOnly(e.target.checked); if (rfb.current) rfb.current.viewOnly = e.target.checked; }} />Only watch</label>
      <Small label="⛶ Full screen" onClick={() => box.current?.requestFullscreen?.()} />
      {state && !state.endsWith('…') ? <Btn label="⟳ Connect again" cls="primary" onClick={() => again()} />
        : <Small label="✕ Close" onClick={() => { history.length > 1 ? history.back() : (location.hash = '#/dashboard'); }} />}
    </PageHead>
    {state ? <p className={state.endsWith('…') ? 'muted' : 'warn-text'}>{state}</p> : null}
    {noScreen && q.get('d') ? <div className="notice">Nothing shares this machine’s screen on that port yet. HaRM can look for screens on it, and set one up.{' '}
      <Btn label="🔍 Find screens" cls="primary" onClick={findScreens} /></div> : null}
    {keyChanged ? <div className="notice warn"><b>The machine’s SSH key changed.</b> That’s normal after reinstalling it, but can also mean something is intercepting the connection.{' '}
      <Btn label="Trust the new key and connect" onClick={() => { toast('Trusting the new key'); again(true); }} /></div> : null}
    {ask ? <form className="notice inline" onSubmit={e => { e.preventDefault(); send(); }}>
      <span>The machine asks for its VNC password.</span>
      {ask.includes('username') ? <input aria-label="Username" placeholder="Username" value={user} onChange={e => setUser(e.target.value)} autoComplete="username" /> : null}
      <input type="password" aria-label="VNC password" placeholder="Password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="current-password" autoFocus />
      <Btn label="Connect" cls="primary" onClick={send} />
    </form> : null}
    {clip ? <div className="vnc-clip">
      <div className="vnc-clip-part">
        <textarea className="mono" aria-label="Text to send" rows={3} placeholder="Text to send to the machine…" value={toSend} onChange={e => setToSend(e.target.value)} />
        <div className="inline">
          <Small label="📋 Put on its clipboard" title="Then paste it on the machine (Ctrl+V)" disabled={!live || !toSend} onClick={pasteIn} />
          <Small label="⌨ Type it" title="Types it as keystrokes: works on login screens and where pasting doesn't" disabled={!live || !toSend || viewOnly} onClick={typeIn} />
        </div>
      </div>
      <div className="vnc-clip-part">
        <div className="small muted">Last copied on the machine:</div>
        {fromIt ? <><pre className="mono small">{fromIt.length > 2000 ? fromIt.slice(0, 2000) + '…' : fromIt}</pre>
          <Small label="⧉ Copy" onClick={() => copy(fromIt, 'Copied')} /></> : <p className="muted small">Nothing yet: copy something on the machine.</p>}
      </div>
    </div> : null}
    <div className="term-box vnc-box" ref={box} />
  </div>;
}
