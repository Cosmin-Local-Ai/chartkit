/**
 * Indicator math: pure functions from bars to one value per bar.
 *
 * Conventions follow the shipped kScript built-ins: a series is NaN until its
 * window is full, stays NaN while any bar inside the window is not finite, and
 * every window is summed oldest to newest so the arithmetic matches bar by bar
 * instead of drifting through a running total.
 */

import type { Bar } from '../types';

export type Values = number[];

export type SourceField = 'close' | 'open' | 'high' | 'low';

export const SOURCE_FIELDS: readonly SourceField[] = ['close', 'open', 'high', 'low'];

export type AtrSmoothing = 'RMA' | 'SMA' | 'EMA' | 'WMA';

export type VwapAnchor = 'none' | 'day' | 'week' | 'month' | 'quarter' | 'year';

export type VwapPrice = 'hlc3' | 'hl2' | 'ohlc4' | 'hlcc4' | 'close';

/** The three pivot formulas the shipped `PivotPoints` kit computes. */
export type PivotKind = 'Traditional' | 'Camarilla' | 'Woodie';

/** Calendar a pivot ladder restarts on. The week restarts at Monday 00:00 UTC. */
export type PivotTimeframe = 'day' | 'week' | 'month';

const DAY_MS = 86_400_000;

export function sourceValues(bars: readonly Bar[], source: SourceField): Values {
  return bars.map((bar) => bar[source]);
}

/** Shift a series back by `offset` bars, leaving the first `offset` entries empty. */
export function delay(values: readonly number[], offset: number): Values {
  const shift = Math.max(0, Math.floor(offset));
  const out: Values = new Array<number>(values.length).fill(Number.NaN);
  for (let i = shift; i < values.length; i += 1) out[i] = values[i - shift] ?? Number.NaN;
  return out;
}

/** Plain mean of the last `period` values; NaN while the window is incomplete or dirty. */
export function sma(values: readonly number[], period: number): Values {
  const p = clampedPeriod(period);
  return windowMap(values, p, (window) => mean(window));
}

/** Exponential average seeded with the mean of the first `period` values. */
export function ema(values: readonly number[], period: number): Values {
  const p = clampedPeriod(period);
  const alpha = 2 / (p + 1);
  const out: Values = new Array<number>(values.length).fill(Number.NaN);
  let seed = 0;
  let seen = 0;
  let value = Number.NaN;
  for (let i = 0; i < values.length; i += 1) {
    const x = values[i] ?? Number.NaN;
    if (!Number.isFinite(x)) continue;
    if (!Number.isFinite(value)) {
      seed += x;
      seen += 1;
      if (seen === p) {
        value = seed / p;
        out[i] = value;
      }
      continue;
    }
    value = x * alpha + value * (1 - alpha);
    out[i] = value;
  }
  return out;
}

/** Wilder's smoothing: seeded with a mean, then `(prev * (period - 1) + x) / period`. */
export function rma(values: readonly number[], period: number): Values {
  const p = clampedPeriod(period);
  const out: Values = new Array<number>(values.length).fill(Number.NaN);
  let seed = 0;
  let seen = 0;
  let value = Number.NaN;
  for (let i = 0; i < values.length; i += 1) {
    const x = values[i] ?? Number.NaN;
    if (!Number.isFinite(x)) continue;
    if (!Number.isFinite(value)) {
      seed += x;
      seen += 1;
      if (seen === p) {
        value = seed / p;
        out[i] = value;
      }
      continue;
    }
    value = (value * (p - 1) + x) / p;
    out[i] = value;
  }
  return out;
}

/** Linearly weighted average: newest bar weighs `period`, oldest weighs 1. */
export function wma(values: readonly number[], period: number): Values {
  const p = clampedPeriod(period);
  const denominator = (p * (p + 1)) / 2;
  return windowMap(values, p, (window) => {
    let weighted = 0;
    for (let k = 0; k < p; k += 1) weighted += (window[k] ?? Number.NaN) * (k + 1);
    return weighted / denominator;
  });
}

/**
 * Hull moving average: WMA(2·WMA(half) − WMA(period), round(sqrt(period))), with the
 * half window truncated the way the shipped HMA script writes it.
 */
export function hma(values: readonly number[], period: number): Values {
  const p = clampedPeriod(period);
  const half = Math.max(1, Math.floor(p / 2));
  const hull = Math.max(1, Math.round(Math.sqrt(p)));
  const halfAverage = wma(values, half);
  const fullAverage = wma(values, p);
  const input: Values = values.map((_, i) => {
    const a = halfAverage[i] ?? Number.NaN;
    const b = fullAverage[i] ?? Number.NaN;
    return Number.isFinite(a) && Number.isFinite(b) ? 2 * a - b : Number.NaN;
  });
  return wma(input, hull);
}

