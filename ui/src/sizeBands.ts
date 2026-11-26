/**
 * The client's side of the size-band split.
 *
 * The server decides the bands: it aggregates the prints in SQL and sends the edges, the
 * labels and the sentence saying how they were chosen. Nothing here recomputes an edge —
 * the client reads them off the response, so the chart, the pane and the API answer cannot
 * disagree about which prints counted as a block.
 *
 * What lives here is the shape the indicator and the pane read: the per-band series the
 * CVD-by-size lines compute from, and the coverage note that says what the prints actually
 * reached. Bars the response does not carry read as unknown rather than zero, exactly as
 * the plain delta family does.
 */

import type { Bar, SizeBand, SizeBandCell, SizeBandSeries, SizeUnit } from './types';
import type { CvdAnchor } from './indicators/flow';
import type { Values } from './indicators/tas';

const DAY_MS = 86_400_000;

/**
 * What the loaded size-band window says about the bars in view. `coveredFrom` and
 * `coveredTo` are the oldest and newest bar the answer actually carries; a bar outside
 * them is unknown, not balanced.
 */
export interface SizeBandFlow {
  instrument: string;
  timeframe: string;
  /** The bands, in order, exactly as the server named them. */
  bands: readonly SizeBand[];
  /** Why those edges, in the server's own words. */
  bandRule: string;
  sizeUnit: SizeUnit;
  /** Bar start → one cell per band, for the covered bars only. */
  byStart: ReadonlyMap<number, readonly SizeBandCell[]>;
  coveredFrom: number | null;
  coveredTo: number | null;
  prints: number;
  /** The covered window as a whole, one cell per band. */
  totals: readonly SizeBandCell[];
  loading: boolean;
  error: string | null;
}

/** The shape a delta-by-size series reads when no window has arrived yet. */
export function emptySizeBandFlow(loading: boolean, error: string | null = null): SizeBandFlow {
  return {
    instrument: '',
    timeframe: '',
    bands: [],
    bandRule: '',
    sizeUnit: 'notional',
    byStart: new Map(),
    coveredFrom: null,
    coveredTo: null,
    prints: 0,
    totals: [],
    loading,
    error,
  };
}

/**
 * Folds a size-band response into what the indicators compute from. The response lists
 * bars oldest first and every bar carries one cell per band, including the bands that saw
 * nothing, so a series can index by band without checking the answer was dense.
 */
export function sizeBandFlow(
  series: SizeBandSeries | null,
  loading: boolean,
  error: string | null = null,
): SizeBandFlow {
  if (!series) return emptySizeBandFlow(loading, error);
  const byStart = new Map<number, readonly SizeBandCell[]>();
  for (const bar of series.bars) byStart.set(bar.start, bar.bands);
  const starts = series.bars.map((bar) => bar.start);
  return {
    instrument: series.instrument,
    timeframe: series.timeframe,
    bands: series.bands,
    bandRule: series.bandRule,
    sizeUnit: series.sizeUnit,
    byStart,
    coveredFrom: starts.length > 0 ? (starts[0] as number) : null,
    coveredTo: starts.length > 0 ? (starts[starts.length - 1] as number) : null,
    prints: series.prints,
    totals: series.totals,
    loading,
    error,
  };
}

/** The band's aggressive volume in one bar, or NaN when the prints do not reach it. */
export function bandValues(
  bars: readonly Bar[],
  flow: SizeBandFlow | null,
  band: number,
  pick: (cell: SizeBandCell) => number,
): Values {
  return bars.map((bar) => {
    const cells = flow?.byStart.get(bar.start);
    const cell = cells?.[band];
    return cell ? pick(cell) : Number.NaN;
  });
}

export function bandDelta(bars: readonly Bar[], flow: SizeBandFlow | null, band: number): Values {
  return bandValues(bars, flow, band, (cell) => cell.buyQty - cell.sellQty);
}

/**
 * One band's running delta, restarted whenever the anchor bucket changes — the same rule
 * the plain CVD line follows, applied to one band at a time. Bars the answer does not
 * cover leave a hole in the line without moving the running total.
 */
export function bandCumulative(bars: readonly Bar[], flow: SizeBandFlow | null, band: number, anchor: CvdAnchor): Values {
  const out: Values = new Array<number>(bars.length).fill(Number.NaN);
  let bucket = Number.NaN;
  let total = 0;
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    if (!bar) continue;
    const id = anchor === 'UTC day' ? Math.floor(bar.start / DAY_MS) : 0;
    if (id !== bucket) {
      bucket = id;
      total = 0;
    }
    const cell = flow?.byStart.get(bar.start)?.[band];
    if (!cell) continue;
    total += cell.buyQty - cell.sellQty;
    out[index] = total;
  }
  return out;
}

/** The exclusive upper edges of the bands, in order. The top band has none. */
export function bandEdges(bands: readonly SizeBand[]): number[] {
  return bands.map((band) => band.max).filter((edge): edge is number => edge !== null);
}

/**
 * Which band a print size falls in, by the edges the server sent: the first edge the size
 * is under, or the top band when it is under none. Edges are exclusive, so a size exactly
 * on an edge belongs to the band above it and to no other — the same rule the SQL applies.
 */
export function bandIndexFor(size: number, bands: readonly SizeBand[]): number {
  for (let index = 0; index < bands.length; index += 1) {
    const edge = bands[index]?.max;
    if (edge !== null && edge !== undefined && size < edge) return index;
  }
  return Math.max(0, bands.length - 1);
}

/** The band a size belongs to, named in the server's own words. */
export function bandLabelFor(bands: readonly SizeBand[], size: number): string {
  return bands[bandIndexFor(size, bands)]?.label ?? '';
}

/** Buy minus sell in one band of the covered window; 0 when nothing is covered. */
export function bandTotalDelta(flow: SizeBandFlow | null, band: number): number {
  return flow?.totals[band] ? flow.totals[band].buyQty - flow.totals[band].sellQty : 0;
}

/**
 * What the size bands have to say about the prints behind them: nothing drawn until a
 * window arrives, an honest statement when the window holds no prints, and the covered
 * range whenever only part of the view is backed by prints.
 */
export function sizeBandNote(flow: SizeBandFlow | null): string | undefined {
  if (!flow || (flow.loading && flow.coveredFrom === null)) return 'loading size bands…';
  if (flow.coveredFrom === null || flow.coveredTo === null) return flow.error ?? 'no prints stored for this window';
  if (flow.coveredFrom === flow.coveredTo) return `prints stored for ${stamp(flow.coveredFrom)} only`;
  return `prints stored from ${stamp(flow.coveredFrom)} to ${stamp(flow.coveredTo)}`;
}

/** UTC stamp: the print spans the server reports are quoted in UTC. */
function stamp(time: number): string {
  return `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
