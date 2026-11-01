/* Types for the server's replies. Records come from entities.ts (generated); the rest are the
 * shapes of the bigger pages' replies. */
import type { Action, Build, Cluster, Component, Connection, Credential, Device, DeviceSlot, Interface, Location, Network, Note, Rack, Service } from './entities';
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

/* Totals the server works out (drives by size, memory sticks, CPUs). */
type Summary = Record<string, any>;

/* A slot on a device's page, with what's in it and the spare parts that would fit. */
export interface SlotUsage extends DeviceSlot {
  bays: (number | null)[]; overflow: number; placed: Record<number, number>; used: number;
  storage: Summary | null; drive_bay: boolean; compatible: Component[];
}

/* GET /devices/{id}/full: everything on a device's page. */
export interface DeviceFull {
  device: Device; rack: Rack | null; cluster: Cluster | null;
  interfaces: Interface[]; services: Service[]; credentials: Credential[]; components: Component[];
  storage: Summary; memory: Summary; cpus: Summary;
  notes: Note[]; slots: SlotUsage[]; connections: Connection[]; actions: Action[];
  builds: Pick<Build, 'id' | 'name' | 'status'>[];
  guests: Device[]; guest_totals: { count: number; vcpus: number; ram_gb: number; disk_gb: number; running: number };
  online: DeviceOnline; can_wake: boolean; power: Summary | null;
}
