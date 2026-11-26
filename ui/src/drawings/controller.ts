/**
 * One interaction controller for every tool: draw by holding the pointer and dragging
 * the shape out, or by successive clicks, select, move the whole drawing, drag a single
 * anchor, delete. Nothing here knows a tool id — placement uses the definition's anchor
 * count, Shift uses its constraint, moving respects each anchor's freedom, and the
 * result is always stored as time plus price.
 */

import { anchorToPixel, pixelToAnchor, snapPrice, type DrawingAnchor, type Pt } from './anchors';
import { DrawingEngine, hitTest, nearestAnchor, type DrawingInstance } from './engine';
import { toolById, type DrawingToolDefinition, type ToolEnv } from './registry';
import type { PendingDrawing } from '../panes/drawingLayer';

/** How far a duplicate lands from the drawing it copies, in pane pixels. */
const DUPLICATE_OFFSET_PX = 18;

/**
 * How far the pointer has to travel before a press counts as a drag rather than a
 * click. The shipped layer splits the two at 5 pane pixels (`clickSlopPx`,
 * `titan-core @728586`): below it a press neither drags a shape out nor moves a drawing.
 */
const DRAG_SLOP_PX = 5;

interface DragState {
  kind: 'draw' | 'move' | 'anchor';
  instanceId?: string;
  anchorIndex?: number;
  /** Anchors as they were when the drag began; every move replays from this. */
  snapshot?: DrawingAnchor[];
  /** Snapped anchor under the pointer at drag start, the origin of the delta. */
  grab?: DrawingAnchor;
  /** Pixels of the press, so a release can tell a click from a drag. */
  pressPx?: Pt;
  /** The anchor a Shift constraint is measured from: the fixed corner or far endpoint. */
  pivot?: DrawingAnchor;
  constraint?: DrawingToolDefinition['shiftConstraint'];
  /** The anchor the pointer stands for now, so the ghost matches what the release stores. */
  flying?: DrawingAnchor;
}

/** True once the pointer has left the point it pressed at by more than a click's worth. */
function dragMoved(point: Pt, origin: Pt): boolean {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  return dx * dx + dy * dy > DRAG_SLOP_PX * DRAG_SLOP_PX;
}

export class DrawingController {
  toolId: string | null = null;
  /** Anchors already placed for the drawing being placed. */
  pending: DrawingAnchor[] = [];
  /** Set whenever a change has to be written back to the workspace. */
  changed = false;
  private drag: DragState | null = null;
  private cursor: Pt | null = null;

  constructor(private readonly engine: DrawingEngine) {}

  setTool(id: string | null): void {
    this.toolId = id;
    this.pending = [];
    this.drag = null;
  }

  /** True while a pointer gesture belongs to the drawing layer. */
  get engaged(): boolean {
    return this.drag !== null || this.pending.length > 0;
  }

  /** True while a press is sizing a shape, as opposed to holding a placed drawing. */
  get placing(): boolean {
    return this.drag?.kind === 'draw';
  }

  /**
   * Which edit the held gesture is, so a whole drag records one undo step. The key names
   * the thing being changed: every move of the same press shares it, a new press or a
   * different anchor does not.
   */
  gestureTarget(): { key: string; label: string } | null {
    const drag = this.drag;
    if (!drag) return null;
    if (drag.kind === 'draw') return { key: `drw:place:${this.toolId ?? ''}`, label: 'place drawing' };
    const id = drag.instanceId ?? '';
    return drag.kind === 'anchor'
      ? { key: `drw:anchor:${id}:${drag.anchorIndex ?? 0}`, label: 'drag anchor' }
      : { key: `drw:move:${id}`, label: 'move drawing' };
  }

