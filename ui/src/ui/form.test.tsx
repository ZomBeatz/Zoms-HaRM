import { describe, expect, it } from 'vitest';
import { S } from '../lib/state';
import { rackInLocation } from '../lib/lookups';
import { FormCtl } from './form';

S.lk.locations = [{ id: 1, name: 'House', parent_id: null }, { id: 2, name: 'Garage', parent_id: 1 }, { id: 3, name: 'Office', parent_id: null }] as any;
S.lk.racks = [{ id: 10, name: 'Rack A', location_id: 2, height_u: 42 }, { id: 11, name: 'Shelf', location_id: 3, height_u: null }] as any;

const rackPicked = (value: string, form: FormCtl) => {
  const r = S.lk.racks.find(x => String(x.id) === value);
  if (r && r.location_id && form.get('location_id') !== String(r.location_id)) form.set({ location_id: r.location_id });
};
const fields = () => [
  { k: 'name', label: 'Name', required: true },
  { k: 'location_id', label: 'Location', type: 'fk' as const, entity: 'locations' },
  { k: 'rack_id', label: 'Rack', type: 'fk' as const, entity: 'racks', scopeBy: ['location_id'], scope: rackInLocation, onChange: rackPicked },
  { k: 'rack_u', label: 'U', type: 'number' as const, showIf: (v: Record<string, any>) => !!v.rack_id, clearWhenHidden: true },
  { k: 'connected', label: 'Hooked up', type: 'checkbox' as const, default: true },
  { k: 'username', label: 'User', raw: true },
  { k: 'password', label: 'Password', type: 'password' as const },
  { k: '_kind', label: 'Kind', type: 'select' as const, virtual: true, required: true, options: ['A', 'B'] },
];

describe('forms', () => {
  it('starts from the record, with defaults', () => {
    const f = new FormCtl(fields(), { name: 'nas', rack_id: 10 });
    expect(f.get('name')).toBe('nas');
    expect(f.get('rack_id')).toBe('10');
    expect(f.get('connected')).toBe(true);
    expect(f.get('_kind')).toBe('A');
  });
  it('submits empty text as null, keeps raw and password text, and leaves out virtual fields', () => {
    const f = new FormCtl(fields(), {});
    f.set({ name: 'x', username: ' admin ', password: '' });
    expect(f.values()).toEqual({ name: 'x', location_id: null, rack_id: null, rack_u: null, connected: true, username: ' admin ', password: '' });
  });
  it('picking a holder moves the location to its room', () => {
    const f = new FormCtl(fields(), {});
    f.input('rack_id', '10');
    expect(f.get('location_id')).toBe('2');
    expect(f.get('rack_id')).toBe('10');
  });
  it('a location that the holder isn’t in empties the holder', () => {
    const f = new FormCtl(fields(), { location_id: 2, rack_id: 10, rack_u: 5 });
    f.input('location_id', '3');
    expect(f.get('rack_id')).toBe('');
    // The U field is hidden without a rack, so it's submitted empty.
    expect(f.values().rack_u).toBeNull();
  });
  it('only offers holders in the chosen location, and rooms inside it', () => {
    const f = new FormCtl(fields(), { location_id: 1 });
    expect(f.options(f.field('rack_id')!).map(o => o.label)).toEqual(['Rack A ()']);
  });
  it('keeps passwords out of drafts', () => {
    const f = new FormCtl(fields(), {});
    f.set({ name: 'x', password: 'secret' });
    expect(f.draftValues()).not.toHaveProperty('password');
  });
  it('points at the field a server error is about', () => {
    const f = new FormCtl(fields(), {});
    expect(f.flag('rack_u: must be a number')).toBe(true);
    expect(f.flagged).toBe('rack_u');
    expect(f.flag('Something else went wrong')).toBe(false);
  });
  it('shows inches but saves millimetres, and an untouched value saves exactly as it was', () => {
    const inches: [(v: unknown) => string, (t: string) => unknown] = [v => String(+(Number(v) / 25.4).toFixed(1)), t => Math.round(Number(t) * 25.4)];
    const f = new FormCtl([{ k: 'depth_mm', type: 'number', convert: inches }], { depth_mm: 1070 });
    expect(f.vals.depth_mm).toBe('42.1');
    expect(f.values().depth_mm).toBe(1070);
    f.input('depth_mm', '29');
    expect(f.values().depth_mm).toBe(737);
  });
});
