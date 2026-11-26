/**
 * Getting a workspace out of the machine and back in, and the bars and prints out as CSV.
 *
 * The file format is checked the way the app uses it: a document is built with every field
 * class it can hold, written to text, read back, validated and put in place of another
 * document — then compared. The refusals matter as much as the success: a file that is
 * malformed, foreign or written by another version of the format has to say why it was
 * rejected and leave the workspace that was already there alone.
 *
 * Run it from `ui/` with:
 *   npx rolldown tests/export-import.test.ts -o /tmp/export-test.mjs -f esm && node /tmp/export-test.mjs
 */

// The test runs in node, whose globals the DOM-only tsconfig does not carry.
declare const process: { exitCode: number };

import { API_ROW_CAP, barColumns, barsToCsv, countCsvRows, csvCell, printsToCsv } from '../src/dataExport';
import { barsFileName, fileStamp, printsFileName, safeName, workspaceFileName } from '../src/download';
import { defaultsFor, indicatorById } from '../src/indicators/registry';
import { SCRIPT_INDICATOR_ID } from '../src/indicators/script/contract';
import { DRAWING_TOOLS, toolById } from '../src/drawings/registry';
import { defaultsForKeys } from '../src/drawings/style';
import { DEFAULT_STATE, normaliseState } from '../src/workspace';
import type { ChartTemplate, ViewStateSnapshot, WorkspaceState } from '../src/workspace';
import {
  MAX_WORKSPACE_FILE_BYTES,
  WORKSPACE_FILE_KIND,
  WORKSPACE_SCHEMA_VERSION,
  buildWorkspaceFile,
  readWorkspaceFile,
  serialiseWorkspaceFile,
} from '../src/workspaceFile';
import type { Bar, Trade } from '../src/types';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed += 1;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const json = (value: unknown): string => JSON.stringify(value);
const equal = (a: unknown, b: unknown): boolean => json(a) === json(b);

const SCRIPT_TEXT = '//@version=5\nindicator("My VWAP band")\np = plot(vwap(close), "vwap", color.blue)\n';

// ------------------------------------------------------------------ 1. the file, as a file

const document = sampleDocument();
const file = buildWorkspaceFile(document, 1_764_100_000_000);
check('the file names itself', file.kind === WORKSPACE_FILE_KIND, file.kind);
check('the file states the version this build writes', file.schemaVersion === WORKSPACE_SCHEMA_VERSION, String(file.schemaVersion));
check('the file says when it was written', file.exportedAt === 1_764_100_000_000, String(file.exportedAt));
check('the file names the chart it came from', file.source.instrument === 'BINANCE:BTCUSDT' && file.source.timeframe === '5m', json(file.source));
check('the file carries the document it was handed', json(file.state) === json(document), diff(json(file.state), json(document)));

const text = serialiseWorkspaceFile(file);
check('the text is one JSON object', text.startsWith('{') && text.endsWith('}\n'), text.slice(0, 20));
check('the text carries the schema version in plain sight', text.includes('"schemaVersion": 1'), text.slice(0, 120));

// The document the app holds is live: a file written from it must not move when the chart does.
const live = structuredClone(document);
const snapshot = buildWorkspaceFile(live, 1_764_100_000_000);
live.drawings.push({ id: 'd-late', toolId: 'TrendLine', anchors: [{ time: 1, price: 1 }, { time: 2, price: 2 }], style: {} });
check('a written file is a copy, not a window on the live document', snapshot.state.drawings.length === document.drawings.length, String(snapshot.state.drawings.length));

// ------------------------------------------------------------------ 2. document → file → document

