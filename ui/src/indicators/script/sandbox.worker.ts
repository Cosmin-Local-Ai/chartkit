/**
 * The user-script sandbox, running off the main thread.
 *
 * Two phases share one runner. `declare` executes the script against a three-bar
 * window so it can report its inputs, its placement and its plots cheaply; `compute`
 * executes it against the real bars and returns the plotted values. The script body is
 * compiled into a strict-mode function whose parameters hold the whole API, so it sees
 * no DOM, no `fetch`, no timers and no route to the page except what is handed to it.
 * A runaway loop cannot be unwound from inside, which is why the host owns the deadline
 * and terminates this worker outright rather than trusting the script to return.
 */

import {
  adx as tasAdx,
  atr as tasAtr,
  bollinger,
  cci as tasCci,
  crossover as tasCrossover,
  crossunder as tasCrossunder,
  delay,
  dmi as tasDmi,
  ema,
  highest as tasHighest,
  hma,
  lowest as tasLowest,
  macd,
  mfi as tasMfi,
  obv as tasObv,
  rma,
  rsi,
  rsiSimple,
  sar as tasSar,
  sma,
  stdev as tasStdev,
  stochastic,
  stochasticLine as tasStochasticLine,
  trueRange as tasTrueRange,
  vwma,
  vwap as tasVwap,
  wma,
  type AtrSmoothing,
  type Values,
  type VwapAnchor,
  type VwapPrice,
} from '../tas';
import type { Bar } from '../../types';
import type { PaneStyle, ParamDescriptor, ParamValue, ParamValues, PlotKind } from '../registry';
import {
  clampName,
  deriveInputNames,
  MAX_WIDTH,
  MIN_WIDTH,
  prettify,
  SCRIPT_SOURCES,
  uniqueName,
  type ScriptColumns,
  type ScriptFlow,
  type ScriptMeta,
  type ScriptPlotMeta,
  type ScriptRequest,
  type ScriptResponse,
} from './contract';

