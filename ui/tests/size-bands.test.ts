/**
 * Checks for the client's side of the size-band split.
 *
 * The bands are decided by the server (`crates/server/src/api.rs`), so what is tested here
 * is the client's reading of them: that a size lands in exactly one band of the ladder the
 * response named, that a window with no prints stays unknown instead of plotting zeros,
 * that a window with prints in one band only leaves the other bands flat rather than
 * missing, and that the per-band lines add back up to the plain delta the prints give.
 *
 * Run it with:
 *   npx rolldown tests/size-bands.test.ts -o /tmp/size-bands-test.mjs -f esm && node /tmp/size-bands-test.mjs
 */

// The test runs in node, whose globals the DOM-only tsconfig does not carry.
declare const process: { exitCode: number };

import type { Bar, SizeBand, SizeBandCell, SizeBandSeries } from '../src/types';
import { defaultsFor, indicatorById, type IndicatorDefinition } from '../src/indicators/registry';
import { cumulativeDelta, printFlow } from '../src/indicators/flow';
import {
  bandCumulative,
  bandEdges,
  bandIndexFor,
  bandLabelFor,
  bandTotalDelta,
  sizeBandFlow,
  sizeBandNote,
} from '../src/sizeBands';

const failures: string[] = [];
const BAR_MS = 60_000;
/** A UTC midnight, so the day anchor the CVD lines restart on is easy to see. */
const FIRST_BAR = Date.UTC(2026, 10, 20, 0, 0, 0);
const BARS: Bar[] = Array.from({ length: 8 }, (_, index) => ({
  start: FIRST_BAR + index * BAR_MS,
  open: 60_000,
  high: 60_100,
  low: 59_900,
  close: 60_000 + index,
  volume: 10 + index,
  trades: 4 + index,
  closed: true,
}));

/** The ladder the server answers with when nothing else is asked for. */
const STANDARD: SizeBand[] = [
  { min: null, max: 1_000, label: 'under 1k' },
  { min: 1_000, max: 10_000, label: '1k to 10k' },
  { min: 10_000, max: 100_000, label: '10k to 100k' },
  { min: 100_000, max: null, label: '100k and up' },
];

function definitionOf(id: string): IndicatorDefinition {
  const definition = indicatorById(id);
  if (!definition) throw new Error(`no indicator ${id}`);
  return definition;
}

/* ------------------------------------------------------------------ band edges */

{
  // A band is `[min, max)`: the check below is the definition, and the client's index has
  // to agree with it for every size, including one sitting exactly on an edge.
  const inside = (size: number, band: SizeBand): boolean =>
    (band.min === null || size >= band.min) && (band.max === null || size < band.max);
  const sizes = [
    0, 1, 999.99, 1_000, 1_000.01, 9_999.99, 10_000, 10_000.01, 99_999.99, 100_000, 100_000.01, 5_000_000,
  ];
  let wrong = 0;
  for (const size of sizes) {
    const matches = STANDARD.filter((band) => inside(size, band));
    const index = bandIndexFor(size, STANDARD);
    if (matches.length !== 1) {
      failures.push(`${size} falls in ${matches.length} bands by the interval definition`);
      wrong += 1;
      continue;
    }
    if (STANDARD[index] !== matches[0]) {
      failures.push(`${size}: the client says "${STANDARD[index]?.label}", the interval says "${matches[0]?.label}"`);
      wrong += 1;
    }
  }
  const onEdge = sizes.filter((size) => [1_000, 10_000, 100_000].includes(size));
  console.log(
    `band assignment: ${sizes.length} sizes, ${wrong === 0 ? 'each in exactly one band' : `${wrong} misplaced`}; ` +
      `a size exactly on an edge (${onEdge.join(', ')}) belongs to the band above it: ` +
      onEdge.map((size) => `${size}→${bandLabelFor(STANDARD, size)}`).join(' '),
  );
  if (bandLabelFor(STANDARD, 1_000) !== '1k to 10k') failures.push('a size exactly on an edge was placed in the band below');
  if (bandLabelFor(STANDARD, 100_000) !== '100k and up') failures.push('a size exactly on the top edge left the top band');

  // The edges are read out of the response, never rebuilt: a ladder with a different
  // number of bands has to change both the edge list and the labels.
  const edges = bandEdges(STANDARD);
  if (JSON.stringify(edges) !== JSON.stringify([1_000, 10_000, 100_000])) {
    failures.push(`the standard ladder's edges read back as ${JSON.stringify(edges)}`);
  }
  const two: SizeBand[] = [
    { min: null, max: 5, label: 'under 5' },
    { min: 5, max: null, label: '5 and up' },
  ];
  if (JSON.stringify(bandEdges(two)) !== JSON.stringify([5])) failures.push('an open top band should contribute no edge');
  if (bandIndexFor(5, two) !== 1) failures.push('a two-band ladder put its edge in the wrong band');
  console.log(`edges come from the response: 4 bands → [${edges}], 2 bands → [${bandEdges(two)}]`);
}

