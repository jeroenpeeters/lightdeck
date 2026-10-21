/**
 * Receives the OSC that rkbx_link sends from the computer that runs rekordbox: a UDP socket
 * that parses what comes in and hands the messages over with the moment they arrived. It
 * knows nothing about what the messages mean; that is for whoever listens.
 *
 * Events: `message` with an `OscMessage` and its arrival on the clock of the tempo,
 * `malformed` with the error and the sender when a datagram is not OSC.
 */

import { createSocket, type Socket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { OscError, type OscMessage, parseOsc } from './osc.js';

/** The port that rkbx_link sends to unless `osc.destination` in its config says otherwise. */
export const DEFAULT_OSC_PORT = 4460;

export interface OscReceiverOptions {
  /** 0 picks a free port; `port` says which. */
  port?: number;
  /** Default: every interface, as the sender is on another computer. */
  host?: string;
  /** Monotonic clock in milliseconds, the clock of the tempo. */
  now?: () => number;
}

export type MessageListener = (message: OscMessage, arrivedAt: number) => void;

export class OscReceiver extends EventEmitter {
  private socket: Socket | undefined;
  /** Set once the socket is bound: asking an unbound socket for its address throws. */
  private bound: number | undefined;
  private readonly wantedPort: number;
  private readonly host: string;
  private readonly now: () => number;

  constructor(options: OscReceiverOptions = {}) {
    super();
    this.wantedPort = options.port ?? DEFAULT_OSC_PORT;
    this.host = options.host ?? '0.0.0.0';
    this.now = options.now ?? (() => performance.now());
  }

  /** The port it listens on, once started. */
  get port(): number | undefined {
    return this.bound;
  }

  /** Binds the socket. Rejects when the port is taken. */
  start(): Promise<void> {
    if (this.socket !== undefined) return Promise.resolve();
    const socket = createSocket('udp4');
    this.socket = socket;
    socket.on('message', (packet, remote) => {
      const arrivedAt = this.now();
      let messages: OscMessage[];
      try {
        messages = parseOsc(packet);
      } catch (error) {
        if (!(error instanceof OscError)) throw error;
        this.emit('malformed', error, remote.address);
        return;
      }
      for (const message of messages) this.emit('message', message, arrivedAt);
    });
    return new Promise((resolve, reject) => {
      const failed = (error: Error) => {
        this.socket = undefined;
        this.bound = undefined;
        socket.close();
        reject(error);
      };
      socket.once('error', failed);
      socket.bind(this.wantedPort, this.host, () => {
        socket.off('error', failed);
        this.bound = socket.address().port;
        // A socket that fails later is not ours to throw from: say so and carry on.
        socket.on('error', (error) => this.emit('problem', error));
        resolve();
      });
    });
  }

  stop(): void {
    this.socket?.close();
    this.socket = undefined;
    this.bound = undefined;
  }
}
