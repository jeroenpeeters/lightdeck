/**
 * Colours as the cells of a fixture mix them: red, green, blue and white, each 0..1.
 *
 * In text, in the show file, a colour is `#rrggbb`, or `#rrggbbww` when it has white, or
 * `off`. Off is no colour at all: a lens that is given off is dark.
 */

import { clamp01 } from '../model/fixture.js';

export interface Rgbw {
  red: number;
  green: number;
  blue: number;
  white: number;
}

export const BLACK: Rgbw = { red: 0, green: 0, blue: 0, white: 0 };

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i;

/** The colour the text says, or null for `off`. Throws an `Error` when it is neither. */
export function parseColour(text: string): Rgbw | null {
  const trimmed = text.trim();
  if (trimmed.toLowerCase() === 'off') return null;
  const found = HEX.exec(trimmed);
  if (!found) throw new Error(`"${text}" is not a colour: write #rrggbb, #rrggbbww or off`);
  const [, red = '0', green = '0', blue = '0', white = '0'] = found;
  const level = (hex: string) => Number.parseInt(hex, 16) / 255;
  return { red: level(red), green: level(green), blue: level(blue), white: level(white) };
}

/** The text of a colour, which `parseColour` reads back to the same bytes. */
export function formatColour(colour: Rgbw | null): string {
  if (colour === null) return 'off';
  const hex = (level: number) =>
    Math.round(clamp01(level) * 255)
      .toString(16)
      .padStart(2, '0');
  const rgb = `#${hex(colour.red)}${hex(colour.green)}${hex(colour.blue)}`;
  return colour.white > 0 ? `${rgb}${hex(colour.white)}` : rgb;
}

export function scaleColour(colour: Rgbw, level: number): Rgbw {
  const k = clamp01(level);
  return {
    red: clamp01(colour.red) * k,
    green: clamp01(colour.green) * k,
    blue: clamp01(colour.blue) * k,
    white: clamp01(colour.white) * k,
  };
}

/** From `from` at 0 to `to` at 1. Off is dark, so a fade to or from it is a fade of brightness. */
export function mixColours(from: Rgbw | null, to: Rgbw | null, t: number): Rgbw {
  const a = from ?? BLACK;
  const b = to ?? BLACK;
  const k = clamp01(t);
  return {
    red: a.red + (b.red - a.red) * k,
    green: a.green + (b.green - a.green) * k,
    blue: a.blue + (b.blue - a.blue) * k,
    white: a.white + (b.white - a.white) * k,
  };
}
