import { describe, expect, it } from 'vitest';
import { type Curve, curveAt } from './curve.js';
import {
  EFFECTS,
  type EffectContext,
  type EffectFrame,
  findEffect,
  limitSpeed,
  MAX_FLASH_HZ,
  palette,
  REST_LEVEL,
  type Rgbw,
  SPEEDS,
} from './effects.js';

/** The foreground. */
const A: Rgbw = { red: 1, green: 0.5, blue: 0, white: 0 };
/** The background: dimmer than the foreground, as it is when a flash has to stand out of it. */
const B: Rgbw = { red: 0, green: 0, blue: 0.25, white: 0 };
const BARS = [
  [0, 1, 2, 3],
  [4, 5, 6, 7],
];

function context(beat: number, extra: Partial<EffectContext> = {}): EffectContext {
  return { beat, bpm: 126, cells: 8, bars: BARS, a: A, b: B, ...extra };
}

function render(id: string, beat: number, extra: Partial<EffectContext> = {}): EffectFrame {
  const effect = findEffect(id);
  if (!effect) throw new Error(`no effect ${id}`);
  return effect.render(context(beat, extra));
}

/** Brightest colour part of a cell, 0..1. */
const peak = (c: Rgbw | undefined) => (c ? Math.max(c.red, c.green, c.blue, c.white) : 0);
/** All the light of a cell. A fade from one colour to another never rises while it falls. */
const light = (c: Rgbw | undefined) => (c ? c.red + c.green + c.blue + c.white : 0);
const total = (frame: EffectFrame) => frame.cells.reduce((sum, c) => sum + peak(c), 0);
const brightest = (frame: EffectFrame) =>
  frame.cells.reduce((best, c, i) => (peak(c) > peak(frame.cells[best]) ? i : best), 0);

/** A motor that is slow at 0 and fast at 100: 30 to 300 degrees per second. */
const CALIBRATED_SPEED = [
  [0, 30],
  [1, 300],
] as const;
/**
 * The two bars as Jeroen calibrated them on 2026-10-14: the same tilt turns them opposite ways,
 * and neither reaches further than 20 degrees to the side where the beams cross.
 */
const BAR_TILTS = [
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
] as const;
const REAL_MOTION = { tilt: BAR_TILTS, motorSpeed: CALIBRATED_SPEED };
/** The motor speed of the spider as timed: fast up to 50, and slow at the top of the channel. */
const SLOW_AT_THE_TOP = [
  [0, 182.9],
  [0.5, 182.9],
  [0.9, 32],
  [1, 3.1],
] as const;
/** Where the bars of the frame stand, in degrees from neutral, by the calibration of the spider. */
const degreesOf = (frame: EffectFrame, motion: { tilt: readonly Curve[] } = REAL_MOTION) =>
  (frame.tilt ?? []).map((tilt, bar) => curveAt(motion.tilt[bar] ?? [], tilt));

describe('the colours of an effect', () => {
  it('are the two the operator chose, the first as foreground and the second as background', () => {
    const B2: Rgbw = { red: 0.2, green: 0, blue: 0, white: 0 };
    expect(palette(A, B2)).toEqual({ a: A, b: B2 });
  });

  it('have the first colour dim for a background when the second is left empty', () => {
    const { a, b } = palette(A, null);
    expect(a).toEqual(A);
    expect(b.red).toBeCloseTo(REST_LEVEL);
    expect(b.green).toBeCloseTo(0.5 * REST_LEVEL);
    expect(b.blue).toBe(0);
    expect(b.white).toBe(0);
  });

  it('do not change the colours that were given', () => {
    const a = { ...A };
    palette(a, null);
    expect(a).toEqual(A);
  });
});

describe('the set of effects', () => {
  it('has twelve, each with its own id, a name and a description', () => {
    expect(EFFECTS).toHaveLength(12);
    expect(new Set(EFFECTS.map((e) => e.id)).size).toBe(12);
    for (const effect of EFFECTS) {
      expect(effect.name.length).toBeGreaterThan(0);
      expect(effect.description.length).toBeGreaterThan(20);
    }
  });

  it('finds an effect by id', () => {
    expect(findEffect('chase')?.name).toBe('Chase');
    expect(findEffect('nope')).toBeUndefined();
  });
});

