/**
 * Alerts: the rules behind the panel, and the guard in front of the desktop popup.
 *
 * The panel itself is DOM, so what is checked here is the contract underneath it: a server
 * payload is validated before the panel trusts it, a condition reads in words the trader can
 * check against what they typed, a form refuses a rule the evaluator could not judge, fires
 * from the socket and from history collapse into one list, and every popup path the browser
 * can refuse ends quietly with the list still written.
 *
 * The contract is this project's own: the shipped product's alert payload was never
 * inspected, so nothing here is compared against a third party's wire format.
 *
 * Run it from `ui/` with:
 *   npx rolldown tests/alerts.test.ts -o /tmp/alerts-test.mjs -f esm && node /tmp/alerts-test.mjs
 * The last section reads source files from disk, so the working directory has to be `ui/`.
 */

// The test runs in node, whose globals the DOM-only tsconfig does not carry.
declare const process: { exitCode: number };

import { readFileSync } from 'node:fs';

import {
  ALERT_KINDS,
  FRESH_FIRE_MS,
  buildAlert,
  conditionText,
  crossingExplanation,
  crossingText,
  draftFrom,
  fireValueText,
  formatLevel,
  grantNotice,
  isAlertKind,
  kindMeta,
  mergeFires,
  newDraft,
  notificationGrant,
  parseAlerts,
  parseFires,
  rearmText,
  shouldNotify,
  trimNumber,
  windowLabel,
  type AlertDraft,
  type AlertPayload,
  type DraftBuild,
  type NotificationGrant,
} from '../src/alertsModel';
import { DesktopNotifier, deliver, probe, type Desktop, type NotificationLike } from '../src/notify';
import type { AlertFire, AlertKind, AlertRecord } from '../src/types';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed += 1;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const json = (value: unknown): string => JSON.stringify(value);

/** The intervals the app offers a window rule. */
const WINDOWS = ['1m', '5m', '1h', '1d', '1mo', 'session'];
const PRECISION = 2;
const NOW = 1_700_000_020_000;

const GRANT_TEXTS: Record<NotificationGrant, string> = {
  on: grantNotice('on'),
  asking: grantNotice('asking'),
  blocked: grantNotice('blocked'),
  unsupported: grantNotice('unsupported'),
};

/** A rule exactly as the server sends one. */
function ruleRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'al0000000000000001',
    instrument: 'BINANCE:BTCUSDT',
    kind: 'price-above',
    threshold: 59_000,
    rearmGap: 25,
    label: 'reclaims the level',
    enabled: true,
    muted: false,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_500,
    armed: true,
    ...over,
  };
}

function fireRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'fv0000000000000001',
    alertId: 'al0000000000000001',
    instrument: 'BINANCE:BTCUSDT',
    kind: 'price-above',
    threshold: 59_000,
    value: 59_012.5,
    ts: 1_700_000_010_000,
    label: 'reclaims the level',
    muted: false,
    missed: false,
    ...over,
  };
}

function record(over: Partial<AlertRecord> = {}): AlertRecord {
  return parseAlerts({ items: [ruleRow(over)] })[0]!;
}

function fire(over: Record<string, unknown> = {}): AlertFire {
  return parseFires({ items: [fireRow(over)] })[0]!;
}

function payload(over: Partial<AlertPayload> = {}): AlertPayload {
  return {
    instrument: 'BINANCE:BTCUSDT',
    kind: 'price-above',
    threshold: 59_012.34,
    rearmGap: 0,
    label: '',
    enabled: true,
    muted: false,
    ...over,
  };
}

/** The request a build produced, or the reason it refused, for one comparison per check. */
function built(build: DraftBuild): AlertPayload | string {
  return build.ok ? build.payload : build.error;
}

// ------------------------------------------------------------------ 1. the kinds and what settles them

