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
  },
  {
    kind: 'level',
    name: 'tilt2',
    channel: 3,
    fineChannel: 4,
    label: 'Y2 motor running, with fine-tuning on channel 4',
    attribute: 'tilt',
  },
  // The manual does not say which end of the range is fast.
  { kind: 'level', name: 'motorSpeed', channel: 5, label: 'motor speed' },
  { kind: 'level', name: 'dimmer', channel: 6, label: 'total dimming', attribute: 'dimmer' },
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
    });
  });
}

const functions: FunctionControl[] = [
  {
    kind: 'function',
    name: 'function',
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
    activeFrom: 1,
    activeTo: 250,
  },
  ...functions,
];

/**
 * How the spider's cells and motors are arranged, for effects and for the drawing on
 * the control page. Cell indices are 0-based.
 *
 * The manual does not say which LEDs sit on which bar. LEDs 1 to 4 on bar 1 and 5 to 8
 * on bar 2 is an assumption.
 */
export const SPIDER_LAYOUT = {
  cells: SPIDER_CELLS,
  bars: [
    [0, 1, 2, 3],
    [4, 5, 6, 7],
  ],
  /** Tilt control per bar, in the order of `bars`. */
  tilt: ['tilt1', 'tilt2'],
  colours: COLOURS,
} as const;

export const SPIDER_43CH = defineProfile({
  id: 'spider-43ch',
  name: 'Spider moving head 8x RGBW, 43-channel mode',
  footprint: 43,
  controls,
});
