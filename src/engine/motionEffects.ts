/**
 * Beat-synced motion effects for a fixture made of colour cells on tilting bars.
 *
 * A motion effect moves the bars: it is a pure function from a moment in the music to a tilt
 * per bar and, for the ones that say `setsMotorSpeed`, a motor speed. It knows no colour and
 * no light, so any motion effect goes with any light effect (`effects.ts`) and any palette.
 * No timers and no state in here, so every effect is reproducible and can be tested frame by
 * frame.
 *
 * The tilt and the motor speed are the properties of the motion type of scene, so an effect
 * that sets the motor speed does not reach into another type. With no motion effect chosen
 * the bars stay where the operator put them: that is hold.
 *
 * The scissors work in degrees, through the calibration of each bar (`MotionModel`): the back
 * bar swings to the front while the front bar swings to the back so that the beams cross, and
 * the other way to open them. Which tilt that is, and how far the bars can go, is the fixture's
 * to say.
 *
 * The swing limits are part of what the bars can do (Jeroen, 2026-10-20): an effect is not cut off
 * at a limit, it maps what it does into the window of tilt that the limit leaves, for the effects
 * in degrees through the calibration, so the swing keeps its shape and its time and the motor
 * speed fits the shorter way.
 *
 * An effect says where the bars must END UP and sets the motor speed to get them there on time
 * (Jeroen, 2026-10-20): it does not send a new tilt on every frame. The motor is slow next to
 * 25 frames a second, and a tilt that was a function of the beat made it stutter. So the target
 * of a bar changes once per leg, on the beat the bar arrives at the one before, and the motor
 * speed is worked out from the calibration (`motorSpeed`) so that the move takes the whole leg,
 * or less where an effect rests. A motor too slow for the tempo gets a shorter swing, not a late
 * one.
 *
 * The speed works as it does for light effects: it scales the beat, and whoever renders an
 * effect limits it with `limitSpeed`. The tilt wave and the scissors take a bar or more for
 * one cycle at speed 1.
 */

import { clamp01 } from '../model/fixture.js';
import { mod } from './beat.js';
import { type Curve, curveAt, curveInverse, curveRange, curveRangeBetween } from './curve.js';

/**
 * How the bars of a fixture move, for an effect that works in degrees and not in tilt values.
 * Both are optional: an effect that is given none moves as if the tilt ran in a straight line
 * from 90 degrees to the front at 0 to 90 degrees to the back at 1.
 */
export interface MotionModel {
  /** Per bar, points of [tilt 0..1, degrees from neutral, positive to the front]. */
  tilt?: readonly Curve[] | undefined;
  /** Points of [motor speed 0..1, degrees per second], the same for every bar. */
  motorSpeed?: Curve | undefined;
  /**
   * The swing limit of each bar, as a `min` and a `max` of the tilt. An effect works inside it: what
   * it would do with the whole of the tilt it does within the window, so a bar that is limited
   * still swings from one end of its window to the other, in the time the effect gives it, and
   * the motor speed is worked out for the shorter way. A bar or a key left out is free.
   */
  limits?: readonly { min: number; max: number }[] | undefined;
}

export interface MotionContext {
  /** Beats since the tempo was last synced, as a fraction. Already scaled by the speed. */
  beat: number;
  /** Effective tempo in beats per minute, speed included. */
  bpm: number;
  /** Number of bars. */
  bars: number;
  /** How the bars turn, when the fixture says. */
  motion?: MotionModel;
}

export interface MotionFrame {
  /** Tilt 0..1 per bar. */
  tilt: number[];
  /**
   * Motor speed 0..1. Absent when the effect leaves it with the operator, which is what every
   * effect does but the ones that say `setsMotorSpeed`.
   */
  motorSpeed?: number;
}

export interface MotionEffect {
  id: string;
  name: string;
  /** One sentence for the operator. */
  description: string;
  /** True when the effect also sets the motor speed, if it can work it out, so the page says so. */
  setsMotorSpeed?: boolean;
  render(context: MotionContext): MotionFrame;
}

/** What a bar does when the fixture gives no calibration: 90 degrees to the front down to 90 to the back. */
const LINEAR_TILT: Curve = [
  [0, 90],
  [1, -90],
];

/** The window of tilt that the swing limit leaves bar number `bar`: all of it when it is not limited. */
function windowOf(model: MotionModel | undefined, bar: number): { min: number; max: number } {
  const limit = model?.limits?.[bar];
  return { min: clamp01(limit?.min ?? 0), max: clamp01(limit?.max ?? 1) };
}