/** The worker scope, typed without pulling the webworker lib into the app's DOM lib. */
// SAFETY: this module only ever runs as a dedicated worker, where `globalThis` is a
// worker scope carrying exactly `postMessage` and `onmessage`; the app's DOM lib types
// the same object as `window`, which would be wrong in the other direction.
const scope = globalThis as unknown as {
  postMessage(message: ScriptResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
};

/** A three-bar window is enough to read a declaration: long enough for any builtin to run once. */
const DECLARE_BARS = 3;

/** The most plotted series one instance may draw: the legend and the pane title have room for about this many. */
const MAX_PLOTS = 12;

/** Globals a script must not reach. They arrive bound to `undefined`. */
const DENIED: readonly string[] = [
  'window', 'self', 'globalThis', 'global', 'document', 'location', 'history', 'navigator', 'screen',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'importScripts', 'Worker',
  'SharedWorker', 'BroadcastChannel', 'ServiceWorker', 'indexedDB', 'localStorage', 'sessionStorage',
  'caches', 'matchMedia', 'alert', 'prompt', 'confirm', 'Function', 'WebAssembly', 'Proxy',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate', 'queueMicrotask',
  'requestAnimationFrame', 'cancelAnimationFrame', 'Atomics', 'SharedArrayBuffer', 'FinalizationRegistry',
];

/**
 * Names a script may use. Everything here is a builtin from `tas.ts` or a plain helper.
 * `Math`, `Number` and the rest are re-bound so one script cannot leave a patched global
 * behind for the next run inside this worker.
 */
const PROVIDED: readonly string[] = [
  'indicator', 'input', 'plot', 'hist', 'fill',
  'open', 'high', 'low', 'close', 'volume', 'time', 'hlc3', 'size', 'barIndex',
  'source', 'na', 'nz', 'add', 'sub', 'mul', 'div', 'abs', 'min', 'max', 'round', 'floor', 'ceil',
  'gt', 'lt', 'ge', 'le', 'eq', 'ne', 'and', 'or', 'not', 'iif',
  'pow', 'sqrt', 'log', 'log10', 'exp', 'sign',
  'highest', 'lowest', 'change', 'pctChange', 'sum', 'average', 'stdev',
  'sma', 'ema', 'rma', 'wma', 'hma', 'vwma', 'bollinger', 'rsi', 'rsiSimple', 'macd', 'stochastic',
  'stochasticLine', 'atr', 'trueRange', 'vwap', 'delay', 'cci', 'mfi', 'adx', 'dmi', 'sar', 'obv',
  'crossover', 'crossunder', 'persist',
  'flowBuy', 'flowSell', 'flowDelta', 'flowCvd',
  'Math', 'Number', 'JSON', 'Date', 'Array', 'Object', 'Set', 'Map', 'String', 'Boolean', 'isNaN', 'isFinite',
  'parseInt', 'parseFloat', 'Float64Array', 'console',
];

/** Names a converted Pine script may need that a hand-written kScript never would: kept in one list so the docs and the sandbox cannot drift. */
export const SANDBOX_GLOBALS: readonly string[] = PROVIDED;

/** A script error worth showing the user verbatim. */
class ScriptFailure extends Error {}

interface BandSpec {
  upper: string;
  lower: string;
  color: string;
}

/** Everything the run learns, held in one object so the API closures only ever write fields. */
interface RunState {
  name: string;
  placement: 'price' | 'pane';
  pane: PaneStyle | null;
  band: BandSpec | null;
  usesFlow: boolean;
  inputs: ParamDescriptor[];
  plots: ScriptPlotMeta[];
  values: Values[];
  /** Which `input.*` call is executing, so it can take its name from the assignment scanning found. */
  cursor: number;
  names: string[];
  used: Set<string>;
}

scope.onmessage = (event: MessageEvent) => {
  const request = event.data as ScriptRequest;
  try {
    const run = execute(request);
    if (request.phase === 'declare') {
      scope.postMessage({ kind: 'meta', id: request.id, instanceId: request.instanceId, key: request.key, meta: run.meta });
      return;
    }
    scope.postMessage({ kind: 'values', id: request.id, instanceId: request.instanceId, key: request.key, values: run.values });
  } catch (error: unknown) {
    scope.postMessage({
      kind: 'failure',
      id: request.id,
      instanceId: request.instanceId,
      key: request.key,
      error: describe(error),
      halted: false,
    });
  }
};

interface Run {
  meta: ScriptMeta;
  values: number[][];
}

/**
 * Runs one script once, in either phase, and returns what the host needs from it.
 * Exported for the parity test, which drives the same code the worker runs.
 */
export function runScript(request: ScriptRequest): Run {
  return execute(request);
}

function execute(request: ScriptRequest): Run {
  const declare = request.phase === 'declare';
  const columns = declare ? tail(request.columns, DECLARE_BARS) : request.columns;
  const flow = declare ? tailFlow(request.flow, DECLARE_BARS) : request.flow;
  const bars = columns.start.length;
  if (bars === 0) throw new ScriptFailure('no bars to compute against');

  const names = deriveInputNames(request.source);
  const state: RunState = {
    name: 'Custom indicator',
    placement: 'price',
    pane: null,
    band: null,
    usesFlow: false,
    inputs: [],
    plots: [],
    values: [],
    cursor: 0,
    names,
    used: new Set<string>(names),
  };

  const series = {
    open: Array.from(columns.open),
    high: Array.from(columns.high),
    low: Array.from(columns.low),
    close: Array.from(columns.close),
    volume: Array.from(columns.volume),
    time: Array.from(columns.start),
    hlc3: hlc3(columns),
    barIndex: Array.from({ length: columns.start.length }, (_, index) => index),
  };
  const rows = barRows(columns);

  const readFlowDelta = (): Values => {
    state.usesFlow = true;
    if (!flow.buy || !flow.sell) return empty(bars);
    const out: Values = new Array<number>(bars).fill(Number.NaN);
    for (let i = 0; i < bars; i += 1) {
      const buy = flow.buy[i] ?? Number.NaN;
      const sell = flow.sell[i] ?? Number.NaN;
      if (Number.isFinite(buy) && Number.isFinite(sell)) out[i] = buy - sell;
    }
    return out;
  };

  /** Running delta, restarted at each UTC day unless the script asks for one unbroken run. */
  const readFlowCvd = (anchor: unknown): Values => {
    const delta = readFlowDelta();
    const daily = !(anchor === 'continuous' || anchor === 'Continuous');
    const out: Values = new Array<number>(bars).fill(Number.NaN);
    let bucket = Number.NaN;
    let total = 0;
    for (let i = 0; i < bars; i += 1) {
      const start = columns.start[i] ?? Number.NaN;
      const id = daily ? Math.floor(start / 86_400_000) : 0;
      if (id !== bucket) {
        bucket = id;
        total = 0;
      }
      const value = delta[i] ?? Number.NaN;
      if (!Number.isFinite(value)) continue;
      total += value;
      out[i] = total;
    }
    return out;
  };

  const api: Record<string, unknown> = {
    indicator: (options: unknown) => {
      const opts = asOptions(options);
      // A Pine port may hand the title in as the first argument rather than as a `name`
      // option, and may call it `title`; all three spellings name the indicator.
      const title = opts['name'] ?? opts['title'] ?? (typeof options === 'string' ? options : undefined);
      if (typeof title === 'string' && title.trim()) state.name = clampName(title);
      const where = opts['placement'];
      if (opts['overlay'] === true || where === 'price' || where === 'onchart') state.placement = 'price';
      else if (opts['overlay'] === false || where === 'pane' || where === 'offchart') state.placement = 'pane';
      const levels = numberList(opts['levels']);
      const range = numberList(opts['range']);
      const style: PaneStyle = {};
      if (levels.length > 0) style.levels = levels;
      if (range.length >= 2) style.range = { min: range[0] as number, max: range[1] as number };
      if (opts['zeroLine'] === true) style.zeroLine = true;
      const precision = opts['precision'];
      if (typeof precision === 'number' && Number.isFinite(precision)) {
        style.precision = Math.max(0, Math.min(8, Math.round(precision)));
      }
      if (opts['priceUnits'] === true) style.priceUnits = true;
      state.pane = Object.keys(style).length > 0 ? style : null;
    },
    plot: (label: unknown, values: unknown, options: unknown) => addPlot(state, label, values, options, 'line'),
    hist: (label: unknown, values: unknown, options: unknown) => addPlot(state, label, values, options, 'histogram'),
    fill: (upper: unknown, lower: unknown, options: unknown) => {
      const up = handleOf(state, upper);
      const down = handleOf(state, lower);
      if (up === down) throw new ScriptFailure('fill: the two plots must be different');
      state.band = { upper: up, lower: down, color: colorOf(options, '#4b9cf5') };
    },
    ...series,
    size: bars,
    source: (which: unknown) => pickSource(series, typeof which === 'string' ? which : 'close'),
    na: (value: unknown) => mapValues(value, (x) => (Number.isFinite(x) ? 0 : 1)),
    nz: (value: unknown, replacement: unknown) =>
      mapValues(value, (x) => x, typeof replacement === 'number' && Number.isFinite(replacement) ? replacement : 0),
    add: (a: unknown, b: unknown) => combine(a, b, (x, y) => x + y),
    sub: (a: unknown, b: unknown) => combine(a, b, (x, y) => x - y),
    mul: (a: unknown, b: unknown) => combine(a, b, (x, y) => x * y),
    div: (a: unknown, b: unknown) => combine(a, b, (x, y) => (y === 0 ? Number.NaN : x / y)),
    abs: (value: unknown) => mapValues(value, Math.abs),
    min: (a: unknown, b: unknown) => combine(a, b, Math.min),
    max: (a: unknown, b: unknown) => combine(a, b, Math.max),
    round: (value: unknown) => mapValues(value, Math.round),
    floor: (value: unknown) => mapValues(value, Math.floor),
    ceil: (value: unknown) => mapValues(value, Math.ceil),
    // Comparisons read a bar as 1 or 0, so they can be plotted, summed, and fed to `iif`.
    gt: (a: unknown, b: unknown) => combine(a, b, (x, y) => (x > y ? 1 : 0)),
    lt: (a: unknown, b: unknown) => combine(a, b, (x, y) => (x < y ? 1 : 0)),
    ge: (a: unknown, b: unknown) => combine(a, b, (x, y) => (x >= y ? 1 : 0)),
    le: (a: unknown, b: unknown) => combine(a, b, (x, y) => (x <= y ? 1 : 0)),
    eq: (a: unknown, b: unknown) => combine(a, b, (x, y) => (x === y ? 1 : 0)),
    ne: (a: unknown, b: unknown) => combine(a, b, (x, y) => (x === y ? 0 : 1)),
    and: (a: unknown, b: unknown) => combine(a, b, (x, y) => (x !== 0 && y !== 0 ? 1 : 0)),
    or: (a: unknown, b: unknown) => combine(a, b, (x, y) => (x !== 0 || y !== 0 ? 1 : 0)),
    not: (value: unknown) => mapValues(value, (x) => (x === 0 ? 1 : 0)),
    pow: (a: unknown, b: unknown) => combine(a, b, Math.pow),
    sqrt: (value: unknown) => mapValues(value, (x) => (x < 0 ? Number.NaN : Math.sqrt(x))),
    log: (value: unknown) => mapValues(value, (x) => (x <= 0 ? Number.NaN : Math.log(x))),
    log10: (value: unknown) => mapValues(value, (x) => (x <= 0 ? Number.NaN : Math.log10(x))),
    exp: (value: unknown) => mapValues(value, Math.exp),
    sign: (value: unknown) => mapValues(value, Math.sign),
    iif: (condition: unknown, whenTrue: unknown, whenFalse: unknown) => choose(condition, whenTrue, whenFalse),
    highest: (values: unknown, period: unknown) => tasHighest(list(values), number(period, 1)),
    lowest: (values: unknown, period: unknown) => tasLowest(list(values), number(period, 1)),
    stdev: (values: unknown, period: unknown) => tasStdev(list(values), number(period, 1)),
    change: (values: unknown) => offsetDifference(values, 1),
    pctChange: (values: unknown) => offsetDifference(values, 1, true),
    sum: (values: unknown, period: unknown) => rollingSum(values, period),
    average: (values: unknown, period: unknown) => rollingAverage(values, period),
    input: buildInput(state, request.params, series, declare),
    sma: (values: unknown, period: unknown) => sma(list(values), number(period, 1)),
    ema: (values: unknown, period: unknown) => ema(list(values), number(period, 1)),
    rma: (values: unknown, period: unknown) => rma(list(values), number(period, 1)),
    wma: (values: unknown, period: unknown) => wma(list(values), number(period, 1)),
    hma: (values: unknown, period: unknown) => hma(list(values), number(period, 1)),
    vwma: (values: unknown, period: unknown, volumes: unknown) =>
      vwma(list(values), list(volumes === undefined ? series.volume : volumes), number(period, 1)),
    bollinger: (values: unknown, period: unknown, mult: unknown) => {
      const bands = bollinger(list(values), number(period, 20), number(mult, 2));
      return { basis: bands.basis, upper: bands.upper, lower: bands.lower };
    },
    rsi: (values: unknown, period: unknown) => rsi(list(values), number(period, 14)),
    rsiSimple: (values: unknown, period: unknown) => rsiSimple(list(values), number(period, 14)),
    macd: (values: unknown, fastPeriod: unknown, slowPeriod: unknown, signalPeriod: unknown) => {
      const lines = macd(list(values), number(fastPeriod, 12), number(slowPeriod, 26), number(signalPeriod, 9));
      return { line: lines.line, signal: lines.signal, hist: lines.hist };
    },
    stochastic: (kPeriod: unknown, kSmoothing: unknown, dPeriod: unknown) => {
      const lines = stochastic(series.high, series.low, series.close, number(kPeriod, 14), number(kSmoothing, 3), number(dPeriod, 3));
      return { k: lines.k, d: lines.d };
    },
    stochasticLine: (values: unknown, highs: unknown, lows: unknown, period: unknown) =>
      tasStochasticLine(list(values), list(highs === undefined ? series.high : highs), list(lows === undefined ? series.low : lows), number(period, 14)),
    cci: (values: unknown, period: unknown) => tasCci(list(values), number(period, 20)),
    // Pine's `ta.mfi` always works from typical price and volume, so it takes no source.
    mfi: (period: unknown) => tasMfi(rows, number(period, 14)),
    adx: (period: unknown) => tasAdx(rows, number(period, 14)),
    dmi: (diLength: unknown, adxLength: unknown) => {
      const lines = tasDmi(rows, number(diLength, 14), number(adxLength ?? diLength, 14));
      return { diPlus: lines.diPlus, diMinus: lines.diMinus, adx: lines.adx };
    },
    sar: (start: unknown, increment: unknown, maximum: unknown) =>
      tasSar(rows, number(start, 0.02), number(increment, 0.02), number(maximum, 0.2)),
    obv: () => tasObv(rows),
    crossover: (a: unknown, b: unknown) => tasCrossover(scalarOrList(a), scalarOrList(b)),
    crossunder: (a: unknown, b: unknown) => tasCrossunder(scalarOrList(a), scalarOrList(b)),
    // Pine's `var`: one update per bar, each seeing what the last bar left behind.
    persist: (initial: unknown, step: unknown) => {
      if (typeof step !== 'function') throw new ScriptFailure('persist: the second argument must be a function of (bar, previous)');
      const next = step as (index: number, previous: number) => unknown;
      const out: Values = new Array<number>(bars).fill(Number.NaN);
      let value = typeof initial === 'number' && Number.isFinite(initial) ? initial : Number.NaN;
      for (let i = 0; i < bars; i += 1) {
        const result = Number(next(i, value));
        value = Number.isFinite(result) ? result : Number.NaN;
        out[i] = value;
      }
      return out;
    },
    atr: (period: unknown, smoothing: unknown) => tasAtr(rows, number(period, 14), smoothingOf(smoothing)),
    trueRange: () => tasTrueRange(rows),
    vwap: (anchor: unknown, price: unknown) => tasVwap(rows, vwapAnchor(anchor), vwapPrice(price)),
    delay: (values: unknown, offset: unknown) => delay(list(values), Math.max(0, Math.round(number(offset, 1)))),
    flowBuy: () => {
      state.usesFlow = true;
      return flow.buy ? Array.from(flow.buy) : empty(bars);
    },
    flowSell: () => {
      state.usesFlow = true;
      return flow.sell ? Array.from(flow.sell) : empty(bars);
    },
    flowDelta: readFlowDelta,
    flowCvd: readFlowCvd,
    Math,
    Number,
    JSON,
    Date,
    Array,
    Object,
    Set,
    Map,
    String,
    Boolean,
    isNaN,
    isFinite,
    parseInt,
    parseFloat,
    Float64Array,
    console,
  };

  compile(request.source)(api);
  return finish(state, bars);
}

/* ------------------------------------------------------------------ declaration reading */

/**
 * The `input` object: each call records one parameter and hands back its value. A declare
 * run reads the default, a compute run reads what the user set in the dialog.
 */
function buildInput(
  state: RunState,
  params: ParamValues,
  series: Record<string, Values>,
  declare: boolean,
): Record<string, (fallback: unknown, options?: unknown) => unknown> {
  /** Shared descriptor shape: name from the assignment, label from the name, plus range. */
  const descriptorOf = (kind: 'number' | 'boolean' | 'select', fallback: unknown, options: unknown): ParamDescriptor => {
    const opts = asOptions(options);
    const explicit = typeof opts['name'] === 'string' ? (opts['name'] as string).trim() : '';
    const derived = state.names[state.cursor] ?? `param${state.cursor + 1}`;
    state.cursor += 1;
    const identifier = explicit ? uniqueName(explicit, state.used) : derived;
    const label = typeof opts['label'] === 'string' && opts['label'].trim() ? opts['label'].trim() : prettify(identifier);
    const descriptor: ParamDescriptor = { name: identifier, label, kind, default: coerceDefault(kind, fallback) };
    if (kind === 'number') {
      const min = typeof opts['min'] === 'number' && Number.isFinite(opts['min']) ? opts['min'] : Number.NEGATIVE_INFINITY;
      const max = typeof opts['max'] === 'number' && Number.isFinite(opts['max']) ? opts['max'] : Number.POSITIVE_INFINITY;
      if (Number.isFinite(min)) descriptor.min = min;
      if (Number.isFinite(max)) descriptor.max = max;
      const step = typeof opts['step'] === 'number' && Number.isFinite(opts['step']) && opts['step'] > 0 ? opts['step'] : 1;
      descriptor.step = step;
    }
    return descriptor;
  };

  const numberInput = (fallback: unknown, options: unknown, integral: boolean): number => {
    const descriptor = descriptorOf('number', fallback, options);
    if (integral) {
      descriptor.default = Math.round(Number(descriptor.default));
      descriptor.step = 1;
    }
    state.inputs.push(descriptor);
    return readNumber(descriptor, declare ? descriptor.default : params[descriptor.name]);
  };

  const booleanInput = (fallback: unknown, options: unknown): boolean => {
    const descriptor = descriptorOf('boolean', fallback, options);
    descriptor.default = descriptor.default === true;
    state.inputs.push(descriptor);
    const stored = declare ? descriptor.default : params[descriptor.name];
    return typeof stored === 'boolean' ? stored : descriptor.default === true;
  };

  const selectInput = (fallback: unknown, options: unknown): string => {
    const descriptor = descriptorOf('select', fallback, options);
    const list = optionList(options);
    if (list.length === 0) throw new ScriptFailure(`input.select: ${descriptor.name} needs a non-empty options list`);
    descriptor.options = list;
    if (!list.includes(String(descriptor.default))) descriptor.default = list[0] ?? '';
    state.inputs.push(descriptor);
    return readString(descriptor, declare ? descriptor.default : params[descriptor.name]);
  };

  /** A price source arrives as a finished series, which is what a price-action script wants. */
  const sourceInput = (fallback: unknown, options: unknown): Values => {
    const base = typeof fallback === 'string' && SCRIPT_SOURCES.includes(fallback) ? fallback : 'close';
    const descriptor = descriptorOf('select', base, options);
    descriptor.options = SCRIPT_SOURCES.slice();
    state.inputs.push(descriptor);
    return pickSource(series, readString(descriptor, declare ? descriptor.default : params[descriptor.name]));
  };

  return {
    int: (fallback, options) => numberInput(fallback, options, true),
    float: (fallback, options) => numberInput(fallback, options, false),
    number: (fallback, options) => numberInput(fallback, options, false),
    bool: (fallback, options) => booleanInput(fallback, options),
    boolean: (fallback, options) => booleanInput(fallback, options),
    select: (fallback, options) => selectInput(fallback, options),
    string: (fallback, options) => selectInput(fallback, options),
    source: (fallback, options) => sourceInput(fallback, options),
  };
}

function coerceDefault(kind: 'number' | 'boolean' | 'select', fallback: unknown): ParamValue {
  if (kind === 'number') return typeof fallback === 'number' && Number.isFinite(fallback) ? fallback : 1;
  if (kind === 'boolean') return fallback === true;
  return typeof fallback === 'string' && fallback ? fallback : '';
}

function readNumber(descriptor: ParamDescriptor, stored: unknown): number {
  const value = typeof stored === 'number' && Number.isFinite(stored) ? stored : Number(descriptor.default) || 0;
  const min = descriptor.min ?? Number.NEGATIVE_INFINITY;
  const max = descriptor.max ?? Number.POSITIVE_INFINITY;
  const clamped = Math.min(max, Math.max(min, value));
  return descriptor.step === 1 ? Math.round(clamped) : clamped;
}

function readString(descriptor: ParamDescriptor, stored: unknown): string {
  const options = descriptor.options ?? [];
  if (typeof stored === 'string' && options.includes(stored)) return stored;
  const fallback = String(descriptor.default ?? '');
  return options.includes(fallback) ? fallback : (options[0] ?? '');
}

/* ------------------------------------------------------------------ results */

function addPlot(state: RunState, label: unknown, values: unknown, options: unknown, kind: PlotKind): string {
  if (state.plots.length >= MAX_PLOTS) throw new ScriptFailure(`a script may plot at most ${MAX_PLOTS} series`);
  const text = typeof label === 'string' ? label.trim() : '';
  if (!text) throw new ScriptFailure('plot: every plot needs a name');
  if (state.plots.some((plot) => plot.label === text)) throw new ScriptFailure(`plot: "${text}" is plotted twice; plot names must be unique`);
  const column = list(values);
  const opts = asOptions(options);
  const width = number(opts['width'], kind === 'histogram' ? 1 : 2);
  const negative = opts['negativeColor'] ?? opts['negative'];
  const plot: ScriptPlotMeta = {
    label: text,
    kind,
    color: colorOf(options, state.plots.length === 0 ? '#4b9cf5' : '#e8b242'),
    width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width))),
    negativeColor: kind === 'histogram' ? colorOf(negative === undefined ? options : { color: negative }, '#e53946') : null,
  };
  state.plots.push(plot);
  state.values.push(column);
  return text;
}

