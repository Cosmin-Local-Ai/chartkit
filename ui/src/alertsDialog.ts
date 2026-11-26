/**
 * The Alerts panel: the rules the server judges, and what they have fired.
 *
 * Two tabs, one form. The rules tab keeps its form on screen while the list changes under
 * it, because a fire arrives on the socket at any moment and must not disturb a level being
 * typed. The history tab is the record: what fired, when, at what value, and whether the
 * trader had that rule muted or the fire happened while the server was down.
 */

import { el } from './canvasKit';
import {
  ALERT_KINDS,
  buildAlert,
  conditionText,
  crossingExplanation,
  crossingText,
  draftFrom,
  fireValueText,
  formatLevel,
  grantNotice,
  kindMeta,
  newDraft,
  rearmText,
  windowLabel,
  type AlertDraft,
  type AlertPayload,
  type NotificationGrant,
} from './alertsModel';
import type { AlertFire, AlertKind, AlertRecord } from './types';

export interface AlertsDialogHandlers {
  /** Rules and fires the app holds, as the server sent them. */
  alerts(): AlertRecord[];
  fires(): AlertFire[];
  /** What the form starts from: the symbol on screen and its newest price. */
  prefilled(): { instrument: string; price: number | null; precision: number };
  /** Intervals a window rule may sum over. */
  windows(): string[];
  /** What the browser will allow for desktop popups, and the ask the trader starts. */
  popups(): NotificationGrant;
  onAskPermission(): void;
  /** Each action answers with the line the panel shows afterwards. */
  onCreate(payload: AlertPayload): Promise<string> | string;
  onEdit(id: string, payload: AlertPayload): Promise<string> | string;
  onToggle(alert: AlertRecord, enabled: boolean): void;
  onMute(alert: AlertRecord, muted: boolean): void;
  onDelete(alert: AlertRecord): void;
  onClearHistory(): void;
  /** A timestamp in the chart's own clock. */
  time(ms: number): string;
}

type Tab = 'rules' | 'history';

const TABS: { id: Tab; label: string }[] = [
  { id: 'rules', label: 'Rules' },
  { id: 'history', label: 'History' },
];

export class AlertsDialog {
  private readonly backdrop: HTMLElement;
  private readonly panel = el('div', 'dialog dialog-alerts');
  private readonly title = el('span', 'dialog-title', 'Alerts');
  private readonly tabs = el('div', 'fp-tabs');
  private readonly body = el('div', 'ind-body');
  private readonly hint = el('div', 'dialog-hint');
  private readonly tabButtons = new Map<Tab, HTMLButtonElement>();
  private readonly rulesBlock = el('div');
  private readonly historyBlock = el('div');
  /** The form is built once and moved back into the list on every render, so typing in it
   * survives a fire arriving on the socket. */
  private readonly formWrap = el('div', 'alert-form-wrap');
  private readonly noticeLine = el('div', 'set-note');
  private tab: Tab = 'rules';
  private open = false;
  /** The rules are the point of the panel, so the form stays folded away until a rule is
   * being added or edited. */
  private formOpen = false;
  /** The form's own state, so a re-render never loses what is being typed. */
  private draft: AlertDraft;
  private instrumentInput!: HTMLInputElement;
  private levelInput!: HTMLInputElement;
  private upperInput!: HTMLInputElement;
  private windowSelect!: HTMLSelectElement;
  private gapInput!: HTMLInputElement;
  private labelInput!: HTMLInputElement;
  private kindSelect!: HTMLSelectElement;
  private upperField!: HTMLElement;
  private windowField!: HTMLElement;
  private submit!: HTMLButtonElement;
  private cancel!: HTMLButtonElement;
  private notice: { ok: boolean; text: string } | null = null;

  constructor(private readonly handlers: AlertsDialogHandlers) {
    const start = handlers.prefilled();
    this.draft = newDraft(start.instrument, start.price, start.precision);

    this.backdrop = el('div', 'dialog-backdrop');
    this.backdrop.hidden = true;
    const head = el('div', 'dialog-head');
    const close = el('button', 'dialog-close', '×');
    close.type = 'button';
    close.title = 'Close';
    close.addEventListener('click', () => this.close());
    head.append(this.title, close);

    for (const tab of TABS) {
      const button = el('button', 'fp-tab', tab.label);
      button.type = 'button';
      button.addEventListener('click', () => {
        this.tab = tab.id;
        this.render();
      });
      this.tabButtons.set(tab.id, button);
      this.tabs.append(button);
    }

    this.panel.append(head, this.tabs, this.body, this.hint);
    this.backdrop.append(this.panel);
    this.backdrop.addEventListener('pointerdown', (event) => {
      if (event.target === this.backdrop) this.close();
    });
    document.body.append(this.backdrop);
    this.buildForm();
  }

