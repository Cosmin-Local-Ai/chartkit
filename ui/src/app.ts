import { api } from './api';
import { API_ROW_CAP, barsToCsv, printsToCsv } from './dataExport';
import { barsFileName, downloadCsv, downloadJson, printsFileName, workspaceFileName } from './download';
import { buildWorkspaceFile, readWorkspaceFile, serialiseWorkspaceFile } from './workspaceFile';
import { LocalTime } from './format';
import { PRICE_AXIS_WIDTH, PLOT_PADDING_LEFT, PaneStack, TIME_AXIS_HEIGHT, emptyHover } from './layout';
import type { Frame, HoverState } from './layout';
import { PriceScale, XScale } from './scale';
import type { PriceScaleMode } from './scale';
import { ChartView } from './view';
import { Series, errorMessage } from './series';
import { dayBoundarySegments, findGaps, previousSessionClose, sessionSegments } from './session';
import { PricePane } from './panes/pricePane';
import type { OverlayLayer, PriceDecor, SeriesStyle } from './panes/pricePane';
import { IndicatorPane } from './panes/indicatorPane';
import { VolumePane } from './panes/volumePane';
import { FootprintPane } from './panes/footprintPane';
import { ProfilePane } from './panes/profilePane';
import { LiveClient } from './live';
import type { ConnectionPhase } from './live';
import { DepthLadder } from './depthLadder';
import { Watchlist } from './watchlist';
import type { WatchEntry } from './watchlist';
import { SymbolSearch } from './symbolSearch';
import { Topbar } from './topbar';
import { StatusStrip } from './statusStrip';
import { DEFAULT_STATE, MAX_TEMPLATES, WorkspaceStore } from './workspace';
import type { ChartTemplate, WorkspaceState } from './workspace';
import { TIMEFRAMES } from './timeframes';
import { ChartHistory, type HistoryKind } from './history';
import { IndicatorEngine } from './indicators/engine';
import { printFlow, type PrintFlow } from './indicators/flow';
import { ScriptRuntime } from './indicators/script/runtime';
import type { IndicatorResult } from './indicators/registry';
import { IndicatorDialog } from './indicatorDialog';
import { FootprintSettingsDialog } from './footprintDialog';
import { normaliseFootprintSettings } from './footprintSettings';
import type { FootprintSettings } from './footprintSettings';
import { SettingsDialog } from './settingsDialog';
import type { PrintRange } from './settingsDialog';
import { ShortcutDialog } from './shortcutDialog';
import { AlertsDialog } from './alertsDialog';
import { DesktopNotifier } from './notify';
import { conditionText, fireValueText, mergeFires, parseAlerts, parseFires } from './alertsModel';
import type { AlertPayload } from './alertsModel';
import { PLAIN_KEY_ACTIONS } from './shortcuts';
import { TICK_PITCH_PX, applyAppearance, applyThemeColours, normaliseSettings, resolveZone } from './settings';
import type { ChartSettings } from './settings';
import { DrawingEngine } from './drawings/engine';
import { DrawingController } from './drawings/controller';
import { DrawingLayer, pricePlot } from './panes/drawingLayer';
import { DrawingDialog } from './drawingDialog';
import { DrawingMenu, TOOL_CHOICES } from './drawingMenu';
import { ToolRail } from './toolRail';
import { toolById, type ToolEnv } from './drawings/registry';
import type { StyleValues } from './drawings/style';
import type { Pt } from './drawings/anchors';
import { measureText } from './canvasKit';
import type {
  AlertFire,
  AlertRecord,
  Bar,
  Coverage,
  DepthSnapshot,
  FootprintSeries,
  Instrument,
  LiveMessage,
} from './types';

const DEFAULT_INSTRUMENT = 'BINANCE:BTCUSDT';
/** Start pulling older bars when the view gets this close to the oldest stored bar. */
const OLDER_MARGIN_BARS = 60;
const FOOTPRINT_DEBOUNCE_MS = 260;
/** Cadence for re-reading prints of a bucket that is still open. */
const FOOTPRINT_LIVE_REFRESH_MS = 5_000;
/**
 * Print window for the delta indicators. The response carries a full price ladder per
 * bar, so a wide view is capped: past the cap the newest bars keep the delta line
 * current and the indicator's note names the range that is actually backed by prints.
 */
const FLOW_DEBOUNCE_MS = 400;
const FLOW_LIVE_REFRESH_MS = 5_000;
const FLOW_MAX_BARS = 400;
/**
 * Bars one `/api/footprint` request answers — the clamp the server puts on `limit`
 * (`crates/server/src/api.rs`). A bars export wider than this asks for one window, so its
 * delta column reaches only the newest this many bars and leaves the older rows blank.
 */
const FOOTPRINT_CSV_LIMIT = 5_000;
/** The volume profile follows the visible window on the same debounce as the footprint. */
const PROFILE_DEBOUNCE_MS = 260;
const PROFILE_LIVE_REFRESH_MS = 5_000;
/** Panes that live in the stack and are switched by their own `setVisible`. */
const STACK_PANES: readonly string[] = ['volume', 'footprint', 'profile'];
const PRICE_GUTTER_HIT = 4;
/** Height an indicator pane gets until the user drags its splitter. */
const INDICATOR_PANE_WEIGHT = 1;
const INDICATOR_PANE_MIN_PX = 110;
const INDICATOR_PANE_PREFIX = 'ind:';

interface DragState {
  kind: 'time' | 'price';
  startX: number;
  startY: number;
  startOffset: number;
  startRange: { min: number; max: number; height: number };
  moved: boolean;
}

/** Root of the web client: wires data, panes, controls and the draw loop together. */
export class ChartApp {
  private readonly stack: PaneStack;
  private readonly pricePane = new PricePane();
  private readonly volumePane = new VolumePane();
  private readonly footprintPane = new FootprintPane();
  private readonly profilePane = new ProfilePane();
  private readonly view = new ChartView();
  private readonly series = new Series();
  private readonly workspace = new WorkspaceStore();
  private local = new LocalTime('UTC');
  private instrument: Instrument | null = null;
  private timeframe = DEFAULT_STATE.timeframe;
  private state: WorkspaceState = structuredClone(DEFAULT_STATE);
  private hover: HoverState = emptyHover();
  /** True while the pointer is anywhere over a pane, including the price axis gutter. */
  private pointerOver = false;
  private frameX: XScale | null = null;
  private dirty = true;
  private coverage: Coverage | null = null;
  private drag: DragState | null = null;
  private watchEntries: WatchEntry[] = [];
  private pendingDepth: DepthSnapshot | null = null;
  private feedPhase: ConnectionPhase = 'idle';
  private feedDetail = '';
  private footprintTimer: number | null = null;
  private footprintFetchedAt = 0;
  /** Prints for the delta indicators: the same window the view shows, wider than the pane needs. */
  private flowSeries: FootprintSeries | null = null;
  private flowError: string | null = null;
  private flowLoading = false;
  private flowRequested = false;
  private flowKey = '';
  private flowGeneration = 0;
  private flowTimer: number | null = null;
  private flowFetchedAt = 0;
  private flowBuilt: { series: FootprintSeries | null; loading: boolean; error: string | null; flow: PrintFlow } | null = null;
  private profileTimer: number | null = null;
  private profileFetchedAt = 0;
  private lastStatusTick = 0;
  /** Bars pulled on the first load; `?bars=N` lowers it to exercise lazy paging. */
  private readonly initialBarLimit = readInitialBarLimit();
  private starts: number[] = [];
  private decor: PriceDecor = { gaps: [], session: [] };
  private decorKey = '';
  /** Runs the user indicators in a worker the host can terminate; declared first so the engine can take it. */
  private readonly scripts = new ScriptRuntime();
  private readonly indicators = new IndicatorEngine(this.scripts);
  private readonly indicatorPanes = new Map<string, IndicatorPane>();
  private indicatorResults = new Map<string, IndicatorResult>();
  private overlays: OverlayLayer[] = [];
  private readonly drawings = new DrawingEngine();
  private readonly drawingController = new DrawingController(this.drawings);
  private readonly drawingLayer = new DrawingLayer();
  /** Undo and redo, in memory only: the workspace document never sees a step. */
  private readonly history = new ChartHistory(this.drawings, this.indicators, (kind) => this.afterHistoryRestore(kind));
  /** Key of the drawing gesture whose edits are still landing in one step, if any. */
  private openGestureKey: string | null = null;
  /** Price scale of the last rendered frame: drawings place against what is on screen. */
  private framePrice: PriceScale | null = null;
  private indicatorDialog!: IndicatorDialog;
  private drawingDialog!: DrawingDialog;
  private drawingMenu!: DrawingMenu;
  private footprintDialog!: FootprintSettingsDialog;
  private settingsDialog!: SettingsDialog;
  private shortcutDialog!: ShortcutDialog;
  private alertsDialog!: AlertsDialog;
  /** Rules and fires exactly as the server has them: the panel is a view over these. */
  private alertRules: AlertRecord[] = [];
  private alertFires: AlertFire[] = [];
  private alertsFetched = false;
  /** Popups, and the guard in front of them. */
  private readonly notifier = new DesktopNotifier();
  /** Fires the trader has not opened the panel for, counted on the top bar. */
  private unseenFires = 0;
  private rail!: ToolRail;
  private live!: LiveClient;
  private topbar!: Topbar;
  private status!: StatusStrip;
  private ladder!: DepthLadder;
  private watchlist!: Watchlist;
  private search!: SymbolSearch;

