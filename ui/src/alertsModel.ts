/**
 * The rules behind the Alerts panel: what each condition means, how it reads in words, how
 * a server payload is checked before the panel trusts it, and when a fire earns a desktop
 * popup. Nothing here touches the DOM, so the Node suite drives it directly.
 *
 * This is our own contract: the shipped product's alert payload was never inspected, so the
 * field names mirror this server, not a third party's wire format.
 */

import { fmtPrice } from './format';
import { timeframeDef } from './timeframes';
import type { AlertFire, AlertKind, AlertRecord } from './types';

/** How one condition reads, and what the form has to ask for. */
export interface AlertKindMeta {
  id: AlertKind;
  /** The picker label. */
  label: string;
  /** What the level field means for this kind. */
  levelLabel: string;
  /** Whether the level is a price or a quantity, which decides how it is printed. */
  unit: 'price' | 'quantity';
  /** The point in the stream that settles the rule, shown on every row. */
  evaluation: string;
  /** Window rules sum a bar, so the bar has to be named. */
  needsWindow: boolean;
  /** The range rule reads a second edge. */
  needsUpperLevel: boolean;
}

export const ALERT_KINDS: readonly AlertKindMeta[] = [
  {
    id: 'price-above',
    label: 'Price crosses above',
    levelLabel: 'Level',
    unit: 'price',
    evaluation: 'every live print',
    needsWindow: false,
    needsUpperLevel: false,
  },
  {
    id: 'price-below',
    label: 'Price crosses below',
    levelLabel: 'Level',
    unit: 'price',
    evaluation: 'every live print',
    needsWindow: false,
    needsUpperLevel: false,
  },
  {
    id: 'price-in-range',
    label: 'Price inside a range',
    levelLabel: 'Lower bound',
    unit: 'price',
    evaluation: 'every live print',
    needsWindow: false,
    needsUpperLevel: true,
  },
  {
    id: 'volume-above',
    label: 'Bar volume above',
    levelLabel: 'Volume',
    unit: 'quantity',
    evaluation: 'each closed bar',
    needsWindow: true,
    needsUpperLevel: false,
  },
  {
    id: 'delta-above',
    label: 'Bar delta above',
    levelLabel: 'Delta',
    unit: 'quantity',
    evaluation: 'each closed bar',
    needsWindow: true,
    needsUpperLevel: false,
  },
];

export const DEFAULT_ALERT_KIND: AlertKind = 'price-above';
/** The window a window rule defaults to; the server needs one for volume and delta rules. */
export const DEFAULT_ALERT_WINDOW = '1m';
/** How many fires the panel keeps in memory. History on the server is never trimmed. */
export const FIRE_MEMORY = 500;
/** A fire older than this is listed but stays quiet: it is news from before the page opened. */
export const FRESH_FIRE_MS = 2 * 60_000;

const KIND_BY_ID = new Map(ALERT_KINDS.map((meta) => [meta.id, meta]));

export function isAlertKind(value: unknown): value is AlertKind {
  return typeof value === 'string' && KIND_BY_ID.has(value as AlertKind);
}

/** Metadata for a kind, falling back to the default rather than failing the whole row. */
export function kindMeta(kind: AlertKind | unknown): AlertKindMeta {
  return KIND_BY_ID.get(kind as AlertKind) ?? KIND_BY_ID.get(DEFAULT_ALERT_KIND)!;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function level(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function itemsOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const items = (payload as { items?: unknown }).items;
    if (Array.isArray(items)) return items;
  }
  return [];
}

/**
 * Rules as the server sent them. A row missing anything the evaluator needs is dropped:
 * one bad row must not take the whole panel down.
 */
export function parseAlerts(payload: unknown): AlertRecord[] {
  const out: AlertRecord[] = [];
  for (const raw of itemsOf(payload)) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const id = text(row.id);
    const instrument = text(row.instrument);
    const threshold = level(row.threshold);
    if (!id || !instrument || threshold === null || !isAlertKind(row.kind)) continue;
    const gap = level(row.rearmGap);
    const created = stamp(row.createdAt);
    const updated = stamp(row.updatedAt);
    if (created === null || updated === null) continue;
    const high = level(row.thresholdHigh);
    const window = text(row.timeframe);
    const fired = stamp(row.lastFiredAt);
    out.push({
      id,
      instrument,
      kind: row.kind,
      threshold,
      ...(high !== null ? { thresholdHigh: high } : {}),
      ...(window ? { timeframe: window } : {}),
      rearmGap: gap === null || gap < 0 ? 0 : gap,
      label: text(row.label),
      enabled: row.enabled === true,
      muted: row.muted === true,
      createdAt: created,
      updatedAt: updated,
      armed: row.armed === true,
      ...(fired !== null ? { lastFiredAt: fired } : {}),
    });
  }
  return out;
}

