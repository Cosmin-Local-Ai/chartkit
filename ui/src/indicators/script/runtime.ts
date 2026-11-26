/**
 * The host side of the user-script sandbox.
 *
 * One worker runs every script, one request at a time. The worker is the only thing
 * standing between a script that never returns and a frozen tab, so execution is
 * bounded by a deadline the host owns: on expiry the worker is terminated, rebuilt for
 * the next request, and the instance that hung is parked until its text changes —
 * otherwise a `while (true)` would restart on every frame and burn a core forever.
 *
 * Results are kept per instance and only replaced by a good run, which is what lets a
 * throwing script keep drawing whatever it last produced.
 */

import type { Bar } from '../../types';
import type { PrintFlow } from '../flow';
import type { ParamValues } from '../registry';
import { barsSignature, flowSignature, paramsSignature } from '../signature';
import type { ScriptColumns, ScriptFlow, ScriptMeta, ScriptRequest, ScriptResponse } from './contract';

/** A compute run has to finish inside this. Generous for tens of thousands of bars, short enough to feel instant. */
export const COMPUTE_TIMEOUT_MS = 2_000;
/** A declare run sees three bars, so it gets a fraction of the compute deadline. */
export const DECLARE_TIMEOUT_MS = 500;

/** What the host holds for one script instance. */
export interface ScriptState {
  /**
   * The last declaration that read cleanly, which may come from an older version of the
   * text while a new one is outstanding or has failed. Null only before the first success.
   */
  meta: ScriptMeta | null;
  /** The exact text `meta` was read from, so an edit is visible without reparsing. */
  declaredText: string;
  /** Values from the last run that succeeded, in plot order. A failed run leaves these alone. */
  values: number[][] | null;
  /** Why the last run failed, or why the instance is parked. Null while healthy. */
  error: string | null;
  /** True after a run had to be stopped: the script is not re-run until its text changes. */
  halted: boolean;
}

interface InFlight {
  id: number;
  instanceId: string;
  /** The script text the running request came from, which an answer is filed against. */
  source: string;
  timer: number;
}

export class ScriptRuntime {
  /** Fires when a declaration or a set of values lands, so the chart can redraw and persist. */
  onUpdate: (() => void) | null = null;

  private worker: Worker | null = null;
  private nextId = 1;
  private readonly states = new Map<string, ScriptState>();
  /** Last request signature sent per instance, so an unchanged frame sends nothing. */
  private readonly sentKeys = new Map<string, string>();
  /** The newest request per instance while another one is still running. */
  private readonly queued = new Map<string, ScriptRequest>();
  private flight: InFlight | null = null;

  /** Everything known about one instance's script, created empty on first sight. */
  stateOf(instanceId: string): ScriptState {
    const found = this.states.get(instanceId);
    if (found) return found;
    const created: ScriptState = { meta: null, declaredText: '', values: null, error: null, halted: false };
    this.states.set(instanceId, created);
    return created;
  }

  /** Drops everything held for an instance the user removed. */
  drop(instanceId: string): void {
    this.states.delete(instanceId);
    this.sentKeys.delete(instanceId);
    this.queued.delete(instanceId);
  }

  /** Drops the instances a reloaded workspace no longer holds. */
  prune(live: ReadonlySet<string>): void {
    for (const instanceId of [...this.states.keys()]) if (!live.has(instanceId)) this.drop(instanceId);
    for (const instanceId of [...this.queued.keys()]) if (!live.has(instanceId)) this.drop(instanceId);
  }

  /**
   * Runs what the instance needs and reports what is currently on hand.
   *
   * A missing or stale declaration asks for a declare; a good declaration asks for
   * values. Both are asynchronous, so the caller draws whatever `stateOf` already holds
   * and gets a redraw request when the answer lands.
   */
  track(instanceId: string, source: string, params: ParamValues, bars: readonly Bar[], flow: PrintFlow | null): ScriptState {
    const state = this.stateOf(instanceId);
    if (!source.trim()) {
      // Empty text is not a reason to throw away what the instance already draws; it is a
      // note on the way to whatever the next edit produces.
      state.error = 'the script is empty';
      return state;
    }
    const key = `${source.length}:${hash(source)}|${paramsSignature(params)}|${barsSignature(bars)}|${flowSignature(flow)}`;
    if (state.halted) return state;

    // The declaration is re-read whenever the text changes, but the previous one keeps
    // drawing until a better one arrives: a script that no longer parses should not blank
    // the series it already produced.
    if (state.declaredText !== source) {
      if (this.sentKeys.get(instanceId) !== key) this.send(instanceId, 'declare', source, params, bars, flow, key);
      return state;
    }
    if (this.sentKeys.get(instanceId) === key) return state;
    this.send(instanceId, 'compute', source, params, bars, flow, key);
    return state;
  }

  /** Asks for the text to be re-read, keeping whatever it last drew on screen. */
  invalidate(instanceId: string): void {
    const state = this.stateOf(instanceId);
    state.halted = false;
    state.error = null;
    this.sentKeys.delete(instanceId);
  }

  private send(
    instanceId: string,
    phase: 'declare' | 'compute',
    source: string,
    params: ParamValues,
    bars: readonly Bar[],
    flow: PrintFlow | null,
    key: string,
  ): void {
    const request = this.request(instanceId, phase, source, params, bars, flow, key);
    this.sentKeys.set(instanceId, key);
    if (this.flight) {
      this.queued.set(instanceId, request);
      return;
    }
    this.dispatch(request);
  }

