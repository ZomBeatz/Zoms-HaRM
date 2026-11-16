/* A terminal in HaRM: an SSH session to one of your machines with a saved login (#/terminal?…).
 * Output streams in as server-sent events; keystrokes go back in small batches. It closes when HaRM
 * locks, after 30 minutes without typing, or when you leave this page. Nothing typed is stored. */
import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api/client';
import { A, Btn, PageHead, Small } from '../ui/bits';
import { toast } from '../ui/overlay';

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export default function Terminal({ q }: { q: URLSearchParams }) {
  const box = useRef<HTMLDivElement>(null);
  const [label, setLabel] = useState(q.get('u') ? `${q.get('u')}@${q.get('h')}` : q.get('h') || '');
  const [ended, setEnded] = useState('');
  const [keyChanged, setKeyChanged] = useState(false);
  const [run, setRun] = useState(0);  // bumped to reconnect
  const [trust, setTrust] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const term = new XTerm({
      cursorBlink: true, fontFamily: css('--zb-font-mono') || 'monospace', fontSize: 14, scrollback: 5000,
      theme: { background: css('--zb-bg') || '#14161c', foreground: css('--zb-text') || '#e6e8ef', cursor: css('--zb-accent') || '#4fb0ec' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Drawn with WebGL: xterm's other renderer adds <style> elements, which HaRM's security policy refuses.
    let gl = true;
    try { term.loadAddon(new WebglAddon()); } catch { gl = false; }
    term.open(el);
    if (!gl) term.writeln('This browser can’t draw the terminal (it needs WebGL).');
    fit.fit();
    term.focus();
    let id = '', closed = false, es: EventSource | null = null, all = '';
    let pending = '', timer = 0, chain = Promise.resolve();
    const send = () => {
      timer = 0;
      const d = pending; pending = '';
      if (!d || !id) return;
      chain = chain.then(() => api('POST', `/terminal/${id}/input`, { d }).then(() => undefined, () => undefined));
    };
    term.onData(d => { pending += d; if (!timer) timer = window.setTimeout(send, 15); });
    const resize = () => { try { fit.fit(); } catch { /* hidden */ } if (id) api('POST', `/terminal/${id}/resize`, { cols: term.cols, rows: term.rows }).catch(() => {}); };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    term.writeln(`Connecting to ${q.get('h')}…`);
    (async () => {
      try {
        const r = await api('POST', '/terminal', {
          device_id: q.get('d') ? +q.get('d')! : null, host: q.get('h'), port: +(q.get('p') || 22), credential_id: q.get('c') ? +q.get('c')! : null,
          username: q.get('u') || '', legacy: q.get('legacy') === '1', cols: term.cols, rows: term.rows, trust_new_key: trust,
        });
        if (closed) { api('POST', `/terminal/${r.id}/close`, {}).catch(() => {}); return; }
        id = r.id; setLabel(r.label);
        es = new EventSource(`/api/terminal/${id}/stream`);
        es.onmessage = e => { const t = JSON.parse(e.data); all = (all + t).slice(-4000); term.write(t); };
        es.addEventListener('end', e => {
          es?.close();
          const why = JSON.parse((e as MessageEvent).data);
          term.writeln(`\r\n\x1b[2m${why}\x1b[0m`);
          setEnded(why);
          if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(all)) setKeyChanged(true);
        });
      } catch (e) {
        term.writeln(`\r\n${(e as Error).message}`);
        setEnded((e as Error).message);
      }
    })();
    return () => {
      closed = true;
      ro.disconnect();
      es?.close();
      if (id) api('POST', `/terminal/${id}/close`, {}).catch(() => {});
      term.dispose();
    };
  }, [run]);  // eslint-disable-line react-hooks/exhaustive-deps
  const again = (t = false) => { setEnded(''); setKeyChanged(false); setTrust(t); setRun(n => n + 1); };
  return <div className="term-page">
    <PageHead title={<span className="mono">{label}</span>} sub={<span>Terminal · closes when HaRM locks · {q.get('d') ? <A href={`#/devices/${q.get('d')}`}>Back to the device</A> : null}</span>}>
      <Small label="⧉ New window" title="Opens another terminal in its own window" onClick={() => { window.open(location.href, '_blank', 'noopener,width=1000,height=640'); }} />
      {ended ? <Btn label="⟳ Connect again" cls="primary" onClick={() => again()} /> : <Small label="✕ Close" onClick={() => { history.length > 1 ? history.back() : (location.hash = '#/dashboard'); }} />}
    </PageHead>
    {keyChanged ? <div className="notice warn"><b>The machine’s SSH key changed.</b> That’s normal after reinstalling it, but can also mean something is intercepting the connection.{' '}
      <Btn label="Trust the new key and connect" onClick={() => { toast('Trusting the new key'); again(true); }} /></div> : null}
    <div className="term-box" ref={box} />
  </div>;
}
