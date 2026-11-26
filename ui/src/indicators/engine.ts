/**
 * Indicator instances: what the user added, the settings each one carries, and the
 * computed series they draw. Instances are unlimited; nothing here counts or caps
 * them. Results are cached per instance and only recomputed when the bars or that
 * instance's parameters change, so the live 60fps path reuses the same series.
 */

import type { Bar } from '../types';
import type { PrintFlow } from './flow';
import type { SizeBandFlow } from '../sizeBands';
import { bandSignature } from './signature';
import {
  cloneValue,
  defaultsFor,
  indicatorById,
  number,
  string,
  type IndicatorDefinition,
  type IndicatorResult,
  type ParamDescriptor,
  type ParamValue,
  type ParamValues,
} from './registry';
import { barsSignature, flowSignature, paramsSignature } from './signature';
import { SCRIPT_INDICATOR_ID } from './script/contract';
import { scriptDefinition, scriptResult } from './script/definition';
import type { ScriptRuntime } from './script/runtime';

export interface IndicatorInstance {
  /** Stable within this workspace document; keys the pane, the cache and the dialogs. */
  id: string;
  indicatorId: string;
  params: ParamValues;
  /**
   * Script text, present on a user indicator and on nothing else. It travels with the
   * instance so a workspace document carries its own indicators and imports cleanly.
   */
  script?: string;
}

interface CacheEntry {
  paramsKey: string;
  barsKey: string;
  flowKey: string;
  bandKey: string;
  result: IndicatorResult;
}

let instanceCounter = 0;

export class IndicatorEngine {
  instances: IndicatorInstance[] = [];
  private readonly cache = new Map<string, CacheEntry>();

  /**
   * `scripts` runs the user indicators off the main thread. Without it a script instance
   * still loads and still draws its parameters, it simply has nothing computed yet.
   */
  constructor(private readonly scripts: ScriptRuntime | null = null) {}

  /** Replaces the instance list, dropping unknown indicator ids and repairing params. */
  setInstances(raw: unknown): void {
    this.instances = normaliseInstances(raw, defaultInstanceKey);
    this.pruneCache();
  }

  add(indicatorId: string): IndicatorInstance | null {
    const definition = indicatorById(indicatorId);
    if (!definition) return null;
    const instance: IndicatorInstance = { id: defaultInstanceKey(), indicatorId, params: defaultsFor(definition) };
    this.instances = this.instances.concat(instance);
    return instance;
  }

  /** Adds one user indicator: the script text is the whole definition, so it rides along. */
  addScript(source: string): IndicatorInstance | null {
    if (!source.trim() || !this.scripts) return null;
    const instance: IndicatorInstance = { id: defaultInstanceKey(), indicatorId: SCRIPT_INDICATOR_ID, params: {}, script: source };
    this.instances = this.instances.concat(instance);
    return instance;
  }

  /** Replaces one instance's script text, which retires its declaration and any parked run. */
  setScript(id: string, source: string): void {
    const instance = this.instances.find((entry) => entry.id === id);
    if (!instance || instance.indicatorId !== SCRIPT_INDICATOR_ID) return;
    if (instance.script === source) return;
    instance.script = source;
    this.cache.delete(id);
    this.scripts?.invalidate(id);
  }

  /** Why a script instance is not drawing what it should, or null when it is healthy. */
  scriptError(id: string): string | null {
    return this.scripts?.stateOf(id).error ?? null;
  }

  /**
   * Fills in parameter defaults for script instances whose declaration has just landed.
   * Returns true when any instance gained or lost a parameter, so the caller persists.
   */
  reconcileScripts(): boolean {
    let changed = false;
    for (const instance of this.instances) {
      if (instance.indicatorId !== SCRIPT_INDICATOR_ID || !this.metaOf(instance.id)) continue;
      const definition = this.definitionOf(instance);
      if (!definition) continue;
      const next = normaliseParams(definition, instance.params);
      if (JSON.stringify(next) !== JSON.stringify(instance.params)) {
        instance.params = next;
        changed = true;
      }
    }
    return changed;
  }

  remove(id: string): void {
    this.instances = this.instances.filter((instance) => instance.id !== id);
    this.cache.delete(id);
    this.scripts?.drop(id);
  }

  /** Merge a partial parameter patch; unknown or malformed values are ignored. */
  setParams(id: string, patch: ParamValues): void {
    const instance = this.instances.find((entry) => entry.id === id);
    const definition = instance ? this.definitionOf(instance) : null;
    if (!instance || !definition) return;
    const merged = { ...instance.params, ...patch };
    // A script whose declaration has not arrived yet has no descriptors to repair
    // against, so its values are kept as typed until the declaration lands.
    const pending = instance.indicatorId === SCRIPT_INDICATOR_ID && !this.metaOf(id);
    instance.params = pending ? merged : normaliseParams(definition, merged);
  }

  definitionOf(instance: IndicatorInstance): IndicatorDefinition | null {
    if (instance.indicatorId === SCRIPT_INDICATOR_ID) return scriptDefinition(this.metaOf(instance.id));
    return indicatorById(instance.indicatorId);
  }

  private metaOf(id: string) {
    return this.scripts?.stateOf(id).meta ?? null;
  }

