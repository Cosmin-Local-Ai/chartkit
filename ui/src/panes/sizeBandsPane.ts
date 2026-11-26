import type { Frame } from '../layout';
import { PRICE_AXIS_WIDTH, TIME_AXIS_HEIGHT } from '../layout';
import type { SizeBandCell, SizeBandSeries } from '../types';
import { api } from '../api';
import { THEME, drawText, fillRect, measureText } from '../canvasKit';
import { fmtCompact, fmtPrice, fmtSize } from '../format';
import { PriceScale } from '../scale';
import { errorMessage } from '../series';
import { drawCrosshair, drawPriceAxis, drawTimeAxis, drawTimeColumns } from './axes';
import { shade } from './footprintPane';
import { DEFAULT_FOOTPRINT_SETTINGS, type FootprintSettings } from '../footprintSettings';
import { bandLabelFor } from '../sizeBands';

const HEADER_HEIGHT = 18;
/** Row height the pane aims for; it decides how wide a price row to ask the server for. */
const ROW_PX = 5;
/** Gap kept between two band columns so the split of one level reads as two bars. */
const COLUMN_GAP = 6;
const HEADER_FONT = '600 11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';

/** The window the last successful request was made for. */
export interface SizeBandWindow {
  instrument: string;
  timeframe: string;
  from: number;
  to: number;
  /** Venue ticks per level row, which is what the request asked the server to fold. */
  ticks: number;
}

/**
 * Volume of the visible window split by order size: one column per size band, one row per
 * price level, each cell split into aggressive buy and aggressive sell. A level that
 * absorbed a block stands out in the block column while staying quiet in the retail one.
 *
 * The bands are the server's: the response carries the edges and their labels, and the pane
 * prints them. Each column is scaled to its own busiest level, because the question a
 * trader asks of it is "did this level see size", not "how much volume is there in total".
 */
export class SizeBandsPane {
  readonly id = 'sizeBands';
  data: SizeBandSeries | null = null;
  error: string | null = null;
  loading = false;
  /** Live settings object; the buy/sell colours are shared with the other order-flow panes. */
  settings: FootprintSettings = DEFAULT_FOOTPRINT_SETTINGS;
  /** What the last drawn frame computed, for the console and automated checks. */
  debugInfo: Record<string, unknown> | null = null;
  /** Requested window of the split on screen; null until one lands. */
  window: SizeBandWindow | null = null;
  private requestKey = '';
  private generation = 0;

  /**
   * Level width in venue ticks for a visible price range: rows the pane can actually draw
   * rather than every tick the window traded. The server folds its aggregation to this
   * width, so the answer is already at row size when it arrives.
   */
  ticksFor(priceMin: number, priceMax: number, priceTick: number, rows: number): number {
    if (!(priceMax > priceMin) || !(priceTick > 0) || rows <= 0) return 1;
    const perRow = (priceMax - priceMin) / rows;
    return Math.max(1, Math.round(perRow / priceTick));
  }

  /** Rows the pane can draw at its current height. */
  rowsAvailable(height: number): number {
    return Math.max(6, Math.floor((height - HEADER_HEIGHT - 8 - TIME_AXIS_HEIGHT) / ROW_PX));
  }

  /**
   * Refetch when the symbol, the interval, the visible window or the row width moves. The
   * key is written when a request starts, so a window already in flight or already failed
   * counts as asked for instead of queueing another copy behind itself.
   */
  needsRefresh(instrument: string, timeframe: string, from: number, to: number, ticks: number): boolean {
    if (!instrument) return false;
    return keyFor(instrument, timeframe, from, to, ticks) !== this.requestKey;
  }

