/**
 * Cluster search: the client's reading of a search answer.
 *
 * The server filters the stored prints in SQL, so what is checked here is how the answer is
 * rendered and what it is allowed to claim: rows are listed newest first and narrowed by
 * aggressor and text without changing what the window held, the numbers on a row are the
 * numbers the server sent, the per-bar marks sit at the volume-weighted price of the cluster
 * prints rather than the bar's close, and the one line under the list distinguishes a search
 * that failed from a window with no prints, from a window whose prints were all too small,
 * from a list the row cap cut short.
 *
 * Run it from `ui/` with:
 *   npx rolldown tests/cluster-search.test.ts -o /tmp/cluster-search-test.mjs -f esm && node /tmp/cluster-search-test.mjs
 * The last section reads source files from disk, so the working directory has to be `ui/`.
 */

// The test runs in node, whose globals the DOM-only tsconfig does not carry.
declare const process: { exitCode: number };

import { readFileSync } from 'node:fs';

import type { ClusterBar, ClusterPrint, ClusterSearchSeries } from '../src/types';
import {
  barStartFor,
  clusterSearchNote,
  clusterSearchState,
  emptyClusterSearch,
  fmtSizeLabel,
  markerBars,
  markerPrice,
  markerSide,
  noRowFilter,
  printKey,
  rowCells,
  selectRows,
  type ClusterRequest,
} from '../src/clusterSearch';
import { ClusterMarkers } from '../src/panes/clusterMarkers';
import { ChartView } from '../src/view';
import { XScale } from '../src/scale';
import { LocalTime } from '../src/format';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed += 1;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

const BAR_MS = 60_000;
/** A UTC midnight, so the fixed clock below and the bar maths are easy to read. */
const FIRST = Date.UTC(2026, 10, 20, 12, 0, 0);

/** A fixed clock, so a row can be shown to print the chart's time rather than the browser's. */
const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 19);

function print(ts: number, seq: number, price: number, qty: number, buy: boolean): ClusterPrint {
  return { ts, seq, price, qty, notional: price * qty, aggressor: buy ? 'buy' : 'sell' };
}

/** Rows newest first, as the server sends them: two minutes of prints, one bar each. */
const ROWS: ClusterPrint[] = [
  print(FIRST + 61_000, 12, 60_000.5, 12.5, false),
  print(FIRST + 60_000, 11, 59_999.25, 0.75, true),
  print(FIRST + 1_000, 9, 60_100, 40_000, true),
  print(FIRST + 1_000, 4, 60_100, 2, false),
];

const BARS: ClusterBar[] = [
  { start: FIRST, prints: 2, buyN: 1, sellN: 1, qty: 40_002, notional: 40_002 * 60_100 },
  { start: FIRST + BAR_MS, prints: 2, buyN: 1, sellN: 1, qty: 13.25, notional: 13.25 * 60_000 },
  { start: FIRST + 2 * BAR_MS, prints: 0, buyN: 0, sellN: 0, qty: 0, notional: 0 },
];

function series(over: Partial<ClusterSearchSeries> = {}): ClusterSearchSeries {
  return {
    instrument: 'BINANCE:BTCUSDT',
    timeframe: '1m',
    from: FIRST,
    to: FIRST + 2 * BAR_MS,
    sizeUnit: 'notional',
    sizeRule: 'at or above 5k quote notional per print',
    threshold: 5_000,
    prints: 278_412,
    clusters: ROWS.length,
    returned: ROWS.length,
    limit: 400,
    truncated: false,
    clusterQty: ROWS.reduce((sum, row) => sum + row.qty, 0),
    clusterNotional: ROWS.reduce((sum, row) => sum + row.notional, 0),
    buyN: 2,
    sellN: 2,
    rows: ROWS,
    bars: BARS,
    ...over,
  };
}

function asked(over: Partial<ClusterRequest> = {}): ClusterRequest {
  return {
    instrument: 'BINANCE:BTCUSDT',
    timeframe: '1m',
    from: FIRST,
    to: FIRST + 2 * BAR_MS,
    threshold: 5_000,
    unit: 'notional',
    ...over,
  };
}

const PRECISION = { price: 2, qty: 4 };

// ------------------------------------------------------------------ listing rows

const listed = selectRows(series(), noRowFilter(), clock, PRECISION.price, PRECISION.qty);
check('an unfiltered list keeps every row the server sent', listed.length === ROWS.length, json(listed.length));
check('the list stays newest first', listed.map((row) => row.ts).every((ts, at, all) => at === 0 || all[at - 1]! >= ts), json(listed.map((row) => row.ts)));
check('an unfiltered list is a copy, so the caller cannot reorder the answer', listed !== series().rows);
check('a null answer lists nothing rather than throwing', selectRows(null, noRowFilter(), clock, 2, 3).length === 0);

