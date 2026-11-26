/**
 * Gesture-level test for the drawing controller: the press/move/release path is driven with
 * plain coordinates against real scales, so placement, the click slop, Esc, moving a placed
 * drawing and the Shift constraints are checked without a browser. Pixels go in, time+price
 * comes out, and every assertion converts the stored anchors back through the same scales.
 *
 * Run it with:
 *   npx rolldown tests/drawing-gestures.test.ts -o /tmp/gestures-test.mjs -f esm && node /tmp/gestures-test.mjs
 */

// The test runs in node, whose globals the DOM-only tsconfig does not carry.
declare const process: { exitCode: number };

import { LocalTime } from '../src/format';
import { PriceScale, XScale } from '../src/scale';
import { anchorToPixel, type DrawingAnchor } from '../src/drawings/anchors';
import { DrawingController } from '../src/drawings/controller';
import { DrawingEngine, type DrawingInstance } from '../src/drawings/engine';
import type { ToolEnv } from '../src/drawings/registry';
import type { Bar } from '../src/types';

const PLOT = { left: 0, right: 600, top: 0, bottom: 213 };
const BAR_MS = 60_000;
const FIRST_BAR = Date.UTC(2026, 10, 25, 0, 0, 0);
const BARS: Bar[] = Array.from({ length: 200 }, (_, i) => {
  const close = 58_500 + i * 2;
  return { start: FIRST_BAR + i * BAR_MS, open: close - 4, high: close + 6, low: close - 6, close, volume: 10 + i, trades: 40, closed: true };
});

const env: ToolEnv = {
  x: new XScale({
    count: BARS.length,
    barStep: 4,
    offsetFromEnd: 42,
    left: PLOT.left,
    right: PLOT.right,
    starts: BARS.map((bar) => bar.start),
    barMs: BAR_MS,
    local: new LocalTime('UTC'),
  }),
  price: new PriceScale({ mode: 'linear', min: 58_000, max: 59_000, top: PLOT.top, bottom: PLOT.bottom, precision: 2 }),
  priceTick: 0.01,
  ctx: { measureText: (text: string) => ({ width: text.length * 7 }) } as CanvasRenderingContext2D,
  plot: PLOT,
  instrument: null,
  bars: BARS,
  local: new LocalTime('UTC'),
  measure: (text: string) => text.length * 7,
};

