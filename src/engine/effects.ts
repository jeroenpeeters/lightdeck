/**
 * Beat-synced effects for a fixture made of colour cells on tilting bars.
 *
 * An effect is a pure function from a moment in the music to a picture: given the
 * beat, the tempo and two colours, it returns a colour for every cell and, for
 * effects that move, a tilt per bar. No timers and no state in here, so every effect
 * is reproducible and can be tested frame by frame.
 *
 * The first colour is the foreground: what flashes, hits or moves. The second is the
 * background: what the rest of the lenses show. An operator who leaves the second colour
 * empty gets the first colour dim there (`palette`), so an effect never sees an empty
 * colour and one colour is enough for every effect.
 *
 * Brightness lives in the cell colours. The fixture's master dimmer stays with the
 * operator.
 *
 * At speed 1 an effect changes once per beat at most: a chase takes one step per beat, a
 * flash comes on the beat. What moves smoothly, such as the wave, takes a bar or more
 * for one cycle. Faster and slower is a matter of the speed, which scales the beat that
 * an effect is given. Whoever renders an effect limits that speed with `limitSpeed`, so
 * that nothing flashes more often than `MAX_FLASH_HZ`.
 */

import { clamp01 } from '../model/fixture.js';
import { type Curve, curveInverse, curveRange } from './curve.js';

export interface Rgbw {
  red: number;
  green: number;
  blue: number;
  white: number;
}

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

export interface EffectContext {
  /** Beats since the tempo was last synced, as a fraction. Already scaled by the speed. */
  beat: number;
  /** Effective tempo in beats per minute, speed included. */
  bpm: number;
  /** Number of colour cells. */
  cells: number;
  /** 0-based cell indices per bar, in order along the bar. */
  bars: readonly (readonly number[])[];
  /** The foreground colour: what flashes, hits or moves. */
  a: Rgbw;
  /** The background colour: what the rest shows. See `palette` for when it was left empty. */
  b: Rgbw;
  /** How the bars turn, when the fixture says. */
  motion?: MotionModel;
}

export interface EffectFrame {
  cells: Rgbw[];
  /** Tilt 0..1 per bar. Absent when the effect leaves the bars where the operator put them. */
  tilt?: number[];
  /**
   * Motor speed 0..1. Absent when the effect leaves it with the operator, which is what every
   * effect does but the ones that say `setsMotorSpeed`.
   */
  motorSpeed?: number;
}

export interface Effect {
  id: string;
  name: string;
  /** One sentence for the operator. */
  description: string;
  /** Which palette colours the effect uses, so the page can say so. */
  colours: 'both' | 'first' | 'none';
  /** True when the effect tilts the bars. */
  moves: boolean;
  /** True when the effect also sets the motor speed, if it can work it out, so the page says so. */
  setsMotorSpeed?: boolean;
  render(context: EffectContext): EffectFrame;
}

/** Upper limit for full-brightness flashing, in flashes per second. */
export const MAX_FLASH_HZ = 10;

/**
 * The speeds to choose from, relative to the tempo. They go for the effect of a fixture
 * and for the console as a whole, and the two multiply.
 */
export const SPEEDS: readonly number[] = [0.25, 0.5, 1, 2, 4];

/**
 * The speed an effect gets: the speed that is wanted, halved until a change on every
 * beat stays at or below `MAX_FLASH_HZ`. So four times the speed at 126 beats per minute
 * is given, and at 160 it falls back to twice.
 */
export function limitSpeed(bpm: number, wanted: number): number {
  let speed = wanted;
  while ((bpm / 60) * speed > MAX_FLASH_HZ) speed /= 2;
  return speed;
}

/** How bright the background is when the second colour was left empty: the first colour, dim. */
export const REST_LEVEL = 0.07;

/**
 * The two colours an effect is given, from what the operator chose. The second colour may
 * be empty (`null`), and then the background is the first colour at `REST_LEVEL`.
 */
export function palette(a: Rgbw, b: Rgbw | null): { a: Rgbw; b: Rgbw } {
  return { a, b: b ?? scale(a, REST_LEVEL) };
}

const TAU = Math.PI * 2;

const frac = (x: number) => x - Math.floor(x);
/** Remainder that is never negative. */
const mod = (x: number, n: number) => ((x % n) + n) % n;

function scale(colour: Rgbw, level: number): Rgbw {
  const k = clamp01(level);
  return {
    red: clamp01(colour.red) * k,
    green: clamp01(colour.green) * k,
    blue: clamp01(colour.blue) * k,
    white: clamp01(colour.white) * k,
  };
}

function mix(from: Rgbw, to: Rgbw, t: number): Rgbw {
  const k = clamp01(t);
  return {
    red: from.red + (to.red - from.red) * k,
    green: from.green + (to.green - from.green) * k,
    blue: from.blue + (to.blue - from.blue) * k,
    white: from.white + (to.white - from.white) * k,
  };
}

