import path from 'node:path';
import type { Findings } from '../findings.ts';
import type { Report, Status } from '../types.ts';
import { formatDuration, plural } from '../util.ts';

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: number) => (text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const red = paint(31);
const yellow = paint(33);
const green = paint(32);
const dim = paint(2);
const bold = paint(1);

const MARK: Record<Status, string> = { ok: green('✓'), warn: yellow('!'), error: red('✗'), skipped: dim('–') };

/** What preflight() reports while it runs. */
export type ProgressEvent =
  | { type: 'start'; name: string; title: string }
  | {
      type: 'done';
      section: { name: string; title: string; status: Status; duration: number; findings: Findings; reason?: string };
    };

/**
 * Prints one line per section as it finishes. On a terminal, the checks still running are shown on a
 * line under them.
 */
export function progressPrinter(stream: NodeJS.WriteStream = process.stdout): (event: ProgressEvent) => void {
  const live = Boolean(stream.isTTY) && !process.env.CI;
  const running: string[] = [];
  let shown = false;
  const clear = () => {
    if (shown) stream.write('\r\x1b[2K');
    shown = false;
  };
  const draw = () => {
    if (!live || !running.length) return;
    const room = Math.max(20, (stream.columns || 80) - 6);
    const text = running.join(', ');
    stream.write(dim(`  … ${text.length > room ? `${text.slice(0, room - 1)}…` : text}`));
    shown = true;
  };
  return (event) => {
    if (event.type === 'start') {
      running.push(event.title);
      clear();
      draw();
      return;
    }
    const { section } = event;
    const index = running.indexOf(section.title);
    if (index >= 0) running.splice(index, 1);
    const errors = section.findings.count('error');
    const warnings = section.findings.count('warn');
    let what: string;
    if (section.status === 'skipped') what = dim(`skipped: ${section.reason ?? ''}`);
    else if (errors || warnings) {
      what = [errors ? red(plural(errors, 'error')) : '', warnings ? yellow(plural(warnings, 'warning')) : ''].filter(Boolean).join(', ');
    } else what = green('passed');
    const time = section.status === 'skipped' ? ''.padStart(9) : dim(formatDuration(section.duration).padStart(9));
    clear();
    stream.write(`  ${MARK[section.status]} ${section.title.padEnd(24)} ${time}  ${what}\n`);
    draw();
  };
}

/** The findings that need attention and where the report is. */
export function printSummary(report: Report & { out: string }, write = (line: string) => process.stdout.write(`${line}\n`)): void {
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
  if (report.stopped) write(yellow('  Stopped before the end: the report covers what ran.'));
  write(`  ${verdict}, ${warnings ? yellow(plural(warnings, 'warning')) : 'no warnings'} in ${formatDuration(report.duration)}`);
  const file = path.join(report.out, 'index.html');
  const relative = path.relative(process.cwd(), file);
  write(`  Report: ${relative.startsWith('..') ? file : relative}`);
}
