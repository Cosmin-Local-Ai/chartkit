import type { Frame, Rect } from '../layout';
import { PRICE_AXIS_WIDTH, TIME_AXIS_HEIGHT } from '../layout';
import type { PriceScale, XScale } from '../scale';
import type { Bar, Instrument } from '../types';
import { THEME, drawText, fillRect, hLine, measureText, vLine, dashedH, drawTag, withAlpha } from '../canvasKit';
import { decimalsForStep, fmtPrice, fmtPct, fmtSigned } from '../format';
import { timeframeDef } from '../timeframes';
import { toHex, type IndicatorPlot } from '../indicators/registry';
import { HeikinAshiCache } from '../heikinAshi';
import { drawPolyline, fillBetween } from './plotLine';
import {
  drawCrosshair,
  drawGapMarks,
  drawPriceAxis,
  drawSessionBands,
  drawSessionDividers,
  drawTimeAxis,
  drawTimeColumns,
} from './axes';

export type SeriesStyle = 'candles' | 'bars' | 'heikin' | 'line';

export const SERIES_STYLES: { value: SeriesStyle; label: string }[] = [
  { value: 'candles', label: 'Candles' },
  { value: 'bars', label: 'Bars' },
  { value: 'heikin', label: 'Heikin Ashi' },
  { value: 'line', label: 'Line' },
];

/** Legend text for a style: the switcher's label, lower-cased to match the other legend notes. */
function styleLabel(style: SeriesStyle): string {
  return (SERIES_STYLES.find((entry) => entry.value === style)?.label ?? style).toLowerCase();
}

export interface PriceDecor {
  gaps: { index: number; from: number; to: number; span: number }[];
  session: { index: number; start: number; open: boolean }[];
}

/** One onchart indicator instance, already computed, drawn over the price tape. */
export interface OverlayLayer {
  name: string;
  caption: string;
  /** Shown after the caption when the indicator has no data to plot. */
  note?: string;
  plots: IndicatorPlot[];
  band?: { upper: number; lower: number; color: string };
  smooth: boolean;
}

/**
 * Legend geometry. The block is two rows: the bar's price row, then one row carrying one
 * cluster of values per indicator overlay. Two rows keeps it about 36 px tall, which is the
 * point — every row the legend grows is tape the trader cannot see. A value with no room
 * moves to a label at the right edge of the plot instead of reflowing the block or shrinking
 * the type, which never goes below 11 px.
 */
const LEGEND_LINE_HEIGHT = 16;
/** Centre of the first legend row. */
const LEGEND_TOP = 14;
/** How far the scrim reaches above the first row and below the last. */
const LEGEND_PAD_Y = 10;
const LEGEND_PAD_X = 6;
/** Space between the parts of one value, and between two indicators' clusters. */
const SEGMENT_GAP = 6;
const GROUP_GAP = 12;
/**
 * Scrim behind the legend text. It comes in from the top edge and fades out again at the
 * bottom, so the block reads as a soft band rather than a plate bolted over the tape. The
 * alpha holds 11 px text over a bright candle while still letting the candles read through.
 * Both ends are the pane background, so the block still matches a pane the settings dialog
 * has re-inked.
 */
const legendScrim = (): string => withAlpha(THEME.bg, 0.62);
const legendScrimClear = (): string => withAlpha(THEME.bg, 0);
/** Where the scrim reaches full strength, and where it starts to fade, as fractions of its height. */
const LEGEND_SCRIM_IN = 0.22;
const LEGEND_SCRIM_OUT = 0.78;
/** Halo behind each glyph, so text stays legible where the scrim fades out. */
const LEGEND_HALO_WIDTH = 3;
/** Height of a right-edge value label, and the pitch kept between two of them. */
const VALUE_TAG_HEIGHT = 16;
const VALUE_TAG_PITCH = 18;
/** Ink on a value-label plate: dark when the study colour is bright, light when it is dark. */
const TAG_INK_DARK = '#0f1317';
const TAG_INK_LIGHT = '#f1f5f9';
/** Caption words that name the input a study reads, not a parameter that shapes its line. */
const INPUT_FIELDS = new Set(['close', 'open', 'high', 'low', 'hl2', 'hlc2', 'hlc3', 'ohlc4', 'volume']);

