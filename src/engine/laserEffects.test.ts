import { describe, expect, it } from 'vitest';
import { ALIEN_LASER_10CH, LASER_GATE, LASER_PATTERNS } from '../fixtures/laser.js';
import {
  type ByteRange,
  type FunctionControl,
  findControl,
  findRange,
  rangeAt,
  stepOfByte,
} from '../fixtures/profile.js';
import { limitSpeed, MAX_FLASH_HZ } from './effects.js';
import {
  findLaserEffect,
  LASER_EFFECTS,
  LASER_EFFECTS_MODE,
  type LaserEffectContext,
} from './laserEffects.js';

const MANUAL = 95;

function render(id: string, beat: number, extra: Partial<LaserEffectContext> = {}) {
  const effect = findLaserEffect(id);
  if (!effect) throw new Error(`no effect ${id}`);
  return effect.render({ beat, bpm: 126, raw: { mode: MANUAL }, ...extra });
}

function control(name: string): FunctionControl {
  const found = findControl(ALIEN_LASER_10CH, name);
  if (found?.kind !== 'function') throw new Error(`no control ${name}`);
  return found;
}

/** Key of the range a byte of a control lies in, with the laser in manual mode. */
const keyOf = (name: string, byte: number) =>
  rangeAt(ALIEN_LASER_10CH, control(name), { mode: MANUAL, [name]: byte })?.key;

const byte = (id: string, name: string, beat: number, extra: Partial<LaserEffectContext> = {}) =>
  render(id, beat, extra)[name] as number;

/** Beats from 0 to `beats`, 40 per beat. */
const moments = (beats: number) => Array.from({ length: beats * 40 }, (_, i) => i / 40);

describe('the set of laser effects', () => {
  it('has five, each with its own id, a name and a description', () => {
    expect(LASER_EFFECTS).toHaveLength(5);
    expect(new Set(LASER_EFFECTS.map((e) => e.id)).size).toBe(5);
    for (const effect of LASER_EFFECTS) {
      expect(effect.name.length).toBeGreaterThan(0);
      expect(effect.description.length).toBeGreaterThan(20);
      expect(effect.drives.length).toBeGreaterThan(0);
    }
  });

  it('counts in a mode that the laser has', () => {
    expect(keyOf(LASER_GATE, MANUAL)).toBe(LASER_EFFECTS_MODE);
  });

  it('never drives the mode, so that opening the laser stays with the operator', () => {
    for (const effect of LASER_EFFECTS) {
      expect(effect.drives).not.toContain(LASER_GATE);
      for (const beat of moments(8)) {
        expect(Object.keys(effect.render({ beat, bpm: 126, raw: {} }))).not.toContain(LASER_GATE);
      }
    }
  });

  it('gives a whole byte for every control it drives and for nothing else', () => {
    for (const effect of LASER_EFFECTS) {
      for (const bpm of [30, 126, 400]) {
        for (const beat of [-3.25, ...moments(16), 100_000.5]) {
          const bytes = effect.render({ beat, bpm, raw: { mode: MANUAL, program: 255 } });
          expect(Object.keys(bytes).sort()).toEqual([...effect.drives].sort());
          for (const value of Object.values(bytes)) {
            expect(Number.isInteger(value)).toBe(true);
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(255);
          }
        }
      }
    }
  });

  it('gives the same bytes for the same moment', () => {
    for (const effect of LASER_EFFECTS) {
      const context = { beat: 5.3, bpm: 126, raw: { mode: MANUAL, program: 40 } };
      expect(effect.render(context)).toEqual(effect.render(context));
    }
  });

  it('changes at most once per beat, which the limit on the speed keeps below the flash limit', () => {
    for (const bpm of [60, 126, 150, 151, 200]) {
      for (const wanted of [0.25, 1, 4, 16]) {
        expect((bpm * limitSpeed(bpm, wanted)) / 60).toBeLessThanOrEqual(MAX_FLASH_HZ);
      }
    }
    for (const id of ['patterns', 'colours']) {
      const effect = findLaserEffect(id);
      const name = effect?.drives[0] as string;
      for (let beat = 0; beat < 8; beat++) {
        const within = moments(1).map((part) => byte(id, name, beat + part));
        expect(new Set(within).size).toBe(1);
      }
    }
  });

  it('does not know an effect that is not there', () => {
    expect(findLaserEffect('tunnel')).toBeUndefined();
  });
});

