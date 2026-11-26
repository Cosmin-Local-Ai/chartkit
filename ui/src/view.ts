import type { PriceScaleMode } from './scale';
import { clamp } from './canvasKit';

/**
 * Density floor in CSS pixels per bar. A candle body needs about a pixel of its own and
 * two more to read as a candle, so zooming out stops here rather than turning the tape
 * into a solid comb: at this step a 680 px plot holds about 270 bars.
 */
export const MIN_BAR_STEP = 2.5;
export const MAX_BAR_STEP = 64;
/** Bounds a user-set density floor may sit within, in CSS pixels per bar. */
export const DENSITY_FLOOR_MIN = 1;
export const DENSITY_FLOOR_MAX = 12;
/**
 * Bars the first view shows. The shipped product lands a fresh chart on 250 bars
 * (`defaultBarCount: 250`, route-core-ZRwd-YvZ.js at offset 3128660, with the same 250 as
 * its fallback at 1674811), so the opening window matches theirs instead of filling the
 * plot with every stored bar.
 */
export const DEFAULT_VISIBLE_BARS = 250;
/** Bars of blank tape kept right of the newest bar at rest, and the pan-right limit. */
export const HOME_OFFSET = 6;
/**
 * How much a single centring request may widen the zoom. Centring a print near the newest bar
 * needs room the pan limit only allows at a wide step; this keeps that step from running away.
 */
const CENTRE_ZOOM_STEP_CAP = 4;
const DEFAULT_PLOT_WIDTH = 800;

/**
 * Horizontal view state (zoom in pixels per bar, offset from the newest bar) and
 * the vertical price range. Zoom and pan are expressed in bar indices, which keeps
 * the cursor anchored across zoom changes and makes gap-collapsed history behave.
 */
export class ChartView {
  barStep = 8;
  /**
   * Distance in bars from the newest bar to the right edge. Positive leaves blank
   * tape on the right, negative puts the newest bar off-screen to the right, which is
   * how the window travels back through a long history.
   */
  offsetFromEnd = HOME_OFFSET;
  /** Plot width in CSS pixels, kept current by the renderer so limits can be derived. */
  plotWidth = DEFAULT_PLOT_WIDTH;
  priceMode: PriceScaleMode = 'linear';
  /** True while the price range tracks the visible bars. */
  autoFit = true;
  /** Pixels per bar the zoom stops at; the settings dialog owns this. */
  minBarStep = MIN_BAR_STEP;
  /** Bars a freshly framed view shows; the settings dialog owns this. */
  defaultVisibleBars = DEFAULT_VISIBLE_BARS;
  private shownMin = 0;
  private shownMax = 1;
  private snap = true;

  setMode(mode: PriceScaleMode): void {
    if (mode === this.priceMode) return;
    this.priceMode = mode;
    this.snap = true;
  }

  setViewport(width: number): void {
    if (width > 0) this.plotWidth = width;
  }

  /**
   * Moves the density floor and the framing target, then re-clamps the live zoom: raising
   * the floor pushes an already maxed-out view in at once instead of waiting for the next
   * wheel turn.
   */
  setDensity(floor: number, visibleBars: number, count: number): void {
    this.minBarStep = clamp(floor, DENSITY_FLOOR_MIN, DENSITY_FLOOR_MAX);
    this.defaultVisibleBars = Math.round(clamp(visibleBars, 20, 2000));
    this.clamp(count);
  }

  /** Bars that fit across the plot at the current zoom. */
  private plotBars(): number {
    return this.plotWidth / Math.max(0.05, this.barStep);
  }

  /** Furthest pan left: the oldest bar sits on the left edge of the plot. */
  minOffset(count: number): number {
    return Math.min(HOME_OFFSET, this.plotBars() - Math.max(0, count - 1));
  }

  clamp(count: number): void {
    this.barStep = clamp(this.barStep, this.minBarStep, MAX_BAR_STEP);
    const low = Math.min(this.minOffset(count), HOME_OFFSET);
    this.offsetFromEnd = clamp(this.offsetFromEnd, low, HOME_OFFSET);
  }

