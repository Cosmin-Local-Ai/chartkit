import type { LocalTime } from './format';
import { decimalsForStep, fmtNumber, niceStep } from './format';

/** One labelled gridline. `major` gets a stronger line and a bolder label. */
export interface AxisTick {
  value: number;
  label: string;
  major: boolean;
}

/** A time gridline pinned to a bar index, because the x axis is index based. */
export interface TimeTick extends AxisTick {
  index: number;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

type Unit = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

interface TickStep {
  ms: number;
  unit: Unit;
  /** Bucket size in whole units; keeps labels on venue-clock boundaries. */
  mod: number;
}

const TICK_STEPS: TickStep[] = [
  { ms: 1_000, unit: 'second', mod: 1 },
  { ms: 5_000, unit: 'second', mod: 5 },
  { ms: 15_000, unit: 'second', mod: 15 },
  { ms: 30_000, unit: 'second', mod: 30 },
  { ms: 60_000, unit: 'minute', mod: 1 },
  { ms: 2 * MINUTE, unit: 'minute', mod: 2 },
  { ms: 5 * MINUTE, unit: 'minute', mod: 5 },
  { ms: 15 * MINUTE, unit: 'minute', mod: 15 },
  { ms: 30 * MINUTE, unit: 'minute', mod: 30 },
  { ms: HOUR, unit: 'hour', mod: 1 },
  { ms: 2 * HOUR, unit: 'hour', mod: 2 },
  { ms: 3 * HOUR, unit: 'hour', mod: 3 },
  { ms: 6 * HOUR, unit: 'hour', mod: 6 },
  { ms: 12 * HOUR, unit: 'hour', mod: 12 },
  { ms: DAY, unit: 'day', mod: 1 },
  { ms: 2 * DAY, unit: 'day', mod: 2 },
  { ms: 7 * DAY, unit: 'week', mod: 1 },
  { ms: 30 * DAY, unit: 'month', mod: 1 },
  { ms: 90 * DAY, unit: 'month', mod: 3 },
  { ms: 180 * DAY, unit: 'month', mod: 6 },
  { ms: 365 * DAY, unit: 'year', mod: 1 },
];

export interface XScaleOptions {
  /** Number of bars in the series. */
  count: number;
  /** Pixels per bar. */
  barStep: number;
  /** Bars of empty space held between the newest bar and the right edge. */
  offsetFromEnd: number;
  left: number;
  right: number;
  /** Ascending bar start times. */
  starts: ArrayLike<number>;
  /** Nominal spacing of one bar in ms. */
  barMs: number;
  local: LocalTime;
}

/**
 * Index-based horizontal mapping shared by every pane. Bars are packed one after
 * another, so venue closures and stored holes collapse instead of leaving empty
 * canvas; the gap marks keep those boundaries visible.
 */
export class XScale {
  private readonly opts: XScaleOptions;

  constructor(opts: XScaleOptions) {
    this.opts = opts;
  }

  get barStep(): number {
    return this.opts.barStep;
  }

  get count(): number {
    return this.opts.count;
  }

  /** Nominal spacing of one bar in ms, used to place anchors in blank tape. */
  get barMs(): number {
    return this.opts.barMs;
  }

  /** Start time of the bar at `index`, or undefined when the index is outside the series. */
  startAt(index: number): number | undefined {
    return this.opts.starts[index];
  }

  get left(): number {
    return this.opts.left;
  }

  get right(): number {
    return this.opts.right;
  }

  get plotWidth(): number {
    return Math.max(1, this.opts.right - this.opts.left);
  }

  /** Centre x of the bar at `index`. */
  toX(index: number): number {
    const { count, barStep, offsetFromEnd, right } = this.opts;
    return right - (offsetFromEnd + (count - 1 - index)) * barStep;
  }

  /**
   * Fractional bar index at pixel `x`; the exact inverse of `toX`. `offsetFromEnd`
   * is the gap between the newest bar and the right edge, so the index at the right
   * edge is `count - 1 + offsetFromEnd`.
   */
  toIndex(x: number): number {
    const { count, barStep, offsetFromEnd, right } = this.opts;
    return count - 1 + offsetFromEnd - (right - x) / barStep;
  }

  /** Bar index under the cursor, clamped to the series. */
  indexAt(x: number): number {
    const raw = Math.round(this.toIndex(x));
    return Math.max(0, Math.min(this.opts.count - 1, raw));
  }

