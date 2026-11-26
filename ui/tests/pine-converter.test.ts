/**
 * Numerical parity test for the Pine converter.
 *
 * Every corpus script that claims to convert is run through the same sandbox worker the
 * chart uses, and each plotted series is compared against the built-in indicator or the
 * reference implementation it stands for, over the same bars. A series only passes when the
 * NaN pattern matches too: a converted RSI that plots zeros where the built-in has no value
 * yet has not reproduced the indicator, however close the numbers look elsewhere.
 *
 * Run it with:
 *   npx rolldown tests/pine-converter.test.ts -o /tmp/pine-test.mjs -f esm && node /tmp/pine-test.mjs
 */

// The test runs in node, whose globals the DOM-only tsconfig does not carry.
declare const process: { exitCode: number };

import { convertPine, type PineConversion } from '../src/indicators/pine/emit';
import { runScript } from '../src/indicators/script/sandbox.worker';
import { indicatorById, type IndicatorDefinition, type ParamValues } from '../src/indicators/registry';
import {
  crossover,
  highest,
  lowest,
  obv,
  sar,
  stdev,
  type Values,
} from '../src/indicators/tas';
import type { Bar } from '../src/types';
import type { ScriptColumns, ScriptMeta, ScriptRequest } from '../src/indicators/script/contract';
import { CORPUS } from './pine-corpus';

const BARS = 2000;
const START = Date.UTC(2026, 10, 2, 0, 0, 0);
const MINUTE = 60_000;
/** Bars the parity table quotes values at, so a reader can check one by hand. */
const MARKED = [999, 1499, 1999];

/* ------------------------------------------------------------------ bars */

/** A seeded walk, so the corpus is compared against the same bars on every run. */
function makeBars(count: number): Bar[] {
  let seed = 20261125;
  const random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const bars: Bar[] = [];
  let price = 58_000;
  for (let i = 0; i < count; i += 1) {
    const drift = Math.sin(i / 120) * 12 + Math.sin(i / 37) * 4;
    const shock = (random() - 0.5) * 90;
    const open = price;
    const close = Math.max(100, open + drift + shock);
    const high = Math.max(open, close) + random() * 45;
    const low = Math.min(open, close) - random() * 45;
    const volume = 0.4 + random() * 6;
    bars.push({ start: START + i * MINUTE, open, high, low, close, volume, trades: Math.round(volume * 10), closed: true });
    price = close;
  }
  return bars;
}

const bars = makeBars(BARS);
const closes = bars.map((bar) => bar.close);
const highs = bars.map((bar) => bar.high);
const lows = bars.map((bar) => bar.low);
const typical = bars.map((bar) => (bar.high + bar.low + bar.close) / 3);
const midpoints = bars.map((bar) => (bar.high + bar.low) / 2);

/* ------------------------------------------------------------------ harness */