describe.each(EFFECTS.map((e) => [e.id, e] as const))('%s', (_id, effect) => {
  it('gives every cell a valid colour at any moment and any tempo', () => {
    // Collected and asserted once: an assertion per value makes this sweep slow.
    const wrong: string[] = [];
    const valid = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;
    for (const bpm of [60, 126, 140, 200, 400]) {
      for (let beat = 0; beat < 40; beat += 0.037) {
        const frame = effect.render(context(beat, { bpm }));
        const at = `beat ${beat.toFixed(3)} at ${bpm} bpm`;
        if (frame.cells.length !== 8) wrong.push(`${frame.cells.length} cells, ${at}`);
        frame.cells.forEach((cell, i) => {
          for (const value of [cell.red, cell.green, cell.blue, cell.white]) {
            if (!valid(value)) wrong.push(`cell ${i} has ${value}, ${at}`);
          }
        });
        for (const tilt of frame.tilt ?? []) {
          if (!valid(tilt)) wrong.push(`tilt ${tilt}, ${at}`);
        }
        if (frame.motorSpeed !== undefined && !valid(frame.motorSpeed)) {
          wrong.push(`motor speed ${frame.motorSpeed}, ${at}`);
        }
      }
    }
    expect(wrong.slice(0, 5)).toEqual([]);
  });

  it('shows the same picture for the same moment', () => {
    expect(effect.render(context(13.37))).toEqual(effect.render(context(13.37)));
  });

  it('changes over time', () => {
    const pictures = new Set<string>();
    for (let beat = 0; beat < 16; beat += 0.25) {
      pictures.add(JSON.stringify(effect.render(context(beat))));
    }
    expect(pictures.size).toBeGreaterThan(4);
  });

  it('copes with a different number of cells and bars', () => {
    const frame = effect.render(context(3.2, { cells: 4, bars: [[0, 1, 2, 3]] }));
    expect(frame.cells).toHaveLength(4);
  });

  it('only sets the motor speed when it says so', () => {
    const motion = REAL_MOTION;
    for (let beat = 0; beat < 16; beat += 0.5) {
      const frame = effect.render(context(beat, { motion }));
      if (!effect.setsMotorSpeed) expect(frame.motorSpeed).toBeUndefined();
    }
  });

  it('only tilts the bars when it says it moves', () => {
    const frame = effect.render(context(2.5));
    expect(frame.tilt !== undefined).toBe(effect.moves);
    if (frame.tilt) expect(frame.tilt).toHaveLength(BARS.length);
  });

  it('does not change the colours it was given', () => {
    const a = { ...A };
    const b = { ...B };
    effect.render(context(1.5, { a, b }));
    expect(a).toEqual(A);
    expect(b).toEqual(B);
  });
});

describe('kick', () => {
  it('is brightest on the beat and fades until the next one', () => {
    const all = (beat: number) => light(render('kick', beat).cells[0]);
    expect(all(1)).toBeGreaterThan(all(1.5));
    expect(all(1.5)).toBeGreaterThan(all(1.95));
    expect(all(2)).toBeCloseTo(all(1));
  });

  it('rings a little longer on the first beat of the bar', () => {
    expect(light(render('kick', 4.5).cells[0])).toBeGreaterThan(
      light(render('kick', 5.5).cells[0]),
    );
  });

  it('hits in the first colour on every beat and falls back to the second', () => {
    for (const beat of [0, 1, 2, 3, 4]) {
      expect(render('kick', beat).cells[0]).toEqual(A);
      const after = render('kick', beat + 0.99).cells[0];
      expect(after?.red).toBeLessThan(0.05);
      expect(after?.blue).toBeGreaterThan(0.2);
    }
  });

  it('with the second colour empty hits and falls back to a dim first colour', () => {
    const frame = render('kick', 1.99, palette(A, null));
    expect(peak(frame.cells[0])).toBeLessThan(0.1);
    expect(frame.cells[0]?.blue).toBe(0);
  });
});

describe('chase', () => {
  it('moves the bright lens along all eight, one lens per beat', () => {
    const order = [0, 1, 2, 3, 4, 5, 6, 7].map((beat) => brightest(render('chase', beat + 0.01)));
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(brightest(render('chase', 8.01))).toBe(0);
  });

  it('stays where it is until the next beat', () => {
    expect(render('chase', 3.01)).toEqual(render('chase', 3.99));
    expect(render('chase', 3.99)).not.toEqual(render('chase', 4));
  });

  it('leaves a tail behind the head, not in front of it', () => {
    const frame = render('chase', 3.5); // head on lens 3
    expect(peak(frame.cells[2])).toBeGreaterThan(peak(frame.cells[4]));
  });
});

