import type { Frame } from '../layout';
import { PRICE_AXIS_WIDTH, TIME_AXIS_HEIGHT } from '../layout';
import type { FootprintBar, FootprintSeries } from '../types';
import { api } from '../api';
import {
  THEME,
  clamp,
  drawText,
  fillRect,
  hLine,
  measureText,
  mixHex,
  vLine,
  withAlpha,
} from '../canvasKit';
import { fmtCompact, fmtNumber, fmtPrice, fmtSize, fmtPct } from '../format';
import { binarySearchStart } from '../series';
import { errorMessage } from '../series';
import { drawTimeAxis, drawTimeColumns } from './axes';
import { DEFAULT_FOOTPRINT_SETTINGS, type CellMetric, type FootprintSettings } from '../footprintSettings';
import {
  barScale,
  buildLadder,
  isUntestedLater,
  markImbalances,
  markLevels,
  markUnfinishedAuction,
  nakedLevels,
  statsValues,
  tradedPriceSets,
  type BarScale,
  type FootprintRow,
  type Ladder,
  type StatValue,
} from './footprintModel';

/** Base row height with `dynamicCandleWidth` off. */
const ROW_HEIGHT = 17;
const MIN_ROW_HEIGHT = 9;
const MAX_ROW_HEIGHT = 34;
const HEADER_HEIGHT = 18;
const LABEL_WIDTH = 78;
const LADDER_GAP = 10;
const STATS_HEIGHT = 17;
const COLUMN_MIN_WIDTH = 44;
const MONO_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const HEADER_FONT = `600 11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;

/*
 * The ladder is linear in price: every row spans `step`. That makes a price mappable
 * to a row position, including prices outside the selected bar's range.
 */
interface LadderMapping {
  basePrice: number;
  step: number;
  rowHeight: number;
  top: number;
  rowCount: number;
  yOf: (price: number) => number;
}

interface CellEnv {
  settings: FootprintSettings;
  scale: BarScale;
  font: string;
  qtyText: (value: number) => string;
  buy: string;
  sell: string;
  text: string;
  volume: string;
}

/**
 * Footprint pane: the bid x ask ladder of one bar as a price ladder with per-price
 * buy and sell quantity, the point-of-control row and imbalances marked, plus
 * cumulative volume delta for the visible window. Everything the footprint settings
 * dialog writes changes what is drawn here.
 */
export class FootprintPane {
  readonly id = 'footprint';
  data: FootprintSeries | null = null;
  error: string | null = null;
  loading = false;
  /** Live settings object; the app swaps it whenever the dialog patches a field. */
  settings: FootprintSettings = DEFAULT_FOOTPRINT_SETTINGS;
  /** Bar under the crosshair; falls back to the newest bar. */
  selectedStart: number | null = null;
  /** What the last drawn frame computed, for the console and automated checks. */
  debugInfo: Record<string, unknown> | null = null;
  private requestKey = '';
  private generation = 0;

  /**
   * Refetch when the symbol, interval or visible window moved by more than a few
   * bars, so panning does not fire a request per frame.
   */
  needsRefresh(instrument: string, timeframe: string, from: number, to: number, barMs: number): boolean {
    if (!instrument || !this.data) return true;
    const bucket = Math.max(barMs, 1);
    const key = `${instrument}|${timeframe}|${Math.round(from / bucket)}|${Math.round(to / bucket)}`;
    return key !== this.requestKey;
  }

  async refresh(instrument: string, timeframe: string, from: number, to: number, barMs: number, limit = 60): Promise<boolean> {
    if (!instrument) return false;
    const bucket = Math.max(barMs, 1);
    this.requestKey = `${instrument}|${timeframe}|${Math.round(from / bucket)}|${Math.round(to / bucket)}`;
    const generation = ++this.generation;
    this.loading = true;
    try {
      const series = await api.footprint(instrument, timeframe, { from, to, limit });
      if (generation !== this.generation) return false;
      this.data = series;
      this.error = null;
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      this.error = errorMessage(error);
      this.data = null;
      return true;
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }

  reset(): void {
    this.generation += 1;
    this.data = null;
    this.error = null;
    this.requestKey = '';
  }

  draw(ctx: CanvasRenderingContext2D, frame: Frame): void {
    const { width, height } = frame;
    const plotBottom = height - (frame.axisBottom ? TIME_AXIS_HEIGHT : 0);
    const timeTicks = frame.x.timeTicks();
    drawTimeColumns(ctx, 0, plotBottom, timeTicks, frame.x, frame.left, width - PRICE_AXIS_WIDTH);
    if (frame.axisBottom) drawTimeAxis(ctx, frame, timeTicks, frame.x);

    const settings = this.settings;
    const bars = this.data?.bars ?? [];
    const selectedIndex = this.pickIndex();
    const selected = selectedIndex >= 0 ? (bars[selectedIndex] ?? null) : null;
    const stats = this.data && selectedIndex >= 0 ? this.computeStats(frame, selectedIndex) : [];
    this.drawHeader(ctx, frame, selected, bars.length);

    const above = settings.statsRowsPosition === 'above' && stats.length > 0;
    const below = settings.statsRowsPosition === 'below' && stats.length > 0;
    const top = HEADER_HEIGHT + 4 + (above ? STATS_HEIGHT : 0);
    const bottom = plotBottom - (below ? STATS_HEIGHT : 0);
    if (above) this.drawStats(ctx, frame, stats, HEADER_HEIGHT + 1);

    if (!this.data || !selected || selectedIndex < 0) {
      const message = this.error ?? (this.loading ? 'loading prints…' : 'no prints stored for this window');
      drawText(ctx, message, width / 2, (top + bottom) / 2, { align: 'center', color: THEME.muted });
      if (below) this.drawStats(ctx, frame, stats, plotBottom - STATS_HEIGHT + 1);
      return;
    }
    this.drawLadder(ctx, frame, selected, selectedIndex, top, bottom);
    this.drawCvd(ctx, frame, selectedIndex, bottom);
    if (below) this.drawStats(ctx, frame, stats, plotBottom - STATS_HEIGHT + 1);
  }

  /** The bar the crosshair points at, matched by start time so it survives paging. */
  private pickIndex(): number {
    const bars = this.data?.bars;
    if (!bars || bars.length === 0) return -1;
    const wanted = this.selectedStart;
    if (wanted !== null) {
      for (let i = 0; i < bars.length; i += 1) if (bars[i]?.start === wanted) return i;
    }
    return bars.length - 1;
  }

  private drawHeader(ctx: CanvasRenderingContext2D, frame: Frame, selected: FootprintBar | null, barCount: number): void {
    const precision = frame.instrument?.pricePrecision ?? 2;
    const qtyPrecision = frame.instrument?.qtyPrecision ?? 2;
    const x = 8;
    drawText(ctx, 'Footprint', x, 9, { color: THEME.text, font: HEADER_FONT });
    if (!selected) {
      drawText(ctx, `${barCount} bars`, x + 74, 9, { color: THEME.muted });
      return;
    }
    let cursor = x + 74;
    cursor += drawText(ctx, frame.local.format(selected.start, 'dateTime'), cursor, 9, { color: THEME.muted }) + 12;
    cursor +=
      drawText(ctx, `qty ${fmtSize(selected.totalQty, qtyPrecision)}`, cursor, 9, { color: THEME.text }) + 12;
    cursor +=
      drawText(
        ctx,
        `Δ ${fmtSize(selected.delta, qtyPrecision)}`,
        cursor,
        9,
        { color: selected.delta >= 0 ? THEME.up : THEME.down },
      ) + 12;
    cursor += drawText(ctx, `trades ${fmtCompact(selected.trades)}`, cursor, 9, { color: THEME.text }) + 12;
    cursor += drawText(ctx, `POC ${fmtPrice(selected.poc, precision)}`, cursor, 9, { color: this.settings.pocColor }) + 12;
    const hint = 'double-click to set up · hover the tape to inspect a bar';
    if (frame.hover.index < 0 && cursor + measureText(ctx, hint) < frame.width - PRICE_AXIS_WIDTH - 8) {
      drawText(ctx, hint, cursor, 9, { color: THEME.muted });
    }
  }

  private drawLadder(
    ctx: CanvasRenderingContext2D,
    frame: Frame,
    bar: FootprintBar,
    selectedIndex: number,
    top: number,
    plotBottom: number,
  ): void {
    const settings = this.settings;
    const series = this.data;
    if (!series) return;
    const tick = series.priceTick || frame.instrument?.priceTick || 0.01;
    const precision = frame.instrument?.pricePrecision ?? 2;
    const width = frame.width;
    const right = width - PRICE_AXIS_WIDTH;

    // Columns are drawn from `footprintColumns`; the CVD panel gives way first, then
    // the price-label gutter, then whole columns, so the ladder never becomes unreadable.
    let columns = settings.footprintColumns.slice(0, 4);
    let cvdWidth = clamp(width * 0.3, 110, 240);
    let labelWidth = LABEL_WIDTH;
    const layout = () => right - labelWidth - cvdWidth - LADDER_GAP * 2;
    const fits = (count: number) => layout() >= COLUMN_MIN_WIDTH * count;
    if (!fits(columns.length)) {
      cvdWidth = Math.max(0, cvdWidth - (COLUMN_MIN_WIDTH * columns.length - layout()));
      if (!fits(columns.length)) labelWidth = Math.max(48, labelWidth - (COLUMN_MIN_WIDTH * columns.length - layout()));
    }
    if (!fits(2)) return;
    while (columns.length > 2 && !fits(columns.length)) columns = columns.slice(0, columns.length - 1);

    const ladderWidth = layout();
    const columnWidth = Math.floor(ladderWidth / columns.length);

    // Row height: `dynamicCandleWidth` fills the pane, otherwise the base height times
    // `barHeightMultiplier`; grouping then keeps the row count inside the pane.
    const fixedHeight = clamp(Math.round(ROW_HEIGHT * settings.barHeightMultiplier), MIN_ROW_HEIGHT, MAX_ROW_HEIGHT);
    const available = Math.max(0, plotBottom - top - 2);
    const rowsAvailable = Math.max(1, Math.floor(available / fixedHeight));
    const built = buildLadder(bar, rowsAvailable, tick, settings);
    if (!built) return;
    let rowHeight = fixedHeight;
    if (settings.dynamicCandleWidth) {
      rowHeight = clamp(Math.floor(available / built.rows.length), MIN_ROW_HEIGHT, MAX_ROW_HEIGHT);
    }

    const ladder: Ladder = {
      rows: built.rows,
      step: built.step,
      group: built.group,
      pocIndex: -1,
      vahIndex: -1,
      valIndex: -1,
      topIndex: built.rows.length - 1,
      bottomIndex: 0,
    };
    markLevels(ladder, bar, settings);
    markImbalances(ladder.rows, settings);
    markUnfinishedAuction(ladder, settings);

    const dayKey = (start: number) => frame.local.dayKey(start);
    const scale = barScale(series, selectedIndex, ladder, settings, built.group, tick, dayKey, bar.start);
    const env = this.cellEnv(scale, frame.instrument?.qtyPrecision ?? 2);

    // Highest price at the top.
    const yFor = (index: number) => top + (ladder.rows.length - 1 - index) * rowHeight;
    const sets = tradedPriceSets(series);
    for (let index = ladder.rows.length - 1; index >= 0; index -= 1) {
      const row = ladder.rows[index];
      if (!row) continue;
      const y = yFor(index);
      if (y > plotBottom) continue;
      this.drawRow(ctx, frame, row, env, columns, labelWidth, columnWidth, y, rowHeight, right, sets, selectedIndex);
    }

    this.debugInfo = {
      start: bar.start,
      rows: ladder.rows.length,
      step: built.step,
      rowHeight,
      topIndex: ladder.topIndex,
      pocIndex: ladder.pocIndex,
      vahIndex: ladder.vahIndex,
      valIndex: ladder.valIndex,
      unfinished: ladder.rows.filter((row) => row.unfinished).length,
      buyImbalance: ladder.rows.filter((row) => row.buyImbalance).length,
      sellImbalance: ladder.rows.filter((row) => row.sellImbalance).length,
      emptyRows: ladder.rows.filter((row) => row.total <= 0).length,
      zeroMetricRows: ladder.rows.filter((row) => columns.some((metric) => row.metrics[metric] === 0)).length,
      topRow: (() => {
        const row = ladder.rows[ladder.topIndex];
        return row ? { buy: +row.buyQty.toFixed(4), sell: +row.sellQty.toFixed(4) } : null;
      })(),
      mode: settings.displayMode,
      columns: columns.join(','),
    };

    this.drawLevels(ctx, ladder, labelWidth, yFor, rowHeight, right);
    const firstRow = ladder.rows[0];
    if (firstRow) {
      const basePrice = firstRow.priceLow;
      const step = built.step;
      const mapping: LadderMapping = {
        basePrice,
        step,
        rowHeight,
        top,
        rowCount: ladder.rows.length,
        yOf: (price: number) =>
          top + (ladder.rows.length - 1 - (price - basePrice) / step) * rowHeight + rowHeight / 2 - 1,
      };
      this.drawNakedLevels(ctx, frame, series, selectedIndex, mapping, labelWidth, right, top, plotBottom);
    }

    hLine(ctx, labelWidth, right, top - 3, THEME.axisLine);
    if (built.group > 1) {
      drawText(ctx, `rows ≈ ${fmtPrice(built.step, precision)}`, right - 6, plotBottom - 8, {
        align: 'right',
        color: THEME.muted,
      });
    }
  }

  /** One price row: heat, the mode's body, imbalance marks and the price label. */
  private drawRow(
    ctx: CanvasRenderingContext2D,
    frame: Frame,
    row: FootprintRow,
    env: CellEnv,
    columns: CellMetric[],
    labelWidth: number,
    columnWidth: number,
    y: number,
    rowHeight: number,
    right: number,
    sets: Set<string>[],
    selectedIndex: number,
  ): void {
    const settings = env.settings;
    const ladderLeft = labelWidth + LADDER_GAP;
    const ladderWidth = columnWidth * columns.length;
    const mode = settings.displayMode;

    if (row.isPoc && settings.showPOC) {
      fillRect(ctx, labelWidth, y, ladderWidth + LADDER_GAP, rowHeight - 1, withAlpha(settings.pocColor, 0.22));
      if (settings.showPOCOutline) {
        ctx.strokeStyle = settings.pocColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(ladderLeft), Math.round(y), Math.round(ladderWidth), Math.max(1, rowHeight - 1));
      }
    }
    if (settings.showValueArea && settings.showValueAreaBand && row.inValueArea) {
      fillRect(ctx, ladderLeft, y, ladderWidth, rowHeight - 1, 'rgba(148,163,178,0.07)');
    }
    const precision = frame.instrument?.pricePrecision ?? 2;
    const imbalanced = row.buyImbalance || row.sellImbalance;
    const labelColor = row.isPoc ? settings.pocColor : row.isVah ? settings.vahColor : row.isVal ? settings.valColor : THEME.text;
    drawText(ctx, fmtPrice(row.labelPrice, precision), labelWidth - 6, y + rowHeight / 2 - 1, {
      align: 'right',
      color: labelColor,
    });

    if (mode === 'ladder') {
      this.drawBidAskLadder(ctx, row, env, ladderLeft, ladderWidth, y, rowHeight);
    } else if (mode === 'stacked-bar' || mode === 'stacked-bar-delta' || mode === 'split-bar' || mode === 'cluster') {
      this.drawModeBar(ctx, mode, row, env, ladderLeft, ladderWidth, y, rowHeight);
    } else {
      for (let i = 0; i < columns.length; i += 1) {
        const metric = columns[i];
        if (!metric) continue;
        const x = labelWidth + i * columnWidth;
        if (mode === 'imbalance-only' && !imbalanced) continue;
        this.drawCell(ctx, metric, row, env, x, y, columnWidth, rowHeight);
      }
      if (settings.secondaryCellMetric !== 'off') {
        drawText(
          ctx,
          secondaryText(row, settings.secondaryCellMetric, env.qtyText),
          labelWidth + ladderWidth - 4,
          y + rowHeight / 2 - 1,
          { align: 'right', color: THEME.muted, font: smallFont(env) },
        );
      }
    }
    this.drawImbalanceMarks(ctx, row, ladderLeft, ladderWidth, y, rowHeight, sets, selectedIndex, right);
    // Last, so the auction marker stays visible over the cell heat it sits on.
    if (row.unfinished) this.drawUnfinishedAuction(ctx, row, labelWidth, ladderLeft, ladderWidth, columnWidth, y, rowHeight);
  }

  /** `ladder` mode: bid quantity left of centre, ask quantity right of centre. */
  private drawBidAskLadder(
    ctx: CanvasRenderingContext2D,
    row: FootprintRow,
    env: CellEnv,
    left: number,
    width: number,
    y: number,
    rowHeight: number,
  ): void {
    const settings = env.settings;
    const half = Math.floor(width / 2);
    const buyStrength = env.scale.peakSide > 0 ? row.buyQty / env.scale.peakSide : 0;
    const sellStrength = env.scale.peakSide > 0 ? row.sellQty / env.scale.peakSide : 0;
    shade(ctx, left, y, half, rowHeight - 1, env.buy, buyStrength, settings);
    shade(ctx, left + half, y, half, rowHeight - 1, env.sell, sellStrength, settings);
    vLine(ctx, left + half, y, y + rowHeight - 1, THEME.gridMajor);
    const mid = y + rowHeight / 2 - 1;
    if (row.buyQty > 0) {
      drawText(ctx, env.qtyText(row.buyQty), left + half - 6, mid, { align: 'right', color: env.buy, font: env.font });
    }
    if (row.sellQty > 0) {
      drawText(ctx, env.qtyText(row.sellQty), left + half + 6, mid, { color: env.sell, font: env.font });
    }
    if (settings.secondaryCellMetric !== 'off') {
      drawText(
        ctx,
        secondaryText(row, settings.secondaryCellMetric, env.qtyText),
        left + width - 4,
        mid,
        { align: 'right', color: THEME.muted, font: smallFont(env) },
      );
    }
  }

  /** Bar modes: one wide bar per row whose shape depends on the mode. */
  private drawModeBar(
    ctx: CanvasRenderingContext2D,
    mode: string,
    row: FootprintRow,
    env: CellEnv,
    left: number,
    width: number,
    y: number,
    rowHeight: number,
  ): void {
    const settings = env.settings;
    const mid = y + rowHeight / 2 - 1;
    const span = width * clamp(settings.barWidth, 0.05, 1);
    const totalStrength = env.scale.peakTotal > 0 ? row.total / env.scale.peakTotal : 0;
    const deltaStrength = env.scale.peakDelta > 0 ? Math.abs(row.delta) / env.scale.peakDelta : 0;
    const buyShare = row.total > 0 ? row.buyQty / row.total : 0.5;

    if (mode === 'split-bar') {
      const half = Math.floor(width / 2);
      vLine(ctx, left + half, y, y + rowHeight - 1, THEME.gridMajor);
      const buyLen = (half * clamp(settings.barWidth, 0.05, 1) * (env.scale.peakSide > 0 ? row.buyQty / env.scale.peakSide : 0));
      const sellLen = (half * clamp(settings.barWidth, 0.05, 1) * (env.scale.peakSide > 0 ? row.sellQty / env.scale.peakSide : 0));
      if (buyLen > 0) fillRect(ctx, left + half - buyLen, y + 2, buyLen, rowHeight - 5, withAlpha(env.buy, 0.75));
      if (sellLen > 0) fillRect(ctx, left + half, y + 2, sellLen, rowHeight - 5, withAlpha(env.sell, 0.75));
      drawText(ctx, env.qtyText(row.buyQty), left - 4, mid, { align: 'right', color: env.buy, font: env.font });
      drawText(ctx, env.qtyText(row.sellQty), left + width + 4, mid, { color: env.sell, font: env.font });
      return;
    }

    if (mode === 'stacked-bar-delta') {
      const length = span * deltaStrength;
      const color = row.delta >= 0 ? env.buy : env.sell;
      fillRect(ctx, left, y + 2, span, rowHeight - 5, withAlpha(THEME.text, 0.05));
      if (length > 0) fillRect(ctx, left, y + 2, length, rowHeight - 5, withAlpha(color, 0.8));
      drawText(ctx, env.qtyText(row.delta), left + span + 6, mid, { color, font: env.font });
      drawText(ctx, env.qtyText(row.total), left + width + 6, mid, { color: THEME.muted, font: smallFont(env) });
      return;
    }

    if (mode === 'stacked-bar') {
      const length = span * totalStrength;
      const buyLen = row.total > 0 ? length * (row.buyQty / row.total) : 0;
      if (buyLen > 0) fillRect(ctx, left, y + 2, buyLen, rowHeight - 5, withAlpha(env.buy, 0.8));
      if (length - buyLen > 0) fillRect(ctx, left + buyLen, y + 2, length - buyLen, rowHeight - 5, withAlpha(env.sell, 0.8));
      drawText(ctx, env.qtyText(row.total), left + span + 6, mid, { color: env.volume, font: env.font });
      return;
    }

    // `cluster`: a heat block whose size carries volume and whose text carries the
    // cluster metric.
    const length = span * totalStrength;
    const base = settings.useGradient ? mixHex(env.buy, env.sell, 1 - buyShare) : env.volume;
    if (length > 0) shade(ctx, left, y, length, rowHeight - 1, base, totalStrength, settings);
    const value =
      settings.clusterCellMetric === 'volume'
        ? env.qtyText(row.total)
        : settings.clusterCellMetric === 'ratio'
          ? (row.sellQty > 0 ? (row.buyQty / row.sellQty).toFixed(2) : '∞')
          : env.qtyText(row.delta);
    const tone =
      settings.clusterCellMetric === 'delta' && row.delta !== 0 ? (row.delta > 0 ? THEME.up : THEME.down) : env.text;
    drawText(ctx, value, left + 4, mid, { color: env.settings.colorImbalanceText && row.imbalanceRun > 0 ? env.buy : tone, font: env.font });
    drawText(ctx, env.qtyText(row.total), left + span + 6, mid, { color: THEME.muted, font: smallFont(env) });
  }

  /** One metric cell: shading behind, value in front. */
  private drawCell(
    ctx: CanvasRenderingContext2D,
    metric: CellMetric,
    row: FootprintRow,
    env: CellEnv,
    x: number,
    y: number,
    width: number,
    rowHeight: number,
  ): void {
    const settings = env.settings;
    const scale = env.scale;
    const mid = y + rowHeight / 2 - 1;
    const pad = 6;
    const totalStrength = scale.peakTotal > 0 ? row.total / scale.peakTotal : 0;
    const sideStrength = (value: number) => (scale.peakSide > 0 ? value / scale.peakSide : 0);
    const deltaStrength = scale.peakDelta > 0 ? Math.abs(row.delta) / scale.peakDelta : 0;
    const buyShare = row.total > 0 ? row.buyQty / row.total : 0.5;
    const span = width * clamp(settings.barWidth, 0.05, 1);

    let color = env.text;
    let strength = totalStrength;
    switch (metric) {
      case 'buy':
        color = env.buy;
        strength = sideStrength(row.buyQty);
        break;
      case 'sell':
        color = env.sell;
        strength = sideStrength(row.sellQty);
        break;
      case 'delta':
      case 'deltaColored':
      case 'deltaPct':
      case 'diagonalDelta':
        color = row.delta > 0 ? THEME.up : row.delta < 0 ? THEME.down : env.text;
        strength = deltaStrength;
        break;
      case 'volume':
      case 'volumeBar':
      case 'volumeBarLeading':
        color = env.volume;
        break;
      case 'bidAsk':
      case 'splitBar':
        color = settings.useGradient ? mixHex(env.buy, env.sell, 1 - buyShare) : env.text;
        break;
      case 'deltaBar':
        color = row.delta > 0 ? THEME.up : row.delta < 0 ? THEME.down : env.text;
        strength = deltaStrength;
        break;
      default:
        break;
    }
    if (metric !== 'bidAsk' && metric !== 'splitBar') shade(ctx, x, y, width, rowHeight - 1, color, strength, settings);

    // `colorImbalanceText` repaints the numbers of an imbalanced row in its side colour.
    const imbalanceText = settings.colorImbalanceText && (row.buyImbalance || row.sellImbalance);
    const textColor = imbalanceText
      ? row.buyImbalance
        ? settings.imbalanceBuyColor
        : settings.imbalanceSellColor
      : metric === 'delta' || metric === 'deltaColored' || metric === 'deltaPct' || metric === 'diagonalDelta' || metric === 'deltaBar'
        ? color
        : metric === 'buy'
          ? env.buy
          : metric === 'sell'
            ? env.sell
            : metric === 'volume' || metric === 'volumeBar' || metric === 'volumeBarLeading'
              ? env.volume
              : env.text;

    switch (metric) {
      case 'bidAsk': {
        const half = Math.floor(width / 2);
        shade(ctx, x, y, half, rowHeight - 1, env.buy, sideStrength(row.buyQty), settings);
        shade(ctx, x + half, y, width - half, rowHeight - 1, env.sell, sideStrength(row.sellQty), settings);
        vLine(ctx, x + half, y, y + rowHeight - 1, THEME.gridMajor);
        if (row.buyQty > 0) {
          drawText(ctx, env.qtyText(row.buyQty), x + half - 5, mid, {
            align: 'right',
            color: settings.colorImbalanceText && row.buyImbalance ? settings.imbalanceBuyColor : env.buy,
            font: env.font,
          });
        }
        if (row.sellQty > 0) {
          drawText(ctx, env.qtyText(row.sellQty), x + half + 5, mid, {
            color: settings.colorImbalanceText && row.sellImbalance ? settings.imbalanceSellColor : env.sell,
            font: env.font,
          });
        }
        break;
      }
      case 'splitBar': {
        const half = Math.floor(width / 2);
        vLine(ctx, x + half, y, y + rowHeight - 1, THEME.gridMajor);
        const buyLen = half * clamp(settings.barWidth, 0.05, 1) * sideStrength(row.buyQty);
        const sellLen = half * clamp(settings.barWidth, 0.05, 1) * sideStrength(row.sellQty);
        if (buyLen > 0) fillRect(ctx, x + half - buyLen, y + 2, buyLen, rowHeight - 5, withAlpha(env.buy, 0.85));
        if (sellLen > 0) fillRect(ctx, x + half, y + 2, sellLen, rowHeight - 5, withAlpha(env.sell, 0.85));
        if (row.buyQty > 0) drawText(ctx, env.qtyText(row.buyQty), x + 2, mid, { color: env.buy, font: smallFont(env) });
        if (row.sellQty > 0) drawText(ctx, env.qtyText(row.sellQty), x + width - 2, mid, { align: 'right', color: env.sell, font: smallFont(env) });
        break;
      }
      case 'volumeBar':
      case 'volumeBarLeading': {
        const length = span * totalStrength;
        if (length > 0) {
          const buyLen = row.total > 0 ? length * (row.buyQty / row.total) : 0;
          if (buyLen > 0) fillRect(ctx, x, y + 2, buyLen, rowHeight - 5, withAlpha(env.buy, 0.8));
          if (length - buyLen > 0) fillRect(ctx, x + buyLen, y + 2, length - buyLen, rowHeight - 5, withAlpha(env.sell, 0.8));
        }
        const text = env.qtyText(row.total);
        if (metric === 'volumeBar') drawText(ctx, text, x + width - pad, mid, { align: 'right', color: textColor, font: env.font });
        else {
          const at = Math.min(x + width - pad, x + length + 4);
          drawText(ctx, text, at, mid, { color: textColor, font: env.font });
        }
        break;
      }
      case 'deltaBar': {
        const half = Math.floor(width / 2);
        const length = half * clamp(settings.barWidth, 0.05, 1) * deltaStrength;
        vLine(ctx, x + half, y, y + rowHeight - 1, THEME.gridMajor);
        if (length > 0) {
          const barColor = row.delta >= 0 ? THEME.up : THEME.down;
          if (row.delta >= 0) fillRect(ctx, x + half, y + 2, length, rowHeight - 5, withAlpha(barColor, 0.85));
          else fillRect(ctx, x + half - length, y + 2, length, rowHeight - 5, withAlpha(barColor, 0.85));
        }
        drawText(ctx, env.qtyText(row.delta), x + width - pad, mid, { align: 'right', color: textColor, font: env.font });
        break;
      }
      case 'deltaPct': {
        const value = row.metrics.deltaPct;
        drawText(ctx, fmtPct(value), x + width - pad, mid, { align: 'right', color: textColor, font: env.font });
        break;
      }
      case 'diagonalDelta': {
        const value = row.metrics.diagonalDelta;
        drawText(ctx, env.qtyText(value), x + width - pad, mid, { align: 'right', color: textColor, font: env.font });
        break;
      }
      case 'delta':
      case 'deltaColored': {
        drawText(ctx, env.qtyText(row.delta), x + width - pad, mid, { align: 'right', color: textColor, font: env.font });
        break;
      }
      case 'volume': {
        drawText(ctx, env.qtyText(row.total), x + width - pad, mid, { align: 'right', color: textColor, font: env.font });
        break;
      }
      case 'buy': {
        drawText(ctx, env.qtyText(row.buyQty), x + width - pad, mid, { align: 'right', color: textColor, font: env.font });
        break;
      }
      case 'sell': {
        drawText(ctx, env.qtyText(row.sellQty), x + width - pad, mid, { align: 'right', color: textColor, font: env.font });
        break;
      }
      default:
        break;
    }
  }

  /** Imbalance markers, and the naked imbalance level when it is still open. */
  private drawImbalanceMarks(
    ctx: CanvasRenderingContext2D,
    row: FootprintRow,
    ladderLeft: number,
    ladderWidth: number,
    y: number,
    rowHeight: number,
    sets: Set<string>[],
    selectedIndex: number,
    right: number,
  ): void {
    const settings = this.settings;
    if (!settings.imbalance) return;
    const strip = Math.max(3, ladderWidth * (0.03 + Math.min(0.06, (row.imbalanceRun - 1) * 0.02)));
    if (row.buyImbalance) fillRect(ctx, ladderLeft, y, strip, rowHeight - 1, settings.imbalanceBuyColor);
    if (row.sellImbalance) fillRect(ctx, ladderLeft + ladderWidth - strip, y, strip, rowHeight - 1, settings.imbalanceSellColor);
    if (!settings.showImbalanceNaked) return;
    const flagged = row.buyImbalance || row.sellImbalance;
    if (!flagged) return;
    const color = row.buyImbalance ? settings.imbalanceBuyColor : settings.imbalanceSellColor;
    if (isUntestedLater(sets, selectedIndex, row.labelPrice)) {
      dashedLine(ctx, ladderLeft, right, y + rowHeight / 2 - 1, withAlpha(color, 0.45));
    }
  }

  /** The unfinished auction at the top of the print range. */
  private drawUnfinishedAuction(
    ctx: CanvasRenderingContext2D,
    row: FootprintRow,
    labelWidth: number,
    ladderLeft: number,
    ladderWidth: number,
    columnWidth: number,
    y: number,
    rowHeight: number,
  ): void {
    const settings = this.settings;
    const color = settings.unfinishedAuctionColor;
    const mode = settings.displayMode;
    if (mode === 'cluster') {
      fillRect(ctx, ladderLeft, y, Math.max(columnWidth, ladderWidth * 0.35), rowHeight - 1, withAlpha(color, 0.42));
    } else if (mode === 'imbalance-only') {
      const strip = Math.max(4, ladderWidth * 0.08);
      if (row.buyImbalance) fillRect(ctx, ladderLeft, y, strip, rowHeight - 1, color);
      else fillRect(ctx, ladderLeft + ladderWidth - strip, y, strip, rowHeight - 1, color);
    } else {
      dashedLine(ctx, ladderLeft, ladderLeft + ladderWidth, y + rowHeight / 2 - 1, withAlpha(color, 0.75));
      fillRect(ctx, ladderLeft, y, Math.max(4, ladderWidth * 0.06), rowHeight - 1, withAlpha(color, 0.8));
    }
    if (mode === 'ladder') {
      drawText(ctx, 'UA', labelWidth - 6, y + rowHeight / 2 - 1, { align: 'right', color, font: HEADER_FONT });
    }
  }

  /** POC / VAH / VAL lines across the ladder. */
  private drawLevels(
    ctx: CanvasRenderingContext2D,
    ladder: Ladder,
    labelWidth: number,
    yFor: (index: number) => number,
    rowHeight: number,
    right: number,
  ): void {
    const settings = this.settings;
    if (settings.showPOC && ladder.pocIndex >= 0) {
      const thickness = clamp(settings.pocThickness, 1, 6);
      const y = yFor(ladder.pocIndex) + rowHeight / 2 - thickness / 2;
      fillRect(ctx, labelWidth, y, right - labelWidth, thickness, settings.pocColor);
    }
    if (settings.showValueArea) {
      if (settings.showVAH && ladder.vahIndex >= 0) {
        const row = ladder.rows[ladder.vahIndex];
        if (row?.isVah) dashedLine(ctx, labelWidth, right, yFor(ladder.vahIndex) + 1, settings.vahColor);
      }
      if (settings.showVAL && ladder.valIndex >= 0) {
        const row = ladder.rows[ladder.valIndex];
        if (row?.isVal) dashedLine(ctx, labelWidth, right, yFor(ladder.valIndex) + rowHeight - 2, settings.valColor);
      }
    }
  }

  /** Naked levels: untested POC/VAH/VAL from earlier bars in the window. */
  private drawNakedLevels(
    ctx: CanvasRenderingContext2D,
    frame: Frame,
    series: FootprintSeries,
    selectedIndex: number,
    mapping: LadderMapping,
    labelWidth: number,
    right: number,
    top: number,
    plotBottom: number,
  ): void {
    const settings = this.settings;
    const levels = nakedLevels(series, selectedIndex, settings);
    if (levels.length === 0) return;
    const precision = frame.instrument?.pricePrecision ?? 2;
    for (const level of levels) {
      const index = binarySearchStart(frame.bars, series.bars[level.barIndex]?.start ?? 0);
      const from = index >= 0 ? Math.max(labelWidth, frame.x.toX(index)) : labelWidth;
      const price = level.price;
      const y = mapping.yOf(price);
      if (!Number.isFinite(y) || y < top || y > plotBottom) continue;
      const color = level.kind === 'poc' ? settings.pocColor : level.kind === 'vah' ? settings.vahColor : settings.valColor;
      dashedLine(ctx, from, right, y, withAlpha(color, 0.6));
      const showPrice =
        (level.kind === 'poc' && settings.showPOCNakedPrice) ||
        (level.kind === 'vah' && settings.showVAHNakedPrice) ||
        (level.kind === 'val' && settings.showVALNakedPrice);
      if (showPrice) drawText(ctx, fmtPrice(price, precision), right + 4, y, { color, font: smallFontFor(settings) });
    }
  }

  /** Stats rows: the enabled metrics of the selected bar as a chip row. */
  private drawStats(ctx: CanvasRenderingContext2D, frame: Frame, stats: StatValue[], y: number): void {
    if (stats.length === 0) return;
    const settings = this.settings;
    hLine(ctx, 8, frame.width - PRICE_AXIS_WIDTH, y + STATS_HEIGHT - 2, THEME.gridMajor);
    let cursor = 8;
    const limit = frame.width - PRICE_AXIS_WIDTH - 8;
    for (const stat of stats) {
      const color = stat.tone === 'up' ? THEME.up : stat.tone === 'down' ? THEME.down : THEME.text;
      if (settings.statsRowsLabels) {
        const labelWidth = drawText(ctx, stat.label, cursor, y + STATS_HEIGHT / 2, { color: THEME.muted, font: SMALL_FONT }) + 3;
        cursor += labelWidth;
      }
      cursor += drawText(ctx, stat.value, cursor, y + STATS_HEIGHT / 2, { color, font: SMALL_FONT }) + 10;
      if (cursor > limit) break;
    }
  }

  private computeStats(frame: Frame, selectedIndex: number): StatValue[] {
    const series = this.data;
    if (!series) return [];
    const settings = this.settings;
    const precision = frame.instrument?.pricePrecision ?? 2;
    const env = this.cellEnv({ peakSide: 1, peakTotal: 1, peakDelta: 1 }, frame.instrument?.qtyPrecision ?? 2);
    return statsValues(
      series,
      selectedIndex,
      settings,
      (value) => fmtPrice(value, precision),
      env.qtyText,
    );
  }

  /** Formatters, colours and font derived from the text knobs. */
  private cellEnv(scale: BarScale, qtyPrecision: number): CellEnv {
    const settings = this.settings;
    const decimals = settings.volumeDecimals === 'auto' ? qtyPrecision : settings.volumeDecimals;
    const qtyText = (value: number): string => {
      if (!Number.isFinite(value)) return '—';
      if (settings.hideZeroText && Math.abs(value) < 1e-9) return '';
      const magnitude = Math.abs(value);
      if (settings.fullNumbers) return fmtNumber(value, decimals);
      if (magnitude >= 10_000) return fmtCompact(value);
      return settings.trimZeroTails ? fmtPrice(value, decimals) : fmtNumber(value, decimals);
    };
    const size = settings.cellFontSize === 'auto' ? 11 : settings.cellFontSize;
    return {
      settings,
      scale,
      font: `${size}px ${MONO_STACK}`,
      qtyText,
      buy: settings.colors[0],
      sell: settings.colors[1],
      text: settings.cellTextColor,
      volume: settings.volumeColor,
    };
  }

  /** Cumulative delta for the fetched window, positioned on the shared time mapping. */
  private drawCvd(ctx: CanvasRenderingContext2D, frame: Frame, selectedIndex: number, plotBottom: number): void {
    const series = this.data;
    if (!series || series.cvd.length === 0) return;
    const width = frame.width;
    const cvdWidth = clamp(width * 0.3, 110, 240);
    const right = width - PRICE_AXIS_WIDTH;
    const left = Math.max(LABEL_WIDTH + 20, right - cvdWidth);
    const top = HEADER_HEIGHT + 8;
    const bottom = plotBottom - 6;
    if (right - left < 40 || bottom <= top) return;

    const positions: number[] = [];
    for (const bar of series.bars) {
      const index = binarySearchStart(frame.bars, bar.start);
      positions.push(index >= 0 ? frame.x.toX(index) : Number.NaN);
    }
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const value of series.cvd) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    if (max - min < 1e-9) {
      const spread = Math.max(Math.abs(max) * 0.1, 1);
      min -= spread;
      max += spread;
    }
    const span = max - min;
    const yFor = (value: number) => bottom - ((value - min) / span) * (bottom - top);

    const fallbackStep = (right - left) / Math.max(1, series.bars.length);
    let started = false;
    ctx.beginPath();
    for (let i = 0; i < series.cvd.length; i += 1) {
      const value = series.cvd[i];
      if (value === undefined) continue;
      const stored = positions[i];
      const px = Number.isFinite(stored) ? stored! : left + i * fallbackStep;
      if (px < left - 40 || px > right + 40) continue;
      const y = yFor(value);
      if (!started) {
        ctx.moveTo(px, y);
        started = true;
      } else ctx.lineTo(px, y);
    }
    if (!started) return;
    ctx.strokeStyle = THEME.cvd;
    ctx.lineWidth = 1.4;
    ctx.stroke();

    if (min < 0 && max > 0) hLine(ctx, left, right, yFor(0), THEME.gridMajor);
    const selected = series.bars[selectedIndex];
    if (selected) {
      const index = binarySearchStart(frame.bars, selected.start);
      if (index >= 0) {
        const px = frame.x.toX(index);
        if (px >= left && px <= right) vLine(ctx, px, top, bottom, THEME.crosshair);
      }
    }
    drawText(ctx, 'CVD', left + 4, top - 6, { color: THEME.cvd, font: HEADER_FONT });
    drawText(ctx, fmtCompact(max), right + 6, top, { color: THEME.cvd });
    drawText(ctx, fmtCompact(min), right + 6, bottom, { color: THEME.cvd });
  }
}

/**
 * Volume shading: continuous, or quantised into `shadingSteps` levels. Shared with the
 * volume-profile pane so both order-flow panes grade quantity the same way.
 */
export function shade(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  strength: number,
  settings: FootprintSettings,
): void {
  if (!(strength > 0) || w <= 0) return;
  let value = Math.min(1, strength);
  if (settings.cellShading === 'steps') {
    const steps = clamp(Math.round(settings.shadingSteps), 2, 8);
    value = Math.round(value * steps) / steps;
    if (value <= 0) return;
  }
  const fill = settings.useGradient ? mixHex('#1b2027', color, value) : color;
  const alpha = settings.useGradient ? 0.18 + value * 0.5 : 0.06 + value * 0.42;
  fillRect(ctx, x, y, w, h, withAlpha(fill.startsWith('#') ? fill : color, alpha));
}

function smallFont(env: CellEnv): string {
  return smallFontFor(env.settings);
}

function smallFontFor(settings: FootprintSettings): string {
  const size = settings.cellFontSize === 'auto' ? 10 : Math.max(8, settings.cellFontSize - 2);
  return `${size}px ${MONO_STACK}`;
}

/** Horizontal dashed rule, used for levels and naked lines. */
function dashedLine(ctx: CanvasRenderingContext2D, x1: number, x2: number, y: number, color: string): void {
  ctx.save();
  ctx.setLineDash([3, 3]);
  hLine(ctx, x1, x2, y, color);
  ctx.restore();
}

function secondaryText(
  row: FootprintRow,
  metric: string,
  qtyText: (value: number) => string,
): string {
  switch (metric) {
    case 'volume':
      return qtyText(row.total);
    case 'delta':
      return qtyText(row.delta);
    case 'deltaPct':
      return fmtPct(row.metrics.deltaPct);
    case 'diagonalDelta':
      return qtyText(row.metrics.diagonalDelta);
    default:
      return '';
  }
}

const SMALL_FONT = `10px ${MONO_STACK}`;
