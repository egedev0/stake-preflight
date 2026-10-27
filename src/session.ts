import { devices } from 'playwright-core';
import type { BrowserContext, BrowserContextOptions, Page, Request } from 'playwright-core';
import type { FindingExtra } from './findings.ts';
import { probe } from './probe.ts';
import type { DrawnText } from './probe.ts';
import { MockRgs, routeRgs } from './rgs.ts';
import type { Call, MockRgsOptions, Round } from './rgs.ts';
import type { ScenarioRun } from './run.ts';
import type { Config, Level, Step } from './types.ts';
import { clip, errorMessage, sleep, until } from './util.ts';

export const RGS_HOST = 'rgs.preflight.test';

const PHONE = devices['Pixel 7'];
const INTRO = /^(continue|start|play|ok|okay|got it|tap|click|press|go|enter|begin|let'?s (play|go))\b/i;
const LOADING = /\bloading\b/i;

export interface SessionOptions {
  /** shown on screenshots, in the call log and next to findings */
  label: string;
  viewport?: [number, number];
  mobile?: boolean;
  /** options for the mock RGS */
  rgs?: Omit<MockRgsOptions, 'findings' | 'sessionID' | 'label'>;
  /** the RGS host the URL points at */
  host?: string;
  /** console errors are expected (the RGS answers with errors) */
  expectErrors?: boolean;
  /** refuse every connection to the RGS host instead of answering */
  offline?: boolean;
}

/** How a round ended: `ok` when it finished (a win with /wallet/end-round). */
export interface Finish {
  ok: boolean;
  nudges: number;
  /** ms from the start of the wait */
  took?: number;
  waited?: number;
}

/** One played round, with its frame times. */
export interface Played {
  play: Call;
  result: Finish;
  frames: number[];
}

export interface Layout {
  width: number;
  height: number;
  scrollWidth: number;
  scrollHeight: number;
  viewport: string | null;
  canvas: boolean;
}

/** One game page in its own browser context, talking to its own mock RGS. */
export class Session {
  readonly run: ScenarioRun;
  readonly config: Config;
  readonly label: string;
  readonly viewport: [number, number];
  readonly mobile: boolean;
  readonly host: string;
  readonly expectErrors: boolean;
  readonly offline: boolean;
  /** connections refused, when offline */
  refused = 0;
  readonly timeouts: Config['timeouts'];
  readonly rgs: MockRgs;
  bytes = 0;
  authenticatedAfter = 0;
  private context: BrowserContext | null = null;
  private currentPage: Page | null = null;
  private readonly inflight = new Set<Request>();
  private lastRequestAt = Date.now();
  private closing = false;

  constructor(run: ScenarioRun, { label, viewport, mobile = false, rgs = {}, host = RGS_HOST, expectErrors = false, offline = false }: SessionOptions) {
    this.run = run;
    this.config = run.config;
    this.label = label;
    this.viewport = viewport ?? run.config.viewport;
    this.mobile = mobile;
    this.host = host;
    this.expectErrors = expectErrors;
    this.offline = offline;
    const { load, round, replay } = run.config.timeouts;
    this.timeouts = { load: load * 1000, round: round * 1000, replay: replay * 1000 };
    this.rgs = new MockRgs({
      findings: run.findings,
      label,
      sessionID: `preflight-${run.name}-${Math.random().toString(36).slice(2, 8)}`,
      modes: run.modes,
      ...rgs,
    });
  }

  /** The game page. Only there once the session is open. */
  get page(): Page {
    if (!this.currentPage) throw new Error(`The "${this.label}" session isn't open`);
    return this.currentPage;
  }

  async open(): Promise<this> {
    const [width, height] = this.viewport;
    const options: BrowserContextOptions = this.mobile
      ? { ...PHONE, viewport: { width, height }, screen: { width, height } }
      : { viewport: { width, height }, deviceScaleFactor: 1 };
    this.context = await this.run.browser.newContext(options);
    await this.context.addInitScript(probe);
    if (this.offline) {
      await this.context.route(`https://${this.host}/**`, (route) => {
        this.refused += 1;
        return route.abort('connectionrefused').catch(() => {});
      });
    } else {
      await routeRgs(this.context, this.host, this.rgs);
    }
    this.currentPage = await this.context.newPage();
    this.watch(this.currentPage);
    return this;
  }

  private flag(level: Level, check: string, message: string, extra: FindingExtra = {}) {
    this.run.findings.add(level, check, message, { ...extra, where: this.label });
  }

  private watch(page: Page) {
    const root = this.run.origin + this.run.prefix;
    const settle = (request: Request) => {
      this.inflight.delete(request);
      this.lastRequestAt = Date.now();
    };

    page.on('pageerror', (error) => {
      this.flag('error', 'page/error', `Uncaught ${error.name}: ${clip(error.message, 200)}`, { detail: clip(error.stack ?? '', 800) });
    });
    page.on('console', (message) => {
      const text = message.text();
      if (message.type() === 'warning') this.run.warnings.add(clip(text, 200));
      if (message.type() !== 'error' || /^Failed to load resource/.test(text)) return;
      this.flag(this.expectErrors ? 'info' : 'error', 'console/error', `console.error: ${clip(text, 200)}`);
    });
    page.on('websocket', (socket) => {
      this.flag('error', 'net/external', `Opened a WebSocket to ${clip(socket.url(), 120)}`);
    });
    page.on('request', (request) => {
      const url = request.url();
      if (url.startsWith('data:') || url.startsWith('blob:')) return;
      this.inflight.add(request);
      this.lastRequestAt = Date.now();
      const target = new URL(url);
      if (target.hostname === this.host || url.startsWith(root)) return;
      if (target.origin === this.run.origin) {
        this.flag('error', 'net/outside', `Requested ${target.pathname}, outside the game's folder`, {
          detail: 'Stake serves a game from /<game>/<version>/. A path that starts with "/" leaves that folder; use relative paths.',
        });
        return;
      }
      this.flag('error', 'net/external', `Requested ${clip(url, 120)}`, { detail: 'A game may not load anything from another host.' });
    });
    page.on('requestfinished', settle);
    page.on('requestfailed', (request) => {
      settle(request);
      const url = request.url();
      if (this.closing || !url.startsWith(root)) return;
      const failure = request.failure()?.errorText ?? 'failed';
      // a download the page itself dropped (a video it has buffered enough of, a 404 body nobody reads)
      if (failure === 'net::ERR_ABORTED') return;
      this.flag('error', 'net/failed', `${new URL(url).pathname} failed to load (${failure})`);
    });
    page.on('response', (response) => {
      const url = response.url();
      // requests outside the game's folder are reported when they're made
      if (!url.startsWith(root)) return;
      const length = Number(response.headers()['content-length']);
      if (Number.isFinite(length)) this.bytes += length;
      if (response.status() < 400) return;
      const file = decodeURIComponent(new URL(url).pathname.slice(this.run.prefix.length));
      // a script asking for an optional file may cope without it; a missing image, font or script is broken
      const optional = ['fetch', 'xhr'].includes(response.request().resourceType());
      this.flag(optional ? 'warn' : 'error', 'net/http', `HTTP ${response.status()} for ${file}`);
    });
  }

  /** URL parameters for a normal session, the way Stake's launcher sends them. `undefined` leaves one out. */
  params(extra: Record<string, string | undefined> = {}): Record<string, string> {
    const params: Record<string, string | undefined> = {
      sessionID: this.rgs.sessionID,
      rgs_url: this.host,
      lang: 'en',
      currency: this.rgs.currency,
      device: this.mobile ? 'mobile' : 'desktop',
      social: 'false',
      ...extra,
    };
    return Object.fromEntries(Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined));
  }

  url(params: Record<string, string>): string {
    return `${this.run.origin}${this.run.prefix}index.html?${new URLSearchParams(params)}`;
  }

  /**
   * Opens the game. With `authenticate`, waits for /wallet/authenticate and for the loading to finish.
   * Returns false (with a finding) if the game doesn't get that far.
   */
  async load(params: Record<string, string> = this.params(), { authenticate = true }: { authenticate?: boolean } = {}): Promise<boolean> {
    const started = Date.now();
    try {
      await this.page.goto(this.url(params), { waitUntil: 'commit', timeout: this.timeouts.load });
    } catch (error) {
      this.flag('error', 'load/page', `The page didn't open: ${clip(errorMessage(error), 160)}`);
      return false;
    }
    if (authenticate) {
      const called = () => this.rgs.count('/wallet/authenticate') > 0;
      // some games only authenticate after a "click to start" screen
      if (!(await until(called, Math.min(8000, this.timeouts.load), 200))) {
        await this.quiet();
        if (!called() && !(await this.start())) await this.click(0.5, 0.5);
      }
      if (!(await until(called, this.timeouts.load, 200))) {
        this.flag('error', 'load/authenticate', `Never called /wallet/authenticate (waited ${this.timeouts.load / 1000} s)`);
        return false;
      }
      this.authenticatedAfter = Date.now() - started;
    }
    await this.quiet();
    await this.loaded();
    return true;
  }

  /** Waits for the game to stop loading files: nothing in flight for a moment, 30 s at most. */
  async quiet(calm = 1500): Promise<void> {
    await until(() => this.inflight.size === 0 && Date.now() - this.lastRequestAt > calm, 30_000, 200);
    await sleep(500);
  }

  /**
   * Waits while the game is still on its loading screen: the page says "loading", or the game drew a
   * "loading" text in the last few seconds (so a game that carries on in bitmap text isn't held up).
   */
  async loaded(): Promise<void> {
    const loading = () =>
      this.page
        .evaluate(() => ({ recent: window.__preflight?.recent(3) ?? [], html: document.body?.innerText ?? '' }))
        .then(({ recent, html }) => LOADING.test(html) || recent.some(({ text, age }) => age < 6000 && LOADING.test(text)))
        .catch(() => false);
    if (!(await loading())) return;
    await until(async () => !(await loading()), 30_000, 500);
    await sleep(1000);
  }

  /**
   * Gets past an intro screen: the configured steps, or a visible button that says continue, start or play.
   * Returns whether it did anything.
   */
  async start(): Promise<boolean> {
    if (this.config.start.length) {
      await this.steps(this.config.start);
      await sleep(800);
      return true;
    }
    for (const button of await this.page.locator('button:visible, [role="button"]:visible').all()) {
      const text = (await button.innerText().catch(() => '')).trim();
      if (!INTRO.test(text)) continue;
      await button.click({ timeout: 2000 }).catch(() => {});
      await sleep(1200);
      return true;
    }
    return false;
  }

  /**
   * Starts a round. If no bet goes out, tries again: the game may still be busy, or behind an intro screen.
   * Returns the /wallet/play call, or null.
   */
  async spin(): Promise<Call | null> {
    const before = this.rgs.playCalls.length;
    const sent = () => this.rgs.playCalls.length > before || (this.rgs.waiting.get('/wallet/play') ?? 0) > 0;
    const attempts = [
      () => this.steps(this.config.spin),
      () => this.steps(this.config.spin),
      async () => {
        await this.start();
        await this.steps(this.config.spin);
      },
      async () => {
        await this.click(0.5, 0.5);
        await sleep(600);
        await this.steps(this.config.spin);
      },
      async () => {
        await this.press('Enter');
        await sleep(600);
        await this.steps(this.config.spin);
      },
    ];
    for (const attempt of attempts) {
      await attempt();
      if (await until(sent, 3500)) {
        // with a slow RGS the bet has gone out but isn't answered yet
        await until(() => this.rgs.playCalls.length > before, 60_000);
        return this.rgs.playCalls[before] ?? null;
      }
    }
    return null;
  }

  /**
   * Waits for a round to finish: a win is done when the game calls /wallet/end-round. Intro and result
   * cards often wait for a press, so when the round goes quiet the spin input is pressed again.
   */
  async finish(play: { round?: Pick<Round, 'betID' | 'active'> } | null): Promise<Finish> {
    const round = play?.round;
    if (!round || !round.active) return { ok: Boolean(round), nudges: 0 };
    const started = Date.now();
    let nudges = 0;
    let nudged = started;
    while (!this.rgs.isEnded(round.betID)) {
      // a long bonus round that keeps saving its progress isn't stuck; one that goes quiet is
      const now = Date.now();
      const idle = now - Math.max(started, this.rgs.lastRoundCallAt);
      if (idle > this.timeouts.round || now - started > this.timeouts.round * 5) return { ok: false, nudges, waited: now - started };
      const quietFor = now - Math.max(nudged, this.rgs.lastRoundCallAt);
      if (quietFor > 4000 && !this.rgs.isEnded(round.betID)) {
        await this.steps(this.config.spin);
        nudges += 1;
        nudged = Date.now();
      }
      await sleep(250);
    }
    return { ok: true, nudges, took: Date.now() - started };
  }

  /** Waits until no request waits for an answer and no round is open, pressing on like `finish`. */
  async drain(): Promise<Finish> {
    await until(() => !this.rgs.busy, 30_000, 100);
    const open = this.rgs.active;
    return open ? this.finish({ round: open }) : { ok: true, nudges: 0 };
  }

  /** Plays one round with screenshots while it spins and after it settles. */
  async round(caption: string, { settle = 2500 }: { settle?: number } = {}): Promise<Played | null> {
    const mark = await this.frameMark();
    const play = await this.spin();
    if (!play) return null;
    await sleep(1200);
    await this.shot(`${caption}, spinning`);
    const result = await this.finish(play);
    await sleep(settle);
    await this.shot(`${caption}, done`);
    return { play, result, frames: await this.frames(mark) };
  }

  async steps(list: readonly Step[]): Promise<void> {
    for (const step of list) {
      if ('key' in step) await this.press(step.key);
      else if ('click' in step) await this.click(...step.click);
      else if ('wait' in step) await sleep(step.wait);
      else {
        const target = this.page.locator(step.selector).first();
        if (!(await target.count().catch(() => 0))) {
          this.flag('warn', 'config/step', `Nothing on the page matches "${step.selector}"`);
          continue;
        }
        // pressed even when disabled (mid-round), the way a player's click lands on it
        await target.click({ force: true, timeout: 500 }).catch(() => {});
      }
    }
  }

  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key).catch(() => {});
  }

  /** Clicks (or taps, on a phone) a point given as fractions of the screen. */
  async click(x: number, y: number): Promise<void> {
    const { width, height } = this.page.viewportSize() ?? { width: this.viewport[0], height: this.viewport[1] };
    const at: [number, number] = [Math.round(x * width), Math.round(y * height)];
    if (this.mobile) await this.page.touchscreen.tap(...at).catch(() => {});
    else await this.page.mouse.click(...at).catch(() => {});
  }

  async resize(width: number, height: number): Promise<void> {
    await this.page.setViewportSize({ width, height });
  }

  shot(caption: string): Promise<string | null> {
    return this.run.shot(this.page, `${this.label}: ${caption}`);
  }

  /** Every text the game drew (canvas, SVG) since `since`, plus what the page shows now. */
  async texts(since = 0): Promise<DrawnText[]> {
    try {
      const [drawn, html] = await this.page.evaluate(
        (since) => [window.__preflight?.texts(since) ?? [], window.__preflight?.domText() ?? document.body?.innerText ?? ''] as const,
        since,
      );
      const shown = html
        .split('\n')
        .map((text) => text.trim())
        .filter(Boolean)
        .map((text) => ({ text, source: 'html' }));
      return [...drawn, ...shown];
    } catch {
      return [];
    }
  }

  async now(): Promise<number> {
    return this.page.evaluate(() => window.__preflight?.now() ?? performance.now()).catch(() => 0);
  }

  async frameMark(): Promise<number> {
    return this.page.evaluate(() => window.__preflight?.frameMark() ?? 0).catch(() => 0);
  }

  async frames(mark = 0): Promise<number[]> {
    return this.page.evaluate((mark) => window.__preflight?.frames(mark) ?? [], mark).catch(() => []);
  }

  async memory(): Promise<number | null> {
    return this.page.evaluate(() => window.__preflight?.memory() ?? null).catch(() => null);
  }

  /** Scroll size, viewport meta and canvas, for the layout checks. */
  async layout(): Promise<Layout | null> {
    return this.page
      .evaluate(() => {
        const root = document.scrollingElement ?? document.documentElement;
        return {
          width: innerWidth,
          height: innerHeight,
          scrollWidth: root.scrollWidth,
          scrollHeight: root.scrollHeight,
          viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? null,
          canvas: Boolean(document.querySelector('canvas')),
        };
      })
      .catch(() => null);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.context?.close().catch(() => {});
  }
}
