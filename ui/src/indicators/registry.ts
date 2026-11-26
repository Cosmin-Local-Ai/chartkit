/**
 * The indicator registry: one entry per indicator, holding its id, its shipped
 * display name, where it plots, its parameter descriptors and the pure function
 * that turns bars into plotted series. Adding an indicator means adding an entry
 * here plus its `compute`; nothing else in the client needs to know about it.
 *
 * Ids, parameter names and defaults are the shipped ones wherever the bundle
 * carries them: the settings tables in `route-libs` for SMA, EMA, BOLLINGER_BANDS,
 * MACD, RSI and STOCH, and the shipped kScript sources for WMA, HMA, VWMA and ATR.
 * Where neither source reaches a parameter, the name and default are noted in the
 * entry as this project's own choice.
 */

import type { Bar } from '../types';
import {
  CVD_ANCHORS,
  cumulativeDelta,
  flowDominance,
  flowNote,
  flowDelta,
  type CvdAnchor,
  type PrintFlow,
} from './flow';
import type { SizeBandFlow } from '../sizeBands';
import { bandCumulative, sizeBandNote } from '../sizeBands';
import type { Values } from './tas';
import {
  atr,
  bollinger,
  cciClassic,
  delay,
  dmi,
  ema,
  hma,
  ichimoku,
  macd,
  mfi,
  obv,
  pivotPoints,
  rsi,
  rsiSimple,
  sma,
  sourceValues,
  stochRsi,
  stochastic,
  supertrend,
  typicalPrice,
  vwma,
  vwap,
  williamsR,
  wma,
  type AtrSmoothing,
  type PivotKind,
  type PivotTimeframe,
  type SourceField,
  type VwapAnchor,
  type VwapPrice,
} from './tas';

export type ParamValue = number | boolean | string | string[];
export type ParamValues = Record<string, ParamValue>;

export type ParamKind = 'number' | 'boolean' | 'select' | 'colors';

export interface ParamDescriptor {
  name: string;
  label: string;
  kind: ParamKind;
  default: ParamValue;
  min?: number;
  max?: number;
  step?: number;
  options?: readonly string[];
  /** `colors` only: one swatch per plotted line, in plot order. */
  slots?: readonly string[];
}

export type PlotKind = 'line' | 'histogram';

export interface IndicatorPlot {
  label: string;
  color: string;
  width: number;
  kind: PlotKind;
  values: Values;
  /** Histogram only: the color used for values below zero instead of `color`. */
  negativeColor?: string;
}

export interface IndicatorResult {
  /** Parameter summary shown next to the indicator name, e.g. `(26, close)`. */
  caption: string;
  plots: IndicatorPlot[];
  /** Shown after the caption when the indicator has less to say than a series would. */
  note?: string;
  /** Plot indices to shade between, for band indicators. */
  band?: { upper: number; lower: number; color: string };
  /** Draw the lines as curves instead of straight segments. */
  smooth: boolean;
  /**
   * Guide lines for this instance, in place of the definition's. Oscillators whose
   * thresholds are parameters (`overbought`, `oversold`) move their own guides here.
   */
  levels?: number[];
}

export interface PaneStyle {
  /** Horizontal guides in an offchart pane. */
  levels?: number[];
  /** Fixed vertical range; auto-fit from the visible bars when absent. */
  range?: { min: number; max: number };
  zeroLine?: boolean;
  /** Decimals for gutter labels when the values are not prices. */
  precision?: number;
  /** Values are in the instrument's price units: use its precision. */
  priceUnits?: boolean;
}

export interface IndicatorDefinition {
  id: string;
  /** Shipped display name, used in the picker and dialog titles. */
  label: string;
  /** Compact name for the legend and pane titles. */
  short: string;
  placement: 'onchart' | 'offchart';
  /** Picker section this indicator is filed under, so the catalog stays skimmable. */
  group: (typeof INDICATOR_GROUPS)[number];
  /** Needs the per-bar buy/sell the prints give, so the app loads a print window for it. */
  needsPrints?: boolean;
  /**
   * Needs the server's size-band split, so the app loads a `/api/cvd-by-size` window for
   * it. The bands are the server's decision and arrive with the answer.
   */
  needsSizeBands?: boolean;
  params: ParamDescriptor[];
  pane?: PaneStyle;
  /**
   * `flow` is the per-bar buy/sell of the prints, `bands` the same window split by print
   * size. An indicator reads the one it declares and ignores the rest.
   */
  compute(bars: readonly Bar[], params: ParamValues, flow: PrintFlow | null, bands?: SizeBandFlow | null): IndicatorResult;
}

const SOURCE_OPTIONS: readonly string[] = ['close', 'open', 'high', 'low'];

/** CCI ships `source` with typical price among its choices. */
const CCI_SOURCE_OPTIONS: readonly string[] = ['close', 'hlc3', 'open', 'high', 'low'];

/**
 * Picker sections, in the order they appear. The shipped catalogue sorts by family
 * (`moving_average`, `trend_follow`, `vwap`, `levels`, `stochastic`, `volume`, …); these
 * groups are that grouping in the words a trader already uses.
 */
export const INDICATOR_GROUPS = [
  'Moving averages',
  'Trend',
  'VWAP',
  'Levels',
  'Volatility',
  'Momentum',
  'Volume',
  'Order flow',
  'Custom',
] as const;

const VWAP_PRICE_OPTIONS: readonly string[] = ['hlc3', 'hl2', 'ohlc4', 'hlcc4', 'close'];

/** `hlc3` picks the typical price; every other choice picks a bar field. */
function cciSource(bars: readonly Bar[], params: ParamValues): Values {
  return string(params, 'source', 'close') === 'hlc3' ? typicalPrice(bars) : sourceValues(bars, source(params));
}

/**
 * The parameters and the compute of one session VWAP, which differ only in the calendar
 * they restart on. The shipped product carries a single `VWAP` type with no parameter
 * table, so `anchor`, `price` and its choices are the shipped `vwap(anchor, price)`
 * built-in's; the daily/weekly/monthly split, these three ids and these labels are this
 * project's own, made because a session VWAP is only ever read against one anchor. The
 * anchor select holds the one value the id names, so a stored instance cannot drift from
 * the line its label promises.
 */
