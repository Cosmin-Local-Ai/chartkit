/**
 * Footprint (order-flow) settings state: the field vocabulary, the defaults and the
 * normalisation of a persisted document. Field names are the shipped product's own,
 * so a stored workspace stays comparable with theirs.
 */

/** Metric ids a footprint column or cell can show. */
export const CELL_METRICS = [
  'bidAsk',
  'delta',
  'deltaColored',
  'diagonalDelta',
  'deltaPct',
  'volume',
  'buy',
  'sell',
  'volumeBar',
  'deltaBar',
  'volumeBarLeading',
  'splitBar',
] as const;
export type CellMetric = (typeof CELL_METRICS)[number];

/** Column presets, each a metric list clamped to the 2-4 column range. */
export const COLUMN_PRESETS: { id: string; columns: CellMetric[] }[] = [
  { id: 'bidAskDelta', columns: ['bidAsk', 'delta'] },
  { id: 'deltaVolumeBar', columns: ['deltaColored', 'volume', 'volumeBar'] },
  { id: 'volumeDeltaBars', columns: ['volumeBar', 'deltaBar'] },
  { id: 'profileBars', columns: ['splitBar', 'volume'] },
];

/** `columns` is the default; the other values are the shipped display-mode list. */
export const DISPLAY_MODES = [
  'columns',
  'stacked-bar',
  'stacked-bar-delta',
  'split-bar',
  'cluster',
  'imbalance-only',
  'ladder',
] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];

/** The three modes the shipped unfinished-auction util validates `displayMode` against. */
export const AUCTION_MODES: readonly DisplayMode[] = ['cluster', 'imbalance-only', 'ladder'];

export const STATS_ROW_METRICS = [
  'volume',
  'buy',
  'sell',
  'mid',
  'delta',
  'deltaPct',
  'cumDelta',
  'pocPrice',
  'range',
  'deltaChange',
  'volAbovePoc',
  'volBelowPoc',
] as const;
export type StatsRowMetric = (typeof STATS_ROW_METRICS)[number];

export const SECONDARY_CELL_METRICS = ['off', 'volume', 'delta', 'deltaPct', 'diagonalDelta'] as const;
export type SecondaryCellMetric = (typeof SECONDARY_CELL_METRICS)[number];

export const CLUSTER_CELL_METRICS = ['volume', 'delta', 'ratio'] as const;
export type ClusterCellMetric = (typeof CLUSTER_CELL_METRICS)[number];

export const FOOTPRINT_TABS = ['general', 'profile', 'imbalance', 'filters', 'color', 'advanced'] as const;
export type FootprintTab = (typeof FOOTPRINT_TABS)[number];

/**
 * Which tab each field belongs to, following the shipped field-to-tab routing table.
 * The dialog builds its tabs from this, so a field cannot drift into the wrong tab.
 */
export const FOOTPRINT_FIELD_TABS: Record<string, FootprintTab> = {
  displayMode: 'general',
  clusterCellMetric: 'general',
  secondaryCellMetric: 'general',
  footprintColumns: 'general',
  barWidth: 'general',
  imbalance: 'imbalance',
  imbalanceRatio: 'imbalance',
  imbalanceMethod: 'imbalance',
  imbalanceMinVolume: 'imbalance',
  stackedImbalances: 'imbalance',
  colorImbalanceText: 'imbalance',
  showImbalanceNaked: 'imbalance',
  skipZeroValues: 'imbalance',
  threshold: 'filters',
  showPOC: 'profile',
  showVAH: 'profile',
  showVAL: 'profile',
  pocThickness: 'profile',
  showPOCOutline: 'profile',
  showPOCNaked: 'profile',
  showVAHNaked: 'profile',
  showVALNaked: 'profile',
  showPOCNakedPrice: 'profile',
  showVAHNakedPrice: 'profile',
  showVALNakedPrice: 'profile',
  maxNakedLevels: 'profile',
  showUnfinishedAuction: 'profile',
  unfinishedAuctionColor: 'profile',
  showValueArea: 'profile',
  valueArea: 'profile',
  showValueAreaBand: 'profile',
  statsRows: 'profile',
  statsRowsPosition: 'profile',
  statsRowsLabels: 'profile',
  'colors.0': 'color',
  'colors.1': 'color',
  cellShading: 'color',
  shadingSteps: 'color',
  useGradient: 'color',
  cellTextColor: 'color',
  volumeColor: 'color',
  pocColor: 'color',
  vahColor: 'color',
  valColor: 'color',
  imbalanceBuyColor: 'color',
  imbalanceSellColor: 'color',
  volumeDecimals: 'advanced',
  hideZeroText: 'advanced',
  cellFontSize: 'advanced',
  fullNumbers: 'advanced',
  trimZeroTails: 'advanced',
  scaleAndGrading: 'advanced',
  dynamicCandleWidth: 'advanced',
  barHeightMultiplier: 'advanced',
};

