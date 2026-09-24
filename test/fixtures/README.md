# Test fixtures

This is the **only** place in the repo where JSON captured from Douyin is
allowed to be committed. Everything else is `.gitignore`d because your archive
is personal data.

## Before committing anything here

A real list response is tied to your account. Scrub it:

- Replace `sec_uid`, `uid`, `short_id` and any `*_id` belonging to **you** (the
  account owner) with obvious placeholders like `SEC_UID_PLACEHOLDER`.
- Replace author nicknames/signatures with generic text if you would rather not
  publish who you follow. Keep at least one entry containing CJK characters —
  the CSV encoding tests depend on non-ASCII input.
- Drop `play_addr` / `download_addr` URL lists entirely. They are signed, expire
  within hours, and are not used by this project.
- Cookies and headers are never part of a response body, but double-check you
  copied the *response*, not the request.

Keeping `aweme_id`s is fine — they are public video identifiers.

## Naming

| File | What it is |
|---|---|
| `liked.sample.json` | one page of the 点赞 list API response |
| `favorites.sample.json` | one page of the 收藏 list API response |
| `grid-fragment.sample.html` | a snippet of the tile grid, for the DOM fallback tests |
| `captcha-dialog.sample.html` | the verify dialog markup, for the captcha detector tests |

Files shipped with the repo whose names end in `.synthetic.json` were written by
hand from documented field names, **not** captured from the live site. They exist
so the test suite is meaningful before anyone has run recon. Replace them with
real captures when you have them, and update the field paths in
`extension/lib/targets.js` to match.