/**
 * Price pane: candlestick, OHLC bar, Heikin Ashi or line series over the shared time
 * mapping, with the price gutter, the live-price marker, the OHLCV legend and the crosshair.
 */
export class PricePane {
  readonly id = 'price';
  style: SeriesStyle = 'candles';
  showLegend = true;
  /** Off-session shading and the rule at each session boundary. */
  showSessionDivider = true;
  private readonly heikin = new HeikinAshiCache();
  /** The legend box of the last frame painted, for layout checks. */
  private legendBlock: LegendBlock | null = null;
  /** Right-edge labels painted on the last frame, for layout checks. */
  private valueTagBoxes: ValueTag[] = [];

  legendBox(): LegendBlock | null {
    return this.legendBlock;
  }

  /** Boxes the right-edge value labels occupy, so a check can prove a value is on screen. */
  valueTagRects(): Rect[] {
    return this.valueTagBoxes.map((tag) => tag.box);
  }

  /**
   * The bars this pane paints: the stored ones, or their Heikin Ashi transform. Only
   * the price tape reads the result — indicators, drawings, the volume pane and the
   * auto-fit range all keep using the raw bars, so smoothing changes what is drawn and
   * nothing else.
   */
  displayed(bars: readonly Bar[]): readonly Bar[] {
    return this.style === 'heikin' ? this.heikin.of(bars) : bars;
  }

  /**
   * `drawings` is the annotation layer's hook: it runs after the series and the
   * indicator overlays but before the axes, the live mark and the crosshair, so user
   * annotations sit on the tape without hiding the readouts.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    frame: Frame,
    decor: PriceDecor,
    overlays: readonly OverlayLayer[] = [],
    drawings?: (ctx: CanvasRenderingContext2D, frame: Frame, reserved: readonly Rect[]) => void,
  ): void {
    const { width, height, x, price, instrument } = frame;
    const bars = this.displayed(frame.bars);
    const plotBottom = height - (frame.axisBottom ? TIME_AXIS_HEIGHT : 0);
    const right = width - PRICE_AXIS_WIDTH;
    const precision = instrument?.pricePrecision ?? 2;
    // Averages such as Heikin Ashi carry more digits than the venue quotes, so the price
    // readouts follow the tick instead of the eight decimals some venues store.
    const seriesPrecision = Math.min(precision, tickPrecision(instrument));
    const timeTicks = x.timeTicks();

    drawSessionBands(ctx, frame, decor.session, this.showSessionDivider);
    for (const tick of price.ticks()) {
      const y = price.toY(tick.value);
      if (y < 1 || y > plotBottom) continue;
      hLine(ctx, frame.left, right, y, tick.major ? THEME.gridMajor : THEME.grid);
    }
    drawTimeColumns(ctx, 0, plotBottom, timeTicks, x, frame.left, right);

    const { first, last } = x.visibleRange();
    if (bars.length > 0 && this.style === 'line') this.drawLine(ctx, bars, x, price, first, last, plotBottom);
    else if (bars.length > 0) this.drawOHLC(ctx, bars, x, price, first, last);

    if (overlays.length > 0) this.drawOverlays(ctx, frame, overlays, plotBottom, first, last);

    // The legend is measured before the annotations so it can claim its area first: the
    // drawing layer keeps its labels out of that area and out of the right-edge value
    // labels, the scrim then covers the area, and the legend's own text goes down last.
    const index = Math.max(0, Math.min(bars.length - 1, hoverIndex(frame, bars)));
    const hovered = bars[index] ?? null;
    const legend = this.showLegend
      ? this.layoutLegend(ctx, frame, hovered ?? bars[bars.length - 1] ?? null, seriesPrecision, instrument, overlays, index)
      : null;
    this.legendBlock = legend;
    const reserved: Rect[] = [];
    if (legend) reserved.push(legend);
    const liveTag = this.liveTagRect(frame, price, plotBottom, bars);
    if (liveTag) reserved.push(liveTag);
    // Values the legend row had to leave out are labelled at the plot's right edge instead,
    // so the block stays two rows and no value is lost.
    this.valueTagBoxes = legend ? this.layoutValueTags(ctx, frame, price, plotBottom, legend, seriesPrecision) : [];
    for (const tag of this.valueTagBoxes) reserved.push(tag.box);

    drawings?.(ctx, frame, reserved);
    // The scrim goes down after the annotations so the legend reads over them rather than
    // through them: its band is the one part of the tape that stays clear.
    if (legend) this.paintLegendPlate(ctx, legend);

    drawGapMarks(ctx, frame, decor.gaps, frame.local);
    // Over the tape, next to the gap rules: a boundary the candles could hide is no use.
    drawSessionDividers(ctx, frame, decor.session, this.showSessionDivider);
    this.drawLiveMark(ctx, frame, bars, price, plotBottom, seriesPrecision);
    drawPriceAxis(ctx, frame, price, price.ticks());
    if (frame.axisBottom) drawTimeAxis(ctx, frame, timeTicks, x);

    const cursorPrice = price.fromY(Math.max(0, Math.min(plotBottom, frame.hover.y)));
    drawCrosshair(ctx, frame, {
      hoveredHere: frame.hover.paneId === this.id,
      gutterLabel: frame.hover.inside ? fmtPrice(cursorPrice, precision) : undefined,
      timeLabel: hovered ? frame.local.format(hovered.start, 'dateTime') : undefined,
    });
    if (legend) this.paintLegend(ctx, legend);
    for (const tag of this.valueTagBoxes) paintValueTag(ctx, tag);
  }

  /** Gutter box the live-price bubble occupies, so no drawing tag lands underneath it. */
  private liveTagRect(frame: Frame, price: PriceScale, plotBottom: number, bars: readonly Bar[]): Rect | null {
    const bar = bars[bars.length - 1];
    if (!bar) return null;
    const y = liveMarkY(price, plotBottom, bar);
    const right = frame.width - 2;
    const width = PRICE_AXIS_WIDTH - 2;
    return { left: right - width, top: y - 8, right, bottom: y + 8 };
  }