  pendingState(env: ToolEnv): PendingDrawing | null {
    if (!this.toolId || this.pending.length === 0) return null;
    const definition = toolById(this.toolId);
    if (!definition) return null;
    const pixels = this.pending.map((anchor) => anchorToPixel(anchor, env));
    const drag = this.drag;
    // While a press is held the shape is drawn to the point under the pointer, so the
    // ghost is that point and not the raw cursor: it shows the constrained, snapped
    // anchor the release will store. A one-anchor tool has no next anchor, so its only
    // anchor rides with the pointer until the release commits it.
    if (drag?.kind === 'draw' && drag.flying) {
      const flying = anchorToPixel(drag.flying, env);
      const full = this.pending.length >= definition.anchorCount;
      if (full) pixels[pixels.length - 1] = flying;
      return { toolId: this.toolId, pixels, cursor: full ? null : flying };
    }
    if (this.cursor && this.pending.length < definition.anchorCount) {
      return { toolId: this.toolId, pixels, cursor: { x: this.cursor.x, y: this.cursor.y } };
    }
    return { toolId: this.toolId, pixels, cursor: null };
  }

  /** Press. Shift matters only from here on: the press itself is always the pivot. */
  pointerDown(point: Pt, env: ToolEnv): DrawingInstancePlaceResult {
    this.cursor = point;
    const definition = this.toolId ? toolById(this.toolId) : null;
    if (definition) {
      // An armed tool owns the press even when it lands on another drawing: the press
      // starts a new instance. Taking an existing drawing is what a press with no tool
      // armed does, which keeps the two models from ever firing on the same press.
      if (this.pending.length === 0) this.pending = [pixelToAnchor(point.x, point.y, env)];
      this.drag = {
        kind: 'draw',
        pressPx: point,
        pivot: this.pending[this.pending.length - 1],
        constraint: definition.shiftConstraint,
      };
      return { consumed: true, placed: null };
    }

    const hit = this.hitAt(point, env);
    if (!hit) {
      this.engine.selectedId = null;
      return { consumed: false, placed: null };
    }
    this.engine.selectedId = hit.id;
    this.beginGrab(hit, point, env);
    return { consumed: true, placed: null };
  }

  pointerMove(point: Pt, env: ToolEnv, shift: boolean): boolean {
    this.cursor = point;
    const drag = this.drag;
    if (!drag) {
      if (!this.toolId) {
        const hit = this.hitAt(point, env);
        this.engine.hoveredId = hit?.id ?? null;
      }
      return false;
    }
    this.applyDrag(drag, point, env, shift);
    return true;
  }

  /** Where the pointer stands becomes the held anchor, or the shift the whole shape takes. */
  private applyDrag(drag: DragState, point: Pt, env: ToolEnv, shift: boolean): void {
    if (drag.kind === 'draw') {
      drag.flying = this.targetAnchor(point, env, drag, shift);
      return;
    }
    const instance = this.engine.find(drag.instanceId ?? null);
    const tool = this.engine.definitionOf(instance);
    if (!instance || !tool || !drag.snapshot) return;
    const target = this.targetAnchor(point, env, drag, shift);
    if (drag.kind === 'anchor' && drag.anchorIndex !== undefined) {
      const axes = tool.anchorAxes[drag.anchorIndex] ?? 'xy';
      const base = drag.snapshot[drag.anchorIndex] ?? target;
      this.engine.setAnchor(instance.id, drag.anchorIndex, {
        time: axes === 'y' ? base.time : target.time,
        price: axes === 'x' ? base.price : target.price,
      });
    } else {
      const grab = drag.grab ?? target;
      const timeDelta = tool.anchorAxes.some((axes) => axes !== 'y') ? target.time - grab.time : 0;
      const priceDelta = tool.anchorAxes.some((axes) => axes !== 'x') ? target.price - grab.price : 0;
      // Replay from the snapshot: the delta is measured from the press, so adding it to
      // the anchors as they now stand would move the drawing by it once per move event.
      drag.snapshot.forEach((anchor, index) => {
        this.engine.setAnchor(instance.id, index, { time: anchor.time + timeDelta, price: anchor.price + priceDelta });
      });
    }
    this.changed = true;
  }

  pointerUp(point: Pt, env: ToolEnv, shift: boolean): DrawingInstancePlaceResult {
    const drag = this.drag;
    this.drag = null;
    this.cursor = point;
    if (!drag) return { consumed: false, placed: null };
    if (drag.kind !== 'draw') {
      // A release counts as a move, so a mouseup that lands where no mousemove went still
      // puts the anchor there instead of leaving it on the last reported position.
      this.applyDrag(drag, point, env, shift);
      this.changed = true;
      return { consumed: true, placed: null };
    }
    return this.commit(this.targetAnchor(point, env, drag, shift), point, env);
  }

