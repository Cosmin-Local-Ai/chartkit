import { el } from './canvasKit';
import type { FeedReport, FeedVenue } from './api';
import { API_ROW_CAP } from './dataExport';
import { readWorkspaceFile, WORKSPACE_FILE_EXTENSION, WORKSPACE_SCHEMA_VERSION } from './workspaceFile';
import type { WorkspaceFileRead, WorkspaceFileSummary } from './workspaceFile';
import type { WorkspaceState } from './workspace';
import { SERIES_STYLES, type SeriesStyle } from './panes/pricePane';
import type { PriceScaleMode } from './scale';
import {
  EXCHANGE_ZONE,
  PRICE_TICK_STYLES,
  THEME_NAMES,
  ZONE_CHOICES,
  isKnownZone,
  type ChartSettings,
} from './settings';
import type { ChartTemplate } from './workspace';

export interface SettingsDialogHandlers {
  /** Live settings object the controls read from. */
  settings: () => ChartSettings;
  /** Merges a patch, re-normalises it, applies it to the panes and writes the document. */
  onPatch: (patch: Partial<ChartSettings>) => void;
  /** Chart type and price scale live in the app; the dialog mirrors them, never forks them. */
  seriesStyle: () => SeriesStyle;
  priceMode: () => PriceScaleMode;
  onSeriesStyle: (style: SeriesStyle) => void;
  onPriceMode: (mode: PriceScaleMode) => void;
  templates: () => ChartTemplate[];
  onSaveTemplate: (name: string) => void;
  onApplyTemplate: (name: string) => void;
  onDeleteTemplate: (name: string) => void;
  /** Read-out for the timezone page: what the axis actually runs on, and the venue's own zone. */
  zoneReadout: () => { resolved: string; offsetMinutes: number; instrumentZone: string };
  /** Backup page: each action answers with the line the page shows afterwards. */
  onExportWorkspace: () => string;
  /** Puts a validated document in place and writes it back to the server. */
  onImportWorkspace: (state: WorkspaceState) => Promise<string>;
  onExportBars: () => Promise<string>;
  onExportPrints: (range: PrintRange) => Promise<string>;
  /** Time span the bars in view cover, used to prefill the prints range. */
  visibleRange: () => { from: number; to: number };
  /** Data feeds: the credential state of every venue the server can route to. */
  feeds: () => Promise<FeedReport>;
  /** Sends only the fields the trader edited, so an untouched field is never cleared. */
  onSaveFeed: (venue: string, values: Record<string, string>) => Promise<FeedVenue[]>;
}

/** Prints window to export. A null bound means "whatever the server holds". */
export interface PrintRange {
  from: number | null;
  to: number | null;
}

type Page = 'appearance' | 'data' | 'feeds' | 'timezone' | 'latency' | 'templates' | 'backup';

const PAGES: { id: Page; label: string }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'data', label: 'Chart data' },
  { id: 'feeds', label: 'Data feeds' },
  { id: 'timezone', label: 'Timezone' },
  { id: 'latency', label: 'Latency' },
  { id: 'templates', label: 'Templates' },
  { id: 'backup', label: 'Backup' },
];

const PAGE_LABELS: Record<Page, string> = Object.fromEntries(PAGES.map((page) => [page.id, page.label])) as Record<Page, string>;

const THEME_LABELS: Record<string, string> = { dark: 'Dark', light: 'Light' };
const TICK_STYLE_LABELS: Record<string, string> = {
  fine: 'Fine — more labels',
  auto: 'Auto',
  coarse: 'Coarse — fewer labels',
};
const SCALE_LABELS: Record<string, string> = { linear: 'Linear', log: 'Log' };

type FieldKey = keyof ChartSettings;

type Field =
  | { kind: 'toggle'; field: FieldKey; label: string; hint?: string }
  | { kind: 'number'; field: FieldKey; label: string; min: number; max: number; step: number; hint?: string }
  | { kind: 'colour'; field: FieldKey; label: string }
  | { kind: 'select'; field: FieldKey; label: string; options: { value: string; label: string }[] }
  | { kind: 'mirror'; label: string; read: (d: SettingsDialog) => string; write: (d: SettingsDialog, value: string) => void; options: () => { value: string; label: string }[] }
  | { kind: 'custom'; render: (d: SettingsDialog) => HTMLElement };

