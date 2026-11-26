/**
 * TPO / market-profile settings: the field vocabulary, the defaults, the normalisation of a
 * persisted document, and the grid the letters are cut on.
 *
 * Field names are the shipped product's own (`assets/tpoSettingsTabs-ZCm-RBUL.js`), so a
 * stored workspace stays comparable with theirs. Only fields this pane draws are carried:
 * the shipped dialog holds ninety-one, and a field that draws nothing would be a control
 * that lies.
 */

export const TPO_TABS = ['general', 'profile', 'volume', 'color'] as const;
export type TpoTab = (typeof TPO_TABS)[number];

/** Bucket units the shipped period picker offers. A month is not a fixed span, so it is not here. */
export const TPO_PERIOD_UNITS = ['minute', 'hour'] as const;
export type TpoPeriodUnit = (typeof TPO_PERIOD_UNITS)[number];

/** What sits in a cell: the letter, the shaded block, or both. */
export const TPO_LETTER_MODES = ['letters-only', 'blocks-only', 'both'] as const;
export type TpoLetterMode = (typeof TPO_LETTER_MODES)[number];

export const TPO_BLOCK_SHAPES = ['square', 'wide', 'outline'] as const;
export type TpoBlockShape = (typeof TPO_BLOCK_SHAPES)[number];

/** Whether the value area follows the money or the clock. */
export const TPO_VALUE_AREA_METHODS = ['volume', 'tpo'] as const;
export type TpoValueAreaMethod = (typeof TPO_VALUE_AREA_METHODS)[number];

/** What a cell's shade is normalised against. */
export const TPO_GRADING = ['volume', 'delta', 'total'] as const;
export type TpoGrading = (typeof TPO_GRADING)[number];

/**
 * Which tab each field belongs to, following the shipped dialog's four tabs. The dialog
 * builds its tabs from this, so a field cannot drift into the wrong one.
 */
export const TPO_FIELD_TABS: Record<string, TpoTab> = {
  periodLength: 'general',
  sessionStartMinute: 'general',
  sessionLengthMinutes: 'general',
  letterMode: 'general',
  blockShape: 'general',
  profileSpacing: 'general',
  showTradingHourLabel: 'general',
  valueAreaPercentage: 'profile',
  valueAreaMethod: 'profile',
  showValueArea: 'profile',
  showPOC: 'profile',
  showVAH: 'profile',
  showVAL: 'profile',
  pocThickness: 'profile',
  showMidpoint: 'profile',
  showLevelLabels: 'profile',
  levelLineExtend: 'profile',
  cellGrading: 'volume',
  showHoverInspector: 'volume',
  tpoColorEachSession: 'color',
  showOutsideVAColors: 'color',
  outsideVAOpacity: 'color',
  valueAreaFillOpacity: 'color',
};

export interface TpoSettings {
  // General: the grid.
  /** One time bucket is `count` of `unit`. Independent of the chart interval on purpose. */
  periodLength: { count: number; unit: TpoPeriodUnit };
  /** Minutes past UTC midnight at which a session begins; 0 is a plain UTC day. */
  sessionStartMinute: number;
  /** Minutes one session runs. Must divide exactly by the bucket, or a letter spans two sessions. */
  sessionLengthMinutes: number;
  letterMode: TpoLetterMode;
  blockShape: TpoBlockShape;
  /** Pixels per price row. The row count is whatever fits the pane at this height. */
  profileSpacing: number;
  showTradingHourLabel: boolean;

  // Profile: the levels.
  valueAreaPercentage: number;
  valueAreaMethod: TpoValueAreaMethod;
  showValueArea: boolean;
  showPOC: boolean;
  showVAH: boolean;
  showVAL: boolean;
  pocThickness: number;
  showMidpoint: boolean;
  showLevelLabels: boolean;
  /** Draw the level rules out to the price axis instead of stopping at the last bucket. */
  levelLineExtend: boolean;

  // Volume: how a cell is graded and read.
  cellGrading: TpoGrading;
  showHoverInspector: boolean;

  // Color.
  /** Shade each session's letters with its own colour, cycling the four below. */
  tpoColorEachSession: boolean;
  /** Four-step shade ramp for the blocks, lightest first. */
  customTPOColors: [string, string, string, string];
  tpoSessionColors: [string, string, string, string];
  showOutsideVAColors: boolean;
  outsideVAColor: string;
  outsideVAOpacity: number;
  pocColor: string;
  vahColor: string;
  valColor: string;
  midpointColor: string;
  /** The developing session's levels, which the shipped dialog colours apart from a closed one. */
  developingPOCColor: string;
  developingVAColor: string;
  valueAreaFillColor: string;
  valueAreaFillOpacity: number;
}