  private drawOHLC(
    ctx: CanvasRenderingContext2D,
    bars: readonly Bar[],
    x: XScale,
    price: PriceScale,
    first: number,
    last: number,
  ): void {
    const body = x.bodyWidth();
    const hairline = body < 2;
    for (let i = Math.max(0, first); i <= Math.min(bars.length - 1, last); i += 1) {
      const bar = bars[i];
      if (!bar) continue;
      const cx = Math.round(x.toX(i)) + 0.5;
      const rising = bar.close >= bar.open;
      const color = rising ? THEME.up : THEME.down;
      const yHigh = price.toY(bar.high);
      const yLow = price.toY(bar.low);
      vLine(ctx, cx, yHigh, yLow, color);
      const yOpen = price.toY(bar.open);
      const yClose = price.toY(bar.close);
      if (this.style === 'bars') {
        const arm = hairline ? 2 : Math.max(2, body / 2);
        hLine(ctx, cx - arm, cx, yOpen, color);
        hLine(ctx, cx, cx + arm, yClose, color);
        continue;
      }
      const top = Math.min(yOpen, yClose);
      const bodyHeight = Math.max(1, Math.abs(yClose - yOpen));
      if (hairline) {
        fillRect(ctx, cx - 0.5, top, 1, bodyHeight, color);
      } else {
        fillRect(ctx, cx - body / 2, top, body, bodyHeight, color);
        if (body >= 4) {
          // Outline keeps the body edge crisp against its own fill.
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.strokeRect(Math.round(cx - body / 2) + 0.5, Math.round(top) + 0.5, Math.round(body) - 1, Math.round(bodyHeight) - 1);
        }
      }
      if (!bar.closed) {
        ctx.strokeStyle = THEME.live;
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(cx - body / 2) - 1.5, Math.round(Math.min(yHigh, yLow)) - 1.5, Math.round(body) + 3, Math.round(Math.abs(yLow - yHigh)) + 3);
      }
    }
  }

  private drawLine(
    ctx: CanvasRenderingContext2D,
    bars: readonly Bar[],
    x: XScale,
    price: PriceScale,
    first: number,
    last: number,
    plotBottom: number,
  ): void {
    const from = Math.max(0, first);
    const to = Math.min(bars.length - 1, last);
    if (to <= from) {
      const only = bars[from];
      if (only) {
        const y = price.toY(only.close);
        ctx.fillStyle = THEME.accent;
        ctx.beginPath();
        ctx.arc(x.toX(from), y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
    ctx.beginPath();
    for (let i = from; i <= to; i += 1) {
      const bar = bars[i];
      if (!bar) continue;
      const px = x.toX(i);
      const y = price.toY(bar.close);
      if (i === from) ctx.moveTo(px, y);
      else ctx.lineTo(px, y);
    }
    ctx.strokeStyle = THEME.accent;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    const gradient = ctx.createLinearGradient(0, 0, 0, plotBottom);
    gradient.addColorStop(0, 'rgba(75,156,245,0.22)');
    gradient.addColorStop(1, 'rgba(75,156,245,0)');
    ctx.lineTo(x.toX(to), plotBottom);
    ctx.lineTo(x.toX(from), plotBottom);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
  }

  /** Last price: a dashed rule plus a gutter bubble, coloured by the bar direction. */
  private drawLiveMark(
    ctx: CanvasRenderingContext2D,
    frame: Frame,
    bars: readonly Bar[],
    price: PriceScale,
    plotBottom: number,
    precision: number,
  ): void {
    const bar = bars[bars.length - 1];
    if (!bar) return;
    const rising = bar.close >= bar.open;
    const color = rising ? THEME.up : THEME.down;
    const y = liveMarkY(price, plotBottom, bar);
    dashedH(ctx, frame.left, frame.width - PRICE_AXIS_WIDTH, y, color);
    drawTag(ctx, fmtPrice(bar.close, precision), frame.width - 2, y, {
      align: 'right',
      width: PRICE_AXIS_WIDTH - 2,
      color: '#0f1317',
      background: color,
    });
  }

  /**
   * Indicator overlays: band fills first, then their lines, clipped to the plot so a
   * pan past the right edge never paints over the price gutter.
   */
  private drawOverlays(
    ctx: CanvasRenderingContext2D,
    frame: Frame,
    overlays: readonly OverlayLayer[],
    plotBottom: number,
    first: number,
    last: number,
  ): void {
    const right = frame.width - PRICE_AXIS_WIDTH;
    ctx.save();
    ctx.beginPath();
    ctx.rect(frame.left, 0, Math.max(1, right - frame.left), Math.max(1, plotBottom));
    ctx.clip();
    for (const layer of overlays) {
      const band = layer.band;
      if (band) {
        const upper = layer.plots[band.upper];
        const lower = layer.plots[band.lower];
        if (upper && lower) fillBetween(ctx, upper.values, lower.values, frame.x, frame.price, first, last, band.color);
      }
      for (const plot of layer.plots) {
        drawPolyline(ctx, plot.values, frame.x, frame.price, first, last, plot.color, plot.width, layer.smooth);
      }
    }
    ctx.restore();
  }

  /**
   * The legend's two rows: the bar's price, then one cluster of values per indicator
   * overlay. Clusters that no longer fit are not squeezed and not wrapped onto more rows —
   * they land in `overflow`, and `layoutValueTags` paints them at the plot's right edge.
   */
  private layoutLegend(
    ctx: CanvasRenderingContext2D,
    frame: Frame,
    bar: Bar | null,
    seriesPrecision: number,
    instrument: Instrument | null,
    overlays: readonly OverlayLayer[],
    index: number,
  ): LegendBlock | null {
    const limit = Math.max(160, frame.width - PRICE_AXIS_WIDTH - 16);
    const start = frame.left + LEGEND_PAD_X + 4;
    const plotBottom = frame.height - (frame.axisBottom ? TIME_AXIS_HEIGHT : 0);
    const rows: LegendRow[] = [];
    const overflow: OverflowValue[] = [];

    const head = fitCells(measureCells(ctx, this.priceRow(frame, bar, seriesPrecision, instrument)), start, limit);
    rows.push({ y: LEGEND_TOP, cells: head.cells });
    let right = head.right;

    const groups = overlayGroups(overlays, index, seriesPrecision);
    // A pane too short for the second row loses it outright, and every value goes to the
    // right edge with it: two rows is the ceiling, so the block never grows to fit.
    if (groups.length > 0 && LEGEND_TOP + LEGEND_LINE_HEIGHT + LEGEND_PAD_Y <= plotBottom) {
      const values = placeGroups(ctx, groups, start, limit);
      overflow.push(...values.dropped.flatMap((group) => group.values));
      if (values.cells.length > 0) {
        rows.push({ y: LEGEND_TOP + LEGEND_LINE_HEIGHT, cells: values.cells });
        right = Math.max(right, values.right);
      }
    } else {
      overflow.push(...groups.flatMap((group) => group.values));
    }
    // A count of what moved to the right edge, so a row that stopped short never reads as
    // complete. It rides whichever row the block ended up with.
    if (overflow.length > 0) {
      const last = rows[rows.length - 1]!;
      const chip = fitCells(measureCells(ctx, [{ text: `+${overflow.length}`, color: THEME.muted, font: LABEL_FONT }]), right + GROUP_GAP, limit);
      last.cells.push(...chip.cells);
      right = Math.max(right, chip.right);
    }

    const last = rows[rows.length - 1];
    if (!last || rows.every((row) => row.cells.length === 0)) return null;
    return {
      rows,
      overflow,
      left: frame.left + 2,
      top: LEGEND_TOP - LEGEND_PAD_Y,
      right: Math.min(right + LEGEND_PAD_X, limit + LEGEND_PAD_X),
      bottom: last.y + LEGEND_PAD_Y,
    };
  }

  /**
   * Row one: what is on screen and which bar is being read. The bar's time goes last, so a
   * narrow pane loses it before it loses an OHLC value — the crosshair's time axis label
   * still names the bar.
   */
  private priceRow(frame: Frame, bar: Bar | null, seriesPrecision: number, instrument: Instrument | null): Segment[] {
    const row: Segment[] = [
      { text: instrument?.display ?? 'no symbol', color: THEME.text, font: TITLE_FONT },
      { text: timeframeDef(frame.timeframe).label, color: THEME.muted },
    ];
    if (this.style !== 'candles') row.push({ text: styleLabel(this.style), color: THEME.muted });
    if (frame.view.priceMode === 'log') row.push({ text: 'log scale', color: THEME.muted });
    if (frame.bars.length === 0) row.push({ text: 'no stored bars for this symbol yet', color: THEME.muted });
    if (!bar) return row;
    if (!bar.closed) row.push({ text: 'live', color: THEME.live });
    const rising = bar.close >= bar.open;
    const color = rising ? THEME.up : THEME.down;
    const change = bar.close - bar.open;
    const pct = bar.open !== 0 ? (change / bar.open) * 100 : 0;
    row.push(
      { text: 'O', color: THEME.muted, font: LABEL_FONT },
      { text: fmtPrice(bar.open, seriesPrecision), color: THEME.text },
      { text: 'H', color: THEME.muted, font: LABEL_FONT },
      { text: fmtPrice(bar.high, seriesPrecision), color },
      { text: 'L', color: THEME.muted, font: LABEL_FONT },
      { text: fmtPrice(bar.low, seriesPrecision), color },
      { text: 'C', color: THEME.muted, font: LABEL_FONT },
      { text: fmtPrice(bar.close, seriesPrecision), color },
      { text: fmtPct(pct), color },
      { text: fmtSigned(change, seriesPrecision), color },
      { text: frame.local.format(bar.start, 'dateTime'), color: THEME.muted },
    );
    return row;
  }

  /**
   * Labels for the values that lost their place on the legend row: each one sits at the plot's
   * right edge, at the height of the price it names, and keeps 18 px of pitch from the one
   * above so two studies at a similar price never stack. A price outside the framed range pins
   * its label to the edge it came from; one that would have to share a slot is left out rather
   * than pushed over the axes.
   */
  private layoutValueTags(
    ctx: CanvasRenderingContext2D,
    frame: Frame,
    price: PriceScale,
    plotBottom: number,
    legend: LegendBlock,
    precision: number,
  ): ValueTag[] {
    if (legend.overflow.length === 0) return [];
    const right = frame.width - PRICE_AXIS_WIDTH - 4;
    const wanted = legend.overflow
      .map((value) => {
        const name = value.name;
        const text = fmtPrice(value.value, precision);
        const width = 5 + measureText(ctx, name, LABEL_FONT) + 6 + measureText(ctx, text, VALUE_FONT) + 5;
        return { name, text, ...plateColors(value.color), width, wanted: price.toY(value.value) };
      })
      .filter((tag) => Number.isFinite(tag.wanted))
      .sort((a, b) => a.wanted - b.wanted);

    const tags: ValueTag[] = [];
    const lowest = plotBottom - VALUE_TAG_HEIGHT / 2 - 2;
    let bottom = -Infinity;
    for (const tag of wanted) {
      const level = Math.min(Math.max(tag.wanted, VALUE_TAG_HEIGHT / 2 + 2), lowest);
      const y = Math.max(level, bottom + VALUE_TAG_PITCH);
      if (y > lowest) continue;
      const box: Rect = { left: right - tag.width, top: y - VALUE_TAG_HEIGHT / 2, right, bottom: y + VALUE_TAG_HEIGHT / 2 };
      tags.push({ ...tag, y, box });
      bottom = y;
    }
    return tags;
  }

  /** Scrim behind the legend: text over the tape needs ground of its own to stay readable. */
  private paintLegendPlate(ctx: CanvasRenderingContext2D, legend: LegendBlock): void {
    const top = Math.round(legend.top);
    const width = Math.max(1, Math.round(legend.right - legend.left));
    const height = Math.max(1, Math.round(legend.bottom - legend.top));
    const scrim = ctx.createLinearGradient(0, top, 0, top + height);
    scrim.addColorStop(0, legendScrimClear());
    scrim.addColorStop(LEGEND_SCRIM_IN, legendScrim());
    scrim.addColorStop(LEGEND_SCRIM_OUT, legendScrim());
    scrim.addColorStop(1, legendScrimClear());
    ctx.fillStyle = scrim;
    ctx.fillRect(Math.round(legend.left), top, width, height);
  }

  /**
   * Legend text carries a dark halo of its own: the scrim fades out at the block's top and
   * bottom edges, and the halo is what keeps the outer row legible over a bright candle.
   */
  private paintLegend(ctx: CanvasRenderingContext2D, legend: LegendBlock): void {
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = LEGEND_HALO_WIDTH;
    ctx.strokeStyle = THEME.bg;
    for (const row of legend.rows) {
      for (const cell of row.cells) {
        ctx.font = cell.font;
        ctx.strokeText(cell.text, cell.x, row.y);
        ctx.fillStyle = cell.color;
        ctx.fillText(cell.text, cell.x, row.y);
      }
    }
    ctx.restore();
  }
}

/** One study's value, pushed off the legend row and shown at the plot's right edge instead. */
interface ValueTag {
  name: string;
  text: string;
  fill: string;
  ink: string;
  width: number;
  y: number;
  box: Rect;
}

function paintValueTag(ctx: CanvasRenderingContext2D, tag: ValueTag): void {
  const box = tag.box;
  ctx.fillStyle = tag.fill;
  ctx.fillRect(Math.round(box.left), Math.round(box.top), Math.max(1, Math.round(box.right - box.left)), Math.max(1, Math.round(box.bottom - box.top)));
  const x = Math.round(box.left) + 5;
  const width = drawText(ctx, tag.name, x, tag.y, { color: tag.ink, font: LABEL_FONT });
  drawText(ctx, tag.text, x + width + 6, tag.y, { color: tag.ink, font: VALUE_FONT });
}

/** A colour's channels, with the alpha an `rgba()` form carries. */
interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** The pane background a translucent study colour is flattened onto, read at draw time. */
function paneRgb(): Rgba {
  return readColor(THEME.bg) ?? { r: 15, g: 19, b: 23, a: 1 };
}

/**
 * Reads any colour the indicator registry accepts: `#rgb`, `#rrggbb`, the CSS names its
 * defaults use, or the translucent `rgba()` form its band lines carry.
 */
function readColor(color: string): Rgba | null {
  const rgb = /^rgba?\(([^)]+)\)$/.exec(color.trim());
  if (rgb) {
    const parts = rgb[1]!.split(/[\s,/]+/).map((part) => Number.parseFloat(part));
    if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
    const alpha = parts.length > 3 && Number.isFinite(parts[3]!) ? Math.max(0, Math.min(1, parts[3]!)) : 1;
    return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: alpha };
  }
  const hex = Number.parseInt(toHex(color).slice(1), 16);
  if (!Number.isFinite(hex)) return null;
  return { r: (hex >> 16) & 255, g: (hex >> 8) & 255, b: hex & 255, a: 1 };
}

