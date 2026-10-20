# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is `0.x`, the extension has not yet been verified against the
live Douyin site and any release may change behavior.

## [Unreleased]

### Added
- Architecture diagram in the README showing how the modules connect.
- GitHub Actions workflow that runs the test suite on every push and pull request.
- Bug report and feature request issue forms, and a pull request template.
- `SECURITY.md` describing how to report a vulnerability privately.
- `CONTRIBUTING.md` describing how to run the tests and propose changes.
- A test that keeps `package.json`, `manifest.json` and this changelog on the
  same version.

## [0.1.0] - 2026-09-24

### Added
- First public release.
- Network capture of the 点赞 (liked) and 收藏 (favorites) lists by wrapping the
  page's own `fetch` and `XMLHttpRequest`, reading bodies only via
  `response.clone()`.
- Auto-scroll run loop with randomized 1.5–3 s pauses, early stop after 50
  already-known videos, and a 45-minute ceiling.
- Captcha and login detection that pauses the run instead of ending it.
- Throttle detection with backoff and retry.
- DOM fallback harvester for when no list responses arrive.
- Deduplicated persistent archive on the extension's own origin.
- JSON export and import, and CSV export with a UTF-8 BOM and formula
  neutralization.
- Recon mode that logs every request URL, for rediscovering Douyin's endpoints.

[Unreleased]: https://github.com/BrandonYUYU/douyin-archiver/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/BrandonYUYU/douyin-archiver/releases/tag/v0.1.0
