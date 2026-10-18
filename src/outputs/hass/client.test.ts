import { createHash } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HassClient, type HassSocketLike } from './client.js';
import type { EntityReport, HassCommand, HassStatus } from './types.js';

type Listener = (event: { data?: unknown }) => void;

class FakeSocket implements HassSocketLike {
  readyState = 0;
  /** What the client sent, parsed. */
  sent: Record<string, unknown>[] = [];
  closed = false;
  private listeners = new Map<string, Listener[]>();

  send(data: string): void {
    this.sent.push(JSON.parse(data));
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
  /** Home Assistant says something. */
  say(message: Record<string, unknown>): void {
    this.emit('message', JSON.stringify(message));
  }
  calls(): Record<string, unknown>[] {
    return this.sent.filter((message) => message.type === 'call_service');
  }
}

const TURN_ON: HassCommand = { domain: 'light', service: 'turn_on', data: { brightness: 200 } };
const TURN_OFF: HassCommand = { domain: 'light', service: 'turn_off', data: { transition: 0 } };

const lamp = (entity: string, state: string, extra: Record<string, unknown> = {}) => ({
  entity_id: entity,
  state,
  attributes: { supported_color_modes: ['rgbw'], ...extra },
});

describe('HassClient with a fake socket', () => {
  let sockets: FakeSocket[];
  let client: HassClient;
  let statuses: HassStatus[];
  let logs: string[];
  let results: { entity: string; ok: boolean; ms: number }[];

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    statuses = [];
    logs = [];
    results = [];
    client = new HassClient({
      url: 'ws://ha:8123/api/websocket',
      token: 'secret',
      entities: ['light.a', 'light.b', 'switch.fog'],
      now: () => Date.now(),
      reconnectMinMs: 500,
      reconnectMaxMs: 2000,
      refusedRetryMs: 10_000,
      connectTimeoutMs: 1000,
      pingEveryMs: 15_000,
      silentAfterMs: 40_000,
      socketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      onStatus: (s) => statuses.push(s),
      onResult: (r) => results.push(r),
      log: (m) => logs.push(m),
    });
  });

  afterEach(() => {
    client.stop();
    vi.useRealTimers();
  });

  const latest = () => sockets[sockets.length - 1] as FakeSocket;

  /** Opens the socket and logs in. */
  function login(socket: FakeSocket = latest()): void {
    socket.emit('open');
    socket.say({ type: 'auth_required', ha_version: '2026.1.0' });
    socket.say({ type: 'auth_ok' });
  }

  /** Home Assistant accepts every command it has not answered yet, until there are no new ones. */
  function answerCalls(socket: FakeSocket = latest()): void {
    const answered = new Set<unknown>();
    for (;;) {
      const open = socket.calls().filter((call) => !answered.has(call.id));
      if (open.length === 0) return;
      for (const call of open) {
        answered.add(call.id);
        socket.say({ id: call.id, type: 'result', success: true });
      }
    }
  }

  /** Answers get_states with these states. */
  function answerStates(states: unknown[], socket: FakeSocket = latest()): void {
    const request = socket.sent.filter((message) => message.type === 'get_states').at(-1);
    socket.say({ id: request?.id, type: 'result', success: true, result: states });
  }