interface Check {
  label: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function check(label: string, ok: boolean, detail = ''): void {
  checks.push({ label, ok, detail });
}

function columnsFor(list: readonly Bar[]): ScriptColumns {
  const empty = { start: new Float64Array(list.length), open: new Float64Array(list.length), high: new Float64Array(list.length), low: new Float64Array(list.length), close: new Float64Array(list.length), volume: new Float64Array(list.length) };
  list.forEach((bar, i) => {
    empty.start[i] = bar.start;
    empty.open[i] = bar.open;
    empty.high[i] = bar.high;
    empty.low[i] = bar.low;
    empty.close[i] = bar.close;
    empty.volume[i] = bar.volume;
  });
  return empty;
}

const columns = columnsFor(bars);

/** Runs a converted script the way the host does: declare, then compute with defaults. */
function run(source: string, params: ParamValues = {}): { meta: ScriptMeta; values: number[][] } {
  const base = { id: 1, instanceId: 'parity', source, params, columns, flow: { buy: null, sell: null }, key: 'parity' };
  const request = (phase: 'declare' | 'compute'): ScriptRequest => ({ ...base, phase } as ScriptRequest);
  const declared = runScript(request('declare'));
  const computed = runScript(request('compute'));
  return { meta: declared.meta, values: computed.values };
}

/**
 * Compares one plotted series against its reference.
 *
 * Tolerance is relative to the size of the reference value, so a moving average of a 58,000
 * coin is held to the same number of significant digits as an oscillator in the 0-100 range.
 */
function compare(label: string, got: Values, want: Values, relative: number): void {
  let maxDiff = 0;
  let worst = -1;
  let nanMismatch = 0;
  let firstMismatch = -1;
  let overTolerance = false;
  for (let i = 0; i < want.length; i += 1) {
    const a = got[i] ?? Number.NaN;
    const b = want[i] ?? Number.NaN;
    const aFinite = Number.isFinite(a);
    const bFinite = Number.isFinite(b);
    if (!aFinite && !bFinite) continue;
    if (aFinite !== bFinite) {
      nanMismatch += 1;
      if (firstMismatch < 0) firstMismatch = i;
      continue;
    }
    const diff = Math.abs(a - b);
    if (diff > relative * Math.max(1, Math.abs(b))) overTolerance = true;
    if (diff > maxDiff) {
      maxDiff = diff;
      worst = i;
    }
  }
  const values = MARKED.map((index) => `${index}: ${format(got[index])} vs ${format(want[index])}`).join(' | ');
  check(
    label,
    !overTolerance && nanMismatch === 0,
    `max ${maxDiff.toExponential(2)} (tol ${relative.toExponential(0)}) at bar ${worst}, NaN gaps differ by ${nanMismatch}${firstMismatch >= 0 ? ` (first at ${firstMismatch})` : ''} | ${values}`,
  );
}

function format(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return 'na';
  return value.toFixed(4);
}

/* ------------------------------------------------------------------ reference implementations */

/** Wilder's RMA, written from the definition: a mean seed, then (prev·(p−1) + x)/p. */
function refRma(values: readonly number[], period: number): Values {
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
      if (seen < period) continue;
      value = seed / period;
      out[i] = value;
      continue;
    }
    value = (value * (period - 1) + x) / period;
    out[i] = value;
  }
  return out;
}

function refTrueRange(list: readonly Bar[]): Values {
  return list.map((bar, i) => {
    if (i === 0) return bar.high - bar.low;
    const before = list[i - 1] as Bar;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - before.close), Math.abs(bar.low - before.close));
  });
}

function refAtr(list: readonly Bar[], period: number): Values {
  return refRma(refTrueRange(list), period);
}

/** CCI as TradingView computes it: the mean of `|src − its own SMA|`, not of the current one. */
function refCci(values: readonly number[], period: number): Values {
  const n = values.length;
  const out: Values = new Array<number>(n).fill(Number.NaN);
  for (let i = 0; i < n; i += 1) {
    if (i < 2 * period - 2) continue;
    let sum = 0;
    for (let k = i - period + 1; k <= i; k += 1) sum += values[k] ?? Number.NaN;
    const basis = sum / period;
    let spread = 0;
    for (let k = i - period + 1; k <= i; k += 1) {
      let window = 0;
      for (let j = k - period + 1; j <= k; j += 1) window += values[j] ?? Number.NaN;
      spread += Math.abs((values[k] ?? Number.NaN) - window / period);
    }
    if (spread === 0) continue;
    out[i] = ((values[i] ?? Number.NaN) - basis) / ((0.015 * spread) / period);
  }
  return out;
}

/** MFI: typical-price money flow, split by whether the typical price rose or fell. */
function refMfi(list: readonly Bar[], period: number): Values {
  const n = list.length;
  const out: Values = new Array<number>(n).fill(Number.NaN);
  const price = (bar: Bar) => (bar.high + bar.low + bar.close) / 3;
  for (let i = period; i < n; i += 1) {
    let plus = 0;
    let minus = 0;
    let broken = false;
    for (let k = i - period + 1; k <= i; k += 1) {
      const bar = list[k] as Bar;
      const before = list[k - 1];
      if (!before) {
        broken = true;
        break;
      }
      const flow = price(bar) * bar.volume;
      if (price(bar) > price(before)) plus += flow;
      else if (price(bar) < price(before)) minus += flow;
    }
    if (broken) continue;
    if (minus === 0) out[i] = 100;
    else if (plus === 0) out[i] = 0;
    else out[i] = 100 - 100 / (1 + plus / minus);
  }
  return out;
}

