import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { preflight, SCENARIOS } from './index.ts';
import { printSummary, progressPrinter } from './report/terminal.ts';
import type { Config } from './types.ts';
import { errorMessage } from './util.ts';

const HELP = `Usage: stake-preflight <build> [options]

Plays a Stake Engine game build against a mock RGS and reports what review tends to send back.

Arguments:
  build                 the folder you upload as the frontend (with index.html)

Options:
  -m, --math <dir>      the math publish folder (index.json, lookUpTable_*.csv, books_*.jsonl.zst);
                        without it, the checks that play rounds are skipped
  -o, --out <dir>       where the report goes (default: preflight-report)
  -c, --config <file>   settings (default: preflight.config.json if there is one)
      --quick           fewer checks and variants, about two minutes
      --only <names>    run only these checks, comma separated
      --skip <names>    skip these checks
      --deep            check every book against its lookup table (slow on big books)
  -j, --jobs <n>        checks to run side by side (default: 2)
      --headed          show the browser while it runs
      --open            open the report when it's done
      --browser <path>  a Chrome or Chromium to use instead of the installed Chrome
      --strict          exit with an error on warnings too
  -h, --help
  -v, --version

Checks: ${SCENARIOS.map((scenario) => scenario.name).join(', ')}

Exit codes: 0 nothing failed, 1 a check failed, 2 it couldn't run, 130 stopped with Ctrl+C.
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        math: { type: 'string', short: 'm' },
        out: { type: 'string', short: 'o' },
        config: { type: 'string', short: 'c' },
        quick: { type: 'boolean' },
        only: { type: 'string' },
        skip: { type: 'string' },
        deep: { type: 'boolean' },
        jobs: { type: 'string', short: 'j' },
        headed: { type: 'boolean' },
        open: { type: 'boolean' },
        browser: { type: 'string' },
        strict: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    return fail(`${errorMessage(error)}\n\n${HELP}`);
  }
  const { values, positionals } = args;
  if (values.version) {
    const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    console.log(version);
    return 0;
  }
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const [build] = positionals;
  if (!build || positionals.length !== 1) return fail(HELP);

  const names = new Set(SCENARIOS.map((scenario) => scenario.name));
  const list = (value: string | undefined) => (value ? value.split(',').map((name) => name.trim()).filter(Boolean) : undefined);
  const only = list(values.only);
  const skip = list(values.skip);
  const unknown = [...(only ?? []), ...(skip ?? [])].filter((name) => !names.has(name));
  if (unknown.length) return fail(`Unknown check: ${unknown.join(', ')}. The checks are ${[...names].join(', ')}.`);
  const jobs = values.jobs === undefined ? 2 : Number(values.jobs);
  if (!Number.isInteger(jobs) || jobs < 1) return fail('--jobs takes a whole number above 0');

  if (!fs.existsSync(build)) return fail(`No such folder: ${build}`);
  if (values.math && !fs.existsSync(values.math)) return fail(`No such folder: ${values.math}`);

  let config: Config;
  try {
    config = loadConfig(values.config);
  } catch (error) {
    return fail(errorMessage(error));
  }

  // Ctrl+C stops the run and still writes the report of what ran; a second one quits at once.
  // Under npx or npm run one press arrives twice (from the terminal, and passed on by npm), so a
  // repeat right after the first doesn't count.
  const stop = new AbortController();
  let stoppedAt = 0;
  const onInterrupt = () => {
    if (stop.signal.aborted) {
      if (Date.now() - stoppedAt > 1000) process.exit(130);
      return;
    }
    stoppedAt = Date.now();
    process.stdout.write('\n  Stopping. Ctrl+C again to quit at once.\n');
    stop.abort();
  };
  process.on('SIGINT', onInterrupt);
  keepAwake();

  console.log(`\nstake-preflight · ${build}${values.math ? ` · ${values.math}` : ''}\n`);
  try {
    const report = await preflight({
      build,
      math: values.math,
      out: values.out,
      config,
      only,
      skip,
      quick: values.quick,
      deep: values.deep,
      jobs,
      headed: values.headed,
      browser: values.browser,
      onProgress: progressPrinter(),
      signal: stop.signal,
    });
    printSummary(report);
    console.log('');
    if (values.open) openFile(path.join(report.out, 'index.html'));
    if (report.stopped) return 130;
    return report.summary.errors || (values.strict && report.summary.warnings) ? 1 : 0;
  } catch (error) {
    return fail(errorMessage(error));
  } finally {
    process.off('SIGINT', onInterrupt);
  }
}

function fail(message: string): number {
  console.error(message);
  return 2;
}

/** A run takes minutes; on a Mac, keep it from going to sleep while it's idle (caffeinate ends with us). */
function keepAwake(): void {
  if (process.platform !== 'darwin') return;
  try {
    spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }).on('error', () => {}).unref();
  } catch {}
}

function openFile(file: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', file] : [file];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
}
