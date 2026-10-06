/**
 * Output adapter for the LR512: a WebSocket client for the Android bridge
 * (android-bridge/), which hands the frames to the vendor library.
 *
 * Client -> bridge, binary: [universe:1 byte][512 DMX bytes].
 * Client -> bridge, text:   {"type":"limits","maxFps":25}, on connecting and when it changes.
 * Bridge -> client, text:   {"type":"status","device":"open"|"lost","universes":N,
 *                            "channels":[512,0]}
 *                           {"type":"alive","device":"open"|"lost","frames":N}, every second
 *                           (a bridge from before 2026-10-07 does not send it)
 *
 * The engine calls `setUniverse` whenever it has made a frame. What happens then is push,
 * not polling: the client looks at it at the end of the turn of the event loop, so that
 * what several fixtures made together goes out as one frame, and sends it at once.
 *
 * - **Only what changed.** A frame equal to the last one sent is not sent.
 * - **A cap.** A universe is sent at most `maxFps` times per second (25 by default, which
 *   is what the original Light Rider app does; nothing is known about what the LR512 takes
 *   beyond that). A frame that comes sooner waits for the rest of the gap, and what goes out
 *   then is the newest. An isolated change goes out at once, because nothing was sent just
 *   before it.
 * - **A keep-alive.** After `keepAliveMs` without a send the last frame goes again, so that
 *   the bridge knows lightdeck is there and the device is fed.
 * - **Held back, not queued.** When the socket's send buffer backs up, the frame waits, so a
 *   slow or stalled bridge costs freshness for a moment and never memory or latency.
 * - After a reconnect the last known state of every universe is sent again.
 *
 * The bridge may be away when lightdeck starts, or go away and come back later, as an app
 * on a phone does. The client polls for it for as long as it is not there: every way an
 * attempt or a connection can end leads to another try, a little later each time, up to
 * `reconnectMaxMs`. Node's WebSocket sends `error` and no `close` when an attempt fails, and
 * nothing at all when the host does not answer, so an attempt is given `connectTimeoutMs`.
 * A connection that dies without a word, as when the Wi-Fi of the phone drops, is only
 * noticed by the operating system after minutes. A bridge that sends `alive` is given
 * `silentAfterMs`: the first `alive` says that it does, and from then on four seconds
 * without a message from it end the connection. A bridge that does not is left alone.
 */

import { UNIVERSE_SIZE } from '../../fixtures/profile.js';

export const FRAME_SIZE = 1 + UNIVERSE_SIZE;
export const DEFAULT_MAX_FPS = 25;
export const MIN_MAX_FPS = 1;
export const MAX_MAX_FPS = 60;
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

/** What the bridge says about itself once a second, when it is new enough to. */
export interface BridgeAlive {
  device: 'open' | 'lost';
  /** Frames the bridge has handed to the vendor library so far. */
  frames: number;
}

/** The part of the WebSocket API this client uses. Tests inject a fake. */
export interface SocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: string;
  send(data: Uint8Array | string): void;
  close(): void;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
}

export type SocketFactory = (url: string) => SocketLike;

export interface BridgeClientOptions {
  /** For example ws://192.168.68.101:9010 */
  url: string;
  /** Upper bound on frames per second per universe. Default 25. */
  maxFps?: number;
  /** The last frame is sent again after this long without a send. Default 1000. */
  keepAliveMs?: number;
  /** A bridge that sends `alive` is given up on after this long without a message. Default 4000. */
  silentAfterMs?: number;
  /** Hold frames back while more than this many are waiting in the socket. Default 2. */
  maxBufferedFrames?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** How long an attempt to connect may go without an answer before it is given up. Default 4000. */
  connectTimeoutMs?: number;
  socketFactory?: SocketFactory;
  /** Monotonic clock in milliseconds. Tests pass their own. */
  now?: () => number;
  onStatus?: (status: BridgeStatus) => void;
  onAlive?: (alive: BridgeAlive) => void;
  onConnection?: (connected: boolean) => void;
  log?: (message: string) => void;
}

export interface BridgeClientStats {
  /** Frames handed to the socket for a change. */
  sent: number;
  /** Frames not sent because they were equal to the one sent before. */
  skipped: number;
  /** Frames sent again as a keep-alive. */
  keepAlives: number;
  /** Times a frame was held back because the socket was backed up. */
  heldBack: number;
  /** Successful connections, including the first. */
  connections: number;
}