describe('bounce', () => {
  it('goes to the far end and back, one lens per beat', () => {
    const order = Array.from({ length: 17 }, (_, beat) => brightest(render('bounce', beat + 0.5)));
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 7, 6, 5, 4, 3, 2, 1, 0, 0]);
  });

  it('is a spot of the first colour over the second', () => {
    expect(render('bounce', 0).cells[0]).toEqual(A);
    expect(render('bounce', 0).cells[7]).toEqual(B);
    expect(render('bounce', 7).cells[7]).toEqual(A);
    expect(render('bounce', 7).cells[0]).toEqual(B);
  });
});

describe('bar swap', () => {
  it('hits one bar per beat, in turn, in the first colour over the second', () => {
    const first = render('swap', 0.05);
    expect(first.cells[0]?.red).toBeGreaterThan(0.5);
    expect(first.cells[4]).toEqual(B);

    const second = render('swap', 1.05);
    expect(second.cells[0]).toEqual(B);
    expect(second.cells[4]?.red).toBeGreaterThan(0.5);
  });
});

describe('wave', () => {
  it('has the first colour on its crest and the second in its trough', () => {
    expect(render('wave', 1).cells[0]).toEqual(A);
    const trough = render('wave', 3).cells[0];
    expect(trough?.red).toBeCloseTo(0);
    expect(trough?.blue).toBeCloseTo(0.25);
  });
});

describe('spectrum', () => {
  it('ignores the chosen colours', () => {
    const black: Rgbw = { red: 0, green: 0, blue: 0, white: 0 };
    expect(render('spectrum', 2.2, { a: black, b: black })).toEqual(render('spectrum', 2.2));
    expect(total(render('spectrum', 2.2, { a: black, b: black }))).toBeGreaterThan(2);
  });

  it('gives neighbouring lenses different colours', () => {
    const frame = render('spectrum', 0.5);
    expect(new Set(frame.cells.map((c) => JSON.stringify(c))).size).toBe(8);
  });
});

describe('sparkle', () => {
  it('flashes only some lenses in the first colour and leaves the rest the second', () => {
    let flashes = 0;
    let slots = 0;
    for (let beat = 0; beat < 128; beat += 1) {
      const frame = render('sparkle', beat + 0.01);
      for (const cell of frame.cells) {
        slots++;
        if (cell.red > 0.5) flashes++;
        else expect(cell).toEqual(B);
      }
    }
    expect(flashes / slots).toBeGreaterThan(0.1);
    expect(flashes / slots).toBeLessThan(0.35);
  });

  it('with blue first and red second flashes blue on a red wash', () => {
    const blue: Rgbw = { red: 0, green: 0, blue: 1, white: 0 };
    const red: Rgbw = { red: 1, green: 0, blue: 0, white: 0 };
    const frame = render('sparkle', 5.01, { a: blue, b: red });
    expect(frame.cells.some((cell) => cell.blue > 0.9)).toBe(true);
    for (const cell of frame.cells) {
      expect(cell.blue > 0.9 || (cell.red === 1 && cell.blue === 0)).toBe(true);
    }
  });

  it('with the second colour empty flashes the first over a dim wash of it', () => {
    const blue: Rgbw = { red: 0, green: 0, blue: 1, white: 0 };
    const frame = render('sparkle', 5.01, palette(blue, null));
    const levels = frame.cells.map((cell) => cell.blue);
    expect(Math.max(...levels)).toBeGreaterThan(0.9);
    for (const level of levels)
      expect(level > 0.9 || Math.abs(level - REST_LEVEL) < 1e-9).toBe(true);
    for (const cell of frame.cells) expect(cell.red + cell.green + cell.white).toBe(0);
  });

  it('flashes the same lenses for a whole beat, and others on the next', () => {
    const lit = (beat: number) => render('sparkle', beat).cells.map((cell) => cell.red > 0.011);
    expect(lit(5.01)).toEqual(lit(5.6));
    const sets = new Set([0, 1, 2, 3, 4, 5, 6, 7].map((beat) => lit(beat + 0.01).join()));
    expect(sets.size).toBeGreaterThan(4);
  });
});

