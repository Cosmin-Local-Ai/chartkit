import type { Frame } from '../layout';
import { PRICE_AXIS_WIDTH, TIME_AXIS_HEIGHT } from '../layout';
import type { TpoSeries } from '../types';
import { api } from '../api';
import { THEME, drawTag, drawText, fillRect, measureText, dashedH, withAlpha } from '../canvasKit';
import { fmtCompact, fmtPrice, fmtSize } from '../format';
import { PriceScale } from '../scale';
import { errorMessage } from '../series';
import { drawCrosshair, drawPriceAxis, drawTimeAxis, drawTimeColumns } from './axes';
import { DEFAULT_TPO_SETTINGS, bucketMinutes, gridProblem, type TpoSettings } from '../tpoSettings';
import {
  cellGrade,
  columnsFor,
  coverageNote,
  featuredSession,
  rowCountFor,
  stepTicksFor,
  tradedExtent,
  valueAreaBounds,
  type TpoColumn,
  type TpoGridCell,
} from './tpoModel';

/** Band above the plot carrying one letter per bucket, which is how a market profile is read. */
const LETTER_BAND = 16;
const HEADER_HEIGHT = 18;
const HEADER_FONT = '600 11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
const LETTER_FONT = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
/** A bucket narrower than this cannot show a letter without overwriting its neighbour's. */
const MIN_PIXELS_FOR_LETTER = 9;
/** Room kept at the right edge for the letter count beside each price row. */
const COUNT_GUTTER = 30;

/** The window and the grid the last successful request was made for. */
/** One cell of the grid, with the bucket it belongs to. */
export interface TpoCellHit {
  column: TpoColumn;
  cell: TpoGridCell;
}

export interface TpoWindow {
  instrument: string;
  from: number;
  to: number;
  bucketMinutes: number;
  sessionStartMinute: number;
  sessionLengthMinutes: number;
  /** Venue ticks per price row, as the answer reports it. */
  stepTicks: number;
  valueArea: number;
  valueAreaMethod: string;
}

/**
 * TPO / market-profile pane: the visible window cut into time buckets and price rows, with one
 * letter per bucket in every cell that traded, the letter count beside each row, and the point
 * of control and value area of each session the window covers.
 *
 * The grid is the settings', not the chart interval's, so the same session reads the same way
 * on a 1m chart and a 1h one. The server assigns the letters; this pane only places them.
 */
export class TpoPane {
  readonly id = 'tpo';
  data: TpoSeries | null = null;
  error: string | null = null;
  loading = false;
  settings: TpoSettings = DEFAULT_TPO_SETTINGS;
  /** What the last drawn frame computed, for the console and automated checks. */
  debugInfo: Record<string, unknown> | null = null;
  /** Window and grid of the profile on screen; null until one lands. */
  window: TpoWindow | null = null;
  private requestKey = '';
  private generation = 0;
  /** Plot height of the last frame, so the price row width asked for matches the rows drawn. */
  private paneHeight = 240;

  /**
   * Refetch when the symbol, the visible window, or anything that changes the answer moves:
   * the bucket, the session, the value-area fraction or its method. The price row width is
   * derived from the visible price span, so it is part of the key too.
   */
  needsRefresh(instrument: string, from: number, to: number, priceSpan: number, priceTick: number): boolean {
    if (!instrument) return false;
    return this.keyFor(instrument, from, to, priceSpan, priceTick) !== this.requestKey;
  }

