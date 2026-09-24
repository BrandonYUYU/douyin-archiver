/**
 * stopRules.js — when to stop a run, and when to pause instead, as pure functions.
 *
 * Getting this wrong is worse than it sounds. Stopping too early silently
 * truncates the archive, and every failure mode looks alike from the outside: a
 * captcha, a rate limit, and the genuine end of the list all present as "no more
 * videos are arriving". So each signal is named, and the reason is reported to
 * the user rather than swallowed.
 *
 * The signals, and why no single one is sufficient:
 *
 *  - `hasMore === false` from the API is the most trustworthy, but only once a
 *    list response has actually been parsed; a renamed field reads as undefined.
 *  - Empty-but-successful pages mean the end — UNLESS the API still says
 *    has_more, in which case the far likelier explanation is a soft throttle, and
 *    stopping would truncate the archive. That case pauses and retries instead.
 *  - No scroll-height growth means the page stopped loading, which at the true
 *    end of a list happens WITHOUT any further request being fired. Growth alone
 *    cannot be trusted either, so it is paired with "no list response for a few
 *    steps".
 */

export const STOP_REASONS = {
  USER: 'user-stopped',
  MAX_DURATION: 'max-duration',
  NO_MORE: 'api-says-no-more',
  EMPTY_PAGES: 'end-of-list',
  NO_GROWTH: 'page-stopped-growing',
  THROTTLED: 'throttled',
  ALREADY_ARCHIVED: 'already-archived'
};

/** Human-readable text for the popup. */
export const STOP_REASON_TEXT = {
  [STOP_REASONS.USER]: 'Stopped by you.',
  [STOP_REASONS.MAX_DURATION]: 'Stopped at the time limit.',
  [STOP_REASONS.NO_MORE]: 'Reached the end of the list.',
  [STOP_REASONS.EMPTY_PAGES]: 'Reached the end of the list (empty pages).',
  [STOP_REASONS.NO_GROWTH]: 'Reached the end of the list (page stopped loading).',
  [STOP_REASONS.THROTTLED]:
    'Douyin kept returning empty pages — stopped to avoid hammering it. Try again later; nothing captured was lost.',
  [STOP_REASONS.ALREADY_ARCHIVED]:
    'Everything from here down is already archived, so the run stopped early.'
};

export const PAUSE_REASONS = {
  CAPTCHA: 'captcha',
  LOGIN: 'login-required',
  THROTTLE: 'soft-throttle',
  USER: 'user-paused'
};

/** A fresh, mutable run state. content.js updates the response-side counters. */
export function createRunState(options = {}) {
  return {
    listId: options.listId || null,
    startedAt: options.startedAt ?? 0,
    steps: 0,

    // set by the controller
    noGrowthSteps: 0,
    stepsSinceLastResponse: 0,
    paused: false,
    pauseReason: null,
    /** When set, the pause lifts by itself at this timestamp (throttle backoff). */
    pauseUntil: null,
    throttlePauses: 0,
    stopRequested: false,

    // set by the capture side
    listResponses: 0,
    emptyResponses: 0,
    hasMore: undefined,
    consecutiveKnown: 0,
    added: 0,
    /** Total already-known videos seen this run, for the end-of-run report. */
    knownThisRun: 0,
    /** When the last usable list response arrived — drives the DOM fallback. */
    lastResponseAt: null,
    /** Records contributed by the DOM fallback this run. */
    domHarvested: 0,

    // set when a decision is reached
    stoppedReason: null
  };
}

function emptyLimitOf(settings) {
  return Math.max(1, Number(settings?.emptyResponseLimit) || 3);
}

/**
 * Are the empty pages a throttle rather than the end?
 *
 * Only when the API itself still claims there is more to come. That combination —
 * "has_more: true" plus an empty page — cannot be the end of the list.
 */
export function evaluateThrottle(state, settings) {
  if (!state || state.paused) return { throttled: false };
  if (state.hasMore !== true) return { throttled: false };
  return { throttled: state.emptyResponses >= emptyLimitOf(settings) };
}

/**
 * Advance the run's already-known streak across a page of results.
 *
 * The per-batch number from dedup.js only counts the trailing known run *inside
 * that page*, which is not enough on its own: the lists are paginated, so a streak
 * of 50 usually spans several pages. This is where it accumulates.
 *
 * A page containing even one new video breaks the streak, which then restarts
 * from whatever known run trailed that page.
 *
 * @param {number} streak current streak
 * @param {{added: number, known: number, consecutiveKnownAtEnd: number}} batch
 * @returns {number}
 */
export function advanceKnownStreak(streak, batch) {
  const current = Number.isFinite(streak) && streak > 0 ? streak : 0;
  if (!batch) return current;

  const added = Number(batch.added) || 0;
  const known = Number(batch.known) || 0;
  const trailing = Number(batch.consecutiveKnownAtEnd) || 0;

  // Nothing new in this page → the whole page extends the streak.
  if (added === 0) return current + known;

  // Something new appeared, so the streak restarts after it.
  return trailing;
}

/**
 * Should the run stop right now?
 *
 * @param {object} state    from createRunState
 * @param {object} settings normalized settings
 * @param {number} now      milliseconds
 * @returns {{stop: boolean, reason: string|null}}
 */
export function evaluateStop(state, settings, now) {
  const go = { stop: false, reason: null };
  if (!state) return go;

  if (state.stopRequested) return { stop: true, reason: STOP_REASONS.USER };

  // Give up only after several backoffs have failed to unstick it.
  const maxThrottlePauses = Math.max(1, Number(settings?.maxThrottlePauses) || 3);
  if (state.throttlePauses > maxThrottlePauses) {
    return { stop: true, reason: STOP_REASONS.THROTTLED };
  }

  // A paused run (captcha, backoff) must never be mistaken for a finished one.
  if (state.paused) return go;

  const maxMs = Math.max(1, Number(settings?.maxRunMinutes) || 45) * 60_000;
  if (state.startedAt && now - state.startedAt >= maxMs) {
    return { stop: true, reason: STOP_REASONS.MAX_DURATION };
  }

  // Incremental runs: both lists are newest-first, so once enough consecutive
  // already-known videos have gone by, everything below is necessarily archived.
  // This is what turns a repeat run from minutes into seconds.
  if (!settings?.fullRescan) {
    const threshold = Math.max(1, Number(settings?.earlyStopThreshold) || 50);
    if (state.consecutiveKnown >= threshold) {
      return { stop: true, reason: STOP_REASONS.ALREADY_ARCHIVED };
    }
  }

  // Only trust the API's end-of-list flag once we have parsed a real response.
  if (state.listResponses > 0 && state.hasMore === false) {
    return { stop: true, reason: STOP_REASONS.NO_MORE };
  }

  // Empty pages while has_more is true are handled by evaluateThrottle, not here.
  if (state.hasMore !== true && state.emptyResponses >= emptyLimitOf(settings)) {
    return { stop: true, reason: STOP_REASONS.EMPTY_PAGES };
  }

  // The page has stopped growing AND stopped asking for more. Either signal on
  // its own is normal mid-run: growth pauses while a request is in flight, and no
  // response arrives during a step that only scrolled a little.
  const growthLimit = Math.max(1, Number(settings?.noGrowthLimit) || 3);
  if (state.noGrowthSteps >= growthLimit && state.stepsSinceLastResponse >= growthLimit) {
    return { stop: true, reason: STOP_REASONS.NO_GROWTH };
  }

  return go;
}

/** Describe an outcome for the UI. */
export function describeStop(reason) {
  return STOP_REASON_TEXT[reason] || 'Stopped.';
}
