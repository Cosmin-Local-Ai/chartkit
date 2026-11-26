/**
 * Turns a user script's declaration into the shape the chart already speaks.
 *
 * A script instance is presented as an ordinary `IndicatorDefinition`: same placement
 * values, same parameter descriptors the settings form renders, same pane style block,
 * same plot list with colors and widths. That is what keeps the dialog, the panes, the
 * legend and the workspace document free of any script-specific branch.
 */

import type { Bar } from '../../types';
import type { PrintFlow } from '../flow';
import { flowNote } from '../flow';
import {
  BAND_FILL_OPACITY,
  toHex,
  withAlpha,
  type IndicatorDefinition,
  type IndicatorPlot,
  type IndicatorResult,
  type ParamDescriptor,
  type ParamValues,
} from '../registry';
import { SCRIPT_INDICATOR_ID, type ScriptMeta } from './contract';
import type { ScriptState } from './runtime';

/** One color well in the settings form, and which plot's color or negative color it edits. */
interface ColorSlot {
  label: string;
  plot: number;
  role: 'color' | 'negative';
}

/** Colors the user may override: one per plot, plus one for each histogram's below-zero half. */
function colorSlots(meta: ScriptMeta | null): ColorSlot[] {
  const out: ColorSlot[] = [];
  (meta?.plots ?? []).forEach((plot, index) => {
    out.push({ label: plot.label, plot: index, role: 'color' });
    if (plot.kind === 'histogram' && plot.negativeColor) out.push({ label: `${plot.label} below`, plot: index, role: 'negative' });
  });
  return out;
}

/**
 * The settings form's parameters: the colors and smoothing every indicator instance
 * carries, then whatever the script declared, in declaration order.
 */
export function scriptParams(meta: ScriptMeta | null): ParamDescriptor[] {
  const slots = colorSlots(meta);
  const out: ParamDescriptor[] = [];
  if (slots.length > 0) {
    out.push({
      name: 'colors',
      label: 'Colors',
      kind: 'colors',
      default: slots.map((slot) => toHex(slotColor(meta, slot))),
      slots: slots.map((slot) => slot.label),
    });
  }
  out.push(...(meta?.inputs ?? []));
  out.push({ name: 'smooth', label: 'Smooth', kind: 'boolean', default: false });
  return out;
}

function slotColor(meta: ScriptMeta | null, slot: ColorSlot): string {
  const plot = meta?.plots[slot.plot];
  if (!plot) return '#4b9cf5';
  if (slot.role === 'negative') return plot.negativeColor ?? plot.color;
  return plot.color;
}

/** Colors in slot order, padded so a short stored list still plots. */
function slotColors(meta: ScriptMeta | null, params: ParamValues): string[] {
  const slots = colorSlots(meta);
  const raw = params['colors'];
  const list = Array.isArray(raw) ? raw.filter((color): color is string => typeof color === 'string' && color !== '') : [];
  return slots.map((_, index) => list[index] ?? list[list.length - 1] ?? '#4b9cf5');
}

/**
 * The definition an instance is drawn from. `compute` is never called: the engine
 * answers script instances from the last good worker run, since evaluation is
 * asynchronous and must not block a frame.
 */
export function scriptDefinition(meta: ScriptMeta | null): IndicatorDefinition {
  const pending = meta === null;
  return {
    id: SCRIPT_INDICATOR_ID,
    label: meta?.name ?? 'Custom indicator',
    short: meta?.name ?? 'Script',
    placement: meta?.placement === 'pane' ? 'offchart' : 'onchart',
    // A user indicator is added from its script, never filed in the catalog grid, so its
    // section is only here to satisfy the shape.
    group: 'Custom',
    needsPrints: meta?.usesFlow === true,
    params: scriptParams(meta),
    pane: pending ? undefined : (meta?.pane ?? undefined),
    compute: () => ({ caption: '', plots: [], smooth: false }),
  };
}

