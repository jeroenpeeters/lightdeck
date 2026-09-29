import { describe, expect, it } from 'vitest';
import {
  defineProfile,
  encodeFixture,
  type FixtureProfile,
  findControl,
  levelsFromLook,
  UNIVERSE_SIZE,
  writeFixture,
} from './profile.js';
import { SPIDER_43CH } from './spider.js';

/** 1-based channel lookup, the way the manual counts. */
const ch = (bytes: Uint8Array, channel: number) => bytes[channel - 1];

describe('SPIDER_43CH layout', () => {
  it('covers every one of the 43 channels exactly once', () => {
    const covered = new Set<number>();
    for (const c of SPIDER_43CH.controls) {
      covered.add(c.channel);
      if (c.kind === 'level' && c.fineChannel !== undefined) covered.add(c.fineChannel);
    }
    expect(SPIDER_43CH.footprint).toBe(43);
    expect([...covered].sort((a, b) => a - b)).toEqual(Array.from({ length: 43 }, (_, i) => i + 1));
  });

  it('matches the manual channel by channel', () => {
    const at = (name: string) => findControl(SPIDER_43CH, name)?.channel;
    expect(at('tilt1')).toBe(1);
    expect(at('tilt2')).toBe(3);
    expect(at('motorSpeed')).toBe(5);
    expect(at('dimmer')).toBe(6);
    // First, a middle and the last LED, as printed in the table.
    expect([at('red1'), at('green1'), at('blue1'), at('white1')]).toEqual([7, 8, 9, 10]);
    expect([at('red2'), at('green2'), at('blue2'), at('white2')]).toEqual([11, 12, 13, 14]);
    expect([at('red5'), at('green5'), at('blue5'), at('white5')]).toEqual([23, 24, 25, 26]);
    expect([at('red8'), at('green8'), at('blue8'), at('white8')]).toEqual([35, 36, 37, 38]);
    expect(at('strobe')).toBe(39);
    expect(at('function')).toBe(40);
    expect(at('autoMode')).toBe(41);
    expect(at('effectSpeed')).toBe(42);
    expect(at('reset')).toBe(43);
  });

  it('puts the fine-tuning channels right after the motors', () => {
    const tilt1 = findControl(SPIDER_43CH, 'tilt1');
    const tilt2 = findControl(SPIDER_43CH, 'tilt2');
    expect(tilt1?.kind === 'level' && tilt1.fineChannel).toBe(2);
    expect(tilt2?.kind === 'level' && tilt2.fineChannel).toBe(4);
  });
});

describe('encodeFixture', () => {
  it('is all zero without values, so the function channels stay in manual control', () => {
    const bytes = encodeFixture(SPIDER_43CH);
    expect(bytes).toHaveLength(43);
    expect([...bytes].every((b) => b === 0)).toBe(true);
  });

  it('drives one colour of one LED without touching its neighbours', () => {
    const bytes = encodeFixture(SPIDER_43CH, { levels: { dimmer: 1, red1: 1 } });
    expect(ch(bytes, 6)).toBe(255);
    expect(ch(bytes, 7)).toBe(255);
    const others = [...bytes].filter((_, i) => i !== 5 && i !== 6);
    expect(others.every((b) => b === 0)).toBe(true);
  });

  it('scales levels to bytes and clamps out-of-range input', () => {
    const bytes = encodeFixture(SPIDER_43CH, {
      levels: { green3: 0.5, blue3: 2, white3: -1 },
    });
    expect(ch(bytes, 16)).toBe(128);
    expect(ch(bytes, 17)).toBe(255);
    expect(ch(bytes, 18)).toBe(0);
  });

  it('splits tilt into coarse and fine bytes', () => {
    const half = encodeFixture(SPIDER_43CH, { levels: { tilt1: 0.5 } });
    // 0.5 * 65535 rounds to 32768 = 0x8000
    expect([ch(half, 1), ch(half, 2)]).toEqual([0x80, 0x00]);
    const full = encodeFixture(SPIDER_43CH, { levels: { tilt2: 1 } });
    expect([ch(full, 3), ch(full, 4)]).toEqual([0xff, 0xff]);
  });

  it('maps strobe onto 1..250 and keeps 0 as no strobe', () => {
    expect(ch(encodeFixture(SPIDER_43CH, { levels: { strobe: 0 } }), 39)).toBe(0);
    expect(ch(encodeFixture(SPIDER_43CH, { levels: { strobe: 0.001 } }), 39)).toBe(1);
    expect(ch(encodeFixture(SPIDER_43CH, { levels: { strobe: 1 } }), 39)).toBe(250);
  });

  it('only changes a function channel through a raw value', () => {
    expect(() => encodeFixture(SPIDER_43CH, { levels: { reset: 1 } })).toThrow(/function channel/);
    const bytes = encodeFixture(SPIDER_43CH, { raw: { function: 5 } });
    expect(ch(bytes, 40)).toBe(5);
    expect(ch(bytes, 43)).toBe(0);
  });

  it('lets a raw value override a level, 16-bit for tilt', () => {
    const bytes = encodeFixture(SPIDER_43CH, {
      levels: { red1: 1, tilt1: 0 },
      raw: { red1: 10, tilt1: 0x1234 },
    });
    expect(ch(bytes, 7)).toBe(10);
    expect([ch(bytes, 1), ch(bytes, 2)]).toEqual([0x12, 0x34]);
  });

  it('rejects unknown names and impossible raw values', () => {
    expect(() => encodeFixture(SPIDER_43CH, { levels: { red9: 1 } })).toThrow(/unknown control/);
    expect(() => encodeFixture(SPIDER_43CH, { raw: { nope: 1 } })).toThrow(/unknown control/);
    expect(() => encodeFixture(SPIDER_43CH, { raw: { dimmer: 256 } })).toThrow(RangeError);
    expect(() => encodeFixture(SPIDER_43CH, { raw: { dimmer: 1.5 } })).toThrow(RangeError);
  });
});

