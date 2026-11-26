import type { Bar, Instrument } from './types';
import type { LocalTime } from './format';
import type { PriceScale, XScale } from './scale';
import type { ChartView } from './view';
import { THEME, el, fitCanvas } from './canvasKit';

/** Right-hand price/volume gutter every pane reserves so columns line up. */
export const PRICE_AXIS_WIDTH = 66;
/** Bottom time axis, drawn once by the lowest visible pane. */
export const TIME_AXIS_HEIGHT = 22;
export const PLOT_PADDING_LEFT = 10;

/** A box on a pane canvas, in CSS pixels. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface HoverState {
  /** Bar index under the cursor, -1 when the cursor is outside the tape. */
  index: number;
  /** Cursor position in CSS pixels relative to the pane it is over. */
  x: number;
  y: number;
  paneId: string | null;
  inside: boolean;
}

export function emptyHover(): HoverState {
  return { index: -1, x: 0, y: 0, paneId: null, inside: false };
}

export interface Frame {
  x: XScale;
  price: PriceScale;
  view: ChartView;
  bars: readonly Bar[];
  instrument: Instrument | null;
  timeframe: string;
  local: LocalTime;
  hover: HoverState;
  /** Plot rect shared by every pane. */
  left: number;
  right: number;
  width: number;
  height: number;
  /** True for the lowest visible pane: it owns the time axis. */
  axisBottom: boolean;
  now: number;
}

export interface PaneDefinition {
  id: string;
  weight: number;
  minPx: number;
  draw(ctx: CanvasRenderingContext2D, frame: Frame): void;
  resize?(width: number, height: number): void;
}

interface Host {
  def: PaneDefinition;
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  visible: boolean;
  observer: ResizeObserver | null;
}

/** One visible pane during a layout pass: its floor, its weight, and the height it is owed. */
interface Slot {
  host: Host;
  floor: number;
  weight: number;
  height: number;
}

/** Height a splitter strip costs the stack between two panes. */
const SPLITTER_PX = 5;
/** Smallest height a pane keeps when the stack has to squeeze every pane into view. */
const MIN_PANE_PX = 52;
/** Height of the strip that tells the user the stack scrolls. */
const MORE_STRIP_PX = 22;
/** Share of the visible plot the price pane keeps until the user drags a splitter. */
const PRICE_MIN_SHARE = 0.56;

/**
 * Vertical stack of panes sharing one x mapping. Heights are computed here rather than
 * left to flex weights and per-pane minimums: every enabled pane gets a real slice of the
 * viewport, the price pane keeps the dominant slice, and the stack only scrolls when even
 * the minimum slices do not fit — in which case a strip says so.
 */
export class PaneStack {
  private hosts: Host[] = [];
  private readonly byId = new Map<string, Host>();
  private splitters: HTMLElement[] = [];
  private splitterHandler: (() => void) | null = null;
  private dpr = 1;
  /** Pane count is bounded by the viewport, so layout runs at most once a frame. */
  private layoutQueued = false;
  /** False once the user drags a splitter: their own weights then rule without a floor. */
  private autoPriceShare = true;
  private readonly moreStrip = el('div', 'pane-more');

  constructor(private readonly host: HTMLElement) {
    this.host.classList.add('pane-stack');
    this.moreStrip.hidden = true;
    this.host.append(this.moreStrip);
    new ResizeObserver(() => this.requestRelayout()).observe(this.host);
    this.host.addEventListener('scroll', () => this.requestRelayout());
  }

