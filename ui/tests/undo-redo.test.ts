/**
 * Undo and redo over the drawing and indicator engines, driven the way app.ts drives them:
 * a pointer gesture opens one step at the press and closes it at the release, and a control
 * edit passes a key that coalesces a sweep into one step. Anchors, styles and parameters are
 * compared as stored values, so a round-trip has to land on the exact numbers it started on.
 *
 * Run it with:
 *   npx rolldown tests/undo-redo.test.ts -o /tmp/undo-test.mjs -f esm && node /tmp/undo-test.mjs
 */

// The test runs in node, whose globals the DOM-only tsconfig does not carry.
declare const process: { exitCode: number };

import { LocalTime } from '../src/format';
import { PriceScale, XScale } from '../src/scale';
import { anchorToPixel, type DrawingAnchor, type Pt } from '../src/drawings/anchors';
import { DrawingController } from '../src/drawings/controller';
import { DrawingEngine, type DrawingInstance } from '../src/drawings/engine';
import type { ToolEnv } from '../src/drawings/registry';
import { COALESCE_WINDOW_MS, ChartHistory, type HistoryKind } from '../src/history';
import { IndicatorEngine } from '../src/indicators/engine';
import { SCRIPT_INDICATOR_ID } from '../src/indicators/script/contract';
import type { Bar } from '../src/types';

const PLOT = { left: 0, right: 600, top: 0, bottom: 213 };
const BAR_MS = 60_000;
const FIRST_BAR = Date.UTC(2026, 10, 25, 0, 0, 0);

/** Bars for one symbol; the second set stands for a different symbol's tape. */
function bars(count: number, base: number): Bar[] {
  return Array.from({ length: count }, (_, i) => {
    const close = base + i * 2;
    return { start: FIRST_BAR + i * BAR_MS, open: close - 4, high: close + 6, low: close - 6, close, volume: 10 + i, trades: 40, closed: true };
  });
}

/** Builds the geometry environment a frame would hand the drawing layer. */
function makeEnv(list: readonly Bar[], low: number, high: number): ToolEnv {
  return {
    x: new XScale({
      count: list.length,
      barStep: 4,
      offsetFromEnd: 42,
      left: PLOT.left,
      right: PLOT.right,
      starts: list.map((bar) => bar.start),
      barMs: BAR_MS,
      local: new LocalTime('UTC'),
    }),
    price: new PriceScale({ mode: 'linear', min: low, max: high, top: PLOT.top, bottom: PLOT.bottom, precision: 2 }),
    priceTick: 0.01,
    ctx: { measureText: (text: string) => ({ width: text.length * 7 }) } as CanvasRenderingContext2D,
    plot: PLOT,
    instrument: null,
    bars: list,
    local: new LocalTime('UTC'),
    measure: (text: string) => text.length * 7,
  };
}

let env = makeEnv(bars(200, 58_500), 58_000, 59_000);

