import { setMaxListeners } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { Browser } from 'playwright-core';
import { launchBrowser } from './browser.ts';
import { checkBuild } from './build.ts';
import { loadConfig } from './config.ts';
import { Findings } from './findings.ts';
import { loadMath } from './math.ts';
import type { MathResult } from './math.ts';
import { writeReport } from './report/html.ts';
import type { ProgressEvent } from './report/terminal.ts';
import { ScenarioRun } from './run.ts';
import type { Scenario, Shared } from './run.ts';
import { SCENARIOS } from './scenarios/index.ts';
import { serveBuild } from './server.ts';
import type { CallRecord, Config, Level, Report, Section, Shot, Status } from './types.ts';
import { errorMessage, mapLimit, stoppable } from './util.ts';

export { DEFAULTS, loadConfig } from './config.ts';
export { SCENARIOS } from './scenarios/index.ts';
export type { ProgressEvent } from './report/terminal.ts';
export type * from './types.ts';

const VERSION: string = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** The scenarios a quick run keeps. */
const QUICK = new Set(['load', 'play', 'resume', 'replay', 'social', 'flags', 'screens']);

export interface PreflightOptions {
  /** the build folder (with index.html) */
  build: string;
  /** the math-sdk publish folder (index.json, lookup tables, books) */
  math?: string | undefined;
  /** where the report goes (default preflight-report) */
  out?: string | undefined;
  /** settings; read from preflight.config.json when left out */
  config?: Config;
  /** run only these scenarios */
  only?: readonly string[] | undefined;
  /** skip these scenarios */
  skip?: readonly string[] | undefined;
  /** fewer scenarios and variants */
  quick?: boolean | undefined;
  /** check every book against its lookup table */
  deep?: boolean | undefined;
  /** scenarios run side by side (default 2) */
  jobs?: number | undefined;
  /** show the browser */
  headed?: boolean | undefined;
  /** a Chrome or Chromium to use */
  browser?: string | undefined;
  onProgress?: (event: ProgressEvent) => void;
  /** stops the run: the checks still to come are skipped, the report covers what ran */
  signal?: AbortSignal | undefined;
}

/** A section while it's being filled. */
interface Working {
  name: string;
  title: string;
  status: Status;
  duration: number;
  findings: Findings;
  notes: string[];
  shots: Shot[];
  calls: CallRecord[];
  reason?: string;
  data?: unknown;
  startedAt: number;
}

