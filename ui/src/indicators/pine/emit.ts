/**
 * Pine Script → the user-indicator script format.
 *
 * The target format is the one `sandbox.worker.ts` runs: `indicator({ name, placement })`,
 * `input.*` calls whose parameter name comes from the variable they assign to, `plot`,
 * `hist` and `fill`, arithmetic by function rather than by operator, and the numeric
 * builtins `tas.ts` exports. Every name this file emits is one of that worker's provided
 * globals, so a converted script can only reach what a hand-written one can.
 *
 * Two rules keep a translation honest:
 *
 * 1. Anything outside the subset is a hard error naming its line — never a silent drop. A
 *    run collects every refusal it finds and returns them together, so the reader sees the
 *    whole list instead of fixing one line at a time.
 * 2. Pine `var` is stateful while our compute is vectorised, so a `var` becomes a `persist`
 *    pass: one loop over the bars, with every state-independent part of its update hoisted
 *    out as a whole series and read per bar inside the step.
 */

import type { CallArgument, Expr, FunctionParam, Stmt } from './ast';
import { eachNode, namesIn } from './ast';
import { PineSyntaxError, tokenize } from './lexer';
import { parse } from './parser';

/** One refusal or note, always tied to a line of the original Pine. */
export interface PineDiagnostic {
  line: number;
  message: string;
}

export interface PineConversion {
  ok: boolean;
  /** The script format's source, empty unless `ok`. */
  source: string;
  /** The name the script declares, taken from Pine's `study`/`indicator` title. */
  name: string;
  /** Where the converted indicator draws. */
  placement: 'price' | 'pane';
  /** The legend labels the converted indicator will draw, in order. */
  plotLabels: string[];
  errors: PineDiagnostic[];
  warnings: PineDiagnostic[];
}

/** How a name resolves inside the emitted script. */
interface NameInfo {
  js: string;
  /** `series` is one value per bar; `scalar` is one value for the whole script. */
  kind: 'series' | 'scalar' | 'state' | 'plot' | 'color' | 'function';
  /** For a `plot`: the legend label it was given. */
  label?: string;
  /** For a `color`: the color literal it holds. */
  color?: string;
  /** For a series that came from `input.source` or a price field: the price name it stands for. */
  priceName?: string;
}

/** A Pine `var`, and the statements that update it. */
interface StatePlan {
  name: string;
  js: string;
  init: Expr;
  /** Index in the flat statement list of the `var` line and of every update, in order. */
  declIndex: number;
  updates: number[];
  /** The expression each update assigns, already folded from any if-chain. */
  bodies: Expr[];
  line: number;
}

/** One local assignment inside a user-defined function. */
interface LocalAssign {
  name: string;
  expr: Expr;
  line: number;
}

/** A pure Pine function, kept as a callable rather than inlined. */
interface FunctionPlan {
  name: string;
  js: string;
  params: FunctionParam[];
  body: LocalAssign[];
  returns: Expr;
  line: number;
}

/** A statement list with the block structure folded away. */
type Flat =
  | { kind: 'assign'; name: string; expr: Expr; declared: boolean; variable: boolean; line: number }
  | { kind: 'call'; expr: Expr; line: number }
  | { kind: 'tuple'; key: 'macd' | 'dmi'; outputs: string[]; names: string[]; args: CallArgument[]; line: number }
  | { kind: 'function'; plan: FunctionPlan; line: number }
  | { kind: 'unsupported'; reason: string; line: number };

/** Names the compiled script body already has, so a Pine variable cannot take them. */
const SANDBOX_NAMES: readonly string[] = [
  'indicator', 'input', 'plot', 'hist', 'fill', 'open', 'high', 'low', 'close', 'volume', 'time', 'hlc3',
  'size', 'barIndex', 'source', 'na', 'nz', 'add', 'sub', 'mul', 'div', 'abs', 'min', 'max', 'round', 'floor',
  'ceil', 'gt', 'lt', 'ge', 'le', 'eq', 'ne', 'and', 'or', 'not', 'iif', 'pow', 'sqrt', 'log', 'log10', 'exp',
  'sign', 'highest', 'lowest', 'change', 'pctChange', 'sum', 'average', 'stdev', 'sma', 'ema', 'rma', 'wma',
  'hma', 'vwma', 'bollinger', 'rsi', 'rsiSimple', 'macd', 'stochastic', 'stochasticLine', 'atr', 'trueRange',
  'vwap', 'delay', 'cci', 'mfi', 'adx', 'dmi', 'sar', 'obv', 'crossover', 'crossunder', 'persist', 'flowBuy',
  'flowSell', 'flowDelta', 'flowCvd', 'Math', 'Number', 'JSON', 'Date', 'Array', 'Object', 'Set', 'Map',
  'String', 'Boolean', 'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'Float64Array', 'console', 'NaN',
  'Infinity', 'undefined', 'null', 'true', 'false', 'arguments', 'length', 'name', 'prototype', '__bar',
  '__prev', 'class', 'const', 'let', 'var', 'function', 'return', 'if', 'else', 'new', 'this', 'typeof', 'in',
  'of', 'do', 'for', 'while', 'switch', 'case', 'default', 'break', 'continue', 'delete', 'void', 'instanceof',
  'try', 'catch', 'throw', 'async', 'await', 'yield', 'static', 'super', 'export', 'import',
];

/** Price sources the host can anchor a VWAP on, by the name Pine gives them. */
const PRICE_NAMES: Record<string, string> = {
  close: 'close',
  open: 'open',
  high: 'high',
  low: 'low',
  hlc3: 'hlc3',
  hl2: 'hl2',
  ohlc4: 'ohlc4',
  hlc4: 'hlcc4',
  hlcc4: 'hlcc4',
};

/** Bar fields the sandbox hands over as series. */
const PRICE_SERIES: Record<string, string> = {
  close: 'close',
  open: 'open',
  high: 'high',
  low: 'low',
  volume: 'volume',
  time: 'time',
  time_start: 'time',
  hlc3: 'hlc3',
  hl3: 'hlc3',
  bar_index: 'barIndex',
};

/** Colors the chart can draw, matching the names `sandbox.worker.ts` accepts. */
const COLOR_NAMES: readonly string[] = [
  'red', 'green', 'blue', 'orange', 'purple', 'white', 'yellow', 'gray', 'grey', 'cyan', 'magenta', 'lime',
  'teal', 'gold', 'silver', 'aqua', 'fuchsia', 'maroon', 'navy', 'olive', 'black',
];

/**
 * Builtins, keyed by the bare name: `ta.sma` and the v2/v3 spelling `sma` both land here.
 * `js` is the sandbox global to call; `special` marks a shape that needs more than a rename;
 * `refuses` carries the reason a familiar name is still unavailable.
 */
interface BuiltinSpec {
  js: string;
  /** Extra literal arguments the host builtin needs, appended at the end. */
  append?: string[];
  special?: 'vwma' | 'mfi' | 'extreme' | 'vwap' | 'macd' | 'dmi';
  refuses?: string;
}

const BUILTINS: Record<string, BuiltinSpec> = {
  sma: { js: 'sma' },
  ema: { js: 'ema' },
  rma: { js: 'rma' },
  wma: { js: 'wma' },
  hma: { js: 'hma' },
  vwma: { js: 'vwma', special: 'vwma' },
  atr: { js: 'atr', append: ["'RMA'"] },
  tr: { js: 'trueRange' },
  rsi: { js: 'rsi' },
  macd: { js: 'macd', special: 'macd' },
  stoch: { js: 'stochasticLine' },
  cci: { js: 'cci' },
  mfi: { js: 'mfi', special: 'mfi' },
  adx: { js: 'adx' },
  dmi: { js: 'dmi', special: 'dmi' },
  sar: { js: 'sar' },
  obv: { js: 'obv' },
  stdev: { js: 'stdev' },
  dev: { js: 'stdev' },
  highest: { js: 'highest', special: 'extreme' },
  lowest: { js: 'lowest', special: 'extreme' },
  crossover: { js: 'crossover' },
  crossunder: { js: 'crossunder' },
  cross: { js: 'crossover' },
  change: { js: 'change' },
  vwap: { js: 'vwap', special: 'vwap' },
  nz: { js: 'nz' },
  na: { js: 'na' },
  abs: { js: 'abs' },
  min: { js: 'min' },
  max: { js: 'max' },
  round: { js: 'round' },
  floor: { js: 'floor' },
  ceil: { js: 'ceil' },
  sqrt: { js: 'sqrt' },
  log: { js: 'log' },
  log10: { js: 'log10' },
  exp: { js: 'exp' },
  sign: { js: 'sign' },
  pow: { js: 'pow' },
  sum: { js: 'sum' },
  avg: { js: 'sma' },
  float: { js: 'float' },
  int: { js: 'int' },
  bool: { js: 'bool' },
  valuewhen: { js: '', refuses: 'ta.valuewhen' },
  barssince: { js: '', refuses: 'ta.barssince' },
  pivotlow: { js: '', refuses: 'ta.pivotlow' },
  pivothigh: { js: '', refuses: 'ta.pivothigh' },
  linreg: { js: '', refuses: 'ta.linreg' },
  cmo: { js: '', refuses: 'ta.cmo' },
  wpr: { js: '', refuses: 'ta.wpr' },
  percentrank: { js: '', refuses: 'ta.percentrank' },
  bbw: { js: '', refuses: 'ta.bbw' },
  median: { js: '', refuses: 'ta.median' },
  mode: { js: '', refuses: 'ta.mode' },
  variance: { js: '', refuses: 'ta.variance' },
  cum: { js: '', refuses: 'ta.cum' },
  swma: { js: '', refuses: 'ta.swma' },
  tema: { js: '', refuses: 'ta.tema' },
  correlation: { js: '', refuses: 'ta.correlation' },
  lowestbars: { js: '', refuses: 'ta.lowestbars' },
  highestbars: { js: '', refuses: 'ta.highestbars' },
  pvi: { js: '', refuses: 'ta.pvi' },
  nvi: { js: '', refuses: 'ta.nvi' },
  obi: { js: '', refuses: 'ta.obi' },
  kc: { js: '', refuses: 'ta.kc' },
  kdj: { js: '', refuses: 'ta.kdj' },
  hma_: { js: 'hma' },
};