  show(): void {
    // Every time the panel opens it starts from the chart in view, unless a rule is being
    // edited, which keeps its own values.
    if (!this.draft.id) {
      const start = this.handlers.prefilled();
      this.draft = newDraft(start.instrument, start.price, start.precision);
    }
    this.open = true;
    this.backdrop.hidden = false;
    this.backdrop.classList.add('is-open');
    this.render();
    if (this.formOpen) this.levelInput.focus();
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

  /** Re-reads the lists, so a fire that arrives on the socket shows up at once. */
  refresh(): void {
    if (this.open) this.render();
  }

  /** Opens the form on one rule, used by a row's Edit button. */
  edit(alert: AlertRecord): void {
    this.draft = draftFrom(alert);
    this.formOpen = true;
    this.notice = null;
    this.tab = 'rules';
    if (this.open) this.render();
    else this.show();
    this.levelInput.focus();
  }

  /** Which tab is on screen, or null while the dialog is closed. */
  openTab(): Tab | null {
    return this.open ? this.tab : null;
  }

  /** The form as it stands, for the console and the checks. */
  draftState(): AlertDraft {
    return { ...this.draft };
  }

  private setNotice(ok: boolean, text: string): void {
    this.notice = text ? { ok, text } : null;
    this.render();
  }

  private field(label: string, node: HTMLElement): HTMLElement {
    const wrap = el('div', 'ind-field');
    wrap.append(el('span', 'ind-field-label', label), node);
    return wrap;
  }

  private input(kind: 'text' | 'number'): HTMLInputElement {
    const node = el('input', 'dialog-input');
    node.type = kind;
    node.addEventListener('input', () => this.readForm());
    return node;
  }

  private buildForm(): void {
    this.instrumentInput = this.input('text');
    this.instrumentInput.spellcheck = false;
    this.instrumentInput.placeholder = 'BINANCE:BTCUSDT';

    this.kindSelect = el('select', 'dialog-select');
    for (const meta of ALERT_KINDS) {
      const option = el('option', undefined, meta.label);
      option.value = meta.id;
      this.kindSelect.append(option);
    }
    this.kindSelect.addEventListener('change', () => {
      this.readForm();
      this.render();
    });

    this.levelInput = this.input('text');
    this.levelInput.inputMode = 'decimal';
    this.upperInput = this.input('text');
    this.upperInput.inputMode = 'decimal';
    this.gapInput = this.input('text');
    this.gapInput.inputMode = 'decimal';
    this.labelInput = this.input('text');
    this.labelInput.placeholder = 'optional note';

    this.windowSelect = el('select', 'dialog-select');
    for (const key of this.handlers.windows()) {
      const option = el('option', undefined, windowLabel(key));
      option.value = key;
      this.windowSelect.append(option);
    }
    this.windowSelect.addEventListener('change', () => this.readForm());

    const actions = el('div', 'alert-form-actions');
    this.submit = el('button', 'dialog-watch', 'add rule');
    this.submit.type = 'button';
    this.submit.addEventListener('click', () => void this.submitRule());
    this.cancel = el('button', 'dialog-watch', 'new rule');
    this.cancel.type = 'button';
    this.cancel.addEventListener('click', () => this.toggleForm());
    actions.append(this.submit, this.cancel);

    this.upperField = this.field('Upper bound', this.upperInput);
    this.windowField = this.field('Bar to sum', this.windowSelect);
    const form = el('div', 'ind-form alert-form');
    form.append(
      this.field('Symbol', this.instrumentInput),
      this.field('Condition', this.kindSelect),
      this.field('Level', this.levelInput),
      this.upperField,
      this.windowField,
      this.field('Re-arm gap', this.gapInput),
      this.field('Note', this.labelInput),
    );
    this.formWrap.append(form, actions, this.noticeLine);
  }

  /** Opens a blank rule built from the chart in view, or folds the form away again. A
   * half-typed edit is dropped, so the next new rule starts clean. */
  private toggleForm(): void {
    if (!this.formOpen) {
      const start = this.handlers.prefilled();
      this.draft = newDraft(start.instrument, start.price, start.precision);
      this.notice = null;
      this.formOpen = true;
      this.tab = 'rules';
      this.render();
      this.levelInput.focus();
      return;
    }
    this.formOpen = false;
    this.draft = { ...this.draft, id: '' };
    this.notice = null;
    this.render();
  }

  /** Which pane the panel is showing: the form, or the list it folds into. */
  formVisible(): boolean {
    return this.formOpen;
  }

  /** Pulls the typed values into the draft; called on every keystroke. */
  private readForm(): void {
    this.draft = {
      ...this.draft,
      instrument: this.instrumentInput.value,
      kind: this.kindSelect.value as AlertKind,
      level: this.levelInput.value,
      upper: this.upperInput.value,
      window: this.windowSelect.value,
      gap: this.gapInput.value,
      label: this.labelInput.value,
    };
  }

  private async submitRule(): Promise<void> {
    this.readForm();
    const built = buildAlert(this.draft, this.handlers.windows());
    if (!built.ok) {
      this.setNotice(false, built.error);
      return;
    }
    const editing = this.draft.id;
    try {
      const line = editing
        ? await this.handlers.onEdit(editing, built.payload)
        : await this.handlers.onCreate(built.payload);
      if (editing) {
        this.draft = { ...this.draft, id: '' };
        const start = this.handlers.prefilled();
        this.draft = newDraft(start.instrument, start.price, start.precision);
      }
      this.setNotice(true, line);
    } catch (error) {
      this.setNotice(false, error instanceof Error ? error.message : String(error));
    }
  }

  private render(): void {
    for (const [id, button] of this.tabButtons) button.classList.toggle('is-on', id === this.tab);
    this.title.textContent = this.tab === 'rules' ? 'Alerts · rules' : 'Alerts · trigger history';

    const start = this.handlers.prefilled();
    const meta = kindMeta(this.draft.kind);
    this.instrumentInput.value = this.draft.instrument;
    this.kindSelect.value = this.draft.kind;
    this.levelInput.value = this.draft.level;
    this.upperInput.value = this.draft.upper;
    this.gapInput.value = this.draft.gap;
    this.labelInput.value = this.draft.label;
    if (this.windowSelect.value !== this.draft.window) this.windowSelect.value = this.draft.window;
    this.levelInput.placeholder = start.price === null ? '' : formatLevel(start.price, this.draft.kind, start.precision);
    this.upperField.hidden = !meta.needsUpperLevel;
    this.windowField.hidden = !meta.needsWindow;
    this.submit.textContent = this.draft.id ? 'save rule' : 'add rule';
    this.cancel.textContent = !this.formOpen ? 'new rule' : this.draft.id ? 'cancel' : 'hide form';
    this.cancel.title = !this.formOpen
      ? 'Add a rule for the chart in view'
      : this.draft.id
        ? 'Stop editing and go back to the rules'
        : 'Go back to the rules';
    this.formWrap.hidden = !this.formOpen;

    const rules = this.handlers.alerts();
    const fires = this.handlers.fires();
    this.renderRules(rules, start.precision);
    this.renderHistory(fires, start.precision);
    this.rulesBlock.hidden = this.tab !== 'rules';
    this.historyBlock.hidden = this.tab !== 'history';
    this.body.replaceChildren(this.tab === 'rules' ? this.rulesBlock : this.historyBlock);

    this.noticeLine.className = this.notice ? (this.notice.ok ? 'set-io-line' : 'set-io-warn') : 'set-note';
    this.noticeLine.textContent = this.notice?.text ?? '';

    const grant = this.handlers.popups();
    const parts = [
      'Rules are judged by the local server, so they fire with the page closed.',
      grantNotice(grant),
      `${rules.length} rule${rules.length === 1 ? '' : 's'} · ${fires.length} fire${fires.length === 1 ? '' : 's'} listed`,
      'Esc closes',
    ];
    if (grant === 'asking') parts.splice(2, 0, '');
    this.hint.replaceChildren();
    for (const part of parts) {
      if (!part) continue;
      this.hint.append(el('span', 'alert-hint-part', part));
    }
    if (!this.formOpen && this.tab === 'rules') {
      const create = el('button', 'alert-ask', 'new rule');
      create.type = 'button';
      create.title = 'Add a rule for the chart in view';
      create.addEventListener('click', () => this.toggleForm());
      this.hint.append(create);
    }
    if (grant === 'asking' || grant === 'blocked') {
      const ask = el('button', 'alert-ask', 'ask for popups');
      ask.type = 'button';
      ask.title = 'The browser only accepts this request after a click.';
      ask.addEventListener('click', () => {
        this.handlers.onAskPermission();
        this.render();
      });
      this.hint.append(ask);
    }
  }

  private renderRules(rules: readonly AlertRecord[], precision: number): void {
    const fragment = document.createDocumentFragment();
    if (this.formOpen) fragment.append(el('div', 'ind-section-title', 'New rule'));
    fragment.append(this.formWrap);
    fragment.append(el('div', 'ind-section-title', rules.length === 0 ? 'Rules · none yet' : `Rules · ${rules.length}`));
    if (rules.length === 0) {
      fragment.append(
        el(
          'div',
          'dialog-note',
          'No rules yet. A price rule answers on the next print that crosses the level; a volume or delta rule answers when its bar closes.',
        ),
      );
    }
    for (const rule of rules) fragment.append(this.ruleRow(rule, precision));
    this.rulesBlock.replaceChildren(fragment);
  }

  private ruleRow(rule: AlertRecord, precision: number): HTMLElement {
    const row = el('div', 'ind-row alert-row');
    row.dataset.id = rule.id;
    const main = el('div', 'ind-row-main');
    main.append(
      el('span', 'ind-row-name', rule.label || rule.instrument),
      el(
        'span',
        'ind-row-meta',
        [
          rule.instrument,
          conditionText(rule, precision),
          kindMeta(rule.kind).evaluation,
          rearmText(rule, precision),
          crossingText(rule),
          rule.lastFiredAt ? `last ${this.handlers.time(rule.lastFiredAt)}` : 'never fired',
        ]
          .filter(Boolean)
          .join(' · '),
      ),
    );
    // The row is narrow, so the state is short on screen and full on hover.
    row.title = [
      `${rule.instrument} · ${conditionText(rule, precision)}`,
      `judged on ${kindMeta(rule.kind).evaluation}`,
      rearmText(rule, precision),
      crossingExplanation(rule),
      rule.lastFiredAt ? `last fired ${this.handlers.time(rule.lastFiredAt)}` : 'never fired',
    ]
      .filter(Boolean)
      .join('. ');
    const actions = el('div', 'alert-actions');
    actions.append(
      action(rule.enabled ? 'on' : 'off', rule.enabled ? 'Switch this rule off' : 'Switch this rule back on', () =>
        this.handlers.onToggle(rule, !rule.enabled),
      ),
      action(rule.muted ? 'muted' : 'mute', rule.muted ? 'Allow the desktop popup again' : 'Keep the popup off; the list still records every fire', () =>
        this.handlers.onMute(rule, !rule.muted),
      ),
      action('edit', 'Change this rule; saving it waits for a fresh crossing', () => this.edit(rule)),
      action('delete', 'Remove this rule; its fires stay in the history', () => this.handlers.onDelete(rule)),
    );
    row.append(main, actions);
    row.classList.toggle('is-off', !rule.enabled);
    row.classList.toggle('is-muted', rule.muted);
    return row;
  }

  private renderHistory(fires: readonly AlertFire[], precision: number): void {
    const fragment = document.createDocumentFragment();
    fragment.append(el('div', 'ind-section-title', fires.length === 0 ? 'Trigger history · nothing yet' : `Trigger history · ${fires.length} newest first`));
    if (fires.length === 0) {
      fragment.append(el('div', 'dialog-note', 'Nothing has fired yet. Fires are kept on the server, so they survive a restart and a closed page.'));
    }
    for (const fire of fires) {
      const row = el('div', 'ind-row alert-row');
      row.dataset.fire = fire.id;
      const main = el('div', 'ind-row-main');
      main.append(
        el('span', 'ind-row-name', `${fire.instrument} · ${conditionText(fire, precision)}`),
        el(
          'span',
          'ind-row-meta',
          [
            this.handlers.time(fire.ts),
            fireValueText(fire, precision),
            fire.barStart !== undefined ? `bar ${this.handlers.time(fire.barStart)}` : '',
            fire.missed ? 'missed while the server was down' : '',
            fire.muted ? 'muted' : '',
            fire.label,
          ]
            .filter(Boolean)
            .join(' · '),
        ),
      );
      row.append(main);
      row.classList.toggle('is-missed', fire.missed);
      fragment.append(row);
    }
    const clear = el('button', 'dialog-watch', 'clear history');
    clear.type = 'button';
    clear.title = 'Empty the list. The rules themselves are untouched.';
    clear.hidden = fires.length === 0;
    clear.addEventListener('click', () => {
      this.handlers.onClearHistory();
      this.setNotice(true, 'Trigger history emptied.');
    });
    const actions = el('div', 'alert-form-actions');
    actions.append(clear);
    fragment.append(actions);
    this.historyBlock.replaceChildren(fragment);
  }
}

function action(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', 'alert-btn', label);
  node.type = 'button';
  node.title = title;
  node.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return node;
}
