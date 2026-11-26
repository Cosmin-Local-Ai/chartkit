/**
 * Drawing style vocabulary. One descriptor map of `key -> {label, kind, options}`
 * drives both the quick bar and the properties form, exactly as the shipped schema
 * does: a tool declares the keys it uses plus the defaults that override the map,
 * and nothing else needs to know which keys exist.
 *
 * Keys, kinds and option lists are the shipped ones (`lineStyle` solid/dashed/
 * dotted, `riskDisplayMode` percents/money, `qtyPrecision` auto/0-8, `levelFormat`
 * value/percent, `levels` entries `{value, color, enabled}`). The shipped defaults
 * are reused verbatim where they exist. Two deviations: `fontFamily` offers the
 * local font stacks instead of the shipped `Poppins` webfont, and `text` is a key
 * of its own because the shipped editor changes note text inline on the canvas
 * rather than through the descriptor map.
 */

export interface LevelEntry {
  value: number;
  color: string;
  enabled: boolean;
}

export type StyleValue = string | number | boolean | string[] | LevelEntry[];
export type StyleValues = Record<string, StyleValue>;

export type StyleKind =
  | 'color'
  | 'number'
  | 'toggle'
  | 'segmented'
  | 'select'
  | 'multiselect'
  | 'levels'
  | 'font'
  | 'text';

export interface StyleDescriptor {
  key: string;
  label: string;
  kind: StyleKind;
  default: StyleValue;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  options?: readonly string[];
  /** Field only shows while another key holds this value, as their `visibleWhen` does. */
  visibleWhen?: { key: string; equals: StyleValue };
}

/** The shipped retracement level set for `FibonacciRetracement`, in shipped order. */
export const FIB_RETRACE_LEVELS: LevelEntry[] = [
  { value: 0, color: '#9598A1', enabled: true },
  { value: 0.236, color: '#F23645', enabled: true },
  { value: 0.382, color: '#FF9800', enabled: true },
  { value: 0.5, color: '#4CAF50', enabled: true },
  { value: 0.618, color: '#089981', enabled: true },
  { value: 0.786, color: '#00BCD4', enabled: true },
  { value: 1, color: '#787B86', enabled: true },
  { value: 1.618, color: '#2962FF', enabled: true },
  { value: 2.618, color: '#F23645', enabled: true },
  { value: 3.618, color: '#9C27B0', enabled: true },
  { value: 4.236, color: '#E91E63', enabled: true },
  { value: 1.272, color: '#9E7548', enabled: false },
  { value: 1.414, color: '#F23645', enabled: false },
  { value: 2, color: '#00BCD4', enabled: false },
  { value: 2.272, color: '#9E7548', enabled: false },
  { value: 2.414, color: '#4CAF50', enabled: false },
  { value: 3, color: '#00BCD4', enabled: false },
  { value: 3.272, color: '#787B86', enabled: false },
  { value: 3.414, color: '#2962FF', enabled: false },
  { value: 4, color: '#F23645', enabled: false },
  { value: 4.272, color: '#9C27B0', enabled: false },
  { value: 4.414, color: '#E91E63', enabled: false },
  { value: 4.618, color: '#9E7548', enabled: false },
  { value: 4.764, color: '#00BCD4', enabled: false },
];

const LINE_STYLES = ['solid', 'dashed', 'dotted'] as const;

function seg(key: string, label: string, value: string, options: readonly string[] = LINE_STYLES): StyleDescriptor {
  return { key, label, kind: 'segmented', default: value, options };
}

function num(
  key: string,
  label: string,
  value: number,
  bounds: { min?: number; max?: number; step?: number; suffix?: string; visibleWhen?: { key: string; equals: StyleValue } } = {},
): StyleDescriptor {
  return { key, label, kind: 'number', default: value, ...bounds };
}

function color(key: string, label: string, value: string): StyleDescriptor {
  return { key, label, kind: 'color', default: value };
}

function toggle(key: string, label: string, value: boolean): StyleDescriptor {
  return { key, label, kind: 'toggle', default: value };
}

