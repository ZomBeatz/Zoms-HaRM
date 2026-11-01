/* Types for the server's replies. Records come from entities.ts (generated); the rest are the
 * shapes of the bigger pages' replies. */
import type { Cluster, Credential, Device, Location, Network, Rack, Service } from './entities';
export * from './entities';

export interface Lookups {
  locations: Location[]; racks: Rack[]; devices: Device[]; services: Service[]; networks: Network[];
  clusters: Cluster[]; credentials: Credential[];
}
export type LookupName = keyof Lookups;
export const LOOKUPS = ['locations', 'racks', 'devices', 'services', 'networks', 'clusters'] as const;

/* One address's answer on the Status page. */
export interface OnlineState {
  state: 'up' | 'down' | 'unknown' | 'unwatched' | 'off' | 'no-address';
  address?: string | null; label?: string | null; method?: string | null; latency_ms?: number | null;
  since?: string | null; checked_at?: string | null; uptime?: number | null; strip?: (string | null)[];
}
export interface ServiceState {
  id: number; name: string; state: 'up' | 'down' | 'unknown'; detail?: string | null; latency_ms?: number | null;
  checked_at?: string | null; cert_expires?: string | null; device_id?: number;
}
export interface DeviceOnline extends OnlineState { others: OnlineState[]; services?: ServiceState[] }