/** Namespaces whose members mean something, so `ta.sma` can resolve to `sma`. */
const VALUE_NAMESPACES: readonly string[] = ['ta', 'math'];

/** Namespaces the converter refuses, with the phrase each error uses. */
const REFUSED_NAMESPACES: Record<string, string> = {
  strategy: 'a strategy (strategy.*)',
  request: 'a data request (request.*)',
  array: 'an array (array.*)',
  map: 'a map (map.*)',
  matrix: 'a matrix (matrix.*)',
  line: 'a drawn line (line.*)',
  box: 'a drawn box (box.*)',
  label: 'a drawn label (label.*)',
  table: 'a drawn table (table.*)',
  polyline: 'a drawn polyline (polyline.*)',
  str: 'a string operation (str.*)',
  chart: 'the chart itself (chart.*)',
  syminfo: 'symbol information (syminfo.*)',
  timeframe: 'a timeframe value (timeframe.*)',
  ticker: 'a ticker id (ticker.*)',
  enums: 'a Pine enum',
  graphics: 'a graphics primitive',
  barstate: 'bar state (barstate.*)',
};

/** Calls that draw or do something the script format has no room for. */
const REFUSED_CALLS: Record<string, string> = {
  plotshape: 'plotshape: markers have no equivalent here',
  plotchar: 'plotchar: markers have no equivalent here',
  plotarrow: 'plotarrow: markers have no equivalent here',
  alertcondition: 'alertcondition: alerts are not part of the script format',
  alert: 'alert: alerts are not part of the script format',
  fillgradient: 'fillgradient has no equivalent here',
  title: 'title belongs on the indicator declaration',
  newseries: 'newseries is not supported',
  barstate: 'bar state is not available here',
  strategy: 'a strategy (strategy.*) is not supported; only indicators convert',
};

/** Calls that only change how the chart looks: noted, then dropped. */
const DECORATION_CALLS: Record<string, string> = {
  bgcolor: 'bgcolor: the script format has no background color',
  barcolor: 'barcolor: the script format cannot recolor bars',
  setplotstyle: 'setplotstyle is not supported',
};

/** Options of `study`/`indicator` the chart has nowhere to put. */
const IGNORED_DECLARATION_OPTIONS: readonly string[] = [
  'shorttitle', 'format', 'formatopen', 'scale', 'max_bars_back', 'max_labels_count', 'max_lines_count',
  'max_boxes_count', 'max_polylines_count', 'precision', 'explicit_plot_zorder', 'force_overlay',
  'calc_on_order_fires', 'calc_on_every_tick', 'auto_authors', 'studio', 'magnitude', 'slim', 'is_overlay',
];

/** `input.*` kinds, and the ones this chart has no control for. */
const INPUT_KINDS: Record<string, { js: string; integral: boolean } | { refuses: string }> = {
  int: { js: 'int', integral: true },
  integer: { js: 'int', integral: true },
  float: { js: 'float', integral: false },
  number: { js: 'float', integral: false },
  double: { js: 'float', integral: false },
  bool: { js: 'bool', integral: false },
  boolean: { js: 'bool', integral: false },
  string: { js: 'select', integral: false },
  select: { js: 'select', integral: false },
  source: { js: 'source', integral: false },
  time: { refuses: 'input.time' },
  session: { refuses: 'input.session' },
  timeframe: { refuses: 'input.timeframe' },
  symbol: { refuses: 'input.symbol' },
  color: { refuses: 'input.color' },
  text: { refuses: 'input.text' },
  point: { refuses: 'input.point' },
  file: { refuses: 'input.file' },
  group: { refuses: 'input.group' },
  button: { refuses: 'input.button' },
  chat: { refuses: 'input.chat' },
  duration: { refuses: 'input.duration' },
  event: { refuses: 'input.event' },
};

/** Plot styles the chart can draw, those it draws as a plain line, and those it cannot. */
const PLOT_STYLES: Record<string, { kind: 'line' | 'histogram' } | { refuses: string } | { warns: string }> = {
  plot_style_line: { kind: 'line' },
  plot_style_linebr: { warns: 'linebr' },
  plot_style_stepline: { warns: 'stepline' },
  plot_style_histogram: { kind: 'histogram' },
  plot_style_columns: { kind: 'histogram' },
  plot_style_area: { warns: 'area' },
  plot_style_linearea: { warns: 'linearea' },
  plot_style_circles: { refuses: 'plot.style_circles' },
  plot_style_cross: { refuses: 'plot.style_cross' },
  plot_style_arrow: { refuses: 'plot.style_arrow' },
};

//** Calls that stand on their own line rather than producing a value. */
const STATEMENT_CALLS: readonly string[] = ['plot', 'hline', 'fill', 'study', 'indicator', 'strategy', 'bgcolor', 'barcolor', 'plotshape', 'plotchar', 'plotarrow', 'alertcondition', 'alert', 'fillgradient', 'title', 'newseries'];

/** Builtins that read a window of bars, so they must run once, outside a per-bar step. */
const WINDOW_BUILTINS = new Set([
  'sma', 'ema', 'rma', 'wma', 'hma', 'vwma', 'bollinger', 'rsi', 'rsiSimple', 'macd', 'stochastic',
  'stochasticLine', 'atr', 'cci', 'mfi', 'adx', 'dmi', 'sar', 'obv', 'stdev', 'highest', 'lowest', 'crossover',
  'crossunder', 'sum', 'average', 'vwap', 'delay', 'change', 'pctChange', 'trueRange',
]);

const INDICATOR_MAX_PLOTS = 12;

/** Runs the whole conversion for one Pine source. */
export function convertPine(source: string): PineConversion {
  return new Converter(source).run();
}

class Converter {
  private readonly errors: PineDiagnostic[] = [];
  private readonly warnings: PineDiagnostic[] = [];
  /** The emitted script, or the function body currently being captured. */
  private lines: string[] = [];
  private scope: { names: Map<string, NameInfo> } = { names: new Map() };
  private readonly taken = new Set<string>(SANDBOX_NAMES);
  private plots: { js: string; label: string }[] = [];
  private plotCounter = 0;
  private hoistCounter = 0;
  /** Whole-series constants hoisted out of the `persist` step being emitted. */
  private hoists: { js: string; text: string }[] | null = null;
  private levels: number[] = [];
  private name = 'Pine indicator';
  private placement: 'price' | 'pane' = 'pane';
  private precision: number | null = null;
  private priceUnits = false;
  private declared = false;
  private flat: Flat[] = [];
  private state = new Map<string, StatePlan>();
  /** Names assigned more than once, which need `let` rather than `const`. */
  private reassigned = new Set<string>();

  constructor(private readonly source: string) {}

  run(): PineConversion {
    let statements: Stmt[];
    try {
      statements = parse(tokenize(this.source));
    } catch (error: unknown) {
      const syntax = error instanceof PineSyntaxError;
      return {
        ok: false,
        source: '',
        name: this.name,
        placement: this.placement,
        plotLabels: [],
        errors: [{ line: syntax ? error.line : 1, message: syntax ? error.message : `could not read the script: ${String(error)}` }],
        warnings: [],
      };
    }

    this.readDeclaration(statements);
    this.flatten(statements);
    // The passes always run, so a script with one bad line still reports every other bad
    // line; the text they produce is dropped when anything failed.
    try {
      this.planFunctions();
      this.planState();
      this.emit();
    } catch (error: unknown) {
      this.fail(this.declared ? 1 : 1, `the converter could not finish reading the script: ${String(error)}`);
    }

    const clean = this.errors.length === 0;
    return {
      ok: clean,
      source: clean ? this.scriptText() : '',
      name: this.name,
      placement: this.placement,
      plotLabels: clean ? this.plots.map((plot) => plot.label) : [],
      errors: sortDiagnostics(this.errors),
      warnings: sortDiagnostics(this.warnings),
    };
  }