  /** Inclusive integer index range that overlaps the plot, widened by one bar. */
  visibleRange(): { first: number; last: number } {
    const first = Math.max(0, Math.floor(this.toIndex(this.opts.left)) - 1);
    const last = Math.min(this.opts.count - 1, Math.ceil(this.toIndex(this.opts.right)) + 1);
    return { first, last };
  }

  /** Width of a candle body: the bar step minus its gutter, never hairline thin. */
  bodyWidth(): number {
    return Math.max(1, Math.min(this.opts.barStep - Math.max(1, this.opts.barStep * 0.15), 26));
  }

  /** Bars per pixel at the current zoom; drives label density choices. */
  msPerPixel(): number {
    return this.opts.barMs / Math.max(0.05, this.opts.barStep);
  }

  /**
   * Time gridlines: pick the smallest ladder step that clears the target pixel
   * pitch, then mark bars that cross one of its boundaries in the venue timezone.
   */
  timeTicks(minGapPx = 96): TimeTick[] {
    const { count, starts, barMs } = this.opts;
    const { first, last } = this.visibleRange();
    if (count === 0 || last < first || !(barMs > 0)) return [];

    const targetMs = minGapPx * this.msPerPixel();
    let step = TICK_STEPS[TICK_STEPS.length - 1] as TickStep;
    for (const candidate of TICK_STEPS) {
      if (candidate.ms >= targetMs) {
        step = candidate;
        break;
      }
    }

    const ticks: TimeTick[] = [];
    let previousKey = Number.NaN;
    for (let i = first; i <= last; i += 1) {
      const start = starts[i];
      if (start === undefined) continue;
      const key = this.bucketKey(start, step);
      if (key === previousKey) continue;
      previousKey = key;
      if (key % step.mod !== 0) continue;
      const label = this.label(start, step.unit);
      ticks.push({ value: start, index: i, label, major: this.isMajor(start, step.unit) });
    }
    return ticks;
  }

  private bucketKey(ms: number, step: TickStep): number {
    const { local } = this.opts;
    switch (step.unit) {
      case 'second':
        return local.secondKey(ms);
      case 'minute':
        return local.minuteKey(ms);
      case 'hour':
        return local.hourKey(ms);
      case 'day':
        return local.dayKey(ms);
      case 'week':
        return local.dayKey(ms) + 4; // day 0 of the shifted epoch is a Thursday
      case 'month': {
        const date = new Date(local.local(ms));
        return date.getUTCFullYear() * 12 + date.getUTCMonth();
      }
      case 'year':
        return new Date(local.local(ms)).getUTCFullYear();
    }
  }

  private label(ms: number, unit: Unit): string {
    const { local } = this.opts;
    switch (unit) {
      case 'second':
        return local.format(ms, 'clockSeconds');
      case 'minute':
      case 'hour':
        return local.format(ms, 'clock');
      case 'day':
      case 'week':
        return local.format(ms, 'day');
      case 'month':
        return local.format(ms, 'month');
      case 'year':
        return local.format(ms, 'year');
    }
  }

  private isMajor(ms: number, unit: Unit): boolean {
    const { local } = this.opts;
    switch (unit) {
      case 'second':
        return local.secondKey(ms) % 60 === 0;
      case 'minute':
        return local.minuteKey(ms) % 60 === 0;
      case 'hour':
        return local.hourKey(ms) % 24 === 0;
      case 'day':
      case 'week': {
        const date = new Date(local.local(ms));
        return date.getUTCDay() === 1;
      }
      case 'month':
        return new Date(local.local(ms)).getUTCMonth() === 0;
      case 'year':
        return true;
    }
  }
}

export type PriceScaleMode = 'linear' | 'log';

export interface PriceScaleOptions {
  mode: PriceScaleMode;
  min: number;
  max: number;
  top: number;
  bottom: number;
  precision: number;
  /**
   * Vertical pitch a labelled tick is aimed at, in CSS pixels. Smaller means more labels
   * and more price rows; the settings dialog's tick-density control moves it. Defaults to
   * the pitch every pane has always used.
   */
  tickPx?: number;
}

/**
 * Vertical price mapping for one pane. Linear and log share one interface so every
 * pane, the crosshair readout and later drawings can reuse the same object.
 */
export class PriceScale {
  private readonly opts: PriceScaleOptions;
  private readonly logMin: number;
  private readonly logMax: number;
  private readonly useLog: boolean;