/* ------------------------------------------------------------------ empty window */

{
  const loading = sizeBandFlow(null, true);
  const waiting = sizeBandNote(loading);
  const empty = sizeBandFlow(emptySeries(STANDARD), false);
  const nothing = sizeBandNote(empty);
  const lines = definitionOf('CVD_BY_SIZE').compute(BARS, defaultsFor(definitionOf('CVD_BY_SIZE')), null, empty);
  const allUnknown = lines.plots.every((plot) => plot.values.every((value) => !Number.isFinite(value)));

  console.log(
    `empty window: ${lines.plots.length} lines, every value unknown (${allUnknown ? 'yes' : 'NO'}), ` +
      `while loading says "${waiting}", with no prints says "${nothing}"`,
  );
  if (!allUnknown) failures.push('an empty window plotted values it has no prints for');
  if (waiting !== 'loading size bands…') failures.push(`a pending window said "${waiting}"`);
  if (nothing !== 'no prints stored for this window') failures.push(`an uncovered window said "${nothing}"`);
  if (!lines.note) failures.push('the empty window drew its lines without saying why');
  if (bandTotalDelta(empty, 0) !== 0) failures.push('an empty window reported delta on a band');
}

/* ------------------------------------------------------------------ one band only */

{
  // Every print of the window is small, so the upper bands are present in the answer and
  // empty in it, which is different from the answer not carrying them at all.
  const cells = BARS.map((_, index) => [cell(index + 1, index), cell(0, 0), cell(0, 0), cell(0, 0)]);
  const series = seriesWith(STANDARD, BARS, cells);
  const flow = sizeBandFlow(series, false);
  const first = bandCumulative(BARS, flow, 0, 'Continuous');
  const top = bandCumulative(BARS, flow, 3, 'Continuous');
  // Each bar trades (index + 1) bought and index sold, so the line climbs by one a bar.
  const expected = BARS.map((_, index) => index + 1);
  const off = first.map((value, index) => Math.abs(value - expected[index]!));
  const flat = top.every((value) => value === 0);

  console.log(
    `prints in one band: band 0 ends at ${first[first.length - 1]} against ${expected[expected.length - 1]} counted by hand ` +
      `(worst ${Math.max(...off)}), the empty top band stays flat at zero (${flat ? 'yes' : 'NO'})`,
  );
  if (Math.max(...off) > 1e-12) failures.push('the only band with prints did not track it');
  if (!flat) failures.push('a band the window never used plotted something other than zero');
  if (bandTotalDelta(flow, 3) !== 0) failures.push('an unused band reported delta');
  if (bandTotalDelta(flow, 0) !== expected[expected.length - 1]!) {
    failures.push(`the used band reported ${bandTotalDelta(flow, 0)} against ${expected[expected.length - 1]}`);
  }
  const note = sizeBandNote(flow);
  if (!note?.startsWith('prints stored from')) failures.push(`a covered window said "${note}"`);
}

/* ------------------------------------------------------------------ every band, against the plain delta */

