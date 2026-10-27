import { MICRO } from '../rgs.ts';
import type { Round } from '../rgs.ts';
import type { Scenario, ScenarioRun } from '../run.ts';
import type { Book, PlayMode } from '../types.ts';
import { clip, formatAmount, sleep } from '../util.ts';
import { featureMode } from './common.ts';

/**
 * A player comes back to a round they didn't finish. The real RGS sends it from /wallet/authenticate,
 * without `event` until the game has saved one. The game has to play it out and end it.
 */
export default {
  name: 'resume',
  title: 'Unfinished rounds',
  needsBooks: true,
  async run(t) {
    const win = t.base.books.big ?? t.base.books.win;
    if (win) await resumeInto(t, { caption: 'Base game win', mode: t.base, book: win, amount: 4 * MICRO });

    const feature = featureMode(t);
    const book = feature?.books.feature;
    if (!feature || !book) {
      if (!win) t.note('No winning book to resume into');
      return;
    }
    const name = feature.base ? 'Free spins' : `${feature.name} free spins`;
    const saved = await resumeInto(t, { caption: name, mode: feature, book, amount: 0.4 * MICRO });
    if (t.quick || !saved) return;

    // Coming back to a saved event needs a value in the game's own format; only plain numbers can be made up.
    if (!saved.length) {
      t.note(`${name}: the game saved no events, so coming back to a saved one wasn't tried`);
    } else if (!saved.every((value) => /^\d+$/.test(value))) {
      t.note(`${name}: the game saves events as "${clip(saved[0], 40)}", so coming back to a saved one wasn't tried`);
    } else {
      const event = saved[Math.floor(saved.length / 2)];
      await resumeInto(t, { caption: `${name}, saved at event ${event}`, mode: feature, book, amount: 0.4 * MICRO, event });
    }
  },
} satisfies Scenario;

interface ResumeCase {
  caption: string;
  mode: PlayMode;
  book: Book;
  amount: number;
  /** the event the round comes back with; none, the way the RGS sends it before the game saves one */
  event?: string | undefined;
}

/** Opens the game into an unfinished round. Returns the events the game saved, or null if it didn't get through. */
async function resumeInto(t: ScenarioRun, { caption, mode, book, amount, event }: ResumeCase): Promise<string[] | null> {
  const multiplier = book.payoutMultiplier / 100;
  const resume: Omit<Round, 'betID' | 'active'> = {
    amount,
    payout: Math.round(amount * multiplier),
    payoutMultiplier: multiplier,
    mode: mode.name.toUpperCase(),
    state: book.events,
    ...(event !== undefined ? { event } : {}),
  };

  return t.use({ label: caption, rgs: { resume, plays: ['loss'] } }, async (s) => {
    if (!(await s.load())) return null;
    await s.start();
    await s.shot('reopened');

    const done = await s.drain();
    if (!done.ok) {
      const shot = await s.shot('still open');
      t.findings.error('resume/end-round', `${caption}: the game didn't finish the round it reopened (no /wallet/end-round)`, {
        detail: `The round came back from /wallet/authenticate ${event === undefined ? 'without "event", the way the real RGS sends it before the game saves one' : `with event "${event}"`}.`,
        ...(shot ? { shot } : {}),
      });
      return null;
    }
    await sleep(2500);
    await s.shot('finished');
    t.note(`${caption}: finished and ended${done.nudges ? ` after ${done.nudges} presses` : ''}`);
    const saved = s.rgs.calls.filter((call) => call.path === '/bet/event' && call.status === 200).map((call) => String(call.body.event));

    const next = await s.spin();
    if (!next) {
      t.findings.warn('resume/next', `${caption}: couldn't start a round after the resumed one`);
      return saved;
    }
    const nextAmount = next.body.amount;
    if (nextAmount !== amount) {
      t.findings.warn('resume/bet', `${caption}: after a ${formatAmount(amount)} round the next bet was ${typeof nextAmount === 'number' ? formatAmount(nextAmount) : String(nextAmount)}`, {
        detail: 'Players expect to carry on at the bet of the round they came back to.',
      });
    }
    if (String(next.body.mode).toLowerCase() !== t.base.name.toLowerCase()) {
      t.findings.warn('resume/mode', `${caption}: the next bet was in mode "${String(next.body.mode)}" instead of the base game`, {
        detail: 'A bought feature is a one-off; the round after it should be a normal spin.',
      });
    }
    await s.finish(next);
    return saved;
  });
}
