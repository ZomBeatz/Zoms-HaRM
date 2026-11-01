/* Reading a photographed label: barcode values and printed text become guesses for form fields. */

export const BRANDS = ['Seagate', 'Western Digital', 'WDC', 'Toshiba', 'HGST', 'Samsung', 'Crucial', 'Micron', 'Kingston',
  'Intel', 'AMD', 'Dell', 'HPE', 'Hewlett Packard', 'Lenovo', 'IBM', 'Supermicro', 'Cisco', 'Ubiquiti', 'MikroTik',
  'Netgear', 'TP-Link', 'Synology', 'QNAP', 'Mellanox', 'NVIDIA', 'Broadcom', 'LSI', 'SK hynix', 'Hynix', 'Corsair',
  'ASUS', 'ASRock', 'Gigabyte', 'MSI', 'APC', 'CyberPower', 'Eaton', 'Juniper', 'Aruba', 'Raspberry Pi', 'Sabrent',
  'SanDisk', 'Solidigm', 'Kioxia', 'Chelsio', 'Brocade', 'Arista', 'Fortinet', 'Netgate', 'Protectli', 'Minisforum'];

export interface Barcode { format: string; value: string }
export interface Candidate { value: string; guess: string | null; source: string }

export function parseLabel(barcodes: Barcode[], text: string) {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (value: string, guess: string | null, source: string) => {
    value = String(value || '').trim().replace(/^[\s:#.\-]+|[\s.,;:]+$/g, '');
    if (value.length < 3 || value.length > 80) return;
    const key = value.toUpperCase();
    const existing = out.find(c => c.value.toUpperCase() === key);
    if (existing) { if (!existing.guess && guess) existing.guess = guess; return; }
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ value, guess, source });
  };
  const macRe = /^(?:[0-9A-F]{2}[:\-]?){5}[0-9A-F]{2}$/i;
  for (const b of barcodes) {
    const v = b.value.trim();
    add(v, macRe.test(v) ? 'mac' : /^\d+(\.\d+)?\s?(TB|GB)$/i.test(v) ? 'capacity' : null, b.format);
  }
  const patterns: [RegExp, string][] = [
    [/\b(?:S\/N|SN|SER(?:IAL)?\.?(?:\s*(?:NO|NUM(?:BER)?|#))?|SERIAL\s+NUMBER)\s*[:#.\-]?\s*([A-Z0-9][A-Z0-9\-]{3,})/i, 'serial'],
    [/\b(?:P\/N|PN|PART\s*(?:NO|NUM(?:BER)?|#)?|MPN|FRU(?:\s*P\/?N)?)\s*[:#.\-]?\s*([A-Z0-9][A-Z0-9\-_.\/]{2,})/i, 'part_number'],
    [/\b(?:M\/N|MODEL(?:\s*(?:NO|NUM(?:BER)?|#))?|MDL|MTM)\s*[:#.\-]?\s*([A-Z0-9][A-Z0-9\-_.\/]{2,})/i, 'model'],
    [/\b(?:SERVICE\s*TAG|SVC\s*TAG|S\/T|ASSET(?:\s*TAG)?)\s*[:#.\-]?\s*([A-Z0-9\-]{4,})/i, 'asset_tag'],
    [/\b(?:MAC|HW\s*ADDR(?:ESS)?|ETHERNET|LAN)\b[^0-9A-F]{0,12}((?:[0-9A-F]{2}[:\-]?){5}[0-9A-F]{2})\b/i, 'mac'],
    [/\b((?:[0-9A-F]{2}[:\-]){5}[0-9A-F]{2})\b/i, 'mac'],
    [/\b(\d+(?:\.\d+)?\s?(?:TB|GB))\b/i, 'capacity'],
  ];
  const lines = (text || '').split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 1);
  for (const line of lines) for (const [re, guess] of patterns) { const m = line.match(re); if (m) add(m[1], guess, 'text'); }
  // Labelled lines first, then barcode values usually being the serial.
  for (const c of out) if (!c.guess && c.source !== 'text') c.guess = out.some(x => x.guess === 'serial') ? null : 'serial';
  const lower = (text || '').toLowerCase();
  for (const b of BRANDS) if (new RegExp(`\\b${b.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)) add(b, 'manufacturer', 'text');
  for (const tok of (text || '').match(/\b[A-Z0-9][A-Z0-9\-]{5,}\b/g) || []) {
    if (/[A-Z]/.test(tok) && /\d/.test(tok)) add(tok, null, 'text');
  }
  return { candidates: out, lines };
}
