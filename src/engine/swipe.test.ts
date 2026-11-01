import { describe, expect, it } from 'vitest';
import type { Rgbw } from './colour.js';
import { type Curve, curveAt } from './curve.js';
import { type EffectContext, findEffect } from './effects.js';
import { findMotionEffect, type MotionContext, type MotionModel } from './motionEffects.js';
import { type PaletteColour, paint } from './palette.js';
import { SWIPE_BEATS, swipeLeg, swipesUp } from './swipe.js';

const A: Rgbw = { red: 1, green: 0, blue: 0, white: 0 };
const B: Rgbw = { red: 0, green: 0, blue: 1, white: 0 };
const BARS = [
  [3, 2, 1, 0],
  [4, 5, 6, 7],
];
/** The spider as Jeroen calibrated it: the same tilt turns the bars opposite ways. */
const TILTS: readonly Curve[] = [
  [
    [0, 20],
    [0.3, 0],
    [0.87, -90],
    [1, -108],
  ],
  [
    [0, -20],
    [0.3, 0],
    [0.87, 90],
    [1, 108],
  ],
];
const MOTOR = [
  [0, 182.9],
  [0.5, 182.9],
  [0.9, 32],
  [1, 3.1],
] as const;
const REAL: MotionModel = { tilt: TILTS, motorSpeed: MOTOR };

const light = (
  beat: number,
  colours: PaletteColour[] = [A, B],
  extra: Partial<EffectContext> = {},
) => {
  const effect = findEffect('swipe');
  if (!effect) throw new Error('no swipe');
  const { levels } = effect.render({
    beat,
    cells: 8,
    bars: BARS,
    slots: colours.length,
    filled: colours.map((colour) => colour !== null),
    ...extra,
  });
  return paint(levels, { colours, mode: 'static', change: 'step', speed: 1 }, 0);
};
const peak = (c: Rgbw | undefined) => (c ? Math.max(c.red, c.green, c.blue, c.white) : 0);
/** The lenses that show light, from a moment in the middle of a leg. */
const lit = (beat: number, colours?: PaletteColour[]) =>
  light(beat, colours).flatMap((cell, lens) => (peak(cell) > 0.5 ? [lens] : []));

const motion = (beat: number, model: MotionModel = REAL, bpm = 126, bars = 2) => {
  const effect = findMotionEffect('swipe');
  if (!effect) throw new Error('no swipe');
  const context: MotionContext = { beat, bpm, bars, motion: model };
  return effect.render(context);
};
const degrees = (tilt: number[], model: MotionModel = REAL) =>
  tilt.map((value, bar) => curveAt(model.tilt?.[bar] ?? [], value));

describe('the legs of a swipe', () => {
  it('counts a leg of two beats and where in it a beat is', () => {
    expect(SWIPE_BEATS).toBe(2);
    expect(swipeLeg(0)).toEqual({ leg: 0, phase: 0 });
    expect(swipeLeg(3).leg).toBe(1);
    expect(swipeLeg(3).phase).toBeCloseTo(0.5, 9);
  });

  it('sends the bars up in turn, the first one first', () => {
    // The first leg ends in arrival 1.
    expect([0, 1].map((bar) => swipesUp(bar, 1))).toEqual([true, false]);
    expect([0, 1].map((bar) => swipesUp(bar, 2))).toEqual([false, true]);
    expect([0, 1].map((bar) => swipesUp(bar, 3))).toEqual([true, false]);
  });
});

describe('the light effect Swipe', () => {
  it('lights two lenses of the bar that goes up, the outer pair first, and nothing else', () => {
    // Leg 0: bar 0 up, outer pair. Its lenses are 3 2 1 0 along the bar, so the outer ones are 3 and 0.
    expect(lit(1)).toEqual([0, 3]);
    // Leg 1: bar 1, the inner pair (the other bar takes the other pair).
    expect(lit(3)).toEqual([5, 6]);
    // Leg 2: bar 0 again, now the inner pair.
    expect(lit(5)).toEqual([1, 2]);
    // Leg 3: bar 1, now the outer pair.
    expect(lit(7)).toEqual([4, 7]);
    // And it comes round.
    expect(lit(9)).toEqual([0, 3]);
  });

  it('is the first colour on the first bar and the second colour on the second bar', () => {
    const first = light(1);
    for (const lens of [0, 3]) expect(first[lens]).toEqual(A);
    const second = light(3);
    for (const lens of [5, 6]) expect(second[lens]).toEqual(B);
  });

  it('is the first colour for both bars when the palette has no second colour', () => {
    for (const colours of [[A], [A, null]] as PaletteColour[][]) {
      const cells = light(3, colours);
      for (const lens of [5, 6]) expect(cells[lens]).toEqual(A);
    }
  });

  it('fades in at the start of a leg and out at its end, so a beam does not pop', () => {
    // Leg 0 is beats 0 to 2, and lens 0 is on the first bar.
    expect(peak(light(0)[0])).toBe(0);
    expect(peak(light(0.1)[0])).toBeGreaterThan(0);
    expect(peak(light(0.1)[0])).toBeLessThan(0.7);
    expect(peak(light(1)[0])).toBe(1);
    expect(peak(light(1.99)[0])).toBeLessThan(0.2);
    // The next leg is the other bar's: the first is dark and the second has only begun.
    expect(peak(light(2.001)[0])).toBe(0);
    expect(peak(light(2.001)[5])).toBeLessThan(0.05);
  });

  it('is always one bar, so there is always a fan', () => {
    for (let beat = 0.3; beat < 16; beat += 1) {
      const on = lit(beat);
      expect(on).toHaveLength(2);
      const bars = new Set(on.map((lens) => (lens < 4 ? 0 : 1)));
      expect(bars.size).toBe(1);
    }
  });

  it('copes with bars of other lengths', () => {
    const effect = findEffect('swipe');
    for (const bars of [
      [[0]],
      [[0, 1]],
      [[0, 1, 2]],
      [[0, 1, 2, 3, 4, 5]],
      [
        [0, 1, 2, 3],
        [4, 5, 6, 7],
        [8, 9, 10, 11],
      ],
    ]) {
      const cells = bars.flat().length;
      const frame = effect?.render({ beat: 1, cells, bars, slots: 2 });
      expect(frame?.levels).toHaveLength(cells);
      expect(frame?.levels.some((levels) => levels.length > 0)).toBe(true);
    }
  });
});

