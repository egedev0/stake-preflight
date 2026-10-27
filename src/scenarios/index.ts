import type { Scenario } from '../run.ts';
import balance from './balance.ts';
import currencies from './currencies.ts';
import errors from './errors.ts';
import flags from './flags.ts';
import input from './input.ts';
import load from './load.ts';
import locales from './locales.ts';
import play from './play.ts';
import replay from './replay.ts';
import resume from './resume.ts';
import screens from './screens.ts';
import social from './social.ts';

/** In the order they run and appear in the report. `load` goes first: nothing else runs if it fails. */
export const SCENARIOS: readonly Scenario[] = [load, play, input, resume, replay, social, flags, balance, errors, screens, locales, currencies];