/** Fires, newest first, as the server sent them. */
export function parseFires(payload: unknown): AlertFire[] {
  const out: AlertFire[] = [];
  for (const raw of itemsOf(payload)) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const id = text(row.id);
    const value = level(row.value);
    const threshold = level(row.threshold);
    const ts = stamp(row.ts);
    if (!id || value === null || threshold === null || ts === null || !isAlertKind(row.kind)) continue;
    const high = level(row.thresholdHigh);
    const window = text(row.timeframe);
    const barStart = stamp(row.barStart);
    out.push({
      id,
      alertId: text(row.alertId),
      instrument: text(row.instrument),
      kind: row.kind,
      threshold,
      ...(high !== null ? { thresholdHigh: high } : {}),
      ...(window ? { timeframe: window } : {}),
      value,
      ...(barStart !== null ? { barStart } : {}),
      ts,
      label: text(row.label),
      muted: row.muted === true,
      missed: row.missed === true,
    });
  }
  return mergeFires(out, []);
}

/**
 * Puts fires together without listing one twice: the panel reads history over REST and the
 * same fires arrive again on a socket that reconnects. Newest first.
 */
export function mergeFires(known: readonly AlertFire[], incoming: Iterable<AlertFire>, cap = FIRE_MEMORY): AlertFire[] {
  const byId = new Map<string, AlertFire>();
  for (const fire of known) byId.set(fire.id, fire);
  for (const fire of incoming) byId.set(fire.id, fire);
  const all = [...byId.values()].sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : 1));
  return cap > 0 ? all.slice(0, cap) : all;
}