/** Volume weighted average: sum(price · volume) / sum(volume) over the window. */
export function vwma(values: readonly number[], volumes: readonly number[], period: number): Values {
  const p = clampedPeriod(period);
  const out: Values = new Array<number>(values.length).fill(Number.NaN);
  for (let i = p - 1; i < values.length; i += 1) {
    let numerator = 0;
    let denominator = 0;
    let broken = false;
    for (let k = i - p + 1; k <= i; k += 1) {
      const value = values[k] ?? Number.NaN;
      const volume = volumes[k] ?? Number.NaN;
      if (!Number.isFinite(value) || !Number.isFinite(volume)) {
        broken = true;
        break;
      }
      numerator += value * volume;
      denominator += volume;
    }
    if (!broken && denominator !== 0) out[i] = numerator / denominator;
  }
  return out;
}

export interface Bands {
  basis: Values;
  upper: Values;
  lower: Values;
}

/** Bollinger bands: the window mean plus and minus `mult` population standard deviations. */
export function bollinger(values: readonly number[], period: number, mult: number): Bands {
  const p = clampedPeriod(period);
  const basis: Values = new Array<number>(values.length).fill(Number.NaN);
  const upper: Values = new Array<number>(values.length).fill(Number.NaN);
  const lower: Values = new Array<number>(values.length).fill(Number.NaN);
  for (let i = p - 1; i < values.length; i += 1) {
    const window = slice(values, i - p + 1, i);
    if (!window) continue;
    const average = mean(window);
    let squared = 0;
    for (const value of window) {
      const diff = value - average;
      squared += diff * diff;
    }
    const dev = mult * Math.sqrt(squared / p);
    basis[i] = average;
    upper[i] = average + dev;
    lower[i] = average - dev;
  }
  return { basis, upper, lower };
}

