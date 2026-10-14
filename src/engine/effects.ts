/**
 * Beat-synced light effects for a fixture made of colour cells on tilting bars.
 *
 * An effect is a pure function from a moment in the music to a picture: given the beat, it
 * returns for every cell how much of each slot of the palette that cell gets. No timers and
 * no state in here, so every effect is reproducible and can be tested frame by frame.
 *
 * A light effect knows no colour. Slot 1 is the main colour, what flashes, hits or moves;
 * slot 2 is the backdrop, what the rest of the lenses show; slot 3 is an accent. The palette
 * (`palette.ts`) says what the slots are, and a slot it does not have, or has as off, is a
 * dark lens. Three effects use the third slot for something extra, and only when the palette
 * has one (`slots` in the context): the kick on the first beat of a bar, the tail of the
 * chase, and now and then a spark. Without it they look as they do with two.
 *
 * Most of them show the second colour as a backdrop, a wash under the hits. The techno effects
 * (`cross`, `ticktock`, `scan`, `pairs`, `stab`) do not: they use the two colours as two colours
 * that take turns, light only one or two lenses at a time, and leave every other lens dark. With
 * one colour the turns of the second colour are dark, so it is a beam that blinks.
 *
 * Moving the bars is not in here: that is a motion effect (`motionEffects.ts`). The two are
 * apart, so any of one goes with any of the other.
 *
 * Brightness lives in the levels. The fixture's master dimmer stays with the operator.
 *
 * At speed 1 an effect changes once per beat at most: a chase takes one step per beat, a
 * flash comes on the beat. What moves smoothly, such as the wave, takes a bar or more
 * for one cycle. Faster and slower is a matter of the speed, which scales the beat that
 * an effect is given. Whoever renders an effect limits that speed with `limitSpeed`, so
 * that nothing flashes more often than `MAX_FLASH_HZ`.
 */

import { clamp01 } from '../model/fixture.js';
import { frac, hit, mod, noise, TAU } from './beat.js';

export type { Rgbw } from './colour.js';

export interface EffectContext {
  /** Beats since the tempo was last synced, as a fraction. Already scaled by the speed. */
  beat: number;
  /** Number of colour cells. */
  cells: number;
  /** 0-based cell indices per bar, in order along the bar. */
  bars: readonly (readonly number[])[];
  /** How many entries the palette has, which is how many slots there are. */
  slots: number;
}

export interface EffectFrame {
  /**
   * Per cell, how much of each slot of the palette it gets, 0..1. The first number is slot 1.
   * A slot that is not named gets nothing.
   */
  levels: number[][];
}