const buys = selectRows(series(), { side: 'buy', text: '' }, clock, PRECISION.price, PRECISION.qty);
const sells = selectRows(series(), { side: 'sell', text: '' }, clock, PRECISION.price, PRECISION.qty);
check('the buy filter keeps only buys', buys.length === 2 && buys.every((row) => row.aggressor === 'buy'), json(buys.map((row) => row.aggressor)));
check('the sell filter keeps only sells, and the two halves add up to the list', sells.length === 2 && buys.length + sells.length === ROWS.length, json(sells.length));

const byPrice = selectRows(series(), { side: 'all', text: '60,100' }, clock, PRECISION.price, PRECISION.qty);
check('text matches the price as the table prints it, thousands separator and all', byPrice.length === 2 && byPrice.every((row) => row.ts === FIRST + 1_000), json(byPrice.map((row) => row.ts)));
const bySide = selectRows(series(), { side: 'all', text: 'SELL' }, clock, PRECISION.price, PRECISION.qty);
check('text is matched case-insensitively against the side cell', bySide.length === 2 && bySide.every((row) => row.aggressor === 'sell'), json(bySide.length));
const bySize = selectRows(series(), { side: 'all', text: '40.0k' }, clock, PRECISION.price, PRECISION.qty);
check('text matches the size cell, written compact', bySize.length === 1 && bySize[0]!.seq === 9, json(bySize.map((row) => row.seq)));
const byTime = selectRows(series(), { side: 'all', text: '12:01:00' }, clock, PRECISION.price, PRECISION.qty);
check('text matches the time cell, in the chart clock rather than the browser clock', byTime.length === 1 && byTime[0]!.seq === 11, json(byTime.map((row) => row.seq)));
check('surrounding spaces do not break a filter', selectRows(series(), { side: 'all', text: '  60,100  ' }, clock, 2, 4).length === 2);
check('a filter that matches nothing lists nothing', selectRows(series(), { side: 'all', text: 'nope' }, clock, 2, 4).length === 0);
check('the two filters combine', selectRows(series(), { side: 'buy', text: '60,100' }, clock, 2, 4).map((row) => row.seq).join() === '9');

// ---------------------------------------------------------------- formatting a row

const cells = rowCells(ROWS[0]!, clock, 2, 4);
check('the time cell is the caller\'s clock, not a formatting choice of the module', cells.time === '12:01:01', cells.time);
check('the price cell is written at the instrument\'s precision', cells.price === '60,000.5', cells.price);
check('the size cell is written at the instrument\'s quantity precision', cells.size === '12.5', cells.size);
check('the notional cell carries the notional the server filtered on, not the quantity', cells.notional === '750K', cells.notional);
check('the side cell is the aggressor in words', cells.side === 'sell', cells.side);
check('a large size is written compact rather than as eight digits', rowCells(ROWS[2]!, clock, 2, 4).size === '40.0K', rowCells(ROWS[2]!, clock, 2, 4).size);
check('an unknown number is written as a dash, never as NaN', rowCells(print(1, 1, Number.NaN, Number.NaN, true), clock, 2, 4).price === '—');

check('two prints of one millisecond have different keys', printKey(ROWS[2]!) !== printKey(ROWS[3]!) && printKey(ROWS[2]!) === `${FIRST + 1_000}:9`, printKey(ROWS[2]!));
check('a print is aligned down to its own bar', barStartFor(FIRST + 61_000, BAR_MS) === FIRST + BAR_MS);
check('a print exactly on a bar start stays on that bar', barStartFor(FIRST + BAR_MS, BAR_MS) === FIRST + BAR_MS);
check('an unusable interval leaves the timestamp alone', barStartFor(FIRST + 61_000, 0) === FIRST + 61_000);
check('a threshold is written the way the band edges are', `${fmtSizeLabel(5_000)}|${fmtSizeLabel(1_500_000)}|${fmtSizeLabel(0.25)}|${fmtSizeLabel(25_000)}` === '5k|1.5M|0.25|25k', `${fmtSizeLabel(5_000)}|${fmtSizeLabel(1_500_000)}`);

// ---------------------------------------------------------------- the marks

