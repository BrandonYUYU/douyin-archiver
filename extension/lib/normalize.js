/**
 * normalize.js — raw Douyin list response → clean, storable records.
 *
 * Pure: no chrome.*, no DOM, no clock except an injectable `now`. That is what
 * makes it testable under `node --test`.
 *
 * Two rules drive the design:
 *  - Never throw on unexpected input. A shape change should cost you fields, not
 *    the run. Malformed items are dropped and counted, not fatal.
 *  - An item without a usable id is worthless (the id *is* the URL), so that is
 *    the single hard requirement.
 */

import { firstPath, firstArrayPath } from './paths.js';
import {
  ITEM_FIELD_PATHS,
  LISTS,
  OK_STATUS_PATHS,
  VIDEO_URL_TEMPLATE,
  AUTHOR_URL_TEMPLATE
} from './targets.js';

/** Bumped when the record shape changes in a way importers must notice. */
export const RECORD_SCHEMA_VERSION = 1;

/** Canonical field order — used by CSV export so columns are stable. */
export const RECORD_FIELDS = [
  'id',
  'url',
  'desc',
  'authorName',
  'authorUrl',
  'coverUrl',
  'durationMs',
  'likeCount',
  'commentCount',
  'createTime',
  'lists',
  'source',
  'firstSeenAt',
  'lastSeenAt'
];

/**
 * Accepted id shape. Douyin uses long digit strings; letters/dash/underscore are
 * tolerated so an id format change does not reject the entire list.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function asText(value, maxLength = 2000) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return '';
  const text = String(value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function asInt(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

function asHttpUrl(value) {
  const text = asText(value, 1000);
  if (!text) return '';
  // Douyin sometimes returns protocol-relative URLs.
  const candidate = text.startsWith('//') ? `https:${text}` : text;
  return /^https?:\/\//i.test(candidate) ? candidate : '';
}

export function videoUrlFromId(id) {
  return VIDEO_URL_TEMPLATE.replace('{id}', id);
}

export function authorUrlFromSecUid(secUid) {
  const text = asText(secUid, 200);
  return text ? AUTHOR_URL_TEMPLATE.replace('{secUid}', encodeURIComponent(text)) : '';
}

/**
 * One raw list item → one record, or null if unusable.
 *
 * @param {unknown} raw
 * @param {{listId?: string, source?: 'api'|'dom', now?: number}} options
 */
export function normalizeItem(raw, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const { listId, source = 'api', now = Date.now() } = options;

  // Read with a generous cap, NOT 64: truncating to the limit first would let an
  // over-long id slip past ID_PATTERN as a silently different video.
  const id = asText(firstPath(raw, ITEM_FIELD_PATHS.id), 256);
  if (!id || !ID_PATTERN.test(id)) return null;

  const record = {
    id,
    url: videoUrlFromId(id),
    desc: asText(firstPath(raw, ITEM_FIELD_PATHS.desc)),
    authorName: asText(firstPath(raw, ITEM_FIELD_PATHS.authorName), 200),
    authorUrl: authorUrlFromSecUid(firstPath(raw, ITEM_FIELD_PATHS.authorSecUid)),
    coverUrl: asHttpUrl(firstPath(raw, ITEM_FIELD_PATHS.coverUrl)),
    durationMs: asInt(firstPath(raw, ITEM_FIELD_PATHS.durationMs)),
    likeCount: asInt(firstPath(raw, ITEM_FIELD_PATHS.likeCount)),
    commentCount: asInt(firstPath(raw, ITEM_FIELD_PATHS.commentCount)),
    createTime: asInt(firstPath(raw, ITEM_FIELD_PATHS.createTime)),
    lists: listId && LISTS[listId] ? [listId] : [],
    source,
    firstSeenAt: now,
    lastSeenAt: now
  };

  // play_addr / download_addr are never read — see docs/decisions.md §4.
  return record;
}

/** Build a record from nothing but a video id (DOM fallback path). */
export function recordFromId(id, options = {}) {
  return normalizeItem({ aweme_id: id }, { ...options, source: options.source || 'dom' });
}