  private request(
    instanceId: string,
    phase: 'declare' | 'compute',
    source: string,
    params: ParamValues,
    bars: readonly Bar[],
    flow: PrintFlow | null,
    key: string,
  ): ScriptRequest {
    const columns = columnsFor(bars);
    return {
      id: this.nextId++,
      instanceId,
      phase,
      source,
      params,
      columns,
      flow: flowFor(bars, flow),
      key,
    };
  }

  private dispatch(request: ScriptRequest): void {
    const worker = this.ensureWorker();
    const deadline = request.phase === 'declare' ? DECLARE_TIMEOUT_MS : COMPUTE_TIMEOUT_MS;
    this.flight = {
      id: request.id,
      instanceId: request.instanceId,
      source: request.source,
      timer: window.setTimeout(() => this.timeout(request), deadline),
    };
    worker.postMessage(request, transferables(request));
  }

  /** A script that did not return in time: park the instance and rebuild the worker. */
  private timeout(request: ScriptRequest): void {
    const state = this.stateOf(request.instanceId);
    const seconds = request.phase === 'declare' ? DECLARE_TIMEOUT_MS / 1000 : COMPUTE_TIMEOUT_MS / 1000;
    state.halted = true;
    state.error = `script stopped: it did not finish in ${seconds}s (check for a loop that never ends)`;
    this.flight = null;
    this.sentKeys.delete(request.instanceId);
    this.destroyWorker();
    this.onUpdate?.();
    this.drain();
  }

  /** Sends the newest request still waiting, if any. */
  private drain(): void {
    if (this.flight || this.queued.size === 0) return;
    const next = this.queued.values().next().value as ScriptRequest | undefined;
    if (!next) return;
    this.queued.delete(next.instanceId);
    this.dispatch(next);
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./sandbox.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent) => this.receive(event.data as ScriptResponse);
    // A worker that dies outright (an allocation that outgrew its heap, most often)
    // would otherwise hang the request until its deadline, so fail it now.
    worker.onerror = (event: ErrorEvent) => {
      const flight = this.flight;
      if (!flight) return;
      const state = this.stateOf(flight.instanceId);
      state.halted = true;
      state.error = `script worker stopped: ${event.message || 'out of memory'}`;
      window.clearTimeout(flight.timer);
      this.flight = null;
      this.sentKeys.delete(flight.instanceId);
      this.destroyWorker();
      this.onUpdate?.();
      this.drain();
    };
    this.worker = worker;
    return worker;
  }

  private destroyWorker(): void {
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
  }

  private receive(response: ScriptResponse): void {
    const flight = this.flight;
    if (!flight || flight.id !== response.id) return;

    window.clearTimeout(flight.timer);
    this.flight = null;
    const state = this.stateOf(response.instanceId);
    // Params or bars may have moved on while the run was out; an answer for an older
    // state is dropped rather than drawn, since a fresher request is already on its way.
    if (response.key !== this.sentKeys.get(response.instanceId)) {
      this.drain();
      return;
    }
    if (response.kind === 'failure') {
      state.error = response.error;
      state.halted = response.halted;
      if (response.halted) this.sentKeys.delete(response.instanceId);
    } else {
      state.error = null;
      if (response.kind === 'meta') {
        state.meta = response.meta;
        state.declaredText = flight.source;
        // A fresh declaration may describe a different set of plots, so the old numbers
        // are dropped and the next frame asks for the new ones.
        if (response.meta.plots.length !== (state.values?.length ?? 0)) state.values = null;
        this.sentKeys.delete(response.instanceId);
      } else {
        state.values = response.values;
      }
    }
    this.onUpdate?.();
    this.drain();
  }
}

/* ------------------------------------------------------------------ transfer */

function columnsFor(bars: readonly Bar[]): ScriptColumns {
  const length = bars.length;
  const start = new Float64Array(length);
  const open = new Float64Array(length);
  const high = new Float64Array(length);
  const low = new Float64Array(length);
  const close = new Float64Array(length);
  const volume = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    const bar = bars[i];
    if (!bar) continue;
    start[i] = bar.start;
    open[i] = bar.open;
    high[i] = bar.high;
    low[i] = bar.low;
    close[i] = bar.close;
    volume[i] = bar.volume;
  }
  return { start, open, high, low, close, volume };
}

/** Per-bar aggressive volume, `NaN` on the bars the prints never covered. */
function flowFor(bars: readonly Bar[], flow: PrintFlow | null): ScriptFlow {
  if (!flow || flow.byStart.size === 0) return { buy: null, sell: null };
  const length = bars.length;
  const buy = new Float64Array(length);
  const sell = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    const entry = flow.byStart.get(bars[i]?.start ?? Number.NaN);
    if (!entry) {
      buy[i] = Number.NaN;
      sell[i] = Number.NaN;
      continue;
    }
    buy[i] = entry.buy;
    sell[i] = entry.sell;
  }
  return { buy, sell };
}

function transferables(request: ScriptRequest): Transferable[] {
  const { columns, flow } = request;
  const out: Transferable[] = [columns.start.buffer, columns.open.buffer, columns.high.buffer, columns.low.buffer, columns.close.buffer, columns.volume.buffer];
  if (flow.buy) out.push(flow.buy.buffer);
  if (flow.sell) out.push(flow.sell.buffer);
  return out;
}

/**
 * Cheap text fingerprint for the request key. A collision would only delay a recompute
 * by one edit, so a rolling 53-bit hash is enough and costs nothing per frame.
 */
function hash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = (Math.imul(b + code, 0x85ebca6b) ^ (b >>> 13)) >>> 0;
  }
  return `${a.toString(36)}${b.toString(36)}`;
}