/**
 * A study's colour as an opaque plate, flattened onto the pane background, with the ink that
 * stays readable on it: dark on a bright plate, light on a dark one. Band lines reach the
 * legend translucent and a user may pick any colour, so neither the plate nor the ink can be
 * taken on faith.
 */
function plateColors(color: string): { fill: string; ink: string } {
  const study = readColor(color) ?? { r: 75, g: 156, b: 245, a: 1 };
  const pane = paneRgb();
  const blend = (channel: number, back: number) => Math.round(study.a * channel + (1 - study.a) * back);
  const r = blend(study.r, pane.r);
  const g = blend(study.g, pane.g);
  const b = blend(study.b, pane.b);
  return { fill: `rgb(${r},${g},${b})`, ink: 0.2126 * r + 0.7152 * g + 0.0722 * b > 140 ? TAG_INK_DARK : TAG_INK_LIGHT };
}

/**
 * Cells of one row that fit, dropped from the right, plus how far they reach. Nothing
 * shrinks and nothing wraps: a segment with no room, and everything after it, is left out.
 */
function fitCells(cells: MeasuredCell[], start: number, limit: number): { cells: LegendCell[]; right: number } {
  const kept: LegendCell[] = [];
  let x = start;
  for (const cell of cells) {
    if (x + cell.width > limit && kept.length > 0) break;
    kept.push({ text: cell.text, color: cell.color, font: cell.font, x, width: cell.width });
    x += cell.width + SEGMENT_GAP;
  }
  const last = kept[kept.length - 1];
  return { cells: kept, right: last ? last.x + last.width : start };
}

