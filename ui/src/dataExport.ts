/**
 * Chart data as CSV: the bars the chart is showing, and the prints behind a range.
 *
 * Both files are plain tabular data — a header row and one row per record — so they open
 * in a spreadsheet with no cleanup. What a file holds is decided by the caller; what it
 * claims to hold is reported here, because the server answers at most `API_ROW_CAP` rows
 * per request and an export that stops there is partial, not complete.
 */

import type { Bar, Trade } from './types';

/**
 * The `limit` clamp the server puts on `/api/bars` and `/api/trades`
 * (`crates/server/src/api.rs`). A request that comes back with exactly this many rows
 * stopped at the clamp, so the file is missing whatever the range still held.
 */
export const API_ROW_CAP = 200_000;

export interface CsvResult {
  csv: string;
  /** Data rows written, not counting the header. */
  rows: number;
  columns: string[];
  /** True when the row count reached `API_ROW_CAP`, so the range was cut short. */
  capped: boolean;
  /** Rows that carry a delta value; zero when no delta column was written. */
  deltaRows: number;
}

/** Bar start → per-bar delta, from the footprint response. Absent means no prints. */
export type DeltaByStart = ReadonlyMap<number, number>;

/** Columns a bars file gets, with `delta` only when the prints reach into the window. */
export function barColumns(delta: DeltaByStart | null | undefined, bars: readonly Bar[]): string[] {
  const columns = ['time', 'open', 'high', 'low', 'close', 'volume'];
  if (hasDelta(delta, bars)) columns.push('delta');
  return columns;
}

function hasDelta(delta: DeltaByStart | null | undefined, bars: readonly Bar[]): boolean {
  if (!delta || delta.size === 0) return false;
  return bars.some((bar) => Number.isFinite(delta.get(bar.start) ?? Number.NaN));
}

/**
 * One row per bar, oldest first, in `time,open,high,low,close,volume[,delta]`. The delta
 * column appears only when the caller hands over a map that covers at least one of these
 * bars; a bar the prints never reached leaves its delta cell empty rather than claiming
 * zero, which is what the delta indicators do for the same gap.
 */
export function barsToCsv(bars: readonly Bar[], delta: DeltaByStart | null = null): CsvResult {
  const columns = barColumns(delta, bars);
  const withDelta = columns.includes('delta');
  let deltaRows = 0;
  const lines = [columns.join(',')];
  for (const bar of bars) {
    const value = withDelta ? delta?.get(bar.start) : undefined;
    const cells = [isoUtc(bar.start), bar.open, bar.high, bar.low, bar.close, bar.volume];
    if (withDelta) {
      const known = value !== undefined && Number.isFinite(value);
      if (known) deltaRows += 1;
      cells.push(known ? String(value) : '');
    }
    lines.push(cells.map(csvCell).join(','));
  }
  return {
    csv: lines.join(LINE_END),
    rows: bars.length,
    columns,
    capped: bars.length >= API_ROW_CAP,
    deltaRows,
  };
}

/**
 * One row per print, oldest first: `time,seq,price,qty,aggressor`. `/api/trades` answers
 * newest first and stops at `API_ROW_CAP`, so `capped` is the caller's only signal that
 * the oldest half of the range is missing from the file.
 */
export function printsToCsv(trades: readonly Trade[]): CsvResult {
  const columns = ['time', 'seq', 'price', 'qty', 'aggressor'];
  const lines = [columns.join(',')];
  for (const trade of trades) {
    lines.push([isoUtc(trade.ts), trade.seq, trade.price, trade.qty, trade.aggressor].map(csvCell).join(','));
  }
  return {
    csv: lines.join(LINE_END),
    rows: trades.length,
    columns,
    capped: trades.length >= API_ROW_CAP,
    deltaRows: 0,
  };
}

/** RFC 4180 quoting, so a stray comma or quote in a text field cannot split a row. */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Bar and print times go out as ISO-8601 UTC: no zone to guess, and the column sorts. */
export function isoUtc(ms: number): string {
  return new Date(ms).toISOString();
}

const LINE_END = '\r\n';

/** Row count of a CSV the way a spreadsheet counts it: the header is not a record. */
export function countCsvRows(csv: string): number {
  if (csv === '') return 0;
  const lines = csv.split(LINE_END).filter((line) => line !== '');
  return Math.max(0, lines.length - 1);
}