/** +DI, −DI and ADX from Wilder's definitions, with its own smoothing pass. */
function refDmi(list: readonly Bar[], diLength: number, adxLength: number): { diPlus: Values; diMinus: Values; adx: Values } {
  const n = list.length;
  const plusDm: Values = new Array<number>(n).fill(Number.NaN);
  const minusDm: Values = new Array<number>(n).fill(Number.NaN);
  for (let i = 1; i < n; i += 1) {
    const bar = list[i] as Bar;
    const before = list[i - 1] as Bar;
    const rise = bar.high - before.high;
    const fall = before.low - bar.low;
    plusDm[i] = rise > fall && rise > 0 ? rise : 0;
    minusDm[i] = fall > rise && fall > 0 ? fall : 0;
  }
  const ranges = refTrueRange(list);
  ranges[0] = Number.NaN;
  const smoothPlus = refRma(plusDm, diLength);
  const smoothMinus = refRma(minusDm, diLength);
  const smoothRange = refRma(ranges, diLength);
  const diPlus: Values = new Array<number>(n).fill(Number.NaN);
  const diMinus: Values = new Array<number>(n).fill(Number.NaN);
  const dx: Values = new Array<number>(n).fill(Number.NaN);
  for (let i = 0; i < n; i += 1) {
    const plus = smoothPlus[i] ?? Number.NaN;
    const minus = smoothMinus[i] ?? Number.NaN;
    const range = smoothRange[i] ?? Number.NaN;
    if (!Number.isFinite(plus) || !Number.isFinite(minus) || !Number.isFinite(range) || range === 0) continue;
    diPlus[i] = (100 * plus) / range;
    diMinus[i] = (100 * minus) / range;
    const total = diPlus[i]! + diMinus[i]!;
    dx[i] = total === 0 ? 0 : (100 * Math.abs(diPlus[i]! - diMinus[i]!)) / total;
  }
  return { diPlus, diMinus, adx: refRma(dx, adxLength) };
}

/** Wilder's parabolic SAR: an accelerating stop, capped by the two bars behind it. */
function refSar(list: readonly Bar[], start = 0.02, step = 0.02, ceiling = 0.2): Values {
  const out: Values = new Array<number>(list.length).fill(Number.NaN);
  if (list.length === 0) return out;
  let rising = true;
  let stop = (list[0] as Bar).low;
  let extreme = (list[0] as Bar).high;
  let speed = start;
  out[0] = stop;
  for (let i = 1; i < list.length; i += 1) {
    const bar = list[i] as Bar;
    stop = stop + speed * (extreme - stop);
    if (rising) {
      const lows = [list[i - 1], list[i - 2]].filter(Boolean) as Bar[];
      if (lows.length === 2) stop = Math.min(stop, lows[0]!.low, lows[1]!.low);
      if (bar.low < stop) {
        rising = false;
        stop = extreme;
        extreme = bar.low;
        speed = start;
      } else if (bar.high > extreme) {
        extreme = bar.high;
        speed = Math.min(ceiling, speed + step);
      }
    } else {
      const highs = [list[i - 1], list[i - 2]].filter(Boolean) as Bar[];
      if (highs.length === 2) stop = Math.max(stop, highs[0]!.high, highs[1]!.high);
      if (bar.high > stop) {
        rising = true;
        stop = extreme;
        extreme = bar.high;
        speed = start;
      } else if (bar.low < extreme) {
        extreme = bar.low;
        speed = Math.min(ceiling, speed + step);
      }
    }
    out[i] = stop;
  }
  return out;
}

