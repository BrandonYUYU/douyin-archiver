import test from 'node:test';
import assert from 'node:assert/strict';

import { createRunner, createRunState } from '../extension/lib/scroll.js';
import {
  evaluateStop,
  evaluateThrottle,
  advanceKnownStreak,
  STOP_REASONS,
  PAUSE_REASONS,
  describeStop
} from '../extension/lib/stopRules.js';
import { normalizeSettings } from '../extension/lib/settings.js';

const SETTINGS = normalizeSettings({
  minDelayMs: 1500,
  maxDelayMs: 3000,
  emptyResponseLimit: 3,
  noGrowthLimit: 3,
  maxRunMinutes: 45
});

const T0 = 1_700_000_000_000;

/**
 * A page that grows for `growthSteps` scrolls and then stops, like a real list
 * reaching its end.
 */
function fakePage({ growthSteps = 5, startHeight = 2000, perStep = 1200 } = {}) {
  let height = startHeight;
  let steps = 0;
  return {
    stepCount: () => steps,
    scrollHeight: () => height,
    stepToBottom() {
      steps += 1;
      if (steps <= growthSteps) height += perStep;
    }
  };
}

/**
 * A clock and sleep that advance together, so no real time passes.
 *
 * `sleep` must yield to the MACROTASK queue, not just resolve a microtask:
 * otherwise a busy loop (like the pause poll) starves any pending setTimeout and
 * the run never resumes. That mistake hangs the suite rather than failing it.
 */
function fakeClock(start = T0) {
  let current = start;
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
    advance: (ms) => {
      current += ms;
    }
  };
}

// --- stop rules ------------------------------------------------------------

test('a fresh run does not stop', () => {
  const state = createRunState({ startedAt: T0 });
  assert.deepEqual(evaluateStop(state, SETTINGS, T0), { stop: false, reason: null });
});

test('a user stop wins over everything', () => {
  const state = createRunState({ startedAt: T0 });
  state.stopRequested = true;
  state.paused = true;
  assert.equal(evaluateStop(state, SETTINGS, T0).reason, STOP_REASONS.USER);
});

test('a paused run is never mistaken for a finished one', () => {
  // This is the captcha case: nothing is loading, nothing is growing, but the
  // run must wait rather than declare the list finished.
  const state = createRunState({ startedAt: T0 });
  state.paused = true;
  state.noGrowthSteps = 99;
  state.stepsSinceLastResponse = 99;
  state.emptyResponses = 99;

  assert.equal(evaluateStop(state, SETTINGS, T0 + 60_000).stop, false);
});

test('the time limit ends a run', () => {
  const state = createRunState({ startedAt: T0 });
  assert.equal(evaluateStop(state, SETTINGS, T0 + 44 * 60_000).stop, false);
  assert.equal(
    evaluateStop(state, SETTINGS, T0 + 45 * 60_000).reason,
    STOP_REASONS.MAX_DURATION
  );
});

test('has_more false ends the run, but only after a parsed response', () => {
  const state = createRunState({ startedAt: T0 });
  state.hasMore = false;
  // No response parsed yet: a stale or defaulted flag must not end the run.
  assert.equal(evaluateStop(state, SETTINGS, T0).stop, false);

  state.listResponses = 1;
  assert.equal(evaluateStop(state, SETTINGS, T0).reason, STOP_REASONS.NO_MORE);
});

test('empty pages end the run at the configured limit, not before', () => {
  const state = createRunState({ startedAt: T0 });
  state.listResponses = 4;

  state.emptyResponses = 1;
  assert.equal(evaluateStop(state, SETTINGS, T0).stop, false, 'one slow page is not the end');

  state.emptyResponses = 2;
  assert.equal(evaluateStop(state, SETTINGS, T0).stop, false);

  state.emptyResponses = 3;
  assert.equal(evaluateStop(state, SETTINGS, T0).reason, STOP_REASONS.EMPTY_PAGES);
});

test('no growth alone does not end the run — it must also stop requesting', () => {
  const state = createRunState({ startedAt: T0 });
  state.listResponses = 2;
  state.noGrowthSteps = 5;
  state.stepsSinceLastResponse = 1;

  assert.equal(
    evaluateStop(state, SETTINGS, T0).stop,
    false,
    'growth pauses while a request is in flight; that is not the end'
  );

  state.stepsSinceLastResponse = 3;
  assert.equal(evaluateStop(state, SETTINGS, T0).reason, STOP_REASONS.NO_GROWTH);
});

