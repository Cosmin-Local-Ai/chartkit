/**
 * Pure footprint computation: price-row grouping, cell metric values, imbalance
 * detection, value-area levels, naked levels, unfinished auction and stats rows.
 * The pane only draws what this produces.
 */

import type { FootprintBar, FootprintSeries } from '../types';
import {
  valueAreaForMode,
  type CellMetric,
  type FootprintSettings,
  type StatsRowMetric,
} from '../footprintSettings';

export interface FootprintRow {
  priceLow: number;
  priceHigh: number;
  labelPrice: number;
  buyQty: number;
  sellQty: number;
  buyN: number;
  sellN: number;
  total: number;
  delta: number;
  /** Bid volume one row higher, the diagonal counterpart of this row's ask. */
  diagonalBuy: number;
  /** Ask volume one row lower, the diagonal counterpart of this row's bid. */
  diagonalSell: number;
  isPoc: boolean;
  isVah: boolean;
  isVal: boolean;
  inValueArea: boolean;
  buyImbalance: boolean;
  sellImbalance: boolean;
  /** Length of the imbalance run this row belongs to, 0 when unflagged. */
  imbalanceRun: number;
  /** Top-of-print row the auction failed to extend past. */
  unfinished: boolean;
  metrics: Record<CellMetric, number>;
}

export interface Ladder {
  rows: FootprintRow[];
  /** Price span of one row. */
  step: number;
  /** Stored ticks aggregated into one row. */
  group: number;
  pocIndex: number;
  vahIndex: number;
  valIndex: number;
  /** Highest and lowest row index that carries prints. */
  topIndex: number;
  bottomIndex: number;
}

export interface NakedLevel {
  price: number;
  kind: 'poc' | 'vah' | 'val';
  /** Index in `series.bars` of the bar that produced the level. */
  barIndex: number;
}

export interface BarScale {
  peakSide: number;
  peakTotal: number;
  peakDelta: number;
}

/**
 * Rows for one bar, grouped to a readable 1-2-5 price step aligned to absolute
 * multiples of the tick so the labels stay round. `rowsAvailable` bounds the count.
 */
export function buildLadder(
  bar: FootprintBar,
  rowsAvailable: number,
  tick: number,
  settings: FootprintSettings,
): Pick<Ladder, 'rows' | 'step' | 'group'> | null {
  const first = bar.cells[0];
  const last = bar.cells[bar.cells.length - 1];
  if (!first || !last || tick <= 0) return null;
  const minPrice = first[0];
  const maxPrice = last[0];
  const maxTicks = Math.max(0, Math.round((maxPrice - minPrice) / tick));
  const bucketOf = (price: number, perRow: number) => Math.floor(Math.round(price / tick) / perRow);
  let group = Math.max(1, Math.ceil((maxTicks + 1) / Math.max(1, rowsAvailable)));
  let step = Math.max(tick, Math.ceil(niceStepOf(group * tick) / tick) * tick);
  group = Math.max(1, Math.round(step / tick));
  const baseBucket = bucketOf(minPrice, group);
  let rowCount = bucketOf(maxPrice, group) - baseBucket + 1;
  while (rowCount > rowsAvailable) {
    group *= 2;
    step = group * tick;
    rowCount = bucketOf(maxPrice, group) - baseBucket + 1;
  }
  if (rowCount > rowsAvailable || rowCount <= 0) return null;

  let rows: FootprintRow[] = [];
  for (let i = 0; i < rowCount; i += 1) {
    const low = (baseBucket + i) * group * tick;
    rows.push({
      priceLow: low,
      priceHigh: low + step - tick,
      labelPrice: low,
      buyQty: 0,
      sellQty: 0,
      buyN: 0,
      sellN: 0,
      total: 0,
      delta: 0,
      diagonalBuy: 0,
      diagonalSell: 0,
      isPoc: false,
      isVah: false,
      isVal: false,
      inValueArea: false,
      buyImbalance: false,
      sellImbalance: false,
      imbalanceRun: 0,
      unfinished: false,
      metrics: {} as Record<CellMetric, number>,
    });
  }
  const rowAt = (price: number): FootprintRow | null => {
    const index = bucketOf(price, group) - baseBucket;
    if (index < 0 || index >= rows.length) return null;
    return rows[index] ?? null;
  };
  for (const [price, cell] of bar.cells) {
    const row = rowAt(price);
    if (!row) continue;
    row.buyQty += cell.buyQty;
    row.sellQty += cell.sellQty;
    row.buyN += cell.buyN;
    row.sellN += cell.sellN;
  }
  for (const row of rows) {
    row.total = row.buyQty + row.sellQty;
    row.delta = row.buyQty - row.sellQty;
  }

  // `skipZeroValues` drops rows that carry no prints, so the ladder shows only levels
  // that actually traded; `threshold` drops rows below a volume floor.
  const keep = (row: FootprintRow): boolean => {
    if (settings.skipZeroValues && row.total <= 0) return false;
    if (settings.threshold > 0 && row.total < settings.threshold) return false;
    return true;
  };
  const kept = rows.filter(keep);
  if (kept.length === 0) return null;
  if (kept.length !== rows.length) rows = kept;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) continue;
    row.diagonalBuy = rows[i + 1]?.buyQty ?? 0;
    row.diagonalSell = rows[i - 1]?.sellQty ?? 0;
    row.metrics = metricValues(row);
  }
  return { rows, step, group };
}