export const DEFAULT_TPO_SETTINGS: TpoSettings = {
  periodLength: { count: 30, unit: 'minute' },
  sessionStartMinute: 0,
  sessionLengthMinutes: 1_440,
  letterMode: 'both',
  blockShape: 'square',
  profileSpacing: 6,
  showTradingHourLabel: true,

  valueAreaPercentage: 0.7,
  valueAreaMethod: 'volume',
  showValueArea: true,
  showPOC: true,
  showVAH: true,
  showVAL: true,
  pocThickness: 2,
  showMidpoint: false,
  showLevelLabels: true,
  levelLineExtend: true,

  cellGrading: 'volume',
  showHoverInspector: true,

  tpoColorEachSession: false,
  customTPOColors: ['#2f3b4d', '#3f6f8f', '#4b9cf5', '#26b98a'],
  tpoSessionColors: ['#4b9cf5', '#e8b242', '#26b98a', '#e8555c'],
  showOutsideVAColors: false,
  outsideVAColor: '#8a94a6',
  outsideVAOpacity: 0.45,
  // The same level colours the footprint ladder and the profile pane use, so the three
  // order-flow panes cannot put the point of control in three different hues.
  pocColor: '#e8b242',
  vahColor: '#4b9cf5',
  valColor: '#e8555c',
  midpointColor: '#94a3b8',
  developingPOCColor: '#f0c96a',
  developingVAColor: '#7fb2f7',
  valueAreaFillColor: '#94a3b8',
  valueAreaFillOpacity: 0.07,
};

/** Minutes in one time bucket. */
export function bucketMinutes(settings: TpoSettings): number {
  return settings.periodLength.count * (settings.periodLength.unit === 'hour' ? 60 : 1);
}

/**
 * Why this grid cannot be cut, or null when it can. The rule is the server's: a bucket that
 * does not divide the session would carry prints from two sessions under one letter, and the
 * letter on screen would mean two different spans. Asking the server anyway costs a round
 * trip and a 400, so the pane checks before it asks.
 */
export function gridProblem(settings: TpoSettings): string | null {
  const bucket = bucketMinutes(settings);
  const session = settings.sessionLengthMinutes;
  const start = settings.sessionStartMinute;
  if (bucket < 1) return 'a bucket needs at least one minute';
  if (session < bucket) return `a ${session} minute session is shorter than one ${bucket} minute bucket`;
  if (session % bucket !== 0) return `${bucket} minute buckets do not divide a ${session} minute session`;
  if (start < 0 || start >= 1_440) return 'a session starts at a minute of the UTC day';
  return null;
}

/**
 * The letter for a bucket inside a session: `A` to `Z`, then `a` to `z`, then `A1`, `B1`.
 * A 24 hour session cut into half hours needs 48 marks, so one alphabet is not enough, and
 * two buckets may never share one. The server assigns the letters the pane draws; this is the
 * client's copy, used for the live bucket before an answer arrives and pinned to the server's
 * by a test.
 */
export function tpoLetter(index: number): string {
  if (!Number.isFinite(index) || index < 0) return '?';
  const letter = String.fromCharCode(65 + (index % 26));
  if (index < 26) return letter;
  if (index < 52) return letter.toLowerCase();
  return `${letter}${Math.floor((index - 52) / 26) + 1}`;
}

/**
 * The session a timestamp falls in, as the grid sees it: sessions tile the timeline from
 * `sessionStartMinute` of the UTC day, so a bucket never straddles one.
 */
export function sessionStartOf(ts: number, settings: TpoSettings): number {
  const offset = settings.sessionStartMinute * 60_000;
  const length = Math.max(1, settings.sessionLengthMinutes * 60_000);
  // Sessions tile the timeline from the session start minute, every `sessionLength`, which is
  // the arithmetic the server's grid uses too; `Math.floor` is the floor division it needs.
  return offset + Math.floor((ts - offset) / length) * length;
}

/** Which bucket a timestamp belongs to, floored onto the grid. */
export function bucketStartOf(ts: number, settings: TpoSettings): number {
  const bucket = bucketMinutes(settings) * 60_000;
  const session = sessionStartOf(ts, settings);
  return session + Math.floor((ts - session) / bucket) * bucket;
}

/** The bucket a live bar's letter will carry, for the frame before the server answers. */
export function liveLetter(ts: number, settings: TpoSettings): string {
  const bucket = bucketMinutes(settings) * 60_000;
  return tpoLetter(Math.floor((bucketStartOf(ts, settings) - sessionStartOf(ts, settings)) / bucket));
}

function bool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback;
}