/** Wilder RSI: gains and losses of the first `period` changes are averaged, then smoothed. */
export function rsi(values: readonly number[], period: number): Values {
  const p = clampedPeriod(period);
  const out: Values = new Array<number>(values.length).fill(Number.NaN);
  let seedGain = 0;
  let seedLoss = 0;
  let seen = 0;
  let avgGain = Number.NaN;
  let avgLoss = Number.NaN;
  for (let i = 1; i < values.length; i += 1) {
    const previous = values[i - 1] ?? Number.NaN;
    const current = values[i] ?? Number.NaN;
    if (!Number.isFinite(previous) || !Number.isFinite(current)) continue;
    const change = current - previous;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (!Number.isFinite(avgGain) || !Number.isFinite(avgLoss)) {
      seedGain += gain;
      seedLoss += loss;
      seen += 1;
      if (seen !== p) continue;
      avgGain = seedGain / p;
      avgLoss = seedLoss / p;
    } else {
      avgGain = (avgGain * (p - 1) + gain) / p;
      avgLoss = (avgLoss * (p - 1) + loss) / p;
    }
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * RSI without Wilder's recursion: gains and losses are averaged over a rolling
 * window instead. Kept for the RSI `smooth` switch, which trades the two.
 */
export function rsiSimple(values: readonly number[], period: number): Values {
  const p = clampedPeriod(period);
  const gains: Values = values.map((_, i) => {
    if (i === 0) return Number.NaN;
    const change = (values[i] ?? NaN) - (values[i - 1] ?? NaN);
    return Number.isFinite(change) ? Math.max(change, 0) : Number.NaN;
  });
  const losses: Values = values.map((_, i) => {
    if (i === 0) return Number.NaN;
    const change = (values[i] ?? NaN) - (values[i - 1] ?? NaN);
    return Number.isFinite(change) ? Math.max(-change, 0) : Number.NaN;
  });
  const out: Values = new Array<number>(values.length).fill(Number.NaN);
  for (let i = p; i < values.length; i += 1) {
    const gain = mean(slice(gains, i - p + 1, i) ?? []);
    const loss = mean(slice(losses, i - p + 1, i) ?? []);
    if (!Number.isFinite(gain) || !Number.isFinite(loss)) continue;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export interface MacdLines {
  line: Values;
  signal: Values;
  hist: Values;
}

/** MACD: the difference of two EMAs, its own signal EMA, and the histogram between them. */
export function macd(values: readonly number[], fastPeriod: number, slowPeriod: number, signalPeriod: number): MacdLines {
  const fast = ema(values, clampedPeriod(fastPeriod));
  const slow = ema(values, clampedPeriod(slowPeriod));
  const line: Values = values.map((_, i) => {
    const a = fast[i] ?? Number.NaN;
    const b = slow[i] ?? Number.NaN;
    return Number.isFinite(a) && Number.isFinite(b) ? a - b : Number.NaN;
  });
  const signal = ema(line, clampedPeriod(signalPeriod));
  const hist: Values = values.map((_, i) => {
    const a = line[i] ?? Number.NaN;
    const b = signal[i] ?? Number.NaN;
    return Number.isFinite(a) && Number.isFinite(b) ? a - b : Number.NaN;
  });
  return { line, signal, hist };
}

export interface StochLines {
  k: Values;
  d: Values;
}

/**
 * Raw %K of the stochastic oscillator: where `source` sits between the window's high and
 * low, in percent. A flat window reads 0, matching the shipped `stoch`; Pine's
 * `ta.stoch(source, high, low, length)` is this line on its own, before any smoothing.
 */
export function stochasticLine(
  source: readonly number[],
  highs: readonly number[],
  lows: readonly number[],
  period: number,
): Values {
  const p = clampedPeriod(period);
  return source.map((value, i) => {
    if (i < p - 1) return Number.NaN;
    let top = Number.NEGATIVE_INFINITY;
    let bottom = Number.POSITIVE_INFINITY;
    for (let k = i - p + 1; k <= i; k += 1) {
      const high = highs[k] ?? Number.NaN;
      const low = lows[k] ?? Number.NaN;
      if (!Number.isFinite(high) || !Number.isFinite(low)) return Number.NaN;
      if (high > top) top = high;
      if (low < bottom) bottom = low;
    }
    if (!Number.isFinite(value)) return Number.NaN;
    if (top === bottom) return 0;
    return ((value - bottom) / (top - bottom)) * 100;
  });
}

/**
 * Stochastic oscillator: raw %K over the window extremes, %K smoothed by an SMA of
 * `kSmoothing`, %D the SMA of %K. A flat window reads 0, matching the shipped `stoch`.
 */
export function stochastic(
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
  kPeriod: number,
  kSmoothing: number,
  dPeriod: number,
): StochLines {
  const raw = stochasticLine(closes, highs, lows, kPeriod);
  const k = sma(raw, clampedPeriod(kSmoothing));
  const d = sma(k, clampedPeriod(dPeriod));
  return { k, d };
}

/** True range: bar 0 is plain high − low, later bars also weigh the previous close. */
export function trueRange(bars: readonly Bar[]): Values {
  const out: Values = new Array<number>(bars.length);
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (!bar) {
      out[i] = Number.NaN;
      continue;
    }
    if (i === 0) {
      out[i] = bar.high - bar.low;
      continue;
    }
    const previous = bars[i - 1];
    if (!previous) {
      out[i] = Number.NaN;
      continue;
    }
    out[i] = Math.max(Math.max(bar.high - bar.low, Math.abs(bar.high - previous.close)), Math.abs(bar.low - previous.close));
  }
  return out;
}

export function atr(bars: readonly Bar[], period: number, smoothing: AtrSmoothing): Values {
  const ranges = trueRange(bars);
  if (smoothing === 'SMA') return sma(ranges, period);
  if (smoothing === 'EMA') return ema(ranges, period);
  if (smoothing === 'WMA') return wma(ranges, period);
  return rma(ranges, period);
}

/** VWAP: sums of price·volume per bucket, restarted at every anchor boundary. */
export function vwap(bars: readonly Bar[], anchor: VwapAnchor, price: VwapPrice): Values {
  const out: Values = new Array<number>(bars.length).fill(Number.NaN);
  let bucket = Number.NaN;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (!bar) continue;
    const id = bucketId(bar.start, anchor);
    if (id !== bucket) {
      bucket = id;
      numerator = 0;
      denominator = 0;
    }
    if (!Number.isFinite(bar.high) || !Number.isFinite(bar.low) || !Number.isFinite(bar.close) || !Number.isFinite(bar.volume)) {
      continue;
    }
    numerator += barPrice(bar, price) * bar.volume;
    denominator += bar.volume;
    if (denominator !== 0) out[i] = numerator / denominator;
  }
  return out;
}

function barPrice(bar: Bar, price: VwapPrice): number {
  switch (price) {
    case 'hl2':
      return (bar.high + bar.low) / 2;
    case 'ohlc4':
      return (bar.open + bar.high + bar.low + bar.close) / 4;
    case 'hlcc4':
      return (bar.high + bar.low + bar.close + bar.close) / 4;
    case 'close':
      return bar.close;
    case 'hlc3':
      return (bar.high + bar.low + bar.close) / 3;
  }
}

/** Bucket id in UTC: anchors restart the VWAP sums when it changes. */
function bucketId(start: number, anchor: VwapAnchor): number {
  if (anchor === 'none') return 0;
  const date = new Date(start);
  switch (anchor) {
    case 'day':
      return Math.floor(start / DAY_MS);
    case 'week':
      return Math.floor(start / DAY_MS + 3) - (Math.floor(start / DAY_MS + 3) % 7);
    case 'month':
      return date.getUTCFullYear() * 12 + date.getUTCMonth();
    case 'quarter':
      return date.getUTCFullYear() * 4 + Math.floor(date.getUTCMonth() / 3);
    case 'year':
      return date.getUTCFullYear();
  }
}

/** Window maximum, NaN while the window is incomplete or holds a value that is not finite. */
export function highest(values: readonly number[], period: number): Values {
  return extremeWindow(values, period, 1);
}

/** Window minimum, NaN while the window is incomplete or holds a value that is not finite. */
export function lowest(values: readonly number[], period: number): Values {
  return extremeWindow(values, period, -1);
}

function extremeWindow(values: readonly number[], period: number, sign: 1 | -1): Values {
  const p = clampedPeriod(period);
  return windowMap(values, p, (window) => {
    let best = Number.NaN;
    for (const value of window) {
      if (!Number.isFinite(value)) return Number.NaN;
      if (!Number.isFinite(best) || value * sign > best * sign) best = value;
    }
    return best;
  });
}

/** Population standard deviation of the window: the same deviation `bollinger` spreads by. */
export function stdev(values: readonly number[], period: number): Values {
  const p = clampedPeriod(period);
  return windowMap(values, p, (window) => {
    const average = mean(window);
    let squared = 0;
    for (const value of window) {
      const diff = value - average;
      squared += diff * diff;
    }
    return Math.sqrt(squared / p);
  });
}

/**
 * Crosses, as 1/0 series: 1 on the bar where `source` moves above (`crossover`) or below
 * (`crossunder`) `other`. Either series may be a plain number. A bar whose current or
 * previous value is missing reads NaN, so a cross is never claimed from an incomplete pair.
 */
export function crossover(source: readonly number[] | number, other: readonly number[] | number): Values {
  return crossPair(source, other, 1);
}

export function crossunder(source: readonly number[] | number, other: readonly number[] | number): Values {
  return crossPair(source, other, -1);
}

function crossPair(source: readonly number[] | number, other: readonly number[] | number, sign: 1 | -1): Values {
  const length = seriesLength(source, other);
  const out: Values = new Array<number>(length).fill(Number.NaN);
  for (let i = 1; i < length; i += 1) {
    const now = pairAt(source, other, i);
    const before = pairAt(source, other, i - 1);
    if (!Number.isFinite(now[0]) || !Number.isFinite(now[1]) || !Number.isFinite(before[0]) || !Number.isFinite(before[1])) continue;
    const above = (now[0] - now[1]) * sign > 0;
    const wasBelow = (before[0] - before[1]) * sign <= 0;
    out[i] = above && wasBelow ? 1 : 0;
  }
  return out;
}

function seriesLength(a: readonly number[] | number, b: readonly number[] | number): number {
  const left = Array.isArray(a) ? a.length : 0;
  const right = Array.isArray(b) ? b.length : 0;
  return Math.max(left, right);
}

function pairAt(a: readonly number[] | number, b: readonly number[] | number, i: number): [number, number] {
  return [Array.isArray(a) ? (a[i] ?? Number.NaN) : a, Array.isArray(b) ? (b[i] ?? Number.NaN) : b];
}

/**
 * Commodity channel index, in TradingView's own reading: the distance of the source from
 * its window mean, over 0.015 times the mean of `|source − its own window mean|`. The
 * deviation term is itself a window of smoothed values, so the line starts at bar
 * `2 · period − 2` rather than `period − 1` like the textbook form.
 */
export function cci(values: readonly number[], period: number): Values {
  const p = clampedPeriod(period);
  const average = sma(values, p);
  const out: Values = new Array<number>(values.length).fill(Number.NaN);
  for (let i = 2 * p - 2; i < values.length; i += 1) {
    const window = slice(values, i - p + 1, i);
    const means = slice(average, i - p + 1, i);
    if (!window || !means) continue;
    let spread = 0;
    for (let k = 0; k < p; k += 1) spread += Math.abs((window[k] ?? Number.NaN) - (means[k] ?? Number.NaN));
    const value = values[i] ?? Number.NaN;
    const basis = average[i] ?? Number.NaN;
    if (!Number.isFinite(spread) || !Number.isFinite(value) || !Number.isFinite(basis) || spread === 0) continue;
    out[i] = (value - basis) / ((0.015 * spread) / p);
  }
  return out;
}

/**
 * Money flow index: typical price times volume, split by whether the typical price rose or
 * fell from the previous bar, summed over the window. 100 when nothing flowed out, 0 when
 * nothing flowed in. The first bar of the window needs a previous bar, so it starts at
 * `period`.
 */
export function mfi(bars: readonly Bar[], period: number): Values {
  const p = clampedPeriod(period);
  const flow: Values = bars.map((bar) => (bar.high + bar.low + bar.close) / 3 * bar.volume);
  const rising: Values = bars.map((bar, i) => {
    if (i === 0) return Number.NaN;
    const before = bars[i - 1];
    if (!before) return Number.NaN;
    const now = (bar.high + bar.low + bar.close) / 3;
    const was = (before.high + before.low + before.close) / 3;
    if (!(now > was)) return 0;
    return flow[i] ?? Number.NaN;
  });
  const falling: Values = bars.map((bar, i) => {
    if (i === 0) return Number.NaN;
    const before = bars[i - 1];
    if (!before) return Number.NaN;
    const now = (bar.high + bar.low + bar.close) / 3;
    const was = (before.high + before.low + before.close) / 3;
    if (!(now < was)) return 0;
    return flow[i] ?? Number.NaN;
  });
  const out: Values = new Array<number>(bars.length).fill(Number.NaN);
  for (let i = p; i < bars.length; i += 1) {
    const up = slice(rising, i - p + 1, i);
    const down = slice(falling, i - p + 1, i);
    if (!up || !down) continue;
    let plus = 0;
    let minus = 0;
    for (let k = 0; k < p; k += 1) {
      const a = up[k] ?? Number.NaN;
      const b = down[k] ?? Number.NaN;
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        plus = Number.NaN;
        minus = Number.NaN;
        break;
      }
      plus += a;
      minus += b;
    }
    if (!Number.isFinite(plus) || !Number.isFinite(minus)) continue;
    if (minus === 0) out[i] = 100;
    else if (plus === 0) out[i] = 0;
    else out[i] = 100 - 100 / (1 + plus / minus);
  }
  return out;
}

export interface DmiLines {
  diPlus: Values;
  diMinus: Values;
  adx: Values;
}

/**
 * Directional movement: Wilder's +DM/−DM and true range, each smoothed by an RMA of
 * `diLength`, turned into +DI and −DI, and the DX of those two smoothed again by an RMA of
 * `adxLength` to give the average directional index.
 */
export function dmi(bars: readonly Bar[], diLength: number, adxLength: number): DmiLines {
  const di = clampedPeriod(diLength);
  const adxPeriod = clampedPeriod(adxLength);
  const up: Values = new Array<number>(bars.length).fill(Number.NaN);
  const down: Values = new Array<number>(bars.length).fill(Number.NaN);
  for (let i = 1; i < bars.length; i += 1) {
    const bar = bars[i];
    const before = bars[i - 1];
    if (!bar || !before) continue;
    const rise = bar.high - before.high;
    const fall = before.low - bar.low;
    up[i] = rise > fall && rise > 0 ? rise : 0;
    down[i] = fall > rise && fall > 0 ? fall : 0;
  }
  const ranges = trueRange(bars);
  // Bar 0 of a difference series has no previous bar to compare with, so the smoothing
  // starts one bar later and carries that bar as NaN rather than inventing a zero.
  const smoothUp = rma(shiftForDmi(up), di);
  const smoothDown = rma(shiftForDmi(down), di);
  const smoothRange = rma(shiftForDmi(ranges), di);
  const diPlus: Values = new Array<number>(bars.length).fill(Number.NaN);
  const diMinus: Values = new Array<number>(bars.length).fill(Number.NaN);
  const dx: Values = new Array<number>(bars.length).fill(Number.NaN);
  for (let i = 0; i < bars.length; i += 1) {
    const plus = smoothUp[i] ?? Number.NaN;
    const minus = smoothDown[i] ?? Number.NaN;
    const range = smoothRange[i] ?? Number.NaN;
    if (!Number.isFinite(plus) || !Number.isFinite(minus) || !Number.isFinite(range) || range === 0) continue;
    const up = (100 * plus) / range;
    const down = (100 * minus) / range;
    diPlus[i] = up;
    diMinus[i] = down;
    const total = up + down;
    dx[i] = total === 0 ? 0 : (100 * Math.abs(up - down)) / total;
  }
  return { diPlus, diMinus, adx: rma(dx, adxPeriod) };
}

/** Average directional index alone: `dmi` with the same length for both stages. */
export function adx(bars: readonly Bar[], period: number): Values {
  return dmi(bars, period, period).adx;
}

/** On-balance volume: running signed volume, the sign taken from the close's direction. */
export function obv(bars: readonly Bar[]): Values {
  const out: Values = new Array<number>(bars.length).fill(Number.NaN);
  let total = 0;
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (!bar) continue;
    const before = bars[i - 1];
    if (before) {
      if (bar.close > before.close) total += bar.volume;
      else if (bar.close < before.close) total -= bar.volume;
    }
    out[i] = total;
  }
  return out;
}