  /* ------------------------------------------------------------------ declaration */

  /** Reads the `study`/`indicator` line, since the emitted script has to start with it. */
  private readDeclaration(statements: readonly Stmt[]): void {
    for (const statement of statements) {
      if (statement.kind !== 'expression' || statement.expr.kind !== 'call') continue;
      const call = statement.expr;
      if (call.callee.kind !== 'ident') continue;
      const head = call.callee.name;
      if (head === 'strategy') {
        this.fail(statement.line, 'a strategy (strategy.*) is not supported; only indicators convert');
        continue;
      }
      if (head !== 'study' && head !== 'indicator') continue;
      if (this.declared) {
        this.fail(statement.line, 'only one study/indicator declaration is supported');
        continue;
      }
      this.declared = true;
      const args = namedArgs(call.args);

      const title = args.get('title') ?? positional(call.args, 0);
      if (title) {
        const text = literalString(title);
        if (text) this.name = text;
        else this.fail(title.line, 'the indicator title must be a text literal');
      }
      const overlay = args.get('overlay') ?? args.get('is_overlay');
      if (overlay) {
        const flag = literalNumber(overlay);
        if (flag === null) this.fail(overlay.line, '`overlay` must be true or false');
        else this.placement = flag === 0 ? 'pane' : 'price';
      }
      const precision = args.get('precision');
      if (precision) {
        const value = literalNumber(precision);
        if (value === null) this.fail(precision.line, '`precision` must be a number');
        else this.precision = Math.max(0, Math.min(8, Math.round(value)));
      }
      const format = args.get('format');
      if (format) {
        const name = memberName(format);
        if (name === 'format_mintick' || name === 'mintick') this.priceUnits = true;
        else this.note(statement.line, `format ${name ?? '?'} on the indicator declaration is ignored`);
      }
      for (const [key, value] of args) {
        if (IGNORED_DECLARATION_OPTIONS.includes(key) && key !== 'format') {
          this.note(value.line, `${key} on the indicator declaration is ignored`);
        }
      }
    }
    if (!this.declared) this.note(1, 'no study/indicator declaration: the script keeps its default name and plots in its own pane');
  }

  /* ------------------------------------------------------------------ flattening */

  /**
   * Turns the statement tree into one straight list.
   *
   * An `if`/`else if`/`else` chain that assigns one variable in every branch folds into a
   * ternary, which is exactly how a vectorised engine reads it. Any other block is a hard
   * error: a body that plots, or assigns two variables, would need per-bar control flow.
   */
  private flatten(statements: readonly Stmt[]): void {
    for (const statement of statements) {
      switch (statement.kind) {
        case 'assign': {
          if (statement.target.kind === 'tuple') {
            this.flattenTuple(statement.target, statement.expr);
            break;
          }
          if (statement.target.kind !== 'ident') {
            this.fail(statement.line, 'only a name may be assigned to');
            break;
          }
          this.flat.push({
            kind: 'assign',
            name: statement.target.name,
            expr: statement.expr,
            declared: statement.declared,
            variable: statement.variable,
            line: statement.line,
          });
          break;
        }
        case 'expression':
          this.flat.push({ kind: 'call', expr: statement.expr, line: statement.line });
          break;
        case 'function':
          this.flattenFunction(statement);
          break;
        case 'if': {
          const folded = this.foldIf(statement);
          if (folded) this.flat.push(folded);
          break;
        }
        case 'unsupported':
          this.fail(statement.line, `${statement.reason} is not supported`);
          this.flat.push({ kind: 'unsupported', reason: statement.reason, line: statement.line });
          break;
      }
    }
  }

  private flattenFunction(statement: Extract<Stmt, { kind: 'function' }>): void {
    const body: LocalAssign[] = [];
    for (const inner of statement.body) {
      if (inner.kind !== 'assign' || inner.target.kind !== 'ident') {
        this.fail(inner.line, `the function ${statement.name} may only assign its own local values`);
        return;
      }
      if (inner.variable) {
        this.fail(inner.line, '`var` inside a function is not supported');
        return;
      }
      body.push({ name: inner.target.name, expr: inner.expr, line: inner.line });
    }
    const returns = statement.returns;
    if (!returns) {
      this.fail(statement.line, `the function ${statement.name} has no return value`);
      return;
    }
    this.flat.push({
      kind: 'function',
      line: statement.line,
      plan: { name: statement.name, js: this.freshName(statement.name), params: statement.params, body, returns, line: statement.line },
    });
  }

  private foldIf(statement: Extract<Stmt, { kind: 'if' }>): Flat | null {
    const branches: { condition: Expr; value: Expr; line: number }[] = [];
    let fallback: Expr | null = null;
    let target: string | null = null;
    let broken = false;

    const walk = (node: Extract<Stmt, { kind: 'if' }>): void => {
      if (broken) return;
      const body = exactlyOneAssign(node.body);
      if (!body) {
        this.fail(node.line, 'an if block has to assign exactly one variable; blocks that plot, or assign several, need per-bar control flow');
        broken = true;
        return;
      }
      if (target && target !== body.name) {
        this.fail(node.line, `this branch assigns \`${body.name}\` but the chain assigns \`${target}\``);
        broken = true;
        return;
      }
      target = body.name;
      branches.push({ condition: node.condition, value: body.expr, line: node.line });

      const otherwise = node.otherwise;
      if (!otherwise) return;
      if (otherwise.length === 1 && otherwise[0]?.kind === 'if') {
        walk(otherwise[0]);
        return;
      }
      const elseBody = exactlyOneAssign(otherwise);
      if (!elseBody || (target && elseBody.name !== target)) {
        this.fail(node.line, 'the else block has to assign the same single variable as the if');
        broken = true;
        return;
      }
      fallback = elseBody.expr;
    };

    walk(statement);
    if (broken || !target) return null;

    // With no else, an unassigned branch keeps the value the variable already had.
    let value: Expr = fallback ?? { kind: 'ident', name: target, line: statement.line };
    for (let i = branches.length - 1; i >= 0; i -= 1) {
      const branch = branches[i];
      if (!branch) continue;
      value = { kind: 'ternary', condition: branch.condition, whenTrue: branch.value, whenFalse: value, line: branch.line };
    }
    return { kind: 'assign', name: target, expr: value, declared: false, variable: false, line: statement.line };
  }

  /** `[a, b, c] = ta.macd(...)`: the builtins the host returns as more than one series. */
  private flattenTuple(target: Extract<Expr, { kind: 'tuple' }>, expr: Expr): void {
    const call = expr.kind === 'call' ? expr : null;
    const key = call && call.callee.kind === 'member' ? memberKey(call.callee) : null;
    const outputs = key === 'macd' ? ['line', 'signal', 'hist'] : key === 'dmi' ? ['diPlus', 'diMinus', 'adx'] : null;
    if (!outputs || !call) {
      this.fail(expr.line, 'only ta.macd and ta.dmi return more than one series; other tuples are not supported');
      return;
    }
    const names: string[] = [];
    for (const item of target.items) {
      if (item.kind !== 'ident') {
        this.fail(item.line, 'a tuple slot must be a plain name');
        return;
      }
      names.push(item.name);
    }
    if (names.length !== outputs.length) {
      this.fail(expr.line, `ta.${key} returns ${outputs.length} series but ${names.length} names were given`);
      return;
    }
    this.flat.push({ kind: 'tuple', key: key as 'macd' | 'dmi', outputs, names, args: call.args, line: expr.line });
  }

  /* ------------------------------------------------------------------ planning */

  /** Declares the functions up front, so a script may call one before its line. */
  private planFunctions(): void {
    for (const statement of this.flat) {
      if (statement.kind !== 'function') continue;
      this.functionPlans.set(statement.plan.name, statement.plan);
      this.declare(statement.plan.name, { js: statement.plan.js, kind: 'function' });
    }
  }

