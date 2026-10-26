import { MICRO } from '../rgs.js';
import { clip, formatAmount, sleep } from '../util.js';
import { featureMode } from './common.js';

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
    if (!feature) {
      if (!win) t.note('No winning book to resume into');
      return;
    }
    const book = feature.books.feature;
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
};

/** Opens the game into an unfinished round. Returns the events the game saved, or null if it didn't get through. */
async function resumeInto(t, { caption, mode, book, amount, event }) {
  const multiplier = book.payoutMultiplier / 100;
  const resume = {
    amount,
    payout: Math.round(amount * multiplier),
    payoutMultiplier: multiplier,
    mode: mode.name.toUpperCase(),
    state: book.events,
  };
  if (event !== undefined) resume.event = String(event);

  return t.use({ label: caption, rgs: { resume, plays: ['loss'] } }, async (s) => {
    if (!(await s.load())) return null;
    await s.start();
    await s.shot('reopened');

    const done = await s.drain();
    if (!done.ok) {
      t.findings.error('resume/end-round', `${caption}: the game didn't finish the round it reopened (no /wallet/end-round)`, {
        detail: `The round came back from /wallet/authenticate ${event === undefined ? 'without "event", the way the real RGS sends it before the game saves one' : `with event "${event}"`}.`,
        shot: await s.shot('still open'),
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
    if (next.body.amount !== amount) {
      t.findings.warn('resume/bet', `${caption}: after a ${formatAmount(amount)} round the next bet was ${formatAmount(next.body.amount)}`, {
        detail: 'Players expect to carry on at the bet of the round they came back to.',
      });
    }
    if (String(next.body.mode).toLowerCase() !== t.base.name.toLowerCase()) {
      t.findings.warn('resume/mode', `${caption}: the next bet was in mode "${next.body.mode}" instead of the base game`, {
        detail: 'A bought feature is a one-off; the round after it should be a normal spin.',
      });
    }
    await s.finish(next);
    return saved;
  });
}
