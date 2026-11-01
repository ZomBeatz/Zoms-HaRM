/* Signing in and out, and noticing that HaRM was updated. */
import { api, GET, loadLookups } from '../api/client';
import { S, useApp } from '../lib/state';
import { FMT, prefGet } from '../lib/util';
import { look } from '../lib/look';
import { closeAllModals, toast } from '../ui/overlay';

export function showAuth(msg = '') {
  S.authed = false;
  closeAllModals();
  useApp.setState({ screen: 'auth', authMsg: msg });
}

/* After HaRM is updated/restarted, an open tab (or the phone app) offers a reload. */
export function checkVersion(st: { version?: string } | null) {
  if (!st || !st.version) return;
  if (!S.version) { S.version = st.version; return; }
  if (st.version !== S.version && !S.updateShown) {
    S.updateShown = true;
    toast('HaRM was updated.', 'ok', { label: '⟳ Reload', onClick: () => location.reload() });
    useApp.setState({ updateReady: true });
  }
}

export async function startApp() {
  S.auth = await api('GET', '/auth/status');
  checkVersion(S.auth);
  if (!S.auth!.authenticated) return showAuth();
  [S.enums, S.caps] = await Promise.all([GET('/meta/enums'), GET('/meta/capabilities').catch(() => ({}))]);
  FMT.currency = S.caps.currency || 'USD';
  await loadLookups();
  S.authed = true;
  openStartPage();
  useApp.setState({ screen: 'app', authMsg: '' });
}

/* Opening HaRM without a page in the address goes to the start page from Settings. */
function openStartPage() {
  if (location.hash && location.hash !== '#/' && location.hash !== '#') return;
  const start = look().wall ? 'status' : S.caps.start_page || 'dashboard';
  const to = start === 'last' ? prefGet('harm-last-page') : `#/${start}`;
  if (to && to !== '#/dashboard' && to.startsWith('#/')) history.replaceState(null, '', to);
}

export async function lockNow() {
  try { await api('POST', '/auth/logout'); } catch { /* ignore */ }
  showAuth('Locked.');
}