/** Bar 0 of a difference series carries no value, so push the run one bar right. */
function shiftForDmi(values: readonly number[]): Values {
  const out: Values = new Array<number>(values.length).fill(Number.NaN);
  for (let i = 1; i < values.length; i += 1) out[i] = values[i] ?? Number.NaN;
  return out;
}

/**
 * Wilder's parabolic SAR: the stop follows the trend, accelerating toward the extreme by
 * `increment` each bar a new extreme prints, capped at `maximum`, and the stop is held
 * below the two previous lows (or above them in a downtrend). A flip parks the stop at the
 * old extreme and resets the acceleration.
 */
export function sar(bars: readonly Bar[], start = 0.02, increment = 0.02, maximum = 0.2): Values {
  const out: Values = new Array<number>(bars.length).fill(Number.NaN);
  if (bars.length === 0) return out;
  const first = bars[0];
  if (!first) return out;
  let up = true;
  let stop = first.low;
  let extreme = first.high;
  let speed = Math.min(maximum, start);
  out[0] = stop;
  for (let i = 1; i < bars.length; i += 1) {
    const bar = bars[i];
    if (!bar) continue;
    stop += speed * (extreme - stop);
    if (up) {
      const prior = lowBefore(bars, i, 2);
      if (Number.isFinite(prior)) stop = Math.min(stop, prior);
      if (bar.low < stop) {
        up = false;
        stop = extreme;
        extreme = bar.low;
        speed = Math.min(maximum, start);
      } else {
        if (bar.high > extreme) {
          extreme = bar.high;
          speed = Math.min(maximum, speed + increment);
        }
      }
    } else {
      const prior = highBefore(bars, i, 2);
      if (Number.isFinite(prior)) stop = Math.max(stop, prior);
      if (bar.high > stop) {
        up = true;
        stop = extreme;
        extreme = bar.high;
        speed = Math.min(maximum, start);
      } else {
        if (bar.low < extreme) {
          extreme = bar.low;
          speed = Math.min(maximum, speed + increment);
        }
      }
    }
    out[i] = stop;
  }
  return out;
}

