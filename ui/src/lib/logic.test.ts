import { describe, expect, it } from 'vitest';
import { b32decode, badgeClass, duration, forHowLong, parseSizeGB, slotKindOf, splitTokens, timeAgo, toggleToken, totpNow, fmtGB } from './util';
import { parseLabel } from './labels';
import { csvCell, exportCSV, exportMarkdown } from './export';

describe('text and numbers', () => {
  it('toggles connections in a "SAS/SATA" list', () => {
    expect(splitTokens('SAS / SATA')).toEqual(['SAS', 'SATA']);
    expect(toggleToken('SAS/SATA', 'SAS')).toBe('SATA');
    expect(toggleToken('SATA', 'SAS')).toBe('SATA/SAS');
  });
  it('reads and writes sizes', () => {
    expect(parseSizeGB('4 TB')).toBe(4000);
    expect(parseSizeGB('512gb')).toBe(512);
    expect(parseSizeGB('big')).toBeNull();
    expect(fmtGB(1500)).toBe('1.5 TB');
    expect(fmtGB(64)).toBe('64 GB');
  });
  it('says how long ago and for how long', () => {
    const now = Date.parse('2026-10-31T12:00:00Z');
    expect(timeAgo('2026-10-31 11:59:30', now)).toBe('just now');
    expect(timeAgo('2026-10-31 11:15:00', now)).toBe('45m ago');
    expect(timeAgo('2026-10-31 09:00:00', now)).toBe('3h ago');
    expect(forHowLong('2026-10-31 11:55:00', now)).toBe('for 5 min');
    expect(forHowLong('2026-10-31 10:30:00', now)).toBe('for 1 h 30 min');
    expect(forHowLong('2026-10-27 12:00:00', now)).toBe('for 4 days');
    expect(duration(0)).toBe('');
    expect(duration(30)).toBe('under a minute');
    expect(duration(5400)).toBe('1.5 h');
  });
  it('puts each status in its color', () => {
    expect(badgeClass('Active')).toBe('ok');
    expect(badgeClass('In Repair')).toBe('warn');
    expect(badgeClass('Broken')).toBe('bad');
    expect(badgeClass('Retired')).toBe('muted');
  });
  it('guesses the kind of slot from what it takes', () => {
    expect(slotKindOf('DDR4 RDIMM')).toBe('Memory slots');
    expect(slotKindOf('SAS/SATA')).toBe('Drive bays');
    expect(slotKindOf('PCIe x16')).toBe('PCIe slots');
    expect(slotKindOf('LGA1700')).toBe('CPU sockets');
  });
});

describe('2FA codes', () => {
  it('matches the RFC 6238 test vector', async () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';  // "12345678901234567890"
    expect([...b32decode(secret)].map(c => String.fromCharCode(c)).join('')).toBe('12345678901234567890');
    expect(await totpNow(secret, 59 * 1000, 30, 8)).toBe('94287082');
    expect(await totpNow(secret, 1111111109 * 1000, 30, 8)).toBe('07081804');
  });
});

describe('reading labels', () => {
  it('finds labelled values and makers in printed text', () => {
    const { candidates } = parseLabel([], 'Seagate Exos\nS/N: ZL2ABC12\nP/N: 1V4107-002\nMAC 00:1A:2B:3C:4D:5E\n12 TB');
    const by = (g: string) => candidates.find(c => c.guess === g)?.value;
    expect(by('serial')).toBe('ZL2ABC12');
    expect(by('part_number')).toBe('1V4107-002');
    expect(by('mac')).toBe('00:1A:2B:3C:4D:5E');
    expect(by('capacity')).toBe('12 TB');
    expect(by('manufacturer')).toBe('Seagate');
  });
  it('takes a lone barcode as the serial', () => {
    const { candidates } = parseLabel([{ format: 'CODE_128', value: 'WCC4E1234567' }], '');
    expect(candidates[0]).toEqual({ value: 'WCC4E1234567', guess: 'serial', source: 'CODE_128' });
  });
});

describe('export', () => {
  const bundle = [{
    device: { id: 1, name: 'pve1', device_type: 'Server', manufacturer: 'Dell', model: 'R730', status: 'Active', connected: 1, serial: '=7XK9P2J' },
    storage: { drives: 2, total: '8 TB', groups: [{ count: 2, capacity: '4 TB', category: 'HDD' }] },
    components: [], interfaces: [{ name: 'eno1', ip: '10.0.0.5', mac: 'AA:BB:CC:DD:EE:FF' }], services: [], slots: [], connections: [], credentials: [], notes: [],
  }];
  it('keeps spreadsheet cells from running as formulas', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
  });
  it('writes a spreadsheet with the chosen columns', () => {
    const csv = exportCSV(bundle, { serial: true, storage: true, network: true }).split('\n');
    expect(csv[0]).toBe('Name,Type,Manufacturer,Model,Status,Serial / service tag,Storage (raw),Drives,IPs,MACs');
    expect(csv[1]).toBe("pve1,Server,Dell,R730,Active,'=7XK9P2J,8 TB,2x 4 TB,10.0.0.5,AA:BB:CC:DD:EE:FF");
  });
  it('writes Markdown for a person or an AI chat', () => {
    const md = exportMarkdown(bundle, { basics: true, storage: true, network: true }, { title: 'Lab', now: new Date(0) });
    expect(md).toContain('# Lab');
    expect(md).toContain('## pve1');
    expect(md).toContain('- **Make / model:** Dell R730');
    expect(md).toContain('**Storage:** 8 TB raw (2 drives)');
    expect(md).toContain('| eno1 |  | 10.0.0.5 | AA:BB:CC:DD:EE:FF |  |  |');
  });
});