  constructor(root: HTMLElement) {
    const topbarEl = mustGet(root, 'topbar');
    const sidebarEl = mustGet(root, 'sidebar');
    const stackEl = mustGet(root, 'pane-stack');
    const ladderEl = mustGet(root, 'ladder-panel');
    const statusEl = mustGet(root, 'status');
    const backdrop = mustGet(root, 'dialog-backdrop');

    this.stack = new PaneStack(stackEl);
    this.indicatorDialog = new IndicatorDialog({
      onAdd: (indicatorId) => this.addIndicator(indicatorId),
      onRemove: (instanceId) => this.removeIndicator(instanceId),
      onParams: (instanceId, patch) => {
        // One step per control: a sweep of one field coalesces, a different field starts
        // a new step, so undo walks back the settings the way they were changed.
        this.history.transact('indicators', `ind:params:${instanceId}:${Object.keys(patch).join('+')}`, 'indicator settings', () =>
          this.indicators.setParams(instanceId, patch),
        );
        this.markDirty();
        this.persist();
      },
      instances: () => this.indicators.instances,
      definitionOf: (instance) => this.indicators.definitionOf(instance),
      summary: (instance) => this.indicators.summary(instance),
      scriptError: (instance) => this.indicators.scriptError(instance.id),
      onAddScript: (source) => this.addScriptIndicator(source),
      onScript: (instanceId, source) => {
        // A run of typing coalesces; a pause closes the step, so undo rewinds a burst of
        // typing at once rather than a character at a time.
        this.history.transact('indicators', `ind:script:${instanceId}`, 'script text', () =>
          this.indicators.setScript(instanceId, source),
        );
        this.markDirty();
        this.persist();
      },
    });

    // A script answer arrives off the render loop: it can add or move a pane, and the
    // parameters a declaration describes are only known then.
    this.scripts.onUpdate = () => {
      this.indicators.reconcileScripts();
      this.syncIndicatorPanes();
      this.indicatorDialog.refreshStatus();
      this.markDirty();
      this.persist();
    };

    this.drawingDialog = new DrawingDialog({
      onPickTool: (toolId) => this.pickTool(toolId),
      onRemove: (instanceId) => this.deleteDrawing(instanceId),
      onSelect: (instanceId) => {
        this.drawings.selectedId = instanceId;
        this.markDirty();
      },
      onStyle: (instanceId, patch) => {
        this.styleDrawing(instanceId, patch);
        this.markDirty();
        this.persist();
      },
      instances: () => this.drawings.instances,
      definitionOf: (instance) => this.drawings.definitionOf(instance),
      summary: (instance) => this.drawings.summary(instance, this.instrument?.pricePrecision ?? 2, (ms) => this.local.format(ms, 'dateTime')),
    });

    // Right-click menu: the drawing's own actions and its style strip, or chart actions
    // and tool picking over empty tape. It reuses the dialogs' field renderer and Esc path.
    this.drawingMenu = new DrawingMenu({
      instanceOf: (instanceId) => this.drawings.find(instanceId),
      definitionOf: (instance) => this.drawings.definitionOf(instance),
      onStyle: (instanceId, patch) => {
        this.styleDrawing(instanceId, patch);
        this.markDirty();
        this.persist();
      },
      onDuplicate: (instanceId) => {
        this.history.transact('drawings', null, 'duplicate drawing', () => {
          const env = this.toolEnv();
          if (env) this.drawingController.duplicate(instanceId, env);
        });
        this.markDirty();
        this.persist();
      },
      onReorder: (instanceId, where) => {
        this.history.transact('drawings', null, 'change draw order', () => this.drawings.reorder(instanceId, where));
        this.markDirty();
        this.persist();
      },
      onLock: (instanceId, locked) => {
        this.history.transact('drawings', null, locked ? 'lock drawing' : 'unlock drawing', () => this.drawings.setLocked(instanceId, locked));
        this.markDirty();
        this.persist();
      },
      onDelete: (instanceId) => this.deleteDrawing(instanceId),
      onSettings: (instanceId) => this.drawingDialog.showSettings(instanceId),
      onChartAction: (action) => {
        if (action === 'fit') this.fitAll();
        else if (action === 'recent') this.goHome();
        else this.autoScale();
      },
      onPickTool: (toolId) => this.pickTool(toolId),
      onMoreTools: () => {
        if (!this.drawingDialog.isOpen()) this.drawingDialog.show();
      },
      recentTools: () => this.state.recentTools,
      armedTool: () => this.drawingController.toolId,
    });

    this.footprintDialog = new FootprintSettingsDialog({
      settings: () => this.state.footprint,
      onPatch: (patch) => this.patchFootprint(patch),
    });

    // One settings dialog over every local setting. Chart type and price scale are mirrored
    // from the app rather than copied, so the top bar and the dialog cannot disagree.
    this.settingsDialog = new SettingsDialog({
      settings: () => this.state.settings,
      onPatch: (patch) => this.patchSettings(patch),
      seriesStyle: () => this.pricePane.style,
      priceMode: () => this.view.priceMode,
      onSeriesStyle: (style) => this.setStyle(style),
      onPriceMode: (mode) => this.setScaleMode(mode),
      templates: () => this.state.templates,
      onSaveTemplate: (name) => {
        this.saveTemplate(name);
        this.markDirty();
      },
      onApplyTemplate: (name) => this.applyTemplate(name),
      onDeleteTemplate: (name) => {
        this.state.templates = this.state.templates.filter((template) => template.name !== name);
        this.persist();
      },
      zoneReadout: () => ({
        resolved: resolveZone(this.state.settings, this.instrument?.session.timezone),
        offsetMinutes: Math.round(this.local.offsetFor(Date.now()) / 60_000),
        instrumentZone: this.instrument?.session.timezone ?? '',
      }),
      feeds: () => api.feeds(),
      onSaveFeed: (venue, values) => api.saveFeeds(venue, values).then((report) => report.venues),
      onExportWorkspace: () => this.exportWorkspace(),
      onImportWorkspace: (state) => this.importWorkspace(state),
      onExportBars: () => this.exportBarsCsv(),
      onExportPrints: (range) => this.exportPrintsCsv(range),
      visibleRange: () => this.visibleTimeRange(),
    });
    this.shortcutDialog = new ShortcutDialog();

    // Alerts live on the server, so the panel owns none of them: it reads what the API
    // returns and sends whole rules back when the trader changes one.
    this.alertsDialog = new AlertsDialog({
      alerts: () => this.alertRules,
      fires: () => this.alertFires,
      prefilled: () => ({
        instrument: this.instrument?.id ?? DEFAULT_INSTRUMENT,
        price: this.series.bars[this.series.size - 1]?.close ?? null,
        precision: this.instrument?.pricePrecision ?? 2,
      }),
      // A window rule sums a bar, so only intervals with a fixed span can be offered.
      windows: () => TIMEFRAMES.filter((def) => def.ms !== null).map((def) => def.key),
      popups: () => this.notifier.grant,
      onAskPermission: () => this.notifier.ask(),
      onCreate: async (payload) => {
        const created = await api.createAlert(payload);
        await this.refreshAlerts();
        return `${created.instrument} rule saved. ${conditionText(created, this.instrument?.pricePrecision ?? 2)}.`;
      },
      onEdit: async (id, payload) => {
        await api.updateAlert(id, payload);
        await this.refreshAlerts();
        return 'Rule saved. It waits for a fresh crossing before it answers again.';
      },
      onToggle: (alert, enabled) => void this.patchAlert(alert, { enabled }),
      onMute: (alert, muted) => void this.patchAlert(alert, { muted }),
      onDelete: (alert) => void this.removeAlert(alert),
      onClearHistory: () => void this.clearAlertHistory(),
      time: (ms) => this.local.format(ms, 'dateTime'),
    });

    // The palette sits left of the panes, the way the shipped tool sidebar does.
    const chartArea = stackEl.parentElement;
    this.rail = new ToolRail({
      onPick: (toolId) => this.pickTool(toolId),
      onManage: () => this.drawingDialog.toggle(),
    });
    if (chartArea) chartArea.insertBefore(this.rail.node, stackEl);

    this.topbar = new Topbar(topbarEl, {
      onSearch: () => this.search.show(this.instrument?.display ?? ''),
      onTimeframe: (key) => void this.setTimeframe(key),
      onStyle: (style) => this.setStyle(style),
      onScaleMode: (mode) => this.setScaleMode(mode),
      onToggle: (id, on) => this.togglePane(id, on),
      onFit: () => this.fitAll(),
      onHome: () => this.goHome(),
      onResetScale: () => this.autoScale(),
      onIndicators: () => this.indicatorDialog.toggle(),
      onAlerts: () => this.openAlerts(),
      onFootprintSettings: () => this.footprintDialog.toggle(),
      onSettings: () => this.settingsDialog.toggle(),
      onBackup: () => this.settingsDialog.showPage('backup'),
      onShortcuts: () => this.shortcutDialog.toggle(),
    });
    this.topbar.addPaneToggles([
      { id: 'volume', label: 'Volume' },
      { id: 'footprint', label: 'Footprint' },
      { id: 'profile', label: 'Profile' },
      { id: 'ladder', label: 'Depth' },
      { id: 'sidebar', label: 'Watchlist' },
    ]);
    this.topbar.setIntervals(TIMEFRAMES, this.timeframe);

    this.ladder = new DepthLadder(ladderEl);
    this.status = new StatusStrip(statusEl);

    this.watchlist = new Watchlist(sidebarEl, {
      onOpen: (id) => void this.setInstrument(id),
      onRemove: (id) => this.removeWatch(id),
      onSearch: () => this.search.show(''),
    });

    this.search = new SymbolSearch(backdrop, {
      onOpen: (instrument) => void this.setInstrument(instrument.id),
      onWatch: (instrument) => void this.addWatch(instrument),
    });

    this.stack.add({ id: 'price', weight: this.state.weights.price ?? 3.2, minPx: 160, draw: (ctx, frame) => this.pricePane.draw(ctx, frame, this.decor) });
    this.stack.add({ id: 'volume', weight: this.state.weights.volume ?? 1, minPx: 84, draw: (ctx, frame) => this.volumePane.draw(ctx, frame) });
    this.stack.add({ id: 'footprint', weight: this.state.weights.footprint ?? 1.6, minPx: 140, draw: (ctx, frame) => this.footprintPane.draw(ctx, frame) });
    this.stack.add({ id: 'profile', weight: this.state.weights.profile ?? 1.2, minPx: 120, draw: (ctx, frame) => this.profilePane.draw(ctx, frame) });
    // Dragging a splitter is an explicit instruction about heights: from then on the user's
    // own weights rule and the price pane no longer reserves its minimum share.
    this.stack.enableSplitters(() => {
      this.state.weightsCustomized = true;
      this.persist();
    });

    this.bindPointer(stackEl);
    this.bindKeyboard();
    this.bindWindow();

    this.live = new LiveClient({
      onMessage: (message) => this.onLiveMessage(message),
      onPhase: (phase, detail) => this.onFeedPhase(phase, detail),
      onBeat: () => this.markDirty(),
    });
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    let restored: WorkspaceState | null = null;
    try {
      restored = await this.workspace.load();
    } catch (error) {
      this.status.setError(`workspace unavailable: ${errorMessage(error)}`);
    }
    if (restored) this.state = restored;
    // A workspace that has never saved a zoom of its own has no barStep, so the first frame
    // picks one: the newest DEFAULT_VISIBLE_BARS bars at a readable density.
    this.defaultViewPending = this.state.view.barStep === undefined;
    this.applyStateToControls();

    void this.refreshCoverage();
    // Rules and their history come from the server, so a page opened hours after a fire
    // still shows what fired while it was shut. The same cadence keeps a rule's crossing
    // state honest: the push says a rule fired, only the server knows when it re-armed.
    void this.refreshAlerts();
    window.setInterval(() => {
      void this.refreshCoverage();
      void this.refreshAlerts();
    }, 20_000);

    const instrumentId = this.state.instrument ?? DEFAULT_INSTRUMENT;
    await this.setInstrument(instrumentId, false);
    if (this.state.watchlist.length === 0 && this.instrument) await this.addWatch(this.instrument, false);
    for (const id of this.state.watchlist) {
      const meta = await api.instrument(id).catch(() => null);
      if (meta) await this.addWatch(meta, false);
    }

    this.live.start();
    // Inspection handle: the console and automated checks read live view state here.
    // SAFETY: `window` has no `chartkit` property, and this write installs one; no
    // other script owns that name on the page.
    (window as unknown as { chartkit: unknown }).chartkit = {
      view: this.view,
      series: this.series,
      instrument: () => this.instrument?.id ?? null,
      hover: () => this.hover,
      /** The tape the price pane paints: stored bars, or their Heikin Ashi transform. */
      seriesStyle: () => this.pricePane.style,
      displayBars: (from: number, to: number) =>
        this.pricePane.displayed(this.series.bars).slice(Math.max(0, from), to + 1),
      frame: () => {
        const x = this.frameX;
        if (!x) return null;
        const range = x.visibleRange();
        return {
          barStep: x.barStep,
          offsetFromEnd: this.view.offsetFromEnd,
          count: this.series.size,
          first: range.first,
          last: range.last,
          firstStart: this.series.bars[range.first]?.start ?? null,
          lastStart: this.series.bars[range.last]?.start ?? null,
          roundTrip: [0, 17, 93, this.series.size - 1].map((i) => +x.toIndex(x.toX(i)).toFixed(6)),
          askIndexAt: x.indexAt(300),
        };
      },
      indicators: () => {
        const visible = this.frameX?.visibleRange() ?? { first: -1, last: -1 };
        return this.indicators.instances.map((instance) => {
          const result = this.indicatorResults.get(instance.id);
          const series = result?.plots.map((plot) => {
            let index = plot.values.length - 1;
            while (index >= 0 && !Number.isFinite(plot.values[index] ?? Number.NaN)) index -= 1;
            return {
              label: plot.label,
              color: plot.color,
              index,
              value: index >= 0 ? (plot.values[index] ?? null) : null,
              /** Computed values across the bars in view, aligned with `indicatorFlow().sample`. */
              values: visible.last >= visible.first
                ? plot.values.slice(visible.first, visible.last + 1).map((value) => (Number.isFinite(value) ? value : null))
                : [],
              covered: plot.values.reduce((count, value) => (Number.isFinite(value) ? count + 1 : count), 0),
            };
          });
          return {
            id: instance.id,
            indicatorId: instance.indicatorId,
            placement: this.indicators.definitionOf(instance)?.placement ?? null,
            params: instance.params,
            caption: result?.caption ?? null,
            note: result?.note ?? null,
            /** Script text and last failure, present only on a user indicator. */
            script: instance.script ?? null,
            error: this.indicators.scriptError(instance.id),
            series: series ?? [],
          };
        });
      },
      drawings: () =>
        this.drawings.instances.map((instance) => ({
          id: instance.id,
          toolId: instance.toolId,
          anchors: instance.anchors.map((anchor) => ({ time: anchor.time, price: anchor.price })),
          style: { ...instance.style },
          locked: instance.locked === true,
        })),
      drawingTool: () => this.drawingController.toolId,
      selectedDrawing: () => this.drawings.selectedId,
      /** Paint order, bottom first: the last id is the one on top. */
      drawingOrder: () => this.drawings.instances.map((instance) => instance.id),
      drawingMenu: () => ({ open: this.drawingMenu.isOpen(), target: this.drawingMenu.targetId() }),
      recentTools: () => this.state.recentTools.slice(),
      /** Pane-local pixel of one anchor, so a check can aim a right-click at a drawing. */
      pixelFor: (instanceId: string, index: number) => {
        const env = this.toolEnv();
        const instance = this.drawings.find(instanceId);
        if (!env || !instance) return null;
        const pixel = this.drawings.pixelsFor(instance, env)[index];
        return pixel ? { x: pixel.x, y: pixel.y } : null;
      },
      hoveredDrawing: () => this.drawings.hoveredId,
      /** Undo and redo stacks, oldest label first. Session state: never written to the document. */
      undoStack: () => this.history.labels('undo'),
      redoStack: () => this.history.labels('redo'),
      undo: () => this.history.undo(),
      redo: () => this.history.redo(),
      /** Price under a pane-local y, read from the scale the last frame actually drew. */
      priceAt: (y: number) => this.framePrice?.fromY(y) ?? null,
      plotRect: () => {
        const env = this.toolEnv();
        return env ? { left: env.plot.left, right: env.plot.right, top: env.plot.top, bottom: env.plot.bottom } : null;
      },
      /** Rules and fires as the server has them, plus what the browser allows for popups. */
      alerts: () => ({
        fetched: this.alertsFetched,
        open: this.alertsDialog.isOpen(),
        tab: this.alertsDialog.openTab(),
        grant: this.notifier.grant,
        unseen: this.unseenFires,
        rules: this.alertRules.map((rule) => ({
          id: rule.id,
          instrument: rule.instrument,
          kind: rule.kind,
          threshold: rule.threshold,
          timeframe: rule.timeframe ?? null,
          enabled: rule.enabled,
          muted: rule.muted,
          armed: rule.armed,
          lastFiredAt: rule.lastFiredAt ?? null,
        })),
        fires: this.alertFires.map((fire) => ({
          id: fire.id,
          alertId: fire.alertId,
          instrument: fire.instrument,
          kind: fire.kind,
          value: fire.value,
          ts: fire.ts,
          missed: fire.missed,
          muted: fire.muted,
        })),
      }),
      priceTick: () => this.instrument?.priceTick ?? null,
      paneIds: () => this.stack.visibleHosts().map((host) => host.id),
      /** Box the price-pane legend claims, so a check can prove no other text lands in it. */
      legendRect: () => this.pricePane.legendBox(),
      /** Right-edge labels standing in for values the legend row had no room for. */
      legendValueTags: () => this.pricePane.valueTagRects(),
      indicatorScales: () =>
        [...this.indicatorPanes.values()].map((pane) => ({
          kind: pane.currentDefinition.id,
          ...pane.debugScale(),
        })),
      /** Print window the delta indicators compute from: what loaded, and what it covers. */
      indicatorFlow: () => {
        const flow = this.flowInput();
        return {
          wanted: this.needsPrintFlow(),
          requested: this.flowRequested,
          loading: this.flowLoading,
          key: this.flowKey,
          error: this.flowError,
          bars: flow?.byStart.size ?? 0,
          prints: flow?.prints ?? 0,
          coveredFrom: flow?.coveredFrom ?? null,
          coveredTo: flow?.coveredTo ?? null,
          /** Bar starts in view paired with the flow the indicator saw, newest last. */
          sample: this.series.bars
            .slice(Math.max(0, (this.frameX?.visibleRange().first ?? 0)), (this.frameX?.visibleRange().last ?? -1) + 1)
            .map((bar) => ({ start: bar.start, flow: flow?.byStart.get(bar.start) ?? null })),
        };
      },
      footprintSettings: () => this.state.footprint,
      footprintDebug: () => this.footprintPane.debugInfo,
      footprintDialogOpen: () => this.footprintDialog.isOpen(),
      footprintBars: () => this.footprintPane.data?.bars.length ?? 0,
      /** Profile pane: the window it fetched, the levels it was given, and the rows it drew. */
      profileWindow: () => this.profilePane.window,
      profileDebug: () => this.profilePane.debugInfo,
      profileError: () => this.profilePane.error,
      footprintLast: () => {
        const bars = this.footprintPane.data?.bars;
        const bar = bars?.[bars.length - 1];
        return bar ? { start: bar.start, trades: bar.trades, cells: bar.cells.length, poc: bar.poc, delta: bar.delta } : null;
      },
      watchlist: () => this.watchEntries.map((entry) => entry.instrument.id),
      /** Settings exactly as the document holds them. */
      settings: () => ({ ...this.state.settings }),
      settingsDialogOpen: () => this.settingsDialog.isOpen(),
      shortcutsDialogOpen: () => this.shortcutDialog.isOpen(),
      /** The axis clock: the zone it resolved to, and the labels and divider it draws. */
      axisClock: () => this.axisClockFor(),
      /** Labelled price ticks at the current density, and the density limits in force. */
      priceTicks: () => this.framePrice?.ticks().length ?? 0,
      density: () => ({ minBarStep: this.view.minBarStep, visibleBars: this.view.defaultVisibleBars, barStep: this.view.barStep }),
      /** The latency estimate the status strip shows. */
      latency: () => this.live.latencySample,
      /** Saved chart templates, newest first. */
      templates: () =>
        this.state.templates.map((template) => ({
          name: template.name,
          indicators: template.indicators.length,
          style: template.seriesStyle,
          autoFit: template.view.autoFit ?? true,
          manualMin: template.view.manualMin ?? null,
          manualMax: template.view.manualMax ?? null,
          barStep: template.view.barStep ?? null,
        })),
      openSettings: () => this.settingsDialog.show(),
      openShortcuts: () => this.shortcutDialog.show(),
      /** The page the settings dialog is showing, or null while it is closed. */
      settingsPage: () => this.settingsDialog.openPageLabel(),
      /** The document exactly as the save path would write it, so a check can hold it next to a file. */
      document: () => this.collectState(),
      /** The workspace file's text: the bytes the export button hands the browser. */
      exportWorkspaceFile: () => serialiseWorkspaceFile(buildWorkspaceFile(this.collectState())),
      /** Validates a workspace file without applying it, and reports what it holds or why it failed. */
      readWorkspaceFile: (text: string) => {
        const read = readWorkspaceFile(text);
        return read.ok ? { ok: true, summary: read.summary } : read;
      },
      /** Applies a workspace file through the same path the Backup page's confirm button takes. */
      importWorkspaceFile: (text: string) => this.importWorkspaceText(text),
      /** The span the bars in view cover, the numbers the prints range prefills from. */
      visibleTimeRange: () => this.visibleTimeRange(),
    };
    requestAnimationFrame((time) => this.frame(time));
  }

