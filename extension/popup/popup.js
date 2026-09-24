/**
 * popup.js — the whole tool, drivable without devtools.
 *
 * The popup owns no state. Run status comes from the CONTENT SCRIPT (which is
 * where the run actually lives) and archive totals from the service worker, so
 * closing the popup cannot interrupt anything and reopening it shows the truth.
 *
 * Import lives on pages/manage.html instead: opening a native file picker from a
 * popup can dismiss the popup before the `change` event fires.
 */

import { RPC } from '../lib/rpc.js';
import { buildExport, exportFilename } from '../lib/exchange.js';
import { recordsToCsv } from '../lib/csv.js';
import { downloadText, MIME } from '../lib/download.js';
import { describeStop } from '../lib/stopRules.js';
import { LISTS, LIST_IDS } from '../lib/targets.js';
import { SETTING_BOUNDS, DEFAULT_SETTINGS } from '../lib/settings.js';
import { formatDuration } from '../lib/format.js';

const el = (id) => document.getElementById(id);

const ui = {
  status: el('status'),
  total: el('total'),
  listSelect: el('listSelect'),
  start: el('start'),
  stop: el('stop'),
  openList: el('openList'),
  runHint: el('runHint'),
  counters: el('counters'),
  cScrolls: el('cScrolls'),
  cNew: el('cNew'),
  cKnown: el('cKnown'),
  cDom: el('cDom'),
  exportJson: el('exportJson'),
  exportCsv: el('exportCsv'),
  openManage: el('openManage'),
  saveSettings: el('saveSettings'),
  resetSettings: el('resetSettings')
};

/** Settings inputs, by setting name. */
const NUMBER_FIELDS = ['minDelayMs', 'maxDelayMs', 'earlyStopThreshold', 'maxRunMinutes'];
const FLAG_FIELDS = ['fullRescan', 'reconMode'];

let pollHandle = null;
/** Set once the user picks a list by hand, so a refresh does not override them. */
let listChosenByUser = false;

function setStatus(text) {
  ui.status.textContent = text;
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response || !response.ok) {
    throw new Error(response?.error || 'no response from service worker');
  }
  return response;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function isDouyinTab(tab) {
  return Boolean(tab?.url && /^https?:\/\/([^/]*\.)?douyin\.com\//.test(tab.url));
}

/**
 * Talk to the content script, injecting it first if the tab was already open when
 * the extension loaded (in which case no content script is there yet).
 */
async function askTab(tabId, message, { inject = true } = {}) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    if (!inject) return null;
    try {
      // Order matters: the page-world hook first, then the isolated script that
      // configures it.
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/hook.js'],
        world: 'MAIN'
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content.js'],
        world: 'ISOLATED'
      });
    } catch {
      return null;
    }
    return askTab(tabId, message, { inject: false });
  }
}

// --- rendering -------------------------------------------------------------

function buildListOptions() {
  ui.listSelect.replaceChildren(
    ...LIST_IDS.map((id) => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = LISTS[id].label;
      return option;
    })
  );
}

function applyBounds() {
  for (const field of NUMBER_FIELDS) {
    const [min, max] = SETTING_BOUNDS[field] || [];
    const input = el(field);
    if (!input) continue;
    if (min !== undefined) input.min = String(min);
    if (max !== undefined) input.max = String(max);
  }
}

function renderSettings(settings) {
  for (const field of NUMBER_FIELDS) {
    const input = el(field);
    if (input && document.activeElement !== input) input.value = String(settings[field]);
  }
  for (const field of FLAG_FIELDS) {
    const input = el(field);
    if (input) input.checked = Boolean(settings[field]);
  }
}

function renderCounters(status) {
  const show = Boolean(status && (status.running || status.stoppedReason));
  ui.counters.hidden = !show;
  if (!show) return;

  ui.cScrolls.textContent = String(status.steps ?? 0);
  ui.cNew.textContent = String(status.added ?? 0);
  ui.cKnown.textContent = String(status.consecutiveKnown ?? 0);
  ui.cDom.textContent = String(status.domHarvested ?? 0);
}

function renderRun(status, tab) {
  const selected = ui.listSelect.value;
  const detected = status?.detectedList || null;

  // Offer to navigate when the chosen list is not the page we are looking at.
  ui.openList.hidden = !isDouyinTab(tab) || !selected || detected === selected;

  if (!isDouyinTab(tab)) {
    ui.start.disabled = true;
    ui.stop.disabled = true;
    ui.openList.hidden = false;
    ui.runHint.textContent = 'Open douyin.com in this tab, or press "Open that list".';
    return;
  }

  if (!status) {
    ui.start.disabled = true;
    ui.stop.disabled = true;
    ui.runHint.textContent = 'Could not reach the page. Reload the Douyin tab and try again.';
    return;
  }

  if (status.running) {
    ui.start.disabled = true;
    ui.stop.disabled = false;
    const label = LISTS[status.listId]?.label || status.listId;
    ui.runHint.textContent = status.paused
      ? `Paused on ${label}: ${status.pauseReason}. Solve it in the page and it continues.`
      : `Running on ${label} — you can close this popup.`;
    return;
  }

  ui.stop.disabled = true;
  ui.start.disabled = detected !== selected;

  if (detected !== selected) {
    ui.runHint.textContent = `This page is not the ${LISTS[selected]?.label || selected} list.`;
  } else if (status.stoppedReason) {
    ui.runHint.textContent = describeStop(status.stoppedReason);
  } else {
    ui.runHint.textContent = `Ready to archive ${LISTS[selected]?.label || selected}.`;
  }
}

