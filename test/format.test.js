import test from 'node:test';
import assert from 'node:assert/strict';

import { formatBadgeCount, formatDuration } from '../extension/lib/format.js';

test('badge counts stay within the four characters Chrome renders', () => {
  const cases = [0, 1, 7, 99, 999, 1000, 1234, 9999, 10_000, 42_000, 99_999, 250_000];
  for (const value of cases) {
    assert.ok(
      formatBadgeCount(value).length <= 4,
      `${value} formatted to "${formatBadgeCount(value)}", which is too long`
    );
  }
});

test('badge counts abbreviate rather than truncate', () => {
  assert.equal(formatBadgeCount(0), '');
  assert.equal(formatBadgeCount(1), '1');
  assert.equal(formatBadgeCount(999), '999');
  assert.equal(formatBadgeCount(1000), '1k');
  assert.equal(formatBadgeCount(1234), '1.2k');
  assert.equal(formatBadgeCount(9999), '9.9k');
  assert.equal(formatBadgeCount(10_000), '10k');
  assert.equal(formatBadgeCount(42_500), '42k');
  assert.equal(formatBadgeCount(250_000), '99k+');
});

test('badge counts ignore junk instead of rendering NaN', () => {
  for (const value of [undefined, null, 'x', -5, NaN, {}]) {
    assert.equal(formatBadgeCount(value), '');
  }
});

test('durations read naturally', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(9_400), '9s');
  assert.equal(formatDuration(59_000), '59s');
  assert.equal(formatDuration(60_000), '1m');
  assert.equal(formatDuration(95_000), '1m 35s');
  assert.equal(formatDuration(600_000), '10m');
  assert.equal(formatDuration(undefined), '0s');
});
