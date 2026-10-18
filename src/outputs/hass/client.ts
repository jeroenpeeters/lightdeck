/**
 * Output adapter for Home Assistant: a WebSocket client for its API, `ws://<host>:8123/api/websocket`.
 *
 * Home Assistant says `auth_required`, the client answers with a long-lived access token and
 * gets `auth_ok` or `auth_invalid`. After `auth_ok` it asks for the states of the entities of the
 * rig once (`get_states`) and follows `state_changed` from then on, only for those entities, and
 * `watch` tells a controller what Home Assistant says of its entity. Commands are `call_service`
 * messages with a number each; the `result` that comes back with that number says whether it was
 * accepted, and a refusal reaches whoever listens with `problems`.
 *
 * - **A budget.** Commands go through a `Throttle`: a gap per entity, a limit in all, newest
 *   wins, urgent first. A pump timer sends what is due. Nothing is sent while there is no
 *   connection, and what waits keeps only the newest command per entity.
 * - **Nothing is replayed.** After a reconnect only what was still waiting goes out. The lamps
 *   kept their state, and sending every lamp at once is what the budget is there to prevent. A
 *   command that was on the way when the connection dropped is not sent again either.
 * - **Lightdeck starts without it.** `start` does not throw and does not wait. When Home
 *   Assistant cannot be reached the client polls for it, a little later each time up to
 *   `reconnectMaxMs`, as `Lr512BridgeClient` does for the bridge: Node's WebSocket sends `error`
 *   and no `close` when an attempt fails and nothing at all when the host does not answer, so
 *   an attempt is given `connectTimeoutMs`, and it counts as an attempt until the login is done.
 * - **A refused token is not tried every second.** The status is `refused`, and the client tries
 *   again every `refusedRetryMs` (30 s), in case the token was just made.
 * - **A silent connection is noticed.** Node's client cannot ping, so the client sends Home
 *   Assistant's own `ping` every `pingEveryMs` and gives up a connection that has said nothing
 *   for `silentAfterMs`.
 */

import {
  DEFAULT_MAX_IN_FLIGHT,
  DEFAULT_MIN_GAP_MS,
  DEFAULT_PER_SECOND,
  Throttle,
} from './throttle.js';
import type { EntityReport, HassCommand, HassOutput, HassStatus } from './types.js';

const SOCKET_OPEN = 1;

/** The part of the WebSocket API this client uses. Tests inject a fake. */
export interface HassSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
}

export type HassSocketFactory = (url: string) => HassSocketLike;

/** How a command ended, for whoever wants to measure: the soak test of `pnpm lamp`. */
export interface CommandResult {
  entity: string;
  ok: boolean;
  /** Milliseconds from sending the command to the answer. */
  ms: number;
  error?: string;
}

/** Everything the client knows of an entity that Home Assistant reported. */
export interface EntityInfo {
  report: EntityReport;
  /** The state as Home Assistant writes it: `on`, `off`, `unavailable`. */
  state: string;
  /** 0..255, when the entity reports a brightness. */
  brightness: number | undefined;
}

export interface HassClientOptions {
  /** For example ws://homeassistant.local:8123/api/websocket */
  url: string;
  /** A long-lived access token. */
  token: string;
  /** The entity ids of the rig. Only these are followed. */
  entities: readonly string[];
  socketFactory?: HassSocketFactory;
  /** Monotonic clock in milliseconds. Tests pass their own. */
  now?: () => number;
  /** The least time between two commands for one entity. Default 1000. */
  minGapMs?: number;
  /** The most commands in any second, in all. Default 10. */
  perSecond?: number;
  /** The most commands without an answer from Home Assistant, in all. Default 4. */
  maxInFlight?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** How long to wait before trying again after a token was refused. Default 30000. */
  refusedRetryMs?: number;
  /** How long an attempt, up to the login, may go without finishing. Default 5000. */
  connectTimeoutMs?: number;
  /** A ping is sent after this long. Default 15000. */
  pingEveryMs?: number;
  /** A connection that said nothing for this long is given up. Default 45000. */
  silentAfterMs?: number;
  onStatus?: (status: HassStatus) => void;
  onResult?: (result: CommandResult) => void;
  log?: (message: string) => void;
}