describe('build-up', () => {
  /** How many lenses show the first colour. */
  const flashing = (frame: EffectFrame) => frame.cells.filter((c) => c.red > 0.001).length;

  it('gets brighter and wider, then drops on the first colour', () => {
    const early = render('build', 1.1);
    const late = render('build', 27.01);
    expect(total(late)).toBeGreaterThan(total(early));
    expect(flashing(early)).toBeLessThan(flashing(late));
    expect(early.cells[0]).toEqual(B);
    expect(render('build', 0).cells[3]?.red).toBeGreaterThan(0);

    const drop = render('build', 31.02);
    for (const cell of drop.cells) expect(cell.red).toBeGreaterThan(0.9);
  });

  it('flashes once per bar, then every two beats, then on every beat', () => {
    const on = (beat: number) => flashing(render('build', beat)) > 0;
    /** The beats in a stretch on which the light comes on. */
    const starts = (from: number, to: number) => {
      const found: number[] = [];
      for (let beat = from; beat < to; beat += 0.25) {
        if (on(beat) && !(beat > from && on(beat - 0.25))) found.push(beat);
      }
      return found;
    };
    expect(starts(0, 16)).toEqual([0, 4, 8, 12]);
    expect(starts(16, 24)).toEqual([16, 18, 20, 22]);
    expect(starts(24, 31)).toEqual([24, 25, 26, 27, 28, 29, 30]);
  });

  it('starts again after eight bars', () => {
    expect(render('build', 33.3)).toEqual(render('build', 1.3));
  });
});

describe('strobe burst', () => {
  it('flashes only during the fourth bar, on the beat', () => {
    for (const beat of [0.3, 5.3, 11.3, 16.3]) {
      const frame = render('burst', beat);
      expect(frame.cells[0]?.red).toBeLessThan(0.7);
    }
    for (const beat of [12, 13, 14, 15]) {
      expect(render('burst', beat + 0.01).cells[0]).toEqual(A);
      expect(render('burst', beat + 0.5).cells[0]).toEqual(B);
    }
  });
});

describe('tilt wave', () => {
  it('tilts the bars against each other around the middle of the tilt', () => {
    for (let beat = 0; beat < 8; beat += 0.5) {
      const tilt = render('tiltwave', beat).tilt ?? [];
      expect((tilt[0] ?? 0) + (tilt[1] ?? 0)).toBeCloseTo(1);
    }
    const quarter = render('tiltwave', 2).tilt ?? [];
    expect(quarter[0]).toBeCloseTo(0.8);
    expect(quarter[1]).toBeCloseTo(0.2);
  });

  it('shows the first colour on both bars, pumping on the beat over the second', () => {
    const frame = render('tiltwave', 0);
    expect(frame.cells[0]).toEqual(A);
    expect(frame.cells[7]).toEqual(A);
    expect(render('tiltwave', 0.99).cells[0]?.blue).toBeGreaterThan(0.01);
  });
});

describe('scissor', () => {
  const at = (beat: number) => degreesOf(render('scissor', beat, { motion: REAL_MOTION }));

  it('swings the bars through each other, the same distance in opposite directions', () => {
    for (let beat = 0; beat < 8; beat += 0.25) {
      const [first = 0, second = 0] = at(beat);
      expect(first + second).toBeCloseTo(0, 3);
    }
  });

  it('crosses the beams on the first beat, as far as the bars can, and opens them four beats later', () => {
    // The back bar to the front and the front bar to the back: the beams cross. They reach 20 degrees that way.
    expect(at(0)[0]).toBeCloseTo(20, 3);
    expect(at(0)[1]).toBeCloseTo(-20, 3);
    // And 60 degrees the other way, which is as far as a scissor goes.
    expect(at(4)[0]).toBeCloseTo(-60, 3);
    expect(at(4)[1]).toBeCloseTo(60, 3);
    expect(at(8)[0]).toBeCloseTo(20, 3);
  });

  it('passes through the middle between crossed and open, where the beams are parallel', () => {
    let wasCrossed = true;
    let crossings = 0;
    for (let beat = 0; beat <= 8; beat += 0.01) {
      const crossed = (at(beat)[0] ?? 0) > 0;
      if (crossed !== wasCrossed) crossings++;
      wasCrossed = crossed;
    }
    expect(crossings).toBe(2);
  });

  it('puts the same tilt on both bars where they cross, which is what a scissor is for these bars', () => {
    const tilt = render('scissor', 0, { motion: REAL_MOTION }).tilt ?? [];
    expect(tilt[0]).toBeCloseTo(0, 6);
    expect(tilt[1]).toBeCloseTo(0, 6);
    const open = render('scissor', 4, { motion: REAL_MOTION }).tilt ?? [];
    expect(open[0]).toBeCloseTo(open[1] ?? 0, 6);
  });

  it('swings 60 degrees to each side without a calibration, on a plain tilt', () => {
    const open = render('scissor', 0).tilt ?? [];
    expect(open[0]).toBeCloseTo(0.5 - 60 / 180, 6);
    expect(open[1]).toBeCloseTo(0.5 + 60 / 180, 6);
  });

  it('shows the first colour on both bars, pumping on the beat over the second', () => {
    expect(render('scissor', 0).cells[0]).toEqual(A);
    expect(render('scissor', 0.99).cells[7]?.blue).toBeGreaterThan(0.01);
  });

  it('leaves the motor speed to the operator', () => {
    expect(render('scissor', 1, { motion: REAL_MOTION }).motorSpeed).toBeUndefined();
  });
});

