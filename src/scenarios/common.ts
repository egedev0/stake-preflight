import { ISSUES } from '../checks/amounts.ts';
import type { AmountIssue } from '../checks/amounts.ts';
import type { ScenarioRun } from '../run.ts';
import type { Layout } from '../session.ts';
import type { Book, Kind, PlayMode, Step } from '../types.ts';
import { formatMultiplier } from '../util.ts';

export const KIND_LABEL: Record<Kind, string> = { loss: 'Loss', win: 'Small win', big: 'Big win', max: 'Max win', feature: 'Free spins' };

export const describeBook = (kind: Kind, book: Book) => `${KIND_LABEL[kind]} (${formatMultiplier(book.payoutMultiplier / 100)})`;

/** How the config starts a round, for messages: "Space", "a click at 50%, 90%". */
export function describeSteps(steps: readonly Step[]): string {
  return steps
    .map((step) => {
      if ('key' in step) return step.key;
      if ('click' in step) return `a click at ${step.click.map((n) => `${Math.round(n * 100)}%`).join(', ')}`;
      if ('selector' in step) return `a click on ${step.selector}`;
      return `a ${step.wait} ms wait`;
    })
    .join(' then ');
}

/** The page shouldn't scroll: Stake shows the game in a fixed frame. */
export function checkLayout(t: ScenarioRun, layout: Layout | null, where: string): void {
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
export function showcaseBook(mode: PlayMode): Book | undefined {
  const { books } = mode;
  return mode.base
    ? (books.feature ?? books.big ?? books.win ?? books.loss)
    : (books.feature ?? books.max ?? books.big ?? books.win ?? books.loss);
}

/** The cheapest mode with a free spins round (the base game if it has one). */
export function featureMode(t: ScenarioRun): PlayMode | undefined {
  if (t.base.books.feature) return t.base;
  return Object.values(t.modes)
    .filter((mode) => mode.books.feature)
    .sort((a, b) => a.cost - b.cost)[0];
}

/** One warning per formatting rule an amount breaks, with a few examples. */
export function reportAmounts(t: ScenarioRun, issues: readonly AmountIssue[], prefix = ''): void {
  const groups = new Map<AmountIssue['issue'], AmountIssue[]>();
  for (const item of issues) groups.set(item.issue, [...(groups.get(item.issue) ?? []), item]);
  for (const [issue, items] of groups) {
    const examples = items.slice(0, 4).map((item) => `"${item.amount}"`).join(', ');
    const more = items.length > 4 ? ` and ${items.length - 4} more` : '';
    t.findings.warn('amount/format', `${prefix ? `${prefix}amounts` : 'Amounts'} ${ISSUES[issue].label}: ${examples}${more}`, {
      detail: [ISSUES[issue].rule, ...items.slice(0, 5).map((item) => `${item.source}: ${item.text}`)].join('\n'),
    });
  }
}
