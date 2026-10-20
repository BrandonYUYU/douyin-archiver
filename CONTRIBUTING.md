# Contributing

Thanks for helping. This is a small personal project, so the process is light.

## Reporting a bug

Open an issue with the **Bug report** form. The most useful thing you can attach
is Recon mode output: open the popup, turn on **Recon mode**, reproduce the
problem, then copy the console lines prefixed `[dy-archiver]`. Remove anything
that identifies your account first.

Never attach an archive export. It contains your viewing history.

## Proposing a change

1. Open an issue first for anything bigger than a typo, so we can agree on the
   approach before you write code.
2. Fork, then create a branch: `git switch -c fix/short-description`.
3. Keep the change focused. Site-specific values (API paths, JSON fields, CSS
   selectors) belong in `extension/lib/targets.js` and nowhere else.
4. Run the tests: `npm test`. They need Node 21 or newer and no install step.
5. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
   messages **and the pull request title**, for example
   `fix: stop treating an empty page as the end of the list`. Pull requests are
   squash-merged, so the title becomes the commit on `main`.
   Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`; add `!` for a
   breaking change (`feat!: rename export fields`).
6. Add a line under `## [Unreleased]` in `CHANGELOG.md` if users would notice the
   change.
7. Open a pull request and fill in the template. CI runs the tests automatically.

## How changes reach this repository

This public repository is published from a private working copy. An accepted pull
request is applied there and then published, so it may land here as part of a
release commit rather than as a merge of your branch. You are credited in the
changelog either way.
