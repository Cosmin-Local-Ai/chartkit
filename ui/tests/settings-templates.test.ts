/**
 * Settings, timezone and template behaviour, driven the way the app drives them.
 *
 * The settings dialog is DOM, so what is checked here is the contract behind it: every
 * stored value is validated before a pane sees it, the axis clock is a real `Intl` zone,
 * a template survives a document round-trip, and the keyboard reference cannot drift from
 * the handler in app.ts.
 *
 * Run it from `ui/` with:
 *   npx rolldown tests/settings-templates.test.ts -o /tmp/settings-test.mjs -f esm && node /tmp/settings-test.mjs
 * The last section reads `src/app.ts` from disk, so the working directory has to be `ui/`.
 */

// The test runs in node, whose globals the DOM-only tsconfig does not carry.
declare const process: { exitCode: number };

import { readFileSync } from 'node:fs';

import { LocalTime } from '../src/format';
import { PriceScale, XScale } from '../src/scale';
import {
  DEFAULT_SETTINGS,
  EXCHANGE_ZONE,
  applyThemeColours,
  isKnownZone,
  normaliseSettings,
  resolveZone,
} from '../src/settings';
import { KEY_LABELS, PLAIN_KEYS, PLAIN_KEY_ACTIONS, SHORTCUT_GROUPS } from '../src/shortcuts';
import { ChartView } from '../src/view';
import { dayBoundarySegments, sessionSegments } from '../src/session';
import { DEFAULT_STATE, normaliseState } from '../src/workspace';
import type { ChartTemplate, WorkspaceState } from '../src/workspace';
import type { Bar, Instrument } from '../src/types';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed += 1;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const json = (value: unknown): string => JSON.stringify(value);

// ------------------------------------------------------------------ 1. settings validation

const clean = normaliseSettings(undefined);
check('a missing settings object gets the defaults', json(clean) === json(DEFAULT_SETTINGS), json(clean));
check('the default axis zone is UTC', clean.timezone === 'UTC', clean.timezone);
check('the default density floor is the shipped one', clean.minBarStep === 2.5 && clean.visibleBars === 250, json(clean));

const foreign = normaliseSettings({
  theme: 'neon',
  paneBackground: 'rebeccapurple',
  upColor: '#26B98A',
  downColor: '#26b98aff',
  showGrid: 'false',
  showLegend: 1,
  priceTickStyle: 'huge',
  showSessionDivider: null,
  minBarStep: 999,
  visibleBars: '120.4',
  timezone: 'Mars/Phobos',
  showLatency: 'yes',
  latencyAlertMs: 'abc',
});
check('a theme the app does not paint falls back to dark', foreign.theme === 'dark', foreign.theme);
check('a named colour is not accepted as a pane background', foreign.paneBackground === DEFAULT_SETTINGS.paneBackground, foreign.paneBackground);
check('a plain hex colour is kept', foreign.upColor === '#26B98A', foreign.upColor);
check('an eight-digit hex keeps its rgb and drops its alpha', foreign.downColor === '#26b98a', foreign.downColor);
check('a string is not a boolean', foreign.showGrid === true && foreign.showLegend === true && foreign.showSessionDivider === true && foreign.showLatency === true, json(foreign));
check('an unknown tick style falls back to auto', foreign.priceTickStyle === 'auto', foreign.priceTickStyle);
check('a density floor above the range is clamped', foreign.minBarStep === 12, String(foreign.minBarStep));
check('a numeric string is read as a number', foreign.visibleBars === 120, String(foreign.visibleBars));
check('a zone the runtime does not know falls back to UTC', foreign.timezone === 'UTC', foreign.timezone);
check('a junk latency threshold keeps the default', foreign.latencyAlertMs === DEFAULT_SETTINGS.latencyAlertMs, String(foreign.latencyAlertMs));

const lowFloor = normaliseSettings({ minBarStep: 0.2 });
check('a density floor below the range is clamped up', lowFloor.minBarStep === 1, String(lowFloor.minBarStep));
check('a typed zone the runtime knows is kept', normaliseSettings({ timezone: 'Asia/Tokyo' }).timezone === 'Asia/Tokyo', normaliseSettings({ timezone: 'Asia/Tokyo' }).timezone);
check('the exchange option survives validation', normaliseSettings({ timezone: EXCHANGE_ZONE }).timezone === EXCHANGE_ZONE, EXCHANGE_ZONE);

