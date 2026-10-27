import type { Scenario, ScenarioRun } from '../run.ts';
import { formatDuration, plural, sleep } from '../util.ts';

/** Jurisdiction flags from /wallet/authenticate: the ones a test can see from outside the game. */
export default {
  name: 'flags',
  title: 'Jurisdiction flags',
  async run(t) {
    await spacebar(t);
    if (t.hasBooks) await minimumDuration(t);
    if (!t.quick) await display(t);
  },
} satisfies Scenario;

async function spacebar(t: ScenarioRun): Promise<void> {
  await t.use({ label: 'disabledSpacebar', rgs: { jurisdiction: { disabledSpacebar: true }, plays: ['loss'] } }, async (s) => {
    if (!(await s.load())) return;
    await s.start();
    for (let i = 0; i < 3; i++) {
      await s.press('Space');
      await sleep(1500);
    }
    await s.shot('after pressing Space three times');
    if (s.rgs.playCalls.length) t.findings.error('flags/spacebar', 'With disabledSpacebar on, Space still started a round');
    else t.note('disabledSpacebar: Space started no round');
  });
}

async function minimumDuration(t: ScenarioRun): Promise<void> {
  const seconds = t.config.minimumRoundDuration;
  const rgs = { jurisdiction: { minimumRoundDuration: seconds }, plays: ['loss'] };
  await t.use({ label: 'minimumRoundDuration', rgs }, async (s) => {
    if (!(await s.load())) return;
    await s.start();
    const stop = Date.now() + Math.max(14, seconds * 5) * 1000;
    while (Date.now() < stop) {
      await s.steps(t.config.spin);
      await sleep(150);
    }
    await s.shot('after pressing spin for a while');
    const starts = s.rgs.playCalls.filter((call) => call.status === 200).map((call) => call.at);
    const gaps = starts.slice(1).map((at, index) => at - (starts[index] ?? at));
    if (!gaps.length) {
      t.findings.info('flags/min-duration', `Couldn't measure minimumRoundDuration: ${plural(starts.length, 'round')} started`);
      return;
    }
    // a little slack: the gap is measured where the bets arrive, not where the game starts its timer
    const shortest = Math.min(...gaps);
    if (shortest < seconds * 1000 - 250) {
      t.findings.error('flags/min-duration', `With minimumRoundDuration ${seconds}, two rounds started ${formatDuration(shortest)} apart`, {
        detail: `The flag's unit isn't documented. This run sends ${seconds} and expects rounds at least ${seconds} s apart; set "minimumRoundDuration" in the config to try another value.`,
      });
    } else {
      t.note(`minimumRoundDuration ${seconds}: rounds started at least ${formatDuration(shortest)} apart`);
    }
  });
}

async function display(t: ScenarioRun): Promise<void> {
  const jurisdiction = {
    displayRTP: true,
    displaySessionTimer: true,
    displayNetPosition: true,
    disabledTurbo: true,
    disabledSuperTurbo: true,
    disabledAutoplay: true,
    disabledBuyFeature: true,
    disabledFullscreen: true,
    disabledSlamstop: true,
  };
  await t.use({ label: 'All flags on', rgs: { jurisdiction, plays: ['win'] } }, async (s) => {
    if (!(await s.load())) return;
    await s.start();
    await s.shot('loaded');
    if (t.hasBooks) await s.round('a win');

    const buy = t.config.screens.buy;
    if (buy && t.hasBooks) {
      await s.steps(buy);
      await sleep(2000);
      await s.shot('trying the buy menu');
      await s.press('Escape');
      const base = t.base.name.toLowerCase();
      const bought = s.rgs.playCalls.filter((call) => String(call.body.mode).toLowerCase() !== base);
      if (bought[0]) t.findings.error('flags/buy', `With disabledBuyFeature on, the game still bought mode "${String(bought[0].body.mode)}"`);
    }

    const text = (await s.texts()).map((entry) => entry.text).join('\n');
    const missing: [string, string][] = [];
    if (!/\bRTP\b/i.test(text)) missing.push(['flags/rtp', 'displayRTP is on but no text says RTP']);
    if (!/\b\d{1,2}:\d{2}(:\d{2})?\b/.test(text)) missing.push(['flags/session-timer', 'displaySessionTimer is on but no clock (00:00) was found']);
    if (!/\bnet\b/i.test(text)) missing.push(['flags/net-position', 'displayNetPosition is on but no text says "net"']);
    for (const [check, message] of missing) {
      t.findings.warn(check, message, { detail: "If it's drawn as an image or bitmap text, check the screenshot instead." });
    }
    t.note('Compare "All flags on" with the loading screenshot: turbo, autoplay, buy and fullscreen controls should be gone.');
  });
}
