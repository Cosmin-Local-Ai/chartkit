/** Interval metadata. Keys are the wire form the server parses, e.g. `15m`, `tick:100`. */

export interface TimeframeDef {
  key: string;
  label: string;
  /** Nominal span of one bar in ms; null for calendar and count-based intervals. */
  ms: number | null;
}

export const TIMEFRAMES: TimeframeDef[] = [
  { key: '1s', label: '1s', ms: 1_000 },
  { key: '15s', label: '15s', ms: 15_000 },
  { key: '1m', label: '1m', ms: 60_000 },
  { key: '3m', label: '3m', ms: 180_000 },
  { key: '5m', label: '5m', ms: 300_000 },
  { key: '15m', label: '15m', ms: 900_000 },
  { key: '30m', label: '30m', ms: 1_800_000 },
  { key: '1h', label: '1h', ms: 3_600_000 },
  { key: '2h', label: '2h', ms: 7_200_000 },
  { key: '4h', label: '4h', ms: 14_400_000 },
  { key: '1d', label: '1D', ms: 86_400_000 },
  { key: '3d', label: '3D', ms: 259_200_000 },
  { key: '1w', label: '1W', ms: 604_800_000 },
  { key: '1mo', label: '1M', ms: null },
  { key: 'session', label: 'Sess', ms: null },
];

const BY_KEY = new Map(TIMEFRAMES.map((def) => [def.key, def]));

export function timeframeDef(key: string): TimeframeDef {
  return BY_KEY.get(key) ?? { key, label: key, ms: null };
}

export function timeframeMs(key: string): number | null {
  return timeframeDef(key).ms;
}

/**
 * Nominal spacing between bars. Count-based and calendar intervals report no span,
 * so fall back to the median gap of the stored bars, which keeps the time axis and
 * gap detection working for `1mo`, `session`, `tick:N` and `vol:N` alike.
 */
export function estimateBarMs(bars: { start: number }[], declared: number | null, fallback = 60_000): number {
  if (declared && declared > 0) return declared;
  if (bars.length < 2) return fallback;
  const gaps: number[] = [];
  const step = Math.max(1, Math.floor(bars.length / 60));
  for (let i = step; i < bars.length; i += step) {
    const prev = bars[i - step];
    const current = bars[i];
    if (prev && current) gaps.push(current.start - prev.start);
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)] ?? 0;
  return median > 0 ? median : fallback;
}