function select(key: string, label: string, value: string, options: readonly string[]): StyleDescriptor {
  return { key, label, kind: 'select', default: value, options };
}

function multiselect(key: string, label: string, value: readonly string[], options: readonly string[]): StyleDescriptor {
  return { key, label, kind: 'multiselect', default: [...value], options };
}

const STYLE_ENTRIES: readonly StyleDescriptor[] = [
    color('color', 'Color', '#4DA3FF'),
    color('borderColor', 'Border', '#1E90FFCC'),
    color('fillColor', 'Fill', '#4DA3FF26'),
    color('fontColor', 'Text color', '#4DA3FF'),
    color('medianColor', 'Median', '#4DA3FF'),
    color('trendLineColor', 'Trend line', '#B0B0B0'),
    color('profitColor', 'Profit', '#00C2A8'),
    color('stopColor', 'Stop', '#ff3232'),
    color('middleLineColor', 'Middle line', '#1E90FFCC'),
    color('bullishColor', 'Bullish', '#60F09A'),
    color('bearishColor', 'Bearish', '#FF6E5F'),
    num('lineWidth', 'Width', 2, { min: 1, max: 12, step: 1, suffix: 'px' }),
    num('medianLineWidth', 'Median width', 2, { min: 1, max: 12, step: 1, suffix: 'px' }),
    num('trendLineLineWidth', 'Trend width', 2, { min: 1, max: 12, step: 1, suffix: 'px' }),
    num('middleLineWidth', 'Middle width', 1, { min: 1, max: 12, step: 1, suffix: 'px' }),
    seg('lineStyle', 'Line style', 'solid'),
    seg('medianLineStyle', 'Median style', 'solid'),
    seg('trendLineLineStyle', 'Trend style', 'dashed'),
    seg('middleLineStyle', 'Middle style', 'dashed'),
    num('fontSize', 'Font size', 14, { min: 8, max: 96, step: 1 }),
    {
      key: 'fontFamily',
      label: 'Font',
      kind: 'font',
      default: 'system',
      options: ['system', 'mono'],
    },
    seg('fontStyle', 'Font style', 'normal', ['normal', 'italic']),
    seg('textPosition', 'Align', 'center', ['left', 'center', 'right']),
    toggle('fillBackground', 'Fill background', false),
    num('backgroundOpacity', 'Background opacity', 10, {
      min: 0,
      max: 100,
      step: 1,
      suffix: '%',
      visibleWhen: { key: 'fillBackground', equals: true },
    }),
    toggle('paperFold', 'Folded corner', false),
    toggle('highlight', 'Highlight', false),
    num('rotation', 'Rotation', 0, { min: -180, max: 180, step: 1, suffix: '°' }),
    multiselect('extendSides', 'Extend', [], ['left', 'right']),
    toggle('extendLines', 'Extend to the edges', false),
    toggle('middleLine', 'Middle line', true),
    toggle('priceLabels', 'Price labels', false),
    toggle('showStats', 'Show stats', false),
    multiselect('stats', 'Stats', ['priceRange', 'percentChange', 'barsRange'], [
      'priceRange',
      'percentChange',
      'barsRange',
    ]),
    select('statsPosition', 'Stats position', 'right', ['auto', 'left', 'center', 'right']),
    toggle('showLabels', 'Labels', true),
    toggle('showLevels', 'Show levels', true),
    toggle('showPrices', 'Show prices', true),
    select('levelFormat', 'Label format', 'value', ['value', 'percent']),
    toggle('reverse', 'Reverse', false),
    { key: 'fibLevels', label: 'Levels', kind: 'levels', default: FIB_RETRACE_LEVELS.map(cloneLevel) },
    num('accountSize', 'Account size', 1000, { min: 0, step: 1 }),
    num('risk', 'Risk', 25, { min: 0, step: 1 }),
    select('riskDisplayMode', 'Risk unit', 'percents', ['percents', 'money']),
    num('lotSize', 'Lot size', 1, { min: 0, step: 1 }),
    select('qtyPrecision', 'Qty precision', 'auto', ['auto', '0', '1', '2', '3', '4', '5', '6', '7', '8']),
    multiselect('positionStats', 'Position stats', ['target', 'stop', 'qty', 'pnl', 'riskReward'], [
      'target',
      'stop',
      'points',
      'qty',
      'pnl',
      'riskReward',
    ]),
    toggle('compactStats', 'Compact stats', false),
    { key: 'text', label: 'Note text', kind: 'text', default: '' },
];

