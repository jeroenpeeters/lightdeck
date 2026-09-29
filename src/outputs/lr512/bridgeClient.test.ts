import { createHash } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
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
  closed = false;
  private listeners = new Map<string, Listener[]>();

  send(data: Uint8Array): void {
    this.sent.push(data.slice());
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

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    statuses = [];
    client = new Lr512BridgeClient({
      url: 'ws://bridge:9010',
      fps: 40,
      maxBufferedFrames: 2,
      reconnectMinMs: 500,
      reconnectMaxMs: 2000,
      socketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      onStatus: (s) => statuses.push(s),
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
    vi.advanceTimersByTime(25);
    expect(latest().sent).toHaveLength(1);
    const frame = latest().sent[0] as Uint8Array;
    expect(frame).toHaveLength(FRAME_SIZE);
    expect(frame[0]).toBe(1);
    expect(frame[1]).toBe(7);
    expect(frame[512]).toBe(7);
  });

  it('sends nothing when nothing changed', () => {
    client.start();
    latest().emit('open');
    client.setUniverse(0, universeOf(1));
    vi.advanceTimersByTime(1000);
    expect(latest().sent).toHaveLength(1);
  });

  it('coalesces a burst into the most recent frame', () => {
    client.start();
    latest().emit('open');
    for (let v = 1; v <= 100; v++) client.setUniverse(0, universeOf(v));
    vi.advanceTimersByTime(25);
    expect(latest().sent).toHaveLength(1);
    expect((latest().sent[0] as Uint8Array)[1]).toBe(100);
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
    vi.advanceTimersByTime(25);
    expect(latest().sent).toHaveLength(1);
    expect((latest().sent[0] as Uint8Array)[1]).toBe(2);
  });

  it('keeps universes apart', () => {
    client.start();
    latest().emit('open');
    client.setUniverse(0, universeOf(10));
    client.setUniverse(1, universeOf(20));
    vi.advanceTimersByTime(25);
    const frames = latest().sent.map((f) => [f[0], f[1]]);
    expect(frames).toEqual([
      [0, 10],
      [1, 20],
    ]);
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
    vi.advanceTimersByTime(25);
    expect(latest().sent).toHaveLength(1);
    expect((latest().sent[0] as Uint8Array)[1]).toBe(42);
    expect(client.stats.connections).toBe(2);
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
function miniBridge(onFrame: (payload: Buffer) => void): Promise<{ server: Server; port: number }> {
  const server = createServer((socket: Socket) => {
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
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 });
    });
  });
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
});
