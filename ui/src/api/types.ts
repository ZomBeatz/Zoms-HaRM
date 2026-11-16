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
  docker: DockerSummary | null;
  machine: boolean;
}

/* The last containers read on a device (Containers tab, Status). */
export interface DockerSummary { at: string | null; total: number; problems: string[]; updates: string[] }
export interface Container {
  name: string; image: string; image_id: string; state: string; health: string | null; started: string; restarts: number;
  project: string; service: string; workdir: string; configs: string; ports: string[];
}
export interface DockerSnap {
  at: string; checked_at?: string; containers: Container[]; updates?: Record<string, 'update' | 'current' | 'unknown'>;
  versions?: Record<string, { now?: string; new?: string }>;
}
export interface DockerConf { host?: string; port?: number; credential_id?: number | null; sudo?: boolean }

/* A machine's health and updates (Device > Health, Maintenance). */
export interface Problem { key: string; level: 'bad' | 'warn' | 'info'; text: string; container?: string; device?: string; device_id?: number }
export interface Smart { health: 'ok' | 'failing' | 'unknown'; hours: number | null; temp: number | null; realloc: number | null; pending: number | null; wear: number | null; note: string }
export interface Disk { name: string; size: number; rotational: boolean; tran: string; model: string; serial: string; virtual: boolean; smart: Smart | null }
export interface Volume { source: string; type: string; size: number; used: number; avail: number; mount: string; pct: number }
export interface Package { name: string; now: string; new: string; security: boolean }
export interface BackupCheck { kind: 'folder' | 'zfs'; path: string; hours: number; name: string; newest?: string | null; file?: string; missing?: boolean; unread?: boolean }
export interface MachineSnap {
  at: string; restarted_at?: string; root: boolean; smartctl: boolean;
  os: { name: string; id: string; version: string; kernel: string; hostname: string; pve: string };
  uptime_s: number | null; load: number[]; cpus: number | null;
  mem: { total: number | null; avail: number | null; swap_total: number | null; swap_free: number | null };
  volumes: Volume[]; disks: Disk[];
  pools: { name: string; size: number; alloc: number; free: number; health: string }[];
  md: { name: string; state: string; level: string; degraded: boolean }[];
  reboot: { needed: boolean; why: string[]; kernel_now: string; kernel_new: string; packages: string[] };
  updates: { manager: string | null; refreshed: boolean; count: number; security: number; packages: Package[] };
  backups: BackupCheck[];
}
export interface MachineLabel { name?: string; real?: string; ignore?: boolean }
export interface MachineView {
  conf: DockerConf; snap: MachineSnap | null; labels: Record<string, MachineLabel>; backups: BackupCheck[]; problems: Problem[];
  error: { at: string; error: string } | null; background: { on: boolean; label: string; since: string | null };
}
export interface PveGuest { vmid: string; name: string; node: string; type: 'qemu' | 'lxc'; status: string; template: boolean; cpu: number; cpus: number; mem: number; maxmem: number; uptime: number; lock: string }
export interface Maintenance {
  machines: { id: number; name: string; at: string | null; os: string | null; problems: Problem[]; error: { at: string; error: string } | null;
    updates: { count: number; security: number; manager: string | null; packages: Package[] }; reboot: boolean; uptime_s: number | null;
    backups: BackupCheck[]; background: boolean; docker_at: string | null }[];
  containers: { device_id: number; device: string; name: string; image: string; project: string; now?: string; new?: string }[];
  proxmox: { at: string; guests: PveGuest[]; backups: Record<string, { ctime: number; storage: string; size: number }>; backups_error: string } | null;
  proxmox_problems: Problem[]; proxmox_ready: boolean;
  background: { on: boolean; hours: number; last: { at: string; machines: string[] } | null; next: string | null; proxmox: boolean };
}
export interface MaintenanceSummary { problems: Problem[]; updates: number; security: number; containers: number; reboot: number }
