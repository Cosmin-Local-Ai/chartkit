/**
 * The keyboard reference, and the one place the plain chart keys are named.
 *
 * `PLAIN_KEYS` is what app.ts switches on, so a row that carries a `bind` cannot drift from
 * the handler: the Node test compares the two in both directions. The remaining rows name
 * keys the handler special-cases (`/`, `Escape`, `i`, `Delete`, the Ctrl combos); the test
 * reads app.ts and fails if one of those literals stops appearing there.
 */

/** Actions app.ts takes from an unmodified key press. */
export type PlainAction = 'panLeft' | 'panRight' | 'zoomIn' | 'zoomOut' | 'home' | 'fitAll' | 'toggleScale';

/** Keys per action. `f`/`F` and `l`/`L` cover both shift states of the same letter. */
export const PLAIN_KEYS: Record<PlainAction, string[]> = {
  panLeft: ['ArrowLeft'],
  panRight: ['ArrowRight'],
  zoomIn: ['ArrowUp', '+', '='],
  zoomOut: ['ArrowDown', '-', '_'],
  home: ['Home'],
  fitAll: ['f', 'F'],
  toggleScale: ['l', 'L'],
};

/**
 * How each key the handler matches is printed in the reference. The handler works on
 * `event.key` values; the dialog shows arrows and one letter per key, and the Node test
 * proves the two cover the same set.
 */
export const KEY_LABELS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  '+': '+',
  '=': '=',
  '-': '−',
  '_': '_',
  Home: 'Home',
  f: 'F',
  F: 'F',
  l: 'L',
  L: 'L',
};

/** The inverse map app.ts looks up: key press to action. */
export const PLAIN_KEY_ACTIONS: Record<string, PlainAction> = Object.fromEntries(
  Object.entries(PLAIN_KEYS).flatMap(([action, keys]) => keys.map((key) => [key, action as PlainAction])),
);

export interface ShortcutRow {
  /** Key combinations as the dialog prints them. */
  keys: string[];
  /** What the key does, in the words the dialog shows. */
  action: string;
  /** Set when the row's keys come from `PLAIN_KEYS`, which the Node test holds in sync. */
  bind?: PlainAction;
  /** Keys the handler special-cases, listed so the test can find them in app.ts. */
  literal?: string;
}

export interface ShortcutGroup {
  title: string;
  note?: string;
  rows: ShortcutRow[];
}

/**
 * Keys that work with no dialog open and no caret in a text field. The dialog says this once
 * per group instead of repeating it on every row.
 */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Dialogs',
    note: 'These work anywhere except while typing in a field.',
    rows: [
      { keys: ['/'], action: 'Search symbols', literal: "'/'" },
      { keys: ['I'], action: 'Indicator list', literal: "'i'" },
      { keys: ['A'], action: 'Alerts: rules and trigger history', literal: "'a'" },
      { keys: ['?'], action: 'Settings', literal: "'?'" },
      // The handler matches this on `event.key === '/'` plus a Ctrl or Cmd modifier.
      { keys: ['Ctrl + /'], action: 'This keyboard reference', literal: "'/'" },
      {
        keys: ['Esc'],
        action: 'Close the open dialog, or drop the drawing being placed',
        literal: "'Escape'",
      },
    ],
  },
  {
    title: 'Time and zoom',
    note: 'Chart keys: no dialog open, and the caret out of any text field.',
    rows: [
      { keys: ['←'], action: 'Pan one bar older', bind: 'panLeft' },
      { keys: ['→'], action: 'Pan one bar newer', bind: 'panRight' },
      { keys: ['Shift + ←', 'Shift + →'], action: 'Pan ten bars' },
      { keys: ['↑', '+', '='], action: 'Zoom in', bind: 'zoomIn' },
      { keys: ['↓', '−', '_'], action: 'Zoom out', bind: 'zoomOut' },
      { keys: ['Home'], action: 'Jump to the newest bar', bind: 'home' },
      { keys: ['F'], action: 'Fit every stored bar', bind: 'fitAll' },
    ],
  },
  {
    title: 'Scale, history, drawings',
    rows: [
      { keys: ['L'], action: 'Toggle log and linear price scale', bind: 'toggleScale' },
      { keys: ['Ctrl + Z'], action: 'Undo', literal: "'z'" },
      { keys: ['Ctrl + Shift + Z', 'Ctrl + Y'], action: 'Redo', literal: "'y'" },
      { keys: ['Delete', 'Backspace'], action: 'Delete the selected drawing', literal: "'Delete'" },
    ],
  },
  {
    title: 'Pointer',
    note: 'The chart never needs to hold focus for these.',
    rows: [
      { keys: ['Wheel'], action: 'Zoom at the cursor' },
      { keys: ['Shift + Wheel'], action: 'Pan left and right' },
      { keys: ['Drag'], action: 'Pan the tape' },
      { keys: ['Drag in the price gutter'], action: 'Frame a price range by hand' },
      { keys: ['Right click'], action: 'Drawing menu, or chart actions over empty tape' },
      { keys: ['Double click'], action: 'Fit all; over a drawing, its style form' },
      { keys: ['Double click the gutter'], action: 'Fit the price axis to the view' },
      { keys: ['Double click an indicator pane'], action: 'That indicator’s settings' },
      { keys: ['Double click the footprint pane'], action: 'Footprint settings' },
    ],
  },
];
