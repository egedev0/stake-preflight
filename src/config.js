import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = {
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
};

const STEP_KEYS = new Set(['key', 'click', 'selector', 'wait']);

/** The defaults, with preflight.config.json (or the file given) on top. */
export function loadConfig(file) {
  const target = file ?? (fs.existsSync('preflight.config.json') ? 'preflight.config.json' : null);
  if (!target) return structuredClone(DEFAULTS);
  let user;
  try {
    user = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    throw new Error(`Can't read ${path.resolve(target)}: ${error.message}`);
  }
  const config = merge(structuredClone(DEFAULTS), user);
  validate(config);
  return config;
}

function merge(base, extra) {
  for (const [key, value] of Object.entries(extra ?? {})) {
    const plain = value && typeof value === 'object' && !Array.isArray(value);
    base[key] = plain && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key]) ? merge(base[key], value) : value;
  }
  return base;
}

function validate(config) {
  if (!config.screens || typeof config.screens !== 'object' || Array.isArray(config.screens)) {
    throw new Error('Config: "screens" should be an object of named step lists, e.g. { "rules": [{ "key": "i" }] }');
  }
  for (const name of ['langs', 'currencies']) {
    if (!Array.isArray(config[name]) || !config[name].every((value) => typeof value === 'string' && value)) {
      throw new Error(`Config: "${name}" should be a list of codes, e.g. ${name === 'langs' ? '["de", "ja"]' : '["EUR", "JPY"]'}`);
    }
  }
  const steps = { spin: config.spin, start: config.start, ...Object.fromEntries(Object.entries(config.screens).map(([name, list]) => [`screens.${name}`, list])) };
  for (const [name, list] of Object.entries(steps)) {
    if (!Array.isArray(list)) throw new Error(`Config: "${name}" should be a list of steps`);
    for (const step of list) {
      const keys = Object.keys(step ?? {});
      if (keys.length !== 1 || !STEP_KEYS.has(keys[0])) {
        throw new Error(`Config: a step in "${name}" should be one of { key }, { click: [x, y] }, { selector }, { wait }; got ${JSON.stringify(step)}`);
      }
      if (step.click && !(Array.isArray(step.click) && step.click.length === 2 && step.click.every((n) => n >= 0 && n <= 1))) {
        throw new Error(`Config: click positions in "${name}" are fractions of the screen, e.g. [0.5, 0.9]`);
      }
    }
  }
  if (!Array.isArray(config.viewport) || config.viewport.length !== 2) throw new Error('Config: "viewport" should be [width, height]');
}
