/** How serious a finding is. */
export type Level = 'error' | 'warn' | 'info';

export interface Finding {
  level: Level;
  /** a short id such as "rgs/end-round" */
  check: string;
  message: string;
  /** how many times the same message came up */
  count: number;
  detail?: string;
  /** a screenshot that shows it, relative to the report */
  shot?: string;
  /** the sessions it came up in */
  where?: string[];
}

/** One step of a config action. Click positions are fractions of the screen: [0.5, 0.9]. */
export type Step = { key: string } | { click: [number, number] } | { selector: string } | { wait: number };

/** Your own targets for the math report. */
export interface Limits {
  rtp?: [number, number];
  maxWin?: number;
  volatility?: number;
}

export interface Config {
  /** the game id replay URLs carry */
  game: string;
  version: string;
  viewport: [number, number];
  /** how a round is started */
  spin: Step[];
  /** steps that get past an intro screen */
  start: Step[];
  /** named steps that open the game's own windows, read in social mode */
  screens: Record<string, Step[]>;
  social: { extra: string[]; allow: string[] };
  langs: string[];
  currencies: string[];
  /** sent as jurisdiction.minimumRoundDuration */
  minimumRoundDuration: number;
  limits: Limits;
  /** seconds */
  timeouts: { load: number; round: number; replay: number };
}

/** An event of a book. Only `type` is the same in every game. */
export interface BookEvent {
  type: string;
  index?: number;
  amount?: number;
  [key: string]: unknown;
}

/** A round as the math-sdk writes it: the payout (hundredths of the bet) and the events the game plays. */
export interface Book {
  id: number;
  payoutMultiplier: number;
  events: BookEvent[];
  criteria?: string;
  [key: string]: unknown;
}

/** The kinds of round the scenarios play. */
export type Kind = 'loss' | 'win' | 'big' | 'max' | 'feature';

/** A bet mode with the books the scenarios play from it. */
export interface PlayMode {
  name: string;
  cost: number;
  /** the mode the base game plays */
  base?: boolean;
  books: Partial<Record<Kind, Book>>;
}

/** What a mode returns, from its lookup table. Wins are multiples of the base bet. */
export interface ModeStats {
  books: number;
  rtp: number;
  hitRate: number;
  maxWin: number;
  maxWinChance: number;
  volatility: number;
  /** the chance of a win at least this big, by size */
  tails: Record<number, number>;
  /** books checked against the table (--deep) */
  verified?: number;
}

export interface Shot {
  file: string;
  caption: string;
}

/** What a /wallet/play answer was, for the report. */
export interface RoundSummary {
  betID: number;
  kind: string;
  bookId: number;
  payoutMultiplier: number;
  active: boolean;
}

/** One RGS call as the report lists it. */
export interface CallRecord {
  session: string;
  at: number;
  method: string;
  path: string;
  status?: number;
  error?: string;
  round?: RoundSummary;
  mode?: unknown;
  amount?: unknown;
  event?: unknown;
}

export type Status = 'ok' | 'warn' | 'error' | 'skipped';

/** A part of the report: the build, the math, or one scenario. */
export interface Section {
  name: string;
  title: string;
  status: Status;
  duration: number;
  findings: Finding[];
  notes: string[];
  shots: Shot[];
  calls: CallRecord[];
  /** why it was skipped */
  reason?: string;
  data?: unknown;
}

export interface Report {
  tool: { name: string; version: string };
  build: string;
  math: string | null;
  title: string;
  game: string;
  startedAt: string;
  duration: number;
  quick: boolean;
  /** stopped (Ctrl+C) before every check ran */
  stopped: boolean;
  sections: Section[];
  summary: { errors: number; warnings: number; passed: number; skipped: number; sections: number };
}
