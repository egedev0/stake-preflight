import fs from 'node:fs';
import path from 'node:path';
import type { Config, Step } from './types.ts';
import { errorMessage } from './util.ts';

export const DEFAULTS: Readonly<Config> = Object.freeze({
  /** The game id replay URLs carry. Stake uses a UUID. */
  game: '3f8c2a6e-91d4-4b7a-a5e2-6c0d9e1b7f40',
  version: '1',
  viewport: [1200, 675],
  /** How a round is started. */
  spin: [{ key: 'Space' }],
  /** Steps that get past an intro screen. Empty: try a visible "continue/start/play" button, then go on. */
  start: [],
  /** Named steps that open the game's own windows (rules, buy menu, settings), read in social mode. */
  screens: {},
  social: { extra: [], allow: [] },
  langs: ['de', 'es', 'br', 'fr', 'ja', 'zh', 'ru', 'tr', 'ar'],
  currencies: ['EUR', 'JPY', 'KWD', 'BRL', 'INR'],
  /** Sent as jurisdiction.minimumRoundDuration. The unit isn't documented; Stake's sample games read seconds. */
  minimumRoundDuration: 3,
  /** Optional limits for the math report, e.g. { "rtp": [0.96, 0.97], "maxWin": 25000 }. */
  limits: {},
  /** Seconds. */
  timeouts: { load: 60, round: 120, replay: 45 },
} satisfies Config);

const STEP_KEYS = new Set(['key', 'click', 'selector', 'wait']);

/** The defaults, with preflight.config.json (or the file given) on top. */
export function loadConfig(file?: string): Config {
  const target = file ?? (fs.existsSync('preflight.config.json') ? 'preflight.config.json' : null);
  const config = structuredClone(DEFAULTS) as Config;
  if (!target) return config;
  let user: unknown;
  try {
    user = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    throw new Error(`Can't read ${path.resolve(target)}: ${errorMessage(error)}`);
  }
  if (!isObject(user)) throw new Error(`Config: ${path.resolve(target)} should hold a JSON object`);
  merge(config as unknown as Record<string, unknown>, user);
  validate(config);
  return config;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Objects merge key by key; anything else (lists included) replaces. */
function merge(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(extra)) {
    const current = base[key];
    base[key] = isObject(value) && isObject(current) ? merge(current, value) : value;
  }
  return base;
}

function validate(config: Config): void {
  if (!isObject(config.screens)) {
    throw new Error('Config: "screens" should be an object of named step lists, e.g. { "rules": [{ "key": "i" }] }');
  }
  for (const name of ['langs', 'currencies'] as const) {
    const list: unknown = config[name];
    if (!Array.isArray(list) || !list.every((value) => typeof value === 'string' && value)) {
      throw new Error(`Config: "${name}" should be a list of codes, e.g. ${name === 'langs' ? '["de", "ja"]' : '["EUR", "JPY"]'}`);
    }
  }
  const lists: [string, unknown][] = [
    ['spin', config.spin],
    ['start', config.start],
    ...Object.entries(config.screens).map(([name, list]): [string, unknown] => [`screens.${name}`, list]),
  ];
  for (const [name, list] of lists) {
    if (!Array.isArray(list)) throw new Error(`Config: "${name}" should be a list of steps`);
    for (const step of list) checkStep(name, step);
  }
  const viewport: unknown = config.viewport;
  if (!Array.isArray(viewport) || viewport.length !== 2 || !viewport.every((n) => Number.isInteger(n) && n > 0)) {
    throw new Error('Config: "viewport" should be [width, height]');
  }
  for (const [name, seconds] of Object.entries(config.timeouts)) {
    if (!(typeof seconds === 'number' && seconds > 0)) throw new Error(`Config: "timeouts.${name}" should be a number of seconds`);
  }
  const limits: unknown = config.limits;
  if (!isObject(limits)) throw new Error('Config: "limits" should be an object, e.g. { "rtp": [0.96, 0.97], "maxWin": 25000 }');
  const { rtp, maxWin, volatility } = limits;
  if (rtp !== undefined && !(Array.isArray(rtp) && rtp.length === 2 && rtp.every((n) => typeof n === 'number' && n > 0 && n <= 1) && rtp[0] <= rtp[1])) {
    throw new Error('Config: "limits.rtp" should be [lowest, highest] as fractions, e.g. [0.96, 0.97]');
  }
  for (const [name, value] of Object.entries({ maxWin, volatility })) {
    if (value !== undefined && !(typeof value === 'number' && value > 0)) throw new Error(`Config: "limits.${name}" should be a number above 0`);
  }
}

function checkStep(name: string, step: unknown): asserts step is Step {
  const keys = isObject(step) ? Object.keys(step) : [];
  if (keys.length !== 1 || !STEP_KEYS.has(keys[0] ?? '')) {
    throw new Error(`Config: a step in "${name}" should be one of { key }, { click: [x, y] }, { selector }, { wait }; got ${JSON.stringify(step)}`);
  }
  const { click } = step as { click?: unknown };
  if (click !== undefined && !(Array.isArray(click) && click.length === 2 && click.every((n) => typeof n === 'number' && n >= 0 && n <= 1))) {
    throw new Error(`Config: click positions in "${name}" are fractions of the screen, e.g. [0.5, 0.9]`);
  }
}
