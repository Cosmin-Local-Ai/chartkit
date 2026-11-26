/**
 * Numeric checks for the indicator library: every indicator the picker offers is compared
 * against an independent implementation written from its definition, over 2 400 seeded
 * bars, and its NaN warm-up window has to line up with the reference bar for bar — a line
 * that plots 0 where the reference has no value yet fails the gap check, not the deviation
 * check, and fails alone.
 *
 * The references are deliberately naive: they re-derive each window from the bars instead
 * of carrying state between bars, and where a smoother is inherently recursive (Wilder's
 * ATR, ADX, RSI) they use a different arithmetic form from the library under test.
 *
 * Run it with:
 *   npx rolldown tests/indicator-library.test.ts -o /tmp/indlib-test.mjs -f esm && node /tmp/indlib-test.mjs
 */

// The test runs in node, whose globals the DOM-only tsconfig does not carry.
declare const process: { exitCode: number };

import type { Bar, FootprintSeries } from '../src/types';
import { normaliseInstances, normaliseParams } from '../src/indicators/engine';
import { printFlow, type PrintFlow } from '../src/indicators/flow';
import {
  INDICATORS,
  INDICATOR_GROUPS,
  defaultsFor,
  type IndicatorDefinition,
  type ParamValues,
} from '../src/indicators/registry';
import {
  cci,
  typicalPrice,
  vwap,
  type Values,
  type VwapAnchor,
  type VwapPrice,
} from '../src/indicators/tas';

const BAR_MS = 15 * 60_000;
/** 2 400 bars of 15 m from a UTC midnight: 25 days, so day, week and month all roll over. */
const FIRST_BAR = Date.UTC(2026, 9, 20, 0, 0, 0);
const BAR_COUNT = 2_400;

/* ------------------------------------------------------------------ seeded bars */

/** mulberry32: a seeded generator, so a failure reproduces exactly. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A wandering tape: drift that reverses, so trend tools flip rather than run away. */
function makeBars(): Bar[] {
  const rnd = seededRandom(0x5eed_1234);
  const out: Bar[] = [];
  let close = 58_000;
  for (let i = 0; i < BAR_COUNT; i += 1) {
    const open = close;
    const drift = Math.sin(i / 90) * 0.0009 + Math.sin(i / 613) * 0.0004;
    close = open * (1 + drift + (rnd() - 0.5) * 0.0032);
    const high = Math.max(open, close) * (1 + rnd() * 0.0016);
    const low = Math.min(open, close) * (1 - rnd() * 0.0016);
    const volume = 0.5 + rnd() * 40 + (Math.abs(close - open) / Math.max(open, 1)) * 9_000;
    out.push({ start: FIRST_BAR + i * BAR_MS, open, high, low, close, volume, trades: Math.round(20 + rnd() * 400), closed: true });
  }
  return out;
}

const BARS = makeBars();
const CLOSES = BARS.map((bar) => bar.close);

/* ------------------------------------------------------------------ references */

/** Window mean of a slice, NaN if the window is short or holds a hole. */
function refMean(window: readonly number[]): number {
  if (window.length === 0) return Number.NaN;
  let sum = 0;
  for (const value of window) if (!Number.isFinite(value)) return Number.NaN;
  sum = window.reduce((total, value) => total + value, 0);
  return sum / window.length;
}

function refSma(values: readonly number[], period: number): Values {
  return values.map((_, i) => (i < period - 1 ? Number.NaN : refMean(values.slice(i - period + 1, i + 1))));
}

/** Wilder's RSI, seeded with the plain mean of the first `period` changes. */
function refRsi(values: readonly number[], period: number): Values {
  const out: Values = values.map(() => Number.NaN);
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < values.length; i += 1) {
    const change = values[i]! - values[i - 1]!;
    gains.push(Math.max(change, 0));
    losses.push(Math.max(-change, 0));
  }
  let avgGain = refMean(gains.slice(0, period));
  let avgLoss = refMean(losses.slice(0, period));
  for (let i = period; i <= gains.length; i += 1) {
    if (i > period) {
      avgGain = (avgGain * (period - 1) + gains[i - 1]!) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i - 1]!) / period;
    }
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** Wilder's ATR: bar 0's true range is high − low, then RMA of the true range. */
function refAtr(bars: readonly Bar[], period: number): Values {
  const tr = bars.map((bar, i) =>
    i === 0 ? bar.high - bar.low : Math.max(Math.max(bar.high - bar.low, Math.abs(bar.high - bars[i - 1]!.close)), Math.abs(bar.low - bars[i - 1]!.close)),
  );
  const out: Values = tr.map(() => Number.NaN);
  let value = Number.NaN;
  for (let i = 0; i < tr.length; i += 1) {
    if (!Number.isFinite(value)) {
      if (i < period - 1) continue;
      value = refMean(tr.slice(0, period));
    } else {
      value = (value * (period - 1) + tr[i]!) / period;
    }
    out[i] = value;
  }
  return out;
}