/** The same document run through the stored-document validator: the shape a file must restore. */
const canonical = normaliseState(document);
const read = readWorkspaceFile(text);
if (!read.ok) {
  failures.push(`the round trip refused its own file — ${read.error}`);
} else {
  const back = read.state;
  check('the whole document comes back unchanged', json(back) === json(canonical), diff(json(back), json(canonical)));
  check('validating the document a second time changes nothing', json(normaliseState(back)) === json(back));
  check('putting the file in place of another document replaces it whole', json(normaliseState(back)) === json(canonical));

  // Field classes, named one by one, because "equal as JSON" hides a field that defaulted
  // to the same value on both sides.
  const script = back.indicators.find((instance) => instance.indicatorId === SCRIPT_INDICATOR_ID);
  check('a script instance keeps its script text', script?.script === SCRIPT_TEXT, JSON.stringify(script?.script?.slice(0, 40)));
  check('a script instance keeps its id', script?.id === 'i-script', script?.id ?? 'missing');
  const sma = back.indicators.find((instance) => instance.id === 'i-sma');
  check('an indicator keeps its parameters', sma?.params['period'] === 33, json(sma?.params));
  check('indicator order survives', json(back.indicators.map((instance) => instance.id)) === json(['i-sma', 'i-rsi', 'i-script']), json(back.indicators.map((instance) => instance.id)));

  const pattern = back.drawings.find((instance) => instance.toolId === 'ElliottTripleCombo');
  check('a pattern drawing keeps all 8 anchors', pattern?.anchors.length === 8, String(pattern?.anchors.length));
  check(
    'every anchor keeps its exact time and price',
    equal(pattern?.anchors, document.drawings.find((instance) => instance.toolId === 'ElliottTripleCombo')?.anchors),
    json(pattern?.anchors),
  );
  const styled = back.drawings.find((instance) => instance.id === 'd-trend');
  check('a drawing keeps its own style', styled?.style['lineWidth'] === 4, json(styled?.style));
  check('a drawing keeps its locked flag', back.drawings.find((instance) => instance.id === 'd-rect')?.locked === true);
  check('drawing order survives', json(back.drawings.map((instance) => instance.id).slice(0, 3)) === json(document.drawings.map((instance) => instance.id).slice(0, 3)));

  check('the manual price range comes back', back.view.manualMin === 59_741.5084 && back.view.manualMax === 60_520.4716, json(back.view));
  check('auto-fit stays off so the framed range is read back', back.view.autoFit === false);
  check('zoom and offset come back', back.view.barStep === 4.001827804523934 && back.view.offsetFromEnd === -43, json(back.view));
  check('the price scale mode comes back', back.view.priceMode === 'log', back.view.priceMode);

  check('settings come back field for field', equal(back.settings, document.settings), json(back.settings));
  check('a non-default theme survives', back.settings.theme === 'light' && back.settings.paneBackground === '#FFFFFF', json(back.settings.theme));
  check('a typed timezone survives', back.settings.timezone === 'America/Chicago', back.settings.timezone);
  check('the density settings survive', back.settings.minBarStep === 1.5 && back.settings.visibleBars === 420, json(back.settings));

  const template = back.templates.find((entry) => entry.name === 'Scalp 1m');
  check('a template comes back whole', equal(template, canonical?.templates[0]), diff(json(template ?? ''), json(canonical?.templates[0] ?? '')));
  check('a template keeps its own framed price range', template?.view.autoFit === false && template?.view.manualMin === 100 && template?.view.manualMax === 200, json(template?.view));
  check('a template keeps its indicators', template?.indicators.length === 1 && template.indicators[0]?.params['period'] === 9, json(template?.indicators));

  check(
    'footprint settings survive',
    back.footprint.valueArea === document.footprint.valueArea &&
      back.footprint.imbalanceRatio === document.footprint.imbalanceRatio &&
      back.footprint.stackedImbalances === document.footprint.stackedImbalances,
    json(back.footprint),
  );
  check(
    'TPO settings survive',
    back.tpo.periodLength.count === document.tpo.periodLength.count &&
      back.tpo.periodLength.unit === document.tpo.periodLength.unit &&
      back.tpo.sessionStartMinute === document.tpo.sessionStartMinute &&
      back.tpo.valueAreaMethod === document.tpo.valueAreaMethod &&
      back.tpo.letterMode === document.tpo.letterMode &&
      back.tpo.profileSpacing === document.tpo.profileSpacing &&
      json(back.tpo.customTPOColors) === json(document.tpo.customTPOColors),
    json(back.tpo),
  );
  check('pane visibility and heights survive', equal(back.panes, document.panes) && equal(back.weights, document.weights), json([back.panes, back.weights]));
  check('the custom-weights flag survives', back.weightsCustomized === true);
  check('the watchlist survives', json(back.watchlist) === json(document.watchlist), json(back.watchlist));
  check('recent tools survive in order', json(back.recentTools) === json(document.recentTools), json(back.recentTools));
}

// ------------------------------------------------------------------ 3. every drawing tool