check('every condition names the point that settles it', ALERT_KINDS.every((meta) => meta.evaluation.length > 0));
check('price rules read prints and window rules read closed bars',
  json(ALERT_KINDS.map((meta) => [meta.id, meta.evaluation])) ===
    json([
      ['price-above', 'every live print'],
      ['price-below', 'every live print'],
      ['price-in-range', 'every live print'],
      ['volume-above', 'each closed bar'],
      ['delta-above', 'each closed bar'],
    ]),
  json(ALERT_KINDS.map((meta) => [meta.id, meta.evaluation])),
);
check('only the window rules are asked for a bar', json(ALERT_KINDS.filter((meta) => meta.needsWindow).map((meta) => meta.id)) === json(['volume-above', 'delta-above']));
check('only the range rule is asked for a second edge', json(ALERT_KINDS.filter((meta) => meta.needsUpperLevel).map((meta) => meta.id)) === json(['price-in-range']));
check('a level is a price for price rules and a quantity for the rest',
  json(ALERT_KINDS.map((meta) => [meta.id, meta.unit])) ===
    json([
      ['price-above', 'price'],
      ['price-below', 'price'],
      ['price-in-range', 'price'],
      ['volume-above', 'quantity'],
      ['delta-above', 'quantity'],
    ]),
  json(ALERT_KINDS.map((meta) => [meta.id, meta.unit])),
);
check('an unknown kind falls back instead of taking the row down', kindMeta('made-up').id === 'price-above' && kindMeta('volume-above').id === 'volume-above');
check('the kinds the server can send are the kinds the form offers',
  json((['price-above', 'price-below', 'price-in-range', 'volume-above', 'delta-above'] as const).map((kind: AlertKind) => isAlertKind(kind))) === json([true, true, true, true, true]) &&
    !isAlertKind('price-crosses-above') &&
    !isAlertKind(undefined),
);

// ------------------------------------------------------------------ 2. reading what the server sent

check('a rule round-trips from the server shape', json(parseAlerts({ items: [ruleRow()] })[0]) === json(record()), json(parseAlerts({ items: [ruleRow()] })[0]));
check('a bare array is accepted too', json(parseAlerts([ruleRow()])) === json([record()]));
check('no items means no rules, not a crash', json(parseAlerts(undefined)) === json([]) && json(parseAlerts({ items: 'nope' })) === json([]) && json(parseAlerts([null, 7, 'x'])) === json([]));

const malformed: Record<string, unknown>[] = [
  { ...ruleRow(), id: '' },
  { ...ruleRow(), instrument: '' },
  { ...ruleRow(), instrument: null },
  { ...ruleRow(), kind: 'price-crosses-above' },
  { ...ruleRow(), threshold: 'a lot' },
  { ...ruleRow(), threshold: null },
  { ...ruleRow(), createdAt: null },
  { ...ruleRow(), updatedAt: undefined },
];
for (const row of malformed) {
  const field = Object.entries(row).find(([key]) => !key.startsWith('id') || row.id === '') ?? ['?'];
  check(`a rule broken at ${json(field[0])} is dropped`, parseAlerts({ items: [row] }).length === 0, json(parseAlerts({ items: [row] })));
}
check('a negative gap is read as none rather than an earlier re-arm', record({ rearmGap: -5 }).rearmGap === 0);
check('a missing gap is read as none', parseAlerts({ items: [{ ...ruleRow(), rearmGap: undefined }] })[0]!.rearmGap === 0);
check('flags are read strictly, so a string never switches a rule on',
  parseAlerts({ items: [ruleRow({ enabled: 'true', muted: 1, armed: 'yes' })] })[0]!.enabled === false &&
    parseAlerts({ items: [ruleRow({ enabled: 'true', muted: 1, armed: 'yes' })] })[0]!.armed === false,
);
check('absent optional fields stay absent', !('thresholdHigh' in record()) && !('lastFiredAt' in record()));
const optionals = record({ kind: 'price-in-range', thresholdHigh: 59_500, timeframe: '5m', lastFiredAt: 1_700_000_020_000, armed: false });
check('the range edge, the window and the crossing state come through',
  optionals.thresholdHigh === 59_500 && optionals.timeframe === '5m' && optionals.lastFiredAt === 1_700_000_020_000 && optionals.armed === false,
  json(optionals),
);