  /** True until a first view has been chosen for a workspace that saved no zoom. */
  private defaultViewPending = false;

  private applyStateToControls(): void {
    this.timeframe = this.state.timeframe;
    this.footprintPane.settings = this.state.footprint;
    this.profilePane.settings = this.state.footprint;
    this.pricePane.style = this.state.seriesStyle;
    // Density and clock before the stored view: the stored zoom is clamped against the
    // stored floor, and it has to be clamped against the one the same document carries.
    this.applySettings(this.state.settings, { frameView: false });
    this.view.restore(this.state.view);
    this.stack.restoreWeights(this.state.weights);
    this.stack.setAutoPriceShare(this.state.weightsCustomized !== true);
    this.indicators.setInstances(this.state.indicators);
    this.drawings.setInstances(this.state.drawings);
    // A freshly loaded document owns a different past: the steps recorded against the old
    // one are session state, and stale ones would undo into a chart that no longer exists.
    this.history.clear();
    this.syncIndicatorPanes();
    this.topbar.setTimeframe(this.timeframe);
    this.topbar.setStyle(this.pricePane.style);
    this.topbar.setScaleMode(this.view.priceMode);
    this.applyPaneVisibility();
  }

  /** Pushes `state.panes` into the stack, the top bar and the shell grid. */
  private applyPaneVisibility(): void {
    for (const id of [...STACK_PANES, 'ladder', 'sidebar']) {
      const on = this.state.panes[id] !== false;
      if (STACK_PANES.includes(id)) this.stack.setVisible(id, on);
      this.topbar.setPaneOn(id, on);
      this.applyShellLayout(id, on);
    }
  }

  private applyShellLayout(id: string, on: boolean): void {
    const app = document.getElementById('app');
    if (!(app instanceof HTMLElement)) return;
    if (id === 'sidebar') app.classList.toggle('no-sidebar', !on);
    if (id === 'ladder') app.classList.toggle('no-ladder', !on);
  }

  // ---------------------------------------------------------------- data paths

  private async refreshCoverage(): Promise<void> {
    try {
      this.coverage = await api.coverage();
      this.status.setCoverage(this.coverage);
      this.status.setError(null);
    } catch (error) {
      this.status.setError(`server unreachable: ${errorMessage(error)}`);
    }
  }

  async setInstrument(id: string, persist = true): Promise<void> {
    if (!id) return;
    const meta = await api.instrument(id).catch(() => null);
    this.instrument = meta ?? stubInstrument(id);
    this.status.setInstrumentVenue(this.instrument.venue);
    // The venue's own zone is only one option: the axis clock follows the timezone setting,
    // which defaults to UTC and offers the venue as `exchange`.
    this.local = new LocalTime(resolveZone(this.state.settings, this.instrument.session.timezone));
    this.decor = { gaps: [], session: [] };
    this.ladder.setInstrument(this.instrument);
    this.footprintPane.reset();
    this.profilePane.reset();
    this.resetFlow();
    this.topbar.setInstrument(this.instrument);
    this.state.instrument = this.instrument.id;
    this.view.restore(this.state.view);
    this.markDirty();
    if (persist) this.persist();

    try {
      await this.series.load(this.instrument.id, this.timeframe, this.initialBarLimit);
      this.errorFromSeries();
    } catch (error) {
      this.status.setError(`bars unavailable: ${errorMessage(error)}`);
    }
    this.subscribeLive();
    this.reportSeriesState();
    this.markDirty();
  }