  async refresh(instrument: string, timeframe: string, from: number, to: number, ticks: number): Promise<boolean> {
    if (!instrument) return false;
    this.requestKey = keyFor(instrument, timeframe, from, to, ticks);
    const generation = ++this.generation;
    this.loading = true;
    try {
      const series = await api.sizeBands(instrument, timeframe, { from, to }, { view: 'levels', ticks });
      if (generation !== this.generation) return false;
      this.data = series;
      this.window = { instrument, timeframe, from, to, ticks };
      this.error = null;
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      this.error = errorMessage(error);
      this.data = null;
      this.window = null;
      return true;
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }

  reset(): void {
    this.generation += 1;
    this.data = null;
    this.window = null;
    this.error = null;
    this.requestKey = '';
    this.debugInfo = null;
  }

  draw(ctx: CanvasRenderingContext2D, frame: Frame): void {
    const { width, height } = frame;
    const plotBottom = height - (frame.axisBottom ? TIME_AXIS_HEIGHT : 0);
    const right = width - PRICE_AXIS_WIDTH;
    const top = HEADER_HEIGHT + 6;
    const timeTicks = frame.x.timeTicks();

    drawTimeColumns(ctx, 0, plotBottom, timeTicks, frame.x, frame.left, right);
    if (frame.axisBottom) drawTimeAxis(ctx, frame, timeTicks, frame.x);

    const bands = this.data;
    // The pane's own vertical mapping, but over the chart's visible prices, so a level
    // here sits beside the same level on the price pane above it.
    const price = new PriceScale({
      mode: frame.price.mode,
      min: frame.price.min,
      max: frame.price.max,
      top,
      bottom: Math.max(top + 1, plotBottom),
      precision: frame.instrument?.pricePrecision ?? 2,
    });

    this.drawHeader(ctx, frame, bands);

    const rows = bands?.levels.filter((level) => level.totalQty > 0) ?? [];
    if (!bands || bands.levels.length === 0 || plotBottom <= top) {
      // The reason the grid is blank, worst first: a failed request, then a window with
      // nothing in it, then a request still in flight.
      let message = 'waiting for a visible window';
      if (this.loading) message = 'loading size bands…';
      if (bands) message = 'no prints stored for this window';
      if (this.error) message = this.error;
      drawText(ctx, message, width / 2, (top + plotBottom) / 2, { align: 'center', color: this.error ? THEME.down : THEME.muted });
      this.debugInfo = { window: this.window, rows: 0, bands: 0, error: this.error };
      drawPriceAxis(ctx, frame, price, [], THEME.muted);
      this.drawCrosshair(ctx, frame, price, null);
      return;
    }

    const count = bands.bands.length;
    const plotWidth = Math.max(8, right - frame.left);
    const column = plotWidth / Math.max(1, count);
    // Each band is scaled against its own busiest level: the columns are not comparable
    // with each other, but a level that saw size is unmistakable inside its own column.
    const peak = bands.bands.map((_, band) => Math.max(...rows.map((row) => cellTotal(row.bands[band] ?? null)), 1e-12));
    const rowStep = bands.priceTick * Math.max(1, bands.stepTicks);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, right, plotBottom - top);
    ctx.clip();

    for (let band = 0; band < count; band += 1) {
      const scale = peak[band] ?? 1;
      const edge = frame.left + column * (band + 1);
      if (band + 1 < count) fillRect(ctx, edge - 0.5, top, 1, plotBottom - top, THEME.grid);
      const usable = Math.max(4, column - COLUMN_GAP);
      const axisEdge = edge - COLUMN_GAP / 2;
      for (const row of rows) {
        const cell = row.bands[band];
        if (!cell || cellTotal(cell) <= 0) continue;
        const yTop = price.toY(row.price + rowStep);
        const yBottom = price.toY(row.price);
        if (yBottom < top || yTop > plotBottom) continue;
        const rowHeight = Math.max(1, yBottom - yTop - 1);
        const strength = cellTotal(cell) / scale;
        const length = strength * usable;
        const total = cellTotal(cell);
        const buyLength = total > 0 ? (cell.buyQty / total) * length : 0;
        shade(ctx, axisEdge - buyLength, yTop, buyLength, rowHeight, this.settings.colors[0], strength, this.settings);
        shade(ctx, axisEdge - length, yTop, length - buyLength, rowHeight, this.settings.colors[1], strength, this.settings);
      }
    }
    ctx.restore();

    this.drawBandCaptions(ctx, frame, bands, frame.left, top, column);
    drawPriceAxis(ctx, frame, price, price.ticks(), THEME.muted);
    const hovered = this.hoveredRow(frame, rows, price, top, plotBottom);
    this.drawCrosshair(ctx, frame, price, hovered);

    this.debugInfo = {
      window: this.window,
      bands: bands.bands.map((band) => band.label),
      bandRule: bands.bandRule,
      sizeUnit: bands.sizeUnit,
      rows: rows.length,
      rowStep: +rowStep.toFixed(6),
      stepTicks: bands.stepTicks,
      peakPerBand: peak.map((value) => +value.toFixed(6)),
      bandTotals: bands.totals.map((cell) => ({ buy: +cell.buyQty.toFixed(6), sell: +cell.sellQty.toFixed(6) })),
      prints: bands.prints,
      totalQty: +bands.totalQty.toFixed(6),
      delta: +bands.delta.toFixed(6),
      viewSpan: { min: frame.price.min, max: frame.price.max },
      hovered: hovered
        ? {
            price: +hovered.price.toFixed(6),
            totalQty: +hovered.totalQty.toFixed(6),
            delta: +hovered.delta.toFixed(6),
            bands: hovered.bands.map((cell, index) => ({
              band: bands.bands[index]?.label ?? String(index),
              buyQty: cell.buyQty,
              sellQty: cell.sellQty,
              buyN: cell.buyN,
              sellN: cell.sellN,
            })),
          }
        : null,
    };
  }