function hue(h: number): Rgbw {
  const x = frac(h) * 6;
  const rise = clamp01(x - Math.floor(x));
  const fall = 1 - rise;
  switch (Math.floor(x) % 6) {
    case 0:
      return { red: 1, green: rise, blue: 0, white: 0 };
    case 1:
      return { red: fall, green: 1, blue: 0, white: 0 };
    case 2:
      return { red: 0, green: 1, blue: rise, white: 0 };
    case 3:
      return { red: 0, green: fall, blue: 1, white: 0 };
    case 4:
      return { red: rise, green: 0, blue: 1, white: 0 };
    default:
      return { red: 1, green: 0, blue: fall, white: 0 };
  }
}

/** Sharp attack on the beat, then an exponential fall. 1 at the start of each period. */
function hit(position: number, sharpness: number): number {
  return Math.exp(-sharpness * frac(position));
}

/** Repeatable pseudo-random number 0..1 from two integers. */
function noise(a: number, b: number): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function fill(cells: number, colour: (index: number) => Rgbw): Rgbw[] {
  return Array.from({ length: cells }, (_, i) => colour(i));
}

/** Bar number of a cell, or -1 when it is on none. */
function barOf(bars: EffectContext['bars'], cell: number): number {
  return bars.findIndex((bar) => bar.includes(cell));
}

/** How long the build-up takes: eight bars. */
const BUILD_BEATS = 32;

const kick: Effect = {
  id: 'kick',
  name: 'Kick',
  description:
    'Every lens hits on the beat in the first colour and falls back to the second, like the kick drum. The first beat of each bar rings a little longer.',
  colours: 'both',
  moves: false,
  render({ beat, cells, a, b }) {
    const downbeat = mod(Math.floor(beat), 4) === 0;
    return { cells: fill(cells, () => mix(b, a, hit(beat, downbeat ? 3.5 : 5))) };
  },
};

const chase: Effect = {
  id: 'chase',
  name: 'Chase',
  description:
    'One bright lens of the first colour steps along all eight with a fading tail, one lens per beat, over the second colour.',
  colours: 'both',
  moves: false,
  render({ beat, cells, a, b }) {
    const head = mod(Math.floor(beat), cells);
    return {
      cells: fill(cells, (i) => {
        const behind = (head - i + cells) % cells;
        return mix(b, a, Math.exp(-1.3 * behind));
      }),
    };
  },
};

const bounce: Effect = {
  id: 'bounce',
  name: 'Bounce',
  description:
    'A spot of the first colour steps to the far end and back, one lens per beat, over the second colour.',
  colours: 'both',
  moves: false,
  render({ beat, cells, a, b }) {
    // There in as many beats as there are lenses, and back in as many, so with eight
    // lenses it turns around on the bar.
    const step = mod(Math.floor(beat), 2 * cells);
    const position = step < cells ? step : 2 * cells - 1 - step;
    return {
      cells: fill(cells, (i) => {
        const near = clamp01(1 - Math.abs(i - position) / 1.4);
        return mix(b, a, near * near);
      }),
    };
  },
};

const swap: Effect = {
  id: 'swap',
  name: 'Bar swap',
  description:
    'The two bars answer each other: bar 1 hits in the first colour, bar 2 on the next beat, each falling back to the second.',
  colours: 'both',
  moves: false,
  render({ beat, cells, bars, a, b }) {
    const count = Math.max(bars.length, 1);
    const lit = mod(Math.floor(beat), count);
    const level = hit(beat, 3.5);
    return {
      cells: fill(cells, (i) => (barOf(bars, i) === lit ? mix(b, a, level) : b)),
    };
  },
};

const wave: Effect = {
  id: 'wave',
  name: 'Wave',
  description:
    'A smooth wave rolls along the lenses: its crest is the first colour and its troughs the second.',
  colours: 'both',
  moves: false,
  render({ beat, cells, a, b }) {
    return {
      cells: fill(cells, (i) => {
        const swell = 0.5 + 0.5 * Math.sin(TAU * (beat / 4 - i / cells));
        return mix(b, a, swell * swell);
      }),
    };
  },
};

const spectrum: Effect = {
  id: 'spectrum',
  name: 'Spectrum',
  description:
    'The full rainbow spread over the eight lenses, turning slowly and pumping gently on the beat. Ignores the chosen colours.',
  colours: 'none',
  moves: false,
  render({ beat, cells }) {
    const pump = 0.65 + 0.35 * hit(beat, 4);
    return { cells: fill(cells, (i) => scale(hue(beat / 16 + i / cells), pump)) };
  },
};

