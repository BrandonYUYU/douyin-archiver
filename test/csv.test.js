import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { escapeCsvCell, toCsv, recordsToCsv, CSV_BOM, CSV_COLUMNS } from '../extension/lib/csv.js';
import { normalizeListResponse } from '../extension/lib/normalize.js';
import { mergeRecords } from '../extension/lib/dedup.js';

const liked = JSON.parse(readFileSync(new URL('./fixtures/liked.synthetic.json', import.meta.url)));
const records = normalizeListResponse(liked, { listId: 'liked', now: 1_700_000_000_000 }).records;

test('plain values pass through unquoted', () => {
  assert.equal(escapeCsvCell('hello'), 'hello');
  assert.equal(escapeCsvCell(1234), '1234');
  assert.equal(escapeCsvCell(''), '');
  assert.equal(escapeCsvCell(null), '');
  assert.equal(escapeCsvCell(undefined), '');
});

test('commas, quotes and newlines are quoted and doubled', () => {
  assert.equal(escapeCsvCell('a,b'), '"a,b"');
  assert.equal(escapeCsvCell('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCsvCell('line1\nline2'), '"line1\nline2"');
  assert.equal(escapeCsvCell('carriage\r\nreturn'), '"carriage\r\nreturn"');
});

test('CJK text is never quoted or altered', () => {
  assert.equal(escapeCsvCell('今天的晚餐：红烧肉 🍖'), '今天的晚餐：红烧肉 🍖');
});

test('formula-leading cells are neutralized', () => {
  // These come from other people's captions, so they are untrusted input.
  assert.equal(escapeCsvCell('=1+1'), "'=1+1");
  assert.equal(escapeCsvCell('+SUM(A1)'), "'+SUM(A1)");
  assert.equal(escapeCsvCell('-2'), "'-2");
  assert.equal(escapeCsvCell('@import'), "'@import");
  assert.equal(escapeCsvCell('=HYPERLINK("http://x","clickme")'), '"\'=HYPERLINK(""http://x"",""clickme"")"');
  // A plain negative number in a numeric column is still safe to read back.
  assert.equal(escapeCsvCell(-2), "'-2");
});

test('the file starts with a UTF-8 BOM so Excel renders Chinese correctly', () => {
  const csv = recordsToCsv(records);
  assert.ok(csv.startsWith(CSV_BOM), 'missing BOM — Excel would show mojibake');
  assert.ok(csv.includes('今天的晚餐'));
});

test('the BOM can be turned off for machine consumers', () => {
  assert.ok(!toCsv([['a']], { bom: false }).startsWith(CSV_BOM));
});

test('the header is the documented column order', () => {
  const csv = recordsToCsv(records);
  const firstLine = csv.slice(CSV_BOM.length).split('\r\n')[0];
  assert.equal(firstLine, CSV_COLUMNS.join(','));
  assert.equal(CSV_COLUMNS[0], 'id');
  assert.equal(CSV_COLUMNS[1], 'url');
});

test('each record becomes exactly one row even with newlines in the description', () => {
  const csv = recordsToCsv(records);
  const body = csv.slice(CSV_BOM.length);

  // A quoted description contains a literal newline, so counting physical lines
  // would over-count. Rows are delimited by a newline followed by an id.
  const rows = body.split(/\r\n(?=\d{6,},)/);
  assert.equal(rows.length - 1, records.length, 'a description newline broke the row count');

  const awkward = body.split('\r\n').find((line) => line.startsWith('7309876543210987654'));
  assert.ok(awkward.includes('"标题里有 ""引号"", 逗号'), 'quotes/commas not escaped as expected');
});

test('lists render as a pipe-joined string and timestamps as ISO', () => {
  const csv = recordsToCsv([
    {
      id: '123',
      url: 'https://www.douyin.com/video/123',
      desc: 'x',
      lists: ['favorites', 'liked'],
      createTime: 1714400000,
      firstSeenAt: 1_700_000_000_000,
      lastSeenAt: 1_700_000_060_000
    }
  ]);
  const row = csv.slice(CSV_BOM.length).split('\r\n')[1];

  assert.ok(row.includes('favorites|liked'));
  assert.ok(row.includes('2024-04-29T14:13:20.000Z'), 'createTime should be ISO from unix seconds');
  assert.ok(row.includes('2023-11-14T22:13:20.000Z'));
});

test('an empty archive still produces a usable header-only file', () => {
  const csv = recordsToCsv([]);
  assert.equal(csv, CSV_BOM + CSV_COLUMNS.join(',') + '\r\n');
});

test('missing fields become empty cells, not the word undefined', () => {
  const csv = recordsToCsv([{ id: '123' }]);
  const row = csv.slice(CSV_BOM.length).split('\r\n')[1];
  assert.ok(!row.includes('undefined'));
  assert.equal(row.split(',').length, CSV_COLUMNS.length);
});

test('records can be passed as a map as well as an array', () => {
  // Record ids are numeric strings, so a map iterates in numeric key order while
  // an array keeps insertion order. Export ordering must not depend on which.
  const archive = mergeRecords({}, records).records; // deduplicated, as storage holds it
  assert.equal(recordsToCsv(archive), recordsToCsv(Object.values(archive)));
});

test('CSV rows are ordered newest first, matching the JSON export', () => {
  const rows = recordsToCsv(records)
    .slice(CSV_BOM.length)
    .split(/\r\n(?=\d{6,},)/)
    .slice(1);

  const createTimes = rows.map((row) => {
    // createTime is the 10th column and is rendered as an ISO string.
    const iso = row.match(/,(\d{4}-\d{2}-\d{2}T[\d:.]+Z),/);
    return iso ? Date.parse(iso[1]) : 0;
  });
  const sorted = [...createTimes].sort((a, b) => b - a);
  assert.deepEqual(createTimes, sorted);
});