/**
 * +DI, −DI and ADX from the shipped directional-movement definition. Wilder's sums here
 * are smoothed the way the shipped engine writes them (`s − s/period + x`, seeded with a
 * plain SUM), which is a different arithmetic path from the library's averaged form.
 */
function refDmi(bars: readonly Bar[], diLength: number, adxLength: number): { diPlus: Values; diMinus: Values; adx: Values } {
  const diPlus: Values = bars.map(() => Number.NaN);
  const diMinus: Values = bars.map(() => Number.NaN);
  const adx: Values = bars.map(() => Number.NaN);
  const dx: Values = bars.map(() => Number.NaN);
  let sumTr = 0;
  let sumUp = 0;
  let sumDown = 0;
  let run = 0;
  let seeded = false;
  let adxValue = Number.NaN;
  let dxSum = 0;
  let dxCount = 0;
  for (let i = 1; i < bars.length; i += 1) {
    const bar = bars[i]!;
    const before = bars[i - 1]!;
    const tr = Math.max(Math.max(bar.high - bar.low, Math.abs(bar.high - before.close)), Math.abs(bar.low - before.close));
    const up = bar.high - before.high;
    const down = before.low - bar.low;
    const plusDm = up > down && up > 0 ? up : 0;
    const minusDm = down > up && down > 0 ? down : 0;
    if (!seeded) {
      sumTr += tr;
      sumUp += plusDm;
      sumDown += minusDm;
      run += 1;
      if (run < diLength) continue;
      seeded = true;
    } else {
      sumTr = sumTr - sumTr / diLength + tr;
      sumUp = sumUp - sumUp / diLength + plusDm;
      sumDown = sumDown - sumDown / diLength + minusDm;
    }
    if (sumTr === 0) continue;
    const plus = (sumUp / sumTr) * 100;
    const minus = (sumDown / sumTr) * 100;
    diPlus[i] = plus;
    diMinus[i] = minus;
    const total = plus + minus;
    const d = total === 0 ? 0 : (Math.abs(plus - minus) / total) * 100;
    dx[i] = d;
    if (!Number.isFinite(adxValue)) {
      dxSum += d;
      dxCount += 1;
      if (dxCount < adxLength) continue;
      adxValue = dxSum / adxLength;
    } else {
      adxValue = (adxValue * (adxLength - 1) + d) / adxLength;
    }
    adx[i] = adxValue;
  }
  return { diPlus, diMinus, adx };
}

/** Donchian's CCI: the window's own mean absolute deviation. */
function refCciClassic(values: readonly number[], period: number, constant: number): Values {
  return values.map((_, i) => {
    if (i < period - 1) return Number.NaN;
    const window = values.slice(i - period + 1, i + 1);
    const average = refMean(window);
    if (!Number.isFinite(average)) return Number.NaN;
    let deviation = 0;
    for (const value of window) deviation += Math.abs(value - average);
    deviation /= period;
    if (deviation === 0) return 0;
    return (values[i]! - average) / (constant * deviation);
  });
}

/** Pine's `ta.cci`: the deviation term is itself a smoothed series, so it lands two bars later. */
function refCciSmoothedDeviation(values: readonly number[], period: number, constant: number): Values {
  const sma = refSma(values, period);
  const spread = values.map((_, i) => (Number.isFinite(sma[i]!) ? Math.abs(values[i]! - sma[i]!) : Number.NaN));
  const mad = refSma(spread, period);
  return values.map((_, i) =>
    !Number.isFinite(sma[i]!) || !Number.isFinite(mad[i]!) || mad[i] === 0 ? Number.NaN : (values[i]! - sma[i]!) / (constant * (mad[i] as number)),
  );
}

/** MFI: typical price times volume, split by which way the typical price moved. */
function refMfi(bars: readonly Bar[], period: number): Values {
  const tp = bars.map((bar) => (bar.high + bar.low + bar.close) / 3);
  return bars.map((_, i) => {
    if (i < period) return Number.NaN;
    let positive = 0;
    let negative = 0;
    for (let k = i - period + 1; k <= i; k += 1) {
      if (tp[k]! > tp[k - 1]!) positive += tp[k]! * bars[k]!.volume;
      else if (tp[k]! < tp[k - 1]!) negative += tp[k]! * bars[k]!.volume;
    }
    return negative === 0 ? 100 : 100 - 100 / (1 + positive / negative);
  });
}

/** On-balance volume: the running signed sum of volume, bar 0 counting as zero. */
function refObv(bars: readonly Bar[]): Values {
  let total = 0;
  return bars.map((bar, i) => {
    if (i > 0) {
      if (bar.close > bars[i - 1]!.close) total += bar.volume;
      else if (bar.close < bars[i - 1]!.close) total -= bar.volume;
    }
    return total;
  });
}