/** Checks a Stake Engine game build and writes a report. */
export async function preflight(options: PreflightOptions): Promise<Report & { out: string }> {
  const started = Date.now();
  const config = options.config ?? loadConfig();
  const out = path.resolve(options.out ?? 'preflight-report');
  const emit = options.onProgress ?? (() => {});
  // the waits of every running check listen on this one (0: no listener limit), which the caller's signal fires
  const halt = options.signal ? AbortSignal.any([options.signal]) : new AbortController().signal;
  setMaxListeners(0, halt);
  const stopped = () => halt.aborted;
  await prepareOut(out);

  const sections: Working[] = [];
  const section = (name: string, title: string): Working => {
    const item: Working = { name, title, status: 'ok', duration: 0, findings: new Findings(), notes: [], shots: [], calls: [], startedAt: Date.now() };
    sections.push(item);
    emit({ type: 'start', name, title });
    return item;
  };
  const done = (item: Working, extra: Partial<Pick<Working, 'status' | 'reason' | 'data'>> = {}) => {
    Object.assign(item, extra, { duration: Date.now() - item.startedAt, status: extra.status ?? item.findings.status });
    emit({ type: 'done', section: item });
  };
  const skip = (scenario: Scenario, reason: string): Working => {
    const item = section(scenario.name, scenario.title);
    done(item, { status: 'skipped', reason });
    return item;
  };
  // set only when the stop kept something from running, not when it lands after the last check
  let interrupted = false;
  const notRun = (scenario: Scenario): Working => {
    interrupted = true;
    return skip(scenario, 'Stopped before it ran');
  };

  const build = section('build', 'Build');
  const buildInfo = await checkBuild(options.build, build.findings);
  done(build, { data: buildInfo && { ...buildInfo, paths: undefined } });

  let math: MathResult = { stats: [], modes: {}, base: null };
  const mathDir = options.math;
  if (mathDir) {
    const item = section('math', 'Math');
    try {
      math = await stoppable(halt, () => loadMath(mathDir, item.findings, { deep: Boolean(options.deep), limits: config.limits }));
    } catch (error) {
      if (!stopped()) item.findings.error('math/index', errorMessage(error));
    }
    if (stopped()) {
      interrupted = true;
      item.findings = new Findings();
      math = { stats: [], modes: {}, base: null };
      done(item, { status: 'skipped', reason: 'Stopped while it ran' });
    } else {
      done(item, { data: { modes: math.stats, deep: Boolean(options.deep) } });
    }
  }

  const wanted = SCENARIOS.filter((scenario) => {
    if (options.only?.length) return options.only.includes(scenario.name);
    if (options.skip?.includes(scenario.name)) return false;
    return !options.quick || QUICK.has(scenario.name);
  });

  if (!buildInfo) {
    for (const scenario of wanted) skip(scenario, 'No index.html in the build folder');
  } else if (wanted.length && !stopped()) {
    // the URL carries the folder encoded; the server compares it decoded, and only to the build's own files
    const prefix = `/${encodeURIComponent(config.game)}/${encodeURIComponent(config.version)}/`;
    const server = await serveBuild(options.build, `/${config.game}/${config.version}/`, new Set(buildInfo.paths));
    let browser: Browser | undefined;
    const onAbort = () => void browser?.close().catch(() => {});
    halt.addEventListener('abort', onAbort, { once: true });
    try {
      browser = await launchBrowser({ executablePath: options.browser, headed: options.headed, ownSigint: Boolean(options.signal) });
      const shared: Shared = {
        browser,
        origin: server.origin,
        prefix,
        config,
        out,
        quick: Boolean(options.quick),
        title: buildInfo.title,
        modes: math.modes,
        base: math.base,
      };
      const runScenario = async (scenario: Scenario): Promise<Working> => {
        if (stopped()) return notRun(scenario);
        const item = section(scenario.name, scenario.title);
        if (scenario.needsBooks && !math.base) {
          done(item, { status: 'skipped', reason: options.math ? 'No playable books in the math folder' : 'Needs the math folder (--math)' });
          return item;
        }
        const run = new ScenarioRun(shared, scenario);
        try {
          await stoppable(halt, () => scenario.run(run));
        } catch (error) {
          // after a stop the browser is gone, and everything that was using it throws
          if (!stopped()) {
            run.findings.error('preflight/crash', `This check stopped early: ${errorMessage(error)}`, {
              ...(error instanceof Error && error.stack ? { detail: error.stack } : {}),
            });
          }
        } finally {
          await run.close();
        }
        // a check cut short proves nothing either way, and the stop itself makes things fail
        const halted = stopped();
        if (halted) interrupted = true;
        Object.assign(item, { findings: halted ? new Findings() : run.findings, notes: run.notes, shots: run.shots, calls: run.calls() });
        done(item, halted ? { status: 'skipped', reason: 'Stopped while it ran' } : {});
        return item;
      };

      const [first, ...rest] = wanted;
      if (first) {
        const opened = await runScenario(first);
        const blocked = first.name === 'load' && opened.findings.items.some((finding) => finding.check.startsWith('load/'));
        if (blocked) {
          for (const scenario of rest) skip(scenario, "The game didn't load, so this didn't run");
        } else {
          await mapLimit(rest, Math.max(1, options.jobs ?? 2), runScenario);
        }
      }
    } finally {
      halt.removeEventListener('abort', onAbort);
      await browser?.close().catch(() => {});
      await server.close();
    }
  } else {
    for (const scenario of wanted) notRun(scenario);
  }

  const order = ['build', 'math', ...SCENARIOS.map((scenario) => scenario.name)];
  sections.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  const finished: Section[] = sections.map(({ findings, startedAt, ...rest }) => ({ ...rest, findings: findings.items }));
  const count = (level: Level) => finished.reduce((sum, item) => sum + item.findings.filter((finding) => finding.level === level).length, 0);
  const report: Report = {
    tool: { name: 'stake-preflight', version: VERSION },
    build: path.resolve(options.build),
    math: options.math ? path.resolve(options.math) : null,
    title: buildInfo?.title ?? path.basename(path.resolve(options.build)),
    game: config.game,
    startedAt: new Date(started).toISOString(),
    duration: Date.now() - started,
    quick: Boolean(options.quick),
    stopped: interrupted,
    sections: finished,
    summary: {
      errors: count('error'),
      warnings: count('warn'),
      passed: finished.filter((item) => item.status === 'ok').length,
      skipped: finished.filter((item) => item.status === 'skipped').length,
      sections: finished.length,
    },
  };
  await writeReport(out, report);
  return { ...report, out };
}

/** Clears the screenshots of the last run; leaves anything else in the folder alone. */
async function prepareOut(out: string): Promise<void> {
  const shots = path.join(out, 'shots');
  await fs.promises.mkdir(shots, { recursive: true });
  for (const name of await fs.promises.readdir(shots)) {
    if (/^[a-z]+-\d{3}\.jpg$/.test(name)) await fs.promises.rm(path.join(shots, name));
  }
}