/** The tilt that puts bar number `bar` at `degrees`, within its window. */
function tiltFor(model: MotionModel | undefined, bar: number, degrees: number): number {
  const curve = model?.tilt?.[bar] ?? LINEAR_TILT;
  const { min, max } = windowOf(model, bar);
  return Math.min(max, Math.max(min, clamp01(curveInverse(curve, degrees) ?? 0.5)));
}

/** What bar number `bar` can reach, in degrees from neutral, inside its window. */
function reachOf(model: MotionModel | undefined, bar: number): { min: number; max: number } {
  const { min, max } = windowOf(model, bar);
  return curveRangeBetween(model?.tilt?.[bar] ?? LINEAR_TILT, min, max) ?? { min: 0, max: 0 };
}

/**
 * The degrees a bar swings about: neutral, or the end of its window nearest to neutral when the
 * window does not reach it, so that a window which leaves out neutral is still swung across.
 */
function centreOf(model: MotionModel | undefined, bar: number): number {
  const { min, max } = reachOf(model, bar);
  return Math.min(max, Math.max(min, 0));
}

/** Where bar number `bar` stands, in degrees from neutral, at `tilt`. */
function degreesAt(model: MotionModel | undefined, bar: number, tilt: number): number {
  return curveAt(model?.tilt?.[bar] ?? LINEAR_TILT, tilt);
}

/** +1 for an even arrival, -1 for an odd one: which end a bar goes to. */
const endOf = (arrival: number) => (mod(arrival, 2) === 0 ? 1 : -1);

/**
 * How a bar goes from one end to the other and back without resting: it is always on its way to
 * the next arrival, and the whole leg is the time it has.
 */
interface Path {
  /** Beats between two arrivals, which is also how long a leg takes. */
  leg: number;
  /** The beat of arrival number 0. */
  first: number;
  /** Where the bar stands on arrival `arrival`, in degrees from neutral, positive to the front. */
  degrees(arrival: number): number;
}

/**
 * The frame for bars that each follow a `Path`: the tilt is the end a bar is on its way to, which
 * changes on the beat it arrived at the one before, and the motor speed is the one that covers the
 * longest leg of any bar in the time of that leg (a bar with a shorter leg gets there early). When
 * the motor cannot go that fast the legs are shortened around their middle, and when the fixture
 * gives no calibration of the motor the motor speed stays with the operator.
 */
function pathFrame(
  { beat, bpm, bars, motion }: MotionContext,
  path: (bar: number) => Path,
): MotionFrame {
  const legs: { to: number; from: number }[] = [];
  let rate = 0;
  for (let bar = 0; bar < bars; bar++) {
    const { leg, first, degrees } = path(bar);
    const arrival = Math.floor((beat - first) / leg) + 1;
    const to = degrees(arrival);
    const from = degrees(arrival - 1);
    legs.push({ to, from });
    rate = Math.max(rate, Math.abs(to - from) / ((leg * 60) / bpm));
  }
  const range = motion?.motorSpeed ? curveRange(motion.motorSpeed) : undefined;
  const shorter = range && rate > range.max ? range.max / rate : 1;
  const frame: MotionFrame = {
    tilt: legs.map(({ to, from }, bar) =>
      tiltFor(motion, bar, (to + from) / 2 + (shorter * (to - from)) / 2),
    ),
  };
  if (motion?.motorSpeed && rate > 0) {
    const byte = curveInverse(motion.motorSpeed, rate * shorter);
    if (byte !== undefined) frame.motorSpeed = clamp01(byte);
  }
  return frame;
}

/** How far the tilt wave goes either side of the middle, in tilt. */
const WAVE_REACH = 0.3;

const tiltWave: MotionEffect = {
  id: 'tiltwave',
  name: 'Tilt wave',
  description:
    'The tilts of the two bars rise and fall against each other, one cycle every two bars: the bars are sent to each end and the motor speed makes them take the whole four beats to get there. With the bars turning opposite ways for the same tilt, this moves them the same way in space.',
  setsMotorSpeed: true,
  render(context) {
    // High on beat 2 and low on beat 6, as the wave of the beat was.
    return pathFrame(context, (bar) => ({
      leg: 4,
      first: 2,
      degrees: (arrival) => {
        // The wave runs from 0.2 to 0.8 of the tilt, and of the window when the bar is limited.
        const { min, max } = windowOf(context.motion, bar);
        const wave = 0.5 + (bar % 2 === 0 ? 1 : -1) * endOf(arrival) * WAVE_REACH;
        return degreesAt(context.motion, bar, min + wave * (max - min));
      },
    }));
  },
};