/** The SuperTrend in the corpus, written straight from its Pine text. */
function refSuperTrend(list: readonly Bar[], atrPeriod: number, factor: number): { up: Values; down: Values; dir: Values } {
  const n = list.length;
  const atr = refAtr(list, atrPeriod);
  const bandUp: Values = new Array<number>(n).fill(Number.NaN);
  const bandDn: Values = new Array<number>(n).fill(Number.NaN);
  for (let i = 0; i < n; i += 1) {
    const close = (list[i] as Bar).close;
    const range = atr[i] ?? Number.NaN;
    if (Number.isFinite(range)) {
      bandUp[i] = close + factor * range;
      bandDn[i] = close - factor * range;
    }
  }
  const finalUp: Values = new Array<number>(n).fill(Number.NaN);
  const finalDn: Values = new Array<number>(n).fill(Number.NaN);
  for (let i = 0; i < n; i += 1) {
    const previous = i > 0 ? (bandUp[i - 1] ?? Number.NaN) : Number.NaN;
    const previousDown = i > 0 ? (bandDn[i - 1] ?? Number.NaN) : Number.NaN;
    const heldUp = Number.isFinite(previous) ? previous : (bandUp[i] ?? Number.NaN);
    const heldDown = Number.isFinite(previousDown) ? previousDown : (bandDn[i] ?? Number.NaN);
    const previousClose = i > 0 ? (list[i - 1] as Bar).close : Number.NaN;
    finalUp[i] = Number.isFinite(previousClose) && previousClose > heldUp ? heldUp : (bandUp[i] ?? Number.NaN);
    finalDn[i] = Number.isFinite(previousClose) && previousClose < heldDown ? heldDown : (bandDn[i] ?? Number.NaN);
  }
  const up: Values = new Array<number>(n).fill(Number.NaN);
  const down: Values = new Array<number>(n).fill(Number.NaN);
  const dir: Values = new Array<number>(n).fill(Number.NaN);
  let trend = 1;
  for (let i = 0; i < n; i += 1) {
    const close = (list[i] as Bar).close;
    if (trend === 1) trend = close < (finalDn[i] ?? Number.NaN) ? -1 : 1;
    else trend = close > (finalUp[i] ?? Number.NaN) ? 1 : -1;
    dir[i] = trend;
    if (trend === 1) up[i] = finalDn[i] ?? Number.NaN;
    else down[i] = finalUp[i] ?? Number.NaN;
  }
  return { up, down, dir };
}

/** The corpus script's own range width: window high−low as a percent of its midpoint. */
function refWidth(): Values {
  const top = refExtreme(highs, 20, 'high');
  const bottom = refExtreme(lows, 20, 'low');
  const midpoint = halve(add(top, bottom));
  return div(sub(top, bottom), midpoint).map((value) => (Number.isFinite(value) ? value * 100 : Number.NaN));
}

/** Window extremes, NaN while the window holds a value that is missing. */
function refExtreme(values: readonly number[], period: number, mode: 'high' | 'low'): Values {
  const out: Values = new Array<number>(values.length).fill(Number.NaN);
  for (let i = period - 1; i < values.length; i += 1) {
    let best = Number.NaN;
    for (let k = i - period + 1; k <= i; k += 1) {
      const value = values[k] ?? Number.NaN;
      if (!Number.isFinite(value)) {
        best = Number.NaN;
        break;
      }
      if (!Number.isFinite(best) || (mode === 'high' ? value > best : value < best)) best = value;
    }
    out[i] = best;
  }
  return out;
}

/* ------------------------------------------------------------------ corpus: scripts that must convert */

interface Parity {
  id: string;
  plot: number;
  label: string;
  reference: () => Values;
  relative: number;
}

