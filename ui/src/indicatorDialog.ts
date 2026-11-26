/**
 * The Indicators dialog: the catalog, the instances already added, one instance's
 * parameters, and the script a user indicator is written in.
 *
 * The script arrives one of two ways. kscript is what this chart runs, and it is edited
 * where its parameters are edited. TradingView Pine is pasted into the add dialog, which
 * converts it first: a Pine script that uses something the converter does not know keeps
 * the dialog open with the offending lines named, because a half-translated indicator that
 * plots something plausible is worse than one that refuses to appear.
 */

import { el } from './canvasKit';
import type { IndicatorInstance } from './indicators/engine';
import { convertPine } from './indicators/pine/emit';
import { STARTER_SCRIPT } from './indicators/script/starter';
import { paramsSignature } from './indicators/signature';
import {
  INDICATORS,
  INDICATOR_GROUPS,
  boolean as readBoolean,
  colorList,
  number as readNumber,
  string as readString,
  toHex,
  type IndicatorDefinition,
  type ParamDescriptor,
  type ParamValues,
} from './indicators/registry';

/** What the dialog asks the app to do; it owns no state of its own. */
export interface IndicatorDialogHandlers {
  onAdd(indicatorId: string): void;
  onRemove(instanceId: string): void;
  onParams(instanceId: string, patch: ParamValues): void;
  /** Replaces an instance's script as it is typed. */
  onScript(instanceId: string, source: string): void;
  /** Adds a user indicator from a script, and returns its instance id, or null if refused. */
  onAddScript(source: string): string | null;
  instances(): IndicatorInstance[];
  definitionOf(instance: IndicatorInstance): IndicatorDefinition | null;
  summary(instance: IndicatorInstance): string;
  scriptError(instance: IndicatorInstance): string | null;
}

/** The two kinds of source the add dialog takes. */
const MODES = [
  { id: 'kscript', label: 'kscript', hint: 'The script format this chart runs.' },
  { id: 'pine', label: 'Pine Script', hint: 'Paste TradingView Pine v2-v5; it converts before it is added.' },
] as const;

type ModeId = (typeof MODES)[number]['id'];

export class IndicatorDialog {
  private readonly backdrop: HTMLDivElement;
  private readonly panel = el('div', 'dialog');
  private readonly title = el('span', 'dialog-title', 'Indicators');
  private readonly body = el('div', 'ind-body');
  private readonly hint = el('div', 'dialog-hint');
  /** The instance whose settings are open, or null for the catalog. */
  private settingsFor: string | null = null;
  /** Text typed into the catalog's filter box, matched against id, name and group. */
  private filter = '';
  /** Set when a re-render came from the filter box, so the caret can be put back. */
  private refocusFilter = false;
  /** The script instance whose error line has to keep up with typing. */
  private statusFor: string | null = null;
  private statusLine: HTMLDivElement | null = null;
  private filterInput: HTMLInputElement | null = null;
  private formSignature = '';
  private open = false;

  constructor(private readonly handlers: IndicatorDialogHandlers) {
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
    (this.body.querySelector<HTMLInputElement>('.ind-filter input') ??
      this.body.querySelector<HTMLElement>('.ind-item') ??
      this.body.querySelector<HTMLInputElement>('.ind-field input'))?.focus();
  }

  refreshStatus(): void {
    const id = this.statusFor;
    if (!id) return;
    const instance = this.handlers.instances().find((entry) => entry.id === id);
    if (!instance) return;
    // A declaration can add or remove parameters, so a script that changed shape needs the
    // whole form again; one that only fails needs its error line updated in place.
    if (signatureOf(instance, this.handlers.definitionOf(instance)) !== this.formSignature) {
      const active = document.activeElement;
      const typing = active instanceof HTMLTextAreaElement;
      const from = typing ? active.selectionStart : 0;
      const to = typing ? active.selectionEnd : 0;
      this.render();
      if (!typing) return;
      const area = this.body.querySelector<HTMLTextAreaElement>('textarea.ind-script');
      if (!area) return;
      area.focus();
      area.setSelectionRange(Math.min(from, area.value.length), Math.min(to, area.value.length));
      return;
    }
    const line = this.statusLine;
    if (!line) return;
    const error = this.handlers.scriptError(instance);
    line.textContent = error ? `⚠ ${error}` : '';
    line.hidden = error === null;
  }

