// Reading a math-sdk publish folder: index.json, one lookUpTable_<mode>_0.csv (id, weight, payout)
// and one books_<mode>.jsonl.zst (a book per line) per mode. Payouts are in hundredths of the bet.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pipeline } from 'node:stream';
import zlib from 'node:zlib';
import type { Book, Kind, ModeStats } from './types.ts';
import { checkStopped, errorMessage } from './util.ts';

/** A mode as index.json lists it, with its files as full paths. */
export interface IndexMode {
  name: string;
  cost: number;
  events: string | null;
  weights: string | null;
}

export interface Lookup {
  ids: number[];
  weights: number[];
  payouts: number[];
  size: number;
  /** rows that couldn't be read (the first few) */
  problems: string[];
}

export async function readIndex(dir: string): Promise<IndexMode[]> {
  const file = path.join(dir, 'index.json');
  let index: unknown;
  try {
    index = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`Can't read ${file}: ${errorMessage(error)}`);
  }
  const modes = (index as { modes?: unknown } | null)?.modes;
  if (!Array.isArray(modes) || modes.length === 0) throw new Error(`${file} lists no modes`);
  return modes.map((mode: Record<string, unknown> | null) => ({
    name: String(mode?.name ?? ''),
    cost: Number(mode?.cost),
    events: typeof mode?.events === 'string' ? path.join(dir, mode.events) : null,
    weights: typeof mode?.weights === 'string' ? path.join(dir, mode.weights) : null,
  }));
}

export async function readLookup(file: string): Promise<Lookup> {
  const text = await fs.promises.readFile(file, 'utf8');
  const lookup: Lookup = { ids: [], weights: [], payouts: [], size: 0, problems: [] };
  const lines = text.split(/\r?\n/);
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(',');
    const [id, weight, payout] = parts.map(Number);
    if (
      parts.length !== 3 ||
      id === undefined ||
      weight === undefined ||
      payout === undefined ||
      ![id, weight, payout].every(Number.isSafeInteger) ||
      weight < 0 ||
      payout < 0
    ) {
      if (lookup.problems.length < 5) lookup.problems.push(`line ${i + 1}: ${line.slice(0, 60)}`);
      continue;
    }
    lookup.ids.push(id);
    lookup.weights.push(weight);
    lookup.payouts.push(payout);
  }
  lookup.size = lookup.ids.length;
  return lookup;
}

/** Win sizes the tail odds are reported for, in multiples of the bet. */
export const TAILS = [100, 1000, 5000, 10000, 25000, 50000] as const;

/** RTP, hit rate, max win, volatility and tail odds of one mode. Wins are in multiples of the base bet. */
export function modeStats(lookup: Lookup, cost: number): ModeStats | null {
  let total = 0;
  let returned = 0;
  let squares = 0;
  let hits = 0;
  let max = 0;
  let maxWeight = 0;
  const tails = TAILS.map(() => 0);
  for (let i = 0; i < lookup.size; i++) {
    const weight = lookup.weights[i] ?? 0;
    const win = (lookup.payouts[i] ?? 0) / 100;
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
    TAILS.forEach((size, t) => {
      if (win >= size) tails[t] = (tails[t] ?? 0) + weight;
    });
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
    tails: Object.fromEntries(TAILS.map((size, t) => [size, (tails[t] ?? 0) / total])),
  };
}

/**
 * One book id per kind of round, so every run plays the same rounds: the first loss, the first small
 * win (up to 5× the cost), the first big win (20× the cost or more, below the max) and the first max win.
 * Books with no weight are skipped: the RGS never draws them.
 */
