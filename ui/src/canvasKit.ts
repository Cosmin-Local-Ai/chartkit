/** Shared canvas helpers: theme colours and crisp pixel-aligned primitives. */

/** Every colour a pane can paint with. The settings dialog rewrites this object in place. */
export interface Palette {
  bg: string;
  grid: string;
  gridMajor: string;
  axisLine: string;
  text: string;
  muted: string;
  up: string;
  down: string;
  upFill: string;
  downFill: string;
  accent: string;
  crosshair: string;
  tagBg: string;
  buy: string;
  sell: string;
  poc: string;
  pocLine: string;
  imbalance: string;
  cvd: string;
  live: string;
  offSession: string;
  gap: string;
}

/** The palette the chart has always shipped with. */
export const DARK_PALETTE: Palette = {
  bg: '#0f1317',
  grid: 'rgba(148,163,178,0.09)',
  gridMajor: 'rgba(148,163,178,0.19)',
  axisLine: 'rgba(148,163,178,0.28)',
  text: '#cbd5e1',
  muted: '#7c8896',
  up: '#26b98a',
  down: '#e8555c',
  upFill: 'rgba(38,185,138,0.16)',
  downFill: 'rgba(232,85,92,0.16)',
  accent: '#4b9cf5',
  crosshair: 'rgba(203,213,225,0.55)',
  tagBg: '#2b3540',
  buy: 'rgba(38,185,138,0.20)',
  sell: 'rgba(232,85,92,0.20)',
  poc: 'rgba(232,178,66,0.26)',
  pocLine: '#e8b242',
  imbalance: 'rgba(75,156,245,0.34)',
  cvd: '#9a7bf2',
  live: '#e8b242',
  offSession: 'rgba(148,163,178,0.06)',
  gap: 'rgba(148,163,178,0.35)',
};

/** Same slots, inked for a light pane. */
export const LIGHT_PALETTE: Palette = {
  bg: '#f7f9fb',
  grid: 'rgba(71,85,105,0.16)',
  gridMajor: 'rgba(71,85,105,0.30)',
  axisLine: 'rgba(71,85,105,0.45)',
  text: '#1f2933',
  muted: '#5b6b7c',
  up: '#12996f',
  down: '#d1414b',
  upFill: 'rgba(18,153,111,0.18)',
  downFill: 'rgba(209,65,75,0.18)',
  accent: '#2f7fd6',
  crosshair: 'rgba(71,85,105,0.55)',
  tagBg: '#dde4ec',
  buy: 'rgba(18,153,111,0.22)',
  sell: 'rgba(209,65,75,0.22)',
  poc: 'rgba(180,124,20,0.30)',
  pocLine: '#b47c14',
  imbalance: 'rgba(47,127,214,0.34)',
  cvd: '#7a55d6',
  live: '#b47c14',
  offSession: 'rgba(71,85,105,0.10)',
  gap: 'rgba(71,85,105,0.45)',
};

/**
 * The palette every pane reads at draw time. `applyAppearance` in settings.ts rewrites it
 * in place, so a settings change repaints on the next frame without a reload.
 */
export const THEME: Palette = { ...DARK_PALETTE };

export const FONT_MONO = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export type Align = 'left' | 'right' | 'center';

export function drawText(
  ctx: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  options: { font?: string; color?: string; align?: Align; baseline?: CanvasTextBaseline } = {},
): number {
  ctx.font = options.font ?? FONT_MONO;
  ctx.fillStyle = options.color ?? THEME.text;
  ctx.textAlign = options.align ?? 'left';
  ctx.textBaseline = options.baseline ?? 'middle';
  ctx.fillText(value, x, y);
  return ctx.measureText(value).width;
}

export function measureText(ctx: CanvasRenderingContext2D, value: string, font = FONT_MONO): number {
  ctx.font = font;
  return ctx.measureText(value).width;
}

/** Hairline-straight horizontal rule: half-pixel offset keeps 1px lines sharp. */
export function hLine(ctx: CanvasRenderingContext2D, x1: number, x2: number, y: number, color: string): void {
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  const yy = Math.round(y) + 0.5;
  ctx.moveTo(Math.round(x1), yy);
  ctx.lineTo(Math.round(x2), yy);
  ctx.stroke();
}

export function vLine(ctx: CanvasRenderingContext2D, x: number, y1: number, y2: number, color: string): void {
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  const xx = Math.round(x) + 0.5;
  ctx.moveTo(xx, Math.round(y1));
  ctx.lineTo(xx, Math.round(y2));
  ctx.stroke();
}

export function dashedH(ctx: CanvasRenderingContext2D, x1: number, x2: number, y: number, color: string): void {
  ctx.save();
  ctx.setLineDash([3, 3]);
  hLine(ctx, x1, x2, y, color);
  ctx.restore();
}

export function dashedV(ctx: CanvasRenderingContext2D, x: number, y1: number, y2: number, color: string): void {
  ctx.save();
  ctx.setLineDash([3, 3]);
  vLine(ctx, x, y1, y2, color);
  ctx.restore();
}

/** Axis bubble: label on a solid plate so it stays legible over the tape. */
export function drawTag(
  ctx: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  options: { align?: Align; color?: string; background?: string; width?: number } = {},
): void {
  const width = options.width ?? measureText(ctx, value) + 10;
  const height = 16;
  const left = options.align === 'right' ? x - width : options.align === 'center' ? x - width / 2 : x;
  ctx.fillStyle = options.background ?? THEME.tagBg;
  ctx.fillRect(Math.round(left), Math.round(y - height / 2), Math.round(width), height);
  drawText(ctx, value, left + 5, y, { color: options.color ?? THEME.text });
}

export function fillRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
}

/** Hex colour with an explicit alpha, so a user-picked colour can drive a heat cell. */
export function withAlpha(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a.toFixed(3)})`;
}

/** Linear blend of two hex colours; `t` runs 0 at `from` to 1 at `to`. */
export function mixHex(from: string, to: string, t: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  const k = Math.max(0, Math.min(1, t));
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * k)},${Math.round(a[1] + (b[1] - a[1]) * k)},${Math.round(a[2] + (b[2] - a[2]) * k)})`;
}

function parseHex(hex: string): [number, number, number] {
  const text = hex.startsWith('#') ? hex.slice(1) : hex;
  const short = text.length === 3;
  const value = Number.parseInt(short ? text.split('').map((c) => c + c).join('') : text, 16);
  if (!Number.isFinite(value)) return [203, 213, 225];
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** Alpha-blended heat cell used by the footprint ladder. */
export function heat(base: 'buy' | 'sell', strength: number): string {
  const clamped = Math.max(0, Math.min(1, strength));
  const alpha = 0.06 + clamped * 0.42;
  return base === 'buy' ? `rgba(38,185,138,${alpha.toFixed(3)})` : `rgba(232,85,92,${alpha.toFixed(3)})`;
}

/** Resize the backing store for the device pixel ratio and reset the transform. */
export function fitCanvas(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dpr: number,
): void {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const targetW = Math.max(1, Math.round(w * dpr));
  const targetH = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
