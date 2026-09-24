import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  normalizeItem,
  normalizeListResponse,
  recordFromId,
  videoUrlFromId,
  RECORD_FIELDS
} from '../extension/lib/normalize.js';
import { getByPath, firstPath } from '../extension/lib/paths.js';

const liked = JSON.parse(readFileSync(new URL('./fixtures/liked.synthetic.json', import.meta.url)));
const favorites = JSON.parse(
  readFileSync(new URL('./fixtures/favorites.synthetic.json', import.meta.url))
);

const NOW = 1_700_000_000_000;

test('getByPath walks objects and array indices', () => {
  const source = { video: { cover: { url_list: ['first', 'second'] } } };
  assert.equal(getByPath(source, 'video.cover.url_list.0'), 'first');
  assert.equal(getByPath(source, 'video.cover.url_list.1'), 'second');
  assert.equal(getByPath(source, 'video.cover.url_list.9'), undefined);
  assert.equal(getByPath(source, 'video.missing.deep'), undefined);
  assert.equal(getByPath(null, 'a'), undefined);
});

test('getByPath refuses prototype-reaching keys', () => {
  assert.equal(getByPath({}, '__proto__.polluted'), undefined);
  assert.equal(getByPath({}, 'constructor.name'), undefined);
});

test('firstPath skips misses, blanks and empty arrays', () => {
  const source = { a: '', b: [], c: 0, d: 'value' };
  assert.equal(firstPath(source, ['missing', 'a', 'b', 'd']), 'value');
  // 0 is a legitimate value (a like count of zero) and must not be skipped.
  assert.equal(firstPath(source, ['a', 'c']), 0);
  assert.equal(firstPath(source, ['nope']), undefined);
});

test('a valid item maps every wanted field', () => {
  const record = normalizeItem(liked.aweme_list[0], { listId: 'liked', now: NOW });

  assert.equal(record.id, '7301234567890123456');
  assert.equal(record.url, 'https://www.douyin.com/video/7301234567890123456');
  assert.equal(record.desc, '今天的晚餐：红烧肉 🍖');
  assert.equal(record.authorName, '小明的厨房');
  assert.equal(record.authorUrl, 'https://www.douyin.com/user/SEC_UID_PLACEHOLDER_A');
  assert.equal(record.coverUrl, 'https://p3.douyinpic.com/placeholder-cover-a.jpeg');
  assert.equal(record.durationMs, 15000);
  assert.equal(record.likeCount, 12345);
  assert.equal(record.commentCount, 678);
  assert.equal(record.createTime, 1714400000);
  assert.deepEqual(record.lists, ['liked']);
  assert.equal(record.source, 'api');
  assert.equal(record.firstSeenAt, NOW);
  assert.equal(record.lastSeenAt, NOW);
});

test('the CDN play URL is never carried into a record', () => {
  const record = normalizeItem(liked.aweme_list[0], { listId: 'liked', now: NOW });
  const serialized = JSON.stringify(record);
  assert.ok(!serialized.includes('douyinvod'), 'play_addr host leaked into the record');
  assert.ok(!serialized.includes('EXPIRES-IN-HOURS'));
  // And no unexpected keys sneak in beyond the documented schema.
  assert.deepEqual(Object.keys(record).sort(), [...RECORD_FIELDS].sort());
});

test('an item without an id is rejected', () => {
  assert.equal(normalizeItem(liked.aweme_list[1], { listId: 'liked', now: NOW }), null);
});

test('garbage input never throws', () => {
  for (const input of [null, undefined, 42, 'text', [], [1, 2], true, { desc: 'no id' }]) {
    assert.equal(normalizeItem(input, { listId: 'liked' }), null);
  }
});

test('an id of the wrong shape is rejected', () => {
  assert.equal(normalizeItem({ aweme_id: 'has space' }, {}), null);
  assert.equal(normalizeItem({ aweme_id: '' }, {}), null);
  assert.equal(normalizeItem({ aweme_id: 'x'.repeat(65) }, {}), null);
  assert.ok(normalizeItem({ aweme_id: '123' }, {}));
});

test('protocol-relative cover URLs are upgraded to https', () => {
  const record = normalizeItem(liked.aweme_list[3], { listId: 'liked', now: NOW });
  assert.equal(record.coverUrl, 'https://p9.douyinpic.com/protocol-relative-cover.jpeg');
});

test('a non-http cover URL is dropped rather than stored', () => {
  const record = normalizeItem(
    { aweme_id: '123', video: { cover: { url_list: ['javascript:alert(1)'] } } },
    {}
  );
  assert.equal(record.coverUrl, '');
});

test('normalizeListResponse parses a JSON string body', () => {
  const result = normalizeListResponse(JSON.stringify(liked), { listId: 'liked', now: NOW });

  assert.equal(result.ok, true);
  assert.equal(result.itemCount, 4);
  assert.equal(result.records.length, 3, 'the id-less item should be dropped');
  assert.equal(result.droppedCount, 1);
  assert.equal(result.hasMore, true);
  assert.equal(result.cursor, 1714500000000);
  assert.equal(result.statusCode, 0);
});

test('normalizeListResponse resolves deeper nesting via candidate paths', () => {
  const result = normalizeListResponse(favorites, { listId: 'favorites', now: NOW });

  assert.equal(result.ok, true);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].id, '7311111111111111111');
  assert.equal(result.records[0].authorName, '旅行日记');
  assert.deepEqual(result.records[0].lists, ['favorites']);
  assert.equal(result.hasMore, false, 'has_more: false must not be read as truthy');
  assert.equal(result.cursor, 20);
});

test('unparseable and malformed bodies fail softly', () => {
  assert.equal(normalizeListResponse('<html>not json</html>', {}).reason, 'unparseable-json');
  assert.equal(normalizeListResponse('null', {}).reason, 'not-an-object');
  assert.equal(normalizeListResponse({ status_code: 8, aweme_list: [] }, {}).reason, 'status-code-8');
  assert.equal(normalizeListResponse({ status_code: 0 }, { listId: 'liked' }).reason, 'no-items-array');

  for (const result of [
    normalizeListResponse('<html>', {}),
    normalizeListResponse({ status_code: 2 }, {})
  ]) {
    assert.equal(result.ok, false);
    assert.deepEqual(result.records, []);
  }
});

test('a missing status_code is treated as success', () => {
  // Some endpoints omit it; rejecting those would capture nothing on a drift.
  const result = normalizeListResponse({ aweme_list: [{ aweme_id: '999' }] }, { listId: 'liked' });
  assert.equal(result.ok, true);
  assert.equal(result.records.length, 1);
});

test('an empty list is a success with zero records', () => {
  const result = normalizeListResponse(
    { status_code: 0, aweme_list: [], has_more: 0 },
    { listId: 'liked' }
  );
  assert.equal(result.ok, true);
  assert.equal(result.itemCount, 0);
  assert.equal(result.hasMore, false);
});

test('recordFromId builds a DOM-sourced record with just an id', () => {
  const record = recordFromId('7301234567890123456', { listId: 'liked', now: NOW });
  assert.equal(record.source, 'dom');
  assert.equal(record.url, videoUrlFromId('7301234567890123456'));
  assert.equal(record.desc, '');
  assert.equal(record.durationMs, undefined);
});