check('a bar is marked at the volume-weighted price of its cluster prints', Math.abs(markerPrice(BARS[1]!) - 60_000) < 1e-9, String(markerPrice(BARS[1]!)));
check('a bar with no cluster prints has no price to mark', Number.isNaN(markerPrice(BARS[2]!)));
check('a negative or empty notional is treated as unmarkable, not as zero', Number.isNaN(markerPrice({ start: 0, prints: 3, buyN: 3, sellN: 0, qty: -1, notional: -100 })));
check('only bars that hold a cluster are marked', markerBars(series()).map((bar) => bar.start).join() === `${FIRST},${FIRST + BAR_MS}`, json(markerBars(series()).map((bar) => bar.start)));
check('no answer means no marks', markerBars(null).length === 0);
check('a bar that split evenly is not called a buy', markerSide(BARS[0]!) === 'mixed');
check('a bar that leans one way is called that way', markerSide({ start: 0, prints: 4, buyN: 3, sellN: 1, qty: 1, notional: 1 }) === 'buy' && markerSide({ start: 0, prints: 4, buyN: 1, sellN: 3, qty: 1, notional: 1 }) === 'sell');

const marks = new ClusterMarkers();
const small = marks.radiusFor(1);
const big = marks.radiusFor(64);
check('a bar with more clusters is drawn larger', big > small, `${small} vs ${big}`);
check('the marker size is bounded, so one enormous bar cannot cover the chart', big <= 8 && small >= 2, `${small}..${big}`);
check('a search answer with no bars leaves the marks with nothing to paint', (() => {
  marks.data = series({ bars: [] });
  marks.clear();
  return marks.data === null && marks.selected === null && marks.debugInfo === null;
})());

// ------------------------------------------------------------------ the note

const idle = clusterSearchNote(emptyClusterSearch());
check('nothing has been searched yet, and the panel says so', /pick a window/i.test(idle), idle);
const running = clusterSearchNote(emptyClusterSearch(true, null, asked()));
check('a search in flight says it is searching', /searching/i.test(running), running);

const failed = clusterSearchNote(clusterSearchState(null, false, 'no answer after 30s', asked()));
check('a failed search says it failed', /search failed/.test(failed), failed);
check('a failed search carries the reason, so an empty list is not read as an empty window', failed.includes('no answer after 30s'), failed);

const noPrints = clusterSearchNote(clusterSearchState(series({ prints: 0, clusters: 0, rows: [], bars: [] }), false, null, asked()));
check('a window with no stored prints says there was nothing to search', /no prints stored/i.test(noPrints), noPrints);
check('a window with no stored prints does not claim a scan succeeded', !/prints scanned/i.test(noPrints), noPrints);

const noBig = clusterSearchNote(clusterSearchState(series({ clusters: 0, returned: 0, rows: [], bars: [] }), false, null, asked()));
check('prints that were all too small still report the scan', /278,412 prints scanned/.test(noBig), noBig);
check('prints that were all too small say nothing cleared the threshold', /none at or above 5k quote notional/.test(noBig), noBig);

const capped = clusterSearchNote(clusterSearchState(series({ clusters: 5_000, returned: 400, truncated: true }), false, null, asked()));
check('a capped list states the cap', /capped at 400/.test(capped), capped);
check('a capped list states the true total, not the row count', /5,000 at or above/.test(capped) && /400 newest listed/.test(capped), capped);
check('a capped list says how many are not shown', /4,600 more are not shown/.test(capped), capped);

const whole = clusterSearchNote(clusterSearchState(series(), false, null, asked()));
check('an uncapped list does not mention a cap', !/capped/.test(whole), whole);
check('the marks are reported as bars, matching the answer', /2 bars marked on the chart/.test(whole), whole);

const inQuantity = clusterSearchNote(clusterSearchState(series({ sizeUnit: 'quantity' }), false, null, asked({ unit: 'quantity' })));
check('a threshold in base quantity is named as one, not as money', /at or above 5k base quantity/.test(inQuantity), inQuantity);
const window = clusterSearchNote(clusterSearchState(series(), false, null, asked()));
check('the note names the window the answer covers', window.includes('2026-11-20 12:00 UTC to 2026-11-20 12:02 UTC'), window);
check('a re-run over an answer already on screen says so', clusterSearchNote(clusterSearchState(series(), true, null, asked())).includes('re-running'));

// ---------------------------------------------------------------- centring the chart

const bars = Array.from({ length: 400 }, (_, index) => ({ start: FIRST + index * BAR_MS, open: 1, high: 2, low: 0.5, close: 1, volume: 1, trades: 1, closed: true }));
const view = new ChartView();
view.setViewport(800);
view.barStep = 4;
view.centreOn(100, bars.length);
const scale = new XScale({
  count: bars.length,
  barStep: view.barStep,
  offsetFromEnd: view.offsetFromEnd,
  left: 0,
  right: 800,
  starts: bars.map((bar) => bar.start),
  barMs: BAR_MS,
  local: new LocalTime('UTC'),
});
const CENTRE = (scale.left + scale.right) / 2;
/** The scale the renderer would build from the view as it stands after a centre request. */
function scaleFor(state: ChartView): XScale {
  return new XScale({
    count: bars.length,
    barStep: state.barStep,
    offsetFromEnd: state.offsetFromEnd,
    left: 0,
    right: 800,
    starts: bars.map((bar) => bar.start),
    barMs: BAR_MS,
    local: new LocalTime('UTC'),
  });
}