  /**
   * Works out which statements update each `var`, and refuses what a single pass cannot
   * express: a var never updated, one read between two of its own updates, or two vars whose
   * updates interleave.
   */
  private planState(): void {
    const declarations = new Map<string, { index: number; init: Expr; line: number }>();
    for (let i = 0; i < this.flat.length; i += 1) {
      const statement = this.flat[i];
      if (statement?.kind !== 'assign') continue;
      if (!statement.variable) continue;
      if (declarations.has(statement.name)) {
        this.fail(statement.line, `\`${statement.name}\` is declared with var twice`);
        continue;
      }
      declarations.set(statement.name, { index: i, init: statement.expr, line: statement.line });
    }

    for (const [name, declaration] of declarations) {
      const updates: number[] = [];
      const bodies: Expr[] = [];
      const reads: number[] = [];
      for (let i = 0; i < this.flat.length; i += 1) {
        const statement = this.flat[i];
        if (!statement) continue;
        let used: string[] = [];
        if (statement.kind === 'assign') used = namesIn(statement.expr);
        else if (statement.kind === 'call' && statement.expr.kind === 'call') used = statement.expr.args.flatMap((arg) => namesIn(arg.expr));
        if (statement.kind === 'assign' && statement.name === name) {
          if (i !== declaration.index) {
            updates.push(i);
            bodies.push(statement.expr);
          }
          continue;
        }
        if (used.includes(name)) reads.push(i);
      }

      if (updates.length === 0) {
        this.fail(declaration.line, `\`${name}\` is declared with var but never updated; write \`${name} = ...\` for a value that follows the bars`);
        continue;
      }
      const first = updates[0] ?? 0;
      const last = updates[updates.length - 1] ?? 0;
      const early = reads.find((index) => index < first);
      if (early !== undefined) {
        this.fail(this.flat[early]?.line ?? declaration.line, `\`${name}\` is read before its first update; a var's series is only available once it has been updated`);
        continue;
      }
      const middle = reads.find((index) => index > first && index < last);
      if (middle !== undefined) {
        this.fail(this.flat[middle]?.line ?? declaration.line, `\`${name}\` is read between two of its own updates, which needs per-bar order the engine does not have`);
        continue;
      }
      this.state.set(name, { name, js: this.freshName(name), init: declaration.init, declIndex: declaration.index, updates, bodies, line: declaration.line });
    }

    // Two vars whose updates overlap cannot each get an uninterrupted run over the bars.
    const plans = [...this.state.values()];
    for (let a = 0; a < plans.length; a += 1) {
      for (let b = a + 1; b < plans.length; b += 1) {
        const left = plans[a];
        const right = plans[b];
        if (!left || !right) continue;
        const aStart = left.updates[0] ?? 0;
        const aEnd = left.updates[left.updates.length - 1] ?? 0;
        const bStart = right.updates[0] ?? 0;
        const bEnd = right.updates[right.updates.length - 1] ?? 0;
        if (aStart <= bEnd && bStart <= aEnd) {
          this.fail(right.line, `\`${left.name}\` and \`${right.name}\` update in interleaved order; each var needs its own uninterrupted run of updates`);
        }
      }
    }
  }

  /* ------------------------------------------------------------------ emission */

  private emit(): void {
    for (let i = 0; i < this.flat.length; i += 1) {
      const statement = this.flat[i];
      if (statement?.kind === 'assign') {
        if (!this.reassigned.has(statement.name)) {
          let later = false;
          for (let k = i + 1; k < this.flat.length; k += 1) {
            const next = this.flat[k];
            if (next?.kind === 'assign' && next.name === statement.name) later = true;
          }
          if (later) this.reassigned.add(statement.name);
        }
      }
    }

    /** Where each var's `persist` pass goes: just after its last update. */
    const loops = new Map<number, StatePlan[]>();
    for (const plan of this.state.values()) {
      const at = plan.updates[plan.updates.length - 1] ?? plan.declIndex;
      loops.set(at, [...(loops.get(at) ?? []), plan]);
    }
    const declarations = new Set<number>();
    for (const plan of this.state.values()) declarations.add(plan.declIndex);
    const updates = new Set<number>();
    for (const plan of this.state.values()) for (const index of plan.updates) updates.add(index);

    for (let i = 0; i < this.flat.length; i += 1) {
      const statement = this.flat[i];
      if (!statement) continue;

      if (declarations.has(i)) {
        const plan = [...this.state.values()].find((entry) => entry.declIndex === i);
        if (plan) this.declare(plan.name, { js: plan.js, kind: 'state' });
        continue;
      }

      if (!(updates.has(i) && statement.kind === 'assign')) {
        switch (statement.kind) {
          case 'assign':
            this.emitAssign(statement);
            break;
          case 'call':
            this.emitCallStatement(statement.expr, statement.line);
            break;
          case 'tuple':
            this.emitTuple(statement);
            break;
          case 'function':
            this.emitFunction(statement.plan);
            break;
          case 'unsupported':
            break;
        }
      }

      for (const plan of loops.get(i) ?? []) this.emitLoop(plan);
    }
  }

  /** One `persist` pass: hoisted whole series, then the per-bar step. */
  private emitLoop(plan: StatePlan): void {
    this.hoists = [];
    const bodies = plan.bodies.map((body) => this.expr(body, plan.name) ?? 'NaN');
    const init = this.initOf(plan);
    const hoists = this.hoists;
    this.hoists = null;

    for (const entry of hoists) this.push(`const ${entry.js} = ${entry.text};`);
    this.push(`// Pine \`var ${plan.name}\`: one update per bar, each seeing the last bar's value.`);
    this.push(`const ${plan.js} = persist(${init}, (__bar, ${plan.js}) => {`);
    for (const body of bodies) this.push(`  ${plan.js} = ${body};`);
    this.push(`  return ${plan.js};`);
    this.push('});');
  }

  /** The value a `var` starts bar 0 with: a literal, a parameter, or bar 0 of a series. */
  private initOf(plan: StatePlan): string {
    const init = plan.init;
    if (init.kind === 'number') return literal(init.value);
    if (init.kind === 'ident') {
      const info = this.lookup(init.name);
      if (info?.kind === 'scalar') return info.js;
    }
    const text = this.expr(init, null);
    if (text === null) return 'Number.NaN';
    return `${this.addHoist(text)}[0]`;
  }

  private emitTuple(statement: Extract<Flat, { kind: 'tuple' }>): void {
    const holder = this.freshName(`pine${statement.key}`);
    const call = this.callText(statement.key, statement.args, statement.line, null);
    if (call === null) return;
    this.push(`const ${holder} = ${call};`);
    statement.names.forEach((name, index) => {
      const js = this.freshName(name);
      this.push(`const ${js} = ${holder}.${statement.outputs[index] ?? ''};`);
      this.declare(name, { js, kind: 'series' });
    });
  }

  private emitFunction(plan: FunctionPlan): void {
    const outer = this.scope;
    for (const statement of plan.body) {
      if (outer.names.has(statement.name)) {
        this.fail(statement.line, `the function ${plan.name} assigns \`${statement.name}\`, which belongs outside it; functions with side effects are not supported`);
        return;
      }
    }
    const body = this.lines;
    this.lines = [];
    this.scope = { names: new Map(outer.names).set(plan.name, { js: plan.js, kind: 'function' }) };
    // Parameters are named in the same scope the body reads, so the arrow's parameter list
    // and the body's references cannot drift apart.
    const params = plan.params.map((param) => {
      const js = this.jsNameOf(param.name);
      this.declare(param.name, { js, kind: 'series' });
      const fallback = param.defaultValue ? this.expr(param.defaultValue, null) : null;
      return fallback ? `${js} = ${fallback}` : js;
    });
    for (const statement of plan.body) {
      this.emitAssign({ kind: 'assign', name: statement.name, expr: statement.expr, declared: true, variable: false, line: statement.line });
    }
    const returned = this.expr(plan.returns, null) ?? 'Number.NaN';
    const captured = this.lines;
    this.lines = body;
    this.scope = outer;

    this.push(`// Pine function ${plan.name}: element-wise, so it reads and returns whole series.`);
    this.push(`const ${plan.js} = (${params.join(', ')}) => {`);
    for (const line of captured) this.push(`  ${line}`);
    this.push(`  return ${returned};`);
    this.push('};');
  }

  private emitAssign(statement: Extract<Flat, { kind: 'assign' }>): void {
    const call = statement.expr.kind === 'call' ? statement.expr : null;
    const key = call ? this.builtinKey(call.callee) : null;

    if (call && (key === 'input' || key?.startsWith('input.'))) {
      this.emitInput(statement, call);
      return;
    }
    if (call && (key === 'plot' || key === 'hline' || key === 'fill')) {
      if (key === 'plot') this.emitPlot(statement.name, call);
      else if (key === 'hline') this.emitHline(call);
      else this.emitFill(call);
      if (key === 'plot') return;
      // `x = hline(...)` and `x = fill(...)` draw nothing on their own.
      const js = this.freshName(statement.name);
      this.push(`const ${js} = null;`);
      this.declare(statement.name, { js, kind: 'scalar' });
      return;
    }

    const text = this.expr(statement.expr, null);
    if (text === null) return;
    const js = this.jsNameOf(statement.name);
    const kind = this.valueKind(statement.expr);
    const known = this.lookup(statement.name);
    if (known && !this.scopeIsFresh(statement.name)) {
      this.push(`${js} = ${text};`);
      this.declare(statement.name, { ...known, kind, color: kind === 'color' ? this.colorOf(statement.expr) ?? known.color : known.color });
      return;
    }
    this.push(`${this.reassigned.has(statement.name) ? 'let' : 'const'} ${js} = ${text};`);
    this.declare(statement.name, {
      js,
      kind,
      color: kind === 'color' ? this.colorOf(statement.expr) ?? undefined : undefined,
      priceName: this.priceNameOf(statement.expr),
    });
  }

