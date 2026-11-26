/**
 * Drawing layer: paints placed drawings over the price tape. Primitives are clipped
 * to the plot so nothing paints over the axes, while price and time bubbles are
 * drawn after the clip so a level keeps its gutter label. The selected drawing gets
 * anchor handles; an in-progress one draws as a ghost through the same geometry.
 */

import { FONT_MONO, THEME, drawTag, drawText, measureText } from '../canvasKit';
import { PRICE_AXIS_WIDTH } from '../layout';
import type { Rect } from '../layout';
import { labelBounds, type DrawingEngine, type DrawingInstance } from '../drawings/engine';
import { toolById, type LabelPrim, type PlotRect, type Prim, type ToolEnv } from '../drawings/registry';
import { defaultsForKeys, type StyleValues } from '../drawings/style';
import type { Pt } from '../drawings/anchors';

export interface PendingDrawing {
  toolId: string;
  /** Anchors already placed, in pane pixels. */
  pixels: Pt[];
  /** Snapped cursor, so the ghost follows the pointer before the next click. */
  cursor: Pt | null;
}

export class DrawingLayer {
  /**
   * `reserved` is the area the price pane has already claimed for its own text — the legend
   * plate and the live-price bubble. Annotations never print into it, and after that each
   * label claims its own box, top of the stack first, so two drawings that land on the same
   * spot leave one readable label rather than a smear.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    engine: DrawingEngine,
    env: ToolEnv,
    pending: PendingDrawing | null,
    reserved: readonly Rect[] = [],
  ): void {
    const ordered = [...engine.instances].sort((a, b) => emphasis(engine, a) - emphasis(engine, b));
    const prims = new Map<string, Prim[]>();
    for (const instance of ordered) prims.set(instance.id, engine.primitivesFor(instance, env));

    const claimed: Rect[] = [...reserved];
    const labels: { prim: LabelPrim; glow: boolean }[] = [];
    ctx.save();
    ctx.beginPath();
    ctx.rect(env.plot.left, env.plot.top, Math.max(1, env.plot.right - env.plot.left), Math.max(1, env.plot.bottom - env.plot.top));
    ctx.clip();
    for (const instance of ordered) {
      const glow = engine.selectedId === instance.id || engine.hoveredId === instance.id;
      for (const prim of prims.get(instance.id) ?? []) {
        if (prim.kind === 'label') {
          labels.push({ prim, glow });
          continue;
        }
        this.paint(ctx, prim, env, glow);
      }
    }
    if (pending) this.paintPending(ctx, pending, env);
    // Labels go last so a fill or a neighbouring leg cannot bury them.
    for (const entry of survivingLabels(labels, claimed, ctx)) this.paint(ctx, entry.prim, env, entry.glow);
    ctx.restore();

    for (const instance of ordered) {
      for (const prim of prims.get(instance.id) ?? []) {
        if (prim.kind !== 'priceTag' && prim.kind !== 'timeTag') continue;
        const box = tagBounds(prim, env, ctx);
        if (box && !fits(claimed, box)) continue;
        if (box) claimed.push(box);
        this.paint(ctx, prim, env, false);
      }
    }
    for (const instance of ordered) {
      if (engine.selectedId !== instance.id && engine.hoveredId !== instance.id) continue;
      this.paintHandles(ctx, engine.pixelsFor(instance, env), engine.selectedId === instance.id);
    }
    if (pending) this.paintHandles(ctx, pending.pixels, true);
  }

  /** Ghost of a drawing still being placed: same geometry, half the presence. */
  private paintPending(ctx: CanvasRenderingContext2D, pending: PendingDrawing, env: ToolEnv): void {
    const definition = toolById(pending.toolId);
    if (!definition) return;
    const pixels = [...pending.pixels];
    if (pending.cursor && pixels.length < definition.anchorCount) pixels.push(pending.cursor);
    if (pixels.length === 0) return;
    const style: StyleValues = defaultsForKeys(definition.styleKeys, definition.styleDefaults);
    ctx.save();
    ctx.globalAlpha = 0.6;
    for (const prim of definition.primitives(pixels, style, env)) {
      if (prim.kind === 'priceTag' || prim.kind === 'timeTag') continue;
      this.paint(ctx, prim, env, false);
    }
    ctx.restore();
  }

  private paintHandles(ctx: CanvasRenderingContext2D, pixels: Pt[], selected: boolean): void {
    for (const pixel of pixels) {
      const size = selected ? 7 : 5;
      ctx.fillStyle = selected ? THEME.accent : THEME.bg;
      ctx.strokeStyle = selected ? THEME.bg : THEME.accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.rect(Math.round(pixel.x - size / 2) + 0.5, Math.round(pixel.y - size / 2) + 0.5, size, size);
      ctx.fill();
      ctx.stroke();
    }
  }

