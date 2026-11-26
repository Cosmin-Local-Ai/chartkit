/**
 * Drawing tool registry: one entry per tool, holding the shipped id, group and
 * toolbar section, the anchor count and per-anchor freedom, the style keys it uses
 * with their shipped defaults, and the geometry. Geometry returns canvas
 * primitives in pane pixels, so the renderer, the hit test and the quick bar all
 * stay shared: adding a tool means adding an entry and its primitives.
 *
 * Ids, groups, section keys, anchor counts, style keys and defaults come from the
 * shipped chart schema and tool identity tables; the deviations are recorded on the
 * entries that carry them.
 */

import type { Align } from '../canvasKit';
import { THEME } from '../canvasKit';
import { fmtNumber, fmtPct, fmtPrice, fmtSize } from '../format';
import type { LocalTime } from '../format';
import type { PriceScale, XScale } from '../scale';
import type { Bar, Instrument } from '../types';
import type { Pt } from './anchors';
import {
  FIB_RETRACE_LEVELS,
  fontCss,
  fontStack,
  lineDash,
  styleBoolean,
  styleColor,
  styleFlags,
  styleLevels,
  styleNumber,
  styleString,
  withOpacity,
  type LevelEntry,
  type StyleValues,
} from './style';

export interface PlotRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Everything geometry needs, all of it derived from the frame being drawn. It also
 * satisfies `AnchorContext`, so one object serves both anchor conversion and geometry.
 */
export interface ToolEnv {
  x: XScale;
  price: PriceScale;
  /** Venue price increment, so a placed price lands on a quoted tick. */
  priceTick: number;
  ctx: CanvasRenderingContext2D;
  plot: PlotRect;
  instrument: Instrument | null;
  bars: readonly Bar[];
  local: LocalTime;
  /** Text width in the current font, so hit tests match what was drawn. */
  measure(text: string, font: string): number;
}

export interface LabelOptions {
  color: string;
  font: string;
  align: Align;
  baseline: 'top' | 'middle' | 'bottom';
  background?: string;
  /** Plate outline, used by the note and signpost plates. */
  border?: string;
  fold?: boolean;
  rotation?: number;
  pad?: number;
  /** Non-square padding: the shipped bubbles pad wider than they pad tall. */
  padX?: number;
  padY?: number;
}

/** Text drawn by a tool. `auto` marks the text a tool generates for itself — a vertex name
 * or a leg ratio — as against a note the user typed, so the renderer can drop it when the
 * tape is too dense for it to read. */
export interface LabelPrim {
  kind: 'label';
  at: Pt;
  text: string;
  options: LabelOptions;
  auto?: boolean;
}

export type Prim =
  | { kind: 'segment'; a: Pt; b: Pt; color: string; width: number; dash: number[] }
  | { kind: 'fill'; pts: Pt[]; color: string }
  | LabelPrim
  /** Gutter bubble: drawn outside the plot clip, like the live-price tag. */
  | { kind: 'priceTag'; at: Pt; text: string; color?: string }
  | { kind: 'timeTag'; at: Pt; text: string };

export interface DrawingToolDefinition {
  id: string;
  label: string;
  /** Shipped tool group. */
  group: string;
  /** Shipped toolbar section key; palette groups follow it. */
  sectionKey: string;
  anchorCount: number;
  /** Freedom of each anchor: 'x' is time only, 'y' is price only, 'xy' is free. */
  anchorAxes: ('x' | 'y' | 'xy')[];
  /** Compact palette glyph; the shipped palette uses icons. */
  glyph: string;
  hint: string;
  styleKeys: readonly string[];
  /** Shipped quick-bar key list, rendered by the same field renderer. */
  quickBar?: readonly string[];
  /** Shipped per-tool defaults, overriding the shared property map. */
  styleDefaults: StyleValues;
  /**
   * True for the note tools, whose content has to be typed the moment the drawing is
 * placed: their style form opens on placement. The shipped editor does this inline.
 */
  opensEditorOnPlace?: boolean;
  /**
   * How Shift constrains a dragged point, measured in pane pixels from the anchor the
   * drag pivots on. `angle` snaps to the nearest quarter turn of 45 degrees, `square`
   * keeps the two corners equal in pixels, `lockPrice` and `lockTime` hold one axis at
   * the press. The shipped layer constrains the same three ways; see
   * `re-notes/feature-inventory.md` §2.
   */
  shiftConstraint?: ShiftConstraint;
  primitives(anchors: Pt[], style: StyleValues, env: ToolEnv): Prim[];
}

/** Which of the Shift constraints, if any, a tool answers to. */
export type ShiftConstraint = 'angle' | 'square' | 'lockPrice' | 'lockTime';

/** Palette sections, keyed and named like the shipped tool sidebar, in shipped order. */
export const TOOL_SECTIONS: { key: string; label: string }[] = [
  { key: 'lines', label: 'Lines' },
  { key: 'channels', label: 'Channels' },
  { key: 'pitchforks', label: 'Pitchforks' },
  { key: 'shapes', label: 'Shapes' },
  { key: 'arrows-classic', label: 'Arrows' },
  { key: 'stylized', label: 'Stylized' },
  { key: 'textAndNotes', label: 'Text and Notes' },
  { key: 'labels', label: 'Labels' },
  { key: 'content', label: 'Content' },
  { key: 'fibonacci', label: 'Fibonacci' },
  { key: 'chartPatterns', label: 'Chart patterns' },
  { key: 'elliottWaves', label: 'Elliott waves' },
  { key: 'cycles', label: 'Cycles' },
  { key: 'forecasting', label: 'Forecasting' },
];

const UNBOUNDED = 1e7;

/* ------------------------------------------------------------------ geometry helpers */

function sub(a: Pt, b: Pt): Pt {
  return { x: a.x - b.x, y: a.y - b.y };
}

function add(a: Pt, v: Pt): Pt {
  return { x: a.x + v.x, y: a.y + v.y };
}

function mid(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Liang-Barsky clip of the line through `a` and `b` to the plot rect over the
 * parameter range [tMin, tMax]: [0, 1] is the segment, (-inf, inf) an extended
 * line, [0, inf) a ray from `a` through `b`.
 */
function clipLine(a: Pt, b: Pt, plot: PlotRect, tMin: number, tMax: number): [Pt, Pt] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - plot.left, plot.right - a.x, a.y - plot.top, plot.bottom - a.y];
  let lo = tMin;
  let hi = tMax;
  for (let i = 0; i < 4; i += 1) {
    const pi = p[i] ?? 0;
    const qi = q[i] ?? 0;
    if (pi === 0) {
      if (qi < 0) return null;
      continue;
    }
    const ratio = qi / pi;
    if (pi < 0) {
      if (ratio > hi) return null;
      if (ratio > lo) lo = ratio;
    } else {
      if (ratio < lo) return null;
      if (ratio < hi) hi = ratio;
    }
  }
  if (!(hi > lo)) return null;
  return [{ x: a.x + lo * dx, y: a.y + lo * dy }, { x: a.x + hi * dx, y: a.y + hi * dy }];
}

function segment(a: Pt, b: Pt, color: string, width: number, dash: number[]): Prim {
  return { kind: 'segment', a, b, color, width, dash };
}

function stroke(style: StyleValues, keyPrefix = ''): { color: string; width: number; dash: number[] } {
  const colorKey = keyPrefix ? `${keyPrefix}Color` : 'color';
  const lineStyleKey = keyPrefix ? `${keyPrefix}LineStyle` : 'lineStyle';
  const widthKey = keyPrefix ? `${keyPrefix}LineWidth` : 'lineWidth';
  const base = strokeBase(style);
  return {
    color: styleColor(style, colorKey, base.color),
    width: styleNumber(style, widthKey, base.width),
    dash: lineDash(styleString(style, lineStyleKey, styleString(style, 'lineStyle', 'solid'))),
  };
}

/** Width and dash always come from the tool's own line style when it has no variant keys. */
function strokeBase(style: StyleValues): { color: string; width: number } {
  return { color: styleColor(style, 'color'), width: styleNumber(style, 'lineWidth', 2) };
}

function priceAt(pt: Pt, env: ToolEnv): number {
  return env.price.fromY(pt.y);
}

function precision(env: ToolEnv): number {
  return env.instrument?.pricePrecision ?? 2;
}

function priceLabel(pt: Pt, env: ToolEnv): string {
  return fmtPrice(priceAt(pt, env), precision(env));
}

/** Text alignment from the shipped `textPosition` key. */
function alignOf(style: StyleValues): Align {
  const position = styleString(style, 'textPosition', 'center');
  return position === 'left' ? 'left' : position === 'right' ? 'right' : 'center';
}

/* ------------------------------------------------------------------ bubble geometry */

/**
 * Box a text primitive occupies. It mirrors `labelBounds` in the engine so a plate,
 * its tail and the hit test all agree on where the text sits.
 */
function plateBox(
  at: Pt,
  text: string,
  font: string,
  size: number,
  align: Align,
  padX: number,
  padY: number,
  env: ToolEnv,
): { left: number; right: number; top: number; bottom: number; center: Pt } {
  const width = env.measure(text, font) + padX * 2;
  const height = size + padY * 2;
  const left = align === 'left' ? at.x - padX : align === 'right' ? at.x - width + padX : at.x - width / 2;
  return {
    left,
    right: left + width,
    top: at.y - height / 2,
    bottom: at.y + height / 2,
    center: { x: left + width / 2, y: at.y },
  };
}

interface BubbleOptions {
  /** Plate fill, usually `color` at the shipped note opacity. */
  plate: string;
  border?: string;
  ink: string;
  center: Pt;
  align: Align;
  padX: number;
  padY: number;
  /** Tip the tail points at, omitted for a plate that floats on its own. */
  tailTo?: Pt;
}

/** Plate + text as one label primitive, with the tail drawn underneath. */
function bubblePrimitives(text: string, style: StyleValues, env: ToolEnv, options: BubbleOptions): Prim[] {
  const font = fontCss(style);
  const size = Math.round(styleNumber(style, 'fontSize', 24));
  const box = plateBox(options.center, text, font, size, options.align, options.padX, options.padY, env);
  const out: Prim[] = [];
  if (options.tailTo) {
    const down = options.tailTo.y > options.center.y;
    const edge = (down ? box.bottom : box.top) + (down ? -1 : 1);
    out.push({
      kind: 'fill',
      pts: [
        { x: box.center.x - 9, y: edge },
        options.tailTo,
        { x: box.center.x + 9, y: edge },
      ],
      color: options.plate,
    });
  }
  out.push({
    kind: 'label',
    at: options.center,
    text,
    options: {
      color: options.ink,
      font,
      align: options.align,
      baseline: 'middle',
      background: options.plate,
      border: options.border,
      padX: options.padX,
      padY: options.padY,
    },
  });
  return out;
}

/* ------------------------------------------------------------------ arrow geometry */

/** Point `distance` px from `at` at `angle`; canvas y grows downwards, like their pixel space. */
function polar(at: Pt, angle: number, distance: number): Pt {
  return { x: at.x + Math.cos(angle) * distance, y: at.y + Math.sin(angle) * distance };
}

/** Point reached by going `forward` px along `angle` and `sideways` px across it. */
function offsetAlong(at: Pt, angle: number, forward: number, sideways: number): Pt {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  return { x: at.x + dx * forward - dy * sideways, y: at.y + dy * forward + dx * sideways };
}

function polygon(pts: Pt[], color: string): Prim {
  return { kind: 'fill', pts, color };
}

/** Quadratic Bézier sampled into segments, so the shared hit test sees the curve. */
function curvePrimitives(a: Pt, control: Pt, b: Pt, color: string, width: number, dash: number[], steps = 24): Prim[] {
  const out: Prim[] = [];
  let previous = a;
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const inverse = 1 - t;
    const at: Pt = {
      x: inverse * inverse * a.x + 2 * inverse * t * control.x + t * t * b.x,
      y: inverse * inverse * a.y + 2 * inverse * t * control.y + t * t * b.y,
    };
    out.push(segment(previous, at, color, width, dash));
    previous = at;
  }
  return out;
}

