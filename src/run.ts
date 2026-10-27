import path from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { Findings } from './findings.ts';
import { Session } from './session.ts';
import type { SessionOptions } from './session.ts';
import type { CallRecord, Config, PlayMode, Shot } from './types.ts';

/** What every scenario shares: the browser, the served build, the config and the books. */
export interface Shared {
  browser: Browser;
  /** where the build is served */
  origin: string;
  /** the build's folder in URLs, e.g. "/game/1/" */
  prefix: string;
  config: Config;
  /** the report folder */
  out: string;
  quick: boolean;
  /** the game's page title */
  title: string | null;
  modes: Record<string, PlayMode>;
  base: PlayMode | null;
}

/** A check that drives the game. */
export interface Scenario {
  name: string;
  title: string;
  /** skipped without the math folder */
  needsBooks?: boolean;
  run(t: ScenarioRun): Promise<void>;
}

/** What a scenario works with: the browser, the books, its own findings, screenshots and notes. */
export class ScenarioRun {
  readonly name: string;
  readonly title: string;
  readonly browser: Browser;
  readonly origin: string;
  readonly prefix: string;
  readonly config: Config;
  readonly out: string;
  readonly quick: boolean;
  /** The game's own name (its page title); its words are never "restricted" in social mode. */
  readonly gameTitle: string | null;
  /** Modes by lowercase name, each with the books it plays; empty without --math. */
  readonly modes: Record<string, PlayMode>;
  private readonly baseMode: PlayMode | null;
  readonly findings = new Findings();
  readonly notes: string[] = [];
  readonly shots: Shot[] = [];
  readonly warnings = new Set<string>();
  private readonly sessions: Session[] = [];
  private shotCount = 0;

  constructor(shared: Shared, scenario: Scenario) {
    this.name = scenario.name;
    this.title = scenario.title;
    this.browser = shared.browser;
    this.origin = shared.origin;
    this.prefix = shared.prefix;
    this.config = shared.config;
    this.out = shared.out;
    this.quick = shared.quick;
    this.gameTitle = shared.title;
    this.modes = shared.modes;
    this.baseMode = shared.base;
  }

  get hasBooks(): boolean {
    return Boolean(this.baseMode);
  }

  /** The mode the base game plays. Only call it in scenarios that need books. */
  get base(): PlayMode {
    if (!this.baseMode) throw new Error(`The ${this.name} check needs the math folder`);
    return this.baseMode;
  }

  note(text: string): void {
    this.notes.push(text);
  }

  /**
   * Opens a session, hands it to `fn` and closes it afterwards, so a scenario never keeps pages open
   * that it's done with. The session's RGS calls stay in the report.
   */
  async use<T>(options: SessionOptions, fn: (session: Session) => Promise<T>): Promise<T> {
    const session = new Session(this, options);
    this.sessions.push(session);
    try {
      await session.open();
      return await fn(session);
    } finally {
      await session.close();
    }
  }

  async shot(page: Page, caption: string): Promise<string | null> {
    this.shotCount += 1;
    const file = `shots/${this.name}-${String(this.shotCount).padStart(3, '0')}.jpg`;
    const entry: Shot = { file, caption };
    this.shots.push(entry);
    try {
      await page.screenshot({ path: path.join(this.out, file), type: 'jpeg', quality: 72, timeout: 15_000 });
      return file;
    } catch {
      this.shots.splice(this.shots.indexOf(entry), 1);
      return null;
    }
  }

  /** Every RGS call of every session, oldest first per session. */
  calls(): CallRecord[] {
    return this.sessions.flatMap((session) =>
      session.rgs.calls.map(({ at, method, path: endpoint, body, status, error, round }) => ({
        session: session.label,
        at,
        method,
        path: endpoint,
        ...(status !== undefined ? { status } : {}),
        ...(error !== undefined ? { error } : {}),
        ...(round !== undefined ? { round } : {}),
        mode: body.mode,
        amount: body.amount,
        event: body.event,
      })),
    );
  }

  async close(): Promise<void> {
    await Promise.all(this.sessions.map((session) => session.close()));
    if (this.warnings.size) {
      this.findings.info('console/warning', `${this.warnings.size} different console warnings`, {
        detail: [...this.warnings].slice(0, 5).join('\n'),
      });
    }
  }
}
