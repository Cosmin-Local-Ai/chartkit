import { decimalsForStep, roundToStep } from '../format';
import type { PriceScale, XScale } from '../scale';

/** A drawing anchor: venue time plus price. Never pixels, so it survives pan and zoom. */
export interface DrawingAnchor {
  time: number;
  price: number;
}

export interface Pt {
  x: number;
  y: number;
}

export interface AnchorContext {
  x: XScale;
  price: PriceScale;
  /** Venue price increment: a placed price always lands on it. */
  priceTick: number;
}

/**
 * Bar index for a stored time. Exact bar starts map to their index; a time between
 * two bars interpolates, and a time past the newest bar extrapolates, which is how
 * a drawing keeps its place in the blank tape right of the last bar.
 */
export function indexForTime(time: number, x: XScale): number {
  const count = x.count;
  if (count === 0 || !Number.isFinite(time)) return 0;
  const barMs = Math.max(1, x.barMs);
  const last = x.startAt(count - 1) ?? 0;
  if (time >= last) return count - 1 + (time - last) / barMs;
  const first = x.startAt(0) ?? 0;
  if (time <= first) return (time - first) / barMs;
  const lower = lowerBound(time, x);
  const a = x.startAt(lower);
  if (a === undefined) return 0;
  if (a === time) return lower;
  const b = x.startAt(lower + 1) ?? a + barMs;
  return lower + (time - a) / Math.max(1, b - a);
}

/** Inverse of `indexForTime`: the time an index stands for, blank tape included. */
export function timeForIndex(index: number, x: XScale): number {
  const count = x.count;
  if (count === 0 || !Number.isFinite(index)) return 0;
  const barMs = Math.max(1, x.barMs);
  const last = x.startAt(count - 1) ?? 0;
  if (index >= count - 1) return last + (index - (count - 1)) * barMs;
  const first = x.startAt(0) ?? 0;
  if (index <= 0) return first + index * barMs;
  const lower = Math.floor(index);
  const a = x.startAt(lower) ?? 0;
  if (index === lower) return a;
  const b = x.startAt(lower + 1) ?? a + barMs;
  return a + (index - lower) * (b - a);
}

/** Largest index whose bar start is at or before `time`; binary search over bar starts. */
function lowerBound(time: number, x: XScale): number {
  let low = 0;
  let high = x.count - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    const start = x.startAt(mid);
    if (start !== undefined && start <= time) low = mid;
    else high = mid - 1;
  }
  return low;
}

export function anchorToPixel(anchor: DrawingAnchor, ctx: AnchorContext): Pt {
  return { x: ctx.x.toX(indexForTime(anchor.time, ctx.x)), y: ctx.price.toY(anchor.price) };
}

export function pixelToAnchor(px: number, py: number, ctx: AnchorContext): DrawingAnchor {
  return { time: timeForIndex(snapIndex(px, ctx.x), ctx.x), price: snapPrice(py, ctx) };
}

/** Nearest bar index, never left of the oldest bar; the right edge stays open for blank tape. */
export function snapIndex(px: number, x: XScale): number {
  return Math.max(0, Math.round(x.toIndex(px)));
}

/**
 * Price under the cursor, rounded onto the venue tick and trimmed to the decimals
 * that tick needs, so a stored price is exactly the quoted increment.
 */
export function snapPrice(py: number, ctx: AnchorContext): number {
  const tick = ctx.priceTick > 0 ? ctx.priceTick : 0.01;
  return Number(roundToStep(ctx.price.fromY(py), tick).toFixed(decimalsForStep(tick)));
}
