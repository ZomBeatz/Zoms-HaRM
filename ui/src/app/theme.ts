/* Themes and light/dark, remembered per device (phone and computer can differ). */
import { asset, deviceWord, prefGet } from '../lib/util';
import { calm } from '../lib/look';

export const THEMES: Record<string, { name: string; blurb: string; icon: string; anim?: string; hidden?: boolean; swatches: Record<string, string[]> }> = {
  zombeatz: { name: 'ZomBeatz', blurb: 'Brand blue with orange highlights. The default.', icon: 'icon.svg',
    swatches: { dark: ['#14161c', '#4fb0ec', '#ec6a3f'], light: ['#f4f5f8', '#2580c3', '#ec6a3f'] } },
  coolant: { name: 'Coolant', blurb: '❄ You found it. Liquid-cooled servers, mint and cyan.', icon: 'icon-coolant.svg', anim: 'icon-coolant-anim.svg', hidden: true,
    swatches: { dark: ['#14161c', '#5ff7cf', '#22d3ee'], light: ['#f4f5f8', '#0e9f8c', '#0891b2'] } },
  graveyard: { name: 'Graveyard Shift', blurb: '🎃 You found it. Pumpkin orange and witching-hour purple, for the night shift.', icon: 'icon-graveyard.svg', anim: 'icon-graveyard-anim.svg', hidden: true,
    swatches: { dark: ['#14161c', '#ff8a2a', '#b57cf5'], light: ['#f4f5f8', '#c2410c', '#7e22ce'] } },
};
export const MODES: [string, string][] = [['auto', `Match my ${deviceWord()}`], ['light', 'Light'], ['dark', 'Dark']];
/* data-product is "harm" for ZomBeatz, "harm-<name>" for the others. */
export const themeName = () => { const t = (document.documentElement.dataset.product || '').replace(/^harm-?/, ''); return THEMES[t] ? t : 'zombeatz'; };
/* The sidebar logo may be animated (Coolant); tab icons and theme previews stay still. */
export const themeIcon = () => { const t = THEMES[themeName()]; return asset(t.anim && !calm() ? t.anim : t.icon); };
export function themePrefs() {
  try { return { theme: localStorage.getItem('harm-theme') || 'zombeatz', mode: localStorage.getItem('harm-mode') || 'auto' }; }
  catch { return { theme: 'zombeatz', mode: 'auto' }; }
}
/* Hidden themes show in Settings once found (remembered per device). */
export const themeUnlocked = (t: string) => !THEMES[t]?.hidden || prefGet(`harm-${t}`) === '1' || themePrefs().theme === t;
export const coolantUnlocked = () => themeUnlocked('coolant');

export function applyTheme(theme?: string | null, mode?: string | null) {
  const p = themePrefs();
  const t = theme && THEMES[theme] ? theme : (THEMES[p.theme] ? p.theme : 'zombeatz');
  const m = mode || p.mode;
  try { localStorage.setItem('harm-theme', t); localStorage.setItem('harm-mode', m); } catch { /* not saved */ }
  const r = document.documentElement;
  r.dataset.product = t === 'zombeatz' ? 'harm' : `harm-${t}`;
  r.dataset.modePref = m;
  r.dataset.theme = m === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : m;
  document.querySelectorAll<HTMLImageElement>('img.brand-icon').forEach(i => { i.src = themeIcon(); });
  const fav = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (fav) fav.href = asset(THEMES[t].icon);
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(r).getPropertyValue('--bg').trim() || '#12151b';
}