  /** Whether this name has already been given a value in the current scope. */
  private scopeIsFresh(name: string): boolean {
    return !this.scope.names.has(name);
  }

  /** Whether an assigned value is one value per bar, one value for the script, or a color. */
  private valueKind(expr: Expr): NameInfo['kind'] {
    if (expr.kind === 'number') return 'scalar';
    if (expr.kind === 'string') return 'color';
    if (expr.kind === 'member') {
      const name = memberName(expr);
      return memberRoot(expr)?.kind === 'ident' && (expr.object as Expr).kind === 'ident' && name && COLOR_NAMES.includes(name.toLowerCase()) ? 'color' : 'series';
    }
    if (expr.kind === 'call') {
      const key = this.builtinKey(expr.callee) ?? '';
      if (key === 'input.int' || key === 'input.float' || key === 'input.bool' || key === 'input') return 'scalar';
      if (key.startsWith('color.')) return 'color';
      if (key === 'sar') return 'series';
      return 'series';
    }
    if (expr.kind === 'ident') return this.lookup(expr.name)?.kind ?? 'series';
    return 'series';
  }

  /** The price name an expression stands for, so `ta.vwap(src)` can anchor on it. */
  private priceNameOf(expr: Expr): string | undefined {
    if (expr.kind === 'ident') return PRICE_NAMES[expr.name];
    if (expr.kind === 'member') return PRICE_NAMES[memberName(expr) ?? ''];
    if (expr.kind === 'call' && this.builtinKey(expr.callee) === 'input.source') {
      const arg = positional(expr.args, 0);
      const name = arg?.kind === 'ident' ? arg.name : arg?.kind === 'member' ? memberName(arg) : null;
      return name ? PRICE_NAMES[name] : undefined;
    }
    return undefined;
  }

  /* ------------------------------------------------------------------ inputs */

  private emitInput(statement: Extract<Flat, { kind: 'assign' }>, call: Extract<Expr, { kind: 'call' }>): void {
    const key = this.builtinKey(call.callee) ?? 'input';
    const kindName = key === 'input' ? this.legacyInputKind(call.args, call.line) : key.slice('input.'.length);
    const spec = INPUT_KINDS[kindName] ?? { refuses: `input.${kindName}` };
    if ('refuses' in spec) {
      this.fail(call.line, `${spec.refuses} has no control on this chart`);
      return;
    }

    const args = namedArgs(call.args);
    const legacy = key === 'input';
    const fallback = args.get('defval') ?? positional(call.args, 0) ?? null;
    const titleNode = args.get('title') ?? args.get('label') ?? positional(call.args, 1) ?? null;
    const label = titleNode ? literalString(titleNode) : null;
    if (titleNode && label === null) this.fail(titleNode.line, 'an input title must be a text literal');

    const options: string[] = [];
    if (label) options.push(`label: '${escapeText(label)}'`);
    const numeric = spec.js === 'int' || spec.js === 'float';
    const min = numberOption(args, 'minval') ?? (legacy && numeric ? numberAt(call.args, 2) : undefined);
    const max = numberOption(args, 'maxval') ?? (legacy && numeric ? numberAt(call.args, 3) : undefined);
    const step = numberOption(args, 'step') ?? (legacy && numeric ? numberAt(call.args, 4) : undefined);
    if (min !== undefined) options.push(`min: ${literal(min)}`);
    if (max !== undefined) options.push(`max: ${literal(max)}`);
    if (step !== undefined && numeric) options.push(`step: ${literal(step)}`);
    for (const ignored of ['group', 'tooltip', 'inline', 'documentation', 'confirm', 'id', 'timeframe', 'timeframe_option', 'close_prev', 'linkto', 'defval_title', 'autogroup', 'display']) {
      const node = args.get(ignored);
      if (node) this.note(node.line, `${ignored} on input \`${statement.name}\` is ignored`);
    }

    const js = this.freshName(statement.name);
    const tail = options.length > 0 ? `, { ${options.join(', ')} }` : '';

    if (spec.js === 'source') {
      const sourceName = this.sourceNameOfInput(fallback, call.line);
      if (!sourceName) return;
      this.push(`const ${js} = input.source('${sourceName}'${tail});`);
      this.declare(statement.name, { js, kind: 'series', priceName: sourceName });
      return;
    }

    if (spec.js === 'select') {
      const list = stringList(args.get('options') ?? positional(call.args, 2));
      if (!list) {
        this.fail(call.line, 'input.string needs a list of text options');
        return;
      }
      const value = (fallback ? literalString(fallback) : null) ?? list[0] ?? '';
      options.push(`options: [${list.map((entry) => `'${escapeText(entry)}'`).join(', ')}]`);
      this.push(`const ${js} = input.select('${escapeText(value)}', { ${options.join(', ')} });`);
      this.declare(statement.name, { js, kind: 'scalar' });
      return;
    }

    if (spec.js === 'bool') {
      this.push(`const ${js} = input.bool(${literalBoolean(fallback) ? 'true' : 'false'}${tail});`);
      this.declare(statement.name, { js, kind: 'scalar' });
      return;
    }

    const fallbackNumber = literalNumber(fallback);
    if (fallback === null || fallbackNumber === null) {
      this.fail(fallback?.line ?? call.line, `input.${spec.js} needs a number as its default value`);
      return;
    }
    const value = spec.integral ? Math.round(fallbackNumber) : fallbackNumber;
    this.push(`const ${js} = input.${spec.js}(${literal(value)}${tail});`);
    this.declare(statement.name, { js, kind: 'scalar' });
  }

  /** The v2/v3 `input(defval, title, min, max, step)`, whose type comes from its default. */
  private legacyInputKind(args: readonly CallArgument[], line: number): string {
    const type = namedArgs(args).get('type');
    const explicit = type ? memberName(type) ?? (type.kind === 'string' ? type.value : null) : null;
    if (explicit) {
      const cleaned = explicit.replace(/^input[._]/, '');
      if (INPUT_KINDS[cleaned]) return cleaned;
      this.fail(line, `input type \`${explicit}\` has no control on this chart`);
      return 'int';
    }
    const fallback = positional(args, 0);
    if (!fallback) return 'int';
    if (fallback.kind === 'number') return Number.isInteger(fallback.value) ? 'int' : 'float';
    if (fallback.kind === 'string') return 'select';
    if (fallback.kind === 'ident' && PRICE_NAMES[fallback.name] && ['close', 'open', 'high', 'low', 'hlc3'].includes(fallback.name)) return 'source';
    const step = numberAt(args, 4);
    if (step !== undefined && !Number.isInteger(step)) return 'float';
    return 'int';
  }

  private sourceNameOfInput(node: Expr | null, line: number): string | null {
    const name = node?.kind === 'ident' ? node.name : node?.kind === 'member' ? memberName(node) : null;
    if (!name) {
      this.fail(line, 'input.source needs a price source such as close, open, high, low or hlc3');
      return null;
    }
    const mapped = ['close', 'open', 'high', 'low', 'hlc3'].includes(name) ? PRICE_NAMES[name] : undefined;
    if (!mapped) {
      this.fail(line, `input.source(${name}) is not a source this chart offers; use open, high, low, close or hlc3`);
      return null;
    }
    return mapped;
  }

  /* ------------------------------------------------------------------ plots */

  private emitPlot(target: string | null, call: Extract<Expr, { kind: 'call' }>): void {
    const args = namedArgs(call.args);
    const series = args.get('series') ?? positional(call.args, 0);
    if (!series) {
      this.fail(call.line, 'plot needs a series to draw');
      return;
    }
    if (this.plots.length >= INDICATOR_MAX_PLOTS) {
      this.fail(call.line, `a script may plot at most ${INDICATOR_MAX_PLOTS} series`);
      return;
    }

    const titleNode = args.get('title') ?? positional(call.args, 1);
    const given = titleNode ? literalString(titleNode) : null;
    if (titleNode && given === null) this.fail(titleNode.line, 'a plot title must be a text literal');
    const label = this.uniqueLabel(given ?? target ?? `Pine plot ${this.plots.length + 1}`, call.line);

    const color = this.colorOf(args.get('color') ?? positional(call.args, 2) ?? null);
    const widthNode = args.get('linewidth') ?? args.get('width') ?? positional(call.args, 3);
    const width = widthNode ? literalNumber(widthNode) : null;
    if (widthNode && width === null) this.fail(widthNode.line, 'a plot line width must be a number');

    let kind: 'line' | 'histogram' = 'line';
    const styleNode = args.get('style') ?? positional(call.args, 4);
    if (styleNode) {
      const style = styleNode.kind === 'member' ? dottedName(styleNode) : literalString(styleNode);
      const mapped = style ? PLOT_STYLES[style.replace(/[.-]/g, '_')] : undefined;
      if (!mapped) this.fail(styleNode.line, `plot style \`${style ?? '?'}\` is not supported`);
      else if ('refuses' in mapped) this.fail(styleNode.line, `${mapped.refuses} has no equivalent here`);
      else if ('warns' in mapped) this.note(styleNode.line, `plot style ${mapped.warns} draws as a plain line`);
      else kind = mapped.kind;
    }

    for (const ignored of ['offset', 'trackprice', 'join', 'editable', 'show_last', 'display', 'autoline', 'isstatus', 'figure']) {
      const node = args.get(ignored);
      if (!node) continue;
      if (ignored === 'offset' && literalNumber(node) === 0) continue;
      this.note(node.line, `offset on plot \`${label}\` is ignored; the series draws at its own bar`.replace('offset on', `${ignored} on`));
    }

    const options: string[] = [];
    if (color) options.push(`color: '${color}'`);
    if (width !== null) options.push(`width: ${literal(Math.max(1, Math.min(8, Math.round(width))))}`);
    const text = this.expr(series, null);
    if (text === null) return;

    const js = this.freshName(`plot${(this.plotCounter += 1)}`);
    this.push(`const ${js} = ${kind === 'histogram' ? 'hist' : 'plot'}('${escapeText(label)}', ${text}${options.length > 0 ? `, { ${options.join(', ')} }` : ''});`);
    this.plots.push({ js, label });
    if (target) this.declare(target, { js, kind: 'plot', label });
  }