  async setTimeframe(key: string): Promise<void> {
    if (!key || key === this.timeframe) return;
    this.timeframe = key;
    this.state.timeframe = key;
    this.topbar.setTimeframe(key);
    this.footprintPane.reset();
    this.profilePane.reset();
    this.resetFlow();
    if (this.instrument) {
      try {
        await this.series.load(this.instrument.id, key, this.initialBarLimit);
        this.errorFromSeries();
      } catch (error) {
        this.status.setError(`bars unavailable: ${errorMessage(error)}`);
      }
      this.subscribeLive();
    }
    this.reportSeriesState();
    this.markDirty();
    this.persist();
  }

  private subscribeLive(): void {
    const instrument = this.instrument;
    if (!instrument) return;
    this.live.unsubscribe(this.previousSymbol);
    this.previousSymbol = instrument.symbol;
    this.live.subscribe(instrument.symbol, this.timeframe);
  }

  private previousSymbol = '';

  private errorFromSeries(): void {
    if (this.series.error) this.status.setError(this.series.error);
    else this.status.setError(null);
  }

  private reportSeriesState(): void {
    const range = this.frameX?.visibleRange();
    this.status.setSeries({
      loaded: this.series.size,
      visible: this.series.size === 0 || !range ? 0 : Math.max(0, range.last - range.first + 1),
      loadingOlder: this.series.loadingOlder,
      olderExhausted: this.series.olderExhausted,
    });
  }

  setStyle(style: SeriesStyle): void {
    this.pricePane.style = style;
    this.state.seriesStyle = style;
    this.topbar.setStyle(style);
    this.markDirty();
    this.persist();
  }

  setScaleMode(mode: PriceScaleMode): void {
    this.view.setMode(mode);
    this.state.view.priceMode = mode;
    this.topbar.setScaleMode(mode);
    this.markDirty();
    this.persist();
  }

  togglePane(id: string, on: boolean): void {
    if (STACK_PANES.includes(id)) this.stack.setVisible(id, on);
    else this.applyShellLayout(id, on);
    this.state.panes[id] = on;
    this.topbar.setPaneOn(id, on);
    this.markDirty();
    this.persist();
  }

  fitAll(): void {
    const host = this.stack.hostFor('price');
    const width = host?.width ?? 800;
    this.view.fitAll(this.series.size, width - PRICE_AXIS_WIDTH - PLOT_PADDING_LEFT);
    this.markDirty();
    this.persist();
  }

  goHome(): void {
    this.view.home(this.series.size);
    this.markDirty();
    this.persist();
  }

  /** What the axis clock is doing: its zone and offset, and the labels and divider it draws. */
  private axisClockFor(): {
    zone: string;
    offsetMinutes: number;
    labels: string[];
    legendTime: string | null;
    dividerX: number[];
  } {
    const x = this.frameX;
    const newest = this.series.bars[this.series.size - 1];
    return {
      zone: this.local.timeZone,
      offsetMinutes: Math.round(this.local.offsetFor(Date.now()) / 60_000),
      labels: (x?.timeTicks() ?? []).map((tick) => tick.label),
      legendTime: newest ? this.local.format(newest.start, 'dateTime') : null,
      dividerX: x ? this.decor.session.map((segment) => Math.round(x.toX(segment.index) - x.barStep / 2)).filter((px) => px >= 0) : [],
    };
  }

  autoScale(): void {
    this.view.restoreAutoFit();
    this.state.view.autoFit = true;
    this.markDirty();
    this.persist();
  }

  // ---------------------------------------------------------------- settings

  /**
   * Merges a settings patch and re-normalises the result, so a typed zone or a typed density
   * lands inside the range the panes can draw. Changing the framing target re-frames the
   * chart at once, which is how the control shows its effect without a reload.
   */
  private patchSettings(patch: Partial<ChartSettings>): void {
    let merged: ChartSettings = { ...this.state.settings, ...patch };
    // A theme switch re-inks the colours the theme owns; a colour picked by hand afterwards
    // is its own setting and survives the next change.
    if (patch.theme !== undefined && patch.theme !== this.state.settings.theme) merged = applyThemeColours(merged);
    const settings = normaliseSettings(merged);
    this.state.settings = settings;
    this.applySettings(settings, { frameView: patch.visibleBars !== undefined });
    this.markDirty();
    this.persist();
  }

  /**
   * Hands every renderer that holds a copy of a setting its new value. The palette is the
   * only one the panes read directly, so an appearance change needs no pane to be rebuilt.
   */
  private applySettings(settings: ChartSettings, flags: { frameView: boolean }): void {
    applyAppearance(settings);
    this.view.setDensity(settings.minBarStep, settings.visibleBars, this.series.size);
    this.pricePane.showSessionDivider = settings.showSessionDivider;
    this.pricePane.showLegend = settings.showLegend;
    const zone = resolveZone(settings, this.instrument?.session.timezone);
    // Session boundaries are worked out on the axis clock, so a new zone means new segments.
    if (zone !== this.local.timeZone) {
      this.decorKey = '';
      this.local = new LocalTime(zone);
    }
    if (flags.frameView && this.series.size >= 2) this.view.applyDefaultView(this.series.size, this.view.plotWidth);
  }

  /**
   * Saves the current view as a named template: settings, series, zoom, a price range framed
   * by hand, indicators with their parameters, and the open panes at their heights. Drawings,
   * the symbol and the interval stay out, so one template fits any chart.
   */
  private saveTemplate(name: string): void {
    const trimmed = name.trim().slice(0, 48);
    if (!trimmed) return;
    this.state.view = { ...this.state.view, ...this.view.serialize() };
    this.state.weights = this.stack.weights();
    const template: ChartTemplate = {
      name: trimmed,
      settings: { ...this.state.settings },
      seriesStyle: this.pricePane.style,
      view: { ...this.state.view },
      panes: { ...this.state.panes },
      weights: { ...this.state.weights },
      weightsCustomized: this.state.weightsCustomized,
      indicators: structuredClone(this.indicators.instances),
    };
    const rest = this.state.templates.filter((entry) => entry.name !== trimmed);
    this.state.templates = [template, ...rest].slice(0, MAX_TEMPLATES);
    this.persist();
  }

  /** Puts a saved template back: the same paths a workspace reload takes, without the symbol. */
  private applyTemplate(name: string): void {
    const template = this.state.templates.find((entry) => entry.name === name);
    if (!template) return;
    this.state.settings = { ...template.settings };
    this.state.panes = { ...this.state.panes, ...template.panes };
    this.state.weights = { ...template.weights };
    this.state.weightsCustomized = template.weightsCustomized;
    this.state.seriesStyle = template.seriesStyle;
    this.applySettings(template.settings, { frameView: false });
    // `setStyle` persists, and persist rewrites `state.view` from the live view, so the saved
    // zoom, scale and framed range go back after it rather than before.
    this.setStyle(template.seriesStyle);
    this.view.restore(template.view);
    this.state.view = { ...this.state.view, ...this.view.serialize() };
    this.stack.restoreWeights(this.state.weights);
    this.stack.setAutoPriceShare(this.state.weightsCustomized !== true);
    this.applyPaneVisibility();
    // The indicators a template carries are a chart change like any other, so undo walks
    // back over them instead of leaving the trader with a set no key press can remove.
    this.history.transact('indicators', null, 'apply template', () => this.indicators.setInstances(structuredClone(template.indicators)));
    this.syncIndicatorPanes();
    if (this.indicatorDialog.isOpen()) this.indicatorDialog.refresh();
    if (this.settingsDialog.isOpen()) this.settingsDialog.refresh();
    this.markDirty();
    this.persist();
  }

  // ---------------------------------------------------------------- indicators

  private addIndicator(indicatorId: string): void {
    this.history.transact('indicators', null, 'add indicator', () => this.indicators.add(indicatorId));
    this.syncIndicatorPanes();
    this.markDirty();
    this.persist();
  }

  /**
   * Adds a user indicator from the source the script dialog settled on: kscript typed or
   * pasted as it stands, Pine already converted.
   */
  private addScriptIndicator(source: string): string | null {
    const instance = this.history.transact('indicators', null, 'add indicator', () => this.indicators.addScript(source));
    if (!instance) return null;
    this.syncIndicatorPanes();
    this.markDirty();
    this.persist();
    return instance.id;
  }

  private removeIndicator(instanceId: string): void {
    this.history.transact('indicators', null, 'remove indicator', () => this.indicators.remove(instanceId));
    this.syncIndicatorPanes();
    this.markDirty();
    this.persist();
  }

  /**
   * Keeps one pane per offchart instance, stacked directly under the price pane in
   * the order they were added. Overlays need no pane: the price pane draws them.
   */
  private syncIndicatorPanes(): void {
    const wanted = this.indicators.instances.filter((instance) => this.indicators.definitionOf(instance)?.placement === 'offchart');
    const live = new Set(wanted.map((instance) => instance.id));
    for (const [id, pane] of this.indicatorPanes) {
      if (live.has(id)) continue;
      this.stack.remove(pane.paneId);
      this.indicatorPanes.delete(id);
    }
    wanted.forEach((instance) => {
      const definition = this.indicators.definitionOf(instance);
      if (!definition) return;
      const existing = this.indicatorPanes.get(instance.id);
      // A script's title, guide levels and fixed range come from its text, so a pane has
      // to follow the text the moment a declaration is re-read.
      if (existing) existing.refreshDefinition(definition);
      if (existing || !definition) return;
      const pane = new IndicatorPane(instance.id, definition);
      const weight = this.state.weights[pane.paneId] ?? INDICATOR_PANE_WEIGHT;
      // New panes join at the end of the indicator block, so add order survives removals.
      this.stack.add({ id: pane.paneId, weight, minPx: INDICATOR_PANE_MIN_PX, draw: (ctx, frame) => pane.draw(ctx, frame, this.indicatorResults.get(instance.id)) }, this.indicatorPanes.size + 1);
      this.indicatorPanes.set(instance.id, pane);
    });
  }

  // ---------------------------------------------------------------- drawings

  /** One style edit, coalesced per field so a slider sweep stays one undo step. */
  private styleDrawing(instanceId: string, patch: StyleValues): void {
    this.history.transact('drawings', `drw:style:${instanceId}:${Object.keys(patch).join('+')}`, 'drawing style', () =>
      this.drawings.setStyle(instanceId, patch),
    );
  }

  /** Removing a drawing is a step of its own: undo has to bring it back whole. */
  private deleteDrawing(instanceId: string): void {
    this.history.transact('drawings', null, 'delete drawing', () => this.drawings.remove(instanceId));
    this.markDirty();
    this.persist();
  }

  /**
   * Something outside the normal edit paths moved the chart back or forward: the panes a
   * script declares, the open settings forms and the stored document all have to follow.
   */
  private afterHistoryRestore(kind: HistoryKind): void {
    if (kind === 'indicators') {
      this.syncIndicatorPanes();
      if (this.indicatorDialog.isOpen()) this.indicatorDialog.refresh();
      // The template list counts the indicators on the chart, so it follows an undo too.
      if (this.settingsDialog.isOpen()) this.settingsDialog.refresh();
    } else {
      if (this.drawingDialog.isOpen()) this.drawingDialog.refresh();
      if (this.drawingMenu.isOpen()) this.drawingMenu.refresh();
    }
    this.markDirty();
    this.persist();
  }

