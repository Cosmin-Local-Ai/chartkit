/**
 * Placed drawings: what the user put on the chart, the style each one carries, and
 * the stored anchors. Instances are unlimited; nothing here counts or caps them.
 * Anchors are venue time plus price, so a drawing keeps its place across pan, zoom,
 * a scale-mode change and a reload.
 */

import { fmtPrice } from '../format';
import type { Pt } from './anchors';
import { anchorToPixel, type AnchorContext, type DrawingAnchor } from './anchors';
import { cloneValue, defaultsForKeys, normaliseStyle, type StyleValues } from './style';
import { toolById, type DrawingToolDefinition, type Prim, type ToolEnv } from './registry';

export interface DrawingInstance {
  /** Stable inside one workspace document; keys selection and the dialogs. */
  id: string;
  toolId: string;
  anchors: DrawingAnchor[];
  style: StyleValues;
  /** Locked drawings stay put: a left press passes through to the tape behind them. */
  locked?: boolean;
}

export class DrawingEngine {
  instances: DrawingInstance[] = [];
  selectedId: string | null = null;
  hoveredId: string | null = null;

  /** Replaces the placed list from a stored document, dropping unknown tools. */
  setInstances(raw: unknown): void {
    this.instances = normaliseDrawings(raw);
    this.selectedId = null;
    this.hoveredId = null;
  }

  add(toolId: string, anchors: DrawingAnchor[]): DrawingInstance | null {
    const definition = toolById(toolId);
    if (!definition || anchors.length !== definition.anchorCount) return null;
    const instance: DrawingInstance = {
      id: nextId(),
      toolId,
      anchors,
      style: defaultsForKeys(definition.styleKeys, definition.styleDefaults),
    };
    this.instances = this.instances.concat(instance);
    return instance;
  }

  remove(id: string): void {
    this.instances = this.instances.filter((instance) => instance.id !== id);
    if (this.selectedId === id) this.selectedId = null;
    if (this.hoveredId === id) this.hoveredId = null;
  }

  find(id: string | null): DrawingInstance | null {
    if (!id) return null;
    return this.instances.find((instance) => instance.id === id) ?? null;
  }

  definitionOf(instance: DrawingInstance | null): DrawingToolDefinition | null {
    return instance ? toolById(instance.toolId) : null;
  }

  /** Merge a style patch; the renderer picks it up on the next frame. */
  setStyle(id: string, patch: StyleValues): void {
    const instance = this.find(id);
    const definition = this.definitionOf(instance);
    if (!instance || !definition) return;
    instance.style = normaliseStyle(definition.styleKeys, definition.styleDefaults, { ...instance.style, ...patch });
  }

  /**
   * Paint order is array order and the hit test walks it backwards, so moving an entry
   * to either end is all z-order needs: the last instance paints over the rest.
   */
  reorder(id: string, where: 'front' | 'back'): boolean {
    const index = this.instances.findIndex((instance) => instance.id === id);
    const instance = this.instances[index];
    if (index < 0 || !instance) return false;
    const rest = this.instances.filter((_, position) => position !== index);
    this.instances = where === 'front' ? [...rest, instance] : [instance, ...rest];
    return true;
  }

  /** Copy of a drawing, same style and z-neighbourhood, shifted by the given offset. */
  duplicate(id: string, offset: { time: number; price: number }): DrawingInstance | null {
    const index = this.instances.findIndex((instance) => instance.id === id);
    const source = this.instances[index];
    if (index < 0 || !source) return null;
    const copy: DrawingInstance = {
      id: nextId(),
      toolId: source.toolId,
      anchors: source.anchors.map((anchor) => ({ time: anchor.time + offset.time, price: anchor.price + offset.price })),
      style: Object.fromEntries(Object.entries(source.style).map(([key, value]) => [key, cloneValue(value)])),
      locked: source.locked === true,
    };
    this.instances = [...this.instances.slice(0, index + 1), copy, ...this.instances.slice(index + 1)];
    this.selectedId = copy.id;
    return copy;
  }

  setLocked(id: string, locked: boolean): void {
    const instance = this.find(id);
    if (instance) instance.locked = locked;
  }

  setAnchor(id: string, index: number, anchor: DrawingAnchor): void {
    const instance = this.find(id);
    if (!instance || index < 0 || index >= instance.anchors.length) return;
    instance.anchors[index] = anchor;
  }

  /** Move every anchor by the same time and price delta. */
  translate(id: string, delta: { time: number; price: number }): void {
    const instance = this.find(id);
    if (!instance) return;
    instance.anchors = instance.anchors.map((anchor) => ({
      time: anchor.time + delta.time,
      price: anchor.price + delta.price,
    }));
  }

  pixelsFor(instance: DrawingInstance, ctx: AnchorContext): Pt[] {
    return instance.anchors.map((anchor) => anchorToPixel(anchor, ctx));
  }

  primitivesFor(instance: DrawingInstance, env: ToolEnv): Prim[] {
    const definition = this.definitionOf(instance);
    if (!definition) return [];
    return definition.primitives(this.pixelsFor(instance, env), instance.style, env);
  }

