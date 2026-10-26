import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { preflight, SCENARIOS } from './index.js';
import { printSummary, progressPrinter } from './report/terminal.js';

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
      --browser <path>  a Chrome or Chromium to use instead of the installed Chrome
      --strict          exit with an error on warnings too
  -h, --help
  -v, --version

Checks: ${SCENARIOS.map((scenario) => scenario.name).join(', ')}
`;

export async function main(argv = process.argv.slice(2)) {
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
        browser: { type: 'string' },
        strict: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    return fail(`${error.message}\n\n${HELP}`);
  }
  const { values, positionals } = args;
  if (values.version) {
    const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(version);
    return 0;
  }
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (positionals.length !== 1) return fail(HELP);

  const names = new Set(SCENARIOS.map((scenario) => scenario.name));
  const list = (value) => (value ? value.split(',').map((name) => name.trim()).filter(Boolean) : undefined);
  const only = list(values.only);
  const skip = list(values.skip);
  const unknown = [...(only ?? []), ...(skip ?? [])].filter((name) => !names.has(name));
  if (unknown.length) return fail(`Unknown check: ${unknown.join(', ')}. The checks are ${[...names].join(', ')}.`);
  const jobs = values.jobs === undefined ? 2 : Number(values.jobs);
  if (!Number.isInteger(jobs) || jobs < 1) return fail('--jobs takes a whole number above 0');

  const [build] = positionals;
  if (!fs.existsSync(build)) return fail(`No such folder: ${build}`);
  if (values.math && !fs.existsSync(values.math)) return fail(`No such folder: ${values.math}`);

  let config;
  try {
    config = loadConfig(values.config);
  } catch (error) {
    return fail(error.message);
  }

  console.log(`\nstake-preflight · ${build}${values.math ? ` · ${values.math}` : ''}\n`);
  let report;
  try {
    report = await preflight({
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
    });
  } catch (error) {
    return fail(error.message);
  }
  printSummary(report);
  console.log('');
  return report.summary.errors || (values.strict && report.summary.warnings) ? 1 : 0;
}

function fail(message) {
  console.error(message);
  return 2;
}
