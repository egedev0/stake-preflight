import { findAmountIssues, findBalance } from '../checks/amounts.ts';
import type { AmountIssue, BalanceFound } from '../checks/amounts.ts';
import { MICRO } from '../rgs.ts';
import type { Scenario, ScenarioRun } from '../run.ts';
import { mapLimit } from '../util.ts';
import { reportAmounts } from './common.ts';

interface InCurrency {
  currency: string;
  balance: BalanceFound;
  issues: AmountIssue[];
}

/** The balance has exactly two decimals in every currency: ¥1,000.00, not ¥1,000. */
export default {
  name: 'currencies',
  title: 'Currencies',
  needsBooks: true,
  async run(t) {
    const list = t.quick ? t.config.currencies.slice(0, 2) : t.config.currencies;
    const results = (await mapLimit(list, 2, (currency) => inCurrency(t, currency))).filter((result) => result !== null);

    const wrong = results.flatMap(({ currency, balance }) => (balance.found === 'wrong' ? [{ currency, ...balance }] : []));
    if (wrong[0]) {
      t.findings.error('amount/balance', `The balance shows as "${wrong[0].shown}" in ${wrong.map((item) => item.currency).join(', ')}; it needs exactly two decimals`, {
        detail: wrong.map((item) => `${item.currency}, ${item.source}: ${item.text}`).join('\n'),
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
} satisfies Scenario;

async function inCurrency(t: ScenarioRun, currency: string): Promise<InCurrency | null> {
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
