// Writes the tiny math publish folder the tests and the demo use: a base game and a 100× bonus buy,
// a dozen books each. Run it again after changing the books: node test/fixtures/make-math.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'math');

const SYMBOLS = ['A', 'K', 'Q', 'J', 'W'];
const board = (seed) => Array.from({ length: 5 }, (_, reel) => Array.from({ length: 3 }, (_, row) => ({ name: SYMBOLS[(seed + reel * 3 + row) % 5] })));

/** A round: one reveal per spin, a free spins trigger when it has more than one, the total at the end. */
function book(id, payout, spins = 1) {
  const events = [];
  for (let spin = 0; spin < spins; spin++) {
    events.push({ index: events.length, type: 'reveal', board: board(id + spin), gameType: spin ? 'freegame' : 'basegame' });
    if (spin === 0 && spins > 1) events.push({ index: events.length, type: 'freeSpinTrigger', totalFs: spins - 1 });
  }
  events.push({ index: events.length, type: 'finalWin', amount: payout });
  const criteria = payout === 0 ? '0' : spins > 1 ? 'freegame' : 'basegame';
  return { id, payoutMultiplier: payout, events, criteria, baseGameWins: payout / 100, freeGameWins: 0 };
}

const MODES = {
  base: {
    cost: 1,
    books: [
      [0, 431.2], [0, 431.2], [0, 431.2],
      [40, 300], [120, 260], [300, 120], [2000, 30],
      [2500, 12, 4], [8000, 3, 6], [500000, 0.002, 8],
    ],
  },
  bonus: {
    cost: 100,
    books: [[3000, 17.95, 4], [9000, 50, 6], [15000, 12, 8], [40000, 2, 8], [500000, 0.05, 10]],
  },
};

fs.mkdirSync(dir, { recursive: true });
const index = { modes: [] };
for (const [name, mode] of Object.entries(MODES)) {
  // weights are scaled to whole numbers, as the math-sdk writes them
  const rows = mode.books.map(([payout, weight, spins], id) => ({ id, payout, spins: spins ?? 1, weight: Math.round(weight * 1000) }));
  const lookup = rows.map((row) => `${row.id},${row.weight},${row.payout}`).join('\n');
  const books = rows.map((row) => JSON.stringify(book(row.id, row.payout, row.spins))).join('\n');
  fs.writeFileSync(path.join(dir, `lookUpTable_${name}_0.csv`), `${lookup}\n`);
  fs.writeFileSync(path.join(dir, `books_${name}.jsonl.zst`), zlib.zstdCompressSync(`${books}\n`));
  index.modes.push({ name, cost: mode.cost, events: `books_${name}.jsonl.zst`, weights: `lookUpTable_${name}_0.csv` });
}
fs.writeFileSync(path.join(dir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
console.log(`wrote ${dir}`);