function metricValues(row: FootprintRow): Record<CellMetric, number> {
  return {
    // `bidAsk` and `splitBar` draw both sides; the number is only used for shading.
    bidAsk: row.total,
    delta: row.delta,
    deltaColored: row.delta,
    diagonalDelta: row.diagonalBuy - row.sellQty,
    deltaPct: row.total > 0 ? (row.delta / row.total) * 100 : 0,
    volume: row.total,
    buy: row.buyQty,
    sell: row.sellQty,
    volumeBar: row.total,
    deltaBar: row.delta,
    volumeBarLeading: row.total,
    splitBar: row.total,
  };
}

/** 1-2-5 ladder step at or above `raw`. */
function niceStepOf(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalized = raw / magnitude;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return multiplier * magnitude;
}

/** Marks POC, value area, VAH and VAL rows for the ladder. */
export function markLevels(ladder: Ladder, bar: FootprintBar, settings: FootprintSettings): void {
  const { rows } = ladder;
  const fraction = valueAreaForMode(settings.displayMode, settings.valueArea);
  let pocIndex = -1;
  let peak = -1;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) continue;
    if (row.total > peak) {
      peak = row.total;
      pocIndex = i;
    }
    if (bar.cells.length > 0 && bar.poc >= row.priceLow && bar.poc <= row.priceHigh) pocIndex = i;
  }
  ladder.pocIndex = pocIndex;
  const pocRow = pocIndex >= 0 ? rows[pocIndex] : null;
  if (pocRow) pocRow.isPoc = true;

  let bottom = 0;
  let top = rows.length - 1;
  while (bottom <= top && (rows[bottom]?.total ?? 0) <= 0) bottom += 1;
  while (top >= bottom && (rows[top]?.total ?? 0) <= 0) top -= 1;
  ladder.bottomIndex = bottom;
  ladder.topIndex = top;
  if (pocIndex < 0 || bottom > top) {
    ladder.vahIndex = -1;
    ladder.valIndex = -1;
    return;
  }

  let total = 0;
  for (const row of rows) total += row.total;
  const target = total * Math.max(0.05, Math.min(1, fraction));
  let covered = rows[pocIndex]?.total ?? 0;
  let lo = pocIndex;
  let hi = pocIndex;
  while (covered < target && (lo > bottom || hi < top)) {
    const below = lo > bottom ? (rows[lo - 1]?.total ?? -1) : -1;
    const above = hi < top ? (rows[hi + 1]?.total ?? -1) : -1;
    if (above >= below) {
      hi += 1;
      covered += rows[hi]?.total ?? 0;
    } else {
      lo -= 1;
      covered += rows[lo]?.total ?? 0;
    }
  }
  ladder.valIndex = lo;
  ladder.vahIndex = hi;
  for (let i = lo; i <= hi; i += 1) {
    const row = rows[i];
    if (row) row.inValueArea = true;
  }
  const vah = rows[hi];
  const val = rows[lo];
  if (vah) vah.isVah = true;
  if (val) val.isVal = true;
}

/**
 * Imbalance flags. `diagonal` uses the shipped geometry: a buy imbalance is recorded at
 * the higher price when the ask below it outweighs the bid above it by `imbalanceRatio`
 * (and the mirror for sells); `horizontal` compares the two sides of one row.
 * `stackedImbalances` then drops runs shorter than the required count.
 */