const allTools = sampleDocumentWithEveryTool();
const allToolsText = serialiseWorkspaceFile(buildWorkspaceFile(allTools, 1_764_100_000_000));
const allToolsRead = readWorkspaceFile(allToolsText);
check(`a document holding all ${DRAWING_TOOLS.length} tool types is accepted`, allToolsRead.ok, allToolsRead.ok ? '' : (allToolsRead as { error: string }).error);
if (allToolsRead.ok) {
  check(`all ${DRAWING_TOOLS.length} drawings come back`, allToolsRead.state.drawings.length === DRAWING_TOOLS.length, String(allToolsRead.state.drawings.length));
  check('every tool type is represented', new Set(allToolsRead.state.drawings.map((instance) => instance.toolId)).size === DRAWING_TOOLS.length);
  const missing = DRAWING_TOOLS.filter((tool) => !allToolsRead.state.drawings.some((instance) => instance.toolId === tool.id));
  check('no tool went missing', missing.length === 0, missing.map((tool) => tool.id).join(', '));
  const wrong = DRAWING_TOOLS.filter((tool) => {
    const instance = allToolsRead.state.drawings.find((entry) => entry.toolId === tool.id);
    return !instance || instance.anchors.length !== tool.anchorCount || !equal(instance.style, defaultsForKeys(tool.styleKeys, tool.styleDefaults));
  });
  check('every drawing keeps its anchor count and style', wrong.length === 0, wrong.map((tool) => `${tool.id}:${tool.anchorCount}`).join(', '));
  const widest = DRAWING_TOOLS.reduce((best, tool) => (tool.anchorCount > best.anchorCount ? tool : best), DRAWING_TOOLS[0]!);
  const widestInstance = allToolsRead.state.drawings.find((instance) => instance.toolId === widest.id);
  check(`the widest pattern keeps its ${widest.anchorCount} anchors`, widestInstance?.anchors.length === widest.anchorCount, widest.id);
  check('nothing was reported as repaired', allToolsRead.summary.repaired.length === 0, allToolsRead.summary.repaired.join('; '));
}

// ------------------------------- 3b. the shipped gannFib group, id by id

/**
 * The shipped identity table for the `gannFib` group, read out of the shipped bundle. Every row
 * is a claim the registry has to agree with: an anchor count one off makes a different tool.
 */
const SHIPPED_GANN_FIB: readonly { id: string; anchorCount: number; sectionKey: string }[] = [
  { id: 'FibonacciRetracement', anchorCount: 2, sectionKey: 'fibonacci' },
  { id: 'FibonacciTrend', anchorCount: 3, sectionKey: 'fibonacci' },
  { id: 'FibChannel', anchorCount: 3, sectionKey: 'fibonacci' },
  { id: 'Pitchfan', anchorCount: 3, sectionKey: 'fibonacci' },
  { id: 'FibTimeZone', anchorCount: 2, sectionKey: 'fibonacci' },
  { id: 'FibTrendTime', anchorCount: 3, sectionKey: 'fibonacci' },
  { id: 'FibCircles', anchorCount: 2, sectionKey: 'fibonacci' },
  { id: 'FibSpeedResistanceArcs', anchorCount: 2, sectionKey: 'fibonacci' },
  { id: 'FibSpeedResistanceFan', anchorCount: 2, sectionKey: 'fibonacci' },
  { id: 'FibWedge', anchorCount: 2, sectionKey: 'fibonacci' },
  { id: 'FibSpiral', anchorCount: 2, sectionKey: 'fibonacci' },
  { id: 'GannBox', anchorCount: 2, sectionKey: 'gann' },
  { id: 'GannSquare', anchorCount: 2, sectionKey: 'gann' },
  { id: 'GannSquareFixed', anchorCount: 2, sectionKey: 'gann' },
  { id: 'GannFan', anchorCount: 2, sectionKey: 'gann' },
];

for (const shipped of SHIPPED_GANN_FIB) {
  const tool = toolById(shipped.id);
  check(`${shipped.id} exists`, tool !== null);
  if (!tool) continue;
  check(`${shipped.id} takes ${shipped.anchorCount} anchors`, tool.anchorCount === shipped.anchorCount, `registry says ${tool.anchorCount}`);
  check(`${shipped.id} declares ${shipped.anchorCount} anchor axes`, tool.anchorAxes.length === shipped.anchorCount, `axes: ${tool.anchorAxes.length}`);
  check(`${shipped.id} sits in group gannFib`, tool.group === 'gannFib', tool.group);
  check(`${shipped.id} lists under ${shipped.sectionKey}`, tool.sectionKey === shipped.sectionKey, tool.sectionKey);
}
check(
  'the registry holds no other gannFib tool than the shipped fifteen',
  DRAWING_TOOLS.filter((tool) => tool.group === 'gannFib').length === SHIPPED_GANN_FIB.length,
  DRAWING_TOOLS.filter((tool) => tool.group === 'gannFib')
    .map((tool) => tool.id)
    .join(', '),
);