const listed = parseFires({
  items: [fireRow({ ts: 200 }), fireRow({ id: 'fv0000000000000002', ts: 400 }), fireRow({ id: 'fv0000000000000003', ts: 300 })],
});
check('fires come back newest first', json(listed.map((entry) => entry.ts)) === json([400, 300, 200]), json(listed.map((entry) => entry.ts)));
check('a fire missing its value or stamp is dropped', parseFires({ items: [fireRow({ value: null }), fireRow({ id: 'x', ts: null })] }).length === 0);
check('a missed fire keeps the flag that says so', fire({ missed: true }).missed === true);
check('a flat socket message parses like a history row', parseFires({ items: [{ ...fireRow(), type: 'alert' }] })[0]!.id === 'fv0000000000000001');

// ------------------------------------------------------------------ 3. one list, no duplicates

const first = fire({ id: 'fv0000000000000001', ts: 300 });
const second = fire({ id: 'fv0000000000000002', ts: 500 });
const merged = mergeFires([first], [second, first]);
check('a fire that arrives twice is listed once', merged.length === 2 && merged.filter((entry) => entry.id === first.id).length === 1, json(merged.map((entry) => entry.id)));
check('the merged list is newest first', json(merged.map((entry) => entry.ts)) === json([500, 300]), json(merged.map((entry) => entry.ts)));
check('an older server list does not overwrite a newer local fire', json(mergeFires([second], [first]).map((entry) => entry.ts)) === json([500, 300]));
const many = Array.from({ length: 60 }, (_, index) => fire({ id: `id${String(index).padStart(4, '0')}`, ts: index }));
check('the listed memory is bounded', mergeFires(many, [], 50).length === 50);
check('the bound is a memory choice, not a limit on alerts', mergeFires(many, [], 0).length === 60);

// ------------------------------------------------------------------ 4. how a rule reads in words

