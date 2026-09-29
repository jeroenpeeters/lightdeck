/**
 * Output adapter for the LR512: a WebSocket client for the Android bridge
 * (android-bridge/), which hands the frames to the vendor library.
 *
 * Client -> bridge, binary: [universe:1 byte][512 DMX bytes].
 * Bridge -> client, text:   {"type":"status","device":"open"|"lost","universes":N,
 *                            "channels":[512,0]}
 *
 * The engine calls `setUniverse` as often as it likes. The client sends at most
 * `fps` frames per second per universe and always the most recent one. When the
 * socket's send buffer backs up, frames are held back instead of queued, so a slow
 * or stalled bridge costs freshness for a moment and never memory or latency.
 * After a reconnect the last known state of every universe is sent again.
 */

import { UNIVERSE_SIZE } from '../../fixtures/profile.js';

export const FRAME_SIZE = 1 + UNIVERSE_SIZE;
const SOCKET_OPEN = 1;

export interface BridgeStatus {
  device: 'open' | 'lost';
  universes: number;
  /**
   * Channels the device's licence allows per universe, index 0 first. A universe with
   * 0 channels cannot be used: the vendor library refuses every frame for it. Empty
   * when the bridge did not report it.
   */
  channels: number[];
}

/** The part of the WebSocket API this client uses. Tests inject a fake. */
export interface SocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: string;
  send(data: Uint8Array): void;
  close(): void;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
}

export type SocketFactory = (url: string) => SocketLike;

export interface BridgeClientOptions {
  /** For example ws://192.168.68.101:9010 */
  url: string;
  /** Upper bound on frames per second per universe. Default 40. */
  fps?: number;
  /** Hold frames back while more than this many are waiting in the socket. Default 2. */
  maxBufferedFrames?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  socketFactory?: SocketFactory;
  onStatus?: (status: BridgeStatus) => void;
  onConnection?: (connected: boolean) => void;
  log?: (message: string) => void;
}

export interface BridgeClientStats {
  /** Frames handed to the socket. */
  sent: number;
  /** Times a frame was held back because the socket was backed up. */
  heldBack: number;
  /** Successful connections, including the first. */
  connections: number;
}

interface UniverseSlot {
  frame: Uint8Array;
  dirty: boolean;
}

const defaultSocketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

export class Lr512BridgeClient {
  private readonly url: string;
  private readonly intervalMs: number;
  private readonly maxBufferedBytes: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly socketFactory: SocketFactory;
  private readonly onStatus: ((status: BridgeStatus) => void) | undefined;
  private readonly onConnection: ((connected: boolean) => void) | undefined;
  private readonly log: (message: string) => void;

  private readonly universes = new Map<number, UniverseSlot>();
  private socket: SocketLike | undefined;
  private running = false;
  private backoffMs: number;
  private pump: ReturnType<typeof setInterval> | undefined;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private counters: BridgeClientStats = { sent: 0, heldBack: 0, connections: 0 };

  /** Last status the bridge reported, if any. */
  status: BridgeStatus | undefined;

  constructor(options: BridgeClientOptions) {
    this.url = options.url;
    this.intervalMs = 1000 / (options.fps ?? 40);
    this.maxBufferedBytes = (options.maxBufferedFrames ?? 2) * FRAME_SIZE;
    this.reconnectMinMs = options.reconnectMinMs ?? 500;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 5000;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.onStatus = options.onStatus;
    this.onConnection = options.onConnection;
    this.log = options.log ?? (() => {});
    this.backoffMs = this.reconnectMinMs;
  }

  get connected(): boolean {
    return this.socket?.readyState === SOCKET_OPEN;
  }

  get stats(): BridgeClientStats {
    return { ...this.counters };
  }

  /** Stores the newest state of a universe. `data` is copied. */
  setUniverse(index: number, data: Uint8Array): void {
    if (!Number.isInteger(index) || index < 0 || index > 255) {
      throw new RangeError(`universe index ${index} is outside 0..255`);
    }
    if (data.length !== UNIVERSE_SIZE) {
      throw new RangeError(`a universe is ${UNIVERSE_SIZE} bytes, got ${data.length}`);
    }
    let slot = this.universes.get(index);
    if (!slot) {
      slot = { frame: new Uint8Array(FRAME_SIZE), dirty: false };
      slot.frame[0] = index;
      this.universes.set(index, slot);
    }
    slot.frame.set(data, 1);
    slot.dirty = true;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
    this.pump = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.pump) clearInterval(this.pump);
    if (this.reconnect) clearTimeout(this.reconnect);
    this.pump = undefined;
    this.reconnect = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  /**
   * Sends what is pending right now. Returns true when nothing is left to send.
   * The timer calls this; it is public for callers that want to flush before exit.
   */
  tick(): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) return false;
    let pending = false;
    for (const slot of this.universes.values()) {
      if (!slot.dirty) continue;
      if (socket.bufferedAmount > this.maxBufferedBytes) {
        this.counters.heldBack++;
        pending = true;
        continue;
      }
      socket.send(slot.frame);
      slot.dirty = false;
      this.counters.sent++;
    }
    return !pending;
  }

  private connect(): void {
    if (!this.running) return;
    let socket: SocketLike;
    try {
      socket = this.socketFactory(this.url);
    } catch (error) {
      this.log(`cannot open ${this.url}: ${String(error)}`);
      this.scheduleReconnect();
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.backoffMs = this.reconnectMinMs;
      this.counters.connections++;
      // Bring the bridge back to the state the engine believes it is in.
      for (const slot of this.universes.values()) slot.dirty = true;
      this.log(`connected to ${this.url}`);
      this.onConnection?.(true);
    });
    socket.addEventListener('message', (event) => this.handleMessage(event.data));
    socket.addEventListener('error', () => {
      // A close event follows; reconnecting is handled there.
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.status = undefined;
      this.log(`disconnected from ${this.url}`);
      this.onConnection?.(false);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.reconnectMaxMs);
    this.reconnect = setTimeout(() => this.connect(), delay);
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    const m = message as Record<string, unknown>;
    if (m.type !== 'status') return;
    if (m.device !== 'open' && m.device !== 'lost') return;
    const status: BridgeStatus = {
      device: m.device,
      universes: typeof m.universes === 'number' ? m.universes : 0,
      channels: Array.isArray(m.channels)
        ? m.channels.filter((c): c is number => typeof c === 'number')
        : [],
    };
    this.status = status;
    this.onStatus?.(status);
  }
}
