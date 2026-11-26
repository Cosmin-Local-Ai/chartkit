import { el } from './canvasKit';
import {
  DEFAULT_TPO_SETTINGS,
  TPO_BLOCK_SHAPES,
  TPO_GRADING,
  TPO_LETTER_MODES,
  TPO_PERIOD_UNITS,
  TPO_TABS,
  TPO_VALUE_AREA_METHODS,
  bucketMinutes,
  gridProblem,
  type TpoSettings,
  type TpoTab,
} from './tpoSettings';

/**
 * TPO / market-profile settings dialog. Four tabs, in the order the shipped product's own
 * `tpoSettingsTabs` file groups them: general, profile, volume, color. Only fields the pane
 * draws are offered; the shipped dialog carries ninety-one, and a control that changes
 * nothing on screen is a control that lies.
 */

export interface TpoDialogHandlers {
  /** Live settings object the controls read from. */
  settings: () => TpoSettings;
  /** Merges a patch; the pane redraws and the workspace persists immediately. */
  onPatch: (patch: Partial<TpoSettings>) => void;
}

type FieldKey = keyof TpoSettings;

type Field =
  | { kind: 'toggle'; field: FieldKey; label: string; hint?: string }
  | { kind: 'number'; field: FieldKey; label: string; min?: number; max?: number; step?: number }
  | { kind: 'select'; field: FieldKey; label: string; options: { value: string; label: string }[] }
  | { kind: 'colour'; field: FieldKey; label: string }
  | { kind: 'custom'; label: string; render: (dialog: TpoSettingsDialog) => HTMLElement };

interface Section {
  title: string;
  fields: Field[];
}

const TAB_LABELS: Record<TpoTab, string> = {
  general: 'General',
  profile: 'Profile',
  volume: 'Volume',
  color: 'Color',
};

const LETTER_MODE_LABELS: Record<string, string> = {
  'letters-only': 'Letters only',
  'blocks-only': 'Blocks only',
  both: 'Letters and blocks',
};

const SHAPE_LABELS: Record<string, string> = {
  square: 'Square',
  wide: 'Wide',
  outline: 'Outline',
};

const GRADING_LABELS: Record<string, string> = {
  volume: 'Volume',
  delta: 'Delta',
  total: 'Print count',
};

const METHOD_LABELS: Record<string, string> = {
  volume: 'From traded volume',
  tpo: 'From letters in the grid',
};

/** The dialog's tabs, built from the shipped field-to-tab routing table. */
function sections(tab: TpoTab): Section[] {
  if (tab === 'general') {
    return [
      {
        title: 'Grid',
        fields: [
          { kind: 'custom', label: 'Time bucket', render: (dialog) => dialog.periodBlock() },
          { kind: 'number', field: 'sessionStartMinute', label: 'Session start, minutes past UTC midnight', min: 0, max: 1_439, step: 1 },
          { kind: 'number', field: 'sessionLengthMinutes', label: 'Session length, minutes', min: 2, max: 10_080, step: 1 },
        ],
      },
      {
        title: 'Cells',
        fields: [
          {
            kind: 'select',
            field: 'letterMode',
            label: 'Show',
            options: TPO_LETTER_MODES.map((mode) => ({ value: mode, label: LETTER_MODE_LABELS[mode] ?? mode })),
          },
          {
            kind: 'select',
            field: 'blockShape',
            label: 'Block shape',
            options: TPO_BLOCK_SHAPES.map((shape) => ({ value: shape, label: SHAPE_LABELS[shape] ?? shape })),
          },
          { kind: 'number', field: 'profileSpacing', label: 'Price row height, px', min: 2, max: 24, step: 1 },
          { kind: 'toggle', field: 'showTradingHourLabel', label: 'Clock under each bucket' },
        ],
      },
    ];
  }
  if (tab === 'profile') {
    return [
      {
        title: 'Value area',
        fields: [
          { kind: 'number', field: 'valueAreaPercentage', label: 'Value area, fraction', min: 0.05, max: 1, step: 0.05 },
          {
            kind: 'select',
            field: 'valueAreaMethod',
            label: 'Value area method',
            options: TPO_VALUE_AREA_METHODS.map((method) => ({ value: method, label: METHOD_LABELS[method] ?? method })),
          },
          { kind: 'toggle', field: 'showValueArea', label: 'Shade the value area' },
        ],
      },
      {
        title: 'Levels',
        fields: [
          { kind: 'toggle', field: 'showPOC', label: 'Point of control' },
          { kind: 'toggle', field: 'showVAH', label: 'Value area high' },
          { kind: 'toggle', field: 'showVAL', label: 'Value area low' },
          { kind: 'toggle', field: 'showMidpoint', label: 'Value area midpoint' },
          { kind: 'number', field: 'pocThickness', label: 'POC thickness, px', min: 1, max: 6, step: 1 },
          { kind: 'toggle', field: 'showLevelLabels', label: 'Name each level' },
          { kind: 'toggle', field: 'levelLineExtend', label: 'Run levels to the price axis' },
        ],
      },
    ];
  }
  if (tab === 'volume') {
    return [
      {
        title: 'Grading',
        fields: [
          {
            kind: 'select',
            field: 'cellGrading',
            label: 'Grade cells by',
            options: TPO_GRADING.map((mode) => ({ value: mode, label: GRADING_LABELS[mode] ?? mode })),
          },
          { kind: 'toggle', field: 'showHoverInspector', label: 'Cell readout under the cursor' },
        ],
      },
    ];
  }
  return [
    {
      title: 'Cells',
      fields: [
        { kind: 'toggle', field: 'tpoColorEachSession', label: 'One colour per session' },
        { kind: 'custom', label: 'Block shades', render: (dialog) => dialog.fourColours('customTPOColors', ['faint', 'light', 'strong', 'heaviest']) },
        { kind: 'custom', label: 'Session colours', render: (dialog) => dialog.fourColours('tpoSessionColors', ['first', 'second', 'third', 'fourth']) },
        { kind: 'toggle', field: 'showOutsideVAColors', label: 'Colour cells outside the value area' },
        { kind: 'colour', field: 'outsideVAColor', label: 'Outside value area' },
        { kind: 'number', field: 'outsideVAOpacity', label: 'Outside opacity', min: 0.05, max: 1, step: 0.05 },
      ],
    },
    {
      title: 'Levels',
      fields: [
        { kind: 'colour', field: 'pocColor', label: 'POC' },
        { kind: 'colour', field: 'vahColor', label: 'VAH' },
        { kind: 'colour', field: 'valColor', label: 'VAL' },
        { kind: 'colour', field: 'midpointColor', label: 'Midpoint' },
        { kind: 'colour', field: 'developingPOCColor', label: 'Developing POC' },
        { kind: 'colour', field: 'developingVAColor', label: 'Developing value area' },
        { kind: 'colour', field: 'valueAreaFillColor', label: 'Value area fill' },
        { kind: 'number', field: 'valueAreaFillOpacity', label: 'Fill opacity', min: 0, max: 0.5, step: 0.01 },
      ],
    },
  ];
}

