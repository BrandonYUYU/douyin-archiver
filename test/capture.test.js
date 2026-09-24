import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { readPageMessage, makeMessage, FROM_PAGE } from '../extension/lib/protocol.js';
import { captureListResponse } from '../extension/lib/capture.js';
import { countRecords } from '../extension/lib/dedup.js';

const likedBody = readFileSync(new URL('./fixtures/liked.synthetic.json', import.meta.url), 'utf8');
const favoritesBody = readFileSync(
  new URL('./fixtures/favorites.synthetic.json', import.meta.url),
  'utf8'
);

const WIN = { name: 'this-window' };
const LIKED_URL = 'https://www.douyin.com/aweme/v1/web/aweme/favorite/?max_cursor=0&count=18';
const FAVORITES_URL = 'https://www.douyin.com/aweme/v1/web/aweme/listcollection/?cursor=0';

/**
 * Replays exactly what content.js does with a window message: validate the
 * envelope, then run the payload through the capture pipeline.
 */
function receive(event, archive) {
  const message = readPageMessage(event, WIN);
  if (!message || message.type !== FROM_PAGE.RESPONSE) return null;
  return captureListResponse(message.payload, { archive });
}

function hookMessage(url, body) {
  return {
    source: WIN,
    data: makeMessage(FROM_PAGE.RESPONSE, { kind: 'fetch', url, status: 200, body })
  };
}

test('a forwarded liked-list response becomes records', () => {
  const outcome = receive(hookMessage(LIKED_URL, likedBody), {});

  assert.equal(outcome.accepted, true);
  assert.equal(outcome.listId, 'liked');
  assert.equal(outcome.result.itemCount, 4);
  assert.equal(outcome.result.droppedCount, 1);
  assert.equal(outcome.merged.added, 2);
  assert.equal(countRecords(outcome.merged.records), 2);

  const urls = Object.values(outcome.merged.records).map((record) => record.url);
  assert.deepEqual(urls.sort(), [
    'https://www.douyin.com/video/7301234567890123456',
    'https://www.douyin.com/video/7309876543210987654'
  ]);
});

test('the favorites endpoint is attributed to the favorites list', () => {
  const outcome = receive(hookMessage(FAVORITES_URL, favoritesBody), {});
  assert.equal(outcome.listId, 'favorites');
  assert.equal(outcome.merged.added, 2);
});

test('successive pages accumulate into one archive', () => {
  const first = receive(hookMessage(LIKED_URL, likedBody), {});
  const second = receive(hookMessage(FAVORITES_URL, favoritesBody), first.merged.records);

  assert.equal(second.merged.added, 1, 'the shared video is not counted twice');
  assert.equal(countRecords(second.merged.records), 3);
  assert.deepEqual(second.merged.records['7301234567890123456'].lists, ['favorites', 'liked']);
});

test('replaying the same page adds nothing', () => {
  const first = receive(hookMessage(LIKED_URL, likedBody), {});
  const replay = receive(hookMessage(LIKED_URL, likedBody), first.merged.records);

  assert.equal(replay.merged.added, 0);
  assert.equal(countRecords(replay.merged.records), countRecords(first.merged.records));
});

test('a spoofed envelope from the page is never captured', () => {
  const spoofed = {
    source: WIN,
    data: {
      source: 'douyin-page-script',
      version: 1,
      type: FROM_PAGE.RESPONSE,
      payload: { url: LIKED_URL, body: likedBody }
    }
  };
  assert.equal(receive(spoofed, {}), null);
});

test('a message relayed from another frame is never captured', () => {
  const fromIframe = { ...hookMessage(LIKED_URL, likedBody), source: { name: 'iframe' } };
  assert.equal(receive(fromIframe, {}), null);
});

test('unrelated traffic that passed the broad filter is discarded', () => {
  const outcome = receive(
    hookMessage('https://www.douyin.com/aweme/v1/web/general/search/single/', '{"status_code":0}'),
    {}
  );
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'not-a-list-url');
  assert.equal(outcome.merged, null);
});

test('an HTML error page instead of JSON fails softly', () => {
  const outcome = receive(hookMessage(LIKED_URL, '<html>blocked</html>'), {});
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'unparseable-json');
  assert.equal(outcome.listId, 'liked');
});

test('an error status_code is reported, not captured', () => {
  const outcome = receive(hookMessage(LIKED_URL, '{"status_code":2154,"aweme_list":[]}'), {});
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'status-code-2154');
});

test('an empty final page is accepted with zero new records', () => {
  const outcome = receive(hookMessage(LIKED_URL, '{"status_code":0,"aweme_list":[],"has_more":0}'), {});
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.result.itemCount, 0);
  assert.equal(outcome.result.hasMore, false);
  assert.equal(outcome.merged.added, 0);
});

test('an oversized body is refused before parsing', () => {
  const outcome = captureListResponse({ url: LIKED_URL, body: 'x'.repeat(13 * 1024 * 1024) }, {});
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'unusable-payload');
});
