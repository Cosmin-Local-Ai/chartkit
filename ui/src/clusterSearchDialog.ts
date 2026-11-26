/**
 * The cluster search panel: "where did the big prints actually trade in this window".
 *
 * The form states a window, an interval to group by, a threshold and the measure that
 * threshold is in — quote notional or base quantity, the same choice the size-band split
 * makes. The server does the searching: it filters the stored prints in SQL and answers with
 * the rows newest first plus the counts of the window behind them.
 *
 * The panel owns no data. It reads the answer back through `state()` and the app pushes a
 * refresh when it arrives, so the list, the price-pane markers and the status line can only
 * ever describe the same search. Clicking a row hands that print to the app, which centres
 * the chart on it; the panel stays open so the next row can be clicked too.
 */

import { el } from './canvasKit';
import type { ClusterPrint, SizeUnit } from './types';
import {
  clusterSearchNote,
  emptyClusterSearch,
  fmtSizeLabel,
  noRowFilter,
  printKey,
  rowCells,
  selectRows,
  type ClusterRequest,
  type ClusterSearchState,
  type RowFilter,
  type SideFilter,
} from './clusterSearch';

/** Windows the form offers, beside the one the chart is looking at. */
const WINDOWS: { minutes: number | null; label: string }[] = [
  { minutes: null, label: 'chart in view' },
  { minutes: 15, label: 'last 15 min' },
  { minutes: 30, label: 'last 30 min' },
  { minutes: 60, label: 'last hour' },
  { minutes: 120, label: 'last 2 hours' },
  { minutes: 240, label: 'last 4 hours' },
  { minutes: 480, label: 'last 8 hours' },
  { minutes: 1_200, label: 'last 20 hours' },
  { minutes: 2_880, label: 'last day' },
];

const SIDES: { value: SideFilter; label: string }[] = [
  { value: 'all', label: 'both' },
  { value: 'buy', label: 'buy' },
  { value: 'sell', label: 'sell' },
];

const MINUTE_MS = 60_000;

export interface ClusterSearchHandlers {
  /**
   * What the form starts from: the symbol and interval on screen, the window the chart is
   * looking at, and the precisions its numbers are written with.
   */
  prefilled(): { instrument: string; timeframe: string; from: number; to: number; pricePrecision: number; qtyPrecision: number };
  /** Intervals the per-bar counts can be grouped by: the chart's own list. */
  timeframes(): string[];
  /** Starts a search. The answer arrives later through `state()` and `refresh()`. */
  onSearch(request: ClusterRequest): void;
  /** A row was clicked: the app centres the chart on that print. */
  onPick(row: ClusterPrint): void;
  /** Whether the clusters are marked on the price pane. */
  markers(): boolean;
  onMarkers(on: boolean): void;
  /** The search as the app holds it, including the request it belongs to. */
  state(): ClusterSearchState;
  /** A timestamp in the chart's own clock. */
  time(ms: number): string;
}

export class ClusterSearchDialog {
  private readonly backdrop: HTMLElement;
  private readonly panel = el('div', 'dialog dialog-clusters');
  private readonly title = el('span', 'dialog-title', 'Cluster search');
  private readonly form = el('div', 'cs-form');
  private readonly filters = el('div', 'cs-filters');
  private readonly head = el('div', 'cs-head');
  private readonly results = el('div', 'cs-results');
  private readonly note = el('div', 'cs-note');
  private readonly hint = el('div', 'dialog-hint');
  private open = false;
  /** What the trader has typed, kept apart from the answer so a refresh cannot lose it. */
  private instrument = '';
  private timeframe = '';
  private windowMinutes: number | null = null;
  private threshold = '';
  private unit: SizeUnit = 'notional';
  private filter: RowFilter = noRowFilter();
  /** The row the trader last clicked, highlighted in the list. */
  private picked: string | null = null;
  private instrumentInput!: HTMLInputElement;
  private timeframeSelect!: HTMLSelectElement;
  private windowSelect!: HTMLSelectElement;
  private thresholdInput!: HTMLInputElement;
  private unitSelect!: HTMLSelectElement;
  private searchButton!: HTMLButtonElement;
  private textInput!: HTMLInputElement;
  private markerBox!: HTMLInputElement;
  private sideButtons = new Map<SideFilter, HTMLButtonElement>();