  private uniqueLabel(label: string, line: number): string {
    let candidate = label;
    let suffix = 2;
    while (this.plots.some((plot) => plot.label === candidate)) {
      candidate = `${label} ${suffix}`;
      suffix += 1;
    }
    if (candidate !== label) this.note(line, `a plot already used the name \`${label}\`, so this one is \`${candidate}\``);
    return candidate;
  }

  /** A plot color, or null to let the chart choose. */
  private colorOf(node: Expr | null): string | null {
    if (!node) return null;
    if (node.kind === 'string') return node.value.trim();
    if (node.kind === 'ident') {
      const info = this.lookup(node.name);
      if (info?.kind === 'color' && info.color) return info.color;
      this.fail(node.line, `plot color \`${node.name}\` must be a color literal`);
      return null;
    }
    if (node.kind === 'member') {
      const name = memberName(node);
      const root = memberRoot(node);
      if (root?.kind === 'ident' && root.name === 'color' && name) {
        if (name === 'na') {
          this.note(node.line, 'color.na draws in the chart default color');
          return null;
        }
        const lower = name.toLowerCase();
        if (COLOR_NAMES.includes(lower)) return lower;
        this.fail(node.line, `color.${name} is not a color this chart draws`);
        return null;
      }
      const info = this.lookup(node.name ?? '');
      if (info?.kind === 'color' && info.color) return info.color;
    }
    if (node.kind === 'call') {
      const key = this.builtinKey(node.callee);
      if (key === 'color.new') {
        const inner = this.colorOf(positional(node.args, 0));
        const transparency = literalNumber(positional(node.args, 1));
        if (transparency && transparency !== 0) this.note(node.line, 'color transparency is ignored; the chart sets the strength of its own fills');
        return inner;
      }
      if (key === 'color.rgb') {
        const parts = node.args.slice(0, 3).map((arg) => literalNumber(arg.expr));
        if (parts.length === 3 && parts.every((part) => part !== null)) {
          const hex = (parts as number[]).map((part) => Math.max(0, Math.min(255, Math.round(part))).toString(16).padStart(2, '0')).join('');
          return `#${hex}`;
        }
        this.fail(node.line, 'color.rgb needs three numbers');
        return null;
      }
    }
    this.fail(node.line, 'a plot color must be a color literal such as color.red or "#ff8800"');
    return null;
  }

  private emitHline(call: Extract<Expr, { kind: 'call' }>): void {
    const level = literalNumber(positional(call.args, 0) ?? null);
    if (level === null) {
      this.fail(call.line, 'hline needs a number as its level');
      return;
    }
    if (!this.levels.includes(level)) this.levels.push(level);
    const args = namedArgs(call.args);
    for (const ignored of ['color', 'linestyle', 'linewidth', 'editable', 'show_last', 'display']) {
      const node = args.get(ignored);
      if (node) this.note(node.line, `hline ${ignored} is ignored; the chart draws its guides the same way`);
    }
  }

  private emitFill(call: Extract<Expr, { kind: 'call' }>): void {
    const resolve = (node: Expr | null | undefined): string | null => {
      if (!node) {
        this.fail(call.line, 'fill takes the two plots to shade between');
        return null;
      }
      if (node.kind !== 'ident') {
        this.fail(node.line, 'fill takes the names the plots were given');
        return null;
      }
      const info = this.lookup(node.name);
      if (info?.kind === 'plot') return info.js;
      this.fail(node.line, `\`${node.name}\` was never plotted, so nothing can be filled to it`);
      return null;
    };
    const up = resolve(positional(call.args, 0));
    const down = resolve(positional(call.args, 1));
    if (!up || !down) return;
    const color = this.colorOf(namedArgs(call.args).get('color') ?? positional(call.args, 2));
    this.push(`fill(${up}, ${down}${color ? `, { color: '${color}' }` : ''});`);
  }

  /* ------------------------------------------------------------------ statements that are calls */

  private emitCallStatement(expr: Expr, line: number): void {
    if (expr.kind !== 'call') {
      this.fail(line, 'a statement here must be an assignment or a call');
      return;
    }
    const key = this.builtinKey(expr.callee);
    if (key === 'hline') {
      this.emitHline(expr);
      return;
    }
    if (key === 'fill') {
      this.emitFill(expr);
      return;
    }
    if (key === 'plot') {
      this.emitPlot(null, expr);
      return;
    }
    if (key === 'study' || key === 'indicator') return;
    if (key && DECORATION_CALLS[key]) {
      this.note(line, DECORATION_CALLS[key]);
      return;
    }
    if (key && REFUSED_CALLS[key]) {
      this.fail(line, REFUSED_CALLS[key]);
      return;
    }
    const rootName = expr.callee.kind === 'member' ? memberRoot(expr.callee) : null;
    const root = rootName && rootName.kind === 'ident' ? rootName.name : null;
    if (root && REFUSED_NAMESPACES[root]) {
      this.fail(line, `${REFUSED_NAMESPACES[root]} is not supported`);
      return;
    }
    if (key) {
      this.fail(line, `\`${key}\` was called but its value is not used`);
      return;
    }
    this.fail(line, 'this statement draws nothing and changes nothing');
  }

  /* ------------------------------------------------------------------ expressions */

  /**
   * Renders one expression. `stateOwner` is the var name while rendering inside a `persist`
   * step, and null in whole-series mode. Null comes back once the expression has failed.
   */
  private expr(node: Expr, stateOwner: string | null): string | null {
    if (stateOwner) {
      const plan = this.state.get(stateOwner);
      if (plan && this.needsHoist(node, plan)) {
        const text = this.expr(node, null);
        if (text === null) return null;
        return `${this.addHoist(text)}[__bar]`;
      }
    }

    switch (node.kind) {
      case 'number':
        return literal(node.value);
      case 'string':
        return `'${escapeText(node.value)}'`;
      case 'ident':
        return this.identifier(node, stateOwner);
      case 'member':
        return this.member(node, stateOwner);
      case 'call':
        return this.call(node, stateOwner);
      case 'index':
        return this.history(node, stateOwner);
      case 'binary':
        return this.binary(node, stateOwner);
      case 'unary':
        return this.unary(node, stateOwner);
      case 'ternary': {
        const condition = this.expr(node.condition, stateOwner);
        const whenTrue = this.expr(node.whenTrue, stateOwner);
        const whenFalse = this.expr(node.whenFalse, stateOwner);
        if (condition === null || whenTrue === null || whenFalse === null) return null;
        return `iif(${condition}, ${whenTrue}, ${whenFalse})`;
      }
      case 'tuple':
        this.fail(node.line, 'a tuple value is not supported');
        return null;
    }
  }

  /**
   * Whether a subtree of a `var` update has to be evaluated once for the whole series: it
   * reads a series, and it does not read the var it belongs to.
   */
  private needsHoist(node: Expr, plan: StatePlan): boolean {
    if (node.kind === 'number' || node.kind === 'string') return false;
    const names = namesIn(node);
    if (names.includes(plan.name)) return false;
    let series = false;
    eachNode(node, (child) => {
      if (child.kind === 'ident') {
        const info = this.lookup(child.name);
        if (info && (info.kind === 'series' || info.kind === 'state' || info.kind === 'plot')) series = true;
        if (PRICE_SERIES[child.name]) series = true;
      }
      if (child.kind === 'index') series = true;
      if (child.kind === 'call') {
        const key = this.builtinKey(child.callee);
        if (key && WINDOW_BUILTINS.has(key)) series = true;
        if (child.callee.kind === 'ident' && this.lookup(child.callee.name)?.kind === 'function') series = true;
      }
    });
    return series;
  }

