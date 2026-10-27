import { chromium } from 'playwright-core';
import type { Browser, LaunchOptions } from 'playwright-core';
import { errorMessage } from './util.ts';

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

export interface BrowserOptions {
  executablePath?: string | undefined;
  headed?: boolean | undefined;
  /**
   * Leave Ctrl+C to the caller. Playwright's own handler closes the browser and exits the process
   * right away, before a stopped run can write its report.
   */
  ownSigint?: boolean | undefined;
}

/**
 * Starts Chromium: the one passed in, else the installed Google Chrome, else Playwright's own build
 * (npx playwright install chromium).
 */
export async function launchBrowser({ executablePath, headed = false, ownSigint = false }: BrowserOptions = {}): Promise<Browser> {
  const base: LaunchOptions = { headless: !headed, args: ARGS, handleSIGINT: !ownSigint };
  const attempts: LaunchOptions[] = executablePath ? [{ ...base, executablePath }] : [{ ...base, channel: 'chrome' }, base];
  const errors: string[] = [];
  for (const options of attempts) {
    try {
      return await chromium.launch(options);
    } catch (error) {
      errors.push(errorMessage(error).split('\n')[0] ?? '');
    }
  }
  throw new Error(
    `Couldn't start a browser. Install Google Chrome, run "npx playwright install chromium", or pass --browser <path>.\n  ${errors.join('\n  ')}`,
  );
}