{
  const cells = BARS.map((_, index) => {
    const retail = cell(3 + index, 1 + index);
    const mid = cell(2, 4);
    const block = cell(0.5, 0);
    const whale = cell(0, 0.25 * index);
    return [retail, mid, block, whale];
  });
  const series = seriesWith(STANDARD, BARS, cells);
  const flow = sizeBandFlow(series, false);

  // The same bars as a plain delta window: each bar's buy and sell are the sum of its
  // bands, so the four lines have to add up to the one line the prints give.
  const plain = printFlow(
    {
      instrument: 'TEST:AAA',
      timeframe: '1m',
      priceTick: 0.01,
      cvd: [],
      bars: BARS.map((bar, index) => {
        const row = cells[index]!;
        const buy = row.reduce((total, cellRow) => total + cellRow.buyQty, 0);
        const sell = row.reduce((total, cellRow) => total + cellRow.sellQty, 0);
        return {
          start: bar.start,
          cells: [],
          totalQty: buy + sell,
          delta: buy - sell,
          trades: row.reduce((total, cellRow) => total + cellRow.buyN + cellRow.sellN, 0),
          poc: bar.close,
          buyImbalance: [],
          sellImbalance: [],
        };
      }),
    },
    false,
  );
  const reference = cumulativeDelta(BARS, plain, 'Continuous');
  const lines = [0, 1, 2, 3].map((band) => bandCumulative(BARS, flow, band, 'Continuous'));
  let worst = 0;
  for (let index = 0; index < BARS.length; index += 1) {
    const sum = lines.reduce((total, line) => total + (line[index] ?? 0), 0);
    worst = Math.max(worst, Math.abs(sum - reference[index]!));
  }
  console.log(
    `${BARS.length} bars × 4 bands: the four lines add up to the plain CVD at every bar ` +
      `(worst ${worst.toExponential(2)}), window delta ${flow.totals.reduce((t, c) => t + c.buyQty - c.sellQty, 0).toFixed(4)} ` +
      `against prints' ${plain.byStart.size} covered bars`,
  );
  if (!(worst <= 1e-12)) failures.push(`the bands disagree with the plain delta by ${worst}`);

  // A bar the answer does not carry stays unknown rather than continuing the line at the
  // last known total, and it does not move the running total either.
  const holed = sizeBandFlow({ ...series, bars: series.bars.filter((_, index) => index !== 3) }, false);
  const holedLine = bandCumulative(BARS, holed, 0, 'Continuous');
  const wholeLine = bandCumulative(BARS, flow, 0, 'Continuous');
  const gapAt = 3;
  const stillRising = (holedLine[4] ?? Number.NaN) === (wholeLine[4] ?? Number.NaN) - (cells[3]![0]!.buyQty - cells[3]![0]!.sellQty);
  console.log(
    `a bar missing from the answer: value at that bar unknown (${!Number.isFinite(holedLine[gapAt]!)}), ` +
      `the line resumes without inventing volume (${stillRising})`,
  );
  if (Number.isFinite(holedLine[gapAt]!)) failures.push('a bar with no answer plotted a value anyway');
  if (!stillRising) failures.push('a missing bar moved the running total');

  // The day anchor restarts each band's line on a UTC day boundary, as the plain CVD does.
  const twoDays = BARS.concat(
    BARS.map((bar, index) => ({ ...bar, start: bar.start + 24 * 3_600_000, close: bar.close + index })),
  );
  const twoDayCells = cells.concat(cells);
  const dayFlow = sizeBandFlow(seriesWith(STANDARD, twoDays, twoDayCells), false);
  const daily = bandCumulative(twoDays, dayFlow, 0, 'UTC day');
  const restarted = daily[BARS.length] === twoDayCells[0]![0]!.buyQty - twoDayCells[0]![0]!.sellQty;
  console.log(`the UTC day anchor restarts each band's line: ${restarted ? 'yes' : 'NO'}`);
  if (!restarted) failures.push('the day anchor did not restart the band line');
}