/** Ranges the prints export offers without typing. */
const PRINT_RANGES = [
  { id: 'visible', label: 'Bars in view', minutes: null },
  { id: '1h', label: 'Last hour', minutes: 60 },
  { id: '24h', label: 'Last 24 hours', minutes: 1_440 },
  { id: 'newest', label: 'Newest stored prints', minutes: Number.NaN },
] as const;

/** One section of one page. */
interface Section {
  title: string;
  note?: string;
  fields: Field[];
}

/**
 * The one settings dialog: appearance, chart data, timezone, latency and templates.
 * Everything here is local to the workspace — no account, plan or publishing pages,
 * because this chart has none of those.
 */
export class SettingsDialog {
  private readonly backdrop: HTMLElement;
  private readonly panel = el('div', 'dialog');
  private readonly title = el('span', 'dialog-title', 'Settings');
  private readonly tabs = el('div', 'fp-tabs');
  private readonly body = el('div', 'ind-body');
  private readonly hint = el('div', 'dialog-hint');
  private page: Page = 'appearance';
  private open = false;
  private readonly tabButtons = new Map<Page, HTMLButtonElement>();
  /** A file that has been read and validated but not yet confirmed. */
  private pendingImport: { name: string; bytes: number; summary: WorkspaceFileSummary } | null = null;
  private pendingState: WorkspaceState | null = null;
  /** The last thing an export or an import did, or why it did not. */
  private notice: { ok: boolean; text: string } | null = null;
  /** Which section asked for that line, so it appears once, under the button that caused it. */
  private noticeOwner: 'workspace' | 'data' | null = null;
  private printRange: (typeof PRINT_RANGES)[number]['id'] = 'visible';

