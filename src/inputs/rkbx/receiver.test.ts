import { createSocket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeOsc, type OscMessage } from './osc.js';
import { OscReceiver } from './receiver.js';

const receivers: OscReceiver[] = [];
afterEach(() => {
  for (const receiver of receivers.splice(0)) receiver.stop();
});

async function started(now?: () => number): Promise<OscReceiver> {
  const receiver = new OscReceiver({ port: 0, host: '127.0.0.1', ...(now ? { now } : {}) });
  receivers.push(receiver);
  await receiver.start();
  return receiver;
}

function send(port: number, packet: Buffer): Promise<void> {
  const socket = createSocket('udp4');
  return new Promise((resolve, reject) => {
    socket.send(packet, port, '127.0.0.1', (error) => {
      socket.close();
      if (error) reject(error);
      else resolve();
    });
  });
}

const next = <T>(receiver: OscReceiver, event: string): Promise<T[]> =>
  new Promise((resolve) => receiver.once(event, (...args: T[]) => resolve(args)));

describe('OscReceiver', () => {
  it('hands over a message with the moment it arrived', async () => {
    const receiver = await started(() => 1234);
    const got = next<OscMessage | number>(receiver, 'message');
    await send(receiver.port as number, encodeOsc({ address: '/master/bpm/current', args: [126] }));
    expect(await got).toEqual([{ address: '/master/bpm/current', args: [126] }, 1234]);
  });

  it('reports a datagram that is not OSC and goes on', async () => {
    const receiver = await started();
    const bad = next<Error | string>(receiver, 'malformed');
    await send(receiver.port as number, Buffer.from('not osc at all'));
    const [error, from] = await bad;
    expect(error).toBeInstanceOf(Error);
    expect(from).toBe('127.0.0.1');

    const good = next<OscMessage>(receiver, 'message');
    await send(receiver.port as number, encodeOsc({ address: '/ok', args: [] }));
    expect((await good)[0]?.address).toBe('/ok');
  });

  it('has no port before it is bound or after it has stopped, and does not throw asking', async () => {
    const receiver = new OscReceiver({ port: 0, host: '127.0.0.1' });
    expect(receiver.port).toBeUndefined();
    const starting = receiver.start();
    expect(receiver.port).toBeUndefined(); // bound a moment later
    await starting;
    expect(receiver.port).toBeGreaterThan(0);
    receiver.stop();
    expect(receiver.port).toBeUndefined();
  });

  it('rejects start when the port is taken, so two listeners do not split the packets', async () => {
    const first = await started();
    const second = new OscReceiver({ port: first.port as number, host: '127.0.0.1' });
    await expect(second.start()).rejects.toThrow();
    expect(second.port).toBeUndefined();
  });
});