/* ------------------------------------------------------------------ the indicator follows the response */

{
  const definition = definitionOf('CVD_BY_SIZE');
  const two: SizeBand[] = [
    { min: null, max: 5, label: 'under 5' },
    { min: 5, max: null, label: '5 and up' },
  ];
  const cells = BARS.map((_, index) => [cell(index, 0), cell(0, index)]);
  const flow = sizeBandFlow(seriesWith(two, BARS, cells), false);
  const result = definition.compute(BARS, defaultsFor(definition), null, flow);
  const labels = result.plots.map((plot) => plot.label);
  console.log(
    `the indicator names its lines after the bands the server sent: ${result.plots.length} lines [${labels.join(', ')}]`,
  );
  if (labels.length !== 2 || labels[0] !== 'under 5' || labels[1] !== '5 and up') {
    failures.push(`a two-band answer drew [${labels.join(', ')}]`);
  }
  const withoutWindow = definition.compute(BARS, defaultsFor(definition), null, null);
  if (withoutWindow.plots.length === 0) failures.push('CVD by Size drew nothing before a window arrived');
  if (!withoutWindow.note) failures.push('CVD by Size drew its lines without a coverage note');
  if (definition.needsSizeBands !== true) failures.push('CVD by Size does not declare that it reads the size-band window');
  console.log(
    `before any window: ${withoutWindow.plots.length} lines, all unknown (${withoutWindow.plots.every((p) =>
      p.values.every((value) => !Number.isFinite(value)),
    )}), note "${withoutWindow.note}"`,
  );
}

/* ------------------------------------------------------------------ report */

if (failures.length > 0) {
  console.log(`FAILED (${failures.length}):`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('all checks passed');
}

function cell(buyQty: number, sellQty: number, prints = 1): SizeBandCell {
  return { buyQty, sellQty, buyN: prints, sellN: prints };
}

/** A response over `bars`, one row of band cells per bar, with totals summed from them. */
function seriesWith(bands: SizeBand[], bars: readonly Bar[], rows: SizeBandCell[][]): SizeBandSeries {
  let running = bands.map(() => 0);
  const totals = bands.map(() => cell(0, 0, 0));
  const barRows = bars.map((bar, index) => {
    const row = rows[index] ?? bands.map(() => cell(0, 0, 0));
    running = running.map((value, band) => value + (row[band]?.buyQty ?? 0) - (row[band]?.sellQty ?? 0));
    row.forEach((entry, band) => {
      const total = totals[band]!;
      total.buyQty += entry.buyQty;
      total.sellQty += entry.sellQty;
      total.buyN += entry.buyN;
      total.sellN += entry.sellN;
    });
    return {
      start: bar.start,
      bands: row,
      cumulative: running.slice(),
      totalQty: row.reduce((sum, entry) => sum + entry.buyQty + entry.sellQty, 0),
      delta: row.reduce((sum, entry) => sum + entry.buyQty - entry.sellQty, 0),
      trades: row.reduce((sum, entry) => sum + entry.buyN + entry.sellN, 0),
    };
  });
  return {
    instrument: 'TEST:AAA',
    timeframe: '1m',
    from: bars[0]?.start ?? null,
    to: (bars[bars.length - 1]?.start ?? 0) + BAR_MS,
    priceTick: 0.01,
    stepTicks: 1,
    sizeUnit: 'notional',
    bandRule: 'named ladder standard: quote notional per print, 1k / 10k / 100k',
    bands,
    bars: barRows,
    levels: [],
    totals,
    prints: barRows.reduce((sum, row) => sum + row.trades, 0),
    totalQty: barRows.reduce((sum, row) => sum + row.totalQty, 0),
    delta: barRows.reduce((sum, row) => sum + row.delta, 0),
  };
}

/** A response that carries the bands and nothing else: the window held no prints. */
function emptySeries(bands: SizeBand[]): SizeBandSeries {
  return { ...seriesWith(bands, [], []), from: null, to: null };
}
