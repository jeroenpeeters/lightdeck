/**
 * Alien 500 mW RGB laser, "single head RGB scanning + pattern 2 in 1", 10 channels.
 *
 * Source: the user's manual, section "DMX channel function", kept in
 * docs/alien-500mw-laser.html. Labels and meanings are the manual's own; names and
 * titles are ours.
 *
 * Every channel of this fixture is a byte divided into ranges, so every control is a
 * function control: it rests at 0 and changes through a raw byte. Channel 1 at rest
 * is "closed light mode", so the laser stays closed until a mode is chosen.
 *
 * Not in the manual, and assumed here:
 * - How the 51 patterns lie on channel 2. They are taken to be spread evenly, five
 *   bytes each, with 255 belonging to the last pattern.
 * - What the place within the two automatic colour ranges of channel 9 does.
 * - Whether channels 3 to 10 count in auto and sound mode.
 * - That "Pattern with dots, wireless strips" on channel 10 means dots without lines.
 * - That channel 9 has seven single colours. Only the effects in
 *   `src/engine/laserEffects.ts` count on that.
 */

import { type ByteRange, defineProfile, type FunctionControl } from './profile.js';

export const LASER_PATTERNS = 51;
export const LASER_PROGRAMS = 4;
/**
 * Single colours on channel 9: red, green, blue and what two or three of them make.
 * The manual gives no number; seven is what an RGB laser can mix without dimming.
 */
export const LASER_COLOURS = 7;

const FASTER = 'the larger the value, the faster the speed';

/** The four programs of auto or sound mode on channel 2. */
function programs(mode: 'auto' | 'sound'): ByteRange[] {
  const word = mode === 'auto' ? 'Auto' : 'Sound';
  return Array.from({ length: LASER_PROGRAMS }, (_, i) => ({
    from: i * 64,
    to: i * 64 + 63,
    meaning: `${word} mode ${i + 1}`,
    key: `${mode}${i + 1}`,
    name: `Program ${i + 1}`,
    when: { control: 'mode', key: mode },
  }));
}

/** A channel whose lower half sets a position and whose upper half a speed. */
function positionOrSpeed(
  name: string,
  channel: number,
  label: string,
  title: string,
  position: string,
  speed: string,
  moving: string,
): FunctionControl {
  return {
    kind: 'function',
    name,
    channel,
    label,
    title,
    idle: 0,
    ranges: [
      {
        from: 0,
        to: 127,
        meaning: `${position} selection`,
        key: 'position',
        name: 'Position',
        scale: 'Position',
      },
      {
        from: 128,
        to: 255,
        meaning: `${speed} selection, ${FASTER}`,
        key: 'speed',
        name: moving,
        scale: 'Speed',
      },
    ],
  };
}