/** Lowest low of the `count` bars before `index`, NaN when the data does not reach back. */
function lowBefore(bars: readonly Bar[], index: number, count: number): number {
  let best = Number.NaN;
  for (let k = index - count; k < index; k += 1) {
    const bar = bars[k];
    if (!bar) return Number.NaN;
    best = Number.isFinite(best) ? Math.min(best, bar.low) : bar.low;
  }
  return best;
}

/** Highest high of the `count` bars before `index`, NaN when the data does not reach back. */
function highBefore(bars: readonly Bar[], index: number, count: number): number {
  let best = Number.NaN;
  for (let k = index - count; k < index; k += 1) {
    const bar = bars[k];
    if (!bar) return Number.NaN;
    best = Number.isFinite(best) ? Math.max(best, bar.high) : bar.high;
  }
  return best;
}

/**
 * Commodity channel index in Donchian's own form: the distance of the source from its
 * window mean, over `constant` times the mean absolute deviation of that same window.
 * The first value therefore lands at bar `period - 1`, one bar earlier than `cci`, whose
 * deviation term is itself smoothed; a window that never moves reads 0.
 */
export function cciClassic(values: readonly number[], period: number, constant = 0.015): Values {
  const p = clampedPeriod(period);
  return windowMap(values, p, (window) => {
    const average = mean(window);
    let deviation = 0;
    for (const value of window) deviation += Math.abs(value - average);
    deviation /= p;
    if (deviation === 0) return 0;
    return ((window[p - 1] ?? Number.NaN) - average) / (constant * deviation);
  });
}