  /**
   * Esc: put back a move or anchor drag that is still held, otherwise drop the drawing
   * being placed, then disarm the tool. A placement drag stores nothing either way.
   */
  cancel(): boolean {
    const drag = this.drag;
    if (drag && drag.kind !== 'draw' && drag.instanceId && drag.snapshot) {
      const instance = this.engine.find(drag.instanceId);
      if (instance) {
        drag.snapshot.forEach((anchor, index) => this.engine.setAnchor(drag.instanceId as string, index, anchor));
        this.changed = true;
      }
      this.drag = null;
      return true;
    }
    if (this.pending.length > 0 || drag?.kind === 'draw') {
      this.pending = [];
      this.drag = null;
      return true;
    }
    if (this.toolId) {
      this.setTool(null);
      return true;
    }
    if (this.engine.selectedId) {
      this.engine.selectedId = null;
      return true;
    }
    return false;
  }

  deleteSelected(): boolean {
    const id = this.engine.selectedId;
    if (!id) return false;
    this.engine.remove(id);
    this.changed = true;
    return true;
  }

  /**
   * Copies a drawing a short way off the original, so the copy is visible and grabbable
   * instead of sitting exactly under the pointer.
   */
  duplicate(id: string, env: ToolEnv): void {
    const instance = this.engine.find(id);
    const first = instance?.anchors[0];
    if (!instance || !first) return;
    const base = anchorToPixel(first, env);
    const shifted = pixelToAnchor(base.x + DUPLICATE_OFFSET_PX, base.y + DUPLICATE_OFFSET_PX, env);
    if (this.engine.duplicate(id, { time: shifted.time - first.time, price: shifted.price - first.price })) {
      this.changed = true;
    }
  }

  /** Pointer cursor for the price pane: placement, anchor grab, or moving a drawing. */
  cursorFor(point: Pt, env: ToolEnv): string {
    if (this.toolId) return 'crosshair';
    const hit = this.hitAt(point, env);
    if (!hit) return 'crosshair';
    const tool = this.engine.definitionOf(hit);
    if (!tool) return 'move';
    return nearestAnchor(this.engine.pixelsFor(hit, env), point) >= 0 ? 'grab' : 'move';
  }

  /**
   * Places the release point as the next anchor of the drawing in progress, and adds the
   * instance once its anchor count is met. `release` is already constrained and snapped,
   * so what lands is what the ghost showed.
   */
  private commit(release: DrawingAnchor, point: Pt, env: ToolEnv): DrawingInstancePlaceResult {
    const definition: DrawingToolDefinition | null = this.toolId ? toolById(this.toolId) : null;
    if (!definition) {
      this.pending = [];
      return { consumed: true, placed: null };
    }
    const anchors = this.pending.slice();
    const last = anchors[anchors.length - 1];
    const lastPx = last ? anchorToPixel(last, env) : null;
    const dragged = lastPx === null || dragMoved(point, lastPx);
    if (anchors.length < definition.anchorCount) {
      // A release that never left the anchor it started from is a click, not a drag: the
      // drawing stays in progress and waits for the next point rather than storing the
      // same anchor twice.
      if (dragged) anchors.push(release);
    } else if (last) {
      anchors[anchors.length - 1] = release;
    }
    this.pending = anchors.length < definition.anchorCount ? anchors : [];
    if (anchors.length !== definition.anchorCount) return { consumed: true, placed: null };
    this.drag = null;
    const placed = this.engine.add(definition.id, anchors);
    if (placed) this.engine.selectedId = placed.id;
    this.changed = true;
    return { consumed: true, placed };
  }

