import { ISSUES } from '../checks/amounts.js';
import { formatMultiplier } from '../util.js';

export const KIND_LABEL = { loss: 'Loss', win: 'Small win', big: 'Big win', max: 'Max win', feature: 'Free spins' };

export const describeBook = (kind, book) => `${KIND_LABEL[kind] ?? kind} (${formatMultiplier(book.payoutMultiplier / 100)})`;

/** How the config starts a round, for messages: "Space", "a click at 50%, 90%". */
export function describeSteps(steps) {
  return steps
    .map((step) => {
      if (step.key) return step.key;
      if (step.click) return `a click at ${step.click.map((n) => `${Math.round(n * 100)}%`).join(', ')}`;
      if (step.selector) return `a click on ${step.selector}`;
      return `a ${step.wait} ms wait`;
    })
    .join(' then ');
}

/** The page shouldn't scroll: Stake shows the game in a fixed frame. */
export function checkLayout(t, layout, where) {
  if (!layout) return;
  const wide = layout.scrollWidth > layout.width + 1;
  const tall = layout.scrollHeight > layout.height + 1;
  if (wide || tall) {
    t.findings.warn(
      'layout/scroll',
      `The page scrolls at ${where} (${layout.width}×${layout.height}): its content is ${layout.scrollWidth}×${layout.scrollHeight}`,
    );
  }
}

/** The round a mode is best shown with: a free spins round when there is one, else its biggest pick. */
export function showcaseBook(mode) {
  const { books } = mode;
  return mode.base
    ? (books.feature ?? books.big ?? books.win ?? books.loss)
    : (books.feature ?? books.max ?? books.big ?? books.win ?? books.loss);
}

/** The cheapest mode with a free spins round (the base game if it has one). */
export function featureMode(t) {
  if (t.base.books.feature) return t.base;
  return Object.values(t.modes)
    .filter((mode) => mode.books.feature)
    .sort((a, b) => a.cost - b.cost)[0];
}

/** One warning per formatting rule an amount breaks, with a few examples. */
export function reportAmounts(t, issues, prefix = '') {
  const groups = new Map();
  for (const item of issues) groups.set(item.issue, [...(groups.get(item.issue) ?? []), item]);
  for (const [issue, items] of groups) {
    const examples = items.slice(0, 4).map((item) => `"${item.amount}"`).join(', ');
    const more = items.length > 4 ? ` and ${items.length - 4} more` : '';
    t.findings.warn('amount/format', `${prefix ? `${prefix}amounts` : 'Amounts'} ${ISSUES[issue].label}: ${examples}${more}`, {
      detail: [ISSUES[issue].rule, ...items.slice(0, 5).map((item) => `${item.source}: ${item.text}`)].join('\n'),
    });
  }
}