const reinked = applyThemeColours({ ...DEFAULT_SETTINGS, theme: 'light', paneBackground: '#0f1317' });
check('switching theme re-inks the pane background', reinked.paneBackground === '#f7f9fb', reinked.paneBackground);
check('switching theme re-inks the series colours', reinked.upColor === '#12996f' && reinked.downColor === '#d1414b', json([reinked.upColor, reinked.downColor]));

// ------------------------------------------------------------------ 2. zone resolution

const at = Date.UTC(2026, 10, 25, 12, 0, 0);
check('a fixed zone ignores the venue', resolveZone({ ...DEFAULT_SETTINGS, timezone: 'UTC' }, 'America/New_York') === 'UTC', resolveZone({ ...DEFAULT_SETTINGS, timezone: 'UTC' }, 'America/New_York'));
check('the exchange option follows the venue', resolveZone({ ...DEFAULT_SETTINGS, timezone: EXCHANGE_ZONE }, 'America/New_York') === 'America/New_York', resolveZone({ ...DEFAULT_SETTINGS, timezone: EXCHANGE_ZONE }, 'America/New_York'));
check('a venue with an unknown zone still gets UTC', resolveZone({ ...DEFAULT_SETTINGS, timezone: EXCHANGE_ZONE }, 'Mars/Phobos') === 'UTC', resolveZone({ ...DEFAULT_SETTINGS, timezone: EXCHANGE_ZONE }, 'Mars/Phobos'));
check('a venue with no zone at all gets UTC', resolveZone({ ...DEFAULT_SETTINGS, timezone: EXCHANGE_ZONE }, undefined) === 'UTC', 'none');
check('an empty zone is not a zone', !isKnownZone('') && !isKnownZone(42), json(['', 42]));

// ------------------------------------------------------------------ 3. the axis clock is a real zone

const BAR_MS = 30 * 60_000;
const FIRST = Date.UTC(2026, 10, 23, 22, 0, 0);
const bars: Bar[] = Array.from({ length: 96 }, (_, i) => {
  const close = 100 + i;
  return { start: FIRST + i * BAR_MS, open: close, high: close + 1, low: close - 1, close, volume: 10, trades: 3, closed: true };
});
const starts = bars.map((bar) => bar.start);

const utc = new LocalTime('UTC');
const tokyo = new LocalTime('Asia/Tokyo');
const newYork = new LocalTime('America/New_York');
check('the same instant reads differently per zone', utc.clock(at) === '12:00' && tokyo.clock(at) === '21:00' && newYork.clock(at) === '07:00', json([utc.clock(at), tokyo.clock(at), newYork.clock(at)]));
// 22:00 UTC is the next day in Tokyo and still the same day in New York: the day label has
// to follow the clock, not the instant.
const late = Date.UTC(2026, 10, 25, 22, 0, 0);
check('the day label follows the zone too', utc.format(late, 'day') === '25 Nov' && tokyo.format(late, 'day') === '26 Nov' && newYork.format(late, 'day') === '25 Nov', json([utc.format(late, 'day'), tokyo.format(late, 'day'), newYork.format(late, 'day')]));
check('the UTC offset is +9 in Tokyo and -5 in New York in late November', Math.round(tokyo.offsetFor(at) / 3.6e6) === 9 && Math.round(newYork.offsetFor(at) / 3.6e6) === -5, json([tokyo.offsetFor(at) / 3.6e6, newYork.offsetFor(at) / 3.6e6]));
check('New York crosses DST: -5 in winter, -4 in summer', Math.round(newYork.offsetFor(Date.UTC(2026, 0, 15)) / 3.6e6) === -5 && Math.round(newYork.offsetFor(Date.UTC(2026, 6, 15)) / 3.6e6) === -4, 'dst');

/** Axis ticks at a day step: the labels and the bar each one lands on. */
function dayTicks(local: LocalTime): { index: number; label: string }[] {
  const x = new XScale({
    count: bars.length,
    barStep: 8,
    offsetFromEnd: 6,
    left: 0,
    right: 2000,
    starts,
    barMs: BAR_MS,
    local,
  });
  // A 250 px label pitch at this zoom is what selects the day step out of the ladder.
  return x.timeTicks(250).map((tick) => ({ index: tick.index, label: tick.label }));
}

const utcTicks = dayTicks(utc);
const tokyoTicks = dayTicks(tokyo);
check('day ticks exist in both zones', utcTicks.length >= 2 && tokyoTicks.length >= 2, json([utcTicks, tokyoTicks]));
check('day ticks land on different bars once the zone moves', json(utcTicks.map((t) => t.index)) !== json(tokyoTicks.map((t) => t.index)), json([utcTicks.map((t) => t.index), tokyoTicks.map((t) => t.index)]));
check('day tick labels move with the zone', json(utcTicks.map((t) => t.label)) !== json(tokyoTicks.map((t) => t.label)), json([utcTicks.map((t) => t.label), tokyoTicks.map((t) => t.label)]));