/** Williams %R: counted down from 0; a window that never moves reads 0, not −100. */
function refWilliamsR(bars: readonly Bar[], length: number): Values {
  return bars.map((_, i) => {
    if (i < length - 1) return Number.NaN;
    let top = Number.NEGATIVE_INFINITY;
    let bottom = Number.POSITIVE_INFINITY;
    for (let k = i - length + 1; k <= i; k += 1) {
      top = Math.max(top, bars[k]!.high);
      bottom = Math.min(bottom, bars[k]!.low);
    }
    if (top === bottom) return 0;
    return (-100 * (top - bars[i]!.close)) / (top - bottom);
  });
}

/** Where `source` sits between the window's high and low, in percent. */
function refStoch(source: readonly number[], highs: readonly number[], lows: readonly number[], period: number): Values {
  return source.map((_, i) => {
    if (i < period - 1) return Number.NaN;
    let top = Number.NEGATIVE_INFINITY;
    let bottom = Number.POSITIVE_INFINITY;
    for (let k = i - period + 1; k <= i; k += 1) {
      if (!Number.isFinite(highs[k]!) || !Number.isFinite(lows[k]!)) return Number.NaN;
      top = Math.max(top, highs[k]!);
      bottom = Math.min(bottom, lows[k]!);
    }
    if (!Number.isFinite(source[i]!)) return Number.NaN;
    if (top === bottom) return 0;
    return ((source[i]! - bottom) / (top - bottom)) * 100;
  });
}

/** Stochastic RSI: the stochastic of the RSI, smoothed twice. */
function refStochRsi(
  values: readonly number[],
  rsiLength: number,
  stochLength: number,
  kSmoothing: number,
  dSmoothing: number,
): { k: Values; d: Values } {
  const r = refRsi(values, rsiLength);
  const raw = refStoch(r, r, r, stochLength);
  return { k: refSma(raw, kSmoothing), d: refSma(refSma(raw, kSmoothing), dSmoothing) };
}

/**
 * Supertrend, from the shipped definition: Wilder ATR bands about the midpoint, the upper
 * band only ever stepping down and the lower only ever stepping up, with the trend flipping
 * when the close takes out the band the trend stands on.
 */
function refSupertrend(bars: readonly Bar[], atrPeriod: number, factor: number): { up: Values; down: Values } {
  const atr = refAtr(bars, atrPeriod);
  const up: Values = bars.map(() => Number.NaN);
  const down: Values = bars.map(() => Number.NaN);
  let upper = Number.NaN;
  let lower = Number.NaN;
  let previousClose = Number.NaN;
  let trend = 0;
  for (let i = 0; i < bars.length; i += 1) {
    const a = atr[i]!;
    if (!Number.isFinite(a)) continue;
    const bar = bars[i]!;
    const midpoint = (bar.high + bar.low) / 2;
    const basicUpper = midpoint + factor * a;
    const basicLower = midpoint - factor * a;
    if (trend === 0) {
      upper = basicUpper;
      lower = basicLower;
      trend = bar.close >= midpoint ? 1 : -1;
    } else {
      upper = basicUpper < upper || previousClose > upper ? basicUpper : upper;
      lower = basicLower > lower || previousClose < lower ? basicLower : lower;
      trend = trend === 1 ? (bar.close < lower ? -1 : 1) : bar.close > upper ? 1 : -1;
    }
    if (trend === 1) up[i] = lower;
    else down[i] = upper;
    previousClose = bar.close;
  }
  return { up, down };
}

/** Ichimoku: midpoints of window extremes, spans displaced forward, chikou displaced back. */
function refIchimoku(bars: readonly Bar[], conversion: number, base: number, lagging: number, displacement: number) {
  const mid = (period: number): Values =>
    bars.map((_, i) => {
      if (i < period - 1) return Number.NaN;
      let top = Number.NEGATIVE_INFINITY;
      let bottom = Number.POSITIVE_INFINITY;
      for (let k = i - period + 1; k <= i; k += 1) {
        top = Math.max(top, bars[k]!.high);
        bottom = Math.min(bottom, bars[k]!.low);
      }
      return (top + bottom) / 2;
    });
  const tenkan = mid(conversion);
  const kijun = mid(base);
  const spanA = tenkan.map((value, i) => (Number.isFinite(value) && Number.isFinite(kijun[i]!) ? (value + kijun[i]!) / 2 : Number.NaN));
  const spanB = mid(lagging);
  const shift = displacement;
  // A leading span is drawn ahead of the bar it was computed on, so the value standing at
  // bar i is the one computed `shift` bars earlier; the lagging span runs the other way and
  // has nothing to show for the last `shift` bars.
  const behind = (values: readonly number[]): Values => values.map((_, i) => (i - shift >= 0 ? values[i - shift]! : Number.NaN));
  return {
    tenkan,
    kijun,
    senkouA: behind(spanA),
    senkouB: behind(spanB),
    chikou: bars.map((_, i) => (i + shift < bars.length ? bars[i + shift]!.close : Number.NaN)),
  };
}

