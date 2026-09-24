/**
 * domHarvest.js — the fallback that keeps a run useful when interception breaks.
 *
 * If Douyin renames the list endpoint or reshapes the response, capture.js starts
 * returning nothing and the archive would quietly stop growing. Reading video ids
 * out of the grid's anchor hrefs survives that, because the canonical URL is
 * reconstructable from the id alone.
 *
 * What it cannot do: metadata. A harvested record has an id and a URL and nothing
 * else, flagged `source: 'dom'`, and the merge rules in dedup.js guarantee it can
 * never blank richer data captured earlier from the API.
 *
 * Remember the grid is VIRTUALIZED: this only ever sees the tiles currently
 * rendered, which is exactly why it runs repeatedly during a scroll rather than
 * once at the end.
 */

import { VIDEO_HREF_PATTERN, SELECTORS } from './targets.js';
import { recordFromId } from './normalize.js';

/**
 * Pull unique video ids out of a list of hrefs.
 *
 * Order is preserved (the grid renders newest-first), and non-video links —
 * profiles, searches, hashtags — are ignored rather than guessed at.
 *
 * @param {Iterable<string>} hrefs
 * @returns {string[]}
 */
export function videoIdsFromHrefs(hrefs) {
  const ids = [];
  const seen = new Set();

  for (const href of hrefs || []) {
    if (typeof href !== 'string' || href.length === 0) continue;
    const match = VIDEO_HREF_PATTERN.exec(href);
    if (!match) continue;
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** Read hrefs out of a real document. The only browser-dependent part. */
export function collectHrefs(doc = document, selector = SELECTORS.tileAnchors) {
  try {
    return [...doc.querySelectorAll(selector)].map((anchor) => anchor.getAttribute('href') || '');
  } catch {
    return [];
  }
}

/**
 * Should the fallback take over?
 *
 * Two conditions, both required:
 *  - nothing has been parsed from the network for a while, and
 *  - the page is nonetheless still loading content (it is growing).
 *
 * The second condition is what distinguishes "interception is broken" from
 * "the list has ended" — at the end of a list nothing arrives AND nothing grows,
 * and harvesting there would be pointless rather than harmful.
 *
 * @param {object} state run state
 * @param {object} settings normalized settings
 * @param {number} now milliseconds
 */
export function shouldHarvest(state, settings, now) {
  if (!state) return false;
  if (state.paused) return false;

  const quietMs = Math.max(1, Number(settings?.domFallbackAfterSeconds) || 20) * 1000;
  const since = state.lastResponseAt || state.startedAt || now;
  if (now - since < quietMs) return false;

  // Still growing → content is arriving that we are not seeing on the network.
  return state.noGrowthSteps === 0;
}

/**
 * Build DOM-sourced records for the tiles currently on screen.
 *
 * @param {string[]} hrefs
 * @param {{listId?: string, now?: number}} options
 */
export function recordsFromHrefs(hrefs, options = {}) {
  const { listId = null, now } = options;
  return videoIdsFromHrefs(hrefs)
    .map((id) => recordFromId(id, { listId, now, source: 'dom' }))
    .filter(Boolean);
}