/** What each corpus script is expected to reproduce, plot by plot. */
const PARITY: Record<string, Parity[]> = {
  'sma-ema': [
    { id: 'sma-ema', plot: 0, label: 'SMA(9, close) = built-in SMA', reference: () => builtIn('SMA', { period: 9, source: 'close' }), relative: 1e-9 },
    { id: 'sma-ema', plot: 1, label: 'EMA(21, close) = built-in EMA', reference: () => builtIn('EMA', { period: 21, source: 'close' }), relative: 1e-9 },
  ],
  'rsi-inputs': [{ id: 'rsi-inputs', plot: 0, label: 'ta.rsi(14) = built-in RSI', reference: () => builtIn('RSI', { period: 14, smooth: true }), relative: 1e-9 }],
  'bb-fill': [
    { id: 'bb-fill', plot: 0, label: 'BB upper = built-in Bollinger', reference: () => builtIn('BOLLINGER_BANDS', { period: 20, stdDev: 2 }, 0), relative: 1e-9 },
    { id: 'bb-fill', plot: 1, label: 'BB basis = built-in Bollinger', reference: () => builtIn('BOLLINGER_BANDS', { period: 20, stdDev: 2 }, 1), relative: 1e-9 },
    { id: 'bb-fill', plot: 2, label: 'BB lower = built-in Bollinger', reference: () => builtIn('BOLLINGER_BANDS', { period: 20, stdDev: 2 }, 2), relative: 1e-9 },
  ],
  'macd-hist': [
    { id: 'macd-hist', plot: 0, label: 'ta.macd line = built-in MACD', reference: () => builtIn('MACD', { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }, 0), relative: 1e-9 },
    { id: 'macd-hist', plot: 1, label: 'ta.macd signal = built-in MACD', reference: () => builtIn('MACD', { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }, 1), relative: 1e-9 },
    { id: 'macd-hist', plot: 2, label: 'ta.macd hist = built-in MACD', reference: () => builtIn('MACD', { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }, 2), relative: 1e-9 },
  ],
  atr: [{ id: 'atr', plot: 0, label: 'ta.atr(14) = built-in ATR (RMA)', reference: () => builtIn('ATR', { period: 14, smoothing: 'RMA' }), relative: 1e-9 }],
  stoch: [
    { id: 'stoch', plot: 0, label: 'sma(ta.stoch,3) = built-in STOCH %K', reference: () => builtIn('STOCH', { kPeriod: 14, kSmoothing: 3, dPeriod: 3 }, 0), relative: 1e-9 },
    { id: 'stoch', plot: 1, label: 'sma(%K,3) = built-in STOCH %D', reference: () => builtIn('STOCH', { kPeriod: 14, kSmoothing: 3, dPeriod: 3 }, 1), relative: 1e-9 },
  ],
  'local-function': [
    { id: 'local-function', plot: 0, label: 'sma(midpoint(high, low), 10) = reference SMA of hl2', reference: () => refSmaNaive(midpoints, 10), relative: 1e-9 },
  ],
  'vwap-bands': [
    { id: 'vwap-bands', plot: 0, label: 'ta.vwap(hlc3) = built-in VWAP (day, hlc3)', reference: () => builtIn('VWAP', { anchor: 'day', price: 'hlc3' }), relative: 1e-9 },
    { id: 'vwap-bands', plot: 1, label: 'VWAP + 1·stdev(hlc3,20)', reference: () => add(refVwap(), mul(tasStdev(typical, 20), 1)), relative: 1e-9 },
  ],
  cci: [{ id: 'cci', plot: 0, label: 'ta.cci(hlc3,20) = reference CCI', reference: () => refCci(typical, 20), relative: 1e-9 }],
  'adx-dmi': [
    { id: 'adx-dmi', plot: 0, label: 'ta.dmi +DI = reference DI', reference: () => refDmi(bars, 14, 14).diPlus, relative: 1e-9 },
    { id: 'adx-dmi', plot: 1, label: 'ta.dmi −DI = reference DI', reference: () => refDmi(bars, 14, 14).diMinus, relative: 1e-9 },
    { id: 'adx-dmi', plot: 2, label: 'ta.dmi ADX = reference ADX', reference: () => refDmi(bars, 14, 14).adx, relative: 1e-9 },
  ],
  mfi: [{ id: 'mfi', plot: 0, label: 'ta.mfi(14) = reference MFI', reference: () => refMfi(bars, 14), relative: 1e-9 }],
  supertrend: [
    { id: 'supertrend', plot: 0, label: 'SuperTrend up = reference', reference: () => refSuperTrend(bars, 10, 3).up, relative: 1e-9 },
    { id: 'supertrend', plot: 1, label: 'SuperTrend down = reference', reference: () => refSuperTrend(bars, 10, 3).down, relative: 1e-9 },
  ],
  ichimoku: [
    { id: 'ichimoku', plot: 0, label: 'Tenkan = (highest(9)+lowest(9))/2', reference: () => halve(add(refExtreme(highs, 9, 'high'), refExtreme(lows, 9, 'low'))), relative: 1e-9 },
    { id: 'ichimoku', plot: 1, label: 'Kijun = (highest(26)+lowest(26))/2', reference: () => halve(add(refExtreme(highs, 26, 'high'), refExtreme(lows, 26, 'low'))), relative: 1e-9 },
    { id: 'ichimoku', plot: 2, label: 'Span A = (Tenkan+Kijun)/2', reference: () => halve(add(halve(add(refExtreme(highs, 9, 'high'), refExtreme(lows, 9, 'low'))), halve(add(refExtreme(highs, 26, 'high'), refExtreme(lows, 26, 'low'))))), relative: 1e-9 },
    { id: 'ichimoku', plot: 3, label: 'Span B = (highest(52)+lowest(52))/2', reference: () => halve(add(refExtreme(highs, 52, 'high'), refExtreme(lows, 52, 'low'))), relative: 1e-9 },
  ],
  'price-action': [
    {
      id: 'price-action',
      plot: 1,
      label: 'Range width = reference',
      reference: () => refWidth(),
      relative: 1e-9,
    },
    {
      id: 'price-action',
      plot: 2,
      label: 'Squeeze marker = reference',
      reference: () => {
        const width = refWidth();
        return bars.map((bar, i) => {
          const inside = i > 0 && bar.high <= (highs[i - 1] as number) && bar.low >= (lows[i - 1] as number);
          const narrow = Math.abs(bar.close - bar.open) <= 0.35 * (bar.high - bar.low);
          return inside && narrow ? (width[i] ?? Number.NaN) : Number.NaN;
        });
      },
      relative: 1e-9,
    },
    {
      id: 'price-action',
      plot: 3,
      label: 'Narrowest-yet marker = reference',
      reference: () => {
        const width = refWidth();
        return width.map((value, i) => {
          const smallest = refExtreme(width, 20, 'low')[i] ?? Number.NaN;
          return Number.isFinite(value) && Number.isFinite(smallest) && value <= smallest + 0.000001 ? value : Number.NaN;
        });
      },
      relative: 1e-9,
    },
  ],
};