/** The UTC calendar bucket a bar belongs to, written from the calendar rather than arithmetic. */
function refBucket(start: number, kind: 'day' | 'week' | 'month'): number {
  const date = new Date(start);
  if (kind === 'month') return date.getUTCFullYear() * 12 + date.getUTCMonth();
  if (kind === 'day') return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const sinceMonday = (date.getUTCDay() + 6) % 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - sinceMonday);
}

function refBarPrice(bar: Bar, price: VwapPrice): number {
  if (price === 'hl2') return (bar.high + bar.low) / 2;
  if (price === 'ohlc4') return (bar.open + bar.high + bar.low + bar.close) / 4;
  if (price === 'hlcc4') return (bar.high + bar.low + bar.close + bar.close) / 4;
  if (price === 'close') return bar.close;
  return (bar.high + bar.low + bar.close) / 3;
}

/** Session VWAP: sums of price·volume, restarted at each calendar boundary. */
function refVwap(bars: readonly Bar[], anchor: 'day' | 'week' | 'month', price: VwapPrice): Values {
  const out: Values = bars.map(() => Number.NaN);
  let bucket = Number.NaN;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i]!;
    const key = refBucket(bar.start, anchor);
    if (key !== bucket) {
      bucket = key;
      numerator = 0;
      denominator = 0;
    }
    numerator += refBarPrice(bar, price) * bar.volume;
    denominator += bar.volume;
    if (denominator !== 0) out[i] = numerator / denominator;
  }
  return out;
}

/**
 * Pivot ladders, grouped by calendar bucket and drawn from the bucket before the bar's own.
 * The formulas are the shipped `PivotPoints` kit's, transcribed from its stated definitions
 * rather than from the library's code.
 */
function refPivots(
  bars: readonly Bar[],
  kind: 'Traditional' | 'Camarilla' | 'Woodie',
  timeframe: 'day' | 'week' | 'month',
  periodsBack: number,
) {
  const keys = bars.map((bar) => refBucket(bar.start, timeframe));
  const order: number[] = [];
  for (const key of keys) if (key !== order[order.length - 1]) order.push(key);
  const rangeOf = new Map<number, { high: number; low: number; close: number }>();
  for (const bar of bars) {
    const key = refBucket(bar.start, timeframe);
    const held = rangeOf.get(key);
    if (!held) rangeOf.set(key, { high: bar.high, low: bar.low, close: bar.close });
    else {
      held.high = Math.max(held.high, bar.high);
      held.low = Math.min(held.low, bar.low);
      held.close = bar.close;
    }
  }
  const blank = { pp: NaN, r1: NaN, r2: NaN, r3: NaN, s1: NaN, s2: NaN, s3: NaN };
  const levels = bars.map((bar, i) => {
    const position = order.indexOf(keys[i]!);
    if (position < 1) return { ...blank };
    const prior = rangeOf.get(order[position - 1]!)!;
    void bar;
    const range = prior.high - prior.low;
    const pp = kind === 'Woodie' ? (prior.high + prior.low + 2 * prior.close) / 4 : (prior.high + prior.low + prior.close) / 3;
    if (kind === 'Camarilla') {
      return {
        pp,
        r1: prior.close + (range * 1.1) / 12,
        r2: prior.close + (range * 1.1) / 6,
        r3: prior.close + (range * 1.1) / 4,
        s1: prior.close - (range * 1.1) / 12,
        s2: prior.close - (range * 1.1) / 6,
        s3: prior.close - (range * 1.1) / 4,
      };
    }
    return {
      pp,
      r1: 2 * pp - prior.low,
      r2: pp + range,
      r3: prior.high + 2 * (pp - prior.low),
      s1: 2 * pp - prior.high,
      s2: pp - range,
      s3: prior.low - 2 * (prior.high - pp),
    };
  });
  const cut = periodsBack > 0 && order.length > periodsBack ? order[order.length - periodsBack]! : Number.NEGATIVE_INFINITY;
  return levels.map((level, i) => (keys[i]! < cut ? { ...blank } : level));
}

/* ------------------------------------------------------------------ comparison */

interface SeriesPair {
  indicator: string;
  plot: string;
  ours: Values;
  reference: Values;
  tolerance: number;
}

interface SeriesVerdict {
  indicator: string;
  plot: string;
  tolerance: number;
  finite: number;
  maxDeviation: number;
  /** Bars where one side has a value and the other does not. */
  gapMismatches: number;
  firstGap: number;
}

