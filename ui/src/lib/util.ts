/* Small helpers with no interface of their own: text, numbers, dates, preferences. */

export type Row = Record<string, any>;

export const nz = (...xs: unknown[]) => xs.filter(x => x != null && x !== '').join(' ');
export const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
/* How numbers and dates read: currency is set for every device (Settings), the rest per device (lib/look.ts). */
export const FMT = { currency: 'USD', dates: 'iso' as 'iso' | 'local' | 'dmy' | 'mdy', clock: 'auto' as 'auto' | '12' | '24', length: 'mm' as 'mm' | 'in' };
export function money(v: unknown) {
  if (v == null || v === '') return '';
  try { return Number(v).toLocaleString(undefined, { style: 'currency', currency: FMT.currency }); }
  catch { return `${FMT.currency} ${Number(v).toFixed(2)}`; }
}
/* A calendar date ("2026-11-20", or the start of a timestamp) in the chosen style. */
export function fmtDay(v: unknown) {
  const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(String(v ?? ''));
  if (!m) return v == null ? '' : String(v);
  const [, y, mo, d] = m;
  if (FMT.dates === 'dmy') return `${d}/${mo}/${y}`;
  if (FMT.dates === 'mdy') return `${mo}/${d}/${y}`;
  if (FMT.dates === 'local') return new Date(+y, +mo - 1, +d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  return `${y}-${mo}-${d}`;
}
const pad = (n: number) => String(n).padStart(2, '0');
export const fmtLocalDay = (d = new Date()) => fmtDay(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
/* Millimetres in the chosen unit: "740 mm" or "29.1 in". */
export const fmtLen = (mm: unknown) => mm == null || mm === '' ? '' : FMT.length === 'in' ? `${+(Number(mm) / 25.4).toFixed(1)} in` : `${mm} mm`;
export const today = () => new Date().toISOString().slice(0, 10);

export function prefGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
export function prefSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* not saved */ } }
export function prefDel(k: string) { try { localStorage.removeItem(k); } catch { /* not saved */ } }

export const fmtGB = (gb: number | null | undefined) => gb == null ? '' : gb >= 1000 ? `${+(gb / 1000).toFixed(2)} TB` : `${+gb.toFixed(1)} GB`;
export const gbText = (v: number | null | undefined) => v == null ? '' : v >= 1000 ? `${+(v / 1000).toFixed(1)} TB` : `${+(+v).toFixed(1)} GB`;
export const parseSizeGB = (t: string | null | undefined) => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(TB|GB)\s*$/i.exec(t || '');
  return m ? +m[1] * (m[2].toUpperCase() === 'TB' ? 1000 : 1) : null;
};
export const STORAGE_CATS = /^(HDD|SSD|NVMe SSD|USB \/ Flash)$/;

export const fmtMs = (ms: number | null | undefined) => ms == null ? '' : ms < 1 ? 'under 1 ms' : `${Math.round(ms)} ms`;
/* The server's timestamps are UTC without a zone ("2026-10-31 14:30:00"). */
export const utcDate = (ts: string) => new Date(String(ts).replace(' ', 'T') + 'Z');
export const clock = (ts: string) => utcDate(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: FMT.clock === 'auto' ? undefined : FMT.clock === '12' });

export function timeAgo(ts: string | null | undefined, now = Date.now()) {
  if (!ts) return '';
  const d = utcDate(ts);
  const s = (now - d.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return fmtLocalDay(d);
}

/* "for 5 min", "for 2 h", "for 3 days" since a UTC timestamp. */
export function forHowLong(ts: string | null | undefined, now = Date.now()) {
  if (!ts) return '';
  const m = Math.max(0, (now - utcDate(ts).getTime()) / 60000);
  if (m < 1) return 'for under a minute';
  if (m < 60) return `for ${Math.floor(m)} min`;
  if (m < 48 * 60) return `for ${Math.floor(m / 60)} h${m % 60 >= 1 && m < 600 ? ` ${Math.floor(m % 60)} min` : ''}`;
  return `for ${Math.floor(m / 1440)} days`;
}

/* A duration in seconds, for the uptime report. */
export const duration = (s: number) => s < 60 ? (s ? 'under a minute' : '') : s < 3600 ? `${Math.round(s / 60)} min`
  : s < 172800 ? `${(s / 3600).toFixed(s < 36000 ? 1 : 0)} h` : `${Math.round(s / 86400)} days`;

/* "SAS/SATA" chips: each connection in or out of the list. */
export const splitTokens = (v: unknown) => String(v || '').split(/\s*\/\s*/).map(x => x.trim()).filter(Boolean);
export function toggleToken(value: string, token: string) {
  const t = splitTokens(value);
  const i = t.indexOf(token);
  if (i >= 0) t.splice(i, 1); else t.push(token);
  return t.join('/');
}

export function genPassword(len = 24) {
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+?';
  const limit = Math.floor(2 ** 32 / cs.length) * cs.length;
  const buf = new Uint32Array(1), out: string[] = [];
  while (out.length < len) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) out.push(cs[buf[0] % cs.length]);
  }
  return out.join('');
}

