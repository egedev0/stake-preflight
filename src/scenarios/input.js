import { plural, sleep } from '../util.js';

/** Presses spin as fast as a player might, then again with a slow RGS. Rounds must never overlap. */
export default {
  name: 'input',
  title: 'Fast input',
  needsBooks: true,
  async run(t) {
    const plays = ['win', 'loss', 'big', 'win', 'loss', 'win', 'loss', 'win'].filter((kind) => t.base.books[kind]);
    await t.use({ label: 'Fast input', rgs: { plays: plays.length ? plays : ['loss'] } }, async (s) => {
      if (!(await s.load())) return;
      await s.start();

      const mash = async (seconds, gap) => {
        const stop = Date.now() + seconds * 1000;
        while (Date.now() < stop) {
          await s.steps(t.config.spin);
          await sleep(gap);
        }
      };

      await mash(15, 100);
      await s.shot('after 15 s of pressing spin');
      if (!(await s.drain()).ok) {
        t.findings.error('round/end-round', 'After fast presses a round was left open (no /wallet/end-round)');
      }
      const fast = s.rgs.playCalls.length;

      s.rgs.delay = 2500;
      await mash(12, 150);
      await s.shot('slow RGS, after 12 s of pressing spin');
      const drained = await s.drain();
      s.rgs.delay = 0;
      if (!drained.ok) t.findings.error('round/end-round', 'With a slow RGS a round was left open (no /wallet/end-round)');

      const slow = s.rgs.playCalls.length - fast;
      t.note(`${plural(fast, 'bet')} in 15 s of fast presses, ${plural(slow, 'bet')} in 12 s with every RGS answer 2.5 s late`);
      if (!fast) t.findings.warn('input/none', 'Pressing spin quickly started no round at all');
    });
  },
};
