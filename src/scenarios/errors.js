import { clip, sleep } from '../util.js';

/** The RGS says no, or can't be reached. The game has to cope: no crash, a message, a way on. */
export default {
  name: 'errors',
  title: 'RGS errors',
  async run(t) {
    await expiredSession(t);
    if (t.hasBooks) await failedBet(t);
    await unreachable(t);
  },
};

const MESSAGE = /\b(error|expired|invalid|session|reload|refresh|restart|try again|connection|connect|unavailable|went wrong)\b/i;
const RELOAD = /\b(reload|refresh|restart)\b/i;

async function expiredSession(t) {
  const faults = { authenticate: { status: 400, error: 'ERR_IS', message: 'invalid session' } };
  await t.use({ label: 'Session expired', rgs: { faults }, expectErrors: true }, async (s) => {
    if (!(await s.load())) return;
    await sleep(3000);
    await s.shot('/wallet/authenticate answered ERR_IS');
    await pastIntro(s);
    saysSomething(t, 'Session expired', await s.texts());
  });
}

async function failedBet(t) {
  const faults = { play: { status: 500, error: 'ERR_UE', message: 'general server error', once: true } };
  await t.use({ label: 'Failed bet', rgs: { faults, plays: ['loss', 'loss'] }, expectErrors: true }, async (s) => {
    if (!(await s.load())) return;
    await s.start();
    const before = await s.now();
    if (!(await s.spin())) {
      t.findings.info('errors/bet', "Failed bet: couldn't start a round to fail");
      return;
    }
    await sleep(2500);
    await s.shot('/wallet/play answered ERR_UE');

    const reload = (await s.texts(before)).find((entry) => RELOAD.test(entry.text));
    if (reload) {
      t.note(`Failed bet: the game asks for a reload ("${clip(reload.text, 80)}")`);
      return;
    }
    // otherwise the player should be able to close the message and carry on
    await s.press('Escape');
    await s.start();
    const next = await s.spin();
    await sleep(1500);
    await s.shot('the next bet');
    if (next) {
      t.note('Failed bet: the next bet went through');
    } else {
      t.findings.warn('errors/recover', 'After a failed bet the game took no new bet and asked for no reload', {
        detail: 'After an error the player should be able to carry on, or be told to reload.',
      });
    }
  });
}

async function unreachable(t) {
  const host = 'unreachable.preflight.test';
  await t.use({ label: 'RGS unreachable', host, offline: true, expectErrors: true }, async (s) => {
    if (!(await s.load(undefined, { authenticate: false }))) return;
    await sleep(6000);
    await s.shot('no answer from the RGS');
    if (!s.refused) {
      t.findings.error('rgs/url', 'Never contacted the RGS host from rgs_url', {
        detail: 'Stake passes the RGS host in the rgs_url parameter. Every RGS request has to go there.',
      });
      return;
    }
    await pastIntro(s);
    saysSomething(t, 'RGS unreachable', await s.texts());
  });
}

/** Clicks past an intro screen, then takes another screenshot: messages often wait behind it. */
async function pastIntro(s) {
  if (!(await s.start())) await s.click(0.5, 0.5);
  await sleep(2000);
  await s.shot('after a click');
}

function saysSomething(t, caption, texts) {
  const message = texts.find((entry) => MESSAGE.test(entry.text));
  if (message) {
    t.note(`${caption}: the game shows "${clip(message.text, 90)}"`);
  } else {
    t.findings.info('errors/message', `${caption}: no error message found in the game's text`, {
      detail: "If it's an image or bitmap text, check the screenshot. The player shouldn't be left on a frozen screen.",
    });
  }
}