/**
 * Williams %R: where `source` sits between the window's high and low, counted down from 0.
 * A window that never moves reads 0 rather than -100, matching the shipped `wpr`.
 */
export function williamsR(bars: readonly Bar[], length: number, source: SourceField = 'close'): Values {
  const p = clampedPeriod(length);
  const highs = bars.map((bar) => bar.high);
  const lows = bars.map((bar) => bar.low);
  const closes = sourceValues(bars, source);
  const out: Values = new Array<number>(bars.length).fill(Number.NaN);
  for (let i = p - 1; i < bars.length; i += 1) {
    let top = Number.NEGATIVE_INFINITY;
    let bottom = Number.POSITIVE_INFINITY;
    let broken = false;
    for (let k = i - p + 1; k <= i; k += 1) {
      const high = highs[k] ?? Number.NaN;
      const low = lows[k] ?? Number.NaN;
      if (!Number.isFinite(high) || !Number.isFinite(low)) {
        broken = true;
        break;
      }
      top = Math.max(top, high);
      bottom = Math.min(bottom, low);
    }
    const close = closes[i] ?? Number.NaN;
    if (broken || !Number.isFinite(close)) continue;
    out[i] = top === bottom ? 0 : (-100 * (top - close)) / (top - bottom);
  }
  return out;
}

/** Typical price: the bar's own three-sided average, what MFI and CCI read by definition. */
export function typicalPrice(bars: readonly Bar[]): Values {
  return bars.map((bar) => (bar.high + bar.low + bar.close) / 3);
}

export interface StochRsiLines {
  k: Values;
  d: Values;
}

/**
 * Stochastic RSI: the raw stochastic of the RSI itself — how far the RSI sits between its
 * own `stochLength` extremes — with %K smoothed by an SMA of `kSmoothing` and %D the SMA of
 * that. The line therefore starts at bar `rsiLength + stochLength + kSmoothing + dSmoothing - 2`,
 * which is the warm-up the shipped `STOCH_RSI` script declares.
 */