  /** Insert a pane at `index` in draw order, or append it when the index is omitted. */
  add(def: PaneDefinition, index?: number): void {
    if (this.byId.has(def.id)) return;
    const root = el('div', 'pane');
    root.dataset.pane = def.id;
    const canvas = el('canvas', 'pane-canvas');
    root.append(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    const host: Host = { def, root, canvas, ctx, width: 0, height: 0, visible: true, observer: null };
    // A starting height only: relayout replaces it with a measured one.
    root.style.flex = `0 0 ${def.minPx}px`;
    const at = index === undefined ? this.hosts.length : Math.max(0, Math.min(this.hosts.length, index));
    this.hosts.splice(at, 0, host);
    this.byId.set(def.id, host);
    const anchor = this.hosts[at + 1]?.root ?? this.moreStrip;
    this.host.insertBefore(root, anchor);
    host.observer = this.observe(host);
    this.syncSplitters();
    this.requestRelayout();
  }

  /** Drop a pane, e.g. when its indicator instance is removed. */
  remove(id: string): void {
    const host = this.byId.get(id);
    if (!host) return;
    host.observer?.disconnect();
    host.root.remove();
    this.byId.delete(id);
    this.hosts = this.hosts.filter((entry) => entry !== host);
    this.syncSplitters();
    this.requestRelayout();
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  private observe(host: Host): ResizeObserver {
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = entry.contentRect;
        host.width = Math.max(1, Math.round(box.width));
        host.height = Math.max(1, Math.round(box.height));
        this.dpr = window.devicePixelRatio || 1;
        fitCanvas(host.canvas, host.ctx, host.width, host.height, this.dpr);
        host.def.resize?.(host.width, host.height);
      }
    });
    observer.observe(host.root);
    return observer;
  }

  setVisible(id: string, visible: boolean): void {
    const host = this.byId.get(id);
    if (!host || host.visible === visible) return;
    host.visible = visible;
    host.root.classList.toggle('is-hidden', !visible);
    this.syncSplitters();
    this.requestRelayout();
  }

  isVisible(id: string): boolean {
    return this.byId.get(id)?.visible ?? false;
  }

  setWeight(id: string, weight: number): void {
    const host = this.byId.get(id);
    if (!host) return;
    host.def.weight = Math.max(0.2, weight);
    this.requestRelayout();
  }

  /**
   * Weights as the user sees them: measured heights over 100, so a saved workspace comes
   * back at the proportions it had. The raw weights would not, because the price floor
   * reshapes the split they produced.
   */
  weights(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const host of this.hosts) {
      out[host.def.id] = host.height > 0 ? Math.max(0.2, host.height / 100) : Math.max(0.2, host.def.weight);
    }
    return out;
  }

  restoreWeights(weights: Record<string, number> | null | undefined): void {
    if (!weights) return;
    for (const host of this.hosts) {
      const value = weights[host.def.id];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) this.setWeight(host.def.id, value);
    }
  }

  /** Turns the price pane's minimum share back on or off, e.g. from a saved workspace. */
  setAutoPriceShare(on: boolean): void {
    if (this.autoPriceShare === on) return;
    this.autoPriceShare = on;
    this.requestRelayout();
  }

  autoPriceShareEnabled(): boolean {
    return this.autoPriceShare;
  }

  /**
   * Heights for the visible panes, in draw order. Each starts at its floor and the rest of
   * the viewport is split by weight, except that the price pane first reserves its share so
   * the tape stays dominant; the other panes then share what is left in proportion to their
   * own weights. Once the floors alone overflow, the stack scrolls and every pane keeps the
   * height its weight asks for, with the price pane never falling below its share.
   */
  private relayout(): void {
    const slots: Slot[] = this.hosts
      .filter((host) => host.visible)
      .map((host) => ({
        host,
        floor: Math.min(host.def.minPx, MIN_PANE_PX),
        weight: Math.max(0.2, host.def.weight),
        height: 0,
      }));
    if (slots.length === 0) return;
    const gaps = (slots.length - 1) * SPLITTER_PX;
    const room = Math.max(0, this.host.clientHeight - gaps);
    const sumFloor = slots.reduce((total, slot) => total + slot.floor, 0);
    const overflowing = sumFloor > room;
    // A stack that already scrolls cannot be squeezed further, so there each pane instead
    // takes the height its weight asks for — weights hold pane heights — which is what lets a
    // splitter drag land on a stack this tall instead of being swallowed by the floors.
    if (overflowing) for (const slot of slots) slot.floor = Math.max(slot.floor, slot.weight * 100);
    const baseSum = overflowing ? slots.reduce((total, slot) => total + slot.floor, 0) : sumFloor;
    // The strip only exists while the stack scrolls, and it takes room of its own.
    const plot = Math.max(0, overflowing ? room - MORE_STRIP_PX : room);
    this.moreStrip.hidden = !overflowing;
    const total = overflowing ? baseSum : plot;
    const price = this.autoPriceShare ? (slots.find((slot) => slot.host.def.id === 'price') ?? null) : null;
    for (const slot of slots) slot.height = slot.floor;
    if (price) {
      // The share is taken from the pane area, splitters excluded.
      const share = Math.floor(room * PRICE_MIN_SHARE);
      const othersFloor = baseSum - price.floor;
      // Never starve the other panes below their floors, but a scrolling stack lets the price
      // pane push the content past the viewport: it is the pane worth seeing.
      const priceHeight = overflowing
        ? Math.max(price.floor, share)
        : Math.min(Math.max(price.floor, share), Math.max(price.floor, plot - othersFloor));
      const othersWeight = slots.reduce((sum, slot) => sum + (slot === price ? 0 : slot.weight), 0) || 1;
      const otherFree = Math.max(0, Math.max(0, total - priceHeight) - othersFloor);
      for (const slot of slots) {
        if (slot !== price) slot.height = slot.floor + (otherFree * slot.weight) / othersWeight;
      }
      price.height = priceHeight;
    } else {
      const free = Math.max(0, total - baseSum);
      const allWeight = slots.reduce((sum, slot) => sum + slot.weight, 0) || 1;
      for (const slot of slots) slot.height = slot.floor + (free * slot.weight) / allWeight;
    }
    const rounded = slots.map((slot) => Math.max(slot.floor, Math.round(slot.height)));
    // Round-off has to land somewhere, or a stray pixel makes a fitting stack scroll.
    const drift = overflowing ? 0 : plot - rounded.reduce((sum, height) => sum + height, 0);
    const sink = price ? slots.indexOf(price) : slots.length - 1;
    slots.forEach((slot, index) => {
      const height = Math.max(slot.floor, (rounded[index] ?? slot.floor) + (index === sink ? drift : 0));
      slot.host.root.style.flex = `0 0 ${height}px`;
      slot.host.root.style.height = `${height}px`;
      slot.host.root.style.minHeight = `${height}px`;
    });
    this.host.classList.toggle('is-overflowing', overflowing);
    this.updateMoreStrip();
  }

  private requestRelayout(): void {
    if (this.layoutQueued) return;
    this.layoutQueued = true;
    requestAnimationFrame(() => {
      this.layoutQueued = false;
      this.relayout();
    });
  }

  private updateMoreStrip(): void {
    if (this.moreStrip.hidden) {
      this.moreStrip.textContent = '';
      return;
    }
    const edge = this.host.getBoundingClientRect().bottom;
    const below = this.hosts.filter(
      (host) => host.visible && host.root.getBoundingClientRect().bottom > edge + 1,
    ).length;
    this.moreStrip.textContent =
      below > 0
        ? `${below} more ${below === 1 ? 'pane' : 'panes'} below \u00b7 scroll`
        : 'bottom of the pane stack \u00b7 scroll up to review';
  }

  /**
   * Index of the pane that owns the time axis: the last one fully inside the scrollport, so
   * the axis stays on screen when the stack scrolls instead of riding off with the bottom
   * pane. Falls back to the last pane when none fits whole.
   */
  private axisOwner(visible: Host[]): number {
    const box = this.host.getBoundingClientRect();
    const bottom = box.bottom - (this.moreStrip.hidden ? 0 : MORE_STRIP_PX);
    let chosen = visible.length - 1;
    visible.forEach((host, index) => {
      const pane = host.root.getBoundingClientRect();
      if (pane.top >= box.top - 0.5 && pane.bottom <= bottom + 0.5) chosen = index;
    });
    return chosen;
  }

  /** Draggable dividers between visible panes; re-run whenever panes come and go. */
  enableSplitters(onResize: () => void): void {
    this.splitterHandler = onResize;
    this.syncSplitters();
  }

  /** Rebuild the dividers so they always sit between the panes that are on screen. */
  private syncSplitters(): void {
    for (const splitter of this.splitters) splitter.remove();
    this.splitters = [];
    const onResize = this.splitterHandler;
    if (!onResize) return;
    const visible = this.hosts.filter((host) => host.visible);
    for (let i = 0; i < visible.length - 1; i += 1) {
      const upper = visible[i];
      const lower = visible[i + 1];
      if (!upper || !lower) continue;
      const splitter = el('div', 'pane-splitter');
      splitter.dataset.between = `${upper.def.id}:${lower.def.id}`;
      splitter.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        splitter.setPointerCapture(event.pointerId);
        const startY = event.clientY;
        const startUpper = upper.root.getBoundingClientRect().height;
        const startLower = lower.root.getBoundingClientRect().height;
        const total = startUpper + startLower;
        const move = (next: PointerEvent) => {
          const delta = next.clientY - startY;
          const upperHeight = Math.max(upper.def.minPx, Math.min(total - lower.def.minPx, startUpper + delta));
          const lowerHeight = total - upperHeight;
          this.autoPriceShare = false;
          this.setWeight(upper.def.id, Math.max(0.2, upperHeight / 100));
          this.setWeight(lower.def.id, Math.max(0.2, lowerHeight / 100));
          onResize();
        };
        const up = () => {
          splitter.removeEventListener('pointermove', move);
          splitter.removeEventListener('pointerup', up);
          splitter.removeEventListener('pointercancel', up);
        };
        splitter.addEventListener('pointermove', move);
        splitter.addEventListener('pointerup', up);
        splitter.addEventListener('pointercancel', up);
      });
      this.splitters.push(splitter);
      this.host.insertBefore(splitter, lower.root);
    }
  }

  /** Visible hosts in draw order; the last one owns the time axis. */
  visibleHosts(): { id: string; width: number; height: number; ctx: CanvasRenderingContext2D; axisBottom: boolean }[] {
    const visible = this.hosts.filter((host) => host.visible);
    const axis = this.axisOwner(visible);
    return visible.map((host, index) => ({
      id: host.def.id,
      width: host.width,
      height: host.height,
      ctx: host.ctx,
      axisBottom: index === axis,
    }));
  }

  /** The draw callback a pane was registered with, for panes added after the built-ins. */
  defFor(id: string): PaneDefinition | null {
    return this.byId.get(id)?.def ?? null;
  }

  hostFor(id: string): { width: number; height: number } | null {
    const host = this.byId.get(id);
    return host ? { width: host.width, height: host.height } : null;
  }

  /** True when the device pixel ratio changed, e.g. the window moved screens. */
  syncDpr(): boolean {
    const next = window.devicePixelRatio || 1;
    if (next === this.dpr) return false;
    this.dpr = next;
    for (const host of this.hosts) fitCanvas(host.canvas, host.ctx, host.width, host.height, this.dpr);
    return true;
  }

  clear(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, width, height);
  }
}
