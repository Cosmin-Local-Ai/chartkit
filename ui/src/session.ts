import type { Bar, Instrument } from './types';
import { LocalTime } from './format';

const DAY_MS = 86_400_000;

interface Window {
  day: number;
  openMin: number;
  closeMin: number;
}

function parseWindows(instrument: Instrument | null): Window[] {
  if (!instrument) return [];
  return instrument.session.windows.map(([day, open, close]) => ({
    day,
    openMin: LocalTime.parseClockTime(open),
    closeMin: LocalTime.parseClockTime(close),
  }));
}

function inWindow(minutes: number, window: Window): boolean {
  return window.closeMin >= window.openMin
    ? minutes >= window.openMin && minutes < window.closeMin
    : minutes >= window.openMin || minutes < window.closeMin;
}

/** True when `ms` falls inside a configured session window; continuous venues are always in. */
export function isSessionTime(ms: number, windows: Window[], local: LocalTime): boolean {
  if (windows.length === 0) return true;
  const day = local.weekday(ms);
  const minutes = Math.floor((local.local(ms) % DAY_MS) / 60_000);
  for (const window of windows) {
    if (window.day === day && inWindow(minutes, window)) return true;
    // A window that wraps past midnight belongs to the previous weekday after 00:00.
    if (window.closeMin < window.openMin && window.day === (day + 6) % 7 && minutes < window.closeMin) return true;
  }
  return false;
}

export interface SessionSegment {
  /** Index of the first bar of a new run of in-session (or out-of-session) bars. */
  index: number;
  start: number;
  open: boolean;
}

/** Runs of off-session bars, so the price pane can shade them and mark the breaks. */
export function sessionSegments(bars: readonly Bar[], instrument: Instrument | null, local: LocalTime): SessionSegment[] {
  const windows = parseWindows(instrument);
  if (windows.length === 0) return [];
  const segments: SessionSegment[] = [];
  let previous = true;
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (!bar) continue;
    const open = isSessionTime(bar.start, windows, local);
    if (open !== previous) {
      segments.push({ index: i, start: bar.start, open });
      previous = open;
    }
  }
  return segments;
}

/**
 * Boundaries of the trading day on the axis clock, for a venue that trades around the
 * clock and so publishes no session windows. Marked `open` so the divider is drawn without
 * off-session shading, and they move when the axis timezone does.
 */
export function dayBoundarySegments(bars: readonly Bar[], local: LocalTime): SessionSegment[] {
  const segments: SessionSegment[] = [];
  let previous = Number.NaN;
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (!bar) continue;
    const day = local.dayKey(bar.start);
    if (day !== previous) {
      if (Number.isFinite(previous)) segments.push({ index: i, start: bar.start, open: true });
      previous = day;
    }
  }
  return segments;
}

export interface GapMark {
  index: number;
  from: number;
  to: number;
  /** Wall-clock length of the hole, used to decide whether the break deserves a label. */
  span: number;
}

/**
 * Holes in the stored series: a spacing wider than the nominal bar interval means
 * bars are missing (venue closed, or history not stored yet). The x mapping is
 * index based, so holes collapse; the mark keeps the boundary visible instead of
 * drawing a misleading continuous tape.
 */
export function findGaps(bars: readonly Bar[], barMs: number, minBars = 1.6): GapMark[] {
  const gaps: GapMark[] = [];
  if (bars.length < 2 || !(barMs > 0)) return gaps;
  const threshold = barMs * minBars;
  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1];
    const current = bars[i];
    if (!prev || !current) continue;
    const span = current.start - prev.start;
    if (span > threshold) gaps.push({ index: i, from: prev.start, to: current.start, span });
  }
  return gaps;
}

export interface SessionReference {
  /** Close of the last bar before the current session began; the change baseline. */
  price: number;
  at: number;
}

/**
 * Reference price for the session-over-session change figure: the close of the bar
 * that precedes the current trading day (or the current session window when the
 * venue has one).
 */
export function previousSessionClose(
  bars: readonly Bar[],
  instrument: Instrument | null,
  local: LocalTime,
  now: number,
): SessionReference | null {
  const last = bars[bars.length - 1];
  if (!last) return null;
  const windows = parseWindows(instrument);
  let boundary: number;
  if (windows.length === 0) {
    boundary = local.startOfDay(now);
  } else {
    boundary = local.startOfDay(now);
    // Walk back at most a week for the most recent session open.
    for (let offset = 0; offset <= 7; offset += 1) {
      const candidate = boundary - offset * DAY_MS;
      if (isSessionOpenAt(candidate, windows, local)) break;
    }
  }
  let reference: SessionReference | null = null;
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    const bar = bars[i];
    if (!bar) continue;
    if (bar.start < boundary) {
      reference = { price: bar.close, at: bar.start };
      break;
    }
  }
  if (reference) return reference;
  const first = bars[0];
  return first ? { price: first.open, at: first.start } : null;
}

function isSessionOpenAt(ms: number, windows: Window[], local: LocalTime): boolean {
  return isSessionTime(ms, windows, local);
}