  private addHoist(text: string): string {
    const found = this.hoists?.find((entry) => entry.text === text);
    if (found) return found.js;
    const js = `_p${(this.hoistCounter += 1)}`;
    this.hoists?.push({ js, text });
    return js;
  }

  private identifier(node: Extract<Expr, { kind: 'ident' }>, stateOwner: string | null): string | null {
    const info = this.lookup(node.name);
    if (info) {
      if (info.kind === 'color') {
        this.fail(node.line, `\`${node.name}\` holds a color, not a value`);
        return null;
      }
      if (info.kind === 'plot') {
        this.fail(node.line, `\`${node.name}\` is a plot handle; it can only be given to fill`);
        return null;
      }
      if (!stateOwner) return info.js;
      if (info.kind === 'state') return info.js;
      if (info.kind === 'series') return `${info.js}[__bar]`;
      return info.js;
    }
    const builtin = PRICE_SERIES[node.name];
    if (builtin) return stateOwner ? `${builtin}[__bar]` : builtin;
    if (node.name === 'hl2') return stateOwner ? 'div(add(high[__bar], low[__bar]), 2)' : 'div(add(high, low), 2)';
    if (node.name === 'ohlc4') {
      return stateOwner
        ? 'div(add(add(add(open[__bar], high[__bar]), low[__bar]), close[__bar]), 4)'
        : 'div(add(add(add(open, high), low), close), 4)';
    }
    if (node.name === 'time_close') {
      this.fail(node.line, 'time_close is not available; `time` is the bar start');
      return null;
    }
    if (node.name === 'timenow') {
      this.fail(node.line, 'timenow reads the clock, which a converted script cannot do');
      return null;
    }
    if (node.name === 'numpoints' || node.name === 'trades') {
      this.fail(node.line, `${node.name} is not available on these bars`);
      return null;
    }
    this.fail(node.line, `\`${node.name}\` is not defined`);
    return null;
  }

  private member(node: Extract<Expr, { kind: 'member' }>, stateOwner: string | null): string | null {
    const root = memberRoot(node);
    const rootName = root && root.kind === 'ident' ? root.name : null;
    const name = memberName(node) ?? '';

    if (rootName && REFUSED_NAMESPACES[rootName]) {
      this.fail(node.line, `${REFUSED_NAMESPACES[rootName]} is not supported`);
      return null;
    }
    if (rootName === 'color') {
      const color = this.colorOf(node);
      return color ? `'${color}'` : null;
    }
    if (rootName === 'plot') {
      this.fail(node.line, `\`plot.${name}\` is only usable as a plot style`);
      return null;
    }
    if (rootName === 'input') {
      this.fail(node.line, `input.${name} must be assigned to a name to become a parameter`);
      return null;
    }
    if (rootName && VALUE_NAMESPACES.includes(rootName)) {
      const spec = BUILTINS[name];
      if (spec?.refuses) {
        this.fail(node.line, `${spec.refuses} is not implemented`);
        return null;
      }
      if (!spec) {
        this.fail(node.line, `\`${rootName}.${name}\` is not implemented`);
        return null;
      }
      // A builtin named without its arguments, e.g. bare `ta.vwap` or `ta.obv`.
      const text = this.callText(name, [], node.line, stateOwner);
      if (text !== null) return text;
      this.fail(node.line, `\`${rootName}.${name}\` needs arguments`);
      return null;
    }
    if (rootName) {
      this.fail(node.line, `\`${rootName}.${name}\` is not part of the supported subset`);
      return null;
    }
    this.fail(node.line, 'this value is not available here');
    return null;
  }

  private call(node: Extract<Expr, { kind: 'call' }>, stateOwner: string | null): string | null {
    const key = this.builtinKey(node.callee);
    const root = node.callee.kind === 'member' ? memberRoot(node.callee) : null;
    const rootName = root && root.kind === 'ident' ? root.name : null;

    if (rootName && REFUSED_NAMESPACES[rootName]) {
      this.fail(node.line, `${REFUSED_NAMESPACES[rootName]} is not supported`);
      return null;
    }
    if (key && REFUSED_CALLS[key]) {
      this.fail(node.line, REFUSED_CALLS[key]);
      return null;
    }
    if (key === 'input' || key?.startsWith('input.')) {
      this.fail(node.line, `${key} must be assigned to a name to become a parameter`);
      return null;
    }
    if (key === 'color.new' || key === 'color.rgb') {
      const color = this.colorOf(node);
      return color ? `'${color}'` : null;
    }
    if (key && DECORATION_CALLS[key]) {
      this.fail(node.line, `${DECORATION_CALLS[key]}, so its value cannot be used`);
      return null;
    }
    if (key === 'hline' || key === 'fill') {
      this.fail(node.line, `${key} has to stand on its own line`);
      return null;
    }
    if (key === 'plot') {
      this.fail(node.line, 'plot has to be assigned to a name or stand on its own line');
      return null;
    }
    if (key === 'study' || key === 'indicator') {
      this.fail(node.line, 'the indicator declaration has to stand on its own line');
      return null;
    }

    if (node.callee.kind === 'ident') {
      const plan = this.functions().get(node.callee.name);
      if (plan) {
        const args = node.args.map((arg) => this.expr(arg.expr, stateOwner));
        if (args.some((arg) => arg === null)) return null;
        return `${plan.js}(${args.join(', ')})`;
      }
      if (!key) {
        this.fail(node.line, `\`${node.callee.name}\` is not a function this converter knows`);
        return null;
      }
    }

    const spec = key ? BUILTINS[key] : null;
    if (spec?.refuses) {
      this.fail(node.line, `${spec.refuses} is not implemented`);
      return null;
    }
    if (!spec) {
      this.fail(node.line, 'this call is not part of the supported subset');
      return null;
    }
    return this.callText(key ?? '', node.args, node.line, stateOwner);
  }

  /** Builds a builtin call, adding or moving the arguments the host builtin wants. */
  private callText(key: string, args: readonly CallArgument[], line: number, stateOwner: string | null): string | null {
    const spec = BUILTINS[key];
    if (!spec) return null;
    const values = args.map((arg) => this.expr(arg.expr, stateOwner));
    if (values.some((value) => value === null)) return null;
    let list = values as string[];

    switch (spec.special) {
      case 'vwma':
        // Pine's ta.vwma takes volume implicitly; the host builtin wants it named.
        list = [list[0] ?? 'close', stateOwner ? 'volume[__bar]' : 'volume', list[1] ?? '20'];
        break;
      case 'mfi':
        this.note(line, 'ta.mfi computes from typical price and volume, as TradingView does, so its source argument is not used');
        list = [list[1] ?? list[0] ?? '14'];
        break;
      case 'extreme':
        if (list.length === 1) list = ['close', list[0] ?? '1'];
        break;
      case 'vwap':
        return this.vwapCall(args, line);
      case 'macd':
      case 'dmi':
        break;
    }

    const extra = spec.append ?? [];
    const parts = list.filter((value) => value !== '');
    if (parts.length === 0 && extra.length === 0) {
      this.fail(line, `\`${key}\` needs arguments`);
      return null;
    }
    return `${spec.js}(${[...parts, ...extra].join(', ')})`;
  }

  /**
   * `ta.vwap(source)`: Pine accumulates the volume-weighted price; this chart anchors the
   * same sum to the UTC day, which is what the built-in VWAP it replaces does.
   */
  private vwapCall(args: readonly CallArgument[], line: number): string | null {
    const source = positional(args, 0);
    if (!source) return "vwap('day', 'hlc3')";
    const name =
      source.kind === 'ident'
        ? this.lookup(source.name)?.priceName ?? PRICE_NAMES[source.name]
        : source.kind === 'member'
          ? PRICE_NAMES[memberName(source) ?? '']
          : undefined;
    if (!name) {
      this.fail(line, 'ta.vwap needs a source the host can anchor on: close, open, high, low, hl2, hlc3 or ohlc4');
      return null;
    }
    this.note(line, 'ta.vwap is anchored to the UTC day, matching the built-in VWAP this script reproduces');
    return `vwap('day', '${name}')`;
  }

  private binary(node: Extract<Expr, { kind: 'binary' }>, stateOwner: string | null): string | null {
    const fn: Record<string, string> = {
      '+': 'add',
      '-': 'sub',
      '*': 'mul',
      '/': 'div',
      '^': 'pow',
      '**': 'pow',
      '==': 'eq',
      '!=': 'ne',
      '<>': 'ne',
      '>': 'gt',
      '<': 'lt',
      '>=': 'ge',
      '<=': 'le',
      and: 'and',
      or: 'or',
    };
    const name = fn[node.op];
    if (!name) {
      this.fail(node.line, `the \`${node.op}\` operator is not supported`);
      return null;
    }
    const left = this.expr(node.left, stateOwner);
    const right = this.expr(node.right, stateOwner);
    if (left === null || right === null) return null;
    return `${name}(${left}, ${right})`;
  }