/** The furthest a scissor goes to either side, in degrees, when the bars can. */
const SCISSOR_DEGREES = 60;
/** One cycle of a scissor, in beats: crossed on the first beat of the cycle, open on the fifth. */
const SCISSOR_BEATS = 8;
/**
 * The beats a bar takes for its whole swing when the motor speed does the timing. The swing is
 * over a beat before the bar reverses, so the bars stand still on the beat they have arrived.
 */
const SCISSOR_TRAVEL_BEATS = 3;

/**
 * How far a scissor can cross its beams and how far it can open them, in degrees from where each
 * bar swings about (`centre`, neutral unless the window of the bar leaves it out). The bar on an
 * even place (the back bar) turns to the front and the one on an odd place to the back when the
 * beams cross, and the other way when they open, so each side is as far as the bar that reaches
 * the least that way inside its window, and no further than `SCISSOR_DEGREES`. The two are not the
 * same when a bar does not reach as far to one side as to the other, and then the swing is
 * lopsided: that is what the bars can do.
 */
function scissorSpan(
  bars: number,
  model: MotionModel | undefined,
): { cross: number; open: number; centre: number[] } {
  let cross = SCISSOR_DEGREES;
  let open = SCISSOR_DEGREES;
  const centre: number[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const range = reachOf(model, bar);
    const about = centreOf(model, bar);
    centre.push(about);
    const front = range.max - about;
    const back = about - range.min;
    cross = Math.min(cross, bar % 2 === 0 ? front : back);
    open = Math.min(open, bar % 2 === 0 ? back : front);
  }
  return { cross, open, centre };
}

/** Positive turns the bar to the cross side: the back bar to the front, the front bar to the back. */
const scissorSide = (bar: number) => (bar % 2 === 0 ? 1 : -1);

/**
 * The scissor with the bars `travelBeats` of every half cycle on their way: the ends are the
 * same, crossed on the first beat of the cycle and open on the fifth, and the target changes
 * `travelBeats` before the beat the bars should arrive.
 */
function scissorRender(travelBeats: number): MotionEffect['render'] {
  return ({ beat, bpm, bars, motion }) => {
    const travelSeconds = (travelBeats * 60) / bpm;
    const span = scissorSpan(bars, motion);
    let { cross, open } = span;
    // A motor that is too slow for the swing at this tempo gets a shorter swing, not a late one.
    const rates = motion?.motorSpeed ? curveRange(motion.motorSpeed) : undefined;
    const whole = cross + open;
    if (rates && whole > 0) {
      const shorter = Math.min(1, (rates.max * travelSeconds) / whole);
      cross *= shorter;
      open *= shorter;
    }
    // The target changes on the beat that is the swing's time before the beat it should arrive on.
    const half = SCISSOR_BEATS / 2;
    const crossed = mod(beat - (half - travelBeats), SCISSOR_BEATS) >= half;
    const target = crossed ? cross : -open;
    const frame: MotionFrame = {
      tilt: Array.from({ length: bars }, (_, bar) =>
        tiltFor(motion, bar, (span.centre[bar] ?? 0) + scissorSide(bar) * target),
      ),
    };
    if (motion?.motorSpeed && cross + open > 0) {
      const speed = curveInverse(motion.motorSpeed, (cross + open) / travelSeconds);
      if (speed !== undefined) frame.motorSpeed = clamp01(speed);
    }
    return frame;
  };
}

const scissor: MotionEffect = {
  id: 'scissor',
  name: 'Scissor',
  description:
    'The bars swing through each other like scissors, and never rest: they are sent to the crossed point on the first beat of every second bar and to the open point four beats later, and the motor speed makes them take all four beats to get there.',
  setsMotorSpeed: true,
  render: scissorRender(SCISSOR_BEATS / 2),
};

const scissorMotor: MotionEffect = {
  id: 'scissor-motor',
  name: 'Scissor, with a rest',
  description:
    'The same scissor, but the bars take three of the four beats to get to each end and stand still for the last, so every end lands on the beat with a stop before the swing back.',
  setsMotorSpeed: true,
  render: scissorRender(SCISSOR_TRAVEL_BEATS),
};

/** The beats one swing of the creep takes: four bars, slow enough to be seen coming. */
const CREEP_BEATS = 16;
/** The furthest the creep goes from the middle of what both bars can do, in degrees. */
const CREEP_DEGREES = 30;

