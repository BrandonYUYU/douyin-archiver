/**
 * capture.js — the whole path from "the hook forwarded something" to "here are
 * the new records", with no browser APIs in it.
 *
 * content.js is deliberately left as thin glue around this function. The point
 * is that the interesting part of interception — screening the payload, deciding
 * which list it belongs to, parsing it, and merging — can be tested under
 * `node --test` instead of only by scrolling Douyin by hand.
 */

import { isUsableResponsePayload } from './protocol.js';
import { listIdForApiUrl } from './targets.js';
import { normalizeListResponse } from './normalize.js';
import { mergeRecords } from './dedup.js';

/**
 * @param {unknown} payload  the payload of a validated FROM_PAGE.RESPONSE message
 * @param {{archive?: object, now?: number, listId?: string|null}} options
 * @returns {{
 *   accepted: boolean,
 *   reason: string|null,
 *   listId: string|null,
 *   result: object|null,
 *   merged: object|null
 * }}
 */
export function captureListResponse(payload, options = {}) {
  const { archive = {}, now, listId: forcedListId = null } = options;

  const fail = (reason, listId = null) => ({
    accepted: false,
    reason,
    listId,
    result: null,
    merged: null
  });

  // A hostile page can post anything; screen before parsing.
  if (!isUsableResponsePayload(payload)) return fail('unusable-payload');

  const listId = forcedListId || listIdForApiUrl(payload.url);
  // Not a list endpoint — the broad URL filter in the hook lets unrelated
  // traffic through on purpose, and this is where it gets discarded.
  if (!listId) return fail('not-a-list-url');

  const result = normalizeListResponse(payload.body, { listId, source: 'api', now });
  if (!result.ok) return fail(result.reason, listId);

  const merged = mergeRecords(archive, result.records);
  return { accepted: true, reason: null, listId, result, merged };
}
