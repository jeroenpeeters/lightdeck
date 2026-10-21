import { describe, expect, it } from 'vitest';
import { encodeOsc, OscError, parseOsc } from './osc.js';

/** An OSC message written by hand, byte for byte, so the parser is not only tested against its own encoder. */
function handwritten(): Buffer {
  return Buffer.concat([
    Buffer.from('/master/bpm/current\0', 'latin1'), // 19 characters and the zero: already 20 bytes
    Buffer.from(',f\0\0', 'latin1'),
    Buffer.from([0x42, 0xfc, 0x00, 0x00]), // 126.0
  ]);
}

describe('parseOsc', () => {
  it('reads a message that was written by hand', () => {
    expect(parseOsc(handwritten())).toEqual([{ address: '/master/bpm/current', args: [126] }]);
  });

  it('round-trips the argument types', () => {
    const blob = new Uint8Array([1, 2, 3]);
    const [message] = parseOsc(
      encodeOsc({
        address: '/x/y',
        args: [0.5, { int: -7 }, 'title', true, false, null, blob],
      }),
    );
    expect(message?.address).toBe('/x/y');
    expect(message?.args).toEqual([0.5, -7, 'title', true, false, null, blob]);
  });

  it('pads strings to a multiple of four, also when the length is already one', () => {
    for (const title of ['', 'a', 'abc', 'abcd', 'abcde']) {
      const [message] = parseOsc(encodeOsc({ address: '/t', args: [title, { int: 9 }] }));
      expect(message?.args).toEqual([title, 9]);
    }
  });

  it('reads a message without arguments, with or without type tags', () => {
    expect(parseOsc(encodeOsc({ address: '/ping', args: [] }))).toEqual([
      { address: '/ping', args: [] },
    ]);
    expect(parseOsc(Buffer.from('/ping\0\0\0', 'latin1'))).toEqual([
      { address: '/ping', args: [] },
    ]);
  });

  it('flattens a bundle, nested ones included', () => {
    const element = (message: Buffer): Buffer => {
      const size = Buffer.alloc(4);
      size.writeInt32BE(message.length);
      return Buffer.concat([size, message]);
    };
    const head = Buffer.concat([Buffer.from('#bundle\0', 'latin1'), Buffer.alloc(8)]);
    const inner = Buffer.concat([head, element(encodeOsc({ address: '/b', args: [2] }))]);
    const bundle = Buffer.concat([
      head,
      element(encodeOsc({ address: '/a', args: [1] })),
      element(inner),
    ]);
    expect(parseOsc(bundle)).toEqual([
      { address: '/a', args: [1] },
      { address: '/b', args: [2] },
    ]);
  });

  it('refuses what is not OSC or is cut short, with an OscError', () => {
    const whole = encodeOsc({ address: '/master/bpm/current', args: [126] });
    expect(() => parseOsc(Buffer.from('hello'))).toThrow(OscError);
    expect(() => parseOsc(Buffer.from('no slash\0\0\0\0', 'latin1'))).toThrow(OscError);
    expect(() => parseOsc(whole.subarray(0, whole.length - 2))).toThrow(OscError);
    expect(() => parseOsc(Buffer.from('/a\0\0,q\0\0', 'latin1'))).toThrow(OscError);
    expect(() => parseOsc(Buffer.alloc(0))).toThrow(OscError);
    // A blob that says it is larger than the packet.
    const blob = Buffer.concat([Buffer.from('/a\0\0,b\0\0', 'latin1'), Buffer.from([0, 0, 1, 0])]);
    expect(() => parseOsc(blob)).toThrow(OscError);
  });
});
