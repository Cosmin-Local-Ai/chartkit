/**
 * Cluster-search results painted on the price pane.
 *
 * This is a display layer, not a set of drawings. The marks never enter the drawing
 * registry, cannot be selected, cannot be dragged, and never touch the undo stack: one search
 * over a day of BTC answers with hundreds of bars, and hundreds of undo steps would bury every
 * drawing the trader actually made. They are repainted from the search answer on each dirty
 * frame and disappear when the answer is cleared.
 *
 * A bar is marked at the volume-weighted price of the prints that cleared the threshold, so a
 * block that printed at the low of the bar is marked at the low and not at the close.
 */

import type { Frame } from '../layout';
import { PRICE_AXIS_WIDTH, TIME_AXIS_HEIGHT } from '../layout';
import type { ClusterBar, ClusterPrint, ClusterSearchSeries } from '../types';
import { THEME, drawText, measureText, withAlpha } from '../canvasKit';
import { binarySearchStart } from '../series';
import { markerBars, markerPrice, markerSide } from '../clusterSearch';

/** Diamond radius at one cluster print, and the extra it grows by per print after that. */
const BASE_RADIUS = 2.2;
const RADIUS_PER_ROOT = 1.5;
/** Radius below which the bar's cluster count is left off, because it would not fit. */
const LABEL_MIN_RADIUS = 4.4;
const LABEL_FONT = '600 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export class ClusterMarkers {
  /** The answer being marked; null clears the pane without forgetting the search. */
  data: ClusterSearchSeries | null = null;
  /** The row the trader clicked, ringed at its own price and time. */
  selected: ClusterPrint | null = null;
  /** Off while the trader wants the chart without the marks; the list stays open. */
  show = true;
  /** What the last drawn frame painted, for the console and automated checks. */
  debugInfo: Record<string, unknown> | null = null;

  clear(): void {
    this.data = null;
    this.selected = null;
    this.debugInfo = null;
  }

  /** Radius a bar's cluster is drawn at: a bar with ten clusters reads larger than one with one. */
  radiusFor(prints: number): number {
    return BASE_RADIUS + Math.min(5, Math.sqrt(Math.max(0, prints)) * RADIUS_PER_ROOT);
  }

  draw(ctx: CanvasRenderingContext2D, frame: Frame): void {
    const bars = this.show ? markerBars(this.data) : [];
    if (bars.length === 0 && !this.selected) {
      this.debugInfo = this.data ? { marked: 0, bars: this.data.bars.length } : null;
      return;
    }
    const { x, price, left, width } = frame;
    const right = width - PRICE_AXIS_WIDTH;
    const plotBottom = frame.height - (frame.axisBottom ? TIME_AXIS_HEIGHT : 0);
    let marked = 0;

    ctx.save();
    ctx.beginPath();
    ctx.rect(left, 0, Math.max(1, right - left), Math.max(1, plotBottom));
    ctx.clip();
    for (const bar of bars) {
      const at = this.place(frame, bar.start, markerPrice(bar));
      if (!at) continue;
      const radius = this.radiusFor(bar.prints);
      const colour = colourFor(bar);
      diamond(ctx, at.x, at.y, radius, withAlpha(colour, 0.72), colour);
      marked += 1;
      // The count only reads once the diamonds are far enough apart to carry text.
      if (radius >= LABEL_MIN_RADIUS && x.barStep >= 6) {
        const label = String(bar.prints);
        drawText(ctx, label, at.x - measureText(ctx, label, LABEL_FONT) / 2, at.y - radius - 7, {
          color: withAlpha(colour, 0.9),
          font: LABEL_FONT,
        });
      }
    }
    if (this.selected) {
      const at = this.place(frame, this.selected.ts, this.selected.price);
      if (at) {
        const colour = this.selected.aggressor === 'buy' ? THEME.up : THEME.down;
        ctx.strokeStyle = THEME.live;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(at.x, at.y, this.radiusFor(1) + 3.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = withAlpha(colour, 0.55);
        ctx.beginPath();
        ctx.moveTo(left, at.y);
        ctx.lineTo(right, at.y);
        ctx.stroke();
      }
    }
    ctx.restore();
    this.debugInfo = {
      marked,
      bars: this.data?.bars.length ?? 0,
      clusters: this.data?.clusters ?? 0,
      selected: this.selected ? `${this.selected.ts}:${this.selected.seq}` : null,
      show: this.show,
    };
  }

  /**
   * Pixel position of a print: the bar it belongs to plus the fraction of the bar its
   * timestamp falls at, so two prints of one bar do not stack on the same pixel.
   */
  private place(frame: Frame, ts: number, price: number): { x: number; y: number } | null {
    const bar = frame.bars[binarySearchStart(frame.bars, floorTo(ts, frame.x.barMs))];
    if (!bar || !Number.isFinite(price)) return null;
    const index = binarySearchStart(frame.bars, bar.start) + (ts - bar.start) / Math.max(1, frame.x.barMs);
    const y = frame.price.toY(price);
    const right = frame.width - PRICE_AXIS_WIDTH;
    if (!Number.isFinite(y) || y < -8 || y > frame.height + 8) return null;
    const px = frame.x.toX(index);
    if (px < frame.left - 6 || px > right + 6) return null;
    return { x: px, y };
  }
}

/** Buy or sell carried the bar; a bar that split evenly is drawn in the accent colour. */
function colourFor(bar: ClusterBar): string {
  const side = markerSide(bar);
  if (side === 'buy') return THEME.up;
  if (side === 'sell') return THEME.down;
  return THEME.accent;
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, stroke: string): void {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.stroke();
}

function floorTo(value: number, step: number): number {
  return Math.floor(value / Math.max(1, step)) * Math.max(1, step);
}
