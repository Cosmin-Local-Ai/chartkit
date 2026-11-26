import { api } from './api';
import { DEFAULT_FOOTPRINT_SETTINGS, normaliseFootprintSettings, type FootprintSettings } from './footprintSettings';
import { normaliseInstances, type IndicatorInstance } from './indicators/engine';
import { normaliseDrawings, type DrawingInstance } from './drawings/engine';
import { SERIES_STYLES, type SeriesStyle } from './panes/pricePane';
import { DEFAULT_SETTINGS, normaliseSettings, type ChartSettings } from './settings';
import type { PriceScaleMode } from './scale';

export interface ViewStateSnapshot {
  barStep?: number;
  offsetFromEnd?: number;
  priceMode?: PriceScaleMode;
  autoFit?: boolean;
  /** Price range the user framed by hand; only read back while autoFit is off. */
  manualMin?: number;
  manualMax?: number;
}

export interface WorkspaceState {
  instrument: string | null;
  timeframe: string;
  seriesStyle: SeriesStyle;
  watchlist: string[];
  panes: Record<string, boolean>;
  weights: Record<string, number>;
  /** True once the user has dragged a pane splitter, so their weights rule without a floor. */
  weightsCustomized: boolean;
  view: ViewStateSnapshot;
  /** Added indicators, in the order their panes stack. No count limit applies. */
  indicators: IndicatorInstance[];
  /** Placed drawings, in placement order. No count limit applies. */
  drawings: DrawingInstance[];
  /** Tools armed most recently, newest first; the right-click menu offers these first. */
  recentTools: string[];
  /** Footprint pane settings; field names follow the shipped product's own. */
  footprint: FootprintSettings;
  /** Appearance, chart data, timezone and latency settings from the settings dialog. */
  settings: ChartSettings;
  /** Named view presets the settings dialog saves and applies. */
  templates: ChartTemplate[];
}

/**
 * A named chart template: how the chart looks and what it plots, including the indicators
 * and any price range framed by hand. It carries no drawings, no symbol and no interval, so
 * one template applies to whatever chart it is opened on.
 */
export interface ChartTemplate {
  name: string;
  settings: ChartSettings;
  seriesStyle: SeriesStyle;
  view: ViewStateSnapshot;
  panes: Record<string, boolean>;
  weights: Record<string, number>;
  weightsCustomized: boolean;
  indicators: IndicatorInstance[];
}

/** Templates a document can hold before the oldest start going missing. */
export const MAX_TEMPLATES = 24;

export const WORKSPACE_NAME = 'main';
export const DEFAULT_STATE: WorkspaceState = {
  instrument: null,
  timeframe: '1m',
  seriesStyle: 'candles',
  watchlist: [],
  // The size-band grid starts switched off: it is an extra way to read the same prints, and
  // a workspace that has never asked for it should not pay a window scan for it.
  panes: { volume: true, footprint: true, profile: true, sizeBands: false, ladder: true, sidebar: true },
  weights: { price: 3.2, volume: 1, footprint: 1.6, profile: 1.2, sizeBands: 1.1 },
  weightsCustomized: false,
  // No barStep: a workspace that has never saved a zoom gets one from the view's density
  // target, which needs the plot width and so can only be worked out on the first frame.
  view: { offsetFromEnd: 6, priceMode: 'linear', autoFit: true },
  indicators: [],
  drawings: [],
  recentTools: [],
  footprint: structuredClone(DEFAULT_FOOTPRINT_SETTINGS),
  settings: { ...DEFAULT_SETTINGS },
  templates: [],
};

/**
 * Workspace persistence: one stored document under the name `main`, loaded on start
 * and written back on a debounce so slider and pan changes do not hammer the server.
 */
export class WorkspaceStore {
  private timer: number | null = null;
  private pending: WorkspaceState | null = null;

  async load(): Promise<WorkspaceState | null> {
    const response = await api.workspaces();
    const found = response.items.find((item) => item.name === WORKSPACE_NAME);
    if (!found) return null;
    return normaliseState(found.data);
  }

