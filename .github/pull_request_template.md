<!--
Title the PR as a Conventional Commit. With squash merging it becomes the one
commit on main, so it is what the changelog and version bump are read from:

  fix(targets): use the real liked endpoint path
  feat: add duration column to CSV export
  docs: explain recon mode in README

Types: feat, fix, docs, test, refactor, chore, ci. Add "!" for a breaking
change, e.g. "feat!: rename export fields".
-->

## What and why

<!-- What does this change, and what problem does it solve? Link the issue: "Fixes #12". -->

## How it was tested

<!-- Tests added or updated, and anything checked by hand on the live site. -->

## Checklist

- [ ] `npm test` passes
- [ ] Site-specific values (API paths, JSON fields, selectors) are only in `extension/lib/targets.js`
- [ ] User-visible changes are listed under `## [Unreleased]` in `CHANGELOG.md`
- [ ] No archive exports, personal data, or account identifiers are included