  constructor(private readonly handlers: SettingsDialogHandlers) {
    this.backdrop = el('div', 'dialog-backdrop');
    this.backdrop.hidden = true;
    const head = el('div', 'dialog-head');
    const close = el('button', 'dialog-close', '×');
    close.type = 'button';
    close.title = 'Close';
    close.addEventListener('click', () => this.close());
    head.append(this.title, close);

    for (const page of PAGES) {
      const button = el('button', 'fp-tab', page.label);
      button.type = 'button';
      button.addEventListener('click', () => {
        this.page = page.id;
        this.render();
      });
      this.tabButtons.set(page.id, button);
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
    this.tabButtons.get(this.page)?.focus();
  }

  close(): void {
    this.open = false;
    this.backdrop.hidden = true;
    this.backdrop.classList.remove('is-open');
    // Closing the dialog is the other half of "cancel": a file nobody confirmed is a file
    // nobody imported, and it must not be waiting there the next time the page opens.
    this.pendingImport = null;
    this.pendingState = null;
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  isOpen(): boolean {
    return this.open;
  }

  /** Which page is on screen, or null while the dialog is closed. */
  openPageLabel(): string | null {
    return this.open ? PAGE_LABELS[this.page] ?? null : null;
  }

  /** Opens one page, used by an entry point that means a specific page. */
  showPage(page: Page): void {
    this.page = page;
    if (this.open) this.render();
    else this.show();
  }

  /** Re-reads every field, so the form never shows a value the chart no longer holds. */
  refresh(): void {
    if (this.open) this.render();
  }

  private patch(patch: Partial<ChartSettings>): void {
    this.handlers.onPatch(patch);
  }

  private render(): void {
    for (const [id, button] of this.tabButtons) button.classList.toggle('is-on', id === this.page);
    this.title.textContent = `Settings · ${PAGE_LABELS[this.page]}`;
    const fragment = document.createDocumentFragment();
    for (const section of this.sectionsFor(this.page)) {
      fragment.append(el('div', 'ind-section-title', section.title));
      if (section.note) fragment.append(el('div', 'set-note', section.note));
      const form = el('div', 'ind-form');
      for (const field of section.fields) {
        form.append(field.kind === 'custom' ? field.render(this) : this.control(field));
      }
      fragment.append(form);
    }
    this.body.replaceChildren(fragment);
    this.hint.textContent = 'Changes apply at once and are kept in the workspace · Esc closes';
  }

  private control(field: Exclude<Field, { kind: 'custom' }>): HTMLElement {
    const wrap = el('label', 'ind-field');
    wrap.append(el('span', 'ind-field-label', field.label));
    if ('hint' in field && field.hint) wrap.title = field.hint;

    if (field.kind === 'toggle') {
      const input = el('input', 'ind-check');
      input.type = 'checkbox';
      input.checked = this.handlers.settings()[field.field] === true;
      input.title = String(field.field);
      input.addEventListener('change', () => this.patch({ [field.field]: input.checked } as Partial<ChartSettings>));
      wrap.append(input);
      return wrap;
    }

    if (field.kind === 'colour') {
      const row = el('div', 'ind-swatch');
      const input = el('input');
      input.type = 'color';
      input.value = String(this.handlers.settings()[field.field] ?? '#000000');
      input.setAttribute('aria-label', field.label);
      input.title = String(field.field);
      const readout = el('span', 'ind-swatch-label', input.value);
      input.addEventListener('input', () => {
        readout.textContent = input.value;
        this.patch({ [field.field]: input.value } as Partial<ChartSettings>);
      });
      row.append(input, readout);
      wrap.append(row);
      return wrap;
    }

    if (field.kind === 'number') {
      const input = el('input', 'dialog-input');
      input.type = 'number';
      input.min = String(field.min);
      input.max = String(field.max);
      input.step = String(field.step);
      input.value = String(this.handlers.settings()[field.field]);
      input.title = String(field.field);
      input.addEventListener('input', () => {
        const next = Number(input.value);
        if (!Number.isFinite(next)) return;
        this.patch({ [field.field]: next } as Partial<ChartSettings>);
      });
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
      select.value = String(this.handlers.settings()[field.field] ?? '');
      select.title = String(field.field);
      select.addEventListener('change', () => this.patch({ [field.field]: select.value } as Partial<ChartSettings>));
      wrap.append(select);
      return wrap;
    }

    // A mirrored value: chart type and price scale belong to the app, not to settings.
    const select = el('select', 'dialog-select');
    for (const option of field.options()) {
      const node = el('option', undefined, option.label);
      node.value = option.value;
      select.append(node);
    }
    select.value = field.read(this);
    select.addEventListener('change', () => field.write(this, select.value));
    wrap.append(select);
    return wrap;
  }

  /** Zone picker: the short list, plus any other IANA name typed in. */
  /**
   * One row per venue the server can route to. Secrets never travel back to the browser, so
   * a password box starts empty and only replaces the stored value when something is typed.
   */
  private feedBlock(): HTMLElement {
    const block = el('div', 'set-feeds');
    const note = el('p', 'set-note', 'Reading feed settings…');
    block.append(note);
    void (async () => {
      try {
        const report = await this.handlers.feeds();
        note.textContent = `Stored in ${report.credentialFile}, and overridden by the environment when those variables are set.`;
        for (const venue of report.venues) block.append(this.feedRow(venue));
      } catch (error) {
        note.textContent = `Could not read the feed settings: ${String(error)}`;
      }
    })();
    return block;
  }

  private feedRow(venue: FeedVenue): HTMLElement {
    const row = el('div', 'feed-venue');
    const head = el('div', 'feed-head');
    head.append(el('span', 'feed-name', venue.tag));
    const state = el('span', 'feed-state');
    const paint = (configured: boolean, source: string, missing: string[]): void => {
      state.dataset.state = configured ? 'ok' : 'missing';
      state.textContent = configured
        ? `configured · from ${source}`
        : `not configured — waiting for ${missing.join(', ')}`;
    };
    paint(venue.configured, venue.source, venue.missing);
    head.append(state);
    row.append(head, el('p', 'set-note', venue.note));

    const fields = el('div', 'feed-fields');
    const inputs = new Map<string, { input: HTMLInputElement; initial: string }>();
    for (const field of venue.fields) {
      const wrap = el('label', 'ind-field');
      wrap.append(el('span', 'ind-field-label', field.required ? field.label : `${field.label} (optional)`));
      const input = el('input', 'dialog-input');
      input.type = field.secret ? 'password' : 'text';
      const stored = venue.values[field.key] ?? '';
      // A required secret counts as set when the server no longer lists it as missing.
      const alreadySet = field.required && !venue.missing.includes(field.label);
      input.value = field.secret ? '' : stored;
      input.placeholder =
        field.secret && alreadySet ? 'set — type to replace' : field.placeholder || (field.required ? 'required' : '');
      input.title = `${field.env} overrides what is stored here`;
      wrap.append(input);
      fields.append(wrap);
      inputs.set(field.key, { input, initial: field.secret ? '' : stored });
    }
    row.append(fields);

    const actions = el('div', 'set-io-row');
    const save = el('button', 'dialog-accept', 'Save');
    save.type = 'button';
    const status = el('span', 'set-note', '');
    actions.append(save, status, el('span', 'feed-check', `chartkit --check-feed ${venue.slug}`));
    row.append(actions);

    save.addEventListener('click', () => {
      const values: Record<string, string> = {};
      for (const [key, entry] of inputs) {
        const text = entry.input.value.trim();
        // Only edited fields go back, so a field left alone keeps its stored value.
        if (text !== entry.initial) values[key] = text;
      }
      if (Object.keys(values).length === 0) {
        status.textContent = 'Nothing to save.';
        return;
      }
      save.disabled = true;
      status.textContent = 'Saving…';
      void (async () => {
        try {
          const venues = await this.handlers.onSaveFeed(venue.venue, values);
          const updated = venues.find((entry) => entry.venue === venue.venue);
          if (updated) paint(updated.configured, updated.source, updated.missing);
          status.textContent = `Saved ${Object.keys(values).length} field${Object.keys(values).length === 1 ? '' : 's'}.`;
        } catch (error) {
          status.textContent = String(error);
        }
        save.disabled = false;
      })();
    });
    return row;
  }

  private zoneBlock(): HTMLElement {
    const settings = this.handlers.settings();
    const block = el('div', 'set-zone');
    const readout = this.handlers.zoneReadout();

    const select = el('select', 'dialog-select');
    for (const zone of ZONE_CHOICES) {
      const node = el('option', undefined, zone === EXCHANGE_ZONE ? 'Exchange session time' : zone);
      node.value = zone;
      select.append(node);
    }
    const typed = settings.timezone !== 'UTC' && !ZONE_CHOICES.includes(settings.timezone);
    if (typed) {
      const node = el('option', undefined, `${settings.timezone} (typed)`);
      node.value = settings.timezone;
      select.append(node);
    }
    select.value = settings.timezone;
    select.addEventListener('change', () => {
      this.patch({ timezone: select.value });
      this.render();
    });

    const input = el('input', 'dialog-input');
    input.type = 'text';
    input.placeholder = 'America/Sao_Paulo';
    input.value = typed ? settings.timezone : '';
    input.title = 'Any IANA zone name; applied only when the runtime knows it';
    const status = el('span', 'set-note', '');
    const paint = (): void => {
      const text = input.value.trim();
      if (text === '') {
        status.textContent = 'Pick a zone from the list, or type any IANA name here.';
        return;
      }
      status.textContent = isKnownZone(text) ? `“${text}” is a zone this browser knows.` : `“${text}” is not a zone this browser knows.`;
    };
    paint();
    input.addEventListener('input', paint);
    input.addEventListener('change', () => {
      const text = input.value.trim();
      if (!isKnownZone(text)) return;
      this.patch({ timezone: text });
      this.render();
    });

    const offset = readout.offsetMinutes;
    const sign = offset < 0 ? '-' : '+';
    const absolute = Math.abs(offset);
    block.append(
      el('div', 'set-note', `Axis clock: ${readout.resolved} (${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}) · venue zone: ${readout.instrumentZone || 'none'}`),
      select,
      input,
      status,
    );
    return block;
  }

  /** Save the current view as a named template, apply one, or drop one. */
  private templateBlock(): HTMLElement {
    const block = el('div', 'set-templates');
    block.append(el('div', 'ind-section-title', 'Saved templates'));

    const save = el('div', 'set-save-row');
    const input = el('input', 'dialog-input');
    input.type = 'text';
    input.placeholder = 'Template name';
    input.setAttribute('aria-label', 'Template name');
    const button = el('button', 'dialog-watch', 'save current view');
    button.type = 'button';
    const submit = (): void => {
      const name = input.value.trim();
      if (!name) return;
      this.handlers.onSaveTemplate(name);
      input.value = '';
      this.render();
    };
    button.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
    save.append(input, button);
    block.append(save);

    const templates = this.handlers.templates();
    if (templates.length === 0) {
      block.append(el('div', 'set-note', 'No templates saved yet.'));
      return block;
    }
    for (const template of templates) {
      const row = el('div', 'set-template-row');
      const main = el('div', 'ind-row-main');
      main.append(el('span', 'ind-row-name', template.name), el('span', 'ind-row-meta', templateSummary(template)));
      const apply = el('button', 'dialog-watch', 'apply');
      apply.type = 'button';
      apply.addEventListener('click', () => {
        this.handlers.onApplyTemplate(template.name);
        this.render();
      });
      const remove = el('button', 'dialog-watch', 'remove');
      remove.type = 'button';
      remove.addEventListener('click', () => {
        this.handlers.onDeleteTemplate(template.name);
        this.render();
      });
      row.append(main, apply, remove);
      block.append(row);
    }
    return block;
  }

  /** Export the workspace, or pick a file and confirm before anything is overwritten. */
  private workspaceBlock(): HTMLElement {
    const block = el('div', 'set-io');
    block.append(el('div', 'ind-section-title', 'Workspace file'));

    const exportRow = el('div', 'set-io-row');
    const exportButton = button('export workspace file', 'Write the whole workspace to a JSON file you keep');
    exportButton.addEventListener('click', () => {
      this.notice = { ok: true, text: this.handlers.onExportWorkspace() };
      this.noticeOwner = 'workspace';
      this.render();
    });
    exportRow.append(exportButton);
    block.append(exportRow);

    const picker = el('input', 'set-io-file');
    picker.type = 'file';
    picker.accept = `.${WORKSPACE_FILE_EXTENSION},.json,application/json`;
    picker.setAttribute('aria-label', 'Workspace file to import');
    picker.addEventListener('change', () => {
      const file = picker.files?.[0];
      if (!file) return;
      void file
        .text()
        .then((text) => this.readCandidate(file.name, file.size, text))
        .catch((error: unknown) => {
          this.rejectCandidate(error instanceof Error ? error.message : String(error));
        });
    });
    const pickRow = el('div', 'set-io-row');
    pickRow.append(picker, el('span', 'set-note', 'pick a file to import'));
    block.append(pickRow);

    if (this.pendingImport && this.pendingState) {
      block.append(this.confirmationBlock());
    } else {
      block.append(
        el(
          'div',
          'set-note',
          `Format: our own JSON, schema version ${WORKSPACE_SCHEMA_VERSION}. A file that states another version, or is not ours, is refused with the reason and changes nothing.`,
        ),
      );
    }

    if (this.notice && this.noticeOwner === 'workspace') block.append(this.noticeLine());
    return block;
  }

  /** A file the validator accepted, waiting on one click before it replaces anything. */
  private confirmationBlock(): HTMLElement {
    const pending = this.pendingImport;
    const state = this.pendingState;
    if (!pending || !state) return el('div', 'set-note');
    const box = el('div', 'set-io-confirm');
    box.append(el('div', 'ind-section-title', 'Confirm the import'));
    for (const line of summaryLines(pending.name, pending.bytes, pending.summary)) {
      box.append(el('div', 'set-io-line', line));
    }
    if (pending.summary.repaired.length > 0) {
      box.append(el('div', 'set-io-warn', `repaired while validating: ${pending.summary.repaired.join('; ')}`));
    }
    box.append(
      el('div', 'set-io-warn', 'Importing replaces the current workspace: its indicators, drawings, zoom, price range, settings and templates. Undo history is cleared.'),
    );

    const actions = el('div', 'set-io-row');
    const accept = button('import and replace', 'Put this workspace in place and save it');
    accept.classList.add('is-primary');
    accept.addEventListener('click', () => {
      const doc = this.pendingState;
      if (!doc) return;
      this.handlers
        .onImportWorkspace(doc)
        .then((message) => {
          this.pendingImport = null;
          this.pendingState = null;
          this.notice = { ok: true, text: message };
          this.noticeOwner = 'workspace';
          this.render();
        })
        .catch((error: unknown) => {
          this.pendingImport = null;
          this.pendingState = null;
          this.notice = { ok: false, text: `import failed: ${error instanceof Error ? error.message : String(error)}` };
          this.noticeOwner = 'workspace';
          this.render();
        });
    });
    const cancel = button('cancel', 'Keep the current workspace and forget this file');
    cancel.addEventListener('click', () => {
      this.pendingImport = null;
      this.pendingState = null;
      this.notice = { ok: true, text: 'import cancelled — the workspace is unchanged' };
      this.noticeOwner = 'workspace';
      this.render();
    });
    actions.append(accept, cancel);
    box.append(actions);
    return box;
  }

  private noticeLine(): HTMLElement {
    const notice = this.notice;
    if (!notice) return el('div', 'set-note');
    const line = el('div', notice.ok ? 'set-io-line' : 'set-io-warn', notice.text);
    return line;
  }

  /** A file that failed validation: name the reason, and leave the chart exactly as it was. */
  private rejectCandidate(error: string): void {
    this.pendingImport = null;
    this.pendingState = null;
    this.notice = { ok: false, text: `not imported: ${error}` };
    this.noticeOwner = 'workspace';
    if (this.open) this.render();
  }

  private readCandidate(name: string, bytes: number, text: string): void {
    const read: WorkspaceFileRead = readWorkspaceFile(text);
    if (!read.ok) {
      this.rejectCandidate(read.error);
      return;
    }
    if (!this.open) return;
    this.pendingImport = { name, bytes, summary: read.summary };
    this.pendingState = read.state;
    this.notice = null;
    this.noticeOwner = null;
    this.render();
  }

  /** Prints for a range the trader picked, as CSV. */
  private printsBlock(): HTMLElement {
    const block = el('div', 'set-io');
    block.append(el('div', 'ind-section-title', 'Chart data'));

    const barsRow = el('div', 'set-io-row');
    const barsButton = button('export bars in view (CSV)', 'One row per bar the chart is showing, with delta where prints cover it');
    barsButton.addEventListener('click', () => {
      void this.handlers.onExportBars().then(
        (message) => {
          this.notice = { ok: true, text: message };
          this.noticeOwner = 'data';
          this.render();
        },
        (error: unknown) => {
          this.notice = { ok: false, text: `bars not exported: ${error instanceof Error ? error.message : String(error)}` };
          this.noticeOwner = 'data';
          this.render();
        },
      );
    });
    barsRow.append(barsButton, el('span', 'set-note', 'time, open, high, low, close, volume, and delta when prints cover the window'));
    block.append(barsRow);

    const rangeRow = el('div', 'set-io-row');
    const select = el('select', 'dialog-select');
    for (const range of PRINT_RANGES) {
      const option = el('option', undefined, range.label);
      option.value = range.id;
      select.append(option);
    }
    select.value = this.printRange;
    const from = el('input', 'dialog-input');
    from.type = 'datetime-local';
    from.step = '1';
    from.setAttribute('aria-label', 'Prints range start (browser local time)');
    const to = el('input', 'dialog-input');
    to.type = 'datetime-local';
    to.step = '1';
    to.setAttribute('aria-label', 'Prints range end (browser local time)');
    const bounds = this.printBounds();
    from.value = bounds.from === null ? '' : localInputValue(bounds.from);
    to.value = bounds.to === null ? '' : localInputValue(bounds.to);
    select.addEventListener('change', () => {
      this.printRange = select.value as (typeof PRINT_RANGES)[number]['id'];
      this.render();
    });
    rangeRow.append(select, from, to, el('span', 'set-note', 'times are browser-local'));
    block.append(rangeRow);

    const printsRow = el('div', 'set-io-row');
    const printsButton = button('export prints (CSV)', 'One row per print in the range, oldest first');
    printsButton.addEventListener('click', () => {
      const range = this.printRangeChosen(from.value, to.value);
      void this.handlers.onExportPrints(range).then(
        (message) => {
          this.notice = { ok: true, text: message };
          this.noticeOwner = 'data';
          this.render();
        },
        (error: unknown) => {
          this.notice = { ok: false, text: `prints not exported: ${error instanceof Error ? error.message : String(error)}` };
          this.noticeOwner = 'data';
          this.render();
        },
      );
    });
    printsRow.append(printsButton);
    block.append(printsRow);

    block.append(
      el(
        'div',
        'set-note',
        `The server answers at most ${API_ROW_CAP.toLocaleString('en-US')} rows per request. An export that stops there is partial, and its file name says so.`,
      ),
    );
    if (this.notice && this.noticeOwner === 'data') block.append(this.noticeLine());
    return block;
  }

  /** The range the picker shows for the current preset. */
  private printBounds(): { from: number | null; to: number | null } {
    const preset = PRINT_RANGES.find((entry) => entry.id === this.printRange) ?? PRINT_RANGES[0]!;
    if (preset.id === 'visible') {
      const seen = this.handlers.visibleRange();
      return { from: seen.from, to: seen.to };
    }
    if (Number.isNaN(preset.minutes)) return { from: null, to: null };
    const to = Date.now();
    return { from: to - preset.minutes * 60_000, to };
  }

  /**
   * The range to ask for: the typed bounds when the trader typed any, else the preset's.
   * A bound that does not parse is ignored rather than guessed at.
   */
  private printRangeChosen(fromValue: string, toValue: string): PrintRange {
    const preset = this.printBounds();
    const typedFrom = fromValue === '' ? null : new Date(fromValue).getTime();
    const typedTo = toValue === '' ? null : new Date(toValue).getTime();
    const from = Number.isFinite(typedFrom) ? (typedFrom as number) : preset.from;
    const to = Number.isFinite(typedTo) ? (typedTo as number) : preset.to;
    if (from !== null && to !== null && to <= from) return { from: null, to: null };
    return { from, to };
  }

  /** The sections of one page. Built inside the class so the controls read live state. */
  private sectionsFor(page: Page): Section[] {
    if (page === 'appearance') {
      return [
        {
          title: 'Theme and colours',
          fields: [
            { kind: 'select', field: 'theme', label: 'Theme', options: THEME_NAMES.map((value) => ({ value, label: THEME_LABELS[value] ?? value })) },
            { kind: 'colour', field: 'paneBackground', label: 'Pane background' },
            { kind: 'colour', field: 'upColor', label: 'Rising colour' },
            { kind: 'colour', field: 'downColor', label: 'Falling colour' },
          ],
        },
        {
          title: 'Grid and axes',
          fields: [
            { kind: 'toggle', field: 'showGrid', label: 'Grid lines', hint: 'Turns the price rows and time columns off in every pane.' },
            {
              kind: 'select',
              field: 'priceTickStyle',
              label: 'Price axis ticks',
              options: PRICE_TICK_STYLES.map((value) => ({ value, label: TICK_STYLE_LABELS[value] ?? value })),
            },
            { kind: 'toggle', field: 'showLegend', label: 'Chart legend' },
          ],
        },
      ];
    }
    if (page === 'data') {
      return [
        {
          title: 'Series and scale',
          note: 'The same state the top bar switches; changing it here changes it there.',
          fields: [
            {
              kind: 'mirror',
              label: 'Chart type',
              options: MIRROR_STYLE,
              read: (d) => d.handlers.seriesStyle(),
              write: (d, value) => d.handlers.onSeriesStyle(value as SeriesStyle),
            },
            {
              kind: 'mirror',
              label: 'Price scale',
              options: () => Object.entries(SCALE_LABELS).map(([value, label]) => ({ value, label })),
              read: (d) => d.handlers.priceMode(),
              write: (d, value) => d.handlers.onPriceMode(value as PriceScaleMode),
            },
            {
              kind: 'toggle',
              field: 'showSessionDivider',
              label: 'Session divider',
              hint: 'A rule at each session boundary, shaded while the venue is closed. A venue that trades around the clock gets the day change instead. Both follow the axis timezone.',
            },
          ],
        },
        {
          title: 'Density',
          note: 'The zoom-out floor and how many bars a framed view shows. Changing the target re-frames the chart now.',
          fields: [
            {
              kind: 'number',
              field: 'minBarStep',
              label: 'Zoom-out floor (px per bar)',
              min: 1,
              max: 12,
              step: 0.25,
              hint: 'Zoom stops here rather than turning the tape into a solid comb.',
            },
            { kind: 'number', field: 'visibleBars', label: 'Bars in a framed view', min: 20, max: 2000, step: 10 },
          ],
        },
      ];
    }
    if (page === 'feeds') {
      return [
        {
          title: 'Logins and endpoints',
          note: 'Your own paid data, your own logins. The server reads each value from its environment variable first and then from a file on this machine; nothing is compiled in, and a venue with no credentials reports that instead of failing or pretending to stream.',
          fields: [{ kind: 'custom', render: (d) => d.feedBlock() }],
        },
      ];
    }
    if (page === 'timezone') {
      return [
        {
          title: 'Axis timezone',
          note: 'Axis labels, the session divider, the crosshair time and the legend follow this zone.',
          fields: [{ kind: 'custom', render: (d) => d.zoneBlock() }],
        },
      ];
    }
    if (page === 'latency') {
      return [
        {
          title: 'Feed latency',
          note: 'Venue timestamp minus arrival, so it carries the clock difference between the venue and this machine.',
          fields: [
            { kind: 'toggle', field: 'showLatency', label: 'Show latency in the status strip' },
            {
              kind: 'number',
              field: 'latencyAlertMs',
              label: 'Warn above (ms)',
              min: 100,
              max: 120000,
              step: 100,
              hint: 'The chip turns amber once the running estimate passes this.',
            },
          ],
        },
      ];
    }
    if (page === 'templates') {
      return [
        {
          title: 'What a template holds',
          note: 'Settings, chart type, price scale, zoom and offset, a price range framed by hand, the indicators with their parameters, and which panes are open with their heights. It holds no drawings, no symbol and no interval, and it never holds undo history.',
          fields: [{ kind: 'custom', render: (d) => d.templateBlock() }],
        },
      ];
    }
    return [
      {
        title: 'Workspace file',
        note: 'The whole workspace in one file you keep: indicators with their script text and parameters, every placed drawing, the zoom and the price range framed by hand, pane heights, footprint settings, settings, templates and the watchlist. It carries no bars and no prints — the server reads those from the venue.',
        fields: [{ kind: 'custom', render: (d) => d.workspaceBlock() }],
      },
      {
        title: 'Chart data',
        note: 'What is on screen, out as CSV.',
        fields: [{ kind: 'custom', render: (d) => d.printsBlock() }],
      },
    ];
  }
}

/** One button, so the backup page reads like the rest of the dialog. */
function button(label: string, title: string): HTMLButtonElement {
  const node = el('button', 'dialog-watch', label);
  node.type = 'button';
  node.title = title;
  return node;
}

/** What the confirmation shows, one line at a time, before a single field is touched. */
function summaryLines(name: string, bytes: number, summary: WorkspaceFileSummary): string[] {
  const lines = [
    `file: ${name} (${(bytes / 1024).toFixed(1)} KB)`,
    `schema version ${WORKSPACE_SCHEMA_VERSION} · symbol ${summary.instrument ?? 'none'} · ${summary.timeframe} · ${summary.seriesStyle}`,
    `${summary.indicators} indicator${summary.indicators === 1 ? '' : 's'}${summary.scripts > 0 ? ` (${summary.scripts} with script text)` : ''}`,
    `${summary.drawings} drawing${summary.drawings === 1 ? '' : 's'} over ${summary.toolTypes} tool${summary.toolTypes === 1 ? '' : 's'}`,
    `${summary.templates} template${summary.templates === 1 ? '' : 's'} · ${summary.watchlist} watchlist symbol${summary.watchlist === 1 ? '' : 's'}`,
    `theme ${summary.theme} · axis zone ${summary.timezone}`,
  ];
  const zoom = summary.barStep === null ? 'zoom not stored' : `zoom ${summary.barStep.toFixed(2)} px/bar`;
  const offset = summary.offsetFromEnd === null ? '' : ` · offset ${summary.offsetFromEnd}`;
  lines.push(`${zoom}${offset}${summary.framedRange ? ' · price range framed by hand' : ''}`);
  return lines;
}

/** `datetime-local` wants wall-clock digits, not an instant. */
function localInputValue(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  );
}


/** What a template carries, in the words the dialog shows under the list. */
function templateSummary(template: ChartTemplate): string {
  const framed = template.view.autoFit === false ? ' · framed price range' : '';
  return `${template.settings.theme} · ${template.seriesStyle} · ${template.indicators.length} indicator${template.indicators.length === 1 ? '' : 's'}${framed}`;
}

const MIRROR_STYLE = () => SERIES_STYLES.map((entry) => ({ value: entry.value, label: entry.label }));