  /** Arming a tool is a toggle: picking the armed one again hands the pointer back to the chart. */
  private pickTool(toolId: string): void {
    if (!toolById(toolId)) return;
    const arming = this.drawingController.toolId !== toolId;
    this.drawingController.setTool(arming ? toolId : null);
    this.rail.setActive(this.drawingController.toolId);
    if (arming) this.rememberTool(toolId);
    this.markDirty();
  }

  /** Keeps the tools a session actually uses at the top of the right-click menu. */
  private rememberTool(toolId: string): void {
    const rest = this.state.recentTools.filter((id) => id !== toolId);
    this.state.recentTools = [toolId, ...rest].slice(0, TOOL_CHOICES);
    this.persist();
  }

  /**
   * Geometry environment for the drawing layer: the price pane's current scales, plot
   * rect and text metrics, taken from the frame that was last rendered so a placed
   * price is the price the cursor was pointing at on screen.
   */
  private toolEnv(): ToolEnv | null {
    const x = this.frameX;
    const price = this.framePrice;
    if (!x || !price) return null;
    const host = this.stack.visibleHosts().find((entry) => entry.id === 'price') ?? this.stack.visibleHosts()[0];
    if (!host) return null;
    const ctx = host.ctx;
    return {
      x,
      price,
      priceTick: this.instrument?.priceTick ?? 0.01,
      ctx,
      plot: pricePlot(host.width, host.height, host.axisBottom, TIME_AXIS_HEIGHT),
      instrument: this.instrument,
      bars: this.series.bars,
      local: this.local,
      measure: (text, font) => measureText(ctx, text, font),
    };
  }

  /**
   * A placed note opens its style form, since its text has to be typed somewhere. Every
   * other tool stays armed so the next drawing can be placed immediately.
   */
  /** Opens one undo step for the drawing gesture the pointer just started. */
  private beginGestureStep(): void {
    const target = this.drawingController.gestureTarget();
    if (!target) return;
    this.openGestureKey = target.key;
    this.history.begin('drawings', target.key, target.label);
  }

  /**
   * Closes it. `dropped` is the Esc path, where the controller already put the drawing
   * back: the step is thrown away instead of recorded.
   */
  private endGestureStep(dropped = false): void {
    if (this.openGestureKey === null) return;
    this.openGestureKey = null;
    if (dropped) this.history.drop();
    else this.history.end();
    this.markDirty();
  }

  private afterPlace(placed: { id: string; toolId: string }): void {
    if (toolById(placed.toolId)?.opensEditorOnPlace) this.drawingDialog.showSettings(placed.id);
  }

  // ---------------------------------------------------------------- footprint

  /**
   * Merges a settings patch, re-normalises it so every value stays in range, and hands
   * the new object to the pane. The pane holds no settings of its own.
   */
  private patchFootprint(patch: Partial<FootprintSettings>): void {
    const merged = { ...this.state.footprint, ...patch };
    this.state.footprint = normaliseFootprintSettings(merged);
    this.footprintPane.settings = this.state.footprint;
    this.profilePane.settings = this.state.footprint;
    this.markDirty();
    this.persist();
  }

  // ---------------------------------------------------------------- watchlist

  async addWatch(instrument: Instrument, persist = true): Promise<void> {
    if (this.watchlist.has(instrument.id)) return;
    const entry: WatchEntry = { instrument, last: null, reference: null };
    this.watchEntries.push(entry);
    this.watchlist.setEntries(this.watchEntries);
    if (persist) this.persist();
    try {
      const response = await api.bars(instrument.id, this.timeframe, { limit: 900 });
      const bars = response.bars;
      const last = bars[bars.length - 1] ?? null;
      const reference = previousSessionClose(bars, instrument, new LocalTime(instrument.session.timezone || 'UTC'), Date.now());
      entry.last = last?.close ?? null;
      entry.reference = reference?.price ?? null;
      this.watchlist.setLast(instrument.id, entry.last);
      this.watchlist.setReference(instrument.id, entry.reference);
    } catch (error) {
      entry.last = null;
      this.watchlist.setLast(instrument.id, null);
      this.status.setError(`watchlist history unavailable for ${instrument.display}: ${errorMessage(error)}`);
    }
    this.watchlist.setActive(this.instrument?.id ?? null);
  }

  removeWatch(id: string): void {
    this.watchEntries = this.watchEntries.filter((entry) => entry.instrument.id !== id);
    this.watchlist.setEntries(this.watchEntries);
    this.watchlist.setActive(this.instrument?.id ?? null);
    this.persist();
  }

  // ---------------------------------------------------------------- live feed

  private onFeedPhase(phase: ConnectionPhase, detail: string): void {
    this.feedPhase = phase;
    this.feedDetail = detail;
    this.topbar.setConnection(phase, detail);
    this.status.setFeed(phase, detail, this.live.beatAt);
    if (phase === 'open') {
      this.subscribeLive();
      // A socket that dropped may have missed fires. The hub replays the recent ones, and
      // this fetch covers whatever is older than what it still holds.
      void this.refreshAlerts();
    }
  }

  private onLiveMessage(message: LiveMessage): void {
    switch (message.type) {
      case 'bar': {
        if (!this.instrument || message.instrument !== this.instrument.id || message.timeframe !== this.timeframe) return;
        const outcome = this.series.applyBar(message.bar);
        if (outcome === 'ignored') return;
        if (outcome === 'appended') {
          this.view.onBarAppended();
          this.view.clamp(this.series.size);
        }
        this.watchlist.patch(message.instrument, message.bar.close);
        this.decorKey = '';
        this.reportSeriesState();
        this.markDirty();
        return;
      }
      case 'trades': {
        const trade = message.trades[0];
        if (!trade) return;
        this.watchlist.patch(message.instrument, trade.price);
        if (this.instrument && message.instrument === this.instrument.id) {
          this.pendingDepth = this.pendingDepth ? { ...this.pendingDepth, ts: trade.ts } : null;
        }
        this.markDirty();
        return;
      }
      case 'alert': {
        // The server decided this one; the page lists it and, when the browser allows it,
        // pops up. Nothing is recomputed here.
        const { type, ...fire } = message;
        void type;
        this.absorbFire(fire, true);
        return;
      }
      case 'depth': {
        if (!this.instrument || message.instrument !== this.instrument.id) return;
        this.pendingDepth = message.snapshot;
        return;
      }
      case 'status': {
        // The server replays every remembered status when a socket opens, feed-wide and
        // per symbol. Only the feed-wide one describes venue health, so a symbol's
        // backfill state can never overwrite it; a named symbol can still report trouble
        // on the chart itself.
        const feedWide = message.instrument === null;
        const onScreen = !feedWide && message.instrument === this.instrument?.id;
        if (feedWide) this.status.setServerState(message.venue, message.state, message.detail);
        if (message.state === 'failed') {
          this.status.setError(message.detail || `${feedWide ? 'venue' : message.instrument} feed failed`);
        } else if (message.state === 'stalled' && (feedWide || onScreen)) {
          this.status.setError(message.detail || 'venue feed stalled');
        } else if (message.state === 'live' && (feedWide || onScreen)) {
          this.status.setError(null);
        }
        if (feedWide || onScreen) this.markDirty();
        return;
      }
      default:
        return;
    }
  }

  // ---------------------------------------------------------------- alerts

  /**
   * Re-reads the rules and the trigger history. The server is the authority: a fire that
   * lands while the fetch is in flight is kept, so the list never goes backwards.
   */
  private async refreshAlerts(): Promise<void> {
    try {
      const [rules, history] = await Promise.all([api.alerts(), api.alertHistory(undefined, 200)]);
      this.alertRules = parseAlerts(rules);
      this.alertFires = mergeFires(parseFires(history), this.alertFires);
      this.alertsFetched = true;
    } catch (error) {
      this.status.setError(`alerts unavailable: ${errorMessage(error)}`);
    }
    this.alertsDialog.refresh();
  }

  /**
   * One fire, from the socket or from history. Ids collapse the duplicates: a reconnect
   * replays what the hub still holds, and the next history read brings the same fires back.
   */
  private absorbFire(fire: AlertFire, live: boolean): void {
    if (this.alertFires.some((known) => known.id === fire.id)) return;
    this.alertFires = mergeFires(this.alertFires, [fire]);
    if (live) {
      // A fire means the rule is now waiting for the level to be given back. The push says
      // that much; only the next read tells when it armed up again.
      this.alertRules = this.alertRules.map((rule) =>
        rule.id === fire.alertId ? { ...rule, armed: false, lastFiredAt: fire.ts } : rule,
      );
      const precision = this.instrument?.pricePrecision ?? 2;
      // The list is written before the popup is tried, so a refused permission costs nothing
      // but the popup itself.
      this.notifier.notify(fire, `${fire.instrument} · ${conditionText(fire, precision)}`, fireValueText(fire, precision));
      if (!this.alertsDialog.isOpen()) {
        this.unseenFires += 1;
        this.topbar.setAlertCount(this.unseenFires);
      }
    }
    this.alertsDialog.refresh();
  }

  private openAlerts(): void {
    if (!this.alertsFetched) void this.refreshAlerts();
    this.alertsDialog.toggle();
    if (this.alertsDialog.isOpen()) {
      this.unseenFires = 0;
      this.topbar.setAlertCount(0);
    }
  }

  /** Sends a rule back with one field changed; the server takes the whole record. */
  private async patchAlert(alert: AlertRecord, patch: Partial<AlertPayload>): Promise<void> {
    const payload: AlertPayload = {
      instrument: alert.instrument,
      kind: alert.kind,
      threshold: alert.threshold,
      ...(alert.thresholdHigh === undefined ? {} : { thresholdHigh: alert.thresholdHigh }),
      ...(alert.timeframe === undefined ? {} : { timeframe: alert.timeframe }),
      rearmGap: alert.rearmGap,
      label: alert.label,
      enabled: alert.enabled,
      muted: alert.muted,
      ...patch,
    };
    try {
      await api.updateAlert(alert.id, payload);
      await this.refreshAlerts();
    } catch (error) {
      this.status.setError(`alert not saved: ${errorMessage(error)}`);
    }
  }

  private async removeAlert(alert: AlertRecord): Promise<void> {
    try {
      await api.deleteAlert(alert.id);
      await this.refreshAlerts();
    } catch (error) {
      this.status.setError(`alert not removed: ${errorMessage(error)}`);
    }
  }

  private async clearAlertHistory(): Promise<void> {
    try {
      await api.clearAlertHistory();
      this.alertFires = [];
      await this.refreshAlerts();
    } catch (error) {
      this.status.setError(`history not cleared: ${errorMessage(error)}`);
    }
  }

  // ---------------------------------------------------------------- interaction