export interface FootprintSettings {
  displayMode: DisplayMode;
  clusterCellMetric: ClusterCellMetric;
  secondaryCellMetric: SecondaryCellMetric;
  /** Metric ids drawn as ladder columns; always 2-4 entries. */
  footprintColumns: CellMetric[];
  /** Fraction of a cell a bar metric may fill. */
  barWidth: number;

  imbalance: boolean;
  imbalanceRatio: number;
  imbalanceMethod: 'diagonal' | 'horizontal';
  imbalanceMinVolume: number;
  /** Consecutive imbalanced rows a run must reach before it is marked; 1 marks singles. */
  stackedImbalances: number;
  colorImbalanceText: boolean;
  showImbalanceNaked: boolean;
  skipZeroValues: boolean;

  /** Rows below this volume draw nothing. */
  threshold: number;

  showPOC: boolean;
  showVAH: boolean;
  showVAL: boolean;
  pocThickness: number;
  showPOCOutline: boolean;
  showPOCNaked: boolean;
  showVAHNaked: boolean;
  showVALNaked: boolean;
  showPOCNakedPrice: boolean;
  showVAHNakedPrice: boolean;
  showVALNakedPrice: boolean;
  /** Cap on drawn naked levels; 0 is unlimited. */
  maxNakedLevels: number;
  showUnfinishedAuction: boolean;
  unfinishedAuctionColor: string;
  showValueArea: boolean;
  valueArea: number;
  showValueAreaBand: boolean;
  statsRows: Partial<Record<StatsRowMetric, boolean>>;
  statsRowsPosition: 'above' | 'below';
  statsRowsLabels: boolean;

  /** [buy, sell] cell heat colours. */
  colors: [string, string];
  cellShading: 'smooth' | 'steps';
  shadingSteps: number;
  useGradient: boolean;
  cellTextColor: string;
  volumeColor: string;
  pocColor: string;
  vahColor: string;
  valColor: string;
  imbalanceBuyColor: string;
  imbalanceSellColor: string;

  volumeDecimals: 'auto' | number;
  hideZeroText: boolean;
  cellFontSize: 'auto' | number;
  fullNumbers: boolean;
  trimZeroTails: boolean;
  /** What the bar and heat scale is normalised against. */
  scaleAndGrading: 'candle' | 'session' | 'visible';
  dynamicCandleWidth: boolean;
  barHeightMultiplier: number;
}

export const DEFAULT_FOOTPRINT_SETTINGS: FootprintSettings = {
  displayMode: 'columns',
  clusterCellMetric: 'delta',
  secondaryCellMetric: 'off',
  footprintColumns: ['bidAsk', 'delta'],
  barWidth: 0.7,

  imbalance: false,
  imbalanceRatio: 3,
  imbalanceMethod: 'diagonal',
  imbalanceMinVolume: 0,
  stackedImbalances: 1,
  colorImbalanceText: false,
  showImbalanceNaked: false,
  skipZeroValues: false,

  threshold: 0,

  showPOC: true,
  showVAH: true,
  showVAL: true,
  pocThickness: 2,
  showPOCOutline: false,
  showPOCNaked: false,
  showVAHNaked: false,
  showVALNaked: false,
  showPOCNakedPrice: false,
  showVAHNakedPrice: false,
  showVALNakedPrice: false,
  maxNakedLevels: 0,
  showUnfinishedAuction: true,
  // The shipped default is `#FF003CB3` in AARRGGBB form, i.e. opaque `#003CB3`.
  unfinishedAuctionColor: '#003CB3',
  showValueArea: true,
  valueArea: 0.7,
  showValueAreaBand: false,
  statsRows: {},
  statsRowsPosition: 'below',
  statsRowsLabels: true,

  colors: ['#26b98a', '#e8555c'],
  cellShading: 'smooth',
  shadingSteps: 4,
  useGradient: false,
  cellTextColor: '#cbd5e1',
  volumeColor: '#4a90e2',
  pocColor: '#e8b242',
  vahColor: '#4b9cf5',
  valColor: '#e8555c',
  // The marker sits on the flagged side of the ladder, so both sides share the chart's
  // imbalance accent; a hue distinct from the buy/sell heat is what makes the flagged
  // numbers readable when `colorImbalanceText` is on.
  imbalanceBuyColor: '#4b9cf5',
  imbalanceSellColor: '#4b9cf5',

  volumeDecimals: 'auto',
  hideZeroText: false,
  cellFontSize: 'auto',
  fullNumbers: false,
  trimZeroTails: true,
  scaleAndGrading: 'candle',
  dynamicCandleWidth: false,
  barHeightMultiplier: 1,
};

