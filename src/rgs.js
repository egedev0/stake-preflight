// A mock of Stake Engine's RGS, close to how the real one behaves:
// - amounts are integers with six decimals (1_000_000 = 1.00),
// - a round with no win comes back inactive and is closed by the RGS; a win stays active until the game
//   calls /wallet/end-round,
// - an unfinished round comes back from /wallet/authenticate without `event` until the game has saved one.
// Everything the game sends is checked as it arrives.

import { formatAmount, sleep } from './util.js';

export const MICRO = 1_000_000;

export const JURISDICTION = Object.freeze({
  socialCasino: false,
  disabledFullscreen: false,
  disabledTurbo: false,
  disabledSuperTurbo: false,
  disabledAutoplay: false,
  disabledSlamstop: false,
  disabledSpacebar: false,
  disabledBuyFeature: false,
  displayNetPosition: false,
  displayRTP: false,
  displaySessionTimer: false,
  minimumRoundDuration: 0,
});

// Unusual on purpose: a game that ignores the levels it's sent and uses its own (1, 2, 5, 10...) shows at once.
export const BET_LEVELS = [0.1, 0.2, 0.4, 0.6, 0.8, 1.2, 1.6, 2, 3, 4, 6, 8, 12, 20, 40, 80, 120].map((value) =>
  Math.round(value * MICRO),
);
export const DEFAULT_BET = 1.2 * MICRO;

/** The calls that move a round along. Polling /wallet/balance doesn't. */
const ROUND_CALLS = new Set(['/wallet/play', '/wallet/end-round', '/bet/event']);

export class MockRgs {
  /**
   * @param {object} options
   * @param {import('./findings.js').Findings} options.findings
   * @param {string} options.sessionID
   * @param {string} [options.label] the session, named in findings
   * @param {Record<string, {name: string, cost: number, base?: boolean, books: Record<string, object>}>} [options.modes]
   *   modes by lowercase name, each with books by kind (loss, win, big, max, feature)
   * @param {string[]} [options.plays] the kinds of book the base game's plays get, in order (the last repeats)
   * @param {object} [options.resume] a round to hand back from /wallet/authenticate
   * @param {object} [options.replay] what /bet/replay should be asked for and answer with
   * @param {Record<string, {status: number, error: string, once?: boolean}>} [options.faults] errors to answer with, by endpoint
   */
  constructor({
    findings,
    sessionID,
    label,
    currency = 'USD',
    balance = 1000,
    jurisdiction = {},
    modes = {},
    plays = ['loss'],
    resume = null,
    replay = null,
    faults = {},
  }) {
    this.findings = findings;
    this.sessionID = sessionID;
    this.label = label;
    this.currency = currency;
    this.balance = Math.round(balance * MICRO);
    this.jurisdiction = { ...JURISDICTION, ...jurisdiction };
    this.modes = modes;
    this.plays = plays;
    this.replay = replay;
    this.faults = { ...faults };
    /** ms an answer waits before it's sent, to play a slow RGS */
    this.delay = 0;
    this.calls = [];
    this.rounds = [];
    this.ended = new Set();
    this.active = null;
    this.betID = 1000;
    this.basePlays = 0;
    /** requests that arrived and haven't been answered yet, by path */
    this.waiting = new Map();
    this.started = Date.now();
    this.lastRoundCallAt = 0;
    if (resume) this.active = { ...resume, betID: ++this.betID, active: true };
  }

  count(endpoint) {
    return this.calls.filter((call) => call.path === endpoint).length;
  }

  get playCalls() {
    return this.calls.filter((call) => call.path === '/wallet/play');
  }

  /** Whether a request is still waiting for its answer. */
  get busy() {
    return [...this.waiting.values()].some((count) => count > 0);
  }

  isEnded(betID) {
    return this.ended.has(betID);
  }

  /**
   * A request came in; its answer may still be delayed. Returns what handle() needs to know about its
   * arrival: a bet that comes in while another bet is still waiting for its answer overlaps it.
   */
  arrive(path) {
    const overlapping = path === '/wallet/play' && (this.waiting.get(path) ?? 0) > 0;
    this.waiting.set(path, (this.waiting.get(path) ?? 0) + 1);
    if (ROUND_CALLS.has(path)) this.lastRoundCallAt = Date.now();
    return { overlapping };
  }