export interface Effect {
  id: string;
  name: string;
  /** One sentence for the operator. */
  description: string;
  /**
   * How many slots of the palette it uses, at most, so that the page can say so. A slot that
   * the palette does not have is off.
   */
  slots: number;
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

/** The main colour at `main` and the backdrop for the rest. */
const over = (main: number): number[] => [main, 1 - main];

function fill(cells: number, levels: (index: number) => number[]): number[][] {
  return Array.from({ length: cells }, (_, i) => levels(i));
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
    'Every lens hits on the beat in the main colour and falls back to the second, like the kick drum. The first beat of each bar rings a little longer, and with a third colour it hits in that.',
  slots: 3,
  render({ beat, cells, slots }) {
    const downbeat = mod(Math.floor(beat), 4) === 0;
    const level = hit(beat, downbeat ? 3.5 : 5);
    const accent = downbeat && slots >= 3;
    return { levels: fill(cells, () => (accent ? [0, 1 - level, level] : over(level))) };
  },
};

const chase: Effect = {
  id: 'chase',
  name: 'Chase',
  description:
    'One bright lens of the main colour steps along all eight with a fading tail, one lens per beat, over the second colour. With a third colour the tail is in that.',
  slots: 3,
  render({ beat, cells, slots }) {
    const head = mod(Math.floor(beat), cells);
    return {
      levels: fill(cells, (i) => {
        const behind = (head - i + cells) % cells;
        const level = Math.exp(-1.3 * behind);
        return behind > 0 && slots >= 3 ? [0, 1 - level, level] : over(level);
      }),
    };
  },
};

const bounce: Effect = {
  id: 'bounce',
  name: 'Bounce',
  description:
    'A spot of the main colour steps to the far end and back, one lens per beat, over the second colour.',
  slots: 2,
  render({ beat, cells }) {
    // There in as many beats as there are lenses, and back in as many, so with eight
    // lenses it turns around on the bar.
    const step = mod(Math.floor(beat), 2 * cells);
    const position = step < cells ? step : 2 * cells - 1 - step;
    return {
      levels: fill(cells, (i) => {
        const near = clamp01(1 - Math.abs(i - position) / 1.4);
        return over(near * near);
      }),
    };
  },
};

const swap: Effect = {
  id: 'swap',
  name: 'Bar swap',
  description:
    'The two bars answer each other: bar 1 hits in the main colour, bar 2 on the next beat, each falling back to the second.',
  slots: 2,
  render({ beat, cells, bars }) {
    const count = Math.max(bars.length, 1);
    const lit = mod(Math.floor(beat), count);
    const level = hit(beat, 3.5);
    return { levels: fill(cells, (i) => (barOf(bars, i) === lit ? over(level) : over(0))) };
  },
};

const wave: Effect = {
  id: 'wave',
  name: 'Wave',
  description:
    'A smooth wave rolls along the lenses: its crest is the main colour and its troughs the second.',
  slots: 2,
  render({ beat, cells }) {
    return {
      levels: fill(cells, (i) => {
        const swell = 0.5 + 0.5 * Math.sin(TAU * (beat / 4 - i / cells));
        return over(swell * swell);
      }),
    };
  },
};

const sparkle: Effect = {
  id: 'sparkle',
  name: 'Sparkle',
  description:
    'Single lenses flash in the main colour over a wash of the second, at random, other lenses on every beat. With a third colour now and then a spark is in that.',
  slots: 3,
  render({ beat, cells, slots }) {
    const step = Math.floor(beat);
    const level = hit(beat, 3);
    return {
      levels: fill(cells, (i) => {
        if (noise(step, i) >= 0.22) return over(0);
        return slots >= 3 && noise(step, i + 101) < 0.3 ? [0, 1 - level, level] : over(level);
      }),
    };
  },
};

const build: Effect = {
  id: 'build',
  name: 'Build-up',
  description:
    'Eight bars of tension: flashes of the main colour get faster and brighter and spread from the middle outwards over the second, then everything drops on the main colour.',
  slots: 2,
  render({ beat, cells }) {
    const position = mod(beat, BUILD_BEATS);
    const last = BUILD_BEATS - 1;
    if (position >= last) return { levels: fill(cells, () => over(hit(position, 2.2))) };

    const progress = position / last;
    // A flash every bar, then every two beats, then on every beat.
    const every = position < 16 ? 4 : position < 24 ? 2 : 1;
    const on = frac(position / every) < 0.5;
    const level = on ? 0.2 + 0.8 * progress : 0;
    // Lenses join in from the middle outwards as the tension rises, on the beat.
    const reach = 0.5 + (Math.floor(position) / last) * (cells / 2);
    const middle = (cells - 1) / 2;
    return {
      levels: fill(cells, (i) => (Math.abs(i - middle) <= reach ? over(level) : over(0))),
    };
  },
};

const burst: Effect = {
  id: 'burst',
  name: 'Strobe burst',
  description:
    'Three bars of kick in the main colour over the second, then a bar of hard flashes of the main colour on the beat.',
  slots: 2,
  render({ beat, cells }) {
    if (mod(beat, 16) < 12) {
      const level = 0.05 + 0.6 * hit(beat, 5);
      return { levels: fill(cells, () => over(level)) };
    }
    const on = frac(beat) < 0.4;
    return { levels: fill(cells, () => over(on ? 1 : 0)) };
  },
};

const pump: Effect = {
  id: 'pump',
  name: 'Pump',
  description:
    'All lenses breathe on the beat: a soft pump in the main colour over the second. It is made to go with a motion effect.',
  slots: 2,
  render({ beat, cells }) {
    return { levels: fill(cells, () => over(0.7 + 0.3 * hit(beat, 3))) };
  },
};

const solid: Effect = {
  id: 'solid',
  name: 'Solid',
  description: 'Every lens in the main colour, and no movement of light. The plainest wash.',
  slots: 1,
  render({ cells }) {
    return { levels: fill(cells, () => [1]) };
  },
};

const bars: Effect = {
  id: 'bars',
  name: 'Bars',
  description: 'The first bar in the main colour and the second bar in the second colour.',
  slots: 2,
  render({ cells, bars: layout }) {
    return { levels: fill(cells, (i) => (barOf(layout, i) === 0 ? [1] : [0, 1])) };
  },
};

const alternate: Effect = {
  id: 'alternate',
  name: 'Alternate',
  description:
    'The lenses take turns along the bars: one in the main colour, the next in the second.',
  slots: 2,
  render({ cells }) {
    return { levels: fill(cells, (i) => (i % 2 === 0 ? [1] : [0, 1])) };
  },
};

const spread: Effect = {
  id: 'spread',
  name: 'Spread',
  description:
    'The colours of the palette spread over the eight lenses, in bands, pumping gently on the beat. With a palette that cycles they turn along the lenses, like a rainbow.',
  slots: 8,
  render({ beat, cells, slots }) {
    const pumped = 0.65 + 0.35 * hit(beat, 4);
    const bands = Math.max(1, Math.min(slots, cells));
    return {
      levels: fill(cells, (i) => {
        const slot = Math.floor((i * bands) / cells);
        return [...Array.from({ length: slot }, () => 0), pumped];
      }),
    };
  },
};

/** How a hit of a techno effect falls: fast, so that a beam is a stab and not a glow. */
const STAB = 5;

/** The levels of a lens that is dark. */
const DARK: number[] = [];

/** A lens that hits in slot 1 or in slot 2: `second` says which. */
const lit = (level: number, second: boolean): number[] => (second ? [0, level] : [level]);

/**
 * Cells with all dark but the ones named: `beams` maps a cell to its levels. A cell named twice
 * keeps the first.
 */
function only(cells: number, beams: readonly (readonly [number, number[]])[]): number[][] {
  const levels = fill(cells, () => DARK);
  for (const [cell, shown] of [...beams].reverse()) {
    if (cell >= 0 && cell < cells) levels[cell] = shown;
  }
  return levels;
}

const cross: Effect = {
  id: 'cross',
  name: 'Cross',
  description:
    'Two beams cross: the first colour steps from one end to the other, one lens per beat, while the second colour steps the other way. Every other lens is dark.',
  slots: 2,
  render({ beat, cells }) {
    const step = mod(Math.floor(beat), cells);
    const level = hit(beat, STAB);
    return {
      levels: only(cells, [
        [step, lit(level, false)],
        [cells - 1 - step, lit(level, true)],
      ]),
    };
  },
};

const ticktock: Effect = {
  id: 'ticktock',
  name: 'Tick-tock',
  description:
    'One beam on every beat, in turn: the first colour on the left half, the second on the right half, both stepping in from the outside. Every other lens is dark.',
  slots: 2,
  render({ beat, cells }) {
    const whole = Math.floor(beat);
    const half = Math.max(1, Math.floor(cells / 2));
    const place = mod(Math.floor(whole / 2), half);
    const right = mod(whole, 2) === 1;
    const lens = right ? cells - 1 - place : place;
    return { levels: only(cells, [[lens, lit(hit(beat, STAB), right)]]) };
  },
};

const scan: Effect = {
  id: 'scan',
  name: 'Scan',
  description:
    'A single hard beam goes along the lenses, one per beat, in the first colour, and comes back in the second colour. Every other lens is dark.',
  slots: 2,
  render({ beat, cells }) {
    const step = mod(Math.floor(beat), 2 * cells);
    const back = step >= cells;
    const lens = back ? 2 * cells - 1 - step : step;
    return { levels: only(cells, [[lens, lit(hit(beat, STAB), back)]]) };
  },
};

const pairs: Effect = {
  id: 'pairs',
  name: 'Pairs',
  description:
    'Two lenses, one on each side of the middle, hit together on the beat. The first colour is the pair on the outside, the second colour the pair on the inside, and they take turns. Every other lens is dark.',
  slots: 2,
  render({ beat, cells }) {
    const whole = Math.floor(beat);
    const half = Math.max(1, Math.floor(cells / 2));
    const place = mod(Math.floor(whole / 2), half);
    const inside = mod(whole, 2) === 1;
    // Outside to inside on the beats of the first colour, and inside to outside on the others.
    const pair = inside ? half - 1 - place : place;
    const shown = lit(hit(beat, STAB), inside);
    return {
      levels: only(cells, [
        [pair, shown],
        [cells - 1 - pair, shown],
      ]),
    };
  },
};

/** A step along the lenses that reaches every lens before it comes round, and is a jump, not a neighbour. */
function jump(cells: number): number {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  for (let step = Math.round(cells * 0.6); step < cells * 2; step++) {
    if (step % cells !== 0 && gcd(step, cells) === 1) return step;
  }
  return 1;
}

const stab: Effect = {
  id: 'stab',
  name: 'Stab',
  description:
    'One lens stabs in the first colour, and again in the second colour on the next beat. After two beats it jumps to a lens far away, and goes round all of them. Every other lens is dark.',
  slots: 2,
  render({ beat, cells }) {
    const whole = Math.floor(beat);
    const turn = Math.floor(whole / 2);
    // The jumps shift by one lens every time they have been round all the lenses once.
    const lens = mod(turn * jump(cells) + Math.floor(turn / cells), cells);
    return { levels: only(cells, [[lens, lit(hit(beat, STAB), mod(whole, 2) === 1)]]) };
  },
};

/** One slow fade from the first colour to the second and back takes this many beats at speed 1. */
const FADE_BEATS = 8;

const fade: Effect = {
  id: 'fade',
  name: 'Fade',
  description:
    'All lenses fade slowly from the first colour to the second and back, one fade in two bars, with nothing hard in it. With a second colour that is off it is a slow breath of light. Calm: it is made to go with a motion effect that holds still.',
  slots: 2,
  render({ beat, cells }) {
    const toSecond = 0.5 - 0.5 * Math.cos(TAU * (beat / FADE_BEATS));
    return { levels: fill(cells, () => [1 - toSecond, toSecond]) };
  },
};

const seesaw: Effect = {
  id: 'seesaw',
  name: 'Seesaw',
  description:
    'The two bars fade against each other, slowly, one fade in two bars: while one bar glows in the first colour the other is in the second colour, and they swap. With a second colour that is off one bar is always glowing and the other is dark. Calm.',
  slots: 2,
  render({ beat, cells, bars }) {
    const toSecond = 0.5 - 0.5 * Math.cos(TAU * (beat / FADE_BEATS));
    return {
      levels: fill(cells, (i) => {
        // A lens that is on no bar goes with the first bar.
        const other = mod(Math.max(barOf(bars, i), 0), 2) === 1;
        return other ? [toSecond, 1 - toSecond] : [1 - toSecond, toSecond];
      }),
    };
  },
};

/** Beats one lens of the glow takes: a pool of light moves one lens in two beats at speed 1. */
const GLOW_BEATS_PER_LENS = 2;
/** How far a lens still shows the glow from its middle, in lenses. */
const GLOW_REACH = 1.75;

const glow: Effect = {
  id: 'glow',
  name: 'Glow',
  description:
    'A soft pool of light travels slowly along the lenses, one lens in two beats: three lenses at the most glow at once, and each fades into the next. The first colour is the heart of the pool and the second colour its edge. Calm.',
  slots: 2,
  render({ beat, cells }) {
    const centre = mod(beat / GLOW_BEATS_PER_LENS, cells);
    return {
      levels: fill(cells, (i) => {
        const gap = Math.abs(i - centre);
        const distance = Math.min(gap, cells - gap);
        if (distance >= GLOW_REACH) return DARK;
        const level = Math.cos((Math.PI / 2) * (distance / GLOW_REACH)) ** 2;
        // The heart is the first colour, the edge turns to the second.
        return [level * level, level * (1 - level)];
      }),
    };
  },
};

/** How long a flash of the strobe is on, as a share of a beat. */
const FLASH = 0.3;

const strobe: Effect = {
  id: 'strobe',
  name: 'Strobe',
  description:
    'All lenses flash hard on every beat, the first colour and the second colour in turn. Faster speeds flash more often, and never more than ten times per second.',
  slots: 2,
  render({ beat, cells }) {
    const on = frac(beat) < FLASH;
    const second = mod(Math.floor(beat), 2) === 1;
    return { levels: fill(cells, () => (on ? lit(1, second) : DARK)) };
  },
};

export const EFFECTS: readonly Effect[] = [
  kick,
  chase,
  bounce,
  swap,
  wave,
  sparkle,
  build,
  burst,
  pump,
  solid,
  bars,
  alternate,
  spread,
  cross,
  ticktock,
  scan,
  pairs,
  stab,
  fade,
  strobe,
  seesaw,
  glow,
];

export function findEffect(id: string): Effect | undefined {
  return EFFECTS.find((effect) => effect.id === id);
}
