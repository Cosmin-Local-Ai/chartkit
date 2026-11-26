/**
 * The workspace file: one workspace, out of the machine and back in.
 *
 * The file is our own format, not a database dump. It carries the same document the
 * server stores under `main` — indicators with their script text, placed drawings, view
 * state, settings and templates — wrapped in a small header that says what it is and
 * which version of the format wrote it. Nothing machine-local goes in: no database path,
 * no server-issued ids, so a file opened on another machine restores a chart rather than
 * a broken reference.
 *
 * A file is never trusted. It is parsed, its header is checked field by field, and then
 * its document goes through `normaliseState`, the same validator a stored document
 * already passes through on load. Whatever that validator had to repair is reported back,
 * so an import states what it dropped instead of quietly losing it.
 */

import { normaliseState } from './workspace';
import type { WorkspaceState } from './workspace';

/** Marks the file as ours. A JSON file with any other kind is a different tool's export. */
export const WORKSPACE_FILE_KIND = 'chartkit.workspace';

/**
 * Format version. A file must state the version this build writes: the format has no
 * migration yet, so an older or newer file is refused with its version named rather than
 * half-read. Bump this and add a step here when a field changes meaning.
 */
export const WORKSPACE_SCHEMA_VERSION = 1;

/** A workspace document is tens of kilobytes; anything larger is the wrong file. */
export const MAX_WORKSPACE_FILE_BYTES = 4 * 1024 * 1024;

export const WORKSPACE_FILE_EXTENSION = 'chartkit.json';

export interface WorkspaceFile {
  kind: typeof WORKSPACE_FILE_KIND;
  schemaVersion: number;
  /** When the file was written, in epoch milliseconds. Informational only. */
  exportedAt: number;
  /** The chart the file came from, so a folder of exports stays readable. */
  source: { instrument: string | null; timeframe: string };
  /** The stored document itself, exactly as `/api/workspaces` holds it. */
  state: WorkspaceState;
}

/** What a file holds, in the words an import confirmation shows before it overwrites. */
export interface WorkspaceFileSummary {
  instrument: string | null;
  timeframe: string;
  seriesStyle: string;
  indicators: number;
  scripts: number;
  drawings: number;
  toolTypes: number;
  templates: number;
  theme: string;
  timezone: string;
  /** True when the file carries a price range the user framed by hand. */
  framedRange: boolean;
  barStep: number | null;
  offsetFromEnd: number | null;
  watchlist: number;
  /** Fields the validator could not take as they stood, e.g. `3 drawings dropped`. */
  repaired: string[];
}

export type WorkspaceFileRead =
  | { ok: true; file: WorkspaceFile; state: WorkspaceState; summary: WorkspaceFileSummary }
  | { ok: false; error: string };

/** Wraps the live document. `exportedAt` is a parameter so a test can pin the bytes. */
export function buildWorkspaceFile(state: WorkspaceState, exportedAt = Date.now()): WorkspaceFile {
  return {
    kind: WORKSPACE_FILE_KIND,
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    exportedAt,
    source: { instrument: state.instrument, timeframe: state.timeframe },
    state: structuredClone(state),
  };
}

