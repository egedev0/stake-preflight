import type { Finding, Level, Status } from './types.ts';

export interface FindingExtra {
  detail?: string;
  shot?: string;
  /** the session it came up in */
  where?: string;
}

/**
 * What a check found. The same message twice is kept once with a count and the sessions it came from,
 * so a console error fired in nine languages is one finding, not nine.
 */
export class Findings {
  readonly items: Finding[] = [];
  private readonly byKey = new Map<string, Finding>();

  error(check: string, message: string, extra?: FindingExtra) {
    return this.add('error', check, message, extra);
  }

  warn(check: string, message: string, extra?: FindingExtra) {
    return this.add('warn', check, message, extra);
  }

  info(check: string, message: string, extra?: FindingExtra) {
    return this.add('info', check, message, extra);
  }

  add(level: Level, check: string, message: string, extra: FindingExtra = {}): Finding {
    const key = `${level}\n${check}\n${message}`;
    let item = this.byKey.get(key);
    if (item) {
      item.count += 1;
    } else {
      item = { level, check, message, count: 1 };
      if (extra.detail) item.detail = extra.detail;
      if (extra.shot) item.shot = extra.shot;
      this.byKey.set(key, item);
      this.items.push(item);
    }
    if (extra.where) {
      item.where ??= [];
      if (!item.where.includes(extra.where)) item.where.push(extra.where);
    }
    return item;
  }

  count(level: Level): number {
    return this.items.filter((item) => item.level === level).length;
  }

  get status(): Exclude<Status, 'skipped'> {
    if (this.count('error')) return 'error';
    if (this.count('warn')) return 'warn';
    return 'ok';
  }
}