  private paint(ctx: CanvasRenderingContext2D, prim: Prim, env: ToolEnv, glow: boolean): void {
    if (prim.kind === 'segment') {
      if (glow) strokeSegment(ctx, prim.a, prim.b, 'rgba(75,156,245,0.35)', prim.width + 4, []);
      strokeSegment(ctx, prim.a, prim.b, prim.color, prim.width, prim.dash);
      return;
    }
    if (prim.kind === 'fill') {
      ctx.beginPath();
      prim.pts.forEach((point, index) => (index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)));
      ctx.closePath();
      ctx.fillStyle = prim.color;
      ctx.fill();
      return;
    }
    if (prim.kind === 'label') {
      const { at, text, options } = prim;
      const box = labelBounds(at, text, options, (value, font) => measureText(ctx, value, font));
      if (options.background && box) {
        ctx.save();
        if (options.rotation) rotate(ctx, at, options.rotation);
        ctx.fillStyle = options.background;
        ctx.fillRect(Math.round(box.left), Math.round(box.top), Math.round(box.right - box.left), Math.round(box.bottom - box.top));
        if (options.border) {
          ctx.strokeStyle = options.border;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(Math.round(box.left) + 0.5, Math.round(box.top) + 0.5, Math.round(box.right - box.left), Math.round(box.bottom - box.top));
        }
        if (options.fold) {
          // Folded corner: the shipped note style cuts the bottom-right corner back.
          const fold = Math.min(12, (box.right - box.left) / 3, (box.bottom - box.top) / 2);
          ctx.fillStyle = THEME.bg;
          ctx.beginPath();
          ctx.moveTo(box.right, box.bottom - fold);
          ctx.lineTo(box.right - fold, box.bottom);
          ctx.lineTo(box.right, box.bottom);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      }
      ctx.save();
      if (options.rotation) rotate(ctx, at, options.rotation);
      drawText(ctx, text, at.x, at.y, {
        font: options.font,
        color: options.color,
        align: options.align,
        baseline: options.baseline,
      });
      ctx.restore();
      return;
    }
    if (prim.kind === 'priceTag') {
      drawTag(ctx, prim.text, env.plot.right + PRICE_AXIS_WIDTH - 3, prim.at.y, {
        align: 'right',
        width: PRICE_AXIS_WIDTH - 3,
        color: '#0f1317',
        background: prim.color ?? THEME.accent,
      });
      return;
    }
    drawTag(ctx, prim.text, prim.at.x, env.plot.bottom + 10, { align: 'center' });
  }
}

/**
 * Which labels can still be read: claim boxes from the top of the stack down, so a selected
 * or hovered drawing keeps its text and the one underneath it yields the space.
 */
function survivingLabels(
  labels: { prim: LabelPrim; glow: boolean }[],
  claimed: Rect[],
  ctx: CanvasRenderingContext2D,
): { prim: LabelPrim; glow: boolean }[] {
  const kept: { prim: LabelPrim; glow: boolean }[] = [];
  for (let i = labels.length - 1; i >= 0; i -= 1) {
    const entry = labels[i];
    if (!entry) continue;
    const box = labelBounds(entry.prim.at, entry.prim.text, entry.prim.options, (value, font) =>
      measureText(ctx, value, font),
    );
    if (box && !fits(claimed, box)) continue;
    if (box) claimed.push(box);
    kept.push(entry);
  }
  kept.reverse();
  return kept;
}

/** True when nothing has claimed this box yet. */
function fits(claimed: readonly Rect[], box: Rect): boolean {
  return !claimed.some(
    (other) => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top,
  );
}

/** Box a gutter tag covers, so two levels at nearly the same price stop sharing one slot. */
function tagBounds(prim: Prim, env: ToolEnv, ctx: CanvasRenderingContext2D): Rect | null {
  if (prim.kind === 'priceTag') {
    const width = PRICE_AXIS_WIDTH - 3;
    const right = env.plot.right + PRICE_AXIS_WIDTH - 3;
    return { left: right - width, top: prim.at.y - 8, right, bottom: prim.at.y + 8 };
  }
  if (prim.kind === 'timeTag') {
    const width = measureText(ctx, prim.text, FONT_MONO) + 10;
    return {
      left: prim.at.x - width / 2,
      top: env.plot.bottom + 2,
      right: prim.at.x + width / 2,
      bottom: env.plot.bottom + 18,
    };
  }
  return null;
}

function emphasis(engine: DrawingEngine, instance: DrawingInstance): number {
  if (engine.selectedId === instance.id) return 2;
  if (engine.hoveredId === instance.id) return 1;
  return 0;
}

function rotate(ctx: CanvasRenderingContext2D, at: Pt, degrees: number): void {
  ctx.translate(at.x, at.y);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.translate(-at.x, -at.y);
}

function strokeSegment(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, color: string, width: number, dash: number[]): void {
  ctx.save();
  ctx.setLineDash(dash);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, width);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();
}

/** Plot rect of the price pane: the area drawings live in, axes excluded. */
export function pricePlot(width: number, height: number, axisBottom: boolean, timeAxisHeight: number): PlotRect {
  return {
    left: 0,
    right: Math.max(1, width - PRICE_AXIS_WIDTH),
    top: 0,
    bottom: Math.max(1, height - (axisBottom ? timeAxisHeight : 0)),
  };
}