test('every stop reason has user-facing text', () => {
  for (const reason of Object.values(STOP_REASONS)) {
    assert.match(describeStop(reason), /\w/);
  }
});

test('empty pages count as a throttle only while the API claims more', () => {
  const state = createRunState({ startedAt: T0 });
  state.listResponses = 5;
  state.emptyResponses = 3;

  // has_more unknown → this is the end of the list, not a throttle.
  assert.equal(evaluateThrottle(state, SETTINGS).throttled, false);

  state.hasMore = false;
  assert.equal(evaluateThrottle(state, SETTINGS).throttled, false);

  // has_more true with empty pages is a contradiction — something is throttling.
  state.hasMore = true;
  assert.equal(evaluateThrottle(state, SETTINGS).throttled, true);

  // Below the limit it is just a slow page.
  state.emptyResponses = 1;
  assert.equal(evaluateThrottle(state, SETTINGS).throttled, false);
});

test('an already-paused run is not re-flagged as throttled', () => {
  const state = createRunState({ startedAt: T0 });
  state.listResponses = 5;
  state.emptyResponses = 9;
  state.hasMore = true;
  state.paused = true;

  assert.equal(evaluateThrottle(state, SETTINGS).throttled, false);
});

// --- incremental runs ------------------------------------------------------

test('the known streak accumulates across pages', () => {
  // An all-known page of 18 extends the streak; the next all-known page extends
  // it further. A 50-video threshold is normally reached across three pages.
  let streak = 0;
  streak = advanceKnownStreak(streak, { added: 0, known: 18, consecutiveKnownAtEnd: 18 });
  assert.equal(streak, 18);
  streak = advanceKnownStreak(streak, { added: 0, known: 18, consecutiveKnownAtEnd: 18 });
  assert.equal(streak, 36);
  streak = advanceKnownStreak(streak, { added: 0, known: 18, consecutiveKnownAtEnd: 18 });
  assert.equal(streak, 54);
});

test('a page containing anything new breaks the streak', () => {
  const streak = advanceKnownStreak(40, { added: 2, known: 16, consecutiveKnownAtEnd: 5 });
  assert.equal(streak, 5, 'restarts from the known run trailing that page');

  assert.equal(
    advanceKnownStreak(40, { added: 1, known: 0, consecutiveKnownAtEnd: 0 }),
    0,
    'a page ending on a new video resets to zero'
  );
});

test('advanceKnownStreak tolerates junk', () => {
  assert.equal(advanceKnownStreak(undefined, null), 0);
  assert.equal(advanceKnownStreak(-5, { added: 0, known: 3 }), 3);
  assert.equal(advanceKnownStreak(NaN, { added: 0, known: 2, consecutiveKnownAtEnd: 2 }), 2);
});

test('the early stop fires at the threshold', () => {
  const state = createRunState({ startedAt: T0 });
  state.listResponses = 3;

  state.consecutiveKnown = 49;
  assert.equal(evaluateStop(state, SETTINGS, T0).stop, false);

  state.consecutiveKnown = 50;
  assert.equal(evaluateStop(state, SETTINGS, T0).reason, STOP_REASONS.ALREADY_ARCHIVED);
});

test('full rescan ignores the early stop', () => {
  const state = createRunState({ startedAt: T0 });
  state.listResponses = 3;
  state.consecutiveKnown = 5000;

  const settings = normalizeSettings({ ...SETTINGS, fullRescan: true });
  assert.equal(evaluateStop(state, settings, T0).stop, false);
});

test('a custom early-stop threshold is respected', () => {
  const state = createRunState({ startedAt: T0 });
  state.listResponses = 3;
  state.consecutiveKnown = 10;

  const settings = normalizeSettings({ ...SETTINGS, earlyStopThreshold: 10 });
  assert.equal(evaluateStop(state, settings, T0).reason, STOP_REASONS.ALREADY_ARCHIVED);
});

