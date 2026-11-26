/**
 * The one property renderer. Every control — the quick bar and the full properties
 * form — is built from the shared descriptor map, so a tool gains its whole editor
 * by listing keys.
 */

import { el } from '../canvasKit';
import {
  STYLE_DESCRIPTORS,
  colorInputValue,
  normaliseLevels,
  type StyleDescriptor,
  type StyleKind,
  type StyleValue,
  type StyleValues,
} from './style';

export type PatchHandler = (patch: StyleValues) => void;

/** Field is hidden while its `visibleWhen` guard does not hold, as their editor does. */
export function fieldIsVisible(descriptor: StyleDescriptor, style: StyleValues): boolean {
  const guard = descriptor.visibleWhen;
  if (!guard) return true;
  return style[guard.key] === guard.equals;
}

export function styleField(descriptor: StyleDescriptor, style: StyleValues, onPatch: PatchHandler): HTMLElement {
  const wrap = el('label', 'ind-field');
  const suffix = descriptor.suffix ? ` (${descriptor.suffix})` : '';
  wrap.append(el('span', 'ind-field-label', descriptor.label + suffix));

  if (descriptor.kind === 'color') wrap.append(colorControl(descriptor, style, onPatch));
  else if (descriptor.kind === 'toggle') wrap.append(toggleControl(descriptor, style, onPatch));
  else if (descriptor.kind === 'segmented') wrap.append(segmentedControl(descriptor, style, onPatch));
  else if (descriptor.kind === 'select' || descriptor.kind === 'font') wrap.append(selectControl(descriptor, style, onPatch));
  else if (descriptor.kind === 'multiselect') wrap.append(multiControl(descriptor, style, onPatch));
  else if (descriptor.kind === 'levels') wrap.append(levelsControl(descriptor, style, onPatch));
  else if (descriptor.kind === 'text') wrap.append(textControl(descriptor, style, onPatch));
  else wrap.append(numberControl(descriptor, style, onPatch));
  return wrap;
}

/** Kinds that fit a compact strip; the rest need the full row the form gives them. */
const COMPACT_KINDS: ReadonlySet<StyleKind> = new Set(['color', 'number', 'segmented', 'select', 'font']);
/** A strip stays a strip. */
const STRIP_KEY_LIMIT = 4;

/**
 * Which keys a strip shows. The shipped per-tool quick-bar list wins whenever a tool
 * declares one — an empty list means that tool has no strip. The tools that ship without
 * one fall back to their own style keys, in declaration order, keeping only the four first
 * controls a compact row can render.
 */
export function stripKeysFor(declared: readonly string[] | undefined, styleKeys: readonly string[]): string[] {
  if (declared) return [...declared];
  const out: string[] = [];
  for (const key of styleKeys) {
    const descriptor = STYLE_DESCRIPTORS[key];
    if (!descriptor || !COMPACT_KINDS.has(descriptor.kind)) continue;
    out.push(key);
    if (out.length >= STRIP_KEY_LIMIT) break;
  }
  return out;
}

/** Compact strip of the keys a tool declares a quick bar for. */
export function quickBar(keys: readonly string[], style: StyleValues, onPatch: PatchHandler): HTMLElement {
  const row = el('div', 'drw-quick');
  for (const key of keys) {
    const descriptor = STYLE_DESCRIPTORS[key];
    if (!descriptor || !fieldIsVisible(descriptor, style)) continue;
    row.append(compactField(descriptor, style, onPatch));
  }
  return row;
}

/** Full form: every key the tool uses, in declaration order. */
export function styleForm(keys: readonly string[], style: StyleValues, onPatch: PatchHandler): HTMLElement {
  const form = el('div', 'ind-form');
  for (const key of keys) {
    const descriptor = STYLE_DESCRIPTORS[key];
    if (!descriptor || !fieldIsVisible(descriptor, style)) continue;
    form.append(styleField(descriptor, style, onPatch));
  }
  return form;
}

function compactField(descriptor: StyleDescriptor, style: StyleValues, onPatch: PatchHandler): HTMLElement {
  const wrap = el('div', 'drw-quick-item');
  wrap.append(el('span', 'ind-field-label', descriptor.label));
  const control =
    descriptor.kind === 'color'
      ? colorControl(descriptor, style, onPatch)
      : descriptor.kind === 'number'
        ? numberControl(descriptor, style, onPatch)
        : descriptor.kind === 'font' || descriptor.kind === 'select' || descriptor.kind === 'segmented'
          ? selectControl(descriptor, style, onPatch)
          : null;
  if (control) wrap.append(control);
  return wrap;
}

function colorControl(descriptor: StyleDescriptor, style: StyleValues, onPatch: PatchHandler): HTMLElement {
  const row = el('div', 'ind-swatch');
  const input = el('input');
  input.type = 'color';
  input.value = colorInputValue(String(style[descriptor.key] ?? descriptor.default));
  input.setAttribute('aria-label', descriptor.label);
  input.addEventListener('input', () => onPatch({ [descriptor.key]: input.value }));
  row.append(input, el('span', 'ind-swatch-label', input.value));
  return row;
}

function toggleControl(descriptor: StyleDescriptor, style: StyleValues, onPatch: PatchHandler): HTMLElement {
  const input = el('input', 'ind-check');
  input.type = 'checkbox';
  input.checked = style[descriptor.key] === true;
  input.setAttribute('aria-label', descriptor.label);
  input.addEventListener('change', () => onPatch({ [descriptor.key]: input.checked }));
  return input;
}

