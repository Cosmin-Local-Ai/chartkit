import type { Instrument } from './types';
import { SERIES_STYLES } from './panes/pricePane';
import type { SeriesStyle } from './panes/pricePane';
import type { PriceScaleMode } from './scale';
import type { ConnectionPhase } from './live';
import type { TimeframeDef } from './timeframes';
import { el } from './canvasKit';

export interface TopbarHandlers {
  onSearch: () => void;
  onTimeframe: (key: string) => void;
  onStyle: (style: SeriesStyle) => void;
  onScaleMode: (mode: PriceScaleMode) => void;
  onToggle: (id: string, on: boolean) => void;
  onFit: () => void;
  onHome: () => void;
  onResetScale: () => void;
  onIndicators: () => void;
  /** The alerts panel: rules the server judges, and what they fired. */
  onAlerts: () => void;
  onFootprintSettings: () => void;
  /** Cluster search: the prints at or above a size, in a window. */
  onClusters: () => void;
  onSettings: () => void;
  /** Opens settings straight on the backup page: the export button a trader reaches for. */
  onBackup: () => void;
  onShortcuts: () => void;
}

interface Segment<T extends string> {
  value: T;
  label: string;
  node: HTMLButtonElement;
}

/** Application header: symbol search, interval, series style, scale, panes, feed state. */
export class Topbar {
  private readonly symbolButton = el('button', 'tb-symbol');
  private readonly meta = el('span', 'tb-meta');
  private readonly interval = el('select', 'tb-select');
  private readonly styleGroup = el('div', 'tb-segment');
  private readonly scaleGroup = el('div', 'tb-segment');
  private readonly paneGroup = el('div', 'tb-segment tb-panes');
  private readonly connection = el('span', 'tb-connection');
  private alertButton!: HTMLButtonElement;
  private readonly styleItems: Segment<SeriesStyle>[] = [];
  private readonly scaleItems: Segment<PriceScaleMode>[] = [];
  private readonly paneToggles = new Map<string, HTMLButtonElement>();

  constructor(
    root: HTMLElement,
    private readonly handlers: TopbarHandlers,
  ) {
    root.classList.add('topbar');
    this.symbolButton.type = 'button';
    this.symbolButton.title = 'Search symbols';
    this.symbolButton.textContent = 'no symbol';
    this.symbolButton.addEventListener('click', () => handlers.onSearch());

    this.interval.setAttribute('aria-label', 'Interval');
    this.interval.addEventListener('change', () => handlers.onTimeframe(this.interval.value));

    for (const entry of SERIES_STYLES) {
      const node = segmentButton(entry.label, () => handlers.onStyle(entry.value));
      this.styleItems.push({ value: entry.value, label: entry.label, node });
      this.styleGroup.append(node);
    }
    for (const entry of [
      { value: 'linear' as const, label: 'Linear' },
      { value: 'log' as const, label: 'Log' },
    ]) {
      const node = segmentButton(entry.label, () => handlers.onScaleMode(entry.value));
      this.scaleItems.push({ value: entry.value, label: entry.label, node });
      this.scaleGroup.append(node);
    }

    const actions = el('div', 'tb-actions');
    // The count of unlooked-at fires is written onto the button itself, so a page left open
    // in the background still says that something happened.
    this.alertButton = actionButton('Alerts', 'Price and volume rules, judged by the local server', () =>
      handlers.onAlerts(),
    );
    actions.append(
      actionButton('Indicators', 'Add or configure indicators', () => handlers.onIndicators()),
      this.alertButton,
      // The Panes group already has a "Footprint" on/off toggle, so the settings entry
      // point spells itself out differently.
      actionButton('Footprint settings', 'Configure the footprint pane', () => handlers.onFootprintSettings()),
      actionButton('Clusters', 'Search the stored prints for the ones at or above a size', () =>
        handlers.onClusters(),
      ),
      actionButton('Settings', 'Appearance, chart data, timezone, latency, templates', () => handlers.onSettings()),
      // Backup is a deliberate, occasional action, so it gets its own button rather than a
      // line inside Settings; it opens the settings page rather than a dialog of its own.
      actionButton('Backup', 'Export or import the workspace file; export bars and prints as CSV', () => handlers.onBackup()),
      actionButton('Shortcuts', 'Keyboard reference', () => handlers.onShortcuts()),
      actionButton('Fit', 'Show all stored bars', () => handlers.onFit()),
      actionButton('Recent', 'Jump to the newest bar', () => handlers.onHome()),
      actionButton('Auto scale', 'Fit the price axis to the view', () => handlers.onResetScale()),
    );

    const group = (label: string, node: HTMLElement): HTMLElement => {
      const wrap = el('div', 'tb-group');
      wrap.append(el('span', 'tb-label', label), node);
      return wrap;
    };

    root.append(
      group('Symbol', wrap2(this.symbolButton, this.meta)),
      group('Interval', this.interval),
      group('Style', this.styleGroup),
      group('Scale', this.scaleGroup),
      group('Panes', this.paneGroup),
      actions,
      this.connection,
    );
  }