test('an incremental run ends in a handful of scrolls', async () => {
  // The second run over an unchanged list: every page is already known.
  const page = fakePage({ growthSteps: 1000 });
  const clock = fakeClock();
  const state = createRunState({ listId: 'liked' });

  const runner = createRunner({
    page,
    state,
    settings: SETTINGS,
    ...clock,
    random: () => 0.5,
    onTick: (current) => {
      current.listResponses += 1;
      current.hasMore = true;
      current.consecutiveKnown = advanceKnownStreak(current.consecutiveKnown, {
        added: 0,
        known: 18,
        consecutiveKnownAtEnd: 18
      });
    }
  });

  const result = await runner.run();

  assert.equal(result.reason, STOP_REASONS.ALREADY_ARCHIVED);
  assert.equal(result.steps, 3, '18 known per page reaches 50 on the third page');
  assert.equal(result.added, 0);
});

test('a run that finds one new video keeps going past it', async () => {
  const page = fakePage({ growthSteps: 1000 });
  const clock = fakeClock();
  const state = createRunState({ listId: 'liked' });

  const runner = createRunner({
    page,
    state,
    settings: SETTINGS,
    ...clock,
    random: () => 0.5,
    onTick: (current) => {
      current.listResponses += 1;
      current.hasMore = true;
      // The first page has one new video, the rest are entirely known.
      const batch =
        current.steps === 1
          ? { added: 1, known: 17, consecutiveKnownAtEnd: 17 }
          : { added: 0, known: 18, consecutiveKnownAtEnd: 18 };
      if (batch.added) current.added += batch.added;
      current.consecutiveKnown = advanceKnownStreak(current.consecutiveKnown, batch);
    }
  });

  const result = await runner.run();

  assert.equal(result.reason, STOP_REASONS.ALREADY_ARCHIVED);
  assert.equal(result.added, 1);
  assert.equal(result.steps, 3, 'the streak restarted at 17, so it needed one more page');
});

// --- the run loop ----------------------------------------------------------

test('a run scrolls until the page stops growing and stops requesting', async () => {
  const page = fakePage({ growthSteps: 4 });
  const clock = fakeClock();
  const state = createRunState({ listId: 'liked' });

  const runner = createRunner({ page, state, settings: SETTINGS, ...clock, random: () => 0.5 });
  const result = await runner.run();

  assert.equal(result.reason, STOP_REASONS.NO_GROWTH);
  // 4 growing steps, then 3 more to satisfy the no-growth limit.
  assert.equal(result.steps, 7);
  assert.equal(page.stepCount(), 7);
});

test('pacing stays inside the configured range', async () => {
  const page = fakePage({ growthSteps: 3 });
  const clock = fakeClock();
  const state = createRunState({});
  const delays = [];

  const runner = createRunner({
    page,
    state,
    settings: SETTINGS,
    ...clock,
    random: () => 0.25,
    onTick: (_state, info) => delays.push(info.delay)
  });
  await runner.run();

  assert.ok(delays.length > 0);
  for (const delay of delays) {
    assert.ok(
      delay >= SETTINGS.minDelayMs && delay <= SETTINGS.maxDelayMs,
      `delay ${delay} outside ${SETTINGS.minDelayMs}–${SETTINGS.maxDelayMs}`
    );
  }
  // Randomized rather than a fixed cadence.
  assert.equal(delays[0], 1875);
});

test('the run ends immediately when the API says there is no more', async () => {
  const page = fakePage({ growthSteps: 100 });
  const clock = fakeClock();
  const state = createRunState({});

  const runner = createRunner({
    page,
    state,
    settings: SETTINGS,
    ...clock,
    random: () => 0.5,
    onTick: (current) => {
      // Simulate the capture side updating the state after the second page.
      current.listResponses += 1;
      if (current.listResponses === 2) current.hasMore = false;
    }
  });
  const result = await runner.run();

  assert.equal(result.reason, STOP_REASONS.NO_MORE);
  assert.equal(result.steps, 2);
});

test('empty responses end a run even while the page keeps growing', async () => {
  const page = fakePage({ growthSteps: 100 });
  const clock = fakeClock();
  const state = createRunState({});

  const runner = createRunner({
    page,
    state,
    settings: SETTINGS,
    ...clock,
    random: () => 0.5,
    onTick: (current) => {
      current.listResponses += 1;
      current.emptyResponses += 1;
    }
  });
  const result = await runner.run();

  assert.equal(result.reason, STOP_REASONS.EMPTY_PAGES);
  assert.equal(result.steps, 3);
});