/** The one property map. Tools reference keys; nothing else hard-codes a control. */
export const STYLE_DESCRIPTORS: Record<string, StyleDescriptor> = Object.fromEntries(
  STYLE_ENTRIES.map((descriptor) => [descriptor.key, descriptor]),
);

export function descriptorFor(key: string): StyleDescriptor | null {
  return STYLE_DESCRIPTORS[key] ?? null;
}

/** Shipped shape: a shared default per key, overridden per tool by its own defaults. */
export function defaultsForKeys(keys: readonly string[], overrides: StyleValues = {}): StyleValues {
  const out: StyleValues = {};
  for (const key of keys) {
    const override = overrides[key];
    const descriptor = STYLE_DESCRIPTORS[key];
    out[key] = override !== undefined ? cloneValue(override) : descriptor ? cloneValue(descriptor.default) : '';
  }
  return out;
}

/** Repairs a stored style: unknown keys drop, missing keys take the tool default. */
export function normaliseStyle(keys: readonly string[], overrides: StyleValues, raw: unknown): StyleValues {
  const source = typeof raw === 'object' && raw !== null ? (raw as StyleValues) : {};
  const out: StyleValues = {};
  for (const key of keys) {
    const descriptor = STYLE_DESCRIPTORS[key];
    const fallback = overrides[key] ?? descriptor?.default ?? '';
    const value = source[key];
    out[key] = descriptor ? coerce(descriptor, value, fallback) : cloneValue(fallback);
  }
  return out;
}

function coerce(descriptor: StyleDescriptor, value: StyleValue | undefined, fallback: StyleValue): StyleValue {
  switch (descriptor.kind) {
    case 'color':
    case 'text':
      return typeof value === 'string' && value ? value : asString(fallback);
    case 'font':
    case 'select':
    case 'segmented': {
      const text = typeof value === 'string' ? value : '';
      return descriptor.options?.includes(text) ? text : asString(fallback);
    }
    case 'toggle':
      return typeof value === 'boolean' ? value : fallback === true;
    case 'number': {
      const bounds = { min: descriptor.min, max: descriptor.max };
      const raw = typeof value === 'number' && Number.isFinite(value) ? value : Number(fallback) || 0;
      const min = bounds.min ?? Number.NEGATIVE_INFINITY;
      const max = bounds.max ?? Number.POSITIVE_INFINITY;
      return Math.min(max, Math.max(min, raw));
    }
    case 'multiselect': {
      const list = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
      const allowed = (descriptor.options ?? []).filter((option) => list.includes(option));
      if (allowed.length > 0) return allowed;
      return Array.isArray(fallback) ? (fallback as string[]).slice() : [];
    }
    case 'levels':
      return normaliseLevels(value, Array.isArray(fallback) ? (fallback as LevelEntry[]) : []);
  }
}

function asString(value: StyleValue): string {
  return typeof value === 'string' ? value : '';
}

export function normaliseLevels(raw: unknown, fallback: LevelEntry[]): LevelEntry[] {
  if (!Array.isArray(raw)) return fallback.map(cloneLevel);
  const out: LevelEntry[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const level = entry as Partial<LevelEntry>;
    if (typeof level.value !== 'number' || !Number.isFinite(level.value)) continue;
    out.push({
      value: level.value,
      color: typeof level.color === 'string' && level.color ? level.color : '#787B86',
      enabled: level.enabled !== false,
    });
  }
  return out.length > 0 ? out : fallback.map(cloneLevel);
}