const sparkle: Effect = {
  id: 'sparkle',
  name: 'Sparkle',
  description:
    'Single lenses flash in the first colour over a wash of the second, at random, other lenses on every beat.',
  colours: 'both',
  moves: false,
  render({ beat, cells, a, b }) {
    const slot = Math.floor(beat);
    const level = hit(beat, 3);
    return {
      cells: fill(cells, (i) => (noise(slot, i) < 0.22 ? mix(b, a, level) : b)),
    };
  },
};

const build: Effect = {
  id: 'build',
  name: 'Build-up',
  description:
    'Eight bars of tension: flashes of the first colour get faster and brighter and spread from the middle outwards over the second, then everything drops on the first.',
  colours: 'both',
  moves: false,
  render({ beat, cells, a, b }) {
    const position = mod(beat, BUILD_BEATS);
    const last = BUILD_BEATS - 1;
    if (position >= last) return { cells: fill(cells, () => mix(b, a, hit(position, 2.2))) };

    const progress = position / last;
    // A flash every bar, then every two beats, then on every beat.
    const every = position < 16 ? 4 : position < 24 ? 2 : 1;
    const on = frac(position / every) < 0.5;
    const level = on ? 0.2 + 0.8 * progress : 0;
    // Lenses join in from the middle outwards as the tension rises, on the beat.
    const reach = 0.5 + (Math.floor(position) / last) * (cells / 2);
    const middle = (cells - 1) / 2;
    return {
      cells: fill(cells, (i) => (Math.abs(i - middle) <= reach ? mix(b, a, level) : b)),
    };
  },
};

const burst: Effect = {
  id: 'burst',
  name: 'Strobe burst',
  description:
    'Three bars of kick in the first colour over the second, then a bar of hard flashes of the first colour on the beat.',
  colours: 'both',
  moves: false,
  render({ beat, cells, a, b }) {
    if (mod(beat, 16) < 12) {
      const level = 0.05 + 0.6 * hit(beat, 5);
      return { cells: fill(cells, () => mix(b, a, level)) };
    }
    const on = frac(beat) < 0.4;
    return { cells: fill(cells, () => (on ? a : b)) };
  },
};

const tiltWave: Effect = {
  id: 'tiltwave',
  name: 'Tilt wave',
  description:
    'The tilts of the two bars rise and fall against each other on a slow wave, one cycle every two bars, with a soft pump on the beat in the first colour over the second.',
  colours: 'both',
  moves: true,
  render({ beat, cells, bars, a, b }) {
    const swing = 0.3 * Math.sin(TAU * (beat / 8));
    const pump = 0.7 + 0.3 * hit(beat, 3);
    return {
      cells: fill(cells, () => mix(b, a, pump)),
      tilt: bars.map((_, bar) => clamp01(0.5 + (bar % 2 === 0 ? swing : -swing))),
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

const scissor: Effect = {
  id: 'scissor',
  name: 'Scissor',
  description:
    'The bars swing through each other like scissors, on a smooth curve of the beat: the beams cross on the first beat of every second bar and are furthest apart four beats later, with a soft pump on the beat.',
  colours: 'both',
  moves: true,
  render({ beat, cells, bars, a, b, motion }) {
    const pump = 0.7 + 0.3 * hit(beat, 3);
    const { cross, open } = scissorSpan(bars.length, motion);
    const swing =
      (cross - open) / 2 + ((cross + open) / 2) * Math.cos(TAU * (beat / SCISSOR_BEATS));
    return {
      cells: fill(cells, () => mix(b, a, pump)),
      tilt: bars.map((_, bar) => tiltFor(motion, bar, scissorSide(bar) * swing)),
    };
  },
};

const scissorMotor: Effect = {
  id: 'scissor-motor',
  name: 'Scissor, by motor speed',
  description:
    'The same scissor, but the bars are sent to their end point only twice per cycle, and the motor speed is set to make them take three of the four beats to get there.',
  colours: 'both',
  moves: true,
  setsMotorSpeed: true,
  render({ beat, bpm, cells, bars, a, b, motion }) {
    const pump = 0.7 + 0.3 * hit(beat, 3);
    const travelSeconds = (SCISSOR_TRAVEL_BEATS * 60) / bpm;
    let { cross, open } = scissorSpan(bars.length, motion);
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
    const frame: EffectFrame = {
      cells: fill(cells, () => mix(b, a, pump)),
      tilt: bars.map((_, bar) => tiltFor(motion, bar, scissorSide(bar) * target)),
    };
    if (motion?.motorSpeed && cross + open > 0) {
      const speed = curveInverse(motion.motorSpeed, (cross + open) / travelSeconds);
      if (speed !== undefined) frame.motorSpeed = clamp01(speed);
    }
    return frame;
  },
};

export const EFFECTS: readonly Effect[] = [
  kick,
  chase,
  bounce,
  swap,
  wave,
  spectrum,
  sparkle,
  build,
  burst,
  tiltWave,
  scissor,
  scissorMotor,
];

export function findEffect(id: string): Effect | undefined {
  return EFFECTS.find((effect) => effect.id === id);
}
