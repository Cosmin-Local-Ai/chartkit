/* Wire types. Field names mirror the server exactly: every payload is camelCase. */

export interface Bar {
  start: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number;
  closed: boolean;
}

export interface Trade {
  ts: number;
  seq: number;
  price: number;
  qty: number;
  aggressor: 'buy' | 'sell';
}

export interface DepthLevel {
  price: number;
  qty: number;
}

export interface DepthSnapshot {
  ts: number;
  bids: DepthLevel[];
  asks: DepthLevel[];
}

export interface Instrument {
  id: string;
  venue: string;
  symbol: string;
  display: string;
  name: string;
  assetClass: string;
  priceTick: number;
  qtyStep: number;
  pricePrecision: number;
  qtyPrecision: number;
  quoteCurrency: string;
  session: { timezone: string; windows: [number, string, string][] };
  active: boolean;
}

export interface FootprintCell {
  buyQty: number;
  sellQty: number;
  buyN: number;
  sellN: number;
}

export interface FootprintBar {
  start: number;
  cells: [number, FootprintCell][];
  totalQty: number;
  delta: number;
  trades: number;
  poc: number;
  buyImbalance: number[];
  sellImbalance: number[];
}

export interface FootprintSeries {
  instrument: string;
  timeframe: string;
  priceTick: number;
  bars: FootprintBar[];
  cvd: number[];
}

export interface ProfileBucket {
  price: number;
  buyQty: number;
  sellQty: number;
  totalQty: number;
}

/**
 * Volume-by-price over one time window. The three levels are null when the window holds
 * no prints, and `buckets` are venue-tick wide, so a busy window carries tens of
 * thousands of them.
 */
export interface VolumeProfile {
  instrument: string;
  priceTick: number;
  buckets: ProfileBucket[];
  poc: number | null;
  vah: number | null;
  val: number | null;
  totalQty: number;
  /** Fraction of volume the value area was asked to cover. */
  valueArea: number;
}

/** How a print's size is measured before it is put in a band. */
export type SizeUnit = 'notional' | 'quantity';

/**
 * One size band: prints whose size sits in `[min, max)`. The edges are the server's and so
 * is the label, which is why the chart prints them instead of building its own.
 */
export interface SizeBand {
  min: number | null;
  max: number | null;
  label: string;
}

export interface SizeBandCell {
  buyQty: number;
  sellQty: number;
  buyN: number;
  sellN: number;
}

/** One bar of volume split by size band, plus the running delta per band. */
export interface SizeBandBar {
  start: number;
  /** One entry per band, in `bands` order, with a zero where a band saw nothing. */
  bands: SizeBandCell[];
  cumulative: number[];
  totalQty: number;
  delta: number;
  trades: number;
}

/** One price level of volume split by size band. */
export interface SizeBandLevel {
  price: number;
  bands: SizeBandCell[];
  totalQty: number;
  delta: number;
  trades: number;
}

/**
 * Prints of a window split by order size. A caller asks for `bars`, `levels` or both; the
 * section it did not ask for comes back empty rather than missing.
 */
export interface SizeBandSeries {
  instrument: string;
  timeframe: string;
  from: number | null;
  to: number | null;
  priceTick: number;
  /** Venue ticks folded into one level row; 1 is the venue's own price grid. */
  stepTicks: number;
  sizeUnit: SizeUnit;
  /** How the edges were chosen, in words the UI prints rather than infers. */
  bandRule: string;
  bands: SizeBand[];
  bars: SizeBandBar[];
  levels: SizeBandLevel[];
  /** The window as a whole, one entry per band. */
  totals: SizeBandCell[];
  prints: number;
  totalQty: number;
  delta: number;
}

/**
 * One print at or above the cluster threshold. `notional` is the number the server filtered
 * on, sent rather than rebuilt by the client.
 */
export interface ClusterPrint {
  ts: number;
  /** Venue sequence: the print's other key, so a row can be found again in the store. */
  seq: number;
  price: number;
  qty: number;
  notional: number;
  aggressor: 'buy' | 'sell';
}