  /** Answers a request. Never throws: a broken answer becomes a finding and a 500. */
  handle(method, path, body, arrival = {}) {
    const call = { at: Date.now() - this.started, method, path, body };
    this.calls.push(call);
    let reply;
    try {
      reply = this.#answer(method, path, body ?? {}, call, arrival);
    } catch (error) {
      this.#flag('error', 'preflight/rgs', `The mock RGS failed on ${method} ${path}: ${error.message}`);
      reply = fail(500, 'ERR_UE', 'mock RGS failure');
    }
    call.status = reply.status;
    if (reply.json?.error) call.error = reply.json.error;
    if (this.waiting.get(path)) this.waiting.set(path, this.waiting.get(path) - 1);
    if (ROUND_CALLS.has(path)) this.lastRoundCallAt = Date.now();
    return reply;
  }

  #flag(level, check, message, extra = {}) {
    this.findings.add(level, check, message, { ...extra, where: this.label });
  }

  #answer(method, path, body, call, arrival) {
    if (body.__invalid !== undefined) {
      this.#flag('error', 'rgs/body', `Sent ${path} a body that isn't JSON`, { detail: body.__invalid });
      return fail(400, 'ERR_VAL', 'invalid body');
    }
    const fault = this.#fault(path);
    if (fault) return fault;

    if (method === 'POST' && path === '/wallet/authenticate') return this.#authenticate(body);
    if (method === 'POST' && path === '/wallet/balance') return this.#session(body, path) ?? this.#balanceReply();
    if (method === 'POST' && path === '/wallet/play') return this.#play(body, call, arrival);
    if (method === 'POST' && path === '/wallet/end-round') return this.#endRound(body, call);
    if (method === 'POST' && path === '/bet/event') return this.#event(body);
    if (method === 'GET' && path.startsWith('/bet/replay/')) return this.#replay(path);

    this.#flag('warn', 'rgs/endpoint', `Called ${method} ${path}, which the RGS doesn't have`);
    return fail(404, 'ERR_UE', 'not found');
  }

  #fault(path) {
    const name = path.startsWith('/bet/replay/') ? 'replay' : path.split('/').pop();
    const fault = this.faults[name];
    if (!fault) return null;
    if (fault.once) delete this.faults[name];
    return fail(fault.status ?? 400, fault.error, fault.message ?? fault.error);
  }

  #session(body, path) {
    if (body.sessionID === this.sessionID) return null;
    this.#flag('error', 'rgs/session', `${path} sent sessionID "${body.sessionID}" instead of the one in the URL`);
    return fail(400, 'ERR_IS', 'invalid session');
  }

  #balanceReply() {
    return ok({ balance: { amount: this.balance, currency: this.currency } });
  }

  #authenticate(body) {
    const wrong = this.#session(body, '/wallet/authenticate');
    if (wrong) return wrong;
    return ok({
      balance: { amount: this.balance, currency: this.currency },
      config: {
        minBet: BET_LEVELS[0],
        maxBet: BET_LEVELS.at(-1),
        stepBet: BET_LEVELS[0],
        defaultBetLevel: DEFAULT_BET,
        betLevels: BET_LEVELS,
        jurisdiction: this.jurisdiction,
      },
      round: this.active ? { ...this.active } : null,
    });
  }

  #play(body, call, arrival) {
    const wrong = this.#session(body, '/wallet/play');
    if (wrong) return wrong;
    if (this.active || arrival.overlapping) {
      this.#flag('error', 'rgs/overlap', 'Placed a new bet while the last round was still open', {
        detail: this.active
          ? 'The last win had no /wallet/end-round yet. The real RGS answers ERR_BE: "player already has an active bet".'
          : 'The last /wallet/play had no answer yet. The real RGS answers ERR_BE: "player already has an active bet".',
      });
      return fail(400, 'ERR_BE', 'player already has an active bet');
    }
    if (!Object.keys(this.modes).length) return fail(400, 'ERR_VAL', 'no books loaded (run with --math)');
    const mode = this.modes[String(body.mode).toLowerCase()];
    if (!mode) {
      this.#flag('error', 'rgs/mode', `Bet with mode "${body.mode}", which isn't in the math's index.json`);
      return fail(400, 'ERR_VAL', 'invalid mode');
    }
    if (!BET_LEVELS.includes(body.amount)) {
      const amount = Number.isFinite(body.amount) ? formatAmount(body.amount) : JSON.stringify(body.amount);
      this.#flag('error', 'rgs/bet-level', `Bet ${amount}, which isn't one of the bet levels /wallet/authenticate sent`, {
        detail: `levels: ${BET_LEVELS.map(formatAmount).join(', ')}`,
      });
      return fail(400, 'ERR_VAL', 'invalid bet amount');
    }
    if (body.currency !== undefined && body.currency !== this.currency) {
      this.#flag('warn', 'rgs/currency', `Bet in "${body.currency}" while the session's currency is ${this.currency}`);
    }
    const charge = Math.round(body.amount * mode.cost);
    if (charge > this.balance) return fail(400, 'ERR_IPB', 'insufficient player balance');

    const kind = mode.base ? (this.plays[this.basePlays++] ?? this.plays.at(-1)) : 'feature';
    const book = mode.books[kind] ?? mode.books.feature ?? mode.books.loss ?? Object.values(mode.books)[0];
    if (!book) return fail(500, 'ERR_UE', `no book to play for mode ${mode.name}`);
    const multiplier = book.payoutMultiplier / 100;
    const round = {
      betID: ++this.betID,
      amount: body.amount,
      payout: Math.round(body.amount * multiplier),
      payoutMultiplier: multiplier,
      active: multiplier > 0,
      mode: body.mode,
      state: book.events,
    };
    this.balance -= charge;
    if (round.active) this.active = round;
    this.rounds.push({ betID: round.betID, kind, bookId: book.id, at: call.at });
    call.round = { betID: round.betID, kind, bookId: book.id, payoutMultiplier: multiplier, active: round.active };
    return ok({ balance: { amount: this.balance, currency: this.currency }, round });
  }

  #endRound(body, call) {
    const wrong = this.#session(body, '/wallet/end-round');
    if (wrong) return wrong;
    if (!this.active) {
      this.#flag('warn', 'rgs/end-round', 'Called /wallet/end-round with no open round', {
        detail: 'A round with no win is closed by the RGS itself; only a win needs /wallet/end-round.',
      });
      return this.#balanceReply();
    }
    this.balance += this.active.payout;
    this.ended.add(this.active.betID);
    call.betID = this.active.betID;
    this.active = null;
    return this.#balanceReply();
  }

  #event(body) {
    const wrong = this.#session(body, '/bet/event');
    if (wrong) return wrong;
    if (typeof body.event !== 'string') {
      this.#flag('warn', 'rgs/event', `Saved event ${JSON.stringify(body.event)} as a ${typeof body.event}; the RGS expects a string`);
    }
    if (this.active) this.active.event = String(body.event);
    return ok({ event: body.event });
  }

  #replay(path) {
    let asked;
    try {
      const [game, version, mode, event] = path.slice('/bet/replay/'.length).split('/').map(decodeURIComponent);
      asked = { game, version, mode, event };
    } catch {
      this.#flag('error', 'replay/request', `Asked for a replay with a malformed path: ${path}`);
      return fail(400, 'ERR_VAL', 'invalid path');
    }
    if (!this.replay) {
      this.#flag('warn', 'rgs/replay', 'Asked for a replay outside replay mode');
      return fail(404, 'ERR_BNF', 'bet not found');
    }
    for (const [key, value] of Object.entries(asked)) {
      const expected = String(this.replay[key]);
      const same = key === 'mode' ? String(value).toLowerCase() === expected.toLowerCase() : String(value) === expected;
      if (!same) {
        this.#flag('error', 'replay/request', `Asked /bet/replay for ${key} "${value}"; the URL said "${expected}"`, { detail: path });
      }
    }
    return ok({
      payoutMultiplier: this.replay.payoutMultiplier,
      costMultiplier: this.replay.costMultiplier,
      state: this.replay.state,
    });
  }
}

const ok = (json) => ({ status: 200, json });
const fail = (status, error, message) => ({ status, json: { error, message } });

/**
 * Answers every request to `https://<host>/` in this browser context from the mock. Playwright answers
 * the CORS preflight of a routed request itself; only the requests themselves get here.
 */
export async function routeRgs(context, host, rgs) {
  await context.route(`https://${host}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const arrival = rgs.arrive(path);
    let body = {};
    const raw = request.postData();
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = { __invalid: raw.slice(0, 200) };
      }
    }
    if (rgs.delay) await sleep(rgs.delay);
    const reply = rgs.handle(request.method(), path, body, arrival);
    await route
      .fulfill({
        status: reply.status,
        headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
        body: JSON.stringify(reply.json),
      })
      .catch(() => {});
  });
}