/** A venue that closes overnight: the session boundary is a wall-clock time in its own zone. */
const instrument: Instrument = {
  ...DEFAULT_STATE,
  id: 'NASDAQ:TEST',
  venue: 'nasdaq',
  symbol: 'TEST',
  display: 'TEST',
  name: 'Test',
  assetClass: 'equity',
  priceTick: 0.01,
  qtyStep: 1,
  pricePrecision: 2,
  qtyPrecision: 0,
  quoteCurrency: 'USD',
  session: {
    timezone: 'America/New_York',
    windows: [
      [0, '09:30', '16:00'],
      [1, '09:30', '16:00'],
      [2, '09:30', '16:00'],
      [3, '09:30', '16:00'],
      [4, '09:30', '16:00'],
    ],
  },
  active: true,
} as Instrument;

const segmentsUtc = sessionSegments(bars, instrument, utc);
const segmentsExchange = sessionSegments(bars, instrument, newYork);
check('session segments are found in both clocks', segmentsUtc.length > 0 && segmentsExchange.length > 0, json([segmentsUtc.length, segmentsExchange.length]));
check('the session divider sits on a different bar per clock', json(segmentsUtc.map((s) => s.index)) !== json(segmentsExchange.map((s) => s.index)), json([segmentsUtc.map((s) => s.index), segmentsExchange.map((s) => s.index)]));
// Index 0 is only the tape starting off-session; the boundaries after it are the real ones.
// A venue that never closes publishes no windows, so the divider falls back to the day
// change on the axis clock — and that moves with the timezone too.
const dayUtc = dayBoundarySegments(bars, utc);
const dayTokyo = dayBoundarySegments(bars, tokyo);
check('a continuous venue still gets day-change dividers', dayUtc.length >= 2, json(dayUtc.map((s) => s.index)));
check('a continuous venue is never shaded off-session', dayUtc.every((segment) => segment.open), json(dayUtc));
check('the day divider moves with the axis timezone', json(dayUtc.map((s) => s.index)) !== json(dayTokyo.map((s) => s.index)), json([dayUtc.map((s) => s.index), dayTokyo.map((s) => s.index)]));
check('in the venue zone a boundary is 09:30 or 16:00 wall clock', segmentsExchange.filter((s) => s.index > 0).every((segment) => {
  const clock = newYork.clock(segment.start);
  return clock === '09:30' || clock === '16:00';
}), json(segmentsExchange.filter((s) => s.index > 0).map((segment) => newYork.clock(segment.start))));
// The venue's windows are wall-clock times, so they are read on the clock the axis runs on:
// on UTC the same window closes 09:30 and 16:00 UTC, which is a different bar.
check('on the UTC clock the same window reads 09:30 and 16:00', segmentsUtc.filter((s) => s.index > 0).every((segment) => {
  const clock = utc.clock(segment.start);
  return clock === '09:30' || clock === '16:00';
}), json(segmentsUtc.filter((s) => s.index > 0).map((segment) => utc.clock(segment.start))));

// ------------------------------------------------------------------ 4. density settings

const view = new ChartView();
view.setViewport(800);
view.setDensity(2.5, 120, bars.length);
view.zoomBy(0.01, bars.length);
check('the shipped floor still stops the zoom-out', view.barStep === 2.5, String(view.barStep));
view.setDensity(1, 120, bars.length);
view.zoomBy(0.01, bars.length);
check('a lowered floor lets the tape pack tighter', view.barStep === 1, String(view.barStep));
view.setDensity(6, 120, bars.length);
check('a raised floor pulls an over-dense view back at once', view.barStep === 6, String(view.barStep));
view.setDensity(2.5, 100, bars.length);
view.applyDefaultView(bars.length, 800);
check('a framed view shows the number of bars the setting asks for', Math.abs(800 / view.barStep - 100) < 1, String(800 / view.barStep));
check('a framed view rests at the home offset', view.offsetFromEnd === 6, String(view.offsetFromEnd));

