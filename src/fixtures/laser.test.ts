import { describe, expect, it } from 'vitest';
import { ALIEN_LASER_10CH, LASER_GATE, LASER_PATTERNS } from './laser.js';
import {
  activeRanges,
  byteForStep,
  byteInRange,
  defineProfile,
  encodeFixture,
  type FixtureProfile,
  type FunctionControl,
  findControl,
  findRange,
  rangeAt,
  stepOfByte,
  UNIVERSE_SIZE,
  writeFixture,
} from './profile.js';

const profile = ALIEN_LASER_10CH;

function control(name: string): FunctionControl {
  const found = findControl(profile, name);
  if (found?.kind !== 'function') throw new Error(`no function control "${name}"`);
  return found;
}

function range(name: string, key: string) {
  const found = findRange(control(name), key);
  if (!found) throw new Error(`no range "${key}" on "${name}"`);
  return found;
}

/** The byte that puts the mode channel in a mode. */
const mode = (key: string) => byteInRange(control('mode'), range('mode', key));

describe('ALIEN_LASER_10CH layout', () => {
  it('covers every one of the 10 channels exactly once', () => {
    expect(profile.footprint).toBe(10);
    expect(profile.controls.map((c) => c.channel)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('matches the manual channel by channel', () => {
    const at = (name: string) => findControl(profile, name)?.channel;
    expect(at('mode')).toBe(1);
    expect(at('program')).toBe(2);
    expect(at('rotation')).toBe(3);
    expect(at('flipH')).toBe(4);
    expect(at('flipV')).toBe(5);
    expect(at('moveH')).toBe(6);
    expect(at('moveV')).toBe(7);
    expect(at('size')).toBe(8);
    expect(at('colour')).toBe(9);
    expect(at('drawing')).toBe(10);
  });

  it('has the byte ranges the manual prints', () => {
    const spans = (name: string) =>
      control(name)
        .ranges.filter((r) => !r.when)
        .map((r) => [r.key, r.from, r.to]);
    expect(spans('mode')).toEqual([
      ['off', 0, 63],
      ['manual', 64, 127],
      ['auto', 128, 191],
      ['sound', 192, 255],
    ]);
    expect(spans('rotation')).toEqual([
      ['angle', 0, 127],
      ['forward', 128, 191],
      ['reverse', 192, 255],
    ]);
    for (const name of ['flipH', 'flipV', 'moveH', 'moveV']) {
      expect(spans(name)).toEqual([
        ['position', 0, 127],
        ['speed', 128, 255],
      ]);
    }
    expect(spans('size')).toEqual([
      ['fixed', 0, 63],
      ['grow', 64, 127],
      ['shrink', 128, 191],
      ['zoom', 192, 255],
    ]);
    expect(spans('colour')).toEqual([
      ['single', 0, 63],
      ['mix', 64, 127],
      ['singleAuto', 128, 191],
      ['auto', 192, 255],
    ]);
    expect(spans('drawing')).toEqual([
      ['lines', 0, 127],
      ['dots', 128, 255],
    ]);
  });

  it('leaves no byte of any channel without a meaning', () => {
    for (const c of profile.controls) {
      if (c.kind !== 'function') throw new Error(`${c.name} is not a function control`);
      const free = c.ranges.filter((r) => !r.when);
      const ranges = free.length > 0 ? free : c.ranges.filter((r) => r.when?.key === 'auto');
      const covered = new Set<number>();
      for (const r of ranges) for (let b = r.from; b <= r.to; b++) covered.add(b);
      expect(covered.size, c.name).toBe(256);
    }
  });

  it('is closed at rest: the laser stays dark until a mode is chosen', () => {
    const bytes = encodeFixture(profile);
    expect([...bytes]).toEqual(new Array(10).fill(0));
    expect(rangeAt(profile, control(LASER_GATE))?.key).toBe('off');
  });

  it('takes raw bytes only, a level is refused', () => {
    expect(() => encodeFixture(profile, { levels: { mode: 1 } })).toThrow(/function channel/);
    expect(() => encodeFixture(profile, { raw: { mode: 256 } })).toThrow(RangeError);
    expect(() => encodeFixture(profile, { raw: { zoom: 1 } })).toThrow(/unknown control/);
  });

  it('lands in the universe at its start address', () => {
    const universe = new Uint8Array(UNIVERSE_SIZE);
    writeFixture(universe, 44, profile, { raw: { mode: 100, colour: 70 } });
    expect(universe[43]).toBe(100);
    expect(universe[51]).toBe(70);
    expect(universe[42]).toBe(0);
    expect(() => writeFixture(universe, 504, profile)).toThrow(RangeError);
    expect(() => writeFixture(universe, 503, profile)).not.toThrow();
  });
});

describe('channel 2 follows the mode', () => {
  const keys = (raw: Record<string, number>) =>
    activeRanges(profile, control('program'), raw).map((r) => r.key);

  it('offers nothing while the laser is closed', () => {
    expect(keys({})).toEqual([]);
    expect(rangeAt(profile, control('program'), { mode: 0 })).toBeUndefined();
  });

  it('chooses one of 51 patterns in manual mode', () => {
    expect(keys({ mode: mode('manual') })).toEqual(['pattern']);
    expect(range('program', 'pattern').steps).toBe(LASER_PATTERNS);
  });

  it('chooses one of four programs in auto and in sound mode', () => {
    expect(keys({ mode: mode('auto') })).toEqual(['auto1', 'auto2', 'auto3', 'auto4']);
    expect(keys({ mode: mode('sound') })).toEqual(['sound1', 'sound2', 'sound3', 'sound4']);
    expect(rangeAt(profile, control('program'), { mode: mode('auto'), program: 130 })?.key).toBe(
      'auto3',
    );
    expect(rangeAt(profile, control('program'), { mode: mode('sound'), program: 255 })?.key).toBe(
      'sound4',
    );
    expect(range('program', 'sound2')).toEqual(
      expect.objectContaining({ from: 64, to: 127, meaning: 'Sound mode 2' }),
    );
  });
});

describe('bytes for ranges', () => {
  it('keeps a plain choice away from the edges of its range', () => {
    expect(mode('off')).toBe(0);
    expect(mode('manual')).toBe(95);
    expect(mode('auto')).toBe(159);
    expect(mode('sound')).toBe(223);
    expect(byteInRange(control('drawing'), range('drawing', 'dots'))).toBe(191);
  });

  it('runs through a range that sets something', () => {
    const forward = range('rotation', 'forward');
    expect(byteInRange(control('rotation'), forward, 0)).toBe(128);
    expect(byteInRange(control('rotation'), forward, 0.5)).toBe(160);
    expect(byteInRange(control('rotation'), forward, 1)).toBe(191);
    expect(byteInRange(control('rotation'), forward, 4)).toBe(191);
    expect(byteInRange(control('rotation'), forward)).toBe(128);
  });

  it('gives each of the 51 patterns five bytes and sends the middle one', () => {
    const pattern = range('program', 'pattern');
    expect(byteForStep(pattern, 1)).toBe(2);
    expect(byteForStep(pattern, 2)).toBe(7);
    expect(byteForStep(pattern, 51)).toBe(252);
    expect(() => byteForStep(pattern, 0)).toThrow(RangeError);
    expect(() => byteForStep(pattern, 52)).toThrow(RangeError);
    expect(() => byteForStep(pattern, 1.5)).toThrow(RangeError);
    for (let step = 1; step <= LASER_PATTERNS; step++) {
      expect(stepOfByte(pattern, byteForStep(pattern, step))).toBe(step);
    }
    expect(stepOfByte(pattern, 0)).toBe(1);
    expect(stepOfByte(pattern, 4)).toBe(1);
    expect(stepOfByte(pattern, 5)).toBe(2);
    expect(stepOfByte(pattern, 255)).toBe(51);
    expect(byteInRange(control('program'), pattern, 0)).toBe(2);
    expect(byteInRange(control('program'), pattern, 1)).toBe(252);
  });
});

describe('defineProfile checks ranges', () => {
  const withRanges = (ranges: FunctionControl['ranges'], more: FunctionControl[] = []) =>
    defineProfile({
      id: 'test',
      name: 'test',
      footprint: 2,
      controls: [{ kind: 'function', name: 'a', channel: 1, label: 'a', idle: 0, ranges }, ...more],
    } satisfies FixtureProfile);

  it('refuses ranges outside a byte or the wrong way round', () => {
    expect(() => withRanges([{ from: 0, to: 256, meaning: 'x' }])).toThrow(RangeError);
    expect(() => withRanges([{ from: 10, to: 5, meaning: 'x' }])).toThrow(RangeError);
    expect(() => withRanges([{ from: -1, to: 5, meaning: 'x' }])).toThrow(RangeError);
  });

  it('refuses the same key twice on one control', () => {
    expect(() =>
      withRanges([
        { from: 0, to: 10, meaning: 'x', key: 'one' },
        { from: 11, to: 20, meaning: 'y', key: 'one' },
      ]),
    ).toThrow(/two ranges/);
  });

  it('refuses more steps than the range has bytes', () => {
    expect(() => withRanges([{ from: 0, to: 9, meaning: 'x', steps: 11 }])).toThrow(RangeError);
    expect(() => withRanges([{ from: 0, to: 9, meaning: 'x', steps: 10 }])).not.toThrow();
  });

  it('refuses a range that depends on something that is not there', () => {
    const b = (ranges: FunctionControl['ranges']): FunctionControl => ({
      kind: 'function',
      name: 'b',
      channel: 2,
      label: 'b',
      idle: 0,
      ranges,
    });
    const onB = { from: 0, to: 255, meaning: 'x', when: { control: 'b', key: 'on' } };
    expect(() => withRanges([onB])).toThrow(/not there/);
    expect(() => withRanges([onB], [b([{ from: 0, to: 255, meaning: 'y', key: 'off' }])])).toThrow(
      /not there/,
    );
    expect(() =>
      withRanges([onB], [b([{ from: 0, to: 255, meaning: 'y', key: 'on' }])]),
    ).not.toThrow();
    expect(() =>
      withRanges(
        [{ ...onB, key: 'self' }],
        [b([{ from: 0, to: 255, meaning: 'y', key: 'on', when: { control: 'a', key: 'self' } }])],
      ),
    ).toThrow(/depends on something itself/);
  });
});
