import { createHash } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BridgeAlive,
  type BridgeStatus,
  FRAME_SIZE,
  Lr512BridgeClient,
  type SocketLike,
} from './bridgeClient.js';

type Listener = (event: { data?: unknown }) => void;

class FakeSocket implements SocketLike {
  readyState = 0;
  bufferedAmount = 0;
  binaryType = '';
  sent: Uint8Array[] = [];
  /** The text messages, which are not frames. */
  texts: string[] = [];
  closed = false;
  private listeners = new Map<string, Listener[]>();

  send(data: Uint8Array | string): void {
    if (typeof data === 'string') this.texts.push(data);
    else this.sent.push(data.slice());
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data?: unknown): void {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }
}

function universeOf(value: number): Uint8Array {
  return new Uint8Array(512).fill(value);
}

describe('Lr512BridgeClient with a fake socket', () => {
  let sockets: FakeSocket[];
  let client: Lr512BridgeClient;
  let statuses: BridgeStatus[];
  let alives: BridgeAlive[];
  let connections: boolean[];
  let logs: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    statuses = [];
    alives = [];
    connections = [];
    logs = [];
    client = new Lr512BridgeClient({
      url: 'ws://bridge:9010',
      maxFps: 25,
      now: () => Date.now(),
      maxBufferedFrames: 2,
      reconnectMinMs: 500,
      reconnectMaxMs: 2000,
      connectTimeoutMs: 1000,
      socketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      onStatus: (s) => statuses.push(s),
      onAlive: (a) => alives.push(a),
      onConnection: (c) => connections.push(c),
      log: (m) => logs.push(m),
    });
  });

  afterEach(() => {
    client.stop();
    vi.useRealTimers();
  });

  const latest = () => sockets[sockets.length - 1] as FakeSocket;

  it('sends [universe][512 bytes] frames', () => {
    client.start();
    latest().emit('open');
    client.setUniverse(1, universeOf(7));
    vi.advanceTimersByTime(0);
    expect(latest().sent).toHaveLength(1);
    const frame = latest().sent[0] as Uint8Array;
    expect(frame).toHaveLength(FRAME_SIZE);
    expect(frame[0]).toBe(1);
    expect(frame[1]).toBe(7);
    expect(frame[512]).toBe(7);
  });

  describe('what goes out, and when', () => {
    it('sends a change at the end of the turn of the event loop, not a timer later', () => {
      client.start();
      latest().emit('open');
      client.setUniverse(0, universeOf(1));
      // Nothing yet: what is made in the same turn goes out together.
      expect(latest().sent).toHaveLength(0);
      vi.advanceTimersByTime(0);
      expect(latest().sent).toHaveLength(1);
    });

    it('sends what several fixtures made in one turn as one frame, with all of it in', () => {
      client.start();
      latest().emit('open');
      const first = universeOf(0);
      first[0] = 11;
      client.setUniverse(0, first);
      const second = universeOf(0);
      second[0] = 11;
      second[43] = 22;
      client.setUniverse(0, second);
      vi.advanceTimersByTime(0);
      expect(latest().sent).toHaveLength(1);
      expect((latest().sent[0] as Uint8Array)[1]).toBe(11);
      expect((latest().sent[0] as Uint8Array)[44]).toBe(22);
    });

    it('does not send a frame that equals the one sent before', () => {
      client.start();
      latest().emit('open');
      client.setUniverse(0, universeOf(5));
      vi.advanceTimersByTime(0);
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(50);
        client.setUniverse(0, universeOf(5));
        vi.advanceTimersByTime(0);
      }
      expect(latest().sent).toHaveLength(1);
      expect(client.stats.sent).toBe(1);
      expect(client.stats.skipped).toBe(10);
    });

    it('sends again as soon as the frame is not the same any more', () => {
      client.start();
      latest().emit('open');
      client.setUniverse(0, universeOf(5));
      vi.advanceTimersByTime(100);
      client.setUniverse(0, universeOf(6));
      vi.advanceTimersByTime(0);
      expect(latest().sent).toHaveLength(2);
      client.setUniverse(0, universeOf(5));
      vi.advanceTimersByTime(100);
      expect(latest().sent).toHaveLength(3);
    });

    it('lets a frame that comes sooner than a gap wait for the rest of it, and sends the newest', () => {
      client.start();
      latest().emit('open');
      client.setUniverse(0, universeOf(1));
      vi.advanceTimersByTime(0);
      expect(latest().sent).toHaveLength(1);
      // 25 per second is a gap of 40 ms.
      vi.advanceTimersByTime(10);
      client.setUniverse(0, universeOf(2));
      vi.advanceTimersByTime(10);
      client.setUniverse(0, universeOf(3));
      vi.advanceTimersByTime(19);
      expect(latest().sent).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(latest().sent).toHaveLength(2);
      expect((latest().sent[1] as Uint8Array)[1]).toBe(3);
    });

    it('sends a change at once when nothing was sent for a while', () => {
      client.start();
      latest().emit('open');
      client.setUniverse(0, universeOf(1));
      vi.advanceTimersByTime(0);
      vi.advanceTimersByTime(300);
      client.setUniverse(0, universeOf(2));
      vi.advanceTimersByTime(0);
      expect(latest().sent).toHaveLength(2);
    });

    it('goes out at the cap and no faster when every frame is new', () => {
      client.start();
      latest().emit('open');
      for (let ms = 0; ms < 2000; ms += 5) {
        client.setUniverse(0, universeOf(1 + ((ms / 5) % 200)));
        vi.advanceTimersByTime(5);
      }
      const sent = latest().sent.length;
      expect(sent).toBeLessThanOrEqual(2000 / 40 + 1);
      expect(sent).toBeGreaterThanOrEqual(2000 / 40 - 2);
    });

    it('keeps the cap per universe', () => {
      client.start();
      latest().emit('open');
      client.setUniverse(0, universeOf(1));
      client.setUniverse(1, universeOf(1));
      vi.advanceTimersByTime(0);
      expect(latest().sent).toHaveLength(2);
      client.setUniverse(0, universeOf(2));
      vi.advanceTimersByTime(40);
      expect(latest().sent).toHaveLength(3);
    });

    it('holds frames back while the socket is backed up, then sends the newest', () => {
      client.start();
      latest().emit('open');
      latest().bufferedAmount = 3 * FRAME_SIZE;
      client.setUniverse(0, universeOf(1));
      vi.advanceTimersByTime(100);
      expect(latest().sent).toHaveLength(0);
      expect(client.stats.heldBack).toBeGreaterThan(0);

      client.setUniverse(0, universeOf(2));
      latest().bufferedAmount = 0;
      vi.advanceTimersByTime(40);
      expect(latest().sent).toHaveLength(1);
      expect((latest().sent[0] as Uint8Array)[1]).toBe(2);
    });

    it('keeps universes apart', () => {
      client.start();
      latest().emit('open');
      client.setUniverse(0, universeOf(10));
      client.setUniverse(1, universeOf(20));
      vi.advanceTimersByTime(0);
      const frames = latest().sent.map((f) => [f[0], f[1]]);
      expect(frames).toEqual([
        [0, 10],
        [1, 20],
      ]);
    });

    it('sends what is pending right away, past the cap, when it is told to flush', () => {
      client.start();
      latest().emit('open');
      client.setUniverse(0, universeOf(1));
      vi.advanceTimersByTime(0);
      client.setUniverse(0, universeOf(2));
      expect(client.flush()).toBe(true);
      expect(latest().sent).toHaveLength(2);
      expect((latest().sent[1] as Uint8Array)[1]).toBe(2);
    });
  });

  describe('the cap', () => {
    it('is 25 per second to start with, and the bridge is told when it connects', () => {
      expect(client.getMaxFps()).toBe(25);
      client.start();
      latest().emit('open');
      expect(latest().texts).toEqual(['{"type":"limits","maxFps":25}']);
    });

    it('can be changed, which the bridge is told, and then holds', () => {
      client.start();
      latest().emit('open');
      client.setMaxFps(10);
      expect(client.getMaxFps()).toBe(10);
      expect(latest().texts.at(-1)).toBe('{"type":"limits","maxFps":10}');
      client.setUniverse(0, universeOf(1));
      vi.advanceTimersByTime(0);
      client.setUniverse(0, universeOf(2));
      vi.advanceTimersByTime(99);
      expect(latest().sent).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(latest().sent).toHaveLength(2);
    });

    it('refuses a rate that makes no sense, and keeps the one it has', () => {
      for (const bad of [0, -5, 61, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => client.setMaxFps(bad)).toThrow(RangeError);
      }
      expect(client.getMaxFps()).toBe(25);
    });

    it('is not told to a bridge that is not there', () => {
      client.setMaxFps(30);
      client.start();
      latest().emit('open');
      expect(latest().texts).toEqual(['{"type":"limits","maxFps":30}']);
    });
  });

  describe('the keep-alive', () => {
    it('sends the last frame again after a second without a send, and goes on every second', () => {
      client.start();
      latest().emit('open');
      client.setUniverse(0, universeOf(7));
      vi.advanceTimersByTime(0);
      vi.advanceTimersByTime(999);
      expect(latest().sent).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(latest().sent).toHaveLength(2);
      expect((latest().sent[1] as Uint8Array)[1]).toBe(7);
      vi.advanceTimersByTime(3000);
      expect(latest().sent).toHaveLength(5);
      expect(client.stats.keepAlives).toBe(4);
    });

    it('starts the second over with every send', () => {
      client.start();
      latest().emit('open');
      client.setUniverse(0, universeOf(1));
      vi.advanceTimersByTime(0);
      vi.advanceTimersByTime(900);
      client.setUniverse(0, universeOf(2));
      vi.advanceTimersByTime(0);
      vi.advanceTimersByTime(900);
      expect(latest().sent).toHaveLength(2);
      vi.advanceTimersByTime(100);
      expect(latest().sent).toHaveLength(3);
    });

    it('has no frame to repeat before one was sent, and says its limits again instead', () => {
      client.start();
      latest().emit('open');
      vi.advanceTimersByTime(5000);
      expect(latest().sent).toHaveLength(0);
      // The bridge on the phone closes a client that sent its limits and then nothing for 6 s.
      expect(latest().texts).toEqual(Array(6).fill('{"type":"limits","maxFps":25}'));
      expect(client.stats.keepAlives).toBe(0);
    });

    it('goes back to frames when one is sent, and stops saying the limits', () => {
      client.start();
      latest().emit('open');
      vi.advanceTimersByTime(1500);
      client.setUniverse(0, universeOf(3));
      vi.advanceTimersByTime(0);
      const texts = latest().texts.length;
      vi.advanceTimersByTime(3000);
      expect(latest().texts).toHaveLength(texts);
      expect(latest().sent).toHaveLength(4);
    });

    it('does not run a keep-alive for a socket that is gone', () => {
      client.start();
      latest().emit('open');
      latest().emit('close');
      const before = latest().texts.length;
      vi.advanceTimersByTime(400);
      expect(latest().texts).toHaveLength(before);
      expect(vi.getTimerCount()).toBe(1);
    });
  });

  it('reconnects with backoff and replays the last state', () => {
    client.start();
    latest().emit('open');
    client.setUniverse(1, universeOf(42));
    vi.advanceTimersByTime(25);
    expect(sockets).toHaveLength(1);

    latest().emit('close');
    expect(client.connected).toBe(false);
    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    // Second failure waits twice as long.
    latest().emit('close');
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);

    latest().emit('open');
    vi.advanceTimersByTime(0);
    // The frame is the same as the one that was sent on the connection before, and it goes
    // again: the bridge that is there now knows nothing of it.
    expect(latest().sent).toHaveLength(1);
    expect((latest().sent[0] as Uint8Array)[1]).toBe(42);
    expect(client.stats.connections).toBe(2);
  });

  // Node's WebSocket does not send `close` after an attempt that fails: it sends `error` and
  // nothing else. Waiting for a `close` that never comes left the client stuck for good, so
  // a bridge that was not there yet when lightdeck started, or that was not back yet at the
  // first retry, was never found.
  it('tries again after an attempt that failed with an error and no close', () => {
    client.start();
    expect(sockets).toHaveLength(1);
    latest().emit('error');
    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    // And again, with the backoff doubling up to its limit, for as long as it takes.
    latest().emit('error');
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(3);
    latest().emit('error');
    vi.advanceTimersByTime(2000);
    expect(sockets).toHaveLength(4);
    latest().emit('error');
    vi.advanceTimersByTime(2000);
    expect(sockets).toHaveLength(5);
    latest().emit('open');
    expect(client.connected).toBe(true);
  });

  it('tries again after a connection that dropped with an error and no close', () => {
    client.start();
    latest().emit('open');
    latest().emit('error');
    expect(client.connected).toBe(false);
    expect(connections).toEqual([true, false]);
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);
  });

  it('tries once, not twice, when an error is followed by a close', () => {
    client.start();
    latest().emit('open');
    latest().emit('error');
    latest().emit('close');
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(2);
    // The late close of the first socket must not touch the second.
    sockets[0]?.emit('close');
    latest().emit('open');
    expect(client.connected).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(2);
  });

  it('gives up on an attempt that never answers, which is a bridge that is not reachable', () => {
    client.start();
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sockets[0]?.closed).toBe(true);
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);
    // What the first socket says when it finally fails is not heard.
    sockets[0]?.emit('error');
    sockets[0]?.emit('close');
    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(2);
  });

  it('does not give up on a connection that opened because it is quiet', () => {
    client.start();
    latest().emit('open');
    vi.advanceTimersByTime(60_000);
    expect(client.connected).toBe(true);
    expect(sockets).toHaveLength(1);
  });

  it('tells that it is connected, and that it is not, only when that changes', () => {
    client.start();
    latest().emit('error');
    vi.advanceTimersByTime(500);
    latest().emit('error');
    expect(connections).toEqual([]);
    vi.advanceTimersByTime(1000);
    latest().emit('open');
    latest().emit('close');
    expect(connections).toEqual([true, false]);
  });

  it('says once that the bridge cannot be reached, not at every try, and when it is back', () => {
    client.start();
    for (let i = 0; i < 6; i++) {
      latest().emit('error');
      vi.advanceTimersByTime(2000);
    }
    const unreachable = logs.filter((line) => line.includes('cannot reach'));
    expect(unreachable).toHaveLength(1);
    expect(unreachable[0]).toContain('ws://bridge:9010');
    latest().emit('open');
    expect(logs.at(-1)).toContain('connected to ws://bridge:9010');
    // A new drop says it again.
    latest().emit('close');
    vi.advanceTimersByTime(500);
    latest().emit('error');
    expect(logs.filter((line) => line.includes('cannot reach')).length).toBeGreaterThanOrEqual(1);
  });

  it('frames set while disconnected are sent once connected', () => {
    client.start();
    client.setUniverse(0, universeOf(5));
    vi.advanceTimersByTime(200);
    expect(latest().sent).toHaveLength(0);
    latest().emit('open');
    vi.advanceTimersByTime(25);
    expect(latest().sent).toHaveLength(1);
  });

  describe('a bridge that says it is alive', () => {
    const alive = (frames = 0, device = 'open') =>
      JSON.stringify({ type: 'alive', device, frames });

    it('is reported, with what it says', () => {
      client.start();
      latest().emit('open');
      latest().emit('message', alive(12));
      expect(alives).toEqual([{ device: 'open', frames: 12 }]);
      expect(client.alive).toEqual({ device: 'open', frames: 12 });
    });

    it('is given up on after four seconds without a message, once it has said so', () => {
      client.start();
      latest().emit('open');
      latest().emit('message', alive());
      vi.advanceTimersByTime(3999);
      expect(client.connected).toBe(true);
      vi.advanceTimersByTime(1);
      expect(client.connected).toBe(false);
      expect(sockets[0]?.closed).toBe(true);
      expect(connections).toEqual([true, false]);
      expect(logs.some((line) => line.includes('fell silent'))).toBe(true);
      // And the client goes looking for it again.
      vi.advanceTimersByTime(500);
      expect(sockets).toHaveLength(2);
    });

    it('is kept by every message it sends, a status as well as an alive', () => {
      client.start();
      latest().emit('open');
      latest().emit('message', alive());
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(3000);
        latest().emit(
          'message',
          i % 2 === 0
            ? alive(i)
            : '{"type":"status","device":"open","universes":2,"channels":[512,0]}',
        );
      }
      expect(client.connected).toBe(true);
    });

    it('is not what an older bridge is held to: it never said it, so it is left alone', () => {
      client.start();
      latest().emit('open');
      latest().emit(
        'message',
        '{"type":"status","device":"open","universes":2,"channels":[512,0]}',
      );
      vi.advanceTimersByTime(120_000);
      expect(client.connected).toBe(true);
    });

    it('is asked again on the next connection, which may be an older bridge', () => {
      client.start();
      latest().emit('open');
      latest().emit('message', alive());
      latest().emit('close');
      vi.advanceTimersByTime(500);
      latest().emit('open');
      vi.advanceTimersByTime(120_000);
      expect(client.connected).toBe(true);
      expect(client.alive).toBeUndefined();
    });

    it('is not trusted when it says something that is not a state of the device', () => {
      client.start();
      latest().emit('open');
      latest().emit('message', '{"type":"alive","device":"on fire"}');
      expect(alives).toHaveLength(0);
    });
  });

  it('reports bridge status and ignores anything else', () => {
    client.start();
    latest().emit('open');
    latest().emit('message', '{"type":"status","device":"open","universes":2,"channels":[512,0]}');
    latest().emit('message', '{"type":"status","device":"lost","universes":0}');
    latest().emit('message', 'not json');
    latest().emit('message', '{"type":"other"}');
    latest().emit('message', new ArrayBuffer(4));
    expect(statuses).toEqual([
      { device: 'open', universes: 2, channels: [512, 0] },
      // An older bridge that does not report channels still works.
      { device: 'lost', universes: 0, channels: [] },
    ]);
    expect(client.status).toEqual({ device: 'lost', universes: 0, channels: [] });
  });

  describe('a socket that refuses to send', () => {
    /** What a socket does that is closing under the client: it throws instead of sending. */
    const refuse = (socket: FakeSocket) => {
      socket.send = () => {
        throw new Error('the socket is closing');
      };
    };

    it('does not kill the process from a timer: the connection is ended and found again', () => {
      client.start();
      latest().emit('open');
      refuse(latest());
      client.setUniverse(0, universeOf(1));
      expect(() => vi.advanceTimersByTime(0)).not.toThrow();
      expect(logs.some((line) => line.includes('sending failed'))).toBe(true);
      expect(client.connected).toBe(false);
      vi.advanceTimersByTime(500);
      expect(sockets).toHaveLength(2);
      latest().emit('open');
      vi.advanceTimersByTime(0);
      expect(latest().sent).toHaveLength(1);
    });

    it('does not kill the process from the keep-alive either', () => {
      client.start();
      latest().emit('open');
      client.setUniverse(0, universeOf(1));
      vi.advanceTimersByTime(0);
      refuse(latest());
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
      expect(sockets[0]?.closed).toBe(true);
    });

    it('does not throw out of a flush at shutdown', () => {
      client.start();
      latest().emit('open');
      refuse(latest());
      client.setUniverse(0, universeOf(1));
      expect(client.flush()).toBe(false);
    });
  });

  it('leaves no timer behind when it is stopped', () => {
    client.start();
    latest().emit('open');
    latest().emit('message', '{"type":"alive","device":"open","frames":0}');
    client.setUniverse(0, universeOf(1));
    vi.advanceTimersByTime(0);
    client.setUniverse(0, universeOf(2));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    client.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops reconnecting after stop()', () => {
    client.start();
    latest().emit('open');
    client.stop();
    expect(latest().closed).toBe(true);
    latest().emit('close');
    vi.advanceTimersByTime(10000);
    expect(sockets).toHaveLength(1);
  });

  it('rejects malformed universes', () => {
    expect(() => client.setUniverse(0, new Uint8Array(10))).toThrow(RangeError);
    expect(() => client.setUniverse(-1, universeOf(0))).toThrow(RangeError);
    expect(() => client.setUniverse(256, universeOf(0))).toThrow(RangeError);
  });
});

