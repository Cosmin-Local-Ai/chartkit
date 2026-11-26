import type { Frame } from '../layout';
import { PRICE_AXIS_WIDTH, TIME_AXIS_HEIGHT } from '../layout';
import type { VolumeProfile } from '../types';
import { api } from '../api';
import { THEME, drawTag, drawText, fillRect, measureText, dashedH } from '../canvasKit';
import { fmtCompact, fmtPrice, fmtSize } from '../format';
import { PriceScale } from '../scale';
import { errorMessage } from '../series';
import { drawCrosshair, drawPriceAxis, drawTimeAxis, drawTimeColumns } from './axes';
import { shade } from './footprintPane';
import { DEFAULT_FOOTPRINT_SETTINGS, type FootprintSettings } from '../footprintSettings';
import { buildLadder, rowCountFor, spanFor, tradedExtent, valueAreaBounds, type ProfileRow } from './profileModel';

const HEADER_HEIGHT = 18;
/** Row height the pane aims for; the row count is whatever fits the pane. */
const ROW_PX = 4;
/** A bar at full strength stops short of the plot's left edge by this much. */
const BAR_INSET = 8;
const HEADER_FONT = '600 11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
/** Same value-area tint the footprint ladder bands its in-value rows with. */
const VALUE_AREA_BAND = 'rgba(148,163,178,0.07)';

interface LevelMark {
  price: number;
  color: string;
  label: string;
  /** POC draws as a solid rule of `pocThickness`; VAH and VAL stay dashed. */
  solid: boolean;
}

/** The window the last successful request was made for. */
export interface ProfileWindow {
  instrument: string;
  from: number;
  to: number;
  valueArea: number;
}

/**
 * Volume-profile pane: a horizontal volume-by-price histogram of the visible window,
 * anchored to the price axis, with the point of control and the value area marked.
 * Levels, colours and the value-area fraction come from the footprint settings, so the
 * two order-flow panes read the same way.
 */
export class ProfilePane {
  readonly id = 'profile';
  data: VolumeProfile | null = null;
  error: string | null = null;
  loading = false;
  /** Live settings object; the app swaps it whenever the footprint dialog patches a field. */
  settings: FootprintSettings = DEFAULT_FOOTPRINT_SETTINGS;
  /** What the last drawn frame computed, for the console and automated checks. */
  debugInfo: Record<string, unknown> | null = null;
  /** Requested window of the profile on screen; null until one lands. */
  window: ProfileWindow | null = null;
  private requestKey = '';
  private generation = 0;

  /**
   * Refetch when the symbol, the visible window or the value-area fraction moves. The
   * window is bar-aligned already, so a pan that does not change a bar edge is free.
   * The key is written when a request starts, so a window that is already in flight or
   * already failed counts as asked for: a profile this wide takes seconds to arrive, and
   * re-asking per frame would queue a copy of it behind itself.
   */
  needsRefresh(instrument: string, from: number, to: number, valueArea: number): boolean {
    if (!instrument) return false;
    return keyFor(instrument, from, to, valueArea) !== this.requestKey;
  }