function segmentedControl(descriptor: StyleDescriptor, style: StyleValues, onPatch: PatchHandler): HTMLElement {
  const group = el('div', 'drw-seg');
  const current = String(style[descriptor.key] ?? descriptor.default);
  for (const option of descriptor.options ?? []) {
    const button = el('button', 'drw-seg-item', optionLabel(option));
    button.type = 'button';
    button.classList.toggle('is-on', option === current);
    button.addEventListener('click', () => onPatch({ [descriptor.key]: option }));
    group.append(button);
  }
  return group;
}

function selectControl(descriptor: StyleDescriptor, style: StyleValues, onPatch: PatchHandler): HTMLElement {
  const select = el('select', 'dialog-select');
  for (const option of descriptor.options ?? []) {
    const node = el('option', undefined, optionLabel(option));
    node.value = option;
    select.append(node);
  }
  select.value = String(style[descriptor.key] ?? descriptor.default);
  select.addEventListener('change', () => onPatch({ [descriptor.key]: select.value }));
  return select;
}

function multiControl(descriptor: StyleDescriptor, style: StyleValues, onPatch: PatchHandler): HTMLElement {
  const row = el('div', 'drw-checks');
  const raw = style[descriptor.key];
  const picked = Array.isArray(raw) ? (raw as string[]) : [];
  for (const option of descriptor.options ?? []) {
    const label = el('label', 'drw-check');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = picked.includes(option);
    input.addEventListener('change', () => {
      const next = picked.filter((entry) => entry !== option);
      if (input.checked) next.push(option);
      onPatch({ [descriptor.key]: next });
    });
    label.append(input, el('span', 'ind-swatch-label', optionLabel(option)));
    row.append(label);
  }
  return row;
}

function textControl(descriptor: StyleDescriptor, style: StyleValues, onPatch: PatchHandler): HTMLElement {
  const input = el('input', 'dialog-input');
  input.type = 'text';
  input.value = String(style[descriptor.key] ?? descriptor.default ?? '');
  input.addEventListener('input', () => onPatch({ [descriptor.key]: input.value }));
  return input;
}

function numberControl(descriptor: StyleDescriptor, style: StyleValues, onPatch: PatchHandler): HTMLElement {
  const input = el('input', 'dialog-input');
  input.type = 'number';
  if (descriptor.min !== undefined) input.min = String(descriptor.min);
  if (descriptor.max !== undefined) input.max = String(descriptor.max);
  input.step = String(descriptor.step ?? 1);
  const value = style[descriptor.key];
  input.value = String(typeof value === 'number' ? value : Number(descriptor.default) || 0);
  input.addEventListener('input', () => {
    const next = Number(input.value);
    if (!Number.isFinite(next)) return;
    onPatch({ [descriptor.key]: next });
  });
  return input;
}

/** Editable level list: the shipped `levels` kind, one `{value, color, enabled}` row each. */
function levelsControl(descriptor: StyleDescriptor, style: StyleValues, onPatch: PatchHandler): HTMLElement {
  const wrap = el('div', 'drw-levels');
  const levels = normaliseLevels(style[descriptor.key], []);
  levels.forEach((level, index) => {
    const row = el('div', 'drw-level-row');
    const enabled = el('input', 'ind-check');
    enabled.type = 'checkbox';
    enabled.checked = level.enabled;
    enabled.setAttribute('aria-label', `Level ${level.value}`);
    enabled.addEventListener('change', () => patchLevel(index, { enabled: enabled.checked }));

    const value = el('input', 'dialog-input');
    value.type = 'number';
    value.step = '0.001';
    value.value = String(level.value);
    value.setAttribute('aria-label', `Level ${index + 1} value`);
    value.addEventListener('input', () => {
      const next = Number(value.value);
      if (Number.isFinite(next)) patchLevel(index, { value: next });
    });

    const swatch = el('input');
    swatch.type = 'color';
    swatch.value = colorInputValue(level.color);
    swatch.setAttribute('aria-label', `Level ${index + 1} color`);
    swatch.addEventListener('input', () => patchLevel(index, { color: swatch.value }));

    const remove = el('button', 'dialog-watch', '×');
    remove.type = 'button';
    remove.title = 'Remove level';
    remove.addEventListener('click', () => {
      const next = levels.filter((_, position) => position !== index);
      onPatch({ [descriptor.key]: next });
    });
    row.append(enabled, value, swatch, remove);
    wrap.append(row);
  });

  const add = el('button', 'dialog-watch', 'add level');
  add.type = 'button';
  add.addEventListener('click', () => {
    const last = levels[levels.length - 1];
    onPatch({
      [descriptor.key]: [
        ...levels,
        { value: last ? last.value + 0.1 : 0.5, color: last?.color ?? '#787B86', enabled: true },
      ],
    });
  });
  wrap.append(add);
  return wrap;

  function patchLevel(index: number, patch: Partial<(typeof levels)[number]>): void {
    const next = levels.map((level, position) => (position === index ? { ...level, ...patch } : level));
    onPatch({ [descriptor.key]: next as StyleValue });
  }
}

/** Shipped option ids stay the stored value; only the label is prettified. */
function optionLabel(option: string): string {
  if (option === option.toUpperCase()) return option;
  return option.charAt(0).toUpperCase() + option.slice(1);
}
