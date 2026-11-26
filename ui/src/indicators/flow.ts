/**
 * Print-derived input for the delta indicators.
 *
 * The footprint window the app already holds carries aggressive buy and sell quantity
 * per bar, so the delta family computes from that same response rather than asking the
 * server for a second copy of the prints. Only the bars the response covers carry flow:
 * stored prints begin at the venue's own oldest print, and a request only reaches as far
 * back as it was told to, so an uncovered bar reads NaN and draws a gap. A flat line at
 * zero would claim balanced trading where nothing is known.
 */

import type { Bar, FootprintSeries } from '../types';
import { sma, type Values } from './tas';

const DAY_MS = 86_400_000;

/** Aggressive volume in one bar, straight from the prints behind it. */
export interface BarFlow {
  buy: number;
  sell: number;
  prints: number;
}

/**
 * What the loaded prints say about the bars in view. `coveredFrom` and `coveredTo` are
 * the oldest and newest bar start the prints actually reached; everything outside them
 * is unknown rather than zero.
 */
export interface PrintFlow {
  instrument: string;
  timeframe: string;
  /** Bar start → aggressive buy and sell quantity, for the covered bars only. */
  byStart: ReadonlyMap<number, BarFlow>;
  coveredFrom: number | null;
  coveredTo: number | null;
  /** Prints behind the covered bars. */
  prints: number;
  /** True until a response for the window in view has arrived. */
  loading: boolean;
  /** Why the window came back empty, when the request itself failed. */
  error: string | null;
}

/**
 * Folds a footprint response into the per-bar flow the delta indicators read. The
 * response lists bars oldest first, and every bar satisfies `totalQty = buy + sell` and
 * `delta = buy - sell`, so the two sides come back out of those two fields instead of
 * walking every price cell again.
 */
export function printFlow(series: FootprintSeries | null, loading: boolean, error: string | null = null): PrintFlow {
  const byStart = new Map<number, BarFlow>();
  let prints = 0;
  if (series) {
    for (const bar of series.bars) {
      byStart.set(bar.start, {
        buy: (bar.totalQty + bar.delta) / 2,
        sell: (bar.totalQty - bar.delta) / 2,
        prints: bar.trades,
      });
      prints += bar.trades;
    }
  }
  const starts = series ? series.bars.map((bar) => bar.start) : [];
  return {
    instrument: series?.instrument ?? '',
    timeframe: series?.timeframe ?? '',
    byStart,
    coveredFrom: starts.length > 0 ? (starts[0] as number) : null,
    coveredTo: starts.length > 0 ? (starts[starts.length - 1] as number) : null,
    prints,
    loading,
    error,
  };
}

export function flowDelta(bars: readonly Bar[], flow: PrintFlow | null): Values {
  return bars.map((bar) => {
    const value = flow?.byStart.get(bar.start);
    return value ? value.buy - value.sell : Number.NaN;
  });
}

export function flowVolume(bars: readonly Bar[], flow: PrintFlow | null): Values {
  return bars.map((bar) => {
    const value = flow?.byStart.get(bar.start);
    return value ? value.buy + value.sell : Number.NaN;
  });
}

/** Where the running delta sum restarts. Names and default come from the shipped `cvd_anchor`. */
export type CvdAnchor = 'UTC day' | 'Continuous';

export const CVD_ANCHORS: readonly CvdAnchor[] = ['UTC day', 'Continuous'];

/**
 * Delta added up bar by bar, restarted whenever the anchor bucket changes. Bars the
 * prints do not cover leave a hole in the line but do not move the running total: the
 * prints that would have filled them are simply not stored.
 */
export function cumulativeDelta(bars: readonly Bar[], flow: PrintFlow | null, anchor: CvdAnchor): Values {
  const out: Values = new Array<number>(bars.length).fill(Number.NaN);
  let bucket = Number.NaN;
  let total = 0;
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (!bar) continue;
    const id = anchor === 'UTC day' ? Math.floor(bar.start / DAY_MS) : 0;
    if (id !== bucket) {
      bucket = id;
      total = 0;
    }
    const value = flow?.byStart.get(bar.start);
    if (!value) continue;
    total += value.buy - value.sell;
    out[i] = total;
  }
  return out;
}

/**
 * How much of the trading over `period` bars was done by the aggressive side that won:
 * net delta as a percentage of volume, the same ratio the footprint's `deltaPct` column
 * prints, read over a window instead of one price level. Bounded at ±100.
 */
export function flowDominance(bars: readonly Bar[], flow: PrintFlow | null, period: number): Values {
  const delta = sma(flowDelta(bars, flow), period);
  const volume = sma(flowVolume(bars, flow), period);
  const out: Values = new Array<number>(bars.length).fill(Number.NaN);
  for (let i = 0; i < bars.length; i += 1) {
    const d = delta[i] ?? Number.NaN;
    const v = volume[i] ?? Number.NaN;
    if (Number.isFinite(d) && Number.isFinite(v) && v > 0) out[i] = (d / v) * 100;
  }
  return out;
}

/**
 * What the indicators have to say about the prints behind them: nothing drawn until a
 * window arrives, an honest statement when the window holds no prints, and the covered
 * range whenever only part of the view is backed by prints.
 */
export function flowNote(flow: PrintFlow | null): string | undefined {
  if (!flow || (flow.loading && flow.coveredFrom === null)) return 'loading prints…';
  if (flow.coveredFrom === null || flow.coveredTo === null) return flow.error ?? 'no prints stored for this window';
  if (flow.coveredFrom === flow.coveredTo) return `prints stored for ${stamp(flow.coveredFrom)} only`;
  return `prints stored from ${stamp(flow.coveredFrom)} to ${stamp(flow.coveredTo)}`;
}

/** UTC stamp: the anchor and the print spans are both quoted in UTC. */
function stamp(time: number): string {
  return `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