  /** Band names above their columns, so the ladder in use is visible without a dialog. */
  private drawBandCaptions(
    ctx: CanvasRenderingContext2D,
    frame: Frame,
    series: SizeBandSeries,
    left: number,
    top: number,
    column: number,
  ): void {
    const precision = frame.instrument?.qtyPrecision ?? 2;
    series.bands.forEach((band, index) => {
      const centre = left + column * (index + 0.5);
      const label = drawText(ctx, band.label, centre, top - 4, { align: 'center', color: THEME.muted });
      const cell = series.totals[index];
      if (!cell || column < label + 24) return;
      drawText(ctx, `${fmtSize(cell.buyQty, precision)}/${fmtSize(cell.sellQty, precision)}`, centre, top + 6, {
        align: 'center',
        color: THEME.text,
      });
    });
  }

  private drawHeader(ctx: CanvasRenderingContext2D, frame: Frame, series: SizeBandSeries | null): void {
    let cursor = 8;
    cursor += drawText(ctx, 'Size bands', cursor, 9, { color: THEME.text, font: HEADER_FONT }) + 12;
    if (!series || !this.window) {
      drawText(ctx, this.error ?? 'volume split by order size over the visible window', cursor, 9, { color: THEME.muted });
      return;
    }
    cursor +=
      drawText(
        ctx,
        `${frame.local.format(this.window.from, 'dateTime')} → ${frame.local.format(this.window.to, 'dateTime')}`,
        cursor,
        9,
        { color: THEME.muted },
      ) + 12;
    cursor += drawText(ctx, `${fmtCompact(series.prints)} prints`, cursor, 9, { color: THEME.text }) + 12;
    if (frame.width - cursor > 260) {
      cursor += drawText(ctx, series.bandRule, cursor, 9, { color: THEME.muted }) + 12;
    }
    if (frame.width - cursor > 190) {
      drawText(ctx, 'each column on its own scale', cursor, 9, { color: THEME.muted });
    }
  }

  /** Level under the cursor, for the gutter readout; null when the cursor is elsewhere. */
  private hoveredRow(
    frame: Frame,
    rows: SizeBandSeries['levels'],
    price: PriceScale,
    top: number,
    plotBottom: number,
  ): SizeBandSeries['levels'][number] | null {
    if (frame.hover.paneId !== this.id || !frame.hover.inside) return null;
    const y = frame.hover.y;
    if (y < top || y > plotBottom) return null;
    const wanted = price.fromY(y);
    const step = (this.data?.priceTick ?? 0) * Math.max(1, this.data?.stepTicks ?? 1);
    for (const row of rows) if (wanted >= row.price && wanted < row.price + step) return row;
    return null;
  }

  private drawCrosshair(
    ctx: CanvasRenderingContext2D,
    frame: Frame,
    price: PriceScale,
    row: SizeBandSeries['levels'][number] | null,
  ): void {
    const precision = frame.instrument?.pricePrecision ?? 2;
    const qtyPrecision = frame.instrument?.qtyPrecision ?? 2;
    const inPane = frame.hover.paneId === this.id && frame.hover.inside;
    const bands = this.data;
    if (row && inPane && bands) {
      const step = bands.priceTick * Math.max(1, bands.stepTicks);
      const parts = [`${fmtPrice(row.price, precision)}–${fmtPrice(row.price + step, precision)}`];
      parts.push(`${fmtSize(row.totalQty, qtyPrecision)}`);
      // The average print at this level, named by the band it falls in: the one number
      // that says whether the volume here came in pieces or in blocks.
      if (row.trades > 0) {
        parts.push(
          `avg print ${fmtSize(row.totalQty / row.trades, qtyPrecision)} · ${bandLabelFor(bands.bands, averagePrintSize(bands, row))}`,
        );
      }
      for (const [index, cell] of row.bands.entries()) {
        if (!cell || cellTotal(cell) <= 0) continue;
        parts.push(`${bands.bands[index]?.label ?? index} ${fmtSize(cell.buyQty, qtyPrecision)}/${fmtSize(cell.sellQty, qtyPrecision)}`);
      }
      const label = parts.join(' · ');
      const right = frame.width - PRICE_AXIS_WIDTH - 8;
      if (measureText(ctx, label) < right - 8) drawText(ctx, label, right, 9, { align: 'right', color: THEME.text });
    }
    drawCrosshair(ctx, frame, {
      hoveredHere: inPane,
      gutterLabel: inPane ? fmtPrice(price.fromY(frame.hover.y), precision) : undefined,
      timeLabel: undefined,
    });
  }
}

/**
 * The average print at a level, stated in the unit the bands use. A level is one row wide,
 * so its own price plus half a row stands in for the price of the prints inside it.
 */
function averagePrintSize(series: SizeBandSeries, row: SizeBandSeries['levels'][number]): number {
  if (row.trades <= 0) return 0;
  const average = row.totalQty / row.trades;
  if (series.sizeUnit === 'quantity') return average;
  return average * (row.price + (series.priceTick * Math.max(1, series.stepTicks)) / 2);
}

function cellTotal(cell: SizeBandCell | null): number {
  return cell ? cell.buyQty + cell.sellQty : 0;
}

function keyFor(instrument: string, timeframe: string, from: number, to: number, ticks: number): string {
  return `${instrument}|${timeframe}|${Math.round(from)}|${Math.round(to)}|${ticks}`;
}

