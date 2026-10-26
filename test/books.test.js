import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import zlib from 'node:zlib';
import { modeStats, pickIds, readBooks, readIndex, readLookup, verifyBooks } from '../src/books.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-books-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const book = (id, payout, free = false) => ({
  id,
  payoutMultiplier: payout,
  events: [{ index: 0, type: 'reveal' }, ...(free ? [{ index: 1, type: 'freeSpinTrigger' }] : [])],
  criteria: free ? 'freegame' : payout ? 'basegame' : '0',
});

function write(name, rows, books) {
  fs.writeFileSync(path.join(dir, `lookUpTable_${name}_0.csv`), rows.map((row) => row.join(',')).join('\n'));
  fs.writeFileSync(path.join(dir, `books_${name}.jsonl.zst`), zlib.zstdCompressSync(books.map((item) => JSON.stringify(item)).join('\n')));
}

// base: 50% loss, 30% at 1×, 15% at 2×, 4% at 30×, 1% at 100× (a free spins round)
write(
  'base',
  [[1, 50, 0], [2, 30, 100], [3, 15, 200], [4, 4, 3000], [5, 1, 10000]],
  [book(1, 0), book(2, 100), book(3, 200), book(4, 3000), book(5, 10000, true)],
);
fs.writeFileSync(
  path.join(dir, 'index.json'),
  JSON.stringify({ modes: [{ name: 'base', cost: 1, events: 'books_base.jsonl.zst', weights: 'lookUpTable_base_0.csv' }] }),
);

test('reads the modes from index.json', async () => {
  const [mode] = await readIndex(dir);
  assert.equal(mode.name, 'base');
  assert.equal(mode.cost, 1);
  assert.equal(mode.events, path.join(dir, 'books_base.jsonl.zst'));
});

test('works out RTP, hit rate, max win and tails from the lookup table', async () => {
  const lookup = await readLookup(path.join(dir, 'lookUpTable_base_0.csv'));
  const stats = modeStats(lookup, 1);
  assert.equal(stats.books, 5);
  assert.ok(Math.abs(stats.rtp - (0.3 + 0.3 + 1.2 + 1)) < 1e-9);
  assert.ok(Math.abs(stats.hitRate - 0.5) < 1e-9);
  assert.equal(stats.maxWin, 100);
  assert.ok(Math.abs(stats.maxWinChance - 0.01) < 1e-9);
  assert.ok(Math.abs(stats.tails[100] - 0.01) < 1e-9);
});

test('reports lookup rows that are not three integers', async () => {
  const file = path.join(dir, 'bad.csv');
  fs.writeFileSync(file, 'id,weight,payout\n1,10,0\n2,x,5\n3,4,100\n');
  const lookup = await readLookup(file);
  assert.equal(lookup.size, 2);
  assert.equal(lookup.problems.length, 2);
});

test('picks one book per kind of round', async () => {
  const lookup = await readLookup(path.join(dir, 'lookUpTable_base_0.csv'));
  assert.deepEqual(pickIds(lookup, 1), { loss: 1, win: 2, big: 4, max: 5 });
});

test('streams the picked books and finds a free spins round', async () => {
  const { books, feature } = await readBooks(path.join(dir, 'books_base.jsonl.zst'), [1, 4], { feature: true });
  assert.deepEqual([...books.keys()].sort(), [1, 4]);
  assert.equal(feature.id, 5);
});

test('checks every book against the lookup table', async () => {
  const lookup = await readLookup(path.join(dir, 'lookUpTable_base_0.csv'));
  const clean = await verifyBooks(path.join(dir, 'books_base.jsonl.zst'), lookup);
  assert.deepEqual(clean, { books: 5, invalid: [], unknown: [], duplicates: [], mismatched: [], missing: 0 });

  write('broken', [[1, 50, 0], [2, 30, 100], [3, 20, 200]], [book(1, 0), book(2, 150), book(2, 150), book(9, 0)]);
  const broken = await verifyBooks(path.join(dir, 'books_broken.jsonl.zst'), await readLookup(path.join(dir, 'lookUpTable_broken_0.csv')));
  assert.deepEqual(broken.mismatched, [{ id: 2, book: 150, table: 100 }]);
  assert.deepEqual(broken.duplicates, [2]);
  assert.deepEqual(broken.unknown, [9]);
  assert.equal(broken.missing, 1);
});

test('leaves books with no weight out of the stats', async () => {
  const file = path.join(dir, 'zero.csv');
  fs.writeFileSync(file, '1,90,0\n2,10,200\n3,0,500000\n');
  const stats = modeStats(await readLookup(file), 1);
  assert.equal(stats.maxWin, 2);
  assert.ok(Math.abs(stats.rtp - 0.2) < 1e-9);
});

test('fails with the file name when a books file is unreadable', async () => {
  await assert.rejects(readBooks(path.join(dir, 'nope.jsonl.zst'), [1]), /Can't read nope\.jsonl\.zst/);
  const junk = path.join(dir, 'junk.jsonl.zst');
  fs.writeFileSync(junk, 'not zstd at all');
  await assert.rejects(readBooks(junk, [1]), /Can't read junk\.jsonl\.zst/);
});