/** What the client has done so far, for the soak test and for the log. */
export interface HassClientStats {
  /** Commands handed to the socket. */
  sent: number;
  /** Commands Home Assistant accepted. */
  accepted: number;
  /** Commands Home Assistant refused. */
  refused: number;
  /** Commands that were on the way when the connection dropped, and are not sent again. */
  lost: number;
  /** Successful logins, including the first. */
  connections: number;
}

interface Call {
  entity: string;
  sentAt: number;
}

const defaultSocketFactory: HassSocketFactory = (url) =>
  new WebSocket(url) as unknown as HassSocketLike;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What an entity object of Home Assistant (`get_states`, `state_changed`) says, or nothing. */
function readEntity(state: unknown): EntityInfo | undefined {
  if (!isObject(state) || typeof state.state !== 'string') return undefined;
  const attributes = isObject(state.attributes) ? state.attributes : {};
  const modes = Array.isArray(attributes.supported_color_modes)
    ? attributes.supported_color_modes.filter((mode): mode is string => typeof mode === 'string')
    : [];
  return {
    state: state.state,
    brightness: typeof attributes.brightness === 'number' ? attributes.brightness : undefined,
    report: {
      available: state.state !== 'unavailable' && state.state !== 'unknown',
      on: state.state === 'on',
      colourModes: modes,
    },
  };
}

export class HassClient implements HassOutput {
  private readonly url: string;
  private readonly token: string;
  private readonly socketFactory: HassSocketFactory;
  private readonly now: () => number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly refusedRetryMs: number;
  private readonly connectTimeoutMs: number;
  private readonly pingEveryMs: number;
  private readonly silentAfterMs: number;
  private readonly onStatus: ((status: HassStatus) => void) | undefined;
  private readonly onResult: ((result: CommandResult) => void) | undefined;
  private readonly log: (message: string) => void;

  private readonly throttle: Throttle<HassCommand>;
  /** The entities whose state is kept: those of the rig and those that are watched. */
  private readonly tracked: Set<string>;
  private readonly infos = new Map<string, EntityInfo>();
  private readonly watchers = new Map<string, Set<(report: EntityReport | undefined) => void>>();
  private readonly problemListeners = new Map<string, Set<(problem: string | null) => void>>();
  private readonly problemOf = new Map<string, string>();
  private readonly waiting = new Set<(connected: boolean) => void>();

  private counters: HassClientStats = { sent: 0, accepted: 0, refused: 0, lost: 0, connections: 0 };
  private socket: HassSocketLike | undefined;
  private running = false;
  private statusNow: HassStatus = 'down';
  private backoffMs: number;
  private nextId = 1;
  private readonly calls = new Map<number, Call>();
  /** The numbers of the `get_states` requests that are on the way. */
  private readonly stateRequests = new Set<number>();
  /** That the login failed on this connection, so that the end of it is not a plain drop. */
  private refused = false;
  /** That the log has said that Home Assistant cannot be reached, so it does not say it at every try. */
  private unreachableLogged = false;
  private pump: ReturnType<typeof setTimeout> | undefined;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private attempt: ReturnType<typeof setTimeout> | undefined;
  private ping: ReturnType<typeof setTimeout> | undefined;
  private silent: ReturnType<typeof setTimeout> | undefined;
  /** Ends the connection that is open, from outside the function that made it. */
  private endConnection: ((why: string) => void) | undefined;

  constructor(options: HassClientOptions) {
    this.url = options.url;
    this.token = options.token;
    this.tracked = new Set(options.entities);
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.now = options.now ?? (() => performance.now());
    this.reconnectMinMs = options.reconnectMinMs ?? 500;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 10_000;
    this.refusedRetryMs = options.refusedRetryMs ?? 30_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
    this.pingEveryMs = options.pingEveryMs ?? 15_000;
    this.silentAfterMs = options.silentAfterMs ?? 45_000;
    this.onStatus = options.onStatus;
    this.onResult = options.onResult;
    this.log = options.log ?? (() => {});
    this.backoffMs = this.reconnectMinMs;
    this.throttle = new Throttle<HassCommand>({
      minGapMs: options.minGapMs ?? DEFAULT_MIN_GAP_MS,
      perSecond: options.perSecond ?? DEFAULT_PER_SECOND,
      maxInFlight: options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT,
      now: this.now,
    });
  }

