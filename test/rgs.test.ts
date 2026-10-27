import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Findings } from '../src/findings.ts';
import { BET_LEVELS, DEFAULT_BET, MICRO, MockRgs, parseBody } from '../src/rgs.ts';
import type { Body, MockRgsOptions, Round } from '../src/rgs.ts';
import type { Book } from '../src/types.ts';

const book = (id: number, payout: number): Book => ({ id, payoutMultiplier: payout, events: [{ index: 0, type: 'reveal' }] });

function mock(options: Partial<MockRgsOptions> = {}) {
  const findings = new Findings();
  const rgs = new MockRgs({
    findings,
    sessionID: 's1',
    modes: {
      base: { name: 'base', cost: 1, base: true, books: { loss: book(1, 0), win: book(2, 250) } },
      bonus: { name: 'bonus', cost: 100, books: { feature: book(9, 12000) } },
    },
    plays: ['loss', 'win'],
    ...options,
  });
  const call = (path: string, body: Body = {}, method = 'POST') => rgs.handle(method, path, { sessionID: 's1', ...body });
  return { rgs, findings, call };
}

/** The round of a /wallet/play or /wallet/authenticate answer. */
const roundOf = (json: Record<string, unknown>) => json.round as Round;

test('authenticate sends the balance, bet levels and jurisdiction', () => {
  const { call } = mock({ jurisdiction: { disabledSpacebar: true } });
  const { status, json } = call('/wallet/authenticate');
  const config = json.config as { defaultBetLevel: number; betLevels: number[]; jurisdiction: { disabledSpacebar: boolean } };
  assert.equal(status, 200);
  assert.equal((json.balance as { amount: number }).amount, 1000 * MICRO);
  assert.equal(config.defaultBetLevel, DEFAULT_BET);
  assert.deepEqual(config.betLevels, BET_LEVELS);
  assert.equal(config.jurisdiction.disabledSpacebar, true);
  assert.equal(json.round, null);
});

test('a loss closes itself; a win stays open until end-round pays it', () => {
  const { rgs, call } = mock();
  const loss = roundOf(call('/wallet/play', { amount: DEFAULT_BET, mode: 'BASE' }).json);
  assert.equal(loss.active, false);
  const win = roundOf(call('/wallet/play', { amount: DEFAULT_BET, mode: 'BASE' }).json);
  assert.equal(win.active, true);
  assert.equal(win.payout, 2.5 * DEFAULT_BET);
  const before = rgs.balance;
  call('/wallet/end-round');
  assert.equal(rgs.balance, before + 2.5 * DEFAULT_BET);
  assert.ok(rgs.isEnded(win.betID));
});

test('a bet while a round is open is refused', () => {
  const { call, findings } = mock({ plays: ['win'] });
  call('/wallet/play', { amount: DEFAULT_BET, mode: 'base' });
  const second = call('/wallet/play', { amount: DEFAULT_BET, mode: 'base' });
  assert.equal(second.json.error, 'ERR_BE');
  assert.ok(findings.items.some((item) => item.check === 'rgs/overlap' && item.level === 'error'));
});

test('a bet that arrives while another waits for its answer is refused', () => {
  const { rgs, findings } = mock({ plays: ['loss'] });
  const first = rgs.arrive('/wallet/play');
  const second = rgs.arrive('/wallet/play');
  assert.equal(rgs.busy, true);
  const body = { sessionID: 's1', amount: DEFAULT_BET, mode: 'base' };
  assert.equal(rgs.handle('POST', '/wallet/play', body, first).status, 200);
  assert.equal(rgs.handle('POST', '/wallet/play', body, second).json.error, 'ERR_BE');
  assert.equal(rgs.busy, false);
  assert.equal(findings.items[0]?.check, 'rgs/overlap');
});

test('a bet outside the levels, or in an unknown mode, is refused', () => {
  const { call, findings } = mock();
  assert.equal(call('/wallet/play', { amount: MICRO, mode: 'base' }).json.error, 'ERR_VAL');
  assert.equal(call('/wallet/play', { amount: DEFAULT_BET, mode: 'turbo' }).json.error, 'ERR_VAL');
  assert.deepEqual(
    findings.items.map((item) => item.check),
    ['rgs/bet-level', 'rgs/mode'],
  );
});

