/* Talking to the HaRM server. Every request carries X-HaRM, which the server requires (CSRF). */
import { S, useApp } from '../lib/state';
import { LOOKUPS } from './types';
import { showAuth } from '../app/session';

/* A failed request on HTTPS is usually the certificate (not trusted on this device, or changed
   after a restart), not a dead server, so say what to try. */
export const UNREACHABLE = () => location.protocol === 'https:'
  ? 'Cannot reach the HaRM server. If it’s running, this device may not trust HaRM’s certificate (or the certificate changed after a restart): open HaRM in the browser once, or install the certificate with Phone setup in the HaRM desktop app.'
  : 'Cannot reach the HaRM server. Check that it’s running and that this device is on the same network.';

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const opt: RequestInit & { headers: Record<string, string> } = { method, credentials: 'same-origin', headers: { 'X-HaRM': '1' } };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  let r: Response;
  try { r = await fetch('/api' + path, opt); }
  catch { throw new Error(UNREACHABLE()); }
  S.lastPing = Date.now();
  let data: any = null;
  try { data = await r.json(); } catch { /* empty body */ }
  if (r.status === 401 && !path.startsWith('/auth/')) {
    showAuth('Your session ended. Please unlock again.');
    throw new Error('Session expired');
  }
  if (!r.ok) {
    const d = data && data.detail;
    throw new Error(typeof d === 'string' ? d : (d ? JSON.stringify(d) : r.statusText));
  }
  return data as T;
}
export const GET = <T = any>(p: string) => api<T>('GET', p);

/* The online demo (web-demo/) answers /api/ inside the browser, so it fetches downloads itself. */
export const openDownload = (url: string) => { if (window.harmDemo) window.harmDemo.download(url); else location.href = url; };

export async function loadLookups() {
  const res = await Promise.all(LOOKUPS.map(e => GET('/' + e)));
  LOOKUPS.forEach((e, i) => { (S.lk as any)[e] = res[i]; });
  useApp.setState(s => ({ lkTick: s.lkTick + 1 }));
}

/* A photo of a label, read by the server (barcodes and printed text). */
export async function serverScan(canvas: HTMLCanvasElement) {
  const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', 0.92));
  const r = await fetch('/api/scan', { method: 'POST', credentials: 'same-origin', headers: { 'X-HaRM': '1', 'Content-Type': 'image/jpeg' }, body: blob });
  if (r.status === 401) { showAuth('Your session ended. Please unlock again.'); throw new Error('Session expired'); }
  if (!r.ok) throw new Error('The server could not read the photo');
  return r.json() as Promise<{ barcodes: { format: string; value: string }[]; text: string; ocr: boolean }>;
}
