import fs from 'node:fs';
import path from 'node:path';
import { modeStats, pickIds, readBooks, readIndex, readLookup, verifyBooks } from './books.js';
import { formatMultiplier, formatPercent, mapLimit } from './util.js';

const isFile = (file) => Boolean(file) && fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true;

/**
 * Checks a math-sdk publish folder and loads, for each mode, the books the scenarios play.
 * @returns {Promise<{ stats: object[], modes: Record<string, object>, base: object | null }>}
 */
export async function loadMath(dir, findings, { deep = false, limits = {} } = {}) {
  const index = await readIndex(dir);
  const seen = new Set();
  const valid = index.filter((mode) => {
    if (!mode.name) {
      findings.error('math/index', 'A mode in index.json has no name');
      return false;
    }
    const key = mode.name.toLowerCase();
    if (seen.has(key)) findings.error('math/index', `Mode "${mode.name}" is listed twice in index.json`);
    seen.add(key);
    if (!(mode.cost > 0)) {
      findings.error('math/index', `Mode "${mode.name}" has cost ${mode.cost} in index.json`);
      return false;
    }
    const missing = [mode.events, mode.weights].filter((file) => !isFile(file));
    if (missing.length) {
      findings.error('math/files', `Mode "${mode.name}": ${missing.map((file) => (file ? path.basename(file) : 'a file name')).join(' and ')} missing`);
      return false;
    }
    return true;
  });

  const loaded = await mapLimit(valid, 3, async (mode) => {
    try {
      return await loadMode(mode, findings, { deep, limits });
    } catch (error) {
      findings.error('math/books', `Mode "${mode.name}": ${error.message}`);
      return null;
    }
  });
  const modes = {};
  const stats = [];
  for (const mode of loaded.filter(Boolean)) {
    stats.push(mode.stats);
    if (Object.keys(mode.books).length) modes[mode.name.toLowerCase()] = { name: mode.name, cost: mode.cost, books: mode.books };
    else findings.error('math/books', `Mode "${mode.name}": none of its books could be read, so it isn't played`);
  }

  const all = Object.values(modes);
  const base = modes.base ?? all.find((mode) => mode.cost === 1) ?? all[0] ?? null;
  if (base) {
    base.base = true;
    if (!modes.base) findings.warn('math/base', `No mode named "base"; "${base.name}" is played as the base game`);
  }
  return { stats, modes, base };
}

async function loadMode(mode, findings, { deep, limits }) {
  const table = path.basename(mode.weights);
  const lookup = await readLookup(mode.weights);
  if (lookup.problems.length) {
    findings.error('math/lookup', `${table} has rows that aren't three integers (id, weight, payout)`, { detail: lookup.problems.join('\n') });
  }
  const ids = new Set(lookup.ids);
  if (ids.size !== lookup.size) findings.error('math/lookup', `${table} lists ${lookup.size - ids.size} book ids more than once`);

  const stats = modeStats(lookup, mode.cost);
  if (!stats) {
    findings.error('math/lookup', `${table}: the weights add up to zero`);
    return null;
  }
  checkLimits(mode, stats, limits, findings);

  const picks = pickIds(lookup, mode.cost);
  const { books: found, feature } = await readBooks(mode.events, Object.values(picks), { feature: true });
  const books = {};
  for (const [kind, id] of Object.entries(picks)) {
    const book = found.get(id);
    if (book) books[kind] = book;
    else findings.error('math/books', `Book ${id} is in ${table} but not in ${path.basename(mode.events)}`);
  }
  if (feature) {
    books.feature = feature;
    // the same round twice in a row says nothing new
    if (books.big?.id === feature.id) delete books.big;
  }

  if (deep) {
    const check = await verifyBooks(mode.events, lookup);
    const file = path.basename(mode.events);
    if (check.invalid.length) findings.error('math/books', `${file}: lines that aren't valid JSON (${check.invalid.join(', ')})`);
    if (check.duplicates.length) findings.error('math/books', `${file}: book ids used twice (${check.duplicates.join(', ')})`);
    if (check.unknown.length) findings.error('math/books', `${file}: books missing from ${table} (ids ${check.unknown.join(', ')})`);
    if (check.missing) findings.error('math/books', `${file}: ${check.missing} books of ${table} aren't in it`);
    for (const { id, book, table: expected } of check.mismatched) {
      findings.error('math/books', `${file}: book ${id} pays ${book} but ${table} says ${expected}`);
    }
    stats.verified = check.books;
  }
  return { name: mode.name, cost: mode.cost, books, stats: { name: mode.name, cost: mode.cost, ...stats } };
}

/** Limits are optional and set in the config, e.g. { "rtp": [0.96, 0.97], "maxWin": 25000, "volatility": 50 }. */
function checkLimits(mode, stats, limits, findings) {
  if (stats.rtp > 1) {
    findings.error('math/rtp', `Mode "${mode.name}" returns ${formatPercent(stats.rtp)}, more than it costs`);
  }
  if (Array.isArray(limits.rtp)) {
    const [low, high] = limits.rtp;
    if (stats.rtp < low || stats.rtp > high) {
      findings.warn('math/rtp', `Mode "${mode.name}": RTP ${formatPercent(stats.rtp)} is outside ${formatPercent(low)} to ${formatPercent(high)}`);
    }
  }
  if (limits.maxWin && stats.maxWin > limits.maxWin) {
    findings.warn('math/max-win', `Mode "${mode.name}": max win ${formatMultiplier(stats.maxWin)} is over ${formatMultiplier(limits.maxWin)}`);
  }
  if (limits.volatility && stats.volatility > limits.volatility) {
    findings.warn('math/volatility', `Mode "${mode.name}": volatility ${stats.volatility.toFixed(1)} is over ${limits.volatility}`);
  }
}
