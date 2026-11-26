import type {
  AlertFire,
  AlertRecord,
  Bar,
  Coverage,
  FootprintSeries,
  Instrument,
  InstrumentSummary,
  Trade,
  VolumeProfile,
} from './types';
import type { AlertPayload } from './alertsModel';

/** Every REST failure the server answers with a plain-text reason, so surface that text. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * A panes' refetch is gated on one request being in flight, so a stalled fetch has to
 * end on its own. The server waits at most 8s for a window to fill, so this only fires
 * on a genuinely dead connection.
 */
const REQUEST_TIMEOUT_MS = 30_000;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (cause) {
    if (cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')) {
      throw new ApiError(0, `no answer after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw new ApiError(0, `network unreachable: ${String(cause)}`);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).trim();
    throw new ApiError(response.status, detail || `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export interface BarWindow {
  from?: number;
  to?: number;
  limit?: number;
}

export const api = {
  coverage: () => request<Coverage>('/api/coverage'),

  instruments: (q: string, assetClass: string): Promise<InstrumentSummary> =>
    request<InstrumentSummary>(`/api/instruments${query({ q, class: assetClass })}`),

  /**
   * Catalogue lookup by `VENUE:SYMBOL` id. The server matches its own text search
   * against symbols and names, not ids, so the symbol part is searched and the id
   * is reconciled client-side.
   */
  instrument: async (id: string): Promise<Instrument | null> => {
    const colon = id.indexOf(':');
    const symbol = colon >= 0 ? id.slice(colon + 1) : id;
    for (const term of [id, symbol]) {
      if (!term) continue;
      const list = await api.instruments(term, '');
      const found =
        list.items.find((item) => item.id === id) ??
        list.items.find((item) => item.display === symbol || item.symbol === symbol);
      if (found) return found;
    }
    return null;
  },

  bars: (instrument: string, timeframe: string, window: BarWindow): Promise<{ bars: Bar[] }> =>
    request(`/api/bars${query({ instrument, timeframe, ...window })}`),

  footprint: (
    instrument: string,
    timeframe: string,
    window: BarWindow,
  ): Promise<FootprintSeries> => request(`/api/footprint${query({ instrument, timeframe, ...window })}`),

  /**
   * Raw prints, newest first, `to` exclusive. The server clamps `limit` at 200 000, so a
   * request that answers with exactly that many rows says nothing about what the rest of
   * the range held.
   */
  trades: (instrument: string, window: BarWindow): Promise<{ instrument: string; trades: Trade[] }> =>
    request(`/api/trades${query({ instrument, ...window })}`),


  /**
   * Volume-by-price over `window`. `to` is exclusive, matching `/api/trades`. The
   * endpoint has no price-step parameter, so the caller folds the venue-tick buckets
   * into display rows.
   */
  profile: (instrument: string, window: BarWindow, valueArea: number): Promise<VolumeProfile> =>
    request(`/api/profile${query({ instrument, ...window, valueArea })}`),

  workspaces: () => request<{ items: { name: string; data: unknown; updatedAt: number }[] }>('/api/workspaces'),

  saveWorkspace: (name: string, data: unknown): Promise<{ name: string; saved: boolean }> =>
    request(`/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, data }),
    }),

  /** Alerts are judged by the server, so the page only reads and edits them. Nothing here
   * counts them: a trader keeps as many rules as they want. */
  alerts: (): Promise<{ items: AlertRecord[] }> => request('/api/alerts'),

  alertHistory: (instrument?: string, limit?: number): Promise<{ items: AlertFire[] }> =>
    request(`/api/alerts/history${query({ instrument, limit })}`),

  createAlert: (payload: AlertPayload): Promise<AlertRecord> =>
    request(`/api/alerts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),

  updateAlert: (id: string, payload: AlertPayload): Promise<AlertRecord> =>
    request(`/api/alerts/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  deleteAlert: (id: string): Promise<{ id: string; deleted: boolean }> =>
    request(`/api/alerts/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  clearAlertHistory: (): Promise<{ cleared: number }> => request(`/api/alerts`, { method: 'DELETE' }),

  /** Every venue the server can route to, with its credential state. */
  feeds: (): Promise<FeedReport> => request<FeedReport>('/api/feeds'),

  /** Save the fields the trader typed. A key sent empty clears that field. */
  saveFeeds: (venue: string, values: Record<string, string>): Promise<{ venues: FeedVenue[] }> =>
    request('/api/feeds', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ venue, values }),
    }),
};

/** One credential field a venue needs, as the server describes it. */
export interface FeedField {
  key: string;
  /** Environment variable that overrides the stored value for this field. */
  env: string;
  label: string;
  required: boolean;
  /** Password box; the server never sends the value back. */
  secret: boolean;
  placeholder: string;
}

/** One venue in the feeds panel: whether it has credentials and what it is still waiting for. */
export interface FeedVenue {
  venue: string;
  tag: string;
  /** Name `chartkit --check-feed <slug>` takes. */
  slug: string;
  configured: boolean;
  /** Labels of the required fields still missing. */
  missing: string[];
  /** Where the values that are set came from. */
  source: 'environment' | 'file' | 'none';
  fields: FeedField[];
  /** Set values the server may show. Secrets never appear here. */
  values: Record<string, string>;
  note: string;
}

export interface FeedReport {
  venues: FeedVenue[];
  credentialFile: string;
}
