import path from 'node:path';
import { formatDuration, plural } from '../util.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const red = paint(31);
const yellow = paint(33);
const green = paint(32);
const dim = paint(2);
const bold = paint(1);

const MARK = { ok: green('✓'), warn: yellow('!'), error: red('✗'), skipped: dim('–') };

/** Prints one line per section as it finishes. */
export function progressPrinter(write = (line) => process.stdout.write(`${line}\n`)) {
  return (event) => {
    if (event.type !== 'done') return;
    const { section } = event;
    const errors = section.findings.count('error');
    const warnings = section.findings.count('warn');
    let what;
    if (section.status === 'skipped') what = dim(`skipped: ${section.reason}`);
    else if (errors || warnings) {
      what = [errors && red(plural(errors, 'error')), warnings && yellow(plural(warnings, 'warning'))].filter(Boolean).join(', ');
    } else what = green('passed');
    const time = section.status === 'skipped' ? '' : dim(formatDuration(section.duration).padStart(9));
    write(`  ${MARK[section.status] ?? ' '} ${section.title.padEnd(24)} ${time}  ${what}`);
  };
}

/** The findings that need attention and where the report is. */
export function printSummary(report, write = (line) => process.stdout.write(`${line}\n`)) {
  const issues = report.sections.flatMap((section) =>
    section.findings.filter((finding) => finding.level !== 'info').map((finding) => ({ ...finding, section: section.title })),
  );
  issues.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
  if (issues.length) {
    write('');
    for (const item of issues.slice(0, 30)) {
      const mark = item.level === 'error' ? red('✗') : yellow('!');
      const count = item.count > 1 ? dim(` ×${item.count}`) : '';
      const where = item.where?.length ? dim(` (${item.where.join(', ')})`) : '';
      write(`  ${mark} ${bold(item.section)}: ${item.message}${count}${where}`);
    }
    if (issues.length > 30) write(dim(`  …and ${issues.length - 30} more in the report`));
  }
  const { errors, warnings } = report.summary;
  const verdict = errors ? red(plural(errors, 'error')) : green('no errors');
  write('');
  write(`  ${verdict}, ${warnings ? yellow(plural(warnings, 'warning')) : 'no warnings'} in ${formatDuration(report.duration)}`);
  const file = path.join(report.out, 'index.html');
  const relative = path.relative(process.cwd(), file);
  write(`  Report: ${relative.startsWith('..') ? file : relative}`);
}
