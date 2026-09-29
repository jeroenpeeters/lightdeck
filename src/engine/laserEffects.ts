/**
 * Beat-synced effects for the Alien laser.
 *
 * The laser draws its own patterns. What can be set from outside is which pattern, and
 * its colour, size, place and rotation: one byte per channel, divided into ranges. An
 * effect is a pure function from a moment in the music to the bytes of the channels it
 * drives. The channels it does not drive stay with the operator, so a hand-set colour
 * change or zoom of the fixture itself goes together with an effect. No timers and no
 * state in here, so every effect can be tested frame by frame.
 *
 * Every byte comes from a range of the profile in `src/fixtures/laser.ts`, which has
 * them from the manual. An effect never drives the mode: opening and closing the laser
 * stays with the operator. Effects count in manual mode only, because that is the mode
 * in which channel 2 chooses a pattern.
 *
 * Nothing here changes more often than once per beat at speed 1. Faster and slower is a
 * matter of the speed, which scales the beat that an effect is given and which whoever
 * renders the effect limits with `limitSpeed`.
 *
 * Not in the manual, and assumed here:
 * - That the fixture follows a position or a size that changes 40 times per second.
 * - That channel 9 has seven single colours, spread evenly over its first range.
 * - That position 0 of channel 6 may mean "centred": the sweep stays above it.
 * - How small the pattern is at the end of the fixed sizes: the pulse stops at three
 *   quarters of the range.
 */

import { ALIEN_LASER_10CH, LASER_COLOURS, LASER_GATE, LASER_PATTERNS } from '../fixtures/laser.js';
import {
  type ByteRange,
  byteForStep,
  findControl,
  findRange,
  stepOfByte,
} from '../fixtures/profile.js';
import { clamp01 } from '../model/fixture.js';
import { MAX_FLASH_HZ } from './effects.js';

export interface LaserEffectContext {
  /** Beats since the tempo was last synced, as a fraction. Already scaled by the speed. */
  beat: number;
  /** Effective tempo in beats per minute, speed included. */
  bpm: number;
  /** What the operator has set: raw bytes by control name. */
  raw: Readonly<Record<string, number>>;
}

export interface LaserEffect {
  id: string;
  name: string;
  /** One sentence for the operator. */
  description: string;
  /** Names of the controls the effect sets. The others stay with the operator. */
  drives: readonly string[];
  /** The bytes of the driven controls at this moment. */
  render(context: LaserEffectContext): Record<string, number>;
}

/** The range of the mode channel in which the effects count. */
export const LASER_EFFECTS_MODE = 'manual';

/** Beats per bar. */
const BAR = 4;
/** The highest tempo an effect is given: the one at which a beat is a flash at the limit. */
const FASTEST_BPM = MAX_FLASH_HZ * 60;
/** How far into the fixed sizes the pulse shrinks the pattern. */
const PULSE_DEPTH = 0.75;

const frac = (x: number) => x - Math.floor(x);
/** Remainder that is never negative. */
const mod = (x: number, n: number) => ((x % n) + n) % n;

/** A range of the laser by control name and key. Fails at startup when it is not there. */
function range(name: string, key: string): ByteRange {
  const control = findControl(ALIEN_LASER_10CH, name);
  const found = control?.kind === 'function' ? findRange(control, key) : undefined;
  if (!found) throw new Error(`the laser has no range "${key}" on "${name}"`);
  return found;
}

/** The byte at `place` 0..1 of a range, optionally keeping off its first bytes. */
function at(found: ByteRange, place: number, skip = 0): number {
  const from = found.from + skip;
  return from + Math.round((found.to - from) * clamp01(place));
}

const PATTERN = range('program', 'pattern');
const COLOUR = range('colour', 'single');
const SIZE = range('size', 'fixed');
const POSITION = range('moveH', 'position');
const FORWARD = range('rotation', 'forward');
const REVERSE = range('rotation', 'reverse');

/** The single colours as steps of their range, the way the patterns are. */
const COLOUR_STEPS: ByteRange = { ...COLOUR, steps: LASER_COLOURS };

const patterns: LaserEffect = {
  id: 'patterns',
  name: 'Pattern chase',
  description:
    'A new pattern on every beat, in the order of the fixture, starting from the pattern you chose.',
  drives: ['program'],
  render({ beat, raw }) {
    const first = stepOfByte(PATTERN, raw.program ?? PATTERN.from);
    const step = mod(first - 1 + Math.floor(beat), LASER_PATTERNS) + 1;
    return { program: byteForStep(PATTERN, step) };
  },
};

const colours: LaserEffect = {
  id: 'colours',
  name: 'Colour chase',
  description: 'A new colour on every beat, through all the single colours of the laser.',
  drives: ['colour'],
  render({ beat }) {
    return { colour: byteForStep(COLOUR_STEPS, mod(Math.floor(beat), LASER_COLOURS) + 1) };
  },
};

const pulse: LaserEffect = {
  id: 'pulse',
  name: 'Pulse',
  description:
    'The pattern jumps to full size on the beat and shrinks until the next, like the kick drum.',
  drives: ['size'],
  render({ beat }) {
    // Larger bytes are smaller patterns, so the fall of the hit is the way up the range.
    const fallen = 1 - Math.exp(-3 * frac(beat));
    return { size: at(SIZE, fallen * PULSE_DEPTH) };
  },
};

const sweep: LaserEffect = {
  id: 'sweep',
  name: 'Sweep',
  description:
    'The pattern travels from one side to the other and back, and turns around on the beat.',
  drives: ['moveH'],
  render({ beat }) {
    const across = 0.5 - 0.5 * Math.cos(Math.PI * beat);
    return { moveH: at(POSITION, across, 1) };
  },
};

const twist: LaserEffect = {
  id: 'twist',
  name: 'Twist',
  description:
    'The pattern turns one way for a bar and the other way for the next. A higher tempo turns it faster.',
  drives: ['rotation'],
  render({ beat, bpm }) {
    const forward = mod(Math.floor(beat / BAR), 2) === 0;
    return { rotation: at(forward ? FORWARD : REVERSE, bpm / FASTEST_BPM) };
  },
};

export const LASER_EFFECTS: readonly LaserEffect[] = [patterns, colours, pulse, sweep, twist];

export function findLaserEffect(id: string): LaserEffect | undefined {
  return LASER_EFFECTS.find((effect) => effect.id === id);
}

// Fails at startup when an effect names a control the laser lacks, or takes the mode.
for (const effect of LASER_EFFECTS) {
  for (const name of effect.drives) {
    const control = findControl(ALIEN_LASER_10CH, name);
    if (control?.kind !== 'function' || name === LASER_GATE) {
      throw new Error(`the effect "${effect.id}" cannot drive "${name}"`);
    }
  }
}
