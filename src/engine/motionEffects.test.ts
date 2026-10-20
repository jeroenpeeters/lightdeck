import { describe, expect, it } from 'vitest';
import { type Curve, curveAt } from './curve.js';
import {
  findMotionEffect,
  MOTION_EFFECTS,
  type MotionContext,
  type MotionFrame,
  type MotionModel,
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

  it('has every one set the motor speed: they say where the bars end up and how fast to get there', () => {
    expect(MOTION_EFFECTS.filter((effect) => effect.setsMotorSpeed).map((e) => e.id)).toEqual(
      MOTION_EFFECTS.map((e) => e.id),
    );
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

  it('only sets the motor speed when it says so, and then only where the fixture can tell it', () => {
    for (let beat = 0; beat < 16; beat += 0.5) {
      const frame = effect.render(context(beat, { motion: REAL_MOTION }));
      if (!effect.setsMotorSpeed) expect(frame.motorSpeed).toBeUndefined();
    }
  });
});

/** How many different tilts the bars were given at `beats` (steps of a twentieth of a beat). */
function targetsBetween(id: string, from: number, to: number, motion: MotionModel = REAL_MOTION) {
  const seen = new Set<string>();
  for (let beat = from; beat <= to; beat += 0.05) {
    seen.add(JSON.stringify(render(id, beat, { motion }).tilt));
  }
  return seen.size;
}

/** The motor speed byte that covers `degrees` in `beats` beats at 126 bpm, on the calibrated motor. */
const byteFor = (degrees: number, beats: number) => (degrees / ((beats * 60) / 126) - 30) / 270;

describe('tilt wave', () => {
  const frame = (beat: number, extra: Partial<MotionContext> = {}) =>
    render('tiltwave', beat, { motion: REAL_MOTION, ...extra });

  it('sends the bars to the high end and the low end in turn, against each other around the middle', () => {
    // Without a calibration the tilts can be read as they are.
    for (let beat = 0; beat < 16; beat += 0.5) {
      const tilt = render('tiltwave', beat).tilt;
      expect((tilt[0] ?? 0) + (tilt[1] ?? 0)).toBeCloseTo(1);
    }
    const high = render('tiltwave', 1).tilt;
    expect(high[0]).toBeCloseTo(0.8);
    expect(high[1]).toBeCloseTo(0.2);
    const low = render('tiltwave', 3).tilt;
    expect(low[0]).toBeCloseTo(0.2);
    expect(low[1]).toBeCloseTo(0.8);
  });

  it('gives one target for four beats, and changes it on the beat the bars arrive at the last', () => {
    expect(targetsBetween('tiltwave', 2.001, 5.999)).toBe(1);
    expect(targetsBetween('tiltwave', 6.001, 9.999)).toBe(1);
    expect(frame(1.99).tilt).not.toEqual(frame(2.01).tilt);
    expect(frame(5.99).tilt).not.toEqual(frame(6.01).tilt);
  });

  it('sets the motor speed to take the four beats for the whole swing', () => {
    const [highBack = 0, highFront = 0] = degreesOf(frame(1));
    const [lowBack = 0, lowFront = 0] = degreesOf(frame(3));
    const distance = Math.max(Math.abs(highBack - lowBack), Math.abs(highFront - lowFront));
    expect(frame(1).motorSpeed).toBeCloseTo(byteFor(distance, 4), 6);
    expect(frame(3).motorSpeed).toBeCloseTo(byteFor(distance, 4), 6);
  });

  it('swings less when the motor cannot do it at this tempo', () => {
    // At 1000 bpm four beats are 0.24 seconds, which is 72 degrees at 300 degrees per second.
    const quick = frame(1, { bpm: 1000 });
    expect(quick.motorSpeed).toBe(1);
    const swing = Math.abs(
      (degreesOf(quick)[0] ?? 0) - (degreesOf(frame(3, { bpm: 1000 }))[0] ?? 0),
    );
    expect(swing).toBeCloseTo(72, 3);
  });

  it('leaves the motor speed to the operator when the fixture gives no calibration of the motor', () => {
    expect(render('tiltwave', 1).motorSpeed).toBeUndefined();
  });
});

describe('scissor', () => {
  const frame = (beat: number, extra: Partial<MotionContext> = {}) =>
    render('scissor', beat, { motion: REAL_MOTION, ...extra });
  const at = (beat: number) => degreesOf(frame(beat));

  it('swings the bars through each other, the same distance in opposite directions', () => {
    for (let beat = 0; beat < 8; beat += 0.25) {
      const [first = 0, second = 0] = at(beat);
      expect(first + second).toBeCloseTo(0, 3);
    }
  });

  it('sends the bars to the open point from the first beat and to the crossed point from the fifth', () => {
    // They arrive crossed on beat 8 (20 degrees is as far as the bars reach that way) and open on beat 4 (60).
    expect(at(2)[0]).toBeCloseTo(-60, 3);
    expect(at(2)[1]).toBeCloseTo(60, 3);
    expect(at(6)[0]).toBeCloseTo(20, 3);
    expect(at(6)[1]).toBeCloseTo(-20, 3);
  });

  it('gives one target for four beats and changes it the moment the bars arrive at the last', () => {
    expect(targetsBetween('scissor', 0.001, 3.999)).toBe(1);
    expect(targetsBetween('scissor', 4.001, 7.999)).toBe(1);
    expect(frame(3.99).tilt).not.toEqual(frame(4.01).tilt);
    expect(frame(7.99).tilt).not.toEqual(frame(8.01).tilt);
  });

  it('puts the same tilt on both bars where they cross, which is what a scissor is for these bars', () => {
    const tilt = frame(6).tilt;
    expect(tilt[0]).toBeCloseTo(0, 6);
    expect(tilt[1]).toBeCloseTo(0, 6);
    const open = frame(2).tilt;
    expect(open[0]).toBeCloseTo(open[1] ?? 0, 6);
  });

  it('swings 60 degrees to each side without a calibration, on a plain tilt', () => {
    const crossed = render('scissor', 6).tilt;
    expect(crossed[0]).toBeCloseTo(0.5 - 60 / 180, 6);
    expect(crossed[1]).toBeCloseTo(0.5 + 60 / 180, 6);
  });

  it('sets the motor speed to cover the swing in all four beats', () => {
    // 80 degrees (20 crossed to 60 open) in four beats of 126 bpm.
    expect(frame(2).motorSpeed).toBeCloseTo(byteFor(80, 4), 6);
    expect(frame(6).motorSpeed).toBeCloseTo(byteFor(80, 4), 6);
  });

  it('leaves the motor speed to the operator without a calibration of the motor', () => {
    expect(render('scissor', 1).motorSpeed).toBeUndefined();
  });
});

describe('scissor with a rest', () => {
  const frame = (beat: number, extra: Partial<MotionContext> = {}) =>
    render('scissor-motor', beat, { motion: REAL_MOTION, ...extra });

  it('says that it sets the motor speed', () => {
    expect(findMotionEffect('scissor-motor')?.setsMotorSpeed).toBe(true);
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

  it('sends the bars to the same ends as the scissor, the opposite way round on the next half', () => {
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
  const frame = (beat: number, motion: MotionModel = REAL_MOTION) =>
    render('creep', beat, { motion });
  const at = (beat: number, motion: MotionModel = REAL_MOTION) =>
    degreesOf(frame(beat, motion), motion as { tilt: readonly Curve[] });

  it('leans both bars the same way, at every moment', () => {
    for (let beat = 0; beat < 32; beat += 0.5) {
      const [first = 0, second = 0] = at(beat);
      expect(first).toBeCloseTo(second, 3);
    }
  });

  it('sends the bars from side to side, one swing in four bars, within what both bars reach', () => {
    // Both bars reach 20 degrees to either side at the most (the front bar only 20 to the back).
    expect(at(2)[0]).toBeCloseTo(20, 3);
    expect(at(6)[0]).toBeCloseTo(-20, 3);
    expect(at(14)[0]).toBeCloseTo(20, 3);
  });

  it('gives one target for eight beats and changes it on the beat the bars arrive at the last', () => {
    expect(targetsBetween('creep', 4.001, 11.999)).toBe(1);
    expect(targetsBetween('creep', 12.001, 19.999)).toBe(1);
    expect(frame(3.99).tilt).not.toEqual(frame(4.01).tilt);
    expect(frame(11.99).tilt).not.toEqual(frame(12.01).tilt);
  });

  it('goes 30 degrees to each side when the bars can, without a calibration', () => {
    expect(render('creep', 2).tilt[0]).toBeCloseTo(0.5 - 30 / 180, 6);
    expect(render('creep', 6).tilt[0]).toBeCloseTo(0.5 + 30 / 180, 6);
  });

  it('sets the motor speed to make the sweep last the eight beats', () => {
    const slowAtTheTop = { tilt: BAR_TILTS, motorSpeed: SLOW_AT_THE_TOP };
    // 40 degrees in eight beats of 126 bpm is 10.5 degrees per second: slow, near the top of the channel.
    const byte = frame(2, slowAtTheTop).motorSpeed ?? 0;
    expect(curveAt(SLOW_AT_THE_TOP, byte)).toBeCloseTo(40 / ((8 * 60) / 126), 6);
  });

  it('asks for the slowest the motor goes when it cannot go as slowly as the sweep', () => {
    // 10.5 degrees per second is below the 30 of the calibrated motor, and the sweep is then early.
    expect(frame(2).motorSpeed).toBe(0);
  });

  it('leaves the motor speed to the operator without a calibration of the motor', () => {
    expect(render('creep', 3).motorSpeed).toBeUndefined();
  });
});

describe('drift', () => {
  const frame = (beat: number) => render('drift', beat, { motion: REAL_MOTION });
  const at = (beat: number) => degreesOf(frame(beat));

  it('swings each bar on its own, the back bar in sixteen beats and the front bar in twenty-four', () => {
    expect(at(16)[0]).toBeCloseTo(at(0)[0] ?? 0, 3);
    expect(at(16)[1]).not.toBeCloseTo(at(0)[1] ?? 0, 1);
    expect(at(24)[1]).toBeCloseTo(at(0)[1] ?? 0, 3);
    expect(at(20)[0]).not.toBeCloseTo(at(0)[0] ?? 0, 1);
    expect(at(48)[0]).toBeCloseTo(at(0)[0] ?? 0, 3);
    expect(at(48)[1]).toBeCloseTo(at(0)[1] ?? 0, 3);
  });

  it('changes the target of the back bar every eight beats and that of the front bar every twelve', () => {
    const back = (beat: number) => frame(beat).tilt[0];
    const front = (beat: number) => frame(beat).tilt[1];
    // The back bar arrives on beats 4, 12, 20 and the front bar on beats 6, 18, 30.
    expect(back(3.99)).not.toBe(back(4.01));
    expect(back(11.99)).not.toBe(back(12.01));
    expect(back(5.99)).toBe(back(6.01));
    expect(front(5.99)).not.toBe(front(6.01));
    expect(front(17.99)).not.toBe(front(18.01));
    expect(front(11.99)).toBe(front(12.01));
    expect(targetsBetween('drift', 6.001, 11.999)).toBe(1);
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

  it('moves both bars at the one motor speed, the back bar going the shorter way', () => {
    const slowAtTheTop = { tilt: BAR_TILTS, motorSpeed: SLOW_AT_THE_TOP };
    const withSlow = (beat: number) => render('drift', beat, { motion: slowAtTheTop });
    const speed = curveAt(SLOW_AT_THE_TOP, withSlow(5).motorSpeed ?? 0);
    // The front bar: 80 degrees (20 crossed, 60 open) in twelve beats. The back bar: two thirds of
    // that in eight, which is the same speed.
    expect(speed).toBeCloseTo(80 / ((12 * 60) / 126), 4);
    const back = (beat: number) => degreesOf(withSlow(beat), slowAtTheTop)[0] ?? 0;
    expect(Math.abs(back(2) - back(6)) / ((8 * 60) / 126)).toBeCloseTo(speed, 4);
  });

  it('leaves the motor speed to the operator without a calibration of the motor', () => {
    expect(render('drift', 5).motorSpeed).toBeUndefined();
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

describe('inside a swing limit', () => {
  /** Tilt 10 to 80 percent on both bars, as Jeroen put it on 2026-10-20. */
  const LIMITS = [
    { min: 0.1, max: 0.8 },
    { min: 0.1, max: 0.8 },
  ] as const;
  const LIMITED = { ...REAL_MOTION, limits: LIMITS };
  const limited = (id: string, beat: number, extra: Partial<MotionContext> = {}) =>
    render(id, beat, { motion: LIMITED, ...extra });

  it.each(MOTION_EFFECTS.map((e) => [e.id] as const))(
    '%s keeps both bars inside the window at any moment and any tempo',
    (id) => {
      const outside: string[] = [];
      for (const bpm of [60, 126, 200, 1000]) {
        for (let beat = 0; beat < 48; beat += 0.1) {
          limited(id, beat, { bpm }).tilt.forEach((tilt, bar) => {
            if (tilt < 0.1 - 1e-9 || tilt > 0.8 + 1e-9) outside.push(`${id} bar ${bar}: ${tilt}`);
          });
        }
      }
      expect(outside.slice(0, 3)).toEqual([]);
    },
  );

  it('swings the tilt wave from 0.2 to 0.8 of the window, not into the limits and stuck there', () => {
    const plain = { limits: LIMITS };
    const high = render('tiltwave', 1, { motion: plain }).tilt;
    const low = render('tiltwave', 3, { motion: plain }).tilt;
    expect(high[0]).toBeCloseTo(0.1 + 0.8 * 0.7, 6);
    expect(low[0]).toBeCloseTo(0.1 + 0.2 * 0.7, 6);
    expect(high[1]).toBeCloseTo(low[0] ?? 0, 6);
  });

  it('sets the motor speed of a limited swing for the way it really goes', () => {
    // The window leaves bar 1 from 13.3 degrees to the front to 78.9 to the back. The scissor
    // crosses to the 13.3 that the bars reach there and opens 60, which is 73.3 degrees in four beats.
    const [crossed1 = 0, crossed2 = 0] = degreesOf(limited('scissor', 6));
    expect(crossed1).toBeCloseTo(20 * (1 - 0.1 / 0.3), 3);
    expect(crossed2).toBeCloseTo(-20 * (1 - 0.1 / 0.3), 3);
    expect(degreesOf(limited('scissor', 2))[0]).toBeCloseTo(-60, 3);
    expect(limited('scissor', 2).motorSpeed).toBeCloseTo(byteFor(60 + 20 * (1 - 0.1 / 0.3), 4), 6);
    // Less than the 80 degrees of the free bars, so a slower motor.
    expect(limited('scissor', 2).motorSpeed ?? 1).toBeLessThan(
      render('scissor', 2, { motion: REAL_MOTION }).motorSpeed ?? 0,
    );
  });

  it('sweeps the creep over what both bars reach inside the window', () => {
    // The bars are mirrored, so the window is 13.3 degrees to the front for one and to the back for the other.
    const reach = 20 * (1 - 0.1 / 0.3);
    expect(degreesOf(limited('creep', 2))[0]).toBeCloseTo(reach, 3);
    expect(degreesOf(limited('creep', 6))[0]).toBeCloseTo(-reach, 3);
  });

  it('moves the bars of the drift at one speed inside the window', () => {
    const slowAtTheTop = { tilt: BAR_TILTS, motorSpeed: SLOW_AT_THE_TOP, limits: LIMITS };
    const withSlow = (beat: number) => render('drift', beat, { motion: slowAtTheTop });
    const speed = curveAt(SLOW_AT_THE_TOP, withSlow(5).motorSpeed ?? 0);
    const back = (beat: number) => degreesOf(withSlow(beat), slowAtTheTop)[0] ?? 0;
    const front = (beat: number) => degreesOf(withSlow(beat), slowAtTheTop)[1] ?? 0;
    expect(Math.abs(back(2) - back(6)) / ((8 * 60) / 126)).toBeCloseTo(speed, 4);
    expect(Math.abs(front(2) - front(14)) / ((12 * 60) / 126)).toBeCloseTo(speed, 4);
  });

  it('swings across a window that leaves out neutral, from one end of it to the other', () => {
    // Bar 1 may go from tilt 0.5 (31.6 degrees to the back) to 0.8 (78.9). Neutral is not inside.
    const away = {
      ...REAL_MOTION,
      limits: [
        { min: 0.5, max: 0.8 },
        { min: 0.5, max: 0.8 },
      ],
    };
    const crossed = render('scissor', 6, { motion: away }).tilt;
    const open = render('scissor', 2, { motion: away }).tilt;
    expect(crossed[0]).toBeCloseTo(0.5, 6);
    expect(open[0]).toBeCloseTo(0.8, 6);
  });

  it('is free where a bar has no limit', () => {
    const half = { ...REAL_MOTION, limits: [{ min: 0.1, max: 0.8 }] };
    expect(render('scissor', 2, { motion: half }).tilt[1]).toBeCloseTo(
      limited('scissor', 2).tilt[1] ?? 0,
      6,
    );
    expect(render('tiltwave', 1, { motion: half }).tilt[1]).toBeCloseTo(0.2, 6);
  });
});