export function markImbalances(rows: FootprintRow[], settings: FootprintSettings): void {
  if (!settings.imbalance) return;
  const ratio = Math.max(1, settings.imbalanceRatio);
  const minVolume = Math.max(0, settings.imbalanceMinVolume);
  const pass = (value: number): boolean => value > 0 && value >= minVolume;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const above = rows[i + 1];
    const below = rows[i - 1];
    if (!row) continue;
    if (settings.imbalanceMethod === 'horizontal') {
      if (pass(row.buyQty) && pass(row.sellQty) && row.buyQty >= row.sellQty * ratio) row.buyImbalance = true;
      if (pass(row.sellQty) && pass(row.buyQty) && row.sellQty >= row.buyQty * ratio) row.sellImbalance = true;
      continue;
    }
    // Diagonal pairs reach one row away, so both sides of the pair must carry volume.
    if (above && pass(above.buyQty) && pass(row.sellQty) && row.sellQty >= above.buyQty * ratio) {
      above.buyImbalance = true;
    }
    if (below && pass(row.buyQty) && pass(below.sellQty) && row.buyQty >= below.sellQty * ratio) {
      row.sellImbalance = true;
    }
  }
  applyStackedRuns(rows, Math.max(1, Math.round(settings.stackedImbalances)));
}

/** Keeps only imbalance runs of `minRun` rows and records each run's length. */
function applyStackedRuns(rows: FootprintRow[], minRun: number): void {
  for (const side of ['buy', 'sell'] as const) {
    let start = 0;
    for (let i = 0; i <= rows.length; i += 1) {
      const row = rows[i];
      const flagged = row !== undefined && (side === 'buy' ? row.buyImbalance : row.sellImbalance);
      if (flagged) continue;
      const run = rows.slice(start, i).filter((entry) => (side === 'buy' ? entry.buyImbalance : entry.sellImbalance));
      if (run.length > 0) {
        if (run.length < minRun) {
          for (const entry of run) {
            if (side === 'buy') entry.buyImbalance = false;
            else entry.sellImbalance = false;
            entry.imbalanceRun = 0;
          }
        } else {
          for (const entry of run) entry.imbalanceRun = run.length;
        }
      }
      start = i + 1;
    }
  }
}

/**
 * The unfinished auction: the top row of prints where buyers were aggressive yet price
 * never traded above. The shipped util treats the profile as having unfinished auctions
 * only when imbalances are on or the mode is `imbalance-only`.
 */
export function markUnfinishedAuction(ladder: Ladder, settings: FootprintSettings): void {
  if (!settings.showUnfinishedAuction) return;
  if (!(settings.imbalance || settings.displayMode === 'imbalance-only')) return;
  const row = ladder.rows[ladder.topIndex];
  if (!row || row.total <= 0) return;
  const ratio = Math.max(1, settings.imbalanceRatio);
  const minVolume = Math.max(0, settings.imbalanceMinVolume);
  if (row.buyQty >= minVolume && row.buyQty >= row.sellQty * ratio) row.unfinished = true;
}

/** Scales used by bar and heat cells, scoped by `scaleAndGrading`. */
export function barScale(
  series: FootprintSeries,
  selectedIndex: number,
  ladder: Ladder,
  settings: FootprintSettings,
  group: number,
  tick: number,
  dayKey: (start: number) => number,
  selectedStart: number,
): BarScale {
  const local = ladderPeaks(ladder);
  if (settings.scaleAndGrading === 'candle') return local;
  let peakSide = local.peakSide;
  let peakTotal = local.peakTotal;
  let peakDelta = local.peakDelta;
  for (let i = 0; i < series.bars.length; i += 1) {
    if (i === selectedIndex) continue;
    const bar = series.bars[i];
    if (!bar) continue;
    if (settings.scaleAndGrading === 'session' && dayKey(bar.start) !== dayKey(selectedStart)) continue;
    const scope = aggregateBar(bar, group, tick);
    peakSide = Math.max(peakSide, scope.peakSide);
    peakTotal = Math.max(peakTotal, scope.peakTotal);
    peakDelta = Math.max(peakDelta, scope.peakDelta);
  }
  return { peakSide, peakTotal, peakDelta };
}