export function isCellMetric(value: unknown): value is CellMetric {
  return typeof value === 'string' && (CELL_METRICS as readonly string[]).includes(value);
}

/**
 * Column list, filtered to known metrics and clamped to 2-4 columns; anything that
 * cannot satisfy the range falls back to the default columns.
 */
export function clampFootprintColumns(raw: unknown): CellMetric[] {
  if (!Array.isArray(raw)) return DEFAULT_FOOTPRINT_SETTINGS.footprintColumns.slice();
  const list = raw.filter(isCellMetric).slice(0, 4);
  return list.length >= 2 ? list : DEFAULT_FOOTPRINT_SETTINGS.footprintColumns.slice();
}

/** The preset whose column list matches exactly, or `custom`. */
export function presetFor(columns: readonly string[]): string {
  for (const preset of COLUMN_PRESETS) {
    if (preset.columns.length !== columns.length) continue;
    if (preset.columns.every((metric, index) => metric === columns[index])) return preset.id;
  }
  return 'custom';
}

/**
 * Value-area fraction in force. The shipped unfinished-auction util overrides the
 * configured percentage for the bar modes (0.7 stacked, whole range split/cluster).
 */
export function valueAreaForMode(mode: DisplayMode, configured: number): number {
  if (mode === 'stacked-bar' || mode === 'stacked-bar-delta') return 0.7;
  if (mode === 'split-bar' || AUCTION_MODES.includes(mode)) return 1;
  return configured;
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

/**
 * Colour field. Accepts `#RRGGBB` and the shipped `#AARRGGBB` form, which is reduced to
 * `#RRGGBB`: canvas would read those same eight digits as `#RRGGBBAA` and change the hue.
 */
function hex(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
  if (/^#[0-9a-fA-F]{8}$/.test(raw)) return `#${raw.slice(3)}`;
  return fallback;
}

/** `auto` or an integer inside `max`, matching the shipped segmented option lists. */
function autoOrInt(raw: unknown, min: number, max: number, fallback: 'auto' | number): 'auto' | number {
  if (raw === 'auto' || raw === '' || raw === null || raw === undefined) return 'auto';
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value)) return fallback;
  return Math.round(Math.max(min, Math.min(max, value)));
}

function colourPair(raw: unknown, fallback: [string, string]): [string, string] {
  const list = Array.isArray(raw) ? raw : [];
  return [hex(list[0], fallback[0]), hex(list[1], fallback[1])];
}

function statsRows(raw: unknown): Partial<Record<StatsRowMetric, boolean>> {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Partial<Record<StatsRowMetric, boolean>> = {};
  for (const metric of STATS_ROW_METRICS) {
    const value = (raw as Record<string, unknown>)[metric];
    if (typeof value === 'boolean') out[metric] = value;
  }
  return out;
}

