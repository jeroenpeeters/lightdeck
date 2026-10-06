import { describe, expect, it } from 'vitest';
import { EffectClock } from './effectClock.js';
import { limitSpeed } from './effects.js';

const input = (over: Partial<Parameters<EffectClock['read']>[0]> = {}) => ({
  beat: 0,
  bpm: 120,
  wanted: 1,
  epoch: 0,
  key: 'chase',
  ...over,
});

/** The lens a chase over eight lenses is on. */
const lens = (effectBeat: number) => ((Math.floor(effectBeat) % 8) + 8) % 8;

describe('EffectClock', () => {
  it('gives the beat times the speed to start with, as before', () => {
    const clock = new EffectClock();
    expect(clock.read(input({ beat: 3.4, wanted: 1 }))).toEqual({ beat: 3.4, speed: 1 });
    expect(clock.read(input({ beat: 3.5, wanted: 1 }))).toEqual({ beat: 3.5, speed: 1 });
    const other = new EffectClock();
    expect(other.read(input({ beat: 3.4, wanted: 2 }))).toEqual({ beat: 6.8, speed: 2 });
  });

  describe('a change of the speed', () => {
    it('keeps the step: the chase stays on its lens when ×2 is pressed', () => {
      const clock = new EffectClock();
      expect(lens(clock.read(input({ beat: 6.8 })).beat)).toBe(6);
      // Without the clock, 6.85 times 2 is 13.7 and the chase would be on lens 5.
      expect(lens(clock.read(input({ beat: 6.85, wanted: 2 })).beat)).toBe(6);
      expect(lens(clock.read(input({ beat: 6.9, wanted: 2 })).beat)).toBe(6);
    });

    it('goes on from there at the new speed, and the steps are on the grid of the beat', () => {
      const clock = new EffectClock();
      clock.read(input({ beat: 6.8 }));
      clock.read(input({ beat: 6.85, wanted: 2 }));
      // At ×2 a step comes every half beat, on the half beats: 7.0, 7.5, 8.0 ...
      expect(lens(clock.read(input({ beat: 6.99, wanted: 2 })).beat)).toBe(6);
      expect(lens(clock.read(input({ beat: 7.0, wanted: 2 })).beat)).toBe(7);
      expect(lens(clock.read(input({ beat: 7.49, wanted: 2 })).beat)).toBe(7);
      expect(lens(clock.read(input({ beat: 7.5, wanted: 2 })).beat)).toBe(0);
    });

    it('does the same going slower, and for the master speed', () => {
      const clock = new EffectClock();
      clock.read(input({ beat: 40.3, wanted: 4 }));
      const slower = clock.read(input({ beat: 40.4, wanted: 0.5 }));
      expect(lens(slower.beat)).toBe(lens(40.3 * 4));
      // At ÷2 a step comes every second beat, on the even beats.
      expect(lens(clock.read(input({ beat: 41.99, wanted: 0.5 })).beat)).toBe(lens(slower.beat));
      expect(lens(clock.read(input({ beat: 42, wanted: 0.5 })).beat)).toBe(lens(slower.beat) + 1);
    });

    it('does not move when the speed is not changed, however long it runs', () => {
      const clock = new EffectClock();
      for (let beat = 0; beat < 2000; beat += 0.37) {
        expect(clock.read(input({ beat })).beat).toBeCloseTo(beat, 9);
      }
    });

    it('survives many changes without losing the grid', () => {
      const clock = new EffectClock();
      const speeds = [1, 2, 4, 0.5, 0.25, 1, 4, 2];
      let beat = 10.1;
      speeds.forEach((wanted) => {
        beat += 3.3;
        clock.read(input({ beat, wanted, bpm: 90 }));
      });
      // After all of that an integer effect beat still falls on a point of the grid.
      const at = (b: number) => clock.read(input({ beat: b, wanted: 2, bpm: 90 })).beat;
      const a = at(beat + 1);
      const b = at(beat + 1.5);
      expect(b - a).toBeCloseTo(1, 9);
      expect((a - Math.floor(a) + 1) % 1).toBeCloseTo(
        (beat + 1) * 2 - Math.floor((beat + 1) * 2),
        9,
      );
    });
  });

  describe('a tap, and another effect', () => {
    it('starts over when the beat count is restarted', () => {
      const clock = new EffectClock();
      clock.read(input({ beat: 6.8 }));
      clock.read(input({ beat: 6.85, wanted: 2 }));
      // The tap makes beat 0 now, and the chase starts on lens 1 again, like a new bar.
      const after = clock.read(input({ beat: 0.02, wanted: 2, epoch: 1 }));
      expect(after.beat).toBeCloseTo(0.04, 9);
      expect(lens(after.beat)).toBe(0);
    });

    it('starts over for another effect', () => {
      const clock = new EffectClock();
      clock.read(input({ beat: 6.8 }));
      clock.read(input({ beat: 6.85, wanted: 2 }));
      expect(clock.read(input({ beat: 7, wanted: 2, key: 'wave' })).beat).toBeCloseTo(14, 9);
    });
  });

  describe('the limit on the speed', () => {
    it('lowers the speed at once when the tempo goes over', () => {
      const clock = new EffectClock();
      expect(clock.read(input({ bpm: 149.9, wanted: 4 })).speed).toBe(4);
      expect(clock.read(input({ bpm: 150.1, wanted: 4 })).speed).toBe(2);
    });

    it('does not bring it back up until the tempo is clear of the limit', () => {
      const clock = new EffectClock();
      clock.read(input({ bpm: 150.2, wanted: 4 }));
      for (const bpm of [150.2, 149.9, 150.1, 149.8, 149.0, 148.6]) {
        expect(clock.read(input({ bpm, wanted: 4 })).speed).toBe(2);
      }
      // 3% under 150 beats per minute is 145.5.
      expect(clock.read(input({ bpm: 145.6, wanted: 4 })).speed).toBe(2);
      expect(clock.read(input({ bpm: 145.4, wanted: 4 })).speed).toBe(4);
    });

    it('does not flap while the tempo wanders around the threshold', () => {
      const clock = new EffectClock();
      let flips = 0;
      let previous = clock.read(input({ bpm: 149.0, wanted: 4 })).speed;
      for (let i = 0; i < 200; i++) {
        const bpm = 150 + 0.4 * Math.sin(i / 3);
        const { speed } = clock.read(input({ bpm, wanted: 4, beat: i * 0.5 }));
        if (speed !== previous) flips++;
        previous = speed;
      }
      expect(flips).toBe(1);
    });

    it('lowers it again at once when the tempo goes up after coming back', () => {
      const clock = new EffectClock();
      clock.read(input({ bpm: 150.2, wanted: 4 }));
      clock.read(input({ bpm: 140, wanted: 4 }));
      expect(clock.read(input({ bpm: 150.2, wanted: 4 })).speed).toBe(2);
    });

    it('takes the strict limit when the speed that is wanted changes', () => {
      const clock = new EffectClock();
      clock.read(input({ bpm: 150.2, wanted: 4 }));
      expect(clock.read(input({ bpm: 140, wanted: 2 })).speed).toBe(limitSpeed(140, 2));
    });

    it('is the plain limit when nothing wanders', () => {
      for (const bpm of [60, 90, 126, 150, 170, 200]) {
        for (const wanted of [0.25, 0.5, 1, 2, 4, 16]) {
          expect(new EffectClock().read(input({ bpm, wanted })).speed).toBe(
            limitSpeed(bpm, wanted),
          );
        }
      }
    });

    it('keeps the step when the limit changes the speed', () => {
      const clock = new EffectClock();
      expect(lens(clock.read(input({ bpm: 149.9, wanted: 4, beat: 5.1 })).beat)).toBe(
        lens(5.1 * 4),
      );
      expect(lens(clock.read(input({ bpm: 150.1, wanted: 4, beat: 5.11 })).beat)).toBe(
        lens(5.1 * 4),
      );
    });
  });
});
