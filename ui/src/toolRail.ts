import { el } from './canvasKit';
import { DRAWING_TOOLS, TOOL_SECTIONS, toolById } from './drawings/registry';

export interface ToolRailHandlers {
  /** Arming a tool places it on the next drag; picking the armed tool again disarms it. */
  onPick: (toolId: string) => void;
  onManage: () => void;
}

/**
 * Tool palette: the placed-drawing manager plus every tool, grouped by the shipped
 * toolbar section keys. Nothing counts or caps anything: the list of placed drawings
 * simply grows.
 */
export class ToolRail {
  private readonly root = el('div', 'tool-rail');
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly manageButton = el('button', 'drw-manage', 'Drawings');

  constructor(handlers: ToolRailHandlers) {
    this.manageButton.type = 'button';
    this.manageButton.title = 'Manage placed drawings and their styles';
    this.manageButton.addEventListener('click', () => handlers.onManage());
    this.root.append(this.manageButton);

    for (const section of TOOL_SECTIONS) {
      const tools = DRAWING_TOOLS.filter((definition) => definition.sectionKey === section.key);
      if (tools.length === 0) continue;
      const block = el('div', 'drw-section');
      // The palette keeps growing, so each section folds away to keep the rail usable.
      const header = el('button', 'drw-section-title');
      header.type = 'button';
      header.title = `Show or hide ${section.label}`;
      header.setAttribute('aria-expanded', 'true');
      header.append(el('span', 'drw-section-caret', '▾'), el('span', 'drw-section-name', section.label));
      header.addEventListener('click', () => {
        const collapsed = block.classList.toggle('is-collapsed');
        header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      });
      block.append(header);
      for (const definition of tools) {
        const button = el('button', 'drw-tool');
        button.type = 'button';
        button.title = `${definition.label} · ${definition.hint}`;
        button.append(el('span', 'drw-tool-glyph', definition.glyph), el('span', 'drw-tool-name', definition.label));
        button.addEventListener('click', () => handlers.onPick(definition.id));
        this.buttons.set(definition.id, button);
        block.append(button);
      }
      this.root.append(block);
    }
    this.root.append(el('div', 'drw-rail-hint', 'Drag on the chart to place'));
  }

  get node(): HTMLElement {
    return this.root;
  }

  setActive(toolId: string | null): void {
    for (const [id, button] of this.buttons) button.classList.toggle('is-on', id === toolId);
    this.manageButton.classList.toggle('is-on', toolId !== null);
    const armed = toolId ? toolById(toolId) : null;
    this.root.dataset.armed = armed ? armed.id : '';
  }
}