  save(state: WorkspaceState): void {
    this.pending = state;
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 700);
  }

  async flush(): Promise<void> {
    const state = this.pending;
    if (!state) return;
    this.pending = null;
    try {
      await api.saveWorkspace(WORKSPACE_NAME, state);
    } catch {
      this.pending = state;
    }
  }
}

/** A stored style counts only while the price pane can still draw it. */
function isSeriesStyle(value: unknown): value is SeriesStyle {
  return typeof value === 'string' && SERIES_STYLES.some((entry) => entry.value === value);
}

/**
 * Validates a stored document. Every field is checked rather than trusted, so a foreign or
 * half-written document restores a working chart instead of poisoning one.
 */
export function normaliseState(raw: unknown): WorkspaceState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Partial<WorkspaceState>;
  const state: WorkspaceState = {
    instrument: typeof value.instrument === 'string' ? value.instrument : null,
    timeframe: typeof value.timeframe === 'string' && value.timeframe ? value.timeframe : DEFAULT_STATE.timeframe,
    seriesStyle: isSeriesStyle(value.seriesStyle) ? value.seriesStyle : DEFAULT_STATE.seriesStyle,
    watchlist: Array.isArray(value.watchlist) ? value.watchlist.filter((id) => typeof id === 'string') : [],
    panes: { ...DEFAULT_STATE.panes, ...(typeof value.panes === 'object' && value.panes ? value.panes : {}) },
    weights: { ...DEFAULT_STATE.weights, ...(typeof value.weights === 'object' && value.weights ? value.weights : {}) },
    weightsCustomized: value.weightsCustomized === true,
    view: { ...DEFAULT_STATE.view, ...(typeof value.view === 'object' && value.view ? value.view : {}) },
    indicators: normaliseInstances(value.indicators),
    drawings: normaliseDrawings(value.drawings),
    recentTools: Array.isArray(value.recentTools) ? value.recentTools.filter((id) => typeof id === 'string') : [],
    footprint: normaliseFootprintSettings(value.footprint),
    settings: normaliseSettings(value.settings),
    templates: normaliseTemplates(value.templates),
  };
  return state;
}

/**
 * Templates are kept only while they are whole: a row with no name, or one whose every
 * field is junk, is dropped rather than half-trusted, because applying a broken template
 * quietly resets the chart.
 */
function normaliseTemplates(raw: unknown): ChartTemplate[] {
  if (!Array.isArray(raw)) return [];
  const out: ChartTemplate[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const value = entry as Partial<ChartTemplate>;
    const name = typeof value.name === 'string' ? value.name.trim().slice(0, 48) : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      settings: normaliseSettings(value.settings),
      seriesStyle: isSeriesStyle(value.seriesStyle) ? value.seriesStyle : DEFAULT_STATE.seriesStyle,
      view: normaliseViewSnapshot(value.view),
      panes: flagMap(value.panes),
      weights: numberMap(value.weights),
      weightsCustomized: value.weightsCustomized === true,
      indicators: normaliseInstances(value.indicators),
    });
    if (out.length >= MAX_TEMPLATES) break;
  }
  return out;
}

/** A stored view keeps only the numbers and flags that mean something. */
function normaliseViewSnapshot(raw: unknown): ViewStateSnapshot {
  if (typeof raw !== 'object' || raw === null) return {};
  const value = raw as Record<string, unknown>;
  const snapshot: ViewStateSnapshot = {};
  const pick = (key: 'barStep' | 'offsetFromEnd' | 'manualMin' | 'manualMax'): void => {
    const field = value[key];
    if (typeof field === 'number' && Number.isFinite(field)) snapshot[key] = field;
  };
  pick('barStep');
  pick('offsetFromEnd');
  pick('manualMin');
  pick('manualMax');
  if (value['priceMode'] === 'linear' || value['priceMode'] === 'log') snapshot.priceMode = value['priceMode'] as PriceScaleMode;
  if (typeof value['autoFit'] === 'boolean') snapshot.autoFit = value['autoFit'];
  return snapshot;
}

function flagMap(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

function numberMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[key] = value;
  }
  return out;
}