function ringPrimitives(center: Pt, radius: number, color: string, width: number, steps = 20): Prim[] {
  const out: Prim[] = [];
  for (let step = 0; step < steps; step += 1) {
    const from = (step / steps) * Math.PI * 2;
    const to = ((step + 1) / steps) * Math.PI * 2;
    out.push(segment(polar(center, from, radius), polar(center, to, radius), color, width, []));
  }
  return out;
}

/** Momentum's shaft: the same stroke, faded in from nothing at the tail to full at the head. */
function fadedPrimitives(a: Pt, b: Pt, color: string, width: number, steps = 14): Prim[] {
  const out: Prim[] = [];
  for (let step = 0; step < steps; step += 1) {
    const from = { x: a.x + ((b.x - a.x) * step) / steps, y: a.y + ((b.y - a.y) * step) / steps };
    const to = { x: a.x + ((b.x - a.x) * (step + 1)) / steps, y: a.y + ((b.y - a.y) * (step + 1)) / steps };
    out.push(segment(from, to, withOpacity(color, ((step + 1) / steps) * 100), width, []));
  }
  return out;
}

/** The shipped `highlight` switch: a wide translucent copy under the drawing. */
function withHighlightGlow(prims: Prim[], color: string): Prim[] {
  const glow = prims
    .filter((prim): prim is Extract<Prim, { kind: 'segment' }> => prim.kind === 'segment')
    .map((prim) => ({ ...prim, color: withOpacity(color, 28), width: prim.width + 6, dash: [] }));
  return [...glow, ...prims];
}

/**
 * The shipped directional marks: a fixed glyph polygon anchored at its tip, drawn in
 * the pixel geometry the shipped renderer uses.
 */
function markGlyph(at: Pt, direction: 'left' | 'right' | 'top' | 'bottom', color: string): Prim {
  const { x, y } = at;
  const pts = (
    direction === 'left'
      ? [[x, y], [x - 10, y - 10], [x, y - 20], [x, y - 15], [x + 10, y - 15], [x + 10, y - 5], [x, y - 5]]
      : direction === 'right'
        ? [[x, y], [x, y - 5], [x - 10, y - 5], [x - 10, y - 15], [x, y - 15], [x, y - 20], [x + 10, y - 10]]
        : direction === 'top'
          ? [[x, y], [x + 5, y], [x + 5, y - 10], [x + 10, y - 10], [x, y - 20], [x - 10, y - 10], [x - 5, y - 10], [x - 5, y]]
          : [[x, y], [x + 10, y - 10], [x + 5, y - 10], [x + 5, y - 20], [x - 5, y - 20], [x - 5, y - 10], [x - 10, y - 10]]
  ).map(([px, py]) => ({ x: px ?? x, y: py ?? y }));
  return polygon(pts, color);
}

/** Control point of a branch bowed `side` of the straight line, as their forks bow it. */
function branchControl(from: Pt, to: Pt, side: number, bow = 0.15): Pt {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const reach = bow * length;
  return { x: (from.x + to.x) / 2 - (dy / length) * reach * side, y: (from.y + to.y) / 2 + (dx / length) * reach * side };
}

/** Horizontal placement of a label along a span, mirroring `textPosition`. */
function placeAt(a: Pt, b: Pt, position: string, offset: number): Pt {
  const t = position === 'left' ? 0 : position === 'center' ? 0.5 : 1;
  return { x: a.x + (b.x - a.x) * t, y: Math.min(b.y, a.y) - offset };
}

/* ------------------------------------------------------------------ shared geometry */

/** Shared line geometry for the four straight-line tools: they differ only in extent. */
function linePrimitives(
  anchors: Pt[],
  style: StyleValues,
  env: ToolEnv,
  extent: 'segment' | 'ray' | 'both' | 'width' | 'height',
): Prim[] {
  const first = anchors[0];
  if (!first) return [];
  const { color, width, dash } = stroke(style);
  const out: Prim[] = [];
  if (extent === 'width') {
    out.push(segment({ x: env.plot.left, y: first.y }, { x: env.plot.right, y: first.y }, color, width, dash));
    out.push({ kind: 'priceTag', at: { x: env.plot.right, y: first.y }, text: priceLabel(first, env) });
    return out;
  }
  if (extent === 'height') {
    out.push(segment({ x: first.x, y: env.plot.top }, { x: first.x, y: env.plot.bottom }, color, width, dash));
    out.push({ kind: 'timeTag', at: { x: first.x, y: env.plot.bottom }, text: timeLabel(first, env) });
    return out;
  }
  const second = anchors[1] ?? first;
  if (extent === 'segment') {
    out.push(segment(first, second, color, width, dash));
    if (styleBoolean(style, 'priceLabels', false)) {
      out.push({ kind: 'priceTag', at: first, text: priceLabel(first, env) });
      out.push({ kind: 'priceTag', at: second, text: priceLabel(second, env) });
    }
    if (styleBoolean(style, 'showStats', false)) out.push(...trendStats(first, second, style, env));
    return out;
  }
  const clipped =
    extent === 'ray'
      ? clipLine(first, second, env.plot, 0, UNBOUNDED)
      : clipLine(first, second, env.plot, -UNBOUNDED, UNBOUNDED);
  if (clipped) out.push(segment(clipped[0], clipped[1], color, width, dash));
  return out;
}

function timeLabel(pt: Pt, env: ToolEnv): string {
  const index = env.x.toIndex(pt.x);
  const start = env.x.startAt(Math.max(0, Math.round(index)));
  const barMs = Math.max(1, env.x.barMs);
  const time = start ?? (env.x.startAt(env.x.count - 1) ?? 0) + (index - (env.x.count - 1)) * barMs;
  return barMs >= 86_400_000 ? env.local.format(time, 'day') : env.local.format(time, 'clock');
}

/** The shipped trend-line stats block: price range, percent change, bar count. */
function trendStats(a: Pt, b: Pt, style: StyleValues, env: ToolEnv): Prim[] {
  const keys = styleFlags(style, 'stats');
  if (keys.length === 0) return [];
  const pa = priceAt(a, env);
  const pb = priceAt(b, env);
  const parts: string[] = [];
  if (keys.includes('priceRange')) parts.push(fmtPrice(pb - pa, precision(env)));
  if (keys.includes('percentChange')) parts.push(fmtPct(pa !== 0 ? ((pb - pa) / Math.abs(pa)) * 100 : 0));
  if (keys.includes('barsRange')) parts.push(`${Math.abs(Math.round(env.x.toIndex(b.x) - env.x.toIndex(a.x)))} bars`);
  const font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const at = placeAt(a, b, styleString(style, 'statsPosition', 'right'), 12);
  return [
    {
      kind: 'label',
      at,
      text: parts.join('  '),
      options: { color: THEME.text, font, align: 'center', baseline: 'bottom' },
    },
  ];
}

/** Fibonacci levels: bands between neighbours, a rule and a label per level. */
function fibPrimitives(
  anchors: Pt[],
  style: StyleValues,
  env: ToolEnv,
  levels: LevelEntry[],
  showTrendLine: boolean,
): Prim[] {
  const a = anchors[0];
  const b = anchors[1];
  if (!a || !b) return [];
  const [from, to] = styleBoolean(style, 'reverse', false) ? [b, a] : [a, b];
  const pa = priceAt(from, env);
  const pb = priceAt(to, env);
  const out: Prim[] = [];
  const left = styleFlags(style, 'extendSides').includes('left') ? env.plot.left : Math.min(from.x, to.x);
  const right = styleFlags(style, 'extendSides').includes('right') ? env.plot.right : Math.max(from.x, to.x);
  const enabled = levels.filter((level) => level.enabled);
  const width = styleNumber(style, 'lineWidth', 2);
  const dash = lineDash(styleString(style, 'lineStyle', 'solid'));
  const opacity = styleNumber(style, 'backgroundOpacity', 10);
  const position = styleString(style, 'textPosition', 'left');
  const font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const percentFormat = styleString(style, 'levelFormat', 'value') === 'percent';

  if (styleBoolean(style, 'showLevels', true)) {
    for (let i = 0; i < enabled.length - 1; i += 1) {
      const upper = enabled[i];
      const lower = enabled[i + 1];
      if (!upper || !lower) continue;
      const y1 = env.price.toY(pa + (pb - pa) * upper.value);
      const y2 = env.price.toY(pa + (pb - pa) * lower.value);
      if (Math.abs(y2 - y1) < 0.5) continue;
      out.push({
        kind: 'fill',
        pts: [
          { x: left, y: y1 },
          { x: right, y: y1 },
          { x: right, y: y2 },
          { x: left, y: y2 },
        ],
        color: withOpacity(upper.color, opacity),
      });
    }
    for (const level of enabled) {
      const value = pa + (pb - pa) * level.value;
      const y = env.price.toY(value);
      out.push(segment({ x: left, y }, { x: right, y }, level.color, width, dash));
      if (!styleBoolean(style, 'showPrices', true)) continue;
      const text = percentFormat
        ? `${(level.value * 100).toFixed(1)}% ${fmtPrice(value, precision(env))}`
        : `${level.value}  ${fmtPrice(value, precision(env))}`;
      out.push({
        kind: 'label',
        at: { x: position === 'left' ? left + 6 : position === 'right' ? right - 6 : (left + right) / 2, y: y - 7 },
        text,
        options: { color: level.color, font, align: position === 'left' ? 'left' : position === 'right' ? 'right' : 'center', baseline: 'bottom' },
      });
    }
  }
  if (showTrendLine) {
    const trendColor = styleColor(style, 'trendLineColor', '#B0B0B0');
    const trendWidth = styleNumber(style, 'trendLineLineWidth', 2);
    const trendDash = lineDash(styleString(style, 'trendLineLineStyle', 'dashed'));
    out.push(segment(from, to, trendColor, trendWidth, trendDash));
  }
  return out;
}

/** Long/short risk calculator: profit band, stop band, three price rules and stats. */
function positionPrimitives(anchors: Pt[], style: StyleValues, env: ToolEnv, long: boolean): Prim[] {
  const entry = anchors[0];
  const target = anchors[1];
  const stop = anchors[2];
  if (!entry || !target || !stop) return [];
  const profitColor = styleColor(style, 'profitColor', '#00C2A8');
  const stopColor = styleColor(style, 'stopColor', '#ff3232');
  const width = styleNumber(style, 'lineWidth', 2);
  const dash = lineDash(styleString(style, 'lineStyle', 'solid'));
  const left = Math.min(entry.x, target.x, stop.x);
  const right = env.plot.right;
  const out: Prim[] = [];

  const band = (to: Pt, color: string): Prim => ({
    kind: 'fill',
    pts: [
      { x: left, y: entry.y },
      { x: right, y: entry.y },
      { x: right, y: to.y },
      { x: left, y: to.y },
    ],
    color: withOpacity(color, 16),
  });
  out.push(band(target, profitColor), band(stop, stopColor));
  out.push(segment({ x: left, y: target.y }, { x: right, y: target.y }, profitColor, width, dash));
  out.push(segment({ x: left, y: stop.y }, { x: right, y: stop.y }, stopColor, width, dash));
  out.push(segment({ x: left, y: entry.y }, { x: right, y: entry.y }, THEME.text, width, dash));
  out.push({ kind: 'priceTag', at: { x: right, y: target.y }, text: priceLabel(target, env), color: profitColor });
  out.push({ kind: 'priceTag', at: { x: right, y: stop.y }, text: priceLabel(stop, env), color: stopColor });
  out.push({ kind: 'priceTag', at: { x: right, y: entry.y }, text: priceLabel(entry, env) });

  const stats = positionStats(anchors, style, env, long);
  const font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const compact = styleBoolean(style, 'compactStats', false);
  const rows = compact ? [stats.join('  ')] : stats;
  const at = { x: left + 8, y: Math.min(entry.y, target.y, stop.y) - (compact ? 8 : 12 * rows.length - 4) };
  rows.forEach((row, index) => {
    out.push({
      kind: 'label',
      at: { x: at.x, y: at.y + index * 14 },
      text: row,
      options: { color: THEME.text, font, align: 'left', baseline: 'bottom' },
    });
  });
  return out;
}

