/* Who's answering: the words for each state, the 24-hour strip, certificate dates, checks and wake-ups. */
import { api, GET } from '../api/client';
import type { OnlineState, ServiceState } from '../api/types';
import { toast } from '../ui/overlay';
import { clock, fmtMs, nz, timeAgo } from './util';

/* The words for each online state. A word every time, never a dot alone (design system). */
export const ONLINE: Record<string, [string, string]> = {
  up: ['Online', 'ok'], down: ['Offline', 'bad'], unknown: ['Not checked yet', 'muted'],
  unwatched: ['Not checked', 'muted'], off: ['Not hooked up', 'muted'], 'no-address': ['No address', 'muted'],
};
const SERVICE_STATE: Record<string, [string, string]> = { up: ['Answering', 'ok'], down: ['Not answering', 'bad'], unknown: ['Not checked', 'muted'] };
export const onlineWord = (state: string) => (ONLINE[state] || ONLINE.unknown);

export function ServicePill({ sv }: { sv: ServiceState }) {
  const [word, cls] = SERVICE_STATE[sv.state] || SERVICE_STATE.unknown;
  return <span className={`badge ${cls}`} title={nz(sv.detail, sv.checked_at ? `checked ${timeAgo(sv.checked_at)}` : '')}>{word}</span>;
}

/* "runs out Nov 12" (amber within 30 days, red once it has). */
export function CertText({ date }: { date?: string | null }) {
  if (!date) return null;
  const d = new Date(date + 'T00:00:00Z');
  const days = Math.round((d.getTime() - Date.now()) / 864e5);
  const when = d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getUTCFullYear() !== new Date().getFullYear() ? 'numeric' : undefined, timeZone: 'UTC' });
  return <span className={days < 0 ? 'bad-text' : days <= 30 ? 'warn-text' : 'muted'}>{days < 0 ? `ran out ${when}` : `runs out ${when}`}</span>;
}

export function onlineTitle(st: OnlineState) {
  if (st.state === 'up') return `Answered${st.method ? ` on ${st.method}` : ''}${st.latency_ms != null ? ` in ${fmtMs(st.latency_ms)}` : ''}${st.checked_at ? `, checked ${timeAgo(st.checked_at)}` : ''}`;
  if (st.state === 'down') return `No answer${st.since ? ` since ${clock(st.since)}` : ''}${st.checked_at ? `, checked ${timeAgo(st.checked_at)}` : ''}`;
  if (st.state === 'unwatched') return '“Check if it’s online” is off for this device';
  if (st.state === 'off') return 'Only devices that are hooked up are checked';
  return 'HaRM hasn’t checked it yet';
}
export function OnlinePill({ st }: { st: OnlineState }) {
  const [word, cls] = onlineWord(st.state);
  return <span className={`badge ${cls}`} title={onlineTitle(st)}>{word}</span>;
}
export const StateBadge = ({ state }: { state: string }) => <span className={`badge ${onlineWord(state)[1]}`}>{onlineWord(state)[0]}</span>;

/* The last 24 hours as 24 small bars, with the share of time it answered. */
export function HistoryStrip({ st }: { st: OnlineState }) {
  if (!st.strip) return null;
  const pct = st.uptime == null ? null : st.uptime * 100;
  const up = pct == null ? '' : `${pct >= 99.95 || pct === 0 ? Math.round(pct) : pct.toFixed(1)}%`;
  const label = up ? `Last 24 hours: online ${up} of the time` : 'Last 24 hours';
  return (
    <div className="hstrip" title={label}>
      <div className="hstrip-bars" role="img" aria-label={label}>{st.strip.map((b, i) => <i key={i} className={`hs-${b || 'none'}`} />)}</div>
      <span className="hstrip-n">{up ? `${up} up` : ''}</span>
    </div>
  );
}

export async function checkDevice(id: number, name: string) {
  try {
    await api('POST', '/status/check', { device_id: id });
    const st = (await GET(`/devices/${id}/full`)).online;
    toast(`${name}: ${onlineWord(st.state)[0]}${st.state === 'up' && st.latency_ms != null ? `, ${fmtMs(st.latency_ms)}` : ''}`, st.state === 'down' ? 'bad' : 'ok');
  } catch (e) { toast((e as Error).message, 'bad'); }
}

export async function wakeDevice(id: number, name: string) {
  try {
    const r = await api('POST', `/devices/${id}/wake`);
    toast(`Wake-up sent to ${name} (${r.mac}). It can take a minute to start.`);
  } catch (e) { toast((e as Error).message, 'bad'); }
}