// Three representatives — the lowest anchor count, a middle one, and the widest tool in the
// registry — written out at anchor values no default would guess, then read back.
const GANN_REPRESENTATIVES: readonly { id: string; anchors: { time: number; price: number }[] }[] = [
  {
    id: 'GannBox',
    anchors: [
      { time: 1_764_000_000_000, price: 61_234.5 },
      { time: 1_764_008_400_000, price: 58_910.25 },
    ],
  },
  {
    id: 'FibonacciTrend',
    anchors: [
      { time: 1_764_000_000_000, price: 58_100.75 },
      { time: 1_764_006_600_000, price: 61_480.5 },
      { time: 1_764_013_800_000, price: 62_905.125 },
    ],
  },
  {
    id: 'ElliottTripleCombo',
    anchors: Array.from({ length: 8 }, (_, index) => ({ time: 1_764_000_000_000 + index * 222_000, price: 60_000 - index * 91.375 })),
  },
];

const gannDoc = structuredClone(DEFAULT_STATE);
gannDoc.drawings = GANN_REPRESENTATIVES.map((entry, index) => {
  const tool = toolById(entry.id)!;
  return {
    id: `d-gann-${index}`,
    toolId: entry.id,
    anchors: entry.anchors,
    style: defaultsForKeys(tool.styleKeys, tool.styleDefaults),
  };
});
const gannRoundTrip = readWorkspaceFile(serialiseWorkspaceFile(buildWorkspaceFile(gannDoc, 1_764_100_000_000)));
check('a document of the representative gann and fib drawings is accepted', gannRoundTrip.ok, gannRoundTrip.ok ? '' : (gannRoundTrip as { error: string }).error);
if (gannRoundTrip.ok) {
  for (const entry of GANN_REPRESENTATIVES) {
    const back = gannRoundTrip.state.drawings.find((instance) => instance.toolId === entry.id);
    check(`${entry.id} comes back`, back !== undefined);
    if (!back) continue;
    check(`${entry.id} keeps all ${entry.anchors.length} anchors`, back.anchors.length === entry.anchors.length, String(back.anchors.length));
    check(`${entry.id} keeps its named anchor values`, equal(back.anchors, entry.anchors), json(back.anchors));
  }
  check('the representative round-trip reports no repair', gannRoundTrip.summary.repaired.length === 0, gannRoundTrip.summary.repaired.join('; '));
}

// ------------------------------------------------------------------ 4. refusals

const current = normaliseState(document);
const before = json(current);

const notJson = readWorkspaceFile('{"state": {"indicators": [');
check('truncated JSON is refused with the reason', !notJson.ok && notJson.error.includes('not valid JSON'), bad(notJson));

const arrayFile = readWorkspaceFile('[1,2,3]');
check('a JSON list is refused', !arrayFile.ok && bad(arrayFile).includes('one JSON object'), bad(arrayFile));

const foreign = readWorkspaceFile(json({ kind: 'tradingview.layout', schemaVersion: 1, state: {} }));
check("another tool's file is refused by its kind", !foreign.ok && bad(foreign).includes('tradingview.layout'), bad(foreign));

const noKind = readWorkspaceFile(json({ schemaVersion: WORKSPACE_SCHEMA_VERSION, state: {} }));
check('a file with no kind is refused', !noKind.ok && bad(noKind).includes('kind is undefined'), bad(noKind));

const apiDump = readWorkspaceFile(json({ instrument: 'BINANCE:BTCUSDT', bars: [{ start: 1, close: 2 }] }));
check('a bars response is refused as foreign', !apiDump.ok && bad(apiDump).includes(WORKSPACE_FILE_KIND), bad(apiDump));

const noState = readWorkspaceFile(json({ kind: WORKSPACE_FILE_KIND, schemaVersion: WORKSPACE_SCHEMA_VERSION }));
check('a file with no document in it is refused', !noState.ok && bad(noState).includes('no workspace document'), bad(noState));

const listState = readWorkspaceFile(json({ kind: WORKSPACE_FILE_KIND, schemaVersion: WORKSPACE_SCHEMA_VERSION, state: { indicators: 'all of them' } }));
check('a document whose list is not a list is refused', !listState.ok && bad(listState).includes('state.indicators must be a list'), bad(listState));