/** A level printed in the unit the kind uses. */
export function formatLevel(value: number, kind: AlertKind | unknown, precision: number): string {
  if (kindMeta(kind).unit === 'price') return fmtPrice(value, precision);
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 1 ? 1 : 2;
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** What a rule watches for, in one line the panel can show for a rule or a fire. */
export function conditionText(
  rule: { kind: AlertKind; threshold: number; thresholdHigh?: number; timeframe?: string },
  precision: number,
): string {
  const level = formatLevel(rule.threshold, rule.kind, precision);
  switch (rule.kind) {
    case 'price-above':
      return `last price above ${level}`;
    case 'price-below':
      return `last price below ${level}`;
    case 'price-in-range': {
      const high = rule.thresholdHigh ?? rule.threshold;
      return `last price between ${level} and ${formatLevel(high, rule.kind, precision)}`;
    }
    case 'volume-above':
      return `${windowLabel(rule.timeframe)} volume above ${level}`;
    case 'delta-above':
      return `${windowLabel(rule.timeframe)} delta above ${level}`;
  }
}

/** The window a rule sums over, named the way the interval picker names it. */
export function windowLabel(key: string | undefined): string {
  return key ? timeframeDef(key).label : '—';
}

/** The value that satisfied a rule, printed the way the rule reads it. */
export function fireValueText(fire: AlertFire, precision: number): string {
  const shown = formatLevel(fire.value, fire.kind, precision);
  if (fire.kind === 'delta-above') return `delta ${fire.value >= 0 ? '+' : ''}${shown}`;
  if (fire.kind === 'volume-above') return `volume ${shown}`;
  return `at ${shown}`;
}

/**
 * How a rule's crossing state reads in the list. A row is narrow, so this is deliberately a
 * few words; `crossingExplanation` carries the same state in full for the tooltip.
 */
export function crossingText(rule: Pick<AlertRecord, 'kind' | 'enabled' | 'armed'>): string {
  if (!rule.enabled) return 'switched off';
  if (kindMeta(rule.kind).needsWindow) return rule.armed ? 'waiting for its bar' : 'level held';
  return rule.armed ? 'waiting to cross' : 'level held';
}

/** The crossing state in words, for the tooltip and for anyone wondering why a rule is quiet. */
export function crossingExplanation(rule: Pick<AlertRecord, 'kind' | 'enabled' | 'armed'>): string {
  if (!rule.enabled) return 'Switched off; nothing is judged.';
  if (!rule.armed) return 'The level is held. It stays quiet until the level is given back.';
  return kindMeta(rule.kind).needsWindow
    ? 'Waiting for a closed bar that reaches the level.'
    : 'Waiting for the level to be crossed before it fires again.';
}

/** How far back the level has to be given up before the rule can fire again. */
export function rearmText(alert: AlertRecord, precision: number): string {
  if (alert.rearmGap <= 0) return '';
  return `re-arms ${formatLevel(alert.rearmGap, alert.kind, precision)} back`;
}

/** The form's own state: text as typed, not numbers the trader has not finished typing. */
export interface AlertDraft {
  /** Set while editing an existing rule; empty for a new one. */
  id: string;
  instrument: string;
  kind: AlertKind;
  level: string;
  upper: string;
  window: string;
  gap: string;
  label: string;
  enabled: boolean;
  muted: boolean;
}

/** The body the server takes. Field names are the ones `Alert` is stored under. */
export interface AlertPayload {
  instrument: string;
  kind: AlertKind;
  threshold: number;
  thresholdHigh?: number;
  timeframe?: string;
  rearmGap: number;
  label: string;
  enabled: boolean;
  muted: boolean;
}

/** A rule's own settings, so editing the level keeps everything else. */
export function draftFrom(alert: AlertRecord): AlertDraft {
  return {
    id: alert.id,
    instrument: alert.instrument,
    kind: alert.kind,
    level: trimNumber(alert.threshold),
    upper: alert.thresholdHigh === undefined ? '' : trimNumber(alert.thresholdHigh),
    window: alert.timeframe ?? DEFAULT_ALERT_WINDOW,
    gap: trimNumber(alert.rearmGap),
    label: alert.label,
    enabled: alert.enabled,
    muted: alert.muted,
  };
}

/** A number with no trailing zeros, so a stored 0.1 does not appear as 0.10000. */
export function trimNumber(value: number): string {
  if (!Number.isFinite(value)) return '';
  return String(Math.round(value * 1e8) / 1e8);
}

/** A blank form for a new rule, prefilled with the price on screen. */
export function newDraft(instrument: string, price: number | null, precision: number): AlertDraft {
  return {
    id: '',
    instrument,
    kind: DEFAULT_ALERT_KIND,
    level: price === null ? '' : fmtPrice(price, precision).replace(/,/g, ''),
    upper: '',
    window: DEFAULT_ALERT_WINDOW,
    gap: '0',
    label: '',
    enabled: true,
    muted: false,
  };
}

export type DraftBuild = { ok: true; payload: AlertPayload } | { ok: false; error: string };

/**
 * Turns the typed form into a request, or says what is missing. The server checks the same
 * things again, so a client cannot smuggle in a rule the evaluator could not judge.
 */
export function buildAlert(draft: AlertDraft, windows: readonly string[]): DraftBuild {
  const meta = kindMeta(draft.kind);
  const instrument = draft.instrument.trim().toUpperCase();
  if (!instrument) return { ok: false, error: 'Pick a symbol first.' };
  const threshold = Number(draft.level.trim());
  if (!draft.level.trim() || !Number.isFinite(threshold)) return { ok: false, error: 'The level has to be a number.' };
  const payload: AlertPayload = {
    instrument,
    kind: draft.kind,
    threshold,
    rearmGap: 0,
    label: draft.label.trim().slice(0, 120),
    enabled: draft.enabled,
    muted: draft.muted,
  };
  if (meta.needsUpperLevel) {
    const upper = Number(draft.upper.trim());
    if (!draft.upper.trim() || !Number.isFinite(upper)) return { ok: false, error: 'A range rule needs an upper bound.' };
    if (upper <= threshold) return { ok: false, error: 'The upper bound has to sit above the lower one.' };
    payload.thresholdHigh = upper;
  }
  if (meta.needsWindow) {
    const window = draft.window.trim();
    if (!window) return { ok: false, error: 'Pick the bar this rule sums over.' };
    if (windows.length > 0 && !windows.includes(window)) return { ok: false, error: `${window} is not one of the stored intervals.` };
    if (timeframeDef(window).ms === null) return { ok: false, error: `${windowLabel(window)} bars have no fixed span to sum.` };
    payload.timeframe = window;
  }
  const gap = draft.gap.trim() === '' ? 0 : Number(draft.gap.trim());
  if (!Number.isFinite(gap) || gap < 0) return { ok: false, error: 'The re-arm gap has to be zero or more.' };
  payload.rearmGap = gap;
  return { ok: true, payload };
}

/** What the browser will let the app do about popups. */
export type NotificationGrant = 'on' | 'asking' | 'blocked' | 'unsupported';

/** Everything the guard looks at, so a test can hand it a browser that has none of it. */
export interface DesktopProbe {
  supported: boolean;
  /** The permission string, or null when it cannot be read at all. */
  permission: string | null;
}

export function notificationGrant(probe: DesktopProbe): NotificationGrant {
  if (!probe.supported) return 'unsupported';
  if (probe.permission === 'granted') return 'on';
  if (probe.permission === 'denied') return 'blocked';
  return 'asking';
}

/** The line the panel shows about popups. Every wording says the list works regardless. */
export function grantNotice(grant: NotificationGrant): string {
  switch (grant) {
    case 'on':
      return 'Desktop popups are on. Rules judged while this page is closed are listed here when it opens.';
    case 'asking':
      return 'Popups need permission. Choose Ask below; until then every alert is recorded and listed here.';
    case 'blocked':
      return 'This browser blocks popups for the page. Every alert is still recorded and listed here.';
    case 'unsupported':
      return 'This browser has no desktop popups. Every alert is still recorded and listed here.';
  }
}

/**
 * Whether a fire should try to pop up. A muted rule, a fire that happened while the server
 * was down, and a fire that predates the page are listed but stay quiet, and a denied or
 * missing permission never reaches the popup call at all.
 */
export function shouldNotify(
  fire: Pick<AlertFire, 'muted' | 'missed' | 'ts'>,
  grant: NotificationGrant,
  now: number,
  freshMs = FRESH_FIRE_MS,
): boolean {
  if (grant !== 'on') return false;
  if (fire.muted || fire.missed) return false;
  const age = now - fire.ts;
  // A clock a little ahead of the server's is still a fire that just happened.
  return age <= freshMs && age >= -freshMs;
}