export function stochRsi(
  values: readonly number[],
  rsiLength: number,
  stochLength: number,
  kSmoothing: number,
  dSmoothing: number,
): StochRsiLines {
  const r = rsi(values, rsiLength);
  const raw = stochasticLine(r, r, r, stochLength);
  const k = sma(raw, kSmoothing);
  const d = sma(k, dSmoothing);
  return { k, d };
}

export interface SuperTrendLines {
  /** The line while the trend is up: it sits below the bars. */
  up: Values;
  /** The line while the trend is down: it sits above the bars. */
  down: Values;
  /** 1 while the trend is up, -1 while it is down, so a flip is a single comparison. */
  direction: Values;
}

/**
 * Supertrend: Wilder ATR bands around the bar's midpoint, where the upper band only ever
 * steps down and the lower only ever steps up (a band is replaced the moment its basic form
 * crosses it, or when the PREVIOUS close has already run through it). The trend flips when
 * the close takes out the active band, and the line is the band the trend stands on.
 * While the ATR has no value the bands are left exactly as they were, so a gap in the ATR
 * neither resets nor advances them.
 */
export function supertrend(bars: readonly Bar[], atrPeriod: number, factor: number): SuperTrendLines {
  const ranges = atr(bars, atrPeriod, 'RMA');
  const up: Values = new Array<number>(bars.length).fill(Number.NaN);
  const down: Values = new Array<number>(bars.length).fill(Number.NaN);
  const direction: Values = new Array<number>(bars.length).fill(Number.NaN);
  let trend = 0;
  let finalUpper = Number.NaN;
  let finalLower = Number.NaN;
  let previousClose = Number.NaN;
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    const atrValue = ranges[i] ?? Number.NaN;
    if (!bar || !Number.isFinite(atrValue) || !Number.isFinite(bar.high) || !Number.isFinite(bar.low) || !Number.isFinite(bar.close)) {
      continue;
    }
    const midpoint = (bar.high + bar.low) / 2;
    const basicUpper = midpoint + factor * atrValue;
    const basicLower = midpoint - factor * atrValue;
    if (trend === 0) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      trend = bar.close >= midpoint ? 1 : -1;
    } else {
      finalUpper = basicUpper < finalUpper || previousClose > finalUpper ? basicUpper : finalUpper;
      finalLower = basicLower > finalLower || previousClose < finalLower ? basicLower : finalLower;
      trend = trend === 1 ? (bar.close < finalLower ? -1 : 1) : bar.close > finalUpper ? 1 : -1;
    }
    const line = trend === 1 ? finalLower : finalUpper;
    if (trend === 1) up[i] = line;
    else down[i] = line;
    direction[i] = trend;
    previousClose = bar.close;
  }
  return { up, down, direction };
}

export interface IchimokuLines {
  tenkan: Values;
  kijun: Values;
  senkouA: Values;
  senkouB: Values;
  chikou: Values;
}

/**
 * Ichimoku: each line is the midpoint of its window's extremes; the leading spans are that
 * midpoint displaced forward by `displacement`, and the lagging span is the close displaced
 * backward by the same amount, so it has no value for the last `displacement` bars. Every
 * line waits for its window to fill instead of plotting a partial window or a zero.
 */
export function ichimoku(
  bars: readonly Bar[],
  conversionPeriod: number,
  basePeriod: number,
  laggingSpanPeriod: number,
  displacement: number,
): IchimokuLines {
  const highs = bars.map((bar) => bar.high);
  const lows = bars.map((bar) => bar.low);
  const shift = Math.max(0, Math.floor(displacement));
  const tenkan = halfExtremes(highs, lows, conversionPeriod);
  const kijun = halfExtremes(highs, lows, basePeriod);
  const midpointA: Values = tenkan.map((value, i) => {
    const other = kijun[i] ?? Number.NaN;
    return Number.isFinite(value) && Number.isFinite(other) ? (value + other) / 2 : Number.NaN;
  });
  return {
    tenkan,
    kijun,
    senkouA: delay(midpointA, shift),
    senkouB: delay(halfExtremes(highs, lows, laggingSpanPeriod), shift),
    chikou: lead(sourceValues(bars, 'close'), shift),
  };
}

/** (window high + window low) / 2, NaN until the window is full and clean. */
function halfExtremes(highs: readonly number[], lows: readonly number[], period: number): Values {
  const top = highest(highs, period);
  const bottom = lowest(lows, period);
  return top.map((value, i) => {
    const other = bottom[i] ?? Number.NaN;
    return Number.isFinite(value) && Number.isFinite(other) ? (value + other) / 2 : Number.NaN;
  });
}

/** Shift a series forward by `offset` bars, reading the value `offset` bars ahead. */
function lead(values: readonly number[], offset: number): Values {
  const shift = Math.max(0, Math.floor(offset));
  const out: Values = new Array<number>(values.length).fill(Number.NaN);
  for (let i = 0; i < values.length; i += 1) {
    const source = values[i + shift];
    if (source !== undefined && Number.isFinite(source)) out[i] = source;
  }
  return out;
}