/**
 * Shipped risk maths: the risk budget is a percent of the account or a money amount,
 * the quantity is that budget divided by the distance to the stop, scaled by the lot.
 */
function positionStats(anchors: Pt[], style: StyleValues, env: ToolEnv, long: boolean): string[] {
  const entryP = priceAt(anchors[0] ?? { x: 0, y: 0 }, env);
  const targetP = priceAt(anchors[1] ?? { x: 0, y: 0 }, env);
  const stopP = priceAt(anchors[2] ?? { x: 0, y: 0 }, env);
  const decimals = precision(env);
  const accountSize = styleNumber(style, 'accountSize', 1000);
  const riskValue = styleNumber(style, 'risk', 25);
  const riskAmount = styleString(style, 'riskDisplayMode', 'percents') === 'money' ? riskValue : (accountSize * riskValue) / 100;
  const stopDistance = Math.abs(entryP - stopP);
  const reward = Math.abs(targetP - entryP);
  const qty = stopDistance > 0 ? (riskAmount / stopDistance) * styleNumber(style, 'lotSize', 1) : 0;
  const qtyDecimals = qtyPrecision(style, env);
  const rows: string[] = [`${long ? 'LONG' : 'SHORT'}  risk ${fmtNumber(riskAmount, 2)}`];
  const wanted = styleFlags(style, 'positionStats');
  if (wanted.includes('target')) rows.push(`target ${fmtPrice(targetP, decimals)}`);
  if (wanted.includes('stop')) rows.push(`stop ${fmtPrice(stopP, decimals)}`);
  if (wanted.includes('points')) rows.push(`points ${fmtPrice(reward, decimals)}`);
  if (wanted.includes('qty')) rows.push(`qty ${fmtSize(qty, qtyDecimals)}`);
  if (wanted.includes('pnl')) rows.push(`pnl ${fmtNumber(qty * reward, 2)}`);
  if (wanted.includes('riskReward')) rows.push(`R:R ${stopDistance > 0 ? (reward / stopDistance).toFixed(2) : '—'}`);
  return rows;
}

function qtyPrecision(style: StyleValues, env: ToolEnv): number {
  const raw = styleString(style, 'qtyPrecision', 'auto');
  if (raw === 'auto') return env.instrument?.qtyPrecision ?? 2;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.round(parsed) : 2;
}

/* ------------------------------------------------------------------ stylized arrows */

/**
 * Geometry of one stylized arrow. The shipped preset for the group is a single
 * `A(color, highlight) = {color, highlight, lineWidth: 2}` and the shipped property
 * map carries no bend or curvature key, so the curve belongs to the tool, not to the
 * style: one renderer reads this record instead of each tool carrying its own path.
 */
interface StylizedShape {
  /** Straight shaft, a shaft bowed by a fraction of its span, or the Burj dome. */
  shaft: 'straight' | { bend: number } | 'hump';
  head: { kind: 'filled' | 'open' | 'notched' | 'ring' | 'none'; length: number; halfAngle?: number };
  /** Gap left between the shaft end and the tip, px (Whisper parks its ring). */
  tipGap?: number;
  /** Dash overriding `lineStyle`; `scaledByWidth` uses the line width, as Whisper does. */
  dash?: { pattern: [number, number]; scaledByWidth?: boolean };
  /** Fade the shaft in towards the head, the Momentum look. */
  fade?: boolean;
}

const HEAD_HALF_ANGLE = Math.PI / 6;

function arrowHeadPrims(tip: Pt, angle: number, head: StylizedShape['head'], color: string, width: number): Prim[] {
  if (head.kind === 'ring') return ringPrimitives(tip, head.length, color, 1.5);
  if (head.kind === 'none') return [];
  const half = head.halfAngle ?? HEAD_HALF_ANGLE;
  if (head.kind === 'open') {
    return [
      segment(polar(tip, angle + half, head.length), tip, color, width, []),
      segment(tip, polar(tip, angle - half, head.length), color, width, []),
    ];
  }
  if (head.kind === 'notched') {
    return [
      polygon(
        [tip, offsetAlong(tip, angle, -head.length, 10), offsetAlong(tip, angle, -(head.length - 7), 0), offsetAlong(tip, angle, -head.length, -10)],
        color,
      ),
    ];
  }
  return [polygon([tip, polar(tip, angle + half, head.length), polar(tip, angle - half, head.length)], color)];
}

/** How far the shaft stops short of the tip, per head shape. */
function shaftStop(shape: StylizedShape): number {
  if (shape.head.kind === 'filled') return shape.head.length * 0.8;
  if (shape.head.kind === 'notched') return shape.head.length - 7;
  return shape.tipGap ?? 0;
}

function stylizedPrimitives(anchors: Pt[], style: StyleValues, _env: ToolEnv, shape: StylizedShape): Prim[] {
  const tail = anchors[0];
  const tip = anchors[1];
  if (!tail || !tip) return [];
  const { color, width, dash } = stroke(style);
  const pattern = shape.dash
    ? shape.dash.scaledByWidth
      ? [shape.dash.pattern[0] * width, shape.dash.pattern[1] * width]
      : [...shape.dash.pattern]
    : dash;
  const angle = Math.atan2(tip.y - tail.y, tip.x - tail.x);
  const end = polar(tip, angle, -shaftStop(shape));
  const out: Prim[] = [];
  let headAngle = angle;

  if (shape.shaft === 'hump') {
    // Pump and dump: up over an apex half the horizontal span above the tail, then down.
    const apex: Pt = { x: (tail.x + tip.x) / 2, y: tail.y - 0.5 * Math.abs(tip.x - tail.x) };
    const left: Pt = { x: (tail.x + apex.x) / 2, y: (tail.y + apex.y) / 2 - 0.525 * Math.abs(apex.y - tail.y) };
    const right: Pt = { x: (apex.x + tip.x) / 2, y: (apex.y + tip.y) / 2 - 0.4725 * Math.abs(tip.y - apex.y) };
    out.push(...curvePrimitives(tail, left, apex, color, width, pattern));
    out.push(...curvePrimitives(apex, right, tip, color, width, pattern));
    headAngle = Math.atan2(2 * (tip.y - right.y), 2 * (tip.x - right.x));
  } else if (typeof shape.shaft === 'object') {
    const bend = shape.shaft.bend * Math.hypot(tip.x - tail.x, tip.y - tail.y);
    const control = offsetAlong({ x: (tail.x + tip.x) / 2, y: (tail.y + tip.y) / 2 }, angle, 0, bend);
    out.push(...curvePrimitives(tail, control, tip, color, width, pattern));
    headAngle = Math.atan2(2 * (tip.y - control.y), 2 * (tip.x - control.x));
  } else if (shape.fade) {
    out.push(...fadedPrimitives(tail, end, color, width));
  } else {
    out.push(segment(tail, end, color, width, pattern));
  }

  out.push(...arrowHeadPrims(tip, headAngle, shape.head, color, width));
  return styleBoolean(style, 'highlight', false) ? withHighlightGlow(out, color) : out;
}

/* ------------------------------------------------------------------ branch arrows */

/** Side a branch bows to: the shipped forks bow away from the trunk, not to one side. */
function branchSides(from: Pt, to: Pt): { top: number; bottom: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dy) > Math.abs(dx)) {
    const side = dy > 0 ? 1 : -1;
    return { top: side, bottom: -side };
  }
  const side = dx > 0 ? -1 : 1;
  return { top: side, bottom: side };
}

const BRANCH_HEAD: StylizedShape['head'] = { kind: 'filled', length: 22, halfAngle: HEAD_HALF_ANGLE };

/** One branch: straight, or bowed by `side`, capped with the group's arrow head. */
function branchPrims(from: Pt, to: Pt, color: string, width: number, side: number | null): Prim[] {
  const out: Prim[] = [];
  let angle = Math.atan2(to.y - from.y, to.x - from.x);
  if (side === null) out.push(segment(from, polar(to, angle, -22 * 0.8), color, width, []));
  else {
    const control = branchControl(from, to, side);
    out.push(...curvePrimitives(from, control, polar(to, angle, -22 * 0.8), color, width, []));
    angle = Math.atan2(2 * (to.y - control.y), 2 * (to.x - control.x));
  }
  out.push(...arrowHeadPrims(to, angle, BRANCH_HEAD, color, width));
  return out;
}

/** Tag drawn past the end of a ThreePaths branch, in that branch's own colour. */
function branchLabel(text: string, at: Pt, angle: number, color: string): Prim {
  return {
    kind: 'label',
    at: polar(at, angle, 30),
    text,
    options: { color, font: `12px ${fontStack('system')}`, align: 'center', baseline: 'middle' },
  };
}

/* ------------------------------------------------------------------ pattern geometry */

/** Shipped label size for pattern vertices: the pattern presets carry no font keys. */
const PATTERN_FONT_SIZE = 14;

/** Points along a circular arc, sampled so the shared hit test follows the curve. */
function arcPoints(center: Pt, radius: number, from: number, to: number, steps: number): Pt[] {
  const out: Pt[] = [];
  for (let step = 0; step <= steps; step += 1) out.push(polar(center, from + ((to - from) * step) / steps, radius));
  return out;
}

/** Where two legs cross in pane pixels; null when they are parallel. */
function intersect(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const cross = (b.x - a.x) * (c.y - d.y) - (b.y - a.y) * (c.x - d.x);
  if (Math.abs(cross) < 1e-6) return null;
  const first = a.x * b.y - a.y * b.x;
  const second = c.x * d.y - c.y * d.x;
  return {
    x: (first * (c.x - d.x) - (b.x - a.x) * second) / cross,
    y: (first * (c.y - d.y) - (b.y - a.y) * second) / cross,
  };
}

/** How far along `a`→`b` `at` lies: outside [0, 1] means past either end. */
function alongSegment(at: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  if (length === 0) return 0;
  return ((at.x - a.x) * dx + (at.y - a.y) * dy) / length;
}

/** The corner of a mouth that sits farther from the apex, as their triangle picks it. */
function farCorner(a: Pt, b: Pt, apex: Pt): Pt {
  return Math.hypot(a.x - apex.x, a.y - apex.y) >= Math.hypot(b.x - apex.x, b.y - apex.y) ? a : b;
}

/** Price distance between two vertices: the shipped ratios are price heights, not pixels. */
function priceDistance(anchors: Pt[], from: number, to: number, env: ToolEnv): number {
  const a = anchors[from];
  const b = anchors[to];
  if (!a || !b) return 0;
  return Math.abs(env.price.fromY(a.y) - env.price.fromY(b.y));
}

/** One shipped ratio: a leg's price height over the height of the leg it corrects. */
interface RatioSpec {
  from: number;
  to: number;
  height: readonly [number, number];
  base: readonly [number, number];
}

interface Ratio {
  from: number;
  to: number;
  ratio: number;
}

function ratiosFrom(spec: readonly RatioSpec[]): (anchors: Pt[], env: ToolEnv) => Ratio[] {
  return (anchors, env) => {
    const out: Ratio[] = [];
    for (const entry of spec) {
      const from = anchors[entry.from];
      const to = anchors[entry.to];
      if (!from || !to) continue;
      const base = priceDistance(anchors, entry.base[0], entry.base[1], env);
      if (base <= 0) continue;
      out.push({ from: entry.from, to: entry.to, ratio: priceDistance(anchors, entry.height[0], entry.height[1], env) / base });
    }
    return out;
  };
}

/**
 * Vertex tag: the shipped filled pill for the pattern tools, the bare number for the
 * Elliott waves, whose shipped renderer circles it instead.
 */
/**
 * Pixels per bar below which a pattern's vertex names and leg ratios stop being
 * information. A vertex pill is about 17 px wide and a ratio pill about 34 px, so below this
 * step they would sit on top of each other; an eight-anchor wave row becomes one smear of
 * ink over the tape.
 */