interface UniverseSlot {
  /** What the engine made last, with the universe in front. */
  frame: Uint8Array;
  /** What was sent last, or nothing yet on this connection. */
  sent: Uint8Array | undefined;
  /** Made, and not sent yet. */
  dirty: boolean;
  /** The moment of the last send. */
  lastSend: number;
}

const defaultSocketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

/** A rate in frames per second, checked. Throws a `RangeError` for a value that makes no sense. */
export function readFps(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < MIN_MAX_FPS ||
    value > MAX_MAX_FPS
  ) {
    throw new RangeError(
      `the most frames per second must be a number between ${MIN_MAX_FPS} and ${MAX_MAX_FPS}`,
    );
  }
  return value;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 1; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class Lr512BridgeClient {
  private readonly url: string;
  private minIntervalMs: number;
  private maxFps: number;
  private readonly keepAliveMs: number;
  private readonly silentAfterMs: number;
  private readonly maxBufferedBytes: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly connectTimeoutMs: number;
  private readonly socketFactory: SocketFactory;
  private readonly now: () => number;
  private readonly onStatus: ((status: BridgeStatus) => void) | undefined;
  private readonly onAlive: ((alive: BridgeAlive) => void) | undefined;
  private readonly onConnection: ((connected: boolean) => void) | undefined;
  private readonly log: (message: string) => void;

  private readonly universes = new Map<number, UniverseSlot>();
  private socket: SocketLike | undefined;
  private running = false;
  private backoffMs: number;
  /** The end of the end-of-turn flush that is asked for, so that it is asked for once. */
  private flushing: ReturnType<typeof setImmediate> | undefined;
  /** The timer that sends what had to wait for the rest of a gap. */
  private retry: ReturnType<typeof setTimeout> | undefined;
  private retryAt = Number.POSITIVE_INFINITY;
  private keepAlive: ReturnType<typeof setTimeout> | undefined;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  /** The deadline of the attempt that is going on. */
  private attempt: ReturnType<typeof setTimeout> | undefined;
  /** The deadline for a message from a bridge that is known to send `alive`. */
  private silent: ReturnType<typeof setTimeout> | undefined;
  /** Whether this connection's bridge has said `alive`. */
  private aliveSeen = false;
  /** Ends the connection that is open, from outside the function that made it. */
  private endConnection: ((why: string) => void) | undefined;
  /** That the log has said that the bridge cannot be reached, so it does not say it at every try. */
  private unreachableLogged = false;
  private counters: BridgeClientStats = {
    sent: 0,
    skipped: 0,
    keepAlives: 0,
    heldBack: 0,
    connections: 0,
  };

  /** Last status the bridge reported, if any. */
  status: BridgeStatus | undefined;
  /** Last `alive` the bridge sent, if it sends them. */
  alive: BridgeAlive | undefined;

  constructor(options: BridgeClientOptions) {
    this.url = options.url;
    this.maxFps = readFps(options.maxFps ?? DEFAULT_MAX_FPS);
    this.minIntervalMs = 1000 / this.maxFps;
    this.keepAliveMs = options.keepAliveMs ?? 1000;
    this.silentAfterMs = options.silentAfterMs ?? 4000;
    this.maxBufferedBytes = (options.maxBufferedFrames ?? 2) * FRAME_SIZE;
    this.reconnectMinMs = options.reconnectMinMs ?? 500;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 5000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 4000;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.now = options.now ?? (() => performance.now());
    this.onStatus = options.onStatus;
    this.onAlive = options.onAlive;
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

  getMaxFps(): number {
    return this.maxFps;
  }

  /**
   * Changes the most frames per second, and tells the bridge, which keeps to it too.
   * Throws a `RangeError` for a value that makes no sense.
   */
  setMaxFps(fps: number): void {
    this.maxFps = readFps(fps);
    this.minIntervalMs = 1000 / this.maxFps;
    this.sendLimits();
    this.askToFlush();
  }

  /** Stores the newest state of a universe, and sees to it that it goes out. `data` is copied. */
  setUniverse(index: number, data: Uint8Array): void {
    if (!Number.isInteger(index) || index < 0 || index > 255) {
      throw new RangeError(`universe index ${index} is outside 0..255`);
    }
    if (data.length !== UNIVERSE_SIZE) {
      throw new RangeError(`a universe is ${UNIVERSE_SIZE} bytes, got ${data.length}`);
    }
    let slot = this.universes.get(index);
    if (!slot) {
      slot = {
        frame: new Uint8Array(FRAME_SIZE),
        sent: undefined,
        dirty: false,
        lastSend: Number.NEGATIVE_INFINITY,
      };
      slot.frame[0] = index;
      this.universes.set(index, slot);
    }
    slot.frame.set(data, 1);
    slot.dirty = true;
    this.askToFlush();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearTimers();
    if (this.reconnect) clearTimeout(this.reconnect);
    if (this.attempt) clearTimeout(this.attempt);
    this.reconnect = undefined;
    this.attempt = undefined;
    this.endConnection = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  /**
   * Sends what is pending right now, past the cap and without waiting for the end of the turn.
   * For a caller that is about to exit, such as the shutdown that closes the laser: the
   * bridge holds the last frame it gets, so that frame has to leave. Returns true when
   * nothing is left to send.
   */
  flush(): boolean {
    return this.guarded(() => this.send(true)) ?? false;
  }

  /**
   * Runs something that sends. A socket that refuses to send is a connection that is gone, and
   * what it throws must not leave a timer: the process would die and take every light with it.
   * The connection is ended, and the client goes looking for the bridge again.
   */
  private guarded<T>(action: () => T): T | undefined {
    try {
      return action();
    } catch (error) {
      this.log(`sending failed: ${String(error)}`);
      this.endConnection?.('sending failed');
      return undefined;
    }
  }

  /** The end-of-turn flush: asked for by every `setUniverse`, done once. */
  private askToFlush(): void {
    if (this.flushing || !this.running) return;
    this.flushing = setImmediate(() => {
      this.flushing = undefined;
      this.guarded(() => this.send(false));
    });
  }

  /**
   * Sends what changed. Without `force` a universe that was sent less than a gap ago waits for
   * the rest of it. Returns true when nothing is left to send.
   */
  private send(force: boolean): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) return false;
    const now = this.now();
    let waitMs = Number.POSITIVE_INFINITY;
    let pending = false;

    for (const slot of this.universes.values()) {
      if (!slot.dirty) continue;
      if (slot.sent && same(slot.frame, slot.sent)) {
        slot.dirty = false;
        this.counters.skipped++;
        continue;
      }
      const gap = now - slot.lastSend;
      if (!force && gap < this.minIntervalMs) {
        waitMs = Math.min(waitMs, this.minIntervalMs - gap);
        pending = true;
        continue;
      }
      if (socket.bufferedAmount > this.maxBufferedBytes && !force) {
        this.counters.heldBack++;
        waitMs = Math.min(waitMs, this.minIntervalMs);
        pending = true;
        continue;
      }
      this.sendFrame(socket, slot, now);
      this.counters.sent++;
    }
    if (pending) this.retryIn(waitMs);
    return !pending;
  }

  private sendFrame(socket: SocketLike, slot: UniverseSlot, now: number): void {
    socket.send(slot.frame);
    if (!slot.sent) slot.sent = new Uint8Array(FRAME_SIZE);
    slot.sent.set(slot.frame);
    slot.dirty = false;
    slot.lastSend = now;
    this.armKeepAlive();
  }

  /** One timer for what has to wait, set for the earliest it can go. */
  private retryIn(ms: number): void {
    const at = this.now() + ms;
    if (this.retry && this.retryAt <= at) return;
    if (this.retry) clearTimeout(this.retry);
    this.retryAt = at;
    this.retry = setTimeout(
      () => {
        this.retry = undefined;
        this.retryAt = Number.POSITIVE_INFINITY;
        this.guarded(() => this.send(false));
      },
      Math.max(0, ms),
    );
  }

  /** After a quiet while the last frame goes again: the bridge hears that lightdeck is there. */
  private armKeepAlive(): void {
    if (this.keepAlive) clearTimeout(this.keepAlive);
    this.keepAlive = setTimeout(() => {
      this.keepAlive = undefined;
      this.guarded(() => {
        const socket = this.socket;
        if (!socket || socket.readyState !== SOCKET_OPEN) return;
        const now = this.now();
        let any = false;
        for (const slot of this.universes.values()) {
          if (!slot.sent) continue;
          socket.send(slot.frame);
          slot.sent.set(slot.frame);
          slot.lastSend = now;
          slot.dirty = false;
          this.counters.keepAlives++;
          any = true;
        }
        // No frame to repeat yet: the limits do the same, and a bridge that closes a silent
        // client (the phone does, after 6 s) does not close one that has nothing to say yet.
        if (!any) this.sendLimits();
        this.armKeepAlive();
      });
    }, this.keepAliveMs);
  }

  private sendLimits(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) return;
    socket.send(JSON.stringify({ type: 'limits', maxFps: this.maxFps }));
  }

  private clearTimers(): void {
    if (this.flushing) clearImmediate(this.flushing);
    if (this.retry) clearTimeout(this.retry);
    if (this.keepAlive) clearTimeout(this.keepAlive);
    if (this.silent) clearTimeout(this.silent);
    this.flushing = undefined;
    this.retry = undefined;
    this.retryAt = Number.POSITIVE_INFINITY;
    this.keepAlive = undefined;
    this.silent = undefined;
  }

  private connect(): void {
    if (!this.running) return;
    this.reconnect = undefined;
    let socket: SocketLike;
    try {
      socket = this.socketFactory(this.url);
    } catch (error) {
      this.noteUnreachable(String(error));
      this.scheduleReconnect();
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    let opened = false;

    // Every way this socket can end comes here, and only the first counts: an error and a
    // close for the same socket, or what a socket says after it was given up on, do nothing.
    const end = (why: string) => {
      if (this.attempt) clearTimeout(this.attempt);
      this.attempt = undefined;
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.endConnection = undefined;
      this.status = undefined;
      this.alive = undefined;
      this.aliveSeen = false;
      this.clearTimers();
      try {
        socket.close();
      } catch {
        // It is gone already.
      }
      if (opened) {
        this.log(`disconnected from ${this.url} (${why})`);
        this.unreachableLogged = false;
        this.onConnection?.(false);
      } else {
        this.noteUnreachable(why);
      }
      this.scheduleReconnect();
    };
    this.endConnection = end;

    this.attempt = setTimeout(() => end('no answer'), this.connectTimeoutMs);

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      if (this.attempt) clearTimeout(this.attempt);
      this.attempt = undefined;
      opened = true;
      this.unreachableLogged = false;
      this.backoffMs = this.reconnectMinMs;
      this.counters.connections++;
      // Bring the bridge back to the state the engine believes it is in.
      for (const slot of this.universes.values()) {
        slot.dirty = true;
        slot.sent = undefined;
        slot.lastSend = Number.NEGATIVE_INFINITY;
      }
      this.log(`connected to ${this.url}`);
      this.sendLimits();
      this.armKeepAlive();
      this.askToFlush();
      this.onConnection?.(true);
    });
    socket.addEventListener('message', (event) => this.handleMessage(event.data));
    socket.addEventListener('error', () => end('the connection failed'));
    socket.addEventListener('close', () => end('the connection closed'));
  }

  /** Says once, until it is connected again, that the bridge is not there. */
  private noteUnreachable(why: string): void {
    if (this.unreachableLogged) return;
    this.unreachableLogged = true;
    this.log(`cannot reach ${this.url} (${why}). Trying again every few seconds.`);
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    if (this.reconnect) clearTimeout(this.reconnect);
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.reconnectMaxMs);
    this.reconnect = setTimeout(() => this.connect(), delay);
  }

  /** A bridge that says `alive` is expected to go on saying something. */
  private armSilent(): void {
    if (this.silent) clearTimeout(this.silent);
    this.silent = setTimeout(
      () => this.endConnection?.('the bridge fell silent'),
      this.silentAfterMs,
    );
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
    if (m.type !== 'status' && m.type !== 'alive') return;
    if (m.device !== 'open' && m.device !== 'lost') return;
    // Anything from a bridge that has shown that it sends `alive` is a sign of life.
    if (this.aliveSeen) this.armSilent();

    if (m.type === 'alive') {
      const alive: BridgeAlive = {
        device: m.device,
        frames: typeof m.frames === 'number' ? m.frames : 0,
      };
      if (!this.aliveSeen) {
        this.aliveSeen = true;
        this.armSilent();
      }
      this.alive = alive;
      this.onAlive?.(alive);
      return;
    }
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
