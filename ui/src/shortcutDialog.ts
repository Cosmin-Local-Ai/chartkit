import { el } from './canvasKit';
import { SHORTCUT_GROUPS } from './shortcuts';

/**
 * Keyboard reference: every binding app.ts actually implements, grouped. The rows come from
 * `SHORTCUT_GROUPS`, which the Node test holds against the handler, so the list cannot drift
 * into promising a key that does nothing.
 */
export class ShortcutDialog {
  private readonly backdrop: HTMLElement;
  private readonly panel = el('div', 'dialog dialog-shortcuts');
  private readonly title = el('span', 'dialog-title', 'Keyboard shortcuts');
  private readonly body = el('div', 'ind-body');
  private readonly hint = el('div', 'dialog-hint');
  private open = false;

  constructor() {
    this.backdrop = el('div', 'dialog-backdrop');
    this.backdrop.hidden = true;
    const head = el('div', 'dialog-head');
    const close = el('button', 'dialog-close', '×');
    close.type = 'button';
    close.title = 'Close';
    close.addEventListener('click', () => this.close());
    head.append(this.title, close);
    this.panel.append(head, this.body, this.hint);
    this.backdrop.append(this.panel);
    this.backdrop.addEventListener('pointerdown', (event) => {
      if (event.target === this.backdrop) this.close();
    });
    document.body.append(this.backdrop);
  }

  show(): void {
    this.open = true;
    this.backdrop.hidden = false;
    this.backdrop.classList.add('is-open');
    this.render();
    this.body.querySelector<HTMLElement>('.sk-row')?.focus();
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

  /** Re-reads the list; the bindings are static, so this only exists to match the other dialogs. */
  refresh(): void {
    if (this.open) this.render();
  }

  private render(): void {
    const fragment = document.createDocumentFragment();
    for (const group of SHORTCUT_GROUPS) {
      fragment.append(el('div', 'ind-section-title', group.title));
      if (group.note) fragment.append(el('div', 'set-note', group.note));
      for (const row of group.rows) {
        const line = el('div', 'sk-row');
        line.tabIndex = -1;
        line.dataset.keys = row.keys.join('|');
        const keys = el('div', 'sk-keys');
        for (const key of row.keys) keys.append(el('kbd', 'sk-key', key));
        line.append(keys, el('span', 'sk-action', row.action));
        fragment.append(line);
      }
    }
    this.body.replaceChildren(fragment);
    this.hint.textContent = 'Every row here is bound in the app · Esc closes';
  }
}
