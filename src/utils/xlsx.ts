/**
 * Minimal dependency-free .xlsx writer.
 *
 * An .xlsx is a ZIP of XML parts. We emit a STORE-only ZIP (no compression —
 * just local headers + CRC32 + central directory) containing the smallest
 * valid workbook: one sheet, inline strings, numbers as numbers. Excel,
 * Numbers and LibreOffice all open it. Grids up to the ~1M-row UI cap are
 * fine; cells are streamed into one Uint8Array at the end.
 */
import { cellText } from './exporters.ts';

// ── CRC32 (standard table-driven) ─────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ── STORE-only ZIP ────────────────────────────────────────────────────────────

interface ZipEntry { name: string; data: Uint8Array }

function u16(v: number): number[] { return [v & 0xFF, (v >>> 8) & 0xFF]; }
function u32(v: number): number[] { return [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]; }

function buildZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: number[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);
    const header = [
      ...u32(0x04034B50), ...u16(20), ...u16(0), ...u16(0),   // sig, version, flags, method=STORE
      ...u16(0), ...u16(0),                                    // mod time/date
      ...u32(crc), ...u32(e.data.length), ...u32(e.data.length),
      ...u16(nameBytes.length), ...u16(0),
    ];
    chunks.push(new Uint8Array(header), nameBytes, e.data);
    central.push(
      ...u32(0x02014B50), ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0),
      ...u32(crc), ...u32(e.data.length), ...u32(e.data.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset),
      ...nameBytes,
    );
    offset += header.length + nameBytes.length + e.data.length;
  }

  const centralBytes = new Uint8Array(central);
  const end = [
    ...u32(0x06054B50), ...u16(0), ...u16(0),
    ...u16(entries.length), ...u16(entries.length),
    ...u32(centralBytes.length), ...u32(offset), ...u16(0),
  ];
  chunks.push(centralBytes, new Uint8Array(end));

  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}

// ── Workbook XML ──────────────────────────────────────────────────────────────

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // literal control chars are invalid in XML 1.0 — strip them
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

/** Column index (0-based) → A1-style letters. */
function colRef(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function cellXml(ref: string, v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' && Number.isFinite(v)) {
    return `<c r="${ref}"><v>${v}</v></c>`;
  }
  if (typeof v === 'boolean') {
    return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cellText(v))}</t></is></c>`;
}

/** Build a complete .xlsx as bytes: header row + data rows on one sheet. */
export function toXlsx(columns: string[], rows: unknown[][], sheetName = 'Result'): Uint8Array {
  const enc = new TextEncoder();
  const safeSheet = xmlEscape(sheetName.replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'Result');

  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>',
  ];
  const headerCells = columns.map((c, ci) => cellXml(`${colRef(ci)}1`, c)).join('');
  parts.push(`<row r="1">${headerCells}</row>`);
  for (let r = 0; r < rows.length; r++) {
    const rr = r + 2;
    const cells = rows[r].map((v, ci) => cellXml(`${colRef(ci)}${rr}`, v)).join('');
    parts.push(`<row r="${rr}">${cells}</row>`);
  }
  parts.push('</sheetData></worksheet>');
  const sheetXml = parts.join('');

  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${safeSheet}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '</Relationships>';

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '</Types>';

  return buildZip([
    { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
    { name: '_rels/.rels', data: enc.encode(rootRels) },
    { name: 'xl/workbook.xml', data: enc.encode(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(workbookRels) },
    { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheetXml) },
  ]);
}

/** HTML table for the clipboard's text/html flavor — Excel/Numbers/Sheets
 *  paste this as real cells with types preserved reasonably. */
export function toHtmlTable(columns: string[], rows: unknown[][]): string {
  const th = columns.map(c => `<th>${xmlEscape(c)}</th>`).join('');
  const trs = rows.map(r =>
    `<tr>${r.map(v => `<td>${v === null || v === undefined ? '' : xmlEscape(cellText(v))}</td>`).join('')}</tr>`
  ).join('');
  return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}
