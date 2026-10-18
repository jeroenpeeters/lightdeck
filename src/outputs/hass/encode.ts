/**
 * From what a lamp should show to the service call that makes Home Assistant do it.
 *
 * Pure functions. A lamp is given as a brightness (0..1), a colour whose brightest channel is 1
 * (red, green, blue, white; the brightness is kept apart from it) and the colour modes the
 * entity reports in `supported_color_modes`. What the lamp can show decides how the colour is
 * written: `rgbw` takes `rgbw_color`, `rgb`, `xy` and `hs` take `rgb_color` with the white mixed
 * in, and a lamp with brightness only, colour temperature only or on/off only takes no colour.
 * Until the entity has reported (`modes` is undefined or empty) `rgbw_color` is sent.
 *
 * `transition` is in seconds and always sent, to a lamp that can take it, so that nothing jumps.
 */

import type { Rgbw } from '../../engine/colour.js';
import type { HassCommand } from './types.js';

export interface LightLook {
  /** 0..1. At 0 the lamp goes off. */
  brightness: number;
  /** The direction of the colour: the brightest channel is 1 unless all are 0, which is off. */
  colour: Rgbw;
  /** `supported_color_modes` of the entity, or undefined while it has not reported. */
  modes: readonly string[] | undefined;
  /** Seconds. Rounded to a tenth. */
  transition: number;
}

const COLOUR_MODES_RGB = ['rgb', 'rgbww', 'xy', 'hs'];

const byte = (level: number): number => Math.min(255, Math.max(0, Math.round(level * 255)));

/** Seconds as Home Assistant takes them: a tenth is the finest anyone sees. */
const seconds = (value: number): number =>
  Math.round(Math.min(300, Math.max(0, Number.isFinite(value) ? value : 0)) * 10) / 10;

/** The service call for a light. */
export function lightCommand(look: LightLook): HassCommand {
  const { brightness, colour, modes } = look;
  const transition = seconds(look.transition);
  const known = modes !== undefined && modes.length > 0;
  const onOffOnly = known && modes.every((mode) => mode === 'onoff');
  const black = colour.red <= 0 && colour.green <= 0 && colour.blue <= 0 && colour.white <= 0;
  if (!(brightness > 0) || black) {
    return {
      domain: 'light',
      service: 'turn_off',
      ...(onOffOnly ? {} : { data: { transition } }),
    };
  }
  if (onOffOnly) return { domain: 'light', service: 'turn_on' };

  const data: Record<string, unknown> = {
    // Never 0 for a lamp that should be on: 0 is off in Home Assistant.
    brightness: Math.max(1, byte(brightness)),
  };
  if (!known || modes.includes('rgbw')) {
    data.rgbw_color = [byte(colour.red), byte(colour.green), byte(colour.blue), byte(colour.white)];
  } else if (modes.some((mode) => COLOUR_MODES_RGB.includes(mode))) {
    data.rgb_color = [
      byte(colour.red + colour.white),
      byte(colour.green + colour.white),
      byte(colour.blue + colour.white),
    ];
  }
  data.transition = transition;
  return { domain: 'light', service: 'turn_on', data };
}

/** The service call for a switch. A switch has no transition. */
export function switchCommand(on: boolean): HassCommand {
  return { domain: 'switch', service: on ? 'turn_on' : 'turn_off' };
}

/** JSON with the keys in order, so that two commands with the same content compare equal. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, each]) => each !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, each]) => `${JSON.stringify(key)}:${stable(each)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Whether two commands ask for the same, so that the controller sends only what changed. */
export function sameCommand(a: HassCommand | undefined, b: HassCommand | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return stable(a) === stable(b);
}
