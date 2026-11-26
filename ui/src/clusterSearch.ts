/**
 * The client's side of a cluster search: finding the big prints in a window.
 *
 * The server decides everything about size. It filters the stored prints in SQL, sends the
 * rows newest first, and sends the counts of the window they were searched in, so the list
 * can be capped without pretending the answer was that small. Nothing here re-derives a
 * threshold or a notional — the numbers on screen are the numbers the server filtered on,
 * which is the same measure `/api/cvd-by-size` splits its bands by.
 *
 * What lives here is what the dialog and the price-pane markers read: the rows to list, the
 * cells to print, and the one line that says what the search actually did. That last part is
 * the difference between an empty list that means "searched, nothing was big enough", an
 * empty list that means "this window holds no prints", and a search that failed.
 */

import type { ClusterBar, ClusterPrint, ClusterSearchSeries, SizeUnit } from './types';
import { fmtCompact, fmtPrice, fmtSize } from './format';

/** What one search was asked for, kept so the note can name the threshold it came back on. */
export interface ClusterRequest {
  instrument: string;
  /** Interval the per-bar cluster counts are grouped by — the chart's own interval. */
  timeframe: string;
  from: number;
  /** Exclusive, like every other print window. */
  to: number;
  threshold: number;
  unit: SizeUnit;
}

/**
 * The search as the dialog shows it. `error` and `loading` are kept apart from the answer on
 * purpose: a failed search must not render as a successful one that found nothing.
 */
export interface ClusterSearchState {
  series: ClusterSearchSeries | null;
  loading: boolean;
  error: string | null;
  /** The window the answer on screen belongs to, or null while nothing has been searched. */
  asked: ClusterRequest | null;
}

export function emptyClusterSearch(loading = false, error: string | null = null, asked: ClusterRequest | null = null): ClusterSearchState {
  return { series: null, loading, error, asked };
}

export function clusterSearchState(
  series: ClusterSearchSeries | null,
  loading: boolean,
  error: string | null,
  asked: ClusterRequest | null,
): ClusterSearchState {
  return { series, loading, error, asked };
}

/** Which aggressor the list is narrowed to. */
export type SideFilter = 'all' | 'buy' | 'sell';

/** The list narrowed to one aggressor, or to rows whose text contains `text`. */
export interface RowFilter {
  side: SideFilter;
  /** Free text matched against the row as the table prints it. */
  text: string;
}

export function noRowFilter(): RowFilter {
  return { side: 'all', text: '' };
}

/** The cells one row is printed as, in table order: time, price, size, notional, side. */
export interface RowCells {
  time: string;
  price: string;
  size: string;
  notional: string;
  side: string;
}

/**
 * One print as the table shows it. `time` comes from the caller's clock, so a search reads in
 * the timezone the chart is set to instead of the browser's.
 */
export function rowCells(
  row: ClusterPrint,
  clock: (ms: number) => string,
  pricePrecision: number,
  qtyPrecision: number,
): RowCells {
  return {
    time: clock(row.ts),
    price: fmtPrice(row.price, pricePrecision),
    size: fmtSize(row.qty, qtyPrecision),
    notional: fmtCompact(row.notional),
    side: row.aggressor === 'buy' ? 'buy' : 'sell',
  };
}

/** True when the row belongs in the list: the aggressor asked for, and the text it matches. */
export function rowMatches(row: ClusterPrint, filter: RowFilter, cells: RowCells): boolean {
  if (filter.side !== 'all' && row.aggressor !== filter.side) return false;
  const needle = filter.text.trim().toLowerCase();
  if (!needle) return true;
  return Object.values(cells).some((cell) => cell.toLowerCase().includes(needle));
}

/**
 * The rows to list, newest first as the server sent them, narrowed by the filter. The count
 * of rows is never the answer's size: `series.clusters` is, and the note says so.
 */
