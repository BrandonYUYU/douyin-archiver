/**
 * protocol.js — the contract between the MAIN-world hook and the isolated
 * content script, plus the validator that treats every page message as hostile.
 *
 * DUPLICATION WARNING: content/hook.js repeats the string literals below,
 * because a MAIN-world script has no chrome.* APIs and therefore cannot import
 * an extension module. test/protocol.test.js asserts the two copies agree, so
 * the duplication cannot rot silently.
 */

/** Namespace tag every message must carry. */
export const MSG_SOURCE = 'dy-archiver';

/** Bumped only on breaking shape changes. */
export const PROTOCOL_VERSION = 1;

/** Page (MAIN world) → isolated content script. */
export const FROM_PAGE = {
  HOOK_READY: 'dya:hook-ready',
  RESPONSE: 'dya:response',
  RECON: 'dya:recon'
};

/** Isolated content script → page (MAIN world). */
export const TO_PAGE = {
  CONFIG: 'dya:config'
};

const FROM_PAGE_TYPES = new Set(Object.values(FROM_PAGE));

/**
 * Validate a `message` event that claims to come from our hook.
 *
 * The page's own JavaScript can post anything it likes to `window`, so nothing
 * here is trusted: we verify the event really originated in this window (not an
 * iframe or another origin), carries our namespace, uses a known type, and has a
 * plain-object payload. Returns null for anything that fails.
 *
 * @param {MessageEvent} event
 * @param {Window} expectedWindow  usually `window`
 * @returns {{type: string, payload: object} | null}
 */
export function readPageMessage(event, expectedWindow) {
  if (!event || typeof event !== 'object') return null;
  // Same-window only: rejects messages forwarded from iframes or other tabs.
  if (expectedWindow && event.source !== expectedWindow) return null;

  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.source !== MSG_SOURCE) return null;
  if (data.version !== PROTOCOL_VERSION) return null;
  if (typeof data.type !== 'string' || !FROM_PAGE_TYPES.has(data.type)) return null;

  const payload = data.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  return { type: data.type, payload };
}

/** Build a well-formed envelope. Used by the isolated side only. */
export function makeMessage(type, payload) {
  return { source: MSG_SOURCE, version: PROTOCOL_VERSION, type, payload };
}

/**
 * Validate the body of a RESPONSE message before anyone tries to parse it.
 * Size cap guards against a hostile page posting a multi-hundred-MB string.
 */
export const MAX_BODY_BYTES = 12 * 1024 * 1024;

export function isUsableResponsePayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (typeof payload.url !== 'string' || payload.url.length === 0) return false;
  if (typeof payload.body !== 'string' || payload.body.length === 0) return false;
  if (payload.body.length > MAX_BODY_BYTES) return false;
  return true;
}
