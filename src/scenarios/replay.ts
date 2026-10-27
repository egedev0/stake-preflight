import { MICRO } from '../rgs.ts';
import type { Fault, ReplayRound } from '../rgs.ts';
import type { Scenario, ScenarioRun } from '../run.ts';
import type { Session } from '../session.ts';
import type { Book, PlayMode, Step } from '../types.ts';
import type { DrawnText } from '../probe.ts';
import { formatMultiplier, mapLimit, sleep, until } from '../util.ts';
import { showcaseBook } from './common.ts';

/**
 * Replays: Stake opens a stored round with ?replay=true. The game fetches it from /bet/replay, shows
 * what the round cost and paid before playing it, and touches no wallet endpoint.
 */
export default {
  name: 'replay',
  title: 'Replays',
  needsBooks: true,
  async run(t) {
    const modes = Object.values(t.modes);
    const priciest = [...modes].sort((a, b) => b.cost - a.cost)[0];
    const list = t.quick ? [...new Set([t.base, priciest ?? t.base])] : modes;
    await mapLimit(list, 2, (mode) => replayMode(t, mode));

    const book = t.base.books.big ?? t.base.books.win ?? t.base.books.loss;
    await replayMode(t, t.base, {
      book,
      label: 'Replay with only the required parameters',
      params: (replay, host) => ({ replay: 'true', game: replay.game, version: replay.version, mode: replay.mode, event: replay.event, rgs_url: host }),
      seconds: 12,
    });
    await replayMode(t, t.base, { book, label: 'Replay that does not exist', missing: true });
  },
} satisfies Scenario;

/** The URL Stake opens a replay with. */
export function replayParams(replay: ReplayRound, host: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    replay: 'true',
    game: replay.game,
    version: replay.version,
    mode: replay.mode,
    event: replay.event,
    rgs_url: host,
    currency: 'USD',
    amount: String(MICRO),
    lang: 'en',
    device: 'desktop',
    social: 'false',
    demo: 'true',
    ...extra,
  };
}

/** What /bet/replay is asked for and answers with, for one book of one mode. */
export function replayOf(t: ScenarioRun, mode: PlayMode, book: Book): ReplayRound {
  return {
    game: t.config.game,
    version: t.config.version,
    mode: mode.name,
    event: String(book.id),
    payoutMultiplier: book.payoutMultiplier / 100,
    costMultiplier: mode.cost,
    state: book.events,
  };
}

interface ReplayOptions {
  book?: Book | undefined;
  label?: string;
  /** the URL's parameters, when not the full set Stake sends */
  params?: (replay: ReplayRound, host: string) => Record<string, string>;
  /** the RGS says the round doesn't exist */
  missing?: boolean;
  seconds?: number;
}

async function replayMode(t: ScenarioRun, mode: PlayMode, options: ReplayOptions = {}): Promise<void> {
  const { label = `Replay ${mode.name}`, params, missing = false, seconds } = options;
  const book = options.book ?? showcaseBook(mode);
  if (!book) return;
  const replay = replayOf(t, mode, book);
  const faults: Record<string, Fault> = missing ? { replay: { status: 404, error: 'ERR_BNF', message: 'bet not found' } } : {};
  await t.use({ label, rgs: { replay, faults }, expectErrors: missing }, async (s) => {
    const query = params ? params(replay, s.host) : replayParams(replay, s.host);
    if (!(await s.load(query, { authenticate: false }))) return;

    const asked = await until(() => s.rgs.calls.some((call) => call.path.startsWith('/bet/replay/')), 30_000, 200);
    if (!asked) {
      const shot = await s.shot('waiting');
      t.findings.error('replay/request', `${label}: never asked /bet/replay for the round`, shot ? { shot } : {});
      return;
    }
    await s.quiet();
    await s.loaded();
    await s.shot('before play');

    if (!missing && !params) checkInfo(t, label, replay, await s.texts());
    if (!missing) {
      if (!(await s.start())) await s.steps(t.config.spin);
      await watch(s, seconds ?? (book.events.length > 12 ? t.config.timeouts.replay : 15), t.config.spin);
    } else {
      await sleep(3000);
      await s.shot("after the RGS said the round doesn't exist");
    }

    const wallet = [...new Set(s.rgs.calls.filter((call) => call.path.startsWith('/wallet/') || call.path === '/bet/event').map((call) => call.path))];
    if (wallet.length) {
      t.findings.error('replay/wallet', `${label}: called ${wallet.join(', ')}`, {
        detail: 'A replay shows a stored round. It must not authenticate, bet, save events or end rounds.',
      });
    }
  });
}

/** Screenshots every few seconds while the replay plays, pressing spin each time for cards that wait. */
async function watch(s: Session, seconds: number, spin: readonly Step[]): Promise<void> {
  const started = Date.now();
  let taken = 0;
  while (Date.now() - started < seconds * 1000) {
    await sleep(Math.min(5000, seconds * 1000 - (Date.now() - started)));
    if (taken < 8) {
      await s.shot(`${Math.round((Date.now() - started) / 1000)} s in`);
      taken += 1;
    }
    await s.steps(spin);
  }
}

/** Review asks for the bet, what it cost and what it paid on screen before the replay plays. */
function checkInfo(t: ScenarioRun, label: string, replay: ReplayRound, entries: readonly DrawnText[]): void {
  if (!replay.payoutMultiplier) return;
  const text = entries.map((entry) => entry.text).join('\n');
  const multiplier = replay.payoutMultiplier;
  const forms = new Set([
    multiplier.toFixed(2),
    String(multiplier),
    multiplier.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    multiplier.toLocaleString('en-US'),
  ]);
  // a whole number only counts next to an x, so a "2" on a coin isn't taken for a 2× payout
  const payout = [...forms].some((form) => {
    const number = form.replace(/[.,]/g, '\\$&');
    const pattern = form.includes('.') ? `(?<![\\d.,])${number}(?![\\d])` : `(?<![\\d.,])${number}\\s?[x×]|[x×]\\s?${number}(?![\\d.,])`;
    return new RegExp(pattern, 'i').test(text);
  });
  const bet = /(?<![\d.,])1\.00(?!\d)/.test(text);
  if (!payout || !bet) {
    const missing = [!bet && 'the bet (1.00)', !payout && `the payout (${formatMultiplier(multiplier)})`].filter(Boolean);
    t.findings.warn('replay/info', `${label}: ${missing.join(' and ')} not on screen before the replay played`, {
      detail: "Review asks for the bet, its cost, the payout multiplier and the win before PLAY. If they're drawn as images or bitmap text, check the screenshot.",
    });
  }
}