export function pickIds(lookup: Lookup, cost: number): Partial<Record<Exclude<Kind, 'feature'>, number>> {
  let max = 0;
  for (let i = 0; i < lookup.size; i++) {
    const payout = lookup.payouts[i] ?? 0;
    if ((lookup.weights[i] ?? 0) > 0 && payout > max) max = payout;
  }
  const picks: Partial<Record<Exclude<Kind, 'feature'>, number>> = {};
  for (let i = 0; i < lookup.size; i++) {
    const id = lookup.ids[i];
    const payout = lookup.payouts[i] ?? 0;
    if (!lookup.weights[i] || id === undefined) continue;
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
const bookId = (line: string): number | null => {
  const match = ID.exec(line);
  if (match) return Number(match[1]);
  try {
    const id: unknown = JSON.parse(line)?.id;
    return typeof id === 'number' ? id : null;
  } catch {
    return null;
  }
};

/**
 * Streams a books file and returns the books with these ids. With `feature`, it also returns a free spins
 * round (the shortest of the first few it meets), so the scenarios can show one without searching by hand.
 * Reading stops as soon as it has everything.
 */
export async function readBooks(
  file: string,
  ids: readonly (number | undefined)[],
  { feature = false }: { feature?: boolean } = {},
): Promise<{ books: Map<number, Book>; feature: Book | null }> {
  const wanted = new Set(ids.filter((id): id is number => id !== undefined));
  const found = new Map<number, Book>();
  let featureLine: string | null = null;
  let featureCount = 0;
  await eachLine(file, (line, count) => {
    const id = bookId(line);
    if (id !== null && wanted.has(id) && !found.has(id)) found.set(id, JSON.parse(line) as Book);
    if (feature && featureCount < 10 && FEATURE.test(line)) {
      featureCount += 1;
      if (!featureLine || line.length < featureLine.length) featureLine = line;
    }
    const haveFeature = !feature || featureCount >= 10 || (featureCount > 0 && count > 200_000) || count > 2_000_000;
    return found.size === wanted.size && haveFeature;
  });
  return { books: found, feature: featureLine ? (JSON.parse(featureLine) as Book) : null };
}

export interface BookCheck {
  books: number;
  invalid: string[];
  /** lines whose id or payoutMultiplier isn't a whole number */
  wrongTypes: string[];
  unknown: number[];
  duplicates: number[];
  mismatched: { id: number; book: number; table: number }[];
  missing: number;
}

const isWhole = (value: unknown): value is number => Number.isSafeInteger(value);

/** Checks every book against the lookup table: valid JSON, whole-number ids and payouts, the same ids, the same payouts. */
export async function verifyBooks(file: string, lookup: Lookup): Promise<BookCheck> {
  const expected = new Map<number, number>();
  for (let i = 0; i < lookup.size; i++) expected.set(lookup.ids[i] ?? -1, lookup.payouts[i] ?? 0);
  const seen = new Set<number>();
  const result: BookCheck = { books: 0, invalid: [], wrongTypes: [], unknown: [], duplicates: [], mismatched: [], missing: 0 };
  const wrongType = (count: number) => {
    if (result.wrongTypes.length < 5) result.wrongTypes.push(`line ${count}`);
  };
  await eachLine(file, (line, count) => {
    result.books += 1;
    let id: unknown;
    let payout: unknown;
    try {
      const book: unknown = JSON.parse(line);
      if (book && typeof book === 'object') ({ id, payoutMultiplier: payout } = book as { id?: unknown; payoutMultiplier?: unknown });
    } catch {
      if (result.invalid.length < 5) result.invalid.push(`line ${count}`);
      const head = HEAD.exec(line);
      if (!head) return false;
      id = Number(head[1]);
      payout = Number(head[2]);
    }
    if (!isWhole(id)) {
      wrongType(count);
      return false;
    }
    if (seen.has(id)) {
      if (result.duplicates.length < 5) result.duplicates.push(id);
      return false;
    }
    seen.add(id);
    const table = expected.get(id);
    if (table === undefined) {
      if (result.unknown.length < 5) result.unknown.push(id);
    } else if (!isWhole(payout)) {
      wrongType(count);
    } else if (table !== payout && result.mismatched.length < 5) {
      result.mismatched.push({ id, book: payout, table });
    }
    return false;
  });
  for (const id of expected.keys()) if (!seen.has(id)) result.missing += 1;
  return result;
}

/** Calls `onLine(line, count)` for each line of a .jsonl.zst file until it returns true. */
async function eachLine(file: string, onLine: (line: string, count: number) => boolean): Promise<number> {
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
      if (count % 1000 === 0) checkStopped();
      if (onLine(line, count)) break;
    }
  } catch (error) {
    throw new Error(`Can't read ${path.basename(file)}: ${errorMessage(error)}`);
  } finally {
    lines.close();
    input.destroy();
  }
  return count;
}