const fine = new PriceScale({ mode: 'linear', min: 100, max: 235, top: 0, bottom: 600, precision: 2, tickPx: 34 });
const coarse = new PriceScale({ mode: 'linear', min: 100, max: 235, top: 0, bottom: 600, precision: 2, tickPx: 96 });
const plain = new PriceScale({ mode: 'linear', min: 100, max: 235, top: 0, bottom: 600, precision: 2 });
check('fine tick density gives more labels', fine.ticks().length > plain.ticks().length, json([fine.ticks().length, plain.ticks().length]));
check('coarse tick density gives fewer labels', coarse.ticks().length < plain.ticks().length, json([coarse.ticks().length, plain.ticks().length]));
check('the default pitch is unchanged when no style is passed', json(plain.ticks()) === json(new PriceScale({ mode: 'linear', min: 100, max: 235, top: 0, bottom: 600, precision: 2, tickPx: 56 }).ticks()), 'pitch');

// ------------------------------------------------------------------ 5. templates in the document

const template: ChartTemplate = {
  name: 'Price action',
  settings: { ...DEFAULT_SETTINGS, theme: 'light', timezone: 'Asia/Tokyo', visibleBars: 180 },
  seriesStyle: 'heikin',
  view: { barStep: 4, offsetFromEnd: 3, priceMode: 'log', autoFit: false, manualMin: 120, manualMax: 180 },
  panes: { volume: false, footprint: true, profile: false, ladder: true, sidebar: true },
  weights: { price: 4, volume: 0.8 },
  weightsCustomized: true,
  indicators: [{ id: 't1', indicatorId: 'EMA', params: { period: 21 } }],
};

const document = {
  ...structuredClone(DEFAULT_STATE),
  instrument: 'BINANCE:BTCUSDT',
  settings: { theme: 'light', minBarStep: 99, timezone: 'Mars/Phobos' },
  templates: [
    template,
    { ...structuredClone(template), name: 'Price action' },
    { ...structuredClone(template), name: '   ' },
    'not an object',
    { name: 'Broken', seriesStyle: 'donuts', settings: 7, view: { barStep: 'wide', manualMin: Number.POSITIVE_INFINITY, autoFit: 'sometimes' }, indicators: [null, { id: 'x' }] },
  ],
};

const restored = normaliseState(document);
check('a stored document with settings and templates still restores', restored !== null, json(restored === null));
const state = restored as WorkspaceState;
check('a stored theme the app cannot paint falls back on load', state.settings.theme === 'light', state.settings.theme);
check('an out-of-range stored floor is clamped on load', state.settings.minBarStep === 12, String(state.settings.minBarStep));
check('an unknown stored zone falls back to UTC on load', state.settings.timezone === 'UTC', state.settings.timezone);
check('the rest of a partial stored document keeps its defaults', state.settings.visibleBars === DEFAULT_SETTINGS.visibleBars && state.settings.showGrid === true, json([state.settings.visibleBars, state.settings.showGrid]));
check('the rest of the document is untouched', state.instrument === 'BINANCE:BTCUSDT' && state.timeframe === DEFAULT_STATE.timeframe, json([state.instrument, state.timeframe]));

check('only whole, named, unique templates are kept', state.templates.length === 2, json(state.templates.map((t) => t.name)));
const kept = state.templates[0]!;
check('a kept template carries its settings', kept.settings.theme === 'light' && kept.settings.timezone === 'Asia/Tokyo' && kept.settings.visibleBars === 180, json(kept.settings));
check('a kept template carries its series style', kept.seriesStyle === 'heikin', kept.seriesStyle);
check('a kept template carries the framed price range', kept.view.autoFit === false && kept.view.manualMin === 120 && kept.view.manualMax === 180, json(kept.view));
check('a kept template carries the zoom and the offset', kept.view.barStep === 4 && kept.view.offsetFromEnd === 3 && kept.view.priceMode === 'log', json(kept.view));
check('a kept template carries its indicators', kept.indicators.length === 1 && kept.indicators[0]?.params.period === 21, json(kept.indicators));
check('a kept template carries its pane layout', kept.panes.volume === false && kept.weights.price === 4 && kept.weightsCustomized === true, json([kept.panes, kept.weights]));
const broken = state.templates[1]!;
check('a half-written template still restores, with defaults filled in', broken.seriesStyle === 'candles' && broken.settings.theme === DEFAULT_SETTINGS.theme, json([broken.seriesStyle, broken.settings.theme]));
check('junk view values are dropped rather than trusted', broken.view.barStep === undefined && broken.view.manualMin === undefined && broken.view.autoFit === undefined, json(broken.view));

