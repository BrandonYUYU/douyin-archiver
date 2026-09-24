/**
 * csv.js — spreadsheet-facing export.
 *
 * Three things here are easy to get wrong and all of them bite silently:
 *
 *  1. ENCODING. Excel assumes the system codepage for a .csv unless the file
 *     starts with a UTF-8 BOM, so Chinese descriptions arrive as mojibake. The
 *     BOM is not optional for this project.
 *  2. QUOTING. Descriptions routinely contain commas, quotes and newlines.
 *  3. FORMULA INJECTION. A description starting with `=`, `+`, `-` or `@` is
 *     executed as a formula when the sheet is opened. Since the text comes from
 *     other people's video captions, it is untrusted input and gets neutralized.
 */

import { RECORD_FIELDS } from './normalize.js';

export const CSV_BOM = '\uFEFF';

/** Cells starting with these are treated as formulas by Excel/Sheets. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** Characters that force a cell to be quoted. */
const MUST_QUOTE = /[",\r\n]/;

export function escapeCsvCell(value) {
  let text = value === undefined || value === null ? '' : String(value);

  // Prefixing with an apostrophe is the conventional neutralizer: spreadsheets
  // show the original text and refuse to evaluate it.
  if (FORMULA_LEAD.test(text)) text = `'${text}`;

  if (MUST_QUOTE.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Rows of primitives → CSV text.
 * @param {Array<Array<unknown>>} rows
 * @param {{header?: string[], bom?: boolean, newline?: string}} options
 */
export function toCsv(rows, options = {}) {
  const { header = null, bom = true, newline = '\r\n' } = options;

  const lines = [];
  if (header) lines.push(header.map(escapeCsvCell).join(','));
  for (const row of Array.isArray(rows) ? rows : []) {
    lines.push((Array.isArray(row) ? row : []).map(escapeCsvCell).join(','));
  }

  // CRLF because that is what Excel expects on Windows.
  return (bom ? CSV_BOM : '') + lines.join(newline) + (lines.length ? newline : '');
}

function isoOrBlank(seconds, { fromSeconds = false } = {}) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return '';
  const ms = fromSeconds ? n * 1000 : n;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/**
 * How each record field is rendered for a spreadsheet. Raw unix timestamps are
 * useless in a cell, so they become ISO strings; `lists` becomes a readable
 * pipe-joined string.
 */
const CELL_RENDERERS = {
  lists: (value) => (Array.isArray(value) ? value.join('|') : ''),
  createTime: (value) => isoOrBlank(value, { fromSeconds: true }),
  firstSeenAt: (value) => isoOrBlank(value),
  lastSeenAt: (value) => isoOrBlank(value)
};

/** Column order is RECORD_FIELDS, so exports stay stable across versions. */
export const CSV_COLUMNS = RECORD_FIELDS;

/**
 * Newest first, ties broken by id.
 *
 * Ordering has to be explicit here: record ids are numeric strings, so
 * `Object.values(recordsMap)` yields them in ascending *numeric* key order
 * rather than insertion order. Without this, the same archive would export in a
 * different row order depending on whether it arrived as a map or an array, and
 * CSV would disagree with JSON.
 */
function inExportOrder(list) {
  return [...list].sort((a, b) => {
    const byTime = (b?.createTime || 0) - (a?.createTime || 0);
    if (byTime !== 0) return byTime;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  });
}

/**
 * Archive records → CSV text ready to write to a file.
 * @param {object[]|Record<string, object>} records
 */
export function recordsToCsv(records, options = {}) {
  const list = Array.isArray(records) ? records : Object.values(records || {});

  const rows = inExportOrder(list).map((record) =>
    CSV_COLUMNS.map((field) => {
      const renderer = CELL_RENDERERS[field];
      const value = record ? record[field] : '';
      return renderer ? renderer(value) : (value ?? '');
    })
  );

  return toCsv(rows, { header: CSV_COLUMNS, ...options });
}
