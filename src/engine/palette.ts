/**
 * Palettes: the colours of the show, apart from the effects.
 *
 * A palette is a list of up to eight entries, slot 1 first. An entry is a colour or off.
 * A light effect does not name colours: it says how much of slot 1, of slot 2 and so on each
 * lens gets (`paint`), and the palette says what those are. A slot that the list does not
 * have is off, and so is an entry that is off, and a lens that gets only off is dark.
 *
 * A palette is static, or it cycles: the list shifts by one slot on every step, so an effect
 * that uses slots 1 and 2 sees (1,2), then (2,3), then (3,1). A step is a hard cut or a fade
 * from one colour to the next, as the palette says. The pace is a speed relative to the
 * tempo, one of `SPEEDS`: one step per beat at ×1, one per bar at ÷4. Slots beyond the end of
 * the list do not take part in the shift: they stay off.
 *
 * A palette can show fewer colours than it has (`visible`, Jeroen, 2026-10-20): the first `visible`
 * slots are what the effects get and the rest of the list is the pool that the shift draws from.
 * With `visible: 1` and a cycle, a light effect has one colour that changes on every step through
 * all the colours of the theme, and nothing behind it: the colour is an effect of its own.
 *
 * The palettes belong to the show and are used by name. `PaletteBook` is where the fixtures
 * look them up, so that a palette that is edited changes what is shown at once.
 */

import { formatColour, mixColours, parseColour, type Rgbw } from './colour.js';
import { SPEEDS } from './effects.js';

/** An entry of a palette: a colour, or null for off. */
export type PaletteColour = Rgbw | null;

export const MAX_PALETTE_COLOURS = 8;
export const PALETTE_MODES = ['static', 'cycle'] as const;
export const PALETTE_CHANGES = ['step', 'fade'] as const;
export type PaletteMode = (typeof PALETTE_MODES)[number];
export type PaletteChange = (typeof PALETTE_CHANGES)[number];

/** One step per bar, which is what a cycle does when nobody says. */
export const DEFAULT_PALETTE_SPEED = 0.25;

/** What is wrong with a palette. The message is for the operator. */
export class PaletteError extends Error {}

export interface PaletteFields {
  colours: PaletteColour[];
  mode: PaletteMode;
  change: PaletteChange;
  /** How fast a cycle steps, one of `SPEEDS`. It is the pace unless a look says another. */
  speed: number;
  /**
   * How many of the first slots show, when fewer than the list has. The slots after them are dark,
   * and in a cycle the colours still come from the whole list. Absent: all of them.
   */
  visible?: number | undefined;
}

export interface Palette extends PaletteFields {
  /** Names the palette in the file and in the API: `sunset`. */
  id: string;
  /** What the operator calls it. */
  label: string;
}

/** A single white, which is what a lens gets when no palette was chosen. */
export const FALLBACK_PALETTE: Palette = {
  id: 'white',
  label: 'White',
  colours: [{ red: 0, green: 0, blue: 0, white: 1 }],
  mode: 'static',
  change: 'step',
  speed: DEFAULT_PALETTE_SPEED,
};

