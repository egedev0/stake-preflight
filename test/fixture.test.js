// Runs stake-preflight against the fixture game: once as it is (nothing to report), then with bugs
// switched on, each of which must be caught. Needs Chrome or Playwright's Chromium.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/browser.js';
import { DEFAULTS } from '../src/config.js';
import { preflight } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const math = path.join(here, 'fixtures', 'math');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-fixture-'));
after(() => fs.rmSync(work, { recursive: true, force: true }));

const config = { ...structuredClone(DEFAULTS), langs: ['de'], currencies: ['JPY'], timeouts: { load: 15, round: 10, replay: 10 } };

let browserMissing = null;
try {
  await (await launchBrowser()).close();
} catch (error) {
  browserMissing = error.message.split('\n')[0];
}

/** A copy of the fixture game with these bugs switched on. */
function game(bugs) {
  const dir = fs.mkdtempSync(path.join(work, 'game-'));
  fs.cpSync(path.join(here, 'fixtures', 'game'), dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bugs.json'), JSON.stringify(bugs));
  return dir;
}

const run = (bugs, only) =>
  preflight({ build: game(bugs), math, out: fs.mkdtempSync(path.join(work, 'report-')), config, only, quick: true, jobs: 3 });

const checks = (report) =>
  new Set(report.sections.flatMap((section) => section.findings.filter((item) => item.level !== 'info').map((item) => item.check)));

describe('the fixture game', { skip: browserMissing ? `no browser (${browserMissing})` : false, timeout: 600_000 }, () => {
  test('passes as it is', async () => {
    const report = await run({}, ['load', 'play', 'resume', 'replay', 'social', 'flags', 'balance', 'errors']);
    const problems = report.sections.flatMap((section) => section.findings.filter((item) => item.level !== 'info').map((item) => `${section.name}: ${item.message}`));
    assert.deepEqual(problems, []);
  });

  test('catches wording, formatting, network and flag mistakes', async () => {
    const report = await run(
      { trailingZero: true, socialWords: true, externalRequest: true, rootPath: true, ignoreSpacebarFlag: true, numericEvent: true },
      ['load', 'play', 'resume', 'social', 'flags'],
    );
    const found = checks(report);
    for (const check of ['amount/format', 'social/words', 'net/external', 'net/outside', 'flags/spacebar', 'rgs/event']) {
      assert.ok(found.has(check), `expected ${check}, got ${[...found].join(', ')}`);
    }
  });

  test('catches a round that is never ended', async () => {
    assert.ok(checks(await run({ noEndRound: true }, ['play'])).has('round/end-round'));
  });

  test('catches a bet that ignores the levels from the RGS', async () => {
    assert.ok(checks(await run({ hardcodedBet: true }, ['play'])).has('rgs/bet-level'));
  });

  test('catches overlapping bets, a crashing replay and a short round', async () => {
    const found = checks(await run({ doubleBet: true, throwOnReplay: true, ignoreMinimumDuration: true }, ['input', 'replay', 'flags']));
    for (const check of ['rgs/overlap', 'page/error', 'flags/min-duration']) assert.ok(found.has(check), `expected ${check}`);
  });

  test('catches a game that ignores rgs_url', async () => {
    const found = checks(await run({ ignoreRgsUrl: true }, ['errors']));
    assert.ok(found.has('rgs/url'));
    assert.ok(found.has('net/external'));
  });
});