const viewString = readWorkspaceFile(json({ kind: WORKSPACE_FILE_KIND, schemaVersion: WORKSPACE_SCHEMA_VERSION, state: { view: 'zoomed in' } }));
check('a document whose view is not an object is refused', !viewString.ok && bad(viewString).includes('state.view must be an object'), bad(viewString));

const oversize = readWorkspaceFile(`${json({ kind: WORKSPACE_FILE_KIND, schemaVersion: WORKSPACE_SCHEMA_VERSION, state: {} })}${'x'.repeat(MAX_WORKSPACE_FILE_BYTES)}`);
check('a file bigger than any workspace can be is refused', !oversize.ok && bad(oversize).includes('MB'), bad(oversize));

check('no refusal touched the workspace that was already open', json(current) === before, diff(json(current), before));

// ------------------------------------------------------------------ 5. the version rule

const newer = readWorkspaceFile(json({ kind: WORKSPACE_FILE_KIND, schemaVersion: WORKSPACE_SCHEMA_VERSION + 1, state: {} }));
check('a newer file is refused, naming both versions', !newer.ok && bad(newer).includes(`schema version ${WORKSPACE_SCHEMA_VERSION + 1}`) && bad(newer).includes(String(WORKSPACE_SCHEMA_VERSION)), bad(newer));
check('a newer file says it is newer than this build reads', !newer.ok && bad(newer).includes('newer than'), bad(newer));

const older = readWorkspaceFile(json({ kind: WORKSPACE_FILE_KIND, schemaVersion: 0, state: {} }));
check('an older file is refused too, not half-read', !older.ok && bad(older).includes('older than'), bad(older));
check('the refusal states that nothing was migrated', !older.ok && bad(older).includes('No migration exists yet'), bad(older));

const floatVersion = readWorkspaceFile(json({ kind: WORKSPACE_FILE_KIND, schemaVersion: 1.5, state: {} }));
check('a fractional version is refused', !floatVersion.ok && bad(floatVersion).includes('schemaVersion'), bad(floatVersion));

const stringVersion = readWorkspaceFile(json({ kind: WORKSPACE_FILE_KIND, schemaVersion: '1', state: {} }));
check('a version written as text is refused', !stringVersion.ok && bad(stringVersion).includes('"1"'), bad(stringVersion));
check('the workspace is still untouched after every version refusal', json(current) === before);

// ------------------------------------------------------------------ 6. what was repaired

const junk = {
  kind: WORKSPACE_FILE_KIND,
  schemaVersion: WORKSPACE_SCHEMA_VERSION,
  state: {
    instrument: 'BINANCE:BTCUSDT',
    timeframe: '1m',
    indicators: [
      { id: 'i-sma', indicatorId: 'SMA', params: { period: 21 } },
      { id: 'i-nope', indicatorId: 'NOT_AN_INDICATOR', params: {} },
      { id: 'i-noscript', indicatorId: SCRIPT_INDICATOR_ID, params: {}, script: '   ' },
    ],
    drawings: [
      { id: 'd-trend', toolId: 'TrendLine', anchors: [{ time: 1, price: 1 }, { time: 2, price: 2 }], style: {} },
      { id: 'd-alien', toolId: 'NotATool', anchors: [{ time: 1, price: 1 }], style: {} },
      { id: 'd-short', toolId: 'TrendLine', anchors: [{ time: 1, price: 1 }], style: {} },
      { id: 'd-dup', toolId: 'Text', anchors: [{ time: 3, price: 3 }], style: { text: 'a' } },
      { id: 'd-dup', toolId: 'Text', anchors: [{ time: 4, price: 4 }], style: { text: 'b' } },
    ],
    templates: [{ name: '', settings: {} }],
    watchlist: ['BINANCE:BTCUSDT', 42, null],
    view: { barStep: 3, offsetFromEnd: 4, autoFit: true },
    settings: { theme: 'neon', minBarStep: 99 },
  },
};
const repaired = readWorkspaceFile(json(junk));
check('a half-broken document is still importable', repaired.ok, bad(repaired));
if (repaired.ok) {
  const notes = repaired.summary.repaired;
  check('the summary counts the indicators it dropped', notes.some((note) => note === '2 indicators dropped'), notes.join('; '));
  check('the summary counts the drawings it dropped', notes.some((note) => note === '3 drawings dropped'), notes.join('; '));
  check('the summary names the tools this build does not have', notes.some((note) => note.includes('NotATool')), notes.join('; '));
  check('the summary counts the template it dropped', notes.some((note) => note === '1 template dropped'), notes.join('; '));
  check('the summary counts the watchlist symbol it dropped', notes.some((note) => note === '2 watchlist symbols dropped'), notes.join('; '));
  check('what it kept is what a workspace needs', repaired.state.indicators.length === 1 && repaired.state.drawings.length === 2 && repaired.state.watchlist.length === 1, json([repaired.state.indicators.length, repaired.state.drawings.length, repaired.state.watchlist.length]));
  const texts = repaired.state.drawings.filter((instance) => instance.toolId === 'Text').map((instance) => String(instance.style['text']));
  check('of two drawings sharing an id, the first is the one that stays', json(texts) === json(['a']), json(texts));
  check('the summary counts what the file holds', repaired.summary.indicators === 1 && repaired.summary.drawings === 2 && repaired.summary.toolTypes === 2, json(repaired.summary));
  check('the summary flags a file with no framed price range', repaired.summary.framedRange === false);
}

