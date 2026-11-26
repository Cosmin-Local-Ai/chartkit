import type { Coverage } from './types';
import type { ConnectionPhase, LatencySample } from './live';
import { el } from './canvasKit';
import { fmtAge, fmtCompact } from './format';

export interface SeriesStatus {
  loaded: number;
  /** Bars the view actually shows: loaded history is usually wider than the plot. */
  visible: number;
  loadingOlder: boolean;
  olderExhausted: boolean;
}

/**
 * Status strip: feed health, feed latency, what the server has stored, how much of it is on
 * screen, and the last server error. No limits or plans are reported because none
 * apply: history is bounded only by what is stored locally.
 */
export class StatusStrip {
  private readonly feed = el('span', 'st-chip st-feed');
  private readonly server = el('span', 'st-chip st-server');
  private readonly stored = el('span', 'st-chip');
  private readonly loaded = el('span', 'st-chip');
  private readonly latency = el('span', 'st-chip st-latency');
  private readonly error = el('span', 'st-chip st-error');
  private readonly keys = el('span', 'st-keys');
  private coverage: Coverage | null = null;
  private series: SeriesStatus = { loaded: 0, visible: 0, loadingOlder: false, olderExhausted: false };
  private feedPhase: ConnectionPhase = 'idle';
  private feedDetail = '';
  private serverState = '';
  private serverDetail = '';
  private lastBeat = 0;
  private showLatency = true;
  private latencySample: LatencySample | null = null;
  private latencyAlertMs = 1_500;

  constructor(root: HTMLElement) {
    root.classList.add('status');
    this.keys.textContent =
      '← → pan · +/− zoom · Home latest · Shift+←/→ faster · F fit all · L log scale · I indicators · / search · ? settings · Ctrl+/ shortcuts · Ctrl+Z undo · Ctrl+Shift+Z redo · Esc close';
    root.append(this.feed, this.server, this.latency, this.stored, this.loaded, this.error, this.keys);
    this.render();
  }

  setFeed(phase: ConnectionPhase, detail: string, beatAt: number): void {
    this.feedPhase = phase;
    this.feedDetail = detail;
    this.lastBeat = beatAt;
    this.render();
  }

  setServerState(state: string, detail: string): void {
    this.serverState = state;
    this.serverDetail = detail;
    this.render();
  }

  setCoverage(coverage: Coverage | null): void {
    this.coverage = coverage;
    this.render();
  }

  setSeries(status: SeriesStatus): void {
    this.series = status;
    this.render();
  }

  /** Feed latency, on and coloured by the threshold the settings dialog sets. */
  setLatency(show: boolean, sample: LatencySample | null, alertMs: number): void {
    this.showLatency = show;
    this.latencySample = sample;
    this.latencyAlertMs = alertMs;
    this.render();
  }

  setError(text: string | null): void {
    this.error.textContent = text ?? '';
    this.error.hidden = !text;
  }

  /** Refreshes the age labels once a second from the draw loop. */
  tick(now: number): void {
    this.render(now);
  }

  private render(now = Date.now()): void {
    this.feed.dataset.phase = this.feedPhase;
    this.feed.textContent = `feed ${this.feedPhase === 'open' ? 'streaming' : this.feedPhase}`;
    this.feed.title = [this.feedDetail, this.lastBeat ? `last message ${fmtAge(this.lastBeat, now)}` : 'no messages yet']
      .filter(Boolean)
      .join(' · ');

    this.server.hidden = this.serverState === '';
    this.server.dataset.phase = this.serverState === 'live' ? 'open' : this.serverState === 'failed' ? 'error' : 'connecting';
    this.server.textContent = `venue ${this.serverState || 'unknown'}`;
    this.server.title = this.serverDetail;

    this.latency.hidden = !this.showLatency;
    if (this.showLatency) {
      const sample = this.latencySample;
      this.latency.dataset.level = sample === null ? 'unknown' : sample.ms > this.latencyAlertMs ? 'slow' : 'ok';
      this.latency.textContent = sample ? `latency ${Math.round(sample.ms)} ms` : 'latency —';
      this.latency.title = sample
        ? `venue stamp minus arrival, so it includes clock skew · ${sample.samples} sample${sample.samples === 1 ? '' : 's'} · last ${fmtAge(sample.at, now)} · warns above ${this.latencyAlertMs} ms`
        : 'waiting for a message that carries a venue timestamp';
    }

    const coverage = this.coverage;
    this.stored.textContent = coverage
      ? `stored ${fmtCompact(coverage.bars)} bars · ${fmtCompact(coverage.trades)} prints · ${fmtCompact(coverage.instruments)} symbols · newest ${fmtAge(coverage.newestBar, now)}`
      : 'stored — connecting';
    const seen = fmtCompact(Math.min(this.series.visible || this.series.loaded, this.series.loaded));
    const held = fmtCompact(this.series.loaded);
    this.loaded.textContent = this.series.olderExhausted
      ? `view ${seen} of ${held} bars · start of stored history`
      : this.series.loadingOlder
        ? `view ${seen} of ${held} bars · loading older…`
        : `view ${seen} of ${held} bars · pan left for more`;
  }
}
