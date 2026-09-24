import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createStore, STORE_KEYS } from '../extension/lib/store.js';
import { normalizeListResponse, recordFromId } from '../extension/lib/normalize.js';
import { countRecords } from '../extension/lib/dedup.js';

const liked = JSON.parse(readFileSync(new URL('./fixtures/liked.synthetic.json', import.meta.url)));

/** Stands in for chrome.storage.local, counting writes so checkpoints are visible. */
function fakeArea(initial = {}) {
  const data = structuredClone(initial);
  const stats = { writes: 0, reads: 0 };
  return {
    data,
    stats,
    async get(keys) {
      stats.reads += 1;
      const wanted = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of wanted) {
        if (Object.prototype.hasOwnProperty.call(data, key)) out[key] = structuredClone(data[key]);
      }
      return out;
    },
    async set(patch) {
      stats.writes += 1;
      Object.assign(data, structuredClone(patch));
    }
  };
}

/** Timers we can fire by hand, so debounce behaviour is deterministic. */
function manualScheduler() {
  const tasks = [];
  return {
    schedule(fn) {
      tasks.push({ fn, cancelled: false });
      return tasks.length - 1;
    },
    cancel(handle) {
      if (tasks[handle]) tasks[handle].cancelled = true;
    },
    pendingCount() {
      return tasks.filter((task) => !task.cancelled).length;
    },
    runAll() {
      for (const task of tasks) if (!task.cancelled) task.fn();
      tasks.length = 0;
    }
  };
}

function records(now = 1_700_000_000_000) {
  return normalizeListResponse(liked, { listId: 'liked', now }).records;
}

function makeStore(area, overrides = {}) {
  const scheduler = overrides.scheduler || manualScheduler();
  const store = createStore({ area, scheduler, now: () => 1_700_000_000_000, ...overrides });
  return { store, scheduler };
}

test('an empty archive loads as empty rather than throwing', async () => {
  const area = fakeArea();
  const { store } = makeStore(area);

  const meta = await store.getMeta();
  assert.equal(meta.total, 0);
  assert.equal(countRecords(await store.getRecords()), 0);
});

test('ingest merges and reports counts', async () => {
  const { store } = makeStore(fakeArea());

  const result = await store.ingest(records());
  assert.equal(result.added, 2);
  assert.equal(result.updated, 0);
  assert.equal(result.total, 2);
  assert.equal(result.known, 1, 'the in-batch duplicate counts as known');
});

test('a small batch defers the write to a debounced checkpoint', async () => {
  const area = fakeArea();
  const { store, scheduler } = makeStore(area);

  const result = await store.ingest(records());
  assert.equal(result.flushed, false);
  assert.equal(area.stats.writes, 0, 'nothing written yet');
  assert.equal(scheduler.pendingCount(), 1, 'a checkpoint is scheduled');

  scheduler.runAll();
  await store.whenIdle();

  assert.equal(area.stats.writes, 1);
  assert.equal(countRecords(area.data[STORE_KEYS.RECORDS]), 2);
});

test('enough pending records force an immediate checkpoint', async () => {
  const area = fakeArea();
  const { store } = makeStore(area, { flushAfterPending: 3 });

  const batch = Array.from({ length: 5 }, (_, index) =>
    recordFromId(`73000000000000000${index}`, { listId: 'liked' })
  );
  const result = await store.ingest(batch);

  assert.equal(result.flushed, true, 'should not wait for the debounce');
  assert.equal(area.stats.writes, 1);
  assert.equal(countRecords(area.data[STORE_KEYS.RECORDS]), 5);
});

test('a checkpoint mid-run survives losing the worker — the crash-safety case', async () => {
  const area = fakeArea();
  const first = makeStore(area, { flushAfterPending: 2 });

  await first.store.ingest(records());
  assert.ok(area.stats.writes > 0);

  // Simulate MV3 evicting the worker: brand new store, same storage.
  const second = makeStore(area);
  const meta = await second.store.getMeta();
  assert.equal(meta.total, 2, 'records written before the crash are still there');
});

test('a fresh worker never overwrites storage with an empty archive', async () => {
  const area = fakeArea();
  const first = makeStore(area, { flushAfterPending: 1 });
  await first.store.ingest(records());
  const totalBefore = countRecords(area.data[STORE_KEYS.RECORDS]);

  // A new worker that flushes before reading would wipe the archive.
  const second = makeStore(area);
  await second.store.flush();

  assert.equal(countRecords(area.data[STORE_KEYS.RECORDS]), totalBefore);
});

