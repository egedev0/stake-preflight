import type { Scenario } from '../run.ts';
import { plural, sleep } from '../util.ts';

/** With nothing to bet, the game should stop the bet itself and say why. */
export default {
  name: 'balance',
  title: 'Empty balance',
  async run(t) {
    await t.use({ label: 'Zero balance', rgs: { balance: 0, plays: ['loss'] }, expectErrors: true }, async (s) => {
      if (!(await s.load())) return;
      await s.start();
      await s.shot('loaded');
      for (let i = 0; i < 3; i++) {
        await s.steps(t.config.spin);
        await sleep(1500);
      }
      await s.shot('after pressing spin three times');
      const sent = s.rgs.playCalls.length;
      if (sent) {
        t.findings.warn('balance/zero', `With a zero balance the game still sent ${plural(sent, 'bet')}`, {
          detail: 'The RGS answers ERR_IPB. Better to stop the bet in the game and tell the player the balance is too low.',
        });
      } else {
        t.note('With a zero balance no bet went out');
      }
    });
  },
} satisfies Scenario;
