import balance from './balance.js';
import currencies from './currencies.js';
import errors from './errors.js';
import flags from './flags.js';
import input from './input.js';
import load from './load.js';
import locales from './locales.js';
import play from './play.js';
import replay from './replay.js';
import resume from './resume.js';
import screens from './screens.js';
import social from './social.js';

/** In the order they run and appear in the report. `load` goes first: nothing else runs if it fails. */
export const SCENARIOS = [load, play, input, resume, replay, social, flags, balance, errors, screens, locales, currencies];
