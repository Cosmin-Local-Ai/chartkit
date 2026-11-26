import type { Frame } from '../layout';
import { PRICE_AXIS_WIDTH, TIME_AXIS_HEIGHT } from '../layout';
import { VolumeScale } from '../scale';
import type { Bar } from '../types';
import { THEME, drawText, fillRect, vLine, withAlpha } from '../canvasKit';
import { fmtCompact, fmtNumber, fmtSize } from '../format';
import { drawCrosshair, drawTimeAxis, drawTimeColumns } from './axes';

// Derived from the palette at draw time, so the rising and falling colours the settings
// dialog picks carry through to the volume bars instead of stopping at the price pane.
const volUp = (): string => withAlpha(THEME.up, 0.55);
const volDown = (): string => withAlpha(THEME.down, 0.55);
const SMA_LINE = 'rgba(203,213,225,0.65)';
const SMA_PERIOD = 20;

/**
 * Volume sub-pane: zero-based bars coloured by the bar's own direction, a short
 * moving average of volume, and the same time gridlines as the price pane.
 */
export class VolumePane {
  readonly id = 'volume';

  draw(ctx: CanvasRenderingContext2D, frame: Frame): void {
    const { width, height, bars, x } = frame;
    const plotBottom = height - (frame.axisBottom ? TIME_AXIS_HEIGHT : 0);
    const right = width - PRICE_AXIS_WIDTH;
    const top = 14;
    const timeTicks = x.timeTicks();

    drawText(ctx, 'Volume', frame.left + 6, 9, { color: THEME.muted, font: LABEL_FONT });
    drawTimeColumns(ctx, 0, plotBottom, timeTicks, x, frame.left, right);

    const { first, last } = x.visibleRange();
    const from = Math.max(0, first);
    const to = Math.min(bars.length - 1, last);
    let max = 0;
    for (let i = from; i <= to; i += 1) {
      const bar = bars[i];
      if (bar && bar.volume > max) max = bar.volume;
    }
    const scale = new VolumeScale(max * 1.08, top, plotBottom);
    const body = x.bodyWidth();
    const showSma = x.barStep >= 2;
    const sma: number[] = [];

    for (let i = from; i <= to; i += 1) {
      const bar = bars[i];
      if (!bar) continue;
      const cx = x.toX(i);
      const y = scale.toY(bar.volume);
      fillRect(ctx, cx - body / 2, y, body, Math.max(1, plotBottom - y), bar.close >= bar.open ? volUp() : volDown());
      if (showSma) {
        const average = movingAverage(bars, i, SMA_PERIOD);
        sma.push(average);
      }
    }

    if (showSma && sma.length > 1) {
      ctx.beginPath();
      for (let i = 0; i < sma.length; i += 1) {
        const value = sma[i];
        if (value === undefined) continue;
        const px = x.toX(from + i);
        const y = scale.toY(value);
        if (i === 0) ctx.moveTo(px, y);
        else ctx.lineTo(px, y);
      }
      ctx.strokeStyle = SMA_LINE;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    vLineRight(ctx, width, height);
    if (max > 0) {
      drawText(ctx, fmtCompact(max), width - PRICE_AXIS_WIDTH + 6, top + 2, { color: THEME.muted });
      drawText(ctx, fmtCompact(max / 2), width - PRICE_AXIS_WIDTH + 6, (top + plotBottom) / 2, { color: THEME.muted });
    }

    if (frame.axisBottom) drawTimeAxis(ctx, frame, timeTicks, x);

    // The price-pane legend is capped at two rows and spends them on price and overlays, so
    // the bar's traded quantity and print count are read here, beside the bars they describe.
    const hovered = frame.hover.index >= 0 ? (bars[frame.hover.index] ?? null) : (bars[bars.length - 1] ?? null);
    if (hovered) {
      const qtyPrecision = frame.instrument?.qtyPrecision ?? 2;
      const quote = frame.instrument?.quoteCurrency ?? '';
      let cursor = frame.left + 62;
      cursor += drawText(
        ctx,
        `${fmtSize(hovered.volume, qtyPrecision)}${quote ? ` ${quote}` : ''}`,
        cursor,
        9,
        { color: THEME.text },
      ) + 12;
      cursor += drawText(ctx, 'Trades', cursor, 9, { color: THEME.muted, font: LABEL_FONT }) + 4;
      drawText(ctx, fmtNumber(hovered.trades, 0), cursor, 9, { color: THEME.text });
    }
    drawCrosshair(ctx, frame, {
      hoveredHere: frame.hover.paneId === this.id,
      gutterLabel:
        frame.hover.inside && max > 0
          ? fmtNumber(max * (1 - (frame.hover.y - top) / Math.max(1, plotBottom - top)), 0)
          : undefined,
      timeLabel: hovered ? frame.local.format(hovered.start, 'dateTime') : undefined,
    });
    if (bars.length === 0) drawText(ctx, 'no volume stored', width / 2, plotBottom / 2, { align: 'center', color: THEME.muted });
  }
}

function vLineRight(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  vLine(ctx, width - PRICE_AXIS_WIDTH, 0, height, THEME.axisLine);
}

function movingAverage(bars: readonly Bar[], index: number, period: number): number {
  if (index < period - 1) return bars[index]?.volume ?? 0;
  let total = 0;
  for (let i = index - period + 1; i <= index; i += 1) total += bars[i]?.volume ?? 0;
  return total / period;
}

const LABEL_FONT = '11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
