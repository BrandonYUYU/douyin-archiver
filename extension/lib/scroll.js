/**
 * scroll.js — the run loop, plus the DOM adapter it drives.
 *
 * The loop takes a `page` object rather than touching the DOM itself, so the
 * whole thing — pacing, growth detection, pausing, stop decisions — runs under
 * `node --test` against a fake page. createDomPage() is the only part that needs
 * a real browser, and it is deliberately trivial.
 */

import { evaluateStop, evaluateThrottle, createRunState, PAUSE_REASONS } from './stopRules.js';
import { randomDelayMs, normalizeSettings } from './settings.js';

export { createRunState };

/**
 * Adapter over a real page.
 *
 * Douyin's grid scrolls the document rather than an inner element as far as we
 * know (docs/findings.md), but a nested scroller is easy enough to support: the
 * tallest scrollable ancestor of the tile grid wins.
 */
export function createDomPage(win = window, doc = document) {
  function scroller() {
    return doc.scrollingElement || doc.documentElement || doc.body;
  }

  return {
    scrollHeight() {
      const element = scroller();
      return element ? element.scrollHeight : 0;
    },

    /**
     * Jump to the bottom to trigger the next page load.
     *
     * The small step back up first is not cosmetic: infinite lists commonly use
     * an IntersectionObserver sentinel, and re-entering it from above is what
     * makes it fire again when the position has not otherwise changed.
     */
    stepToBottom() {
      const element = scroller();
      if (!element) return;
      const bottom = element.scrollHeight;
      win.scrollTo({ top: Math.max(0, bottom - 800), behavior: 'auto' });
      win.scrollTo({ top: bottom, behavior: 'auto' });
    }
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{
 *   page: {scrollHeight: Function, stepToBottom: Function},
 *   state: object,
 *   settings: object,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   random?: () => number,
 *   onTick?: (state: object, info: object) => void,
 *   watch?: (state: object, api: object) => void,
 *   onPause?: (state: object, reason: string) => void,
 *   onResume?: (state: object, reason: string) => void,
 *   pausePollMs?: number
 * }} options
 */
export function createRunner(options) {
  const {
    page,
    state,
    sleep = defaultSleep,
    now = () => Date.now(),
    random = Math.random,
    onTick = null,
    /** Called every iteration, including while paused, so the caller can look at
     *  the DOM for a captcha and pause/resume accordingly. */
    watch = null,
    onPause = null,
    onResume = null,
    pausePollMs = 1000
  } = options;

  const settings = normalizeSettings(options.settings);
  let finished = null;
  let lastSeenResponseCount = 0;

  function requestStop() {
    state.stopRequested = true;
  }

  /**
   * @param {string} reason
   * @param {{untilMs?: number}} [opts] untilMs makes the pause lift by itself
   */
  function pause(reason, opts = {}) {
    if (state.paused) return;
    state.paused = true;
    state.pauseReason = reason || PAUSE_REASONS.USER;
    state.pauseUntil = opts.untilMs ?? null;
    if (onPause) onPause(state, state.pauseReason);
  }

  function resume() {
    if (!state.paused) return;
    const reason = state.pauseReason;
    state.paused = false;
    state.pauseReason = null;
    state.pauseUntil = null;
    // A pause usually means loading also stalled. Clear the staleness counters so
    // the wait itself cannot later be read as end-of-list.
    state.noGrowthSteps = 0;
    state.stepsSinceLastResponse = 0;
    state.emptyResponses = 0;
    if (onResume) onResume(state, reason);
  }

  async function run() {
    if (!state.startedAt) state.startedAt = now();

    for (;;) {
      // Let the caller inspect the page first: a captcha that appeared during the
      // last sleep should pause the run before any stop rule sees a stalled page.
      if (watch) watch(state, { pause, resume, now: now() });

      const decision = evaluateStop(state, settings, now());
      if (decision.stop) {
        state.stoppedReason = decision.reason;
        finished = {
          reason: decision.reason,
          steps: state.steps,
          elapsedMs: now() - state.startedAt,
          added: state.added
        };
        return finished;
      }

      if (state.paused) {
        // Self-lifting pauses (throttle backoff) expire on their own; a captcha
        // pause waits for `watch` to clear it.
        if (state.pauseUntil !== null && now() >= state.pauseUntil) resume();
        else {
          await sleep(pausePollMs);
          continue;
        }
      }

      // Empty pages while the API still says has_more is a throttle, not the end.
      // Back off and retry rather than truncating the archive.
      const throttle = evaluateThrottle(state, settings);
      if (throttle.throttled) {
        state.throttlePauses += 1;
        state.emptyResponses = 0; // measure the retry fresh
        const backoffMs = Math.max(1, Number(settings.throttleBackoffSeconds) || 60) * 1000;
        pause(PAUSE_REASONS.THROTTLE, { untilMs: now() + backoffMs });
        continue;
      }

      const heightBefore = page.scrollHeight();
      page.stepToBottom();
      state.steps += 1;

      // Randomized so the cadence does not look mechanical, and slow enough that
      // Douyin has time to answer (docs/decisions.md §7).
      const delay = randomDelayMs(settings, random);
      await sleep(delay);

      const heightAfter = page.scrollHeight();
      if (heightAfter > heightBefore) state.noGrowthSteps = 0;
      else state.noGrowthSteps += 1;

      if (state.listResponses > lastSeenResponseCount) {
        lastSeenResponseCount = state.listResponses;
        state.stepsSinceLastResponse = 0;
      } else {
        state.stepsSinceLastResponse += 1;
      }

      if (onTick) {
        onTick(state, { delay, heightBefore, heightAfter });
      }
    }
  }

  return {
    run,
    requestStop,
    pause,
    resume,
    get state() {
      return state;
    },
    get result() {
      return finished;
    }
  };
}
