/**
 * dedup.js — merge freshly captured records into the archive.
 *
 * Pure and non-mutating: takes the existing id→record map, returns a new one
 * plus a report. The service worker owns persistence; this module owns the
 * decision of what "already have it" means.
 *
 * Merge rules, in priority order:
 *  1. The video id is the only identity. The same video appearing in both 点赞
 *     and 收藏 is ONE record whose `lists` is the union — not two rows.
 *  2. A field is only overwritten by a non-empty incoming value. This is what
 *     stops the DOM fallback (which knows nothing but the id) from blanking
 *     metadata previously captured from the API.
 *  3. `source` upgrades from 'dom' to 'api' but never downgrades.
 *  4. `firstSeenAt` keeps the earliest timestamp; `lastSeenAt` the latest.
 */

const META_FIELDS = [
  'desc',
  'authorName',
  'authorUrl',
  'coverUrl',
  'durationMs',
  'likeCount',
  'commentCount',
  'createTime'
];

function isEmptyValue(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  return false;
}

function unionLists(a, b) {
  const merged = new Set();
  for (const source of [a, b]) {
    if (!Array.isArray(source)) continue;
    for (const entry of source) {
      if (typeof entry === 'string' && entry) merged.add(entry);
    }
  }
  return [...merged].sort();
}

/**
 * Merge one incoming record onto an existing one.
 * @returns {{record: object, changed: boolean}}
 */
export function mergeRecord(existing, incoming) {
  if (!existing) return { record: { ...incoming }, changed: true };

  const merged = { ...existing };
  let changed = false;

  for (const field of META_FIELDS) {
    const next = incoming[field];
    if (isEmptyValue(next)) continue; // rule 2
    if (merged[field] !== next) {
      merged[field] = next;
      changed = true;
    }
  }

  if (isEmptyValue(merged.url) && !isEmptyValue(incoming.url)) {
    merged.url = incoming.url;
    changed = true;
  }

  const lists = unionLists(existing.lists, incoming.lists); // rule 1
  if (lists.length !== (existing.lists?.length ?? 0) || lists.some((v, i) => v !== existing.lists?.[i])) {
    merged.lists = lists;
    changed = true;
  } else {
    merged.lists = lists;
  }

  if (existing.source !== 'api' && incoming.source === 'api') {
    merged.source = 'api'; // rule 3
    changed = true;
  }

  // rule 4 — timestamps move but do not count as a meaningful change, otherwise
  // every re-scan would report the whole archive as "updated".
  const firstSeen = Math.min(
    Number.isFinite(existing.firstSeenAt) ? existing.firstSeenAt : Infinity,
    Number.isFinite(incoming.firstSeenAt) ? incoming.firstSeenAt : Infinity
  );
  merged.firstSeenAt = Number.isFinite(firstSeen) ? firstSeen : Date.now();

  const lastSeen = Math.max(
    Number.isFinite(existing.lastSeenAt) ? existing.lastSeenAt : -Infinity,
    Number.isFinite(incoming.lastSeenAt) ? incoming.lastSeenAt : -Infinity
  );
  merged.lastSeenAt = Number.isFinite(lastSeen) ? lastSeen : Date.now();

  return { record: merged, changed };
}

/**
 * Merge a batch into the archive.
 *
 * @param {Record<string, object>} existingMap  id → record (not mutated)
 * @param {object[]} incoming
 * @returns {{
 *   records: Record<string, object>,
 *   addedIds: string[], updatedIds: string[],
 *   added: number, updated: number, known: number,
 *   consecutiveKnownAtEnd: number
 * }}
 */
export function mergeRecords(existingMap, incoming) {
  const records = { ...(existingMap && typeof existingMap === 'object' ? existingMap : {}) };
  const addedIds = [];
  const updatedIds = [];
  let known = 0;

  // Longest run of already-known ids ending at the batch's last item. The lists
  // are newest-first, so a long run means we have reached territory already
  // archived — this is what drives early-stop (docs/decisions.md §8).
  let consecutiveKnownAtEnd = 0;

  for (const candidate of Array.isArray(incoming) ? incoming : []) {
    if (!candidate || typeof candidate !== 'object') continue;
    const id = typeof candidate.id === 'string' ? candidate.id : '';
    if (!id) continue;

    const existed = Object.prototype.hasOwnProperty.call(records, id);
    const { record, changed } = mergeRecord(existed ? records[id] : null, candidate);
    records[id] = record;

    if (!existed) {
      addedIds.push(id);
      consecutiveKnownAtEnd = 0;
    } else {
      known += 1;
      consecutiveKnownAtEnd += 1;
      if (changed) updatedIds.push(id);
    }
  }

  return {
    records,
    addedIds,
    updatedIds,
    added: addedIds.length,
    updated: updatedIds.length,
    known,
    consecutiveKnownAtEnd
  };
}

/** Count of records in an archive map. */
export function countRecords(recordsMap) {
  return recordsMap && typeof recordsMap === 'object' ? Object.keys(recordsMap).length : 0;
}