  /** One line describing a placed drawing for the manager list. */
  summary(instance: DrawingInstance, precision: number, formatTime: (ms: number) => string): string {
    const first = instance.anchors[0];
    if (!first) return 'no anchors';
    const parts = instance.anchors.map((anchor) => `${formatTime(anchor.time)} ${fmtPrice(anchor.price, precision)}`);
    return parts.join(' → ');
  }
}

/** Ids only have to be unique inside one workspace document. */
let instanceCounter = 0;

function nextId(): string {
  instanceCounter += 1;
  const random = globalThis.crypto?.randomUUID?.();
  return random ? `d${random.slice(0, 8)}` : `d${Date.now().toString(36)}${instanceCounter.toString(36)}`;
}

/** Read a stored drawing list: unknown tools and malformed anchors drop, styles repair. */
export function normaliseDrawings(raw: unknown): DrawingInstance[] {
  const out: DrawingInstance[] = [];
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const value = entry as { id?: unknown; toolId?: unknown; anchors?: unknown; style?: unknown; locked?: unknown };
    const definition = typeof value.toolId === 'string' ? toolById(value.toolId) : null;
    if (!definition) continue;
    const anchors = normaliseAnchors(value.anchors, definition.anchorCount);
    if (!anchors) continue;
    if (typeof value.id === 'string' && value.id && out.some((instance) => instance.id === value.id)) continue;
    out.push({
      id: typeof value.id === 'string' && value.id ? value.id : nextId(),
      toolId: definition.id,
      anchors,
      style: normaliseStyle(definition.styleKeys, definition.styleDefaults, value.style),
      locked: value.locked === true,
    });
  }
  return out;
}

/** Anchors must be a complete set of finite time/price pairs, or the entry is useless. */
function normaliseAnchors(raw: unknown, expected: number): DrawingAnchor[] | null {
  if (!Array.isArray(raw) || raw.length !== expected) return null;
  const out: DrawingAnchor[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const value = entry as { time?: unknown; price?: unknown };
    if (typeof value.time !== 'number' || !Number.isFinite(value.time)) return null;
    if (typeof value.price !== 'number' || !Number.isFinite(value.price)) return null;
    out.push({ time: value.time, price: value.price });
  }
  return out;
}

/* ------------------------------------------------------------------ hit testing */

export const HIT_TOLERANCE = 5;
/** Pointer must land this close to an anchor before it grabs the anchor itself. */
export const HANDLE_TOLERANCE = 7;

export function nearestAnchor(pixels: Pt[], at: Pt): number {
  let best = -1;
  let bestDistance = HANDLE_TOLERANCE;
  pixels.forEach((pixel, index) => {
    const distance = Math.hypot(pixel.x - at.x, pixel.y - at.y);
    if (distance <= bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/**
 * Generic hit test over a tool's primitives: rules by distance, filled regions by
 * the polygon they enclose, text by the box its glyphs occupy.
 */
export function hitTest(prims: Prim[], at: Pt, measure: (text: string, font: string) => number): boolean {
  for (const prim of prims) {
    if (prim.kind === 'segment' && distanceToSegment(at, prim.a, prim.b) <= HIT_TOLERANCE + prim.width / 2) return true;
    if (prim.kind === 'fill' && pointInPolygon(at, prim.pts)) return true;
    if (prim.kind === 'label') {
      const box = labelBounds(prim.at, prim.text, prim.options, measure);
      if (box && at.x >= box.left && at.x <= box.right && at.y >= box.top && at.y <= box.bottom) return true;
    }
  }
  return false;
}

export interface LabelBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Box a text primitive occupies, so the hit test and its background plate agree. */
export function labelBounds(
  at: Pt,
  text: string,
  options: { font: string; align: string; baseline: string; pad?: number; padX?: number; padY?: number },
  measure: (text: string, font: string) => number,
): LabelBounds | null {
  const width = measure(text, options.font);
  const size = fontSizeFrom(options.font);
  const padX = options.padX ?? options.pad ?? 0;
  const padY = options.padY ?? options.pad ?? 0;
  const left = options.align === 'left' ? at.x - padX : options.align === 'right' ? at.x - width - padX : at.x - width / 2 - padX;
  const top =
    options.baseline === 'top' ? at.y - padY : options.baseline === 'bottom' ? at.y - size - padY : at.y - size / 2 - padY;
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  return { left, right: left + width + padX * 2, top, bottom: top + size + padY * 2 };
}

export function fontSizeFrom(font: string): number {
  const match = /(\d+(?:\.\d+)?)px/.exec(font);
  const size = match ? Number(match[1]) : 11;
  return Number.isFinite(size) ? size : 11;
}

function distanceToSegment(at: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  if (length === 0) return Math.hypot(at.x - a.x, at.y - a.y);
  const t = Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / length));
  return Math.hypot(at.x - (a.x + t * dx), at.y - (a.y + t * dy));
}

function pointInPolygon(at: Pt, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (!a || !b) continue;
    if (a.y > at.y !== b.y > at.y && at.x < ((b.x - a.x) * (at.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
