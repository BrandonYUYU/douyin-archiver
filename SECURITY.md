# Security policy

## Supported versions

Only the latest release receives fixes. While the project is `0.x`, there are no
backports to older versions.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub instead:
**Security** tab → **Report a vulnerability**
(<https://github.com/BrandonYUYU/douyin-archiver/security/advisories/new>).

Include what you found, how to reproduce it, and what an attacker could do with
it. You should get a first reply within 7 days. Once a fix is released, the
advisory is published and you are credited unless you ask not to be.

## What counts as a security issue here

This extension runs inside a logged-in Douyin tab and stores the user's viewing
history, so these are in scope:

- Anything that lets a web page, another extension, or an imported file run code
  in the extension's context or read the stored archive.
- Archive data leaving the browser in any way other than an export the user
  clicked.
- Exported CSV or JSON that executes when opened (for example, spreadsheet
  formula injection getting past the neutralization in `extension/lib/csv.js`).
- The page-side hook (`extension/content/hook.js`) breaking or altering Douyin's
  own requests.

Out of scope: Douyin rate limiting or captchas, and Douyin changing its site so
that capture stops working. Those are ordinary bugs; please open an issue.