function handleOf(state: RunState, value: unknown): string {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!state.plots.some((plot) => plot.label === text)) throw new ScriptFailure(`fill: "${text}" was never plotted`);
    return text;
  }
  if (typeof value === 'number') {
    const plot = state.plots[value];
    if (!plot) throw new ScriptFailure('fill: pass the value plot() returned');
    return plot.label;
  }
  throw new ScriptFailure('fill: pass the values plot() returned');
}

/** Validates what the run collected and turns it into the host's declaration plus values. */
function finish(state: RunState, bars: number): Run {
  const { band } = state;
  if (state.plots.length === 0) throw new ScriptFailure('the script plotted nothing: call plot(...) or hist(...)');
  if (band && (!state.plots.some((plot) => plot.label === band.upper) || !state.plots.some((plot) => plot.label === band.lower))) {
    throw new ScriptFailure('fill: both plots it joins must be plotted lines');
  }
  const values = state.values.map((column) => {
    if (column.length !== bars) throw new ScriptFailure(`a plot returned ${column.length} values but there are ${bars} bars`);
    return column;
  });
  const meta: ScriptMeta = {
    name: state.name,
    placement: state.placement,
    inputs: state.inputs,
    plots: state.plots,
    pane: state.pane,
    band,
    usesFlow: state.usesFlow,
  };
  return { meta, values };
}