describe('writeFixture', () => {
  it('places the fixture at its start address and leaves the rest alone', () => {
    const universe = new Uint8Array(UNIVERSE_SIZE).fill(9);
    writeFixture(universe, 101, SPIDER_43CH, { levels: { dimmer: 1, white8: 1 } });
    expect(universe[99]).toBe(9); // channel 100, before the fixture
    expect(universe[100 + 5]).toBe(255); // dimmer: fixture channel 6 -> DMX 106
    expect(universe[100 + 37]).toBe(255); // white8: fixture channel 38 -> DMX 138
    expect(universe[100 + 42]).toBe(0); // reset: fixture channel 43 -> DMX 143
    expect(universe[100 + 43]).toBe(9); // channel 144, after the fixture
  });

  it('refuses an address where the fixture does not fit', () => {
    const universe = new Uint8Array(UNIVERSE_SIZE);
    expect(() => writeFixture(universe, 470, SPIDER_43CH)).not.toThrow(); // 470..512
    expect(() => writeFixture(universe, 471, SPIDER_43CH)).toThrow(RangeError);
    expect(() => writeFixture(universe, 0, SPIDER_43CH)).toThrow(RangeError);
    expect(() => writeFixture(new Uint8Array(100), 1, SPIDER_43CH)).toThrow(RangeError);
  });
});

describe('levelsFromLook', () => {
  it('applies one look to all eight LEDs and both motors', () => {
    const levels = levelsFromLook(SPIDER_43CH, { dimmer: 0.8, red: 1, tilt: 0.25, strobe: 0.5 });
    expect(levels.dimmer).toBe(0.8);
    expect(levels.tilt1).toBe(0.25);
    expect(levels.tilt2).toBe(0.25);
    expect(levels.strobe).toBe(0.5);
    for (let cell = 1; cell <= 8; cell++) expect(levels[`red${cell}`]).toBe(1);
    expect(levels.green1).toBeUndefined();
    expect(levels.motorSpeed).toBeUndefined();
  });

  it('lets a cell override the fixture look', () => {
    const levels = levelsFromLook(SPIDER_43CH, { red: 1, blue: 0 }, [
      undefined,
      { red: 0, blue: 1 },
    ]);
    expect([levels.red1, levels.blue1]).toEqual([1, 0]);
    expect([levels.red2, levels.blue2]).toEqual([0, 1]);
    expect([levels.red3, levels.blue3]).toEqual([1, 0]);
  });

  it('round-trips through the encoder', () => {
    const bytes = encodeFixture(SPIDER_43CH, {
      levels: levelsFromLook(SPIDER_43CH, { dimmer: 1, white: 1 }),
    });
    expect(ch(bytes, 6)).toBe(255);
    for (let cell = 0; cell < 8; cell++) expect(ch(bytes, 10 + cell * 4)).toBe(255);
    expect(ch(bytes, 7)).toBe(0);
  });
});

describe('defineProfile', () => {
  const base: FixtureProfile = {
    id: 'test',
    name: 'test',
    footprint: 2,
    controls: [{ kind: 'level', name: 'a', channel: 1, label: 'a' }],
  };

  it('rejects two controls on one channel', () => {
    expect(() =>
      defineProfile({
        ...base,
        controls: [...base.controls, { kind: 'level', name: 'b', channel: 1, label: 'b' }],
      }),
    ).toThrow(/used by both/);
  });

  it('rejects a channel outside the footprint and duplicate names', () => {
    expect(() =>
      defineProfile({
        ...base,
        controls: [{ kind: 'level', name: 'a', channel: 3, label: 'a' }],
      }),
    ).toThrow(RangeError);
    expect(() =>
      defineProfile({
        ...base,
        controls: [...base.controls, { kind: 'level', name: 'a', channel: 2, label: 'a' }],
      }),
    ).toThrow(/duplicate/);
  });
});
