import { mapLimit, sleep } from '../util.js';
import { checkLayout } from './common.js';

/** The sizes Stake's launcher offers. */
export const SCREENS = [
  { name: 'Desktop', size: [1200, 675] },
  { name: 'Laptop', size: [1024, 576] },
  { name: 'Popout L', size: [800, 450] },
  { name: 'Popout S', size: [400, 225] },
  { name: 'Mobile L', size: [425, 812], mobile: true },
  { name: 'Mobile M', size: [375, 667], mobile: true },
  { name: 'Mobile S', size: [320, 568], mobile: true },
];

export default {
  name: 'screens',
  title: 'Screen sizes',
  async run(t) {
    const list = t.quick ? SCREENS.filter((screen) => ['Popout S', 'Mobile M'].includes(screen.name)) : SCREENS;
    await mapLimit(list, 2, (screen) => atSize(t, screen));
    if (!t.quick) await resizing(t);
  },
};

async function atSize(t, { name, size, mobile = false }) {
  await t.use({ label: `${name} ${size.join('×')}`, viewport: size, mobile, rgs: { plays: ['win'] } }, async (s) => {
    if (!(await s.load())) return;
    await s.start();
    await s.shot('loaded');
    checkLayout(t, await s.layout(), name);
    if (t.hasBooks && !(await s.round('a win', { settle: 2000 }))) {
      t.findings.warn('screens/spin', `${name}: couldn't start a round`);
    }
  });
}

/** Stake's launcher switches sizes without reloading the game. */
async function resizing(t) {
  await t.use({ label: 'Resizing' }, async (s) => {
    if (!(await s.load())) return;
    await s.start();
    for (const [width, height] of [[400, 225], [375, 667], [800, 450], [1200, 675]]) {
      await s.resize(width, height);
      await sleep(1500);
      await s.shot(`resized to ${width}×${height}`);
    }
    checkLayout(t, await s.layout(), 'desktop size after resizing');
    if (s.rgs.count('/wallet/authenticate') > 1) {
      t.findings.warn('screens/reload', 'The game reloaded itself when the window was resized', {
        detail: "Stake's launcher resizes the game while it runs; a reload loses the player's place.",
      });
    }
  });
}