describe('pattern chase', () => {
  const range = findRange(control('program'), 'pattern') as ByteRange;
  const pattern = (beat: number, program = 0) =>
    stepOfByte(range, byte('patterns', 'program', beat, { raw: { mode: MANUAL, program } }));

  it('shows the next pattern on every beat', () => {
    expect([0, 0.99, 1, 2, 3.5].map((beat) => pattern(beat))).toEqual([1, 1, 2, 3, 4]);
  });

  it('starts from the pattern the operator chose', () => {
    expect(pattern(0, 57)).toBe(12);
    expect(pattern(2, 57)).toBe(14);
  });

  it('comes back to the first pattern after the last', () => {
    expect(pattern(LASER_PATTERNS - 1)).toBe(LASER_PATTERNS);
    expect(pattern(LASER_PATTERNS)).toBe(1);
    expect(pattern(0, 255)).toBe(LASER_PATTERNS);
    expect(pattern(1, 255)).toBe(1);
  });

  it('sends the middle of the bytes of a pattern', () => {
    expect(byte('patterns', 'program', 0)).toBe(2);
    expect(byte('patterns', 'program', 11)).toBe(57);
  });
});

describe('colour chase', () => {
  it('goes through seven single colours, one per beat', () => {
    const bytes = Array.from({ length: 8 }, (_, beat) => byte('colours', 'colour', beat));
    expect(bytes).toEqual([4, 13, 22, 31, 40, 49, 58, 4]);
    for (const value of bytes) expect(keyOf('colour', value)).toBe('single');
  });
});

describe('pulse', () => {
  it('is at full size on the beat and shrinks until the next', () => {
    expect(byte('pulse', 'size', 0)).toBe(0);
    expect(byte('pulse', 'size', 4)).toBe(0);
    const sizes = moments(1).map((beat) => byte('pulse', 'size', beat));
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1] as number);
    }
    expect(sizes[sizes.length - 1]).toBeGreaterThan(40);
  });

  it('stays within the fixed sizes and away from the smallest', () => {
    for (const beat of moments(4)) {
      const size = byte('pulse', 'size', beat);
      expect(keyOf('size', size)).toBe('fixed');
      expect(size).toBeLessThanOrEqual(48);
    }
  });
});

describe('sweep', () => {
  it('is at one side on a beat and at the other on the next', () => {
    expect(byte('sweep', 'moveH', 0)).toBe(1);
    expect(byte('sweep', 'moveH', 1)).toBe(127);
    expect(byte('sweep', 'moveH', 2)).toBe(1);
    expect(byte('sweep', 'moveH', 0.5)).toBe(64);
  });

  it('stays within the positions and travels without jumps', () => {
    const places = moments(4).map((beat) => byte('sweep', 'moveH', beat));
    for (const place of places) {
      expect(keyOf('moveH', place)).toBe('position');
      expect(place).toBeGreaterThanOrEqual(1);
    }
    for (let i = 1; i < places.length; i++) {
      expect(Math.abs((places[i] as number) - (places[i - 1] as number))).toBeLessThanOrEqual(6);
    }
  });
});

describe('twist', () => {
  it('turns one way for a bar and the other way for the next', () => {
    const ways = [0, 3.99, 4, 7.99, 8].map((beat) =>
      keyOf('rotation', byte('twist', 'rotation', beat)),
    );
    expect(ways).toEqual(['forward', 'forward', 'reverse', 'reverse', 'forward']);
  });

  it('turns faster at a higher tempo, and never leaves the speeds', () => {
    const at = (bpm: number, beat = 0) => byte('twist', 'rotation', beat, { bpm });
    expect(at(30)).toBeLessThan(at(126));
    expect(at(126)).toBeLessThan(at(252));
    expect(at(126)).toBe(141);
    expect(at(600)).toBe(191);
    expect(at(126, 4)).toBe(205);
    expect(at(600, 4)).toBe(255);
    expect(keyOf('rotation', at(1000))).toBe('forward');
  });
});
