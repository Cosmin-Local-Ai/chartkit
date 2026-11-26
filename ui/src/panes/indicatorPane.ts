import type { Frame } from '../layout';
import { PRICE_AXIS_WIDTH, TIME_AXIS_HEIGHT } from '../layout';
import { PriceScale } from '../scale';
import { THEME, dashedH, drawText, hLine, measureText } from '../canvasKit';
import { decimalsForStep, fmtNumber, fmtPrice } from '../format';
import { drawCrosshair, drawPriceAxis, drawTimeAxis, drawTimeColumns } from './axes';
import { drawHistogram, drawPolyline } from './plotLine';
import type { IndicatorDefinition, IndicatorResult } from '../indicators/registry';

const LABEL_FONT = '11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
/** Rows of eased auto-fit: the pane's scale chases the visible bars without jittering. */
const EASE = 0.3;
const SNAP_TOLERANCE = 0.004;

/**
 * One offchart indicator pane. Every instance gets its own pane of this kind: the
 * series, its own vertical scale, its guide levels and its gutter are all derived
 * from the instance's computed result, so several indicators stack side by side.
 */
export class IndicatorPane {
  private shownMin = 0;
  private shownMax = 1;
  private snap = true;
  private lastWanted: { min: number; max: number } | null = null;

  constructor(
    readonly instanceId: string,
    private definition: IndicatorDefinition,
  ) {}

  /**
   * Swaps in a definition read from an edited script: the pane title, its guide levels
   * and its fixed range follow the text, but the pane keeps its place in the stack and
   * its eased scale, so editing a script does not move the chart around.
   */
  refreshDefinition(definition: IndicatorDefinition): void {
    this.definition = definition;
  }

  get currentDefinition(): IndicatorDefinition {
    return this.definition;
  }

  draw(ctx: CanvasRenderingContext2D, frame: Frame, result: IndicatorResult | undefined): void {
    const { width, height, x, bars } = frame;
    const plotBottom = height - (frame.axisBottom ? TIME_AXIS_HEIGHT : 0);
    const right = width - PRICE_AXIS_WIDTH;
    const top = 14;
    const timeTicks = x.timeTicks();

    drawTimeColumns(ctx, 0, plotBottom, timeTicks, x, frame.left, right);

    const { first, last } = x.visibleRange();
    const range = this.scaleRange(result, first, last, top, plotBottom);
    const precision = this.precisionFor(frame);
    const scale = new PriceScale({
      mode: 'linear',
      min: range.min,
      max: range.max,
      top,
      bottom: Math.max(top + 1, plotBottom),
      precision,
    });

    for (const tick of scale.ticks()) {
      const y = scale.toY(tick.value);
      if (y < top || y > plotBottom) continue;
      hLine(ctx, frame.left, right, y, THEME.grid);
    }
    this.drawGuides(ctx, frame, result, scale, top, plotBottom, right);

    if (result) {
      const body = x.bodyWidth();
      ctx.save();
      ctx.beginPath();
      ctx.rect(frame.left, top, Math.max(1, right - frame.left), Math.max(1, plotBottom - top));
      ctx.clip();
      for (const plot of result.plots) {
        if (plot.kind !== 'histogram') continue;
        drawHistogram(ctx, plot.values, x, scale, first, last, plot.color, body, plot.negativeColor);
      }
      for (const plot of result.plots) {
        if (plot.kind !== 'line') continue;
        drawPolyline(ctx, plot.values, x, scale, first, last, plot.color, plot.width, result.smooth);
      }
      ctx.restore();
    }

    drawPriceAxis(ctx, frame, scale, scale.ticks());
    if (frame.axisBottom) drawTimeAxis(ctx, frame, timeTicks, x);

    this.drawTitle(ctx, frame, result, precision);
    const hovered = frame.hover.index >= 0 ? frame.hover.index : bars.length - 1;
    drawCrosshair(ctx, frame, {
      hoveredHere: frame.hover.paneId === this.paneId,
      gutterLabel:
        frame.hover.inside && frame.hover.paneId === this.paneId
          ? format(scale.fromY(Math.max(top, Math.min(plotBottom, frame.hover.y))), precision, this.isPriceUnits(frame))
          : undefined,
      timeLabel: hovered >= 0 && hovered < bars.length ? frame.local.format(bars[hovered]?.start ?? 0, 'dateTime') : undefined,
    });
  }

  /** Eased range next to the range the visible bars imply, for automated checks. */
  debugScale(): { shown: { min: number; max: number }; wanted: { min: number; max: number } | null } {
    return { shown: { min: this.shownMin, max: this.shownMax }, wanted: this.lastWanted };
  }

  /** Pane id in the stack, also the value the pointer handler reads back. */
  get paneId(): string {
    return `ind:${this.instanceId}`;
  }

