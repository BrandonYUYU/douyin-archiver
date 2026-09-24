/**
 * exchange.js — the archival file format, and the parser that reads it back.
 *
 * This is the durability story for the whole project (docs/decisions.md §5):
 * extension storage can be lost by uninstalling or by a profile reset, so the
 * exported JSON file is the real backup. That makes the format's stability and
 * the importer's tolerance more important than either is for storage itself.
 */

import { RECORD_SCHEMA_VERSION, sanitizeRecord } from './normalize.js';

/** Marker so an importer can tell our files from any other JSON. */
export const EXPORT_FORMAT = 'douyin-archiver-export';

/**
 * @param {object[]|Record<string, object>} records
 * @param {{now?: number, meta?: object}} options
 */
export function buildExport(records, options = {}) {
  const { now = Date.now(), meta = {} } = options;
  const list = Array.isArray(records) ? records : Object.values(records || {});

  // Newest first, matching how the lists themselves read.
  const sorted = [...list].sort((a, b) => (b?.createTime || 0) - (a?.createTime || 0));

  return {
    format: EXPORT_FORMAT,
    schemaVersion: RECORD_SCHEMA_VERSION,
    exportedAt: new Date(now).toISOString(),
    total: sorted.length,
    archiveCreatedAt: meta.createdAt ? new Date(meta.createdAt).toISOString() : null,
    records: sorted
  };
}

/** Filename that sorts chronologically and is safe on Windows. */
export function exportFilename(extension, now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/[:T]/g, '-').slice(0, 16);
  return `douyin-archive-${stamp}.${extension}`;
}

/**
 * Parse an export file back into records.
 *
 * Tolerant by design: accepts our envelope, a bare array of records, or a
 * `{records: [...]}` object, because a backup you cannot read is not a backup.
 * Every record still goes through sanitizeRecord, so nothing unvalidated lands
 * in storage.
 *
 * @param {string|object} input
 * @returns {{
 *   ok: boolean, reason: string|null, records: object[],
 *   skipped: number, warnings: string[], schemaVersion: number|null
 * }}
 */
export function parseImport(input, options = {}) {
  const { now = Date.now() } = options;
  const fail = (reason) => ({
    ok: false,
    reason,
    records: [],
    skipped: 0,
    warnings: [],
    schemaVersion: null
  });

  let parsed = input;
  if (typeof input === 'string') {
    const text = input.replace(/^\uFEFF/, '').trim(); // tolerate a BOM
    if (!text) return fail('empty-file');
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail('unparseable-json');
    }
  }

  let rawRecords = null;
  const warnings = [];
  let schemaVersion = null;

  if (Array.isArray(parsed)) {
    rawRecords = parsed;
    warnings.push('File had no envelope; treated as a bare array of records.');
  } else if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.records)) {
      rawRecords = parsed.records;
      if (parsed.format && parsed.format !== EXPORT_FORMAT) {
        warnings.push(`Unexpected format marker "${parsed.format}".`);
      }
      const version = Number(parsed.schemaVersion);
      if (Number.isFinite(version)) {
        schemaVersion = version;
        if (version > RECORD_SCHEMA_VERSION) {
          // Newer files are additive, so import rather than refuse — but say so.
          warnings.push(
            `File uses schema v${version}; this build understands v${RECORD_SCHEMA_VERSION}. ` +
              'Unknown fields were dropped.'
          );
        }
      }
    } else {
      return fail('no-records-array');
    }
  } else {
    return fail('not-an-object');
  }

  const records = [];
  let skipped = 0;
  for (const raw of rawRecords) {
    const record = sanitizeRecord(raw, { now });
    if (record) records.push(record);
    else skipped += 1;
  }

  if (records.length === 0) return { ...fail('no-usable-records'), warnings, skipped };

  return { ok: true, reason: null, records, skipped, warnings, schemaVersion };
}
