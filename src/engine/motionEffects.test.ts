import { describe, expect, it } from 'vitest';
import { type Curve, curveAt } from './curve.js';
import {
  findMotionEffect,
  MOTION_EFFECTS,
  type MotionContext,
  type MotionFrame,
} from './motionEffects.js';

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

function context(beat: number, extra: Partial<MotionContext> = {}): MotionContext {
  return { beat, bpm: 126, bars: 2, ...extra };
}

function render(id: string, beat: number, extra: Partial<MotionContext> = {}): MotionFrame {
  const effect = findMotionEffect(id);
  if (!effect) throw new Error(`no motion effect ${id}`);
  return effect.render(context(beat, extra));
}

/** Where the bars of the frame stand, in degrees from neutral, by the calibration of the spider. */
const degreesOf = (frame: MotionFrame, motion: { tilt: readonly Curve[] } = REAL_MOTION) =>
  frame.tilt.map((tilt, bar) => curveAt(motion.tilt[bar] ?? [], tilt));

describe('the set of motion effects', () => {
  it('has six, each with its own id, a name and a description', () => {
    expect(MOTION_EFFECTS.map((effect) => effect.id)).toEqual([
      'tiltwave',
      'scissor',
      'scissor-motor',
      'creep',
      'drift',
      'slice',
    ]);
    for (const effect of MOTION_EFFECTS) {
      expect(effect.name.length).toBeGreaterThan(0);
      expect(effect.description.length).toBeGreaterThan(20);
    }
  });

  it('finds an effect by id', () => {
    expect(findMotionEffect('scissor')?.name).toBe('Scissor');
    expect(findMotionEffect('nope')).toBeUndefined();
  });

  it('has two that set the motor speed', () => {
    expect(MOTION_EFFECTS.filter((effect) => effect.setsMotorSpeed).map((e) => e.id)).toEqual([
      'scissor-motor',
      'slice',
    ]);
  });
});

