import type { ProfileBucket, VolumeProfile } from '../types';

/**
 * Volume-profile maths: turning the venue-tick buckets `/api/profile` returns into the
 * rows the pane can actually draw, and reading the value area back out of the response.
 */

/** One display row: every bucket whose price falls inside `low` (inclusive) to `high`. */
export interface ProfileRow {
  low: number;
  high: number;
  buyQty: number;
  sellQty: number;
  totalQty: number;
}

export interface ProfileLadder {
  /** Rows in ascending price order; row 0 is the lowest band. */
  rows: ProfileRow[];
  /** Price width of one row, 0 when the span is degenerate. */
  step: number;
  /** Largest row total, the length every bar is normalised against. */
  maxRowQty: number;
  /** Sum of every row total, which equals the window's traded quantity inside the span. */
  totalQty: number;
}

export const MIN_ROWS = 8;
export const MAX_ROWS = 140;

/** How many rows fit in `plotHeight` at `rowPx` each, clamped to a readable range. */
export function rowCountFor(plotHeight: number, rowPx: number): number {
  return Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.floor(plotHeight / Math.max(1, rowPx))));
}

/**
 * Folds buckets into `rowCount` equal bands over `lo`..`hi`, summing buy, sell and
 * total per band. `/api/profile` has no price-step parameter, so a busy window arrives
 * as tens of thousands of one-tick buckets; this keeps the pane's work proportional to
 * its own height instead of the bucket count.
 */
export function buildLadder(
  buckets: readonly ProfileBucket[],
  lo: number,
  hi: number,
  rowCount: number,
): ProfileLadder {
  const span = hi - lo;
  const step = span > 0 ? span / rowCount : 0;
  const rows: ProfileRow[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    rows.push({
      low: lo + index * step,
      high: lo + (index + 1) * step,
      buyQty: 0,
      sellQty: 0,
      totalQty: 0,
    });
  }
  let maxRowQty = 0;
  let totalQty = 0;
  if (step > 0) {
    for (const bucket of buckets) {
      if (!Number.isFinite(bucket.price) || bucket.price < lo || bucket.price > hi) continue;
      const index = Math.min(rowCount - 1, Math.floor((bucket.price - lo) / step));
      const row = rows[index];
      if (!row) continue;
      row.buyQty += bucket.buyQty;
      row.sellQty += bucket.sellQty;
      row.totalQty += bucket.totalQty;
      if (row.totalQty > maxRowQty) maxRowQty = row.totalQty;
      totalQty += bucket.totalQty;
    }
  }
  return { rows, step, maxRowQty, totalQty };
}

/**
 * Price span the rows tile: the prices the window actually traded, padded by half a row
 * so the top and bottom bands come out whole. The pane fits itself to the profile rather
 * than to the chart's price range, because bar wicks routinely span several times the
 * range the prints inside the same window cover, and rows tiled over the wick range would
 * leave most of the pane empty.
 */
export function spanFor(profile: VolumeProfile, rowCount: number): { lo: number; hi: number } {
  const extent = tradedExtent(profile.buckets);
  if (!extent) return { lo: 0, hi: 1 };
  const raw = extent.high - extent.low;
  const pad = raw > 0
    ? raw / Math.max(2, rowCount * 2)
    : Math.max(profile.priceTick, Math.abs(extent.high) * 1e-9, 1e-9);
  return { lo: extent.low - pad, hi: extent.high + pad };
}

/** Lowest and highest price the window traded at. */
export function tradedExtent(buckets: readonly ProfileBucket[]): { low: number; high: number } | null {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const bucket of buckets) {
    if (!Number.isFinite(bucket.price)) continue;
    if (bucket.price < low) low = bucket.price;
    if (bucket.price > high) high = bucket.price;
  }
  return high >= low ? { low, high } : null;
}

/**
 * Value-area bounds, high first. The endpoint widens out from the POC, so `vah` is the
 * upper bound and `val` the lower; the ordering is asserted rather than trusted, and a
 * single-bucket value area where both are equal still returns a band of zero height.
 */
export function valueAreaBounds(profile: VolumeProfile): { high: number; low: number } | null {
  const vah = profile.vah;
  const val = profile.val;
  if (vah === null || val === null || !Number.isFinite(vah) || !Number.isFinite(val)) return null;
  return vah >= val ? { high: vah, low: val } : { high: val, low: vah };
}