  /** Pan by whole bars; positive moves toward older bars. */
  panBars(delta: number, count: number): void {
    this.offsetFromEnd -= delta;
    this.clamp(count);
  }

  /** Drag the tape by pixels: the content follows the pointer. */
  panPixels(dx: number, count: number): void {
    this.offsetFromEnd -= dx / Math.max(0.05, this.barStep);
    this.clamp(count);
  }

  /** Wheel zoom that keeps the bar under `x` pinned to `x`. */
  zoomAt(x: number, factor: number, count: number, right: number): void {
    const pinned = count - 1 + this.offsetFromEnd - (right - x) / Math.max(0.05, this.barStep);
    const nextStep = clamp(this.barStep * factor, this.minBarStep, MAX_BAR_STEP);
    if (nextStep === this.barStep) return;
    this.barStep = nextStep;
    this.offsetFromEnd = pinned - (count - 1) + (right - x) / Math.max(0.05, this.barStep);
    this.clamp(count);
  }

  zoomBy(factor: number, count: number): void {
    this.barStep = clamp(this.barStep * factor, this.minBarStep, MAX_BAR_STEP);
    this.clamp(count);
  }

  /**
   * Fit as much history as the density floor allows: every bar when they all fit at
   * `MIN_BAR_STEP`, otherwise the newest window that does. Pan left for the rest.
   */
  fitAll(count: number, plotWidth: number): void {
    if (count < 2 || plotWidth <= 0) return;
    this.plotWidth = plotWidth;
    this.barStep = clamp(plotWidth / (count + HOME_OFFSET), this.minBarStep, MAX_BAR_STEP);
    this.offsetFromEnd = HOME_OFFSET;
    this.clamp(count);
  }

  /** Opening view for a workspace with no saved zoom: the newest `DEFAULT_VISIBLE_BARS`. */
  applyDefaultView(count: number, plotWidth: number): void {
    if (count < 2 || plotWidth <= 0) return;
    this.plotWidth = plotWidth;
    this.barStep = clamp(plotWidth / this.defaultVisibleBars, this.minBarStep, MAX_BAR_STEP);
    this.offsetFromEnd = HOME_OFFSET;
    this.clamp(count);
  }

  /**
   * Put bar `index` in the middle of the plot, widening the zoom if it has to. Used by cluster
   * search: a listed print is only useful if the chart shows it.
   *
   * The pan limit allows at most `HOME_OFFSET` bars of blank tape right of the newest bar, so
   * a print near the newest end cannot be centred at every zoom: the bars between it and the
   * newest bar have to fill half the plot. Rather than leave it parked at the right edge the
   * step is widened to whatever still fits, but only by `CENTRE_ZOOM_STEP_CAP`: a click should
   * not turn a chart of a hundred bars into a chart of eight. Past that bound the print sits as
   * close to the middle as the pan limit allows, which for the newest bar is its right edge.
   */
  centreOn(index: number, count: number): void {
    if (count < 1 || index < 0 || index >= count) return;
    const bars = count - 1 - index;
    const half = this.plotWidth / 2;
    const room = HOME_OFFSET + bars;
    if (room > 0 && half / Math.max(0.05, this.barStep) > room) {
      const widest = Math.min(MAX_BAR_STEP, this.barStep * CENTRE_ZOOM_STEP_CAP);
      this.barStep = clamp(half / room, this.minBarStep, Math.max(this.minBarStep, widest));
    }
    this.offsetFromEnd = half / Math.max(0.05, this.barStep) - bars;
    this.clamp(count);
  }

  /** Jump to the newest bar. */
  home(count: number): void {
    this.offsetFromEnd = HOME_OFFSET;
    this.clamp(count);
  }

  /** True while the view rides the newest bar instead of sitting back in history. */
  followsLive(): boolean {
    return this.offsetFromEnd >= HOME_OFFSET - 0.75;
  }