/**
 * Compiles a script body into a function whose parameters are the API and the denied
 * globals. Strict mode keeps `this` out of the body's reach.
 */
/** The name the compiled body answers to in a stack frame, so an error can name a line. */
const SCRIPT_URL = 'chartkit-script.js';

function compile(source: string): (api: Record<string, unknown>) => void {
  const factory = new Function(...PROVIDED, ...DENIED, `"use strict";\n${source}\n//# sourceURL=${SCRIPT_URL}\n`);
  return (api: Record<string, unknown>) => {
    factory(...PROVIDED.map((key) => api[key]), ...DENIED.map(() => undefined));
  };
}

/* ------------------------------------------------------------------ helpers */

function hlc3(columns: ScriptColumns): Values {
  const out: Values = new Array<number>(columns.close.length);
  for (let i = 0; i < out.length; i += 1) {
    const high = columns.high[i] ?? Number.NaN;
    const low = columns.low[i] ?? Number.NaN;
    const close = columns.close[i] ?? Number.NaN;
    out[i] = (high + low + close) / 3;
  }
  return out;
}

/** `tas.ts` works on bar rows while the sandbox holds columns, so rebuild rows where a builtin needs them. */
function barRows(columns: ScriptColumns): Bar[] {
  const length = columns.start.length;
  const rows: Bar[] = [];
  for (let i = 0; i < length; i += 1) {
    rows.push({
      start: columns.start[i] ?? 0,
      open: columns.open[i] ?? 0,
      high: columns.high[i] ?? 0,
      low: columns.low[i] ?? 0,
      close: columns.close[i] ?? 0,
      volume: columns.volume[i] ?? 0,
      trades: 0,
      closed: true,
    });
  }
  return rows;
}

