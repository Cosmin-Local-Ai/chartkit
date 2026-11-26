import { api } from './api';
import type { Instrument } from './types';
import { ASSET_CLASSES } from './types';
import { el } from './canvasKit';

export interface SearchHandlers {
  onOpen: (instrument: Instrument) => void;
  onWatch: (instrument: Instrument) => void;
}

/**
 * Symbol search dialog: queries the instrument catalogue by text and asset class,
 * keyboard first (arrows move, Enter opens, Shift+Enter adds to the watchlist,
 * Escape closes).
 */
export class SymbolSearch {
  private readonly backdrop: HTMLElement;
  private readonly panel = el('div', 'dialog');
  private readonly input = el('input', 'dialog-input');
  private readonly select = el('select', 'dialog-select');
  private readonly results = el('div', 'dialog-results');
  private readonly hint = el('div', 'dialog-hint');
  private items: Instrument[] = [];
  private cursor = 0;
  private timer: number | null = null;
  private requestId = 0;
  private status: string | null = null;
  private open = false;

  constructor(
    backdrop: HTMLElement,
    private readonly handlers: SearchHandlers,
  ) {
    this.backdrop = backdrop;
    this.input.placeholder = 'Search symbol, name or venue id';
    this.input.setAttribute('aria-label', 'Search symbols');
    this.input.spellcheck = false;
    for (const option of ASSET_CLASSES) {
      const node = el('option', undefined, option.label);
      node.value = option.value;
      this.select.append(node);
    }
    const bar = el('div', 'dialog-bar');
    bar.append(this.input, this.select);
    const head = el('div', 'dialog-head');
    head.append(el('span', 'dialog-title', 'Symbol search'), closeIcon(() => this.close()));
    this.panel.append(head, bar, this.results, this.hint);
    this.backdrop.append(this.panel);
    this.backdrop.addEventListener('pointerdown', (event) => {
      if (event.target === this.backdrop) this.close();
    });

    this.input.addEventListener('input', () => this.schedule());
    this.select.addEventListener('change', () => this.schedule());
    this.input.addEventListener('keydown', (event) => this.onKey(event));
    this.results.addEventListener('keydown', (event) => this.onKey(event));
  }

  show(initialQuery = ''): void {
    this.open = true;
    this.backdrop.hidden = false;
    this.backdrop.classList.add('is-open');
    this.input.value = initialQuery;
    this.input.focus();
    this.input.select();
    this.search();
  }

  close(): void {
    this.open = false;
    this.backdrop.hidden = true;
    this.backdrop.classList.remove('is-open');
  }

  isOpen(): boolean {
    return this.open;
  }

  private schedule(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.search(), 180);
  }

  private async search(): Promise<void> {
    const query = this.input.value.trim();
    const assetClass = this.select.value;
    const requestId = ++this.requestId;
    this.status = 'searching…';
    this.render();
    try {
      const response = await api.instruments(query, assetClass);
      if (requestId !== this.requestId) return;
      this.items = response.items.slice(0, 200);
      this.cursor = 0;
      this.status = response.count > this.items.length ? `${this.items.length} of ${response.count} matches` : null;
    } catch (error) {
      if (requestId !== this.requestId) return;
      this.items = [];
      this.status = error instanceof Error ? error.message : 'search failed';
    }
    this.render();
  }

  private onKey(event: KeyboardEvent): void {
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        this.close();
        break;
      case 'ArrowDown':
        event.preventDefault();
        this.move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.move(-1);
        break;
      case 'Enter': {
        event.preventDefault();
        const item = this.items[this.cursor];
        if (!item) break;
        if (event.shiftKey) this.handlers.onWatch(item);
        else {
          this.handlers.onOpen(item);
          this.close();
        }
        break;
      }
      default:
        break;
    }
  }

  private move(delta: number): void {
    if (this.items.length === 0) return;
    this.cursor = (this.cursor + delta + this.items.length) % this.items.length;
    this.render(true);
  }

  private render(preserveScroll = false): void {
    if (this.status) {
      this.results.replaceChildren(el('div', 'dialog-note', this.status));
    }
    if (!this.status || this.items.length > 0) {
      const fragment = document.createDocumentFragment();
      this.items.forEach((item, index) => fragment.append(this.itemRow(item, index)));
      this.results.replaceChildren(fragment);
    }
    this.hint.textContent =
      'Enter opens · Shift+Enter adds to watchlist · ↑↓ moves · Esc closes · every class and symbol stored locally is available';
    if (preserveScroll) {
      const active = this.results.children[this.cursor];
      if (active instanceof HTMLElement) active.scrollIntoView({ block: 'nearest' });
    }
  }

  private itemRow(item: Instrument, index: number): HTMLElement {
    const row = el('div', 'dialog-row');
    row.dataset.index = String(index);
    row.tabIndex = 0;
    row.classList.toggle('is-cursor', index === this.cursor);
    const left = el('div', 'dialog-row-left');
    left.append(
      el('span', 'dialog-symbol', item.display),
      el('span', 'dialog-name', item.name || item.symbol),
    );
    const meta = el('div', 'dialog-meta', `${item.venue} · ${item.assetClass} · ${item.quoteCurrency}${item.active ? '' : ' · inactive'}`);
    const watch = el('button', 'dialog-watch', '+ watch');
    watch.type = 'button';
    watch.addEventListener('click', (event) => {
      event.stopPropagation();
      this.handlers.onWatch(item);
    });
    row.append(left, meta, watch);
    row.addEventListener('click', () => {
      this.cursor = index;
      this.handlers.onOpen(item);
      this.close();
    });
    return row;
  }
}

function closeIcon(onClick: () => void): HTMLElement {
  const button = el('button', 'dialog-close', '×');
  button.type = 'button';
  button.title = 'Close';
  button.addEventListener('click', onClick);
  return button;
}