const MIN_LABEL_BAR_STEP = 3.5;

function vertexLabel(text: string, at: Pt, above: boolean, style: StyleValues, circled: boolean): Prim {
  const { color } = stroke(style);
  const size = styleNumber(style, 'fontSize', PATTERN_FONT_SIZE);
  const offset = size / 2 + 8;
  const font = fontCss(style);
  return {
    kind: 'label',
    auto: true,
    at: { x: at.x, y: at.y + (above ? -offset : offset) },
    text,
    options: circled
      ? { color, font, align: 'center', baseline: 'middle' }
      : { color: '#0f1317', font, align: 'center', baseline: 'middle', background: color, padX: 5, padY: 3 },
  };
}

/** A vertex is labelled above when it is a local high and below when it is a low. */
function isHighPoint(anchors: Pt[], index: number): boolean {
  const at = anchors[index];
  if (!at) return false;
  const before = anchors[index - 1]?.y ?? at.y;
  const after = anchors[index + 1]?.y ?? at.y;
  return at.y <= before && at.y <= after;
}

interface PatternSpec {
  /** Shipped vertex names; the shipped loop labels only as many anchors as it has names. */
  labels: readonly string[];
  /** Elliott waves: the number carries no plate. */
  circled?: boolean;
  /** Ordered points the legs run through; a control anchor stays off the polyline. */
  legs?: (anchors: Pt[]) => Pt[];
  /** Translucent regions the legs enclose, as the shipped fill pass draws them. */
  regions?: (anchors: Pt[]) => Pt[][];
  /** Dotted connectors printed with their price ratio. */
  ratios?: (anchors: Pt[], env: ToolEnv) => Ratio[];
  /** Dotted geometry outside the legs: a triangle's apex lines, a neckline. */
  extras?: (anchors: Pt[], style: StyleValues) => Prim[];
}

/**
 * One renderer for every pattern and wave tool: legs through the anchors, the regions
 * they enclose, any extra dotted geometry, then vertex names and leg ratios. The tools
 * differ only by their shipped label sets, ratio tables and fill shapes.
 */
function patternPrimitives(anchors: Pt[], style: StyleValues, env: ToolEnv, spec: PatternSpec): Prim[] {
  const out: Prim[] = [];
  if (anchors.length < 2) return out;
  const { color, width, dash } = stroke(style);
  if (spec.regions && styleBoolean(style, 'fillBackground', true)) {
    const tint = withOpacity(styleColor(style, 'fillColor', color), styleNumber(style, 'backgroundOpacity', 10));
    for (const region of spec.regions(anchors)) if (region.length >= 3) out.push(polygon(region, tint));
  }
  const legs = spec.legs ? spec.legs(anchors) : anchors;
  for (let i = 1; i < legs.length; i += 1) {
    const from = legs[i - 1];
    const to = legs[i];
    if (from && to) out.push(segment(from, to, color, width, dash));
  }
  out.push(...(spec.extras?.(anchors, style) ?? []));
  if (!styleBoolean(style, 'showLabels', true)) return out;
  const connectors = spec.ratios ? spec.ratios(anchors, env) : [];
  const dotted = lineDash('dotted');
  for (const connector of connectors) {
    const from = anchors[connector.from];
    const to = anchors[connector.to];
    if (from && to) out.push(segment(from, to, color, 1, dotted));
  }
  // The geometry still reads at a glance when the bars are thinner than a label; its text
  // does not, so the pills and vertex names are left out until the zoom carries them.
  if (env.x.barStep < MIN_LABEL_BAR_STEP) return out;
  for (let i = 0; i < anchors.length && i < spec.labels.length; i += 1) {
    const text = spec.labels[i];
    const at = anchors[i];
    if (!text || !at) continue;
    out.push(vertexLabel(text, at, isHighPoint(anchors, i), style, spec.circled === true));
  }
  for (const connector of connectors) {
    const from = anchors[connector.from];
    const to = anchors[connector.to];
    if (from && to) out.push(vertexLabel(connector.ratio.toFixed(3), mid(from, to), true, style, false));
  }
  return out;
}

/** The shipped pattern fill: triangles (0,1,2), (2,3,4)… along the legs. */
function legTriangles(anchors: Pt[]): Pt[][] {
  const out: Pt[][] = [];
  for (let i = 0; i + 2 < anchors.length; i += 2) {
    const a = anchors[i];
    const b = anchors[i + 1];
    const c = anchors[i + 2];
    if (a && b && c) out.push([a, b, c]);
  }
  return out;
}

/**
 * Where the triangle's two converging lines meet. Their renderer computes it from the
 * four corners and drops it when it falls inside a leg or drifts far off the figure.
 */