function sessionVwap(anchor: VwapAnchor, color: string): Pick<IndicatorDefinition, 'params' | 'compute'> {
  return {
    params: [
      { name: 'colors', label: 'Color', kind: 'colors', default: [color], slots: ['VWAP'] },
      { name: 'width', label: 'Width', kind: 'number', default: 2, min: 1, max: 8, step: 1 },
      { name: 'anchor', label: 'Anchor', kind: 'select', default: anchor, options: [anchor] },
      { name: 'price', label: 'Price', kind: 'select', default: 'hlc3', options: VWAP_PRICE_OPTIONS },
      { name: 'smooth', label: 'Smooth', kind: 'boolean', default: false },
    ],
    compute: (bars, params) => {
      const colors = colorList(params, ['VWAP']);
      const price = string(params, 'price', 'hlc3') as VwapPrice;
      return {
        caption: `(${string(params, 'anchor', anchor)}, ${price})`,
        plots: [
          { label: 'VWAP', color: colors[0] ?? color, width: number(params, 'width', 2), kind: 'line', values: vwap(bars, string(params, 'anchor', anchor) as VwapAnchor, price) },
        ],
        smooth: boolean(params, 'smooth', false),
      };
    },
  };
}

/** Band opacities, in the shipped scripts' 0-100 percent units: a faint fill, near-solid edges. */
export const BAND_FILL_OPACITY = 6;
const BAND_EDGE_OPACITY = 80;

/** Shared color/width/period/smooth shape the shipped moving-average scripts declare. */
function movingAverageParams(colors: readonly string[], period: number, periodMin: number, offset: boolean): ParamDescriptor[] {
  const out: ParamDescriptor[] = [
    { name: 'colors', label: 'Color', kind: 'colors', default: [...colors], slots: ['Line'] },
    { name: 'width', label: 'Width', kind: 'number', default: 1, min: 1, max: 8, step: 1 },
    { name: 'period', label: 'Period', kind: 'number', default: period, min: periodMin, max: 500, step: 1 },
    { name: 'source', label: 'Source', kind: 'select', default: 'close', options: SOURCE_OPTIONS },
  ];
  if (offset) out.push({ name: 'offset', label: 'Offset', kind: 'number', default: 0, min: 0, max: 500, step: 1 });
  out.push({ name: 'smooth', label: 'Smooth', kind: 'boolean', default: false });
  return out;
}

function singleLine(params: ParamValues, values: Values, label: string): IndicatorResult {
  const colors = colorList(params, ['Line']);
  const width = number(params, 'width', 1);
  const offset = Math.max(0, Math.floor(number(params, 'offset', 0)));
  return {
    caption: `(${number(params, 'period', 1)}${'source' in params ? `, ${string(params, 'source', 'close')}` : ''}${offset > 0 ? `, ${offset}` : ''})`,
    plots: [{ label, color: colors[0] ?? '#4b9cf5', width, kind: 'line', values: offset > 0 ? delay(values, offset) : values }],
    smooth: boolean(params, 'smooth', false),
  };
}

/** CVD and its aggregated twin share the shipped `cvd_anchor` select and its options. */
function cvdParams(color: readonly string[], slot: string): ParamDescriptor[] {
  return [
    { name: 'colors', label: 'Color', kind: 'colors', default: [...color], slots: [slot] },
    { name: 'width', label: 'Width', kind: 'number', default: 2, min: 1, max: 8, step: 1 },
    {
      name: 'cvd_anchor',
      label: 'CVD anchor',
      kind: 'select',
      default: 'UTC day',
      options: CVD_ANCHORS,
    },
    { name: 'smooth', label: 'Smooth', kind: 'boolean', default: false },
  ];
}

/*
 * The band names the default ladder answers with, used only before a window has arrived:
 * once the response is in, the lines take the labels the server sent instead.
 */
const CVD_BY_SIZE_SLOTS: readonly string[] = ['under 1k', '1k to 10k', '10k to 100k', '100k and up'];

/** Running delta since the anchor, which is what both CVD types plot. */
function cumulativeResult(bars: readonly Bar[], params: ParamValues, flow: PrintFlow | null, label: string): IndicatorResult {
  const colors = colorList(params, [label]);
  const anchor = string(params, 'cvd_anchor', 'UTC day') as CvdAnchor;
  return {
    caption: `(${anchor})`,
    plots: [
      { label, color: colors[0] ?? '#4b9cf5', width: number(params, 'width', 2), kind: 'line', values: cumulativeDelta(bars, flow, anchor) },
    ],
    note: flowNote(flow),
    smooth: boolean(params, 'smooth', false),
  };
}