test('a new worker continues deduplicating against what is already stored', async () => {
  const area = fakeArea();
  const first = makeStore(area, { flushAfterPending: 1 });
  await first.store.ingest(records());

  const second = makeStore(area, { flushAfterPending: 1 });
  const result = await second.store.ingest(records(1_700_000_100_000));

  assert.equal(result.added, 0, 'already-stored records must not be re-added');
  assert.equal(result.total, 2);
});

test('overlapping ingests do not lose records', async () => {
  const area = fakeArea();
  const { store } = makeStore(area, { flushAfterPending: 1000 });

  const batchA = [recordFromId('7300000000000000001', { listId: 'liked' })];
  const batchB = [recordFromId('7300000000000000002', { listId: 'liked' })];
  const batchC = [recordFromId('7300000000000000003', { listId: 'liked' })];

  // Fired without awaiting in between, as two fast pages would.
  const results = await Promise.all([
    store.ingest(batchA),
    store.ingest(batchB),
    store.ingest(batchC)
  ]);

  assert.deepEqual(
    results.map((result) => result.added),
    [1, 1, 1]
  );
  assert.equal(countRecords(await store.getRecords()), 3);
});

test('meta carries a schema version and timestamps', async () => {
  const area = fakeArea();
  const { store } = makeStore(area, { flushAfterPending: 1 });

  await store.ingest(records());
  const meta = await store.getMeta();

  assert.equal(meta.schemaVersion, 1);
  assert.equal(meta.createdAt, 1_700_000_000_000);
  assert.equal(meta.updatedAt, 1_700_000_000_000);
  assert.equal(meta.total, 2);
});

test('replaceAll swaps the archive and writes immediately', async () => {
  const area = fakeArea();
  const { store } = makeStore(area, { flushAfterPending: 1 });
  await store.ingest(records());

  const replacement = { '7399999999999999999': recordFromId('7399999999999999999', {}) };
  const total = await store.replaceAll(replacement);

  assert.equal(total, 1);
  assert.deepEqual(Object.keys(area.data[STORE_KEYS.RECORDS]), ['7399999999999999999']);
});

test('clear empties the archive and the stored copy', async () => {
  const area = fakeArea();
  const { store } = makeStore(area, { flushAfterPending: 1 });
  await store.ingest(records());

  assert.equal(await store.clear(), 0);
  assert.deepEqual(area.data[STORE_KEYS.RECORDS], {});
  assert.equal((await store.getMeta()).total, 0);
});

test('hasId answers from the loaded archive', async () => {
  const { store } = makeStore(fakeArea());
  await store.ingest(records());

  assert.equal(await store.hasId('7301234567890123456'), true);
  assert.equal(await store.hasId('nope'), false);
});

test('setLastRun persists a run summary for the popup', async () => {
  const area = fakeArea();
  const { store } = makeStore(area);

  await store.setLastRun({ listId: 'liked', added: 7, reason: 'end-of-list' });
  const meta = await store.getMeta();

  assert.equal(meta.lastRun.listId, 'liked');
  assert.equal(meta.lastRun.added, 7);
  assert.equal(meta.lastRun.at, 1_700_000_000_000);
  assert.equal(area.data[STORE_KEYS.META].lastRun.reason, 'end-of-list');
});

test('corrupt stored data degrades to an empty archive instead of throwing', async () => {
  for (const corrupt of ['not-an-object', 42, null, []]) {
    const area = fakeArea({ [STORE_KEYS.RECORDS]: corrupt });
    const { store } = makeStore(area);
    const total = (await store.getMeta()).total;
    assert.ok(Number.isInteger(total), `total should be a number for ${JSON.stringify(corrupt)}`);
  }
});

test('an ingest of junk writes nothing and schedules nothing', async () => {
  const area = fakeArea();
  const { store, scheduler } = makeStore(area);

  const result = await store.ingest([null, 'x', {}, 42]);
  assert.equal(result.added, 0);
  assert.equal(area.stats.writes, 0);
  assert.equal(scheduler.pendingCount(), 0, 'no checkpoint needed when nothing changed');
});