  /**
   * The anchor a dragged point stands for. With Shift the point is first pulled onto the
   * tool's constraint in pane pixels, then snapped to a bar and a venue tick, then the
   * price re-solved from the snapped bar, so a constrained drag keeps its angle through
   * the bar snap. Same order, same pixel-space maths as the shipped layer.
   */
  private targetAnchor(point: Pt, env: ToolEnv, drag: DragState, shift: boolean): DrawingAnchor {
    const free = pixelToAnchor(point.x, point.y, env);
    const constraint = shift ? drag.constraint : undefined;
    const pivot = drag.pivot;
    if (!constraint || !pivot) return free;
    const pivotPx = anchorToPixel(pivot, env);
    const dx = point.x - pivotPx.x;
    const dy = point.y - pivotPx.y;
    if (constraint === 'lockPrice') return { time: free.time, price: pivot.price };
    if (constraint === 'lockTime') return { time: pivot.time, price: snapPrice(point.y, env) };
    let x: number;
    let y: number;
    if (constraint === 'square') {
      const side = Math.max(Math.abs(dx), Math.abs(dy));
      x = pivotPx.x + Math.sign(dx) * side;
      y = pivotPx.y + Math.sign(dy) * side;
    } else {
      // angle: the nearest multiple of 45 degrees from the pivot. A straight run keeps
      // the pivot's price or time; a diagonal keeps its distance, shortened onto the
      // 45 degree line.
      const step = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
      if (step % 4 === 0) return { time: free.time, price: pivot.price };
      if (step % 4 === 2) return { time: pivot.time, price: snapPrice(point.y, env) };
      const reach = Math.hypot(dx, dy) * Math.SQRT1_2;
      x = pivotPx.x + Math.sign(dx) * reach;
      y = pivotPx.y + Math.sign(dy) * reach;
    }
    const snapped = pixelToAnchor(x, y, env);
    const run = Math.abs(anchorToPixel(snapped, env).x - pivotPx.x);
    return { time: snapped.time, price: snapPrice(pivotPx.y + Math.sign(dy) * run, env) };
  }

  /**
   * Starts the gesture that takes an existing drawing: a handle drags one anchor, the
   * body moves the whole thing. A constrained tool measures from the other corner, which
   * is what the shipped angle snap and aspect lock pivot on.
   */
  private beginGrab(instance: DrawingInstance, point: Pt, env: ToolEnv): DragState | null {
    const tool = this.engine.definitionOf(instance);
    if (!tool) return null;
    const handle = nearestAnchor(this.engine.pixelsFor(instance, env), point);
    if (handle >= 0) {
      this.drag = {
        kind: 'anchor',
        instanceId: instance.id,
        anchorIndex: handle,
        snapshot: instance.anchors.slice(),
        constraint: tool.shiftConstraint,
        pivot: tool.anchorCount === 2 ? instance.anchors[handle === 0 ? 1 : 0] : instance.anchors[handle],
      };
      return this.drag;
    }
    this.drag = {
      kind: 'move',
      instanceId: instance.id,
      snapshot: instance.anchors.slice(),
      grab: pixelToAnchor(point.x, point.y, env),
    };
    return this.drag;
  }

  /**
   * Id of the topmost drawing under the pointer, for double-click and the right-click
   * menu. Locked drawings count here, otherwise there would be no way to unlock one.
   */
  hitId(point: Pt, env: ToolEnv): string | null {
    return this.hitAt(point, env, true)?.id ?? null;
  }

  /**
   * Topmost drawing under the pointer, so later additions win overlap. A locked drawing
   * is invisible to gestures, which leaves the tape free to pan under it.
   */
  private hitAt(point: Pt, env: ToolEnv, includeLocked = false): DrawingInstance | null {
    for (let i = this.engine.instances.length - 1; i >= 0; i -= 1) {
      const instance = this.engine.instances[i];
      if (!instance) continue;
      if (!includeLocked && instance.locked === true) continue;
      if (hitTest(this.engine.primitivesFor(instance, env), point, env.measure)) return instance;
    }
    return null;
  }
}

export interface DrawingInstancePlaceResult {
  /** True when the gesture must not reach the chart's own pan/drag handling. */
  consumed: boolean;
  /** The drawing that just finished being placed, if any. */
  placed: { id: string; toolId: string } | null;
}
