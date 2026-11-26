/**
 * Heikin Ashi: a display-only transform of the stored bars. Indicators, drawings, the
 * volume pane and the auto-fit range keep reading the raw bars, so smoothing the tape
 * never moves a value the user measured or drew against.
 *
 * Each HA bar comes from its own raw bar plus the HA bar before it:
 *   close = (open + high + low + close) / 4
 *   open  = (previous HA open + previous HA close) / 2, or (open + close) / 2 for the first
 *   high  = max(raw high, HA open, HA close)
 *   low   = min(raw low,  HA open, HA close)
 * Time, volume, trades and the closed flag carry through untouched.
 */

import type { Bar } from './types';

/** A bar whose OHLC can seed the chain. A gap or a broken print has to step around it. */
function usable(bar: Bar | undefined | null): boolean {
  return !!bar && Number.isFinite(bar.open) && Number.isFinite(bar.high) && Number.isFinite(bar.low) && Number.isFinite(bar.close);
}

/** One HA bar. `previous` is the HA bar before it, or null at the head of the chain. */
export function heikinAshiBar(bar: Bar, previous: Bar | null): Bar {
  if (!usable(bar)) return { ...bar };
  const close = (bar.open + bar.high + bar.low + bar.close) / 4;
  const open = previous ? (previous.open + previous.close) / 2 : (bar.open + bar.close) / 2;
  return {
    ...bar,
    open,
    high: Math.max(bar.high, open, close),
    low: Math.min(bar.low, open, close),
    close,
  };
}

/** The whole series as HA bars; unusable bars are copied through and skipped by the chain. */
export function heikinAshi(bars: readonly Bar[]): Bar[] {
  const out: Bar[] = [];
  let previous: Bar | null = null;
  for (const bar of bars) {
    const value = heikinAshiBar(bar, previous);
    out.push(value);
    if (usable(value)) previous = value;
  }
  return out;
}

/**
 * Memoizes the transform for the price pane, which asks for it on every repaint.
 * Between frames only the newest bar moves, and history grows one bar at a time, so
 * both cases repair or extend the existing chain instead of rebuilding 38k bars.
 */
export class HeikinAshiCache {
  private values: Bar[] = [];
  /** Signature of the series the current output was built from. */
  private whole = '';
  /** The same signature without the newest bar, which is what a live update leaves alone. */
  private tail = '';

  of(bars: readonly Bar[]): readonly Bar[] {
    const n = bars.length;
    const whole = signature(bars, n);
    if (whole === this.whole && this.values.length === n) return this.values;
    const tail = signature(bars, Math.max(0, n - 1));
    const newest = n > 0 ? bars[n - 1] ?? null : null;
    const replaced = this.values.length === n && tail === this.tail;
    const appended = this.values.length === n - 1 && tail === this.whole;
    if (newest && (replaced || appended)) {
      const previous = chainPredecessor(this.values, this.values.length - 1);
      const value = heikinAshiBar(newest, previous);
      if (appended) this.values.push(value);
      else this.values[this.values.length - 1] = value;
    } else {
      this.values = heikinAshi(bars);
    }
    this.whole = whole;
    this.tail = tail;
    return this.values;
  }
}

/** The nearest earlier HA bar that can seed the next one, or null at the head. */
function chainPredecessor(values: readonly Bar[], index: number): Bar | null {
  for (let i = index - 1; i >= 0; i -= 1) if (usable(values[i])) return values[i] ?? null;
  return null;
}

/**
 * Cheap identity for the first `count` bars: how many, the oldest start, and the newest
 * bar's start, close and closed flag, which is everything a recompute can depend on.
 */
function signature(bars: readonly Bar[], count: number): string {
  if (count <= 0) return 'empty';
  const first = bars[0];
  const last = bars[count - 1];
  if (!first || !last) return 'empty';
  return `${count}:${first.start}:${last.start}:${last.close}:${last.closed ? 1 : 0}`;
}
