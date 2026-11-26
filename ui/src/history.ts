/**
 * Undo and redo for chart edits: the drawings and the indicators, and nothing else.
 * The stack is session state — the workspace document stores what the chart looks like,
 * never the steps that walked it there.
 *
 * A step records the whole collection it touched, before and after. Restoring one
 * therefore cannot leave half an edit behind, and a step whose list has since been
 * replaced wholesale still restores a consistent list instead of chasing an id that is
 * gone.
 */

import type { DrawingEngine, DrawingInstance } from './drawings/engine';
import { cloneValue as cloneStyle, type StyleValues } from './drawings/style';
import type { IndicatorEngine, IndicatorInstance } from './indicators/engine';
import { cloneValue as cloneParam, type ParamValues } from './indicators/registry';

/** Which collection a step walks back. */
export type HistoryKind = 'drawings' | 'indicators';

/**
 * How long one control may stay quiet before its next edit starts a new step. A slider
 * sweep or a run of keystrokes lands inside one step; two edits with a pause between them
 * are two intentions.
 */
export const COALESCE_WINDOW_MS = 750;

/** Steps kept per direction: a working session's worth, and far below any real limit. */
const HISTORY_LIMIT = 200;

interface Step {
  label: string;
  kind: HistoryKind;
  before: unknown[];
  after: unknown[];
  /** Selection travels with a drawings step, so undoing a delete brings the drawing back selected. */
  selectedBefore: string | null;
  selectedAfter: string | null;
}

/** An edit still in progress: keyed by the control driving it, closed by `end`. */
interface Group {
  key: string;
  kind: HistoryKind;
  label: string;
  before: unknown[];
  selectedBefore: string | null;
  /** A held group waits for its caller to close it; a timed one closes on quiet. */
  held: boolean;
}

export class ChartHistory {
  private readonly undoStack: Step[] = [];
  private readonly redoStack: Step[] = [];
  private group: Group | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly drawings: DrawingEngine,
    private readonly indicators: IndicatorEngine,
    /** Runs after every restore so panes, dialogs and the stored document follow the engines. */
    private readonly onRestore: (kind: HistoryKind) => void,
  ) {}

  /**
   * Applies one mutation and records it. A null key makes it stand alone; a key opens or
   * continues a coalescing group, which is how a slider sweep becomes one step. Returns
   * whatever the mutation returned, so callers can still see what they created.
   */
  transact<T>(kind: HistoryKind, key: string | null, label: string, mutate: () => T): T {
    if (key === null) {
      this.end();
      const before = this.snapshot(kind);
      const selectedBefore = this.selection(kind);
      const result = mutate();
      this.push({ label, kind, before, after: this.snapshot(kind), selectedBefore, selectedAfter: this.selection(kind) });
      return result;
    }
    this.open(kind, key, label, false);
    const result = mutate();
    this.arm();
    return result;
  }

  /**
   * Opens a group the caller drives by hand: the state is captured now, and every change
   * until `end` lands in the same step. Used by a pointer gesture, which mutates the
   * engines through many moves between one press and its release, so it never times out.
   */
  begin(kind: HistoryKind, key: string, label: string): void {
    this.open(kind, key, label, true);
  }

  private open(kind: HistoryKind, key: string, label: string, held: boolean): void {
    const group = this.group;
    if (group && group.key === key) {
      group.label = label;
      group.held = group.held || held;
      if (!group.held) this.arm();
      return;
    }
    this.end();
    this.group = { key, kind, label, before: this.snapshot(kind), selectedBefore: this.selection(kind), held };
  }

  /** Closes the open group, recording it only if it changed anything. */
  end(): void {
    const group = this.group;
    this.group = null;
    this.cancelTimer();
    if (!group) return;
    this.push({
      label: group.label,
      kind: group.kind,
      before: group.before,
      after: this.snapshot(group.kind),
      selectedBefore: group.selectedBefore,
      selectedAfter: this.selection(group.kind),
    });
  }

  /** Throws the open group away: the caller already put the chart back, as Esc mid-drag does. */
  drop(): void {
    this.group = null;
    this.cancelTimer();
  }

  /** Steps one drawing or indicator edit back. False when there is nothing to undo. */
  undo(): boolean {
    this.end();
    const step = this.undoStack.pop();
    if (!step) return false;
    this.apply(step, step.before, step.selectedBefore);
    this.redoStack.push(step);
    return true;
  }

  /** Puts an undone edit back. False when nothing has been undone. */
  redo(): boolean {
    this.end();
    const step = this.redoStack.pop();
    if (!step) return false;
    this.apply(step, step.after, step.selectedAfter);
    // A fresh mutation after an undo retires the redo line, the standard behaviour.
    this.undoStack.push(step);
    return true;
  }

  /** Forgets every step: a different workspace document owns a different stack. */
  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.drop();
  }

  /** Labels on the stack, oldest first: what Ctrl+Z would step back through. */
  labels(which: 'undo' | 'redo'): string[] {
    return (which === 'undo' ? this.undoStack : this.redoStack).map((step) => step.label);
  }

  depth(): { undo: number; redo: number } {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }

  private apply(step: Step, list: unknown[], selected: string | null): void {
    if (step.kind === 'drawings') {
      this.drawings.setInstances(list);
      this.drawings.selectedId = this.drawings.find(selected) ? selected : null;
    } else {
      this.indicators.setInstances(list);
    }
    this.onRestore(step.kind);
  }

  /**
   * Records a step unless the mutation left the collection exactly as it was. Selection
   * alone is not a step: clicking a drawing to select it has nothing to undo.
   */
  private push(step: Step): void {
    if (sameValue(step.before, step.after)) return;
    if (this.undoStack.length >= HISTORY_LIMIT) this.undoStack.shift();
    this.undoStack.push(step);
    // A new mutation invalidates everything that was undone.
    this.redoStack.length = 0;
  }

  private snapshot(kind: HistoryKind): unknown[] {
    return kind === 'drawings' ? cloneDrawings(this.drawings.instances) : cloneIndicators(this.indicators.instances);
  }

  private selection(kind: HistoryKind): string | null {
    return kind === 'drawings' ? this.drawings.selectedId : null;
  }

  /** Restarts the quiet-period clock that closes a coalescing group. */
  private arm(): void {
    this.cancelTimer();
    if (this.group?.held) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.end();
    }, COALESCE_WINDOW_MS);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

function cloneDrawings(list: readonly DrawingInstance[]): DrawingInstance[] {
  return list.map((instance) => ({
    id: instance.id,
    toolId: instance.toolId,
    anchors: instance.anchors.map((anchor) => ({ time: anchor.time, price: anchor.price })),
    style: cloneStyles(instance.style),
    locked: instance.locked === true,
  }));
}

function cloneStyles(style: StyleValues): StyleValues {
  const out: StyleValues = {};
  for (const [key, value] of Object.entries(style)) out[key] = cloneStyle(value);
  return out;
}

function cloneIndicators(list: readonly IndicatorInstance[]): IndicatorInstance[] {
  return list.map((instance) => {
    const params: ParamValues = {};
    for (const [name, value] of Object.entries(instance.params)) params[name] = cloneParam(value);
    const copy: IndicatorInstance = { id: instance.id, indicatorId: instance.indicatorId, params };
    if (instance.script !== undefined) copy.script = instance.script;
    return copy;
  });
}

/**
 * Structural equality with keys sorted, so two objects agree whatever order they were
 * built in. Only plain values live in these collections.
 */
function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort((x, y) => (x[0] < y[0] ? -1 : 1))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
