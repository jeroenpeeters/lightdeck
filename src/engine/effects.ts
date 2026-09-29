/**
 * Beat-synced effects for a fixture made of colour cells on tilting bars.
 *
 * An effect is a pure function from a moment in the music to a picture: given the
 * beat, the tempo and two colours, it returns a colour for every cell and, for
 * effects that move, a tilt per bar. No timers and no state in here, so every effect
 * is reproducible and can be tested frame by frame.
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

export interface Rgbw {
  red: number;
  green: number;
  blue: number;
  white: number;
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
  /** First and second colour of the palette. */
  a: Rgbw;
  b: Rgbw;
}

export interface EffectFrame {
  cells: Rgbw[];
  /** Tilt 0..1 per bar. Absent when the effect leaves the bars where the operator put them. */
  tilt?: number[];
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

const BLACK: Rgbw = { red: 0, green: 0, blue: 0, white: 0 };
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
    'Every lens hits on the beat and fades, like the kick drum. The first beat of each bar takes the second colour.',
  colours: 'both',
  moves: false,
  render({ beat, cells, a, b }) {
    const downbeat = mod(Math.floor(beat), 4) === 0;
    const level = 0.06 + 0.94 * hit(beat, 5);
    return { cells: fill(cells, () => scale(downbeat ? b : a, level)) };
  },
};

const chase: Effect = {
  id: 'chase',
  name: 'Chase',
  description:
    'One bright lens steps along all eight with a fading tail, one lens per beat, over a dim second colour.',
  colours: 'both',
  moves: false,
  render({ beat, cells, a, b }) {
    const head = mod(Math.floor(beat), cells);
    return {
      cells: fill(cells, (i) => {
        const behind = (head - i + cells) % cells;
        return mix(scale(b, 0.07), a, Math.exp(-1.3 * behind));
      }),
    };
  },
};

const bounce: Effect = {
  id: 'bounce',
  name: 'Bounce',
  description:
    'A spot of light steps to the far end and back, one lens per beat, changing from the first colour to the second on the way.',
  colours: 'both',
  moves: false,
  render({ beat, cells, a, b }) {
    // There in as many beats as there are lenses, and back in as many, so with eight
    // lenses it turns around on the bar.
    const step = mod(Math.floor(beat), 2 * cells);
    const position = step < cells ? step : 2 * cells - 1 - step;
    const colour = mix(a, b, cells > 1 ? position / (cells - 1) : 0);
    return {
      cells: fill(cells, (i) => {
        const near = clamp01(1 - Math.abs(i - position) / 1.4);
        return scale(colour, near * near);
      }),
    };
  },
};

const swap: Effect = {
  id: 'swap',
  name: 'Bar swap',
  description:
    'The two bars answer each other: bar 1 hits in the first colour, bar 2 on the next beat in the second.',
  colours: 'both',
  moves: false,
  render({ beat, cells, bars, a, b }) {
    const count = Math.max(bars.length, 1);
    const lit = mod(Math.floor(beat), count);
    const level = hit(beat, 3.5);
    return {
      cells: fill(cells, (i) => {
        const bar = barOf(bars, i);
        if (bar !== lit) return scale(bar % 2 === 0 ? a : b, 0.04);
        return scale(bar % 2 === 0 ? a : b, level);
      }),
    };
  },
};

const wave: Effect = {
  id: 'wave',
  name: 'Wave',
  description:
    'Brightness rolls along the lenses as a smooth wave while the colour drifts between the two colours.',
  colours: 'both',
  moves: false,
  render({ beat, cells, a, b }) {
    return {
      cells: fill(cells, (i) => {
        const swell = 0.5 + 0.5 * Math.sin(TAU * (beat / 4 - i / cells));
        const blend = 0.5 + 0.5 * Math.sin(TAU * (beat / 8 + i / cells));
        return scale(mix(a, b, blend), 0.05 + 0.95 * swell * swell);
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
    'A dim wash of the first colour with single lenses flashing in the second colour, at random, other lenses on every beat.',
  colours: 'both',
  moves: false,
  render({ beat, cells, a, b }) {
    const slot = Math.floor(beat);
    const level = hit(beat, 3);
    const base = scale(a, 0.1);
    return {
      cells: fill(cells, (i) => (noise(slot, i) < 0.22 ? mix(base, b, level) : base)),
    };
  },
};

const build: Effect = {
  id: 'build',
  name: 'Build-up',
  description:
    'Eight bars of tension: the flashes get faster and brighter and spread from the middle outwards, then everything drops on the second colour.',
  colours: 'both',
  moves: false,
  render({ beat, cells, a, b }) {
    const position = mod(beat, BUILD_BEATS);
    const last = BUILD_BEATS - 1;
    if (position >= last) return { cells: fill(cells, () => scale(b, hit(position, 2.2))) };

    const progress = position / last;
    // A flash every bar, then every two beats, then on every beat.
    const every = position < 16 ? 4 : position < 24 ? 2 : 1;
    const on = frac(position / every) < 0.5;
    const level = on ? 0.2 + 0.8 * progress : 0;
    // Lenses join in from the middle outwards as the tension rises, on the beat.
    const reach = 0.5 + (Math.floor(position) / last) * (cells / 2);
    const middle = (cells - 1) / 2;
    return {
      cells: fill(cells, (i) => (Math.abs(i - middle) <= reach ? scale(a, level) : BLACK)),
    };
  },
};

const burst: Effect = {
  id: 'burst',
  name: 'Strobe burst',
  description:
    'Three bars of kick in the first colour, then a bar of hard flashes on the beat in the second colour.',
  colours: 'both',
  moves: false,
  render({ beat, cells, a, b }) {
    if (mod(beat, 16) < 12) {
      const level = 0.05 + 0.6 * hit(beat, 5);
      return { cells: fill(cells, () => scale(a, level)) };
    }
    const on = frac(beat) < 0.4;
    return { cells: fill(cells, () => (on ? scale(b, 1) : BLACK)) };
  },
};

const scissor: Effect = {
  id: 'scissor',
  name: 'Scissor',
  description:
    'The bars swing against each other, one cycle every two bars. Bar 1 holds the first colour and bar 2 the second, with a soft pump on the beat.',
  colours: 'both',
  moves: true,
  render({ beat, cells, bars, a, b }) {
    const swing = 0.3 * Math.sin(TAU * (beat / 8));
    const pump = 0.7 + 0.3 * hit(beat, 3);
    return {
      cells: fill(cells, (i) => scale(barOf(bars, i) % 2 === 0 ? a : b, pump)),
      tilt: bars.map((_, bar) => clamp01(0.5 + (bar % 2 === 0 ? swing : -swing))),
    };
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
  scissor,
];

export function findEffect(id: string): Effect | undefined {
  return EFFECTS.find((effect) => effect.id === id);
}