const summary = read.ok ? read.summary : null;
check('the confirmation counts the indicators', summary?.indicators === 3, json(summary?.indicators));
check('the confirmation counts the drawings and tool types', summary?.drawings === document.drawings.length && summary?.toolTypes === new Set(document.drawings.map((entry) => entry.toolId)).size, json([summary?.drawings, summary?.toolTypes]));
check('the confirmation says a script instance carries script text', summary?.scripts === 1, json(summary?.scripts));
check('the confirmation reports the framed price range', summary?.framedRange === true);
check('the confirmation counts the templates', summary?.templates === 2, json(summary?.templates));

// ------------------------------------------------------------------ 7. bars CSV

const window = barWindow(1_764_000_000_000, 240, 60_000);
const deltas = new Map<number, number>();
for (const bar of window.slice(1)) deltas.set(bar.start, bar.close - bar.open);

const withDelta = barsToCsv(window, deltas);
check('one row per bar in the window', withDelta.rows === 240, String(withDelta.rows));
check('the file holds exactly the rows it claims', countCsvRows(withDelta.csv) === withDelta.rows, String(countCsvRows(withDelta.csv)));
check('the columns are the ones promised', json(withDelta.columns) === json(['time', 'open', 'high', 'low', 'close', 'volume', 'delta']), json(withDelta.columns));
check('delta is written for every bar the prints cover', withDelta.deltaRows === 239, String(withDelta.deltaRows));
check('the first row is the header', withDelta.csv.split('\r\n')[0] === 'time,open,high,low,close,volume,delta', withDelta.csv.split('\r\n')[0]);
check('the time column is ISO-8601 UTC', withDelta.csv.split('\r\n')[1]?.startsWith('2025-11-24T16:00:00.000Z,') === true, withDelta.csv.split('\r\n')[1]?.slice(0, 40));
check('a bar with no prints leaves its delta cell empty', withDelta.csv.split('\r\n')[1]?.endsWith(',') === true, withDelta.csv.split('\r\n')[1]?.slice(-12));
check('an uncovered window is not cut short by the row cap', withDelta.capped === false);
check('a bars window the size of the cap is reported as capped', barsToCsv(barWindow(0, API_ROW_CAP, 60_000)).capped === true);

const noPrints = barsToCsv(window, null);
check('no prints means no delta column', json(noPrints.columns) === json(['time', 'open', 'high', 'low', 'close', 'volume']), json(noPrints.columns));
check('the empty delta map writes no column either', json(barsToCsv(window, new Map()).columns) === json(['time', 'open', 'high', 'low', 'close', 'volume']));
check('a delta map that covers nothing writes no column', json(barColumns(new Map([[999, 1]]), window)) === json(['time', 'open', 'high', 'low', 'close', 'volume']));
check('a delta map that covers one bar earns the column', barColumns(new Map([[window[0]!.start, 1]]), window).includes('delta'));
check('an empty window writes only the header', barsToCsv([]).rows === 0 && countCsvRows(barsToCsv([]).csv) === 0);
check('a one-bar window is one row', countCsvRows(barsToCsv(window.slice(0, 1)).csv) === 1);

// ------------------------------------------------------------------ 8. prints CSV and the cap

const prints = barWindow(0, 500, 250).map((bar, index): Trade => ({
  ts: 1_764_000_000_000 + index,
  seq: index,
  price: 100 + index / 100,
  qty: bar.volume,
  aggressor: index % 2 === 0 ? 'buy' : 'sell',
}));
const printFile = printsToCsv(prints);
check('one row per print', printFile.rows === 500, String(printFile.rows));
check('the print columns are the wire fields', json(printFile.columns) === json(['time', 'seq', 'price', 'qty', 'aggressor']), json(printFile.columns));
check('the prints file holds its rows', countCsvRows(printFile.csv) === 500, String(countCsvRows(printFile.csv)));
check('a small range is not capped', printFile.capped === false);