function triangleApex(anchors: Pt[]): Pt | null {
  const [p0, p1, p2, p3] = anchors;
  if (!p0 || !p1 || !p2 || !p3) return null;
  const apex = intersect(p0, p2, p1, p3);
  if (!apex) return null;
  const onFirst = alongSegment(apex, p0, p2);
  const onSecond = alongSegment(apex, p1, p3);
  if ((onFirst > 0 && onFirst < 1) || (onSecond > 0 && onSecond < 1)) return null;
  let span = 0;
  for (let i = 0; i < 4; i += 1) {
    for (let j = i + 1; j < 4; j += 1) {
      const a = anchors[i];
      const b = anchors[j];
      if (a && b) span = Math.max(span, Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  const centre = { x: (p0.x + p1.x + p2.x + p3.x) / 4, y: (p0.y + p1.y + p2.y + p3.y) / 4 };
  if (Math.hypot(apex.x - centre.x, apex.y - centre.y) > 12 * span + 1) return null;
  return apex;
}

/**
 * The triangle's fifth anchor is the apex the converging lines aim at. Their tool has
 * four corners and computes that point; here the user places it, and a placed point
 * that cannot be reached from the legs falls back to the computed one.
 */
function triangleApexOf(anchors: Pt[]): Pt | null {
  const corners = anchors.slice(0, 4);
  const placed = anchors[4];
  if (placed && corners.length === 4) {
    const [p0, p1, p2, p3] = corners;
    if (p0 && p1 && p2 && p3) {
      const onFirst = alongSegment(placed, p0, p2);
      const onSecond = alongSegment(placed, p1, p3);
      if (!((onFirst > 0 && onFirst < 1) || (onSecond > 0 && onSecond < 1))) return placed;
    }
  }
  return triangleApex(corners);
}

function triangleRegions(anchors: Pt[]): Pt[][] {
  const [p0, p1, p2, p3] = anchors;
  if (!p0 || !p1 || !p2 || !p3) return [];
  const apex = triangleApexOf(anchors);
  if (!apex) return [[p0, p2, p3, p1]];
  return [[farCorner(p0, p2, apex), farCorner(p1, p3, apex), apex]];
}

function triangleExtras(anchors: Pt[], style: StyleValues): Prim[] {
  const [p0, p1, p2, p3] = anchors;
  if (!p0 || !p1 || !p2 || !p3) return [];
  const { color, width } = stroke(style);
  const dotted = lineDash('dotted');
  const apex = triangleApexOf(anchors);
  if (!apex) return [segment(p0, p2, color, width, dotted), segment(p1, p3, color, width, dotted)];
  return [
    segment(farCorner(p0, p2, apex), apex, color, width, dotted),
    segment(farCorner(p1, p3, apex), apex, color, width, dotted),
  ];
}

/** Where the outer legs meet the neckline between the two shoulder troughs. */
function neckCrossings(anchors: Pt[]): { left: Pt | null; right: Pt | null } {
  const [p0, p1, p2, p4, p5, p6] = anchors;
  const left = p0 && p1 && p2 && p4 ? intersect(p2, p4, p0, p1) : null;
  const right = p2 && p4 && p5 && p6 && anchors.length >= 7 ? intersect(p2, p4, p5, p6) : null;
  return { left, right };
}

/** Head, left shoulder wedge, right shoulder wedge — the three shipped fill regions. */
function headShouldersRegions(anchors: Pt[]): Pt[][] {
  const [, p1, p2, p3, p4, p5] = anchors;
  if (!p1 || !p2 || !p3 || !p4 || !p5) return [];
  const out: Pt[][] = [[p2, p3, p4]];
  const { left, right } = neckCrossings(anchors);
  if (left) out.push([left, p1, p2]);
  if (right && p5) out.push([p4, p5, right]);
  return out;
}

function headShouldersExtras(anchors: Pt[], style: StyleValues): Prim[] {
  const [, , p2, , p4] = anchors;
  if (!p2 || !p4) return [];
  const { color, width } = stroke(style);
  const { left, right } = neckCrossings(anchors);
  return [segment(left ?? p2, right ?? p4, color, width, lineDash('dotted'))];
}

/* ------------------------------------------------------------------ cycle geometry */

/**
 * Repeat offsets of a cycle: every whole period from the first anchor, in pixels, over
 * the plot. `toward` keeps the shipped behaviour of running the repeats only the side the
 * second anchor points to.
 */
function cycleOffsets(first: Pt, period: number, plot: PlotRect, toward: number): number[] {
  const step = Math.abs(period);
  let low = Math.floor((plot.left - first.x) / step) - 1;
  let high = Math.ceil((plot.right - first.x) / step) + 1;
  if (toward > 0) low = Math.max(low, 0);
  if (toward < 0) high = Math.min(high, 0);
  const out: number[] = [];
  for (let k = low; k <= high; k += 1) out.push(k * step * Math.sign(period || 1));
  return out;
}

/* ------------------------------------------------------------------ the tools */

const LINE_STYLE_KEYS = ['color', 'lineWidth', 'lineStyle'] as const;

const POSITION_STYLE_KEYS = [
  'profitColor',
  'stopColor',
  'lineWidth',
  'lineStyle',
  'accountSize',
  'risk',
  'riskDisplayMode',
  'lotSize',
  'qtyPrecision',
  'positionStats',
  'compactStats',
] as const;

const POSITION_DEFAULTS: StyleValues = {
  profitColor: '#00C2A8',
  stopColor: '#ff3232',
  accountSize: 1000,
  risk: 25,
  riskDisplayMode: 'percents',
  lotSize: 1,
  qtyPrecision: 'auto',
  positionStats: ['target', 'stop', 'qty', 'pnl', 'riskReward'],
  compactStats: false,
  lineWidth: 2,
  lineStyle: 'solid',
};

/** The four directional marks: one glyph, four directions, the shipped pixel shapes. */
const DIRECTIONAL_MARK_TOOLS: readonly DrawingToolDefinition[] = (
  [
    { id: 'ArrowMarkLeft', label: 'Arrow Mark Left', glyph: '\u2190', direction: 'left' },
    { id: 'ArrowMarkRight', label: 'Arrow Mark Right', glyph: '\u2192', direction: 'right' },
    { id: 'ArrowMarkTop', label: 'Arrow Mark Top', glyph: '\u2191', direction: 'top' },
    { id: 'ArrowMarkBottom', label: 'Arrow Mark Bottom', glyph: '\u2193', direction: 'bottom' },
  ] as const
).map(
  (mark): DrawingToolDefinition => ({
    id: mark.id,
    label: mark.label,
    group: 'arrows',
    sectionKey: 'arrows-classic',
    anchorCount: 1,
    anchorAxes: ['xy'],
    glyph: mark.glyph,
    hint: `Click where the ${mark.direction} marker should sit`,
    styleKeys: ['color'],
    styleDefaults: {},
    primitives: (anchors, style) => {
      const at = anchors[0];
      if (!at) return [];
      return [markGlyph(at, mark.direction, styleColor(style, 'color'))];
    },
  }),
);

/**
 * The note tools share the shipped note preset `{fontColor, fontFamily, fontSize,
 * fontStyle, textPosition, color}`: a `color` plate at 15%, a `color` border and
 * `fontColor` ink. They differ in where the plate sits and whether it carries a tail.
 */
const NOTE_TOOLS: readonly DrawingToolDefinition[] = (
  [
    { id: 'Note', label: 'Note', glyph: '\u270e', hint: 'Click where the note should sit, then type it', above: 0, tail: false, placeholder: 'note' },
    { id: 'AnchoredNote', label: 'Anchored Note', glyph: '\u2751', hint: 'Click where the note should pin, then type it', above: 0, tail: false, placeholder: 'note' },
    { id: 'Callout', label: 'Callout', glyph: '\u275d', hint: 'Click the spot the bubble points at, then type it', above: 30, tail: true, placeholder: 'callout' },
  ] as const
).map(
  (note): DrawingToolDefinition => ({
    id: note.id,
    label: note.label,
    group: 'annotations',
    sectionKey: 'textAndNotes',
    anchorCount: 1,
    anchorAxes: ['xy'],
    glyph: note.glyph,
    hint: note.hint,
    opensEditorOnPlace: true,
    styleKeys: ['text', 'fontColor', 'fontFamily', 'fontSize', 'fontStyle', 'textPosition', 'color'],
    styleDefaults: {
      fontColor: '#4DA3FF',
      fontFamily: 'system',
      fontSize: 24,
      fontStyle: 'normal',
      textPosition: 'center',
      color: '#4DA3FF',
    },
    primitives: (anchors, style, env) => {
      const at = anchors[0];
      if (!at) return [];
      const color = styleColor(style, 'color');
      return bubblePrimitives(styleString(style, 'text') || note.placeholder, style, env, {
        plate: withOpacity(color, 15),
        border: color,
        ink: styleColor(style, 'fontColor', '#4DA3FF'),
        center: { x: at.x, y: at.y - note.above },
        align: alignOf(style),
        padX: 10,
        padY: 6,
        tailTo: note.tail ? at : undefined,
      });
    },
  }),
);

/**
 * Price tags: the shipped `{color, fontColor, fontSize}` preset, a leader from the
 * anchor to a solid `color` plate. `PriceNote` adds the shipped `lineWidth` and
 * `lineStyle` keys for that leader.
 */
const PRICE_TAG_TOOLS: readonly DrawingToolDefinition[] = (
  [
    { id: 'PriceLabel', label: 'Price Label', glyph: '\u00a4', hint: 'Click the price to tag', quickBar: [], line: false, placeholder: 'label' },
    { id: 'PriceNote', label: 'Price Note', glyph: '$', hint: 'Click the price to annotate', quickBar: ['color', 'fontColor', 'fontSize'], line: true, placeholder: 'note' },
  ] as const
).map(
  (tag): DrawingToolDefinition => ({
    id: tag.id,
    label: tag.label,
    group: 'annotations',
    sectionKey: 'labels',
    anchorCount: 1,
    anchorAxes: ['xy'],
    glyph: tag.glyph,
    hint: tag.hint,
    quickBar: tag.quickBar,
    opensEditorOnPlace: true,
    styleKeys: tag.line ? ['text', 'color', 'fontColor', 'fontSize', 'lineWidth', 'lineStyle'] : ['text', 'color', 'fontColor', 'fontSize'],
    styleDefaults: { color: '#4DA3FF', fontColor: '#FFFFFF', fontSize: 12, lineWidth: 1.5, lineStyle: 'solid' },
    primitives: (anchors, style, env) => {
      const at = anchors[0];
      if (!at) return [];
      const color = styleColor(style, 'color', '#4DA3FF');
      const center = { x: at.x + 46, y: at.y - 26 };
      return [
        segment(at, center, color, styleNumber(style, 'lineWidth', 1.5), lineDash(styleString(style, 'lineStyle', 'solid'))),
        ...bubblePrimitives(styleString(style, 'text') || tag.placeholder, style, env, {
          plate: color,
          ink: styleColor(style, 'fontColor', '#FFFFFF'),
          center,
          align: 'center',
          padX: 10,
          padY: 5,
        }),
      ];
    },
  }),
);

/**
 * The shipped pattern preset `qt`: a line, a fill of the same colour at 10%, and vertex
 * labels. The wave tools use the same keys with the fill switched off, as their `Jt` does.
 */
const PATTERN_STYLE_KEYS = [
  'color',
  'lineWidth',
  'lineStyle',
  'fillBackground',
  'fillColor',
  'backgroundOpacity',
  'showLabels',
] as const;

const PATTERN_DEFAULTS: StyleValues = {
  color: '#4DA3FF',
  lineWidth: 2,
  lineStyle: 'solid',
  fillBackground: true,
  fillColor: '#4DA3FF',
  backgroundOpacity: 10,
  showLabels: true,
};

const ELLIOTT_DEFAULTS: StyleValues = { ...PATTERN_DEFAULTS, fillBackground: false };

/** The shipped `Rt` preset the cycle tools carry: a line and nothing else. */
const CYCLE_STYLE_KEYS = LINE_STYLE_KEYS;
const CYCLE_DEFAULTS: StyleValues = { color: '#4DA3FF', lineWidth: 2, lineStyle: 'solid' };
/** The shipped `Ut` preset `TimeCycles` carries: the same line with a 15% fill. */
const TIME_CYCLE_STYLE_KEYS = ['color', 'lineWidth', 'lineStyle', 'fillBackground', 'fillColor', 'backgroundOpacity'] as const;
const TIME_CYCLE_DEFAULTS: StyleValues = {
  ...CYCLE_DEFAULTS,
  fillBackground: true,
  fillColor: '#4DA3FF',
  backgroundOpacity: 15,
};

/** Every anchor of a pattern is free: turns sit wherever the market made them. */
function freeAxes(count: number): ('x' | 'y' | 'xy')[] {
  return Array.from({ length: count }, () => 'xy' as const);
}

/** Harmonic ratios the shipped renderer prints on dotted connectors between non-adjacent turns. */
const XABCD_RATIOS: readonly RatioSpec[] = [
  { from: 0, to: 2, height: [1, 2], base: [0, 1] },
  { from: 1, to: 3, height: [2, 3], base: [1, 2] },
  { from: 2, to: 4, height: [3, 4], base: [2, 3] },
  { from: 0, to: 4, height: [1, 4], base: [0, 1] },
];

const ABCD_RATIOS: readonly RatioSpec[] = [
  { from: 0, to: 2, height: [1, 2], base: [0, 1] },
  { from: 1, to: 3, height: [2, 3], base: [1, 2] },
];

/** The first drive pair only: the shipped second connector needs a sixth turn. */
const THREE_DRIVES_RATIOS: readonly RatioSpec[] = [{ from: 1, to: 3, height: [2, 3], base: [1, 2] }];

interface PatternEntry {
  id: string;
  label: string;
  glyph: string;
  hint: string;
  anchorCount: number;
  styleKeys: readonly string[];
  styleDefaults: StyleValues;
  spec: PatternSpec;
}

/**
 * The shipped pattern tools. Anchor counts come from the shipped identity table, and the
 * vertex names, fills and ratios come from the shipped renderers, so `CypherPattern` really
 * is `XABCDPattern` under the hood and `ThreeDrivesPattern` really ships without labels.
 */
const PATTERN_ENTRIES: readonly PatternEntry[] = [
  {
    id: 'XABCDPattern',
    label: 'XABCD pattern',
    glyph: '✕',
    hint: 'Click the five turns X, A, B, C, D',
    anchorCount: 5,
    styleKeys: PATTERN_STYLE_KEYS,
    styleDefaults: PATTERN_DEFAULTS,
    spec: { labels: ['X', 'A', 'B', 'C', 'D'], regions: legTriangles, ratios: ratiosFrom(XABCD_RATIOS) },
  },
  {
    id: 'CypherPattern',
    label: 'Cypher pattern',
    glyph: '❖',
    hint: 'Click the five turns X, A, B, C, D',
    anchorCount: 5,
    styleKeys: PATTERN_STYLE_KEYS,
    styleDefaults: PATTERN_DEFAULTS,
    spec: { labels: ['X', 'A', 'B', 'C', 'D'], regions: legTriangles, ratios: ratiosFrom(XABCD_RATIOS) },
  },
  {
    id: 'HeadAndShoulders',
    label: 'Head and shoulders',
    glyph: '⋀',
    hint: 'Click the seven turns over both shoulders and the head',
    anchorCount: 7,
    styleKeys: PATTERN_STYLE_KEYS,
    styleDefaults: PATTERN_DEFAULTS,
    spec: {
      labels: ['', 'Left Shoulder', '', 'Head', '', 'Right Shoulder', ''],
      regions: headShouldersRegions,
      extras: headShouldersExtras,
    },
  },
  {
    id: 'ABCDPattern',
    label: 'ABCD pattern',
    glyph: '⌁',
    hint: 'Click the four turns A, B, C, D',
    anchorCount: 4,
    styleKeys: PATTERN_STYLE_KEYS,
    styleDefaults: PATTERN_DEFAULTS,
    spec: { labels: ['A', 'B', 'C', 'D'], regions: legTriangles, ratios: ratiosFrom(ABCD_RATIOS) },
  },
  {
    id: 'TrianglePattern',
    label: 'Triangle pattern',
    glyph: '△',
    hint: 'Click the four corners, then where the two lines meet',
    anchorCount: 5,
    styleKeys: PATTERN_STYLE_KEYS,
    styleDefaults: PATTERN_DEFAULTS,
    spec: {
      labels: ['A', 'B', 'C', 'D'],
      legs: (anchors) => anchors.slice(0, 4),
      regions: triangleRegions,
      extras: triangleExtras,
    },
  },
  {
    id: 'ThreeDrivesPattern',
    label: 'Three drives',
    glyph: '⌇',
    hint: 'Click each turn of the three drives',
    anchorCount: 5,
    // The shipped `Yt` preset carries no fill keys, and the shipped renderer fills nothing.
    styleKeys: ['color', 'lineWidth', 'lineStyle', 'showLabels'],
    styleDefaults: { color: '#4DA3FF', lineWidth: 2, lineStyle: 'solid', showLabels: true },
    spec: { labels: ['', '', '', '', ''], ratios: ratiosFrom(THREE_DRIVES_RATIOS) },
  },
];

const PATTERN_TOOLS: readonly DrawingToolDefinition[] = PATTERN_ENTRIES.map((entry): DrawingToolDefinition => ({
  id: entry.id,
  label: entry.label,
  group: 'patterns',
  sectionKey: 'chartPatterns',
  anchorCount: entry.anchorCount,
  anchorAxes: freeAxes(entry.anchorCount),
  glyph: entry.glyph,
  hint: entry.hint,
  styleKeys: entry.styleKeys,
  styleDefaults: entry.styleDefaults,
  primitives: (anchors, style, env) => patternPrimitives(anchors, style, env, entry.spec),
}));

/**
 * The shipped wave tools: one renderer, per-tool leg counts and vertex names. The shipped
 * label list bounds which anchors carry a name, so the combo tools run past theirs unlabeled.
 */
const ELLIOTT_TOOLS: readonly DrawingToolDefinition[] = (
  [
    { id: 'ElliottImpulse', label: 'Elliott impulse', glyph: '⑤', anchorCount: 6, hint: 'Click the six wave turns from 0 to 5', labels: ['0', '1', '2', '3', '4', '5'] },
    { id: 'ElliottCorrection', label: 'Elliott correction', glyph: '③', anchorCount: 4, hint: 'Click the four turns of the A-B-C correction', labels: ['0', 'A', 'B', 'C'] },
    { id: 'ElliottTriangle', label: 'Elliott triangle', glyph: '◬', anchorCount: 6, hint: 'Click the six turns of the A-B-C-D-E triangle', labels: ['0', 'A', 'B', 'C', 'D', 'E'] },
    { id: 'ElliottDoubleCombo', label: 'Elliott double combo', glyph: '⧖', anchorCount: 7, hint: 'Click the seven turns of the double three', labels: ['0', 'W', 'X', 'Y'] },
    { id: 'ElliottTripleCombo', label: 'Elliott triple combo', glyph: '⧗', anchorCount: 8, hint: 'Click the eight turns of the triple three', labels: ['0', 'W', 'X', 'Y', 'X', 'Z'] },
  ] as const
).map(
  (wave): DrawingToolDefinition => ({
    id: wave.id,
    label: wave.label,
    group: 'patterns',
    sectionKey: 'elliottWaves',
    anchorCount: wave.anchorCount,
    anchorAxes: freeAxes(wave.anchorCount),
    glyph: wave.glyph,
    hint: wave.hint,
    styleKeys: PATTERN_STYLE_KEYS,
    styleDefaults: ELLIOTT_DEFAULTS,
    primitives: (anchors, style, env) => patternPrimitives(anchors, style, env, { labels: wave.labels, circled: true }),
  }),
);

/**
 * The shipped cycle tools: two anchors that set a period, then geometry repeated across the
 * whole pane. Their anchors are time, so a period in bars survives pan and zoom.
 */
const CYCLE_TOOLS: readonly DrawingToolDefinition[] = [
  {
    id: 'CyclicLines',
    label: 'Cyclic lines',
    group: 'patterns',
    sectionKey: 'cycles',
    anchorCount: 2,
    anchorAxes: ['xy', 'xy'],
    glyph: '⋮',
    hint: 'Click two bars a cycle apart; the lines repeat that spacing',
    styleKeys: CYCLE_STYLE_KEYS,
    styleDefaults: CYCLE_DEFAULTS,
    primitives: (anchors, style, env) => {
      const first = anchors[0];
      if (!first) return [];
      const second = anchors[1] ?? first;
      const { color, width, dash } = stroke(style);
      const period = second.x - first.x;
      if (Math.abs(period) < 2) {
        return [segment({ x: first.x, y: env.plot.top }, { x: first.x, y: env.plot.bottom }, color, width, dash)];
      }
      return cycleOffsets(first, period, env.plot, Math.sign(period)).map((offset) => {
        const x = first.x + offset;
        return segment({ x, y: env.plot.top }, { x, y: env.plot.bottom }, color, width, dash);
      });
    },
  },
  {
    id: 'TimeCycles',
    label: 'Time cycles',
    group: 'patterns',
    sectionKey: 'cycles',
    anchorCount: 2,
    // The second anchor only ever sets the period: the shipped tool pins its price back
    // onto the first anchor every time it moves.
    anchorAxes: ['xy', 'x'],
    glyph: '◠',
    hint: 'Click two bars a cycle apart; half-circles repeat above the level',
    styleKeys: TIME_CYCLE_STYLE_KEYS,
    styleDefaults: TIME_CYCLE_DEFAULTS,
    primitives: (anchors, style, env) => {
      const first = anchors[0];
      if (!first) return [];
      const second = anchors[1] ?? first;
      const { color, width, dash } = stroke(style);
      const period = Math.abs(second.x - first.x);
      if (period < 2) {
        return [segment({ x: first.x, y: env.plot.top }, { x: first.x, y: env.plot.bottom }, color, width, dash)];
      }
      // The arcs tile outward from whichever anchor sits leftmost, as their tool does.
      const origin = { x: Math.min(first.x, second.x), y: first.y };
      const radius = period / 2;
      const fill = styleBoolean(style, 'fillBackground', true)
        ? withOpacity(styleColor(style, 'fillColor', color), styleNumber(style, 'backgroundOpacity', 15))
        : '';
      const out: Prim[] = [];
      for (const offset of cycleOffsets(origin, period, env.plot, 0)) {
        const centre = { x: origin.x + offset + radius, y: origin.y };
        const arc = arcPoints(centre, radius, Math.PI, Math.PI * 2, 24);
        if (fill) out.push(polygon(arc, fill));
        for (let i = 1; i < arc.length; i += 1) {
          const from = arc[i - 1];
          const to = arc[i];
          if (from && to) out.push(segment(from, to, color, width, dash));
        }
      }
      return out;
    },
  },
  {
    id: 'SineLine',
    label: 'Sine line',
    group: 'patterns',
    sectionKey: 'cycles',
    anchorCount: 2,
    anchorAxes: ['xy', 'xy'],
    glyph: '∿',
    hint: 'Click the two ends of a half cycle; the wave runs on past them',
    styleKeys: CYCLE_STYLE_KEYS,
    styleDefaults: CYCLE_DEFAULTS,
    primitives: (anchors, style, env) => {
      const first = anchors[0];
      if (!first) return [];
      const second = anchors[1] ?? first;
      const { color, width, dash } = stroke(style);
      // The wave is anchored on the left end, so flipping the click order cannot flip it.
      const [left, right] = first.x <= second.x ? [first, second] : [second, first];
      const half = right.x - left.x;
      if (half < 2) return [segment(first, second, color, width, dash)];
      // Sampled in price space, so the curve keeps its shape on a log price scale.
      const start = env.price.fromY(left.y);
      const end = env.price.fromY(right.y);
      const centre = (start + end) / 2;
      const amplitude = (start - end) / 2;
      const step = Math.max(2, half / 32);
      const low = Math.floor((env.plot.left - left.x) / step) - 1;
      const high = Math.ceil((env.plot.right - left.x) / step) + 1;
      const out: Prim[] = [];
      let previous: Pt | null = null;
      for (let k = low; k <= high; k += 1) {
        const x = left.x + k * step;
        const at = { x, y: env.price.toY(centre + amplitude * Math.cos(((x - left.x) / half) * Math.PI)) };
        if (previous) out.push(segment(previous, at, color, width, dash));
        previous = at;
      }
      return out;
    },
  },
];

export const DRAWING_TOOLS: readonly DrawingToolDefinition[] = [
  {
    id: 'TrendLine',
    label: 'Trend Line',
    group: 'lines',
    sectionKey: 'lines',
    anchorCount: 2,
    anchorAxes: ['xy', 'xy'],
    glyph: '╱',
    hint: 'Drag from one bar to another · Shift snaps to 45°',
    shiftConstraint: 'angle',
    styleKeys: [
      ...LINE_STYLE_KEYS,
      'extendSides',
      'priceLabels',
      'showStats',
      'stats',
      'statsPosition',
    ],
    styleDefaults: { extendSides: [], leftEnd: 'normal', rightEnd: 'normal' },
    primitives: (anchors, style, env) => linePrimitives(anchors, style, env, 'segment'),
  },
  {
    id: 'Ray',
    label: 'Ray',
    group: 'lines',
    sectionKey: 'lines',
    anchorCount: 2,
    anchorAxes: ['xy', 'xy'],
    glyph: '⇢',
    hint: 'Drag from the origin through a second point · Shift snaps to 45°',
    shiftConstraint: 'angle',
    styleKeys: LINE_STYLE_KEYS,
    styleDefaults: {},
    primitives: (anchors, style, env) => linePrimitives(anchors, style, env, 'ray'),
  },
  {
    id: 'ExtendedLine',
    label: 'Extended Line',
    group: 'lines',
    sectionKey: 'lines',
    anchorCount: 2,
    anchorAxes: ['xy', 'xy'],
    glyph: '∕',
    hint: 'Drag between two points; the line runs to both edges · Shift snaps to 45°',
    shiftConstraint: 'angle',
    styleKeys: LINE_STYLE_KEYS,
    styleDefaults: {},
    primitives: (anchors, style, env) => linePrimitives(anchors, style, env, 'both'),
  },
  {
    id: 'HorizontalLine',
    label: 'Horizontal Line',
    group: 'lines',
    sectionKey: 'lines',
    anchorCount: 1,
    anchorAxes: ['y'],
    glyph: '─',
    hint: 'Click or drag to set the price level · Shift holds the level while you drag',
    shiftConstraint: 'lockPrice',
    styleKeys: LINE_STYLE_KEYS,
    styleDefaults: {},
    primitives: (anchors, style, env) => linePrimitives(anchors, style, env, 'width'),
  },
  {
    id: 'VerticalLine',
    label: 'Vertical Line',
    group: 'lines',
    sectionKey: 'lines',
    anchorCount: 1,
    anchorAxes: ['x'],
    glyph: '│',
    hint: 'Click or drag to set the time · Shift holds the bar while you drag',
    shiftConstraint: 'lockTime',
    styleKeys: LINE_STYLE_KEYS,
    styleDefaults: {},
    primitives: (anchors, style, env) => linePrimitives(anchors, style, env, 'height'),
  },
  {
    id: 'ParallelLine',
    label: 'Parallel Line',
    group: 'lines',
    sectionKey: 'channels',
    anchorCount: 3,
    anchorAxes: ['xy', 'xy', 'xy'],
    glyph: '∥',
    hint: 'Drag the first line, then click the offset',
    quickBar: ['color', 'fillColor', 'lineWidth', 'lineStyle'],
    styleKeys: ['color', 'lineWidth', 'lineStyle', 'fillBackground', 'fillColor', 'middleLine'],
    styleDefaults: { fillBackground: true, fillColor: '#4DA3FF26', middleLine: true },
    primitives: (anchors, style, _env) => {
      const a = anchors[0];
      const b = anchors[1];
      const c = anchors[2];
      if (!a || !b || !c) return [];
      const { color, width, dash } = stroke(style);
      const offset = sub(b, a);
      const d = add(c, offset);
      const out: Prim[] = [];
      if (styleBoolean(style, 'fillBackground', true)) out.push({ kind: 'fill', pts: [a, b, d, c], color: styleColor(style, 'fillColor') });
      out.push(segment(a, b, color, width, dash));
      out.push(segment(c, d, color, width, dash));
      if (styleBoolean(style, 'middleLine', true)) out.push(segment(mid(a, c), mid(b, d), color, width, lineDash('dashed')));
      return out;
    },
  },
  {
    id: 'Pitchfork',
    label: 'Pitchfork',
    group: 'lines',
    sectionKey: 'pitchforks',
    anchorCount: 3,
    anchorAxes: ['xy', 'xy', 'xy'],
    glyph: '⅄',
    hint: 'Click the two extremes, then the median handle',
    styleKeys: [
      'color',
      'lineWidth',
      'lineStyle',
      'medianColor',
      'medianLineWidth',
      'medianLineStyle',
      'fillBackground',
      'backgroundOpacity',
      'extendLines',
    ],
    styleDefaults: { fillBackground: true, backgroundOpacity: 10, extendLines: false },
    primitives: (anchors, style, env) => {
      const upper = anchors[0];
      const lower = anchors[1];
      const handle = anchors[2];
      if (!upper || !lower || !handle) return [];
      const spine = mid(upper, lower);
      const dir = sub(handle, spine);
      const side = add(upper, dir);
      const other = add(lower, dir);
      const extend = styleBoolean(style, 'extendLines', false);
      const base = stroke(style);
      const median = stroke(style, 'median');
      const out: Prim[] = [];
      if (styleBoolean(style, 'fillBackground', true)) {
        out.push({ kind: 'fill', pts: [upper, side, other, lower], color: withOpacity(median.color, styleNumber(style, 'backgroundOpacity', 10)) });
      }
      const ruled = (from: Pt, to: Pt, prim: { color: string; width: number; dash: number[] }): Prim | null => {
        if (!extend) return segment(from, to, prim.color, prim.width, prim.dash);
        const clipped = clipLine(from, to, env.plot, -UNBOUNDED, UNBOUNDED);
        return clipped ? segment(clipped[0], clipped[1], prim.color, prim.width, prim.dash) : null;
      };
      for (const rule of [
        ruled(upper, side, base),
        ruled(lower, other, base),
        ruled(spine, handle, median),
      ]) {
        if (rule) out.push(rule);
      }
      return out;
    },
  },
  {
    id: 'FibonacciRetracement',
    label: 'Fibonacci Retracement',
    group: 'gannFib',
    sectionKey: 'fibonacci',
    anchorCount: 2,
    anchorAxes: ['xy', 'xy'],
    glyph: 'ϕ',
    hint: 'Drag from swing low to swing high',
    styleKeys: [
      'lineWidth',
      'lineStyle',
      'trendLineColor',
      'trendLineLineWidth',
      'trendLineLineStyle',
      'backgroundOpacity',
      'extendSides',
      'reverse',
      'showLevels',
      'showPrices',
      'levelFormat',
      'textPosition',
      'fibLevels',
    ],
    styleDefaults: {
      trendLineColor: '#B0B0B0',
      trendLineLineStyle: 'dashed',
      backgroundOpacity: 10,
      reverse: false,
      showLevels: true,
      showPrices: true,
      levelFormat: 'value',
      textPosition: 'left',
      fibLevels: FIB_RETRACE_LEVELS,
    },
    primitives: (anchors, style, env) => fibPrimitives(anchors, style, env, styleLevels(style, 'fibLevels'), true),
  },
  {
    id: 'Rectangle',
    label: 'Rectangle',
    group: 'shape',
    sectionKey: 'shapes',
    anchorCount: 2,
    anchorAxes: ['xy', 'xy'],
    glyph: '▭',
    hint: 'Drag a zone between two bars and prices · Shift squares it',
    shiftConstraint: 'square',
    quickBar: ['color', 'borderColor', 'lineWidth', 'lineStyle'],
    styleKeys: [
      'color',
      'borderColor',
      'lineWidth',
      'lineStyle',
      'middleLine',
      'middleLineColor',
      'middleLineWidth',
      'middleLineStyle',
      'text',
      'fontColor',
      'fontSize',
      'textPosition',
    ],
    styleDefaults: {
      color: '#1E90FF15',
      borderColor: '#1E90FFCC',
      middleLine: false,
      middleLineColor: '#1E90FFCC',
      middleLineWidth: 1,
      middleLineStyle: 'dashed',
      fontColor: '#1E90FF',
    },
    primitives: (anchors, style, _env) => {
      const a = anchors[0];
      const b = anchors[1];
      if (!a || !b) return [];
      const left = Math.min(a.x, b.x);
      const right = Math.max(a.x, b.x);
      const top = Math.min(a.y, b.y);
      const bottom = Math.max(a.y, b.y);
      const border = stroke(style, 'middle');
      const line = { color: styleColor(style, 'borderColor', '#1E90FFCC'), width: styleNumber(style, 'lineWidth', 2), dash: lineDash(styleString(style, 'lineStyle', 'solid')) };
      const out: Prim[] = [
        { kind: 'fill', pts: [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }], color: styleColor(style, 'color') },
        segment({ x: left, y: top }, { x: right, y: top }, line.color, line.width, line.dash),
        segment({ x: right, y: top }, { x: right, y: bottom }, line.color, line.width, line.dash),
        segment({ x: right, y: bottom }, { x: left, y: bottom }, line.color, line.width, line.dash),
        segment({ x: left, y: bottom }, { x: left, y: top }, line.color, line.width, line.dash),
      ];
      if (styleBoolean(style, 'middleLine', false)) {
        const y = (top + bottom) / 2;
        out.push(segment({ x: left, y }, { x: right, y }, border.color, border.width, border.dash));
      }
      const text = styleString(style, 'text');
      if (text) {
        const position = styleString(style, 'textPosition', 'center');
        out.push({
          kind: 'label',
          at: { x: position === 'left' ? left + 6 : position === 'right' ? right - 6 : (left + right) / 2, y: (top + bottom) / 2 },
          text,
          options: {
            color: styleColor(style, 'fontColor', '#1E90FF'),
            font: fontCss(style),
            align: position === 'left' ? 'left' : position === 'right' ? 'right' : 'center',
            baseline: 'middle',
          },
        });
      }
      return out;
    },
  },
  {
    id: 'Text',
    label: 'Text',
    group: 'annotations',
    sectionKey: 'textAndNotes',
    anchorCount: 1,
    anchorAxes: ['xy'],
    glyph: 'T',
    hint: 'Click where the note should sit, then type it',
    quickBar: ['fontColor', 'fontSize', 'fontFamily'],
    opensEditorOnPlace: true,
    styleKeys: [
      'text',
      'fontColor',
      'fontSize',
      'fontFamily',
      'fontStyle',
      'textPosition',
      'fillBackground',
      'fillColor',
      'backgroundOpacity',
      'paperFold',
      'rotation',
    ],
    styleDefaults: {
      fontColor: '#4DA3FF',
      fontFamily: 'system',
      fontSize: 24,
      fontStyle: 'normal',
      textPosition: 'center',
      fillColor: '#F7D774',
      backgroundOpacity: 90,
      rotation: 0,
    },
    primitives: (anchors, style, _env) => {
      const at = anchors[0];
      if (!at) return [];
      const text = styleString(style, 'text') || 'text';
      const position = styleString(style, 'textPosition', 'center');
      const fill = styleBoolean(style, 'fillBackground', false);
      return [
        {
          kind: 'label',
          at,
          text,
          options: {
            color: styleColor(style, 'fontColor', '#4DA3FF'),
            font: fontCss(style),
            align: position === 'left' ? 'left' : position === 'right' ? 'right' : 'center',
            baseline: 'middle',
            background: fill ? withOpacity(styleColor(style, 'fillColor', '#F7D774'), styleNumber(style, 'backgroundOpacity', 90)) : undefined,
            fold: styleBoolean(style, 'paperFold', false) && fill,
            rotation: styleNumber(style, 'rotation', 0),
            pad: 6,
          },
        },
      ];
    },
  },
  {
    id: 'LongPosition',
    label: 'Long Position',
    group: 'forecastMeasure',
    sectionKey: 'forecasting',
    anchorCount: 3,
    anchorAxes: ['xy', 'xy', 'xy'],
    glyph: '▲',
    hint: 'Drag entry to target, then click the stop',
    quickBar: ['profitColor', 'stopColor'],
    styleKeys: POSITION_STYLE_KEYS,
    styleDefaults: POSITION_DEFAULTS,
    primitives: (anchors, style, env) => positionPrimitives(anchors, style, env, true),
  },
  {
    id: 'ShortPosition',
    label: 'Short Position',
    group: 'forecastMeasure',
    sectionKey: 'forecasting',
    anchorCount: 3,
    anchorAxes: ['xy', 'xy', 'xy'],
    glyph: '▼',
    hint: 'Drag entry to target, then click the stop',
    quickBar: ['profitColor', 'stopColor'],
    styleKeys: POSITION_STYLE_KEYS,
    styleDefaults: POSITION_DEFAULTS,
    primitives: (anchors, style, env) => positionPrimitives(anchors, style, env, false),
  },

  /* ------------------------------------------------------------------ arrows: classic */
  {
    id: 'Arrow',
    label: 'Arrow',
    group: 'arrows',
    sectionKey: 'arrows-classic',
    anchorCount: 1,
    anchorAxes: ['xy'],
    glyph: '↗',
    hint: 'Click where the arrow starts; it points up and to the right',
    styleKeys: LINE_STYLE_KEYS,
    styleDefaults: {},
    primitives: (anchors, style, _env) => {
      const tail = anchors[0];
      if (!tail) return [];
      const { color, width, dash } = stroke(style);
      const tip = polar(tail, -Math.PI / 4, 48);
      const head = Math.max(10, 4 * width);
      return [
        segment(tail, tip, color, width, dash),
        ...arrowHeadPrims(tip, Math.atan2(tip.y - tail.y, tip.x - tail.x), { kind: 'filled', length: head, halfAngle: Math.PI / 7 }, color, width),
      ];
    },
  },
  {
    id: 'ArrowMarker',
    label: 'Arrow Marker',
    group: 'arrows',
    sectionKey: 'arrows-classic',
    anchorCount: 1,
    anchorAxes: ['xy'],
    glyph: '➔',
    hint: 'Click where the fat arrow starts',
    styleKeys: LINE_STYLE_KEYS,
    styleDefaults: { color: '#1E90FF80' },
    primitives: (anchors, style, _env) => {
      const from = anchors[0];
      if (!from) return [];
      const { color, width, dash } = stroke(style);
      const to = polar(from, 0, 56);
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const length = Math.max(12, Math.hypot(to.x - from.x, to.y - from.y));
      const halfWidth = Math.max(6, width * 3);
      const headLength = Math.min(length * 0.35, halfWidth * 2.4);
      const tail = offsetAlong(to, angle, -length, 0);
      const outline = [
        to,
        offsetAlong(to, angle, -headLength, halfWidth),
        offsetAlong(tail, angle, 0, halfWidth),
        offsetAlong(tail, angle, 0, -halfWidth),
        offsetAlong(to, angle, -headLength, -halfWidth),
      ];
      // The shipped default fill is half transparent, so the outline is kept.
      return [
        polygon(outline, color),
        ...outline.map((point, index) => segment(point, outline[(index + 1) % outline.length] ?? point, color, width, dash)),
      ];
    },
  },
  ...DIRECTIONAL_MARK_TOOLS,
  {
    id: 'FlagMark',
    label: 'Flag Mark',
    group: 'arrows',
    sectionKey: 'arrows-classic',
    anchorCount: 1,
    anchorAxes: ['xy'],
    glyph: '⚑',
    hint: 'Click where the flag pole should stand',
    styleKeys: ['color'],
    styleDefaults: {},
    primitives: (anchors, style, _env) => {
      const at = anchors[0];
      if (!at) return [];
      const color = styleColor(style, 'color');
      const left = at.x - 10;
      const right = at.x + 10;
      const crest = at.y - 7;
      const hem = at.y + 7;
      const pennant: Pt[] = [{ x: left, y: hem }];
      for (let step = 1; step <= 12; step += 1) {
        const t = step / 12;
        const inverse = 1 - t;
        pennant.push({
          x: inverse * inverse * left + 2 * inverse * t * at.x + t * t * right,
          y: inverse * inverse * hem + 2 * inverse * t * (hem - 5) + t * t * hem,
        });
      }
      pennant.push({ x: right, y: crest });
      for (let step = 1; step <= 12; step += 1) {
        const t = step / 12;
        const inverse = 1 - t;
        pennant.push({
          x: inverse * inverse * right + 2 * inverse * t * at.x + t * t * left,
          y: inverse * inverse * crest + 2 * inverse * t * (crest + 5) + t * t * crest,
        });
      }
      return [
        polygon(pennant, color),
        segment({ x: left, y: hem + 14 }, { x: left, y: hem }, '#2D313B', 2, []),
      ];
    },
  },

  /* ------------------------------------------------------------------ arrows: stylized */
  {
    id: 'Momentum',
    label: 'Momentum',
    group: 'arrows',
    sectionKey: 'stylized',
    anchorCount: 2,
    anchorAxes: ['xy', 'xy'],
    glyph: '⇗',
    hint: 'Drag from the start to where the move lands',
    styleKeys: ['color', 'highlight', 'lineWidth'],
    styleDefaults: { color: '#00FF7F', highlight: true },
    primitives: (anchors, style, env) =>
      stylizedPrimitives(anchors, style, env, { shaft: 'straight', head: { kind: 'notched', length: 22 }, fade: true }),
  },
  {
    id: 'Flow',
    label: 'Flow',
    group: 'arrows',
    sectionKey: 'stylized',
    anchorCount: 2,
    anchorAxes: ['xy', 'xy'],
    glyph: '↝',
    hint: 'Drag a curved path from start to finish',
    styleKeys: ['color', 'highlight', 'lineWidth'],
    styleDefaults: { color: '#044391' },
    primitives: (anchors, style, env) =>
      stylizedPrimitives(anchors, style, env, { shaft: { bend: 0.25 }, head: { kind: 'open', length: 20, halfAngle: Math.PI / 5 } }),
  },
  {
    id: 'Emphasis',
    label: 'Emphasis',
    group: 'arrows',
    sectionKey: 'stylized',
    anchorCount: 2,
    anchorAxes: ['xy', 'xy'],
    glyph: '▶',
    hint: 'Drag a bold straight arrow',
    styleKeys: ['color', 'highlight', 'lineWidth'],
    styleDefaults: { color: '#FF4C4C' },
    primitives: (anchors, style, env) =>
      stylizedPrimitives(anchors, style, env, { shaft: 'straight', head: { kind: 'filled', length: 22, halfAngle: Math.PI / 6 } }),
  },
  {
    id: 'Whisper',
    label: 'Whisper',
    group: 'arrows',
    sectionKey: 'stylized',
    anchorCount: 2,
    anchorAxes: ['xy', 'xy'],
    glyph: '○',
    hint: 'Drag a dotted arrow that ends in a small ring',
    styleKeys: ['color', 'highlight', 'lineWidth'],
    styleDefaults: { color: '#656565' },
    primitives: (anchors, style, env) =>
      stylizedPrimitives(anchors, style, env, {
        shaft: 'straight',
        head: { kind: 'ring', length: 4 },
        tipGap: 4,
        dash: { pattern: [1, 1], scaledByWidth: true },
      }),
  },
  {
    id: 'Subtle',
    label: 'Subtle',
    group: 'arrows',
    sectionKey: 'stylized',
    anchorCount: 2,
    anchorAxes: ['xy', 'xy'],
    glyph: '△',
    hint: 'Drag a thin arrow with a small head',
    styleKeys: ['color', 'highlight', 'lineWidth'],
    styleDefaults: { color: '#656565' },
    primitives: (anchors, style, env) =>
      stylizedPrimitives(anchors, style, env, { shaft: 'straight', head: { kind: 'filled', length: 8, halfAngle: Math.PI / 6 } }),
  },
  {
    id: 'Journey',
    label: 'Journey',
    group: 'arrows',
    sectionKey: 'stylized',
    anchorCount: 2,
    anchorAxes: ['xy', 'xy'],
    glyph: '┄',
    hint: 'Drag a dashed arrow along the path',
    styleKeys: ['color', 'highlight', 'lineWidth'],
    styleDefaults: { color: '#FFD878' },
    primitives: (anchors, style, env) =>
      stylizedPrimitives(anchors, style, env, {
        shaft: 'straight',
        head: { kind: 'filled', length: 22, halfAngle: Math.PI / 6 },
        dash: { pattern: [12, 6] },
      }),
  },
  {
    id: 'Burj',
    label: 'Burj',
    group: 'arrows',
    sectionKey: 'stylized',
    anchorCount: 2,
    anchorAxes: ['xy', 'xy'],
    glyph: '∩',
    hint: 'Drag from the pump start to the dump end',
    styleKeys: ['color', 'highlight', 'lineWidth'],
    styleDefaults: { color: '#FFBED3' },
    primitives: (anchors, style, env) =>
      stylizedPrimitives(anchors, style, env, { shaft: 'hump', head: { kind: 'open', length: 20, halfAngle: Math.PI / 5 } }),
  },
  {
    id: 'Fork',
    label: 'Fork',
    group: 'arrows',
    sectionKey: 'stylized',
    anchorCount: 2,
    anchorAxes: ['xy', 'xy'],
    glyph: 'Y',
    hint: 'Drag from the decision point to the branch you expect',
    styleKeys: ['color', 'highlight', 'lineWidth'],
    styleDefaults: { color: '#5AA0FF' },
    primitives: (anchors, style, _env) => {
      const start = anchors[0];
      const end = anchors[1];
      if (!start || !end) return [];
      const { color, width } = stroke(style);
      const fork: Pt = { x: start.x + (end.x - start.x) * 0.55, y: start.y + (end.y - start.y) * 0.55 };
      const reach = 0.2 * Math.hypot(end.x - start.x, end.y - start.y);
      const vertical = Math.abs(end.y - start.y) > Math.abs(end.x - start.x);
      const top: Pt = vertical ? { x: end.x - reach, y: end.y } : { x: end.x, y: end.y - reach };
      const bottom: Pt = vertical ? { x: end.x + reach, y: end.y } : { x: end.x, y: end.y + reach };
      const sides = branchSides(start, end);
      const out: Prim[] = [segment(start, fork, color, width, [])];
      out.push(...branchPrims(fork, top, color, width, sides.top));
      out.push(...branchPrims(fork, end, color, width, null));
      out.push(...branchPrims(fork, bottom, color, width, sides.bottom));
      return styleBoolean(style, 'highlight', false) ? withHighlightGlow(out, color) : out;
    },
  },
  {
    id: 'ThreePaths',
    label: '3 Paths',
    group: 'arrows',
    sectionKey: 'stylized',
    anchorCount: 4,
    anchorAxes: ['xy', 'xy', 'xy', 'xy'],
    glyph: 'Ψ',
    hint: 'Click the start, then the up, middle and down targets',
    styleKeys: ['color', 'highlight', 'lineWidth'],
    styleDefaults: { color: '#4DA3FF' },
    primitives: (anchors, style, _env) => {
      const start = anchors[0];
      const top = anchors[1];
      const middle = anchors[2];
      const bottom = anchors[3];
      if (!start || !top || !middle || !bottom) return [];
      const { color, width } = stroke(style);
      const fork: Pt = { x: start.x + (middle.x - start.x) * 0.55, y: start.y + (middle.y - start.y) * 0.55 };
      const side = middle.x > start.x ? -1 : 1;
      const out: Prim[] = [segment(start, fork, color, width, [])];
      const pump = Math.atan2(top.y - fork.y, top.x - fork.x);
      out.push(...branchPrims(fork, top, '#25B43D', width, side));
      out.push(branchLabel('PUMP', top, pump, '#25B43D'));
      out.push(...branchPrims(fork, middle, '#C0C533', width, null));
      out.push(branchLabel('CRAB', middle, Math.atan2(middle.y - fork.y, middle.x - fork.x), '#C0C533'));
      out.push(...branchPrims(fork, bottom, '#B42525', width, side));
      out.push(branchLabel('DUMP', bottom, Math.atan2(bottom.y - fork.y, bottom.x - fork.x), '#B42525'));
      return styleBoolean(style, 'highlight', false) ? withHighlightGlow(out, color) : out;
    },
  },
  {
    id: 'Divergence',
    label: 'Divergence',
    group: 'arrows',
    sectionKey: 'stylized',
    anchorCount: 2,
    anchorAxes: ['xy', 'xy'],
    glyph: '⋔',
    hint: 'Drag from the fork to where the trend ends',
    styleKeys: ['bullishColor', 'bearishColor', 'highlight', 'lineWidth'],
    styleDefaults: { bullishColor: '#60F09A', bearishColor: '#FF6E5F', highlight: false },
    primitives: (anchors, style, _env) => {
      const fork = anchors[0];
      const end = anchors[1];
      if (!fork || !end) return [];
      const width = styleNumber(style, 'lineWidth', 2);
      const dx = end.x - fork.x;
      const dy = end.y - fork.y;
      const length = Math.hypot(dx, dy);
      if (length === 0) return [];
      const angle = Math.atan2(dy, dx);
      const converging = fork.x > end.x;
      const color = converging ? styleColor(style, 'bullishColor', '#60F09A') : styleColor(style, 'bearishColor', '#FF6E5F');
      const spread = 0.05;
      const top = polar(fork, angle - spread, length);
      const bottom = polar(fork, angle + spread, length);
      const out: Prim[] = [];
      // A branch only bows once it separates from its neighbour by a few pixels.
      const bow = (to: Pt): number | null => (Math.abs(to.y - end.y) < 5 ? null : to.y < end.y ? 1 : -1);
      out.push(...branchPrims(fork, end, color, width, null));
      out.push(...branchPrims(fork, top, color, width, bow(top)));
      out.push(...branchPrims(fork, bottom, color, width, bow(bottom)));
      return styleBoolean(style, 'highlight', false) ? withHighlightGlow(out, color) : out;
    },
  },

  /* ------------------------------------------------------------------ annotations */
  {
    id: 'AnchoredText',
    label: 'Anchored Text',
    group: 'annotations',
    sectionKey: 'textAndNotes',
    anchorCount: 1,
    anchorAxes: ['xy'],
    glyph: 'T',
    hint: 'Click where the text should sit, then type it',
    quickBar: ['fontColor', 'fontSize', 'fontFamily'],
    opensEditorOnPlace: true,
    styleKeys: [
      'text',
      'fontColor',
      'fontSize',
      'fontFamily',
      'fontStyle',
      'textPosition',
      'fillBackground',
      'fillColor',
      'backgroundOpacity',
      'paperFold',
      'rotation',
    ],
    styleDefaults: {
      fontColor: '#4DA3FF',
      fontFamily: 'system',
      fontSize: 24,
      fontStyle: 'normal',
      textPosition: 'center',
      fillColor: '#F7D774',
      backgroundOpacity: 90,
      rotation: 0,
    },
    primitives: (anchors, style, _env) => {
      const at = anchors[0];
      if (!at) return [];
      const fill = styleBoolean(style, 'fillBackground', false);
      return [
        {
          kind: 'label',
          at,
          text: styleString(style, 'text') || 'text',
          options: {
            color: styleColor(style, 'fontColor', '#4DA3FF'),
            font: fontCss(style),
            align: alignOf(style),
            baseline: 'middle',
            background: fill ? withOpacity(styleColor(style, 'fillColor', '#F7D774'), styleNumber(style, 'backgroundOpacity', 90)) : undefined,
            fold: styleBoolean(style, 'paperFold', false) && fill,
            rotation: styleNumber(style, 'rotation', 0),
            pad: 6,
          },
        },
      ];
    },
  },
  ...NOTE_TOOLS,
  ...PRICE_TAG_TOOLS,
  ...PATTERN_TOOLS,
  ...ELLIOTT_TOOLS,
  ...CYCLE_TOOLS,
  {
    id: 'Signpost',
    label: 'Signpost',
    group: 'annotations',
    sectionKey: 'labels',
    anchorCount: 1,
    anchorAxes: ['xy'],
    glyph: '⚑',
    hint: 'Click the bar the sign should stand on, then type it',
    opensEditorOnPlace: true,
    styleKeys: ['text', 'color', 'fontColor', 'fontSize'],
    styleDefaults: { color: '#4DA3FF', fontColor: '#FFFFFF', fontSize: 12 },
    primitives: (anchors, style, env) => {
      const base = anchors[0];
      if (!base) return [];
      const color = styleColor(style, 'color', '#4DA3FF');
      const text = styleString(style, 'text') || 'event';
      const center = { x: base.x, y: base.y - 34 };
      const box = plateBox(center, text, fontCss(style), Math.round(styleNumber(style, 'fontSize', 12)), 'center', 10, 6, env);
      return [
        segment(base, { x: base.x, y: box.bottom }, color, 2, []),
        ...bubblePrimitives(text, style, env, {
          plate: withOpacity(color, 15),
          border: color,
          ink: styleColor(style, 'fontColor', '#FFFFFF'),
          center,
          align: 'center',
          padX: 10,
          padY: 6,
        }),
      ];
    },
  },
  {
    id: 'Comment',
    label: 'Comment',
    group: 'annotations',
    sectionKey: 'labels',
    anchorCount: 1,
    anchorAxes: ['xy'],
    glyph: '❠',
    hint: 'Click the spot the comment points at, then type it',
    opensEditorOnPlace: true,
    styleKeys: ['text', 'color', 'fontColor', 'fontSize'],
    styleDefaults: { color: '#4DA3FF', fontColor: '#FFFFFF', fontSize: 12 },
    primitives: (anchors, style, env) => {
      const at = anchors[0];
      if (!at) return [];
      return bubblePrimitives(styleString(style, 'text') || 'comment', style, env, {
        plate: styleColor(style, 'color', '#4DA3FF'),
        ink: styleColor(style, 'fontColor', '#FFFFFF'),
        center: { x: at.x + 12, y: at.y - 30 },
        align: 'center',
        padX: 10,
        padY: 5,
        tailTo: at,
      });
    },
  },
];

const BY_ID = new Map(DRAWING_TOOLS.map((definition) => [definition.id, definition]));

export function toolById(id: string): DrawingToolDefinition | null {
  return BY_ID.get(id) ?? null;
}
