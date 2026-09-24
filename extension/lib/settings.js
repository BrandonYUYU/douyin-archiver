/**
 * settings.js — user-tunable knobs, their defaults, and coercion.
 *
 * Defaults are deliberately conservative: a ~1000 item run takes a few minutes
 * and looks unremarkable to Douyin. See docs/decisions.md §7.
 */

export const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS = {
  /** Log every request URL in the page console instead of only matching ones. */
  reconMode: false,

  /** Randomized pause between scroll steps, milliseconds. */
  minDelayMs: 1500,
  maxDelayMs: 3000,

  /**
   * Stop once this many consecutive already-known videos have gone by.
   * Both lists are newest-first, so everything past that point is already
   * archived. 50 rather than 1 to tolerate small ordering anomalies.
   */
  earlyStopThreshold: 50,

  /** Ignore earlyStopThreshold and walk the whole list. */
  fullRescan: false,

  /** Hard ceiling on a single run. */
  maxRunMinutes: 45,

  /** Consecutive empty-but-successful list responses that mean "end of list". */
  emptyResponseLimit: 3,

  /**
   * Consecutive scroll steps with no scroll-height growth AND no list response
   * before concluding the list has ended. Paired deliberately — see
   * lib/stopRules.js.
   */
  noGrowthLimit: 3,

  /** How long to wait out a suspected soft throttle before retrying. */
  throttleBackoffSeconds: 60,

  /** How many backoffs to try before giving up on a throttled run. */
  maxThrottlePauses: 3,

  /** Seconds without any list JSON, while the page is still growing, before the
   *  DOM fallback harvester takes over. */
  domFallbackAfterSeconds: 20
};

/**
 * Valid range for each numeric setting.
 *
 * Exported so the popup's number inputs can take their min/max straight from
 * here rather than repeating the numbers in HTML, where they would silently
 * drift. normalizeSettings clamps regardless, so the UI hints and the validator
 * can never disagree.
 */
export const SETTING_BOUNDS = {
  minDelayMs: [200, 60_000],
  maxDelayMs: [200, 120_000],
  earlyStopThreshold: [1, 100_000],
  maxRunMinutes: [1, 600],
  emptyResponseLimit: [1, 50],
  noGrowthLimit: [1, 50],
  throttleBackoffSeconds: [5, 3600],
  maxThrottlePauses: [1, 20],
  domFallbackAfterSeconds: [5, 600]
};

const BOUNDS = SETTING_BOUNDS;

function clampInt(value, [lo, hi], fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Coerce anything (stored JSON, popup form input) into a valid settings object.
 * Never throws — bad values fall back to defaults field by field.
 */
export function normalizeSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULT_SETTINGS };

  out.reconMode = Boolean(input.reconMode ?? DEFAULT_SETTINGS.reconMode);
  out.fullRescan = Boolean(input.fullRescan ?? DEFAULT_SETTINGS.fullRescan);

  for (const key of Object.keys(BOUNDS)) {
    out[key] = clampInt(input[key] ?? DEFAULT_SETTINGS[key], BOUNDS[key], DEFAULT_SETTINGS[key]);
  }

  // A reversed range would make the delay generator misbehave; normalize it.
  if (out.maxDelayMs < out.minDelayMs) out.maxDelayMs = out.minDelayMs;

  return out;
}

/** Inclusive random pause, used between scroll steps. */
export function randomDelayMs(settings, random = Math.random) {
  const { minDelayMs, maxDelayMs } = normalizeSettings(settings);
  return Math.round(minDelayMs + random() * (maxDelayMs - minDelayMs));
}