const controls: FunctionControl[] = [
  {
    kind: 'function',
    name: 'mode',
    channel: 1,
    label: 'Mode selection',
    title: 'Mode',
    idle: 0,
    ranges: [
      { from: 0, to: 63, meaning: 'Closed light mode', key: 'off', name: 'Off' },
      { from: 64, to: 127, meaning: 'Manual mode', key: 'manual', name: 'Manual' },
      { from: 128, to: 191, meaning: 'Auto mode', key: 'auto', name: 'Auto' },
      { from: 192, to: 255, meaning: 'Sound mode', key: 'sound', name: 'Sound' },
    ],
  },
  {
    kind: 'function',
    name: 'program',
    channel: 2,
    label: 'Pattern in manual mode, program in auto and sound mode',
    title: 'Pattern',
    idle: 0,
    ranges: [
      {
        from: 0,
        to: 255,
        meaning: `${LASER_PATTERNS} patterns to choose`,
        key: 'pattern',
        name: 'Pattern',
        scale: 'Pattern',
        steps: LASER_PATTERNS,
        when: { control: 'mode', key: 'manual' },
      },
      ...programs('auto'),
      ...programs('sound'),
    ],
  },
  {
    kind: 'function',
    name: 'rotation',
    channel: 3,
    label: 'Angle control',
    title: 'Rotation',
    idle: 0,
    ranges: [
      {
        from: 0,
        to: 127,
        meaning: 'Rotation angle selection',
        key: 'angle',
        name: 'Angle',
        scale: 'Angle',
      },
      {
        from: 128,
        to: 191,
        meaning: `Positive rotation speed selection, ${FASTER}`,
        key: 'forward',
        name: 'Spin',
        scale: 'Speed',
      },
      {
        from: 192,
        to: 255,
        meaning: `Anti-rotation speed selection, ${FASTER}`,
        key: 'reverse',
        name: 'Spin back',
        scale: 'Speed',
      },
    ],
  },
  positionOrSpeed(
    'flipH',
    4,
    'Horizontal angle',
    'Horizontal flip',
    'Horizontal flip position',
    'Horizontal flip speed',
    'Flip',
  ),
  positionOrSpeed(
    'flipV',
    5,
    'Vertical angle',
    'Vertical flip',
    'Vertical flip position',
    'Vertical flip speed',
    'Flip',
  ),
  positionOrSpeed(
    'moveH',
    6,
    'horizontal position',
    'Horizontal position',
    'Horizontal position',
    'Horizontal movement speed',
    'Move',
  ),
  positionOrSpeed(
    'moveV',
    7,
    'Vertical position',
    'Vertical position',
    'Vertical position',
    'Vertical movement speed',
    'Move',
  ),
  {
    kind: 'function',
    name: 'size',
    channel: 8,
    label: 'Pattern size control',
    title: 'Size',
    idle: 0,
    ranges: [
      {
        from: 0,
        to: 63,
        meaning: 'Fixed size, the larger the value, the smaller the pattern',
        key: 'fixed',
        name: 'Fixed',
        scale: 'Smaller',
      },
      {
        from: 64,
        to: 127,
        meaning: `Choose from small to large speed, ${FASTER}`,
        key: 'grow',
        name: 'Grow',
        scale: 'Speed',
      },
      {
        from: 128,
        to: 191,
        meaning: `Choose from large to small speed, ${FASTER}`,
        key: 'shrink',
        name: 'Shrink',
        scale: 'Speed',
      },
      {
        from: 192,
        to: 255,
        meaning: `Size zoom speed selection, ${FASTER}`,
        key: 'zoom',
        name: 'Zoom',
        scale: 'Speed',
      },
    ],
  },
  {
    kind: 'function',
    name: 'colour',
    channel: 9,
    label: 'Color control',
    title: 'Colour',
    idle: 0,
    ranges: [
      {
        from: 0,
        to: 63,
        meaning: 'Monochrome color selection',
        key: 'single',
        name: 'One colour',
        scale: 'Colour',
      },
      {
        from: 64,
        to: 127,
        meaning: 'Color mixing',
        key: 'mix',
        name: 'Mixed',
        scale: 'Mix',
      },
      // The manual does not say what the place within the next two ranges does.
      {
        from: 128,
        to: 191,
        meaning: 'Monochrome Auto',
        key: 'singleAuto',
        name: 'One colour, changing',
        scale: 'Value',
      },
      {
        from: 192,
        to: 255,
        meaning: 'Auto',
        key: 'auto',
        name: 'Changing',
        scale: 'Value',
      },
    ],
  },
  {
    kind: 'function',
    name: 'drawing',
    channel: 10,
    label: 'Code control',
    title: 'Drawing',
    idle: 0,
    ranges: [
      {
        from: 0,
        to: 127,
        meaning: 'The pattern has dots and lines',
        key: 'lines',
        name: 'Dots and lines',
      },
      {
        from: 128,
        to: 255,
        meaning: 'Pattern with dots, wireless strips',
        key: 'dots',
        name: 'Dots only',
      },
    ],
  },
];

/**
 * The control that keeps the laser closed while it rests at its idle value. A blackout
 * holds it there.
 */
export const LASER_GATE = 'mode';

export const ALIEN_LASER_10CH = defineProfile({
  id: 'alien-laser-10ch',
  name: 'Alien 500 mW RGB laser, 10 channels',
  footprint: 10,
  controls,
});
