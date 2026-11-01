/* What the whole app shares. `S` holds plain values that don't redraw anything (filters, the last
 * tab, in-app history); `useApp` holds what the interface draws from (who's signed in, lookups). */
import { create } from 'zustand';
import type { Row } from './util';
import type { Lookups } from '../api/types';

export interface AuthStatus {
  setup: boolean; authenticated: boolean; totp_enabled: boolean; idle_minutes: number;
  version?: string; release?: string; [k: string]: unknown;
}

export const S = {
  auth: null as AuthStatus | null,
  authed: false,
  enums: {} as Record<string, string[]>,
  caps: {} as Row,
  lk: { locations: [], racks: [], devices: [], services: [], networks: [], clusters: [], credentials: [] } as Lookups,
  hist: [] as { hash: string; title: string }[],
  filters: { devices: {}, components: { tab: 'spares' }, vault: {} } as Record<string, Row>,
  tabs: {} as Record<string, string>,
  lastActivity: Date.now(),
  lastPing: Date.now(),
  version: '' as string,
  updateShown: false,
  pageTitle: '',
  devFiltersOpen: false,
  devVisible: [] as number[],
  lastNoteKind: 'note',
  showAllNotes: '',
  wizSticky: {} as Row,
  pc: null as Row | null,
  aiConf: null as Row | null,
  ai: null as Row | null,
  statusPrev: null as Map<number, string> | null,
  statusPrevSvc: null as Map<number, string> | null,
  brandClicks: [] as number[],
};

export type Screen = 'boot' | 'auth' | 'app' | 'error';

interface AppState {
  screen: Screen;
  authMsg: string;
  startError: string;
  /* Bumped to redraw the page with fresh data (after a save, a delete…). */
  tick: number;
  /* Bumped when lookups or settings change, so the shell redraws. */
  lkTick: number;
  installPrompt: BeforeInstallPromptEvent | null;
  updateReady: boolean;
}

export const useApp = create<AppState>(() => ({
  screen: 'boot', authMsg: '', startError: '', tick: 0, lkTick: 0, installPrompt: null, updateReady: false,
}));

/* Load the current page's data again and redraw it. */
export const rerender = () => useApp.setState(s => ({ tick: s.tick + 1 }));