check('a price rule reads as the level it watches', conditionText({ kind: 'price-above', threshold: 59_000 }, PRECISION) === 'last price above 59,000', conditionText({ kind: 'price-above', threshold: 59_000 }, PRECISION));
check('a range rule names both edges',
  conditionText({ kind: 'price-in-range', threshold: 59_000, thresholdHigh: 59_500 }, PRECISION) === 'last price between 59,000 and 59,500',
  conditionText({ kind: 'price-in-range', threshold: 59_000, thresholdHigh: 59_500 }, PRECISION),
);
check('a volume rule names its bar', conditionText({ kind: 'volume-above', threshold: 1_250, timeframe: '5m' }, PRECISION) === '5m volume above 1,250', conditionText({ kind: 'volume-above', threshold: 1_250, timeframe: '5m' }, PRECISION));
check('a delta rule names its bar', conditionText({ kind: 'delta-above', threshold: 12.5, timeframe: '1h' }, PRECISION) === '1h delta above 12.5', conditionText({ kind: 'delta-above', threshold: 12.5, timeframe: '1h' }, PRECISION));
check('a window rule with no window still prints', conditionText({ kind: 'volume-above', threshold: 10 }, PRECISION) === '— volume above 10.0', conditionText({ kind: 'volume-above', threshold: 10 }, PRECISION));
check('a quantity is not printed with price decimals', formatLevel(1_234.567, 'volume-above', 2) === '1,235' && formatLevel(0.25, 'delta-above', 2) === '0.25', json([formatLevel(1_234.567, 'volume-above', 2), formatLevel(0.25, 'delta-above', 2)]));
check('a price is printed with the venue precision', formatLevel(59_012.5, 'price-above', 1) === '59,012.5', formatLevel(59_012.5, 'price-above', 1));
check('the fire line says what satisfied the rule',
  fireValueText(fire({ kind: 'price-above', value: 59_012.5 }), PRECISION) === 'at 59,012.5' &&
    fireValueText(fire({ kind: 'volume-above', value: 1_250 }), PRECISION) === 'volume 1,250' &&
    fireValueText(fire({ kind: 'delta-above', value: 12.5 }), PRECISION) === 'delta +12.5',
  json([fireValueText(fire({ kind: 'price-above', value: 59_012.5 }), PRECISION), fireValueText(fire({ kind: 'delta-above', value: 12.5 }), PRECISION)]),
);
check('a re-arm gap is shown only when there is one',
  rearmText(record({ rearmGap: 0 }), PRECISION) === '' && rearmText(record({ rearmGap: 50 }), PRECISION) === 're-arms 50 back',
  json([rearmText(record({ rearmGap: 0 }), PRECISION), rearmText(record({ rearmGap: 50 }), PRECISION)]),
);
check('an interval label is the one the interval picker uses', windowLabel('1h') === '1h' && windowLabel(undefined) === '—');
check('a held level reads short and says why in full',
  crossingText(record({ armed: false })) === 'level held' &&
    crossingExplanation(record({ armed: false })) === 'The level is held. It stays quiet until the level is given back.',
  json([crossingText(record({ armed: false })), crossingExplanation(record({ armed: false }))]),
);
check('an armed rule says what it is waiting for',
  crossingText(record({ armed: true })) === 'waiting to cross' &&
    crossingText(record({ kind: 'volume-above', timeframe: '1m', armed: true })) === 'waiting for its bar' &&
    crossingExplanation(record({ kind: 'volume-above', timeframe: '1m', armed: true })) === 'Waiting for a closed bar that reaches the level.',
  json([crossingText(record({ armed: true })), crossingText(record({ kind: 'volume-above', timeframe: '1m', armed: true }))]),
);
check('a switched-off rule promises nothing',
  crossingText(record({ enabled: false })) === 'switched off' && crossingExplanation(record({ enabled: false })) === 'Switched off; nothing is judged.',
);
check('the short state stays short enough to survive a narrow row',
  ALERT_KINDS.every(
    (meta) =>
      crossingText({ kind: meta.id, enabled: true, armed: true }).length <= 19 && crossingText({ kind: meta.id, enabled: true, armed: false }).length <= 11,
  ),
);

// ------------------------------------------------------------------ 5. the form refuses what cannot be judged

const draft = (over: Partial<AlertDraft> = {}): AlertDraft => ({
  ...newDraft('BINANCE:BTCUSDT', 59_012.34, PRECISION),
  ...over,
});

