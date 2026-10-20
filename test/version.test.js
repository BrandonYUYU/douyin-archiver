import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * A release bumps the version in two places, and the changelog has to describe
 * it. Forgetting one is the classic release mistake: the store or the
 * chrome://extensions page shows one number, the GitHub release another. These
 * tests make that mistake fail CI instead of shipping.
 */

function read(relative) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

const pkg = JSON.parse(read('../package.json'));
const manifest = JSON.parse(read('../extension/manifest.json'));
const changelog = read('../CHANGELOG.md');

test('package.json and manifest.json declare the same version', () => {
  assert.equal(
    manifest.version,
    pkg.version,
    'bump extension/manifest.json and package.json together'
  );
});

test('the version is plain MAJOR.MINOR.PATCH', () => {
  // Chrome rejects pre-release suffixes like 1.0.0-beta in manifest.json.
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});

test('CHANGELOG.md has a dated entry for the current version', () => {
  const heading = new RegExp(
    `^## \\[${pkg.version.replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`,
    'm'
  );
  assert.match(changelog, heading, `add "## [${pkg.version}] - YYYY-MM-DD" to CHANGELOG.md`);
});

test('CHANGELOG.md keeps an Unreleased section for work in progress', () => {
  assert.match(changelog, /^## \[Unreleased\]$/m);
});
