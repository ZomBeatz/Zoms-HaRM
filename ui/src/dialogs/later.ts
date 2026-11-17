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
export const connectDialog = (dev: Row) => load(() => import('./connect')).then(m => m.connectDialog(dev));
export const importBitwarden = (after?: After) => load(() => import('./vaultio')).then(m => m.importBitwarden(after));
export const exportBitwarden = () => load(() => import('./vaultio')).then(m => m.exportBitwarden());
export const changeOnMachine = (cred: Row, after?: After) => load(() => import('./vaultio')).then(m => m.changeOnMachine(cred, after));
export const changeManyOnMachines = (creds: Row[], after?: After) => load(() => import('./vaultio')).then(m => m.changeManyOnMachines(creds, after));
export const installApp = () => load(() => import('./phone')).then(m => m.installApp());
export const phoneAppHelp = () => load(() => import('./phone')).then(m => m.phoneAppHelp());