  private drawGuides(
    ctx: CanvasRenderingContext2D,
    frame: Frame,
    result: IndicatorResult | undefined,
    scale: PriceScale,
    top: number,
    plotBottom: number,
    right: number,
  ): void {
    if (!result) return;
    const pane = this.definition.pane;
    if (!pane) return;
    if (pane.zeroLine) {
      const y = scale.toY(0);
      if (y > top && y < plotBottom) hLine(ctx, frame.left, right, y, THEME.axisLine);
    }
    for (const level of result.levels ?? pane.levels ?? []) {
      const y = scale.toY(level);
      if (y < top + 2 || y > plotBottom - 2) continue;
      dashedH(ctx, frame.left, right, y, THEME.gridMajor);
      drawText(ctx, format(level, pane.precision ?? 2, false), right + 6, y, { color: THEME.muted });
    }
  }

  /** Name, parameters and the values under the crosshair, in the pane's own title row. */
  private drawTitle(ctx: CanvasRenderingContext2D, frame: Frame, result: IndicatorResult | undefined, precision: number): void {
    let x = frame.left + 6;
    const limit = frame.width - PRICE_AXIS_WIDTH - 8;
    const head = result ? `${this.definition.short} ${result.caption}${result.note ? ` · ${result.note}` : ''}` : this.definition.short;
    x += drawText(ctx, head, x, 9, { color: THEME.muted, font: LABEL_FONT }) + 10;
    const index = frame.hover.index >= 0 ? frame.hover.index : frame.bars.length - 1;
    if (!result || index < 0 || index >= frame.bars.length) return;
    const priceUnits = this.isPriceUnits(frame);
    for (const plot of result.plots) {
      const value = plot.values[index];
      if (value === undefined || !Number.isFinite(value)) continue;
      const label = result.plots.length > 1 ? `${plot.label} ` : '';
      const text = `${label}${format(value, precision, priceUnits)}`;
      if (x + measureText(ctx, text, LABEL_FONT) > limit) break;
      x += drawText(ctx, text, x, 9, { color: plot.color, font: LABEL_FONT }) + 10;
    }
  }

  private isPriceUnits(frame: Frame): boolean {
    return this.definition.pane?.priceUnits === true && (frame.instrument?.pricePrecision ?? 0) > 0;
  }

  /**
   * Label decimals: price-unit indicators quote at the venue's tick rather than its
   * stored precision, so an averaged value never prints eight decimals.
   */
  private precisionFor(frame: Frame): number {
    const pane = this.definition.pane;
    if (!pane?.priceUnits) return pane?.precision ?? 2;
    const instrument = frame.instrument;
    const precision = instrument?.pricePrecision ?? 2;
    return Math.min(precision, Math.max(0, decimalsForStep(instrument?.priceTick ?? 0.01)));
  }

  /**
   * Vertical range: fixed for bounded oscillators, otherwise the visible bars, eased
   * so a moving live value does not move the whole pane every frame.
   */
  private scaleRange(
    result: IndicatorResult | undefined,
    first: number,
    last: number,
    top: number,
    plotBottom: number,
  ): { min: number; max: number } {
    const fixed = result && this.definition.pane?.range ? this.definition.pane.range : null;
    if (fixed) {
      this.lastWanted = fixed;
      this.shownMin = fixed.min;
      this.shownMax = fixed.max;
      this.snap = true;
      return { min: fixed.min, max: fixed.max };
    }
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    if (result) {
      for (const plot of result.plots) {
        for (let i = Math.max(0, first); i <= Math.min(plot.values.length - 1, last); i += 1) {
          const value = plot.values[i];
          if (value === undefined || !Number.isFinite(value)) continue;
          if (value < min) min = value;
          if (value > max) max = value;
        }
      }
    }
    if (this.definition.pane?.zeroLine && Number.isFinite(min) && min > 0) min = 0;
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      const height = Math.max(1, plotBottom - top);
      return { min: 0, max: height };
    }
    if (min === max) {
      const pad = Math.max(Math.abs(min) * 1e-6, 1e-9);
      min -= pad;
      max += pad;
    }
    const pad = Math.max((max - min) * 0.08, Math.max(Math.abs(max), 1) * 1e-9);
    const wanted = { min: min - pad, max: max + pad };
    this.lastWanted = wanted;
    if (this.snap) {
      this.shownMin = wanted.min;
      this.shownMax = wanted.max;
      this.snap = false;
    } else {
      const tolerance = (wanted.max - wanted.min) * SNAP_TOLERANCE;
      this.shownMin += (wanted.min - this.shownMin) * EASE;
      this.shownMax += (wanted.max - this.shownMax) * EASE;
      if (Math.abs(wanted.min - this.shownMin) < tolerance) this.shownMin = wanted.min;
      if (Math.abs(wanted.max - this.shownMax) < tolerance) this.shownMax = wanted.max;
    }
    return { min: this.shownMin, max: this.shownMax };
  }
}

/**
 * Gutter and title label: price-unit indicators keep the instrument's formatting
 * with trailing zeros dropped, oscillator values are plain fixed-decimal numbers.
 */
function format(value: number, precision: number, priceUnits: boolean): string {
  if (!Number.isFinite(value)) return '—';
  return priceUnits ? fmtPrice(value, precision) : fmtNumber(value, precision);
}
