import { findAmountIssues, findBalance } from '../checks/amounts.js';
import { describeFrames, frameStats } from '../frames.js';
import { DEFAULT_BET, MICRO } from '../rgs.js';
import { formatAmount, formatDuration, plural } from '../util.js';
import { describeBook, describeSteps, reportAmounts } from './common.js';

export default {
  name: 'play',
  title: 'Base game rounds',
  needsBooks: true,
  async run(t) {
    const { books } = t.base;
    const kinds = ['loss', 'win', 'big', 'feature', 'loss'].filter((kind) => books[kind]);
    if (t.quick) kinds.splice(3);
    await t.use({ label: 'Base game', rgs: { plays: kinds } }, async (s) => {
      if (!(await s.load())) return;
      await s.start();
      await s.shot('ready');

      const balances = [];
      const checkBalance = async () => balances.push(findBalance(await s.texts(), s.rgs.balance / MICRO));
      await checkBalance();

      for (const [index, kind] of kinds.entries()) {
        const caption = describeBook(kind, books[kind]);
        const played = await s.round(caption);
        if (!played) {
          t.findings.error('play/spin', `Couldn't start round ${index + 1}: no bet went out after ${describeSteps(t.config.spin)}`, {
            detail: 'If the game starts rounds another way, set "spin" in preflight.config.json.',
          });
          break;
        }
        if (played.play.status !== 200) break;
        if (!played.result.ok) {
          t.findings.error('round/end-round', `${caption}: no /wallet/end-round after ${formatDuration(played.result.waited)}`, {
            detail: 'A round with a win stays open until the game ends it, and the player is only paid then.',
            shot: t.shots.at(-1)?.file,
          });
          break;
        }
        const presses = played.result.nudges ? `, needed ${plural(played.result.nudges, 'press', 'presses')} to finish` : '';
        t.note(`${caption}: ${describeFrames(frameStats(played.frames))}${presses}`);
        await checkBalance();
      }

      const first = s.rgs.playCalls[0];
      if (first?.status === 200 && first.body.amount !== DEFAULT_BET) {
        t.findings.warn('bet/default', `The first bet was ${formatAmount(first.body.amount)}; /wallet/authenticate's defaultBetLevel was ${formatAmount(DEFAULT_BET)}`, {
          detail: 'A game should start at the default level the RGS sends, and offer only its betLevels.',
        });
      }

      const wrong = balances.find((found) => found.found === 'wrong');
      if (wrong) {
        t.findings.error('amount/balance', `The balance shows as "${wrong.shown}"; it needs exactly two decimals`, {
          detail: `${wrong.source}: ${wrong.text}`,
        });
      } else if (!balances.some((found) => found.found === 'exact')) {
        t.findings.info('amount/balance', "Couldn't find the balance in the game's text", {
          detail: "If it's drawn with a bitmap font or as an image, this check can't read it. Look at the screenshots.",
        });
      }
      reportAmounts(t, findAmountIssues(await s.texts()));

      const saved = s.rgs.count('/bet/event');
      if (saved) t.note(`Saved progress with /bet/event ${plural(saved, 'time')}`);
      const memory = await s.memory();
      if (memory) t.note(`JS heap after ${plural(s.rgs.rounds.length, 'round')}: ${(memory / 2 ** 20).toFixed(0)} MB`);
    });
  },
};