/**
 * A WebSocket server reduced to what the Android bridge does: the RFC 6455
 * handshake, a status text frame, and parsing of masked client frames. It lets the
 * client run against Node's real WebSocket instead of the fake.
 */
interface MiniBridge {
  server: Server;
  port: number;
  /** Goes away the way a bridge does when its app is closed: the connections are cut. */
  stop(): Promise<void>;
}

function miniBridge(onFrame: (payload: Buffer) => void, atPort = 0): Promise<MiniBridge> {
  const open = new Set<Socket>();
  const server = createServer((socket: Socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const key = /sec-websocket-key:\s*(.+)\r\n/i.exec(buffer.toString('latin1'))?.[1]?.trim();
        const accept = createHash('sha1')
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64');
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        const status = Buffer.from(
          '{"type":"status","device":"open","universes":2,"channels":[512,0]}',
        );
        socket.write(Buffer.concat([Buffer.from([0x81, status.length]), status]));
        buffer = buffer.subarray(end + 4);
        upgraded = true;
      }
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = (buffer[0] as number) & 0x0f;
        const masked = ((buffer[1] as number) & 0x80) !== 0;
        let length = (buffer[1] as number) & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        }
        const maskOffset = offset;
        if (masked) offset += 4;
        if (buffer.length < offset + length) return;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        if (masked) {
          for (let i = 0; i < payload.length; i++) {
            payload[i] = (payload[i] as number) ^ (buffer[maskOffset + (i & 3)] as number);
          }
        }
        buffer = buffer.subarray(offset + length);
        if (opcode === 0x2) onFrame(payload);
        if (opcode === 0x8) socket.end();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(atPort, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        port: typeof address === 'object' && address ? address.port : 0,
        stop: () =>
          new Promise<void>((done) => {
            for (const socket of open) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

/** A port that nothing listens on: it was free a moment ago. */
async function freePort(): Promise<number> {
  const probe = await miniBridge(() => {});
  const { port } = probe;
  await probe.stop();
  return port;
}

describe('Lr512BridgeClient over a real WebSocket', () => {
  it('delivers frames and receives the bridge status', async () => {
    const frames: Buffer[] = [];
    const { server, port } = await miniBridge((payload) => frames.push(payload));
    const statuses: BridgeStatus[] = [];
    const client = new Lr512BridgeClient({
      url: `ws://127.0.0.1:${port}`,
      onStatus: (s) => statuses.push(s),
    });
    try {
      const universe = new Uint8Array(512);
      universe[0] = 11; // channel 1
      universe[5] = 255; // channel 6
      universe[511] = 99; // channel 512
      client.setUniverse(1, universe);
      client.start();
      await vi.waitFor(
        () => {
          expect(frames.length).toBeGreaterThan(0);
          expect(statuses.length).toBeGreaterThan(0);
        },
        { timeout: 3000 },
      );
      const frame = frames[0] as Buffer;
      expect(frame).toHaveLength(FRAME_SIZE);
      expect(frame[0]).toBe(1);
      expect(frame[1]).toBe(11);
      expect(frame[6]).toBe(255);
      expect(frame[512]).toBe(99);
      expect(statuses[0]).toEqual({ device: 'open', universes: 2, channels: [512, 0] });
      expect(client.connected).toBe(true);
    } finally {
      client.stop();
      server.close();
    }
  });

  it('connects when the bridge was not there yet at the start, and keeps trying until it is', async () => {
    const port = await freePort();
    const frames: Buffer[] = [];
    const lines: string[] = [];
    const client = new Lr512BridgeClient({
      url: `ws://127.0.0.1:${port}`,
      reconnectMinMs: 20,
      reconnectMaxMs: 80,
      log: (line) => lines.push(line),
    });
    let bridge: MiniBridge | undefined;
    try {
      client.setUniverse(0, new Uint8Array(512).fill(9));
      client.start();
      // Several attempts fail while nothing listens. This was where it gave up for good.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(client.connected).toBe(false);
      bridge = await miniBridge((payload) => frames.push(payload), port);
      await vi.waitFor(() => expect(client.connected).toBe(true), { timeout: 3000 });
      await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0), { timeout: 3000 });
      expect(frames[0]?.[1]).toBe(9);
      expect(lines.filter((line) => line.includes('cannot reach'))).toHaveLength(1);
    } finally {
      client.stop();
      await bridge?.stop();
    }
  });

  it('finds the bridge again after it went away and came back, and sends what it last had', async () => {
    const firstFrames: Buffer[] = [];
    const secondFrames: Buffer[] = [];
    const first = await miniBridge((payload) => firstFrames.push(payload));
    const { port } = first;
    const connections: boolean[] = [];
    const client = new Lr512BridgeClient({
      url: `ws://127.0.0.1:${port}`,
      reconnectMinMs: 20,
      reconnectMaxMs: 80,
      onConnection: (connected) => connections.push(connected),
    });
    let second: MiniBridge | undefined;
    try {
      client.setUniverse(0, new Uint8Array(512).fill(5));
      client.start();
      await vi.waitFor(() => expect(client.connected).toBe(true), { timeout: 3000 });

      await first.stop();
      await vi.waitFor(() => expect(client.connected).toBe(false), { timeout: 3000 });
      // The app is still starting: the first tries at the new bridge find no one.
      await new Promise((resolve) => setTimeout(resolve, 300));
      second = await miniBridge((payload) => secondFrames.push(payload), port);
      await vi.waitFor(() => expect(client.connected).toBe(true), { timeout: 3000 });
      await vi.waitFor(() => expect(secondFrames.length).toBeGreaterThan(0), { timeout: 3000 });
      expect(secondFrames[0]?.[1]).toBe(5);
      expect(connections).toEqual([true, false, true]);
    } finally {
      client.stop();
      await second?.stop();
    }
  });
});