  /** Fires the trader has not looked at yet, counted on the Alerts button. */
  setAlertCount(count: number): void {
    this.alertButton.textContent = count > 0 ? `Alerts · ${count}` : 'Alerts';
    this.alertButton.classList.toggle('has-news', count > 0);
    this.alertButton.title =
      count > 0
        ? `Price and volume rules, judged by the local server · ${count} fire${count === 1 ? '' : 's'} not looked at`
        : 'Price and volume rules, judged by the local server';
  }

  addPaneToggles(entries: { id: string; label: string }[]): void {
    for (const entry of entries) {
      const node = segmentButton(entry.label, () => {
        const next = !node.classList.contains('is-on');
        node.classList.toggle('is-on', next);
        this.handlers.onToggle(entry.id, next);
      });
      this.paneToggles.set(entry.id, node);
      this.paneGroup.append(node);
    }
  }

  setIntervals(defs: TimeframeDef[], active: string): void {
    this.interval.replaceChildren();
    for (const def of defs) {
      const node = el('option', undefined, def.label);
      node.value = def.key;
      this.interval.append(node);
    }
    this.interval.value = active;
  }

  setInstrument(instrument: Instrument | null): void {
    this.symbolButton.textContent = instrument
      ? `${instrument.display}`
      : 'no symbol';
    this.meta.textContent = instrument
      ? `${instrument.name} · ${instrument.venue} · ${instrument.assetClass}`
      : 'search a symbol to start';
    this.symbolButton.title = instrument ? `${instrument.id} — search symbols` : 'Search symbols';
  }

  setTimeframe(key: string): void {
    if (this.interval.value !== key) this.interval.value = key;
  }

  setStyle(style: SeriesStyle): void {
    for (const item of this.styleItems) item.node.classList.toggle('is-on', item.value === style);
  }

  setScaleMode(mode: PriceScaleMode): void {
    for (const item of this.scaleItems) item.node.classList.toggle('is-on', item.value === mode);
  }

  setPaneOn(id: string, on: boolean): void {
    this.paneToggles.get(id)?.classList.toggle('is-on', on);
  }

  setConnection(phase: ConnectionPhase, detail: string): void {
    this.connection.dataset.phase = phase;
    const label =
      phase === 'open' ? 'live' : phase === 'connecting' ? 'connecting' : phase === 'error' ? 'error' : phase === 'closed' ? 'retrying' : 'idle';
    this.connection.textContent = label;
    this.connection.title = detail || label;
  }
}

function segmentButton(label: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', 'tb-item', label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function actionButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', 'tb-action', label);
  node.type = 'button';
  node.title = title;
  node.addEventListener('click', onClick);
  return node;
}

function wrap2(a: HTMLElement, b: HTMLElement): HTMLElement {
  const wrap = el('div', 'tb-symbol-wrap');
  wrap.append(a, b);
  return wrap;
}