const engine = new DrawingEngine();
const indicators = new IndicatorEngine(null);
const controller = new DrawingController(engine);
/** The app's restore hook: recorded here so the test can see which side came back. */
const restored: HistoryKind[] = [];
const history = new ChartHistory(engine, indicators, (kind) => restored.push(kind));

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed += 1;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const json = (value: unknown): string => JSON.stringify(value);
const last = (): DrawingInstance => engine.instances[engine.instances.length - 1] as DrawingInstance;
const count = (): number => engine.instances.length;
/** Everything a stored drawing has to survive an undo with, in the order it paints. */
const shape = (instance: DrawingInstance) => ({
  id: instance.id,
  toolId: instance.toolId,
  anchors: instance.anchors.map((anchor) => ({ time: anchor.time, price: anchor.price })),
  style: instance.style,
  locked: instance.locked === true,
});
const document_ = () => engine.instances.map(shape);
const anchorsOf = (id: string): DrawingAnchor[] | null => engine.find(id)?.anchors.map((a) => ({ time: a.time, price: a.price })) ?? null;
/** Pixel at the middle of a drawing's body, so a press grabs it instead of an anchor. */
function midOf(id: string): Pt {
  const anchors = anchorsOf(id)!;
  const a = anchorToPixel(anchors[0]!, env);
  const b = anchorToPixel(anchors[1]!, env);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
const depth = () => history.depth();

/** Mirrors app.ts: the press opens the step, the release closes it, Esc throws it away. */
let openKey: string | null = null;
function beginStep(): void {
  const target = controller.gestureTarget();
  if (!target) return;
  openKey = target.key;
  history.begin('drawings', target.key, target.label);
}
function endStep(dropped = false): void {
  if (openKey === null) return;
  openKey = null;
  if (dropped) history.drop();
  else history.end();
}

/** One pointer gesture with `steps` moves in it: the unit a coalescing rule is measured in. */
function gesture(from: Pt, to: Pt, shift = false, steps = 6): void {
  const down = controller.pointerDown(from, env);
  if (down.consumed) beginStep();
  try {
    for (let i = 1; i <= steps; i += 1) {
      controller.pointerMove({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }, env, shift);
    }
    controller.pointerUp(to, env, shift);
  } finally {
    endStep();
  }
}

/** Fresh chart: no drawings, no steps, one armed tool. */
function reset(toolId: string | null): void {
  controller.setTool(null);
  engine.setInstances([]);
  history.clear();
  controller.setTool(toolId);
}

/**
 * Hands the pointer back to the chart. An armed tool owns every press and starts a new
 * drawing, so a gesture meant to grab a placed one needs the tool disarmed first.
 */
function disarm(): void {
  controller.setTool(null);
}

// 0. An empty stack says so rather than pretending to step back.
reset(null);
check('nothing to undo on a fresh chart', history.undo() === false, json(depth()));
check('nothing to redo before an undo', history.redo() === false, json(depth()));

// 1. Create round-trip: the drawing comes back with the anchors it was placed with.
reset('TrendLine');
gesture({ x: 60, y: 40 }, { x: 180, y: 120 });
const placedId = last().id;
const placedAnchors = anchorsOf(placedId);
check('placing one drawing records exactly one step', depth().undo === 1, json(history.labels('undo')));
check('undo removes the drawing', history.undo() === true && count() === 0, `count ${count()}`);
check('undo reports the drawings side', restored.at(-1) === 'drawings', String(restored.at(-1)));
check('redo re-applies the same anchors', history.redo() === true && json(anchorsOf(placedId)) === json(placedAnchors), json(anchorsOf(placedId)));
check('the id survives so selection and panes keep their key', engine.find(placedId) !== null, placedId);

// 2. Move round-trip: exact previous values, not just a different position.
const beforeMove = anchorsOf(placedId) as DrawingAnchor[];
disarm();
const grab = midOf(placedId);
gesture(grab, { x: grab.x + 90, y: grab.y + 16 });
const afterMove = anchorsOf(placedId) as DrawingAnchor[];
check('the move shifted both anchors', afterMove[0]!.time !== beforeMove[0]!.time && afterMove[1]!.price !== beforeMove[1]!.price, json(afterMove));
check('a move is one step however many moves it carried', depth().undo === 2, json(history.labels('undo')));
history.undo();
check('undo restores the exact pre-move anchors', json(anchorsOf(placedId)) === json(beforeMove), json(anchorsOf(placedId)));
history.redo();
check('redo restores the exact moved anchors', json(anchorsOf(placedId)) === json(afterMove), json(anchorsOf(placedId)));

// 3. One anchor dragged: the other anchor must not drift, and undo lands on the old numbers.
const beforeDrag = anchorsOf(placedId) as DrawingAnchor[];
const handle = anchorToPixel(beforeDrag[1]!, env);
gesture(handle, { x: handle.x - 70, y: handle.y + 40 });
const afterDrag = anchorsOf(placedId) as DrawingAnchor[];
check('the dragged anchor moved', afterDrag[1]!.time !== beforeDrag[1]!.time || afterDrag[1]!.price !== beforeDrag[1]!.price, json(afterDrag));
check('the anchor left alone stayed put', json(afterDrag[0]) === json(beforeDrag[0]), json(afterDrag[0]));
check('an anchor drag adds one step', depth().undo === 3, json(history.labels('undo')));
history.undo();
const undragged = anchorsOf(placedId) as DrawingAnchor[];
check('undo returns the dragged anchor to its exact previous time', undragged[1]!.time === beforeDrag[1]!.time, `${undragged[1]!.time} vs ${beforeDrag[1]!.time}`);
check('undo returns the dragged anchor to its exact previous price', undragged[1]!.price === beforeDrag[1]!.price, `${undragged[1]!.price} vs ${beforeDrag[1]!.price}`);
history.redo();
check('redo re-applies the dragged anchor', json(anchorsOf(placedId)) === json(afterDrag), json(anchorsOf(placedId)));

// 4. Coalescing inside one gesture: twelve moves, one step, and one undo covers all twelve.
reset('TrendLine');
gesture({ x: 60, y: 40 }, { x: 180, y: 120 }, false, 12);
const coalesceId = last().id;
const coalesceBefore = anchorsOf(coalesceId) as DrawingAnchor[];
const stepsBeforeSweep = depth().undo;
disarm();
const sweepFrom = midOf(coalesceId);
gesture(sweepFrom, { x: sweepFrom.x + 180, y: sweepFrom.y + 70 }, false, 12);
check('twelve pointer moves in one drag are one step', depth().undo === stepsBeforeSweep + 1, json(history.labels('undo')));
check('one undo walks the whole drag back', history.undo() === true && json(anchorsOf(coalesceId)) === json(coalesceBefore), json(anchorsOf(coalesceId)));
check('and one redo replays all twelve moves', history.redo() === true && json(anchorsOf(coalesceId)) !== json(coalesceBefore), json(anchorsOf(coalesceId)));

// 5. Esc mid-drag puts the drawing back and leaves no step behind.
const escBefore = anchorsOf(coalesceId) as DrawingAnchor[];
const escDepth = depth().undo;
const escFrom = midOf(coalesceId);
controller.pointerDown(escFrom, env);
beginStep();
for (let i = 1; i <= 5; i += 1) controller.pointerMove({ x: escFrom.x + i * 12, y: escFrom.y + i * 6 }, env, false);
controller.cancel();
endStep(true);
check('Esc restores the anchors the drag started from', json(anchorsOf(coalesceId)) === json(escBefore), json(anchorsOf(coalesceId)));
check('Esc leaves no undo step', depth().undo === escDepth, json(history.labels('undo')));

// 6. A click that only selects has nothing to undo.
const clickDepth = depth().undo;
const clickAt = midOf(coalesceId);
controller.pointerDown(clickAt, env);
beginStep();
controller.pointerUp(clickAt, env, false);
endStep();
check('selecting a drawing records no step', depth().undo === clickDepth, json(history.labels('undo')));
check('the click still selected it', engine.selectedId === coalesceId, String(engine.selectedId));

// 7. Style change: reverts exactly, and a sweep of one field is one step.
const styleId = coalesceId;
const styleKeys = Object.keys(engine.find(styleId)!.style);
const widthKey = styleKeys.find((key) => typeof engine.find(styleId)!.style[key] === 'number') ?? styleKeys[0]!;
const styleBefore = engine.find(styleId)!.style[widthKey];
const styleDepth = depth().undo;
for (let i = 1; i <= 8; i += 1) {
  history.transact('drawings', `drw:style:${styleId}:${widthKey}`, 'drawing style', () =>
    engine.setStyle(styleId, { [widthKey]: (styleBefore as number) + i }),
  );
}
history.end(); // the quiet period would have closed the run; an undo or a tool switch closes it too
check('eight edits to one style field are one step', depth().undo === styleDepth + 1, json(history.labels('undo')));
check('the sweep landed on its last value', engine.find(styleId)!.style[widthKey] === (styleBefore as number) + 8, String(engine.find(styleId)!.style[widthKey]));
history.undo();
check('undo reverts the style field', engine.find(styleId)!.style[widthKey] === styleBefore, String(engine.find(styleId)!.style[widthKey]));
history.redo();
check('redo re-applies the swept value', engine.find(styleId)!.style[widthKey] === (styleBefore as number) + 8, String(engine.find(styleId)!.style[widthKey]));

// 8. A different field is a new step, and so is a pause past the coalescing window.
history.transact('drawings', `drw:style:${styleId}:color`, 'drawing style', () => engine.setStyle(styleId, { color: '#ff0000' }));
history.end();
check('a different style field opens a new step', depth().undo >= styleDepth + 2, json(history.labels('undo')));
const paused = depth().undo;
history.transact('drawings', `drw:style:${styleId}:${widthKey}`, 'drawing style', () => engine.setStyle(styleId, { [widthKey]: 1 }));
await new Promise((resolve) => setTimeout(resolve, COALESCE_WINDOW_MS + 60));
history.transact('drawings', `drw:style:${styleId}:${widthKey}`, 'drawing style', () => engine.setStyle(styleId, { [widthKey]: 2 }));
history.end();
check('edits after the coalescing window open a second step', depth().undo === paused + 2, json(history.labels('undo')));

// 9. Delete round-trip: anchors, style, lock and paint order all come back.
reset(null);
engine.setInstances([
  { id: 'a', toolId: 'TrendLine', anchors: [{ time: FIRST_BAR, price: 58_500 }, { time: FIRST_BAR + 600_000, price: 58_700 }], style: {} },
  { id: 'b', toolId: 'TrendLine', anchors: [{ time: FIRST_BAR, price: 58_600 }, { time: FIRST_BAR + 600_000, price: 58_800 }], style: {} },
  { id: 'c', toolId: 'TrendLine', anchors: [{ time: FIRST_BAR, price: 58_700 }, { time: FIRST_BAR + 600_000, price: 58_900 }], style: {} },
]);
engine.setLocked('b', true);
engine.setStyle('b', { color: '#123456' });
engine.selectedId = 'b';
const wholeDocument = document_();
const selectedBefore = engine.selectedId;
history.transact('drawings', null, 'delete drawing', () => engine.remove('b'));
check('the delete took the middle drawing out', engine.instances.map((d) => d.id).join(',') === 'a,c', engine.instances.map((d) => d.id).join(','));
check('deleting clears its selection', engine.selectedId === null, String(engine.selectedId));
check('a delete is its own step even next to an open run', history.labels('undo').at(-1) === 'delete drawing', json(history.labels('undo')));
history.undo();
check('undo restores the deleted drawing whole', json(document_()) === json(wholeDocument), json(document_()));
check('the restored drawing keeps its id, anchors, style and lock', engine.find('b')?.locked === true, json(engine.find('b')));
check('and it comes back selected', engine.selectedId === selectedBefore, String(engine.selectedId));
history.redo();
check('redo deletes it again', engine.instances.map((d) => d.id).join(',') === 'a,c', engine.instances.map((d) => d.id).join(','));

// 10. Z-order and lock revert.
engine.setInstances(wholeDocument.map((entry) => ({ ...entry })));
engine.setLocked('b', true);
history.clear();
const orderBefore = engine.instances.map((d) => d.id).join(',');
history.transact('drawings', null, 'change draw order', () => engine.reorder('a', 'front'));
check('the reorder moved it to the top', engine.instances.map((d) => d.id).join(',') !== orderBefore, engine.instances.map((d) => d.id).join(','));
history.undo();
check('undo restores the paint order', engine.instances.map((d) => d.id).join(',') === orderBefore, engine.instances.map((d) => d.id).join(','));
history.transact('drawings', null, 'lock drawing', () => engine.setLocked('c', true));
history.transact('drawings', null, 'unlock drawing', () => engine.setLocked('b', false));
check('the lock applied', engine.find('c')?.locked === true && engine.find('b')?.locked === false, json([engine.find('c')?.locked, engine.find('b')?.locked]));
history.undo();
check('undo reverts the unlock', engine.find('b')?.locked === true, String(engine.find('b')?.locked));
history.undo();
check('and the lock', engine.find('c')?.locked === false, String(engine.find('c')?.locked));

// 11. Duplicate: undo drops the copy and leaves the original untouched.
const original = anchorsOf('a') as DrawingAnchor[];
const copy = history.transact('drawings', null, 'duplicate drawing', () => engine.duplicate('a', { time: 120_000, price: 10 }));
check('the copy exists', copy !== null && count() === 4, `count ${count()}`);
history.undo();
check('undo removes the copy', count() === 3 && engine.instances.every((d) => d.id !== copy?.id), json(engine.instances.map((d) => d.id)));
check('the original kept its anchors through it', json(anchorsOf('a')) === json(original), json(anchorsOf('a')));
history.redo();
check('redo puts the copy back', count() === 3 + 1, `count ${count()}`);

// 12. A fresh mutation after an undo clears the redo line.
history.transact('drawings', null, 'delete drawing', () => engine.remove('c'));
check('a new mutation retires the redo stack', depth().redo === 0 && history.redo() === false, json(depth()));

// 13. Indicators: add, parameter sweep, script text, remove.
indicators.setInstances([]);
history.clear();
const added = history.transact('indicators', null, 'add indicator', () => indicators.add('EMA'));
check('the indicator was added', added !== null && indicators.instances.length === 1, `count ${indicators.instances.length}`);
check('undo removes the indicator', history.undo() === true && indicators.instances.length === 0, `count ${indicators.instances.length}`);
check('undo reports the indicators side', restored.at(-1) === 'indicators', String(restored.at(-1)));
history.transact('indicators', null, 'add indicator', () => indicators.add('EMA'));
check('a fresh add after an undo is its own step', depth().undo === 1 && depth().redo === 0, json(depth()));
const indId = indicators.instances[0]!.id;
const periodBefore = indicators.instances[0]!.params.period;
const paramDepth = depth().undo;
for (let i = 0; i < 9; i += 1) {
  history.transact('indicators', `ind:params:${indId}:period`, 'indicator settings', () => indicators.setParams(indId, { period: 5 + i }));
}
history.end();
check('nine parameter edits are one step', depth().undo === paramDepth + 1, json(history.labels('undo')));
check('the sweep left the parameter on its last value', indicators.instances[0]!.params.period === 13, String(indicators.instances[0]!.params.period));
history.undo();
check('undo restores the exact previous parameter', indicators.instances[0]!.params.period === periodBefore, String(indicators.instances[0]!.params.period));
history.redo();
check('redo re-applies the swept parameter', indicators.instances[0]!.params.period === 13, String(indicators.instances[0]!.params.period));
history.transact('indicators', `ind:params:${indId}:source`, 'indicator settings', () => indicators.setParams(indId, { source: 'high' }));
history.end();
check('a different parameter opens a new step', depth().undo >= paramDepth + 2, json(history.labels('undo')));
check('the other parameter survived', indicators.instances[0]!.params.period === 13, String(indicators.instances[0]!.params.period));

// 14. Script text is undoable too, and coalesces per instance.
indicators.setInstances([
  { id: 's1', indicatorId: SCRIPT_INDICATOR_ID, params: {}, script: 'indicator({ name: "One" })' },
  { id: 's2', indicatorId: SCRIPT_INDICATOR_ID, params: {}, script: 'indicator({ name: "Two" })' },
]);
history.clear();
const scriptDepth = depth().undo;
for (const line of ['plot(close)', 'plot(close + 1)', 'plot(close + 22)']) {
  history.transact('indicators', 'ind:script:s1', 'script text', () => indicators.setScript('s1', line));
}
history.end();
check('a run of typing in one script is one step', depth().undo === scriptDepth + 1, json(history.labels('undo')));
check('the script holds the typed text', indicators.instances.find((i) => i.id === 's1')?.script === 'plot(close + 22)', String(indicators.instances.find((i) => i.id === 's1')?.script));
history.undo();
check('undo restores the exact previous script', indicators.instances.find((i) => i.id === 's1')?.script === 'indicator({ name: "One" })', String(indicators.instances.find((i) => i.id === 's1')?.script));
check('the untouched script did not move', indicators.instances.find((i) => i.id === 's2')?.script === 'indicator({ name: "Two" })', String(indicators.instances.find((i) => i.id === 's2')?.script));

// 15. Removing an indicator reverts with its parameters and its script.
const removedDoc = indicators.instances.map((instance) => ({ id: instance.id, indicatorId: instance.indicatorId, params: instance.params, script: instance.script }));
history.transact('indicators', null, 'remove indicator', () => indicators.remove('s1'));
check('the instance is gone', indicators.instances.map((i) => i.id).join(',') === 's2', indicators.instances.map((i) => i.id).join(','));
history.undo();
const restoredDoc = indicators.instances.map((instance) => ({ id: instance.id, indicatorId: instance.indicatorId, params: instance.params, script: instance.script }));
check('undo restores it with its script and parameters', json(restoredDoc) === json(removedDoc), json(restoredDoc));
check('and in its original position', indicators.instances.map((i) => i.id).join(',') === 's1,s2', indicators.instances.map((i) => i.id).join(','));

// 16. A symbol switch keeps the stack, and every entry still lands on exact values.
reset('TrendLine');
gesture({ x: 60, y: 40 }, { x: 180, y: 120 });
const switchedId = last().id;
const beforeSwitch = anchorsOf(switchedId) as DrawingAnchor[];
const labelsBefore = history.labels('undo').join('|');
const depthBefore = depth();
// The tape, the bar count and the scales change; the drawings and the steps do not.
env = makeEnv(bars(320, 57_500), 57_000, 60_000);
controller.setTool(null);
check('a symbol switch leaves the stack intact', json(depth()) === json(depthBefore) && history.labels('undo').join('|') === labelsBefore, json(depth()));
check('no stale entry leaked in', depth().undo === 1, json(history.labels('undo')));
disarm();
const switchedFrom = midOf(switchedId);
gesture(switchedFrom, { x: switchedFrom.x + 140, y: switchedFrom.y + 80 });
check('a drawing still moves on the new tape', json(anchorsOf(switchedId)) !== json(beforeSwitch), json(anchorsOf(switchedId)));
history.undo();
check('undo after a switch lands on the exact pre-switch anchors', json(anchorsOf(switchedId)) === json(beforeSwitch), json(anchorsOf(switchedId)));
history.redo();
// A different workspace document owns a different past: its steps are dropped, not replayed.
engine.setInstances([{ id: 'z', toolId: 'TrendLine', anchors: [{ time: FIRST_BAR, price: 58_000 }, { time: FIRST_BAR + 60_000, price: 58_100 }], style: {} }]);
history.clear();
check('a document reload empties the stack', depth().undo === 0 && depth().redo === 0 && history.undo() === false, json(depth()));
check('the reloaded document is untouched by the clear', engine.instances.map((d) => d.id).join(',') === 'z', engine.instances.map((d) => d.id).join(','));

// 17. A gesture that changes nothing records nothing, so undo never stalls on a no-op.
reset('Rectangle');
const noopDepth = depth().undo;
gesture({ x: 300, y: 40 }, { x: 302, y: 41 });
check('a press that never left the anchor records no step', depth().undo === noopDepth, json(history.labels('undo')));

history.clear();
console.log(`undo/redo: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
if (failures.length > 0) process.exitCode = 1;