/**
 * What both bars can reach: from the highest of their lowest angles to the lowest of their highest.
 * Without a calibration the bars reach 90 degrees either way.
 */
function commonRange(bars: number, model: MotionModel | undefined): { low: number; high: number } {
  let low = -90;
  let high = 90;
  for (let bar = 0; bar < bars; bar++) {
    const range = reachOf(model, bar);
    low = Math.max(low, range.min);
    high = Math.min(high, range.max);
  }
  return high > low ? { low, high } : { low: 0, high: 0 };
}

const creep: MotionEffect = {
  id: 'creep',
  name: 'Creep',
  description:
    'Both bars lean the same way and sweep slowly from side to side together, one swing in four bars: the beams stay parallel and stalk across the room. The motor speed is set so the sweep takes the whole eight beats.',
  setsMotorSpeed: true,
  render(context) {
    const { low, high } = commonRange(context.bars, context.motion);
    const reach = Math.min(CREEP_DEGREES, (high - low) / 2);
    const middle = (low + high) / 2;
    // To the right on beat 4 of the cycle and to the left on beat 12, as the sweep of the beat was.
    return pathFrame(context, () => ({
      leg: CREEP_BEATS / 2,
      first: CREEP_BEATS / 4,
      degrees: (arrival) => middle + endOf(arrival) * reach,
    }));
  },
};

/** The beats of one swing of a bar in the drift: the back bar takes four bars and the front bar six. */
const DRIFT_BEATS = [16, 24];

const drift: MotionEffect = {
  id: 'drift',
  name: 'Drift',
  description:
    'Each bar swings slowly on its own, the back bar in four bars and the front bar in six, so the beams drift apart and cross each other at other places every time. There is one motor speed, so the back bar swings a shorter way than the front bar to make the same speed.',
  setsMotorSpeed: true,
  render(context) {
    const { cross, open, centre } = scissorSpan(context.bars, context.motion);
    const middle = (cross - open) / 2;
    const reach = (cross + open) / 2;
    const longest = Math.max(...DRIFT_BEATS);
    // The bars share the motor speed, so the one with the shorter leg goes a proportionally shorter
    // way and both move at the same speed. The ends are where the sine of the beat had its peaks.
    return pathFrame(context, (bar) => {
      const cycle = DRIFT_BEATS[bar % 2] ?? CREEP_BEATS;
      const amplitude = (reach * cycle) / longest;
      return {
        leg: cycle / 2,
        first: cycle / 4,
        degrees: (arrival) =>
          (centre[bar] ?? 0) + scissorSide(bar) * (middle + endOf(arrival) * amplitude),
      };
    });
  },
};

/** How long the slice stays in one position, in beats. */
const SLICE_BEATS = 2;

const slice: MotionEffect = {
  id: 'slice',
  name: 'Slice',
  description:
    'The bars snap to a new position every two beats: the beams crossed, fanned out, both pointing back and both pointing forward. It sets the motor speed to the fastest, so that they get there at once.',
  setsMotorSpeed: true,
  render({ beat, bars, motion }) {
    const { cross, open, centre } = scissorSpan(bars, motion);
    const parallel = Math.min(cross, open);
    // Back bar and front bar: where each stands in degrees, positive to the front.
    const positions: readonly (readonly [number, number])[] = [
      [cross, -cross],
      [-open, open],
      [-parallel, -parallel],
      [parallel, parallel],
    ];
    const [back, front] = positions[mod(Math.floor(beat / SLICE_BEATS), positions.length)] ?? [
      0, 0,
    ];
    const frame: MotionFrame = {
      tilt: Array.from({ length: bars }, (_, bar) =>
        tiltFor(motion, bar, (centre[bar] ?? 0) + (bar % 2 === 0 ? back : front)),
      ),
    };
    // The fastest the motor goes: the first byte that gives that, which is where the fast end is.
    const rates = motion?.motorSpeed ? curveRange(motion.motorSpeed) : undefined;
    if (motion?.motorSpeed && rates) {
      const fastest = curveInverse(motion.motorSpeed, rates.max);
      if (fastest !== undefined) frame.motorSpeed = clamp01(fastest);
    }
    return frame;
  },
};

export const MOTION_EFFECTS: readonly MotionEffect[] = [
  tiltWave,
  scissor,
  scissorMotor,
  creep,
  drift,
  slice,
];

export function findMotionEffect(id: string): MotionEffect | undefined {
  return MOTION_EFFECTS.find((effect) => effect.id === id);
}
