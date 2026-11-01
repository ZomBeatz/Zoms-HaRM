/* Which page each address opens. */
import { lazy, useEffect, type ComponentType, type ReactNode } from 'react';
import { editEntity } from '../lib/forms';
import Dashboard from '../pages/Dashboard';

/* Every page but Home loads the first time it's opened, or quietly a few seconds after HaRM starts
   (prefetchPages), so going to a page later only waits for its data. */
const loaders: (() => Promise<unknown>)[] = [];
const page = <T,>(load: () => Promise<T>, pick: (m: T) => ComponentType<any>) => {
  loaders.push(load);
  return lazy(() => load().then(m => ({ default: pick(m) })));
};
export function prefetchPages() {
  for (const load of loaders) load().catch(() => { /* fetched again when opened */ });
}
const Status = page(() => import('../pages/Status'), m => m.default);
const Uptime = page(() => import('../pages/Uptime'), m => m.default);
const Actions = page(() => import('../pages/Actions'), m => m.default);
const Devices = page(() => import('../pages/Devices'), m => m.default);
const Device = page(() => import('../pages/Device'), m => m.default);
const Racks = page(() => import('../pages/Racks'), m => m.Racks);
const Rack = page(() => import('../pages/Racks'), m => m.Rack);
const Components = page(() => import('../pages/Components'), m => m.default);
const Connections = page(() => import('../pages/Lists'), m => m.Connections);
const Audit = page(() => import('../pages/Lists'), m => m.Audit);
const Vault = page(() => import('../pages/Lists'), m => m.Vault);
const Search = page(() => import('../pages/Lists'), m => m.Search);
const Locations = page(() => import('../pages/Locations'), m => m.Locations);
const Location = page(() => import('../pages/Locations'), m => m.Location);
const Networks = page(() => import('../pages/Networks'), m => m.Networks);
const Network = page(() => import('../pages/Networks'), m => m.Network);
const Discover = page(() => import('../pages/Discover'), m => m.default);
const Virtual = page(() => import('../pages/Virtual'), m => m.Virtual);
const Cluster = page(() => import('../pages/Virtual'), m => m.Cluster);
const Setup = page(() => import('../pages/Setup'), m => m.default);
const Builds = page(() => import('../pages/Builder'), m => m.Builds);
const Build = page(() => import('../pages/Builder'), m => m.Build);
const Library = page(() => import('../pages/Builder'), m => m.Library);
const Export = page(() => import('../pages/Export'), m => m.default);
const Tasks = page(() => import('../pages/Tasks'), m => m.default);
const Help = page(() => import('../pages/Help'), m => m.default);
const Settings = page(() => import('../pages/Settings'), m => m.default);

type Render = (m: RegExpMatchArray, q: URLSearchParams) => ReactNode;

function ScanPart() {
  useEffect(() => {
    location.replace('#/components');
    setTimeout(() => editEntity('components', { status: 'In Stock', quantity: 1 }, null, { autoScan: true }), 300);
  }, []);
  return null;
}

export const ROUTES: [RegExp, Render][] = [
  [/^\/?(dashboard)?$/, () => <Dashboard />],
  [/^\/status$/, () => <Status />],
  [/^\/actions$/, () => <Actions />],
  [/^\/uptime$/, (_m, q) => <Uptime q={q} />],
  [/^\/devices$/, () => <Devices />],
  [/^\/devices\/(\d+)$/, (m, q) => <Device id={+m[1]} q={q} />],
  [/^\/racks$/, () => <Racks />],
  [/^\/racks\/(\d+)$/, m => <Rack id={+m[1]} />],
  [/^\/components$/, (_m, q) => <Components q={q} />],
  [/^\/connections$/, () => <Connections />],
  [/^\/locations$/, () => <Locations />],
  [/^\/locations\/(\d+)$/, m => <Location id={+m[1]} />],
  [/^\/networks$/, () => <Networks />],
  [/^\/networks\/(\d+)$/, m => <Network id={+m[1]} />],
  [/^\/discover$/, () => <Discover />],
  [/^\/virtual$/, () => <Virtual />],
  [/^\/clusters\/(\d+)$/, m => <Cluster id={+m[1]} />],
  [/^\/setup$/, () => <Setup />],
  [/^\/builds$/, () => <Builds />],
  [/^\/builds\/(\d+)$/, m => <Build id={+m[1]} />],
  [/^\/library$/, () => <Library />],
  [/^\/export$/, (_m, q) => <Export q={q} />],
  [/^\/tasks$/, () => <Tasks />],
  [/^\/scan-part$/, () => <ScanPart />],
  [/^\/help$/, (_m, q) => <Help section={q.get('s')} />],
  [/^\/vault$/, (_m, q) => <Vault q={q} />],
  [/^\/audit$/, () => <Audit />],
  [/^\/settings$/, () => <Settings />],
  [/^\/search$/, (_m, q) => <Search q={q.get('q') || ''} />],
];
