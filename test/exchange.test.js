import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildExport, parseImport, exportFilename, EXPORT_FORMAT } from '../extension/lib/exchange.js';
import { normalizeListResponse } from '../extension/lib/normalize.js';
import { mergeRecords, countRecords } from '../extension/lib/dedup.js';
import { createStore } from '../extension/lib/store.js';

const liked = JSON.parse(readFileSync(new URL('./fixtures/liked.synthetic.json', import.meta.url)));
const favorites = JSON.parse(
  readFileSync(new URL('./fixtures/favorites.synthetic.json', import.meta.url))
);

const NOW = 1_700_000_000_000;

function archive() {
  const a = mergeRecords({}, normalizeListResponse(liked, { listId: 'liked', now: NOW }).records);
  const b = mergeRecords(
    a.records,
    normalizeListResponse(favorites, { listId: 'favorites', now: NOW }).records
  );
  return b.records;
}

function fakeArea(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      const wanted = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of wanted) {
        if (Object.prototype.hasOwnProperty.call(data, key)) out[key] = structuredClone(data[key]);
      }
      return out;
    },
    async set(patch) {
      Object.assign(data, structuredClone(patch));
    }
  };
}

test('an export carries a format marker, schema version and timestamp', () => {
  const payload = buildExport(archive(), { now: NOW, meta: { createdAt: NOW - 1000 } });

  assert.equal(payload.format, EXPORT_FORMAT);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.exportedAt, '2023-11-14T22:13:20.000Z');
  assert.equal(payload.total, 3);
  assert.equal(payload.records.length, 3);
  assert.equal(payload.archiveCreatedAt, '2023-11-14T22:13:19.000Z');
});

test('exported records are ordered newest first', () => {
  const times = buildExport(archive(), { now: NOW }).records.map((record) => record.createTime);
  const sorted = [...times].sort((a, b) => b - a);
  assert.deepEqual(times, sorted);
});

test('export then import round-trips every record exactly', () => {
  const original = archive();
  const text = JSON.stringify(buildExport(original, { now: NOW }));

  const result = parseImport(text, { now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, 0);
  assert.equal(result.records.length, countRecords(original));

  const restored = mergeRecords({}, result.records).records;
  assert.deepEqual(
    Object.keys(restored).sort(),
    Object.keys(original).sort()
  );
  for (const id of Object.keys(original)) {
    assert.deepEqual(restored[id], original[id], `record ${id} changed across the round trip`);
  }
});

test('importing the same file twice adds nothing the second time', async () => {
  const text = JSON.stringify(buildExport(archive(), { now: NOW }));
  const store = createStore({ area: fakeArea(), flushAfterPending: 1, now: () => NOW });

  const first = await store.ingest(parseImport(text, { now: NOW }).records);
  const second = await store.ingest(parseImport(text, { now: NOW }).records);

  assert.equal(first.added, 3);
  assert.equal(second.added, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.total, 3);
});

test('import restores an archive that was wiped', async () => {
  const area = fakeArea();
  const store = createStore({ area, flushAfterPending: 1, now: () => NOW });

  await store.ingest(Object.values(archive()));
  const backup = JSON.stringify(buildExport(await store.getRecords(), { now: NOW }));
  const before = (await store.getMeta()).total;

  await store.clear();
  assert.equal((await store.getMeta()).total, 0);

  await store.ingest(parseImport(backup, { now: NOW }).records);
  assert.equal((await store.getMeta()).total, before);
});

test('a bare array of records is accepted with a warning', () => {
  const records = Object.values(archive());
  const result = parseImport(JSON.stringify(records), { now: NOW });

  assert.equal(result.ok, true);
  assert.equal(result.records.length, records.length);
  assert.match(result.warnings.join(' '), /bare array/i);
});

test('a leading BOM does not break the parser', () => {
  const text = '\uFEFF' + JSON.stringify(buildExport(archive(), { now: NOW }));
  assert.equal(parseImport(text, { now: NOW }).ok, true);
});

test('a newer schema version imports with a warning rather than failing', () => {
  const payload = buildExport(archive(), { now: NOW });
  payload.schemaVersion = 99;
  payload.records = payload.records.map((record) => ({ ...record, futureField: 'ignored' }));

  const result = parseImport(JSON.stringify(payload), { now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.schemaVersion, 99);
  assert.match(result.warnings.join(' '), /schema v99/);
  assert.ok(!('futureField' in result.records[0]), 'unknown fields must not reach storage');
});

test('records without a usable id are skipped, not fatal', () => {
  const result = parseImport(
    JSON.stringify({
      format: EXPORT_FORMAT,
      records: [{ id: '7301234567890123456' }, { desc: 'no id' }, null, 42, { id: 'bad id' }]
    }),
    { now: NOW }
  );

  assert.equal(result.ok, true);
  assert.equal(result.records.length, 1);
  assert.equal(result.skipped, 4);
});

test('a doctored URL in a file is replaced with the canonical one', () => {
  const result = parseImport(
    JSON.stringify([{ id: '7301234567890123456', url: 'https://evil.example/phish' }]),
    { now: NOW }
  );
  assert.equal(result.records[0].url, 'https://www.douyin.com/video/7301234567890123456');
});

test('unrelated or broken files are rejected with a reason', () => {
  assert.equal(parseImport('', {}).reason, 'empty-file');
  assert.equal(parseImport('not json', {}).reason, 'unparseable-json');
  assert.equal(parseImport('"a string"', {}).reason, 'not-an-object');
  assert.equal(parseImport(JSON.stringify({ hello: 'world' }), {}).reason, 'no-records-array');
  assert.equal(parseImport(JSON.stringify({ records: [] }), {}).reason, 'no-usable-records');
  assert.equal(parseImport(JSON.stringify({ records: [{ nope: 1 }] }), {}).reason, 'no-usable-records');
});

test('export filenames sort chronologically and are safe on Windows', () => {
  const name = exportFilename('json', NOW);
  assert.equal(name, 'douyin-archive-2023-11-14-22-13.json');
  assert.ok(!/[:<>"|?*]/.test(name), 'filename contains a character Windows forbids');
});