  private unary(node: Extract<Expr, { kind: 'unary' }>, stateOwner: string | null): string | null {
    if (node.op === 'not') {
      const operand = this.expr(node.operand, stateOwner);
      return operand === null ? null : `not(${operand})`;
    }
    if (node.op === '~') {
      this.fail(node.line, 'the `~` operator is not supported');
      return null;
    }
    const operand = this.expr(node.operand, stateOwner);
    if (operand === null) return null;
    if (node.op === '+') return operand;
    if (node.operand.kind === 'number') return literal(-node.operand.value);
    return `sub(0, ${operand})`;
  }

  /** `close[1]`, which is a shift of the whole series in a vectorised engine. */
  private history(node: Extract<Expr, { kind: 'index' }>, stateOwner: string | null): string | null {
    const offset = literalNumber(node.offset);
    if (offset === null || !Number.isInteger(offset) || offset < 0) {
      this.fail(node.line, 'a history offset has to be a whole number of bars, such as close[1]');
      return null;
    }
    const baseName = node.base.kind === 'ident' ? node.base.name : null;
    if (stateOwner && baseName === stateOwner) {
      if (offset > 1) {
        this.fail(node.line, `\`${baseName}[${offset}]\`: a var's history deeper than one bar is not available`);
        return null;
      }
      return this.identifier(node.base as Extract<Expr, { kind: 'ident' }>, stateOwner);
    }
    const text = this.expr(node.base, null);
    if (text === null) return null;
    if (offset === 0) return stateOwner && !text.includes('[') ? `${text}[__bar]` : text;
    const shifted = `delay(${text}, ${offset})`;
    return stateOwner ? `${shifted}[__bar]` : shifted;
  }

  /* ------------------------------------------------------------------ naming and lookups */

  /** Resolves a callee to a builtin key: `ta.sma` and the v2/v3 `sma` both read as `sma`. */
  private builtinKey(callee: Expr): string | null {
    if (callee.kind === 'member') {
      const root = memberRoot(callee);
      const rootName = root && root.kind === 'ident' ? root.name : null;
      const name = memberName(callee);
      if (!rootName || !name) return null;
      if (rootName === 'input') return `input.${name}`;
      if (rootName === 'color') return `color.${name}`;
      if (rootName === 'ta' || rootName === 'math') return name;
      if (rootName === 'plot') return `plot.${name}`;
      return null;
    }
    if (callee.kind === 'ident') {
      if (callee.name === 'input') return 'input';
      if (this.scope.names.has(callee.name) && !STATEMENT_CALLS.includes(callee.name)) return null;
      if (BUILTINS[callee.name]) return callee.name;
      if (STATEMENT_CALLS.includes(callee.name)) return callee.name;
      return null;
    }
    return null;
  }

  private functions(): Map<string, FunctionPlan> {
    return this.functionPlans;
  }

  private functionPlans = new Map<string, FunctionPlan>();

  private lookup(name: string): NameInfo | null {
    return this.scope.names.get(name) ?? null;
  }

  private declare(name: string, info: NameInfo): void {
    this.scope.names.set(name, info);
  }

  /** The JavaScript name already given to a Pine identifier, or a new one that fits. */
  private jsNameOf(pine: string): string {
    const known = this.scope.names.get(pine);
    if (known) return known.js;
    return this.freshName(pine);
  }

  /** Allocates a JavaScript name, keeping clear of the sandbox's own globals. */
  private freshName(pine: string): string {
    const clean = pine.replace(/[^A-Za-z0-9_$]/g, '_').replace(/^([0-9])/, '_$1');
    if (!clean) return this.reserve('pine');
    if (!this.taken.has(clean)) {
      this.taken.add(clean);
      return clean;
    }
    let suffix = 2;
    while (this.taken.has(`${clean}_${suffix}`)) suffix += 1;
    const candidate = `${clean}_${suffix}`;
    this.taken.add(candidate);
    return candidate;
  }

  private reserve(base: string): string {
    let suffix = 1;
    while (this.taken.has(`${base}${suffix}`)) suffix += 1;
    const candidate = `${base}${suffix}`;
    this.taken.add(candidate);
    return candidate;
  }

  /* ------------------------------------------------------------------ output */

  private push(line: string): void {
    this.lines.push(line);
  }

  private scriptText(): string {
    const header = [`// Converted from Pine Script "${this.name}", plotting ${this.placement === 'price' ? 'over the price' : 'in its own pane'}.`];
    for (const warning of sortDiagnostics(this.warnings)) header.push(`// Line ${warning.line}: ${warning.message}.`);
    const options = [`name: '${escapeText(this.name)}'`, `placement: '${this.placement}'`];
    if (this.levels.length > 0) options.push(`levels: [${this.levels.map((level) => literal(level)).join(', ')}]`);
    if (this.precision !== null) options.push(`precision: ${this.precision}`);
    if (this.priceUnits) options.push('priceUnits: true');
    return [header.join('\n'), `indicator({ ${options.join(', ')} });`, ...this.lines, ''].join('\n');
  }

  /* ------------------------------------------------------------------ notes */

  private fail(line: number, message: string): void {
    const clean = message.replace(/ \(line \d+\)$/, '');
    if (!this.errors.some((error) => error.line === line && error.message === clean)) this.errors.push({ line, message: clean });
  }

  private note(line: number, message: string): void {
    if (!this.warnings.some((warning) => warning.line === line && warning.message === message)) this.warnings.push({ line, message });
  }
}

/* ------------------------------------------------------------------ helpers */

/** An if/else body that assigns exactly one variable, which is what a chain can fold. */
function exactlyOneAssign(body: readonly Stmt[]): { name: string; expr: Expr } | null {
  if (body.length !== 1) return null;
  const statement = body[0];
  if (!statement || statement.kind !== 'assign' || statement.target.kind !== 'ident') return null;
  return { name: statement.target.name, expr: statement.expr };
}

function positional(args: readonly CallArgument[], index: number): Expr | null {
  let seen = 0;
  for (const arg of args) {
    if (arg.name) continue;
    if (seen === index) return arg.expr;
    seen += 1;
  }
  return null;
}

function namedArgs(args: readonly CallArgument[]): Map<string, Expr> {
  const out = new Map<string, Expr>();
  for (const arg of args) if (arg.name) out.set(arg.name, arg.expr);
  return out;
}

function numberAt(args: readonly CallArgument[], index: number): number | undefined {
  const value = literalNumber(positional(args, index));
  return value === null ? undefined : value;
}

function numberOption(args: Map<string, Expr>, name: string): number | undefined {
  const value = literalNumber(args.get(name) ?? null);
  return value === null ? undefined : value;
}

function literalNumber(node: Expr | null | undefined): number | null {
  if (!node) return null;
  if (node.kind === 'number') return node.value;
  if (node.kind === 'unary' && node.op === '-' && node.operand.kind === 'number') return -node.operand.value;
  if (node.kind === 'unary' && node.op === '+' && node.operand.kind === 'number') return node.operand.value;
  return null;
}

function literalBoolean(node: Expr | null | undefined): boolean {
  const value = literalNumber(node);
  return value !== null && value !== 0;
}

function literalString(node: Expr | null | undefined): string | null {
  return node && node.kind === 'string' ? node.value : null;
}

function stringList(node: Expr | null | undefined): string[] | null {
  if (!node || node.kind !== 'tuple') return null;
  const out: string[] = [];
  for (const item of node.items) {
    const text = literalString(item);
    if (text === null) return null;
    out.push(text);
  }
  return out.length > 0 ? out : null;
}

/** `plot.style_columns` → `plot_style_columns`, so style names can be looked up whole. */
function dottedName(node: Expr): string | null {
  if (node.kind === 'ident') return node.name;
  if (node.kind !== 'member') return null;
  const parent = dottedName(node.object);
  return parent ? `${parent}_${node.name}` : node.name;
}

/** `ta.sma` → `sma`: the tail of a member chain, and its root. */
function memberName(node: Expr): string | null {
  return node.kind === 'member' ? node.name : null;
}

function memberRoot(node: Expr): Expr | null {
  let current = node;
  while (current.kind === 'member') current = current.object;
  return current;
}

function memberKey(node: Extract<Expr, { kind: 'member' }>): string | null {
  const root = memberRoot(node.object);
  const rootName = root && root.kind === 'ident' ? root.name : null;
  if (rootName === 'ta' || rootName === 'math') return node.name;
  return rootName ? null : node.name;
}

function literal(value: number): string {
  if (Number.isNaN(value)) return 'Number.NaN';
  if (!Number.isFinite(value)) return value > 0 ? 'Number.POSITIVE_INFINITY' : 'Number.NEGATIVE_INFINITY';
  return String(value);
}

function escapeText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ');
}

function sortDiagnostics(list: readonly PineDiagnostic[]): PineDiagnostic[] {
  const out: PineDiagnostic[] = [];
  for (const entry of list) {
    if (!out.some((other) => other.line === entry.line && other.message === entry.message)) out.push(entry);
  }
  return out.sort((a, b) => a.line - b.line);
}