  constructor(opts: PriceScaleOptions) {
    let { min, max } = opts;
    if (!(Number.isFinite(min) && Number.isFinite(max)) || max < min) {
      min = 0;
      max = 1;
    }
    if (max - min < Math.max(1e-12, Math.abs(max) * 1e-9)) max = min + Math.max(1e-9, Math.abs(min) * 1e-6 || 1);
    this.opts = { ...opts, min, max };
    this.useLog = opts.mode === 'log' && min > 0;
    this.logMin = Math.log10(Math.max(this.useLog ? min : 1, 1e-12));
    this.logMax = Math.log10(Math.max(max, 1e-12));
  }

  get min(): number {
    return this.opts.min;
  }

  get max(): number {
    return this.opts.max;
  }

  get mode(): PriceScaleMode {
    return this.useLog ? 'log' : 'linear';
  }

  get height(): number {
    return Math.max(1, this.opts.bottom - this.opts.top);
  }

  /** Pixel pitch a tick is aimed at; 56 px is the pitch used before the setting existed. */
  private tickPx(): number {
    const wanted = this.opts.tickPx;
    return typeof wanted === 'number' && wanted >= 16 && wanted <= 240 ? wanted : 56;
  }

  toY(price: number): number {
    const { min, max, top, bottom } = this.opts;
    const value = Number.isFinite(price) ? price : min;
    const ratio = this.useLog
      ? (Math.log10(Math.max(value, min)) - this.logMin) / (this.logMax - this.logMin || 1)
      : (value - min) / (max - min);
    return bottom - ratio * (bottom - top);
  }

  fromY(y: number): number {
    const { min, max, top, bottom } = this.opts;
    const ratio = (bottom - y) / Math.max(1, bottom - top);
    if (this.useLog) return Math.pow(10, this.logMin + ratio * (this.logMax - this.logMin));
    return min + ratio * (max - min);
  }

  /** Ticks: 1-2-5 ladder for linear, decade 1/2/5 pattern for log. */
  ticks(): AxisTick[] {
    return this.useLog ? this.logTicks() : this.linearTicks();
  }

  private linearTicks(): AxisTick[] {
    const { min, max, precision } = this.opts;
    const target = Math.max(2, Math.round(this.height / this.tickPx()));
    const step = niceStep((max - min) / target);
    const decimals = Math.min(precision, Math.max(0, decimalsForStep(step)));
    const ticks: AxisTick[] = [];
    const start = Math.ceil(min / step) * step;
    for (let value = start; value <= max + step * 0.5 && ticks.length < 64; value += step) {
      ticks.push({ value, label: fmtNumber(value, decimals), major: false });
    }
    return ticks;
  }

  private logTicks(): AxisTick[] {
    const { min, max, precision } = this.opts;
    const span = this.logMax - this.logMin;
    // Under one decade the 1/2/5-per-decade pattern lands nowhere near the range, so
    // narrow ranges get ordinary nice steps placed on the log spacing instead.
    if (span < 1) return this.linearTicks();
    const target = Math.max(2, Math.round(this.height / this.tickPx()));
    const perDecade = Math.max(1, Math.min(3, Math.floor(target / Math.max(span, 0.2))));
    const multipliers = perDecade >= 3 ? [1, 2, 5] : perDecade === 2 ? [1, 2] : [1];
    const ticks: AxisTick[] = [];
    const firstDecade = Math.floor(this.logMin);
    const lastDecade = Math.ceil(this.logMax);
    for (let exponent = firstDecade; exponent <= lastDecade && ticks.length < 64; exponent += 1) {
      for (const multiplier of multipliers) {
        const value = multiplier * Math.pow(10, exponent);
        if (value < min || value > max) continue;
        const decimals = Math.min(precision, Math.max(0, decimalsForStep(value / (multipliers.length * 2))));
        ticks.push({ value, label: fmtNumber(value, decimals), major: multiplier === 1 });
      }
    }
    return ticks;
  }
}

/** Value-to-pixel mapping for the volume pane: always zero-based, never log. */
export class VolumeScale {
  constructor(
    private readonly max: number,
    private readonly top: number,
    private readonly bottom: number,
  ) {}

  toY(value: number): number {
    const height = Math.max(1, this.bottom - this.top);
    if (!(this.max > 0) || !Number.isFinite(value) || value <= 0) return this.bottom;
    return this.bottom - Math.min(1, value / this.max) * height;
  }
}
