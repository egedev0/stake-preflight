import fs from 'node:fs';
import path from 'node:path';
import { TAILS } from '../books.ts';
import type { BuildInfo } from '../build.ts';
import type { ModeReport } from '../math.ts';
import type { CallRecord, Finding, Level, Report, Section, Shot, Status } from '../types.ts';
import { formatAmount, formatBytes, formatDuration, formatMultiplier, formatOdds, formatPercent } from '../util.ts';

/** What the math section carries. */
export interface MathData {
  modes: ModeReport[];
  deep: boolean;
}

/** Writes report.json and index.html (with its screenshots next to it) to `out`. */
export async function writeReport(out: string, report: Report): Promise<void> {
  await fs.promises.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await fs.promises.writeFile(path.join(out, 'index.html'), renderHtml(report));
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char);

const STATUS: Record<Status, string> = { ok: 'Passed', warn: 'Warnings', error: 'Failed', skipped: 'Skipped' };
const LEVEL: Record<Level, string> = { error: 'Error', warn: 'Warning', info: 'Info' };

type Issue = Finding & { section: Section };

export function renderHtml(report: Report): string {
  const { summary } = report;
  const issues: Issue[] = report.sections.flatMap((section) =>
    section.findings.filter((finding) => finding.level !== 'info').map((finding) => ({ ...finding, section })),
  );
  issues.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
  const name = report.title;
  const date = new Date(report.startedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Preflight: ${esc(name)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
  <header>
    <p class="eyebrow">stake-preflight ${esc(report.tool.version)}${report.quick ? ' · quick run' : ''}</p>
    <h1>${esc(name)}</h1>
    <p class="meta">${esc(date)} · ${esc(formatDuration(report.duration))}${report.math ? ' · with math' : ' · no math folder'}</p>
    ${report.stopped ? `<p class="stopped">Stopped before the end: the checks marked skipped didn't run. Run it to the end before you submit.</p>` : ''}
  </header>

  <section class="summary">
    ${tile(summary.errors, 'errors', summary.errors ? 'error' : 'ok')}
    ${tile(summary.warnings, 'warnings', summary.warnings ? 'warn' : 'ok')}
    ${tile(`${summary.passed}/${summary.sections - summary.skipped}`, 'checks passed', 'plain')}
    ${summary.skipped ? tile(summary.skipped, 'skipped', 'plain') : ''}
  </section>

  ${verdict(report, issues)}

  ${report.sections.map(sectionCard).join('\n')}

  <footer>Made with <a href="https://github.com/egedev0/stake-preflight">stake-preflight</a>. Not affiliated with Stake.</footer>
</main>
</body>
</html>
`;
}

function verdict(report: Report, issues: readonly Issue[]): string {
  if (issues.length) return `<section><h2>Issues</h2><ul class="issues">${issues.map(issue).join('')}</ul></section>`;
  if (report.stopped) return '<section><p class="note">Nothing found in the checks that ran.</p></section>';
  return '<section><p class="clean">Nothing to fix. Look through the screenshots below before you submit.</p></section>';
}

/** The sessions a finding came from, when there's more than one session in its check. */
const where = (item: Finding) => (item.where?.length ? ` <span class="where">in ${esc(item.where.join(', '))}</span>` : '');

const tile = (value: unknown, label: string, tone: string) => `<div class="tile ${tone}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;

function issue(item: Issue): string {
  return `<li class="${item.level}">
    <span class="pill ${item.level}">${LEVEL[item.level]}</span>
    <div>
      <p><a href="#${esc(item.section.name)}">${esc(item.section.title)}</a> · ${esc(item.message)}${item.count > 1 ? ` <span class="count">×${item.count}</span>` : ''}${where(item)}</p>
      ${item.detail ? `<pre>${esc(item.detail)}</pre>` : ''}
      <code>${esc(item.check)}</code>${item.shot ? ` · <a href="${esc(item.shot)}">screenshot</a>` : ''}
    </div>
  </li>`;
}

function mathTable(math: Section): string {
  const data = math.data as MathData | undefined;
  const modes = data?.modes ?? [];
  if (!modes.length) return '';
  const tails = TAILS.filter((size) => modes.some((mode) => (mode.tails[size] ?? 0) > 0));
  return `<div class="scroll"><table>
      <thead><tr><th>Mode</th><th>Cost</th><th>Books</th><th>RTP</th><th>Hit rate</th><th>Volatility</th><th>Max win</th><th>Max win odds</th>${tails.map((size) => `<th>≥ ${size.toLocaleString('en-US')}×</th>`).join('')}</tr></thead>
      <tbody>${modes
        .map(
          (mode) => `<tr><td>${esc(mode.name)}</td><td>${esc(formatMultiplier(mode.cost))}</td><td>${mode.books.toLocaleString('en-US')}</td><td>${formatPercent(mode.rtp)}</td><td>${formatPercent(mode.hitRate, 1)}</td><td>${mode.volatility.toFixed(1)}</td><td>${esc(formatMultiplier(mode.maxWin))}</td><td>${esc(formatOdds(mode.maxWinChance))}</td>${tails.map((size) => `<td>${esc(formatOdds(mode.tails[size] ?? 0))}</td>`).join('')}</tr>`,
        )
        .join('')}</tbody>
    </table></div>
    <p class="note">Wins are multiples of the base bet. Volatility is the standard deviation of a round's return, in multiples of its cost.${data?.deep ? ' Every book was checked against its lookup table.' : ' Run with --deep to check every book against its lookup table.'}</p>`;
}

function sectionCard(section: Section): string {
  const findings = section.findings;
  let data = '';
  if (section.name === 'build' && section.data) data = buildData(section.data as BuildInfo);
  if (section.name === 'math') data = mathTable(section);
  return `<section class="card" id="${esc(section.name)}">
    <div class="head">
      <h2>${esc(section.title)}</h2>
      <span class="pill ${esc(section.status)}">${STATUS[section.status]}</span>
      <span class="time">${esc(formatDuration(section.duration))}</span>
    </div>
    ${section.reason ? `<p class="note">${esc(section.reason)}</p>` : ''}
    ${data}
    ${section.notes.length ? `<ul class="notes">${section.notes.map((note) => `<li>${esc(note)}</li>`).join('')}</ul>` : ''}
    ${findings.length ? `<ul class="findings">${findings.map(finding).join('')}</ul>` : ''}
    ${section.shots.length ? `<div class="shots">${section.shots.map(shot).join('')}</div>` : ''}
    ${section.calls.length ? callTable(section.calls) : ''}
  </section>`;
}

const finding = (item: Finding) =>
  `<li class="${item.level}"><span class="pill ${item.level}">${LEVEL[item.level]}</span> ${esc(item.message)}${item.count > 1 ? ` <span class="count">×${item.count}</span>` : ''}${where(item)}${item.detail ? `<pre>${esc(item.detail)}</pre>` : ''}</li>`;

const shot = (item: Shot) =>
  `<figure><a href="${esc(item.file)}"><img src="${esc(item.file)}" alt="${esc(item.caption)}" loading="lazy"></a><figcaption>${esc(item.caption)}</figcaption></figure>`;

function buildData(data: BuildInfo): string {
  return `<p class="note">${data.files.toLocaleString('en-US')} files, ${esc(formatBytes(data.bytes))}. Largest: ${data.biggest
    .map((file) => `${esc(file.path)} (${esc(formatBytes(file.size))})`)
    .join(', ')}</p>`;
}

function callTable(calls: readonly CallRecord[]): string {
  const rows = calls
    .map((call) => {
      const what = [
        call.mode !== undefined && `mode ${String(call.mode)}`,
        typeof call.amount === 'number' && Number.isFinite(call.amount) && `bet ${formatAmount(call.amount)}`,
        call.event !== undefined && `event ${String(call.event)}`,
        call.round && `${call.round.kind} book ${call.round.bookId}, ${formatMultiplier(call.round.payoutMultiplier)}`,
      ]
        .filter(Boolean)
        .join(', ');
      const status = call.error ? `${call.status ?? ''} ${call.error}` : (call.status ?? '');
      return `<tr><td>${esc(call.session)}</td><td>${esc((call.at / 1000).toFixed(1))} s</td><td>${esc(call.method)} ${esc(call.path)}</td><td class="${call.error ? 'bad' : ''}">${esc(status)}</td><td>${esc(what)}</td></tr>`;
    })
    .join('');
  return `<details><summary>RGS calls (${calls.length})</summary><div class="scroll"><table class="calls"><thead><tr><th>Session</th><th>Time</th><th>Call</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

const CSS = `
:root {
  --bg: #f5f6f8; --panel: #ffffff; --text: #1b2029; --muted: #667085; --line: #e4e7ec;
  --error: #c8322f; --error-bg: #fdeceb; --warn: #a1620a; --warn-bg: #fdf3e1; --ok: #1f8a4c; --ok-bg: #e6f5ec;
  --info: #3b5bdb; --info-bg: #e8edfd; --code: #eef0f4;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1216; --panel: #171b21; --text: #e5e8ee; --muted: #98a1b2; --line: #282e37;
    --error: #ff7a73; --error-bg: #3a1d1c; --warn: #f2b04f; --warn-bg: #36290f; --ok: #4fc685; --ok-bg: #143022;
    --info: #8ea2ff; --info-bg: #1c2340; --code: #222831;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1120px; margin: 0 auto; padding: 36px 20px 64px; }
a { color: var(--info); }
h1 { font-size: 26px; margin: 2px 0 4px; letter-spacing: -0.01em; }
h2 { font-size: 17px; margin: 0; }
.eyebrow { margin: 0; color: var(--muted); font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; }
.meta, .note, .time { color: var(--muted); font-size: 13px; }
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 24px 0; }
.tile { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
.tile b { display: block; font-size: 28px; line-height: 1.1; }
.tile span { color: var(--muted); font-size: 13px; }
.tile.error b { color: var(--error); } .tile.warn b { color: var(--warn); } .tile.ok b { color: var(--ok); }
section { margin: 0 0 16px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 18px 20px; }
.head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.head .time { margin-left: auto; }
.pill { display: inline-block; font-size: 12px; font-weight: 600; padding: 1px 8px; border-radius: 999px; white-space: nowrap; }
.pill.error { color: var(--error); background: var(--error-bg); } .pill.warn { color: var(--warn); background: var(--warn-bg); }
.pill.ok { color: var(--ok); background: var(--ok-bg); } .pill.info, .pill.skipped { color: var(--info); background: var(--info-bg); }
.issues { list-style: none; padding: 0; margin: 12px 0 0; display: grid; gap: 8px; }
.issues li { display: flex; gap: 12px; align-items: flex-start; background: var(--panel); border: 1px solid var(--line); border-left-width: 4px; border-radius: 10px; padding: 12px 14px; }
.issues li.error { border-left-color: var(--error); } .issues li.warn { border-left-color: var(--warn); }
.issues p { margin: 0; }
.issues a { text-decoration: none; font-weight: 600; }
code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); padding: 1px 6px; border-radius: 4px; color: var(--muted); }
pre { white-space: pre-wrap; word-break: break-word; margin: 6px 0; font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
.count, .where { color: var(--muted); font-size: 13px; }
.clean { background: var(--ok-bg); color: var(--ok); padding: 12px 16px; border-radius: 10px; margin: 0; font-weight: 600; }
.stopped { background: var(--warn-bg); color: var(--warn); padding: 12px 16px; border-radius: 10px; margin: 16px 0 0; font-weight: 600; }
.notes { margin: 12px 0 0; padding-left: 18px; color: var(--muted); font-size: 14px; }
.findings { list-style: none; padding: 0; margin: 12px 0 0; display: grid; gap: 6px; font-size: 14px; }
.shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; margin-top: 14px; }
figure { margin: 0; }
figure img { width: 100%; height: 132px; object-fit: contain; background: #000; border-radius: 8px; border: 1px solid var(--line); display: block; }
figcaption { font-size: 12px; color: var(--muted); margin-top: 4px; line-height: 1.35; }
details { margin-top: 14px; }
summary { cursor: pointer; color: var(--muted); font-size: 14px; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 13px; margin-top: 10px; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--muted); font-weight: 600; }
td.bad { color: var(--error); }
footer { margin-top: 32px; color: var(--muted); font-size: 13px; text-align: center; }
`;
