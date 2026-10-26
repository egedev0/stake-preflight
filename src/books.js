// Reading a math-sdk publish folder: index.json, one lookUpTable_<mode>_0.csv (id, weight, payout)
// and one books_<mode>.jsonl.zst (a book per line) per mode. Payouts are in hundredths of the bet.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pipeline } from 'node:stream';
import zlib from 'node:zlib';

export async function readIndex(dir) {
  const file = path.join(dir, 'index.json');
  let index;
  try {
    index = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`Can't read ${file}: ${error.message}`);
  }
  if (!Array.isArray(index?.modes) || index.modes.length === 0) throw new Error(`${file} lists no modes`);
  return index.modes.map((mode) => ({
    name: String(mode?.name ?? ''),
    cost: Number(mode?.cost),
    events: typeof mode?.events === 'string' ? path.join(dir, mode.events) : null,
    weights: typeof mode?.weights === 'string' ? path.join(dir, mode.weights) : null,
  }));
}

export async function readLookup(file) {
  const text = await fs.promises.readFile(file, 'utf8');
  const ids = [];
  const weights = [];
  const payouts = [];
  const problems = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(',');
    const [id, weight, payout] = parts.map(Number);
    if (parts.length !== 3 || ![id, weight, payout].every(Number.isSafeInteger) || weight < 0 || payout < 0) {
      if (problems.length < 5) problems.push(`line ${i + 1}: ${line.slice(0, 60)}`);
      continue;
    }
    ids.push(id);
    weights.push(weight);
    payouts.push(payout);
  }
  return { ids, weights, payouts, size: ids.length, problems };
}

/** Win sizes the tail odds are reported for, in multiples of the bet. */
export const TAILS = [100, 1000, 5000, 10000, 25000, 50000];

/** RTP, hit rate, max win, volatility and tail odds of one mode. Wins are in multiples of the base bet. */
export function modeStats(lookup, cost) {
  let total = 0;
  let returned = 0;
  let squares = 0;
  let hits = 0;
  let max = 0;
  let maxWeight = 0;
  const tails = TAILS.map(() => 0);
  for (let i = 0; i < lookup.size; i++) {
    const weight = lookup.weights[i];
    const win = lookup.payouts[i] / 100;
    if (!weight) continue;
    total += weight;
    returned += weight * win;
    squares += weight * win * win;
    if (win > 0) hits += weight;
    if (win > max) {
      max = win;
      maxWeight = weight;
    } else if (win === max) {
      maxWeight += weight;
    }
    for (let t = 0; t < TAILS.length; t++) if (win >= TAILS[t]) tails[t] += weight;
  }
  if (!total) return null;
  const mean = returned / total;
  return {
    books: lookup.size,
    rtp: mean / cost,
    hitRate: hits / total,
    maxWin: max,
    maxWinChance: max > 0 ? maxWeight / total : 0,
    volatility: Math.sqrt(Math.max(0, squares / total - mean * mean)) / cost,
    tails: Object.fromEntries(TAILS.map((size, t) => [size, tails[t] / total])),
  };
}

/**
 * One book id per kind of round, so every run plays the same rounds: the first loss, the first small
 * win (up to 5× the cost), the first big win (20× the cost or more, below the max) and the first max win.
 * Books with no weight are skipped: the RGS never draws them.
 */
export function pickIds(lookup, cost) {
  let max = 0;
  for (let i = 0; i < lookup.size; i++) if (lookup.weights[i] > 0 && lookup.payouts[i] > max) max = lookup.payouts[i];
  const picks = {};
  for (let i = 0; i < lookup.size; i++) {
    if (!lookup.weights[i]) continue;
    const id = lookup.ids[i];
    const payout = lookup.payouts[i];
    const win = payout / 100 / cost;
    if (win === 0) picks.loss ??= id;
    else if (win <= 5) picks.win ??= id;
    else if (win >= 20 && payout < max) picks.big ??= id;
    if (max > 0 && payout === max) picks.max ??= id;
  }
  return picks;
}