  async refresh(instrument: string, from: number, to: number, valueArea: number): Promise<boolean> {
    if (!instrument) return false;
    this.requestKey = keyFor(instrument, from, to, valueArea);
    const generation = ++this.generation;
    this.loading = true;
    try {
      const profile = await api.profile(instrument, { from, to }, valueArea);
      if (generation !== this.generation) return false;
      this.data = profile;
      this.window = { instrument, from, to, valueArea };
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

    const profile = this.data;
    const settings = this.settings;
    this.drawHeader(ctx, frame, profile);

    if (!profile || profile.buckets.length === 0 || plotBottom <= top) {
      const message = this.error ?? (profile ? 'no prints stored for this window' : this.loading ? 'loading profile…' : 'waiting for a visible window');
      drawText(ctx, message, width / 2, (top + plotBottom) / 2, {
        align: 'center',
        color: this.error ? THEME.down : THEME.muted,
      });
      const emptyAxis = this.axisFor(frame, frame.price.min, frame.price.max, top, plotBottom);
      this.debugInfo = { window: this.window, rows: 0, buckets: 0, error: this.error };
      drawPriceAxis(ctx, frame, emptyAxis, [], THEME.muted);
      this.drawCrosshair(ctx, frame, emptyAxis, null);
      return;
    }

    const rowCount = rowCountFor(plotBottom - top, ROW_PX);
    const span = spanFor(profile, rowCount);
    const price = this.axisFor(frame, span.lo, span.hi, top, plotBottom);
    const ladder = buildLadder(profile.buckets, span.lo, span.hi, rowCount);
    const valueArea = valueAreaBounds(profile);
    const plotWidth = Math.max(8, right - frame.left - BAR_INSET);
    const max = ladder.maxRowQty * 1.06;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, right, plotBottom - top);
    ctx.clip();

    if (valueArea && settings.showValueAreaBand) {
      const yHigh = price.toY(valueArea.high);
      const yLow = price.toY(valueArea.low);
      fillRect(ctx, frame.left, Math.min(yHigh, yLow), right - frame.left, Math.abs(yLow - yHigh), VALUE_AREA_BAND);
    }

    // Bars are anchored to the price axis and grow left, so every bar ends beside the
    // price label it belongs to and the tape's own direction is not mirrored.
    const axisEdge = right - 1;
    let drawn = 0;
    for (const row of ladder.rows) {
      if (row.totalQty <= 0 || row.totalQty < settings.threshold) continue;
      const yTop = price.toY(row.high);
      const yBottom = price.toY(row.low);
      const rowHeight = Math.max(1, yBottom - yTop - 1);
      const strength = max > 0 ? row.totalQty / max : 0;
      const length = strength * plotWidth;
      const buyLength = row.totalQty > 0 ? (row.buyQty / row.totalQty) * length : 0;
      shade(ctx, axisEdge - buyLength, yTop, buyLength, rowHeight, settings.colors[0], strength, settings);
      shade(ctx, axisEdge - length, yTop, length - buyLength, rowHeight, settings.colors[1], strength, settings);
      drawn += 1;
    }

    const levels = this.levels(profile, valueArea, settings);
    for (const level of levels) {
      const y = price.toY(level.price);
      if (y < top || y > plotBottom) continue;
      if (level.solid) {
        const thickness = Math.max(1, Math.min(6, settings.pocThickness));
        fillRect(ctx, frame.left, y - thickness / 2, right - frame.left, thickness, level.color);
      } else {
        dashedH(ctx, frame.left, right, y, level.color);
      }
    }
    ctx.restore();

    this.drawLevelTags(ctx, levels, price, top, plotBottom, frame.left + 4);
    drawPriceAxis(ctx, frame, price, price.ticks(), THEME.muted);
    this.drawCrosshair(ctx, frame, price, ladder.rows.length ? ladder.rows : null);

    this.debugInfo = {
      window: this.window,
      buckets: profile.buckets.length,
      rows: ladder.rows.length,
      rowsDrawn: drawn,
      rowStep: +ladder.step.toFixed(6),
      maxRowQty: +ladder.maxRowQty.toFixed(6),
      rowTotal: +ladder.totalQty.toFixed(6),
      serverTotalQty: +profile.totalQty.toFixed(6),
      span: { lo: +span.lo.toFixed(6), hi: +span.hi.toFixed(6) },
      viewSpan: { min: frame.price.min, max: frame.price.max },
      poc: profile.poc,
      vah: profile.vah,
      val: profile.val,
      valueAreaOrdered: valueArea,
      valueAreaFraction: profile.valueArea,
      bandDrawn: settings.showValueAreaBand && valueArea !== null,
      show: {
        poc: settings.showPOC,
        vah: settings.showVAH,
        val: settings.showVAL,
        valueArea: settings.showValueArea,
        band: settings.showValueAreaBand,
      },
      hoveredRow: this.hoveredRow(frame, ladder.rows, price, top, plotBottom),
    };
  }

  /** The pane's own vertical price mapping: same prices as the chart, this pane's height. */
  private axisFor(
    frame: Frame,
    lo: number,
    hi: number,
    top: number,
    plotBottom: number,
  ): PriceScale {
    return new PriceScale({
      mode: frame.price.mode,
      min: lo,
      max: hi,
      top,
      bottom: Math.max(top + 1, plotBottom),
      precision: frame.instrument?.pricePrecision ?? 2,
    });
  }

  /** POC, VAH and VAL as the settings want them drawn, in top-to-bottom draw order. */
  private levels(
    profile: VolumeProfile,
    valueArea: { high: number; low: number } | null,
    settings: FootprintSettings,
  ): LevelMark[] {
    const marks: LevelMark[] = [];
    const poc = profile.poc;
    if (settings.showPOC && poc !== null && Number.isFinite(poc)) {
      marks.push({ price: poc, color: settings.pocColor, label: 'POC', solid: true });
    }
    if (settings.showValueArea && valueArea) {
      if (settings.showVAH) marks.push({ price: valueArea.high, color: settings.vahColor, label: 'VAH', solid: false });
      if (settings.showVAL) marks.push({ price: valueArea.low, color: settings.valColor, label: 'VAL', solid: false });
    }
    return marks;
  }