describe.each(MOTION_EFFECTS.map((e) => [e.id, e] as const))('%s', (_id, effect) => {
  it('gives every bar a valid tilt at any moment and any tempo', () => {
    // Collected and asserted once: an assertion per value makes this sweep slow.
    const wrong: string[] = [];
    const valid = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;
    for (const motion of [undefined, REAL_MOTION]) {
      for (const bpm of [60, 126, 140, 200, 400]) {
        for (let beat = 0; beat < 40; beat += 0.037) {
          const frame = effect.render(context(beat, { bpm, ...(motion ? { motion } : {}) }));
          const at = `beat ${beat.toFixed(3)} at ${bpm} bpm`;
          if (frame.tilt.length !== 2) wrong.push(`${frame.tilt.length} tilts, ${at}`);
          for (const tilt of frame.tilt) if (!valid(tilt)) wrong.push(`tilt ${tilt}, ${at}`);
          if (frame.motorSpeed !== undefined && !valid(frame.motorSpeed)) {
            wrong.push(`motor speed ${frame.motorSpeed}, ${at}`);
          }
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
    expect(pictures.size).toBeGreaterThan(1);
  });

  it('copes with a different number of bars', () => {
    expect(effect.render(context(3.2, { bars: 1 })).tilt).toHaveLength(1);
    expect(effect.render(context(3.2, { bars: 3 })).tilt).toHaveLength(3);
  });

  it('only sets the motor speed when it says so', () => {
    for (let beat = 0; beat < 16; beat += 0.5) {
      const frame = effect.render(context(beat, { motion: REAL_MOTION }));
      if (!effect.setsMotorSpeed) expect(frame.motorSpeed).toBeUndefined();
    }
  });
});

describe('tilt wave', () => {
  it('tilts the bars against each other around the middle of the tilt', () => {
    for (let beat = 0; beat < 8; beat += 0.5) {
      const tilt = render('tiltwave', beat).tilt;
      expect((tilt[0] ?? 0) + (tilt[1] ?? 0)).toBeCloseTo(1);
    }
    const quarter = render('tiltwave', 2).tilt;
    expect(quarter[0]).toBeCloseTo(0.8);
    expect(quarter[1]).toBeCloseTo(0.2);
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
    const tilt = render('scissor', 0, { motion: REAL_MOTION }).tilt;
    expect(tilt[0]).toBeCloseTo(0, 6);
    expect(tilt[1]).toBeCloseTo(0, 6);
    const open = render('scissor', 4, { motion: REAL_MOTION }).tilt;
    expect(open[0]).toBeCloseTo(open[1] ?? 0, 6);
  });

  it('swings 60 degrees to each side without a calibration, on a plain tilt', () => {
    const open = render('scissor', 0).tilt;
    expect(open[0]).toBeCloseTo(0.5 - 60 / 180, 6);
    expect(open[1]).toBeCloseTo(0.5 + 60 / 180, 6);
  });

  it('leaves the motor speed to the operator', () => {
    expect(render('scissor', 1, { motion: REAL_MOTION }).motorSpeed).toBeUndefined();
  });
});

describe('scissor by motor speed', () => {
  const frame = (beat: number, extra: Partial<MotionContext> = {}) =>
    render('scissor-motor', beat, { motion: REAL_MOTION, ...extra });

  it('says that it sets the motor speed', () => {
    expect(findMotionEffect('scissor-motor')?.setsMotorSpeed).toBe(true);
    expect(findMotionEffect('scissor')?.setsMotorSpeed).toBeUndefined();
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
});

describe('creep', () => {
  const at = (beat: number, motion = REAL_MOTION) =>
    degreesOf(render('creep', beat, { motion }), motion);

  it('leans both bars the same way, at every moment', () => {
    for (let beat = 0; beat < 32; beat += 0.5) {
      const [first = 0, second = 0] = at(beat);
      expect(first).toBeCloseTo(second, 3);
    }
  });

  it('sweeps slowly from side to side, one swing in four bars, within what both bars reach', () => {
    // Both bars reach 20 degrees to either side at the most (the front bar only 20 to the back).
    const swing = Array.from({ length: 160 }, (_, i) => at(i / 10)[0] ?? 0);
    expect(Math.max(...swing)).toBeCloseTo(20, 1);
    expect(Math.min(...swing)).toBeCloseTo(-20, 1);
    expect(at(0)[0]).toBeCloseTo(0, 3);
    expect(at(16)[0]).toBeCloseTo(0, 3);
    expect(at(4)[0]).toBeCloseTo(20, 3);
    expect(at(12)[0]).toBeCloseTo(-20, 3);
  });

  it('moves no faster than a few degrees per beat', () => {
    for (let beat = 0; beat < 32; beat += 0.25) {
      expect(Math.abs((at(beat + 0.25)[0] ?? 0) - (at(beat)[0] ?? 0))).toBeLessThan(3);
    }
  });

  it('goes 30 degrees to each side when the bars can, without a calibration', () => {
    const plain = Array.from({ length: 160 }, (_, i) => render('creep', i / 10).tilt[0] ?? 0);
    expect(Math.max(...plain)).toBeCloseTo(0.5 + 30 / 180, 2);
    expect(Math.min(...plain)).toBeCloseTo(0.5 - 30 / 180, 2);
  });

  it('leaves the motor speed to the operator', () => {
    expect(render('creep', 3, { motion: REAL_MOTION }).motorSpeed).toBeUndefined();
  });
});

describe('drift', () => {
  const at = (beat: number) => degreesOf(render('drift', beat, { motion: REAL_MOTION }));

  it('swings each bar on its own, the back bar in sixteen beats and the front bar in twenty-four', () => {
    expect(at(16)[0]).toBeCloseTo(at(0)[0] ?? 0, 3);
    expect(at(16)[1]).not.toBeCloseTo(at(0)[1] ?? 0, 1);
    expect(at(24)[1]).toBeCloseTo(at(0)[1] ?? 0, 3);
    expect(at(20)[0]).not.toBeCloseTo(at(0)[0] ?? 0, 1);
    expect(at(48)[0]).toBeCloseTo(at(0)[0] ?? 0, 3);
    expect(at(48)[1]).toBeCloseTo(at(0)[1] ?? 0, 3);
  });

  it('keeps the bars within what they reach: 20 degrees where beams cross, 60 where they open', () => {
    for (let beat = 0; beat < 48; beat += 0.25) {
      const [back = 0, front = 0] = at(beat);
      expect(back).toBeLessThanOrEqual(20 + 1e-6);
      expect(back).toBeGreaterThanOrEqual(-60 - 1e-6);
      expect(front).toBeGreaterThanOrEqual(-20 - 1e-6);
      expect(front).toBeLessThanOrEqual(60 + 1e-6);
    }
  });

  it('crosses the beams at some moments and has them apart at others, and keeps changing which', () => {
    // The beams cross while the back bar points further to the front than the front bar does.
    const crossed = (beat: number) => (at(beat)[0] ?? 0) > (at(beat)[1] ?? 0);
    const states = Array.from({ length: 480 }, (_, i) => crossed(i / 10));
    expect(states).toContain(true);
    expect(states).toContain(false);
    let changes = 0;
    for (let i = 1; i < states.length; i++) if (states[i] !== states[i - 1]) changes++;
    expect(changes).toBeGreaterThanOrEqual(2);
  });

  it('does not set the motor speed', () => {
    expect(render('drift', 5, { motion: REAL_MOTION }).motorSpeed).toBeUndefined();
  });
});

describe('slice', () => {
  const frame = (beat: number, motion = REAL_MOTION) => render('slice', beat, { motion });
  const at = (beat: number) => degreesOf(frame(beat));

  it('snaps to a new position every two beats and holds it', () => {
    for (let turn = 0; turn < 4; turn++) {
      const held = new Set<string>();
      for (let beat = turn * 2; beat < turn * 2 + 2; beat += 0.1)
        held.add(JSON.stringify(frame(beat).tilt));
      expect(held.size).toBe(1);
    }
    expect(frame(1.99).tilt).not.toEqual(frame(2).tilt);
  });

  it('goes crossed, fanned out, both back and both forward, and round again', () => {
    const [crossedBack = 0, crossedFront = 0] = at(0);
    expect(crossedBack).toBeCloseTo(20, 3);
    expect(crossedFront).toBeCloseTo(-20, 3);
    const [openBack = 0, openFront = 0] = at(2);
    expect(openBack).toBeCloseTo(-60, 3);
    expect(openFront).toBeCloseTo(60, 3);
    expect(at(4)[0]).toBeCloseTo(-20, 3);
    expect(at(4)[1]).toBeCloseTo(-20, 3);
    expect(at(6)[0]).toBeCloseTo(20, 3);
    expect(at(6)[1]).toBeCloseTo(20, 3);
    expect(at(8)[0]).toBeCloseTo(20, 3);
    expect(at(8)[1]).toBeCloseTo(-20, 3);
  });

  it('asks for the fastest motor speed, wherever the fast end of the channel is', () => {
    // Fast at the top of the channel.
    expect(frame(1).motorSpeed).toBe(1);
    // Fast at the bottom of it, as the spider is timed.
    const slowAtTheTop = { tilt: BAR_TILTS, motorSpeed: SLOW_AT_THE_TOP };
    expect(render('slice', 1, { motion: slowAtTheTop }).motorSpeed).toBe(0);
  });

  it('leaves the motor speed alone when it does not know the motor', () => {
    expect(render('slice', 1).motorSpeed).toBeUndefined();
    const flat = {
      tilt: BAR_TILTS,
      motorSpeed: [
        [0, 100],
        [1, 100],
      ] as const,
    };
    expect(render('slice', 1, { motion: flat }).motorSpeed).toBeUndefined();
  });
});
