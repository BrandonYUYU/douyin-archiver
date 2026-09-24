/**
 * paths.js — read values out of unknown JSON by dotted path.
 *
 * This exists because lib/targets.js describes every wanted field as a LIST of
 * candidate paths rather than one path: Douyin's response shape is not verified
 * (docs/findings.md), so "try these in order, take the first that resolves"
 * turns a wrong guess into a missing field instead of a crash.
 */

/** Keys that could reach Object.prototype. Never traversed. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Resolve `a.b.0.c` against an object. Numeric segments index arrays.
 * Returns undefined for any miss — never throws.
 */
export function getByPath(source, path) {
  if (source == null || typeof path !== 'string' || path.length === 0) return undefined;

  let current = source;
  for (const segment of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    if (UNSAFE_KEYS.has(segment)) return undefined;

    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
      current = current[segment];
    }
  }
  return current;
}

/**
 * First candidate path that yields something meaningful.
 * Empty strings and empty arrays count as misses, so a present-but-blank field
 * falls through to the next candidate.
 */
export function firstPath(source, paths) {
  if (!Array.isArray(paths)) return undefined;
  for (const path of paths) {
    const value = getByPath(source, path);
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    return value;
  }
  return undefined;
}

/**
 * First candidate path that holds an array — INCLUDING an empty one.
 *
 * Separate from firstPath because the two cases genuinely differ: an empty
 * `aweme_list` is the normal "you have reached the end of the list" response,
 * and treating it as a miss would make the end of a run indistinguishable from
 * a renamed field.
 */
export function firstArrayPath(source, paths) {
  if (!Array.isArray(paths)) return undefined;
  for (const path of paths) {
    const value = getByPath(source, path);
    if (Array.isArray(value)) return value;
  }
  return undefined;
}
