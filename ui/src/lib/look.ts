/* How HaRM looks and reads on this device (Settings > Appearance), kept with the theme in this
   browser's storage, so a phone and a wall screen can differ. harm/static/theme.js applies the
   page-wide parts (text size, density, motion) before the page draws. */
import { FMT, prefGet, prefSet } from './util';

export interface Look {
  text: 'normal' | 'large' | 'larger';
  density: 'comfy' | 'compact';
  dates: typeof FMT.dates;
  clock: typeof FMT.clock;
  length: typeof FMT.length;
  motion: 'auto' | 'reduce';
  sound: boolean;
  contrast: 'normal' | 'high';
  /* A screen on the wall: opens on Status, full window, never locks itself (see Settings). */
  wall: boolean;
  /* Sidebar pages left out of the menu on this device (still reachable by search and links). */
  hideNav: string[];
  notesOrder: 'newest' | 'oldest';
  hideDone: boolean;
}
const DEFAULTS: Look = { text: 'normal', density: 'comfy', dates: 'iso', clock: 'auto', length: 'mm', motion: 'auto', sound: false,
  contrast: 'normal', wall: false, hideNav: [], notesOrder: 'newest', hideDone: false };

export function look(): Look {
  try { return { ...DEFAULTS, ...JSON.parse(prefGet('harm-look') || '{}') }; } catch { return { ...DEFAULTS }; }
}

export function applyLook(l = look()) {
  const r = document.documentElement;
  r.dataset.text = l.text;
  r.dataset.density = l.density;
  r.dataset.motion = l.motion;
  r.dataset.contrast = l.contrast;
  Object.assign(FMT, { dates: l.dates, clock: l.clock, length: l.length });
}

export function setLook(changes: Partial<Look>) {
  const next = { ...look(), ...changes };
  prefSet('harm-look', JSON.stringify(next));
  applyLook(next);
}

/* The person (or their computer) asked for less movement. */
export const calm = () => look().motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Settings > Appearance > Sound when something goes offline: two short notes, and a buzz on phones.
   Only while the Status page is open; browsers allow sound once you've used the page. */
export function alertChime() {
  try { navigator.vibrate?.([180, 80, 180]); } catch { /* no vibration */ }
  try {
    const ctx = new AudioContext();
    [[880, 0], [660, 0.22]].forEach(([hz, at]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.2);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + at);
      o.stop(ctx.currentTime + at + 0.22);
    });
    setTimeout(() => ctx.close(), 800);
  } catch { /* no sound here */ }
}
