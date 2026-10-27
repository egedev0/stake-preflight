import type { Scenario } from '../run.ts';
import { mapLimit } from '../util.ts';

/** The game opened in other languages. Stake passes `lang`; "br" is Brazilian Portuguese. */
export default {
  name: 'locales',
  title: 'Languages',
  async run(t) {
    const langs = t.quick ? t.config.langs.slice(0, 2) : t.config.langs;
    await mapLimit(langs, 2, (lang) =>
      t.use({ label: lang }, async (s) => {
        if (!(await s.load(s.params({ lang })))) return;
        await s.start();
        await s.shot('loaded');
      }),
    );
    t.note(`Opened in ${langs.join(', ')}. Look over the screenshots for text that overflows or wasn't translated.`);
  },
} satisfies Scenario;