  describe('logging in', () => {
    it('answers auth_required with the token, and is connected after auth_ok', () => {
      client.start();
      latest().emit('open');
      expect(client.status).toBe('down');
      latest().say({ type: 'auth_required' });
      expect(latest().sent[0]).toEqual({ type: 'auth', access_token: 'secret' });
      latest().say({ type: 'auth_ok' });
      expect(client.status).toBe('connected');
      expect(statuses).toEqual(['connected']);
    });

    it('asks for the states and follows state_changed after logging in, with numbered messages', () => {
      client.start();
      login();
      const [, first, second] = latest().sent;
      expect(first).toEqual({ id: 1, type: 'get_states' });
      expect(second).toEqual({ id: 2, type: 'subscribe_events', event_type: 'state_changed' });
    });

    it('does not throw or wait when Home Assistant is not there', () => {
      client.start();
      latest().emit('error');
      expect(client.status).toBe('down');
      expect(statuses).toEqual([]);
      expect(logs.filter((line) => line.includes('cannot reach'))).toHaveLength(1);
    });

    it('is refused by a wrong token, and tries again slowly and not every second', () => {
      client.start();
      latest().emit('open');
      latest().say({ type: 'auth_required' });
      latest().say({ type: 'auth_invalid', message: 'Invalid access token' });
      expect(client.status).toBe('refused');
      expect(statuses).toEqual(['refused']);
      expect(latest().closed).toBe(true);
      vi.advanceTimersByTime(9_000);
      expect(sockets).toHaveLength(1);
      vi.advanceTimersByTime(1_500);
      expect(sockets).toHaveLength(2);
      // It stays refused through the next failed login, and does not flap to down.
      latest().emit('open');
      latest().say({ type: 'auth_required' });
      latest().say({ type: 'auth_invalid' });
      expect(statuses).toEqual(['refused']);
      // A token that works takes it out of that.
      vi.advanceTimersByTime(10_000);
      login();
      expect(statuses).toEqual(['refused', 'connected']);
    });

    it('gives up an attempt that gets no login within the time, and tries again', () => {
      client.start();
      latest().emit('open'); // opened, and Home Assistant says nothing
      vi.advanceTimersByTime(1100);
      expect(latest().closed).toBe(true);
      vi.advanceTimersByTime(600);
      expect(sockets).toHaveLength(2);
    });

    it('keeps trying with a growing wait up to the maximum', () => {
      client.start();
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const before = sockets.length;
        const start = Date.now();
        latest().emit('error');
        while (sockets.length === before) vi.advanceTimersByTime(10);
        times.push(Math.round((Date.now() - start) / 100) * 100);
      }
      expect(times).toEqual([500, 1000, 2000, 2000, 2000]);
    });

    it('survives an error and a close for one socket', () => {
      client.start();
      latest().emit('error');
      latest().emit('close');
      vi.advanceTimersByTime(600);
      expect(sockets).toHaveLength(2);
    });

    it('goes back to down and reconnects when the connection closes', () => {
      client.start();
      login();
      latest().emit('close');
      expect(statuses).toEqual(['connected', 'down']);
      vi.advanceTimersByTime(600);
      expect(sockets).toHaveLength(2);
      login();
      expect(statuses).toEqual(['connected', 'down', 'connected']);
    });

    it('resolves whenConnected after the login and rejects on time', async () => {
      client.start();
      const connected = client.whenConnected(5000);
      login();
      await expect(connected).resolves.toBeUndefined();
      client.stop();
      const other = new HassClient({
        url: 'ws://x',
        token: 't',
        entities: [],
        socketFactory: () => new FakeSocket(),
      });
      const late = other.whenConnected(100);
      const caught = late.catch((error: Error) => error.message);
      vi.advanceTimersByTime(150);
      expect(await caught).toContain('could not reach Home Assistant');
    });
  });

  describe('what Home Assistant says', () => {
    it('reports the entities of the rig from get_states, and only those', () => {
      const heard: (EntityReport | undefined)[] = [];
      client.watch('light.a', (report) => heard.push(report));
      client.start();
      login();
      answerStates([
        lamp('light.a', 'on', { brightness: 120 }),
        lamp('light.other', 'on'),
        { entity_id: 'switch.fog', state: 'unavailable', attributes: {} },
      ]);
      expect(heard).toEqual([{ available: true, on: true, colourModes: ['rgbw'] }]);
      const reports = client.reports();
      expect([...reports.keys()].sort()).toEqual(['light.a', 'switch.fog']);
      expect(reports.get('light.a')).toMatchObject({ state: 'on', brightness: 120 });
      expect(reports.get('switch.fog')?.report).toEqual({
        available: false,
        on: false,
        colourModes: [],
      });
    });

    it('tells a watcher at once what is already known, and stops when it stops listening', () => {
      client.start();
      login();
      answerStates([lamp('light.a', 'off')]);
      const heard: (EntityReport | undefined)[] = [];
      const stop = client.watch('light.a', (report) => heard.push(report));
      expect(heard).toEqual([{ available: true, on: false, colourModes: ['rgbw'] }]);
      stop();
      latest().say({
        type: 'event',
        event: {
          event_type: 'state_changed',
          data: { entity_id: 'light.a', new_state: lamp('light.a', 'on') },
        },
      });
      expect(heard).toHaveLength(1);
    });

    it('follows state_changed, and ignores other entities and other events', () => {
      const heard: (EntityReport | undefined)[] = [];
      client.watch('light.a', (report) => heard.push(report));
      client.start();
      login();
      answerStates([lamp('light.a', 'off')]);
      const changed = (entity: string, state: string) =>
        latest().say({
          id: 2,
          type: 'event',
          event: {
            event_type: 'state_changed',
            data: { entity_id: entity, new_state: lamp(entity, state) },
          },
        });
      changed('light.a', 'on');
      changed('light.zzz', 'on');
      changed('light.a', 'on'); // no change, no news
      latest().say({ id: 2, type: 'event', event: { event_type: 'call_service', data: {} } });
      changed('light.a', 'unavailable');
      expect(heard.map((report) => [report?.available, report?.on])).toEqual([
        [true, false],
        [true, true],
        [false, false],
      ]);
    });

    it('says that an entity is unknown when Home Assistant removes it', () => {
      const heard: (EntityReport | undefined)[] = [];
      client.watch('light.a', (report) => heard.push(report));
      client.start();
      login();
      answerStates([lamp('light.a', 'on')]);
      latest().say({
        type: 'event',
        event: { event_type: 'state_changed', data: { entity_id: 'light.a', new_state: null } },
      });
      expect(heard.at(-1)).toBeUndefined();
      expect(client.reports().has('light.a')).toBe(false);
    });

    it('forgets what it knew when the link drops, and says so', () => {
      const heard: (EntityReport | undefined)[] = [];
      client.watch('light.a', (report) => heard.push(report));
      client.start();
      login();
      answerStates([lamp('light.a', 'on')]);
      latest().emit('close');
      expect(heard.at(-1)).toBeUndefined();
      expect(client.reports().size).toBe(0);
    });

    it('asks again for the states when an entity is watched that the rig did not name', () => {
      client.start();
      login();
      answerStates([]);
      const heard: (EntityReport | undefined)[] = [];
      client.watch('light.late', (report) => heard.push(report));
      const requests = latest().sent.filter((message) => message.type === 'get_states');
      expect(requests).toHaveLength(2);
      answerStates([lamp('light.late', 'on')]);
      expect(heard).toHaveLength(1);
    });
  });

  describe('commands', () => {
    it('sends nothing before the login, and the newest command per entity after it', () => {
      client.setEntity('light.a', TURN_ON);
      client.setEntity('light.a', TURN_OFF);
      client.start();
      expect(latest().calls()).toHaveLength(0);
      login();
      const calls = latest().calls();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        type: 'call_service',
        domain: 'light',
        service: 'turn_off',
        service_data: { entity_id: 'light.a', transition: 0 },
      });
      expect(typeof calls[0]?.id).toBe('number');
    });

    it('numbers the commands after the requests of the login', () => {
      client.start();
      login();
      client.setEntity('light.a', TURN_ON);
      client.setEntity('light.b', TURN_ON);
      expect(
        latest()
          .calls()
          .map((call) => call.id),
      ).toEqual([3, 4]);
    });

    it('holds a second command for an entity until its gap is over, and sends the newest', () => {
      client.start();
      login();
      client.setEntity('light.a', TURN_ON);
      client.setEntity('light.a', { ...TURN_ON, data: { brightness: 1 } });
      client.setEntity('light.a', { ...TURN_ON, data: { brightness: 2 } });
      expect(latest().calls()).toHaveLength(1);
      latest().say({ id: latest().calls()[0]?.id, type: 'result', success: true });
      vi.advanceTimersByTime(900);
      expect(latest().calls()).toHaveLength(1);
      vi.advanceTimersByTime(200);
      expect(latest().calls()).toHaveLength(2);
      expect(latest().calls()[1]).toMatchObject({
        service_data: { entity_id: 'light.a', brightness: 2 },
      });
    });

    it('sends an urgent command at once, past the gap of its entity', () => {
      client.start();
      login();
      client.setEntity('light.a', TURN_ON);
      client.setEntity('light.a', TURN_OFF, { urgent: true });
      expect(latest().calls()).toHaveLength(2);
    });

    it('keeps to 10 commands in a second', () => {
      const many = Array.from({ length: 14 }, (_, i) => `light.n${i}`);
      client.start();
      login();
      for (const entity of many) client.setEntity(entity, TURN_ON);
      answerCalls();
      expect(latest().calls()).toHaveLength(10);
      vi.advanceTimersByTime(1000);
      answerCalls();
      expect(latest().calls()).toHaveLength(14);
    });

    it('sends a lamp nothing new while its last command has no answer, and then the newest', () => {
      client.start();
      login();
      client.setEntity('light.a', TURN_ON);
      vi.advanceTimersByTime(3000);
      client.setEntity('light.a', { ...TURN_ON, data: { brightness: 1 } });
      client.setEntity('light.a', { ...TURN_ON, data: { brightness: 2 } });
      vi.advanceTimersByTime(3000);
      expect(latest().calls()).toHaveLength(1);
      latest().say({ id: latest().calls()[0]?.id, type: 'result', success: true });
      expect(latest().calls()).toHaveLength(2);
      expect(latest().calls()[1]).toMatchObject({ service_data: { brightness: 2 } });
    });

    it('has no more than 4 commands on the way, and one more with every answer', () => {
      const many = Array.from({ length: 8 }, (_, i) => `light.n${i}`);
      client.start();
      login();
      for (const entity of many) client.setEntity(entity, TURN_ON);
      expect(latest().calls()).toHaveLength(4);
      expect(client.unanswered).toBe(4);
      latest().say({ id: latest().calls()[0]?.id, type: 'result', success: true });
      expect(latest().calls()).toHaveLength(5);
      expect(client.unanswered).toBe(4);
    });

    it('is not held back by commands of a connection that is gone', () => {
      client.start();
      login();
      for (let i = 0; i < 4; i++) client.setEntity(`light.n${i}`, TURN_ON);
      expect(client.unanswered).toBe(4);
      latest().emit('close');
      vi.advanceTimersByTime(600);
      login();
      client.setEntity('light.a', TURN_ON);
      expect(latest().calls()).toHaveLength(1);
    });

    it('passes the refusal of a command on to who listens, and clears it with the next success', () => {
      const heard: (string | null)[] = [];
      client.problems('light.a', (problem) => heard.push(problem));
      client.start();
      login();
      client.setEntity('light.a', TURN_ON);
      const id = latest().calls()[0]?.id;
      latest().say({
        id,
        type: 'result',
        success: false,
        error: { code: 'not_found', message: 'Entity not found' },
      });
      expect(heard).toEqual(['Entity not found']);
      expect(results[0]).toMatchObject({ entity: 'light.a', ok: false });
      vi.advanceTimersByTime(1100);
      client.setEntity('light.a', TURN_OFF);
      latest().say({
        id: latest().calls()[1]?.id,
        type: 'result',
        success: true,
        result: { context: {} },
      });
      expect(heard).toEqual(['Entity not found', null]);
      expect(results[1]).toMatchObject({ entity: 'light.a', ok: true });
    });

    it('tells a problem listener that is late what is wrong now', () => {
      client.start();
      login();
      client.setEntity('light.a', TURN_ON);
      latest().say({
        id: latest().calls()[0]?.id,
        type: 'result',
        success: false,
        error: { message: 'no' },
      });
      const heard: (string | null)[] = [];
      client.problems('light.a', (problem) => heard.push(problem));
      expect(heard).toEqual(['no']);
    });

    it('counts what it sent, what was accepted, refused and lost', () => {
      client.start();
      login();
      client.setEntity('light.a', TURN_ON);
      client.setEntity('light.b', TURN_ON);
      client.setEntity('switch.fog', TURN_ON);
      const [first, second] = latest().calls();
      latest().say({ id: first?.id, type: 'result', success: true });
      latest().say({ id: second?.id, type: 'result', success: false, error: { message: 'no' } });
      latest().emit('close');
      expect(client.stats).toEqual({ sent: 3, accepted: 1, refused: 1, lost: 1, connections: 1 });
    });

    it('measures how long the answer took', () => {
      client.start();
      login();
      client.setEntity('light.a', TURN_ON);
      vi.advanceTimersByTime(120);
      latest().say({ id: latest().calls()[0]?.id, type: 'result', success: true });
      expect(results[0]?.ms).toBe(120);
    });

    it('does not send a command again after a reconnect, only what was still waiting', () => {
      client.start();
      login();
      client.setEntity('light.a', TURN_ON); // sent, never answered
      client.setEntity('light.a', TURN_OFF); // waits for the gap
      latest().emit('close');
      vi.advanceTimersByTime(600);
      login();
      // The one that waited goes out, the one that was on the way does not.
      expect(latest().calls()).toHaveLength(0);
      vi.advanceTimersByTime(500);
      const calls = latest().calls();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ service: 'turn_off' });
      vi.advanceTimersByTime(5000);
      expect(latest().calls()).toHaveLength(1);
    });

    it('does not send every lamp again after a reconnect', () => {
      client.start();
      login();
      for (const entity of ['light.a', 'light.b', 'switch.fog']) client.setEntity(entity, TURN_ON);
      expect(latest().calls()).toHaveLength(3);
      latest().emit('close');
      vi.advanceTimersByTime(600);
      login();
      vi.advanceTimersByTime(5000);
      expect(latest().calls()).toHaveLength(0);
    });

    it('holds a command while the link is down and sends it when it is back', () => {
      client.start();
      login();
      latest().emit('close');
      client.setEntity('light.b', TURN_ON);
      vi.advanceTimersByTime(600);
      expect(latest().calls()).toHaveLength(0);
      login();
      expect(latest().calls()).toHaveLength(1);
    });

    it('does not lose a command when the socket refuses to send', () => {
      client.start();
      login();
      const socket = latest();
      const send = socket.send.bind(socket);
      socket.send = () => {
        throw new Error('broken pipe');
      };
      client.setEntity('light.a', TURN_ON);
      expect(client.status).toBe('down');
      socket.send = send;
      vi.advanceTimersByTime(1100);
      login();
      expect(latest().calls()).toHaveLength(1);
    });
  });

  describe('a connection that dies without a word', () => {
    it('pings, and gives up on a connection that says nothing', () => {
      client.start();
      login();
      vi.advanceTimersByTime(15_000);
      expect(latest().sent.at(-1)).toMatchObject({ type: 'ping' });
      vi.advanceTimersByTime(25_000);
      expect(client.status).toBe('down');
      expect(logs.some((line) => line.includes('fell silent'))).toBe(true);
    });

    it('stays when Home Assistant answers the pings', () => {
      client.start();
      login();
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(15_000);
        const ping = latest()
          .sent.filter((message) => message.type === 'ping')
          .at(-1);
        latest().say({ id: ping?.id, type: 'pong' });
      }
      expect(client.status).toBe('connected');
    });
  });

  it('stops for good', () => {
    client.start();
    login();
    client.stop();
    expect(latest().closed).toBe(true);
    latest().emit('close');
    vi.advanceTimersByTime(20_000);
    expect(sockets).toHaveLength(1);
  });
});

