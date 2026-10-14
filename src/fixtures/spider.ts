/**
 * Spider moving head, 8 x RGBW LEDs on two motorised bars, in its 43-channel mode.
 *
 * Source: the fixture manual, section 5 "DMX channels", kept in
 * docs/spider-dmx-channels.pdf. Labels and byte ranges are the manual's own.
 *
 * In this mode every colour of every LED has its own channel. The fixture's other
 * mode (13 channels) drives all eight LEDs together and is not described here.
 */

import { type Control, defineProfile, type FunctionControl, type LevelControl } from './profile.js';

export const SPIDER_CELLS = 8;

const COLOURS = ['red', 'green', 'blue', 'white'] as const;
const FIRST_COLOUR_CHANNEL = 7;

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const motion: LevelControl[] = [
  {
    kind: 'level',
    name: 'tilt1',
    channel: 1,
    fineChannel: 2,
    label: 'Y1 motor running, with fine-tuning on channel 2',
    attribute: 'tilt',
    part: 'motion',
  },
  {
    kind: 'level',
    name: 'tilt2',
    channel: 3,
    fineChannel: 4,
    label: 'Y2 motor running, with fine-tuning on channel 4',
    attribute: 'tilt',
    part: 'motion',
  },
  // The manual does not say which end of the range is fast.
  { kind: 'level', name: 'motorSpeed', channel: 5, label: 'motor speed', part: 'motion' },
  {
    kind: 'level',
    name: 'dimmer',
    channel: 6,
    label: 'total dimming',
    attribute: 'dimmer',
    part: 'lights',
  },
];

const cells: LevelControl[] = [];
for (let cell = 1; cell <= SPIDER_CELLS; cell++) {
  COLOURS.forEach((colour, i) => {
    cells.push({
      kind: 'level',
      name: `${colour}${cell}`,
      channel: FIRST_COLOUR_CHANNEL + (cell - 1) * COLOURS.length + i,
      label: `${capitalise(colour)} ${cell} total dimming`,
      attribute: colour,
      cell,
      part: 'colour',
    });
  });
}

const functions: FunctionControl[] = [
  {
    kind: 'function',
    name: 'function',
    part: 'lights',
    channel: 40,
    label: 'dimming channel function or built-in effect',
    idle: 0,
    ranges: [
      { from: 0, to: 0, meaning: 'Dimming channel function (manual control)' },
      { from: 1, to: 7, meaning: 'Gradient effect' },
      { from: 8, to: 140, meaning: 'Auto effect' },
      { from: 141, to: 255, meaning: 'Sound auto effect' },
    ],
  },
  {
    kind: 'function',
    name: 'autoMode',
    part: 'lights',
    channel: 41,
    label: 'other channels, auto effect or sound effect',
    idle: 0,
    // The manual prints 0-15 and 15-128; the overlap at 15 is in the original.
    ranges: [
      { from: 0, to: 15, meaning: 'other channels (manual control)' },
      { from: 15, to: 128, meaning: 'Auto effect' },
      { from: 129, to: 255, meaning: 'Sound effect' },
    ],
  },
  {
    kind: 'function',
    name: 'effectSpeed',
    part: 'lights',
    channel: 42,
    label: 'Control the speed and sensitivity of the 6 7',
    idle: 0,
    ranges: [{ from: 0, to: 255, meaning: 'speed and sensitivity of the built-in effects' }],
  },
  {
    kind: 'function',
    name: 'reset',
    channel: 43,
    label: 'Reset (stop for 3 seconds)',
    idle: 0,
    ranges: [{ from: 250, to: 255, meaning: 'Reset, when held for 3 seconds' }],
  },
];

const controls: Control[] = [
  ...motion,
  ...cells,
  {
    kind: 'strobe',
    name: 'strobe',
    channel: 39,
    label: 'strobe (0 and 251-255 are no strobe)',
    attribute: 'strobe',
    part: 'lights',
    activeFrom: 1,
    activeTo: 250,
  },
  ...functions,
];

/**
 * How the spider's cells and motors are arranged, for effects, for the drawing on the
 * control page and for the simulator. Cell indices are 0-based.
 *
 * As Jeroen described it on 2026-10-14, looking at the back of the fixture, which is the
 * side with the LCD display and the cables:
 *
 *   bar 1, at the back:   L1 L2 L3 L4
 *   bar 2, at the front:  L8 L7 L6 L5
 *
 * `bars` lists the LEDs of a bar from left to right looking at the FRONT, the mirror of the
 * above, so the first bar is `[3, 2, 1, 0]` and the second `[4, 5, 6, 7]`. The effects work on
 * the numbers of the LEDs and do not use the order within a bar.
 */
export const SPIDER_LAYOUT = {
  cells: SPIDER_CELLS,
  bars: [
    [3, 2, 1, 0],
    [4, 5, 6, 7],
  ],
  /** Tilt control per bar, in the order of `bars`. */
  tilt: ['tilt1', 'tilt2'],
  colours: COLOURS,
  /** Which side of the fixture each bar sits on. */
  side: ['back', 'front'],
  /**
   * How each bar turns for its tilt, in the order of `bars`: points of [tilt 0..1, degrees]
   * in the order of the tilt. The degrees are from neutral, which is the lenses facing the way
   * the fixture is mounted (down when hung, forward when on a wall), positive to the front and
   * negative to the back, 90 being horizontal. Between two points the bar turns in a straight
   * line, so the movement is not linear over the whole tilt, and beyond the first and the last
   * point it stays where it is.
   *
   * From Jeroen, 2026-10-14, set in the Calibrate panel of the simulator (what the panel keeps
   * in his browser, copied here so that the effects use it too): neutral is at tilt 30 for both bars, and the bars turn the opposite way for the
   * same tilt, because they face each other. Bar 1 goes from 20 degrees to the front at tilt 0 to
   * 90 degrees to the back at 87, and carries on to 108 at 100. Bar 2 is the mirror of it: 20
   * degrees to the back at tilt 0 and 90 degrees to the front at 87. So the same tilt on both
   * bars is a scissor, and opposite tilts move the bars the same way in space.
   */
  tiltCurve: [
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
  ],
  /**
   * How fast the bars turn for the motor speed (channel 5, 0..1): points of [motor speed,
   * degrees per second] in the order of the motor speed, the same for both bars. A bar turns at
   * that constant speed towards the tilt it is given. Between two points the speed changes in a
   * straight line, and beyond the first and the last point it stays what it is there.
   *
   * From Jeroen, 2026-10-14, his timings, entered in the Calibrate panel of the simulator: the bars turn at 183 degrees per second from motor speed 0 to 50, then slower
   * and slower, 32 at 90 and 3 at 100. So the high end of the channel is the slow one.
   */
  motorSpeedCurve: [
    [0, 182.9],
    [0.5, 182.9],
    [0.9, 32],
    [1, 3.1],
  ],
  /**
   * How far each lens of a bar faces away from straight ahead, in degrees along the bar, from
   * left to right: the outer lenses face a little to the side and the inner ones a little less.
   * Positive is to the right.
   */
  aim: [-12, -5, 5, 12],
} as const;

export const SPIDER_43CH = defineProfile({
  id: 'spider-43ch',
  name: 'Spider moving head 8x RGBW, 43-channel mode',
  footprint: 43,
  controls,
});