/**
 * How many of one bar's prints cleared the threshold. `notional / qty` is the volume-weighted
 * price of exactly those prints, which is where the bar's cluster is marked.
 */
export interface ClusterBar {
  start: number;
  prints: number;
  buyN: number;
  sellN: number;
  qty: number;
  notional: number;
}

/**
 * Prints at or above one size, newest first. The counts describe the whole window; `rows` is
 * the newest `limit` of them, and `truncated` says when those are not the same set. `prints`
 * counts every print the window holds, so 0 means the window holds no prints at all rather
 * than that nothing in it was big enough.
 */
export interface ClusterSearchSeries {
  instrument: string;
  timeframe: string;
  from: number | null;
  to: number | null;
  sizeUnit: SizeUnit;
  /** The threshold and its measure, in words the UI prints rather than infers. */
  sizeRule: string;
  threshold: number;
  prints: number;
  clusters: number;
  returned: number;
  /** The cap the server applied to the list. */
  limit: number;
  truncated: boolean;
  clusterQty: number;
  clusterNotional: number;
  buyN: number;
  sellN: number;
  rows: ClusterPrint[];
  /** Bars holding at least one cluster print, oldest first. */
  bars: ClusterBar[];
}

export interface Coverage {
  bars: number;
  instruments: number;
  trades: number;
  newestBar: number;
}

export interface InstrumentSummary {
  count: number;
  items: Instrument[];
}

export type FeedState =
  | 'connecting'
  | 'backfilling'
  | 'live'
  | 'delayed'
  | 'stalled'
  | 'failed'
  | 'not-configured';

/**
 * What a server-side rule watches. `price-*` rules are settled by each live print,
 * `volume-above` and `delta-above` by a bar once it has closed.
 */
export type AlertKind = 'price-above' | 'price-below' | 'price-in-range' | 'volume-above' | 'delta-above';

/**
 * A rule the server judges, so it holds with the page closed. `armed` is the server's
 * crossing state: false means the rule has answered for this crossing and is waiting for
 * the level to be given back.
 */
export interface AlertRecord {
  id: string;
  instrument: string;
  kind: AlertKind;
  threshold: number;
  thresholdHigh?: number;
  timeframe?: string;
  rearmGap: number;
  label: string;
  enabled: boolean;
  muted: boolean;
  createdAt: number;
  updatedAt: number;
  armed: boolean;
  lastFiredAt?: number;
}

/**
 * One fire. The condition is copied into the row, so the list still reads correctly after
 * the rule that made it has been edited or deleted.
 */
export interface AlertFire {
  id: string;
  alertId: string;
  instrument: string;
  kind: AlertKind;
  timeframe?: string;
  threshold: number;
  thresholdHigh?: number;
  /** The observation that satisfied the rule: a print price, or a closed bar's quantity. */
  value: number;
  barStart?: number;
  ts: number;
  label: string;
  muted: boolean;
  /** Decided at startup from data stored while the server was down. */
  missed: boolean;
}

export type LiveMessage =
  | { type: 'hello'; time: number }
  | { type: 'trades'; instrument: string; trades: Trade[] }
  | { type: 'bar'; instrument: string; timeframe: string; bar: Bar }
  | { type: 'depth'; instrument: string; snapshot: DepthSnapshot }
  | { type: 'status'; instrument: string | null; venue: string; state: FeedState; detail: string }
  | { type: 'instruments'; venue: string; items: Instrument[] }
  // A rule the server judged. Flat, so it reads like every other event on the socket.
  | ({ type: 'alert' } & AlertFire);

export const ASSET_CLASSES: { value: string; label: string }[] = [
  { value: '', label: 'All classes' },
  { value: 'equity', label: 'Equities' },
  { value: 'etf', label: 'ETFs' },
  { value: 'index', label: 'Indices' },
  { value: 'future', label: 'Futures' },
  { value: 'option', label: 'Options' },
  { value: 'crypto-spot', label: 'Crypto spot' },
  { value: 'perpetual', label: 'Perpetuals' },
  { value: 'forex', label: 'Forex' },
  { value: 'prediction', label: 'Predictions' },
  { value: 'treasury', label: 'Treasuries' },
];