export class TpoSettingsDialog {
  private readonly backdrop: HTMLElement;
  private readonly panel = el('div', 'dialog');
  private readonly title = el('span', 'dialog-title', 'TPO settings');
  private readonly tabs = el('div', 'fp-tabs');
  private readonly body = el('div', 'ind-body');
  private readonly hint = el('div', 'dialog-hint');
  private tab: TpoTab = 'general';
  private open = false;
  private readonly tabButtons = new Map<TpoTab, HTMLButtonElement>();

  constructor(private readonly handlers: TpoDialogHandlers) {
    this.backdrop = el('div', 'dialog-backdrop');
    this.backdrop.hidden = true;
    const head = el('div', 'dialog-head');
    const close = el('button', 'dialog-close', '×');
    close.type = 'button';
    close.title = 'Close';
    close.addEventListener('click', () => this.close());
    head.append(this.title, close);

    for (const id of TPO_TABS) {
      const button = el('button', 'fp-tab', TAB_LABELS[id]);
      button.type = 'button';
      button.addEventListener('click', () => {
        this.tab = id;
        this.render();
      });
      this.tabButtons.set(id, button);
      this.tabs.append(button);
    }

    this.panel.append(head, this.tabs, this.body, this.hint);
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
    this.tabButtons.get(this.tab)?.focus();
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

  /** Opens one tab, used by the pane's own entry point. */
  showTab(tab: TpoTab): void {
    this.tab = tab;
    if (!this.open) this.show();
    else this.render();
  }

  /** Patches a single field; the pane redraws immediately. */
  patch(patch: Partial<TpoSettings>): void {
    this.handlers.onPatch(patch);
  }

  private render(): void {
    for (const [id, button] of this.tabButtons) button.classList.toggle('is-on', id === this.tab);
    const fragment = document.createDocumentFragment();
    for (const section of sections(this.tab)) {
      fragment.append(el('div', 'ind-section-title', section.title));
      const form = el('div', 'ind-form');
      for (const field of section.fields) {
        if (field.kind === 'custom') {
          const wrap = el('label', 'ind-field');
          wrap.append(el('span', 'ind-field-label', field.label), field.render(this));
          form.append(wrap);
          continue;
        }
        form.append(this.control(field));
      }
      fragment.append(form);
    }
    this.body.replaceChildren(fragment);
    const problem = gridProblem(this.handlers.settings());
    const grid = `${bucketMinutes(this.handlers.settings())} minute buckets, ${this.handlers.settings().sessionLengthMinutes} minute sessions`;
    this.hint.textContent = problem ? `Grid not applied: ${problem}` : `${grid} · changes apply as you type · Esc closes`;
  }

  private control(field: Exclude<Field, { kind: 'custom' }>): HTMLElement {
    const settings = this.handlers.settings();
    const wrap = el('label', 'ind-field');
    wrap.append(el('span', 'ind-field-label', field.label));
    wrap.title = String(field.field);

    if (field.kind === 'toggle') {
      const input = el('input', 'ind-check');
      input.type = 'checkbox';
      input.checked = settings[field.field] === true;
      input.addEventListener('change', () => this.patch({ [field.field]: input.checked } as Partial<TpoSettings>));
      wrap.append(input);
      return wrap;
    }

    if (field.kind === 'select') {
      const select = el('select', 'dialog-select');
      for (const option of field.options) {
        const node = el('option', undefined, option.label);
        node.value = option.value;
        select.append(node);
      }
      select.value = String(settings[field.field] ?? '');
      select.addEventListener('change', () => {
        const value = /^\d+$/.test(select.value) ? Number(select.value) : select.value;
        this.patch({ [field.field]: value } as Partial<TpoSettings>);
        this.render();
      });
      wrap.append(select);
      return wrap;
    }

    if (field.kind === 'colour') return this.colourControl(field.field, field.label);

    const input = el('input', 'dialog-input');
    input.type = 'number';
    if (field.min !== undefined) input.min = String(field.min);
    if (field.max !== undefined) input.max = String(field.max);
    if (field.step !== undefined) input.step = String(field.step);
    const value = settings[field.field];
    input.value = String(typeof value === 'number' ? value : '');
    input.addEventListener('input', () => {
      const next = Number(input.value);
      if (!Number.isFinite(next)) return;
      this.patch({ [field.field]: next } as Partial<TpoSettings>);
      if (field.field === 'sessionLengthMinutes' || field.field === 'sessionStartMinute') this.render();
    });
    wrap.append(input);
    return wrap;
  }

  /** Colour control for one named field. */
  colourControl(field: FieldKey, label: string): HTMLElement {
    const row = el('div', 'ind-swatch');
    const input = el('input');
    input.type = 'color';
    const value = this.handlers.settings()[field];
    input.value = typeof value === 'string' ? value : '#000000';
    input.setAttribute('aria-label', label);
    input.title = String(field);
    input.addEventListener('input', () => this.patch({ [field]: input.value } as Partial<TpoSettings>));
    row.append(input, el('span', 'ind-swatch-label', input.value));
    return row;
  }

  /** Four colour slots of one ramp, each writing back only its own slot. */
  fourColours(field: 'customTPOColors' | 'tpoSessionColors', labels: readonly string[]): HTMLElement {
    const row = el('div', 'fp-columns');
    labels.forEach((name, slot) => {
      const swatch = el('div', 'ind-swatch');
      const input = el('input');
      input.type = 'color';
      input.value = this.handlers.settings()[field][slot] ?? '#000000';
      input.setAttribute('aria-label', `${field} ${name}`);
      input.title = `${field}.${slot}`;
      input.addEventListener('input', () => {
        const colours = [...this.handlers.settings()[field]];
        colours[slot] = input.value;
        this.patch({
          [field]: [
            colours[0] ?? DEFAULT_TPO_SETTINGS[field][0],
            colours[1] ?? DEFAULT_TPO_SETTINGS[field][1],
            colours[2] ?? DEFAULT_TPO_SETTINGS[field][2],
            colours[3] ?? DEFAULT_TPO_SETTINGS[field][3],
          ],
        } as Partial<TpoSettings>);
      });
      swatch.append(input, el('span', 'ind-swatch-label', name));
      row.append(swatch);
    });
    return row;
  }

  /** Bucket count and unit, which have to be written together or the grid can drift apart. */
  periodBlock(): HTMLElement {
    const settings = this.handlers.settings();
    const row = el('div', 'fp-columns');
    const count = el('input', 'dialog-input');
    count.type = 'number';
    count.min = '1';
    count.max = '480';
    count.value = String(settings.periodLength.count);
    count.title = 'periodLength.count';
    const unit = el('select', 'dialog-select');
    for (const option of TPO_PERIOD_UNITS) {
      const node = el('option', undefined, option === 'minute' ? 'minutes' : 'hours');
      node.value = option;
      unit.append(node);
    }
    unit.value = settings.periodLength.unit;
    unit.title = 'periodLength.unit';
    const write = () => this.patch({ periodLength: { count: Number(count.value) || 1, unit: unit.value as TpoSettings['periodLength']['unit'] } });
    count.addEventListener('input', write);
    unit.addEventListener('change', () => {
      write();
      this.render();
    });
    row.append(count, unit);
    return row;
  }
}
