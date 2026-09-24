/**
 * interruptions.js — notice when the page has put something in the way.
 *
 * Why this matters more than it looks: an undetected captcha is indistinguishable
 * from "you have reached the end of your liked list". The run would stop, report
 * success, and silently leave half your archive uncaptured. Detection is a
 * correctness feature, not a politeness one (docs/decisions.md §7).
 *
 * The detector is deliberately over-inclusive on selectors but strict about
 * VISIBILITY. Douyin keeps captcha containers in the DOM ahead of time, so
 * matching a selector alone would pause every run forever. An element only
 * counts if it is actually rendered and has a non-trivial size.
 *
 * Pure apart from an injected probe, so it is testable without a DOM.
 */

export const INTERRUPTIONS = {
  CAPTCHA: 'captcha',
  LOGIN: 'login-required'
};

export const INTERRUPTION_TEXT = {
  [INTERRUPTIONS.CAPTCHA]: 'Douyin is showing a verification puzzle. Solve it and the run continues.',
  [INTERRUPTIONS.LOGIN]: 'Douyin wants you to log in again. Sign in and the run continues.'
};

/** Smallest rendered box we will believe is a real dialog. */
const MIN_VISIBLE_PX = 40;

/**
 * Probe over a real document.
 * @param {Document} doc
 * @param {Window} win
 */
export function createDomProbe(doc = document, win = window) {
  return {
    query(selector) {
      try {
        return [...doc.querySelectorAll(selector)];
      } catch {
        // A malformed selector in targets.js must not break the run.
        return [];
      }
    },
    isVisible(element) {
      if (!element) return false;
      try {
        const rect = element.getBoundingClientRect();
        if (rect.width < MIN_VISIBLE_PX || rect.height < MIN_VISIBLE_PX) return false;
        const style = win.getComputedStyle(element);
        if (!style) return true;
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.visibility !== 'collapse' &&
          Number(style.opacity ?? 1) > 0.05
        );
      } catch {
        return false;
      }
    }
  };
}

/**
 * @param {{query: (selector: string) => unknown[], isVisible: (el: unknown) => boolean}} probe
 * @param {{captcha?: string[], loginWall?: string[]}} selectors
 * @returns {{kind: string, selector: string} | null}
 */
export function findInterruption(probe, selectors) {
  if (!probe || typeof probe.query !== 'function') return null;

  const groups = [
    [INTERRUPTIONS.CAPTCHA, selectors?.captcha],
    [INTERRUPTIONS.LOGIN, selectors?.loginWall]
  ];

  for (const [kind, list] of groups) {
    for (const selector of Array.isArray(list) ? list : []) {
      // Guarded per selector: one bad selector or a probe that throws must not
      // abort the whole check, or a run could never detect a captcha again.
      let found;
      try {
        found = probe.query(selector);
      } catch {
        continue;
      }
      for (const element of Array.isArray(found) ? found : []) {
        try {
          if (probe.isVisible(element)) return { kind, selector };
        } catch {
          /* treat an unmeasurable element as not visible */
        }
      }
    }
  }
  return null;
}

export function describeInterruption(kind) {
  return INTERRUPTION_TEXT[kind] || 'The page needs your attention.';
}