function tail(columns: ScriptColumns, count: number): ScriptColumns {
  const from = Math.max(0, columns.start.length - count);
  return {
    start: columns.start.slice(from),
    open: columns.open.slice(from),
    high: columns.high.slice(from),
    low: columns.low.slice(from),
    close: columns.close.slice(from),
    volume: columns.volume.slice(from),
  };
}

function tailFlow(flow: ScriptFlow, count: number): ScriptFlow {
  const cut = (values: Float64Array | null) => (values ? values.slice(Math.max(0, values.length - count)) : null);
  return { buy: cut(flow.buy), sell: cut(flow.sell) };
}

function pickSource(series: Record<string, Values>, which: string): Values {
  return series[which] ?? series['close'] ?? [];
}

function empty(bars: number): Values {
  return new Array<number>(bars).fill(Number.NaN);
}

function asOptions(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function list(value: unknown): Values {
  if (Array.isArray(value)) return value.map((entry) => (typeof entry === 'number' ? entry : Number.NaN));
  if (value instanceof Float64Array) return Array.from(value);
  throw new ScriptFailure('expected a series: builtins return an array of numbers per bar');
}

function numberList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry));
}

function optionList(options: unknown): string[] {
  const raw = asOptions(options)['options'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

/** Color names the chart can already parse, plus `#rgb` and `#rrggbb`. */
const COLOR_NAMES: readonly string[] = [
  'red', 'green', 'blue', 'orange', 'purple', 'white', 'yellow', 'gray', 'grey', 'cyan', 'magenta', 'lime', 'teal', 'gold', 'silver',
];

function colorOf(options: unknown, fallback: string): string {
  const raw = typeof options === 'object' && options !== null ? (options as Record<string, unknown>)['color'] : options;
  if (typeof raw !== 'string') return fallback;
  const text = raw.trim().toLowerCase();
  if (COLOR_NAMES.includes(text)) return text;
  const hex = text.replace(/^#/, '');
  if (hex.length === 3 || hex.length === 6) {
    if (/^[0-9a-f]+$/.test(hex)) return `#${hex}`;
  }
  return fallback;
}

function smoothingOf(value: unknown): AtrSmoothing {
  const text = typeof value === 'string' ? value.toUpperCase() : '';
  return text === 'SMA' || text === 'EMA' || text === 'WMA' ? text : 'RMA';
}

function vwapAnchor(value: unknown): VwapAnchor {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  const allowed: readonly string[] = ['none', 'day', 'week', 'month', 'quarter', 'year'];
  return allowed.includes(text) ? (text as VwapAnchor) : 'day';
}

function vwapPrice(value: unknown): VwapPrice {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  const allowed: readonly string[] = ['hlc3', 'hl2', 'ohlc4', 'hlcc4', 'close'];
  return allowed.includes(text) ? (text as VwapPrice) : 'hlc3';
}

/**
 * Element-wise math over two operands. Two plain numbers give a plain number, which is
 * what a `persist` step needs; anything else gives one value per bar.
 */
function combine(a: unknown, b: unknown, op: (x: number, y: number) => number): Values | number {
  if (typeof a === 'number' && typeof b === 'number') return both(a, b, op);
  // Either side may be a level instead of a series, and either may be the series.
  const left = typeof a === 'number' ? null : list(a);
  const right = typeof b === 'number' ? null : list(b);
  const span = left ?? (right as Values);
  const out: Values = new Array<number>(span.length).fill(Number.NaN);
  for (let i = 0; i < span.length; i += 1) {
    const x = left ? (left[i] ?? Number.NaN) : (a as number);
    const y = right ? (right[i] ?? Number.NaN) : (b as number);
    if (Number.isFinite(x) && Number.isFinite(y)) out[i] = op(x, y);
  }
  return out;
}

/** Element-wise math over one operand, which may be a single bar's value instead. */
function mapValues(value: unknown, op: (x: number) => number, fallback?: number): Values | number {
  if (typeof value === 'number') return one(value, op, fallback);
  const values = list(value);
  const out: Values = new Array<number>(values.length).fill(Number.NaN);
  for (let i = 0; i < values.length; i += 1) {
    const x = values[i] ?? Number.NaN;
    out[i] = Number.isFinite(x) ? op(x) : (fallback ?? Number.NaN);
  }
  return out;
}

function one(value: number, op: (x: number) => number, fallback?: number): number {
  if (!Number.isFinite(value)) return fallback ?? Number.NaN;
  const result = op(value);
  return Number.isFinite(result) ? result : Number.NaN;
}

function both(a: number, b: number, op: (x: number, y: number) => number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
  const result = op(a, b);
  return Number.isFinite(result) ? result : Number.NaN;
}

/**
 * Pine's ternary: one value per bar, taking `whenTrue` where the condition is a non-zero
 * number and `whenFalse` everywhere else — a missing value reads false, as it does in Pine.
 */
function choose(condition: unknown, whenTrue: unknown, whenFalse: unknown): Values | number {
  if (typeof condition === 'number') return truthy(condition) ? asValue(whenTrue) : asValue(whenFalse);
  const flags = list(condition);
  const scalarTrue = typeof whenTrue === 'number';
  const scalarFalse = typeof whenFalse === 'number';
  const trues = scalarTrue ? null : list(whenTrue);
  const falses = scalarFalse ? null : list(whenFalse);
  const out: Values = new Array<number>(flags.length).fill(Number.NaN);
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i] ?? Number.NaN;
    const fromTrue = truthy(flag);
    const source = fromTrue ? trues : falses;
    out[i] = source ? (source[i] ?? Number.NaN) : (fromTrue ? (whenTrue as number) : (whenFalse as number));
  }
  return out;
}

function truthy(value: number): boolean {
  return Number.isFinite(value) && value !== 0;
}

function asValue(value: unknown): number {
  if (typeof value === 'number') return value;
  const values = list(value);
  return values.length > 0 ? (values[values.length - 1] ?? Number.NaN) : Number.NaN;
}

/** A `crossover` may compare a series against a level, so a plain number stays one. */
function scalarOrList(value: unknown): readonly number[] | number {
  return typeof value === 'number' ? value : list(value);
}

function offsetDifference(values: unknown, offset: number, percent = false): Values {
  const series = list(values);
  const out: Values = new Array<number>(series.length).fill(Number.NaN);
  for (let i = offset; i < series.length; i += 1) {
    const current = series[i] ?? Number.NaN;
    const previous = series[i - offset] ?? Number.NaN;
    if (!Number.isFinite(current) || !Number.isFinite(previous)) continue;
    if (percent) out[i] = previous === 0 ? Number.NaN : ((current - previous) / previous) * 100;
    else out[i] = current - previous;
  }
  return out;
}

function rollingSum(values: unknown, period: unknown): Values {
  const series = list(values);
  const p = Math.max(1, Math.round(number(period, 1)));
  const out: Values = new Array<number>(series.length).fill(Number.NaN);
  let total = 0;
  let covered = 0;
  for (let i = 0; i < series.length; i += 1) {
    const enter = series[i] ?? Number.NaN;
    if (Number.isFinite(enter)) {
      total += enter;
      covered += 1;
    }
    if (i >= p) {
      const leave = series[i - p] ?? Number.NaN;
      if (Number.isFinite(leave)) {
        total -= leave;
        covered -= 1;
      }
    }
    if (i >= p - 1 && covered === p) out[i] = total;
  }
  return out;
}

function rollingAverage(values: unknown, period: unknown): Values {
  const sums = rollingSum(values, period);
  const p = Math.max(1, Math.round(number(period, 1)));
  return sums.map((value) => (Number.isFinite(value) ? value / p : Number.NaN));
}

/** Turns whatever the script threw into one line the dialog can show. */
function describe(error: unknown): string {
  if (error instanceof ScriptFailure) return error.message;
  if (error instanceof SyntaxError) return `syntax error: ${error.message}${lineOf(error)}`;
  if (error instanceof Error) return `${error.name}: ${error.message}${lineOf(error)}`;
  return String(error);
}

/**
 * Line of the script that threw. The compiled body answers to `SCRIPT_URL`, so only its
 * frames count; every other frame names the worker and would point at framework code.
 * V8 reports two lines past the compiled body, and the compiled body starts one line
 * above the script's own first line, which is what the correction is for.
 */
const SCRIPT_FRAME = new RegExp(`${SCRIPT_URL.replace(/\./g, '\\.')}:(\\d+)`);
const LINE_CORRECTION = 3;

function lineOf(error: Error): string {
  const match = SCRIPT_FRAME.exec(error.message) ?? SCRIPT_FRAME.exec(error.stack ?? '');
  if (!match) return '';
  const line = Number(match[1]) - LINE_CORRECTION;
  return line >= 1 ? ` (line ${line})` : '';
}
