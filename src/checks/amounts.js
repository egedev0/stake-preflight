// How amounts read on screen. Review has sent games back for "$0.020" (a trailing zero), for amounts
// with no cents, and for a balance in yen shown without decimals. The rules checked here:
// - every amount shows at least two decimals,
// - an amount with more than two decimals doesn't end in a zero,
// - the balance shows exactly two decimals, in every currency.
// Only English formatting is read (1,234.56), so these checks run on lang=en sessions.

const SYMBOLS = '$€£¥₹₩₺₽₴₦₱฿₫₪₸₼₾';
const MARK = String.raw`R\$|[${SYMBOLS}]|\b[A-Z]{2,3}\b`;
const AMOUNT = new RegExp(String.raw`(${MARK})? ?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?: ?(${MARK}))?`, 'g');

/**
 * A currency sign counts anywhere. Letters count only as the session's own code ("KWD 1.25" in a KWD
 * session), so words such as TRY, PEN or MAD next to a number aren't taken for money.
 */
const isCurrency = (mark, currency) => {
  if (!mark) return false;
  if (mark === 'R$' || SYMBOLS.includes(mark)) return true;
  return mark === currency || (mark === 'KD' && currency === 'KWD');
};

/** Every kind of space as a plain one: games put no-break spaces between a sign and its number. */
const normalize = (text) => text.replace(/\s/g, ' ');

export const ISSUES = {
  'no-decimals': { label: 'without decimals', rule: 'Every amount needs at least two decimals: $5.00, not $5.' },
  'one-decimal': { label: 'with one decimal', rule: 'Every amount needs at least two decimals: $1.50, not $1.5.' },
  'trailing-zero': { label: 'with a zero that adds nothing', rule: 'Past two decimals, a zero at the end adds nothing: $0.02, not $0.020.' },
};

/**
 * Amounts with a currency sign or code next to them that break the rules above.
 * @param {{ text: string, source: string }[]} entries
 * @param {{ currency?: string }} [options] the session's currency
 * @returns {{ amount: string, issue: keyof ISSUES, source: string, text: string }[]}
 */
export function findAmountIssues(entries, { currency = 'USD' } = {}) {
  const issues = [];
  const seen = new Set();
  for (const entry of entries) {
    const line = normalize(entry.text);
    for (const match of line.matchAll(AMOUNT)) {
      const [whole, before, , decimals, after] = match;
      if (!isCurrency(before, currency) && !isCurrency(after, currency)) continue;
      const end = match.index + whole.length;
      // part of a longer number written another way ("1.234,56 €"), or short for thousands ("$5K")
      if (/[\d.,]/.test(line[match.index - 1] ?? '') || /[\d.,]/.test(line[end] ?? '')) continue;
      if (/^[KMB]\b/.test(line.slice(end))) continue;
      let issue = null;
      if (decimals === undefined) issue = 'no-decimals';
      else if (decimals.length === 1) issue = 'one-decimal';
      else if (decimals.length > 2 && decimals.endsWith('0')) issue = 'trailing-zero';
      if (!issue) continue;
      const amount = whole.trim();
      if (seen.has(`${issue} ${amount}`)) continue;
      seen.add(`${issue} ${amount}`);
      issues.push({ amount, issue, source: entry.source, text: line.trim().slice(0, 80) });
    }
  }
  return issues;
}

/**
 * Looks for the balance in the texts and says how it was shown: `exact` (two decimals), `wrong` (the same
 * value with other decimals, next to a currency or the word "balance") or `missing`.
 * @param {number} amount the balance in currency units, e.g. 998.8
 * @param {{ currency?: string }} [options] the session's currency
 */
export function findBalance(entries, amount, { currency = 'USD' } = {}) {
  const units = Math.trunc(amount);
  const cents = Math.round((amount - units) * 100);
  const integer = `(?:${escape(units.toLocaleString('en-US'))}|${units})`;
  const number = new RegExp(String.raw`(?<![\d.,])${integer}(?:\.(\d+))?(?![\d,]|\.\d)`, 'g');
  let wrong = null;
  for (const entry of entries) {
    const line = normalize(entry.text);
    for (const match of line.matchAll(number)) {
      const decimals = match[1];
      // a different amount that starts with the same digits
      if (decimals !== undefined && Number(`0.${decimals}`) !== cents / 100) continue;
      if (decimals === undefined && cents !== 0) continue;
      if (decimals?.length === 2) return { found: 'exact' };
      const near = line.slice(Math.max(0, match.index - 4), match.index + match[0].length + 4);
      const money = [...near.matchAll(new RegExp(MARK, 'g'))].some(([mark]) => isCurrency(mark, currency));
      if (!wrong && (money || /\bbalance\b/i.test(line))) {
        wrong = { found: 'wrong', shown: match[0], source: entry.source, text: line.trim().slice(0, 80) };
      }
    }
  }
  return wrong ?? { found: 'missing' };
}

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
