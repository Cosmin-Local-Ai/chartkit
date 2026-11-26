/**
 * Chart settings: what the settings dialog owns, the defaults, how a stored document is
 * validated, and how the appearance subset becomes the palette the renderer paints with.
 *
 * Nothing here is account-bound. A workspace document carries its own settings, so a
 * restored document restores the chart exactly as its owner left it.
 */

import { DARK_PALETTE, LIGHT_PALETTE, THEME, withAlpha } from './canvasKit';
import { DEFAULT_VISIBLE_BARS, DENSITY_FLOOR_MAX, DENSITY_FLOOR_MIN, MIN_BAR_STEP } from './view';

export const THEME_NAMES = ['dark', 'light'] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

export const PRICE_TICK_STYLES = ['fine', 'auto', 'coarse'] as const;
export type PriceTickStyle = (typeof PRICE_TICK_STYLES)[number];

/** Pixel pitch per price-axis tick for each tick style. `auto` is the pitch used before. */
export const TICK_PITCH_PX: Record<PriceTickStyle, number> = { fine: 34, auto: 56, coarse: 96 };

/** Means "the instrument's own session zone" rather than a fixed one. */
export const EXCHANGE_ZONE = 'exchange';

/**
 * Zones the timezone page offers without typing. The list is short on purpose: anything
 * else is typed, and a typed zone is only accepted if `Intl` knows it.
 */
export const ZONE_CHOICES: readonly string[] = [
  'UTC',
  EXCHANGE_ZONE,
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
];

export interface ChartSettings {
  // Appearance
  theme: ThemeName;
  paneBackground: string;
  upColor: string;
  downColor: string;
  showGrid: boolean;
  showLegend: boolean;
  priceTickStyle: PriceTickStyle;
  // Chart data
  showSessionDivider: boolean;
  /** Zoom-out floor in CSS pixels per bar. */
  minBarStep: number;
  /** Bars a freshly framed view shows. */
  visibleBars: number;
  // Timezone
  /** `'exchange'`, `'UTC'`, or any IANA zone name `Intl` accepts. */
  timezone: string;
  // Latency
  showLatency: boolean;
  latencyAlertMs: number;
}

export const DEFAULT_SETTINGS: ChartSettings = {
  theme: 'dark',
  paneBackground: DARK_PALETTE.bg,
  upColor: DARK_PALETTE.up,
  downColor: DARK_PALETTE.down,
  showGrid: true,
  showLegend: true,
  priceTickStyle: 'auto',
  showSessionDivider: true,
  minBarStep: MIN_BAR_STEP,
  visibleBars: DEFAULT_VISIBLE_BARS,
  timezone: 'UTC',
  showLatency: true,
  latencyAlertMs: 1_500,
};

/** Grid lines disappear by colour, so every pane that draws them honours the switch. */
const TRANSPARENT = 'rgba(0,0,0,0)';

function bool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback;
}

function num(raw: unknown, min: number, max: number, fallback: number): number {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/**
 * Only a plain `#rrggbb` reaches the canvas: `withAlpha` and `mixHex` both parse hex, and a
 * stored alpha would be dropped anyway. An eight-digit form is read as `#rrggbbaa`.
 */
function hex(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
  if (/^#[0-9a-fA-F]{8}$/.test(raw)) return `#${raw.slice(1, 7)}`;
  return fallback;
}

/** True when `Intl` can format in `zone`; the only test needed for an IANA name. */
export function isKnownZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** A stored zone counts only if it is `exchange` or a name `Intl` accepts; else UTC. */
function zone(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  if (raw === EXCHANGE_ZONE) return EXCHANGE_ZONE;
  return isKnownZone(raw) ? raw : fallback;
}

/**
 * The IANA zone the axis clock runs on. `exchange` follows the instrument and falls back to
 * UTC for a venue that publishes no zone or one this runtime cannot resolve.
 */
export function resolveZone(settings: ChartSettings, instrumentZone?: string): string {
  if (settings.timezone === EXCHANGE_ZONE) return isKnownZone(instrumentZone) ? instrumentZone : 'UTC';
  return isKnownZone(settings.timezone) ? settings.timezone : 'UTC';
}

/** Rewrites a stored document's settings, field by field, so a foreign value cannot reach a pane. */
export function normaliseSettings(raw: unknown): ChartSettings {
  const d = DEFAULT_SETTINGS;
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    theme: oneOf(value['theme'], THEME_NAMES, d.theme),
    paneBackground: hex(value['paneBackground'], d.paneBackground),
    upColor: hex(value['upColor'], d.upColor),
    downColor: hex(value['downColor'], d.downColor),
    showGrid: bool(value['showGrid'], d.showGrid),
    showLegend: bool(value['showLegend'], d.showLegend),
    priceTickStyle: oneOf(value['priceTickStyle'], PRICE_TICK_STYLES, d.priceTickStyle),
    showSessionDivider: bool(value['showSessionDivider'], d.showSessionDivider),
    minBarStep: num(value['minBarStep'], DENSITY_FLOOR_MIN, DENSITY_FLOOR_MAX, d.minBarStep),
    visibleBars: Math.round(num(value['visibleBars'], 20, 2000, d.visibleBars)),
    timezone: zone(value['timezone'], d.timezone),
    showLatency: bool(value['showLatency'], d.showLatency),
    latencyAlertMs: Math.round(num(value['latencyAlertMs'], 100, 120_000, d.latencyAlertMs)),
  };
}

/**
 * A theme owns its own starting colours, so switching theme re-inks the three the theme
 * provides. A colour picked by hand after the switch is a separate setting and stays put.
 */
export function applyThemeColours(settings: ChartSettings): ChartSettings {
  const base = settings.theme === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
  return { ...settings, paneBackground: base.bg, upColor: base.up, downColor: base.down };
}

/**
 * Pushes the appearance subset into the palette every pane reads, and into the CSS custom
 * properties the surrounding chrome reads. Called on load and on every change, so the chart
 * follows the control on the next frame with no reload.
 */
export function applyAppearance(settings: ChartSettings): void {
  const base = settings.theme === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
  Object.assign(THEME, base, {
    bg: settings.paneBackground,
    up: settings.upColor,
    down: settings.downColor,
    upFill: withAlpha(settings.upColor, 0.16),
    downFill: withAlpha(settings.downColor, 0.16),
    grid: settings.showGrid ? base.grid : TRANSPARENT,
    gridMajor: settings.showGrid ? base.gridMajor : TRANSPARENT,
  });
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.style.setProperty('--bg', settings.paneBackground);
  root.style.setProperty('--up', settings.upColor);
  root.style.setProperty('--down', settings.downColor);
}