/** Row totals for one bar at the ladder's grouping, so scales stay comparable. */
function aggregateBar(bar: FootprintBar, group: number, tick: number): BarScale {
  const buckets = new Map<number, { buy: number; sell: number }>();
  for (const [price, cell] of bar.cells) {
    const key = Math.floor(Math.round(price / tick) / group);
    const found = buckets.get(key);
    if (found) {
      found.buy += cell.buyQty;
      found.sell += cell.sellQty;
    } else buckets.set(key, { buy: cell.buyQty, sell: cell.sellQty });
  }
  let peakSide = 0;
  let peakTotal = 0;
  let peakDelta = 0;
  for (const bucket of buckets.values()) {
    peakSide = Math.max(peakSide, bucket.buy, bucket.sell);
    peakTotal = Math.max(peakTotal, bucket.buy + bucket.sell);
    peakDelta = Math.max(peakDelta, Math.abs(bucket.buy - bucket.sell));
  }
  return { peakSide, peakTotal, peakDelta };
}

/** Peak values of the rows themselves; fills an empty ladder with zeros. */
export function ladderPeaks(ladder: Ladder): BarScale {
  let peakSide = 0;
  let peakTotal = 0;
  let peakDelta = 0;
  for (const row of ladder.rows) {
    peakSide = Math.max(peakSide, row.buyQty, row.sellQty);
    peakTotal = Math.max(peakTotal, row.total);
    peakDelta = Math.max(peakDelta, Math.abs(row.delta));
  }
  return { peakSide, peakTotal, peakDelta };
}

/** POC, VAH and VAL of one bar at price granularity. */
export function barLevels(bar: FootprintBar, settings: FootprintSettings): { poc: number; vah: number; val: number } | null {
  if (bar.cells.length === 0) return null;
  const totals: { price: number; total: number }[] = [];
  let total = 0;
  let poc = bar.poc;
  let peak = -1;
  for (const [price, cell] of bar.cells) {
    const value = cell.buyQty + cell.sellQty;
    totals.push({ price, total: value });
    total += value;
    if (value > peak) {
      peak = value;
      poc = price;
    }
  }
  const pocIndex = totals.findIndex((entry) => entry.price === poc);
  if (pocIndex < 0) return null;
  const fraction = valueAreaForMode(settings.displayMode, settings.valueArea);
  const target = total * Math.max(0.05, Math.min(1, fraction));
  let covered = totals[pocIndex]?.total ?? 0;
  let lo = pocIndex;
  let hi = pocIndex;
  while (covered < target && (lo > 0 || hi < totals.length - 1)) {
    const below = lo > 0 ? (totals[lo - 1]?.total ?? -1) : -1;
    const above = hi < totals.length - 1 ? (totals[hi + 1]?.total ?? -1) : -1;
    if (above >= below) {
      hi += 1;
      covered += totals[hi]?.total ?? 0;
    } else {
      lo -= 1;
      covered += totals[lo]?.total ?? 0;
    }
  }
  return { poc, vah: totals[hi]?.price ?? poc, val: totals[lo]?.price ?? poc };
}

/**
 * Naked levels: a bar's POC/VAH/VAL that no later bar in the fetched window traded at,
 * so the level is still open. Drawn from the bar that produced it to the right edge.
 */
export function nakedLevels(
  series: FootprintSeries,
  selectedIndex: number,
  settings: FootprintSettings,
): NakedLevel[] {
  const wanted = settings.showPOCNaked || settings.showVAHNaked || settings.showVALNaked;
  if (!wanted || series.bars.length < 2) return [];
  const traded = tradedPriceSets(series);
  const levels: NakedLevel[] = [];
  for (let i = 0; i < series.bars.length; i += 1) {
    const bar = series.bars[i];
    if (!bar || i === selectedIndex) continue;
    const levelsOfBar = barLevels(bar, settings);
    if (!levelsOfBar) continue;
    for (const kind of ['poc', 'vah', 'val'] as const) {
      if (kind === 'poc' && !settings.showPOCNaked) continue;
      if (kind === 'vah' && !settings.showVAHNaked) continue;
      if (kind === 'val' && !settings.showVALNaked) continue;
      const price = levelsOfBar[kind];
      if (!Number.isFinite(price)) continue;
      let open = true;
      for (let later = i + 1; later < traded.length; later += 1) {
        if (traded[later]?.has(price.toFixed(6))) {
          open = false;
          break;
        }
      }
      if (open) levels.push({ price, kind, barIndex: i });
    }
  }
  if (levels.length === 0) return [];
  const anchor = series.bars[selectedIndex]?.poc ?? levels[0]?.price ?? 0;
  levels.sort((a, b) => Math.abs(a.price - anchor) - Math.abs(b.price - anchor));
  const cap = settings.maxNakedLevels;
  return cap > 0 ? levels.slice(0, cap) : levels;
}

