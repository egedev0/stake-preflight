import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findAmountIssues, findBalance } from '../src/checks/amounts.ts';

const texts = (...list: string[]) => list.map((text) => ({ text, source: 'canvas' }));

test('flags a trailing zero, a missing decimal and missing cents', () => {
  const issues = findAmountIssues(texts('WIN $0.020', 'BET $5', 'TOTAL €1.5'));
  assert.deepEqual(
    issues.map(({ amount, issue }) => [amount, issue]),
    [
      ['$0.020', 'trailing-zero'],
      ['$5', 'no-decimals'],
      ['€1.5', 'one-decimal'],
    ],
  );
});

test('reads letter codes only for the session currency', () => {
  assert.deepEqual(findAmountIssues(texts('KWD 1.250'), { currency: 'KWD' }).map((item) => item.issue), ['trailing-zero']);
  assert.deepEqual(findAmountIssues(texts('KWD 1.250', 'TRY 5 FREE SPINS', 'PEN 2', 'MAX 25 MAD')), []);
});

test('leaves good amounts and numbers without a currency alone', () => {
  const issues = findAmountIssues(
    texts('BALANCE $1,234.50', '¥0.0125', 'WIN 2.50x', 'x5 MULTIPLIER', '1,024 WAYS', 'WIN 5.00', 'MAX WIN 5,000X', '€1.234,56', '1.234,56 €', 'UP TO $5K'),
  );
  assert.deepEqual(issues, []);
});

test('reports each bad amount once', () => {
  assert.equal(findAmountIssues(texts('$5', 'BET $5', '$5')).length, 1);
});

test('finds the balance with exactly two decimals', () => {
  assert.equal(findBalance(texts('BALANCE $998.80'), 998.8).found, 'exact');
  assert.equal(findBalance(texts('$1,000.00'), 1000).found, 'exact');
  assert.equal(findBalance(texts('KWD 1000.00'), 1000).found, 'exact');
});

test('spots the balance with the wrong decimals', () => {
  assert.equal(findBalance(texts('BALANCE ¥1,000'), 1000).found, 'wrong');
  assert.equal(findBalance(texts('$998.8'), 998.8).found, 'wrong');
  assert.equal(findBalance(texts('Balance: 998.800'), 998.8).found, 'wrong');
});

test("doesn't mistake other numbers for the balance", () => {
  assert.equal(findBalance(texts('WIN $998.81'), 998.8).found, 'missing');
  assert.equal(findBalance(texts('1000 WAYS'), 1000).found, 'missing');
  assert.equal(findBalance(texts('$11,000.00'), 1000).found, 'missing');
  assert.equal(findBalance(texts('WIN UP TO 1,000X', '1000 WAYS TO WIN'), 1000).found, 'missing');
});