export const INDICATORS: readonly IndicatorDefinition[] = [
  {
    id: 'SMA',
    label: 'Simple Moving Average (SMA)',
    short: 'SMA',
    placement: 'onchart',
    group: 'Moving averages',
    params: movingAverageParams(['red'], 26, 1, false),
    compute: (bars, params) =>
      singleLine(params, sma(sourceValues(bars, source(params)), number(params, 'period', 26)), 'SMA'),
  },
  {
    id: 'EMA',
    label: 'Exponential Moving Average (EMA)',
    short: 'EMA',
    placement: 'onchart',
    group: 'Moving averages',
    params: movingAverageParams(['red'], 26, 1, false),
    compute: (bars, params) =>
      singleLine(params, ema(sourceValues(bars, source(params)), number(params, 'period', 26)), 'EMA'),
  },
  {
    id: 'WMA',
    label: 'Weighted Moving Average',
    short: 'WMA',
    placement: 'onchart',
    group: 'Moving averages',
    params: movingAverageParams(['#6c9bd2'], 9, 1, true),
    compute: (bars, params) =>
      singleLine(params, wma(sourceValues(bars, source(params)), number(params, 'period', 9)), 'WMA'),
  },
  {
    id: 'HMA',
    label: 'Hull Moving Average',
    short: 'HMA',
    placement: 'onchart',
    group: 'Moving averages',
    params: movingAverageParams(['#d6a2e8'], 9, 2, false),
    compute: (bars, params) =>
      singleLine(params, hma(sourceValues(bars, source(params)), number(params, 'period', 9)), 'HMA'),
  },
  {
    id: 'VWMA',
    label: 'Volume Weighted Moving Average',
    short: 'VWMA',
    placement: 'onchart',
    group: 'Moving averages',
    params: movingAverageParams(['#e0a064'], 20, 1, true),
    compute: (bars, params) =>
      singleLine(
        params,
        vwma(sourceValues(bars, source(params)), bars.map((bar) => bar.volume), number(params, 'period', 20)),
        'VWMA',
      ),
  },
  {
    id: 'BOLLINGER_BANDS',
    label: 'Bollinger Bands',
    short: 'BB',
    placement: 'onchart',
    group: 'Trend',
    params: [
      { name: 'colors', label: 'Colors', kind: 'colors', default: ['blue', 'red', 'green'], slots: ['Upper', 'Middle', 'Lower'] },
      { name: 'width', label: 'Width', kind: 'number', default: 2, min: 1, max: 8, step: 1 },
      { name: 'period', label: 'Period', kind: 'number', default: 20, min: 2, max: 500, step: 1 },
      { name: 'stdDev', label: 'Std Dev', kind: 'number', default: 2, min: 0.5, max: 10, step: 0.1 },
      { name: 'smooth', label: 'Smooth', kind: 'boolean', default: false },
    ],
    compute: (bars, params) => {
      const colors = colorList(params, ['Upper', 'Middle', 'Lower']);
      const width = number(params, 'width', 2);
      const period = number(params, 'period', 20);
      const stdDev = number(params, 'stdDev', 2);
      const bands = bollinger(sourceValues(bars, 'close'), period, stdDev);
      return {
        caption: `(${period}, ${stdDev})`,
        plots: [
          { label: 'Upper', color: withAlpha(colors[0] ?? '#4b9cf5', BAND_EDGE_OPACITY), width, kind: 'line', values: bands.upper },
          { label: 'Middle', color: colors[1] ?? '#cbd5e1', width, kind: 'line', values: bands.basis },
          { label: 'Lower', color: withAlpha(colors[2] ?? '#4b9cf5', BAND_EDGE_OPACITY), width, kind: 'line', values: bands.lower },
        ],
        band: { upper: 0, lower: 2, color: withAlpha(colors[0] ?? '#4b9cf5', BAND_FILL_OPACITY) },
        smooth: boolean(params, 'smooth', false),
      };
    },
  },
  {
    id: 'VWAP',
    label: 'VWAP',
    short: 'VWAP',
    placement: 'onchart',
    group: 'VWAP',
    // Names come from the shipped `vwap(anchor, price)` built-in; the day anchor and
    // the color are this project's choice, since the data-backed VWAP ships no table.
    params: [
      { name: 'colors', label: 'Color', kind: 'colors', default: ['#e8b242'], slots: ['VWAP'] },
      { name: 'width', label: 'Width', kind: 'number', default: 2, min: 1, max: 8, step: 1 },
      {
        name: 'anchor',
        label: 'Anchor',
        kind: 'select',
        default: 'day',
        options: ['none', 'day', 'week', 'month', 'quarter', 'year'],
      },
      { name: 'price', label: 'Price', kind: 'select', default: 'hlc3', options: VWAP_PRICE_OPTIONS },
      { name: 'smooth', label: 'Smooth', kind: 'boolean', default: false },
    ],
    compute: (bars, params) => {
      const colors = colorList(params, ['VWAP']);
      const anchor = string(params, 'anchor', 'day') as VwapAnchor;
      const price = string(params, 'price', 'hlc3') as VwapPrice;
      return {
        caption: `(${anchor}, ${price})`,
        plots: [{ label: 'VWAP', color: colors[0] ?? '#e8b242', width: number(params, 'width', 2), kind: 'line', values: vwap(bars, anchor, price) }],
        smooth: boolean(params, 'smooth', false),
      };
    },
  },
  {
    id: 'RSI',
    label: 'Relative Strength Index (RSI)',
    short: 'RSI',
    placement: 'offchart',
    group: 'Momentum',
    params: [
      { name: 'colors', label: 'Color', kind: 'colors', default: ['orange'], slots: ['RSI'] },
      { name: 'width', label: 'Width', kind: 'number', default: 2, min: 1, max: 8, step: 1 },
      { name: 'period', label: 'Period', kind: 'number', default: 26, min: 2, max: 200, step: 1 },
      { name: 'smooth', label: 'Smooth', kind: 'boolean', default: true },
    ],
    pane: { levels: [30, 50, 70], range: { min: 0, max: 100 }, precision: 1 },
    compute: (bars, params) => {
      const colors = colorList(params, ['RSI']);
      const period = number(params, 'period', 26);
      const closes = sourceValues(bars, 'close');
      // Wilder's recursion is the shipped `rsi`; switching `smooth` off averages the
      // same gains and losses over a rolling window instead.
      const values = boolean(params, 'smooth', true) ? rsi(closes, period) : rsiSimple(closes, period);
      return {
        caption: `(${period}${boolean(params, 'smooth', true) ? '' : ', simple'})`,
        plots: [{ label: 'RSI', color: colors[0] ?? '#ffa500', width: number(params, 'width', 2), kind: 'line', values }],
        smooth: false,
      };
    },
  },
  {
    id: 'MACD',
    label: 'Moving Average Convergence Divergence',
    short: 'MACD',
    placement: 'offchart',
    group: 'Trend',
    params: [
      { name: 'colors', label: 'Colors', kind: 'colors', default: ['red', 'green'], slots: ['MACD', 'Signal'] },
      { name: 'width', label: 'Width', kind: 'number', default: 1, min: 1, max: 8, step: 1 },
      { name: 'fastPeriod', label: 'Fast', kind: 'number', default: 12, min: 2, max: 200, step: 1 },
      { name: 'slowPeriod', label: 'Slow', kind: 'number', default: 26, min: 3, max: 300, step: 1 },
      { name: 'signalPeriod', label: 'Signal', kind: 'number', default: 9, min: 2, max: 100, step: 1 },
      { name: 'smooth', label: 'Smooth', kind: 'boolean', default: false },
    ],
    pane: { zeroLine: true, priceUnits: true },
    compute: (bars, params) => {
      const colors = colorList(params, ['MACD', 'Signal']);
      const fast = number(params, 'fastPeriod', 12);
      const slow = number(params, 'slowPeriod', 26);
      const signalPeriod = number(params, 'signalPeriod', 9);
      const lines = macd(sourceValues(bars, 'close'), fast, slow, signalPeriod);
      const width = number(params, 'width', 1);
      const smooth = boolean(params, 'smooth', false);
      return {
        caption: `(${fast}, ${slow}, ${signalPeriod})`,
        plots: [
          { label: 'MACD', color: colors[0] ?? '#e8555c', width, kind: 'line', values: lines.line },
          { label: 'Signal', color: colors[1] ?? '#26b98a', width, kind: 'line', values: lines.signal },
          { label: 'Hist', color: withAlpha(colors[0] ?? '#e8555c', 45), width: 0, kind: 'histogram', values: lines.hist },
        ],
        smooth,
      };
    },
  },
  {
    id: 'STOCH',
    label: 'Stochastic Oscillator',
    short: 'STOCH',
    placement: 'offchart',
    group: 'Momentum',
    params: [
      { name: 'colors', label: 'Colors', kind: 'colors', default: ['#2196F3', '#FF9800'], slots: ['K', 'D'] },
      { name: 'width', label: 'Width', kind: 'number', default: 1, min: 1, max: 8, step: 1 },
      { name: 'kPeriod', label: 'K Period', kind: 'number', default: 14, min: 2, max: 200, step: 1 },
      { name: 'kSmoothing', label: 'K Smoothing', kind: 'number', default: 3, min: 1, max: 50, step: 1 },
      { name: 'dPeriod', label: 'D Period', kind: 'number', default: 3, min: 1, max: 50, step: 1 },
      { name: 'smooth', label: 'Smooth', kind: 'boolean', default: false },
    ],
    pane: { levels: [20, 50, 80], range: { min: 0, max: 100 }, precision: 1 },
    compute: (bars, params) => {
      const colors = colorList(params, ['K', 'D']);
      const kPeriod = number(params, 'kPeriod', 14);
      const kSmoothing = number(params, 'kSmoothing', 3);
      const dPeriod = number(params, 'dPeriod', 3);
      const lines = stochastic(
        bars.map((bar) => bar.high),
        bars.map((bar) => bar.low),
        bars.map((bar) => bar.close),
        kPeriod,
        kSmoothing,
        dPeriod,
      );
      const width = number(params, 'width', 1);
      const smooth = boolean(params, 'smooth', false);
      return {
        caption: `(${kPeriod}, ${kSmoothing}, ${dPeriod})`,
        plots: [
          { label: 'K', color: colors[0] ?? '#2196f3', width, kind: 'line', values: lines.k },
          { label: 'D', color: colors[1] ?? '#ff9800', width, kind: 'line', values: lines.d },
        ],
        smooth,
      };
    },
  },
  {
    id: 'ATR',
    label: 'Average True Range',
    short: 'ATR',
    placement: 'offchart',
    group: 'Volatility',
    params: [
      { name: 'colors', label: 'Color', kind: 'colors', default: ['#e0a064'], slots: ['ATR'] },
      { name: 'width', label: 'Width', kind: 'number', default: 1, min: 1, max: 8, step: 1 },
      { name: 'period', label: 'Period', kind: 'number', default: 14, min: 1, max: 200, step: 1 },
      { name: 'smoothing', label: 'Smoothing', kind: 'select', default: 'RMA', options: ['RMA', 'SMA', 'EMA', 'WMA'] },
      { name: 'smooth', label: 'Smooth', kind: 'boolean', default: false },
    ],
    pane: { zeroLine: true, priceUnits: true },
    compute: (bars, params) => {
      const colors = colorList(params, ['ATR']);
      const period = number(params, 'period', 14);
      const smoothing = string(params, 'smoothing', 'RMA') as AtrSmoothing;
      return {
        caption: `(${period}, ${smoothing})`,
        plots: [
          { label: 'ATR', color: colors[0] ?? '#e0a064', width: number(params, 'width', 1), kind: 'line', values: atr(bars, period, smoothing) },
        ],
        smooth: boolean(params, 'smooth', false),
      };
    },
  },
  {
    id: 'SUPERTREND',
    label: 'Supertrend',
    short: 'Supertrend',
    placement: 'onchart',
    group: 'Trend',
    // Id, title, parameter names and both defaults come from the shipped `SUPERTREND`
    // table. Its `fillOpacity` is the one input left undrawn: the two trend lines never
    // share a bar, so there is nothing between them to fill.
    params: [
      { name: 'colors', label: 'Colors', kind: 'colors', default: ['#A7BE94', '#AF6870'], slots: ['Up Trend', 'Down Trend'] },
      { name: 'width', label: 'Width', kind: 'number', default: 1, min: 1, max: 8, step: 1 },
      { name: 'atrPeriod', label: 'ATR Period', kind: 'number', default: 10, min: 1, max: 200, step: 1 },
      { name: 'factor', label: 'Factor', kind: 'number', default: 3, min: 0.5, max: 10, step: 0.1 },
    ],
    compute: (bars, params) => {
      const colors = colorList(params, ['Up Trend', 'Down Trend']);
      const atrPeriod = number(params, 'atrPeriod', 10);
      const factor = number(params, 'factor', 3);
      const width = number(params, 'width', 1);
      const lines = supertrend(bars, atrPeriod, factor);
      return {
        caption: `(${atrPeriod}, ${factor})`,
        plots: [
          { label: 'Up Trend', color: colors[0] ?? '#a7be94', width, kind: 'line', values: lines.up },
          { label: 'Down Trend', color: colors[1] ?? '#af6870', width, kind: 'line', values: lines.down },
        ],
        smooth: false,
      };
    },
  },
  {
    id: 'ICHI_CLOUD',
    label: 'Ichimoku Cloud',
    short: 'Ichimoku',
    placement: 'onchart',
    group: 'Trend',
    // Id, title, parameter names, defaults and the five plot slots come from the shipped
    // `ICHI_CLOUD` table and its output list. Each line waits for its window to fill and
    // the lagging span simply stops at the right edge, where its future bar has not
    // printed yet — the shipped engine instead plots partial windows from bar 0 and turns
    // every absent value into 0, which would put a line at zero on this chart.
    params: [
      {
        name: 'colors',
        label: 'Colors',
        kind: 'colors',
        default: ['#6C9BD2', '#E0A064', '#A7BE94', '#AF6870', '#D6A2E8'],
        slots: ['Tenkan', 'Kijun', 'Span A', 'Span B', 'Chikou'],
      },
      { name: 'smooth', label: 'Smooth', kind: 'boolean', default: false },
      { name: 'width', label: 'Width', kind: 'number', default: 1, min: 1, max: 8, step: 1 },
      { name: 'conversionPeriod', label: 'Conversion', kind: 'number', default: 9, min: 1, max: 200, step: 1 },
      { name: 'basePeriod', label: 'Base', kind: 'number', default: 26, min: 1, max: 300, step: 1 },
      { name: 'laggingSpanPeriod', label: 'Lagging Span', kind: 'number', default: 52, min: 1, max: 500, step: 1 },
      { name: 'displacement', label: 'Displacement', kind: 'number', default: 26, min: 0, max: 300, step: 1 },
      { name: 'cloudOpacity', label: 'Cloud Opacity', kind: 'number', default: 16, min: 0, max: 100, step: 1 },
    ],
    compute: (bars, params) => {
      const colors = colorList(params, ['Tenkan', 'Kijun', 'Span A', 'Span B', 'Chikou']);
      const conversion = number(params, 'conversionPeriod', 9);
      const base = number(params, 'basePeriod', 26);
      const lagging = number(params, 'laggingSpanPeriod', 52);
      const displacement = number(params, 'displacement', 26);
      const width = number(params, 'width', 1);
      const lines = ichimoku(bars, conversion, base, lagging, displacement);
      const plot = (label: string, color: string, values: Values): IndicatorPlot => ({ label, color, width, kind: 'line', values });
      return {
        caption: `(${conversion}, ${base}, ${lagging}, ${displacement})`,
        plots: [
          plot('Tenkan', colors[0] ?? '#6c9bd2', lines.tenkan),
          plot('Kijun', colors[1] ?? '#e0a064', lines.kijun),
          plot('Span A', withAlpha(colors[2] ?? '#a7be94', BAND_EDGE_OPACITY), lines.senkouA),
          plot('Span B', withAlpha(colors[3] ?? '#af6870', BAND_EDGE_OPACITY), lines.senkouB),
          plot('Chikou', colors[4] ?? '#d6a2e8', lines.chikou),
        ],
        band: {
          upper: 2,
          lower: 3,
          color: withAlpha(colors[2] ?? '#a7be94', number(params, 'cloudOpacity', 16)),
        },
        smooth: boolean(params, 'smooth', false),
      };
    },
  },
  {
    id: 'VWAP_DAILY',
    label: 'VWAP (Daily)',
    short: 'VWAP D',
    placement: 'onchart',
    group: 'VWAP',
    ...sessionVwap('day', '#e8b242'),
  },
  {
    id: 'VWAP_WEEKLY',
    label: 'VWAP (Weekly)',
    short: 'VWAP W',
    placement: 'onchart',
    group: 'VWAP',
    ...sessionVwap('week', '#9ad1c0'),
  },
  {
    id: 'VWAP_MONTHLY',
    label: 'VWAP (Monthly)',
    short: 'VWAP M',
    placement: 'onchart',
    group: 'VWAP',
    ...sessionVwap('month', '#d6a2e8'),
  },
  {
    id: 'PIVOT_POINTS',
    label: 'Pivot Points Standard',
    short: 'Pivots',
    placement: 'onchart',
    group: 'Levels',
    // Id, title and parameter names come from the shipped `PIVOT_POINTS` table, and the
    // three formulas are the ones its `PivotPoints` kit computes. Levels anchor to the
    // UTC calendar: the day ladder restarts at 00:00 UTC, the week ladder on Monday
    // 00:00 UTC, the month ladder on the 1st at 00:00 UTC, each reading the range of the
    // period that just closed. The shipped table also offers `Auto` (the ladder follows
    // the chart's timeframe) and tiers 4 and 5, which its own seven-level formula does
    // not produce; neither is offered here.
    params: [
      { name: 'colors', label: 'Colors', kind: 'colors', default: ['#FB8C00', '#EF5350', '#26A69A'], slots: ['Pivot', 'Resistance', 'Support'] },
      { name: 'pivotType', label: 'Type', kind: 'select', default: 'Traditional', options: ['Traditional', 'Camarilla', 'Woodie'] },
      { name: 'pivotTimeframe', label: 'Timeframe', kind: 'select', default: 'day', options: ['day', 'week', 'month'] },
      { name: 'pivotsBack', label: 'Periods Back', kind: 'number', default: 15, min: 1, max: 200, step: 1 },
      { name: 'width', label: 'Width', kind: 'number', default: 1, min: 1, max: 8, step: 1 },
      { name: 'showP', label: 'Show Pivot', kind: 'boolean', default: true },
      { name: 'showTier1', label: 'Show R1 / S1', kind: 'boolean', default: true },
      { name: 'showTier2', label: 'Show R2 / S2', kind: 'boolean', default: true },
      { name: 'showTier3', label: 'Show R3 / S3', kind: 'boolean', default: true },
    ],
    compute: (bars, params) => {
      const colors = colorList(params, ['Pivot', 'Resistance', 'Support']);
      const kind = string(params, 'pivotType', 'Traditional') as PivotKind;
      const timeframe = string(params, 'pivotTimeframe', 'day') as PivotTimeframe;
      const back = Math.max(1, Math.floor(number(params, 'pivotsBack', 15)));
      const width = number(params, 'width', 1);
      const levels = pivotPoints(bars, kind, timeframe, back);
      const plot = (label: string, color: string, values: Values, on: boolean): IndicatorPlot | null =>
        on ? { label, color, width, kind: 'line', values } : null;
      const plots = [
        plot('PP', colors[0] ?? '#fb8c00', levels.pp, boolean(params, 'showP', true)),
        plot('R1', colors[1] ?? '#ef5350', levels.r1, boolean(params, 'showTier1', true)),
        plot('R2', colors[1] ?? '#ef5350', levels.r2, boolean(params, 'showTier2', true)),
        plot('R3', colors[1] ?? '#ef5350', levels.r3, boolean(params, 'showTier3', true)),
        plot('S1', colors[2] ?? '#26a69a', levels.s1, boolean(params, 'showTier1', true)),
        plot('S2', colors[2] ?? '#26a69a', levels.s2, boolean(params, 'showTier2', true)),
        plot('S3', colors[2] ?? '#26a69a', levels.s3, boolean(params, 'showTier3', true)),
      ].filter((entry): entry is IndicatorPlot => entry !== null);
      return {
        caption: `(${kind.toLowerCase()}, ${timeframe}, ${back})`,
        plots,
        smooth: false,
      };
    },
  },
  {
    id: 'ADX',
    label: 'Average Directional Index (ADX)',
    short: 'ADX',
    placement: 'offchart',
    group: 'Trend',
    // Id, title, parameter names and defaults come from the shipped `ADX` table, and its
    // three output names fix which color is which line. One `period` drives both stages,
    // as the shipped single-length script does: +DI and −DI appear at bar `period`, ADX
    // at bar `2 · period − 1`. `showCloud` (the fill where +DI leads −DI) is not drawn.
    params: [
      { name: 'colors', label: 'Colors', kind: 'colors', default: ['#E0A064', '#A7BE94', '#AF6870'], slots: ['ADX', '+DI', '-DI'] },
      { name: 'width', label: 'Width', kind: 'number', default: 1, min: 1, max: 8, step: 1 },
      { name: 'period', label: 'Period', kind: 'number', default: 14, min: 1, max: 200, step: 1 },
      { name: 'smooth', label: 'Smooth', kind: 'boolean', default: false },
      { name: 'threshold', label: 'Threshold', kind: 'number', default: 25, min: 1, max: 100, step: 1 },
    ],
    pane: { range: { min: 0, max: 100 }, precision: 1 },
    compute: (bars, params) => {
      const colors = colorList(params, ['ADX', '+DI', '-DI']);
      const period = number(params, 'period', 14);
      const width = number(params, 'width', 1);
      const lines = dmi(bars, period, period);
      return {
        caption: `(${period})`,
        plots: [
          { label: 'ADX', color: colors[0] ?? '#e0a064', width, kind: 'line', values: lines.adx },
          { label: '+DI', color: colors[1] ?? '#a7be94', width, kind: 'line', values: lines.diPlus },
          { label: '-DI', color: colors[2] ?? '#af6870', width, kind: 'line', values: lines.diMinus },
        ],
        levels: [number(params, 'threshold', 25)],
        smooth: boolean(params, 'smooth', false),
      };
    },
  },
  {
    id: 'CCI',
    label: 'Commodity Channel Index (CCI)',
    short: 'CCI',
    placement: 'offchart',
    group: 'Momentum',
    // Id, title and parameter names come from the shipped `CCI` table, which spells its
    // width `lineWidth` and ships the deviation divisor as `constant`. `source` is the
    // shipped input, whose own built-in ignores it and reads typical price; `hlc3` is
    // offered so the same line is reachable. The thresholds are the shipped
    // `overbought`/`oversold` inputs, drawn as the pane's guides.
    params: [
      { name: 'colors', label: 'Color', kind: 'colors', default: ['#6C9BD2'], slots: ['CCI'] },
      { name: 'lineWidth', label: 'Line Width', kind: 'number', default: 1, min: 1, max: 8, step: 1 },
      { name: 'smooth', label: 'Smooth', kind: 'boolean', default: false },
      { name: 'period', label: 'Period', kind: 'number', default: 20, min: 2, max: 200, step: 1 },
      { name: 'constant', label: 'Constant', kind: 'number', default: 0.015, min: 0.001, max: 1, step: 0.001 },
      { name: 'source', label: 'Source', kind: 'select', default: 'close', options: CCI_SOURCE_OPTIONS },
      { name: 'overbought', label: 'Overbought', kind: 'number', default: 100, min: 0, max: 1000, step: 1 },
      { name: 'oversold', label: 'Oversold', kind: 'number', default: -100, min: -1000, max: 0, step: 1 },
    ],
    pane: { zeroLine: true, precision: 1 },
    compute: (bars, params) => {
      const colors = colorList(params, ['CCI']);
      const period = number(params, 'period', 20);
      const constant = number(params, 'constant', 0.015);
      return {
        caption: `(${period}, ${constant}, ${string(params, 'source', 'close')})`,
        plots: [
          {
            label: 'CCI',
            color: colors[0] ?? '#6c9bd2',
            width: number(params, 'lineWidth', 1),
            kind: 'line',
            values: cciClassic(cciSource(bars, params), period, constant),
          },
        ],
        levels: [number(params, 'oversold', -100), 0, number(params, 'overbought', 100)],
        smooth: boolean(params, 'smooth', false),
      };
    },
  },
  {
    id: 'MFI',
    label: 'Money Flow Index (MFI)',
    short: 'MFI',
    placement: 'offchart',
    group: 'Volume',
    // Id, title, parameter names and defaults come from the shipped `MFI` table. Its
    // `source` input is left out: the index is defined on typical price times volume, and
    // the shipped built-in reads typical price whatever that input says.
    params: [
      { name: 'colors', label: 'Color', kind: 'colors', default: ['#D6A2E8'], slots: ['MFI'] },
      { name: 'width', label: 'Line Width', kind: 'number', default: 1, min: 1, max: 8, step: 1 },
      { name: 'period', label: 'Period', kind: 'number', default: 14, min: 2, max: 200, step: 1 },
      { name: 'smooth', label: 'Smooth', kind: 'boolean', default: false },
      { name: 'overbought', label: 'Overbought', kind: 'number', default: 80, min: 0, max: 100, step: 1 },
      { name: 'oversold', label: 'Oversold', kind: 'number', default: 20, min: 0, max: 100, step: 1 },
    ],
    pane: { range: { min: 0, max: 100 }, precision: 1 },
    compute: (bars, params) => {
      const colors = colorList(params, ['MFI']);
      const period = number(params, 'period', 14);
      return {
        caption: `(${period})`,
        plots: [
          { label: 'MFI', color: colors[0] ?? '#d6a2e8', width: number(params, 'width', 1), kind: 'line', values: mfi(bars, period) },
        ],
        levels: [number(params, 'oversold', 20), 50, number(params, 'overbought', 80)],
        smooth: boolean(params, 'smooth', false),
      };
    },
  },
  {
    id: 'OBV',
    label: 'On-Balance Volume (OBV)',
    short: 'OBV',
    placement: 'offchart',
    group: 'Volume',
    // Id, title, parameter names and defaults come from the shipped `OBV` table, which
    // carries no inputs beyond color and width: the line is a running sum, not a window.
    params: [
      { name: 'colors', label: 'Color', kind: 'colors', default: ['#6C9BD2'], slots: ['OBV'] },
      { name: 'smooth', label: 'Smooth', kind: 'boolean', default: false },
      { name: 'width', label: 'Width', kind: 'number', default: 1, min: 1, max: 8, step: 1 },
    ],
    pane: { zeroLine: true, precision: 0 },
    compute: (bars, params) => {
      const colors = colorList(params, ['OBV']);
      return {
        caption: '(cumulative)',
        plots: [
          { label: 'OBV', color: colors[0] ?? '#6c9bd2', width: number(params, 'width', 1), kind: 'line', values: obv(bars) },
        ],
        smooth: boolean(params, 'smooth', false),
      };
    },
  },
  {
    id: 'WILLIAMS_R',
    label: 'Williams %R',
    short: '%R',
    placement: 'offchart',
    group: 'Momentum',
    // Id, title, parameter names and defaults come from the shipped `WILLIAMS_R` table,
    // which names its length `length` and counts the scale down from 0.
    params: [
      { name: 'colors', label: 'Color', kind: 'colors', default: ['#D6A2E8'], slots: ['%R'] },
      { name: 'width', label: 'Width', kind: 'number', default: 1, min: 1, max: 8, step: 1 },
      { name: 'length', label: 'Length', kind: 'number', default: 14, min: 2, max: 200, step: 1 },
      { name: 'smooth', label: 'Smooth', kind: 'boolean', default: false },
      { name: 'source', label: 'Source', kind: 'select', default: 'close', options: SOURCE_OPTIONS },
      { name: 'overbought', label: 'Overbought', kind: 'number', default: -20, min: -100, max: 0, step: 1 },
      { name: 'oversold', label: 'Oversold', kind: 'number', default: -80, min: -100, max: 0, step: 1 },
    ],
    pane: { range: { min: -100, max: 0 }, precision: 1 },
    compute: (bars, params) => {
      const colors = colorList(params, ['%R']);
      const length = number(params, 'length', 14);
      return {
        caption: `(${length}, ${string(params, 'source', 'close')})`,
        plots: [
          {
            label: '%R',
            color: colors[0] ?? '#d6a2e8',
            width: number(params, 'width', 1),
            kind: 'line',
            values: williamsR(bars, length, source(params)),
          },
        ],
        levels: [number(params, 'oversold', -80), -50, number(params, 'overbought', -20)],
        smooth: boolean(params, 'smooth', false),
      };
    },
  },
  {
    id: 'STOCH_RSI',
    label: 'Stochastic RSI',
    short: 'StochRSI',
    placement: 'offchart',
    group: 'Momentum',
    // Id, title, parameter names and defaults come from the shipped `STOCH_RSI` table.
    // Its four lengths and the order they warm up in are the shipped script's own:
    // the line starts at bar `rsiLength + stochLength + kSmoothing + dSmoothing - 2`.
    params: [
      { name: 'colors', label: 'Colors', kind: 'colors', default: ['#6C9BD2', '#E0A064'], slots: ['K', 'D'] },
      { name: 'width', label: 'Width', kind: 'number', default: 1, min: 1, max: 8, step: 1 },
      { name: 'kSmoothing', label: 'K Smoothing', kind: 'number', default: 3, min: 1, max: 50, step: 1 },
      { name: 'dSmoothing', label: 'D Smoothing', kind: 'number', default: 3, min: 1, max: 50, step: 1 },
      { name: 'rsiLength', label: 'RSI Length', kind: 'number', default: 14, min: 2, max: 200, step: 1 },
      { name: 'stochLength', label: 'Stoch Length', kind: 'number', default: 14, min: 2, max: 200, step: 1 },
      { name: 'smooth', label: 'Smooth', kind: 'boolean', default: false },
      { name: 'source', label: 'Source', kind: 'select', default: 'close', options: SOURCE_OPTIONS },
      { name: 'overbought', label: 'Overbought', kind: 'number', default: 80, min: 0, max: 100, step: 1 },
      { name: 'oversold', label: 'Oversold', kind: 'number', default: 20, min: 0, max: 100, step: 1 },
    ],
    pane: { range: { min: 0, max: 100 }, precision: 1 },
    compute: (bars, params) => {
      const colors = colorList(params, ['K', 'D']);
      const kSmoothing = number(params, 'kSmoothing', 3);
      const dSmoothing = number(params, 'dSmoothing', 3);
      const rsiLength = number(params, 'rsiLength', 14);
      const stochLength = number(params, 'stochLength', 14);
      const lines = stochRsi(sourceValues(bars, source(params)), rsiLength, stochLength, kSmoothing, dSmoothing);
      const width = number(params, 'width', 1);
      return {
        caption: `(${kSmoothing}, ${dSmoothing}, ${rsiLength}, ${stochLength})`,
        plots: [
          { label: 'K', color: colors[0] ?? '#6c9bd2', width, kind: 'line', values: lines.k },
          { label: 'D', color: colors[1] ?? '#e0a064', width, kind: 'line', values: lines.d },
        ],
        levels: [number(params, 'oversold', 20), 50, number(params, 'overbought', 80)],
        smooth: boolean(params, 'smooth', false),
      };
    },
  },
  {
    id: 'VOLUME_DELTA',
    label: 'Volume Delta',
    short: 'Delta',
    placement: 'offchart',
    group: 'Order flow',
    needsPrints: true,
    // The shipped type is server-fed and carries no parameter table, so the two colors
    // are this project's own, one per half of the histogram.
    params: [
      { name: 'colors', label: 'Colors', kind: 'colors', default: ['green', 'red'], slots: ['Above zero', 'Below zero'] },
      { name: 'width', label: 'Width', kind: 'number', default: 1, min: 1, max: 8, step: 1 },
    ],
    pane: { zeroLine: true, precision: 2 },
    compute: (bars, params, flow) => {
      const colors = colorList(params, ['Above zero', 'Below zero']);
      return {
        caption: '(buy - sell)',
        plots: [
          {
            label: 'Delta',
            color: colors[0] ?? '#26b98a',
            negativeColor: colors[1] ?? '#e53946',
            width: number(params, 'width', 1),
            kind: 'histogram',
            values: flowDelta(bars, flow),
          },
        ],
        note: flowNote(flow),
        smooth: false,
      };
    },
  },
  {
    id: 'CUMULATIVE_VOLUME_DELTA',
    label: 'CVD',
    short: 'CVD',
    placement: 'offchart',
    group: 'Order flow',
    needsPrints: true,
    params: cvdParams(['#4b9cf5'], 'CVD'),
    pane: { zeroLine: true, precision: 2 },
    compute: (bars, params, flow) => cumulativeResult(bars, params, flow, 'CVD'),
  },
  {
    // The shipped twin of CVD differs only in that it adds several venues' prints. One
    // instrument id here is one venue, so the two compute the same numbers.
    id: 'AGGREGATED_CUMULATIVE_VOLUME_DELTA',
    label: 'Agg. Cumulative Volume Delta',
    short: 'Agg CVD',
    placement: 'offchart',
    group: 'Order flow',
    needsPrints: true,
    params: cvdParams(['#e8b242'], 'Agg CVD'),
    pane: { zeroLine: true, precision: 2 },
    compute: (bars, params, flow) => cumulativeResult(bars, params, flow, 'Agg CVD'),
  },
  {
    // The shipped product carries this as a server-fed type whose payload was never
    // recovered, so the shape here is this project's own: one cumulative line per size
    // band, the bands being whatever ladder the server answered with.
    id: 'CVD_BY_SIZE',
    label: 'CVD by Size',
    short: 'CVD Size',
    placement: 'offchart',
    group: 'Order flow',
    needsSizeBands: true,
    // One colour per band of the default ladder, so a stored instance keeps all four
    // through the parameter repair every document goes through.
    params: [
      { name: 'colors', label: 'Color', kind: 'colors', default: ['#4b9cf5', '#26b98a', '#e8b242', '#c58af9'], slots: CVD_BY_SIZE_SLOTS },
      { name: 'width', label: 'Width', kind: 'number', default: 2, min: 1, max: 8, step: 1 },
      { name: 'cvd_anchor', label: 'CVD anchor', kind: 'select', default: 'UTC day', options: CVD_ANCHORS },
      { name: 'smooth', label: 'Smooth', kind: 'boolean', default: false },
    ],
    pane: { zeroLine: true, precision: 2 },
    compute: (bars, params, _flow, bandsInput) => {
      const bands = bandsInput ?? null;
      const anchor = string(params, 'cvd_anchor', 'UTC day') as CvdAnchor;
      // The line labels are the server's band names, so another ladder relabels the lines
      // instead of leaving the chart describing bands the response never used.
      const slots = bands && bands.bands.length > 0 ? bands.bands.map((band) => band.label) : CVD_BY_SIZE_SLOTS;
      const colors = colorList(params, slots);
      const width = number(params, 'width', 2);
      return {
        caption: `(${anchor}, ${slots.length} bands)`,
        plots: slots.map((label, band) => ({
          label,
          color: colors[band] ?? '#4b9cf5',
          width,
          kind: 'line' as const,
          values: bandCumulative(bars, bands, band, anchor),
        })),
        note: sizeBandNote(bands),
        smooth: boolean(params, 'smooth', false),
      };
    },
  },
  {
    id: 'CVD_FLOW_DOMINANCE',
    label: 'CVD Flow Dominance',
    short: 'Flow Dom',
    placement: 'offchart',
    group: 'Order flow',
    needsPrints: true,
    // Shipped as a server-fed type with no parameter table and no description, so the
    // lookback name and default are this project's own: `period`, as every other
    // lookback in this registry spells it.
    params: [
      { name: 'colors', label: 'Color', kind: 'colors', default: ['#b48cf0'], slots: ['Dominance'] },
      { name: 'width', label: 'Width', kind: 'number', default: 2, min: 1, max: 8, step: 1 },
      { name: 'period', label: 'Period', kind: 'number', default: 14, min: 2, max: 200, step: 1 },
      { name: 'smooth', label: 'Smooth', kind: 'boolean', default: false },
    ],
    pane: { levels: [-50, 0, 50], range: { min: -100, max: 100 }, precision: 1 },
    compute: (bars, params, flow) => {
      const colors = colorList(params, ['Dominance']);
      const period = number(params, 'period', 14);
      return {
        caption: `(${period}, % of volume)`,
        plots: [
          {
            label: 'Dominance',
            color: colors[0] ?? '#b48cf0',
            width: number(params, 'width', 2),
            kind: 'line',
            values: flowDominance(bars, flow, period),
          },
        ],
        note: flowNote(flow),
        smooth: boolean(params, 'smooth', false),
      };
    },
  },
];

