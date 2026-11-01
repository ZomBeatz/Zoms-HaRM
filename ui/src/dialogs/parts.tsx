/* Moving a part into a device and back onto a shelf. */
import { api, GET } from '../api/client';
import { S, rerender } from '../lib/state';
import { rackInLocation } from '../lib/lookups';
import { nz, type Row } from '../lib/util';
import { toast } from '../ui/overlay';
import { formDialog } from '../ui/form';
import { rackPicked } from '../lib/forms';

type After = (() => unknown) | null | undefined;

export async function installDialog(comp: Row, deviceId?: number | null, after?: After) {
  let fits: Row[] = [];
  try { fits = await GET(`/components/${comp.id}/fits`); } catch { /* optional */ }
  const fitIds = new Map(fits.map(f => [f.device_id, f]));
  const devs = [...S.lk.devices].sort((a, b) => (+fitIds.has(b.id) - +fitIds.has(a.id)) || a.name.localeCompare(b.name));
  formDialog({
    title: `Install ${nz(comp.manufacturer, comp.model) || comp.category}`,
    fields: [
      { k: 'device_id', label: 'Into device', type: 'select', required: true,
        options: devs.map(d => ({ value: String(d.id), label: (fitIds.has(d.id) ? `★ ${d.name}: ${fitIds.get(d.id)!.free} free ${fitIds.get(d.id)!.slot}` : d.name) })) },
      comp.quantity > 1 ? { k: 'quantity', label: `How many (of ${comp.quantity})`, type: 'number', min: 1, default: 1 } : null,
    ],
    rec: { device_id: deviceId ? String(deviceId) : (fits[0] ? String(fits[0].device_id) : ''), quantity: 1 },
    extra: fits.length ? <p className="muted small">★ marks devices with a free slot matching this part’s interface and form factor.</p>
      : <p className="muted small">No device has a recorded free slot matching this part. Add slots on a device page to get suggestions.</p>,
    saveLabel: 'Install',
    submit: async v => { await api('POST', `/components/${comp.id}/install`, { device_id: v.device_id, quantity: v.quantity || 1 }); toast('Installed'); },
    onDone: () => (after || rerender)(),
  });
}

/* Fields a part can be re-created from (Undo after a delete). */
const KEEP_OUT = ['id', 'created_at', 'updated_at', 'device_name', 'location_name', 'rack_name'];

/* Deletes a part outright (added by mistake, or a scan read it wrong), with Undo in the message.
   Nothing goes to Spare Parts. */
export async function deletePart(comp: Row, after?: After) {
  const name = nz(comp.manufacturer, comp.model) || comp.category;
  try { await api('DELETE', `/components/${comp.id}`); }
  catch (e) { toast((e as Error).message, 'bad'); return; }
  (after || rerender)();
  toast(`Deleted ${name}`, 'ok', { label: 'Undo', onClick: async () => {
    const body = Object.fromEntries(Object.entries(comp).filter(([k]) => !KEEP_OUT.includes(k)));
    try { await api('POST', '/components', body); toast(`${name} is back`); (after || rerender)(); }
    catch (e) { toast((e as Error).message, 'bad'); }
  } });
}

export function uninstallDialog(comp: Row, after?: After) {
  const m = formDialog({
    title: `Remove ${nz(comp.manufacturer, comp.model) || comp.category} from ${comp.device_name}`,
    fields: [
      { k: 'status', label: 'New status', type: 'select', options: S.enums.component_statuses.filter(s => s !== 'Installed'), required: true, default: 'In Stock' },
      { k: 'location_id', label: 'Location (room)', type: 'fk', entity: 'locations' },
      { k: 'rack_id', label: 'Store in (holder)', type: 'fk', entity: 'racks', none: 'None (loose in the room)', scopeBy: ['location_id'], scope: rackInLocation, onChange: rackPicked },
      { k: 'position', label: 'Spot', ph: 'Bin 2' },
    ],
    extra: <p className="muted small">Added by mistake? <button type="button" className="link-btn" onClick={() => { m.m.close(true); deletePart(comp, after); }}>Delete it instead</button>, so it doesn’t go to Spare Parts.</p>,
    saveLabel: 'Move to spares',
    submit: async v => { await api('POST', `/components/${comp.id}/uninstall`, v); toast('Moved to spares'); },
    onDone: () => (after || rerender)(),
  });
}