export interface PivotLevels {
  pp: Values;
  r1: Values;
  r2: Values;
  r3: Values;
  s1: Values;
  s2: Values;
  s3: Values;
}

/**
 * Pivot points: one ladder per calendar period, drawn from the PREVIOUS period's high, low
 * and close, so the levels hold flat across a period and roll over on its first bar. Levels
 * stay absent until one period has closed, since a pivot with no prior range is a guess.
 * The three formulas are the shipped `PivotPoints` kit's: Traditional and Camarilla read
 * (H + L + C) / 3, Woodie reads (H + L + 2C) / 4, and Camarilla's tiers come off the prior
 * close at 1.1/12, 1.1/6 and 1.1/4 of the prior range. `periodsBack` keeps only the most
 * recent that many ladders (0 keeps every one), so a long tape does not fill with decades
 * of dead levels.
 */
export function pivotPoints(
  bars: readonly Bar[],
  kind: PivotKind,
  timeframe: PivotTimeframe,
  periodsBack = 0,
): PivotLevels {
  const levels: PivotLevels = {
    pp: empty(bars.length),
    r1: empty(bars.length),
    r2: empty(bars.length),
    s1: empty(bars.length),
    s2: empty(bars.length),
    r3: empty(bars.length),
    s3: empty(bars.length),
  };
  let bucket = Number.NaN;
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  let close = Number.NaN;
  let priorHigh = Number.NaN;
  let priorLow = Number.NaN;
  let priorClose = Number.NaN;
  const starts: number[] = [];
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (!bar) continue;
    const id = bucketId(bar.start, timeframe);
    if (id !== bucket) {
      if (Number.isFinite(high) && Number.isFinite(low) && Number.isFinite(close)) {
        priorHigh = high;
        priorLow = low;
        priorClose = close;
      }
      bucket = id;
      high = Number.NEGATIVE_INFINITY;
      low = Number.POSITIVE_INFINITY;
      close = Number.NaN;
      starts.push(i);
    }
    if (Number.isFinite(bar.high) && Number.isFinite(bar.low) && Number.isFinite(bar.close)) {
      high = Math.max(high, bar.high);
      low = Math.min(low, bar.low);
      close = bar.close;
    }
    if (!Number.isFinite(priorHigh) || !Number.isFinite(priorLow) || !Number.isFinite(priorClose)) continue;
    const range = priorHigh - priorLow;
    const pp = kind === 'Woodie' ? (priorHigh + priorLow + 2 * priorClose) / 4 : (priorHigh + priorLow + priorClose) / 3;
    levels.pp[i] = pp;
    if (kind === 'Camarilla') {
      const step = (range * 1.1) / 12;
      levels.r1[i] = priorClose + step;
      levels.r2[i] = priorClose + step * 2;
      levels.r3[i] = priorClose + step * 3;
      levels.s1[i] = priorClose - step;
      levels.s2[i] = priorClose - step * 2;
      levels.s3[i] = priorClose - step * 3;
    } else {
      levels.r1[i] = 2 * pp - priorLow;
      levels.s1[i] = 2 * pp - priorHigh;
      levels.r2[i] = pp + range;
      levels.s2[i] = pp - range;
      levels.r3[i] = priorHigh + 2 * (pp - priorLow);
      levels.s3[i] = priorLow - 2 * (priorHigh - pp);
    }
  }
  if (periodsBack > 0 && starts.length > periodsBack) {
    const cut = starts[starts.length - periodsBack] ?? 0;
    for (const series of Object.values(levels)) {
      for (let i = 0; i < cut; i += 1) series[i] = Number.NaN;
    }
  }
  return levels;
}

function empty(length: number): Values {
  return new Array<number>(length).fill(Number.NaN);
}

function clampedPeriod(period: number): number {
  if (!Number.isFinite(period) || period < 1) return 1;
  return Math.floor(period);
}

function slice(values: readonly number[], from: number, to: number): number[] | null {
  if (from < 0 || to < from) return null;
  const out: number[] = [];
  for (let i = from; i <= to; i += 1) {
    const value = values[i];
    if (value === undefined) return null;
    out.push(value);
  }
  return out;
}

function mean(window: readonly number[]): number {
  if (window.length === 0) return Number.NaN;
  let sum = 0;
  for (const value of window) {
    if (!Number.isFinite(value)) return Number.NaN;
    sum += value;
  }
  return sum / window.length;
}

/** Apply `fn` to every complete window, leaving incomplete or dirty windows NaN. */
function windowMap(values: readonly number[], period: number, fn: (window: readonly number[]) => number): Values {
  const out: Values = new Array<number>(values.length).fill(Number.NaN);
  for (let i = period - 1; i < values.length; i += 1) {
    const window = slice(values, i - period + 1, i);
    if (!window) continue;
    const value = fn(window);
    if (Number.isFinite(value)) out[i] = value;
  }
  return out;
}
