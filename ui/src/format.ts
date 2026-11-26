/** Number and time formatting. Prices always use the instrument's own precision. */

const groupCache = new Map<string, Intl.NumberFormat>();

function grouped(decimals: number): Intl.NumberFormat {
  const key = String(decimals);
  let format = groupCache.get(key);
  if (!format) {
    format = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    groupCache.set(key, format);
  }
  return format;
}

function clampDecimals(decimals: number): number {
  return Math.max(0, Math.min(12, Math.round(decimals)));
}

export function fmtNumber(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return '—';
  return grouped(clampDecimals(decimals)).format(value);
}

/** Decimal places needed to show increments of `step` without rounding away a tick. */
export function decimalsForStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 2;
  if (step >= 1) return 0;
  return Math.min(12, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
}

/**
 * Price label. Digits never exceed the instrument's `pricePrecision`, and trailing
 * zeros are dropped so a venue that publishes eight decimals still reads cleanly.
 */
export function fmtPrice(value: number, precision: number): string {
  const text = fmtNumber(value, precision);
  if (!text.includes('.')) return text;
  return text.replace(/0+$/, '').replace(/\.$/, '');
}

/** Quantity label: compact above 10k, otherwise the venue's precision with no trailing zeros. */
export function fmtSize(value: number, precision: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 10_000) return fmtCompact(value);
  return fmtPrice(value, precision);
}

const UNITS = ['', 'K', 'M', 'B', 'T'];

export function fmtCompact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const magnitude = Math.abs(value);
  if (magnitude < 1000) return sign + magnitude.toFixed(magnitude < 10 && magnitude % 1 !== 0 ? 2 : 0);
  let index = 0;
  let scaled = magnitude;
  while (scaled >= 1000 && index < UNITS.length - 1) {
    scaled /= 1000;
    index += 1;
  }
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${sign}${scaled.toFixed(digits)}${UNITS[index] ?? ''}`;
}

export function fmtSigned(value: number, decimals: number): string {
  const text = fmtPrice(Math.abs(value), decimals);
  if (value > 0) return `+${text}`;
  if (value < 0) return `-${text}`;
  return text;
}

export function fmtPct(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(2)}%`;
}

/** 1-2-5 ladder step at or above `raw`; the backbone of both axis tick selection. */
export function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalized = raw / magnitude;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return multiplier * magnitude;
}

export function roundToStep(value: number, step: number): number {
  if (!(step > 0)) return value;
  return Math.round(value / step) * step;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

type Style = 'clock' | 'clockSeconds' | 'day' | 'month' | 'year' | 'full' | 'dateTime';

const utcFormatters = new Map<Style, Intl.DateTimeFormat>();

function utcFormatter(style: Style): Intl.DateTimeFormat {
  let format = utcFormatters.get(style);
  if (!format) {
    const options: Intl.DateTimeFormatOptions = { timeZone: 'UTC', hour12: false };
    if (style === 'clock') Object.assign(options, { hour: '2-digit', minute: '2-digit' });
    else if (style === 'clockSeconds') Object.assign(options, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    else if (style === 'day') Object.assign(options, { day: '2-digit', month: 'short' });
    else if (style === 'month') Object.assign(options, { month: 'short' });
    else if (style === 'year') Object.assign(options, { year: 'numeric' });
    else if (style === 'dateTime')
      Object.assign(options, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    else Object.assign(options, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    format = new Intl.DateTimeFormat('en-GB', options);
    utcFormatters.set(style, format);
  }
  return format;
}

function parts(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

const tzFormatters = new Map<string, Intl.DateTimeFormat>();

function tzFormatter(tz: string): Intl.DateTimeFormat {
  let format = tzFormatters.get(tz);
  if (!format) {
    format = parts(tz);
    tzFormatters.set(tz, format);
  }
  return format;
}

/**
 * Converts instants to wall-clock time in the instrument's session timezone by
 * shifting the timestamp, so axis labels can be produced from plain UTC formatters
 * without one Intl call per bar.
 */
export class LocalTime {
  private offset = 0;
  private offsetAt = Number.NaN;

  constructor(readonly timeZone: string) {}

  /** UTC offset of the zone at `ms`, refreshed hourly so DST edges stay correct. */
  offsetFor(ms: number): number {
    const bucket = Math.floor(ms / HOUR_MS);
    if (bucket === this.offsetAt) return this.offset;
    this.offsetAt = bucket;
    try {
      const fields = tzFormatter(this.timeZone).formatToParts(new Date(ms));
      const pick = (type: string): number => Number(fields.find((f) => f.type === type)?.value ?? '0');
      const wall = Date.UTC(pick('year'), pick('month') - 1, pick('day'), pick('hour') % 24, pick('minute'), pick('second'));
      this.offset = wall - Math.floor(ms / 1000) * 1000;
    } catch {
      this.offset = 0; // unknown zone: fall back to venue time, which is UTC
    }
    return this.offset;
  }

  local(ms: number): number {
    return ms + this.offsetFor(ms);
  }

  format(ms: number, style: Style): string {
    return utcFormatter(style).format(new Date(this.local(ms)));
  }

  /** Local midnight (start of the trading day) that contains or precedes `ms`. */
  startOfDay(ms: number): number {
    const shifted = this.local(ms);
    return Math.floor(shifted / DAY_MS) * DAY_MS - this.offsetFor(ms);
  }

  dayKey(ms: number): number {
    return Math.floor(this.local(ms) / DAY_MS);
  }

  hourKey(ms: number): number {
    return Math.floor(this.local(ms) / HOUR_MS);
  }

  minuteKey(ms: number): number {
    return Math.floor(this.local(ms) / 60_000);
  }

  secondKey(ms: number): number {
    return Math.floor(this.local(ms) / 1000);
  }

  /** Weekday in the session zone: 0 = Monday, matching the server's session windows. */
  weekday(ms: number): number {
    const shifted = this.local(ms);
    return (new Date(shifted).getUTCDay() + 6) % 7;
  }

  clock(ms: number): string {
    return this.format(ms, 'clock');
  }

  /** Parses a session window "HH:MM" into minutes since local midnight. */
  static parseClockTime(text: string): number {
    const match = /^(\d{1,2}):(\d{2})$/.exec(text);
    if (!match) return 0;
    return Number(match[1]) * 60 + Number(match[2]);
  }
}

export function fmtAge(ms: number, now: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'never';
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}