  constructor(private readonly handlers: ClusterSearchHandlers) {
    this.backdrop = el('div', 'dialog-backdrop is-side');
    this.backdrop.hidden = true;

    const header = el('div', 'dialog-head');
    const close = el('button', 'dialog-close', '×');
    close.type = 'button';
    close.title = 'Close';
    close.addEventListener('click', () => this.close());
    header.append(this.title, close);

    this.buildForm();
    this.buildFilters();
    this.panel.append(header, this.form, this.filters, this.head, this.results, this.note, this.hint);
    this.backdrop.append(this.panel);
    this.backdrop.addEventListener('pointerdown', (event) => {
      if (event.target === this.backdrop) this.close();
    });
    document.body.append(this.backdrop);
  }

  show(): void {
    // The search follows the chart: the symbol, the interval and the window come from what is
    // on screen, while the threshold and the measure stay as the trader left them.
    const start = this.handlers.prefilled();
    this.instrument = start.instrument;
    this.timeframe = start.timeframe;
    this.windowMinutes = null;
    this.open = true;
    this.backdrop.hidden = false;
    this.backdrop.classList.add('is-open');
    this.render();
    if (!this.threshold) this.thresholdInput.focus();
  }

  close(): void {
    this.open = false;
    this.backdrop.hidden = true;
    this.backdrop.classList.remove('is-open');
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  isOpen(): boolean {
    return this.open;
  }

  /** Re-renders after the app has put a new answer on screen. */
  refresh(): void {
    if (this.open) this.render();
  }

  /** The form as it stands, for the console and the checks. */
  draftState(): { instrument: string; timeframe: string; windowMinutes: number | null; threshold: string; unit: SizeUnit; filter: RowFilter; picked: string | null } {
    return {
      instrument: this.instrument,
      timeframe: this.timeframe,
      windowMinutes: this.windowMinutes,
      threshold: this.threshold,
      unit: this.unit,
      filter: { ...this.filter },
      picked: this.picked,
    };
  }

  /** What the panel is showing, for the console and the checks. */
  debugState(): { rows: number; listed: number; note: string; loading: boolean; error: string | null } {
    const state = this.handlers.state();
    const start = this.handlers.prefilled();
    return {
      rows: state.series?.rows.length ?? 0,
      listed: selectRows(state.series, this.filter, (ms) => this.handlers.time(ms), start.pricePrecision, start.qtyPrecision).length,
      note: clusterSearchNote(state),
      loading: state.loading,
      error: state.error,
    };
  }

  private field(label: string, node: HTMLElement): HTMLElement {
    const wrap = el('div', 'cs-field');
    wrap.append(el('span', 'ind-field-label', label), node);
    return wrap;
  }

  private buildForm(): void {
    this.instrumentInput = el('input', 'dialog-input');
    this.instrumentInput.type = 'text';
    this.instrumentInput.spellcheck = false;
    this.instrumentInput.placeholder = 'BINANCE:BTCUSDT';
    this.instrumentInput.addEventListener('input', () => {
      this.instrument = this.instrumentInput.value;
    });

    this.timeframeSelect = el('select', 'dialog-select');
    this.timeframeSelect.addEventListener('change', () => {
      this.timeframe = this.timeframeSelect.value;
    });

    this.windowSelect = el('select', 'dialog-select');
    for (const entry of WINDOWS) {
      const option = el('option', undefined, entry.label);
      option.value = entry.minutes === null ? 'view' : String(entry.minutes);
      this.windowSelect.append(option);
    }
    this.windowSelect.addEventListener('change', () => {
      this.windowMinutes = this.windowSelect.value === 'view' ? null : Number(this.windowSelect.value);
    });

    this.thresholdInput = el('input', 'dialog-input');
    this.thresholdInput.type = 'text';
    this.thresholdInput.inputMode = 'decimal';
    this.thresholdInput.placeholder = 'e.g. 5000';
    this.thresholdInput.title = 'Smallest size a print may have and still be listed';
    this.thresholdInput.addEventListener('input', () => {
      this.threshold = this.thresholdInput.value;
    });
    this.thresholdInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.submit();
      }
    });

    this.unitSelect = el('select', 'dialog-select');
    for (const entry of [
      { value: 'notional' as const, label: 'quote notional' },
      { value: 'quantity' as const, label: 'base quantity' },
    ]) {
      const option = el('option', undefined, entry.label);
      option.value = entry.value;
      this.unitSelect.append(option);
    }
    this.unitSelect.addEventListener('change', () => {
      this.unit = this.unitSelect.value === 'quantity' ? 'quantity' : 'notional';
    });

    this.searchButton = el('button', 'dialog-accept', 'search');
    this.searchButton.type = 'button';
    this.searchButton.addEventListener('click', () => this.submit());
    this.form.append(
      this.field('Symbol', this.instrumentInput),
      this.field('Interval', this.timeframeSelect),
      this.field('Window', this.windowSelect),
      this.field('At or above', this.thresholdInput),
      this.field('Measure', this.unitSelect),
      this.field('', this.searchButton),
    );
  }

  private buildFilters(): void {
    for (const side of SIDES) {
      const button = el('button', 'cs-side', side.label);
      button.type = 'button';
      button.addEventListener('click', () => {
        this.filter = { ...this.filter, side: side.value };
        this.render();
      });
      this.sideButtons.set(side.value, button);
      this.filters.append(button);
    }
    this.textInput = el('input', 'dialog-input cs-text');
    this.textInput.type = 'text';
    this.textInput.placeholder = 'filter listed rows: time, price, size';
    this.textInput.addEventListener('input', () => {
      this.filter = { ...this.filter, text: this.textInput.value };
      this.render();
    });
    this.markerBox = el('input');
    this.markerBox.type = 'checkbox';
    this.markerBox.addEventListener('change', () => {
      this.handlers.onMarkers(this.markerBox.checked);
      this.render();
    });
    const marks = el('label', 'cs-marks');
    marks.append(this.markerBox, el('span', undefined, 'mark clusters on the chart'));
    this.filters.append(this.textInput, marks);

    // The aggressor column is `cs-aggressor`, not `cs-side`, which is the filter button's class.
    for (const column of ['time', 'price', 'size', 'notional', 'side']) {
      this.head.append(el('span', `cs-cell cs-${column === 'side' ? 'aggressor' : column}`, column));
    }
  }

  /** Reads the form, refuses what cannot be searched, and hands the request to the app. */
  private submit(): void {
    const start = this.handlers.prefilled();
    const threshold = Number(this.threshold.trim());
    if (!this.instrument.trim()) return;
    if (!Number.isFinite(threshold) || threshold <= 0) {
      this.filter = { ...this.filter };
      this.render();
      return;
    }
    const view = this.handlers.prefilled();
    const to = view.to;
    const from = this.windowMinutes === null ? view.from : to - this.windowMinutes * MINUTE_MS;
    this.handlers.onSearch({
      instrument: this.instrument.trim(),
      timeframe: this.timeframe || start.timeframe,
      from,
      to,
      threshold,
      unit: this.unit,
    });
  }

  private render(): void {
    const start = this.handlers.prefilled();
    const state = this.handlers.state();
    const intervals = this.handlers.timeframes();
    if (this.timeframeSelect.value !== this.timeframe) {
      if (![...this.timeframeSelect.options].some((option) => option.value === this.timeframe)) {
        this.timeframeSelect.replaceChildren();
        for (const key of intervals) {
          const option = el('option', undefined, key);
          option.value = key;
          this.timeframeSelect.append(option);
        }
      }
      this.timeframeSelect.value = this.timeframe;
    }
    if (this.instrumentInput.value !== this.instrument) this.instrumentInput.value = this.instrument;
    if (this.thresholdInput.value !== this.threshold) this.thresholdInput.value = this.threshold;
    if (this.unitSelect.value !== this.unit) this.unitSelect.value = this.unit;
    const wanted = this.windowMinutes === null ? 'view' : String(this.windowMinutes);
    if (this.windowSelect.value !== wanted) this.windowSelect.value = wanted;
    if (this.textInput.value !== this.filter.text) this.textInput.value = this.filter.text;
    this.markerBox.checked = this.handlers.markers();
    this.searchButton.disabled = state.loading;
    this.searchButton.textContent = state.loading ? 'searching…' : 'search';

    for (const [side, button] of this.sideButtons) button.classList.toggle('is-on', side === this.filter.side);

    const rows = selectRows(state.series, this.filter, (ms) => this.handlers.time(ms), start.pricePrecision, start.qtyPrecision);
    const fragment = document.createDocumentFragment();
    for (const row of rows) fragment.append(this.resultRow(row, start.pricePrecision, start.qtyPrecision));
    if (rows.length === 0) fragment.append(el('div', 'dialog-note', this.emptyMessage(state, rows.length)));
    this.results.replaceChildren(fragment);

    this.note.className = state.error ? 'cs-note is-error' : 'cs-note';
    this.note.textContent = clusterSearchNote(state);
    this.title.textContent = state.series
      ? `Cluster search · ${grouped(state.series.clusters)} prints at or above ${fmtSizeLabel(state.series.threshold)}`
      : 'Cluster search';

    const parts = [
      'Prints are searched in the store, not in the browser, so the window can be wider than the chart.',
      'Click a row to centre the chart on that print.',
      'Esc closes',
    ];
    this.hint.replaceChildren();
    for (const part of parts) this.hint.append(el('span', 'alert-hint-part', part));
  }

  /**
   * Why the list is empty, in the order a trader needs it: nothing searched yet, nothing
   * stored, nothing big enough, or a filter that hides rows the scan did find. The last of
   * those must not read like the first two, or a filter looks like a window with no prints.
   */
  private emptyMessage(state: ClusterSearchState, listed: number): string {
    const series = state.series;
    if (!series) return 'Search a window to list its prints.';
    if (series.prints === 0) return 'No prints are stored for that window, so the search had nothing to look at.';
    if (series.clusters === 0) return `Nothing in that window reached ${fmtSizeLabel(series.threshold)}.`;
    if (listed === 0 && series.rows.length > 0) return 'No listed row matches this filter.';
    return `The row cap kept the ${series.returned} newest of ${series.clusters}; none of them match this filter.`;
  }

  private resultRow(row: ClusterPrint, pricePrecision: number, qtyPrecision: number): HTMLElement {
    const cells = rowCells(row, (ms) => this.handlers.time(ms), pricePrecision, qtyPrecision);
    const key = printKey(row);
    const line = el('div', 'cs-row');
    line.tabIndex = 0;
    line.dataset.key = key;
    line.classList.toggle('is-picked', this.picked === key);
    line.title = `Centre the chart on this print · seq ${row.seq}`;
    for (const column of ['time', 'price', 'size', 'notional', 'side'] as const) {
      const name = column === 'side' ? `cs-aggressor ${row.aggressor === 'buy' ? 'is-buy' : 'is-sell'}` : `cs-${column}`;
      line.append(el('span', `cs-cell ${name}`, cells[column]));
    }
    const pick = () => {
      this.picked = key;
      this.handlers.onPick(row);
      this.render();
    };
    line.addEventListener('click', pick);
    line.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      pick();
    });
    return line;
  }
}

function grouped(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}
