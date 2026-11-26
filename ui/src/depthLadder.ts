import type { DepthLevel, DepthSnapshot, Instrument } from './types';
import { THEME, el } from './canvasKit';
import { decimalsForStep, fmtPrice, fmtSize } from './format';

const ROWS_PER_SIDE = 13;

interface Row {
  price: number;
  qty: number;
  cumulative: number;
}

/**
 * Live DOM ladder: grouped bid and ask levels, a cumulative size column that shows
 * resting liquidity behind each level, and a spread row between the two sides.
 */
export class DepthLadder {
  private readonly title = el('div', 'ladder-title');
  private readonly body = el('div', 'ladder-body');
  private readonly footer = el('div', 'ladder-foot');
  private snapshot: DepthSnapshot | null = null;
  private instrument: Instrument | null = null;
  private dirty = false;

  constructor(root: HTMLElement) {
    root.classList.add('ladder-panel');
    this.title.textContent = 'Depth';
    root.append(this.title, el('div', 'ladder-head', 'price / size / total'), this.body, this.footer);
  }

  setInstrument(instrument: Instrument | null): void {
    this.instrument = instrument;
    this.snapshot = null;
    this.body.replaceChildren();
    this.footer.textContent = instrument ? 'waiting for depth' : '';
    this.title.textContent = instrument ? `Depth · ${instrument.display}` : 'Depth';
    this.dirty = true;
  }

  update(snapshot: DepthSnapshot): void {
    this.snapshot = snapshot;
    this.dirty = true;
  }

  /** Rebuilds rows at most once per animation frame. */
  flush(now: number): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.render(now);
  }

  private render(now: number): void {
    const snapshot = this.snapshot;
    const instrument = this.instrument;
    if (!snapshot || !instrument) {
      this.footer.textContent = instrument ? 'waiting for depth' : '';
      return;
    }
    const tick = instrument.priceTick > 0 ? instrument.priceTick : 0.01;
    const precision = instrument.pricePrecision;
    const bestBid = extremePrice(snapshot.bids, 'max');
    const bestAsk = extremePrice(snapshot.asks, 'min');
    const spread = Number.isFinite(bestAsk) && Number.isFinite(bestBid) ? bestAsk - bestBid : Number.NaN;
    const step = groupingStep(tick, spread);

    const bids = groupLevels(snapshot.bids, step, ROWS_PER_SIDE, 'bid');
    const asks = groupLevels(snapshot.asks, step, ROWS_PER_SIDE, 'ask');
    const maxTotal = Math.max(...bids.map((row) => row.cumulative), ...asks.map((row) => row.cumulative), 1e-12);

    // Both sides are drawn high price to low, so the best levels meet at the spread row.
    // Rows come back high to low, so the best ask is the first ask row and the best bid
    // the last bid row. Position, not price, marks them: grouping can move a bucket off
    // the exact best price.
    const fragment = document.createDocumentFragment();
    asks.forEach((row, index) => fragment.append(this.row(row, 'ask', maxTotal, precision, instrument.qtyPrecision, index === 0)));
    fragment.append(this.spreadRow(bestBid, bestAsk, spread, precision, now, snapshot.ts));
    bids.forEach((row, index) => fragment.append(this.row(row, 'bid', maxTotal, precision, instrument.qtyPrecision, index === bids.length - 1)));
    this.body.replaceChildren(fragment);

    const bidTotal = farTotal(bids);
    const askTotal = farTotal(asks);
    const imbalance = bidTotal + askTotal > 0 ? ((bidTotal - askTotal) / (bidTotal + askTotal)) * 100 : 0;
    this.footer.replaceChildren(
      stat('spread', Number.isFinite(spread) ? fmtPrice(spread, precision) : '—'),
      stat(
        'spread %',
        Number.isFinite(spread) && Number.isFinite(bestBid) && bestBid > 0
          ? `${fmtRatio((spread / bestBid) * 100)}`
          : '—',
      ),
      stat('bid/ask %', `${imbalance.toFixed(1)}`),
      stat('age', `${Math.max(0, Math.round((now - snapshot.ts) / 100) / 10)}s`),
    );
    this.title.textContent = `Depth · ${instrument.display} · ${fmtPrice(step, Math.max(precision, decimalsForStep(step)))} grouping`;
  }

  private row(
    row: Row,
    side: 'bid' | 'ask',
    maxTotal: number,
    precision: number,
    qtyPrecision: number,
    isBest: boolean,
  ): HTMLElement {
    const line = el('div', `ladder-row ladder-${side}`);
    const fill = el('i');
    const share = Math.min(1, row.cumulative / maxTotal);
    fill.style.width = `${(share * 100).toFixed(1)}%`;
    fill.style.background = side === 'bid' ? THEME.upFill : THEME.downFill;
    const price = el('span', 'cell cell-price', fmtPrice(row.price, precision));
    const qty = el('span', 'cell cell-qty', fmtSize(row.qty, qtyPrecision));
    const total = el('span', 'cell cell-total', fmtSize(row.cumulative, qtyPrecision));
    price.classList.toggle('is-best', isBest);
    line.append(fill, price, qty, total);
    return line;
  }

  private spreadRow(
    bestBid: number,
    bestAsk: number,
    spread: number,
    precision: number,
    now: number,
    stamp: number,
  ): HTMLElement {
    const line = el('div', 'ladder-row ladder-spread');
    const mid = Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? (bestBid + bestAsk) / 2 : Number.NaN;
    line.append(
      el('span', 'cell cell-price', Number.isFinite(mid) ? fmtPrice(mid, precision) : '—'),
      el('span', 'cell cell-qty', Number.isFinite(spread) ? `±${fmtPrice(spread / 2, precision)}` : '—'),
      el('span', 'cell cell-total', `${Math.max(0, Math.round((now - stamp) / 100) / 10)}s`),
    );
    return line;
  }
}

