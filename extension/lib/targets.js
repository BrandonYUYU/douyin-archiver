/**
 * targets.js — EVERY assumption this project makes about Douyin lives here.
 *
 * Nothing else in the codebase should contain a Douyin URL path, a JSON field
 * name, or a CSS selector. When Douyin changes something, this is the only file
 * you edit. Use the popup's "Recon mode" to discover the new values and write
 * them down in docs/findings.md.
 *
 * VERIFICATION STATUS: the field paths and selectors below are *candidates*
 * based on documented/observed Douyin web API shapes, not yet confirmed against
 * a live logged-in session. That is why every field accepts a LIST of candidate
 * paths and the first one that resolves wins — an unverified guess degrades into
 * a missing field instead of a crash. See docs/findings.md.
 */

/** Canonical watch URL. The only identifier that never expires. */
export const VIDEO_URL_TEMPLATE = 'https://www.douyin.com/video/{id}';

/** Author profile URL. Built from sec_uid, which is stable and public. */
export const AUTHOR_URL_TEMPLATE = 'https://www.douyin.com/user/{secUid}';

/**
 * Broad prefilter used by content/hook.js in the MAIN world.
 *
 * hook.js cannot import this file: MAIN-world scripts have no chrome.* APIs, so
 * they cannot resolve an extension URL. It therefore ships with its own copy of
 * a permissive default and receives this list from content.js over postMessage.
 *
 * It is deliberately broad rather than set to the apiHints below, because those
 * hints are unverified (docs/findings.md). A broad filter forwards some
 * unrelated JSON — content.js discards it immediately — whereas a precise filter
 * built on a wrong guess would capture nothing at all and look like a bug.
 *
 * Once you have confirmed the real endpoints, narrowing this to those exact
 * paths is a free performance win.
 */
export const BROAD_URL_FILTERS = ['/aweme/v1/web/'];

/**
 * The two lists we can archive.
 *
 * apiHints: substrings that identify this list's pagination endpoint. A response
 * is attributed to a list when its URL contains any hint. Ordered most-specific
 * first, because `liked` and `favorites` endpoints are easy to confuse.
 */
export const LISTS = {
  liked: {
    id: 'liked',
    label: '点赞 (liked)',
    pageUrl: 'https://www.douyin.com/user/self?showTab=like',
    pageQuery: { showTab: 'like' },
    apiHints: ['/aweme/v1/web/aweme/favorite/'],
    itemsPaths: ['aweme_list', 'data.aweme_list', 'awemeList'],
    hasMorePaths: ['has_more', 'hasMore'],
    cursorPaths: ['max_cursor', 'maxCursor', 'cursor']
  },
  favorites: {
    id: 'favorites',
    label: '收藏 (favorites)',
    pageUrl: 'https://www.douyin.com/user/self?showTab=favorite_collection',
    pageQuery: { showTab: 'favorite_collection' },
    apiHints: [
      '/aweme/v1/web/aweme/listcollection/',
      '/aweme/v1/web/collects/video/list/'
    ],
    itemsPaths: ['aweme_list', 'data.aweme_list', 'items', 'awemeList'],
    hasMorePaths: ['has_more', 'hasMore'],
    cursorPaths: ['cursor', 'max_cursor', 'maxCursor']
  }
};

export const LIST_IDS = Object.keys(LISTS);

/** `status_code: 0` means success in Douyin's web API. */
export const OK_STATUS_PATHS = ['status_code', 'statusCode', 'data.status_code'];

/**
 * Where each wanted field lives inside one list item.
 * First resolving path wins. Add, don't replace, when correcting these — an
 * extra candidate costs nothing and keeps older captures parseable.
 */
export const ITEM_FIELD_PATHS = {
  id: ['aweme_id', 'awemeId', 'aweme_info.aweme_id', 'id'],
  desc: ['desc', 'aweme_info.desc', 'title', 'item_title'],
  authorName: ['author.nickname', 'aweme_info.author.nickname', 'author_name'],
  authorSecUid: ['author.sec_uid', 'aweme_info.author.sec_uid', 'author.secUid'],
  coverUrl: [
    'video.cover.url_list.0',
    'video.origin_cover.url_list.0',
    'video.dynamic_cover.url_list.0',
    'aweme_info.video.cover.url_list.0',
    'cover'
  ],
  durationMs: ['video.duration', 'duration', 'aweme_info.video.duration'],
  likeCount: ['statistics.digg_count', 'aweme_info.statistics.digg_count'],
  commentCount: ['statistics.comment_count', 'aweme_info.statistics.comment_count'],
  createTime: ['create_time', 'aweme_info.create_time', 'createTime']
};

/**
 * Fields we deliberately refuse to store.
 * play_addr URLs are signed, expire within hours, and are gated against
 * non-browser clients — useless for later downloading, so pure noise.
 * Documented here so nobody "helpfully" adds them back. See docs/decisions.md §4.
 */
export const EXCLUDED_FIELDS = ['video.play_addr', 'video.download_addr'];

export const SELECTORS = {
  /** Video tiles in the grid. Used only by the DOM fallback harvester. */
  tileAnchors: 'a[href*="/video/"]',

  /**
   * Captcha / slider verification dialog. Matching ANY of these pauses the run.
   * Over-inclusive on purpose: a false pause costs you a few seconds, a missed
   * captcha silently truncates the archive.
   */
  captcha: [
    '#captcha_container',
    '#captcha-verify-image',
    '.captcha_verify_container',
    '.captcha-verify-container',
    '.vc-captcha-container',
    '[class*="captcha_verify"]',
    '[class*="captcha-verify"]',
    '[id*="captcha"]'
  ],

  /** Login walls — a run is pointless if we have been logged out. */
  loginWall: ['#login-panel', '[class*="login-panel"]', '[class*="login_panel"]']
};

/** Matches /video/{digits} in an href, capturing the id. */
export const VIDEO_HREF_PATTERN = /\/video\/(\d{6,})/;

/** True when the current location looks like the given list's page. */
export function pageMatchesList(urlString, listId) {
  const list = LISTS[listId];
  if (!list) return false;
  try {
    const url = new URL(urlString);
    return Object.entries(list.pageQuery).every(
      ([key, value]) => url.searchParams.get(key) === value
    );
  } catch {
    return false;
  }
}

/** Which list an API URL belongs to, or null if it is not a list endpoint. */
export function listIdForApiUrl(urlString) {
  if (typeof urlString !== 'string') return null;
  for (const list of Object.values(LISTS)) {
    if (list.apiHints.some((hint) => urlString.includes(hint))) return list.id;
  }
  return null;
}