function num(raw: unknown, min: number, max: number, fallback: number): number {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function int(raw: unknown, min: number, max: number, fallback: number): number {
  return Math.round(num(raw, min, max, fallback));
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/** Colour field; only a plain `#rrggbb` reaches the canvas. */
function hex(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
  if (/^#[0-9a-fA-F]{8}$/.test(raw)) return `#${raw.slice(1, 7)}`;
  return fallback;
}

/** Four colour slots, so a stored list of any length still yields the four the pane indexes. */
function colourFour(raw: unknown, fallback: [string, string, string, string]): [string, string, string, string] {
  const list = Array.isArray(raw) ? raw : [];
  return [hex(list[0], fallback[0]), hex(list[1], fallback[1]), hex(list[2], fallback[2]), hex(list[3], fallback[3])];
}

/**
 * Rebuilds a complete, in-range settings object from whatever the document holds. The period
 * pair is validated together, because a stored `count` of 0 or a `unit` this pane cannot cut
 * would ask the server for a grid it refuses.
 */
export function normaliseTpoSettings(raw: unknown): TpoSettings {
  const d = DEFAULT_TPO_SETTINGS;
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const period = (typeof value['periodLength'] === 'object' && value['periodLength'] !== null
    ? value['periodLength']
    : {}) as Record<string, unknown>;
  const unit = oneOf(period['unit'], TPO_PERIOD_UNITS, d.periodLength.unit);
  const count = int(period['count'], 1, unit === 'hour' ? 24 : 480, d.periodLength.count);
  // A count that no longer divides its session is a stored pair that drifted apart; keep the
  // session and move the bucket to the largest divisor of it that still fits the unit.
  const session = int(value['sessionLengthMinutes'], 2, 10_080, d.sessionLengthMinutes);
  const minutes = count * (unit === 'hour' ? 60 : 1);
  const bucket = session % minutes === 0 ? minutes : largestDivisor(session, minutes);
  return {
    periodLength: {
      count: bucket % 60 === 0 && bucket / 60 <= 24 ? bucket / 60 : bucket,
      unit: bucket % 60 === 0 && bucket / 60 <= 24 ? 'hour' : unit === 'hour' ? 'minute' : unit,
    },
    sessionStartMinute: int(value['sessionStartMinute'], 0, 1_439, d.sessionStartMinute),
    sessionLengthMinutes: session,
    letterMode: oneOf(value['letterMode'], TPO_LETTER_MODES, d.letterMode),
    blockShape: oneOf(value['blockShape'], TPO_BLOCK_SHAPES, d.blockShape),
    profileSpacing: int(value['profileSpacing'], 2, 24, d.profileSpacing),
    showTradingHourLabel: bool(value['showTradingHourLabel'], d.showTradingHourLabel),

    valueAreaPercentage: num(value['valueAreaPercentage'], 0.05, 1, d.valueAreaPercentage),
    valueAreaMethod: oneOf(value['valueAreaMethod'], TPO_VALUE_AREA_METHODS, d.valueAreaMethod),
    showValueArea: bool(value['showValueArea'], d.showValueArea),
    showPOC: bool(value['showPOC'], d.showPOC),
    showVAH: bool(value['showVAH'], d.showVAH),
    showVAL: bool(value['showVAL'], d.showVAL),
    pocThickness: int(value['pocThickness'], 1, 6, d.pocThickness),
    showMidpoint: bool(value['showMidpoint'], d.showMidpoint),
    showLevelLabels: bool(value['showLevelLabels'], d.showLevelLabels),
    levelLineExtend: bool(value['levelLineExtend'], d.levelLineExtend),

    cellGrading: oneOf(value['cellGrading'], TPO_GRADING, d.cellGrading),
    showHoverInspector: bool(value['showHoverInspector'], d.showHoverInspector),

    tpoColorEachSession: bool(value['tpoColorEachSession'], d.tpoColorEachSession),
    customTPOColors: colourFour(value['customTPOColors'], d.customTPOColors),
    tpoSessionColors: colourFour(value['tpoSessionColors'], d.tpoSessionColors),
    showOutsideVAColors: bool(value['showOutsideVAColors'], d.showOutsideVAColors),
    outsideVAColor: hex(value['outsideVAColor'], d.outsideVAColor),
    outsideVAOpacity: num(value['outsideVAOpacity'], 0.05, 1, d.outsideVAOpacity),
    pocColor: hex(value['pocColor'], d.pocColor),
    vahColor: hex(value['vahColor'], d.vahColor),
    valColor: hex(value['valColor'], d.valColor),
    midpointColor: hex(value['midpointColor'], d.midpointColor),
    developingPOCColor: hex(value['developingPOCColor'], d.developingPOCColor),
    developingVAColor: hex(value['developingVAColor'], d.developingVAColor),
    valueAreaFillColor: hex(value['valueAreaFillColor'], d.valueAreaFillColor),
    valueAreaFillOpacity: num(value['valueAreaFillOpacity'], 0, 0.5, d.valueAreaFillOpacity),
  };
}

/** Largest divisor of `value` at or below `guess`, so a drifted bucket still divides its session. */
function largestDivisor(value: number, guess: number): number {
  for (let candidate = Math.min(guess, value); candidate >= 1; candidate -= 1) {
    if (value % candidate === 0) return candidate;
  }
  return 1;
}
