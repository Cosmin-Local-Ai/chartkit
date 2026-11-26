import type { Frame } from '../layout';
import { PRICE_AXIS_WIDTH, TIME_AXIS_HEIGHT } from '../layout';
import type { AxisTick, PriceScale, TimeTick, XScale } from '../scale';
import type { GapMark } from '../session';
import type { LocalTime } from '../format';
import { THEME, dashedH, dashedV, drawTag, drawText, hLine, measureText, vLine, withAlpha } from '../canvasKit';

/** Vertical gridlines at time ticks, shared by every pane so columns line up. */
export function drawTimeColumns(
  ctx: CanvasRenderingContext2D,
  top: number,
  bottom: number,
  ticks: TimeTick[],
  x: XScale,
  left: number,
  right: number,
): void {
  for (const tick of ticks) {
    const px = x.toX(tick.index);
    if (px < left || px > right) continue;
    vLine(ctx, px, top, bottom, tick.major ? THEME.gridMajor : THEME.grid);
  }
}

/** Right-hand price gutter: tick labels, gridline rows included by the caller. */
export function drawPriceAxis(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  price: PriceScale,
  ticks: AxisTick[],
  color = THEME.muted,
): void {
  const { width, height } = frame;
  const axisLeft = width - PRICE_AXIS_WIDTH;
  const bottom = height - (frame.axisBottom ? TIME_AXIS_HEIGHT : 0);
  vLine(ctx, axisLeft, 0, height, THEME.axisLine);
  for (const tick of ticks) {
    const y = price.toY(tick.value);
    if (y < 9 || y > bottom - 4) continue;
    drawText(ctx, tick.label, axisLeft + 6, y, { color: tick.major ? THEME.text : color });
  }
}

/** Bottom time axis, drawn once by the lowest visible pane. */
export function drawTimeAxis(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  ticks: TimeTick[],
  x: XScale,
): void {
  const { width, height } = frame;
  const y = height - TIME_AXIS_HEIGHT;
  // The strip is the pane background with a little weight taken out, so a light pane keeps a
  // legible axis instead of inheriting the dark one this chart shipped with.
  ctx.fillStyle = withAlpha(THEME.bg, 0.75);
  ctx.fillRect(0, Math.round(y) + 1, width, TIME_AXIS_HEIGHT - 1);
  hLine(ctx, 0, width, y, THEME.axisLine);
  let lastRight = Number.NEGATIVE_INFINITY;
  for (const tick of ticks) {
    const px = x.toX(tick.index);
    const labelWidth = measureText(ctx, tick.label);
    if (px - labelWidth / 2 < 4 || px + labelWidth / 2 > width - PRICE_AXIS_WIDTH - 2) continue;
    if (px - labelWidth / 2 < lastRight + 10) continue;
    drawText(ctx, tick.label, px, y + TIME_AXIS_HEIGHT / 2, {
      align: 'center',
      color: tick.major ? THEME.text : THEME.muted,
    });
    lastRight = px + labelWidth / 2;
  }
}

export interface CrosshairOptions {
  /** Whether the cursor is inside this pane: only then is the horizontal rule drawn. */
  hoveredHere: boolean;
  /** Value shown in the right gutter at the cursor row. */
  gutterLabel?: string;
  /** Timestamp shown on the time axis at the hovered bar. */
  timeLabel?: string;
}

/**
 * Crosshair: a vertical rule snapped to the hovered bar in every pane, a
 * horizontal rule only in the pane holding the cursor, plus axis bubbles.
 */
export function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  options: CrosshairOptions,
): void {
  const { hover, width, height } = frame;
  if (!hover.inside || hover.index < 0) return;
  const plotBottom = height - (frame.axisBottom ? TIME_AXIS_HEIGHT : 0);
  const px = frame.x.toX(hover.index);
  if (px >= frame.left - 1 && px <= frame.right + 1) {
    dashedV(ctx, px, 0, plotBottom, THEME.crosshair);
  }
  if (!options.hoveredHere) return;
  const y = Math.max(1, Math.min(plotBottom - 1, hover.y));
  dashedH(ctx, frame.left, width - PRICE_AXIS_WIDTH, y, THEME.crosshair);
  if (options.gutterLabel) {
    drawTag(ctx, options.gutterLabel, width - 2, y, { align: 'right', width: PRICE_AXIS_WIDTH - 2 });
  }
  if (options.timeLabel && frame.axisBottom) {
    drawTag(ctx, options.timeLabel, px, height - TIME_AXIS_HEIGHT / 2, { align: 'center' });
  }
}

/**
 * Stored-history holes and venue closures collapse in an index-based mapping, so a
 * dashed rule plus the resumption time keeps the break visible instead of drawing a
 * continuous tape over it.
 */
export function drawGapMarks(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  gaps: GapMark[],
  local: LocalTime,
): void {
  const { x, left, right, height } = frame;
  const bottom = height - (frame.axisBottom ? TIME_AXIS_HEIGHT : 0);
  for (const gap of gaps) {
    const px = x.toX(gap.index) - x.barStep / 2;
    if (px < left || px > right) continue;
    dashedV(ctx, px, 0, bottom, THEME.gap);
    if (x.barStep < 3) continue;
    const label = gap.span >= 2 * 86_400_000 ? local.format(gap.to, 'day') : local.format(gap.to, 'clock');
    drawText(ctx, label, px + 4, 12, { color: THEME.muted, font: '10px ui-monospace, monospace' });
  }
}

/**
 * Off-session shading, for venues that publish session windows. The segments are worked out
 * on the axis clock, so the shading moves with the timezone setting. `show` is the
 * chart-data switch.
 */
export function drawSessionBands(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  segments: { index: number; start: number; open: boolean }[],
  show = true,
): void {
  if (!show || segments.length === 0) return;
  const { x, left, right, height } = frame;
  const bottom = height - (frame.axisBottom ? TIME_AXIS_HEIGHT : 0);
  ctx.fillStyle = THEME.offSession;
  for (const segment of segments) {
    if (segment.open) continue;
    const startPx = Math.max(left, x.toX(segment.index) - x.barStep / 2);
    const endPx = Math.min(right, x.toX(segment.index + 1) + x.barStep / 2);
    if (endPx < left || startPx > right) continue;
    ctx.fillRect(Math.round(startPx), 0, Math.max(1, Math.round(endPx - startPx)), bottom);
  }
}

/**
 * The rule at each session boundary, drawn over the tape rather than under it so it stays
 * readable on a busy chart. Same segments as the shading, so the divider follows the axis
 * timezone.
 */
export function drawSessionDividers(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  segments: { index: number; start: number; open: boolean }[],
  show = true,
): void {
  if (!show || segments.length === 0) return;
  const { x, left, right, height } = frame;
  const bottom = height - (frame.axisBottom ? TIME_AXIS_HEIGHT : 0);
  for (const segment of segments) {
    const px = x.toX(segment.index) - x.barStep / 2;
    if (px < left || px > right) continue;
    vLine(ctx, px, 0, bottom, THEME.axisLine);
  }
}
