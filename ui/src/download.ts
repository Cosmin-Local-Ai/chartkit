/**
 * Getting a file out of the browser. The server has no export route, so an export is a
 * Blob and a click on a hidden anchor: the browser writes the bytes and names the file,
 * and nothing about the download path ever reaches the chart.
 */

import { WORKSPACE_FILE_EXTENSION } from './workspaceFile';

const JSON_MIME = 'application/json';
const CSV_MIME = 'text/csv';

/** Writes `text` to disk as `filename` and lets the browser pick where it lands. */
export function downloadFile(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // The browser reads the blob when the click lands, so the object URL stays alive for the
  // next task only; revoking it any later leaves the download intact and the memory freed.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadJson(filename: string, text: string): void {
  downloadFile(filename, text, JSON_MIME);
}

export function downloadCsv(filename: string, text: string): void {
  downloadFile(filename, text, CSV_MIME);
}

/** `BINANCE:BTCUSDT` reads badly in a filename, so the venue separator becomes a dash. */
export function safeName(id: string | null): string {
  if (!id) return 'no-symbol';
  return id.replace(/[^A-Za-z0-9._-]+/g, '-');
}

/** `20261125-2215` in UTC, so two exports sort in the order they were taken. */
export function fileStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
}

export function workspaceFileName(instrument: string | null, at: number): string {
  return `chartkit-${safeName(instrument)}-${fileStamp(at)}.${WORKSPACE_FILE_EXTENSION}`;
}

export function barsFileName(instrument: string | null, timeframe: string, at: number): string {
  return `bars-${safeName(instrument)}-${timeframe}-${fileStamp(at)}.csv`;
}

/**
 * A prints file that stopped at the server's row limit says so in its name, because the
 * dialog it came from is already gone by the time the file is opened again.
 */
export function printsFileName(instrument: string | null, at: number, partial: boolean): string {
  return `prints-${safeName(instrument)}-${fileStamp(at)}${partial ? '-partial' : ''}.csv`;
}