/* ------------------------------------------------------------------ small series helpers for the references */

function map2(a: Values, b: Values | number, fn: (x: number, y: number) => number): Values {
  return a.map((value, i) => {
    const other = typeof b === 'number' ? b : (b[i] ?? Number.NaN);
    if (!Number.isFinite(value) || !Number.isFinite(other)) return Number.NaN;
    return fn(value, other);
  });
}

function add(a: Values, b: Values | number): Values {
  return map2(a, b, (x, y) => x + y);
}

function sub(a: Values, b: Values | number): Values {
  return map2(a, b, (x, y) => x - y);
}

function mul(a: Values, b: Values | number): Values {
  return map2(a, b, (x, y) => x * y);
}

function div(a: Values, b: Values | number): Values {
  return map2(a, b, (x, y) => (y === 0 ? Number.NaN : x / y));
}

function halve(a: Values): Values {
  return div(a, 2);
}

/** The built-in indicator's own plotted series, straight from its `compute`. */
function builtIn(id: string, params: ParamValues, plot = 0): Values {
  const definition = indicatorById(id) as IndicatorDefinition;
  const result = definition.compute(bars, { width: 1, smooth: false, colors: [], ...params }, null);
  return result.plots[plot]?.values ?? [];
}

function refVwap(): Values {
  let bucket = Number.NaN;
  let numerator = 0;
  let denominator = 0;
  return bars.map((bar, i) => {
    const day = Math.floor(bar.start / 86_400_000);
    if (day !== bucket) {
      bucket = day;
      numerator = 0;
      denominator = 0;
    }
    numerator += (typical[i] ?? Number.NaN) * bar.volume;
    denominator += bar.volume;
    return denominator === 0 ? Number.NaN : numerator / denominator;
  });
}

