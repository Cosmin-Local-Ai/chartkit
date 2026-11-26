/**
 * Right-click menu. One DOM overlay covers both cases: over a placed drawing it shows that
 * drawing's actions plus a compact style strip built from the same field renderer the
 * dialogs use; over empty tape it shows chart actions and tool picking. It is a plain
 * element like every other surface here, so Esc, the outside click and the existing dialog
 * styling all keep working.
 */

import { el } from './canvasKit';
import type { DrawingInstance } from './drawings/engine';
import { DRAWING_TOOLS, toolById, type DrawingToolDefinition } from './drawings/registry';
import { quickBar, stripKeysFor } from './drawings/styleFields';
import type { StyleValues } from './drawings/style';

/** How many tools the empty-tape menu offers before falling back to the full palette. */
export const TOOL_CHOICES = 6;

export type ChartAction = 'fit' | 'recent' | 'autoScale';

export interface DrawingMenuHandlers {
  instanceOf: (instanceId: string) => DrawingInstance | null;
  definitionOf: (instance: DrawingInstance | null) => DrawingToolDefinition | null;
  /** Style patches land live, exactly as the dialog's quick bar applies them. */
  onStyle: (instanceId: string, patch: StyleValues) => void;
  onDuplicate: (instanceId: string) => void;
  onReorder: (instanceId: string, where: 'front' | 'back') => void;
  onLock: (instanceId: string, locked: boolean) => void;
  onDelete: (instanceId: string) => void;
  onSettings: (instanceId: string) => void;
  onChartAction: (action: ChartAction) => void;
  onPickTool: (toolId: string) => void;
  onMoreTools: () => void;
  /** Tool ids to offer for picking, most recently armed first. */
  recentTools: () => readonly string[];
  armedTool: () => string | null;
}

export class DrawingMenu {
  private readonly root = el('div', 'ctx-menu');
  private open = false;
  private instanceId: string | null = null;

  constructor(private readonly handlers: DrawingMenuHandlers) {
    this.root.hidden = true;
    this.root.setAttribute('role', 'menu');
    document.body.append(this.root);
    // Any press elsewhere dismisses it, the way the dialog backdrops do.
    window.addEventListener(
      'pointerdown',
      (event) => {
        if (this.open && !this.owns(event.target)) this.close();
      },
      true,
    );
    // A wheel or a keyboard shortcut moves the chart under the menu, so the menu would end
    // up naming the wrong spot; scrolling inside the menu itself is fine. Esc is left to the
    // app's own Escape handling, which closes every surface the same way.
    window.addEventListener(
      'wheel',
      (event) => {
        if (this.open && !this.owns(event.target)) this.close();
      },
      { capture: true, passive: true },
    );
    window.addEventListener(
      'keydown',
      (event) => {
        if (this.open && event.key !== 'Escape' && !this.owns(event.target)) this.close();
      },
      true,
    );
  }

  /** Opens at viewport coordinates; the menu pulls itself back inside the window. */
  openAt(clientX: number, clientY: number, instanceId: string | null): void {
    this.instanceId = instanceId;
    this.render();
    this.root.hidden = false;
    this.open = true;
    const margin = 8;
    const left = Math.max(margin, Math.min(clientX, window.innerWidth - this.root.offsetWidth - margin));
    const top = Math.max(margin, Math.min(clientY, window.innerHeight - this.root.offsetHeight - margin));
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
  }

  close(): void {
    if (!this.open && this.root.hidden) return;
    this.open = false;
    this.instanceId = null;
    this.root.hidden = true;
  }

  isOpen(): boolean {
    return this.open;
  }

  /** The drawing the menu is acting on, or null while the chart-level menu is open. */
  targetId(): string | null {
    return this.open ? this.instanceId : null;
  }

  /** Re-renders in place after a change made elsewhere, such as an undo, so the style strip
   *  agrees with the drawing it is styling. */
  refresh(): void {
    if (this.open) this.render();
  }

  private owns(target: EventTarget | null): boolean {
    return target instanceof Node && this.root.contains(target);
  }