describe('the motion effect Swipe', () => {
  it('sends the bar that goes up to the top of its reach and the other down to where it hangs', () => {
    // Leg 0 ends in arrival 1: bar 0 to 108 degrees to the back, bar 1 hanging.
    const first = degrees(motion(1).tilt);
    expect(first[0]).toBeCloseTo(-108, 3);
    expect(first[1]).toBeCloseTo(0, 3);
    // Leg 1: bar 1 up, to 108 to the front, bar 0 back to hanging.
    const second = degrees(motion(3).tilt);
    expect(second[0]).toBeCloseTo(0, 3);
    expect(second[1]).toBeCloseTo(108, 3);
  });

  it('changes the targets once per leg, on the beat the bars arrived', () => {
    const targets = new Set<string>();
    for (let beat = 2; beat < 3.95; beat += 0.05) targets.add(JSON.stringify(motion(beat).tilt));
    expect(targets.size).toBe(1);
    expect(JSON.stringify(motion(4.05).tilt)).not.toBe([...targets][0]);
  });

  it('sets the motor speed so that a swing takes the two beats', () => {
    const frame = motion(1);
    const speed = curveAt(
      [
        [0, 182.9],
        [0.5, 182.9],
        [0.9, 32],
        [1, 3.1],
      ],
      frame.motorSpeed ?? 0,
    );
    // 108 degrees in two beats at 126 bpm is 113 degrees per second, within what the motor does at its fastest.
    expect(frame.motorSpeed).toBeDefined();
    expect(speed).toBeGreaterThan(100);
    expect(speed).toBeLessThanOrEqual(183);
  });

  it('keeps both bars inside a swing limit and swings between the ends of it', () => {
    const limited: MotionModel = {
      ...REAL,
      limits: [
        { min: 0.1, max: 0.5 },
        { min: 0.1, max: 0.5 },
      ],
    };
    for (let beat = 0; beat < 24; beat += 0.1) {
      for (const tilt of motion(beat, limited).tilt) {
        expect(tilt).toBeGreaterThanOrEqual(0.1 - 1e-9);
        expect(tilt).toBeLessThanOrEqual(0.5 + 1e-9);
      }
    }
    // Bar 0 hangs at 0 (tilt 0.3) and goes up as far as the window lets it: tilt 0.5 is 46 degrees to the back.
    expect(motion(1, limited).tilt[0]).toBeCloseTo(0.5, 6);
    expect(motion(1, limited).tilt[1]).toBeCloseTo(0.3, 6);
  });

  it('keeps to the swing limits of the show: the back bar a little way back, the front bar far forward', () => {
    // Jeroen's limits of 2026-10: tilt 0 to 0.37 for the back bar and 0.16 to 0.8 for the front bar.
    const shown: MotionModel = {
      ...REAL,
      limits: [
        { min: 0, max: 0.37 },
        { min: 0.16, max: 0.8 },
      ],
    };
    expect(motion(1, shown).tilt[0]).toBeCloseTo(0.37, 6);
    expect(motion(1, shown).tilt[1]).toBeCloseTo(0.3, 6);
    expect(motion(3, shown).tilt[0]).toBeCloseTo(0.3, 6);
    expect(motion(3, shown).tilt[1]).toBeCloseTo(0.8, 6);
  });

  it('swings a window that leaves out neutral across what it has', () => {
    // The floor zone of the show: tilt 0 to 0.2, which is 20 to 6.7 degrees to the front for bar 0.
    const floor: MotionModel = {
      ...REAL,
      limits: [
        { min: 0, max: 0.2 },
        { min: 0, max: 0.2 },
      ],
    };
    const ends = new Set<number>();
    for (let beat = 0; beat < 8; beat += 0.1)
      ends.add(Math.round((motion(beat, floor).tilt[0] ?? 0) * 1000));
    expect(ends.size).toBe(2);
  });

  it('shortens the swing instead of being late when the motor is too slow for the tempo', () => {
    const fast = degrees(motion(1, REAL, 126).tilt);
    const faster = degrees(motion(1, REAL, 400).tilt);
    expect(Math.abs(faster[0] ?? 0)).toBeLessThan(Math.abs(fast[0] ?? 0));
  });
});

describe('the two Swipes together', () => {
  it('light the bar that is on its way up, at every moment', () => {
    for (let beat = 0.2; beat < 24; beat += 0.37) {
      const target = degrees(motion(beat).tilt);
      const lens = lit(beat + 0.0, undefined);
      const { phase } = swipeLeg(beat);
      // At the edges of a leg the beam is faded out, and nothing is lit.
      if (lens.length === 0) {
        expect(phase < 0.2 || phase > 0.8).toBe(true);
        continue;
      }
      const litBar = (lens[0] ?? 0) < 4 ? 0 : 1;
      const other = 1 - litBar;
      // The lit bar is the one that is away from where it hangs, the other is going to hang.
      expect(Math.abs(target[litBar] ?? 0)).toBeGreaterThan(Math.abs(target[other] ?? 0));
    }
  });
});