describe('scissor by motor speed', () => {
  const frame = (beat: number, extra: Partial<EffectContext> = {}) =>
    render('scissor-motor', beat, { motion: REAL_MOTION, ...extra });

  it('says that it sets the motor speed', () => {
    expect(findEffect('scissor-motor')?.setsMotorSpeed).toBe(true);
    expect(findEffect('scissor')?.setsMotorSpeed).toBeUndefined();
  });

  it('gives the bars one target per half cycle, and no position in between', () => {
    // The target changes on beat 1 and beat 5, three beats before the bars should arrive.
    const targets = (from: number, to: number) => {
      const seen = new Set<string>();
      for (let beat = from; beat < to; beat += 0.05) seen.add(JSON.stringify(frame(beat).tilt));
      return seen;
    };
    expect(targets(1.001, 4.999).size).toBe(1);
    expect(targets(5.001, 8.999).size).toBe(1);
    expect(frame(0.99).tilt).not.toEqual(frame(1.01).tilt);
    expect(frame(4.99).tilt).not.toEqual(frame(5.01).tilt);
  });

  it('sends the bars to the same ends as the scissor of the beat, the opposite way round on the next half', () => {
    // Told on beat 1 to be open on beat 4, and on beat 5 to be crossed on beat 8.
    const [open1 = 0, open2 = 0] = degreesOf(frame(2));
    expect(open1).toBeCloseTo(-60, 3);
    expect(open2).toBeCloseTo(60, 3);
    const [crossed1 = 0, crossed2 = 0] = degreesOf(frame(6));
    expect(crossed1).toBeCloseTo(20, 3);
    expect(crossed2).toBeCloseTo(-20, 3);
  });

  it('sets the motor speed to cover the swing in three beats', () => {
    // 80 degrees (20 crossed to 60 open) in three beats of 126 bpm, which is 1.43 seconds: 56 degrees per second.
    const rate = 80 / ((3 * 60) / 126);
    expect(frame(2).motorSpeed).toBeCloseTo((rate - 30) / 270, 6);
  });

  it('turns the motor speed up with the tempo, and leaves the same swing', () => {
    const slow = frame(2, { bpm: 100 }).motorSpeed ?? 0;
    const fast = frame(2, { bpm: 200 }).motorSpeed ?? 0;
    expect(fast).toBeGreaterThan(slow);
    expect(degreesOf(frame(2, { bpm: 200 }))[1]).toBeCloseTo(60, 3);
  });

  it('asks for a lower byte on a motor that gets slower with the byte', () => {
    const slowAtTheTop = { tilt: BAR_TILTS, motorSpeed: SLOW_AT_THE_TOP };
    // 56 degrees per second lies between 0.5 (183) and 0.9 (32) on the calibration of the spider.
    const byte = render('scissor-motor', 2, { motion: slowAtTheTop }).motorSpeed ?? 0;
    expect(curveAt(SLOW_AT_THE_TOP, byte)).toBeCloseTo(80 / ((3 * 60) / 126), 6);
    expect(byte).toBeGreaterThan(0.5);
    expect(byte).toBeLessThan(0.9);
  });

  it('swings less when the motor cannot do it at this tempo', () => {
    // At 1000 bpm three beats are 0.18 seconds, and at 300 degrees per second that is 54 degrees in all.
    const quick = frame(2, { bpm: 1000 });
    expect(quick.motorSpeed).toBe(1);
    const crossed = degreesOf(frame(6, { bpm: 1000 }))[0] ?? 0;
    const open = degreesOf(quick)[0] ?? 0;
    expect(crossed - open).toBeCloseTo(54, 3);
  });

  it('leaves the motor speed alone when the calibration cannot tell which byte to send', () => {
    const flat = {
      tilt: BAR_TILTS,
      motorSpeed: [
        [0, 200],
        [1, 200],
      ] as const,
    };
    expect(frame(2, { motion: flat }).motorSpeed).toBeUndefined();
    expect(render('scissor-motor', 2).motorSpeed).toBeUndefined();
    // It still swings, at the speed that is set.
    expect(degreesOf(frame(2, { motion: flat }), flat)[1]).toBeCloseTo(60, 3);
  });

  it('shows the first colour on both bars, pumping on the beat over the second', () => {
    expect(frame(0).cells[0]).toEqual(A);
    expect(frame(0.99).cells[7]?.blue).toBeGreaterThan(0.01);
  });
});