function compareSeries(pair: SeriesPair): SeriesVerdict {
  let maxDeviation = 0;
  let gapMismatches = 0;
  let firstGap = -1;
  let finite = 0;
  for (let i = 0; i < pair.ours.length; i += 1) {
    const ours = pair.ours[i] ?? Number.NaN;
    const theirs = pair.reference[i] ?? Number.NaN;
    const haveOurs = Number.isFinite(ours);
    const haveTheirs = Number.isFinite(theirs);
    if (haveOurs !== haveTheirs) {
      gapMismatches += 1;
      if (firstGap < 0) firstGap = i;
      continue;
    }
    if (!haveOurs) continue;
    finite += 1;
    maxDeviation = Math.max(maxDeviation, Math.abs(ours - theirs));
  }
  return {
    indicator: pair.indicator,
    plot: pair.plot,
    tolerance: pair.tolerance,
    finite,
    maxDeviation,
    gapMismatches,
    firstGap,
  };
}

function scientific(value: number): string {
  if (value === 0) return '0.00e+0';
  return value.toExponential(2);
}

/* ------------------------------------------------------------------ runs */

const failures: string[] = [];
const pairs: SeriesPair[] = [];

function definitionOf(id: string): IndicatorDefinition {
  const definition = INDICATORS.find((entry) => entry.id === id);
  if (!definition) throw new Error(`no indicator ${id} in the registry`);
  return definition;
}

/** The plots an indicator draws at its default settings, in plot order. */
function plotsOf(id: string, params: ParamValues = {}, flow: PrintFlow | null = null): Values[] {
  const definition = definitionOf(id);
  const merged = { ...defaultsFor(definition), ...params };
  const result = definition.compute(BARS, normaliseParams(definition, merged), flow);
  return result.plots.map((plot) => plot.values);
}

const TIGHT = 1e-9;

// ADX/DMI: one period drives both stages, as the shipped single-length ADX script does.
{
  const period = 14;
  const [adx, diPlus, diMinus] = plotsOf('ADX');
  const reference = refDmi(BARS, period, period);
  pairs.push(
    { indicator: 'ADX', plot: 'ADX', ours: adx!, reference: reference.adx, tolerance: TIGHT },
    { indicator: 'ADX', plot: '+DI', ours: diPlus!, reference: reference.diPlus, tolerance: TIGHT },
    { indicator: 'ADX', plot: '-DI', ours: diMinus!, reference: reference.diMinus, tolerance: TIGHT },
  );
}

// CCI, in Donchian's form, at the shipped defaults (period 20, constant 0.015, close).
{
  const [line] = plotsOf('CCI');
  pairs.push({ indicator: 'CCI', plot: 'CCI', ours: line!, reference: refCciClassic(CLOSES, 20, 0.015), tolerance: TIGHT });
  // Typical price is the other source the shipped table's select can name.
  const [tp] = plotsOf('CCI', { source: 'hlc3' });
  pairs.push({ indicator: 'CCI', plot: 'CCI (hlc3)', ours: tp!, reference: refCciClassic(typicalPrice(BARS), 20, 0.015), tolerance: TIGHT });
  // The Pine form task #35 left in `tas.cci` still answers its own definition.
  pairs.push({ indicator: 'CCI', plot: 'CCI (Pine ta.cci)', ours: cci(CLOSES, 20), reference: refCciSmoothedDeviation(CLOSES, 20, 0.015), tolerance: TIGHT });
}

{
  const [line] = plotsOf('MFI');
  pairs.push({ indicator: 'MFI', plot: 'MFI', ours: line!, reference: refMfi(BARS, 14), tolerance: TIGHT });
}

{
  const [line] = plotsOf('OBV');
  pairs.push({ indicator: 'OBV', plot: 'OBV', ours: line!, reference: refObv(BARS), tolerance: 1e-6 });
}

{
  const [line] = plotsOf('WILLIAMS_R');
  pairs.push({ indicator: 'WILLIAMS_R', plot: '%R', ours: line!, reference: refWilliamsR(BARS, 14), tolerance: TIGHT });
}

{
  const [k, d] = plotsOf('STOCH_RSI');
  const reference = refStochRsi(CLOSES, 14, 14, 3, 3);
  pairs.push(
    { indicator: 'STOCH_RSI', plot: 'K', ours: k!, reference: reference.k, tolerance: TIGHT },
    { indicator: 'STOCH_RSI', plot: 'D', ours: d!, reference: reference.d, tolerance: TIGHT },
  );
}

{
  const [up, down] = plotsOf('SUPERTREND');
  const reference = refSupertrend(BARS, 10, 3);
  pairs.push(
    { indicator: 'SUPERTREND', plot: 'Up Trend', ours: up!, reference: reference.up, tolerance: TIGHT },
    { indicator: 'SUPERTREND', plot: 'Down Trend', ours: down!, reference: reference.down, tolerance: TIGHT },
  );
}