check('a plain price rule builds', json(built(buildAlert(draft({ level: '59000' }), WINDOWS))) === json(payload({ threshold: 59_000 })), json(built(buildAlert(draft({ level: '59000' }), WINDOWS))));
check('the symbol is sent the way the store keys it', json(built(buildAlert(draft({ instrument: ' binance:ethusdt ' }), WINDOWS))) === json({ ...payload(), instrument: 'BINANCE:ETHUSDT' }), json(built(buildAlert(draft({ instrument: ' binance:ethusdt ' }), WINDOWS))));
check('a blank symbol is refused before it reaches the server', built(buildAlert(draft({ instrument: '   ' }), WINDOWS)) === 'Pick a symbol first.', json(built(buildAlert(draft({ instrument: '   ' }), WINDOWS))));
check('a level that is not a number is refused',
  built(buildAlert(draft({ level: 'about fifty nine' }), WINDOWS)) === 'The level has to be a number.' &&
    built(buildAlert(draft({ level: '' }), WINDOWS)) === 'The level has to be a number.' &&
    built(buildAlert(draft({ level: 'Infinity' }), WINDOWS)) === 'The level has to be a number.',
);
check('a range rule needs an upper bound, and above the lower one',
  built(buildAlert(draft({ kind: 'price-in-range', upper: '' }), WINDOWS)) === 'A range rule needs an upper bound.' &&
    built(buildAlert(draft({ kind: 'price-in-range', upper: '59000' }), WINDOWS)) === 'The upper bound has to sit above the lower one.' &&
    json(built(buildAlert(draft({ kind: 'price-in-range', upper: '59500' }), WINDOWS))) === json({ ...payload(), kind: 'price-in-range', thresholdHigh: 59_500 }),
);
check('a volume rule carries the bar it sums', json(built(buildAlert(draft({ kind: 'volume-above', level: '1250', window: '5m' }), WINDOWS))) === json({ ...payload(), kind: 'volume-above', threshold: 1_250, timeframe: '5m' }), json(built(buildAlert(draft({ kind: 'volume-above', level: '1250', window: '5m' }), WINDOWS))));
check('a window rule with no bar is refused', built(buildAlert(draft({ kind: 'volume-above', window: '' }), WINDOWS)) === 'Pick the bar this rule sums over.');
check('a bar with no fixed span cannot be summed',
  /no fixed span/.test(String(built(buildAlert(draft({ kind: 'delta-above', window: '1mo' }), WINDOWS)))) &&
    /no fixed span/.test(String(built(buildAlert(draft({ kind: 'delta-above', window: 'session' }), WINDOWS)))),
);
check('a bar the server does not hold is refused', /not one of the stored intervals/.test(String(built(buildAlert(draft({ kind: 'volume-above', window: '7m' }), WINDOWS)))));
check('a bar outside the offered list passes when no list is offered', buildAlert(draft({ kind: 'volume-above', window: '15m' }), []).ok === true);
check('a bar with no known span cannot be summed even with no list', /no fixed span/.test(String(built(buildAlert(draft({ kind: 'volume-above', window: '7m' }), [])))));
check('a negative re-arm gap is refused and a blank one is none',
  built(buildAlert(draft({ gap: '-3' }), WINDOWS)) === 'The re-arm gap has to be zero or more.' &&
    json(built(buildAlert(draft({ gap: '' }), WINDOWS))) === json(payload({ threshold: 59_012.34 })),
);
const labelled = buildAlert(draft({ label: `  ${'x'.repeat(140)}  ` }), WINDOWS);
check('the note is trimmed and bounded', labelled.ok && labelled.payload.label.length === 120 && !labelled.payload.label.startsWith(' '), labelled.ok ? String(labelled.payload.label.length) : labelled.error);
check('switched off and muted survive the form',
  json(built(buildAlert({ ...draft({ level: '1' }), enabled: false, muted: true }, WINDOWS))) === json(payload({ threshold: 1, enabled: false, muted: true })),
  json(built(buildAlert({ ...draft({ level: '1' }), enabled: false, muted: true }, WINDOWS))),
);

const edited = draftFrom(record({ kind: 'price-in-range', threshold: 59_000, thresholdHigh: 59_500, rearmGap: 0.25, timeframe: '5m', label: 'both edges' }));
check('editing a rule starts from what it holds', json(edited) === json({ id: 'al0000000000000001', instrument: 'BINANCE:BTCUSDT', kind: 'price-in-range', level: '59000', upper: '59500', window: '5m', gap: '0.25', label: 'both edges', enabled: true, muted: false }), json(edited));
check('a re-edited rule builds the request it came from',
  json(built(buildAlert(edited, WINDOWS))) ===
    json(payload({ kind: 'price-in-range', threshold: 59_000, thresholdHigh: 59_500, rearmGap: 0.25, label: 'both edges' })),
  json(built(buildAlert(edited, WINDOWS))),
);
check('a price rule sends no bar, because no bar decides it', !('timeframe' in (built(buildAlert(edited, WINDOWS)) as AlertPayload)));
check('a window rule keeps its bar through an edit',
  json(built(buildAlert(draftFrom(record({ kind: 'volume-above', threshold: 1_250, timeframe: '1h' })), WINDOWS))) ===
    json(payload({ kind: 'volume-above', threshold: 1_250, timeframe: '1h', rearmGap: 25, label: 'reclaims the level' })),
  json(built(buildAlert(draftFrom(record({ kind: 'volume-above', threshold: 1_250, timeframe: '1h' })), WINDOWS))),
);
check('a fresh form starts on the chart in view with the level typed',
  json(newDraft('BINANCE:ETHUSDT', 3_012.5, 1)) ===
    json({ id: '', instrument: 'BINANCE:ETHUSDT', kind: 'price-above', level: '3012.5', upper: '', window: '1m', gap: '0', label: '', enabled: true, muted: false }),
  json(newDraft('BINANCE:ETHUSDT', 3_012.5, 1)),
);
check('a fresh form with no price leaves the level blank', newDraft('BINANCE:ETHUSDT', null, 2).level === '');
check('a stored number is shown without trailing zeros', trimNumber(0.1) === '0.1' && trimNumber(59_000) === '59000' && trimNumber(Number.NaN) === '');

