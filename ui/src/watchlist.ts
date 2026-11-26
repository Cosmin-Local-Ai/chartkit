import type { Instrument } from './types';
import { el } from './canvasKit';
import { fmtPrice, fmtPct } from './format';

export interface WatchEntry {
  instrument: Instrument;
  last: number | null;
  /** Previous session close; the baseline for the change column. */
  reference: number | null;
}

export interface WatchlistHandlers {
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
  onSearch: () => void;
}

/**
 * Watchlist sidebar: last price and session-over-session change per symbol, kept
 * live from the trade stream and persisted through the workspace.
 */
export class Watchlist {
  private readonly list = el('div', 'watch-list');
  private readonly rows = new Map<string, {
    row: HTMLElement;
    price: HTMLElement;
    change: HTMLElement;
  }>();
  private entries: WatchEntry[] = [];
  private activeId: string | null = null;

  constructor(
    root: HTMLElement,
    private readonly handlers: WatchlistHandlers,
  ) {
    root.classList.add('sidebar');
    const head = el('div', 'side-head');
    head.append(el('span', 'side-title', 'Watchlist'));
    const add = el('button', 'side-add', '+');
    add.type = 'button';
    add.title = 'Search symbols';
    add.addEventListener('click', () => handlers.onSearch());
    head.append(add);
    root.append(head, this.list);
  }

  setEntries(entries: WatchEntry[]): void {
    this.entries = entries;
    this.rows.clear();
    this.list.replaceChildren();
    for (const entry of entries) this.list.append(this.buildRow(entry));
    this.markActive();
  }

  private buildRow(entry: WatchEntry): HTMLElement {
    const row = el('div', 'watch-row');
    row.dataset.id = entry.instrument.id;
    row.tabIndex = 0;
    const left = el('div', 'watch-left');
    left.append(el('span', 'watch-symbol', entry.instrument.display), el('span', 'watch-meta', `${entry.instrument.venue} · ${entry.instrument.quoteCurrency}`));
    const price = el('span', 'watch-price', entry.last === null ? '—' : fmtPrice(entry.last, entry.instrument.pricePrecision));
    const change = el('span', 'watch-change', changeText(entry));
    row.append(left, price, change);
    const remove = el('button', 'watch-remove', '×');
    remove.type = 'button';
    remove.title = `Remove ${entry.instrument.display}`;
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      this.handlers.onRemove(entry.instrument.id);
    });
    row.append(remove);
    row.addEventListener('click', () => this.handlers.onOpen(entry.instrument.id));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.handlers.onOpen(entry.instrument.id);
      }
    });
    this.rows.set(entry.instrument.id, { row, price, change });
    this.paint(entry);
    return row;
  }

  /** Live price tick for one symbol; unknown ids are ignored. */
  patch(id: string, price: number): void {
    const entry = this.entries.find((item) => item.instrument.id === id);
    if (!entry) return;
    entry.last = price;
    this.paint(entry);
  }

  setReference(id: string, reference: number | null): void {
    const entry = this.entries.find((item) => item.instrument.id === id);
    if (!entry) return;
    entry.reference = reference;
    this.paint(entry);
  }

  setLast(id: string, last: number | null): void {
    const entry = this.entries.find((item) => item.instrument.id === id);
    if (!entry) return;
    entry.last = last;
    this.paint(entry);
  }

  private paint(entry: WatchEntry): void {
    const cells = this.rows.get(entry.instrument.id);
    if (!cells) return;
    cells.price.textContent = entry.last === null ? '—' : fmtPrice(entry.last, entry.instrument.pricePrecision);
    const text = changeText(entry);
    cells.change.textContent = text;
    const up = text.startsWith('+');
    cells.change.classList.toggle('is-up', up);
    cells.change.classList.toggle('is-down', text.startsWith('-'));
    cells.price.classList.toggle('is-empty', entry.last === null);
  }

  setActive(id: string | null): void {
    this.activeId = id;
    this.markActive();
  }

  private markActive(): void {
    for (const [id, cells] of this.rows) cells.row.classList.toggle('is-active', id === this.activeId);
  }

  has(id: string): boolean {
    return this.entries.some((entry) => entry.instrument.id === id);
  }

}

function changeText(entry: WatchEntry): string {
  if (entry.last === null || entry.reference === null || entry.reference === 0) return '—';
  return fmtPct(((entry.last - entry.reference) / entry.reference) * 100);
}
