import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { normalizeListResponse, recordFromId } from '../extension/lib/normalize.js';
import { mergeRecord, mergeRecords, countRecords } from '../extension/lib/dedup.js';

const liked = JSON.parse(readFileSync(new URL('./fixtures/liked.synthetic.json', import.meta.url)));
const favorites = JSON.parse(
  readFileSync(new URL('./fixtures/favorites.synthetic.json', import.meta.url))
);

const T1 = 1_700_000_000_000;
const T2 = T1 + 60_000;

function likedRecords(now = T1) {
  return normalizeListResponse(liked, { listId: 'liked', now }).records;
}

test('duplicate ids inside one batch collapse to a single record', () => {
  // The fixture repeats one aweme_id, as a page boundary would.
  const records = likedRecords();
  assert.equal(records.length, 3);

  const result = mergeRecords({}, records);
  assert.equal(countRecords(result.records), 2);
  assert.equal(result.records['7301234567890123456'].likeCount, 12345);
});

test('within a batch, the later occurrence of an id supplies the newer metadata', () => {
  const [first] = likedRecords();
  const bumped = { ...first, likeCount: 20_000, commentCount: 900 };

  const result = mergeRecords({}, [first, bumped]);
  assert.equal(countRecords(result.records), 1);
  assert.equal(result.records[first.id].likeCount, 20_000);
  assert.equal(result.records[first.id].commentCount, 900);
});

test('merging a batch into an empty archive reports every record as added', () => {
  const result = mergeRecords({}, likedRecords());
  assert.equal(result.added, 2);
  assert.equal(result.updated, 0);
  assert.equal(result.known, 1, 'the in-batch duplicate counts as known');
});

test('re-merging the same batch adds nothing', () => {
  const first = mergeRecords({}, likedRecords());
  const second = mergeRecords(first.records, likedRecords(T2));

  assert.equal(second.added, 0);
  assert.equal(countRecords(second.records), countRecords(first.records));
});

test('mergeRecords does not mutate the archive it was given', () => {
  const archive = mergeRecords({}, likedRecords()).records;
  const snapshot = JSON.stringify(archive);

  mergeRecords(archive, [recordFromId('7399999999999999999', { listId: 'liked', now: T2 })]);
  assert.equal(JSON.stringify(archive), snapshot);
});

test('a video in both lists becomes one record with a union of lists', () => {
  const step1 = mergeRecords({}, likedRecords());
  const step2 = mergeRecords(
    step1.records,
    normalizeListResponse(favorites, { listId: 'favorites', now: T2 }).records
  );

  const shared = step2.records['7301234567890123456'];
  assert.deepEqual(shared.lists, ['favorites', 'liked']);
  assert.equal(step2.added, 1, 'only the favorites-only video is new');
  assert.equal(countRecords(step2.records), 3);
});

test('the DOM fallback never blanks metadata captured from the API', () => {
  const apiRecord = likedRecords()[0];
  const domRecord = recordFromId(apiRecord.id, { listId: 'liked', now: T2 });

  const { record, changed } = mergeRecord(apiRecord, domRecord);

  assert.equal(record.desc, apiRecord.desc);
  assert.equal(record.authorName, apiRecord.authorName);
  assert.equal(record.likeCount, apiRecord.likeCount);
  assert.equal(record.source, 'api', 'source must not downgrade to dom');
  assert.equal(changed, false, 'a sparse DOM record adds nothing to an API record');
});

test('source upgrades from dom to api', () => {
  const domRecord = recordFromId('7301234567890123456', { listId: 'liked', now: T1 });
  const apiRecord = likedRecords(T2)[0];

  const { record, changed } = mergeRecord(domRecord, apiRecord);
  assert.equal(record.source, 'api');
  assert.equal(record.desc, apiRecord.desc);
  assert.equal(changed, true);
});

test('timestamps widen: earliest first-seen, latest last-seen', () => {
  const early = likedRecords(T1)[0];
  const late = likedRecords(T2)[0];

  const { record } = mergeRecord(early, late);
  assert.equal(record.firstSeenAt, T1);
  assert.equal(record.lastSeenAt, T2);
});

test('a re-scan with unchanged data is not reported as updated', () => {
  const first = mergeRecords({}, likedRecords(T1));
  const second = mergeRecords(first.records, likedRecords(T2));
  assert.equal(second.updated, 0, 'only timestamps moved, which is not a change');
});

test('changed metadata is reported as updated', () => {
  const first = mergeRecords({}, likedRecords(T1));
  const bumped = likedRecords(T2).map((record) => ({ ...record, likeCount: 999_999 }));
  const second = mergeRecords(first.records, bumped);

  assert.equal(second.added, 0);
  assert.ok(second.updated > 0);
  assert.equal(second.records['7301234567890123456'].likeCount, 999_999);
});

test('consecutiveKnownAtEnd tracks the run of known ids ending the batch', () => {
  const archive = mergeRecords({}, likedRecords()).records;
  const known = Object.values(archive);

  // All known → the whole batch is a known run.
  const allKnown = mergeRecords(archive, known);
  assert.equal(allKnown.consecutiveKnownAtEnd, known.length);

  // A new id at the end resets the streak.
  const endsNew = mergeRecords(archive, [
    ...known,
    recordFromId('7355555555555555555', { listId: 'liked' })
  ]);
  assert.equal(endsNew.consecutiveKnownAtEnd, 0);

  // A new id in the middle: only the trailing known run counts.
  const newInMiddle = mergeRecords(archive, [
    known[0],
    recordFromId('7366666666666666666', { listId: 'liked' }),
    known[1]
  ]);
  assert.equal(newInMiddle.consecutiveKnownAtEnd, 1);
});

test('mergeRecords tolerates junk entries', () => {
  const result = mergeRecords({}, [null, 42, 'text', {}, { id: '' }, { id: '123' }]);
  assert.equal(countRecords(result.records), 1);
  assert.equal(result.added, 1);
});

test('mergeRecords tolerates a junk archive', () => {
  for (const archive of [null, undefined, 'nope', 42]) {
    const result = mergeRecords(archive, [{ id: '123', lists: ['liked'] }]);
    assert.equal(countRecords(result.records), 1);
  }
});
