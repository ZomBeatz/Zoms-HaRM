/* Which page each address opens. */
import { useEffect, type ReactNode } from 'react';
import { editEntity } from '../lib/forms';
import Dashboard from '../pages/Dashboard';
import Status from '../pages/Status';
import Uptime from '../pages/Uptime';
import Actions from '../pages/Actions';
import Devices from '../pages/Devices';
import Device from '../pages/Device';
import { Racks, Rack } from '../pages/Racks';
import Components from '../pages/Components';
import { Connections, Audit, Vault, Search } from '../pages/Lists';
import { Locations, Location } from '../pages/Locations';
import { Networks, Network } from '../pages/Networks';
import Discover from '../pages/Discover';
import { Virtual, Cluster } from '../pages/Virtual';
import Setup from '../pages/Setup';
import { Builds, Build, Library } from '../pages/Builder';
import Export from '../pages/Export';
import Tasks from '../pages/Tasks';
import Help from '../pages/Help';
import Settings from '../pages/Settings';

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