const atCap = printsToCsv(Array.from({ length: API_ROW_CAP }, (_, index): Trade => ({ ts: 1_764_000_000_000 + index, seq: index, price: 100, qty: 1, aggressor: 'buy' })));
check(`exactly ${API_ROW_CAP.toLocaleString('en-US')} rows is read as the cap`, atCap.capped === true, String(atCap.rows));
check('one row short of the cap is a complete file', printsToCsv(prints.slice(0, API_ROW_CAP - 1)).capped === false);
check('the cap is the server clamp', API_ROW_CAP === 200_000, String(API_ROW_CAP));
check('an empty tape still writes a header', printsToCsv([]).rows === 0 && printsToCsv([]).csv.startsWith('time,seq,price,qty,aggressor'));

check('a value with a comma is quoted', csvCell('a,b') === '"a,b"', csvCell('a,b'));
check('a quote inside a value is doubled', csvCell('say "hi"') === '"say ""hi"""', csvCell('say "hi"'));
check('a plain number needs no quoting', csvCell(12.5) === '12.5');
check('a missing value is an empty cell', csvCell(undefined) === '');

// ------------------------------------------------------------------ 9. file names

check('a venue id cannot break a file name', safeName('BINANCE:BTCUSDT') === 'BINANCE-BTCUSDT', safeName('BINANCE:BTCUSDT'));
check('a file name without a symbol still works', safeName(null) === 'no-symbol');
check('a stamp carries no character a file name may not hold', fileStamp(1_764_100_000_000) === '20251125-1946', fileStamp(1_764_100_000_000));
check('the workspace file is named for its symbol and moment', workspaceFileName('BINANCE:BTCUSDT', 1_764_100_000_000) === 'chartkit-BINANCE-BTCUSDT-20251125-1946.chartkit.json', workspaceFileName('BINANCE:BTCUSDT', 1_764_100_000_000));
check('a bars file names its interval', barsFileName('BINANCE:BTCUSDT', '5m', 1_764_100_000_000) === 'bars-BINANCE-BTCUSDT-5m-20251125-1946.csv', barsFileName('BINANCE:BTCUSDT', '5m', 1_764_100_000_000));
check('a capped prints file says so in its name', printsFileName('BINANCE:BTCUSDT', 1_764_100_000_000, true) === 'prints-BINANCE-BTCUSDT-20251125-1946-partial.csv', printsFileName('BINANCE:BTCUSDT', 1_764_100_000_000, true));
check('a complete prints file does not', printsFileName('BINANCE:BTCUSDT', 1_764_100_000_000, false) === 'prints-BINANCE-BTCUSDT-20251125-1946.csv');

// ------------------------------------------------------------------ report