  get status(): HassStatus {
    return this.statusNow;
  }

  get connected(): boolean {
    return this.statusNow === 'connected';
  }

  /** Commands sent that Home Assistant has not answered yet. */
  get unanswered(): number {
    return this.calls.size;
  }

  get stats(): HassClientStats {
    return { ...this.counters };
  }

  /** What Home Assistant says of the entities that were asked for, as far as it has said it. */
  reports(): ReadonlyMap<string, EntityInfo> {
    return new Map(this.infos);
  }

  /** Resolves when the login is done, and rejects after `timeoutMs`. */
  whenConnected(timeoutMs: number): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(listener);
        reject(
          new Error(
            this.statusNow === 'refused'
              ? 'Home Assistant refused the token'
              : `could not reach Home Assistant at ${this.url} within ${Math.round(timeoutMs / 1000)} s`,
          ),
        );
      }, timeoutMs);
      const listener = (connected: boolean) => {
        if (!connected) return;
        clearTimeout(timer);
        this.waiting.delete(listener);
        resolve();
      };
      this.waiting.add(listener);
    });
  }

  setEntity(entity: string, command: HassCommand, options: { urgent?: boolean } = {}): void {
    this.throttle.push(entity, command, options);
    this.armPump();
  }

  watch(entity: string, listener: (report: EntityReport | undefined) => void): () => void {
    let listeners = this.watchers.get(entity);
    if (!listeners) {
      listeners = new Set();
      this.watchers.set(entity, listeners);
    }
    listeners.add(listener);
    const known = this.infos.get(entity);
    if (known) listener(known.report);
    else if (!this.tracked.has(entity)) {
      this.tracked.add(entity);
      this.askForStates();
    }
    return () => listeners.delete(listener);
  }

  problems(entity: string, listener: (problem: string | null) => void): () => void {
    let listeners = this.problemListeners.get(entity);
    if (!listeners) {
      listeners = new Set();
      this.problemListeners.set(entity, listeners);
    }
    listeners.add(listener);
    const known = this.problemOf.get(entity);
    if (known !== undefined) listener(known);
    return () => listeners.delete(listener);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnect) clearTimeout(this.reconnect);
    if (this.attempt) clearTimeout(this.attempt);
    if (this.pump) clearTimeout(this.pump);
    this.reconnect = undefined;
    this.attempt = undefined;
    this.pump = undefined;
    this.clearConnectionTimers();
    this.endConnection = undefined;
    const socket = this.socket;
    this.socket = undefined;
    try {
      socket?.close();
    } catch {
      // It is gone already.
    }
  }

  private connect(): void {
    if (!this.running) return;
    this.reconnect = undefined;
    let socket: HassSocketLike;
    try {
      socket = this.socketFactory(this.url);
    } catch (error) {
      this.noteUnreachable(String(error));
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.refused = false;
    let loggedIn = false;

    // Every way this socket can end comes here, and only the first counts: an error and a
    // close for the same socket, or what a socket says after it was given up on, do nothing.
    const end = (why: string) => {
      if (this.attempt) clearTimeout(this.attempt);
      this.attempt = undefined;
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.endConnection = undefined;
      this.clearConnectionTimers();
      if (this.pump) clearTimeout(this.pump);
      this.pump = undefined;
      try {
        socket.close();
      } catch {
        // It is gone already.
      }
      // Commands on the way are lost: they are not sent again, and the lamps keep their state.
      this.counters.lost += this.calls.size;
      this.throttle.abandon();
      this.calls.clear();
      this.stateRequests.clear();
      if (this.refused) {
        this.setStatus('refused');
      } else {
        this.setStatus('down');
        if (loggedIn) {
          this.log(`disconnected from ${this.url} (${why})`);
          this.unreachableLogged = false;
        } else {
          this.noteUnreachable(why);
        }
      }
      this.forgetStates();
      this.scheduleReconnect();
    };
    this.endConnection = end;

    // The attempt runs until the login is done: a server that opens and then says nothing is no better.
    this.attempt = setTimeout(() => end('no answer'), this.connectTimeoutMs);

    socket.addEventListener('open', () => {
      // Home Assistant speaks first (`auth_required`). Nothing to do until then.
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      this.armSilent();
      const message = this.parse(event.data);
      if (!message) return;
      if (message.type === 'auth_required') {
        this.sendNow({ type: 'auth', access_token: this.token });
      } else if (message.type === 'auth_ok') {
        loggedIn = true;
        if (this.attempt) clearTimeout(this.attempt);
        this.attempt = undefined;
        this.unreachableLogged = false;
        this.backoffMs = this.reconnectMinMs;
        this.nextId = 1;
        this.counters.connections++;
        this.log(`connected to ${this.url}`);
        this.setStatus('connected');
        this.askForStates();
        this.sendNow({ id: this.nextId++, type: 'subscribe_events', event_type: 'state_changed' });
        this.armSilent();
        this.armPing();
        this.armPump();
      } else if (message.type === 'auth_invalid') {
        this.refused = true;
        this.log(
          `Home Assistant refused the token (${String(message.message ?? 'auth_invalid')}). Trying again in ${Math.round(this.refusedRetryMs / 1000)} s.`,
        );
        end('the token was refused');
      } else if (message.type === 'result') {
        this.handleResult(message);
      } else if (message.type === 'event') {
        this.handleEvent(message);
      }
    });
    socket.addEventListener('error', () => end('the connection failed'));
    socket.addEventListener('close', () => end('the connection closed'));
  }

  private parse(data: unknown): Record<string, unknown> | undefined {
    if (typeof data !== 'string') return undefined;
    try {
      const message: unknown = JSON.parse(data);
      return isObject(message) ? message : undefined;
    } catch {
      return undefined;
    }
  }

  private setStatus(status: HassStatus): void {
    if (status === this.statusNow) return;
    this.statusNow = status;
    this.onStatus?.(status);
    for (const listener of [...this.waiting]) listener(status === 'connected');
  }

  /** Says once, until it is connected again, that Home Assistant is not there. */
  private noteUnreachable(why: string): void {
    if (this.unreachableLogged) return;
    this.unreachableLogged = true;
    this.log(`cannot reach ${this.url} (${why}). Trying again every few seconds.`);
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    if (this.reconnect) clearTimeout(this.reconnect);
    let delay = this.backoffMs;
    if (this.refused) {
      delay = this.refusedRetryMs;
    } else {
      this.backoffMs = Math.min(this.backoffMs * 2, this.reconnectMaxMs);
    }
    this.reconnect = setTimeout(() => this.connect(), delay);
  }

  private clearConnectionTimers(): void {
    if (this.ping) clearTimeout(this.ping);
    if (this.silent) clearTimeout(this.silent);
    this.ping = undefined;
    this.silent = undefined;
  }

  /** Any message is a sign of life. Silence for too long ends the connection. */
  private armSilent(): void {
    if (!this.endConnection || this.statusNow !== 'connected') return;
    if (this.silent) clearTimeout(this.silent);
    this.silent = setTimeout(
      () => this.endConnection?.('Home Assistant fell silent'),
      this.silentAfterMs,
    );
  }

  private armPing(): void {
    if (this.ping) clearTimeout(this.ping);
    this.ping = setTimeout(() => {
      this.ping = undefined;
      if (!this.sendNow({ id: this.nextId++, type: 'ping' })) return;
      this.armPing();
    }, this.pingEveryMs);
  }

  /**
   * Sends a message on the open socket. A socket that refuses to send is a connection that is
   * gone: it is ended, and the client goes looking again. Returns whether it was sent.
   */
  private sendNow(message: Record<string, unknown>): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      this.log(`sending failed: ${String(error)}`);
      this.endConnection?.('sending failed');
      return false;
    }
  }

  private askForStates(): void {
    if (this.statusNow !== 'connected') return;
    const id = this.nextId++;
    this.stateRequests.add(id);
    this.sendNow({ id, type: 'get_states' });
  }

  /** The states are not known while the link is down. */
  private forgetStates(): void {
    const known = [...this.infos.keys()];
    this.infos.clear();
    for (const entity of known) this.tell(entity, undefined);
  }

  private tell(entity: string, report: EntityReport | undefined): void {
    for (const listener of [...(this.watchers.get(entity) ?? [])]) listener(report);
  }

  private keep(entity: string, info: EntityInfo | undefined): void {
    if (!this.tracked.has(entity)) return;
    const before = this.infos.get(entity);
    if (info) this.infos.set(entity, info);
    else this.infos.delete(entity);
    const a = before?.report;
    const b = info?.report;
    const same =
      a !== undefined &&
      b !== undefined &&
      a.available === b.available &&
      a.on === b.on &&
      a.colourModes.join() === b.colourModes.join();
    if (!same && (a !== undefined || b !== undefined)) this.tell(entity, b);
  }

  private handleResult(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof id !== 'number') return;
    if (this.stateRequests.delete(id)) {
      if (message.success !== true || !Array.isArray(message.result)) {
        this.log('could not read the states from Home Assistant');
        return;
      }
      for (const state of message.result) {
        const entity = isObject(state) ? state.entity_id : undefined;
        if (typeof entity !== 'string' || !this.tracked.has(entity)) continue;
        this.keep(entity, readEntity(state));
      }
      return;
    }
    const call = this.calls.get(id);
    if (!call) return;
    this.calls.delete(id);
    this.throttle.done(call.entity);
    const ok = message.success === true;
    if (ok) this.counters.accepted++;
    else this.counters.refused++;
    const error =
      isObject(message.error) && typeof message.error.message === 'string'
        ? message.error.message
        : 'Home Assistant refused the command';
    this.onResult?.({
      entity: call.entity,
      ok,
      ms: this.now() - call.sentAt,
      ...(ok ? {} : { error }),
    });
    if (ok) {
      if (this.problemOf.delete(call.entity)) this.tellProblem(call.entity, null);
    } else {
      this.log(`${call.entity}: ${error}`);
      if (this.problemOf.get(call.entity) !== error) {
        this.problemOf.set(call.entity, error);
        this.tellProblem(call.entity, error);
      }
    }
    // An answer frees a place: what waited for one can go now.
    this.armPump();
  }

  private tellProblem(entity: string, problem: string | null): void {
    for (const listener of [...(this.problemListeners.get(entity) ?? [])]) listener(problem);
  }

  private handleEvent(message: Record<string, unknown>): void {
    const event = message.event;
    if (!isObject(event) || event.event_type !== 'state_changed' || !isObject(event.data)) return;
    const entity = event.data.entity_id;
    if (typeof entity !== 'string' || !this.tracked.has(entity)) return;
    this.keep(entity, readEntity(event.data.new_state));
  }

  /** Sends what is due now, and arms the timer for what is due later. */
  private armPump(): void {
    if (this.pump) clearTimeout(this.pump);
    this.pump = undefined;
    if (this.statusNow !== 'connected') return;
    for (;;) {
      const next = this.throttle.take();
      if (!next) break;
      const { entity, item } = next;
      const id = this.nextId++;
      const sent = this.sendNow({
        id,
        type: 'call_service',
        domain: item.domain,
        service: item.service,
        service_data: { entity_id: entity, ...item.data },
      });
      if (!sent) {
        // The connection went with it. What was taken is not lost: it waits for the next one.
        this.throttle.done(entity);
        this.throttle.push(entity, item);
        return;
      }
      this.counters.sent++;
      this.calls.set(id, { entity, sentAt: this.now() });
    }
    const due = this.throttle.nextDueAt();
    if (due === undefined) return;
    this.pump = setTimeout(
      () => {
        this.pump = undefined;
        this.armPump();
      },
      Math.max(0, due - this.now()),
    );
  }
}