async function refresh() {
  const { meta, settings } = await send({ type: RPC.GET_STATE });

  ui.total.textContent = String(meta.total);
  renderSettings(settings);

  const hasRecords = meta.total > 0;
  ui.exportJson.disabled = !hasRecords;
  ui.exportCsv.disabled = !hasRecords;

  const tab = await activeTab();
  const reply = isDouyinTab(tab) ? await askTab(tab.id, { type: RPC.GET_RUN_STATUS }) : null;
  const status = reply?.status || null;

  // Default the selector to whatever list the page is showing, until the user
  // expresses a preference of their own.
  if (!listChosenByUser && status?.detectedList) ui.listSelect.value = status.detectedList;

  renderRun(status, tab);
  renderCounters(status);

  const parts = [];
  if (settings.reconMode) parts.push('Recon mode ON');
  if (settings.fullRescan) parts.push('Full rescan ON');
  if (meta.lastRun) {
    const known = Number(meta.lastRun.known) || 0;
    parts.push(
      `last run +${meta.lastRun.added} new, ${known} already known, ` +
        `in ${formatDuration(meta.lastRun.elapsedMs)} (${describeStop(meta.lastRun.reason)})`
    );
  }
  setStatus(parts.length ? parts.join(' · ') : 'Ready.');

  // Poll only while a run is active, so an idle popup costs nothing.
  const running = Boolean(status?.running);
  if (running && pollHandle === null) {
    pollHandle = setInterval(() => refresh().catch(() => {}), 1500);
  } else if (!running && pollHandle !== null) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

// --- actions ---------------------------------------------------------------

async function exportArchive(kind) {
  setStatus('Preparing export…');
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

async function saveSettings() {
  const patch = {};
  for (const field of NUMBER_FIELDS) patch[field] = Number(el(field).value);
  for (const field of FLAG_FIELDS) patch[field] = el(field).checked;

  // The worker normalizes and clamps, then we re-render from what it stored, so
  // an out-of-range entry visibly snaps to the accepted value.
  await send({ type: RPC.SET_SETTINGS, patch });
  await refresh();
  setStatus('Settings saved.');
}

ui.listSelect.addEventListener('change', () => {
  listChosenByUser = true;
  refresh().catch((error) => setStatus(`Error: ${error.message}`));
});

ui.openList.addEventListener('click', async () => {
  const listId = ui.listSelect.value;
  const url = LISTS[listId]?.pageUrl;
  if (!url) return;

  const tab = await activeTab();
  if (tab) await chrome.tabs.update(tab.id, { url });
  setStatus('Opening the list — press Start once it has loaded.');
});

ui.start.addEventListener('click', async () => {
  try {
    const tab = await activeTab();
    if (!isDouyinTab(tab)) return;
    const reply = await askTab(tab.id, { type: RPC.START_RUN, listId: ui.listSelect.value });
    if (!reply) throw new Error('could not reach the page — reload the tab');
    if (!reply.ok) throw new Error(reply.error);
    await refresh();
  } catch (error) {
    setStatus(`Could not start: ${error.message}`);
  }
});

ui.stop.addEventListener('click', async () => {
  try {
    const tab = await activeTab();
    if (!isDouyinTab(tab)) return;
    await askTab(tab.id, { type: RPC.STOP_RUN }, { inject: false });
    await refresh();
  } catch (error) {
    setStatus(`Could not stop: ${error.message}`);
  }
});

ui.saveSettings.addEventListener('click', () => {
  saveSettings().catch((error) => setStatus(`Could not save: ${error.message}`));
});

ui.resetSettings.addEventListener('click', async () => {
  try {
    await send({ type: RPC.SET_SETTINGS, patch: { ...DEFAULT_SETTINGS } });
    await refresh();
    setStatus('Settings reset to defaults.');
  } catch (error) {
    setStatus(`Could not reset: ${error.message}`);
  }
});

for (const field of FLAG_FIELDS) {
  el(field).addEventListener('change', async () => {
    try {
      await send({ type: RPC.SET_SETTINGS, patch: { [field]: el(field).checked } });
      await refresh();
    } catch (error) {
      setStatus(`Error: ${error.message}`);
    }
  });
}

ui.exportJson.addEventListener('click', () => {
  exportArchive('json').catch((error) => setStatus(`Export failed: ${error.message}`));
});

ui.exportCsv.addEventListener('click', () => {
  exportArchive('csv').catch((error) => setStatus(`Export failed: ${error.message}`));
});

ui.openManage.addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

// Stop polling when the popup closes, so no timer leaks into the next open.
window.addEventListener('unload', () => {
  if (pollHandle !== null) clearInterval(pollHandle);
});

buildListOptions();
applyBounds();
refresh().catch((error) => setStatus(`Error: ${error.message}`));
