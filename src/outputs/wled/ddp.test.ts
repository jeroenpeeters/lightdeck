import { describe, expect, it } from 'vitest';
import { type DatagramLike, DDP_MAX_PAYLOAD, DdpSender, ddpPackets } from './ddp.js';

const pixels = (count: number) => Uint8Array.from({ length: count * 3 }, (_, i) => i % 256);

describe('ddpPackets', () => {
  it('puts a row of 300 LEDs in one packet with the push flag, and the header WLED reads', () => {
    const packets = ddpPackets(pixels(300), 0);
    expect(packets).toHaveLength(1);
    const packet = packets[0] ?? new Uint8Array(0);
    expect(packet.length).toBe(10 + 900);
    expect([...packet.subarray(0, 4)]).toEqual([0x41, 1, 0, 1]);
    const view = new DataView(packet.buffer);
    expect(view.getUint32(4)).toBe(0);
    expect(view.getUint16(8)).toBe(900);
    expect([...packet.subarray(10, 16)]).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('cuts a longer row at 1440 bytes, with the offset, and pushes only on the last', () => {
    const packets = ddpPackets(pixels(600), 3);
    expect(packets.map((packet) => packet.length - 10)).toEqual([DDP_MAX_PAYLOAD, 360]);
    expect(packets.map((packet) => packet[0])).toEqual([0x40, 0x41]);
    expect(new DataView((packets[1] ?? new Uint8Array(10)).buffer).getUint32(4)).toBe(
      DDP_MAX_PAYLOAD,
    );
    expect(packets.every((packet) => packet[1] === 4)).toBe(true);
  });

  it('counts the sequence from 1 to 15 and round', () => {
    expect([0, 1, 14, 15].map((n) => ddpPackets(pixels(1), n)[0]?.[1])).toEqual([1, 2, 15, 1]);
  });

  it('sends an empty row as one packet with nothing in it', () => {
    expect(ddpPackets(new Uint8Array(0), 0)).toHaveLength(1);
  });
});

describe('DdpSender', () => {
  const make = () => {
    const sent: { data: Uint8Array; port: number; host: string }[] = [];
    const socket: DatagramLike = {
      send: (data, port, host, done) => {
        sent.push({ data, port, host });
        done?.(null);
      },
      close: () => {},
    };
    return { sent, sender: new DdpSender({ host: '192.168.68.32', socket }) };
  };

  it('sends to the port of DDP and counts what it sent', () => {
    const { sent, sender } = make();
    sender.send(pixels(300));
    sender.send(pixels(600));
    expect(sent.map((each) => [each.host, each.port])).toEqual([
      ['192.168.68.32', 4048],
      ['192.168.68.32', 4048],
      ['192.168.68.32', 4048],
    ]);
    expect(sender.frames).toBe(2);
    expect(sender.packets).toBe(3);
    expect(sender.bytes).toBe(910 + 1450 + 370);
    // The sequence moves by frame, so the two packets of the second share a number.
    expect(sent[1]?.data[1]).toBe(sent[2]?.data[1]);
    expect(sent[0]?.data[1]).not.toBe(sent[1]?.data[1]);
  });

  it('counts a socket that fails and goes on', () => {
    const socket: DatagramLike = {
      send: (_data, _port, _host, done) => done?.(new Error('network is unreachable')),
      close: () => {},
    };
    const sender = new DdpSender({ host: 'x', socket });
    sender.send(pixels(1));
    expect(sender.errors).toBe(1);
    expect(sender.lastError).toBe('network is unreachable');
  });
});