describe('speed', () => {
  it('has a normal speed, and two slower and two faster', () => {
    expect(SPEEDS).toEqual([0.25, 0.5, 1, 2, 4]);
  });

  it('is given as wanted while a change per beat stays within the flash limit', () => {
    expect(limitSpeed(126, 4)).toBe(4); // 8.4 per second
    expect(limitSpeed(150, 4)).toBe(4); // 10 per second, the limit itself
    expect(limitSpeed(60, 0.25)).toBe(0.25);
    expect(limitSpeed(200, 2)).toBe(2);
  });

  it('is halved until a change per beat is within the limit', () => {
    expect(limitSpeed(160, 4)).toBe(2); // 10.7 would be too fast
    expect(limitSpeed(200, 4)).toBe(2);
    expect(limitSpeed(126, 16)).toBe(4);
    expect(limitSpeed(200, 16)).toBe(2);
  });

  /** The highest tempo an effect is given, whatever tempo and speeds are chosen. */
  const fastest = Math.max(
    ...[60, 126, 150, 151, 200].flatMap((bpm) =>
      SPEEDS.flatMap((effect) => SPEEDS.map((console) => bpm * limitSpeed(bpm, effect * console))),
    ),
  );

  it('never gives an effect a tempo at which a change per beat is over the flash limit', () => {
    expect(fastest).toBe(600);
    expect(fastest / 60).toBeLessThanOrEqual(MAX_FLASH_HZ);
  });

  /** Counts dark-to-bright changes of a lens per second, over 64 beats of the effect. */
  function flashesPerSecond(id: string, bpm: number, cell: number): number {
    const beats = 64;
    let flashes = 0;
    let wasOn = false;
    for (let beat = 0; beat < beats; beat += 0.01) {
      const on = peak(render(id, beat, { bpm }).cells[cell]) > 0.5;
      if (on && !wasOn) flashes++;
      wasOn = on;
    }
    return flashes / ((beats / bpm) * 60);
  }

  it.each(EFFECTS.map((effect) => effect.id))(
    'keeps %s within the flash limit at the highest tempo it is given',
    (id) => {
      for (const cell of [0, 3, 7]) {
        expect(flashesPerSecond(id, fastest, cell)).toBeLessThanOrEqual(MAX_FLASH_HZ + 0.2);
      }
    },
  );

  it.each(EFFECTS.map((effect) => effect.id))(
    'changes %s once per beat at most, unless it moves smoothly',
    (id) => {
      const smooth = ['wave', 'spectrum', 'scissor'];
      if (smooth.includes(id)) return;
      // Between two beats a lens may fade or go out, but no lens may come on. It holds with
      // the second colour set and with it left empty.
      for (const colours of [{}, palette(A, null)]) {
        for (let beat = 0; beat < 64; beat++) {
          for (let cell = 0; cell < 8; cell++) {
            let before = light(render(id, beat + 0.01, colours).cells[cell]);
            for (let part = 0.05; part < 1; part += 0.05) {
              const now = light(render(id, beat + part, colours).cells[cell]);
              expect(now - before).toBeLessThan(0.1);
              before = now;
            }
          }
        }
      }
    },
  );
});
