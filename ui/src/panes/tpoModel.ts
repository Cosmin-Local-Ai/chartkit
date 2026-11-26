import type { TpoBucket, TpoCell, TpoSeries, TpoSession } from '../types';
import type { TpoGrading, TpoSettings } from '../tpoSettings';
import { bucketMinutes } from '../tpoSettings';

/**
 * The reading side of the letter grid: which session to feature, what the answer actually
 * covers, how wide a price row to ask for, and how a cell is graded. Nothing here redraws —
 * the pane takes these and paints.
 */

/** Row heights the pane will settle for, so a thread-thin pane still draws readable letters. */
export const MIN_ROWS = 8;
export const MAX_ROWS = 120;

/** How many price rows fit in `plotHeight` at `rowPx` each. */
export function rowCountFor(plotHeight: number, rowPx: number): number {
  return Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.floor(plotHeight / Math.max(1, rowPx))));
}

/**
 * Price row width in venue ticks for a pane `rowCount` rows tall over a `priceSpan` range.
 *
 * The width is rounded up to a `1 / 2 / 5 × 10ⁿ` multiple of the tick, because the row width
 * travels in the request: an exact division would change on every pan of the price axis and
 * refetch a window that draws identically either way. Levels do not move with it — the server
 * reads the point of control and the value area off its own price grid whatever row width it
 * folds the answer to.
 */
export function stepTicksFor(priceSpan: number, priceTick: number, rowCount: number): number {
  if (!(priceSpan > 0) || !(priceTick > 0) || rowCount < 1) return 1;
  const raw = priceSpan / priceTick / rowCount;
  if (raw <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  for (const step of [1, 2, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= raw - 1e-9) return Math.max(1, Math.round(candidate));
  }
  return Math.max(1, Math.ceil(raw));
}

/** The session the pane features: the one still open, else the newest that traded. */
export function featuredSession(series: TpoSeries): TpoSession | null {
  const newestFirst = [...series.sessions].reverse();
  return (
    newestFirst.find((session) => session.developing && session.buckets.length > 0) ??
    newestFirst.find((session) => session.buckets.length > 0) ??
    series.sessions[0] ??
    null
  );
}

/** Value-area bounds, high first. A single-row value area returns a band of zero height. */
export function valueAreaBounds(session: TpoSession): { high: number; low: number } | null {
  const { vah, val } = session;
  if (vah === null || val === null || !Number.isFinite(vah) || !Number.isFinite(val)) return null;
  return vah >= val ? { high: vah, low: val } : { high: val, low: vah };
}

/** Lowest and highest price the answer traded, over every session it carries. */
export function tradedExtent(series: TpoSeries): { low: number; high: number } | null {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const session of series.sessions) {
    for (const bucket of session.buckets) {
      for (const [price] of bucket.rows) {
        if (!Number.isFinite(price)) continue;
        if (price < low) low = price;
        if (price > high) high = price;
      }
    }
  }
  return high >= low ? { low, high } : null;
}

/**
 * What the answer's own prints reach, in words. A window wider than the stored prints, or one
 * whose oldest buckets fell off the answer's bucket limit, has to say so: an absent bucket is
 * a stretch the prints do not cover, not a session nobody traded in. Null when the prints
 * cover the asked window, which is the common case and needs no note.
 */
export function coverageNote(series: TpoSeries, askedFrom: number, askedTo: number): string | null {
  if (series.sessions.length === 0 || series.coveredFrom === null || series.coveredTo === null) {
    return 'no prints stored for this window';
  }
  const bucketMs = Math.max(1, series.bucketMinutes) * 60_000;
  // The newest bucket covers up to its own end, so the asked window is met when the prints
  // reach within one bucket of either edge.
  const from = series.coveredFrom;
  const to = series.coveredTo + bucketMs;
  if (from <= askedFrom && to >= askedTo - bucketMs) return null;
  const gap = Math.max(0, Math.round((askedTo - askedFrom) / 60_000));
  const covered = Math.max(0, Math.round((to - from) / 60_000));
  if (covered <= 0) return 'no prints stored for this window';
  return `prints cover ${covered} of the ${gap} minutes asked for; buckets outside it are not empty, they are unanswered`;
}

/** The number a cell's shade is normalised against, as the grading setting wants it. */
export function cellGrade(cell: TpoCell, grading: TpoGrading): number {
  switch (grading) {
    case 'delta':
      return Math.abs(cell.buyQty - cell.sellQty);
    case 'total':
      return cell.buyN + cell.sellN;
    case 'volume':
      return cell.buyQty + cell.sellQty;
  }
}

/** Largest cell grade across the buckets, the length every cell is normalised against. */
export function maxCellGrade(buckets: readonly TpoBucket[], grading: TpoGrading): number {
  let max = 0;
  for (const bucket of buckets) {
    for (const [, cell] of bucket.rows) {
      const grade = cellGrade(cell, grading);
      if (grade > max) max = grade;
    }
  }
  return max;
}

/** One cell of the grid, placed on the pane's price scale. */
export interface TpoGridCell {
  price: number;
  top: number;
  bottom: number;
  cell: TpoCell;
  grade: number;
  inValueArea: boolean;
}

/** One bucket placed on the pane's time axis: its letter, its x range, and its cells. */
export interface TpoColumn {
  start: number;
  end: number;
  letter: string;
  sessionIndex: number;
  developing: boolean;
  cells: TpoGridCell[];
  poc: number | null;
}

/**
 * Buckets of every session in the answer, in time order, with the value-area membership each
 * cell has inside its own session. Sessions are kept apart because their levels are: a cell
 * inside one session's value area is not inside the next one's.
 */
export function columnsFor(
  series: TpoSeries,
  settings: TpoSettings,
  bucketWidthMs: number,
): TpoColumn[] {
  const columns: TpoColumn[] = [];
  series.sessions.forEach((session, sessionIndex) => {
    const area = valueAreaBounds(session);
    for (const bucket of session.buckets) {
      columns.push({
        start: bucket.start,
        end: bucket.start + bucketWidthMs,
        letter: bucket.letter,
        sessionIndex,
        developing: session.developing,
        poc: bucket.poc,
        cells: bucket.rows.map(([price, cell]) => ({
          price,
          top: price,
          bottom: price + series.stepTicks * series.priceTick,
          cell,
          grade: cellGrade(cell, settings.cellGrading),
          inValueArea: area !== null && price >= area.low && price <= area.high,
        })),
      });
    }
  });
  return columns;
}

/**
 * Minutes the time axis has to show for the buckets to fit `plotWidth` at one letter each.
 * The pane asks for a window this wide, so a bucket is always at least a letter wide on screen
 * and two neighbours never overlap into an unreadable smear.
 */
export function minutesToFit(plotWidth: number, bucketMinutesValue: number, minPxPerBucket: number): number {
  const buckets = Math.max(1, Math.floor(plotWidth / Math.max(1, minPxPerBucket)));
  return buckets * bucketMinutesValue;
}

/** Time span one bucket occupies, so the pane's columns and the server's letters agree. */
export function bucketWidthMs(settings: TpoSettings): number {
  return Math.max(1, bucketMinutes(settings)) * 60_000;
}

/** Letter the `index`th bucket of a session carries, read off the answer itself. */
export function letterAt(session: TpoSession, index: number): string | null {
  return session.buckets[index]?.letter ?? null;
}