export function serialiseWorkspaceFile(file: WorkspaceFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * Turns file text into a document that is safe to put in place of the current one. Every
 * failure comes back as a message naming what was wrong; nothing is applied halfway,
 * because the caller only ever sees a whole document or an error.
 */
export function readWorkspaceFile(text: string): WorkspaceFileRead {
  if (text.length > MAX_WORKSPACE_FILE_BYTES) {
    return { ok: false, error: `file is ${(text.length / 1_048_576).toFixed(1)} MB, over the ${MAX_WORKSPACE_FILE_BYTES / 1_048_576} MB a workspace document can be` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'a workspace file holds one JSON object, not a list or a bare value' };
  }
  const file = raw as Record<string, unknown>;
  const headerError = checkHeader(file);
  if (headerError) return { ok: false, error: headerError };
  const shapeError = checkDocumentShape(file['state']);
  if (shapeError) return { ok: false, error: shapeError };

  const state = normaliseState(file['state']);
  if (!state) return { ok: false, error: 'the file has no workspace document in it' };
  // The header is rebuilt from the fields just checked, so a file cannot smuggle a value
  // past validation by carrying an extra or mistyped key.
  const exportedAt = typeof file['exportedAt'] === 'number' && Number.isFinite(file['exportedAt']) ? file['exportedAt'] : Date.now();
  const header: WorkspaceFile = {
    kind: WORKSPACE_FILE_KIND,
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    exportedAt,
    source: { instrument: state.instrument, timeframe: state.timeframe },
    state,
  };
  return { ok: true, file: header, state, summary: summarise(state, file['state']) };
}

/** The wrapper: is this our file, and does it state a version this build can read? */
function checkHeader(file: Record<string, unknown>): string | null {
  const kind = file['kind'];
  if (kind !== WORKSPACE_FILE_KIND) {
    return `not a chartkit workspace file: kind is ${describe(kind)}, but this build writes "${WORKSPACE_FILE_KIND}"`;
  }
  const version = file['schemaVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return `schemaVersion must be a whole number, but the file says ${describe(version)}`;
  }
  if (version !== WORKSPACE_SCHEMA_VERSION) {
    const direction = version > WORKSPACE_SCHEMA_VERSION ? 'newer than' : 'older than';
    return (
      `this file is schema version ${version}, which is ${direction} the version this build reads (${WORKSPACE_SCHEMA_VERSION}). ` +
      'No migration exists yet, so nothing was changed.'
    );
  }
  return null;
}

/**
 * Container-level checks the field validator does not make: `normaliseState` repairs a
 * missing field into a default, which is right for a stored document but would let a file
 * about something else pass as an empty workspace.
 */
function checkDocumentShape(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return 'the file has no workspace document in it (state is missing or is not an object)';
  }
  const value = raw as Record<string, unknown>;
  for (const key of ['indicators', 'drawings', 'templates', 'watchlist', 'recentTools']) {
    const field = value[key];
    if (field !== undefined && !Array.isArray(field)) return `state.${key} must be a list`;
  }
  for (const key of ['view', 'settings', 'panes', 'weights', 'footprint']) {
    const field = value[key];
    if (field !== undefined && (typeof field !== 'object' || field === null || Array.isArray(field))) {
      return `state.${key} must be an object`;
    }
  }
  const instrument = value['instrument'];
  if (instrument !== null && instrument !== undefined && typeof instrument !== 'string') return 'state.instrument must be a symbol id or null';
  for (const key of ['timeframe', 'seriesStyle']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return `state.${key} must be a string`;
  }
  return null;
}

/**
 * The document plus the raw fields it came from: the validator repairs in place, so the
 * only way to know what it dropped is to compare the counts it was handed.
 */
function summarise(state: WorkspaceState, raw: unknown): WorkspaceFileSummary {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const repaired: string[] = [];
  reportDropped(repaired, 'indicator', value['indicators'], state.indicators.length);
  reportDropped(repaired, 'drawing', value['drawings'], state.drawings.length);
  reportDropped(repaired, 'template', value['templates'], state.templates.length);
  reportDropped(repaired, 'watchlist symbol', value['watchlist'], state.watchlist.length);
  if (Array.isArray(value['drawings'])) {
    const stored = new Set(state.drawings.map((instance) => instance.toolId));
    const names = new Set<string>();
    for (const entry of value['drawings']) {
      const toolId = (entry as { toolId?: unknown } | null)?.toolId;
      if (typeof toolId === 'string' && !stored.has(toolId)) names.add(toolId);
    }
    if (names.size > 0) repaired.push(`tools this build does not have: ${[...names].sort().join(', ')}`);
  }
  return {
    instrument: state.instrument,
    timeframe: state.timeframe,
    seriesStyle: state.seriesStyle,
    indicators: state.indicators.length,
    scripts: state.indicators.filter((instance) => typeof instance.script === 'string').length,
    drawings: state.drawings.length,
    toolTypes: new Set(state.drawings.map((instance) => instance.toolId)).size,
    templates: state.templates.length,
    theme: state.settings.theme,
    timezone: state.settings.timezone,
    framedRange: state.view.autoFit === false && typeof state.view.manualMin === 'number' && typeof state.view.manualMax === 'number',
    barStep: state.view.barStep ?? null,
    offsetFromEnd: state.view.offsetFromEnd ?? null,
    watchlist: state.watchlist.length,
    repaired,
  };
}

function reportDropped(out: string[], noun: string, raw: unknown, kept: number): void {
  if (!Array.isArray(raw)) return;
  const missing = raw.length - kept;
  if (missing > 0) out.push(`${missing} ${noun}${missing === 1 ? '' : 's'} dropped`);
}

function describe(value: unknown): string {
  if (typeof value === 'string') return `"${value.slice(0, 40)}"`;
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'an object';
  return String(value);
}