console.log(`workspace export/import: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
if (failures.length > 0) process.exitCode = 1;

// ------------------------------------------------------------------ fixtures

/** Bars at a fixed step, so a window's row count is known before anyone counts it. */
function barWindow(from: number, count: number, step: number): Bar[] {
  return Array.from({ length: count }, (_, index): Bar => ({
    start: from + index * step,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 10 + index / 4,
    trades: 3 + index,
    closed: true,
  }));
}

/** A document with one drawing per tool type, each at its own anchor count. */
function sampleDocumentWithEveryTool(): WorkspaceState {
  const state = structuredClone(DEFAULT_STATE);
  state.drawings = DRAWING_TOOLS.map((tool, index) => ({
    id: `d-tool-${index}`,
    toolId: tool.id,
    anchors: Array.from({ length: tool.anchorCount }, (_, step) => ({ time: 1_764_000_000_000 + step * 60_000, price: 100 + step * 3 + index })),
    style: defaultsForKeys(tool.styleKeys, tool.styleDefaults),
    locked: index % 7 === 0,
  }));
  return state;
}

/** Every field class the document can hold, at values no default would guess. */
function sampleDocument(): WorkspaceState {
  const view: ViewStateSnapshot = {
    barStep: 4.001827804523934,
    offsetFromEnd: -43,
    priceMode: 'log',
    autoFit: false,
    manualMin: 59_741.5084,
    manualMax: 60_520.4716,
  };
  const sma = indicatorById('SMA');
  const rsi = indicatorById('RSI');
  const template: ChartTemplate = {
    name: 'Scalp 1m',
    settings: { ...DEFAULT_STATE.settings, theme: 'light', visibleBars: 120 },
    seriesStyle: 'heikin',
    view: { barStep: 6, offsetFromEnd: 2, priceMode: 'linear', autoFit: false, manualMin: 100, manualMax: 200 },
    panes: { volume: false, footprint: true, profile: false, ladder: true, sidebar: false },
    weights: { price: 2, volume: 0.5, footprint: 1, profile: 1 },
    weightsCustomized: true,
    indicators: [{ id: 't-sma', indicatorId: 'SMA', params: { ...defaultsFor(sma!), period: 9 } }],
  };
  const triple = toolById('ElliottTripleCombo');
  const patternAnchors = Array.from({ length: triple?.anchorCount ?? 8 }, (_, index) => ({
    time: 1_764_000_000_000 + index * 90_000,
    price: 60_000 - index * 137.25,
  }));
  return {
    ...structuredClone(DEFAULT_STATE),
    instrument: 'BINANCE:BTCUSDT',
    timeframe: '5m',
    seriesStyle: 'candles',
    watchlist: ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT'],
    // The size-band grid and the TPO grid are panes like any other: switched on here so a
    // file that turns them off cannot quietly restore them on.
    panes: { volume: true, footprint: false, profile: true, sizeBands: true, tpo: true, ladder: false, sidebar: true },
    weights: { price: 4.25, volume: 1.5, footprint: 2.75, profile: 1.25, sizeBands: 0.9, tpo: 1.4 },
    weightsCustomized: true,
    view,
    indicators: [
      { id: 'i-sma', indicatorId: 'SMA', params: { ...defaultsFor(sma!), period: 33 } },
      { id: 'i-rsi', indicatorId: 'RSI', params: { ...defaultsFor(rsi!), length: 7 } },
      { id: 'i-script', indicatorId: SCRIPT_INDICATOR_ID, params: {}, script: SCRIPT_TEXT },
    ],
    drawings: [
      { id: 'd-trend', toolId: 'TrendLine', anchors: [{ time: 1_764_000_000_000, price: 60_000 }, { time: 1_764_003_600_000, price: 59_123.5 }], style: { lineWidth: 4 } },
      { id: 'd-rect', toolId: 'Rectangle', anchors: [{ time: 1_764_000_000_000, price: 60_100 }, { time: 1_764_004_800_000, price: 59_050 }], style: {}, locked: true },
      { id: 'd-triple', toolId: 'ElliottTripleCombo', anchors: patternAnchors, style: {} },
      { id: 'd-text', toolId: 'Text', anchors: [{ time: 1_764_010_000_000, price: 61_000.125 }], style: { text: 'session open' } },
    ],
    recentTools: ['TrendLine', 'ElliottTripleCombo', 'Text'],
    footprint: { ...DEFAULT_STATE.footprint, valueArea: 0.6, imbalanceRatio: 4.5, stackedImbalances: 3, threshold: 12.25 },
    // The TPO grid is settings too: the bucket, the session and the value-area method have to
    // come back or the letters restore at a grid the trader never chose.
    tpo: {
      ...DEFAULT_STATE.tpo,
      periodLength: { count: 4, unit: 'hour' },
      sessionStartMinute: 17 * 60,
      valueAreaPercentage: 0.5,
      valueAreaMethod: 'tpo',
      letterMode: 'blocks-only',
      profileSpacing: 9,
      customTPOColors: ['#101820', '#203040', '#305070', '#4b9cf5'],
    },
    settings: {
      ...DEFAULT_STATE.settings,
      theme: 'light',
      paneBackground: '#FFFFFF',
      upColor: '#112233',
      downColor: '#445566',
      priceTickStyle: 'fine',
      minBarStep: 1.5,
      visibleBars: 420,
      timezone: 'America/Chicago',
      latencyAlertMs: 900,
    },
    templates: [template, { ...template, name: 'Swing 1h', view: { barStep: 2, offsetFromEnd: 0, autoFit: true }, weightsCustomized: false }],
  };
}

/** The first place two JSON documents part, which is far quicker to read than a full diff. */
function diff(a: string, b: string): string {
  let index = 0;
  while (index < a.length && a[index] === b[index]) index += 1;
  return `at ${index}: ${a.slice(Math.max(0, index - 40), index + 60)} <> ${b.slice(Math.max(0, index - 40), index + 60)}`;
}

function bad(read: { ok: boolean; error?: string }): string {
  return read.ok ? `accepted: ${json(read)}` : read.error ?? 'no reason given';
}
