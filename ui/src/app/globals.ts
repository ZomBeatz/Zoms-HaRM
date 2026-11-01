/* Things that watch the whole page: the idle lock, keyboard shortcuts, the installable app. */
import { api } from '../api/client';
import { S, useApp } from '../lib/state';
import { prefSet } from '../lib/util';
import { anyModalOpen, toast } from '../ui/overlay';
import { checkVersion, showAuth } from './session';
import { onKeyForBoo } from './halloween';
import { applyLook, look } from '../lib/look';
import { applyTheme, themePrefs } from './theme';
import { editCredential, editEntity } from '../lib/forms';
import { ACTION_TEMPLATES, editAction } from '../lib/actions';
import { aiAssist, editAlerts, editNetwatch, phoneAppHelp } from '../dialogs/later';
import { scanDialog } from '../dialogs/scan';

export function toggleNavFold() {
  const on = !document.body.classList.contains('nav-folded');
  document.body.classList.toggle('nav-folded', on);
  prefSet('harm-nav-folded', on ? '1' : '0');
}

export function installGlobals() {
  applyLook();
  window.toast = toast;  // the online demo's welcome-back message
  // For the guide's screenshot script (zombeatz-docs/scripts/harm-screenshots.mjs) and debugging.
  window.harm = { editEntity, editCredential, editAction, ACTION_TEMPLATES, editAlerts, editNetwatch, aiAssist, phoneAppHelp, scanDialog, showAuth };

  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => {
    if (themePrefs().mode === 'auto') applyTheme();
  });

  for (const ev of ['mousemove', 'keydown', 'click', 'scroll', 'touchstart']) {
    addEventListener(ev, () => { S.lastActivity = Date.now(); }, { passive: true });
  }
  setInterval(async () => {
    if (!S.authed || !S.auth || look().wall) return;  // a wall display never locks itself
    const idleMs = S.auth.idle_minutes * 60000;  // 0: only when locked by hand (Settings > Locking)
    const now = Date.now();
    if (idleMs && now - S.lastActivity > idleMs) {
      try { await api('POST', '/auth/logout'); } catch { /* ignore */ }
      showAuth('Locked after inactivity.');
    } else if (now - S.lastActivity < 60000 && now - S.lastPing > 4 * 60000) {
      // Keep the server session alive while the user is actively working.
      api('GET', '/auth/status').then(st => { checkVersion(st); if (!st.authenticated) showAuth('Your session ended. Please unlock again.'); }).catch(() => {});
    }
  }, 15000);

  // Installable app: register the service worker and keep Chrome's install prompt for our own button.
  if ('serviceWorker' in navigator && window.isSecureContext && !window.harmDemo) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { /* untrusted certificate etc. */ });
  }
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); useApp.setState({ installPrompt: e as BeforeInstallPromptEvent }); });
  addEventListener('appinstalled', () => { useApp.setState({ installPrompt: null }); toast('HaRM installed as an app'); });
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && !look().wall) document.body.classList.remove('wall'); });

  /* The same keys as every ZomBeatz product. Ctrl +/−/0 is the browser's own zoom. */
  addEventListener('keydown', e => {
    if (!S.authed || e.isComposing) return;
    const target = e.target as HTMLElement;
    const typing = target.closest && target.closest('input,textarea,select,[contenteditable]');
    const inDialog = anyModalOpen();
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      if (inDialog) return;
      const box = document.querySelector<HTMLInputElement>('.topbar input[type=search]');
      if (box) { e.preventDefault(); box.focus(); box.select(); }
      return;
    }
    // Single keys never fire while typing, with a dialog open, or with Ctrl/⌘/Alt held.
    if (typing || inDialog || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') {
      const box = document.querySelector<HTMLInputElement>('#view input[type=search]') || document.querySelector<HTMLInputElement>('.topbar input[type=search]');
      if (box) { e.preventDefault(); box.focus(); }
    } else if (e.key === 'n' || e.key === 'N') {
      const b = document.querySelector<HTMLButtonElement>('.qa-btn');
      if (b) { e.preventDefault(); b.click(); setTimeout(() => document.querySelector<HTMLButtonElement>('.qa-menu:not([hidden]) button')?.focus(), 0); }
    } else if (e.key === '?') {
      e.preventDefault();
      location.hash = '#/help?s=keys';
    } else if (e.key === '[' && matchMedia('(min-width: 701px)').matches) {
      e.preventDefault();
      toggleNavFold();
    } else if (e.key.length === 1) {
      onKeyForBoo(e.key);
    }
  });
}