/**
 * Lays the value row out cluster by cluster. A cluster is one indicator's whole set of
 * values: it either fits intact or moves to the right edge intact, so a study is never shown
 * as half its lines.
 */
function placeGroups(
  ctx: CanvasRenderingContext2D,
  groups: LegendGroup[],
  start: number,
  limit: number,
): { cells: LegendCell[]; right: number; dropped: LegendGroup[] } {
  const kept: LegendCell[] = [];
  const dropped: LegendGroup[] = [];
  let x = start;
  for (const group of groups) {
    const cells = measureCells(ctx, group.segments);
    const width = cells.reduce((sum, cell, index) => sum + cell.width + (index > 0 ? SEGMENT_GAP : 0), 0);
    if (x + width > limit) {
      dropped.push(group);
      continue;
    }
    let cursor = x;
    for (const cell of cells) {
      kept.push({ text: cell.text, color: cell.color, font: cell.font, x: cursor, width: cell.width });
      cursor += cell.width + SEGMENT_GAP;
    }
    x = cursor - SEGMENT_GAP + GROUP_GAP;
  }
  const last = kept[kept.length - 1];
  return { cells: kept, right: last ? last.x + last.width : start, dropped };
}

/** Text of each segment with the width it will occupy, so layout and paint agree. */
function measureCells(ctx: CanvasRenderingContext2D, segments: Segment[]): MeasuredCell[] {
  return segments.map((segment) => {
    const font = segment.font ?? VALUE_FONT;
    return { text: segment.text, color: segment.color, font, width: measureText(ctx, segment.text, font) };
  });
}

