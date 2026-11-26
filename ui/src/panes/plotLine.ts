import type { PriceScale, XScale } from '../scale';

/**
 * Canvas primitives for indicator series, shared by price-pane overlays and
 * offchart panes: a polyline that breaks wherever the series has no value, and the
 * band fill between two of them.
 */

/**
 * Draw one series as a polyline, breaking the path wherever the indicator has no
 * value. `smooth` bends each segment through its midpoints, which is what the
 * shipped `smooth` plot option does: the numbers stay untouched.
 */
export function drawPolyline(
  ctx: CanvasRenderingContext2D,
  values: readonly number[],
  x: XScale,
  scale: PriceScale,
  first: number,
  last: number,
  color: string,
  width: number,
  smooth: boolean,
): void {
  const from = Math.max(0, first);
  const to = Math.min(values.length - 1, last);
  if (to < from) return;
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, width);
  ctx.lineJoin = 'round';
  let drawing = false;
  let previousX = 0;
  let previousY = 0;
  for (let i = from; i <= to; i += 1) {
    const value = values[i];
    if (value === undefined || !Number.isFinite(value)) {
      if (drawing) ctx.stroke();
      drawing = false;
      continue;
    }
    const px = x.toX(i);
    const py = scale.toY(value);
    if (!drawing) {
      ctx.moveTo(px, py);
      drawing = true;
    } else if (smooth) {
      ctx.quadraticCurveTo(previousX, previousY, (previousX + px) / 2, (previousY + py) / 2);
    } else {
      ctx.lineTo(px, py);
    }
    previousX = px;
    previousY = py;
  }
  if (drawing) ctx.stroke();
}

/** Shade the area between two series, e.g. the inside of a Bollinger band. */
export function fillBetween(
  ctx: CanvasRenderingContext2D,
  upper: readonly number[],
  lower: readonly number[],
  x: XScale,
  scale: PriceScale,
  first: number,
  last: number,
  color: string,
): void {
  const from = Math.max(0, first);
  const to = Math.min(Math.min(upper.length, lower.length) - 1, last);
  if (to <= from) return;
  let started = false;
  ctx.beginPath();
  for (let i = from; i <= to; i += 1) {
    const top = upper[i];
    const bottom = lower[i];
    if (top === undefined || bottom === undefined || !Number.isFinite(top) || !Number.isFinite(bottom)) {
      if (started) break;
      continue;
    }
    const px = x.toX(i);
    if (!started) {
      ctx.moveTo(px, scale.toY(top));
      started = true;
    } else {
      ctx.lineTo(px, scale.toY(top));
    }
  }
  if (!started) return;
  for (let i = to; i >= from; i -= 1) {
    const bottom = lower[i];
    const top = upper[i];
    if (bottom === undefined || top === undefined || !Number.isFinite(bottom) || !Number.isFinite(top)) continue;
    ctx.lineTo(x.toX(i), scale.toY(bottom));
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/**
 * Bars from the zero line to the value, used by the MACD and delta histograms.
 * `negativeColor` paints the bars below zero a second color, which is how a delta
 * histogram shows which side paid for the bar.
 */
export function drawHistogram(
  ctx: CanvasRenderingContext2D,
  values: readonly number[],
  x: XScale,
  scale: PriceScale,
  first: number,
  last: number,
  color: string,
  bodyWidth: number,
  negativeColor?: string,
): void {
  const zero = scale.toY(0);
  const from = Math.max(0, first);
  const to = Math.min(values.length - 1, last);
  for (let i = from; i <= to; i += 1) {
    const value = values[i];
    if (value === undefined || !Number.isFinite(value)) continue;
    const px = x.toX(i);
    const y = scale.toY(value);
    fillRectBetween(ctx, px - bodyWidth / 2, Math.min(y, zero), bodyWidth, Math.max(1, Math.abs(y - zero)), value < 0 ? (negativeColor ?? color) : color);
  }
}

function fillRectBetween(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
}