const FEATURE = /"criteria"\s*:\s*"freegame"|"type"\s*:\s*"freeSpinTrigger"/;
const ID = /^\{\s*"id"\s*:\s*(\d+)/;
const HEAD = /^\{\s*"id"\s*:\s*(\d+)\s*,\s*"payoutMultiplier"\s*:\s*(\d+)/;

/** A book's id, read from the start of its line; null for a line that isn't a book. */
const bookId = (line) => {
  const match = ID.exec(line);
  if (match) return Number(match[1]);
  try {
    return JSON.parse(line).id ?? null;
  } catch {
    return null;
  }
};

/**
 * Streams a books file and returns the books with these ids. With `feature`, it also returns a free spins
 * round (the shortest of the first few it meets), so the scenarios can show one without searching by hand.
 * Reading stops as soon as it has everything.
 */
export async function readBooks(file, ids, { feature = false } = {}) {
  const wanted = new Set(ids.filter((id) => id !== undefined));
  const found = new Map();
  let featureLine = null;
  let featureCount = 0;
  await eachLine(file, (line, count) => {
    const id = bookId(line);
    if (wanted.has(id) && !found.has(id)) found.set(id, JSON.parse(line));
    if (feature && featureCount < 10 && FEATURE.test(line)) {
      featureCount += 1;
      if (!featureLine || line.length < featureLine.length) featureLine = line;
    }
    const haveFeature = !feature || featureCount >= 10 || (featureCount > 0 && count > 200_000) || count > 2_000_000;
    return found.size === wanted.size && haveFeature;
  });
  return { books: found, feature: featureLine ? JSON.parse(featureLine) : null };
}

/** Checks every book against the lookup table: valid JSON, the same ids, the same payouts. */
export async function verifyBooks(file, lookup) {
  const expected = new Map();
  for (let i = 0; i < lookup.size; i++) expected.set(lookup.ids[i], lookup.payouts[i]);
  const seen = new Set();
  const result = { books: 0, invalid: [], unknown: [], duplicates: [], mismatched: [], missing: 0 };
  await eachLine(file, (line, count) => {
    result.books += 1;
    let book;
    try {
      book = JSON.parse(line);
    } catch {
      if (result.invalid.length < 5) result.invalid.push(`line ${count}`);
      const head = HEAD.exec(line);
      if (!head) return false;
      book = { id: Number(head[1]), payoutMultiplier: Number(head[2]) };
    }
    const { id, payoutMultiplier } = book;
    if (seen.has(id)) {
      if (result.duplicates.length < 5) result.duplicates.push(id);
      return false;
    }
    seen.add(id);
    if (!expected.has(id)) {
      if (result.unknown.length < 5) result.unknown.push(id);
    } else if (expected.get(id) !== payoutMultiplier && result.mismatched.length < 5) {
      result.mismatched.push({ id, book: payoutMultiplier, table: expected.get(id) });
    }
    return false;
  });
  for (const id of expected.keys()) if (!seen.has(id)) result.missing += 1;
  return result;
}

/** Calls `onLine(line, count)` for each line of a .jsonl.zst file until it returns true. */
async function eachLine(file, onLine) {
  if (typeof zlib.createZstdDecompress !== 'function') {
    throw new Error(`Reading .zst books needs Node 22.15 or newer (this is ${process.version})`);
  }
  // pipeline passes a read error on to the decompressor, so the loop below ends with it
  const input = pipeline(fs.createReadStream(file), zlib.createZstdDecompress(), () => {});
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const line of lines) {
      if (!line) continue;
      count += 1;
      if (onLine(line, count)) break;
    }
  } catch (error) {
    throw new Error(`Can't read ${path.basename(file)}: ${error.message}`);
  } finally {
    lines.close();
    input.destroy();
  }
  return count;
}
