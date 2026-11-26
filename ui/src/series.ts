import { api } from './api';
import type { Bar } from './types';
import { estimateBarMs, timeframeMs } from './timeframes';

/**
 * Stored bars for one instrument and interval, plus the lazy history window.
 * The server always answers with the newest bars inside the requested range, so
 * older pages are pulled with `to = oldest - 1` and prepended.
 */
export class Series {
  bars: Bar[] = [];
  instrument = '';
  timeframe = '';
  barMs = 60_000;
  loadingOlder = false;
  olderExhausted = false;
  error: string | null = null;
  /** Bumped on every symbol/interval switch so late responses are discarded. */
  private generation = 0;

  get size(): number {
    return this.bars.length;
  }

  lastBar(): Bar | null {
    return this.bars[this.bars.length - 1] ?? null;
  }

  firstBar(): Bar | null {
    return this.bars[0] ?? null;
  }

  /** Binary search for a bar start; -1 when absent. */
  indexOfStart(start: number): number {
    let low = 0;
    let high = this.bars.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const bar = this.bars[mid];
      if (!bar) break;
      if (bar.start === start) return mid;
      if (bar.start < start) low = mid + 1;
      else high = mid - 1;
    }
    return -1;
  }

  async load(instrument: string, timeframe: string, limit = 1500): Promise<number> {
    const generation = ++this.generation;
    this.instrument = instrument;
    this.timeframe = timeframe;
    this.bars = [];
    this.barMs = timeframeMs(timeframe) ?? 60_000;
    this.olderExhausted = false;
    this.loadingOlder = true;
    this.error = null;
    try {
      const response = await api.bars(instrument, timeframe, { limit });
      if (generation !== this.generation) return 0;
      this.bars = response.bars.slice().sort((a, b) => a.start - b.start);
      this.barMs = estimateBarMs(this.bars, timeframeMs(timeframe));
      this.olderExhausted = this.bars.length < Math.min(limit, 200_000);
      return this.bars.length;
    } catch (error) {
      if (generation === this.generation) this.error = errorMessage(error);
      throw error;
    } finally {
      if (generation === this.generation) this.loadingOlder = false;
    }
  }

  /** Pull one page of older bars. Resolves with the number added. */
  async loadOlder(pageSize = 600): Promise<number> {
    const oldest = this.firstBar();
    if (this.loadingOlder || this.olderExhausted || !oldest || this.instrument === '') return 0;
    const generation = this.generation;
    this.loadingOlder = true;
    try {
      const response = await api.bars(this.instrument, this.timeframe, {
        to: oldest.start - 1,
        limit: pageSize,
      });
      if (generation !== this.generation) return 0;
      const older = response.bars.filter((bar) => bar.start < oldest.start);
      if (older.length > 0) {
        this.bars = older.concat(this.bars);
        this.barMs = estimateBarMs(this.bars, timeframeMs(this.timeframe));
      }
      if (response.bars.length < pageSize) this.olderExhausted = true;
      return older.length;
    } catch (error) {
      this.error = errorMessage(error);
      return 0;
    } finally {
      if (generation === this.generation) this.loadingOlder = false;
    }
  }

  /**
   * Fold one live `bar` message into the series. Returns what happened so callers
   * can decide whether a redraw or a legend refresh is needed.
   */
  applyBar(bar: Bar): 'replaced' | 'appended' | 'ignored' {
    const last = this.lastBar();
    if (!last) {
      this.bars = [bar];
      this.barMs = estimateBarMs(this.bars, timeframeMs(this.timeframe));
      return 'appended';
    }
    if (bar.start === last.start) {
      this.bars[this.bars.length - 1] = bar;
      return 'replaced';
    }
    if (bar.start > last.start) {
      this.bars.push(bar);
      this.barMs = estimateBarMs(this.bars, timeframeMs(this.timeframe));
      return 'appended';
    }
    const index = this.indexOfStart(bar.start);
    if (index >= 0) {
      this.bars[index] = bar;
      return 'replaced';
    }
    return 'ignored';
  }

  /** Highest and lowest value in an index window, used to auto-fit the price axis. */
  rangeIn(first: number, last: number): { min: number; max: number } | null {
    if (this.bars.length === 0 || last < first) return null;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = Math.max(0, first); i <= Math.min(this.bars.length - 1, last); i += 1) {
      const bar = this.bars[i];
      if (!bar) continue;
      if (bar.low < min) min = bar.low;
      if (bar.high > max) max = bar.high;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    return { min, max };
  }
}

/** Index of the bar with this exact start time, or -1. */
export function binarySearchStart(bars: readonly { start: number }[], start: number): number {
  let low = 0;
  let high = bars.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const bar = bars[mid];
    if (!bar) return -1;
    if (bar.start === start) return mid;
    if (bar.start < start) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