export function cloneLevel(level: LevelEntry): LevelEntry {
  return { value: level.value, color: level.color, enabled: level.enabled };
}

export function cloneValue(value: StyleValue): StyleValue {
  if (Array.isArray(value)) {
    const list = value as readonly (string | LevelEntry)[];
    return list.map((entry) => (typeof entry === 'number' || typeof entry === 'string' ? entry : cloneLevel(entry as LevelEntry))) as StyleValue;
  }
  return value;
}

export function styleColor(style: StyleValues, key: string, fallback = '#4DA3FF'): string {
  const value = style[key];
  return typeof value === 'string' && value ? value : fallback;
}

export function styleNumber(style: StyleValues, key: string, fallback: number): number {
  const value = style[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function styleBoolean(style: StyleValues, key: string, fallback: boolean): boolean {
  const value = style[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function styleString(style: StyleValues, key: string, fallback = ''): string {
  const value = style[key];
  return typeof value === 'string' && value ? value : fallback;
}

export function styleFlags(style: StyleValues, key: string): string[] {
  const value = style[key];
  return Array.isArray(value) ? (value as string[]).filter((entry) => typeof entry === 'string') : [];
}

export function styleLevels(style: StyleValues, key: string): LevelEntry[] {
  const value = style[key];
  return Array.isArray(value) && typeof (value[0] ?? null) === 'object'
    ? (value as LevelEntry[])
    : [];
}

/** Canvas dash pattern for the shipped `lineStyle` values. */
export function lineDash(style: string): number[] {
  if (style === 'dashed') return [6, 4];
  if (style === 'dotted') return [2, 3];
  return [];
}

const UI_FONT_STACK = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const MONO_FONT_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** Local font stacks: the shipped default names `Poppins`, which this client does not load. */
export function fontStack(name: string): string {
  return name === 'mono' ? MONO_FONT_STACK : UI_FONT_STACK;
}

export function fontCss(style: StyleValues, sizeKey = 'fontSize'): string {
  const size = Math.round(styleNumber(style, sizeKey, 14));
  const family = fontStack(styleString(style, 'fontFamily', 'system'));
  const weight = styleBoolean(style, 'fontWeight', false) ? '600 ' : '';
  const slant = styleString(style, 'fontStyle', 'normal') === 'italic' ? 'italic ' : '';
  return `${slant}${weight}${size}px ${family}`;
}

/** Reads `#rgb`, `#rrggbb`, `#rrggbbaa` and the plain CSS names the shipped defaults use. */
export function parseColor(value: string): { r: number; g: number; b: number; a: number } | null {
  const hex = value.trim().replace(/^#/, '');
  if (hex.length === 3 || hex.length === 4) {
    const parts = [1, 2, 3].map((i) => Number.parseInt(`${hex[i]}${hex[i]}`, 16));
    if (parts.some((part) => !Number.isFinite(part))) return null;
    const alpha = hex.length === 4 ? Number.parseInt(`${hex[3]}${hex[3]}`, 16) / 255 : 1;
    return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: alpha };
  }
  if (hex.length !== 6 && hex.length !== 8) return null;
  const parts = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  if (parts.some((part) => !Number.isFinite(part))) return null;
  const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: alpha };
}

/** Color as `rgba()` with the opacity of a shipped percentage-style fill applied. */
export function withOpacity(value: string, percent: number): string {
  const parsed = parseColor(value);
  if (!parsed) return value;
  const alpha = parsed.a * Math.max(0, Math.min(100, percent)) / 100;
  return `rgba(${Math.round(parsed.r)},${Math.round(parsed.g)},${Math.round(parsed.b)},${alpha.toFixed(3)})`;
}

/** `<input type="color">` needs plain `#rrggbb`, so the shipped alpha suffix comes off. */
export function colorInputValue(value: string): string {
  const parsed = parseColor(value);
  if (!parsed) return '#4da3ff';
  const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${hex(parsed.r)}${hex(parsed.g)}${hex(parsed.b)}`;
}