  private render(): void {
    const instance = this.instanceId ? this.handlers.instanceOf(this.instanceId) : null;
    const definition = this.handlers.definitionOf(instance);
    if (!instance || !definition) this.renderChart();
    else this.renderDrawing(instance, definition);
  }

  private renderDrawing(instance: DrawingInstance, definition: DrawingToolDefinition): void {
    const head = el('div', 'ctx-head');
    head.append(el('span', 'ctx-title', definition.label));
    if (instance.locked === true) head.append(el('span', 'ctx-tag', 'locked'));
    const fragment = document.createDocumentFragment();
    fragment.append(head);

    const keys = stripKeysFor(definition.quickBar, definition.styleKeys);
    if (keys.length > 0) {
      const strip = el('div', 'ctx-strip');
      strip.append(el('div', 'ctx-section', 'Style'), quickBar(keys, instance.style, (patch) => this.handlers.onStyle(instance.id, patch)));
      fragment.append(strip, el('div', 'ctx-sep'));
    }

    fragment.append(this.row('Style…', () => this.act(() => this.handlers.onSettings(instance.id))));
    fragment.append(this.row('Duplicate', () => this.act(() => this.handlers.onDuplicate(instance.id))));
    fragment.append(this.row('Bring to front', () => this.handlers.onReorder(instance.id, 'front')));
    fragment.append(this.row('Send to back', () => this.handlers.onReorder(instance.id, 'back')));
    const locked = instance.locked === true;
    fragment.append(
      this.row(locked ? 'Unlock' : 'Lock', () => {
        this.handlers.onLock(instance.id, !locked);
        this.render();
      }),
    );
    fragment.append(this.row('Delete', () => this.act(() => this.handlers.onDelete(instance.id)), { className: 'is-danger' }));
    this.root.replaceChildren(fragment);
  }

  private renderChart(): void {
    const head = el('div', 'ctx-head');
    head.append(el('span', 'ctx-title', 'Chart'));
    const fragment = document.createDocumentFragment();
    fragment.append(head);
    fragment.append(this.row('Fit all bars', () => this.act(() => this.handlers.onChartAction('fit'))));
    fragment.append(this.row('Jump to newest bar', () => this.act(() => this.handlers.onChartAction('recent'))));
    fragment.append(this.row('Auto scale price axis', () => this.act(() => this.handlers.onChartAction('autoScale'))));
    fragment.append(el('div', 'ctx-sep'), el('div', 'ctx-section', 'Draw'));

    for (const id of this.toolChoices()) {
      const definition = toolById(id);
      if (!definition) continue;
      fragment.append(
        this.row(definition.label, () => this.act(() => this.handlers.onPickTool(id)), {
          glyph: definition.glyph,
          className: definition.id === this.handlers.armedTool() ? 'is-on' : undefined,
        }),
      );
    }
    fragment.append(this.row('All drawing tools…', () => this.act(() => this.handlers.onMoreTools())));
    this.root.replaceChildren(fragment);
  }

  /** Recently armed tools first, topped up from the palette so the menu always offers some. */
  private toolChoices(): string[] {
    const out: string[] = [];
    for (const id of this.handlers.recentTools()) {
      if (out.length >= TOOL_CHOICES) break;
      if (toolById(id) && !out.includes(id)) out.push(id);
    }
    for (const definition of DRAWING_TOOLS) {
      if (out.length >= TOOL_CHOICES) break;
      if (!out.includes(definition.id)) out.push(definition.id);
    }
    return out;
  }

  /** Runs an action that ends the gesture, closing the menu with it. */
  private act(action: () => void): void {
    action();
    this.close();
  }

  /** `glyph` is the palette glyph of a tool row; action rows keep the spacer to align. */
  private row(label: string, onClick: () => void, options: { glyph?: string; className?: string } = {}): HTMLElement {
    const button = el('button', `ctx-item${options.className ? ` ${options.className}` : ''}`);
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.append(el('span', 'ctx-glyph', options.glyph ?? ''), el('span', 'ctx-item-name', label));
    button.addEventListener('click', onClick);
    return button;
  }
}
