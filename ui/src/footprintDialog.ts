import { el } from './canvasKit';
import {
  CELL_METRICS,
  CLUSTER_CELL_METRICS,
  COLUMN_PRESETS,
  DISPLAY_MODES,
  FOOTPRINT_TABS,
  SECONDARY_CELL_METRICS,
  STATS_ROW_METRICS,
  presetFor,
  type CellMetric,
  type FootprintSettings,
  type FootprintTab,
  type StatsRowMetric,
} from './footprintSettings';

export interface FootprintDialogHandlers {
  /** Live settings object the controls read from. */
  settings: () => FootprintSettings;
  /** Merges a patch; the pane redraws and the workspace persists immediately. */
  onPatch: (patch: Partial<FootprintSettings>) => void;
}

type FieldKey = keyof FootprintSettings;

type Field =
  | { kind: 'toggle'; field: FieldKey; label: string; hint?: string }
  | { kind: 'number'; field: FieldKey; label: string; min?: number; max?: number; step?: number }
  | { kind: 'select'; field: FieldKey; label: string; options: { value: string; label: string }[] }
  | { kind: 'custom'; label: string; render: (dialog: FootprintSettingsDialog) => HTMLElement };

interface Section {
  title: string;
  fields: Field[];
}

const TAB_LABELS: Record<FootprintTab, string> = {
  general: 'General',
  profile: 'Profile',
  imbalance: 'Imbalance',
  filters: 'Filters',
  color: 'Color',
  advanced: 'Advanced',
};

const MODE_LABELS: Record<string, string> = {
  columns: 'Columns',
  'stacked-bar': 'Stacked bar',
  'stacked-bar-delta': 'Stacked delta',
  'split-bar': 'Split bar',
  cluster: 'Cluster',
  'imbalance-only': 'Imbalance only',
  ladder: 'Ladder',
};

const METRIC_LABELS: Record<string, string> = {
  bidAsk: 'Bid / ask',
  delta: 'Delta',
  deltaColored: 'Delta (colored)',
  diagonalDelta: 'Diagonal delta',
  deltaPct: 'Delta %',
  volume: 'Volume',
  buy: 'Buy',
  sell: 'Sell',
  volumeBar: 'Volume bar',
  deltaBar: 'Delta bar',
  volumeBarLeading: 'Volume bar leading',
  splitBar: 'Split bar',
};

const GRADING_HINTS: Record<string, string> = {
  candle: 'each bar on its own scale',
  session: 'all bars of the same day share a scale',
  visible: 'every bar in the fetched window shares a scale',
};