/**
 * Validate a record that claims to already be in our own shape — i.e. one read
 * back from an export file.
 *
 * Import is an untrusted path: the file may be hand-edited, truncated, produced
 * by an older schema version, or simply not ours. Unknown keys are dropped
 * rather than stored, and the URL is always rebuilt from the id rather than
 * trusted, so a doctored file cannot inject a link into your archive.
 *
 * @returns {object|null} null when the record has no usable id
 */
export function sanitizeRecord(raw, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { now = Date.now() } = options;

  const id = asText(raw.id, 256);
  if (!id || !ID_PATTERN.test(id)) return null;

  const lists = Array.isArray(raw.lists)
    ? [...new Set(raw.lists.filter((entry) => typeof entry === 'string' && LISTS[entry]))].sort()
    : [];

  const firstSeenAt = asInt(raw.firstSeenAt);
  const lastSeenAt = asInt(raw.lastSeenAt);

  return {
    id,
    url: videoUrlFromId(id), // never trust a URL from a file
    desc: asText(raw.desc),
    authorName: asText(raw.authorName, 200),
    authorUrl: asHttpUrl(raw.authorUrl),
    coverUrl: asHttpUrl(raw.coverUrl),
    durationMs: asInt(raw.durationMs),
    likeCount: asInt(raw.likeCount),
    commentCount: asInt(raw.commentCount),
    createTime: asInt(raw.createTime),
    lists,
    source: raw.source === 'dom' ? 'dom' : 'api',
    firstSeenAt: firstSeenAt ?? now,
    lastSeenAt: lastSeenAt ?? firstSeenAt ?? now
  };
}

function coerceHasMore(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  const n = Number(value);
  if (Number.isFinite(n)) return n !== 0;
  return undefined;
}

/**
 * Whole list response → records plus pagination signals.
 *
 * Accepts the response body as a JSON string (what the hook forwards) or an
 * already-parsed object (what tests and the importer pass).
 *
 * @returns {{
 *   ok: boolean, reason: string|null, listId: string|null,
 *   records: object[], itemCount: number, droppedCount: number,
 *   hasMore: boolean|undefined, cursor: (string|number|undefined),
 *   statusCode: number|undefined
 * }}
 */
export function normalizeListResponse(body, options = {}) {
  const { listId = null, source = 'api', now = Date.now() } = options;

  const empty = {
    ok: false,
    reason: null,
    listId,
    records: [],
    itemCount: 0,
    droppedCount: 0,
    hasMore: undefined,
    cursor: undefined,
    statusCode: undefined
  };

  let parsed = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      return { ...empty, reason: 'unparseable-json' };
    }
  }
  if (!parsed || typeof parsed !== 'object') return { ...empty, reason: 'not-an-object' };

  const statusCode = asInt(firstPath(parsed, OK_STATUS_PATHS));
  // Unknown status is treated as fine: some endpoints omit it entirely, and
  // refusing those would mean capturing nothing when the shape drifts.
  if (statusCode !== undefined && statusCode !== 0) {
    return { ...empty, reason: `status-code-${statusCode}`, statusCode };
  }

  const list = (listId && LISTS[listId]) || null;
  // Fall back to every known items path when the list is unidentified, so a
  // renamed endpoint still yields data.
  const itemsPaths = list
    ? list.itemsPaths
    : [...new Set(Object.values(LISTS).flatMap((entry) => entry.itemsPaths))];

  const rawItems = firstArrayPath(parsed, itemsPaths);
  if (!Array.isArray(rawItems)) {
    return { ...empty, reason: 'no-items-array', statusCode };
  }

  const records = [];
  let droppedCount = 0;
  for (const rawItem of rawItems) {
    const record = normalizeItem(rawItem, { listId, source, now });
    if (record) records.push(record);
    else droppedCount += 1;
  }

  const hasMorePaths = list
    ? list.hasMorePaths
    : [...new Set(Object.values(LISTS).flatMap((entry) => entry.hasMorePaths))];
  const cursorPaths = list
    ? list.cursorPaths
    : [...new Set(Object.values(LISTS).flatMap((entry) => entry.cursorPaths))];

  return {
    ok: true,
    reason: null,
    listId,
    records,
    itemCount: rawItems.length,
    droppedCount,
    hasMore: coerceHasMore(firstPath(parsed, hasMorePaths)),
    cursor: firstPath(parsed, cursorPaths),
    statusCode
  };
}
