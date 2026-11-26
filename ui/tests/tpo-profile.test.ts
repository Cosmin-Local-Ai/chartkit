/**
 * Checks for the client's side of the TPO / market-profile pane.
 *
 * The server cuts the grid, assigns the letters and reads the levels
 * (`crates/core/src/flow.rs`, `crates/store/src/db.rs`), so what is tested here is the
 * client's reading of that answer: that a bucket's letter means the same span on both sides,
 * that a window crossing a session boundary keeps two sessions apart, that a stretch the
 * stored prints do not reach reads as unanswered rather than as a session nobody traded in,
 * and that a stored settings document cannot hand the pane a grid the server would refuse.
 *
 * The recorded slice in `liveAnswer` is a real `/api/tpo` answer over BINANCE:BTCUSDT,
 * 2026-11-26 00:00→03:00 UTC, half-hour buckets, one venue tick per row, trimmed to the
 * fields these checks read.
 *
 * Run it with:
 *   npx rolldown tests/tpo-profile.test.ts -o /tmp/tpo-profile-test.mjs -f esm && node /tmp/tpo-profile-test.mjs
 */

// The test runs in node, whose globals the DOM-only tsconfig does not carry.
declare const process: { exitCode: number };

import type { TpoSeries, TpoSession } from '../src/types';
import {
  DEFAULT_TPO_SETTINGS,
  bucketMinutes,
  bucketStartOf,
  gridProblem,
  liveLetter,
  normaliseTpoSettings,
  sessionStartOf,
  tpoLetter,
  type TpoSettings,
} from '../src/tpoSettings';
import {
  columnsFor,
  coverageNote,
  cellGrade,
  featuredSession,
  rowCountFor,
  stepTicksFor,
  tradedExtent,
  valueAreaBounds,
} from '../src/panes/tpoModel';

const failures: string[] = [];

function check(condition: unknown, label: string): void {
  if (!condition) failures.push(label);
}

/**
 * A fixture part the rest of the block indexes. A missing part is a broken fixture, not a
 * behaviour under test, so it is reported and stood in for rather than thrown on.
 */
function need<T>(value: T | undefined, label: string, fallback: T): T {
  if (value === undefined) failures.push(`fixture is missing ${label}`);
  return value ?? fallback;
}

const NO_SESSION: TpoSession = {
  start: 0,
  end: 0,
  letters: '',
  buckets: [],
  rows: [],
  poc: null,
  vah: null,
  val: null,
  valueArea: 0.7,
  valueAreaBasis: 'volume',
  prints: 0,
  totalQty: 0,
  developing: false,
};