/**
 * Home Assistant reduced to what the client needs: the handshake of RFC 6455, the login, the
 * states and the service calls, over a real socket, so that the client runs against Node's own
 * WebSocket and not against a fake that always says `close`.
 */
interface MiniHass {
  server: Server;
  port: number;
  /** The `call_service` messages that arrived. */
  calls: Record<string, unknown>[];
  stop(): Promise<void>;
}

function textFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const head =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([head, payload]);
}

function miniHass(token: string, states: unknown[], atPort = 0): Promise<MiniHass> {
  const open = new Set<Socket>();
  const calls: Record<string, unknown>[] = [];
  const server = createServer((socket: Socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const say = (message: unknown) => socket.write(textFrame(JSON.stringify(message)));
    const handle = (message: Record<string, unknown>) => {
      if (message.type === 'auth') {
        say(
          message.access_token === token
            ? { type: 'auth_ok' }
            : { type: 'auth_invalid', message: 'nope' },
        );
      } else if (message.type === 'get_states') {
        say({ id: message.id, type: 'result', success: true, result: states });
      } else if (message.type === 'call_service') {
        calls.push(message);
        say({ id: message.id, type: 'result', success: true, result: {} });
      } else if (typeof message.id === 'number') {
        say({ id: message.id, type: 'result', success: true, result: null });
      }
    };
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
        buffer = buffer.subarray(end + 4);
        upgraded = true;
        say({ type: 'auth_required', ha_version: 'test' });
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
        if (opcode === 0x1) handle(JSON.parse(payload.toString()));
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
        calls,
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
  const probe = await miniHass('x', []);
  const { port } = probe;
  await probe.stop();
  return port;
}

describe('HassClient over a real WebSocket', () => {
  it('logs in, reads the states and sends a command', async () => {
    const hass = await miniHass('secret', [lamp('light.a', 'on', { brightness: 77 })]);
    const client = new HassClient({
      url: `ws://127.0.0.1:${hass.port}/api/websocket`,
      token: 'secret',
      entities: ['light.a'],
    });
    try {
      client.setEntity('light.a', TURN_ON);
      client.start();
      await client.whenConnected(3000);
      await vi.waitFor(() => expect(hass.calls).toHaveLength(1), { timeout: 3000 });
      expect(hass.calls[0]).toMatchObject({
        domain: 'light',
        service: 'turn_on',
        service_data: { entity_id: 'light.a', brightness: 200 },
      });
      await vi.waitFor(() => expect(client.reports().get('light.a')?.brightness).toBe(77), {
        timeout: 3000,
      });
    } finally {
      client.stop();
      await hass.stop();
    }
  });

  it('is refused by a wrong token and says so', async () => {
    const hass = await miniHass('secret', []);
    const statuses: HassStatus[] = [];
    const client = new HassClient({
      url: `ws://127.0.0.1:${hass.port}/api/websocket`,
      token: 'wrong',
      entities: [],
      onStatus: (status) => statuses.push(status),
    });
    try {
      client.start();
      await vi.waitFor(() => expect(statuses).toEqual(['refused']), { timeout: 3000 });
    } finally {
      client.stop();
      await hass.stop();
    }
  });

  it('connects when Home Assistant was not there yet at the start, and keeps trying until it is', async () => {
    const port = await freePort();
    const lines: string[] = [];
    const client = new HassClient({
      url: `ws://127.0.0.1:${port}/api/websocket`,
      token: 'secret',
      entities: ['light.a'],
      reconnectMinMs: 20,
      reconnectMaxMs: 80,
      log: (line) => lines.push(line),
    });
    let hass: MiniHass | undefined;
    try {
      client.setEntity('light.a', TURN_OFF);
      client.start();
      // Several attempts fail while nothing listens. This is where a client that waited for
      // `close` gave up for good.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(client.connected).toBe(false);
      hass = await miniHass('secret', [lamp('light.a', 'off')], port);
      await client.whenConnected(3000);
      await vi.waitFor(() => expect(hass?.calls).toHaveLength(1), { timeout: 3000 });
      expect(lines.filter((line) => line.includes('cannot reach'))).toHaveLength(1);
    } finally {
      client.stop();
      await hass?.stop();
    }
  });

  it('finds Home Assistant again after a restart and sends what waited meanwhile', async () => {
    const first = await miniHass('secret', []);
    const { port } = first;
    const statuses: HassStatus[] = [];
    const client = new HassClient({
      url: `ws://127.0.0.1:${port}/api/websocket`,
      token: 'secret',
      entities: ['light.a'],
      reconnectMinMs: 20,
      reconnectMaxMs: 80,
      onStatus: (status) => statuses.push(status),
    });
    let second: MiniHass | undefined;
    try {
      client.start();
      await client.whenConnected(3000);
      await first.stop();
      await vi.waitFor(() => expect(client.connected).toBe(false), { timeout: 3000 });
      client.setEntity('light.a', TURN_ON);
      await new Promise((resolve) => setTimeout(resolve, 200));
      second = await miniHass('secret', [], port);
      await vi.waitFor(() => expect(second?.calls).toHaveLength(1), { timeout: 3000 });
      expect(statuses).toEqual(['connected', 'down', 'connected']);
    } finally {
      client.stop();
      await second?.stop();
    }
  });
});