  /**
   * A bar was appended: a view parked in history keeps the same bars on screen, a
   * following view advances so the live bar stays at the right edge.
   */
  onBarAppended(): void {
    if (!this.followsLive()) this.offsetFromEnd -= 1;
  }

  setManualRange(min: number, max: number): void {
    this.autoFit = false;
    this.shownMin = Math.min(min, max);
    this.shownMax = Math.max(min, max);
    this.snap = true;
  }

  restoreAutoFit(): void {
    this.autoFit = true;
    this.snap = true;
  }

  /** Shift the manual price range by pixels; disables auto-fit. */
  dragPriceRange(dy: number, scale: { min: number; max: number; height: number }): void {
    const span = scale.max - scale.min;
    const delta = (dy / Math.max(1, scale.height)) * span;
    this.setManualRange(scale.min + delta, scale.max + delta);
  }

  get manualMin(): number {
    return this.shownMin;
  }

  get manualMax(): number {
    return this.shownMax;
  }

  /**
   * Eased auto-fit: the range chases the visible bars instead of snapping, so a
   * moving live bar does not make the whole tape jitter every frame.
   */
  updateAutoRange(target: { min: number; max: number } | null): { min: number; max: number } {
    if (!target) return { min: this.shownMin, max: this.shownMax };
    const pad = Math.max(
      Math.abs(target.max - target.min) * 0.08,
      Math.max(Math.abs(target.max), 1) * 1e-6,
    );
    const wanted = { min: target.min - pad, max: target.max + pad };
    if (!this.autoFit) return { min: this.shownMin, max: this.shownMax };
    if (this.snap) {
      this.shownMin = wanted.min;
      this.shownMax = wanted.max;
      this.snap = false;
    } else {
      const tolerance = (wanted.max - wanted.min) * 0.004;
      this.shownMin += (wanted.min - this.shownMin) * 0.3;
      this.shownMax += (wanted.max - this.shownMax) * 0.3;
      if (Math.abs(wanted.min - this.shownMin) < tolerance) this.shownMin = wanted.min;
      if (Math.abs(wanted.max - this.shownMax) < tolerance) this.shownMax = wanted.max;
    }
    return { min: this.shownMin, max: this.shownMax };
  }

  serialize(): {
    barStep: number;
    offsetFromEnd: number;
    priceMode: PriceScaleMode;
    autoFit: boolean;
    manualMin: number;
    manualMax: number;
  } {
    return {
      barStep: this.barStep,
      offsetFromEnd: this.offsetFromEnd,
      priceMode: this.priceMode,
      autoFit: this.autoFit,
      // A manual range is the user's own framing of the tape. priceRange() keeps
      // serving it while auto-fit is off, so a reload has to bring it back too.
      manualMin: this.shownMin,
      manualMax: this.shownMax,
    };
  }

  restore(state: {
    barStep?: number;
    offsetFromEnd?: number;
    priceMode?: PriceScaleMode;
    autoFit?: boolean;
    manualMin?: number;
    manualMax?: number;
  } | null | undefined): void {
    if (!state) return;
    if (typeof state.barStep === 'number') this.barStep = clamp(state.barStep, this.minBarStep, MAX_BAR_STEP);
    if (typeof state.offsetFromEnd === 'number' && Number.isFinite(state.offsetFromEnd)) {
      this.offsetFromEnd = state.offsetFromEnd;
    }
    if (state.priceMode === 'linear' || state.priceMode === 'log') this.priceMode = state.priceMode;
    if (typeof state.autoFit === 'boolean') this.autoFit = state.autoFit;
    if (
      typeof state.manualMin === 'number' &&
      typeof state.manualMax === 'number' &&
      Number.isFinite(state.manualMin) &&
      Number.isFinite(state.manualMax)
    ) {
      this.shownMin = Math.min(state.manualMin, state.manualMax);
      this.shownMax = Math.max(state.manualMin, state.manualMax);
    }
    this.snap = true;
  }
}