test('a stop request ends the run at the next decision point', async () => {
  const page = fakePage({ growthSteps: 1000 });
  const clock = fakeClock();
  const state = createRunState({});

  const runner = createRunner({
    page,
    state,
    settings: SETTINGS,
    ...clock,
    random: () => 0.5,
    onTick: (current) => {
      current.listResponses += 1;
      if (current.steps === 5) runner.requestStop();
    }
  });
  const result = await runner.run();

  assert.equal(result.reason, STOP_REASONS.USER);
  assert.equal(result.steps, 5);
});

test('the time limit ends a long run', async () => {
  const page = fakePage({ growthSteps: 100_000 });
  const clock = fakeClock();
  const state = createRunState({});

  const runner = createRunner({
    page,
    state,
    settings: normalizeSettings({ ...SETTINGS, maxRunMinutes: 1 }),
    ...clock,
    random: () => 1,
    onTick: (current) => {
      current.listResponses += 1;
    }
  });
  const result = await runner.run();

  assert.equal(result.reason, STOP_REASONS.MAX_DURATION);
  assert.ok(result.elapsedMs >= 60_000);
});

test('a paused run stops scrolling and resumes where it left off', async () => {
  const page = fakePage({ growthSteps: 1000 });
  const clock = fakeClock();
  const state = createRunState({});
  let ticks = 0;

  const runner = createRunner({
    page,
    state,
    settings: SETTINGS,
    ...clock,
    random: () => 0.5,
    pausePollMs: 500,
    onTick: (current) => {
      ticks += 1;
      current.listResponses += 1;
      if (ticks === 2) runner.pause('captcha');
      if (ticks === 2) {
        // Resume after a few poll cycles, as solving a captcha would.
        setTimeout(() => runner.resume(), 0);
      }
      if (ticks === 6) runner.requestStop();
    }
  });

  const result = await runner.run();

  assert.equal(result.reason, STOP_REASONS.USER);
  assert.equal(result.steps, 6, 'pausing must not lose or duplicate steps');
  assert.equal(state.paused, false);
});

test('resuming clears the staleness counters a pause would have inflated', () => {
  const page = fakePage();
  const state = createRunState({});
  const runner = createRunner({ page, state, settings: SETTINGS });

  state.noGrowthSteps = 7;
  state.stepsSinceLastResponse = 7;
  state.emptyResponses = 2;
  runner.pause('captcha');
  runner.resume();

  assert.equal(state.noGrowthSteps, 0);
  assert.equal(state.stepsSinceLastResponse, 0);
  assert.equal(state.emptyResponses, 0);
  assert.equal(state.pauseReason, null);
});

// --- interruptions ---------------------------------------------------------

test('a captcha appearing pauses the run, and clearing it resumes', async () => {
  const page = fakePage({ growthSteps: 1000 });
  const clock = fakeClock();
  const state = createRunState({});

  let captchaVisible = false;
  const pauses = [];
  const resumes = [];
  let watchCalls = 0;

  const runner = createRunner({
    page,
    state,
    settings: SETTINGS,
    ...clock,
    random: () => 0.5,
    pausePollMs: 500,
    watch: (current, api) => {
      watchCalls += 1;
      // Appears on the 3rd iteration, cleared 4 poll cycles later.
      if (watchCalls === 3) captchaVisible = true;
      if (watchCalls === 8) captchaVisible = false;

      if (captchaVisible && !current.paused) api.pause(PAUSE_REASONS.CAPTCHA);
      else if (!captchaVisible && current.pauseReason === PAUSE_REASONS.CAPTCHA) api.resume();
    },
    onPause: (_s, reason) => pauses.push(reason),
    onResume: (_s, reason) => resumes.push(reason),
    onTick: (current) => {
      current.listResponses += 1;
      if (current.steps >= 6) runner.requestStop();
    }
  });

  const result = await runner.run();

  assert.deepEqual(pauses, [PAUSE_REASONS.CAPTCHA]);
  assert.deepEqual(resumes, [PAUSE_REASONS.CAPTCHA]);
  assert.equal(result.reason, STOP_REASONS.USER);
  assert.equal(state.paused, false);
  assert.equal(result.steps, 6, 'the pause must not lose captured progress');
});