// ------------------------------------------------------------------ 6. what the browser will allow

check('no Notification API reads as unsupported', notificationGrant({ supported: false, permission: 'granted' }) === 'unsupported');
check('granted reads as on', notificationGrant({ supported: true, permission: 'granted' }) === 'on');
check('denied reads as blocked', notificationGrant({ supported: true, permission: 'denied' }) === 'blocked');
for (const permission of ['default', null, '', 'unknown']) {
  check(`${json(permission)} permission reads as still asking`, notificationGrant({ supported: true, permission }) === 'asking', notificationGrant({ supported: true, permission }));
}
for (const grant of Object.keys(GRANT_TEXTS) as NotificationGrant[]) {
  check(`the ${grant} popup line still promises the list`, GRANT_TEXTS[grant].includes('listed'), GRANT_TEXTS[grant]);
}
check('no popup line or condition label mentions a plan or a ceiling',
  !/plan|quota|subscription|upgrade|per day|per month/i.test(
    [...Object.values(GRANT_TEXTS), ...ALERT_KINDS.map((meta) => `${meta.label} ${meta.evaluation} ${meta.levelLabel}`)].join(' '),
  ),
);

check('a fresh fire with permission pops', shouldNotify({ muted: false, missed: false, ts: NOW - 1_000 }, 'on', NOW));
check('a muted rule is listed but stays quiet', !shouldNotify({ muted: true, missed: false, ts: NOW }, 'on', NOW));
check('a fire from the downtime gap is listed but stays quiet', !shouldNotify({ muted: false, missed: true, ts: NOW }, 'on', NOW));
check('a fire older than the freshness window does not wake an open page', !shouldNotify({ muted: false, missed: false, ts: NOW - FRESH_FIRE_MS - 1 }, 'on', NOW));
check('a server clock a little ahead is still a fresh fire', shouldNotify({ muted: false, missed: false, ts: NOW + 1_000 }, 'on', NOW));
for (const grant of ['asking', 'blocked', 'unsupported'] as NotificationGrant[]) {
  check(`a ${grant} permission never reaches the popup`, !shouldNotify({ muted: false, missed: false, ts: NOW }, grant, NOW));
}

// ------------------------------------------------------------------ 7. the popup path cannot break the page

/** A browser, real enough to prove the guard: records what was constructed. */
function fakeDesktop(permission: string | null, throws = false): { desktop: Desktop; built: () => unknown[] } {
  const made: unknown[] = [];
  if (permission === null) return { desktop: { ctor: null }, built: () => made };
  function FakeNotification(this: unknown, title: string, options?: NotificationOptions): unknown {
    if (throws) throw new Error('this browser will not construct a notification');
    made.push({ title, options });
    return { title };
  }
  const ctor = Object.assign(FakeNotification as unknown as NotificationLike, { permission });
  return { desktop: { ctor }, built: () => made };
}