/** Parameter summary shown next to the name, e.g. `(26, close, ATR band 1.5)`. */
export function scriptCaption(meta: ScriptMeta | null, params: ParamValues): string {
  const parts: string[] = [];
  for (const descriptor of meta?.inputs ?? []) {
    const value = params[descriptor.name] ?? descriptor.default;
    if (typeof value === 'number') parts.push(formatNumber(value));
    else if (typeof value === 'string' && value) parts.push(value);
    else if (value === true) parts.push(descriptor.label.toLowerCase());
  }
  return parts.length > 0 ? `(${parts.join(', ')})` : '()';
}

/**
 * The series to draw right now: the last run that succeeded, with the colors and
 * smoothing the user set. A run that failed leaves the previous series in place and
 * says so in the note, so a broken script cannot blank the chart.
 */
export function scriptResult(
  meta: ScriptMeta | null,
  params: ParamValues,
  state: ScriptState,
  bars: readonly Bar[],
  flow: PrintFlow | null,
): IndicatorResult {
  const caption = scriptCaption(meta, params);
  const plots = meta?.plots ?? [];
  if (plots.length === 0) {
    return { caption, plots: [], note: state.error ? `script error: ${truncate(state.error)}` : 'reading the script…', smooth: false };
  }

  const slots = colorSlots(meta);
  const wells = slotColors(meta, params);
  // Slot order is the order the color wells were built in, so a well maps back to exactly
  // one plot and one of its two colors.
  const drawn: IndicatorPlot[] = plots.map((plot, index) => {
    let color = plot.color;
    let negativeColor = plot.negativeColor ?? undefined;
    slots.forEach((slot, well) => {
      if (slot.plot !== index) return;
      const value = wells[well];
      if (!value) return;
      if (slot.role === 'color') color = value;
      else negativeColor = value;
    });
    return {
      label: plot.label,
      color,
      width: plot.width,
      kind: plot.kind,
      values: valuesFor(state.values, index, bars.length),
      negativeColor,
    };
  });

  const band = meta?.band;
  const bandIndex = band
    ? { upper: plots.findIndex((plot) => plot.label === band.upper), lower: plots.findIndex((plot) => plot.label === band.lower) }
    : null;
  const bandColor = bandIndex && bandIndex.upper >= 0 ? declaredBandColor(meta, slots, wells, bandIndex.upper) : '#4b9cf5';
  const note = state.error
    ? `script error: ${truncate(state.error)}`
    : meta?.usesFlow
      ? flowNote(flow)
      : undefined;

  return {
    caption,
    plots: drawn,
    note,
    band:
      bandIndex && bandIndex.upper >= 0 && bandIndex.lower >= 0
        ? { upper: bandIndex.upper, lower: bandIndex.lower, color: withFillAlpha(bandColor) }
        : undefined,
    smooth: params['smooth'] === true,
  };
}

/**
 * Fill between two lines: the color the script declared, or the upper line's color once
 * the user recolors that line, since a recolored band should follow the band's own edge.
 */
function declaredBandColor(meta: ScriptMeta | null, slots: ColorSlot[], wells: string[], upper: number): string {
  const declared = meta?.band?.color ?? '#4b9cf5';
  const well = slots.findIndex((slot) => slot.plot === upper && slot.role === 'color');
  const slot = slots[well];
  const chosen = well >= 0 ? wells[well] : undefined;
  if (slot && chosen && chosen !== toHex(slotColor(meta, slot))) return chosen;
  return declared;
}

function valuesFor(values: number[][] | null, index: number, bars: number): number[] {
  const column = values?.[index];
  if (column && column.length === bars) return column;
  return new Array<number>(bars).fill(Number.NaN);
}

function truncate(text: string): string {
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

/** Band fill, at the same faintness the built-in band indicators use. */
function withFillAlpha(color: string): string {
  return withAlpha(color, BAND_FILL_OPACITY);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}