const engine = new DrawingEngine();
const controller = new DrawingController(engine);

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed += 1;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const px = (anchor: DrawingAnchor) => anchorToPixel(anchor, env);
const pixels = (id: string) => engine.instances.filter((d) => d.id === id)[0]!.anchors.map((a) => px(a));
const count = () => engine.instances.length;
const last = (): DrawingInstance => engine.instances[engine.instances.length - 1] as DrawingInstance;
/** A bar is 4 px wide here, so a stored anchor can sit up to half a bar from the pixel it came from. */
const BAR = 2.5;
const near = (a: number, b: number, tolerance = 1.2) => Math.abs(a - b) <= tolerance;
const middleOf = (id: string) => {
  const [a, b] = pixels(id);
  return { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
};

/** A press, some moves, a release: one pointer gesture. */
function drag(from: { x: number; y: number }, to: { x: number; y: number }, shift = false): void {
  controller.pointerDown(from, env);
  const steps = 6;
  for (let i = 1; i <= steps; i += 1) {
    controller.pointerMove({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }, env, shift);
  }
  controller.pointerUp(to, env, shift);
}

/** A plain click: press and release on the same point, which the app turns into a place. */
function click(at: { x: number; y: number }): void {
  controller.pointerDown(at, env);
  controller.pointerUp(at, env, false);
}

function reset(toolId: string | null): void {
  controller.setTool(null);
  engine.instances = [];
  engine.selectedId = null;
  controller.setTool(toolId);
}

// 1. One press-drag-release commits a two-anchor tool.
reset('Rectangle');
const beforeFirst = count();
drag({ x: 60, y: 40 }, { x: 180, y: 120 });
const rect = last();
const rectPx = pixels(rect.id);
check('two-anchor drag creates one drawing', count() === beforeFirst + 1, `count ${count()}`);
check('first anchor lands where the press was', near(rectPx[0]!.x, 60) && near(rectPx[0]!.y, 40), JSON.stringify(rectPx[0]!));
check('second anchor lands where the release was', near(rectPx[1]!.x, 180) && near(rectPx[1]!.y, 120), JSON.stringify(rectPx[1]!));

// 2. A release that never left the press places nothing extra.
reset('Rectangle');
drag({ x: 300, y: 40 }, { x: 302, y: 41 });
check('release inside the click slop creates nothing', count() === 0, `count ${count()}`);
check('the placement stays in progress after it', controller.pending.length === 1, `pending ${controller.pending.length}`);
drag({ x: 300, y: 40 }, { x: 420, y: 130 });
const resumed = pixels(last().id);
check('the next release completes that placement', count() === 1 && near(resumed[1]!.x, 420) && near(resumed[1]!.y, 130), JSON.stringify(resumed));
check('its first anchor stayed at the first press', near(resumed[0]!.x, 300, 4) && near(resumed[0]!.y, 40, 1.5), JSON.stringify(resumed[0]!));

// 3. An N-anchor tool takes exactly one anchor per release.
reset('ThreeDrivesPattern');
const legs = [
  { x: 40, y: 100 },
  { x: 140, y: 60 },
  { x: 240, y: 130 },
  { x: 340, y: 70 },
  { x: 440, y: 120 },
];
const afterEach: number[] = [];
for (let i = 1; i < legs.length; i += 1) {
  drag(legs[i - 1]!, legs[i]!);
  afterEach.push(count());
}
check('one anchor per release, nothing before the last', afterEach.join(',') === '0,0,0,1', afterEach.join(','));
const drives = pixels(last().id);
check(
  'the finished pattern carries every point',
  drives.length === 5 && drives.every((p, i) => near(p.x, legs[i]!.x) && near(p.y, legs[i]!.y)),
  JSON.stringify(drives),
);

// 4. Esc mid-drag persists nothing.
reset('Rectangle');
controller.pointerDown({ x: 60, y: 40 }, env);
controller.pointerMove({ x: 120, y: 80 }, env, false);
controller.pointerMove({ x: 180, y: 110 }, env, false);
controller.cancel();
controller.pointerUp({ x: 190, y: 115 }, env, false);
check('Esc during a shape drag stores no drawing', count() === 0, `count ${count()}`);
check('Esc drops the pending anchors', controller.pending.length === 0, `pending ${controller.pending.length}`);

// 5. A drag that starts on an existing drawing moves it instead of creating one.
reset(null);
const placed = engine.add('Rectangle', [
  { time: BARS[120]!.start, price: 58_740 },
  { time: BARS[160]!.start, price: 58_660 },
]);
const bodyWas = pixels(placed!.id);
const middle = middleOf(placed!.id);
drag(middle, { x: middle.x + 80, y: middle.y - 30 });
const bodyNow = pixels(placed!.id);
check('the body drag creates nothing', count() === 1, `count ${count()}`);
check('the pressed drawing moved with the pointer', bodyNow.every((p, i) => near(p.x - bodyWas[i]!.x, 80, BAR) && near(p.y - bodyWas[i]!.y, -30, 1.5)), JSON.stringify([bodyWas, bodyNow]));

// 6. Esc while that move is still held puts the drawing back.
const heldWas = pixels(placed!.id);
const heldMiddle = middleOf(placed!.id);
controller.pointerDown(heldMiddle, env);
controller.pointerMove({ x: heldMiddle.x + 40, y: heldMiddle.y + 20 }, env, false);
const heldNow = pixels(placed!.id);
check('a held move does change the drawing first', heldNow.some((p, i) => !near(p.x, heldWas[i]!.x, BAR)), JSON.stringify([heldWas, heldNow]));
controller.cancel();
controller.pointerUp({ x: heldMiddle.x + 40, y: heldMiddle.y + 20 }, env, false);
const reverted = pixels(placed!.id);
check('Esc during a held move restores the pre-drag anchors', reverted.every((p, i) => near(p.x, heldWas[i]!.x, BAR) && near(p.y, heldWas[i]!.y, 1.5)), JSON.stringify([heldWas, reverted]));

// 7. A handle drag moves one anchor and leaves the other.
const grabWas = pixels(placed!.id);
const handle = grabWas[0]!;
controller.pointerDown(handle, env);
controller.pointerMove({ x: handle.x + 20, y: handle.y + 12 }, env, false);
controller.pointerUp({ x: handle.x + 30, y: handle.y + 18 }, env, false);
const handled = pixels(placed!.id);
check('the grabbed anchor moved', !near(handled[0]!.x, grabWas[0]!.x, 10) && !near(handled[0]!.y, grabWas[0]!.y, 10), JSON.stringify([grabWas[0]!, handled[0]!]));
check('the other anchor stayed', near(handled[1]!.x, grabWas[1]!.x, BAR) && near(handled[1]!.y, grabWas[1]!.y, 1.5), JSON.stringify([grabWas[1]!, handled[1]!]));
check(
  'the release point, not the last move, is where the anchor lands',
  near(handled[0]!.x, handle.x + 30, BAR) && near(handled[0]!.y, handle.y + 18, 1.5),
  JSON.stringify([handle, handled[0]!]),
);

// 8. With a tool armed the same press creates a new shape and leaves the old one alone.
reset('Rectangle');
const held = engine.add('Rectangle', [
  { time: BARS[120]!.start, price: 58_740 },
  { time: BARS[160]!.start, price: 58_660 },
]);
const underWas = pixels(held!.id);
const over = middleOf(held!.id);
drag(over, { x: over.x + 90, y: over.y + 40 });
const underNow = pixels(held!.id);
check('an armed press over a drawing creates a second one', count() === 2, `count ${count()}`);
check('the drawing underneath stays put', underNow.every((p, i) => near(p.x, underWas[i]!.x, BAR) && near(p.y, underWas[i]!.y, 1.5)), JSON.stringify([underWas, underNow]));
const made = pixels(last().id);
check(
  'the new shape took the gesture points',
  near(made[0]!.x, over.x, BAR) && near(made[0]!.y, over.y, 1.5) && near(made[1]!.x, over.x + 90, BAR) && near(made[1]!.y, over.y + 40, 1.5),
  JSON.stringify([over, made]),
);

// 9. Shift constraints, measured in pane pixels.
reset('Rectangle');
drag({ x: 100, y: 100 }, { x: 220, y: 40 }, true);
const square = pixels(last().id);
const boxW = Math.abs(square[1]!.x - square[0]!.x);
const boxH = Math.abs(square[1]!.y - square[0]!.y);
check('Shift squares the rectangle', near(boxW, boxH, 1.5) && near(boxW, Math.max(120, 60), 1.5), `${boxW}x${boxH}`);

reset('TrendLine');
drag({ x: 100, y: 100 }, { x: 200, y: 188 }, true);
const diagonal = pixels(last().id);
const run = Math.abs(diagonal[1]!.x - diagonal[0]!.x);
const rise = Math.abs(diagonal[1]!.y - diagonal[0]!.y);
check('Shift snaps a near-diagonal run to 45 degrees', near(run, rise, BAR) && run > 20, `${run} / ${rise}`);

reset('TrendLine');
drag({ x: 100, y: 100 }, { x: 200, y: 112 }, true);
const flatRun = pixels(last().id);
check(
  'Shift flattens a near-level run instead',
  Math.abs(flatRun[1]!.y - flatRun[0]!.y) < 1.5 && Math.abs(flatRun[1]!.x - flatRun[0]!.x) > 60,
  JSON.stringify(flatRun),
);

reset('HorizontalLine');
drag({ x: 100, y: 100 }, { x: 200, y: 160 }, true);
const flat = pixels(last().id);
check('Shift keeps a horizontal line at its price', near(flat[0]!.y, 100, 1.2), JSON.stringify(flat[0]!));

reset('VerticalLine');
drag({ x: 100, y: 100 }, { x: 240, y: 160 }, true);
const upright = pixels(last().id);
check('Shift keeps a vertical line at its bar', near(upright[0]!.x, 100, 1.2), JSON.stringify(upright[0]!));

// 10. Successive clicks still place, one anchor per click.
reset('ParallelLine');
const clicks = [
  { x: 80, y: 60 },
  { x: 200, y: 90 },
  { x: 320, y: 70 },
];
const afterClicks: number[] = [];
for (const at of clicks) {
  click(at);
  afterClicks.push(count());
}
check('clicks place one anchor each and finish on the last', afterClicks.join(',') === '0,0,1', afterClicks.join(','));
const lines = pixels(last().id);
check(
  'the clicked drawing holds every clicked point',
  lines.length === 3 && lines.every((p, i) => near(p.x, clicks[i]!.x) && near(p.y, clicks[i]!.y)),
  JSON.stringify(lines),
);

console.log(`drawing gestures: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
if (failures.length > 0) process.exitCode = 1;