/** Keeps a one-tick spread on a 59,000 market readable instead of rounding to 0. */
function fmtRatio(percent: number): string {
  const magnitude = Math.abs(percent);
  if (magnitude === 0) return '0.000';
  if (magnitude >= 0.01) return percent.toFixed(3);
  return percent.toFixed(5);
}

function stat(label: string, value: string): HTMLElement {
  const wrap = el('span', 'ladder-stat');
  wrap.append(el('b', undefined, label), el('span', undefined, value));
  return wrap;
}

/**
 * Largest 1/2/5 multiple of the tick that still fits inside the spread. Grouping wider
 * than the spread would fold the best bid and best ask into one displayed price.
 */
function groupingStep(tick: number, spread: number): number {
  const ceiling = Number.isFinite(spread) ? Math.max(spread, tick) : tick;
  let step = tick;
  for (let decade = 1; decade <= 1e6; decade *= 10) {
    for (const multiplier of [1, 2, 5]) {
      const candidate = tick * decade * multiplier;
      if (candidate <= ceiling) step = candidate;
    }
  }
  return Number(step.toFixed(10));
}

function extremePrice(levels: DepthLevel[], want: 'min' | 'max'): number {
  let best = Number.NaN;
  for (const level of levels) {
    if (!Number.isFinite(best)) best = level.price;
    else if (want === 'min' ? level.price < best : level.price > best) best = level.price;
  }
  return best;
}

/** Total resting size at the far end of the ladder, where the cumulative peaks. */
function farTotal(rows: Row[]): number {
  let total = 0;
  for (const row of rows) total = Math.max(total, row.cumulative);
  return total;
}

/**
 * Collapse raw levels into fixed-size price buckets. The `limit` buckets nearest the
 * spread are kept; rows come back high price to low so both sides meet at the spread.
 */
function groupLevels(levels: DepthLevel[], step: number, limit: number, side: 'bid' | 'ask'): Row[] {
  if (levels.length === 0) return [];
  const buckets = new Map<number, number>();
  for (const level of levels) {
    const bucket = Number((Math.round(level.price / step) * step).toFixed(10));
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + level.qty);
  }
  // Nearest the spread first: bids descend, asks ascend.
  const keys = [...buckets.keys()].sort((a, b) => (side === 'bid' ? b - a : a - b));
  const rows: Row[] = [];
  let cumulative = 0;
  for (const key of keys.slice(0, limit)) {
    const qty = buckets.get(key) ?? 0;
    cumulative += qty;
    rows.push({ price: key, qty, cumulative });
  }
  rows.sort((a, b) => b.price - a.price);
  return rows;
}