const noApi = fakeDesktop(null);
check('a platform with no Notification reports unsupported and builds nothing',
  json(deliver(noApi.desktop, 't', 'b')) === json({ shown: false, reason: 'unsupported' }) && noApi.built().length === 0,
  json([deliver(noApi.desktop, 't', 'b'), noApi.built().length]),
);
const denied = fakeDesktop('denied');
check('a denied permission never constructs a notification',
  json(deliver(denied.desktop, 't', 'b')) === json({ shown: false, reason: 'blocked' }) && denied.built().length === 0,
  json([deliver(denied.desktop, 't', 'b'), denied.built().length]),
);
const notYet = fakeDesktop('default');
check('an unanswered permission never constructs a notification either',
  json(deliver(notYet.desktop, 't', 'b')) === json({ shown: false, reason: 'asking' }) && notYet.built().length === 0,
);
const granted = fakeDesktop('granted');
check('a granted permission builds one notification',
  deliver(granted.desktop, 'BTCUSDT · last price above 59,000.00', 'at 59,012.50').shown === true && granted.built().length === 1,
  json(granted.built()),
);
const builtNotification = granted.built()[0] as { title: string; options: NotificationOptions } | undefined;
check('the notification carries the alert, not a generic line',
  builtNotification?.title.includes('59,000.00') === true && builtNotification.options.body === 'at 59,012.50',
  json(builtNotification),
);
check('the notification is silent and tagged, so a burst does not stack sound',
  builtNotification?.options.silent === true && typeof builtNotification.options.tag === 'string',
  json(builtNotification),
);
const throwing = fakeDesktop('granted', true);
check('a browser that throws on construction loses only the popup', json(deliver(throwing.desktop, 't', 'b')) === json({ shown: false, reason: 'refused' }), json(deliver(throwing.desktop, 't', 'b')));
check('the permission is read without assuming the API exists',
  json(probe({ ctor: null })) === json({ supported: false, permission: null }) &&
    json(probe({ ctor: Object.assign(function empty(): void {}, { permission: 'granted' }) as unknown as NotificationLike })) === json({ supported: true, permission: 'granted' }),
);

const quiet = new DesktopNotifier(fakeDesktop('denied').desktop);
check('with permission denied the notifier stays quiet and the caller still lists the alert',
  quiet.grant === 'blocked' && quiet.notify({ muted: false, missed: false, ts: NOW }, 't', 'b', NOW) === false,
);
const loud = new DesktopNotifier(fakeDesktop('granted').desktop);
check('with permission granted the same call pops', loud.notify({ muted: false, missed: false, ts: NOW }, 't', 'b', NOW) === true);
check('a muted rule pops nothing even with permission', loud.notify({ muted: true, missed: false, ts: NOW }, 't', 'b', NOW) === false);
const offline = new DesktopNotifier({ ctor: null });
check('a platform with no popups reports its state and neither call throws',
  offline.grant === 'unsupported' && offline.notify({ muted: false, missed: false, ts: NOW }, 't', 'b', NOW) === false && offline.ask() === undefined,
);

// ------------------------------------------------------------------ 8. the panel promises no ceiling

for (const path of ['src/alertsModel.ts', 'src/notify.ts', 'src/alertsDialog.ts', 'src/api.ts']) {
  const source = readFileSync(path, 'utf8');
  const offenders = new Set((source.match(/plan\b|quota|subscription|upgrade|tier\b|unlimited|per account/gi) ?? []).map((word) => word.toLowerCase()));
  check(`${path} carries no account, plan or quota wording`, offenders.size === 0, json([...offenders]));
  check(`${path} sets no ceiling on the rules kept`, !/alert (count|limit)|limit of \d+ alerts|\d+ alerts? per/i.test(source));
}
check('the panel says where rules are judged', readFileSync('src/alertsDialog.ts', 'utf8').includes('judged by the local server'));
check('the panel says the history outlives the page', readFileSync('src/alertsDialog.ts', 'utf8').includes('survive a restart'));

// ------------------------------------------------------------------ report

console.log(`alerts: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
if (failures.length > 0) process.exitCode = 1;
