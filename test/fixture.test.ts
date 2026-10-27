// Runs stake-preflight against the fixture game: once as it is (nothing to report), then with bugs
// switched on, each of which must be caught. Needs Chrome or Playwright's Chromium.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/browser.ts';
import { DEFAULTS } from '../src/config.ts';
import { preflight } from '../src/index.ts';
import type { Config, Report } from '../src/types.ts';
import { errorMessage } from '../src/util.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const math = path.join(here, 'fixtures', 'math');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-fixture-'));
after(() => fs.rmSync(work, { recursive: true, force: true }));

const config: Config = { ...structuredClone(DEFAULTS), langs: ['de'], currencies: ['JPY'], timeouts: { load: 15, round: 10, replay: 10 } };

let browserMissing: string | null = null;
try {
  await (await launchBrowser()).close();
} catch (error) {
  browserMissing = errorMessage(error).split('\n')[0] ?? 'unknown';
}

/** The fixture game's mistakes, switched on through its bugs.json. */
type Bugs = Partial<
  Record<
    | 'trailingZero'
    | 'winZero'
    | 'socialWords'
    | 'externalRequest'
    | 'rootPath'
    | 'consoleError'
    | 'ignoreSpacebarFlag'
    | 'ignoreMinimumDuration'
    | 'noEndRound'
    | 'hardcodedBet'
    | 'doubleBet'
    | 'throwOnReplay'
    | 'ignoreRgsUrl'
    | 'numericEvent',
    boolean
  >
>;

/** A copy of the fixture game with these bugs switched on. */
function game(bugs: Bugs): string {
  const dir = fs.mkdtempSync(path.join(work, 'game-'));
  fs.cpSync(path.join(here, 'fixtures', 'game'), dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bugs.json'), JSON.stringify(bugs));
  return dir;
}

const run = (bugs: Bugs, only: string[]) =>
  preflight({ build: game(bugs), math, out: fs.mkdtempSync(path.join(work, 'report-')), config, only, quick: true, jobs: 3 });

const checks = (report: Report) =>
  new Set(report.sections.flatMap((section) => section.findings.filter((item) => item.level !== 'info').map((item) => item.check)));

describe('the fixture game', { skip: browserMissing ? `no browser (${browserMissing})` : false, timeout: 600_000 }, () => {
  test('passes as it is', async () => {
    const report = await run({}, ['load', 'play', 'resume', 'replay', 'social', 'flags', 'balance', 'errors']);
    const problems = report.sections.flatMap((section) =>
      section.findings.filter((item) => item.level !== 'info').map((item) => `${section.name}: ${item.message}`),
    );
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

  test('a stopped run ends at once, skips what is left and still writes its report', async () => {
    // a round that never ends would hold the play check for the whole two-minute round timeout
    const stop = new AbortController();
    let stoppedAt = 0;
    setTimeout(() => {
      stoppedAt = Date.now();
      stop.abort();
    }, 10_000);
    const report = await preflight({
      build: game({ noEndRound: true }),
      math,
      out: fs.mkdtempSync(path.join(work, 'report-')),
      config: { ...config, timeouts: { ...config.timeouts, round: 120 } },
      only: ['load', 'play', 'replay'],
      quick: true,
      jobs: 1,
      signal: stop.signal,
    });
    assert.ok(Date.now() - stoppedAt < 5000, `took ${Date.now() - stoppedAt} ms to stop`);
    assert.equal(report.stopped, true);
    assert.deepEqual(
      report.sections.map((section) => [section.name, section.status]),
      [
        ['build', 'ok'],
        ['math', 'ok'],
        ['load', 'ok'],
        ['play', 'skipped'],
        ['replay', 'skipped'],
      ],
    );
    assert.equal(report.summary.errors, 0);
    assert.ok(fs.existsSync(path.join(report.out, 'index.html')));
  });
});