  async refresh(
    instrument: string,
    from: number,
    to: number,
    priceSpan: number,
    priceTick: number,
    rowCount: number,
  ): Promise<boolean> {
    if (!instrument) return false;
    const problem = gridProblem(this.settings);
    if (problem) {
      this.error = problem;
      this.data = null;
      this.window = null;
      this.requestKey = this.keyFor(instrument, from, to, priceSpan, priceTick);
      return true;
    }
    const grid = {
      bucket: bucketMinutes(this.settings),
      sessionStart: this.settings.sessionStartMinute,
      sessionLength: this.settings.sessionLengthMinutes,
      valueArea: this.settings.valueAreaPercentage,
      valueAreaFrom: this.settings.valueAreaMethod,
      ticks: stepTicksFor(priceSpan, priceTick, rowCount),
    };
    this.requestKey = this.keyFor(instrument, from, to, priceSpan, priceTick);
    const generation = ++this.generation;
    this.loading = true;
    try {
      const series = await api.tpo(instrument, { from, to }, grid);
      if (generation !== this.generation) return false;
      this.data = series;
      this.window = {
        instrument,
        from,
        to,
        bucketMinutes: series.bucketMinutes,
        sessionStartMinute: series.sessionStartMinute,
        sessionLengthMinutes: series.sessionMinutes,
        stepTicks: series.stepTicks,
        valueArea: this.settings.valueAreaPercentage,
        valueAreaMethod: this.settings.valueAreaMethod,
      };
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

  /** Height of the last frame this pane drew: the row count its next request should fit. */
  get lastFrameHeight(): number {
    return this.paneHeight;
  }

  /**
   * What a request is keyed on. The grid belongs in it: the same window cut into 30 minute
   * buckets is a different answer from the same window cut into hourly ones, and a pane that
   * refetched only on the window would keep showing letters of a grid it no longer asks for.
   */
  private keyFor(instrument: string, from: number, to: number, priceSpan: number, priceTick: number): string {
    const rows = rowsForPane(this.paneHeight, this.settings);
    return [
      instrument,
      Math.round(from),
      Math.round(to),
      bucketMinutes(this.settings),
      this.settings.sessionStartMinute,
      this.settings.sessionLengthMinutes,
      this.settings.valueAreaPercentage,
      this.settings.valueAreaMethod,
      this.settings.profileSpacing,
      stepTicksFor(priceSpan, priceTick, rows),
    ].join('|');
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
    this.paneHeight = height;
    const plotBottom = height - (frame.axisBottom ? TIME_AXIS_HEIGHT : 0);
    const right = width - PRICE_AXIS_WIDTH;
    const top = HEADER_HEIGHT + LETTER_BAND + 4;
    const timeTicks = frame.x.timeTicks();

    drawTimeColumns(ctx, 0, plotBottom, timeTicks, frame.x, frame.left, right);
    if (frame.axisBottom) drawTimeAxis(ctx, frame, timeTicks, frame.x);

    const series = this.data;
    this.drawHeader(ctx, frame, series);

    // A pane this short has no plot left once the header and the letter band are drawn. That is
    // a different problem from a window with no prints, and it needs a different message: the
    // answer may be sitting right there with nowhere to put it.
    if (!series || series.sessions.length === 0 || plotBottom <= top) {
      const message =
        this.error ??
        (plotBottom <= top
          ? 'the pane is too short for a profile'
          : series
            ? 'no prints stored for this window'
            : this.loading
              ? 'loading the profile…'
              : 'waiting for a visible window');
      drawText(ctx, message, width / 2, (top + plotBottom) / 2, { align: 'center', color: this.error ? THEME.down : THEME.muted });
      const emptyAxis = this.axisFor(frame, frame.price.min, frame.price.max, top, plotBottom);
      this.debugInfo = { window: this.window, sessions: series?.sessions.length ?? 0, buckets: 0, error: this.error };
      drawPriceAxis(ctx, frame, emptyAxis, [], THEME.muted);
      this.drawCrosshair(ctx, frame, emptyAxis, [], top, plotBottom);
      return;
    }

    const extent = tradedExtent(series);
    if (!extent) {
      this.debugInfo = { window: this.window, sessions: series.sessions.length, buckets: 0, error: this.error };
      return;
    }
    const bucketMs = Math.max(1, series.bucketMinutes) * 60_000;
    const pad = Math.max(series.stepTicks * series.priceTick, (extent.high - extent.low) / 40);
    const price = this.axisFor(frame, extent.low - pad, extent.high + pad, top, plotBottom);
    const columns = columnsFor(series, this.settings, bucketMs);
    const plot = Math.max(COUNT_GUTTER + 8, right - frame.left - COUNT_GUTTER);
    const maxGrade = Math.max(1e-12, maxColumnGrade(columns, this.settings));

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, right, plotBottom - top);
    ctx.clip();
    for (const column of columns) {
      this.drawSessionBand(ctx, frame, series, column, price, top, plotBottom, frame.left, plot + frame.left);
    }
    for (const column of columns) {
      this.drawColumn(ctx, frame, series, column, price, top, plotBottom, maxGrade);
    }
    for (const column of columns) {
      this.drawLevels(ctx, frame, series, column, price, top, plotBottom, frame.left, plot + frame.left);
    }
    ctx.restore();

    this.drawLetterBand(ctx, frame, columns, top - LETTER_BAND);
    this.drawRowCounts(ctx, series, price, top, plotBottom, right);
    drawPriceAxis(ctx, frame, price, price.ticks(), THEME.muted);
    this.drawCrosshair(ctx, frame, price, columns, top, plotBottom);

    const featured = featuredSession(series);
    this.debugInfo = {
      window: this.window,
      instrument: series.instrument,
      sessions: series.sessions.length,
      buckets: series.sessions.reduce((sum, session) => sum + session.buckets.length, 0),
      letters: featured?.letters ?? '',
      rows: featured?.rows.length ?? 0,
      prints: series.prints,
      totalQty: +series.totalQty.toFixed(6),
      stepTicks: series.stepTicks,
      priceTick: series.priceTick,
      bucketRule: series.bucketRule,
      sessionRule: series.sessionRule,
      valueAreaRule: series.valueAreaRule,
      coveredFrom: series.coveredFrom,
      coveredTo: series.coveredTo,
      note: coverageNote(series, this.window?.from ?? 0, this.window?.to ?? 0),
      cellsDrawn: columns.reduce((sum, column) => sum + column.cells.length, 0),
      lettersDrawn: this.lettersFit(columns, frame) ? columns.length : 0,
      bucketPx: this.bucketWidthPx(frame, columns[0]),
      featured: featured
        ? {
            start: featured.start,
            end: featured.end,
            developing: featured.developing,
            poc: featured.poc,
            vah: featured.vah,
            val: featured.val,
            buckets: featured.buckets.length,
            letters: featured.letters,
            // The rows with the letter count beside each, so an automated check can compare
            // a named price against the same answer read straight from the API.
            rows: featured.rows.map((row) => ({
              price: row.price,
              tpoCount: row.tpoCount,
              prints: row.prints,
              totalQty: +row.totalQty.toFixed(6),
            })),
            bucketLetters: featured.buckets.map((bucket) => ({
              start: bucket.start,
              letter: bucket.letter,
              prints: bucket.prints,
              poc: bucket.poc,
            })),
            // The grid as the pane holds it: every bucket's letters against the prints of each
            // price row, so a named level can be compared cell by cell with the API answer.
            grid: featured.buckets.map((bucket) => ({
              start: bucket.start,
              letter: bucket.letter,
              cells: bucket.rows.map(([price, cell]) => [price, cell.buyN + cell.sellN]),
            })),
          }
        : null,
      settings: {
        letterMode: this.settings.letterMode,
        blockShape: this.settings.blockShape,
        grading: this.settings.cellGrading,
        eachSession: this.settings.tpoColorEachSession,
        outsideVA: this.settings.showOutsideVAColors,
        labels: this.settings.showLevelLabels,
      },
      error: this.error,
    };
  }

  /** Pixel width one bucket occupies, or 0 when its time is off the loaded bars. */
  private bucketWidthPx(frame: Frame, column: TpoColumn | undefined): number {
    if (!column) return 0;
    const a = this.xForTime(frame, column.start);
    const b = this.xForTime(frame, column.end);
    return a === null || b === null ? 0 : Math.abs(b - a);
  }

  /** Whether buckets are wide enough that a letter in one cannot collide with the next. */
  private lettersFit(columns: readonly TpoColumn[], frame: Frame): boolean {
    return this.bucketWidthPx(frame, columns[0]) >= MIN_PIXELS_FOR_LETTER;
  }

  /**
   * Pixel of a timestamp: the bar it falls in plus the fraction of that bar its time sits at,
   * so a 30 minute bucket still lands between two hourly bars instead of vanishing with the
   * bar it does not match.
   */
  private xForTime(frame: Frame, ts: number): number | null {
    const bars = frame.bars;
    if (bars.length === 0) return null;
    const barMs = Math.max(1, frame.x.barMs);
    let low = 0;
    let high = bars.length - 1;
    let index = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const bar = bars[mid];
      if (!bar) break;
      if (bar.start <= ts) {
        index = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const bar = bars[index];
    if (index < 0 || !bar) return null;
    return frame.x.toX(index + (ts - bar.start) / barMs);
  }

  /** The pane's own vertical price mapping: same prices as the chart, this pane's height. */
  private axisFor(frame: Frame, lo: number, hi: number, top: number, plotBottom: number): PriceScale {
    return new PriceScale({
      mode: frame.price.mode,
      min: lo,
      max: hi,
      top,
      bottom: Math.max(top + 1, plotBottom),
      precision: frame.instrument?.pricePrecision ?? 2,
    });
  }

  /** Value-area band and session boundary of the column's own session. */
  private drawSessionBand(
    ctx: CanvasRenderingContext2D,
    frame: Frame,
    series: TpoSeries,
    column: TpoColumn,
    price: PriceScale,
    top: number,
    plotBottom: number,
    left: number,
    right: number,
  ): void {
    const session = series.sessions[column.sessionIndex];
    if (!session) return;
    const area = valueAreaBounds(session);
    if (area && this.settings.showValueArea) {
      const yHigh = price.toY(area.high);
      const yLow = price.toY(area.low);
      fillRect(
        ctx,
        left,
        Math.min(yHigh, yLow),
        right - left,
        Math.abs(yLow - yHigh),
        withAlpha(this.settings.valueAreaFillColor, this.settings.valueAreaFillOpacity),
      );
    }
    const x = this.xForTime(frame, session.start);
    if (x === null || x <= frame.left + 1) return;
    fillRect(ctx, x - 0.5, top, 1, plotBottom - top, THEME.gridMajor);
  }

  /** One bucket: its cells, as blocks, letters, or both. */
  private drawColumn(
    ctx: CanvasRenderingContext2D,
    frame: Frame,
    series: TpoSeries,
    column: TpoColumn,
    price: PriceScale,
    top: number,
    plotBottom: number,
    maxGrade: number,
  ): void {
    const x0 = this.xForTime(frame, column.start);
    const x1 = this.xForTime(frame, column.end);
    if (x0 === null || x1 === null) return;
    const left = Math.min(x0, x1);
    const width = Math.abs(x1 - x0);
    if (left > frame.right || left + width < frame.left) return;
    const showLetters = this.settings.letterMode !== 'blocks-only' && width >= MIN_PIXELS_FOR_LETTER;
    const showBlocks = this.settings.letterMode !== 'letters-only';
    const sessionColour = this.settings.tpoSessionColors[column.sessionIndex % this.settings.tpoSessionColors.length] ?? THEME.accent;
    for (const cell of column.cells) {
      const yTop = price.toY(cell.bottom);
      const yBottom = price.toY(cell.top);
      const height = Math.max(1, yBottom - yTop - 1);
      if (yBottom < top || yTop > plotBottom) continue;
      const strength = Math.min(1, cell.grade / maxGrade);
      const colour = this.cellColour(cell.inValueArea, strength, sessionColour);
      if (showBlocks) {
        if (this.settings.blockShape === 'outline') {
          ctx.strokeStyle = colour;
          ctx.lineWidth = 1;
          ctx.strokeRect(left + 0.5, yTop + 0.5, Math.max(1, width - 1), height);
        } else {
          const inset = this.settings.blockShape === 'wide' ? 0 : Math.max(0, (width - Math.min(width, height)) / 2);
          fillRect(ctx, left + inset, yTop, Math.max(1, width - inset * 2), height, colour);
        }
      }
      if (showLetters) {
        drawText(ctx, column.letter, left + width / 2, (yTop + yBottom) / 2, {
          align: 'center',
          color: this.settings.tpoColorEachSession ? sessionColour : THEME.text,
          font: LETTER_FONT,
        });
      }
    }
  }

  /** Shade a cell: the ramp by strength, or the outside-value-area colour when asked. */
  private cellColour(inValueArea: boolean, strength: number, sessionColour: string): string {
    if (!inValueArea && this.settings.showOutsideVAColors) {
      return withAlpha(this.settings.outsideVAColor, this.settings.outsideVAOpacity);
    }
    if (this.settings.tpoColorEachSession) return withAlpha(sessionColour, 0.25 + 0.75 * strength);
    const ramp = this.settings.customTPOColors;
    const slot = Math.min(ramp.length - 1, Math.floor(strength * ramp.length));
    const colour = ramp[slot] ?? ramp[ramp.length - 1] ?? THEME.accent;
    return withAlpha(colour, 0.35 + 0.65 * strength);
  }

  /** POC, VAH and VAL of the column's session, once per session. */
  private drawLevels(
    ctx: CanvasRenderingContext2D,
    frame: Frame,
    series: TpoSeries,
    column: TpoColumn,
    price: PriceScale,
    top: number,
    plotBottom: number,
    left: number,
    right: number,
  ): void {
    const session = series.sessions[column.sessionIndex];
    if (!session) return;
    // One pass per session: a closed session's levels are drawn once, from its first column,
    // and the developing session's are redrawn every frame so they follow the live bar.
    if (!session.developing && column.start !== session.buckets[0]?.start) return;
    const settings = this.settings;
    const area = valueAreaBounds(session);
    const marks: { price: number; color: string; label: string; solid: boolean }[] = [];
    const developing = session.developing;
    if (settings.showPOC && session.poc !== null) {
      marks.push({
        price: session.poc,
        color: developing ? settings.developingPOCColor : settings.pocColor,
        label: 'POC',
        solid: true,
      });
    }
    if (settings.showValueArea && area) {
      if (settings.showVAH) marks.push({ price: area.high, color: developing ? settings.developingVAColor : settings.vahColor, label: 'VAH', solid: false });
      if (settings.showVAL) marks.push({ price: area.low, color: developing ? settings.developingVAColor : settings.valColor, label: 'VAL', solid: false });
      if (settings.showMidpoint) {
        marks.push({ price: (area.high + area.low) / 2, color: settings.midpointColor, label: 'MID', solid: false });
      }
    }
    // The rules stop at the last bucket that traded unless the setting asks them to run the
    // whole width of the pane, which is how a level is read off the price axis.
    const edge = settings.levelLineExtend ? frame.width - 2 : right;
    for (const mark of marks) {
      const y = price.toY(mark.price);
      if (y < top || y > plotBottom) continue;
      if (mark.solid) {
        const thickness = Math.max(1, Math.min(6, settings.pocThickness));
        fillRect(ctx, left, y - thickness / 2, edge - left, thickness, mark.color);
      } else {
        dashedH(ctx, left, edge, y, mark.color);
      }
      if (settings.showLevelLabels && column.start === session.buckets[0]?.start) {
        this.drawLevelTag(ctx, mark.label, left + 4, y, mark.color, top, plotBottom);
      }
    }
  }

  /** Level name beside its rule, dropped when it would land on one already drawn. */
  private drawLevelTag(
    ctx: CanvasRenderingContext2D,
    label: string,
    x: number,
    y: number,
    color: string,
    top: number,
    plotBottom: number,
  ): void {
    if (y < top + 6 || y > plotBottom - 6) return;
    drawTag(ctx, label, x, y, { color });
  }

  /** The band above the plot: one letter per bucket, and the clock under it when asked. */
  private drawLetterBand(
    ctx: CanvasRenderingContext2D,
    frame: Frame,
    columns: readonly TpoColumn[],
    y: number,
  ): void {
    if (this.settings.letterMode === 'blocks-only') return;
    for (const column of columns) {
      if (this.bucketWidthPx(frame, column) >= MIN_PIXELS_FOR_LETTER) {
        this.drawBucketMarks(ctx, frame, columns, y, this.settings);
        return;
      }
    }
  }

  /** The letters and clock labels of every bucket, drawn only when they fit. */
  private drawBucketMarks(
    ctx: CanvasRenderingContext2D,
    frame: Frame,
    columns: readonly TpoColumn[],
    y: number,
    settings: TpoSettings,
  ): void {
    for (const column of columns) {
      const x0 = this.xForTime(frame, column.start);
      const x1 = this.xForTime(frame, column.end);
      if (x0 === null || x1 === null) continue;
      const left = Math.min(x0, x1);
      const width = Math.abs(x1 - x0);
      if (left > frame.right || left + width < frame.left) continue;
      if (width >= MIN_PIXELS_FOR_LETTER) {
        drawText(ctx, column.letter, left + width / 2, y + 6, {
          align: 'center',
          color: column.developing ? THEME.accent : THEME.text,
          font: LETTER_FONT,
        });
      }
      if (settings.showTradingHourLabel && width >= 34) {
        drawText(ctx, frame.local.format(column.start, 'clock'), left + width / 2, y + 13, {
          align: 'center',
          color: THEME.muted,
          font: '500 9px ui-monospace, SFMono-Regular, Menlo, monospace',
        });
      }
    }
  }

  /** Letter count beside each price row of the newest session, in the gutter by the axis. */
  private drawRowCounts(
    ctx: CanvasRenderingContext2D,
    series: TpoSeries,
    price: PriceScale,
    top: number,
    plotBottom: number,
    right: number,
  ): void {
    const session = featuredSession(series);
    if (!session) return;
    for (const row of session.rows) {
      if (row.tpoCount <= 0) continue;
      const y = (price.toY(row.price) + price.toY(row.price + series.stepTicks * series.priceTick)) / 2;
      if (y < top || y > plotBottom) continue;
      drawText(ctx, String(row.tpoCount), right - 4, y, { align: 'right', color: THEME.muted, font: LETTER_FONT });
    }
  }

  private drawHeader(ctx: CanvasRenderingContext2D, frame: Frame, series: TpoSeries | null): void {
    const precision = frame.instrument?.pricePrecision ?? 2;
    const qtyPrecision = frame.instrument?.qtyPrecision ?? 2;
    let cursor = 8;
    cursor += drawText(ctx, 'TPO', cursor, 9, { color: THEME.text, font: HEADER_FONT }) + 12;
    if (!series || !this.window) {
      drawText(ctx, this.error ?? 'time price opportunity over the visible window', cursor, 9, { color: THEME.muted });
      return;
    }
    const session = featuredSession(series);
    if (!session) {
      drawText(ctx, 'no prints stored for this window', cursor, 9, { color: THEME.muted });
      return;
    }
    cursor +=
      drawText(
        ctx,
        `${frame.local.format(session.start, 'dateTime')}${session.developing ? ' (developing)' : ''}`,
        cursor,
        9,
        { color: THEME.muted },
      ) + 12;
    cursor += drawText(ctx, `letters ${session.letters}`, cursor, 9, { color: THEME.text }) + 12;
    cursor += drawText(ctx, `qty ${fmtSize(session.totalQty, qtyPrecision)}`, cursor, 9, { color: THEME.text }) + 12;
    if (session.poc !== null && frame.width - cursor > 120) {
      cursor += drawText(ctx, `POC ${fmtPrice(session.poc, precision)}`, cursor, 9, { color: this.settings.pocColor }) + 12;
    }
    const area = valueAreaBounds(session);
    if (area && frame.width - cursor > 220) {
      cursor += drawText(ctx, `VAH ${fmtPrice(area.high, precision)}`, cursor, 9, { color: this.settings.vahColor }) + 12;
      cursor += drawText(ctx, `VAL ${fmtPrice(area.low, precision)}`, cursor, 9, { color: this.settings.valColor }) + 12;
    }
    if (frame.width - cursor > 200) {
      cursor +=
        drawText(ctx, `${series.bucketMinutes}m · ${fmtCompact(series.prints)} prints`, cursor, 9, { color: THEME.muted }) + 12;
    }
    const note = coverageNote(series, this.window.from, this.window.to);
    if (note && frame.width - cursor > 200) drawText(ctx, note, cursor, 9, { color: THEME.accent });
  }

  /** Cell under the cursor, for the gutter readout. */
  private hoveredCell(
    frame: Frame,
    columns: readonly TpoColumn[],
    price: PriceScale,
    top: number,
    plotBottom: number,
  ): TpoCellHit | null {
    if (frame.hover.paneId !== this.id || !frame.hover.inside) return null;
    const x = frame.hover.x;
    const y = frame.hover.y;
    if (y < top || y > plotBottom) return null;
    const wanted = price.fromY(y);
    for (const column of columns) {
      const x0 = this.xForTime(frame, column.start);
      const x1 = this.xForTime(frame, column.end);
      if (x0 === null || x1 === null) continue;
      const left = Math.min(x0, x1);
      if (x < left || x > left + Math.abs(x1 - x0)) continue;
      for (const cell of column.cells) {
        if (wanted >= cell.top && wanted <= cell.bottom) return { column, cell } satisfies TpoCellHit;
      }
    }
    return null;
  }

  private drawCrosshair(
    ctx: CanvasRenderingContext2D,
    frame: Frame,
    price: PriceScale,
    columns: readonly TpoColumn[],
    top: number,
    plotBottom: number,
  ): void {
    const precision = frame.instrument?.pricePrecision ?? 2;
    const qtyPrecision = frame.instrument?.qtyPrecision ?? 2;
    const inPane = frame.hover.paneId === this.id && frame.hover.inside;
    const hit = this.settings.showHoverInspector ? this.hoveredCell(frame, columns, price, top, plotBottom) : null;
    if (hit && inPane) {
      const label = `${hit.column.letter} · ${fmtPrice(hit.cell.top, precision)}–${fmtPrice(hit.cell.bottom, precision)} · ${fmtSize(
        hit.cell.cell.buyQty + hit.cell.cell.sellQty,
        qtyPrecision,
      )} · ${fmtSize(hit.cell.cell.buyQty, qtyPrecision)}/${fmtSize(hit.cell.cell.sellQty, qtyPrecision)}`;
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

/** Largest cell grade over the buckets, the strength every cell is normalised against. */
function maxColumnGrade(columns: readonly TpoColumn[], settings: TpoSettings): number {
  let max = 0;
  for (const column of columns) {
    for (const cell of column.cells) {
      if (cell.grade > max) max = cell.grade;
    }
  }
  return max;
}

/** Price rows the pane asks the server for, given its own height. */
export function rowsForPane(plotHeight: number, settings: TpoSettings): number {
  return rowCountFor(plotHeight - HEADER_HEIGHT - LETTER_BAND - 4, settings.profileSpacing);
}

/** Grade of a cell as the settings want it, exposed for the automated checks. */
export function gradeOf(cell: Parameters<typeof cellGrade>[0], settings: TpoSettings): number {
  return cellGrade(cell, settings.cellGrading);
}