// A template has to survive the round trip through the server, which is JSON. Indicator
// parameters are filled out with their defaults on the way back, so the fields the trader
// chose are what has to match.
const roundTripped = normaliseState(JSON.parse(JSON.stringify({ ...structuredClone(DEFAULT_STATE), templates: [template] })));
const back = roundTripped?.templates[0];
const fieldsMatch = back !== undefined &&
  back.name === template.name &&
  json(back.settings) === json(normaliseSettings(template.settings)) &&
  back.seriesStyle === template.seriesStyle &&
  back.view.barStep === 4 &&
  back.view.offsetFromEnd === 3 &&
  back.view.priceMode === 'log' &&
  back.view.autoFit === false &&
  back.view.manualMin === 120 &&
  back.view.manualMax === 180 &&
  back.panes.volume === false &&
  back.panes.profile === false &&
  back.weights.price === 4 &&
  back.weightsCustomized === true;
check('a template round-trips through JSON unchanged', fieldsMatch, json(back));
check('a round-tripped template still carries its indicator and parameters', back?.indicators.length === 1 && back?.indicators[0]?.indicatorId === 'EMA' && back?.indicators[0]?.params.period === 21, json(back?.indicators));

check('a document whose templates field is a string loses them', normaliseState({ templates: 'nope' })?.templates.length === 0, 'string');
check('a non-object document is refused outright', normaliseState('nope') === null, 'string');

// ------------------------------------------------------------------ 6. the keyboard reference matches the handler

// The dialog prints labels, the handler matches `event.key` values, and `KEY_LABELS` is the
// bridge. Compared both ways: a key the handler maps but the reference omits fails, and so
// does a labelled row that maps to nothing.
const bound = new Map<string, string>();
for (const group of SHORTCUT_GROUPS) {
  for (const row of group.rows) {
    if (!row.bind) continue;
    for (const label of row.keys) bound.set(label, row.bind);
  }
}
check(
  'the map the handler looks up is the inverse of the key list',
  json(Object.entries(PLAIN_KEY_ACTIONS).sort()) === json(Object.entries(PLAIN_KEYS).flatMap(([action, keys]) => keys.map((key) => [key, action])).sort()),
  json(PLAIN_KEY_ACTIONS),
);
const expected = new Map<string, string>();
for (const [action, keys] of Object.entries(PLAIN_KEYS)) {
  for (const key of keys) expected.set(KEY_LABELS[key] ?? key, action as string);
}
check('the reference lists exactly the keys the handler maps, and no others', json([...bound.entries()].sort()) === json([...expected.entries()].sort()), json([[...bound.entries()].sort(), [...expected.entries()].sort()]));
for (const [action, keys] of Object.entries(PLAIN_KEYS)) {
  const listed = [...bound.entries()].filter(([, mapped]) => mapped === action).map(([label]) => label).sort();
  check(`the row for ${action} names the same keys the handler maps`, json(listed) === json([...new Set(keys.map((key) => KEY_LABELS[key] ?? key))].sort()), json([listed, keys]));
}

const appSource = readFileSync('src/app.ts', 'utf8');
const handlerStart = appSource.indexOf('private bindKeyboard(): void {');
const handlerEnd = appSource.indexOf('private bindWindow(): void {');
check('app.ts still has one keyboard handler to compare against', handlerStart >= 0 && handlerEnd > handlerStart, json([handlerStart, handlerEnd]));
const handler = appSource.slice(handlerStart, handlerEnd);

check('the handler reads its plain keys from the table, not from literals of its own', handler.includes('PLAIN_KEY_ACTIONS') && !handler.includes("case 'ArrowLeft'"), 'PLAIN_KEY_ACTIONS');
for (const group of SHORTCUT_GROUPS) {
  for (const row of group.rows) {
    if (!row.literal) continue;
    check(`the reference lists ${row.keys.join(' / ')} and app.ts binds it`, handler.includes(row.literal), row.literal);
  }
}
// Every key the handler acts on has to appear in the reference, or the list is incomplete.
const listedLiterals = SHORTCUT_GROUPS.flatMap((group) => group.rows.flatMap((row) => row.literal ?? []));
const listedLabels = new Set(SHORTCUT_GROUPS.flatMap((group) => group.rows.flatMap((row) => row.keys)));
for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'f', 'l', 'Escape', 'Delete', 'Backspace', 'i']) {
  const label = KEY_LABELS[key] ?? key;
  check(`the reference covers ${key}`, listedLiterals.includes(`'${key}'`) || bound.has(label) || listedLabels.has(label), key);
}
check('the reference covers the symbol search and settings keys', listedLiterals.includes("'/'") && listedLiterals.includes("'?'"), json(listedLiterals));

console.log(`settings/templates: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
if (failures.length > 0) process.exitCode = 1;
