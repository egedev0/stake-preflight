/** Severity, most serious first. */
export const LEVELS = ['error', 'warn', 'info'];

/**
 * What a check found. The same message twice is kept once with a count and the sessions it came from,
 * so a console error fired in nine languages is one finding, not nine.
 */
export class Findings {
  constructor() {
    this.items = [];
    this.byKey = new Map();
  }

  error(check, message, extra) {
    return this.add('error', check, message, extra);
  }

  warn(check, message, extra) {
    return this.add('warn', check, message, extra);
  }

  info(check, message, extra) {
    return this.add('info', check, message, extra);
  }

  /** @param {{ detail?: string, shot?: string, where?: string }} [extra] */
  add(level, check, message, extra = {}) {
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

  count(level) {
    return this.items.filter((item) => item.level === level).length;
  }

  get status() {
    if (this.count('error')) return 'error';
    if (this.count('warn')) return 'warn';
    return 'ok';
  }
}
