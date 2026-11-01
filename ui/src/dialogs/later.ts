/* Dialogs that load the first time they're opened, so HaRM's first page shows sooner. */
import type { Row } from '../lib/util';
import type { FormCtl } from '../ui/form';
import { toast } from '../ui/overlay';

type After = (() => unknown) | null | undefined;

// The code can't be downloaded after HaRM was updated while this tab stayed open.
const load = <T,>(get: () => Promise<T>) => get().catch(e => {
  toast('HaRM was updated. Reload the page to open this.', 'bad', { label: '⟳ Reload', onClick: () => location.reload() });
  throw e;
});

export const aiAssist = (preset?: Row) => load(() => import('./ai')).then(m => m.aiAssist(preset));
export const libraryLookup = (form: FormCtl) => load(() => import('./library')).then(m => m.libraryLookup(form));
export const editAlerts = (after?: After) => load(() => import('./watch')).then(m => m.editAlerts(after));
export const editNetwatch = (after?: After) => load(() => import('./watch')).then(m => m.editNetwatch(after));
export const installApp = () => load(() => import('./phone')).then(m => m.installApp());
export const phoneAppHelp = () => load(() => import('./phone')).then(m => m.phoneAppHelp());