check('a print with room on both sides lands in the middle of the plot', scaleFor(view).indexAt(CENTRE) === 100, `${scaleFor(view).indexAt(CENTRE)} vs 100`);
check('the zoom is left alone when it did not have to change', view.barStep === 4, String(view.barStep));

// A print 42 bars back from the newest end, on a chart zoomed out enough to hold 600 bars:
// the pan limit forbids centring at that zoom, so the step has to widen.
const wide = new ChartView();
wide.setViewport(800);
wide.barStep = 2.5;
wide.centreOn(bars.length - 43, bars.length);
check('a print near the newest end widens the zoom until the pan limit allows centring', scaleFor(wide).indexAt(CENTRE) === bars.length - 43, `${scaleFor(wide).indexAt(CENTRE)} vs ${bars.length - 43}`);
check('the zoom it widens to stays inside the chart\'s own bounds', wide.barStep >= 2.5 && wide.barStep <= 64, String(wide.barStep));
check('blank tape right of the newest bar never exceeds the pan limit', wide.offsetFromEnd <= 6 + 1e-9, String(wide.offsetFromEnd));

const newest = new ChartView();
newest.setViewport(800);
newest.barStep = 4;
newest.centreOn(bars.length - 1, bars.length);
check('the newest print sits at the pan limit rather than inventing tape', Math.abs(newest.offsetFromEnd - 6) < 1e-9, String(newest.offsetFromEnd));
check('one click does not turn a hundred bars into eight: the widening is bounded', newest.barStep <= 4 * 4 + 1e-9 && newest.barStep > 4, String(newest.barStep));
check('the bounded widening still leaves the print inside the visible bars', (() => {
  const visible = scaleFor(newest).visibleRange();
  return bars.length - 1 >= visible.first && bars.length - 1 <= visible.last;
})(), JSON.stringify(scaleFor(newest).visibleRange()));
const before = newest.offsetFromEnd;
newest.centreOn(-1, bars.length);
check('an index outside the series leaves the view where it was', newest.offsetFromEnd === before);
newest.centreOn(0, 0);
check('an empty series cannot be centred', newest.offsetFromEnd === before);

// ---------------------------------------------------------------- the wiring around it

const app = readFileSync('src/app.ts', 'utf8');
const api = readFileSync('api.ts'.replace('api.ts', 'src/api.ts'), 'utf8');
const dialog = readFileSync('src/clusterSearchDialog.ts', 'utf8');

check('the search is its own endpoint, beside the band split', api.includes('/api/cluster-search') && api.includes('/api/cvd-by-size'));
check('both endpoints take the same measure parameter', api.includes('unit?: string') && api.includes('options: { threshold: number; unit?: string; limit?: number }'));
check('the marks are painted in the price pane, not as drawings', app.includes('this.clusterMarkers.draw(') && !app.includes('drawings.add') );
check('the marks never enter the undo history', !app.includes('history.transact') || !/clusterMarkers[\s\S]{0,120}history\.transact/.test(app));
check('the drawing registry is not told about them', !app.includes('toolById') || !app.includes('clusterMarkers.register'));
check('Esc closes the cluster panel with every other dialog', app.includes('this.clusterDialog.close();'));
check('a key press is not stolen from the chart while the panel is open', app.includes('this.clusterDialog.isOpen()'));
check('another symbol or interval drops a search that no longer fits', (app.match(/this\.resetClusterSearch\(\);/g) ?? []).length === 2);
check('the panel tells the trader what a click does', dialog.includes('Click a row to centre the chart on that print.'));
check('an empty list names which kind of empty it is', dialog.includes('No prints are stored for that window') && dialog.includes('Nothing in that window reached') && dialog.includes('No listed row matches this filter'));
check('a filter that hides every row is not worded like an empty window', dialog.includes('private emptyMessage(') && (dialog.match(/'No listed row matches this filter.'/g) ?? []).length === 1);
check('the panel advertises Esc in its own footer', dialog.includes("'Esc closes'"));
check('the panel offers both measures rather than one', dialog.includes("'quote notional'") && dialog.includes("'base quantity'"));
check('the list is labelled by what the server filtered on, not by its row count', dialog.includes('at or above ${fmtSizeLabel(state.series.threshold)}'));

console.log(`cluster search: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
if (failures.length > 0) process.exitCode = 1;
