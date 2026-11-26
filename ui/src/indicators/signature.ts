/**
 * Change detection for indicator results.
 *
 * The renderer asks for results on every frame, so both the built-in path in
 * `engine.ts` and the user-script path in `script/runtime.ts` need to know cheaply
 * whether anything a series can depend on actually moved. They share these three
 * signatures so a live tick drags a recompute along exactly once, however the series
 * was produced.
 */

import type { Bar } from '../types';
import type { SizeBandFlow } from '../sizeBands';
import type { PrintFlow } from './flow';
import type { ParamValues } from './registry';

/** Bars signature: length plus the newest bar, which is all a recompute can depend on. */
export function barsSignature(bars: readonly Bar[]): string {
  const first = bars[0];
  const last = bars[bars.length - 1];
  if (!first || !last) return 'empty';
  return `${bars.length}:${first.start}:${last.start}:${last.close}:${last.closed ? 1 : 0}`;
}

/**
 * Print window signature: the covered range plus the print count behind it, which is
 * all a delta series can depend on.
 */
export function flowSignature(flow: PrintFlow | null): string {
  if (!flow) return 'none';
  return `${flow.instrument}:${flow.timeframe}:${flow.coveredFrom}:${flow.coveredTo}:${flow.prints}:${flow.loading ? 1 : 0}`;
}

/**
 * Size-band window signature: the covered range, the print count behind it and the bands
 * the answer named. A different ladder is a different series even over the same prints, so
 * the band names belong in the key.
 */
export function bandSignature(bands: SizeBandFlow | null): string {
  if (!bands) return 'none';
  const labels = bands.bands.map((band) => band.label).join('|');
  return `${bands.instrument}:${bands.timeframe}:${labels}:${bands.coveredFrom}:${bands.coveredTo}:${bands.prints}:${bands.loading ? 1 : 0}`;
}

export function paramsSignature(params: ParamValues): string {
  return JSON.stringify(params);
}