/** Prices each bar traded at, keyed by the tick-rounded price string. */
export function tradedPriceSets(series: FootprintSeries): Set<string>[] {
  return series.bars.map((bar) => new Set<string>(bar.cells.map(([price]) => price.toFixed(6))));
}

/** True when no bar after `index` traded at `price`, so a level there is still open. */
export function isUntestedLater(sets: Set<string>[], index: number, price: number): boolean {
  const key = price.toFixed(6);
  for (let later = index + 1; later < sets.length; later += 1) {
    if (sets[later]?.has(key)) return false;
  }
  return true;
}

export interface StatValue {
  metric: StatsRowMetric;
  label: string;
  value: string;
  tone: 'up' | 'down' | 'flat';
}

const STAT_LABELS: Record<StatsRowMetric, string> = {
  volume: 'vol',
  buy: 'buy',
  sell: 'sell',
  mid: 'mid',
  delta: 'delta',
  deltaPct: 'delta%',
  cumDelta: 'cumΔ',
  pocPrice: 'POC',
  range: 'range',
  deltaChange: 'Δchg',
  volAbovePoc: 'vol>POC',
  volBelowPoc: 'vol<POC',
};

/** Values for the enabled stats-row metrics of the selected bar. */
export function statsValues(
  series: FootprintSeries,
  selectedIndex: number,
  settings: FootprintSettings,
  priceText: (value: number) => string,
  qtyText: (value: number) => string,
): StatValue[] {
  const bar = series.bars[selectedIndex];
  if (!bar) return [];
  const enabled = (STATS_ORDER as readonly StatsRowMetric[]).filter((metric) => settings.statsRows[metric] === true);
  if (enabled.length === 0) return [];
  let buy = 0;
  let sell = 0;
  let above = 0;
  let below = 0;
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  for (const [price, cell] of bar.cells) {
    buy += cell.buyQty;
    sell += cell.sellQty;
    const total = cell.buyQty + cell.sellQty;
    if (price > bar.poc) above += total;
    if (price < bar.poc) below += total;
    high = Math.max(high, price);
    low = Math.min(low, price);
  }
  const total = buy + sell;
  const previous = series.bars[selectedIndex - 1];
  const cumDelta = series.cvd[selectedIndex];
  const out: StatValue[] = [];
  for (const metric of enabled) {
    let value = '';
    let tone: StatValue['tone'] = 'flat';
    switch (metric) {
      case 'volume':
        value = qtyText(total);
        break;
      case 'buy':
        value = qtyText(buy);
        tone = 'up';
        break;
      case 'sell':
        value = qtyText(sell);
        tone = 'down';
        break;
      case 'mid':
        value = priceText(Number.isFinite(high) && Number.isFinite(low) ? (high + low) / 2 : bar.poc);
        break;
      case 'delta':
        value = qtyText(bar.delta);
        tone = bar.delta > 0 ? 'up' : bar.delta < 0 ? 'down' : 'flat';
        break;
      case 'deltaPct':
        value = `${total > 0 ? ((bar.delta / total) * 100).toFixed(2) : '0.00'}%`;
        tone = bar.delta > 0 ? 'up' : bar.delta < 0 ? 'down' : 'flat';
        break;
      case 'cumDelta':
        value = Number.isFinite(cumDelta) ? qtyText(cumDelta ?? 0) : '—';
        tone = (cumDelta ?? 0) > 0 ? 'up' : (cumDelta ?? 0) < 0 ? 'down' : 'flat';
        break;
      case 'pocPrice':
        value = priceText(bar.poc);
        break;
      case 'range':
        value = Number.isFinite(high) && Number.isFinite(low) ? priceText(high - low) : '—';
        break;
      case 'deltaChange': {
        const change = bar.delta - (previous?.delta ?? 0);
        value = qtyText(change);
        tone = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
        break;
      }
      case 'volAbovePoc':
        value = qtyText(above);
        break;
      case 'volBelowPoc':
        value = qtyText(below);
        break;
      default:
        continue;
    }
    out.push({ metric, label: STAT_LABELS[metric], value, tone });
  }
  return out;
}

const STATS_ORDER: readonly StatsRowMetric[] = [
  'volume',
  'buy',
  'sell',
  'mid',
  'delta',
  'deltaPct',
  'cumDelta',
  'pocPrice',
  'range',
  'deltaChange',
  'volAbovePoc',
  'volBelowPoc',
];
