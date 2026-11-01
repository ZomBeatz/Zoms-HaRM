/* Signing in and out, and noticing that HaRM was updated. */
import { api, GET, loadLookups } from '../api/client';
import { S, useApp } from '../lib/state';
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
  await loadLookups();
  S.authed = true;
  useApp.setState({ screen: 'app', authMsg: '' });
}

export async function lockNow() {
  try { await api('POST', '/auth/logout'); } catch { /* ignore */ }
  showAuth('Locked.');
}