  close(): void {
    this.open = false;
    this.settingsFor = null;
    this.statusFor = null;
    this.statusLine = null;
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

  /**
   * Re-reads the list or the open settings form after a change made outside this dialog,
   * such as an undo, so its fields never show a value the chart no longer holds.
   */
  refresh(): void {
    if (this.open) this.render();
  }

  /** Opens one instance's settings, from the workspace's "configure" affordance. */
  showSettings(instanceId: string): void {
    this.settingsFor = instanceId;
    if (this.open) this.render();
    else this.show();
  }

  private render(): void {
    if (this.settingsFor) {
      const instance = this.handlers.instances().find((entry) => entry.id === this.settingsFor) ?? null;
      const definition = instance ? this.handlers.definitionOf(instance) : null;
      if (!instance || !definition) this.settingsFor = null;
      else {
        this.renderSettings(instance, definition);
        return;
      }
    }
    this.renderList();
  }

  private renderList(): void {
    this.title.textContent = 'Indicators';
    const fragment = document.createDocumentFragment();
    fragment.append(this.filterField());
    for (const placement of ['onchart', 'offchart'] as const) {
      const definitions = INDICATORS.filter((definition) => definition.placement === placement && matchesFilter(definition, this.filter));
      if (definitions.length === 0) continue;
      fragment.append(el('div', 'ind-section-title', placement === 'onchart' ? 'Over the price' : 'In their own pane'));
      for (const group of INDICATOR_GROUPS) {
        const inGroup = definitions.filter((definition) => definition.group === group);
        if (inGroup.length === 0) continue;
        fragment.append(el('div', 'ind-group-title', group), this.catalog(inGroup));
      }
    }
    const shown = INDICATORS.filter((definition) => matchesFilter(definition, this.filter)).length;
    if (shown === 0) fragment.append(el('div', 'dialog-note', `Nothing matches "${this.filter}".`));
    fragment.append(el('div', 'ind-section-title', 'Write your own'), this.scriptCatalog());

    const instances = this.handlers.instances();
    const section = el('div', 'ind-section');
    section.append(el('div', 'ind-section-title', `Added (${instances.length})`));
    if (instances.length === 0) section.append(el('div', 'dialog-note', 'Nothing added yet — pick one above.'));
    for (const instance of instances) section.append(this.instanceRow(instance));
    fragment.append(section);
    this.body.replaceChildren(fragment);
    this.hint.textContent = `${INDICATORS.length} indicators · add as many as you want · each instance keeps its own settings · Esc closes`;
    const filter = this.filterInput;
    if (this.refocusFilter && filter) {
      this.refocusFilter = false;
      filter.focus();
      filter.setSelectionRange(filter.value.length, filter.value.length);
    }
  }

  /** The catalog's search box: with thirty types, typing two letters beats scanning. */
  private filterField(): HTMLElement {
    const wrap = el('div', 'ind-filter');
    const input = el('input', 'dialog-input');
    input.type = 'search';
    input.placeholder = 'Filter indicators';
    input.setAttribute('aria-label', 'Filter indicators');
    input.value = this.filter;
    input.addEventListener('input', () => {
      this.filter = input.value;
      this.refocusFilter = true;
      this.render();
    });
    this.filterInput = input;
    wrap.append(input);
    return wrap;
  }

  private catalog(definitions: readonly IndicatorDefinition[]): HTMLElement {
    const grid = el('div', 'ind-grid');
    for (const definition of definitions) {
      const item = el('button', 'ind-item');
      item.type = 'button';
      item.append(el('span', 'ind-item-name', definition.short), el('span', 'ind-item-label', definition.label));
      item.addEventListener('click', () => {
        this.handlers.onAdd(definition.id);
        this.render();
      });
      grid.append(item);
    }
    return grid;
  }

  private scriptCatalog(): HTMLElement {
    const grid = el('div', 'ind-grid');
    const item = el('button', 'ind-item');
    item.type = 'button';
    item.append(el('span', 'ind-item-name', 'Script'), el('span', 'ind-item-label', 'Your own indicator, written as a script or pasted from Pine'));
    item.addEventListener('click', () => {
      openScriptDialog(null, (source) => {
        const id = this.handlers.onAddScript(source);
        if (id) this.settingsFor = id;
        this.render();
      });
    });
    grid.append(item);
    return grid;
  }

  private instanceRow(instance: IndicatorInstance): HTMLElement {
    const definition = this.handlers.definitionOf(instance);
    const row = el('div', 'ind-row');
    const main = el('div', 'ind-row-main');
    const error = this.handlers.scriptError(instance);
    main.append(
      el('span', 'ind-row-name', definition?.label ?? instance.indicatorId),
      el('span', 'ind-row-meta', error ? `⚠ ${error}` : this.handlers.summary(instance) || 'default settings'),
    );
    const settings = el('button', 'dialog-watch', 'settings');
    settings.type = 'button';
    settings.addEventListener('click', (event) => {
      event.stopPropagation();
      this.settingsFor = instance.id;
      this.render();
    });
    const remove = el('button', 'dialog-watch', 'remove');
    remove.type = 'button';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      this.handlers.onRemove(instance.id);
      if (this.settingsFor === instance.id) this.settingsFor = null;
      this.render();
    });
    row.append(main, settings, remove);
    row.addEventListener('click', () => {
      this.settingsFor = instance.id;
      this.render();
    });
    return row;
  }

  private renderSettings(instance: IndicatorInstance, definition: IndicatorDefinition): void {
    this.formSignature = signatureOf(instance, definition);
    this.title.textContent = definition.label;
    this.statusFor = instance.script === undefined ? null : instance.id;
    this.statusLine = null;

    const script = instance.script === undefined ? null : this.scriptForm(instance);
    const form = el('div', 'ind-form');
    for (const param of definition.params) form.append(this.field(instance.id, param));

    const actions = el('div', 'ind-actions');
    const back = el('button', 'dialog-watch', '‹ all indicators');
    back.type = 'button';
    back.addEventListener('click', () => {
      this.settingsFor = null;
      this.render();
    });
    const remove = el('button', 'dialog-watch', 'remove this indicator');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      this.handlers.onRemove(instance.id);
      this.settingsFor = null;
      this.render();
    });
    actions.append(back, remove);

    this.body.replaceChildren(...(script ? [script] : []), form, actions);
    this.hint.textContent =
      instance.script === undefined
        ? 'Changes apply as you type · every instance is independent'
        : 'Changes apply as you type · a bad script keeps its last good drawing · Esc closes';
  }

  /** The script of a user indicator, editable where its parameters are. */
  private scriptForm(instance: IndicatorInstance): HTMLElement {
    const wrap = el('label', 'ind-field ind-script-wrap');
    wrap.append(el('span', 'ind-field-label', 'Script'));
    const area = el('textarea', 'ind-script');
    area.value = instance.script ?? '';
    area.rows = 14;
    area.spellcheck = false;
    area.addEventListener('input', () => this.handlers.onScript(instance.id, area.value));

    const status = el('div', 'ind-script-status');
    const error = this.handlers.scriptError(instance);
    status.textContent = error ? `⚠ ${error}` : '';
    status.hidden = error === null;
    this.statusLine = status;

    const actions = el('div', 'ind-script-actions');
    const convert = el('button', 'dialog-watch', 'convert pasted Pine');
    convert.type = 'button';
    convert.title = 'Read the text above as TradingView Pine and replace it with the equivalent script';
    convert.addEventListener('click', () => {
      const conversion = convertPine(area.value.trim());
      if (!conversion.ok) {
        status.textContent = conversion.errors.map((entry) => `line ${entry.line}: ${entry.message}`).join('\n');
        status.hidden = false;
        return;
      }
      area.value = conversion.source;
      status.textContent = '';
      status.hidden = true;
      this.handlers.onScript(instance.id, conversion.source);
    });
    actions.append(convert, el('span', 'ind-script-hint', 'Pine v2-v5; anything unsupported names its line instead of guessing.'));

    wrap.append(area, actions, status);
    return wrap;
  }

  private field(instanceId: string, param: ParamDescriptor): HTMLElement {
    const wrap = el('label', 'ind-field');
    wrap.append(el('span', 'ind-field-label', param.label));
    const commit = (patch: ParamValues): void => this.handlers.onParams(instanceId, patch);

    if (param.kind === 'colors') {
      const slots = param.slots ?? ['Color'];
      const colors = colorList(stored(instanceId, this.handlers), slots);
      const row = el('div', 'ind-swatches');
      slots.forEach((slot, index) => {
        const swatch = el('div', 'ind-swatch');
        const input = el('input');
        input.type = 'color';
        input.value = toHex(colors[index] ?? '#4b9cf5');
        input.setAttribute('aria-label', `${param.label} ${slot}`);
        input.addEventListener('input', () => {
          const next = colors.slice();
          next[index] = input.value;
          commit({ colors: next });
        });
        swatch.append(input, el('span', 'ind-swatch-label', slots.length > 1 ? slot : ''));
        row.append(swatch);
      });
      wrap.append(row);
      return wrap;
    }

    if (param.kind === 'boolean') {
      const input = el('input', 'ind-check');
      input.type = 'checkbox';
      input.checked = readBoolean(stored(instanceId, this.handlers), param.name, param.default === true);
      input.addEventListener('change', () => commit({ [param.name]: input.checked }));
      wrap.append(input);
      return wrap;
    }

    if (param.kind === 'select') {
      const select = el('select', 'dialog-select');
      for (const option of param.options ?? []) {
        const node = el('option', undefined, option);
        node.value = option;
        select.append(node);
      }
      select.value = readString(stored(instanceId, this.handlers), param.name, String(param.default));
      select.addEventListener('change', () => commit({ [param.name]: select.value }));
      wrap.append(select);
      return wrap;
    }

    const input = el('input', 'dialog-input');
    input.type = 'number';
    if (param.min !== undefined) input.min = String(param.min);
    if (param.max !== undefined) input.max = String(param.max);
    if (param.step !== undefined) input.step = String(param.step);
    input.value = String(readNumber(stored(instanceId, this.handlers), param.name, Number(param.default) || 0));
    input.addEventListener('input', () => {
      const value = Number(input.value);
      if (Number.isFinite(value)) commit({ [param.name]: value });
    });
    wrap.append(input);
    return wrap;
  }
}