function tasStdev(values: Values, period: number): Values {
  return stdev(values, period);
}

/* ------------------------------------------------------------------ run the corpus */

const converted = new Map<string, PineConversion>();

for (const script of CORPUS) {
  const result = convertPine(script.pine);
  converted.set(script.id, result);

  if (script.expect === 'refuses') {
    const lines = result.errors.map((error) => error.line);
    const missing = (script.errorLines ?? []).filter((line) => !lines.includes(line));
    check(
      `refuses ${script.id} (${script.title})`,
      !result.ok && missing.length === 0 && result.errors.length > 0,
      missing.length > 0 ? `expected a line in the errors, missing ${missing.join('/')}; got ${lines.join('/')}: ${result.errors[0]?.message}` : `${lines.join('/')}: ${result.errors.map((error) => error.message).join(' | ')}`,
    );
    continue;
  }

  if (!result.ok) {
    check(`converts ${script.id} (${script.title})`, false, result.errors.map((error) => `line ${error.line}: ${error.message}`).join(' | '));
    continue;
  }
  check(`converts ${script.id} (${script.title})`, true, `warnings: ${result.warnings.map((warning) => `line ${warning.line}: ${warning.message}`).join(' | ') || 'none'}`);

  let run_;
  try {
    run_ = run(result.source);
  } catch (error: unknown) {
    check(`runs ${script.id}`, false, String(error));
    continue;
  }
  const { meta, values } = run_;
  check(
    `runs ${script.id}`,
    values.length > 0 && values.every((column) => column.length === BARS),
    `${values.length} plots, name "${meta.name}", placement ${meta.placement}, inputs ${meta.inputs.map((input) => `${input.name}:${input.kind}`).join(',') || 'none'}`,
  );
  check(
    `name and placement ${script.id}`,
    meta.name === result.name && meta.placement === (script.pine.includes('overlay = true') || script.pine.includes('overlay=true') ? 'price' : 'pane'),
    `pane title shows "${meta.name}", plots ${meta.plots.map((plot) => plot.label).join(', ')}`,
  );

  for (const parity of PARITY[script.id] ?? []) {
    const got = values[parity.plot] ?? [];
    compare(`${script.id} · ${parity.label}`, got, parity.reference(), parity.relative);
  }
}

/* ------------------------------------------------------------------ new builtins against references */

check('tas.highest matches the reference', same(refExtreme(highs, 14, 'high'), highest(highs, 14), 1e-12), `max ${maxDiff(refExtreme(highs, 14, 'high'), highest(highs, 14)).toExponential(2)} (tol 1e-12)`);
check('tas.lowest matches the reference', same(refExtreme(lows, 14, 'low'), lowest(lows, 14), 1e-12), `max ${maxDiff(refExtreme(lows, 14, 'low'), lowest(lows, 14)).toExponential(2)} (tol 1e-12)`);
check(
  'tas.stdev matches the reference',
  same(refStdev(typical, 20), stdev(typical, 20), 1e-9),
  `max ${maxDiff(refStdev(typical, 20), stdev(typical, 20)).toExponential(2)} (tol 1e-9)`,
);
check(
  'tas.crossover matches the reference',
  same(refCross(closes, refSmaNaive(closes, 20)), crossover(closes, refSmaNaive(closes, 20)), 0),
  `crosses: ${count(refCross(closes, refSmaNaive(closes, 20)))} vs ${count(crossover(closes, refSmaNaive(closes, 20)))}`,
);
check('tas.obv matches the reference', same(refObv(bars), obv(bars), 1e-9), `last ${format(obv(bars)[BARS - 1])} vs ${format(refObv(bars)[BARS - 1])} (tol 1e-9)`);
check(
  'tas.sar matches the reference',
  same(refSar(bars), sar(bars), 1e-9),
  `max ${maxDiff(refSar(bars), sar(bars)).toExponential(2)} (tol 1e-9); flips ${flips(sar(bars))} vs ${flips(refSar(bars))}`,
);