  /** Level names beside their rules; a tag that would collide with one already drawn is dropped. */
  private drawLevelTags(
    ctx: CanvasRenderingContext2D,
    marks: LevelMark[],
    price: PriceScale,
    top: number,
    plotBottom: number,
    x: number,
  ): void {
    let lastBottom = Number.NEGATIVE_INFINITY;
    for (const mark of marks) {
      const y = Math.round(price.toY(mark.price));
      if (y < top + 6 || y > plotBottom - 6) continue;
      if (y - 8 < lastBottom + 2) continue;
      drawTag(ctx, mark.label, x, y, { color: mark.color });
      lastBottom = y + 8;
    }
  }

  private drawHeader(ctx: CanvasRenderingContext2D, frame: Frame, profile: VolumeProfile | null): void {
    const precision = frame.instrument?.pricePrecision ?? 2;
    const qtyPrecision = frame.instrument?.qtyPrecision ?? 2;
    let cursor = 8;
    cursor += drawText(ctx, 'Profile', cursor, 9, { color: THEME.text, font: HEADER_FONT }) + 12;
    if (!profile || !this.window) {
      drawText(ctx, this.error ?? 'volume by price over the visible window', cursor, 9, { color: THEME.muted });
      return;
    }
    const extent = tradedExtent(profile.buckets);
    cursor +=
      drawText(
        ctx,
        `${frame.local.format(this.window.from, 'dateTime')} → ${frame.local.format(this.window.to, 'dateTime')}`,
        cursor,
        9,
        { color: THEME.muted },
      ) + 12;
    cursor += drawText(ctx, `qty ${fmtSize(profile.totalQty, qtyPrecision)}`, cursor, 9, { color: THEME.text }) + 12;
    if (profile.poc !== null && frame.width - cursor > 120) {
      cursor += drawText(ctx, `POC ${fmtPrice(profile.poc, precision)}`, cursor, 9, { color: this.settings.pocColor }) + 12;
    }
    // The labels follow the ordered bounds, not the response fields, so a venue that ever
    // answered the pair the other way round could not put a price on the wrong name.
    const area = valueAreaBounds(profile);
    if (area && frame.width - cursor > 220) {
      cursor += drawText(ctx, `VAH ${fmtPrice(area.high, precision)}`, cursor, 9, { color: this.settings.vahColor }) + 12;
      cursor += drawText(ctx, `VAL ${fmtPrice(area.low, precision)}`, cursor, 9, { color: this.settings.valColor }) + 12;
    }
    if (frame.width - cursor > 120 && extent) {
      drawText(
        ctx,
        `${fmtCompact(profile.buckets.length)} ticks · ${fmtPrice(extent.low, precision)}–${fmtPrice(extent.high, precision)}`,
        cursor,
        9,
        { color: THEME.muted },
      );
    }
  }

  /** Row under the cursor, for the gutter readout; null when the cursor is elsewhere. */
  private hoveredRow(
    frame: Frame,
    rows: ProfileRow[],
    price: PriceScale,
    top: number,
    plotBottom: number,
  ): ProfileRow | null {
    if (frame.hover.paneId !== this.id || !frame.hover.inside) return null;
    const y = frame.hover.y;
    if (y < top || y > plotBottom) return null;
    const wanted = price.fromY(y);
    for (const row of rows) if (wanted >= row.low && wanted <= row.high) return row;
    return rows[rows.length - 1] ?? null;
  }

  private drawCrosshair(
    ctx: CanvasRenderingContext2D,
    frame: Frame,
    price: PriceScale,
    rows: ProfileRow[] | null,
  ): void {
    const precision = frame.instrument?.pricePrecision ?? 2;
    const inPane = frame.hover.paneId === this.id && frame.hover.inside;
    const row = rows ? this.hoveredRow(frame, rows, price, 0, frame.height) : null;
    if (row && inPane) {
      const label = `${fmtPrice(row.low, precision)}–${fmtPrice(row.high, precision)} · ${fmtSize(
        row.totalQty,
        frame.instrument?.qtyPrecision ?? 2,
      )} · ${fmtSize(row.buyQty, frame.instrument?.qtyPrecision ?? 2)}/${fmtSize(
        row.sellQty,
        frame.instrument?.qtyPrecision ?? 2,
      )}`;
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

function keyFor(instrument: string, from: number, to: number, valueArea: number): string {
  return `${instrument}|${Math.round(from)}|${Math.round(to)}|${valueArea}`;
}
