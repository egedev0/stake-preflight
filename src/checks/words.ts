import type { DrawnText } from '../probe.ts';

// Social mode (Stake.us) is a sweepstakes casino: no real-money wording. These are the common words a
// game ends up showing there by accident. Extend or trim the list with `social.extra` / `social.allow`.
export const RESTRICTED: readonly string[] = [
  'bet', 'bets', 'betting', 'rebet',
  'wager', 'wagers', 'wagering',
  'gamble', 'gambling',
  'buy', 'buys', 'buying', 'bought',
  'purchase', 'purchases',
  'pay', 'pays', 'paid', 'paying', 'payout', 'payouts', 'paytable', 'paytables', 'pay table',
  'payline', 'paylines', 'pay line', 'pay lines',
  'cash', 'money', 'currency', 'fund', 'funds',
  'deposit', 'deposits', 'withdraw', 'withdrawal', 'withdrawals',
  'credit', 'credits',
  'stake', 'stakes',
  'cost', 'costs', 'price', 'prices', 'spend',
];

// "Stake" as the name of the platform, not as a bet
const BRAND = /^(\s+(engine|originals)\b|\.(us|com)\b)/i;

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');

export interface RestrictedHit {
  word: string;
  /** where it was seen: canvas, svg, html */
  sources: string[];
  /** up to three texts it was in */
  examples: string[];
}

/** Restricted words in the given texts, one entry per word with where it was seen. */
export function findRestrictedWords(
  entries: readonly DrawnText[],
  { extra = [], allow = [] }: { extra?: readonly string[]; allow?: readonly string[] } = {},
): RestrictedHit[] {
  const allowed = new Set(allow.map((word) => word.toLowerCase()));
  const words = [...new Set([...RESTRICTED, ...extra].map((word) => word.toLowerCase()))]
    .filter((word) => !allowed.has(word))
    .sort((a, b) => b.length - a.length);
  if (!words.length) return [];
  const pattern = new RegExp(`\\b(${words.map(escape).join('|')})\\b`, 'gi');

  const hits = new Map<string, { word: string; sources: Set<string>; examples: string[] }>();
  for (const { text, source } of entries) {
    for (const match of text.matchAll(pattern)) {
      const word = (match[1] ?? '').toLowerCase().replace(/\s+/g, ' ');
      if (word === 'stake' && BRAND.test(text.slice(match.index + match[0].length))) continue;
      const hit = hits.get(word) ?? { word, sources: new Set(), examples: [] };
      hit.sources.add(source);
      const example = text.replace(/\s+/g, ' ').trim().slice(0, 80);
      if (hit.examples.length < 3 && !hit.examples.includes(example)) hit.examples.push(example);
      hits.set(word, hit);
    }
  }
  return [...hits.values()].map((hit) => ({ ...hit, sources: [...hit.sources] }));
}

/** The words of a game's name: "Money Train" may say money in social mode, it's the title. */
export const titleWords = (title: string | null | undefined): string[] => (title ? (title.toLowerCase().match(/[a-z]+/g) ?? []) : []);
