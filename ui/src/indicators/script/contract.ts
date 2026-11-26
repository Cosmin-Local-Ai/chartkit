/**
 * The contract between the chart and a user indicator script.
 *
 * A user indicator is one instance of `SCRIPT_INDICATOR_ID` carrying its own script
 * text. The script declares its inputs, where it plots and what it plots; the host
 * turns that declaration into the same `IndicatorDefinition` a built-in indicator
 * provides, so the dialog, the panes and the legend need no script-specific branch.
 *
 * The declaration shape follows the shipped product's own kScript surface: `input(...)`
 * with a type, a default, a label and a group, and a placement that is either over the
 * price or in a pane of its own. Names of the numeric builtins are the ones `tas.ts`
 * already exports, so a Pine or kScript port is a renaming exercise, not a rewrite.
 */

import type { PaneStyle, ParamDescriptor, ParamValues, PlotKind } from '../registry';

/** The `indicatorId` every user-script instance carries. No built-in uses this id. */
export const SCRIPT_INDICATOR_ID = 'script';

/** Where the script plots: over the price, or in a pane of its own. */
export type ScriptPlacement = 'price' | 'pane';

/** One plotted series as the script declared it. Values arrive later, from the compute run. */
export interface ScriptPlotMeta {
  label: string;
  kind: PlotKind;
  color: string;
  width: number;
  /** Histogram only: the color for values below zero. */
  negativeColor: string | null;
}

/** What a declare run learned about one script. Recomputed whenever the text changes. */
export interface ScriptMeta {
  name: string;
  placement: ScriptPlacement;
  /** Parameters the script declared, in declaration order, in the dialog's own descriptor shape. */
  inputs: ParamDescriptor[];
  plots: ScriptPlotMeta[];
  /** Pane style for a `pane` placement: guide levels, fixed range, zero line, label decimals. */
  pane: PaneStyle | null;
  /** Shading between two plotted lines, named by plot label so it survives a renumber. */
  band: { upper: string; lower: string; color: string } | null;
  /** True once the script reads the print flow, so the app loads a print window for it. */
  usesFlow: boolean;
}

/** Bars as they cross into the worker: one column per field, so the copy is one memcpy. */
export interface ScriptColumns {
  start: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
}

/** Per-bar aggressive volume, `NaN` on bars the prints do not cover. */
export interface ScriptFlow {
  buy: Float64Array | null;
  sell: Float64Array | null;
}

export type ScriptRequest = {
  id: number;
  instanceId: string;
  /** `declare` reads only the declaration; `compute` produces the plotted values. */
  phase: 'declare' | 'compute';
  source: string;
  params: ParamValues;
  columns: ScriptColumns;
  flow: ScriptFlow;
  /** Request signature, echoed back so the host can drop a stale answer. */
  key: string;
};

export type ScriptResponse =
  | { kind: 'meta'; id: number; instanceId: string; key: string; meta: ScriptMeta }
  | { kind: 'values'; id: number; instanceId: string; key: string; values: number[][] }
  | { kind: 'failure'; id: number; instanceId: string; key: string; error: string; halted: boolean };

/** Param names the host already owns; a script input may not take them. */
export const RESERVED_PARAM_NAMES: readonly string[] = ['colors', 'smooth'];

/** Price sources a script may ask for. `hlc3` is the typical price. */
export const SCRIPT_SOURCES: readonly string[] = ['open', 'high', 'low', 'close', 'hlc3'];

/** Line widths the chart draws, the same 1-8 range the built-in indicators offer. */
export const MIN_WIDTH = 1;
export const MAX_WIDTH = 8;

/** Longest script name worth showing in a legend or pane title. */
const MAX_NAME = 64;

export function clampName(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_NAME ? `${trimmed.slice(0, MAX_NAME - 1)}…` : trimmed;
}

/**
 * Parameter names for a script's `input.*` calls, in call order.
 *
 * The name comes from the variable the call is assigned to, since that is what a Pine
 * or kScript port has to hand a name to anyway; a call that is not a plain assignment
 * falls back to a positional name, which is still stable for one version of the text.
 */
export function deriveInputNames(source: string): string[] {
  const masked = maskCommentsAndStrings(source);
  const out: string[] = [];
  const used = new Set<string>(RESERVED_PARAM_NAMES);
  const call = /\binput\s*\.\s*(?:int|float|number|bool|boolean|select|source|string)\s*\(/g;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = call.exec(masked)) !== null) {
    index += 1;
    const head = masked.slice(0, match.index);
    const statement = Math.max(
      head.lastIndexOf('\n'),
      head.lastIndexOf(';'),
      head.lastIndexOf('{'),
      head.lastIndexOf('}'),
    );
    const declared = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^=]*$/.exec(head.slice(statement + 1));
    out.push(uniqueName(declared?.[1] ?? `param${index}`, used));
  }
  return out;
}

/** Keeps a name usable and unique: host names are reserved, and repeats get a suffix. */
export function uniqueName(name: string, used: Set<string>): string {
  const clean = name.trim() || 'param';
  let candidate = clean;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${clean}${suffix++}`;
  used.add(candidate);
  return candidate;
}

/**
 * Blanks comments, string and template literals, and regular-expression literals,
 * keeping every newline in place so line numbers still line up. Declaration scanning
 * must not see `input.int(` inside a comment or a label.
 */
export function maskCommentsAndStrings(source: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] ?? '';
    const next = source[i + 1] ?? '';
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      out.push(blank(source.slice(i, stop)));
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out.push(blank(source.slice(i, stop)));
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < source.length) {
        const c = source[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === ch) break;
        j += 1;
      }
      const stop = Math.min(j + 1, source.length);
      out.push(blank(source.slice(i, stop)));
      i = stop;
      continue;
    }
    if (ch === '/' && regexLiteralAhead(source, i)) {
      let j = i + 1;
      let classBody = false;
      while (j < source.length) {
        const c = source[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '[') classBody = true;
        else if (c === ']') classBody = false;
        else if (c === '/' && !classBody) break;
        else if (c === '\n') break;
        j += 1;
      }
      const stop = Math.min(j + 1, source.length);
      out.push(blank(source.slice(i, stop)));
      i = stop;
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

/** A `/` opens a regex only where a value can start, never after a number or an identifier. */
function regexLiteralAhead(source: string, at: number): boolean {
  for (let i = at - 1; i >= 0; i -= 1) {
    const ch = source[i];
    if (ch === undefined) break;
    if (/\s/.test(ch)) continue;
    return !(/[A-Za-z0-9_$)\]'"`]/.test(ch));
  }
  return true;
}

function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/**
 * Label for a parameter name, following the shipped client's own rule: underscores and
 * camelCase become words, and each word starts upper case.
 */
export function prettify(name: string): string {
  return name
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word.length > 1 && /^[A-Z0-9]+$/.test(word) ? word : `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`))
    .join(' ');
}
