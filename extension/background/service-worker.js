/**
 * service-worker.js — the extension's only durable component.
 *
 * Everything persistent lives here rather than on the page, so clearing
 * douyin.com's site data cannot touch the archive (docs/decisions.md §5).
 *
 * MV3 evicts idle workers, so this file holds no state that matters: lib/store.js
 * reloads from chrome.storage.local on first use after every restart, and
 * checkpoints during a run rather than at the end.
 *
 * Task 5 scope: settings, ingest, checkpointed storage, badge.
 */

import { DEFAULT_SETTINGS, SETTINGS_KEY, normalizeSettings } from '../lib/settings.js';
import { RPC } from '../lib/rpc.js';
import { createStore } from '../lib/store.js';
import { formatBadgeCount } from '../lib/format.js';

const store = createStore({ area: chrome.storage.local });

async function readSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(stored[SETTINGS_KEY]);
}

async function writeSettings(patch) {
  const current = await readSettings();
  const next = normalizeSettings({ ...current, ...(patch || {}) });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

async function updateBadge(total) {
  try {
    await chrome.action.setBadgeText({ text: formatBadgeCount(total) });
    await chrome.action.setBadgeBackgroundColor({ color: '#1a6fd4' });
  } catch {
    // Badge updates are cosmetic; never let one break an ingest.
  }
}

const ATTENTION_NOTIFICATION_ID = 'dya-attention';

/**
 * Show that the run is waiting for the user. The badge turns into an alert rather
 * than a count, because a paused run that looks identical to a finished one is
 * exactly the failure this whole feature exists to prevent.
 */
async function raiseAttention(title, message) {
  try {
    await chrome.action.setBadgeText({ text: '!!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#c0392b' });
  } catch {
    /* cosmetic */
  }
  try {
    await chrome.notifications.create(ATTENTION_NOTIFICATION_ID, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
      priority: 2
    });
  } catch {
    // Notifications can be disabled at the OS level; the badge still shows it.
  }
}

async function clearAttention() {
  try {
    await chrome.notifications.clear(ATTENTION_NOTIFICATION_ID);
  } catch {
    /* ignore */
  }
  const meta = await store.getMeta();
  await updateBadge(meta.total);
}

chrome.runtime.onInstalled.addListener(async () => {
  // Seed defaults so the popup never renders an empty form.
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  if (!stored[SETTINGS_KEY]) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS } });
  }
  const meta = await store.getMeta();
  await updateBadge(meta.total);
});

// A restarted worker should show the stored count without waiting for a run.
chrome.runtime.onStartup.addListener(async () => {
  const meta = await store.getMeta();
  await updateBadge(meta.total);
});

const handlers = {
  [RPC.GET_SETTINGS]: async () => ({ ok: true, settings: await readSettings() }),

  [RPC.SET_SETTINGS]: async (message) => ({
    ok: true,
    settings: await writeSettings(message.patch)
  }),

  [RPC.INGEST]: async (message) => {
    const result = await store.ingest(Array.isArray(message.records) ? message.records : []);
    await updateBadge(result.total);
    return { ok: true, ...result };
  },

  [RPC.GET_STATE]: async () => ({
    ok: true,
    meta: await store.getMeta(),
    settings: await readSettings(),
    pending: store.pendingCount
  }),

  [RPC.EXPORT_RECORDS]: async () => {
    // Wait for any in-flight checkpoint so an export can never miss records that
    // were captured seconds earlier.
    await store.whenIdle();
    const records = await store.getRecords();
    return { ok: true, records: Object.values(records), meta: await store.getMeta() };
  },

  [RPC.IMPORT_RECORDS]: async (message) => {
    const result = await store.ingest(Array.isArray(message.records) ? message.records : []);
    // Import is a deliberate user action, so write immediately rather than
    // leaving it to the debounce.
    await store.flush();
    await updateBadge(result.total);
    return { ok: true, ...result };
  },

  [RPC.CLEAR_ARCHIVE]: async () => {
    const total = await store.clear();
    await updateBadge(total);
    return { ok: true, total };
  },

  [RPC.SET_LAST_RUN]: async (message) => ({
    ok: true,
    lastRun: await store.setLastRun(message.summary || {})
  }),

  [RPC.RUN_EVENT]: async (message) => {
    switch (message.kind) {
      case 'paused':
        await raiseAttention(
          message.title || 'Archiving paused',
          message.message || 'The page needs your attention.'
        );
        break;
      case 'resumed':
      case 'finished':
        await clearAttention();
        break;
      default:
        break;
    }
    return { ok: true };
  }
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = message && handlers[message.type];
  if (!handler) return false;

  // Returning true keeps the message channel open for the async reply.
  Promise.resolve(handler(message))
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});