  private bindPointer(stackEl: HTMLElement): void {
    stackEl.addEventListener('wheel', (event) => {
      event.preventDefault();
      const target = event.target;
      if (!(target instanceof HTMLCanvasElement)) return;
      const rect = target.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
      const count = this.series.size;
      if (event.shiftKey) {
        this.view.panPixels(event.deltaX * unit, count);
      } else {
        const factor = Math.exp(-event.deltaY * unit * 0.0016);
        this.view.zoomAt(x, factor, count, rect.width - PRICE_AXIS_WIDTH);
      }
      this.markDirty();
      this.persist();
    }, { passive: false });

    stackEl.addEventListener('pointermove', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLCanvasElement)) return;
      const paneId = target.parentElement instanceof HTMLElement ? (target.parentElement.dataset.pane ?? null) : null;
      const rect = target.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const env = paneId === 'price' ? this.toolEnv() : null;
      const onDrawing = env ? this.drawingController.pointerMove({ x, y }, env, event.shiftKey) : false;
      const drag = this.drag;
      if (!onDrawing && drag) {
        if (drag.kind === 'time') {
          this.view.offsetFromEnd = drag.startOffset - (event.clientX - drag.startX) / this.view.barStep;
          this.view.clamp(this.series.size);
        } else {
          this.view.dragPriceRange(event.clientY - drag.startY, drag.startRange);
        }
        drag.moved = true;
        this.markDirty();
        this.persist();
      }
      const xScale = this.frameX;
      if (!xScale) return;
      this.pointerOver = true;
      this.hover = {
        index: xScale.indexAt(x),
        x,
        y,
        paneId,
        inside: x < rect.width - PRICE_AXIS_WIDTH + PRICE_GUTTER_HIT,
      };
      const bars = this.series.bars;
      const bar = bars[this.hover.index];
      this.footprintPane.selectedStart = bar?.start ?? bars[bars.length - 1]?.start ?? null;
      const inGutter = x > rect.width - PRICE_AXIS_WIDTH && paneId === 'price';
      if (inGutter) target.style.cursor = 'ns-resize';
      // The shipped chart keeps the crosshair while a shape is being drawn and only
      // shows the grabbing hand once it has a drawing in hand.
      else if (this.drawingController.placing) target.style.cursor = 'crosshair';
      else if (this.drawingController.engaged) target.style.cursor = 'grabbing';
      else if (env) target.style.cursor = this.drawingController.cursorFor({ x, y }, env);
      else target.style.cursor = drag ? 'grabbing' : 'crosshair';
      this.markDirty();
    });

    stackEl.addEventListener('pointerdown', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLCanvasElement)) return;
      // Only the left button drags. The right button belongs to the context menu below, so
      // it can never start a tape pan, a placement or an anchor drag behind the menu's back.
      if (event.button !== 0) return;
      const rect = target.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const paneId = target.parentElement instanceof HTMLElement ? (target.parentElement.dataset.pane ?? null) : null;
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // The pointer may already be gone; dragging still works from window events.
      }
      const env = paneId === 'price' ? this.toolEnv() : null;
      if (env) {
        const outcome = this.drawingController.pointerDown({ x, y }, env);
        if (outcome.consumed) {
          // One undo step covers the whole press, however many moves it carries.
          this.beginGestureStep();
          // The gesture belongs to the drawing layer: no tape pan, no scale drag.
          this.drag = null;
          stackEl.focus({ preventScroll: true });
          this.markDirty();
          // A final anchor placed by a click ends the gesture here, so the save has to
          // happen now rather than waiting for a release that carries no change.
          if (this.drawingController.changed) {
            this.drawingController.changed = false;
            this.persist();
          }
          if (outcome.placed) this.afterPlace(outcome.placed);
          return;
        }
      }
      const scale = this.priceScaleFor(paneId, rect.height);
      this.drag = {
        kind: x > rect.width - PRICE_AXIS_WIDTH && paneId === 'price' ? 'price' : 'time',
        startX: event.clientX,
        startY: event.clientY,
        startOffset: this.view.offsetFromEnd,
        startRange: scale ? { min: scale.min, max: scale.max, height: scale.height } : { min: 0, max: 1, height: rect.height },
        moved: false,
      };
      stackEl.focus({ preventScroll: true });
    });

    const endDrag = () => {
      if (this.drag?.moved) this.persist();
      this.drag = null;
    };
    const finish = (event: PointerEvent) => {
      try {
        const target = event.target;
        if (target instanceof HTMLCanvasElement) {
          const paneId = target.parentElement instanceof HTMLElement ? (target.parentElement.dataset.pane ?? null) : null;
          const env = paneId === 'price' ? this.toolEnv() : null;
          if (env) {
            const rect = target.getBoundingClientRect();
            const outcome = this.drawingController.pointerUp(
              { x: event.clientX - rect.left, y: event.clientY - rect.top },
              env,
              event.shiftKey,
            );
            if (outcome.consumed) {
              this.markDirty();
              if (this.drawingController.changed) {
                this.drawingController.changed = false;
                this.persist();
              }
              if (outcome.placed) this.afterPlace(outcome.placed);
              return;
            }
          }
        }
        endDrag();
      } finally {
        // The release closes the step whatever path the pointer took to get here.
        this.endGestureStep();
      }
    };
    stackEl.addEventListener('pointerup', finish);
    stackEl.addEventListener('pointercancel', finish);
    stackEl.addEventListener('pointerleave', () => {
      this.hover = emptyHover();
      this.pointerOver = false;
      this.drawings.hoveredId = null;
      this.markDirty();
    });

    stackEl.addEventListener('dblclick', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLCanvasElement)) return;
      const rect = target.getBoundingClientRect();
      const paneId = target.parentElement instanceof HTMLElement ? (target.parentElement.dataset.pane ?? null) : null;
      if (paneId?.startsWith(INDICATOR_PANE_PREFIX)) {
        this.indicatorDialog.showSettings(paneId.slice(INDICATOR_PANE_PREFIX.length));
        return;
      }
      // The footprint pane has no header of its own, so a double-click opens its settings.
      if (paneId === 'footprint') {
        this.footprintDialog.toggle();
        return;
      }
      const env = paneId === 'price' ? this.toolEnv() : null;
      if (env) {
        const point: Pt = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        const hit = this.drawingController.hitId(point, env);
        if (hit) {
          this.drawings.selectedId = hit;
          this.drawingDialog.showSettings(hit);
          this.markDirty();
          return;
        }
      }
      if (event.clientX - rect.left > rect.width - PRICE_AXIS_WIDTH && paneId === 'price') this.autoScale();
      else this.fitAll();
    });

    // The right button selects and opens the menu; it never starts a gesture of its own.
    stackEl.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const target = event.target;
      if (!(target instanceof HTMLCanvasElement)) return;
      // Mid-gesture the gesture wins: a right press during a pan, a placement or an
      // anchor drag is ignored rather than stealing the pointer away from it.
      if (this.drag !== null || this.drawingController.engaged) return;
      const rect = target.getBoundingClientRect();
      const paneId = target.parentElement instanceof HTMLElement ? (target.parentElement.dataset.pane ?? null) : null;
      const env = paneId === 'price' ? this.toolEnv() : null;
      const point: Pt = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const hit = env ? this.drawingController.hitId(point, env) : null;
      // A right press selects, so the strip and the drawing it styles agree with the menu.
      this.drawings.selectedId = hit;
      this.markDirty();
      this.drawingMenu.openAt(event.clientX, event.clientY, hit);
    });
  }

  private bindKeyboard(): void {
    // Shortcuts are advertised in the status strip, so they work anywhere except while
    // typing or searching; the chart itself never needs to hold focus.
    window.addEventListener('keydown', (event) => {
      const active = document.activeElement;
      const typing =
        active instanceof HTMLInputElement || active instanceof HTMLSelectElement || active instanceof HTMLTextAreaElement;
      // Ctrl+/ opens the keyboard reference. It has to be read before the plain `/` that
      // opens symbol search, because `event.key` is `/` for both.
      if (event.key === '/' && (event.ctrlKey || event.metaKey) && !event.altKey) {
        event.preventDefault();
        this.shortcutDialog.toggle();
        return;
      }
      if (event.key === '/' && !this.search.isOpen() && !typing) {
        event.preventDefault();
        this.search.show(this.instrument?.display ?? '');
        return;
      }
      // `?` is Shift+/ on the same key, and it opens the settings dialog.
      if (event.key === '?' && !typing) {
        event.preventDefault();
        this.settingsDialog.toggle();
        return;
      }
      // Every dialog advertises Esc in its own footer, so Esc has to reach all of them.
      if (
        event.key === 'Escape' &&
        (this.search.isOpen() ||
          this.indicatorDialog.isOpen() ||
          this.drawingDialog.isOpen() ||
          this.footprintDialog.isOpen() ||
          this.settingsDialog.isOpen() ||
          this.shortcutDialog.isOpen() ||
          this.alertsDialog.isOpen() ||
          this.drawingMenu.isOpen())
      ) {
        this.search.close();
        this.indicatorDialog.close();
        this.drawingDialog.close();
        this.footprintDialog.close();
        this.settingsDialog.close();
        this.shortcutDialog.close();
        this.alertsDialog.close();
        this.drawingMenu.close();
        event.preventDefault();
        return;
      }
      // With no dialog open, Esc drops the drawing being placed, then disarms the tool.
      if (event.key === 'Escape' && this.drawingController.cancel()) {
        // A move or anchor drag Esc put back never becomes an undo step: the chart is where
        // it was, so the step the press opened is thrown away rather than recorded.
        this.endGestureStep(true);
        this.rail.setActive(this.drawingController.toolId);
        this.markDirty();
        event.preventDefault();
        return;
      }
      if ((event.key === 'i' || event.key === 'I') && !typing) {
        event.preventDefault();
        this.indicatorDialog.toggle();
        return;
      }
      if ((event.key === 'a' || event.key === 'A') && !typing) {
        event.preventDefault();
        this.openAlerts();
        return;
      }
      // Undo belongs to the chart, not to the control holding focus: a slider, a colour
      // swatch or a dropdown has no text to rewind. A caret keeps its own undo, so typing
      // in the script editor or the search box is untouched. The only other modified
      // binding is Ctrl+/, which opens the keyboard reference and cannot read as z or y.
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !holdsCaret(active)) {
        const key = event.key.toLowerCase();
        if (key === 'z' || key === 'y') {
          event.preventDefault();
          if (key === 'y' || event.shiftKey) this.history.redo();
          else this.history.undo();
          return;
        }
      }
      if (
        typing ||
        this.search.isOpen() ||
        this.indicatorDialog.isOpen() ||
        this.drawingDialog.isOpen() ||
        this.footprintDialog.isOpen() ||
        this.settingsDialog.isOpen() ||
          this.shortcutDialog.isOpen() ||
          this.alertsDialog.isOpen()
      )
        return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        const removed = this.history.transact('drawings', null, 'delete drawing', () => this.drawingController.deleteSelected());
        if (removed) {
          this.drawingMenu.close();
          event.preventDefault();
          this.persist();
          this.markDirty();
        }
        return;
      }
      // A modified press belongs to the browser or to a binding above, never to a chart key.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const count = this.series.size;
      const step = event.shiftKey ? 10 : 1;
      // The keys and what they do live in shortcuts.ts, which the keyboard reference renders
      // and the Node test compares against this handler.
      switch (PLAIN_KEY_ACTIONS[event.key]) {
        case 'panLeft':
          this.view.panBars(step, count);
          break;
        case 'panRight':
          this.view.panBars(-step, count);
          break;
        case 'zoomIn':
          this.view.zoomBy(1.25, count);
          break;
        case 'zoomOut':
          this.view.zoomBy(1 / 1.25, count);
          break;
        case 'home':
          this.view.home(count);
          break;
        case 'fitAll':
          this.fitAll();
          break;
        case 'toggleScale':
          this.setScaleMode(this.view.priceMode === 'log' ? 'linear' : 'log');
          break;
        default:
          return;
      }
      event.preventDefault();
      this.state.view = { ...this.state.view, ...this.view.serialize() };
      this.markDirty();
      this.persist();
    });

  }

  private bindWindow(): void {
    window.addEventListener('resize', () => this.markDirty());
    window.addEventListener('beforeunload', () => {
      this.state.view = { ...this.state.view, ...this.view.serialize() };
      this.state.weights = this.stack.weights();
      void this.workspace.flush();
    });
  }

  private priceScaleFor(paneId: string | null, height: number): PriceScale | null {
    if (paneId !== 'price') return null;
    const bottom = height - (STACK_PANES.some((id) => this.stack.isVisible(id)) ? 0 : TIME_AXIS_HEIGHT);
    const target = this.view.autoFit ? this.autoTarget() : null;
    const range = target ?? { min: this.view.manualMin, max: this.view.manualMax };
    return new PriceScale({
      mode: this.view.priceMode,
      min: range.min,
      max: range.max,
      top: 0,
      bottom: Math.max(1, bottom),
      precision: this.instrument?.pricePrecision ?? 2,
      tickPx: TICK_PITCH_PX[this.state.settings.priceTickStyle],
    });
  }

  private autoTarget(): { min: number; max: number } | null {
    const x = this.frameX;
    if (!x) return null;
    const { first, last } = x.visibleRange();
    return this.series.rangeIn(first, last);
  }

  // ---------------------------------------------------------------- draw loop

  private markDirty(): void {
    this.dirty = true;
  }

  private frame(_time: number): void {
    requestAnimationFrame((next) => this.frame(next));
    if (this.stack.syncDpr()) this.dirty = true;

    const now = Date.now();
    if (this.pendingDepth) {
      const snapshot = this.pendingDepth;
      this.pendingDepth = null;
      this.ladder.update(snapshot);
    }
    this.ladder.flush(now);

    if (this.dirty) {
      this.dirty = false;
      this.render(now);
    }
    if (now - this.lastStatusTick > 1_000) {
      this.lastStatusTick = now;
      this.status.tick(now);
      this.status.setFeed(this.feedPhase, this.feedDetail, this.live.beatAt);
      this.status.setLatency(this.state.settings.showLatency, this.live.latencySample, this.state.settings.latencyAlertMs);
    }
  }

  private render(now: number): void {
    const hosts = this.stack.visibleHosts();
    if (hosts.length === 0) return;
    const bars = this.series.bars;
    const count = bars.length;
    const width = Math.max(...hosts.map((host) => host.width));
    const left = PLOT_PADDING_LEFT;
    const right = width - PRICE_AXIS_WIDTH;
    // The pan limits depend on how many bars fit, so the renderer keeps the view informed.
    this.view.setViewport(right - left);
    this.view.clamp(count);
    if (this.defaultViewPending && count >= 2 && right > left) {
      this.view.applyDefaultView(count, right - left);
      this.defaultViewPending = false;
    }

    this.ensureDecor(bars);
    this.indicatorResults = this.indicators.results(bars, this.flowInput());
    this.overlays = this.indicators.instances.flatMap((instance) => {
      const definition = this.indicators.definitionOf(instance);
      const result = this.indicatorResults.get(instance.id);
      if (!definition || !result || definition.placement !== 'onchart') return [];
      return [{ name: definition.short, caption: result.caption, note: result.note, plots: result.plots, band: result.band, smooth: result.smooth }];
    });
    const x = new XScale({
      count,
      barStep: this.view.barStep,
      offsetFromEnd: this.view.offsetFromEnd,
      left,
      right,
      starts: this.starts,
      barMs: this.series.barMs,
      local: this.local,
    });
    this.frameX = x;

    // Panning and zooming slide the tape under a stationary cursor, so the crosshair
    // and legend track the pointer rather than the bar it first landed on. A cursor
    // parked over the price axis is outside the plot, but its bar still has to follow
    // the view, otherwise the legend keeps naming a bar the view moved away from.
    if (this.pointerOver) {
      const index = x.indexAt(this.hover.x);
      this.hover = { ...this.hover, index };
      this.footprintPane.selectedStart = bars[index]?.start ?? null;
    }

    const priceHost = hosts.find((host) => host.id === 'price') ?? hosts[0];
    const priceBottom = (priceHost?.height ?? 300) - (priceHost?.axisBottom ? TIME_AXIS_HEIGHT : 0);
    const visible = x.visibleRange();
    const range = this.view.updateAutoRange(this.series.rangeIn(visible.first, visible.last));
    const price = new PriceScale({
      mode: this.view.priceMode,
      min: range.min,
      max: range.max,
      top: 0,
      bottom: Math.max(1, priceBottom),
      precision: this.instrument?.pricePrecision ?? 2,
      tickPx: TICK_PITCH_PX[this.state.settings.priceTickStyle],
    });
    this.framePrice = price;

    for (const host of hosts) {
      this.stack.clear(host.ctx, host.width, host.height);
      const frame: Frame = {
        x,
        price,
        view: this.view,
        bars,
        instrument: this.instrument,
        timeframe: this.timeframe,
        local: this.local,
        hover: this.hover,
        left,
        right,
        width: host.width,
        height: host.height,
        axisBottom: host.axisBottom,
        now,
      };
      if (host.id === 'price') {
        // Drawings share the price-pane canvas: that canvas is already repainted whole
        // on every dirty frame, so a second canvas would add a repaint without saving one.
        this.pricePane.draw(host.ctx, frame, this.decor, this.overlays, (layerCtx, _layerFrame, reserved) => {
          const env = this.toolEnv();
          if (env) this.drawingLayer.draw(layerCtx, this.drawings, env, this.drawingController.pendingState(env), reserved);
        });
      } else if (host.id === 'volume') this.volumePane.draw(host.ctx, frame);
      else if (host.id === 'footprint') this.footprintPane.draw(host.ctx, frame);
      else if (host.id === 'profile') this.profilePane.draw(host.ctx, frame);
      // Indicator panes carry their own draw closure, so they need no branch here.
      else if (host.id.startsWith(INDICATOR_PANE_PREFIX)) this.stack.defFor(host.id)?.draw(host.ctx, frame);
    }

    this.status.setSeries({
      loaded: count,
      visible: count === 0 ? 0 : Math.max(0, visible.last - visible.first + 1),
      loadingOlder: this.series.loadingOlder,
      olderExhausted: this.series.olderExhausted,
    });
    this.loadOlderIfNeeded(x);
    this.scheduleFootprint(x);
    this.scheduleFlow(x);
    this.scheduleProfile(x);
  }

  private ensureDecor(bars: readonly Bar[]): void {
    const key = `${bars.length}:${bars[0]?.start ?? -1}:${bars[bars.length - 1]?.start ?? -1}:${this.instrument?.id ?? ''}`;
    if (key === this.decorKey) return;
    this.decorKey = key;
    this.starts = bars.map((bar) => bar.start);
    const windows = this.instrument?.session.windows.length ?? 0;
    this.decor = {
      gaps: findGaps(bars, this.series.barMs),
      // A venue that publishes session windows gets its boundaries; one that trades around
      // the clock gets the day change on the axis clock, which is the divider a naked chart
      // still needs and which moves with the timezone setting.
      session: windows > 0 ? sessionSegments(bars, this.instrument, this.local) : dayBoundarySegments(bars, this.local),
    };
  }

  private loadOlderIfNeeded(x: XScale): void {
    if (this.series.size === 0 || this.series.loadingOlder || this.series.olderExhausted) return;
    const { first } = x.visibleRange();
    if (first > OLDER_MARGIN_BARS) return;
    void this.series.loadOlder().then(() => {
      this.errorFromSeries();
      this.reportSeriesState();
      this.markDirty();
    });
  }

  private scheduleFootprint(x: XScale): void {
    const instrument = this.instrument;
    if (!instrument) return;
    const bars = this.series.bars;
    const { first, last } = x.visibleRange();
    const newest = bars[Math.min(bars.length - 1, Math.max(0, last))];
    const from = bars[Math.max(0, first)]?.start;
    if (newest === undefined || from === undefined) return;
    // `/api/footprint` and `/api/trades` treat `to` as an exclusive upper bound, so a
    // window ending at the newest bar start would drop every print of the live bar.
    // One bar duration past it keeps the still-open bucket in range.
    const to = newest.start + this.series.barMs;
    // Prints keep landing in the open bucket, so a visible live bar is re-read on a cadence.
    const overdue = !newest.closed && Date.now() - this.footprintFetchedAt > FOOTPRINT_LIVE_REFRESH_MS;
    if (!overdue && !this.footprintPane.needsRefresh(instrument.id, this.timeframe, from, to, this.series.barMs)) return;
    // One read in flight at a time. A second refresh bumps the response guard, so the
    // answer already on its way is dropped and the pane is left holding nothing.
    if (this.footprintPane.loading) return;
    if (this.footprintTimer !== null) return;
    this.footprintTimer = window.setTimeout(() => {
      this.footprintTimer = null;
      this.footprintFetchedAt = Date.now();
      void this.footprintPane.refresh(instrument.id, this.timeframe, from, to, this.series.barMs).then((changed) => {
        if (changed) this.markDirty();
      });
    }, FOOTPRINT_DEBOUNCE_MS);
  }

  /** Whether any added indicator reads the prints. Only then is a print window worth fetching. */
  private needsPrintFlow(): boolean {
    return this.indicators.instances.some((instance) => this.indicators.definitionOf(instance)?.needsPrints === true);
  }

  /**
   * Prints for the delta indicators: the same `/api/footprint` response the footprint
   * pane reads, but sized to the bars in view instead of the one bar the pane draws, so
   * the delta line spans the window rather than its last minute. Runs only while an
   * indicator that needs prints is added, and stops the moment the last one goes.
   */
  private scheduleFlow(x: XScale): void {
    if (!this.needsPrintFlow()) {
      if (this.flowSeries !== null || this.flowRequested) this.resetFlow();
      return;
    }
    const instrument = this.instrument;
    if (!instrument) return;
    const bars = this.series.bars;
    const { first, last } = x.visibleRange();
    const newest = bars[Math.min(bars.length - 1, Math.max(0, last))];
    const from = bars[Math.max(0, first)]?.start;
    if (newest === undefined || from === undefined) return;
    // `to` is exclusive, so one bar past the newest visible start keeps its open bucket in range.
    const to = newest.start + this.series.barMs;
    const limit = Math.max(1, Math.min(FLOW_MAX_BARS, last - first + 1));
    const key = `${instrument.id}|${this.timeframe}|${from}|${to}|${limit}`;
    // Prints keep landing in the open bucket, so a visible live bar is re-read on a cadence.
    const overdue = !newest.closed && Date.now() - this.flowFetchedAt > FLOW_LIVE_REFRESH_MS;
    if (!overdue && key === this.flowKey) return;
    if (this.flowLoading || this.flowTimer !== null) return;
    this.flowRequested = true;
    this.flowTimer = window.setTimeout(() => {
      this.flowTimer = null;
      this.flowFetchedAt = Date.now();
      this.flowLoading = true;
      const generation = ++this.flowGeneration;
      void api
        .footprint(instrument.id, this.timeframe, { from, to, limit })
        .then((series) => {
          this.flowLoading = false;
          if (generation !== this.flowGeneration) return;
          this.flowSeries = series;
          this.flowError = null;
          this.flowKey = key;
          this.markDirty();
        })
        .catch((error: unknown) => {
          this.flowLoading = false;
          if (generation !== this.flowGeneration) return;
          this.flowError = errorMessage(error);
          this.flowKey = key;
          this.markDirty();
        });
    }, FLOW_DEBOUNCE_MS);
  }

  /**
   * The print window as the per-bar buy/sell the delta indicators compute from. Rebuilt
   * only when the response or the pending state changes, since the renderer asks for it
   * on every frame.
   */
  private flowInput(): PrintFlow | null {
    if (!this.needsPrintFlow()) return null;
    const loading = this.flowLoading || !this.flowRequested;
    const built = this.flowBuilt;
    if (built && built.series === this.flowSeries && built.loading === loading && built.error === this.flowError) return built.flow;
    const flow = printFlow(this.flowSeries, loading, this.flowError);
    this.flowBuilt = { series: this.flowSeries, loading, error: this.flowError, flow };
    return flow;
  }

  private resetFlow(): void {
    this.flowGeneration += 1;
    this.flowSeries = null;
    this.flowError = null;
    this.flowLoading = false;
    this.flowRequested = false;
    this.flowKey = '';
    this.flowBuilt = null;
    if (this.flowTimer !== null) {
      window.clearTimeout(this.flowTimer);
      this.flowTimer = null;
    }
  }

  /**
   * Fetches the profile of exactly the visible window, debounced like the footprint. The
   * buckets carry no time dimension, so a profile taken over a wider window could not be
   * narrowed back to the view; the request follows the view instead.
   */
  private scheduleProfile(x: XScale): void {
    const instrument = this.instrument;
    if (!instrument || !this.stack.isVisible('profile')) return;
    const bars = this.series.bars;
    const { first, last } = x.visibleRange();
    const newest = bars[Math.min(bars.length - 1, Math.max(0, last))];
    const from = bars[Math.max(0, first)]?.start;
    if (newest === undefined || from === undefined) return;
    // `to` is exclusive, so one bar past the newest visible start keeps its open bucket in range.
    const to = newest.start + this.series.barMs;
    const valueArea = this.state.footprint.valueArea;
    // One profile in flight at a time: a window this wide takes seconds to come back, and
    // a second copy queued behind it would only be dropped by the response guard.
    if (this.profilePane.loading) return;
    const overdue = !newest.closed && Date.now() - this.profileFetchedAt > PROFILE_LIVE_REFRESH_MS;
    if (!overdue && !this.profilePane.needsRefresh(instrument.id, from, to, valueArea)) return;
    if (this.profileTimer !== null) return;
    this.profileTimer = window.setTimeout(() => {
      this.profileTimer = null;
      this.profileFetchedAt = Date.now();
      void this.profilePane.refresh(instrument.id, from, to, valueArea).then((changed) => {
        if (changed) this.markDirty();
      });
    }, PROFILE_DEBOUNCE_MS);
  }

  private persist(): void {
    this.workspace.save(this.collectState());
  }

  /**
   * The document as it stands right now: the live view, pane heights, watchlist, indicators
   * and drawings folded back into the state the server stores. The export reads the same
   * thing the save path writes, so a file and a stored workspace cannot disagree.
   */
  private collectState(): WorkspaceState {
    this.state.view = { ...this.state.view, ...this.view.serialize() };
    this.state.weights = this.stack.weights();
    this.state.watchlist = this.watchEntries.map((entry) => entry.instrument.id);
    this.state.timeframe = this.timeframe;
    this.state.seriesStyle = this.pricePane.style;
    this.state.indicators = this.indicators.instances;
    this.state.drawings = this.drawings.instances;
    return this.state;
  }

  // ---------------------------------------------------------------- backup and export

  /** Writes the whole workspace out as a file. Returns the line the Backup page shows. */
  private exportWorkspace(): string {
    const state = this.collectState();
    const file = buildWorkspaceFile(state);
    const text = serialiseWorkspaceFile(file);
    const name = workspaceFileName(state.instrument, file.exportedAt);
    downloadJson(name, text);
    return (
      `${name} — ${state.indicators.length} indicators, ${state.drawings.length} drawings, ` +
      `${state.templates.length} templates (${(text.length / 1024).toFixed(1)} KB)`
    );
  }

  /**
   * Puts an imported document where the live one was, through the same paths a workspace
   * load takes, then writes it back so the server's copy matches the file. The document has
   * already passed the file validator, so either everything lands or nothing does.
   */
  private async importWorkspace(state: WorkspaceState): Promise<string> {
    this.state = state;
    this.applyStateToControls();
    // A workspace that has never saved a zoom gets one from the view's density target; an
    // imported document states its own, so that rule no longer applies to it.
    this.defaultViewPending = false;
    const needsSeries =
      (state.instrument !== null && state.instrument !== this.series.instrument) || state.timeframe !== this.series.timeframe;
    // `setInstrument` loads the bars for the interval the state now carries, re-subscribes
    // the feed and restores the stored view on top, which is everything a new symbol needs.
    if (needsSeries) await this.setInstrument(state.instrument ?? this.instrument?.id ?? DEFAULT_INSTRUMENT);
    await this.syncWatchlist(state.watchlist);
    this.markDirty();
    this.persist();
    await this.workspace.flush();
    return (
      `imported ${state.instrument ?? 'no symbol'} ${state.timeframe}: ${state.indicators.length} indicators, ` +
      `${state.drawings.length} drawings, ${state.templates.length} templates, settings and view state`
    );
  }

  /** Brings the sidebar round to the symbols the imported document names. */
  private async syncWatchlist(ids: readonly string[]): Promise<void> {
    for (const entry of [...this.watchEntries]) {
      if (!ids.includes(entry.instrument.id)) this.removeWatch(entry.instrument.id);
    }
    for (const id of ids) {
      if (this.watchEntries.some((entry) => entry.instrument.id === id)) continue;
      const meta = await api.instrument(id).catch(() => null);
      if (meta) await this.addWatch(meta, false);
    }
    this.watchlist.setActive(this.instrument?.id ?? null);
  }

  /** Validate a workspace file and, if it holds, put it in place. The Backup page's path. */
  private async importWorkspaceText(text: string): Promise<{ ok: boolean; error?: string; message?: string }> {
    const read = readWorkspaceFile(text);
    if (!read.ok) return { ok: false, error: read.error };
    return { ok: true, message: await this.importWorkspace(read.state) };
  }

  /**
   * CSV of the bars the price pane is painting. The window comes from the scale the last
   * frame drew, and the series from the same transform the tape on screen uses, so the file
   * matches the chart rather than the stored table while a display transform is on.
   */
  private async exportBarsCsv(): Promise<string> {
    const range = this.frameX?.visibleRange();
    const shown = this.pricePane.displayed(this.series.bars);
    const bars = range ? shown.slice(Math.max(0, range.first), range.last + 1) : [];
    if (bars.length === 0) return 'nothing to export: the chart has no bars in view';
    const flow = await this.deltaWindow(bars);
    const file = barsToCsv(bars, flow.map);
    const name = barsFileName(this.instrument?.id ?? null, this.timeframe, Date.now());
    downloadCsv(name, file.csv);
    const kind = this.pricePane.style === 'heikin' ? 'Heikin Ashi averages' : 'stored candles';
    const coverage = file.columns.includes('delta')
      ? `delta on ${file.deltaRows} of ${file.rows} rows`
      : (flow.note ?? 'no prints cover this window');
    return `${name} — ${file.rows} rows (${kind}), ${file.columns.join(', ')}; ${coverage}`;
  }

  /**
   * Per-bar delta for the window being written. The app's own print window exists only
   * while a delta indicator is added, so the export asks the footprint endpoint for exactly
   * the bars it is writing. A failure costs the delta column, never the file.
   */
  private async deltaWindow(bars: readonly Bar[]): Promise<{ map: Map<number, number> | null; note: string | null }> {
    const instrument = this.instrument;
    if (!instrument) return { map: null, note: 'no symbol is open' };
    const from = bars[0]?.start ?? 0;
    const newest = bars[bars.length - 1]?.start ?? 0;
    try {
      const series = await api.footprint(instrument.id, this.timeframe, {
        from,
        // `to` is exclusive, so one bar past the newest start keeps an open bucket inside.
        to: newest + this.series.barMs,
        limit: Math.min(bars.length, FOOTPRINT_CSV_LIMIT),
      });
      const map = new Map<number, number>();
      for (const bar of series.bars) map.set(bar.start, bar.delta);
      return { map, note: map.size === 0 ? 'the server holds no prints for this window' : null };
    } catch (error) {
      return { map: null, note: `delta unavailable: ${errorMessage(error)}` };
    }
  }

  /** Prints over the range the Backup page picked, oldest first. */
  private async exportPrintsCsv(range: PrintRange): Promise<string> {
    const instrument = this.instrument?.id;
    if (!instrument) return 'nothing to export: no symbol is open';
    const response = await api.trades(instrument, {
      from: range.from ?? undefined,
      to: range.to ?? undefined,
      limit: API_ROW_CAP,
    });
    // The endpoint answers newest first and stops at its row cap, so the oldest half of a
    // capped range is simply absent. Sorting makes the file readable; the cap says the rest.
    const prints = response.trades.slice().sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    const file = printsToCsv(prints);
    const name = printsFileName(instrument, Date.now(), file.capped);
    downloadCsv(name, file.csv);
    const bounds =
      range.from === null && range.to === null
        ? 'the newest stored prints'
        : `${new Date(range.from ?? prints[0]?.ts ?? 0).toISOString()} to ${new Date(range.to ?? Date.now()).toISOString()}`;
    return file.capped
      ? `${name} — ${file.rows} prints over ${bounds}, cut at the server's ${API_ROW_CAP} row cap: the file holds the newest prints in that range, not all of them`
      : `${name} — ${file.rows} prints over ${bounds}`;
  }

  /** The time span the bars in view cover, used to prefill the prints range. */
  private visibleTimeRange(): { from: number; to: number } {
    const range = this.frameX?.visibleRange();
    const bars = this.series.bars;
    if (!range || bars.length === 0) {
      const now = Date.now();
      return { from: now - 3_600_000, to: now };
    }
    const from = bars[Math.max(0, range.first)]?.start ?? Date.now();
    const newest = bars[Math.min(bars.length - 1, range.last)]?.start ?? Date.now();
    return { from, to: newest + this.series.barMs };
  }
}

/** Input types whose caret keeps the browser's own undo; every other control defers to the chart. */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'time', 'datetime-local']);

function holdsCaret(target: Element | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type);
}

/** A symbol outside the stored catalogue still gets a usable display contract. */
function stubInstrument(id: string): Instrument {
  const [venue, symbol] = id.split(':');
  return {
    id,
    venue: (venue ?? '').toLowerCase(),
    symbol: symbol ?? id,
    display: symbol ?? id,
    name: id,
    assetClass: 'unknown',
    priceTick: 0.01,
    qtyStep: 0.001,
    pricePrecision: 2,
    qtyPrecision: 3,
    quoteCurrency: '',
    session: { timezone: 'UTC', windows: [] },
    active: true,
  };
}

function readInitialBarLimit(): number {
  const raw = Number(new URLSearchParams(window.location.search).get('bars'));
  return Number.isFinite(raw) && raw >= 10 && raw <= 5_000 ? Math.floor(raw) : 1_500;
}

function mustGet(root: HTMLElement, id: string): HTMLElement {
  const node = root.querySelector(`#${id}`) ?? document.getElementById(id);
  if (!node) throw new Error(`missing #${id} in the page shell`);
  return node as HTMLElement;
}