/** Rebuilds a complete, in-range settings object from whatever the document holds. */
export function normaliseFootprintSettings(raw: unknown): FootprintSettings {
  const d = DEFAULT_FOOTPRINT_SETTINGS;
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const colors = colourPair(value['colors'], d.colors);
  const settings: FootprintSettings = {
    displayMode: oneOf(value['displayMode'], DISPLAY_MODES, d.displayMode),
    clusterCellMetric: oneOf(value['clusterCellMetric'], CLUSTER_CELL_METRICS, d.clusterCellMetric),
    secondaryCellMetric: oneOf(value['secondaryCellMetric'], SECONDARY_CELL_METRICS, d.secondaryCellMetric),
    footprintColumns: clampFootprintColumns(value['footprintColumns']),
    barWidth: num(value['barWidth'], 0.05, 1, d.barWidth),

    imbalance: bool(value['imbalance'], d.imbalance),
    imbalanceRatio: num(value['imbalanceRatio'], 1, 20, d.imbalanceRatio),
    imbalanceMethod: oneOf(value['imbalanceMethod'], ['diagonal', 'horizontal'] as const, d.imbalanceMethod),
    imbalanceMinVolume: num(value['imbalanceMinVolume'], 0, Number.MAX_SAFE_INTEGER, d.imbalanceMinVolume),
    stackedImbalances: int(value['stackedImbalances'], 1, 8, d.stackedImbalances),
    colorImbalanceText: bool(value['colorImbalanceText'], d.colorImbalanceText),
    showImbalanceNaked: bool(value['showImbalanceNaked'], d.showImbalanceNaked),
    skipZeroValues: bool(value['skipZeroValues'], d.skipZeroValues),

    threshold: num(value['threshold'], 0, Number.MAX_SAFE_INTEGER, d.threshold),

    showPOC: bool(value['showPOC'], d.showPOC),
    showVAH: bool(value['showVAH'], d.showVAH),
    showVAL: bool(value['showVAL'], d.showVAL),
    pocThickness: int(value['pocThickness'], 1, 6, d.pocThickness),
    showPOCOutline: bool(value['showPOCOutline'], d.showPOCOutline),
    showPOCNaked: bool(value['showPOCNaked'], d.showPOCNaked),
    showVAHNaked: bool(value['showVAHNaked'], d.showVAHNaked),
    showVALNaked: bool(value['showVALNaked'], d.showVALNaked),
    showPOCNakedPrice: bool(value['showPOCNakedPrice'], d.showPOCNakedPrice),
    showVAHNakedPrice: bool(value['showVAHNakedPrice'], d.showVAHNakedPrice),
    showVALNakedPrice: bool(value['showVALNakedPrice'], d.showVALNakedPrice),
    maxNakedLevels: int(value['maxNakedLevels'], 0, 64, d.maxNakedLevels),
    showUnfinishedAuction: bool(value['showUnfinishedAuction'], d.showUnfinishedAuction),
    unfinishedAuctionColor: hex(value['unfinishedAuctionColor'], d.unfinishedAuctionColor),
    showValueArea: bool(value['showValueArea'], d.showValueArea),
    valueArea: num(value['valueArea'], 0.05, 1, d.valueArea),
    showValueAreaBand: bool(value['showValueAreaBand'], d.showValueAreaBand),
    statsRows: statsRows(value['statsRows']),
    statsRowsPosition: oneOf(value['statsRowsPosition'], ['above', 'below'] as const, d.statsRowsPosition),
    statsRowsLabels: bool(value['statsRowsLabels'], d.statsRowsLabels),

    colors,
    cellShading: oneOf(value['cellShading'], ['smooth', 'steps'] as const, d.cellShading),
    shadingSteps: int(value['shadingSteps'], 2, 8, d.shadingSteps),
    useGradient: bool(value['useGradient'], d.useGradient),
    cellTextColor: hex(value['cellTextColor'], d.cellTextColor),
    volumeColor: hex(value['volumeColor'], d.volumeColor),
    pocColor: hex(value['pocColor'], d.pocColor),
    vahColor: hex(value['vahColor'], d.vahColor),
    valColor: hex(value['valColor'], d.valColor),
    imbalanceBuyColor: hex(value['imbalanceBuyColor'], d.imbalanceBuyColor),
    imbalanceSellColor: hex(value['imbalanceSellColor'], d.imbalanceSellColor),

    volumeDecimals: autoOrInt(value['volumeDecimals'], 0, 8, d.volumeDecimals),
    hideZeroText: bool(value['hideZeroText'], d.hideZeroText),
    cellFontSize: autoOrInt(value['cellFontSize'], 8, 24, 11),
    fullNumbers: bool(value['fullNumbers'], d.fullNumbers),
    trimZeroTails: bool(value['trimZeroTails'], d.trimZeroTails),
    scaleAndGrading: oneOf(value['scaleAndGrading'], ['candle', 'session', 'visible'] as const, d.scaleAndGrading),
    dynamicCandleWidth: bool(value['dynamicCandleWidth'], d.dynamicCandleWidth),
    barHeightMultiplier: num(value['barHeightMultiplier'], 0.5, 4, d.barHeightMultiplier),
  };
  return settings;
}
