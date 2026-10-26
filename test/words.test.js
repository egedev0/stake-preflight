import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findRestrictedWords, titleWords } from '../src/checks/words.js';

test('finds restricted words as whole words', () => {
  const hits = findRestrictedWords([
    { text: 'BUY BONUS', source: 'canvas' },
    { text: 'Total bet: 1.00', source: 'html' },
    { text: 'PAYDAY', source: 'canvas' },
    { text: 'Pays anywhere', source: 'svg' },
    { text: 'ALPHABET', source: 'canvas' },
  ]);
  assert.deepEqual(hits.map((hit) => hit.word).sort(), ['bet', 'buy', 'pays']);
});

test('keeps where each word was seen', () => {
  const [hit] = findRestrictedWords([
    { text: 'BUY BONUS', source: 'canvas' },
    { text: 'Buy feature', source: 'html' },
  ]);
  assert.deepEqual(hit.sources.sort(), ['canvas', 'html']);
  assert.deepEqual(hit.examples, ['BUY BONUS', 'Buy feature']);
});

test('flags paylines, which review counts as "pay"', () => {
  const hits = findRestrictedWords([{ text: 'The game has 40 fixed paylines.', source: 'html' }]);
  assert.deepEqual(hits.map((hit) => hit.word), ['paylines']);
});

test('matches phrases across spacing', () => {
  const hits = findRestrictedWords([{ text: 'See the PAY   TABLE', source: 'html' }]);
  assert.deepEqual(hits.map((hit) => hit.word), ['pay table']);
});

test('takes extra words and allowed words from the config', () => {
  const entries = [{ text: 'COINS BUY SPINS', source: 'canvas' }];
  const hits = findRestrictedWords(entries, { extra: ['coins'], allow: ['buy'] });
  assert.deepEqual(hits.map((hit) => hit.word), ['coins']);
});

test('leaves Stake as a name alone, but not stake as a bet', () => {
  const hits = findRestrictedWords([
    { text: 'Powered by Stake Engine', source: 'html' },
    { text: 'Play on Stake.us', source: 'html' },
    { text: 'Total stake: 1.00', source: 'canvas' },
  ]);
  assert.deepEqual(hits.map((hit) => hit.examples), [['Total stake: 1.00']]);
});

test("allows the words of the game's own name", () => {
  const entries = [{ text: 'MONEY TRAIN', source: 'canvas' }];
  assert.equal(findRestrictedWords(entries).length, 1);
  assert.equal(findRestrictedWords(entries, { allow: titleWords('Money Train 4') }).length, 0);
});