/* ------------------------------------------------------------------ catalog filter */

/** Whether one indicator survives the filter box: id, short name, label or section. */
function matchesFilter(definition: IndicatorDefinition, filter: string): boolean {
  const text = filter.trim().toLowerCase();
  if (!text) return true;
  return [definition.id, definition.short, definition.label, definition.group].some((value) => value.toLowerCase().includes(text));
}

/* ------------------------------------------------------------------ values */

/** The parameters an instance holds, which the form reads back out of. */
function stored(instanceId: string, handlers: IndicatorDialogHandlers): ParamValues {
  return handlers.instances().find((entry) => entry.id === instanceId)?.params ?? {};
}

/**
 * What a settings form describes: its parameters and, for a user indicator, its script.
 * Either half moving means the parameters on screen may no longer be the right ones.
 */
function signatureOf(instance: IndicatorInstance, definition: IndicatorDefinition | null): string {
  return `${paramsSignature(instance.params)}|${instance.script ?? ''}|${definition?.params.map((param) => param.name).join(',') ?? ''}`;
}

/* ------------------------------------------------------------------ script editor */

/** Opens the editor for a new indicator's script. Resolves once, with the source to add. */
export function openScriptDialog(initial: string | null, onAccept: (source: string) => void): void {
  const backdrop = el('div', 'dialog-backdrop is-open');
  const card = el('div', 'dialog script-dialog');

  const head = el('div', 'dialog-head');
  const title = el('div', 'dialog-title', initial ? 'Edit indicator script' : 'Add indicator script');
  const close = el('button', 'dialog-close', '×');
  close.type = 'button';
  close.title = 'Close';
  head.append(title, close);

  const modes = el('div', 'script-modes');
  const hint = el('span', 'script-mode-hint');

  const area = el('textarea', 'script-area');
  area.spellcheck = false;
  area.value = initial ?? STARTER_SCRIPT;

  const issues = el('div', 'script-issues');
  issues.hidden = true;

  const actions = el('div', 'dialog-actions');
  const tip = el('span', 'dialog-tip', 'Cmd/Ctrl+Enter to add');
  const accept = el('button', 'dialog-accept', initial ? 'Apply' : 'Add indicator');
  actions.append(tip, accept);
  card.append(head, modes, area, issues, actions);

  let mode: ModeId = 'kscript';
  const buttons = new Map<ModeId, HTMLButtonElement>();
  for (const entry of MODES) {
    const button = el('button', 'script-mode', entry.label);
    button.type = 'button';
    button.addEventListener('click', () => {
      mode = entry.id;
      for (const [id, other] of buttons) other.classList.toggle('is-on', id === mode);
      area.placeholder = entry.id === 'pine' ? '//@version=5\nindicator("My study", overlay=false)\n…' : '';
      paint();
      area.focus();
    });
    buttons.set(entry.id, button);
    modes.append(button);
  }
  buttons.get('kscript')?.classList.add('is-on');
  modes.append(hint);

  /** Shows what pasted Pine does or does not convert to, before anything is added. */
  function paint(): void {
    hint.textContent = MODES.find((entry) => entry.id === mode)?.hint ?? '';
    issues.textContent = '';
    const text = area.value.trim();
    if (mode === 'kscript' || text.length === 0) {
      issues.hidden = true;
      accept.disabled = text.length === 0;
      return;
    }
    const conversion = convertPine(text);
    accept.disabled = !conversion.ok;
    for (const error of conversion.errors) addIssue(issues, 'error', `line ${error.line}: ${error.message}`);
    for (const warning of conversion.warnings) addIssue(issues, 'note', `line ${warning.line}: ${warning.message}`);
    if (conversion.ok) {
      addIssue(
        issues,
        'ok',
        `Converts to "${conversion.name}", ${conversion.plotLabels.length > 0 ? conversion.plotLabels.join(', ') : 'with no plots'} — ${conversion.placement === 'price' ? 'drawn over the price' : 'in its own pane'}.`,
      );
    }
    issues.hidden = false;
  }

  function submit(): void {
    const text = area.value.trim();
    if (text.length === 0) return;
    if (mode === 'pine') {
      const conversion = convertPine(text);
      if (!conversion.ok) {
        paint();
        return;
      }
      onAccept(conversion.source);
    } else {
      onAccept(text);
    }
    done();
  }

  area.addEventListener('input', paint);
  accept.addEventListener('click', submit);
  close.addEventListener('click', done);
  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target === backdrop) done();
  });
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      done();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      event.stopImmediatePropagation();
      submit();
    }
  };
  // The chart's own shortcut handler owns capture on window; this dialog was opened last,
  // so it reads the key first and swallows it.
  window.addEventListener('keydown', onKey, true);

  function done(): void {
    window.removeEventListener('keydown', onKey, true);
    backdrop.remove();
  }

  backdrop.append(card);
  document.body.append(backdrop);
  paint();
  area.focus();
}

/** One line of conversion feedback: a refusal, a note, or the result. */
function addIssue(host: HTMLDivElement, kind: 'error' | 'note' | 'ok', text: string): void {
  host.append(el('div', `script-issue ${kind}`, text));
}
