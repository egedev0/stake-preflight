import { findAmountIssues, findBalance } from '../checks/amounts.js';
import { MICRO } from '../rgs.js';
import { mapLimit } from '../util.js';
import { reportAmounts } from './common.js';

/** The balance has exactly two decimals in every currency: ¥1,000.00, not ¥1,000. */
export default {
  name: 'currencies',
  title: 'Currencies',
  needsBooks: true,
  async run(t) {
    const list = t.quick ? t.config.currencies.slice(0, 2) : t.config.currencies;
    const results = (await mapLimit(list, 2, (currency) => inCurrency(t, currency))).filter(Boolean);

    const wrong = results.filter((result) => result.balance.found === 'wrong');
    if (wrong.length) {
      t.findings.error('amount/balance', `The balance shows as "${wrong[0].balance.shown}" in ${wrong.map((result) => result.currency).join(', ')}; it needs exactly two decimals`, {
        detail: wrong.map((result) => `${result.currency}, ${result.balance.source}: ${result.balance.text}`).join('\n'),
      });
    }
    const missing = results.filter((result) => result.balance.found === 'missing').map((result) => result.currency);
    if (missing.length) t.note(`Couldn't find the balance in the game's text in ${missing.join(', ')}`);

    const issues = results.flatMap((result) => result.issues);
    const affected = results.filter((result) => result.issues.length).map((result) => result.currency);
    reportAmounts(t, issues, affected.length ? `In ${affected.join(', ')}: ` : '');
    if (!wrong.length && !issues.length && results.length) {
      t.note(`Amounts read right in ${results.map((result) => result.currency).join(', ')}`);
    }
  },
};

async function inCurrency(t, currency) {
  return t.use({ label: currency, rgs: { currency, plays: ['win'] } }, async (s) => {
    if (!(await s.load(s.params({ currency })))) return null;
    await s.start();
    const atLoad = findBalance(await s.texts(), s.rgs.balance / MICRO, { currency });
    await s.round('a win');
    const afterWin = findBalance(await s.texts(), s.rgs.balance / MICRO, { currency });
    const shown = [atLoad, afterWin];
    const balance = shown.find((found) => found.found === 'wrong') ?? shown.find((found) => found.found === 'exact') ?? atLoad;
    return { currency, balance, issues: findAmountIssues(await s.texts(), { currency }) };
  });
}