{
  const [tenkan, kijun, senkouA, senkouB, chikou] = plotsOf('ICHI_CLOUD');
  const reference = refIchimoku(BARS, 9, 26, 52, 26);
  pairs.push(
    { indicator: 'ICHI_CLOUD', plot: 'Tenkan', ours: tenkan!, reference: reference.tenkan, tolerance: TIGHT },
    { indicator: 'ICHI_CLOUD', plot: 'Kijun', ours: kijun!, reference: reference.kijun, tolerance: TIGHT },
    { indicator: 'ICHI_CLOUD', plot: 'Span A', ours: senkouA!, reference: reference.senkouA, tolerance: TIGHT },
    { indicator: 'ICHI_CLOUD', plot: 'Span B', ours: senkouB!, reference: reference.senkouB, tolerance: TIGHT },
    { indicator: 'ICHI_CLOUD', plot: 'Chikou', ours: chikou!, reference: reference.chikou, tolerance: TIGHT },
  );
}

// The three session VWAPs, each against its own calendar.
for (const [id, anchor] of [
  ['VWAP_DAILY', 'day'],
  ['VWAP_WEEKLY', 'week'],
  ['VWAP_MONTHLY', 'month'],
] as const) {
  const [line] = plotsOf(id);
  pairs.push({ indicator: id, plot: 'VWAP', ours: line!, reference: refVwap(BARS, anchor, 'hlc3'), tolerance: TIGHT });
}

// Pivots, all three shipped formulas, at the shipped 15-period window.
for (const kind of ['Traditional', 'Camarilla', 'Woodie'] as const) {
  const plots = plotsOf('PIVOT_POINTS', { pivotType: kind });
  const labels = ['PP', 'R1', 'R2', 'R3', 'S1', 'S2', 'S3'];
  const reference = refPivots(BARS, kind, 'day', 15);
  const fields = ['pp', 'r1', 'r2', 'r3', 's1', 's2', 's3'] as const;
  fields.forEach((field, index) => {
    pairs.push({
      indicator: `PIVOT_POINTS ${kind}`,
      plot: labels[index]!,
      ours: plots[index]!,
      reference: reference.map((level) => level[field]),
      tolerance: TIGHT,
    });
  });
}

const verdicts = pairs.map(compareSeries);
console.log(`\nindicator / plot            bars  values  tolerance   max deviation   NaN-gap`);
for (const verdict of verdicts) {
  const gap = verdict.gapMismatches === 0 ? 'aligned' : `${verdict.gapMismatches} mismatch, first at bar ${verdict.firstGap}`;
  console.log(
    `${`${verdict.indicator} ${verdict.plot}`.padEnd(28)} ${String(BARS.length).padStart(4)}  ${String(verdict.finite).padStart(6)}  ${verdict.tolerance.toExponential(0).padStart(9)}   ${scientific(verdict.maxDeviation).padStart(13)}   ${gap}`,
  );
  if (verdict.maxDeviation > verdict.tolerance) {
    failures.push(`${verdict.indicator} ${verdict.plot}: max deviation ${scientific(verdict.maxDeviation)} exceeds tolerance ${scientific(verdict.tolerance)}`);
  }
  if (verdict.gapMismatches > 0) failures.push(`${verdict.indicator} ${verdict.plot}: ${verdict.gapMismatches} warm-up bars disagree with the reference`);
}

/* ------------------------------------------------------------------ anchoring */

/** The bar each UTC period first appears on, so rollover can be checked by name. */
function firstBarsOf(timeframe: 'day' | 'week' | 'month'): number[] {
  const out: number[] = [];
  let bucket = Number.NaN;
  BARS.forEach((bar, i) => {
    const key = refBucket(bar.start, timeframe);
    if (key !== bucket) {
      bucket = key;
      out.push(i);
    }
  });
  return out;
}

{
  const periodsBack = 15;
  for (const timeframe of ['day', 'week', 'month'] as const) {
    const levels = plotsOf('PIVOT_POINTS', { pivotTimeframe: timeframe })[1]!;
    const boundaries = firstBarsOf(timeframe);
    const offBoundary = levels.filter((value, i) => i > 0 && Number.isFinite(value) && Number.isFinite(levels[i - 1]!) && value !== levels[i - 1]! && !boundaries.includes(i)).length;
    const firstLadder = levels.findIndex((value) => Number.isFinite(value));
    const onBoundary = firstLadder >= 0 && boundaries.includes(firstLadder) && !Number.isFinite(levels[firstLadder - 1] ?? Number.NaN);
    // Each period contributes one ladder, drawn from the period before it, so the number of
    // different levels on screen is the number of periods `pivotsBack` keeps.
    const ladders = new Set(levels.filter((value) => Number.isFinite(value))).size;
    const expectedLadders = Math.min(periodsBack, Math.max(0, boundaries.length - 1));
    console.log(
      `pivots (${timeframe}): ${boundaries.length} ${timeframe} starts in view, ${ladders} ladders drawn (expected ${expectedLadders}), levels change only on a boundary: ${offBoundary === 0 ? 'yes' : `NO (${offBoundary} bars)`}, first ladder begins on its period's first bar: ${onBoundary ? 'yes' : 'NO'}`,
    );
    if (offBoundary !== 0) failures.push(`pivots (${timeframe}): ${offBoundary} bars change level away from a ${timeframe} boundary`);
    if (!onBoundary) failures.push(`pivots (${timeframe}): the first ladder does not begin on a ${timeframe} boundary`);
    if (ladders !== expectedLadders) failures.push(`pivots (${timeframe}): ${ladders} ladders drawn, expected ${expectedLadders}`);
  }
}