test('a run blocked by a captcha never reports itself as finished', async () => {
  const page = fakePage({ growthSteps: 0 }); // nothing loads while blocked
  const clock = fakeClock();
  const state = createRunState({});
  let polls = 0;

  const runner = createRunner({
    page,
    state,
    settings: SETTINGS,
    ...clock,
    random: () => 0.5,
    pausePollMs: 500,
    watch: (current, api) => {
      polls += 1;
      if (!current.paused) api.pause(PAUSE_REASONS.CAPTCHA);
      // Give up waiting after a while, as a user closing the tab would.
      if (polls > 20) runner.requestStop();
    }
  });

  const result = await runner.run();

  // Without pause handling this would have stopped as 'page-stopped-growing'
  // and silently reported a truncated archive as complete.
  assert.equal(result.reason, STOP_REASONS.USER);
});

// --- soft throttling -------------------------------------------------------

test('empty pages while has_more is true back off instead of stopping', async () => {
  const page = fakePage({ growthSteps: 1000 });
  const clock = fakeClock();
  const state = createRunState({});
  const pauses = [];

  const runner = createRunner({
    page,
    state,
    settings: normalizeSettings({ ...SETTINGS, throttleBackoffSeconds: 30 }),
    ...clock,
    random: () => 0.5,
    onPause: (_s, reason) => pauses.push(reason),
    onTick: (current) => {
      current.listResponses += 1;
      current.hasMore = true; // the API insists there is more
      current.emptyResponses += 1; // yet every page comes back empty
      if (current.throttlePauses >= 2) runner.requestStop();
    }
  });

  const result = await runner.run();

  assert.deepEqual(pauses, [PAUSE_REASONS.THROTTLE, PAUSE_REASONS.THROTTLE]);
  assert.equal(result.reason, STOP_REASONS.USER);
  assert.ok(state.throttlePauses >= 2);
});

test('a throttle backoff lifts by itself after the configured wait', async () => {
  const page = fakePage({ growthSteps: 1000 });
  const clock = fakeClock();
  const state = createRunState({});

  const runner = createRunner({
    page,
    state,
    settings: normalizeSettings({ ...SETTINGS, throttleBackoffSeconds: 30 }),
    ...clock,
    random: () => 0.5,
    pausePollMs: 1000,
    onTick: (current) => {
      current.listResponses += 1;
      // Throttle once, then behave normally.
      if (current.throttlePauses === 0) {
        current.hasMore = true;
        current.emptyResponses += 1;
      } else {
        current.hasMore = undefined;
        current.emptyResponses = 0;
        if (current.steps >= 6) runner.requestStop();
      }
    }
  });

  const startedAt = clock.now();
  const result = await runner.run();

  assert.equal(result.reason, STOP_REASONS.USER);
  assert.equal(state.paused, false, 'the backoff should have lifted itself');
  assert.ok(clock.now() - startedAt >= 30_000, 'the backoff should have waited');
});

test('a persistently throttled run gives up rather than looping forever', async () => {
  const page = fakePage({ growthSteps: 1000 });
  const clock = fakeClock();
  const state = createRunState({});

  const runner = createRunner({
    page,
    state,
    settings: normalizeSettings({
      ...SETTINGS,
      throttleBackoffSeconds: 5,
      maxThrottlePauses: 2
    }),
    ...clock,
    random: () => 0.5,
    pausePollMs: 1000,
    onTick: (current) => {
      current.listResponses += 1;
      current.hasMore = true;
      current.emptyResponses += 1;
    }
  });

  const result = await runner.run();

  assert.equal(result.reason, STOP_REASONS.THROTTLED);
  assert.equal(state.throttlePauses, 3, 'one more than the limit, then it stops');
});

test('empty pages with no has_more signal are still treated as the end', async () => {
  const page = fakePage({ growthSteps: 1000 });
  const clock = fakeClock();
  const state = createRunState({});

  const runner = createRunner({
    page,
    state,
    settings: SETTINGS,
    ...clock,
    random: () => 0.5,
    onTick: (current) => {
      current.listResponses += 1;
      current.emptyResponses += 1; // hasMore stays undefined
    }
  });

  const result = await runner.run();
  assert.equal(result.reason, STOP_REASONS.EMPTY_PAGES);
});
