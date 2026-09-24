import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Guards the most boring extension bug there is: a script reading an element id
 * the HTML does not define. It fails silently at runtime with a null reference,
 * and no amount of unit-testing the pure modules would catch it.
 */

const PAGES = [
  { html: '../extension/popup/popup.html', js: '../extension/popup/popup.js', name: 'popup' },
  { html: '../extension/pages/manage.html', js: '../extension/pages/manage.js', name: 'manage page' }
];

function read(relative) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

for (const page of PAGES) {
  test(`${page.name}: every element id the script reads exists in the markup`, () => {
    const html = read(page.html);
    const js = read(page.js);

    const declared = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
    const used = new Set(
      [...js.matchAll(/(?:getElementById\(|\bel\()'([^']+)'/g)].map((match) => match[1])
    );

    assert.ok(used.size > 0, 'found no element lookups — has the script been rewritten?');
    const missing = [...used].filter((id) => !declared.has(id));
    assert.deepEqual(missing, [], `ids read but never declared: ${missing.join(', ')}`);
  });

  test(`${page.name}: referenced scripts and stylesheets exist`, () => {
    const html = read(page.html);
    const base = new URL(page.html, import.meta.url);

    const assets = [
      ...[...html.matchAll(/src="([^"]+)"/g)].map((match) => match[1]),
      ...[...html.matchAll(/href="([^"#]+\.css)"/g)].map((match) => match[1])
    ];

    assert.ok(assets.length > 0);
    for (const asset of assets) {
      assert.doesNotThrow(
        () => readFileSync(new URL(asset, base)),
        `${page.name} references a missing asset: ${asset}`
      );
    }
  });
}

test('the settings form covers every field the popup writes', () => {
  const html = read('../extension/popup/popup.html');
  const js = read('../extension/popup/popup.js');

  // The popup builds its settings patch from these two arrays; each entry needs a
  // matching input, or saving would send NaN/undefined.
  const arrays = [...js.matchAll(/const (NUMBER_FIELDS|FLAG_FIELDS) = \[([^\]]*)\]/g)];
  assert.equal(arrays.length, 2, 'could not find the settings field lists');

  const fields = arrays.flatMap((match) =>
    [...match[2].matchAll(/'([^']+)'/g)].map((inner) => inner[1])
  );
  assert.ok(fields.length >= 6);

  const declared = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  for (const field of fields) {
    assert.ok(declared.has(field), `settings field "${field}" has no input in the popup`);
  }
});

test('every settings input the popup writes is a known setting', async () => {
  const { DEFAULT_SETTINGS } = await import('../extension/lib/settings.js');
  const js = read('../extension/popup/popup.js');

  const arrays = [...js.matchAll(/const (NUMBER_FIELDS|FLAG_FIELDS) = \[([^\]]*)\]/g)];
  const fields = arrays.flatMap((match) =>
    [...match[2].matchAll(/'([^']+)'/g)].map((inner) => inner[1])
  );

  for (const field of fields) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, field),
      `popup writes "${field}", which normalizeSettings would silently discard`
    );
  }
});

test('the manage page keeps import and delete, which the popup deliberately lacks', () => {
  const manage = read('../extension/pages/manage.html');
  const popup = read('../extension/popup/popup.html');

  // Import must not move into the popup: a native file picker can dismiss a popup
  // before its change event fires (see popup.js header).
  assert.match(manage, /type="file"/);
  assert.ok(!popup.includes('type="file"'), 'a file input reappeared in the popup');
  assert.match(manage, /id="clearArchive"/);
});