const BY_ID = new Map(INDICATORS.map((definition) => [definition.id, definition]));

export function indicatorById(id: string): IndicatorDefinition | null {
  return BY_ID.get(id) ?? null;
}

export function defaultsFor(definition: IndicatorDefinition): ParamValues {
  const out: ParamValues = {};
  for (const descriptor of definition.params) out[descriptor.name] = cloneValue(descriptor.default);
  return out;
}

export function cloneValue(value: ParamValue): ParamValue {
  return Array.isArray(value) ? value.slice() : value;
}

function source(params: ParamValues): SourceField {
  return string(params, 'source', 'close') as SourceField;
}

export function number(params: ParamValues, name: string, fallback: number): number {
  const value = params[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function boolean(params: ParamValues, name: string, fallback: boolean): boolean {
  const value = params[name];
  return typeof value === 'boolean' ? value : fallback;
}

export function string(params: ParamValues, name: string, fallback: string): string {
  const value = params[name];
  return typeof value === 'string' && value ? value : fallback;
}

/** Colors, padded to one entry per slot so a short stored list still plots. */
export function colorList(params: ParamValues, slots: readonly string[]): string[] {
  const raw = params['colors'];
  const list = Array.isArray(raw) ? raw.filter((color): color is string => typeof color === 'string' && color !== '') : [];
  return slots.map((_, index) => list[index] ?? list[list.length - 1] ?? '#4b9cf5');
}

/** Accepts `#rrggbb`, `#rgb` and the plain CSS names the shipped defaults use. */
export function withAlpha(color: string, percent: number): string {
  const rgb = parseColor(color);
  if (!rgb) return color;
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(percent / 100).toFixed(3)})`;
}

const NAMED_COLORS: Record<string, readonly [number, number, number]> = {
  red: [229, 57, 70],
  green: [38, 185, 138],
  blue: [33, 150, 243],
  orange: [255, 165, 0],
  purple: [171, 71, 188],
  white: [236, 239, 244],
  yellow: [240, 200, 74],
};

/** Normalises any accepted color into the `#rrggbb` form a color input needs. */
export function toHex(color: string): string {
  const rgb = parseColor(color);
  if (!rgb) return '#4b9cf5';
  return `#${rgb.map((part) => Math.max(0, Math.min(255, Math.round(part))).toString(16).padStart(2, '0')).join('')}`;
}

function parseColor(color: string): [number, number, number] | null {
  const named = NAMED_COLORS[color.toLowerCase()];
  if (named) return [named[0], named[1], named[2]];
  const hex = color.trim().replace(/^#/, '');
  if (hex.length === 3) {
    const short = hex.split('');
    const r = Number.parseInt(`${short[0]}${short[0]}`, 16);
    const g = Number.parseInt(`${short[1]}${short[1]}`, 16);
    const b = Number.parseInt(`${short[2]}${short[2]}`, 16);
    return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) ? [r, g, b] : null;
  }
  if (hex.length !== 6) return null;
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  return [r, g, b];
}
