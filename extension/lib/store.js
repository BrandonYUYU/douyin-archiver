/**
 * store.js — the archive itself: load, merge, checkpoint, report.
 *
 * Deliberately knows nothing about chrome.*. It is handed a `area` object with
 * `get`/`set`/`remove`, which in production is chrome.storage.local and in tests
 * is a plain fake. Same for the scheduler, so checkpoint timing is testable
 * without real timers.
 *
 * Two constraints drive the design:
 *
 *  - CRASH SAFETY (R7). A crash at record 900 must not cost 900 records, so
 *    writes happen during the run: on a short debounce, and immediately once
 *    enough records are pending. Never one big write at the end.
 *  - SERVICE WORKER EVICTION. MV3 kills idle workers, taking memory with them.
 *    Every entry point calls ensureLoaded(), so a fresh worker rebuilds state
 *    from storage instead of overwriting it with nothing. The debounce is far
 *    shorter than the ~30s idle timeout, so a flush is never left outstanding
 *    across an eviction.
 */

import { mergeRecords, countRecords } from './dedup.js';
import { RECORD_SCHEMA_VERSION } from './normalize.js';

export const STORE_KEYS = {
  RECORDS: 'records',
  META: 'meta'
};

export const DEFAULT_META = {
  schemaVersion: RECORD_SCHEMA_VERSION,
  total: 0,
  createdAt: null,
  updatedAt: null,
  lastRun: null
};

const realScheduler = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (handle) => clearTimeout(handle)
};

/**
 * @param {{
 *   area: {get: Function, set: Function, remove?: Function},
 *   now?: () => number,
 *   debounceMs?: number,
 *   flushAfterPending?: number,
 *   scheduler?: {schedule: Function, cancel: Function}
 * }} options
 */
export function createStore(options) {
  const {
    area,
    now = () => Date.now(),
    // Short enough that an eviction cannot strand a pending write, long enough
    // that a burst of pages does not rewrite the archive once per page.
    debounceMs = 1200,
    flushAfterPending = 25,
    scheduler = realScheduler
  } = options;

  let records = null; // null until loaded
  let meta = { ...DEFAULT_META };
  let pending = 0; // records added/updated since the last successful write
  let flushHandle = null;
  let writing = null; // in-flight write, so flushes serialize
  let lastFlush = Promise.resolve(); // most recent scheduled flush
  let queue = Promise.resolve(); // serializes ingest calls

  async function load() {
    const stored = await area.get([STORE_KEYS.RECORDS, STORE_KEYS.META]);
    const storedRecords = stored?.[STORE_KEYS.RECORDS];
    records = storedRecords && typeof storedRecords === 'object' ? storedRecords : {};
    meta = { ...DEFAULT_META, ...(stored?.[STORE_KEYS.META] || {}) };
    meta.total = countRecords(records);
    return records;
  }

  async function ensureLoaded() {
    if (records === null) await load();
    return records;
  }

  function cancelScheduledFlush() {
    if (flushHandle !== null) {
      scheduler.cancel(flushHandle);
      flushHandle = null;
    }
  }

  async function write() {
    const timestamp = now();
    meta = {
      ...meta,
      schemaVersion: RECORD_SCHEMA_VERSION,
      total: countRecords(records),
      createdAt: meta.createdAt ?? timestamp,
      updatedAt: timestamp
    };
    await area.set({ [STORE_KEYS.RECORDS]: records, [STORE_KEYS.META]: meta });
    pending = 0;
  }

  /** Force a checkpoint now. Safe to call at any time. */
  async function flush() {
    cancelScheduledFlush();
    if (records === null) return;
    // Collapse concurrent flushes onto the in-flight one.
    if (writing) {
      await writing;
      if (pending === 0) return;
    }
    writing = write().finally(() => {
      writing = null;
    });
    await writing;
  }

  function scheduleFlush() {
    if (flushHandle !== null) return;
    flushHandle = scheduler.schedule(() => {
      flushHandle = null;
      // Kept in a field rather than discarded, so whenIdle() can await it.
      lastFlush = flush();
    }, debounceMs);
  }

  /**
   * Resolve once nothing is outstanding — no queued merge, no pending write.
   * Used by tests and before export, where a stale read would be a real bug.
   */
  async function whenIdle() {
    await queue;
    await lastFlush;
    if (writing) await writing;
  }

  /**
   * Merge a batch into the archive.
   * @param {object[]} incoming
   * @returns {Promise<{
   *   added: number, updated: number, known: number, total: number,
   *   consecutiveKnownAtEnd: number, flushed: boolean
   * }>}
   */
  function ingest(incoming) {
    // Serialized so two overlapping batches cannot both merge onto the same
    // pre-merge snapshot and lose one of them.
    const task = queue.then(async () => {
      await ensureLoaded();

      const result = mergeRecords(records, incoming);
      records = result.records;
      meta.total = countRecords(records);
      pending += result.added + result.updated;

      let flushed = false;
      if (result.added + result.updated > 0) {
        if (pending >= flushAfterPending) {
          await flush();
          flushed = true;
        } else {
          scheduleFlush();
        }
      }

      return {
        added: result.added,
        updated: result.updated,
        known: result.known,
        total: meta.total,
        consecutiveKnownAtEnd: result.consecutiveKnownAtEnd,
        flushed
      };
    });

    // Keep the chain alive even if one ingest rejects.
    queue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  /** Replace the whole archive (used by import). Writes immediately. */
  async function replaceAll(nextRecords) {
    await ensureLoaded();
    records = nextRecords && typeof nextRecords === 'object' ? { ...nextRecords } : {};
    pending = countRecords(records);
    await flush();
    return meta.total;
  }

  /** Delete everything. Writes immediately. */
  async function clear() {
    records = {};
    meta = { ...DEFAULT_META, createdAt: null };
    pending = 0;
    cancelScheduledFlush();
    await area.set({ [STORE_KEYS.RECORDS]: {}, [STORE_KEYS.META]: meta });
    return 0;
  }

  async function getRecords() {
    await ensureLoaded();
    return records;
  }

  async function getMeta() {
    await ensureLoaded();
    return { ...meta, total: countRecords(records) };
  }

  /** Record how the last run went, for the popup to display. */
  async function setLastRun(summary) {
    await ensureLoaded();
    meta = { ...meta, lastRun: { ...summary, at: now() } };
    await flush();
    return meta.lastRun;
  }

  async function hasId(id) {
    await ensureLoaded();
    return Object.prototype.hasOwnProperty.call(records, id);
  }

  return {
    load,
    ingest,
    flush,
    whenIdle,
    replaceAll,
    clear,
    getRecords,
    getMeta,
    setLastRun,
    hasId,
    get pendingCount() {
      return pending;
    },
    get isLoaded() {
      return records !== null;
    }
  };
}
