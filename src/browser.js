import { chromium } from 'playwright-core';

const ARGS = [
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--ignore-gpu-blocklist',
  '--enable-unsafe-swiftshader',
  '--enable-precise-memory-info',
];

/**
 * Starts Chromium: the one passed in, else the installed Google Chrome, else Playwright's own build
 * (npx playwright install chromium).
 */
export async function launchBrowser({ executablePath, headed = false } = {}) {
  const base = { headless: !headed, args: ARGS };
  const attempts = executablePath ? [{ ...base, executablePath }] : [{ ...base, channel: 'chrome' }, base];
  const errors = [];
  for (const options of attempts) {
    try {
      return await chromium.launch(options);
    } catch (error) {
      errors.push(error.message.split('\n')[0]);
    }
  }
  throw new Error(
    `Couldn't start a browser. Install Google Chrome, run "npx playwright install chromium", or pass --browser <path>.\n  ${errors.join('\n  ')}`,
  );
}
