import { describe, expect, it } from 'vitest';
import { ALIEN_LASER_10CH } from '../fixtures/laser.js';
import { encodeFixture } from '../fixtures/profile.js';
import {
  baseBytes,
  byteLabel,
  checkName,
  functionControl,
  PILOT_SHAPES,
  PlanError,
  patternByte,
  pilot,
  sweep,
  sweepBytes,
} from './plan.js';

describe('baseBytes', () => {
  it('is manual mode, with the pattern if one is asked for', () => {
    const base = baseBytes({}, 26);
    expect(base.mode).toBe(95);
    expect(base.program).toBe(patternByte(26));
  });

  it('lets a byte the operator named win', () => {
    expect(baseBytes({ program: 7, mode: 130 }, 26)).toMatchObject({ program: 7, mode: 130 });
  });
});

describe('patternByte', () => {
  it('puts the 51 patterns in order on channel 2', () => {
    const bytes = Array.from({ length: 51 }, (_, i) => patternByte(i + 1));
    expect([...bytes].sort((a, b) => a - b)).toEqual(bytes);
    expect(new Set(bytes).size).toBe(51);
    expect(() => patternByte(0)).toThrow(PlanError);
    expect(() => patternByte(52)).toThrow(PlanError);
  });
});

describe('sweepBytes', () => {
  it('has every step, the last byte and the edges of the ranges', () => {
    const bytes = sweepBytes(functionControl('rotation'), { step: 100 });
    expect(bytes).toEqual([0, 100, 127, 128, 191, 192, 200, 255]);
  });

  it('can be cut to a part, and rejects nonsense', () => {
    expect(sweepBytes(functionControl('size'), { step: 1, from: 10, to: 12 })).toEqual([
      10, 11, 12,
    ]);
    expect(() => sweepBytes(functionControl('size'), { step: 0 })).toThrow(PlanError);
    expect(() => sweepBytes(functionControl('size'), { from: 9, to: 3 })).toThrow(PlanError);
    expect(() => sweepBytes(functionControl('size'), { to: 256 })).toThrow(PlanError);
  });
});

describe('sweep', () => {
  it('holds the rest and varies one channel', () => {
    const shots = sweep(baseBytes({ moveH: 64 }, 3), 'size', { step: 64 });
    expect(shots.map((s) => s.name)).toEqual(
      ['b000', 'b063', 'b064', 'b127', 'b128', 'b191', 'b192', 'b255'].map(
        (b) => `sweep-size/${b}`,
      ),
    );
    for (const shot of shots) {
      expect(shot.raw).toMatchObject({ mode: 95, moveH: 64, program: patternByte(3) });
    }
    expect(shots.map((s) => s.raw.size)).toEqual([0, 63, 64, 127, 128, 191, 192, 255]);
  });

  it('sweeps all 256 bytes of the pattern channel with step 1', () => {
    expect(sweep(baseBytes({}), 'program', { step: 1 })).toHaveLength(256);
  });

  it('never sweeps the mode, and knows the channels', () => {
    expect(() => sweep(baseBytes({}), 'mode')).toThrow(/manual/);
    expect(() => sweep(baseBytes({}), 'nope')).toThrow(PlanError);
  });
});

describe('pilot', () => {
  const shots = pilot(baseBytes({}, 26), 26);

  it('has the shapes, the series and one clip', () => {
    expect(shots.filter((s) => s.name.startsWith('pilot/shape-'))).toHaveLength(
      PILOT_SHAPES.length,
    );
    expect(shots.filter((s) => s.seconds !== undefined)).toHaveLength(1);
    expect(shots).toHaveLength(3 + 14 + 1);
  });

  it('has unique names in the folder of the pilot, all of them valid file names', () => {
    const names = shots.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(checkName(name)).toBe(name);
  });

  it('encodes every shot to a laser in manual mode', () => {
    for (const shot of shots) {
      expect(encodeFixture(ALIEN_LASER_10CH, { raw: shot.raw })[0]).toBe(95);
    }
  });

  it('varies one channel at a time in the series', () => {
    const rotation = shots.filter((s) => s.name.startsWith('pilot/rotation-'));
    expect(rotation.map((s) => s.raw.rotation)).toEqual([0, 32, 64, 96, 127]);
    expect(new Set(rotation.map((s) => s.raw.program)).size).toBe(1);
  });
});

describe('names', () => {
  it('refuses a way out of the folder', () => {
    for (const bad of ['../x', '/x', 'a/../b', 'a b', 'x.jpg', 'a//b', '']) {
      expect(() => checkName(bad)).toThrow(PlanError);
    }
    expect(checkName('shots/aim-1')).toBe('shots/aim-1');
    expect(byteLabel(7)).toBe('b007');
  });
});
