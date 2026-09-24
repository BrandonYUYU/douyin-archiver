<img src="docs/icon-preview.png" alt="Extension icon: a white download arrow on a blue rounded square" width="96" align="right" />


# Douyin Liked / Favorites Archiver

A Chrome/Edge extension that auto-scrolls your own Douyin 点赞 (liked) and 收藏
(favorites) lists, captures every video's URL and metadata as it streams past,
deduplicates it into persistent storage, and exports it as JSON or CSV.

No build step, no dependencies, no bundler — plain JavaScript.

## Why an extension and not a scraper

Two properties of the site make a standalone scraper the wrong tool:

- **Requests are signed.** Douyin's list endpoints require an `a_bogus` parameter
  computed by obfuscated page JavaScript, and it rotates. Reimplementing the
  signer is a maintenance treadmill. Running inside your logged-in tab means the
  page signs its own requests and the extension simply reads the responses —
  signing stops being a problem rather than getting solved.
- **The grid is virtualized.** Tiles are removed from the DOM once scrolled past,
  so the complete list never exists anywhere at once. Capture has to happen
  continuously during the scroll, not after it.

Concretely: a content script declared with `"world": "MAIN"` patches the page's own
`fetch` and `XMLHttpRequest`, reads each list response via `response.clone()` — the
original stream is left untouched for the page to consume — and forwards a copy over
`postMessage` to an isolated-world script, which validates it and hands it to the
service worker for deduplicated storage. See `extension/content/hook.js`.

## Install

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder.

Requires Chrome or Edge **111 or newer**, for `world: "MAIN"` content scripts.

## Usage

1. Log in to Douyin and open your own list:
   `https://www.douyin.com/user/self?showTab=like`
   (or `?showTab=favorite_collection` for 收藏).
2. Open the popup, pick the list, click **Start**.
3. The page scrolls itself with randomized 1.5–3 s pauses. Live counters show
   scrolls, new videos, the already-known streak, and anything the DOM fallback
   contributed. The toolbar badge shows the total stored.
4. Closing the popup does not stop the run — it lives in the page, not the popup.

### If a captcha appears

The run pauses, the badge turns to `!!`, and a notification fires. Solve the
slider by hand and the run resumes where it stopped.

This matters for correctness rather than politeness: an undetected captcha looks
identical to "reached the end of the list" and would silently truncate the
archive. The same reasoning applies to rate limiting — empty pages while the API
still reports `has_more` are treated as throttling (back off and retry), not as
the end.

### Incremental runs

Both lists are ordered newest-first, so after the first full run the tool stops
once it has passed 50 consecutive already-known videos. A repeat run typically
finishes in about ten seconds. **Full rescan** in the settings walks the whole
list again.

## Export and import

- **Export JSON** — the archival format, and what Import reads.
- **Export CSV** — for spreadsheets. Written with a UTF-8 BOM so Excel renders
  Chinese correctly, and cells starting with `=`, `+`, `-` or `@` are neutralized
  so a video caption cannot execute as a formula.
- **Import** lives on the options page (popup → *Import / clear archive*), because
  opening a file picker from a popup can dismiss the popup before the file is
  handed over. Records merge by video ID, so importing twice adds nothing.

The archive lives on the extension's own origin, so clearing your browser cache
or Douyin's site data does not touch it. Uninstalling the extension or deleting
your browser profile does. Keep one exported JSON file and any loss is
recoverable — that, rather than the storage backend, is the durability story.

## What gets captured

Per video: id, canonical `https://www.douyin.com/video/{id}` URL, description,
author name, author profile link, cover image URL, duration, like count, comment
count, create time, which list it came from, and whether it came from the API or
the DOM fallback.

**Not** captured: the CDN play URL. It expires within hours and is gated against
non-browser clients, so it cannot be used for downloading later — storing it would
only add noise.

## Development

```
node --test                 # unit tests for the pure logic in extension/lib/
node tools/make-icons.js    # regenerate the icons
```

All decision logic — normalizing, dedup, stop rules, CSV, detectors — lives in
`extension/lib/` as dependency-free ES modules with no browser APIs, so it is
testable in Node while also being importable by the extension. The impure parts
are injected: the store takes a storage area, the scroll loop takes a page object,
a clock and a random source. That is why the suite runs in about a second without
a browser.

### When Douyin changes something

Every site-specific assumption — API paths, JSON field paths, CSS selectors —
lives in `extension/lib/targets.js` and nowhere else. Each field is declared as a
*list* of candidate paths, first match wins, so a stale guess costs one missing
field rather than the whole run.

To rediscover the current values, enable **Recon mode** in the popup: the page-side
hook then logs every request URL to the console, prefixed `[dy-archiver]`.

```
extension/
  manifest.json
  lib/            pure, testable modules (+ targets.js = all site assumptions)
  content/        hook.js (MAIN world) + content.js (isolated world)
  background/     service worker: storage, dedup, checkpoints
  popup/          UI
  pages/          options page: import, delete
test/             node --test suites and fixtures
```

## Scope

Reads only your own signed-in account's lists, through the normal web UI. No
credential handling, no request-signing bypass, no requests the page would not
otherwise make. It is a personal archiving tool for your own data.

## License

MIT — see [`LICENSE`](LICENSE).