/** One run of text in a legend row, placed so the scrim and the paint agree. */
interface LegendCell {
  text: string;
  color: string;
  font: string;
  x: number;
  width: number;
}

/** A legend segment measured before it is placed. */
interface MeasuredCell {
  text: string;
  color: string;
  font: string;
  width: number;
}

interface LegendRow {
  y: number;
  cells: LegendCell[];
}

/**
 * One indicator's values as the legend row carries them, plus what a right-edge label needs
 * in case the cluster has to move there.
 */
interface LegendGroup {
  segments: Segment[];
  values: OverflowValue[];
}

/** One plotted line's value at the bar the legend is reading. */
interface OverflowValue {
  name: string;
  value: number;
  color: string;
}

/** The laid-out legend, which is also a box other canvas text has to stay out of. */
interface LegendBlock extends Rect {
  rows: LegendRow[];
  /** Values the row could not hold; each one gets a label at the plot's right edge. */
  overflow: OverflowValue[];
}

/** Where the live-price rule sits: inside the plot even when the price runs off its edge. */
function liveMarkY(price: PriceScale, plotBottom: number, bar: Bar): number {
  return Math.max(8, Math.min(plotBottom - 4, price.toY(bar.close)));
}

/**
 * Decimals a computed value should show. A venue can store eight decimals while
 * quoting two, which makes an average like `59,327.56846154` unreadable, so derived
 * values follow the tick, capped by the instrument's precision.
 */