// Each session VWAP restarts where its name says, and the daily one is the built-in day VWAP.
for (const anchor of ['day', 'week', 'month'] as VwapAnchor[]) {
  if (anchor === 'none' || anchor === 'quarter' || anchor === 'year') continue;
  const id = anchor === 'day' ? 'VWAP_DAILY' : anchor === 'week' ? 'VWAP_WEEKLY' : 'VWAP_MONTHLY';
  const line = plotsOf(id)[0]!;
  const boundaries = firstBarsOf(anchor);
  let restarts = 0;
  let wrong = 0;
  for (let i = 1; i < line.length; i += 1) {
    if (!boundaries.includes(i)) continue;
    restarts += 1;
    const previous = line[i - 1]!;
    const at = line[i]!;
    const bar = BARS[i]!;
    if (Math.abs(at - refBarPrice(bar, 'hlc3')) > 1e-9 * Math.max(1, Math.abs(at))) wrong += 1;
    if (Math.abs(previous - at) < 1e-12) wrong += 1;
  }
  console.log(`${id}: ${restarts} ${anchor} boundaries in view, every one restarts from its own bar: ${wrong === 0 ? 'yes' : `NO (${wrong})`}`);
  if (wrong !== 0) failures.push(`${id}: ${wrong} of ${restarts} ${anchor} boundaries do not restart the sums`);
}

{
  const builtIn = vwap(BARS, 'day', 'hlc3');
  const daily = plotsOf('VWAP_DAILY')[0]!;
  let mismatch = 0;
  for (let i = 0; i < BARS.length; i += 1) if ((builtIn[i] ?? NaN) !== (daily[i] ?? NaN)) mismatch += 1;
  console.log(`VWAP_DAILY equals the built-in VWAP at (day, hlc3) bar for bar: ${mismatch === 0 ? 'yes' : `NO (${mismatch} bars)`}`);
  if (mismatch !== 0) failures.push(`VWAP_DAILY disagrees with the built-in day VWAP on ${mismatch} bars`);
}

/* ------------------------------------------------------------------ registry shape */

{
  const ids = INDICATORS.map((definition) => definition.id);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length > 0) failures.push(`duplicate indicator ids: ${duplicates.join(', ')}`);
  const groups = new Map<string, number>();
  for (const definition of INDICATORS) {
    if (!INDICATOR_GROUPS.includes(definition.group)) failures.push(`${definition.id}: group "${definition.group}" is not a picker section`);
    groups.set(`${definition.placement} · ${definition.group}`, (groups.get(`${definition.placement} · ${definition.group}`) ?? 0) + 1);
    const names = definition.params.map((param) => param.name);
    if (new Set(names).size !== names.length) failures.push(`${definition.id}: duplicate parameter names`);
    if (names.length === 0) failures.push(`${definition.id}: no parameters`);
    for (const param of definition.params) {
      const value = defaultsFor(definition)[param.name];
      if (param.kind === 'number' && typeof value === 'number') {
        if (param.min !== undefined && value < param.min) failures.push(`${definition.id}.${param.name}: default ${value} is below min ${param.min}`);
        if (param.max !== undefined && value > param.max) failures.push(`${definition.id}.${param.name}: default ${value} is above max ${param.max}`);
      }
      if (param.kind === 'select' && typeof value === 'string' && !param.options?.includes(value)) {
        failures.push(`${definition.id}.${param.name}: default "${value}" is not one of the choices`);
      }
    }
  }
  console.log(`\nregistry: ${INDICATORS.length} types (${INDICATORS.filter((d) => d.placement === 'onchart').length} over the price, ${INDICATORS.filter((d) => d.placement === 'offchart').length} in their own pane), ${(groups.size)} picker sections`);
  for (const [group, count] of groups) console.log(`  ${group.padEnd(34)} ${count}`);
  if (INDICATORS.length < 25 || INDICATORS.length > 35) failures.push(`the catalog holds ${INDICATORS.length} types, outside the 25-35 range the picker was laid out for`);
}

