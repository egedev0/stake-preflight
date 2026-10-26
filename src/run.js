import path from 'node:path';
import { Findings } from './findings.js';
import { Session } from './session.js';

/** What a scenario works with: the browser, the books, its own findings, screenshots and notes. */
export class ScenarioRun {
  constructor(shared, scenario) {
    this.name = scenario.name;
    this.title = scenario.title;
    this.browser = shared.browser;
    this.origin = shared.origin;
    this.prefix = shared.prefix;
    this.config = shared.config;
    this.out = shared.out;
    this.quick = shared.quick;
    /** The game's own name (its page title); its words are never "restricted" in social mode. */
    this.gameTitle = shared.title;
    /** Modes by lowercase name, each with the books it plays; empty without --math. */
    this.modes = shared.modes;
    this.base = shared.base;
    this.findings = new Findings();
    this.notes = [];
    this.shots = [];
    this.shotCount = 0;
    this.sessions = [];
    this.warnings = new Set();
  }

  get hasBooks() {
    return Boolean(this.base);
  }

  note(text) {
    this.notes.push(text);
  }

  /**
   * Opens a session, hands it to `fn` and closes it afterwards, so a scenario never keeps pages open
   * that it's done with. The session's RGS calls stay in the report.
   * @template T
   * @param {ConstructorParameters<typeof Session>[1]} options
   * @param {(session: Session) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async use(options, fn) {
    const session = new Session(this, options);
    this.sessions.push(session);
    try {
      await session.open();
      return await fn(session);
    } finally {
      await session.close();
    }
  }

  async shot(page, caption) {
    this.shotCount += 1;
    const file = `shots/${this.name}-${String(this.shotCount).padStart(3, '0')}.jpg`;
    const entry = { file, caption };
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
  calls() {
    return this.sessions.flatMap((session) =>
      session.rgs.calls.map(({ at, method, path: endpoint, body, status, error, round }) => ({
        session: session.label,
        at,
        method,
        path: endpoint,
        status,
        error,
        round,
        mode: body?.mode,
        amount: body?.amount,
        event: body?.event,
      })),
    );
  }

  async close() {
    await Promise.all(this.sessions.map((session) => session.close()));
    if (this.warnings.size) {
      this.findings.info('console/warning', `${this.warnings.size} different console warnings`, {
        detail: [...this.warnings].slice(0, 5).join('\n'),
      });
    }
  }
}
