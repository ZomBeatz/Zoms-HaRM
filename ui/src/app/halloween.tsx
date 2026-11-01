/* Graveyard Shift, the hidden Halloween theme. Two ways to find it: type b-o-o anywhere (on a
   computer), or, during Halloween week, catch the bat that flies across the screen once. */
import { useEffect, useState } from 'react';
import { useApp } from '../lib/state';
import { prefSet } from '../lib/util';
import { toast } from '../ui/overlay';
import { applyTheme, themeName, themeUnlocked } from './theme';

/* Switches to Graveyard Shift (or back to ZomBeatz if it's already on). */
export function toggleGraveyard() {
  const first = !themeUnlocked('graveyard');
  prefSet('harm-graveyard', '1');
  const next = themeName() === 'graveyard' ? 'zombeatz' : 'graveyard';
  applyTheme(next);
  toast(next === 'graveyard' ? (first ? '🎃 Graveyard Shift unlocked! Switch any time in Settings > Appearance.' : '🎃 Graveyard Shift on') : 'Back to ZomBeatz');
  useApp.setState(s => ({ lkTick: s.lkTick + 1 }));
}

let typed = '';
/* Fed every single-key press that isn't a shortcut (see app/globals.ts). */
export function onKeyForBoo(key: string) {
  typed = (typed + key.toLowerCase()).slice(-3);
  if (typed !== 'boo') return false;
  typed = '';
  toggleGraveyard();
  return true;
}

/* October 24 to November 1, on this device's calendar. */
export function halloweenWeek(d = new Date()) {
  return (d.getMonth() === 9 && d.getDate() >= 24) || (d.getMonth() === 10 && d.getDate() === 1);
}

export function NightBat() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!halloweenWeek() || themeUnlocked('graveyard')) return;
    try { if (sessionStorage.getItem('harm-bat')) return; } catch { /* storage blocked: it may fly again */ }
    const t = setTimeout(() => {
      setShow(true);
      try { sessionStorage.setItem('harm-bat', '1'); } catch { /* fine */ }
    }, 15000 + Math.random() * 25000);
    return () => clearTimeout(t);
  }, []);
  // With reduced motion the bat doesn't fly; it waits in a corner for a while instead.
  useEffect(() => {
    if (!show) return;
    const t = setTimeout(() => setShow(false), 12000);
    return () => clearTimeout(t);
  }, [show]);
  if (!show) return null;
  return (
    <button type="button" className="night-bat" aria-label="A bat" title="🦇"
      onClick={() => { setShow(false); toggleGraveyard(); }} onAnimationEnd={e => { if (e.target === e.currentTarget) setShow(false); }}>
      <svg viewBox="-40 -26 80 50" aria-hidden="true"><path fill="currentColor" d="M 0 -6 C 6 -14 14 -16 24 -22 C 22 -12 28 -6 36 -4 C 28 0 22 2 18 10 C 12 4 6 6 0 12 C -6 6 -12 4 -18 10 C -22 2 -28 0 -36 -4 C -28 -6 -22 -12 -24 -22 C -14 -16 -6 -14 0 -6 Z" />
        <ellipse fill="currentColor" cx="0" cy="2" rx="7" ry="10" /><path fill="currentColor" d="M -6 -5 L -7 -14 L -2 -8 L 2 -8 L 7 -14 L 6 -5 Z" /></svg>
    </button>
  );
}