// Every indicator draws at its defaults: one value per bar, a caption, and the plots its
// placement promises. The delta family is excluded: it needs the prints.
{
  const flow = printFlow(footprint(), false);
  let checked = 0;
  for (const definition of INDICATORS) {
    const result = definition.compute(BARS, defaultsFor(definition), definition.needsPrints ? flow : null);
    if (result.plots.length === 0 && definition.id !== 'SCRIPT') failures.push(`${definition.id}: computes no plots`);
    if (!result.caption) failures.push(`${definition.id}: no caption`);
    for (const plot of result.plots) {
      if (plot.values.length !== BARS.length) failures.push(`${definition.id}.${plot.label}: ${plot.values.length} values for ${BARS.length} bars`);
    }
    if (!definition.needsPrints) checked += 1;
  }
  console.log(`registry: ${checked} indicators compute at their defaults over ${BARS.length} bars, plus ${INDICATORS.filter((d) => d.needsPrints).length} that read the prints`);
}

/* ------------------------------------------------------------------ persistence */

{
  const stored = INDICATORS.filter((definition) => !definition.needsPrints).map((definition, index) => ({
    id: `i${index}`,
    indicatorId: definition.id,
    params: defaultsFor(definition),
  }));
  const restored = normaliseInstances(JSON.parse(JSON.stringify(stored)));
  if (restored.length !== stored.length) failures.push(`restoring the workspace kept ${restored.length} of ${stored.length} instances`);
  let drift = 0;
  restored.forEach((instance, index) => {
    if (instance.indicatorId !== stored[index]!.indicatorId) drift += 1;
    if (JSON.stringify(instance.params) !== JSON.stringify(stored[index]!.params)) drift += 1;
  });
  console.log(`persistence: ${restored.length} instances survive a JSON round trip with their parameters${drift === 0 ? ' intact' : ` — ${drift} changed`}`);
  if (drift !== 0) failures.push(`${drift} restored instances changed identity or parameters`);

  // A stored instance whose parameters are half missing comes back complete, and one that
  // names a value the select cannot hold falls back rather than drawing an unknown line.
  const partial = normaliseInstances([{ id: 'p1', indicatorId: 'ICHI_CLOUD', params: { basePeriod: 40 } }]);
  const ichi = partial[0];
  if (!ichi || ichi.params['basePeriod'] !== 40 || ichi.params['conversionPeriod'] !== 9) {
    failures.push('a stored instance with half its parameters did not come back repaired');
  }
  const nonsense = normaliseInstances([{ id: 'p2', indicatorId: 'PIVOT_POINTS', params: { pivotType: 'DeMark' } }]);
  if (nonsense[0]?.params['pivotType'] !== 'Traditional') failures.push('a stored pivot type the select does not offer was not repaired');
}

/* ------------------------------------------------------------------ delta family */

{
  const flow = printFlow(footprint(), false);
  const deltas = BARS.map((_, i) => (i === 0 ? 0 : (BARS[i]!.close >= BARS[i - 1]!.close ? 1 : -1) * BARS[i]!.volume * 0.2));
  const continuous = plotsOf('CUMULATIVE_VOLUME_DELTA', { cvd_anchor: 'Continuous' }, flow)[0]!;
  const expected = deltas.reduce((total, value) => total + value, 0);
  const last = continuous[continuous.length - 1] ?? Number.NaN;
  const dev = Math.abs(last - expected);
  console.log(`CVD (continuous): last value ${last.toFixed(4)} against ${expected.toFixed(4)} summed from the prints, deviation ${scientific(dev)}`);
  if (!(dev <= 1e-6)) failures.push(`CVD disagrees with the summed prints by ${scientific(dev)}`);

  const noFlow = definitionOf('VOLUME_DELTA').compute(BARS, defaultsFor(definitionOf('VOLUME_DELTA')), null);
  const allUnknown = noFlow.plots.every((plot) => plot.values.every((value) => !Number.isFinite(value)));
  console.log(`delta family without prints: every value unknown (${allUnknown ? 'yes' : 'NO'}), note shown (${noFlow.note ? 'yes' : 'NO'})`);
  if (!allUnknown || !noFlow.note) failures.push('the delta family claims values where it has no prints');
}

/* ------------------------------------------------------------------ report */

console.log(`\n${verdicts.length} series compared against their references over ${BARS.length} bars`);
if (failures.length > 0) {
  console.log(`FAILED (${failures.length}):`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('all checks passed');
}

/** Prints behind the seeded bars: buy minus sell follows the bar's own direction. */
function footprint(): FootprintSeries {
  return {
    instrument: 'TEST',
    timeframe: '15m',
    priceTick: 0.5,
    cvd: [],
    bars: BARS.map((bar, i) => ({
      start: bar.start,
      cells: [],
      totalQty: bar.volume,
      delta: i === 0 ? 0 : (BARS[i]!.close >= BARS[i - 1]!.close ? 1 : -1) * bar.volume * 0.2,
      trades: bar.trades,
      poc: bar.close,
      buyImbalance: [],
      sellImbalance: [],
    })),
  };
}
