import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findInterruption,
  describeInterruption,
  INTERRUPTIONS,
  createDomProbe
} from '../extension/lib/interruptions.js';
import { SELECTORS } from '../extension/lib/targets.js';

/**
 * Fake DOM probe. `map` is selector → array of fake elements, where an element is
 * just `{visible: boolean}`.
 */
function fakeProbe(map) {
  return {
    query: (selector) => map[selector] || [],
    isVisible: (element) => Boolean(element?.visible)
  };
}

test('nothing in the way returns null', () => {
  assert.equal(findInterruption(fakeProbe({}), SELECTORS), null);
});

test('a visible captcha container is detected', () => {
  const probe = fakeProbe({ '#captcha_container': [{ visible: true }] });
  const found = findInterruption(probe, SELECTORS);

  assert.equal(found.kind, INTERRUPTIONS.CAPTCHA);
  assert.equal(found.selector, '#captcha_container');
});

test('a hidden captcha container is IGNORED', () => {
  // Douyin ships captcha markup in the page before it is ever shown. Matching on
  // the selector alone would pause every run forever.
  const probe = fakeProbe({
    '#captcha_container': [{ visible: false }],
    '.captcha_verify_container': [{ visible: false }]
  });
  assert.equal(findInterruption(probe, SELECTORS), null);
});

test('one visible element among hidden siblings still counts', () => {
  const probe = fakeProbe({
    '[class*="captcha_verify"]': [{ visible: false }, { visible: false }, { visible: true }]
  });
  assert.equal(findInterruption(probe, SELECTORS).kind, INTERRUPTIONS.CAPTCHA);
});

test('a login wall is reported as its own kind', () => {
  const probe = fakeProbe({ '#login-panel': [{ visible: true }] });
  assert.equal(findInterruption(probe, SELECTORS).kind, INTERRUPTIONS.LOGIN);
});

test('captcha wins over a login wall when both are visible', () => {
  const probe = fakeProbe({
    '#captcha_container': [{ visible: true }],
    '#login-panel': [{ visible: true }]
  });
  assert.equal(findInterruption(probe, SELECTORS).kind, INTERRUPTIONS.CAPTCHA);
});

test('a broken probe or selector list never throws', () => {
  assert.equal(findInterruption(null, SELECTORS), null);
  assert.equal(findInterruption({}, SELECTORS), null);
  assert.equal(findInterruption(fakeProbe({}), null), null);
  assert.equal(findInterruption(fakeProbe({}), { captcha: 'not-an-array' }), null);
});

test('a selector that throws is skipped rather than killing the run', () => {
  const probe = {
    query(selector) {
      if (selector === '#captcha_container') throw new Error('bad selector');
      return selector === '#login-panel' ? [{ visible: true }] : [];
    },
    isVisible: (element) => Boolean(element?.visible)
  };

  // The throwing selector is skipped and the later match is still found.
  assert.equal(findInterruption(probe, SELECTORS).kind, INTERRUPTIONS.LOGIN);
});

test('the DOM probe returns nothing for a malformed selector', () => {
  const domProbe = createDomProbe(
    {
      querySelectorAll() {
        throw new Error('SyntaxError: not a valid selector');
      }
    },
    {}
  );
  assert.deepEqual(domProbe.query('!!!'), []);
});

test('every interruption kind has user-facing text', () => {
  for (const kind of Object.values(INTERRUPTIONS)) {
    assert.match(describeInterruption(kind), /\w/);
  }
  assert.match(describeInterruption('something-new'), /\w/);
});

test('the real probe rejects elements that are too small to be a dialog', () => {
  const tiny = {
    getBoundingClientRect: () => ({ width: 10, height: 10 })
  };
  const big = {
    getBoundingClientRect: () => ({ width: 300, height: 200 })
  };
  const win = { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) };
  const probe = createDomProbe({ querySelectorAll: () => [] }, win);

  assert.equal(probe.isVisible(tiny), false);
  assert.equal(probe.isVisible(big), true);
});

test('the real probe respects display, visibility and opacity', () => {
  const element = { getBoundingClientRect: () => ({ width: 300, height: 200 }) };
  const probeWith = (style) =>
    createDomProbe({ querySelectorAll: () => [] }, { getComputedStyle: () => style });

  assert.equal(probeWith({ display: 'none' }).isVisible(element), false);
  assert.equal(probeWith({ visibility: 'hidden' }).isVisible(element), false);
  assert.equal(probeWith({ opacity: '0' }).isVisible(element), false);
  assert.equal(probeWith({ display: 'block', visibility: 'visible', opacity: '1' }).isVisible(element), true);
});
