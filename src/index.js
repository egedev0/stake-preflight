import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from './browser.js';
import { checkBuild } from './build.js';
import { loadConfig } from './config.js';
import { Findings } from './findings.js';
import { loadMath } from './math.js';
import { writeReport } from './report/html.js';
import { ScenarioRun } from './run.js';
import { SCENARIOS } from './scenarios/index.js';
import { serveBuild } from './server.js';
import { mapLimit } from './util.js';

export { DEFAULTS, loadConfig } from './config.js';
export { SCENARIOS } from './scenarios/index.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** The scenarios a quick run keeps. */
const QUICK = ['load', 'play', 'resume', 'replay', 'social', 'flags', 'screens'];

/**
 * Checks a Stake Engine game build and writes a report.
 * @param {object} options
 * @param {string} options.build the build folder (with index.html)
 * @param {string} [options.math] the math-sdk publish folder (index.json, lookup tables, books)
 * @param {string} [options.out] where the report goes
 * @param {object} [options.config] settings (see config.js); read from preflight.config.json when left out
 * @param {string[]} [options.only] run only these scenarios
 * @param {string[]} [options.skip] skip these scenarios
 * @param {boolean} [options.quick] fewer scenarios and variants
 * @param {boolean} [options.deep] check every book against its lookup table
 * @param {number} [options.jobs] scenarios run side by side
 * @param {boolean} [options.headed] show the browser
 * @param {string} [options.browser] a Chrome or Chromium to use
 * @param {(event: object) => void} [options.onProgress]
 */
export async function preflight(options) {
  const started = Date.now();
  const config = options.config ?? loadConfig();
  const out = path.resolve(options.out ?? 'preflight-report');
  const emit = options.onProgress ?? (() => {});
  await prepareOut(out);

  const sections = [];
  const section = (name, title) => {
    const item = { name, title, findings: new Findings(), notes: [], shots: [], calls: [], startedAt: Date.now() };
    sections.push(item);
    emit({ type: 'start', name, title });
    return item;
  };
  const done = (item, extra = {}) => {
    Object.assign(item, extra, { duration: Date.now() - item.startedAt, status: extra.status ?? item.findings.status });
    emit({ type: 'done', section: item });
  };

  const build = section('build', 'Build');
  const buildInfo = await checkBuild(options.build, build.findings);
  done(build, { data: buildInfo && { ...buildInfo, paths: undefined } });

  let math = { stats: [], modes: {}, base: null };
  if (options.math) {
    const item = section('math', 'Math');
    try {
      math = await loadMath(options.math, item.findings, { deep: options.deep, limits: config.limits });
    } catch (error) {
      item.findings.error('math/index', error.message);
    }
    done(item, { data: { modes: math.stats, deep: Boolean(options.deep) } });
  }

  const wanted = SCENARIOS.filter((scenario) => {
    if (options.only?.length) return options.only.includes(scenario.name);
    if (options.skip?.includes(scenario.name)) return false;
    return !options.quick || QUICK.includes(scenario.name);
  });

  if (!buildInfo) {
    for (const scenario of wanted) done(section(scenario.name, scenario.title), { status: 'skipped', reason: 'No index.html in the build folder' });
  } else if (wanted.length) {
    // the URL carries the folder encoded; the server compares it decoded, and only to the build's own files
    const prefix = `/${encodeURIComponent(config.game)}/${encodeURIComponent(config.version)}/`;
    const server = await serveBuild(options.build, `/${config.game}/${config.version}/`, new Set(buildInfo.paths));
    let browser;
    try {
      browser = await launchBrowser({ executablePath: options.browser, headed: options.headed });
      const shared = {
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
      const runScenario = async (scenario) => {
        const item = section(scenario.name, scenario.title);
        if (scenario.needsBooks && !math.base) {
          done(item, { status: 'skipped', reason: options.math ? 'No playable books in the math folder' : 'Needs the math folder (--math)' });
          return item;
        }
        const run = new ScenarioRun(shared, scenario);
        try {
          await scenario.run(run);
        } catch (error) {
          run.findings.error('preflight/crash', `This check stopped early: ${error.message}`, { detail: error.stack });
        } finally {
          await run.close();
        }
        Object.assign(item, { findings: run.findings, notes: run.notes, shots: run.shots, calls: run.calls() });
        done(item);
        return item;
      };

      const [first, ...rest] = wanted;
      const opened = await runScenario(first);
      const blocked = first.name === 'load' && opened.findings.items.some((finding) => finding.check.startsWith('load/'));
      if (blocked) {
        for (const scenario of rest) {
          done(section(scenario.name, scenario.title), { status: 'skipped', reason: "The game didn't load, so this didn't run" });
        }
      } else {
        await mapLimit(rest, Math.max(1, options.jobs ?? 2), runScenario);
      }
    } finally {
      await browser?.close().catch(() => {});
      await server.close();
    }
  }

  const order = ['build', 'math', ...SCENARIOS.map((scenario) => scenario.name)];
  sections.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  const report = {
    tool: { name: 'stake-preflight', version: VERSION },
    build: path.resolve(options.build),
    math: options.math ? path.resolve(options.math) : null,
    title: buildInfo?.title ?? path.basename(path.resolve(options.build)),
    game: config.game,
    startedAt: new Date(started).toISOString(),
    duration: Date.now() - started,
    quick: Boolean(options.quick),
    sections: sections.map(({ findings, startedAt, ...rest }) => ({ ...rest, findings: findings.items })),
  };
  report.summary = {
    errors: count(report, 'error'),
    warnings: count(report, 'warn'),
    passed: report.sections.filter((item) => item.status === 'ok').length,
    skipped: report.sections.filter((item) => item.status === 'skipped').length,
    sections: report.sections.length,
  };
  await writeReport(out, report);
  return { ...report, out };
}

const count = (report, level) => report.sections.reduce((sum, item) => sum + item.findings.filter((finding) => finding.level === level).length, 0);

/** Clears the screenshots of the last run; leaves anything else in the folder alone. */
async function prepareOut(out) {
  const shots = path.join(out, 'shots');
  await fs.promises.mkdir(shots, { recursive: true });
  for (const name of await fs.promises.readdir(shots)) {
    if (/^[a-z]+-\d{3}\.jpg$/.test(name)) await fs.promises.rm(path.join(shots, name));
  }
}
