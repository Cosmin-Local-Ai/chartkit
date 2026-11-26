import type { LiveMessage } from './types';

export type ConnectionPhase = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

/** One smoothed latency estimate and when it was taken. */
export interface LatencySample {
  ms: number;
  at: number;
  samples: number;
}

export interface LiveHandlers {
  onMessage: (message: LiveMessage) => void;
  onPhase: (phase: ConnectionPhase, detail: string) => void;
  /** Wall-clock time of the last message received, used by the status strip. */
  onBeat: (at: number) => void;
}

const MAX_BACKOFF_MS = 8_000;
/** A socket that stays open but stops talking is treated as stalled and replaced. */
const SILENCE_MS = 25_000;

/**
 * Single live socket for the whole app: keeps the subscription set, reconnects with
 * backoff, replays subscriptions after a drop, and replaces silent connections.
 */
export class LiveClient {
  private socket: WebSocket | null = null;
  private attempts = 0;
  private timer: number | null = null;
  private closedByUser = false;
  private lastBeat = 0;
  /** Running estimate of venue stamp to arrival; null until a stamped message lands. */
  private latency: LatencySample | null = null;
  /** Venue symbol -> timeframe key; the server subscribes by venue symbol. */
  private subscriptions = new Map<string, string>();

  constructor(private readonly handlers: LiveHandlers, private readonly path = '/api/live') {}

  get beatAt(): number {
    return this.lastBeat;
  }

  /**
   * Venue timestamp minus arrival, smoothed over recent messages. It carries the clock
   * difference between the venue and this machine, so it reads as an estimate, not a
   * measurement.
   */
  get latencySample(): LatencySample | null {
    return this.latency;
  }

  start(): void {
    this.closedByUser = false;
    this.open();
  }

  stop(): void {
    this.closedByUser = true;
    this.clearTimer();
    this.socket?.close();
    this.socket = null;
    this.handlers.onPhase('idle', 'disconnected');
  }

  subscribe(symbol: string, timeframe: string): void {
    if (!symbol) return;
    if (this.subscriptions.get(symbol) === timeframe && this.socket?.readyState === WebSocket.OPEN) return;
    this.subscriptions.set(symbol, timeframe);
    this.send({ type: 'subscribe', symbol, timeframe });
  }

  unsubscribe(symbol: string): void {
    if (!this.subscriptions.delete(symbol)) return;
    this.send({ type: 'unsubscribe', symbol });
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private open(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.handlers.onPhase(this.attempts === 0 ? 'connecting' : 'connecting', this.attempts === 0 ? 'opening' : `retry ${this.attempts}`);
    let socket: WebSocket;
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${window.location.host}${this.path}`);
    } catch (error) {
      this.handlers.onPhase('error', `cannot open socket: ${String(error)}`);
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.attempts = 0;
      this.handlers.onPhase('open', 'streaming');
      for (const [symbol, timeframe] of this.subscriptions) {
        this.send({ type: 'subscribe', symbol, timeframe });
      }
    };
    socket.onmessage = (event) => {
      this.lastBeat = Date.now();
      let message: LiveMessage;
      try {
        message = JSON.parse(String(event.data)) as LiveMessage;
      } catch {
        return;
      }
      this.sampleLatency(message, this.lastBeat);
      this.handlers.onBeat(this.lastBeat);
      this.handlers.onMessage(message);
    };
    socket.onerror = () => {
      this.handlers.onPhase('error', 'socket error');
    };
    socket.onclose = (event) => {
      this.socket = null;
      if (this.closedByUser) return;
      this.handlers.onPhase('closed', event.reason || 'connection closed');
      this.scheduleRetry();
    };
    this.watchForSilence(socket);
  }

  /** Only a message that carries a venue stamp can say anything about latency. */
  private sampleLatency(message: LiveMessage, arrivedAt: number): void {
    let stamp = Number.NaN;
    if (message.type === 'trades') stamp = message.trades[0]?.ts ?? Number.NaN;
    else if (message.type === 'depth') stamp = message.snapshot.ts;
    else if (message.type === 'hello') stamp = message.time;
    if (!Number.isFinite(stamp)) return;
    const ms = Math.max(0, arrivedAt - stamp);
    // Smoothed: one stamped trade says more about that trade than about the feed.
    const previous = this.latency;
    this.latency = previous
      ? { ms: previous.ms + (ms - previous.ms) * 0.25, at: arrivedAt, samples: previous.samples + 1 }
      : { ms, at: arrivedAt, samples: 1 };
  }

  private watchForSilence(socket: WebSocket): void {
    const timer = window.setInterval(() => {
      if (this.socket !== socket) {
        window.clearInterval(timer);
        return;
      }
      if (Date.now() - this.lastBeat > SILENCE_MS) {
        this.handlers.onPhase('connecting', 'no messages, reopening');
        socket.close();
      }
    }, 5_000);
    socket.addEventListener('close', () => window.clearInterval(timer), { once: true });
  }

  private scheduleRetry(): void {
    this.clearTimer();
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(this.attempts, 4));
    this.attempts += 1;
    this.timer = window.setTimeout(() => this.open(), delay + Math.random() * 250);
  }

  private send(payload: Record<string, string> & { type: string }): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }
}
