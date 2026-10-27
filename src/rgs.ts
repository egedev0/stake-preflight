// A mock of Stake Engine's RGS, close to how the real one behaves:
// - amounts are integers with six decimals (1_000_000 = 1.00),
// - a round with no win comes back inactive and is closed by the RGS; a win stays active until the game
//   calls /wallet/end-round,
// - an unfinished round comes back from /wallet/authenticate without `event` until the game has saved one.
// Everything the game sends is checked as it arrives.

import type { BrowserContext } from 'playwright-core';
import type { FindingExtra, Findings } from './findings.ts';
import type { Book, BookEvent, Level, PlayMode, RoundSummary } from './types.ts';
import { errorMessage, formatAmount, sleep } from './util.ts';

export const MICRO = 1_000_000;

/** The jurisdiction config /wallet/authenticate sends: what the game must turn off or show. */
export interface Jurisdiction {
  socialCasino: boolean;
  disabledFullscreen: boolean;
  disabledTurbo: boolean;
  disabledSuperTurbo: boolean;
  disabledAutoplay: boolean;
  disabledSlamstop: boolean;
  disabledSpacebar: boolean;
  disabledBuyFeature: boolean;
  displayNetPosition: boolean;
  displayRTP: boolean;
  displaySessionTimer: boolean;
  minimumRoundDuration: number;
}

