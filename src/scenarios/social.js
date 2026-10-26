import { findRestrictedWords, titleWords } from '../checks/words.js';
import { sleep, until } from '../util.js';
import { showcaseBook } from './common.js';
import { replayOf, replayParams } from './replay.js';

/**
 * Stake.us runs games in social mode (social=true in the URL, or jurisdiction.socialCasino). Real-money
 * words have to go: no bet, buy, pay, cash... Everything the game draws or shows is read.
 */
export default {
  name: 'social',
  title: 'Social mode (Stake.us)',
  async run(t) {
    const words = { ...t.config.social, allow: [...t.config.social.allow, ...titleWords(t.gameTitle)] };
    const seen = [];

    await t.use({ label: 'Social', rgs: { plays: ['win', 'feature', 'big'] } }, async (s) => {
      if (!(await s.load(s.params({ social: 'true' })))) return;
      await s.start();
      await s.shot('ready');
      if (t.hasBooks) {
        const kinds = t.quick ? ['win'] : ['win', 'feature'];
        for (const kind of kinds.filter((name) => t.base.books[name])) await s.round(kind === 'win' ? 'a win' : 'free spins');
      }
      for (const [name, steps] of Object.entries(t.config.screens)) {
        await s.steps(steps);
        await sleep(1200);
        await s.shot(name);
        seen.push(...(await s.texts()));
        await s.press('Escape');
        await sleep(600);
      }
      seen.push(...(await s.texts()));
    });

    if (t.hasBooks && !t.quick) {
      const book = showcaseBook(t.base);
      const replay = replayOf(t, t.base, book);
      await t.use({ label: 'Social replay', rgs: { replay } }, async (s) => {
        if (!(await s.load(replayParams(replay, s.host, { social: 'true' }), { authenticate: false }))) return;
        await until(() => s.rgs.calls.some((call) => call.path.startsWith('/bet/replay/')), 30_000, 200);
        await s.quiet();
        await s.loaded();
        await s.shot('before play');
        if (!(await s.start())) await s.steps(t.config.spin);
        await sleep(12_000);
        await s.shot('playing');
        seen.push(...(await s.texts()));
      });
    }

    const hits = findRestrictedWords(seen, words);
    for (const hit of hits) {
      t.findings.error('social/words', `"${hit.word}" shown in social mode`, {
        detail: `${hit.sources.join(', ')}: ${hit.examples.map((example) => `"${example}"`).join(', ')}`,
      });
    }
    if (!hits.length) t.note(`No restricted words in ${new Set(seen.map((entry) => entry.text)).size} different texts`);
    if (!Object.keys(t.config.screens).length) {
      t.note('Only the main screen was read. Add "screens" to the config to open the rules, buy menu and settings too.');
    }

    if (!t.quick) await socialFlag(t, words, new Set(hits.map((hit) => hit.word)));
  },
};

/** The same words with only jurisdiction.socialCasino on: some games read just the URL. */
async function socialFlag(t, words, known) {
  await t.use({ label: 'socialCasino flag', rgs: { jurisdiction: { socialCasino: true } } }, async (s) => {
    if (!(await s.load(s.params({ social: undefined })))) return;
    await s.start();
    await s.shot('ready');
    const fresh = findRestrictedWords(await s.texts(), words).filter((hit) => !known.has(hit.word));
    if (fresh.length) {
      t.findings.warn('social/flag', `With jurisdiction.socialCasino on (and no social=true in the URL) the game shows ${fresh.map((hit) => `"${hit.word}"`).join(', ')}`, {
        detail: 'Some operators turn social mode on through the jurisdiction config instead of the URL.',
      });
    }
  });
}
