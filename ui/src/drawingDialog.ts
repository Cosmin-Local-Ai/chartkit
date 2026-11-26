import { el } from './canvasKit';
import { DRAWING_TOOLS, TOOL_SECTIONS, type DrawingToolDefinition } from './drawings/registry';
import type { DrawingInstance } from './drawings/engine';
import { quickBar, styleForm } from './drawings/styleFields';
import type { StyleValues } from './drawings/style';

export interface DrawingDialogHandlers {
  /** Arms a tool and closes the sheet so the chart can be dragged. */
  onPickTool: (toolId: string) => void;
  onRemove: (instanceId: string) => void;
  onSelect: (instanceId: string) => void;
  /** Style changes apply as you type and are written back to the workspace. */
  onStyle: (instanceId: string, patch: StyleValues) => void;
  instances: () => DrawingInstance[];
  definitionOf: (instance: DrawingInstance | null) => DrawingToolDefinition | null;
  summary: (instance: DrawingInstance) => string;
}

/**
 * Drawing manager: the tool palette grouped by the shipped sections, the list of
 * placed drawings, and the style form for one of them. It borrows the indicator
 * dialog's backdrop and styling, so there is one dialog system on the page.
 */
export class DrawingDialog {
  private readonly backdrop: HTMLElement;
  private readonly panel = el('div', 'dialog');
  private readonly title = el('span', 'dialog-title', 'Drawings');
  private readonly body = el('div', 'ind-body');
  private readonly hint = el('div', 'dialog-hint');
  private settingsFor: string | null = null;
  private open = false;

  constructor(private readonly handlers: DrawingDialogHandlers) {
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
    (this.body.querySelector<HTMLElement>('.drw-tool') ?? this.body.querySelector<HTMLElement>('.ind-field input'))?.focus();
  }

  close(): void {
    this.open = false;
    this.settingsFor = null;
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
   * Re-reads the list or the open style form after a change made outside this dialog, such
   * as an undo, so its fields never show a value the chart no longer holds.
   */
  refresh(): void {
    if (this.open) this.render();
  }

  /** Opens the style form for one placed drawing, used by the chart double-click. */
  showSettings(instanceId: string): void {
    this.settingsFor = instanceId;
    if (!this.open) this.show();
    else this.render();
  }

  private render(): void {
    if (this.settingsFor) {
      const instance = this.handlers.instances().find((entry) => entry.id === this.settingsFor);
      const definition = this.handlers.definitionOf(instance ?? null);
      if (instance && definition) {
        this.renderSettings(instance, definition);
        return;
      }
      this.settingsFor = null;
    }
    this.renderList();
  }

  private renderList(): void {
    this.title.textContent = 'Drawings';
    const fragment = document.createDocumentFragment();
    for (const section of TOOL_SECTIONS) {
      const tools = DRAWING_TOOLS.filter((definition) => definition.sectionKey === section.key);
      if (tools.length === 0) continue;
      fragment.append(el('div', 'ind-section-title', section.label), this.catalog(tools));
    }
    const instances = this.handlers.instances();
    const section = el('div', 'ind-section');
    section.append(el('div', 'ind-section-title', 'On the chart'));
    if (instances.length === 0) section.append(el('div', 'dialog-note', 'Nothing placed yet — pick a tool and drag on the chart.'));
    for (const instance of instances) section.append(this.instanceRow(instance));
    fragment.append(section);
    this.body.replaceChildren(fragment);
    this.hint.textContent =
      'Draw as many as you want · press and drag to size a shape, Shift to square or snap to 45° · click to select, drag to move · Delete removes it · Esc closes';
  }

  private catalog(tools: readonly DrawingToolDefinition[]): HTMLElement {
    const grid = el('div', 'ind-grid');
    for (const definition of tools) {
      const button = el('button', 'ind-item');
      button.type = 'button';
      button.append(
        el('span', 'ind-item-name', `${definition.glyph} ${definition.label}`),
        el('span', 'ind-item-label', definition.hint),
      );
      button.addEventListener('click', () => {
        this.handlers.onPickTool(definition.id);
        this.close();
      });
      grid.append(button);
    }
    return grid;
  }

  private instanceRow(instance: DrawingInstance): HTMLElement {
    const definition = this.handlers.definitionOf(instance);
    const row = el('div', 'ind-row');
    const main = el('div', 'ind-row-main');
    main.append(
      el('span', 'ind-row-name', definition?.label ?? instance.toolId),
      el('span', 'ind-row-meta', this.handlers.summary(instance)),
    );
    const settings = el('button', 'dialog-watch', 'style');
    settings.type = 'button';
    settings.addEventListener('click', (event) => {
      event.stopPropagation();
      this.settingsFor = instance.id;
      this.handlers.onSelect(instance.id);
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
      this.handlers.onSelect(instance.id);
      this.render();
    });
    return row;
  }

  private renderSettings(instance: DrawingInstance, definition: DrawingToolDefinition): void {
    this.title.textContent = definition.label;
    const fragment = document.createDocumentFragment();
    const keys = definition.quickBar;
    if (keys && keys.length > 0) {
      const strip = el('div', 'drw-quick-block');
      strip.append(el('div', 'ind-section-title', 'Quick bar'), quickBar(keys, instance.style, (patch) => this.patch(instance.id, patch)));
      fragment.append(strip);
    }
    fragment.append(styleForm(definition.styleKeys, instance.style, (patch) => this.patch(instance.id, patch)));
    const actions = el('div', 'ind-actions');
    const back = el('button', 'dialog-watch', '‹ all drawings');
    back.type = 'button';
    back.addEventListener('click', () => {
      this.settingsFor = null;
      this.render();
    });
    const remove = el('button', 'dialog-watch', 'remove this drawing');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      this.handlers.onRemove(instance.id);
      this.settingsFor = null;
      this.render();
    });
    actions.append(back, remove);
    fragment.append(actions);
    this.body.replaceChildren(fragment);
    this.hint.textContent = 'Changes apply as you type · every drawing is independent';
  }

  /** Re-reads the instance after each patch so sliders keep working while typing. */
  private patch(instanceId: string, values: StyleValues): void {
    this.handlers.onStyle(instanceId, values);
    const instance = this.handlers.instances().find((entry) => entry.id === instanceId);
    if (!instance) {
      this.settingsFor = null;
      this.render();
    }
  }
}
