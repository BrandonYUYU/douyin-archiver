import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  videoIdsFromHrefs,
  recordsFromHrefs,
  shouldHarvest,
  collectHrefs
} from '../extension/lib/domHarvest.js';
import { createRunState } from '../extension/lib/stopRules.js';
import { normalizeSettings } from '../extension/lib/settings.js';
import { mergeRecord } from '../extension/lib/dedup.js';
import { normalizeListResponse } from '../extension/lib/normalize.js';

const fragment = readFileSync(new URL('./fixtures/grid-fragment.sample.html', import.meta.url), 'utf8');
const liked = JSON.parse(readFileSync(new URL('./fixtures/liked.synthetic.json', import.meta.url)));

const SETTINGS = normalizeSettings({ domFallbackAfterSeconds: 20 });
const T0 = 1_700_000_000_000;

/**
 * Test-only href scraper. The extension uses querySelectorAll; here we just need
 * the hrefs out of the fixture so the real extraction logic can be exercised.
 */
function hrefsFromHtml(html) {
  return [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((match) => match[1]);
}

test('video ids are extracted from a realistic grid fragment', () => {
  const ids = videoIdsFromHrefs(hrefsFromHtml(fragment));

  assert.deepEqual(ids, [
    '7301234567890123456',
    '7309876543210987654',
    '7311111111111111111'
  ]);
});

test('duplicate tiles collapse and order is preserved', () => {
  const ids = videoIdsFromHrefs([
    '/video/7300000000000000002',
    '/video/7300000000000000001',
    '/video/7300000000000000002'
  ]);
  assert.deepEqual(ids, ['7300000000000000002', '7300000000000000001']);
});

test('non-video links are ignored rather than guessed at', () => {
  const ids = videoIdsFromHrefs([
    '/user/SEC_UID_PLACEHOLDER_A',
    '/search/foo',
    '/hashtag/1234567890',
    '/note/7300000000000000009',
    '/video/',
    '/video/12345',
    '',
    null,
    undefined,
    42,
    {}
  ]);
  assert.deepEqual(ids, []);
});

test('absolute URLs with query strings still yield the id', () => {
  const ids = videoIdsFromHrefs([
    'https://www.douyin.com/video/7309876543210987654?previous_page=user_like'
  ]);
  assert.deepEqual(ids, ['7309876543210987654']);
});

test('harvested records are flagged as DOM-sourced with a canonical URL', () => {
  const records = recordsFromHrefs(hrefsFromHtml(fragment), { listId: 'liked', now: T0 });

  assert.equal(records.length, 3);
  for (const record of records) {
    assert.equal(record.source, 'dom');
    assert.equal(record.url, `https://www.douyin.com/video/${record.id}`);
    assert.deepEqual(record.lists, ['liked']);
    assert.equal(record.desc, '', 'the DOM gives us no metadata, and must not invent any');
  }
});

test('a harvested record never overwrites richer API data', () => {
  const apiRecord = normalizeListResponse(liked, { listId: 'liked', now: T0 }).records[0];
  const [domRecord] = recordsFromHrefs([`/video/${apiRecord.id}`], { listId: 'liked', now: T0 + 1000 });

  const { record, changed } = mergeRecord(apiRecord, domRecord);

  assert.equal(changed, false);
  assert.equal(record.desc, apiRecord.desc);
  assert.equal(record.source, 'api');
});

// --- activation rule -------------------------------------------------------

test('the fallback stays off while responses are arriving', () => {
  const state = createRunState({ startedAt: T0 });
  state.lastResponseAt = T0 + 5_000;

  assert.equal(shouldHarvest(state, SETTINGS, T0 + 10_000), false);
});

test('the fallback activates after a quiet spell while the page still grows', () => {
  const state = createRunState({ startedAt: T0 });
  state.lastResponseAt = T0;
  state.noGrowthSteps = 0; // content is still appearing

  assert.equal(shouldHarvest(state, SETTINGS, T0 + 19_000), false, 'not yet');
  assert.equal(shouldHarvest(state, SETTINGS, T0 + 20_000), true);
});

test('the fallback stays off at the end of the list', () => {
  // Nothing arriving AND nothing growing is the end, not a broken interception.
  const state = createRunState({ startedAt: T0 });
  state.lastResponseAt = T0;
  state.noGrowthSteps = 3;

  assert.equal(shouldHarvest(state, SETTINGS, T0 + 60_000), false);
});

test('the fallback stays off while paused', () => {
  const state = createRunState({ startedAt: T0 });
  state.lastResponseAt = T0;
  state.paused = true;

  assert.equal(shouldHarvest(state, SETTINGS, T0 + 60_000), false);
});

test('a run that never sees a response falls back relative to its start', () => {
  const state = createRunState({ startedAt: T0 });
  state.lastResponseAt = null;

  assert.equal(shouldHarvest(state, SETTINGS, T0 + 5_000), false);
  assert.equal(shouldHarvest(state, SETTINGS, T0 + 25_000), true);
});

test('junk state never throws', () => {
  assert.equal(shouldHarvest(null, SETTINGS, T0), false);
  assert.deepEqual(videoIdsFromHrefs(null), []);
  assert.deepEqual(recordsFromHrefs(undefined, {}), []);
});

test('collectHrefs survives a document that throws', () => {
  assert.deepEqual(
    collectHrefs(
      {
        querySelectorAll() {
          throw new Error('SyntaxError');
        }
      },
      'a'
    ),
    []
  );
});

test('collectHrefs reads the href attribute, not the resolved property', () => {
  // Relative hrefs must survive; reading `.href` would absolutize them against
  // the extension origin in some contexts.
  const doc = {
    querySelectorAll: () => [
      { getAttribute: (name) => (name === 'href' ? '/video/7300000000000000001' : null) },
      { getAttribute: () => null }
    ]
  };
  assert.deepEqual(collectHrefs(doc, 'a'), ['/video/7300000000000000001', '']);
});