test('a bought feature costs its multiple and draws a feature book', () => {
  const { rgs, call } = mock();
  const { json } = call('/wallet/play', { amount: 0.4 * MICRO, mode: 'BONUS' });
  assert.equal(roundOf(json).payoutMultiplier, 120);
  assert.equal(rgs.balance, 1000 * MICRO - 40 * MICRO);
});

test('not enough balance gets ERR_IPB', () => {
  const { call } = mock({ balance: 0 });
  assert.equal(call('/wallet/play', { amount: DEFAULT_BET, mode: 'base' }).json.error, 'ERR_IPB');
});

test('end-round with nothing open is flagged', () => {
  const { call, findings } = mock();
  call('/wallet/end-round');
  assert.equal(findings.items[0]?.check, 'rgs/end-round');
});

test('a resumed round comes back from authenticate without event', () => {
  const { call } = mock({ resume: { amount: 4 * MICRO, payout: 10 * MICRO, payoutMultiplier: 2.5, mode: 'BASE', state: [] } });
  const round = roundOf(call('/wallet/authenticate').json);
  assert.equal(round.active, true);
  assert.equal('event' in round, false);
  call('/bet/event', { event: '3' });
  assert.equal(roundOf(call('/wallet/authenticate').json).event, '3');
});

test('replays must ask for the round in the URL and nothing else', () => {
  const replay = { game: 'g', version: '1', mode: 'bonus', event: '9', payoutMultiplier: 120, costMultiplier: 100, state: [] };
  const { rgs, findings } = mock({ replay });
  const good = rgs.handle('GET', '/bet/replay/g/1/bonus/9', null);
  assert.equal(good.json.costMultiplier, 100);
  assert.equal(findings.items.length, 0);
  rgs.handle('GET', '/bet/replay/g/1/base/9', null);
  assert.equal(findings.items[0]?.check, 'replay/request');
});

test('faults answer once when asked to', () => {
  const { call } = mock({ faults: { play: { status: 500, error: 'ERR_UE', once: true } } });
  assert.equal(call('/wallet/play', { amount: DEFAULT_BET, mode: 'base' }).status, 500);
  assert.equal(call('/wallet/play', { amount: DEFAULT_BET, mode: 'base' }).status, 200);
});

test('a wrong session id is refused', () => {
  const { rgs, findings } = mock();
  assert.equal(rgs.handle('POST', '/wallet/authenticate', { sessionID: 'other' }).json.error, 'ERR_IS');
  assert.equal(findings.items[0]?.check, 'rgs/session');
});

test('a failure inside the mock becomes a finding and a 500, not a crash', () => {
  const broken = {
    id: 1,
    payoutMultiplier: 0,
    get events(): Book['events'] {
      throw new Error('boom');
    },
  };
  const findings = new Findings();
  const rgs = new MockRgs({ findings, sessionID: 's1', modes: { base: { name: 'base', cost: 1, base: true, books: { loss: broken } } } });
  const reply = rgs.handle('POST', '/wallet/play', { sessionID: 's1', amount: DEFAULT_BET, mode: 'base' });
  assert.equal(reply.status, 500);
  assert.equal(findings.items[0]?.check, 'preflight/rgs');
});

test('a body that is not a JSON object is refused with the right reason', () => {
  assert.deepEqual(parseBody('{"sessionID":"s1"}'), { sessionID: 's1' });
  assert.deepEqual(parseBody(null), {});
  const { rgs, findings } = mock();
  rgs.handle('POST', '/wallet/authenticate', parseBody('{ nope'));
  rgs.handle('POST', '/wallet/authenticate', parseBody(JSON.stringify(JSON.stringify({ sessionID: 's1' }))));
  assert.deepEqual(
    findings.items.map((item) => item.message),
    ["Sent /wallet/authenticate a body that isn't JSON", "Sent /wallet/authenticate a JSON body that isn't an object"],
  );
});

test('findings name the session they came from', () => {
  const { findings, call } = mock({ label: 'Mobile S' });
  call('/wallet/end-round');
  assert.deepEqual(findings.items[0]?.where, ['Mobile S']);
});