export const JURISDICTION: Readonly<Jurisdiction> = Object.freeze({
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

/** A round as /wallet/play and /wallet/authenticate send it. */
export interface Round {
  betID: number;
  amount: number;
  payout: number;
  payoutMultiplier: number;
  active: boolean;
  mode: string;
  state: BookEvent[];
  event?: string;
}

/** What /bet/replay should be asked for, and what it answers with. */
export interface ReplayRound {
  game: string;
  version: string;
  mode: string;
  event: string;
  payoutMultiplier: number;
  costMultiplier: number;
  state: BookEvent[];
}

export interface Fault {
  status?: number;
  error: string;
  message?: string;
  /** answer with it once, then normally */
  once?: boolean;
}

/** What the game sent. Bodies are JSON, so anything can be in them. */
export type Body = Record<string, unknown>;

export interface Call {
  at: number;
  method: string;
  path: string;
  body: Body;
  status?: number;
  error?: string;
  round?: RoundSummary;
  betID?: number;
}

export interface Reply {
  status: number;
  json: Record<string, unknown>;
}

/** What handle() needs to know about how a request arrived. */
export interface Arrival {
  /** a bet that came in while another bet was still waiting for its answer */
  overlapping?: boolean;
}

export interface MockRgsOptions {
  findings: Findings;
  sessionID: string;
  /** the session, named in findings */
  label?: string;
  currency?: string;
  /** in currency units */
  balance?: number;
  jurisdiction?: Partial<Jurisdiction>;
  /** modes by lowercase name, each with books by kind */
  modes?: Record<string, PlayMode>;
  /** the kinds of book the base game's plays get, in order (the last repeats) */
  plays?: string[];
  /** a round to hand back from /wallet/authenticate */
  resume?: Omit<Round, 'betID' | 'active'> | null;
  replay?: ReplayRound | null;
  /** errors to answer with, by endpoint name (authenticate, play, end-round, event, replay) */
  faults?: Record<string, Fault>;
}

export class MockRgs {
  readonly findings: Findings;
  readonly sessionID: string;
  readonly label: string | undefined;
  readonly currency: string;
  balance: number;
  readonly jurisdiction: Jurisdiction;
  readonly modes: Record<string, PlayMode>;
  readonly plays: string[];
  readonly replay: ReplayRound | null;
  readonly faults: Record<string, Fault>;
  /** ms an answer waits before it's sent, to play a slow RGS */
  delay = 0;
  readonly calls: Call[] = [];
  readonly rounds: { betID: number; kind: string; bookId: number; at: number }[] = [];
  readonly ended = new Set<number>();
  active: Round | null = null;
  /** requests that arrived and haven't been answered yet, by path */
  readonly waiting = new Map<string, number>();
  lastRoundCallAt = 0;
  private betID = 1000;
  private basePlays = 0;
  private readonly started = Date.now();

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
  }: MockRgsOptions) {
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
    if (resume) this.active = { ...resume, betID: ++this.betID, active: true };
  }

  count(endpoint: string): number {
    return this.calls.filter((call) => call.path === endpoint).length;
  }

  get playCalls(): Call[] {
    return this.calls.filter((call) => call.path === '/wallet/play');
  }

  /** Whether a request is still waiting for its answer. */
  get busy(): boolean {
    return [...this.waiting.values()].some((count) => count > 0);
  }

  isEnded(betID: number): boolean {
    return this.ended.has(betID);
  }

  /**
   * A request came in; its answer may still be delayed. Returns what handle() needs to know about its
   * arrival: a bet that comes in while another bet is still waiting for its answer overlaps it.
   */
  arrive(path: string): Arrival {
    const overlapping = path === '/wallet/play' && (this.waiting.get(path) ?? 0) > 0;
    this.waiting.set(path, (this.waiting.get(path) ?? 0) + 1);
    if (ROUND_CALLS.has(path)) this.lastRoundCallAt = Date.now();
    return { overlapping };
  }

  /** Answers a request. Never throws: a broken answer becomes a finding and a 500. */
  handle(method: string, path: string, body: Body | null, arrival: Arrival = {}): Reply {
    const call: Call = { at: Date.now() - this.started, method, path, body: body ?? {} };
    this.calls.push(call);
    let reply: Reply;
    try {
      reply = this.answer(method, path, call.body, call, arrival);
    } catch (error) {
      this.flag('error', 'preflight/rgs', `The mock RGS failed on ${method} ${path}: ${errorMessage(error)}`);
      reply = fail(500, 'ERR_UE', 'mock RGS failure');
    }
    call.status = reply.status;
    if (typeof reply.json.error === 'string') call.error = reply.json.error;
    const waiting = this.waiting.get(path);
    if (waiting) this.waiting.set(path, waiting - 1);
    if (ROUND_CALLS.has(path)) this.lastRoundCallAt = Date.now();
    return reply;
  }

  private flag(level: Level, check: string, message: string, extra: FindingExtra = {}) {
    this.findings.add(level, check, message, { ...extra, ...(this.label ? { where: this.label } : {}) });
  }

  private answer(method: string, path: string, body: Body, call: Call, arrival: Arrival): Reply {
    if (body.__invalid !== undefined) {
      const what = body.__json ? "a JSON body that isn't an object" : "a body that isn't JSON";
      this.flag('error', 'rgs/body', `Sent ${path} ${what}`, { detail: String(body.__invalid) });
      return fail(400, 'ERR_VAL', 'invalid body');
    }
    const fault = this.fault(path);
    if (fault) return fault;

    if (method === 'POST' && path === '/wallet/authenticate') return this.authenticate(body);
    if (method === 'POST' && path === '/wallet/balance') return this.session(body, path) ?? this.balanceReply();
    if (method === 'POST' && path === '/wallet/play') return this.play(body, call, arrival);
    if (method === 'POST' && path === '/wallet/end-round') return this.endRound(body, call);
    if (method === 'POST' && path === '/bet/event') return this.event(body);
    if (method === 'GET' && path.startsWith('/bet/replay/')) return this.replayRound(path);

    this.flag('warn', 'rgs/endpoint', `Called ${method} ${path}, which the RGS doesn't have`);
    return fail(404, 'ERR_UE', 'not found');
  }

  private fault(path: string): Reply | null {
    const name = path.startsWith('/bet/replay/') ? 'replay' : (path.split('/').pop() ?? '');
    const fault = this.faults[name];
    if (!fault) return null;
    if (fault.once) delete this.faults[name];
    return fail(fault.status ?? 400, fault.error, fault.message ?? fault.error);
  }

  private session(body: Body, path: string): Reply | null {
    if (body.sessionID === this.sessionID) return null;
    this.flag('error', 'rgs/session', `${path} sent sessionID "${String(body.sessionID)}" instead of the one in the URL`);
    return fail(400, 'ERR_IS', 'invalid session');
  }

  private balanceReply(): Reply {
    return ok({ balance: { amount: this.balance, currency: this.currency } });
  }

  private authenticate(body: Body): Reply {
    const wrong = this.session(body, '/wallet/authenticate');
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

  private play(body: Body, call: Call, arrival: Arrival): Reply {
    const wrong = this.session(body, '/wallet/play');
    if (wrong) return wrong;
    if (this.active || arrival.overlapping) {
      this.flag('error', 'rgs/overlap', 'Placed a new bet while the last round was still open', {
        detail: this.active
          ? 'The last win had no /wallet/end-round yet. The real RGS answers ERR_BE: "player already has an active bet".'
          : 'The last /wallet/play had no answer yet. The real RGS answers ERR_BE: "player already has an active bet".',
      });
      return fail(400, 'ERR_BE', 'player already has an active bet');
    }
    if (!Object.keys(this.modes).length) return fail(400, 'ERR_VAL', 'no books loaded (run with --math)');
    const mode = this.modes[String(body.mode).toLowerCase()];
    if (!mode) {
      this.flag('error', 'rgs/mode', `Bet with mode "${String(body.mode)}", which isn't in the math's index.json`);
      return fail(400, 'ERR_VAL', 'invalid mode');
    }
    const amount = body.amount;
    if (typeof amount !== 'number' || !BET_LEVELS.includes(amount)) {
      const shown = typeof amount === 'number' && Number.isFinite(amount) ? formatAmount(amount) : JSON.stringify(amount);
      this.flag('error', 'rgs/bet-level', `Bet ${shown}, which isn't one of the bet levels /wallet/authenticate sent`, {
        detail: `levels: ${BET_LEVELS.map(formatAmount).join(', ')}`,
      });
      return fail(400, 'ERR_VAL', 'invalid bet amount');
    }
    if (body.currency !== undefined && body.currency !== this.currency) {
      this.flag('warn', 'rgs/currency', `Bet in "${String(body.currency)}" while the session's currency is ${this.currency}`);
    }
    const charge = Math.round(amount * mode.cost);
    if (charge > this.balance) return fail(400, 'ERR_IPB', 'insufficient player balance');

    const kind = mode.base ? (this.plays[this.basePlays++] ?? this.plays.at(-1) ?? 'loss') : 'feature';
    const book = (mode.books as Record<string, Book | undefined>)[kind] ?? mode.books.feature ?? mode.books.loss ?? Object.values(mode.books)[0];
    if (!book) return fail(500, 'ERR_UE', `no book to play for mode ${mode.name}`);
    const multiplier = book.payoutMultiplier / 100;
    const round: Round = {
      betID: ++this.betID,
      amount,
      payout: Math.round(amount * multiplier),
      payoutMultiplier: multiplier,
      active: multiplier > 0,
      mode: String(body.mode),
      state: book.events,
    };
    this.balance -= charge;
    if (round.active) this.active = round;
    this.rounds.push({ betID: round.betID, kind, bookId: book.id, at: call.at });
    call.round = { betID: round.betID, kind, bookId: book.id, payoutMultiplier: multiplier, active: round.active };
    return ok({ balance: { amount: this.balance, currency: this.currency }, round });
  }

  private endRound(body: Body, call: Call): Reply {
    const wrong = this.session(body, '/wallet/end-round');
    if (wrong) return wrong;
    if (!this.active) {
      this.flag('warn', 'rgs/end-round', 'Called /wallet/end-round with no open round', {
        detail: 'A round with no win is closed by the RGS itself; only a win needs /wallet/end-round.',
      });
      return this.balanceReply();
    }
    this.balance += this.active.payout;
    this.ended.add(this.active.betID);
    call.betID = this.active.betID;
    this.active = null;
    return this.balanceReply();
  }

  private event(body: Body): Reply {
    const wrong = this.session(body, '/bet/event');
    if (wrong) return wrong;
    if (typeof body.event !== 'string') {
      this.flag('warn', 'rgs/event', `Saved event ${JSON.stringify(body.event)} as a ${typeof body.event}; the RGS expects a string`);
    }
    if (this.active) this.active.event = String(body.event);
    return ok({ event: body.event });
  }

  private replayRound(path: string): Reply {
    let asked: Record<'game' | 'version' | 'mode' | 'event', string>;
    try {
      const [game = '', version = '', mode = '', event = ''] = path.slice('/bet/replay/'.length).split('/').map(decodeURIComponent);
      asked = { game, version, mode, event };
    } catch {
      this.flag('error', 'replay/request', `Asked for a replay with a malformed path: ${path}`);
      return fail(400, 'ERR_VAL', 'invalid path');
    }
    if (!this.replay) {
      this.flag('warn', 'rgs/replay', 'Asked for a replay outside replay mode');
      return fail(404, 'ERR_BNF', 'bet not found');
    }
    for (const key of ['game', 'version', 'mode', 'event'] as const) {
      const value = asked[key];
      const expected = String(this.replay[key]);
      const same = key === 'mode' ? value.toLowerCase() === expected.toLowerCase() : value === expected;
      if (!same) {
        this.flag('error', 'replay/request', `Asked /bet/replay for ${key} "${value}"; the URL said "${expected}"`, { detail: path });
      }
    }
    return ok({
      payoutMultiplier: this.replay.payoutMultiplier,
      costMultiplier: this.replay.costMultiplier,
      state: this.replay.state,
    });
  }
}

const ok = (json: Record<string, unknown>): Reply => ({ status: 200, json });
const fail = (status: number, error: string, message: string): Reply => ({ status, json: { error, message } });

/**
 * Answers every request to `https://<host>/` in this browser context from the mock. Playwright answers
 * the CORS preflight of a routed request itself; only the requests themselves get here.
 */
/** An RGS request's JSON body. What the mock can't use is kept in `__invalid`, for the finding. */
export function parseBody(raw: string | null): Body {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    // JSON, but not an object: null, a number, or a body encoded twice
    return parsed && typeof parsed === 'object' ? (parsed as Body) : { __invalid: raw.slice(0, 200), __json: true };
  } catch {
    return { __invalid: raw.slice(0, 200) };
  }
}

export async function routeRgs(context: BrowserContext, host: string, rgs: MockRgs): Promise<void> {
  await context.route(`https://${host}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const arrival = rgs.arrive(path);
    const body = parseBody(request.postData());
    // a stopped run ends the wait early; the answer still goes out, to a page that's closing anyway
    if (rgs.delay) await sleep(rgs.delay).catch(() => {});
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
