/**
 * manage.js — the options page: import, export, and deletion.
 *
 * Import lives here rather than in the popup because a native file picker can
 * dismiss a popup before its `change` event fires. A tab survives losing focus.
 */

import { RPC } from '../lib/rpc.js';
import { buildExport, exportFilename, parseImport } from '../lib/exchange.js';
import { recordsToCsv } from '../lib/csv.js';
import { downloadText, MIME } from '../lib/download.js';

const statusEl = document.getElementById('status');
const totalEl = document.getElementById('total');
const exportJsonEl = document.getElementById('exportJson');
const exportCsvEl = document.getElementById('exportCsv');
const importFileEl = document.getElementById('importFile');
const importLogEl = document.getElementById('importLog');
const clearEl = document.getElementById('clearArchive');

function setStatus(text) {
  statusEl.textContent = text;
}

function logLines(lines) {
  importLogEl.replaceChildren(
    ...lines.map((line) => {
      const item = document.createElement('li');
      item.textContent = line;
      return item;
    })
  );
  importLogEl.hidden = lines.length === 0;
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response || !response.ok) {
    throw new Error(response?.error || 'no response from service worker');
  }
  return response;
}

async function refresh() {
  const { meta } = await send({ type: RPC.GET_STATE });
  totalEl.textContent = String(meta.total);

  const hasRecords = meta.total > 0;
  exportJsonEl.disabled = !hasRecords;
  exportCsvEl.disabled = !hasRecords;
  clearEl.disabled = !hasRecords;

  setStatus(
    meta.updatedAt ? `Last saved ${new Date(meta.updatedAt).toLocaleString()}.` : 'Nothing stored yet.'
  );
}

async function exportArchive(kind) {
  const { records, meta } = await send({ type: RPC.EXPORT_RECORDS });

  if (kind === 'csv') {
    downloadText(exportFilename('csv'), recordsToCsv(records), MIME.CSV);
  } else {
    downloadText(
      exportFilename('json'),
      JSON.stringify(buildExport(records, { meta }), null, 2),
      MIME.JSON
    );
  }
  setStatus(`Exported ${records.length} videos as ${kind.toUpperCase()}.`);
}

async function importFile(file) {
  setStatus(`Reading ${file.name}…`);
  const text = await file.text();
  const parsed = parseImport(text);

  if (!parsed.ok) {
    setStatus(`Import failed: ${parsed.reason}`);
    logLines(parsed.warnings);
    return;
  }

  const result = await send({ type: RPC.IMPORT_RECORDS, records: parsed.records });

  const lines = [...parsed.warnings];
  if (parsed.skipped) lines.push(`${parsed.skipped} entries in the file had no usable video id.`);
  lines.push(
    `${result.added} added, ${result.updated} updated, ` +
      `${parsed.records.length - result.added - result.updated} already identical.`
  );
  logLines(lines);

  setStatus(`Imported ${parsed.records.length} records — archive now holds ${result.total}.`);
  await refresh();
}

exportJsonEl.addEventListener('click', () => {
  exportArchive('json').catch((error) => setStatus(`Export failed: ${error.message}`));
});

exportCsvEl.addEventListener('click', () => {
  exportArchive('csv').catch((error) => setStatus(`Export failed: ${error.message}`));
});

importFileEl.addEventListener('change', () => {
  const file = importFileEl.files?.[0];
  if (!file) return;
  importFile(file)
    .catch((error) => setStatus(`Import failed: ${error.message}`))
    // Reset so selecting the same file again re-triggers the event.
    .finally(() => {
      importFileEl.value = '';
    });
});

clearEl.addEventListener('click', async () => {
  const { meta } = await send({ type: RPC.GET_STATE });
  // Destructive and irreversible from here, so it is confirmed explicitly and
  // the count is spelled out rather than left implicit.
  const confirmed = window.confirm(
    `Delete all ${meta.total} archived videos?\n\n` +
      'This cannot be undone. If you have not exported a JSON backup, cancel and do that first.'
  );
  if (!confirmed) return;

  try {
    await send({ type: RPC.CLEAR_ARCHIVE });
    logLines([]);
    setStatus('Archive deleted.');
    await refresh();
  } catch (error) {
    setStatus(`Delete failed: ${error.message}`);
  }
});

refresh().catch((error) => setStatus(`Error: ${error.message}`));