/** Population standard deviation over a window, from the definition. */
function refStdev(values: readonly number[], period: number): Values {
  const out: Values = new Array<number>(values.length).fill(Number.NaN);
  for (let i = period - 1; i < values.length; i += 1) {
    let sum = 0;
    for (let k = i - period + 1; k <= i; k += 1) sum += values[k] ?? Number.NaN;
    const average = sum / period;
    let squared = 0;
    for (let k = i - period + 1; k <= i; k += 1) {
      const diff = (values[k] ?? Number.NaN) - average;
      squared += diff * diff;
    }
    out[i] = Math.sqrt(squared / period);
  }
  return out;
}

/** 1 where a series moves above another, 0 where it does not, NaN without a pair. */
function refCross(source: readonly number[], other: readonly number[]): Values {
  return source.map((_, i) => {
    if (i === 0) return Number.NaN;
    const now = source[i] as number;
    const above = other[i] as number;
    const before = source[i - 1] as number;
    const wasAbove = other[i - 1] as number;
    if (!Number.isFinite(now) || !Number.isFinite(above) || !Number.isFinite(before) || !Number.isFinite(wasAbove)) return Number.NaN;
    return now > above && before <= wasAbove ? 1 : 0;
  });
}

function refSmaNaive(values: readonly number[], period: number): Values {
  return values.map((_, i) => {
    if (i < period - 1) return Number.NaN;
    let sum = 0;
    for (let k = i - period + 1; k <= i; k += 1) sum += values[k] ?? Number.NaN;
    return sum / period;
  });
}

function refObv(list: readonly Bar[]): Values {
  const out: Values = new Array<number>(list.length).fill(0);
  let total = 0;
  list.forEach((bar, i) => {
    if (i > 0) {
      const before = list[i - 1] as Bar;
      if (bar.close > before.close) total += bar.volume;
      else if (bar.close < before.close) total -= bar.volume;
    }
    out[i] = total;
  });
  return out;
}

function same(a: Values, b: Values, tolerance: number): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? Number.NaN;
    const y = b[i] ?? Number.NaN;
    if (!Number.isFinite(x) && !Number.isFinite(y)) continue;
    if (Number.isFinite(x) !== Number.isFinite(y)) return false;
    if (Math.abs(x - y) > tolerance * Math.max(1, Math.abs(y))) return false;
  }
  return true;
}

function maxDiff(a: Values, b: Values): number {
  let best = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const x = a[i] ?? Number.NaN;
    const y = b[i] ?? Number.NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    best = Math.max(best, Math.abs(x - y));
  }
  return best;
}

function count(values: Values): number {
  return values.filter((value) => value === 1).length;
}

/** How often a stop-and-reverse series changes side against the close. */
function flips(values: Values): number {
  let side = Number.NaN;
  let total = 0;
  values.forEach((value, i) => {
    if (!Number.isFinite(value)) return;
    const current = value > (closes[i] ?? 0) ? 1 : -1;
    if (Number.isFinite(side) && current !== side) total += 1;
    side = current;
  });
  return total;
}

/* ------------------------------------------------------------------ report */

const failures = checks.filter((entry) => !entry.ok);
console.log(`\nPine converter parity: ${checks.length - failures.length}/${checks.length} checks passed on ${BARS} bars\n`);
for (const entry of checks) {
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.label}`);
  if (entry.detail) console.log(`        ${entry.detail}`);
}
if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exitCode = 1;
}
