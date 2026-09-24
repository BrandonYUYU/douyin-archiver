import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  readPageMessage,
  makeMessage,
  isUsableResponsePayload,
  MSG_SOURCE,
  PROTOCOL_VERSION,
  FROM_PAGE,
  TO_PAGE,
  MAX_BODY_BYTES
} from '../extension/lib/protocol.js';

const WIN = { name: 'this-window' };
const OTHER_WIN = { name: 'some-iframe' };

function event(data, source = WIN) {
  return { source, data };
}

test('a well-formed hook message is accepted', () => {
  const message = readPageMessage(
    event(makeMessage(FROM_PAGE.RESPONSE, { url: 'https://x/y', body: '{}' })),
    WIN
  );
  assert.equal(message.type, FROM_PAGE.RESPONSE);
  assert.equal(message.payload.url, 'https://x/y');
});

test('messages from another window or frame are rejected', () => {
  const data = makeMessage(FROM_PAGE.RESPONSE, { url: 'u', body: '{}' });
  assert.equal(readPageMessage(event(data, OTHER_WIN), WIN), null);
});

test('a spoofed namespace is rejected', () => {
  // Douyin's own code shares this window and can post whatever it likes.
  const spoofed = {
    source: 'not-us',
    version: PROTOCOL_VERSION,
    type: FROM_PAGE.RESPONSE,
    payload: { url: 'u', body: '{}' }
  };
  assert.equal(readPageMessage(event(spoofed), WIN), null);
});

test('a mismatched protocol version is rejected', () => {
  const stale = {
    source: MSG_SOURCE,
    version: PROTOCOL_VERSION + 1,
    type: FROM_PAGE.RESPONSE,
    payload: { url: 'u', body: '{}' }
  };
  assert.equal(readPageMessage(event(stale), WIN), null);
});

test('an unknown or wrong-direction type is rejected', () => {
  for (const type of ['dya:something-else', TO_PAGE.CONFIG, '', 42, null]) {
    const data = { source: MSG_SOURCE, version: PROTOCOL_VERSION, type, payload: {} };
    assert.equal(readPageMessage(event(data), WIN), null, `type ${String(type)} slipped through`);
  }
});

test('malformed envelopes never throw', () => {
  const junk = [
    undefined,
    null,
    'string',
    42,
    event(null),
    event('text'),
    event([1, 2, 3]),
    event({ source: MSG_SOURCE, version: PROTOCOL_VERSION, type: FROM_PAGE.RESPONSE }),
    event({ source: MSG_SOURCE, version: PROTOCOL_VERSION, type: FROM_PAGE.RESPONSE, payload: 'x' }),
    event({ source: MSG_SOURCE, version: PROTOCOL_VERSION, type: FROM_PAGE.RESPONSE, payload: [] })
  ];
  for (const candidate of junk) {
    assert.equal(readPageMessage(candidate, WIN), null);
  }
});

test('response payloads are screened before anyone parses them', () => {
  assert.equal(isUsableResponsePayload({ url: 'https://x', body: '{"a":1}' }), true);

  assert.equal(isUsableResponsePayload({ url: '', body: '{}' }), false);
  assert.equal(isUsableResponsePayload({ url: 'https://x', body: '' }), false);
  assert.equal(isUsableResponsePayload({ url: 'https://x' }), false);
  assert.equal(isUsableResponsePayload({ body: '{}' }), false);
  assert.equal(isUsableResponsePayload(null), false);
  assert.equal(isUsableResponsePayload('nope'), false);
  // A hostile page could post an enormous string to wedge the content script.
  assert.equal(
    isUsableResponsePayload({ url: 'https://x', body: 'x'.repeat(MAX_BODY_BYTES + 1) }),
    false
  );
});

/**
 * hook.js runs in the MAIN world, where chrome.* does not exist, so it cannot
 * import lib/protocol.js and must repeat these literals. These assertions are
 * the only thing stopping the two copies from drifting apart silently.
 */
test('hook.js repeats the protocol constants exactly', () => {
  const hookSource = readFileSync(new URL('../extension/content/hook.js', import.meta.url), 'utf8');

  for (const literal of [
    MSG_SOURCE,
    FROM_PAGE.HOOK_READY,
    FROM_PAGE.RESPONSE,
    FROM_PAGE.RECON,
    TO_PAGE.CONFIG
  ]) {
    assert.ok(
      hookSource.includes(`'${literal}'`),
      `hook.js is missing the literal '${literal}' — the page channel would break`
    );
  }

  assert.ok(
    hookSource.includes(`PROTOCOL_VERSION = ${PROTOCOL_VERSION}`),
    'hook.js protocol version has drifted from lib/protocol.js'
  );
});

test('hook.js reads response bodies only through clone()', () => {
  const hookSource = readFileSync(new URL('../extension/content/hook.js', import.meta.url), 'utf8');

  // Consuming the original body would break Douyin's own feed, because the page
  // has not read it yet. This guards the most damaging possible regression here.
  const textCalls = [...hookSource.matchAll(/\.text\(\)/g)];
  assert.ok(textCalls.length > 0, 'hook.js no longer reads any response body');

  for (const match of textCalls) {
    const preceding = hookSource.slice(Math.max(0, match.index - 80), match.index);
    assert.ok(
      preceding.includes('.clone()'),
      `a .text() at offset ${match.index} is not preceded by .clone()`
    );
  }
});