  /**
   * Computed series for every instance, recomputed only where something changed.
   * `flow` is the per-bar buy/sell the prints give, which the delta family computes
   * from and every other indicator ignores; `bands` is the same window split by print
   * size, which only CVD by Size reads.
   */
  results(bars: readonly Bar[], flow: PrintFlow | null, bands: SizeBandFlow | null): Map<string, IndicatorResult> {
    const out = new Map<string, IndicatorResult>();
    if (bars.length === 0) {
      this.cache.clear();
      return out;
    }
    const barsKey = barsSignature(bars);
    const flowKey = flowSignature(flow);
    const bandKey = bandSignature(bands);
    for (const instance of this.instances) {
      if (instance.indicatorId === SCRIPT_INDICATOR_ID) {
        const series = this.scriptSeries(instance, bars, flow);
        if (series) out.set(instance.id, series);
        continue;
      }
      const definition = indicatorById(instance.indicatorId);
      if (!definition) continue;
      const paramsKey = paramsSignature(instance.params);
      const cached = this.cache.get(instance.id);
      if (
        cached &&
        cached.paramsKey === paramsKey &&
        cached.barsKey === barsKey &&
        cached.flowKey === flowKey &&
        cached.bandKey === bandKey
      ) {
        out.set(instance.id, cached.result);
        continue;
      }
      const result = definition.compute(bars, instance.params, flow, bands);
      this.cache.set(instance.id, { paramsKey, barsKey, flowKey, bandKey, result });
      out.set(instance.id, result);
    }
    this.pruneCache();
    return out;
  }

  /**
   * A user indicator's series: whatever its last good run produced, while the sandbox
   * catches up in the background. A script that throws or hangs keeps drawing the series
   * it had and says what went wrong, rather than taking the chart or its neighbours down.
   */
  private scriptSeries(instance: IndicatorInstance, bars: readonly Bar[], flow: PrintFlow | null): IndicatorResult | null {
    const runtime = this.scripts;
    if (!runtime) return null;
    const state = runtime.track(instance.id, instance.script ?? '', instance.params, bars, flow);
    return scriptResult(state.meta, instance.params, state, bars, flow);
  }

  /** One-line parameter summary for the instance list, e.g. `26 · close · smooth`. */
  summary(instance: IndicatorInstance): string {
    const definition = this.definitionOf(instance);
    if (!definition) return '';
    const parts: string[] = [];
    for (const descriptor of definition.params) {
      if (descriptor.kind === 'colors') continue;
      const value = instance.params[descriptor.name];
      if (typeof value === 'boolean') {
        if (value) parts.push(descriptor.label.toLowerCase());
      } else if (typeof value === 'number') {
        parts.push(`${descriptor.label} ${formatNumber(value)}`);
      } else if (typeof value === 'string') {
        parts.push(`${descriptor.label} ${value}`);
      }
    }
    return parts.join(' · ');
  }

  private pruneCache(): void {
    const live = new Set(this.instances.map((instance) => instance.id));
    for (const key of this.cache.keys()) if (!live.has(key)) this.cache.delete(key);
    this.scripts?.prune(live);
  }

}

/** Instance ids only have to be unique inside one workspace document. */
function defaultInstanceKey(): string {
  instanceCounter += 1;
  const random = globalThis.crypto?.randomUUID?.();
  return random ? `i${random.slice(0, 8)}` : `i${Date.now().toString(36)}${instanceCounter.toString(36)}`;
}

/** Read a stored instance list: unknown indicator ids drop, parameters repair. */
export function normaliseInstances(raw: unknown, nextId: () => string = defaultInstanceKey): IndicatorInstance[] {
  const out: IndicatorInstance[] = [];
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    const instance = normaliseInstance(entry, nextId);
    if (instance) out.push(instance);
  }
  return out;
}

function normaliseInstance(raw: unknown, nextId: () => string): IndicatorInstance | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as { id?: unknown; indicatorId?: unknown; params?: unknown; script?: unknown };
  const indicatorId = typeof value.indicatorId === 'string' ? value.indicatorId : '';
  const params = typeof value.params === 'object' && value.params ? (value.params as ParamValues) : {};
  const id = typeof value.id === 'string' && value.id ? value.id : nextId();
  if (indicatorId === SCRIPT_INDICATOR_ID) {
    // A user indicator is only worth restoring if it brought its own script.
    const script = typeof value.script === 'string' ? value.script : '';
    if (!script.trim()) return null;
    return { id, indicatorId, params, script };
  }
  const definition = indicatorById(indicatorId);
  if (!definition) return null;
  return { id, indicatorId, params: normaliseParams(definition, params) };
}

/** Fill every missing parameter with its default and clamp the rest into range. */
export function normaliseParams(definition: IndicatorDefinition, raw: ParamValues): ParamValues {
  const out: ParamValues = {};
  for (const descriptor of definition.params) {
    const value = raw[descriptor.name];
    out[descriptor.name] = value === undefined ? cloneValue(descriptor.default) : coerce(descriptor, value, descriptor.default);
  }
  return out;
}

function coerce(descriptor: ParamDescriptor, value: ParamValue, fallback: ParamValue): ParamValue {
  switch (descriptor.kind) {
    case 'number': {
      const min = descriptor.min ?? Number.NEGATIVE_INFINITY;
      const max = descriptor.max ?? Number.POSITIVE_INFINITY;
      const num = number({ v: value }, 'v', typeof fallback === 'number' ? fallback : 1);
      return Math.min(max, Math.max(min, num));
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : typeof fallback === 'boolean' && fallback;
    case 'select': {
      const text = string({ v: value }, 'v', '');
      return descriptor.options?.includes(text) ? text : String(fallback ?? '');
    }
    case 'colors': {
      const slots = descriptor.slots?.length ?? 1;
      const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
      const clean = list.filter((color): color is string => typeof color === 'string' && /^#[0-9a-fA-F]{6}$|^[a-z]+$/i.test(color.trim()));
      const base = Array.isArray(fallback) ? fallback : [];
      const out: string[] = [];
      for (let i = 0; i < slots; i += 1) out.push(clean[i] ?? clean[clean.length - 1] ?? base[i] ?? '#4b9cf5');
      return out;
    }
  }
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}