function equal<T>(got: T, want: T, label: string): void {
  if (!Object.is(got, want)) failures.push(`${label}: got ${String(got)}, want ${String(want)}`);
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** A UTC midnight, so a session that starts at minute 0 of the day is easy to read. */
const DAY0 = 1_700_000_000_000 - (1_700_000_000_000 % DAY);

// ------------------------------------------------------------------ letter assignment

check(tpoLetter(0) === 'A' && tpoLetter(1) === 'B' && tpoLetter(25) === 'Z', 'the first alphabet runs A to Z');
check(tpoLetter(26) === 'a' && tpoLetter(51) === 'z', 'a 24 hour session of half hours needs 48 marks, so the second alphabet is lower case');
check(tpoLetter(52) === 'A1' && tpoLetter(77) === 'Z1' && tpoLetter(78) === 'A2', 'past two alphabets the cycle number rides along');
check(tpoLetter(-1) === '?' && tpoLetter(Number.NaN) === '?', 'a bucket with no place in a session has no letter');
{
  const marks = new Set<string>();
  for (let index = 0; index < 400; index += 1) marks.add(tpoLetter(index));
  equal(marks.size, 400, 'no two buckets may share a mark');
}

// ------------------------------------------------------------------ session boundaries

const DAILY: TpoSettings = { ...DEFAULT_TPO_SETTINGS };
equal(DEFAULT_TPO_SETTINGS.sessionLengthMinutes, 1_440, 'the default session is a UTC day');
equal(bucketMinutes(DAILY), 30, 'the default bucket is half an hour');

equal(sessionStartOf(DAY0 + 95 * MINUTE, DAILY), DAY0, 'a minute inside a session names its start');
equal(sessionStartOf(DAY0, DAILY), DAY0, 'the first minute of a session is its own start');
equal(sessionStartOf(DAY0 - 1, DAILY), DAY0 - DAY, 'the last millisecond of the day before belongs to the day before');
equal(bucketStartOf(DAY0 + 29 * MINUTE + 999, DAILY), DAY0, 'the last millisecond of a bucket stays in it');
equal(bucketStartOf(DAY0 + 30 * MINUTE, DAILY), DAY0 + 30 * MINUTE, 'the first millisecond of the next bucket opens it');
equal(liveLetter(DAY0, DAILY), 'A', 'the session opens at A');
equal(liveLetter(DAY0 + 30 * MINUTE, DAILY), 'B', 'and the next bucket is B');
equal(liveLetter(DAY0 + DAY - 30 * MINUTE, DAILY), 'v', 'the 48th half hour of a UTC day');
equal(liveLetter(DAY0 + DAY, DAILY), 'A', 'the next session starts its letters again');

const SHIFTED: TpoSettings = { ...DEFAULT_TPO_SETTINGS, sessionStartMinute: 17 * 60 };
equal(sessionStartOf(DAY0 + 18 * HOUR, SHIFTED), DAY0 + 17 * HOUR, 'a session that starts at 17:00 begins there');
equal(sessionStartOf(DAY0 + 17 * HOUR - 1, SHIFTED), DAY0 - 7 * HOUR, 'and the minute before it belongs to the session before');
equal(liveLetter(DAY0 + 17 * HOUR, SHIFTED), 'A', 'a moved boundary moves the letters with it');
// The bucket at 16:30 belongs to the session that opened at 17:00 the day before, and it is
// the 48th bucket of that session, so it carries the 48th mark rather than restarting.
equal(liveLetter(DAY0 + 17 * HOUR - MINUTE, SHIFTED), tpoLetter(47), 'one minute before the boundary is the last bucket of the session before');
{
  // A bucket that straddled a boundary would carry two sessions under one letter.
  const starts = new Set<number>();
  for (let minute = 0; minute < 1_440; minute += 1) {
    const ts = DAY0 + minute * MINUTE;
    const session = sessionStartOf(ts, SHIFTED);
    const bucket = bucketStartOf(ts, SHIFTED);
    if (bucket < session || bucket >= session + DEFAULT_TPO_SETTINGS.sessionLengthMinutes * MINUTE) {
      failures.push(`bucket ${bucket} sits outside its session ${session}`);
    }
    starts.add(session);
  }
  equal(starts.size, 2, 'a day of minutes crosses two 17:00 sessions');
}

// ------------------------------------------------------------------ the grid the server accepts

check(gridProblem(DAILY) === null, 'the default grid is one the server accepts');
check(gridProblem({ ...DAILY, periodLength: { count: 7, unit: 'minute' } }) !== null, 'seven minute buckets do not divide a day');
check(gridProblem({ ...DAILY, periodLength: { count: 60, unit: 'minute' } }) === null, 'an hour is a day divisor');
check(gridProblem({ ...DAILY, periodLength: { count: 4, unit: 'hour' } }) === null, 'four hours is a day divisor');
check(gridProblem({ ...DAILY, sessionLengthMinutes: 90, periodLength: { count: 60, unit: 'minute' } }) !== null, 'a session shorter than two buckets');
check(gridProblem({ ...DAILY, sessionStartMinute: 1_440 }) !== null, 'a session starts at a minute of the UTC day');

{
  // A stored document whose pair drifted apart must come back asking for a grid that divides,
  // because the server answers a bad grid with a 400 and the pane would show an error instead
  // of a profile.
  const drifted = normaliseTpoSettings({ periodLength: { count: 7, unit: 'minute' }, sessionLengthMinutes: 1_440 });
  check(gridProblem(drifted) === null, `a drifted pair was not repaired: ${JSON.stringify(drifted.periodLength)}`);
  equal(bucketMinutes(drifted), 6, 'the repair moves the bucket to the largest divisor that fits');
  const nonsense = normaliseTpoSettings({
    periodLength: { count: 'many', unit: 'fortnight' },
    sessionStartMinute: -5,
    sessionLengthMinutes: 0,
    profileSpacing: 999,
    valueAreaPercentage: 4,
    letterMode: 'hieroglyphs',
    blockShape: 'round',
    cellGrading: 'vibes',
    customTPOColors: ['#26b98a', '#zzzzzz', '#12345678'],
    outsideVAOpacity: 12,
    pocColor: 'crimson',
  });
  check(gridProblem(nonsense) === null, 'nonsense settings still describe a grid the server accepts');
  equal(nonsense.letterMode, DEFAULT_TPO_SETTINGS.letterMode, 'an unknown letter mode falls back');
  equal(nonsense.blockShape, DEFAULT_TPO_SETTINGS.blockShape, 'an unknown block shape falls back');
  equal(nonsense.cellGrading, DEFAULT_TPO_SETTINGS.cellGrading, 'an unknown grading falls back');
  equal(nonsense.profileSpacing, 24, 'a row height is clamped to what the pane can draw');
  equal(nonsense.valueAreaPercentage, 1, 'a value-area fraction is clamped to a fraction');
  equal(nonsense.sessionStartMinute, 0, 'a session start before the day is clamped onto it');
  equal(nonsense.customTPOColors[1], DEFAULT_TPO_SETTINGS.customTPOColors[1], 'an unreadable colour slot keeps its own default');
  equal(nonsense.customTPOColors[0], '#26b98a', 'a readable slot is kept as the document wrote it');
  equal(nonsense.customTPOColors[2], '#123456', 'an eight digit slot is read as rgb');
  equal(nonsense.customTPOColors[3], DEFAULT_TPO_SETTINGS.customTPOColors[3], 'a missing slot keeps the default');
  equal(nonsense.pocColor, DEFAULT_TPO_SETTINGS.pocColor, 'a named colour is not a hex the canvas can take');
  check(nonsense.sessionLengthMinutes >= 2, 'a session of no minutes cannot be cut');
}
{
  // Settings are what survives a reload, so a document round-trips without drift.
  const round = normaliseTpoSettings(JSON.parse(JSON.stringify(DEFAULT_TPO_SETTINGS)));
  check(JSON.stringify(round) === JSON.stringify(DEFAULT_TPO_SETTINGS), 'the defaults round-trip unchanged');
  const edited = normaliseTpoSettings({ ...DEFAULT_TPO_SETTINGS, periodLength: { count: 4, unit: 'hour' }, valueAreaMethod: 'tpo' });
  equal(bucketMinutes(edited), 240, 'an hourly bucket is four hours of minutes');
  equal(edited.valueAreaMethod, 'tpo', 'the value-area method survives');
  check(gridProblem(edited) === null, 'four hour buckets divide a UTC day');
}

// ------------------------------------------------------------------ a recorded answer

/** One cell of the grid, as the wire sends it: `[bottom edge, cell]`. */
function cell(price: number, buyQty: number, sellQty: number, buyN: number, sellN: number): [number, { buyQty: number; sellQty: number; buyN: number; sellN: number }] {
  return [price, { buyQty, sellQty, buyN, sellN }];
}

function sessionOf(start: number, end: number, letters: string, buckets: TpoSession['buckets'], rows: TpoSession['rows'], levels: [number | null, number | null, number | null], developing: boolean): TpoSession {
  return {
    start,
    end,
    letters,
    buckets,
    rows,
    poc: levels[0],
    vah: levels[1],
    val: levels[2],
    valueArea: 0.7,
    valueAreaBasis: 'volume',
    prints: buckets.reduce((sum, bucket) => sum + bucket.prints, 0),
    totalQty: buckets.reduce((sum, bucket) => sum + bucket.totalQty, 0),
    developing,
  };
}

function answer(sessions: TpoSession[], covered: [number | null, number | null]): TpoSeries {
  return {
    instrument: 'BINANCE:BTCUSDT',
    from: sessions[0]?.start ?? null,
    to: sessions[sessions.length - 1]?.end ?? null,
    priceTick: 0.01,
    stepTicks: 50,
    bucketMinutes: 30,
    sessionMinutes: 1_440,
    sessionStartMinute: 0,
    bucketRule: '30 minute buckets, letters restarting at each session',
    sessionRule: '1440 minute sessions from minute 0 of the UTC day',
    valueAreaRule: 'value area 70% of traded volume',
    sessions,
    prints: sessions.reduce((sum, session) => sum + session.prints, 0),
    totalQty: sessions.reduce((sum, session) => sum + session.totalQty, 0),
    coveredFrom: covered[0],
    coveredTo: covered[1],
  };
}

/** A slice of the recorded answer: six half-hour buckets of one session, A to F. */
const RECORDED_BUCKETS: TpoSession['buckets'] = [0, 1, 2, 3, 4, 5].map((index) => {
  const start = DAY0 + index * 30 * MINUTE;
  const letter = tpoLetter(index);
  const rows: [number, TpoSession['buckets'][number]['rows'][number][1]][] = [
    cell(60_506.01 + index * 0.5, 1.25, 0.75, 3, 2),
    cell(61_000.0, 4, 1, 5, 1),
    cell(61_083.99, 0.5, 2.5, 1, 4),
  ];
  const prints = rows.reduce((sum, [, c]) => sum + c.buyN + c.sellN, 0);
  const totalQty = rows.reduce((sum, [, c]) => sum + c.buyQty + c.sellQty, 0);
  return { start, letter, rows, prints, totalQty, poc: 61_000.0 };
});

const RECORDED_ROWS: TpoSession['rows'] = [
  { price: 60_506.01, tpoCount: 6, prints: 30, buyQty: 7.5, sellQty: 4.5, totalQty: 12 },
  { price: 61_000.0, tpoCount: 6, prints: 36, buyQty: 24, sellQty: 6, totalQty: 30 },
  { price: 61_083.99, tpoCount: 5, prints: 25, buyQty: 2.5, sellQty: 12.5, totalQty: 15 },
];

const RECORDED = answer(
  [sessionOf(DAY0, DAY0 + DAY, 'ABCDEF', RECORDED_BUCKETS, RECORDED_ROWS, [61_000.0, 61_083.99, 60_506.01], true)],
  [DAY0, DAY0 + 150 * MINUTE],
);

{
  // The letters the pane draws come from the answer; the client's own grid has to agree, or a
  // letter on screen means a span the answer never had.
  const session = need(RECORDED.sessions[0], 'the recorded session', NO_SESSION);
  equal(session.letters.length, session.buckets.length, 'one letter per bucket that traded');
  session.buckets.forEach((bucket, index) => {
    equal(bucket.letter, tpoLetter(index), 'the bucket carries the letter its place in the session gives it');
    equal(bucket.letter, session.letters[index], 'and the same letter the session lists');
    equal(bucket.start, bucketStartOf(bucket.start, DAILY), 'the bucket start is already on the grid');
    equal(liveLetter(bucket.start, DAILY), bucket.letter, 'the client would have picked the same letter itself');
  });
  const firstBucket = need(session.buckets[0], 'the first recorded bucket', { start: DAY0, letter: 'A', rows: [], prints: 0, totalQty: 0, poc: null });
  equal(firstBucket.start, sessionStartOf(firstBucket.start, DAILY), 'the session starts where the grid says');
  const extent = tradedExtent(RECORDED);
  check(extent !== null && extent.low === 60_506.01 && extent.high === 61_083.99, 'the pane frames the prices that traded, not the wicks');
  const area = valueAreaBounds(session);
  check(area !== null && area.high === 61_083.99 && area.low === 60_506.01, 'the value area is ordered high first');
  const flipped = sessionOf(DAY0, DAY0 + DAY, 'A', RECORDED_BUCKETS.slice(0, 1), RECORDED_ROWS, [61_000.0, 60_506.01, 61_083.99], false);
  const flippedArea = valueAreaBounds(flipped);
  check(flippedArea !== null && flippedArea.high === 61_083.99 && flippedArea.low === 60_506.01, 'a venue that ever sent the pair the other way cannot put a price on the wrong name');
  check(valueAreaBounds(sessionOf(DAY0, DAY0 + DAY, 'A', [], [], [null, null, null], false)) === null, 'a session with no levels has no band');
  const columns = columnsFor(RECORDED, DAILY, 30 * MINUTE);
  equal(columns.length, 6, 'every bucket that traded becomes a column');
  equal(columns[0]?.cells.length, 3, 'and one cell per row it traded in');
  check(columns.every((column) => column.end - column.start === 30 * MINUTE), 'a column is exactly one bucket wide');
  const counts = RECORDED_ROWS.map((row) => row.tpoCount);
  check(counts.every((count, index) => count === (index === 2 ? 5 : 6)), 'the letter count beside a row is the row of the answer, not a client tally');
  equal(featuredSession(RECORDED), RECORDED.sessions[0], 'the developing session is the one the pane features');
}

// ------------------------------------------------------------------ two sessions stay apart

{
  const today = need(RECORDED.sessions[0], 'the recorded session', NO_SESSION);
  const yesterday = sessionOf(
    DAY0 - DAY,
    DAY0,
    'ABCDEFGH',
    [0, 1, 2, 3, 4, 5, 6, 7].map((index) => ({
      start: DAY0 - DAY + index * 30 * MINUTE,
      letter: tpoLetter(index),
      rows: [cell(59_000 + index, 2, 1, 2, 1)],
      prints: 3,
      totalQty: 3,
      poc: 59_000 + index,
    })),
    [{ price: 59_000, tpoCount: 8, prints: 24, buyQty: 16, sellQty: 8, totalQty: 24 }],
    [59_004, 59_007, 59_001],
    false,
  );
  const firstOfYesterday = need(yesterday.buckets[0], "yesterday's first bucket", { start: DAY0 - DAY, letter: 'A', rows: [], prints: 0, totalQty: 0, poc: null });
  const lastOfToday = need(today.buckets[today.buckets.length - 1], "today's last bucket", { start: DAY0, letter: 'F', rows: [], prints: 0, totalQty: 0, poc: null });
  const crossed = answer([yesterday, today], [firstOfYesterday.start, lastOfToday.start]);

  equal(crossed.sessions.length, 2, 'a window across a boundary answers two sessions, never a blend');
  const columns = columnsFor(crossed, DAILY, 30 * MINUTE);
  equal(columns.length, 14, 'and every bucket of both');
  equal(columns[8]?.letter, 'A', 'the second session opens at A again');
  check(columns[8]?.sessionIndex === 1, 'a column knows which session it belongs to');
  const areaToday = valueAreaBounds(today);
  const areaYesterday = valueAreaBounds(yesterday);
  const insideToday = columns.filter((column) => column.sessionIndex === 1).flatMap((column) => column.cells);
  const insideYesterday = columns.filter((column) => column.sessionIndex === 0).flatMap((column) => column.cells);
  check(insideToday.length > 0 && insideToday.every((c) => c.inValueArea === (c.price >= (areaToday?.low ?? 0) && c.price <= (areaToday?.high ?? 0))), 'value-area membership is each session’s own');
  check(insideYesterday.length > 0 && insideYesterday.some((c) => !c.inValueArea), 'a row outside one session’s value area is not inside the next one’s by accident');
  equal(featuredSession(crossed), today, 'the live session is the featured one, not the older');
  // Levels are per session, so blending them would put an edge between two auctions.
  check(crossed.sessions.every((session) => session.poc !== null), 'both sessions keep their own point of control');
}

// ------------------------------------------------------------------ the coverage note

{
  const askedFrom = DAY0;
  const askedTo = DAY0 + 6 * HOUR;
  check(coverageNote(RECORDED, askedFrom, DAY0 + 180 * MINUTE) === null, 'a window the prints reach needs no note');

  const wider = answer(RECORDED.sessions, [DAY0 + 30 * MINUTE, DAY0 + 150 * MINUTE]);
  const note = coverageNote(wider, DAY0 - 2 * HOUR, askedTo);
  check(note !== null, 'a window wider than the prints has to say so');
  check(note !== null && note.includes('unanswered'), `the note must not call the missing stretch empty: ${note}`);
  check(note !== null && /\d+ of the \d+ minutes/.test(note), `the note gives the reader the size of the gap: ${note}`);

  const nothing = answer([], [null, null]);
  equal(coverageNote(nothing, askedFrom, askedTo), 'no prints stored for this window', 'an answer with no sessions says there is nothing to draw');

  const hole = sessionOf(DAY0, DAY0 + DAY, 'AB', RECORDED_BUCKETS.slice(0, 2), RECORDED_ROWS, [61_000.0, 61_083.99, 60_506.01], false);
  const holed = answer([hole], [DAY0, DAY0 + 30 * MINUTE]);
  const holeNote = coverageNote(holed, DAY0, DAY0 + 6 * HOUR);
  check(holeNote !== null, 'prints that stop early are reported, not padded to the window');
  equal(holed.sessions[0]?.buckets.length, 2, 'a bucket the store returned nothing for is absent rather than empty');
  equal(holed.sessions[0]?.letters, 'AB', 'and the letters follow the buckets that exist');
}

// ------------------------------------------------------------------ row width and grading

{
  // The row width travels in the request, so an exact division would refetch on every pan.
  const tick = 0.01;
  const rows = rowCountFor(300, 6);
  equal(rows, 50, 'the row count is what fits the pane at the configured height');
  const a = stepTicksFor(2_000, tick, rows);
  const b = stepTicksFor(2_040, tick, rows);
  check(a >= 2_000 / tick / rows, 'the row width covers the span it was asked for');
  equal(a, b, 'a pan that barely moves the span keeps the same row width, so the same answer');
  const tiny = stepTicksFor(0.4, tick, rows);
  equal(tiny, 1, 'a span narrower than one tick per row asks for the venue grid itself');
  equal(stepTicksFor(0, tick, rows), 1, 'a degenerate span asks for the venue grid');
  equal(stepTicksFor(2_000, 0, rows), 1, 'a symbol with no tick cannot be folded');
  check(rowCountFor(20, 6) === 8 && rowCountFor(100_000, 6) === 120, 'the row count stays inside what the pane can draw');
}
{
  const buy = { buyQty: 9, sellQty: 1, buyN: 5, sellN: 2 };
  equal(cellGrade(buy, 'volume'), 10, 'volume grading adds both sides');
  equal(cellGrade(buy, 'delta'), 8, 'delta grading takes the difference');
  equal(cellGrade(buy, 'total'), 7, 'print-count grading counts prints, not size');
  const columns = columnsFor(RECORDED, { ...DAILY, cellGrading: 'total' }, 30 * MINUTE);
  check(columns.every((column) => column.cells.every((c) => c.grade === c.cell.buyN + c.cell.sellN)), 'the pane grades cells the way the setting says');
}

// ------------------------------------------------------------------ report

if (failures.length > 0) {
  console.log(`tpo-profile: ${failures.length} failure(s)`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('tpo-profile: ok');
}