/** The palettes of a show that has none of its own yet. */
export function startingPalettes(): Palette[] {
  const stops = ['#ff0000', '#ffaa00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff'];
  return [
    { ...FALLBACK_PALETTE, colours: [...FALLBACK_PALETTE.colours] },
    {
      id: 'rainbow',
      label: 'Rainbow',
      colours: stops.map((stop) => parseColour(stop)),
      mode: 'cycle',
      change: 'fade',
      speed: DEFAULT_PALETTE_SPEED,
    },
  ];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The fields of a palette as they were given: `colours` is required, the rest has a default.
 * Throws a `PaletteError` that says what is wrong.
 */
export function readPaletteFields(data: unknown): PaletteFields {
  if (!isObject(data)) throw new PaletteError('a palette needs colours');
  const extra = Object.keys(data).find(
    (key) => !['label', 'colours', 'mode', 'change', 'speed', 'visible'].includes(key),
  );
  if (extra !== undefined) {
    throw new PaletteError(
      `a palette cannot have "${extra}", only label, colours, mode, change, speed and visible`,
    );
  }
  const listed = data.colours;
  if (!Array.isArray(listed) || listed.length === 0) {
    throw new PaletteError('a palette needs a list of colours, at least one');
  }
  if (listed.length > MAX_PALETTE_COLOURS) {
    throw new PaletteError(`a palette can have ${MAX_PALETTE_COLOURS} colours at most`);
  }
  const colours = listed.map((entry): PaletteColour => {
    if (typeof entry !== 'string') throw new PaletteError('a colour is written as #rrggbb or off');
    try {
      return parseColour(entry);
    } catch (error) {
      throw new PaletteError(error instanceof Error ? error.message : String(error));
    }
  });

  const mode = data.mode ?? 'static';
  if (!PALETTE_MODES.includes(mode as PaletteMode)) {
    throw new PaletteError(`the mode of a palette is ${PALETTE_MODES.join(' or ')}`);
  }
  const change = data.change ?? 'step';
  if (!PALETTE_CHANGES.includes(change as PaletteChange)) {
    throw new PaletteError(`the change of a palette is ${PALETTE_CHANGES.join(' or ')}`);
  }
  const speed = data.speed ?? DEFAULT_PALETTE_SPEED;
  if (typeof speed !== 'number' || !SPEEDS.includes(speed)) {
    throw new PaletteError(`the speed of a palette must be one of ${SPEEDS.join(', ')}`);
  }
  let visible: number | undefined;
  if (data.visible !== undefined && data.visible !== null) {
    if (typeof data.visible !== 'number' || !Number.isInteger(data.visible) || data.visible < 1) {
      throw new PaletteError('the number of colours a palette shows is a whole number, 1 or more');
    }
    // As many as the list has, or more, is all of them.
    if (data.visible < colours.length) visible = data.visible;
  }
  return {
    colours,
    mode: mode as PaletteMode,
    change: change as PaletteChange,
    speed,
    ...(visible === undefined ? {} : { visible }),
  };
}

/** How many slots of a palette show: the effects get no more colours than this. */
export function shownSlots(palette: PaletteFields): number {
  return Math.min(palette.visible ?? palette.colours.length, palette.colours.length);
}

/** The fields as the file and the API have them, which `readPaletteFields` reads back. */
export function paletteData(palette: PaletteFields): Record<string, unknown> {
  return {
    colours: palette.colours.map((colour) => formatColour(colour)),
    mode: palette.mode,
    change: palette.change,
    speed: palette.speed,
    ...(palette.visible === undefined ? {} : { visible: palette.visible }),
  };
}

/**
 * From this many changes per second a fade between colours is a smear, and the cheap lenses make a
 * mess of it: a fast effect or a fast cycle changes hard (Jeroen, 2026-10-21).
 */
export const FAST_CHANGES_PER_SECOND = 3;

/** Whether something that changes once per beat at `speed` is fast, at `bpm`. */
export function isFast(bpm: number, speed: number): boolean {
  return (bpm / 60) * speed >= FAST_CHANGES_PER_SECOND;
}

/**
 * The colour of a slot (0-based) after `step` steps of the cycle, as a fraction. Null is off:
 * a slot beyond the list, an entry that is off, and a fade that has gone all the way to off.
 */
export function colourAt(palette: PaletteFields, slot: number, step: number): Rgbw | null {
  const { colours } = palette;
  const count = colours.length;
  if (slot < 0 || slot >= shownSlots(palette)) return null;
  if (palette.mode !== 'cycle' || count < 2) return colours[slot] ?? null;
  const whole = Math.floor(step);
  const from = colours[(((slot + whole) % count) + count) % count] ?? null;
  if (palette.change === 'step') return from;
  const to = colours[(((slot + whole + 1) % count) + count) % count] ?? null;
  if (from === null && to === null) return null;
  return mixColours(from, to, step - whole);
}

/**
 * The colours of the lenses: for each lens how much of each slot it gets, times what the
 * slot is at this step. The colours of the slots add up, and are held to 1.
 */
export function paint(
  levels: readonly (readonly number[])[],
  palette: PaletteFields,
  step: number,
): Rgbw[] {
  const slots = palette.colours.map((_, slot) => colourAt(palette, slot, step));
  return levels.map((weights) => {
    let red = 0;
    let green = 0;
    let blue = 0;
    let white = 0;
    weights.forEach((weight, slot) => {
      const colour = slots[slot];
      if (!colour || !(weight > 0)) return;
      red += colour.red * weight;
      green += colour.green * weight;
      blue += colour.blue * weight;
      white += colour.white * weight;
    });
    const hold = (level: number) => Math.min(1, Math.max(0, level));
    return { red: hold(red), green: hold(green), blue: hold(blue), white: hold(white) };
  });
}

/** Where the fixtures look the palettes of the show up. */
export class PaletteBook {
  private palettes = new Map<string, Palette>();

  /** Replaces the palettes with those of the show, in the order of the show. */
  set(palettes: readonly Palette[]): void {
    this.palettes = new Map(palettes.map((palette) => [palette.id, palette]));
  }

  get(id: string | null): Palette | undefined {
    return id === null ? undefined : this.palettes.get(id);
  }

  list(): Palette[] {
    return [...this.palettes.values()];
  }
}