function tickPrecision(instrument: Instrument | null): number {
  const precision = instrument?.pricePrecision ?? 2;
  return Math.min(precision, Math.max(0, decimalsForStep(instrument?.priceTick ?? 0.01)));
}

interface Segment {
  text: string;
  color: string;
  font?: string;
}

/**
 * One cluster per indicator instance: its name and parameters, then the value of every
 * plotted line at the bar being read. A line keeps its own colour, which is how the reader
 * matches a number to a line on the tape.
 */
function overlayGroups(layers: readonly OverlayLayer[], index: number, precision: number): LegendGroup[] {
  return layers.map((layer) => {
    const caption = `${layer.name} ${shortCaption(layer.caption)}`.trim();
    const segments: Segment[] = [{ text: `${caption}${layer.note ? ` · ${layer.note}` : ''}`, color: THEME.muted, font: LABEL_FONT }];
    const values: OverflowValue[] = [];
    if (index >= 0) {
      const labelled = layer.plots.length > 1;
      for (const plot of layer.plots) {
        const value = plot.values[index];
        if (value === undefined || !Number.isFinite(value)) continue;
        if (labelled) segments.push({ text: plot.label, color: THEME.muted, font: LABEL_FONT });
        segments.push({ text: fmtPrice(value, precision), color: plot.color });
        values.push({
          name: `${layer.name}${labelled ? ` ${plot.label}` : ''}`,
          value,
          color: plot.color,
        });
      }
    }
    return { segments, values };
  });
}

/**
 * The legend's short form of a parameter summary: `(26, close)` becomes `26`, `(day, hlc3)`
 * becomes `day`. The input a study reads is one word per line of legend and the indicator
 * dialog carries it; dropping it is what lets four studies' values sit side by side.
 */
function shortCaption(caption: string): string {
  return caption
    .replace(/[()]/g, '')
    .split(', ')
    .filter((part) => part !== '' && !INPUT_FIELDS.has(part))
    .join(' ');
}

function hoverIndex(frame: Frame, bars: readonly Bar[]): number {
  if (frame.hover.index >= 0) return frame.hover.index;
  return bars.length - 1;
}

const TITLE_FONT = '600 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
const LABEL_FONT = '11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
const VALUE_FONT = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