/** The dialog's tabs, built from the shipped field-to-tab routing table. */
function sections(tab: FootprintTab): Section[] {
  if (tab === 'general') {
    return [
      {
        title: 'Display',
        fields: [
          {
            kind: 'select',
            field: 'displayMode',
            label: 'Display mode',
            options: DISPLAY_MODES.map((mode) => ({ value: mode, label: MODE_LABELS[mode] ?? mode })),
          },
          { kind: 'number', field: 'barWidth', label: 'Bar width', min: 0.05, max: 1, step: 0.05 },
          {
            kind: 'select',
            field: 'clusterCellMetric',
            label: 'Cluster cell metric',
            options: CLUSTER_CELL_METRICS.map((value) => ({ value, label: value })),
          },
          {
            kind: 'select',
            field: 'secondaryCellMetric',
            label: 'Secondary cell metric',
            options: SECONDARY_CELL_METRICS.map((value) => ({ value, label: value === 'off' ? 'Off' : (METRIC_LABELS[value] ?? value) })),
          },
          { kind: 'custom', label: '', render: (dialog) => dialog.columnsBlock() },
        ],
      },
    ];
  }
  if (tab === 'profile') {
    return [
      {
        title: 'Levels',
        fields: [
          { kind: 'toggle', field: 'showPOC', label: 'Show POC' },
          { kind: 'number', field: 'pocThickness', label: 'POC thickness', min: 1, max: 6, step: 1 },
          { kind: 'toggle', field: 'showPOCOutline', label: 'POC outline' },
          { kind: 'toggle', field: 'showVAH', label: 'Show VAH' },
          { kind: 'toggle', field: 'showVAL', label: 'Show VAL' },
          { kind: 'toggle', field: 'showValueArea', label: 'Show value area' },
          { kind: 'number', field: 'valueArea', label: 'Value area %', min: 0.05, max: 1, step: 0.05 },
          { kind: 'toggle', field: 'showValueAreaBand', label: 'Value area band' },
        ],
      },
      {
        title: 'Naked levels',
        fields: [
          { kind: 'toggle', field: 'showPOCNaked', label: 'Naked POC' },
          { kind: 'toggle', field: 'showVAHNaked', label: 'Naked VAH' },
          { kind: 'toggle', field: 'showVALNaked', label: 'Naked VAL' },
          { kind: 'toggle', field: 'showPOCNakedPrice', label: 'Naked POC price' },
          { kind: 'toggle', field: 'showVAHNakedPrice', label: 'Naked VAH price' },
          { kind: 'toggle', field: 'showVALNakedPrice', label: 'Naked VAL price' },
          { kind: 'number', field: 'maxNakedLevels', label: 'Max naked levels', min: 0, max: 64, step: 1 },
        ],
      },
      {
        title: 'Unfinished auction',
        fields: [
          { kind: 'toggle', field: 'showUnfinishedAuction', label: 'Unfinished auctions' },
          { kind: 'custom', label: 'Color', render: (dialog) => dialog.colorControl('unfinishedAuctionColor', 'Color') },
        ],
      },
      {
        title: 'Stats rows',
        fields: [
          { kind: 'custom', label: '', render: (dialog) => dialog.statsBlock() },
          {
            kind: 'select',
            field: 'statsRowsPosition',
            label: 'Stats position',
            options: [
              { value: 'above', label: 'Above' },
              { value: 'below', label: 'Below' },
            ],
          },
          { kind: 'toggle', field: 'statsRowsLabels', label: 'Show labels' },
        ],
      },
    ];
  }
  if (tab === 'imbalance') {
    return [
      {
        title: 'Detection',
        fields: [
          { kind: 'toggle', field: 'imbalance', label: 'Imbalances' },
          { kind: 'number', field: 'imbalanceRatio', label: 'Ratio', min: 1, max: 20, step: 0.5 },
          {
            kind: 'select',
            field: 'imbalanceMethod',
            label: 'Method',
            options: [
              { value: 'diagonal', label: 'Diagonal' },
              { value: 'horizontal', label: 'Horizontal' },
            ],
          },
          { kind: 'number', field: 'imbalanceMinVolume', label: 'Min volume', min: 0, step: 1 },
          { kind: 'number', field: 'stackedImbalances', label: 'Stacked imbalances', min: 1, max: 8, step: 1 },
          { kind: 'toggle', field: 'skipZeroValues', label: 'Skip zero values' },
          { kind: 'toggle', field: 'colorImbalanceText', label: 'Color imbalance text' },
          { kind: 'toggle', field: 'showImbalanceNaked', label: 'Show naked imbalances' },
        ],
      },
    ];
  }
  if (tab === 'filters') {
    return [
      {
        title: 'Filters',
        fields: [{ kind: 'number', field: 'threshold', label: 'Threshold', min: 0, step: 1 }],
      },
    ];
  }
  if (tab === 'color') {
    return [
      {
        title: 'Shading',
        fields: [
          {
            kind: 'select',
            field: 'cellShading',
            label: 'Cell shading',
            options: [
              { value: 'smooth', label: 'Smooth' },
              { value: 'steps', label: 'Steps' },
            ],
          },
          { kind: 'number', field: 'shadingSteps', label: 'Shading steps', min: 2, max: 8, step: 1 },
          { kind: 'toggle', field: 'useGradient', label: 'Use gradient' },
        ],
      },
      {
        title: 'Cells',
        fields: [
          { kind: 'custom', label: 'Buy color', render: (dialog) => dialog.pairColorControl(0, 'Buy color') },
          { kind: 'custom', label: 'Sell color', render: (dialog) => dialog.pairColorControl(1, 'Sell color') },
          { kind: 'custom', label: 'Cell text', render: (dialog) => dialog.colorControl('cellTextColor', 'Cell text') },
          { kind: 'custom', label: 'Volume', render: (dialog) => dialog.colorControl('volumeColor', 'Volume') },
          { kind: 'custom', label: 'Imbalance buy', render: (dialog) => dialog.colorControl('imbalanceBuyColor', 'Imbalance buy') },
          { kind: 'custom', label: 'Imbalance sell', render: (dialog) => dialog.colorControl('imbalanceSellColor', 'Imbalance sell') },
        ],
      },
      {
        title: 'Levels',
        fields: [
          { kind: 'custom', label: 'POC', render: (dialog) => dialog.colorControl('pocColor', 'POC') },
          { kind: 'custom', label: 'VAH', render: (dialog) => dialog.colorControl('vahColor', 'VAH') },
          { kind: 'custom', label: 'VAL', render: (dialog) => dialog.colorControl('valColor', 'VAL') },
        ],
      },
    ];
  }
  return [
    {
      title: 'Text',
      fields: [
        {
          kind: 'select',
          field: 'cellFontSize',
          label: 'Cell font size',
          options: [{ value: 'auto', label: 'Auto' }, ...[9, 10, 11, 12, 14, 16, 18, 20].map((n) => ({ value: String(n), label: `${n} px` }))],
        },
        {
          kind: 'select',
          field: 'volumeDecimals',
          label: 'Volume decimals',
          options: [{ value: 'auto', label: 'Auto' }, ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: String(n), label: String(n) }))],
        },
        { kind: 'toggle', field: 'fullNumbers', label: 'Full numbers' },
        { kind: 'toggle', field: 'trimZeroTails', label: 'Trim zero tails' },
        { kind: 'toggle', field: 'hideZeroText', label: 'Hide zero text' },
      ],
    },
    {
      title: 'Scaling',
      fields: [
        {
          kind: 'select',
          field: 'scaleAndGrading',
          label: 'Scale and grading',
          options: (['candle', 'session', 'visible'] as const).map((value) => ({
            value,
            label: `${value} — ${GRADING_HINTS[value] ?? ''}`,
          })),
        },
        { kind: 'toggle', field: 'dynamicCandleWidth', label: 'Dynamic row height' },
        { kind: 'number', field: 'barHeightMultiplier', label: 'Row height multiplier', min: 0.5, max: 4, step: 0.1 },
      ],
    },
  ];
}