export function b32decode(s: string) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0;
  const out: number[] = [];
  for (const c of s.toUpperCase().replace(/=+$/, '')) {
    const i = A.indexOf(c);
    if (i < 0) continue;
    val = ((val << 5) | i) & 0xffff;
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export async function totpNow(secret: string, at = Date.now(), period = 30, digits = 6) {
  const key = await crypto.subtle.importKey('raw', b32decode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const ctr = Math.floor(at / 1000 / period);
  const buf = new ArrayBuffer(8), dv = new DataView(buf);
  dv.setUint32(0, Math.floor(ctr / 2 ** 32));
  dv.setUint32(4, ctr >>> 0);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const o = sig[sig.length - 1] & 15;
  const code = (((sig[o] & 127) << 24) | (sig[o + 1] << 16) | (sig[o + 2] << 8) | sig[o + 3]) % 10 ** digits;
  return String(code).padStart(digits, '0');
}
export const splitCode = (c: string) => (c && c.length === 6 ? `${c.slice(0, 3)} ${c.slice(3)}` : c || '');

/* "this phone", "this tablet", "this computer": the words the design system uses for the device in hand. */
export function deviceWord() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) || (/Android/.test(ua) && !/Mobile/.test(ua))) return 'tablet';
  if (/iPhone|iPod|Android|Mobile/.test(ua)) return 'phone';
  return 'computer';
}
export function deviceKind() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'computer';
}
export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = IS_MAC ? '⌘' : 'Ctrl';
export const hasKeyboard = () => matchMedia('(hover: hover) and (pointer: fine)').matches;

export function badgeClass(status: string | null | undefined) {
  const s = (status || '').toLowerCase();
  return /^(active|running|in stock|new|built$|have$)/.test(s) ? 'ok'
    : /^(standby|testing|spare|reserved|planned|installed|planning|ordering|building|ordered)/.test(s) ? 'info'
      : /^(in repair|rma|used - fair)/.test(s) ? 'warn' : /^(broken|faulty)/.test(s) ? 'bad' : 'muted';
}

export const VIRTUAL_TYPES = ['Virtual Machine', 'Container'];
export const isVirtual = (v: Row) => VIRTUAL_TYPES.includes(v.device_type) || !!v.host_id;

/* Which kind of slot a connection belongs to. */
export function slotKindOf(iface: string | null | undefined) {
  const k = String(iface || '').toLowerCase();
  if (!k) return 'Drive bays';
  if (/ddr|dimm/.test(k)) return 'Memory slots';
  if (/m\.?2/.test(k)) return 'M.2 slots';
  if (/pcie|ocp|mezz/.test(k)) return 'PCIe slots';
  if (/sfp/.test(k)) return 'Network ports (SFP)';
  if (/lga|am\d|sp\d|socket|c32|g34/.test(k)) return 'CPU sockets';
  if (/hot-swap|atx|sfx|psu/.test(k)) return 'Power supply bays';
  if (/sas|sata|u\.2|raid|bay|drive/.test(k)) return 'Drive bays';
  return 'Other';
}

/* Save text as a file. */
export function downloadText(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* HaRM's own files: the online demo serves them from a sub-folder. */
export const asset = (p: string) => (window.harmDemo ? 'static/' : '/static/') + p;
