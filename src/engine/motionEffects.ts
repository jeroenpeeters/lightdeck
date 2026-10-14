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
 * The speed works as it does for light effects: it scales the beat, and whoever renders an
 * effect limits it with `limitSpeed`. The tilt wave and the scissors take a bar or more for
 * one cycle at speed 1.
 */

import { clamp01 } from '../model/fixture.js';
import { mod, TAU } from './beat.js';
import { type Curve, curveInverse, curveRange } from './curve.js';

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

const tiltWave: MotionEffect = {
  id: 'tiltwave',
  name: 'Tilt wave',
  description:
    'The tilts of the two bars rise and fall against each other on a slow wave, one cycle every two bars. With the bars turning opposite ways for the same tilt, this moves them the same way in space.',
  render({ beat, bars }) {
    const swing = 0.3 * Math.sin(TAU * (beat / 8));
    return {
      tilt: Array.from({ length: bars }, (_, bar) =>
        clamp01(0.5 + (bar % 2 === 0 ? swing : -swing)),
      ),
    };
  },
};

/** What a bar does when the fixture gives no calibration: 90 degrees to the front down to 90 to the back. */
const LINEAR_TILT: Curve = [
  [0, 90],
  [1, -90],
];

/** The furthest a scissor goes to either side, in degrees, when the bars can. */
const SCISSOR_DEGREES = 60;
/** One cycle of a scissor, in beats: crossed on the first beat of the cycle, open on the fifth. */
const SCISSOR_BEATS = 8;
/**
 * The beats a bar takes for its whole swing when the motor speed does the timing. The swing is
 * over a beat before the bar reverses, so the bars stand still on the beat they have arrived.
 */
const SCISSOR_TRAVEL_BEATS = 3;

/** The tilt that puts bar number `bar` at `degrees`. */
function tiltFor(model: MotionModel | undefined, bar: number, degrees: number): number {
  const curve = model?.tilt?.[bar] ?? LINEAR_TILT;
  return clamp01(curveInverse(curve, degrees) ?? 0.5);
}

/**
 * How far a scissor can cross its beams and how far it can open them, in degrees. The bar on an
 * even place (the back bar) turns to the front and the one on an odd place to the back when the
 * beams cross, and the other way when they open, so each side is as far as the bar that reaches
 * the least that way, and no further than `SCISSOR_DEGREES`. The two are not the same when a bar
 * does not reach as far to one side as to the other, and then the swing is lopsided: that is
 * what the bars can do.
 */
function scissorSpan(
  bars: number,
  model: MotionModel | undefined,
): { cross: number; open: number } {
  let cross = SCISSOR_DEGREES;
  let open = SCISSOR_DEGREES;
  for (let bar = 0; bar < bars; bar++) {
    const range = curveRange(model?.tilt?.[bar] ?? LINEAR_TILT);
    if (!range) continue;
    const front = Math.max(0, range.max);
    const back = Math.max(0, -range.min);
    cross = Math.min(cross, bar % 2 === 0 ? front : back);
    open = Math.min(open, bar % 2 === 0 ? back : front);
  }
  return { cross, open };
}

/** Positive turns the bar to the cross side: the back bar to the front, the front bar to the back. */
const scissorSide = (bar: number) => (bar % 2 === 0 ? 1 : -1);

const scissor: MotionEffect = {
  id: 'scissor',
  name: 'Scissor',
  description:
    'The bars swing through each other like scissors, on a smooth curve of the beat: the beams cross on the first beat of every second bar and are furthest apart four beats later.',
  render({ beat, bars, motion }) {
    const { cross, open } = scissorSpan(bars, motion);
    const swing =
      (cross - open) / 2 + ((cross + open) / 2) * Math.cos(TAU * (beat / SCISSOR_BEATS));
    return {
      tilt: Array.from({ length: bars }, (_, bar) =>
        tiltFor(motion, bar, scissorSide(bar) * swing),
      ),
    };
  },
};

const scissorMotor: MotionEffect = {
  id: 'scissor-motor',
  name: 'Scissor, by motor speed',
  description:
    'The same scissor, but the bars are sent to their end point only twice per cycle, and the motor speed is set to make them take three of the four beats to get there.',
  setsMotorSpeed: true,
  render({ beat, bpm, bars, motion }) {
    const travelSeconds = (SCISSOR_TRAVEL_BEATS * 60) / bpm;
    let { cross, open } = scissorSpan(bars, motion);
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
    const crossed = mod(beat - (half - SCISSOR_TRAVEL_BEATS), SCISSOR_BEATS) >= half;
    const target = crossed ? cross : -open;
    const frame: MotionFrame = {
      tilt: Array.from({ length: bars }, (_, bar) =>
        tiltFor(motion, bar, scissorSide(bar) * target),
      ),
    };
    if (motion?.motorSpeed && cross + open > 0) {
      const speed = curveInverse(motion.motorSpeed, (cross + open) / travelSeconds);
      if (speed !== undefined) frame.motorSpeed = clamp01(speed);
    }
    return frame;
  },
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
    const range = curveRange(model?.tilt?.[bar] ?? LINEAR_TILT);
    if (!range) continue;
    low = Math.max(low, range.min);
    high = Math.min(high, range.max);
  }
  return high > low ? { low, high } : { low: 0, high: 0 };
}

const creep: MotionEffect = {
  id: 'creep',
  name: 'Creep',
  description:
    'Both bars lean the same way and sweep slowly from side to side together, one swing in four bars: the beams stay parallel and stalk across the room.',
  render({ beat, bars, motion }) {
    const { low, high } = commonRange(bars, motion);
    const reach = Math.min(CREEP_DEGREES, (high - low) / 2);
    const degrees = (low + high) / 2 + reach * Math.sin(TAU * (beat / CREEP_BEATS));
    return { tilt: Array.from({ length: bars }, (_, bar) => tiltFor(motion, bar, degrees)) };
  },
};

/** The beats of one swing of a bar in the drift: the back bar takes four bars and the front bar six. */
const DRIFT_BEATS = [16, 24];

const drift: MotionEffect = {
  id: 'drift',
  name: 'Drift',
  description:
    'Each bar swings slowly on its own, the back bar in four bars and the front bar in six, so the beams drift apart and cross each other at other places every time.',
  render({ beat, bars, motion }) {
    const { cross, open } = scissorSpan(bars, motion);
    const middle = (cross - open) / 2;
    const reach = (cross + open) / 2;
    return {
      tilt: Array.from({ length: bars }, (_, bar) => {
        const swing =
          middle + reach * Math.sin(TAU * (beat / (DRIFT_BEATS[bar % 2] ?? CREEP_BEATS)));
        return tiltFor(motion, bar, scissorSide(bar) * swing);
      }),
    };
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
    const { cross, open } = scissorSpan(bars, motion);
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
        tiltFor(motion, bar, bar % 2 === 0 ? back : front),
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