export function selectRows(
  series: ClusterSearchSeries | null,
  filter: RowFilter,
  clock: (ms: number) => string,
  pricePrecision: number,
  qtyPrecision: number,
): ClusterPrint[] {
  const rows = series?.rows ?? [];
  if (filter.side === 'all' && !filter.text.trim()) return rows.slice();
  return rows.filter((row) =>
    rowMatches(row, filter, rowCells(row, clock, pricePrecision, qtyPrecision)),
  );
}

/** One print's identity: the pair the store keys it by. */
export function printKey(row: ClusterPrint): string {
  return `${row.ts}:${row.seq}`;
}

/** Start of the bar a print belongs to. */
export function barStartFor(ts: number, barMs: number): number {
  if (!(barMs > 0)) return ts;
  return Math.floor(ts / barMs) * barMs;
}

/**
 * Where a bar's cluster sits on the price axis: the volume-weighted price of the prints that
 * cleared the threshold, not the bar's close. A 40-lot that printed at the low of the bar is
 * marked at the low.
 */
export function markerPrice(bar: ClusterBar): number {
  if (!(bar.qty > 0) || !(bar.notional > 0)) return Number.NaN;
  return bar.notional / bar.qty;
}

/** Bars worth marking: the ones that hold at least one cluster print, oldest first. */
export function markerBars(series: ClusterSearchSeries | null): ClusterBar[] {
  return (series?.bars ?? []).filter((bar) => bar.prints > 0 && Number.isFinite(markerPrice(bar)));
}

/** Buy or sell carried the bar: the marker's colour, and NaN when neither outweighs. */
export function markerSide(bar: ClusterBar): 'buy' | 'sell' | 'mixed' {
  if (bar.buyN > bar.sellN) return 'buy';
  if (bar.sellN > bar.buyN) return 'sell';
  return 'mixed';
}

/** A size written the way the server writes its band edges: 5k, 1.5M, 0.25. */
export function fmtSizeLabel(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1_000_000_000) return `${trim(value / 1_000_000_000)}B`;
  if (value >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trim(value / 1_000)}k`;
  return String(value);
}

function trim(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(Math.round(rounded)) : String(rounded);
}

/**
 * The line that says what the search did, worst case first: a failed search, then a search
 * still running, then a window with no prints at all, then a window whose prints were all too
 * small, then the answer with its cap stated. A truncated list always says it is a slice, so a
 * trader never reads "400 prints" as "the window held 400".
 */
export function clusterSearchNote(state: ClusterSearchState): string {
  const { series, loading, error, asked } = state;
  if (error) return `search failed: ${error}`;
  if (loading && !series) return 'searching the stored prints…';
  if (!series) return asked ? 'no answer yet for this window' : 'pick a window and a threshold, then search';
  const window = windowText(series.from, series.to);
  if (series.prints === 0) {
    return `${window}: no prints stored, so there was nothing to search. The window was asked of the venue and came back empty.`;
  }
  const at = `${fmtSizeLabel(series.threshold)} ${series.sizeUnit === 'quantity' ? 'base quantity' : 'quote notional'}`;
  if (series.clusters === 0) {
    return `${window}: ${grouped(series.prints)} prints scanned, none at or above ${at}.`;
  }
  const parts = [
    `${window}: ${grouped(series.prints)} prints scanned, ${grouped(series.clusters)} at or above ${at}.`,
    `${series.returned} newest listed${
      series.truncated
        ? ` · the list is capped at ${grouped(series.limit)}, so ${grouped(series.clusters - series.returned)} more are not shown.`
        : '.'
    }`,
    `${grouped(series.bars.reduce((bars, bar) => bars + (bar.prints > 0 ? 1 : 0), 0))} bar${series.bars.length === 1 ? '' : 's'} marked on the chart.`,
  ];
  if (loading) parts.push('re-running…');
  return parts.filter(Boolean).join(' ');
}

/** The searched window, in the same UTC terms the store reports its print ranges in. */
function windowText(from: number | null, to: number | null): string {
  if (from === null || to === null) return 'Stored history';
  return `${stamp(from)} to ${stamp(to)}`;
}

function stamp(time: number): string {
  return `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function grouped(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}
