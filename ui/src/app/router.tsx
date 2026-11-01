/* Hash routes (#/devices/12), in-app history for "← Back to …", and loading a page's data. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { S, useApp } from '../lib/state';

export function currentRoute() {
  const raw = location.hash.replace(/^#/, '');
  const [path, qs] = raw.split('?');
  return { hash: location.hash || '#/dashboard', path, q: new URLSearchParams(qs || '') };
}

/* In-app history, so detail pages can offer "← Back to The Rack". */
export function trackHistory() {
  const hsh = location.hash || '#/dashboard';
  const hist = S.hist;
  if (hist.length && hist[hist.length - 1].hash === hsh) return;
  if (hist.length > 1 && hist[hist.length - 2].hash === hsh) { hist.pop(); return; }
  hist.push({ hash: hsh, title: '' });
  if (hist.length > 60) hist.shift();
}

/* Drop one-shot query parts (like ?edit=…) from the address without reloading, so Back and
   redraws don't reopen the same dialog. */
export function cleanHash(hash: string) {
  history.replaceState(null, '', hash);
  const cur = S.hist[S.hist.length - 1];
  if (cur) cur.hash = location.hash;
}

export function goBackOr(fallback: string) {
  if (S.hist.length > 1) history.back();
  else location.hash = fallback;
}

export function BackLink() {
  const prev = S.hist[S.hist.length - 2];
  if (!prev) return null;
  return <a className="back-link" href={prev.hash} onClick={e => { e.preventDefault(); history.back(); }}>{`← Back to ${prev.title || 'previous page'}`}</a>;
}

export function useHash(before?: () => void) {
  const [route, setRoute] = useState(currentRoute);
  const pre = useRef(before);
  pre.current = before;
  useEffect(() => {
    const on = () => { pre.current?.(); setRoute(currentRoute()); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

/* Pages still waiting for their first data. While any are, the shell keeps showing the previous
   page (dimmed) instead of an empty one. */
let firstLoads = 0;
const loadWaiters = new Set<() => void>();
export const pageLoading = () => firstLoads > 0;
export function whenPageLoaded(f: () => void) { loadWaiters.add(f); return () => { loadWaiters.delete(f); }; }
function firstLoadDone() {
  if (--firstLoads === 0) for (const f of [...loadWaiters]) f();
}

/* Shown while a page's code is still downloading; counts as waiting, like its data. */
export function PageWaiting() {
  useLayoutEffect(() => {
    let open = true;
    firstLoads++;
    return () => { if (open) { open = false; firstLoadDone(); } };
  }, []);
  return null;
}

export interface Loaded<T> { data: T | undefined; error: string; reload: () => Promise<void> }
/* A page's data: loaded on open, again on reload() and whenever rerender() is called. */
export function useLoad<T>(load: () => Promise<T>): Loaded<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const tick = useApp(s => s.tick);
  const fn = useRef(load);
  fn.current = load;
  const alive = useRef(true);
  const seq = useRef(0);
  const done = useRef(false);
  const first = useRef(() => {});
  const reload = useCallback(async () => {
    const my = ++seq.current;
    try {
      const d = await fn.current();
      if (alive.current && my === seq.current) { setData(d); setError(''); }
    } catch (e) {
      if (alive.current && my === seq.current && S.authed) setError((e as Error).message);
    }
    if (my === seq.current) { done.current = true; first.current(); }
  }, []);
  useLayoutEffect(() => {
    if (done.current) return;
    let open = true;
    firstLoads++;
    const release = () => { if (open) { open = false; firstLoadDone(); } };
    first.current = release;
    return release;
  }, []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { reload(); }, [tick, reload]);
  return { data, error, reload };
}

/* What a page shows before its data arrives, or when loading it failed. */
export function Pending({ q }: { q: { error: string } }) {
  return q.error ? <div className="form-error">{q.error}</div> : null;
}