/**
 * Footprint settings dialog: the shipped six tabs over the fields this chart can
 * actually draw. Changes apply as they are made and are written to the workspace.
 */
export class FootprintSettingsDialog {
  private readonly backdrop: HTMLElement;
  private readonly panel = el('div', 'dialog');
  private readonly title = el('span', 'dialog-title', 'Footprint settings');
  private readonly tabs = el('div', 'fp-tabs');
  private readonly body = el('div', 'ind-body');
  private readonly hint = el('div', 'dialog-hint');
  private tab: FootprintTab = 'general';
  private open = false;
  private readonly tabButtons = new Map<FootprintTab, HTMLButtonElement>();

  constructor(private readonly handlers: FootprintDialogHandlers) {
    this.backdrop = el('div', 'dialog-backdrop');
    this.backdrop.hidden = true;
    const head = el('div', 'dialog-head');
    const close = el('button', 'dialog-close', '×');
    close.type = 'button';
    close.title = 'Close';
    close.addEventListener('click', () => this.close());
    head.append(this.title, close);

    for (const id of FOOTPRINT_TABS) {
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
  showTab(tab: FootprintTab): void {
    this.tab = tab;
    if (!this.open) this.show();
    else this.render();
  }

  /** Patches a single field; the pane redraws immediately. */
  patch(patch: Partial<FootprintSettings>): void {
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
          if (field.label) {
            const wrap = el('label', 'ind-field');
            wrap.append(el('span', 'ind-field-label', field.label), field.render(this));
            form.append(wrap);
          } else {
            form.append(field.render(this));
          }
          continue;
        }
        form.append(this.control(field));
      }
      fragment.append(form);
    }
    this.body.replaceChildren(fragment);
    this.hint.textContent = 'Changes apply as you type · Esc closes';
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
      input.addEventListener('change', () => this.patch({ [field.field]: input.checked } as Partial<FootprintSettings>));
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
      const current = settings[field.field];
      select.value = current === 'auto' ? 'auto' : String(current ?? '');
      select.addEventListener('change', () => {
        const value = /^\d+$/.test(select.value) ? Number(select.value) : select.value;
        this.patch({ [field.field]: value } as Partial<FootprintSettings>);
        this.render();
      });
      wrap.append(select);
      return wrap;
    }

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
      this.patch({ [field.field]: next } as Partial<FootprintSettings>);
    });
    wrap.append(input);
    return wrap;
  }

  /** Colour control for one named field. */
  colorControl(field: FieldKey, label: string): HTMLElement {
    const row = el('div', 'ind-swatch');
    const input = el('input');
    input.type = 'color';
    const value = this.handlers.settings()[field];
    input.value = typeof value === 'string' ? value : '#000000';
    input.setAttribute('aria-label', label);
    input.title = String(field);
    input.addEventListener('input', () => this.patch({ [field]: input.value } as Partial<FootprintSettings>));
    row.append(input, el('span', 'ind-swatch-label', input.value));
    return row;
  }

  /** Colour control for one slot of the `colors` pair. */
  pairColorControl(slot: number, label: string): HTMLElement {
    const row = el('div', 'ind-swatch');
    const input = el('input');
    input.type = 'color';
    input.value = this.handlers.settings().colors[slot] ?? '#000000';
    input.setAttribute('aria-label', label);
    input.title = `colors.${slot}`;
    input.addEventListener('input', () => {
      const colors = this.handlers.settings().colors.slice();
      colors[slot] = input.value;
      this.patch({ colors: [colors[0] ?? '#26b98a', colors[1] ?? '#e8555c'] });
    });
    row.append(input, el('span', 'ind-swatch-label', input.value));
    return row;
  }

  /** Column presets plus the per-column metric pickers, clamped to 2-4 columns. */
  columnsBlock(): HTMLElement {
    const settings = this.handlers.settings();
    const columns = settings.footprintColumns;
    const block = el('div', 'fp-columns');
    block.append(el('div', 'ind-section-title', `Columns · ${columns.length} of 2-4`));

    const presets = el('div', 'fp-preset-row');
    for (const preset of COLUMN_PRESETS) {
      const button = el('button', 'fp-preset', preset.id);
      button.type = 'button';
      button.title = preset.columns.join(' · ');
      button.classList.toggle('is-on', presetFor(columns) === preset.id);
      button.addEventListener('click', () => {
        this.patch({ footprintColumns: preset.columns.slice() });
        this.render();
      });
      presets.append(button);
    }
    block.append(presets);

    const grid = el('div', 'fp-column-grid');
    columns.forEach((metric, index) => {
      const pick = el('select', 'dialog-select');
      for (const id of CELL_METRICS) {
        const node = el('option', undefined, METRIC_LABELS[id] ?? id);
        node.value = id;
        pick.append(node);
      }
      pick.value = metric;
      pick.title = `footprintColumns[${index}]`;
      pick.addEventListener('change', () => {
        const next = columns.slice();
        next[index] = pick.value as CellMetric;
        this.patch({ footprintColumns: next });
        this.render();
      });
      grid.append(pick);
    });
    block.append(grid);

    const actions = el('div', 'fp-preset-row');
    const add = el('button', 'fp-preset', '+ column');
    add.type = 'button';
    add.disabled = columns.length >= 4;
    add.addEventListener('click', () => {
      const next = columns.slice();
      next.push(next.length === 2 ? 'volumeBar' : 'delta');
      this.patch({ footprintColumns: next });
      this.render();
    });
    const remove = el('button', 'fp-preset', '− column');
    remove.type = 'button';
    remove.disabled = columns.length <= 2;
    remove.addEventListener('click', () => {
      this.patch({ footprintColumns: columns.slice(0, columns.length - 1) });
      this.render();
    });
    actions.append(add, remove);
    block.append(actions);
    return block;
  }

  /** One checkbox per stats metric. */
  statsBlock(): HTMLElement {
    const settings = this.handlers.settings();
    const block = el('div', 'fp-stats');
    for (const metric of STATS_ROW_METRICS) {
      const label = el('label', 'fp-stat');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = settings.statsRows[metric] === true;
      input.title = `statsRows.${metric}`;
      // The patch replaces the settings object, so the merge has to read the live one.
      input.addEventListener('change', () => {
        const statsRows = { ...this.handlers.settings().statsRows, [metric]: input.checked };
        this.patch({ statsRows });
      });
      label.append(input, el('span', undefined, METRIC_LABELS[metric] ?? (metric as StatsRowMetric)));
      block.append(label);
    }
    return block;
  }
}
