import { describe, expect, it } from 'vitest';
import { formatColour, parseColour } from './colour.js';
import {
  colourAt,
  FALLBACK_PALETTE,
  MAX_PALETTE_COLOURS,
  PaletteBook,
  PaletteError,
  paint,
  paletteData,
  readPaletteFields,
  shownSlots,
  startingPalettes,
} from './palette.js';

const RED = { red: 1, green: 0, blue: 0, white: 0 };
const GREEN = { red: 0, green: 1, blue: 0, white: 0 };
const BLUE = { red: 0, green: 0, blue: 1, white: 0 };

const fields = (
  colours: ReturnType<typeof parseColour>[],
  over: Partial<ReturnType<typeof readPaletteFields>> = {},
) => ({
  colours,
  mode: 'static' as const,
  change: 'step' as const,
  speed: 0.25,
  ...over,
});

describe('colours as text', () => {
  it('reads #rrggbb, #rrggbbww and off', () => {
    expect(parseColour('#ff0000')).toEqual(RED);
    expect(parseColour('#000000ff')).toEqual({ red: 0, green: 0, blue: 0, white: 1 });
    expect(parseColour('off')).toBeNull();
    expect(parseColour(' OFF ')).toBeNull();
  });

  it('refuses anything else', () => {
    expect(() => parseColour('red')).toThrow(/not a colour/);
    expect(() => parseColour('#fff')).toThrow(/not a colour/);
  });

  it('writes what it reads', () => {
    for (const text of ['#ff9400', '#12345678', 'off', '#000000']) {
      expect(formatColour(parseColour(text))).toBe(text);
    }
  });
});

describe('reading a palette', () => {
  it('needs at least one colour and at most eight', () => {
    expect(() => readPaletteFields({ colours: [] })).toThrow(PaletteError);
    expect(() => readPaletteFields({})).toThrow(/list of colours/);
    const nine = Array.from({ length: MAX_PALETTE_COLOURS + 1 }, () => '#ff0000');
    expect(() => readPaletteFields({ colours: nine })).toThrow(/8 colours at most/);
    const eight = nine.slice(1);
    expect(readPaletteFields({ colours: eight }).colours).toHaveLength(8);
  });

  it('defaults to static, a hard step and one step per bar', () => {
    expect(readPaletteFields({ colours: ['#ff0000'] })).toEqual({
      colours: [RED],
      mode: 'static',
      change: 'step',
      speed: 0.25,
    });
  });

  it('refuses what it does not know', () => {
    expect(() => readPaletteFields({ colours: ['#ff0000'], mode: 'spin' })).toThrow(
      /static or cycle/,
    );
    expect(() => readPaletteFields({ colours: ['#ff0000'], change: 'blur' })).toThrow(
      /step or fade/,
    );
    expect(() => readPaletteFields({ colours: ['#ff0000'], speed: 3 })).toThrow(/one of/);
    expect(() => readPaletteFields({ colours: ['#ff0000'], tint: 1 })).toThrow(
      /cannot have "tint"/,
    );
    expect(() => readPaletteFields({ colours: [4] })).toThrow(/#rrggbb or off/);
    expect(() => readPaletteFields({ colours: ['nope'] })).toThrow(/not a colour/);
  });

  it('gives the data back that it reads', () => {
    const read = readPaletteFields({
      colours: ['#ff0000', 'off', '#0000ff'],
      mode: 'cycle',
      change: 'fade',
      speed: 1,
    });
    expect(paletteData(read)).toEqual({
      colours: ['#ff0000', 'off', '#0000ff'],
      mode: 'cycle',
      change: 'fade',
      speed: 1,
    });
    expect(readPaletteFields(paletteData(read))).toEqual(read);
  });

  it('starts a show with a white and a rainbow', () => {
    const [white, rainbow] = startingPalettes();
    expect(white?.id).toBe('white');
    expect(white?.colours).toEqual([{ red: 0, green: 0, blue: 0, white: 1 }]);
    expect(rainbow?.mode).toBe('cycle');
    expect(rainbow?.colours).toHaveLength(6);
  });
});

describe('the colour of a slot', () => {
  const palette = fields([RED, null, BLUE]);

  it('is the entry of the slot, and off beyond the list', () => {
    expect(colourAt(palette, 0, 0)).toEqual(RED);
    expect(colourAt(palette, 1, 0)).toBeNull();
    expect(colourAt(palette, 2, 0)).toEqual(BLUE);
    expect(colourAt(palette, 3, 0)).toBeNull();
    expect(colourAt(palette, -1, 0)).toBeNull();
  });

  it('stays where it is when the palette is static', () => {
    expect(colourAt(palette, 0, 17.4)).toEqual(RED);
  });

  it('shifts the list by one slot on every step of a cycle', () => {
    const cycle = fields([RED, GREEN, BLUE], { mode: 'cycle' });
    expect([0, 1, 2].map((slot) => colourAt(cycle, slot, 0))).toEqual([RED, GREEN, BLUE]);
    expect([0, 1, 2].map((slot) => colourAt(cycle, slot, 1))).toEqual([GREEN, BLUE, RED]);
    expect([0, 1, 2].map((slot) => colourAt(cycle, slot, 3))).toEqual([RED, GREEN, BLUE]);
    // Steps stay hard until the next one.
    expect(colourAt(cycle, 0, 0.99)).toEqual(RED);
  });

  it('keeps the slots beyond the list off in a cycle', () => {
    const cycle = fields([RED, GREEN], { mode: 'cycle' });
    expect(colourAt(cycle, 2, 1)).toBeNull();
  });

  it('fades from the colour to the next one when it says fade', () => {
    const cycle = fields([RED, BLUE], { mode: 'cycle', change: 'fade' });
    expect(colourAt(cycle, 0, 0)).toEqual(RED);
    expect(colourAt(cycle, 0, 0.5)).toEqual({ red: 0.5, green: 0, blue: 0.5, white: 0 });
    expect(colourAt(cycle, 0, 1)).toEqual(BLUE);
  });

  it('fades brightness to and from an entry that is off', () => {
    const cycle = fields([RED, null], { mode: 'cycle', change: 'fade' });
    expect(colourAt(cycle, 0, 0.25)).toEqual({ red: 0.75, green: 0, blue: 0, white: 0 });
    expect(colourAt(cycle, 1, 0.25)).toEqual({ red: 0.25, green: 0, blue: 0, white: 0 });
  });

  it('stays off when both ends of a fade are off', () => {
    const cycle = fields([null, null, RED], { mode: 'cycle', change: 'fade' });
    expect(colourAt(cycle, 0, 0.5)).toBeNull();
  });

  it('does not cycle a palette of one colour', () => {
    const one = fields([RED], { mode: 'cycle' });
    expect(colourAt(one, 0, 5.5)).toEqual(RED);
  });

  it('counts steps backwards too', () => {
    const cycle = fields([RED, GREEN, BLUE], { mode: 'cycle' });
    expect(colourAt(cycle, 0, -1)).toEqual(BLUE);
  });
});

describe('painting the lenses', () => {
  const palette = fields([RED, GREEN, BLUE]);

  it('adds the slots by their levels', () => {
    const [lens] = paint([[0.5, 0.25]], palette, 0);
    expect(lens).toEqual({ red: 0.5, green: 0.25, blue: 0, white: 0 });
  });

  it('leaves a lens dark that gets only slots that are off or not there', () => {
    const sparse = fields([RED, null]);
    expect(paint([[0, 1]], sparse, 0)[0]).toEqual({ red: 0, green: 0, blue: 0, white: 0 });
    expect(paint([[0, 0, 1]], sparse, 0)[0]).toEqual({ red: 0, green: 0, blue: 0, white: 0 });
  });

  it('holds a sum above one at one', () => {
    const [lens] = paint([[1, 1]], fields([RED, RED]), 0);
    expect(lens?.red).toBe(1);
  });

  it('paints every lens', () => {
    expect(paint([[1], [0, 1], []], palette, 0)).toEqual([
      RED,
      GREEN,
      { red: 0, green: 0, blue: 0, white: 0 },
    ]);
  });

  it('follows the step of a cycle', () => {
    const cycle = fields([RED, GREEN, BLUE], { mode: 'cycle' });
    expect(paint([[1]], cycle, 1)[0]).toEqual(GREEN);
  });
});

describe('the palette book', () => {
  it('looks palettes up by their id and keeps their order', () => {
    const book = new PaletteBook();
    expect(book.get('white')).toBeUndefined();
    book.set(startingPalettes());
    expect(book.get('white')?.label).toBe('White');
    expect(book.get(null)).toBeUndefined();
    expect(book.list().map((palette) => palette.id)).toEqual(['white', 'rainbow']);
    book.set([FALLBACK_PALETTE]);
    expect(book.get('rainbow')).toBeUndefined();
  });
});

describe('a palette that shows fewer colours than it has', () => {
  const pool = [parseColour('#ff0000'), parseColour('#00ff00'), parseColour('#0000ff')];

  it('is read, and is the same as showing all when it shows as many as it has or more', () => {
    const data = { colours: ['#ff0000', '#00ff00', '#0000ff'], mode: 'cycle' };
    expect(readPaletteFields({ ...data, visible: 1 }).visible).toBe(1);
    expect(readPaletteFields({ ...data, visible: 2 }).visible).toBe(2);
    expect(readPaletteFields({ ...data, visible: 3 }).visible).toBeUndefined();
    expect(readPaletteFields({ ...data, visible: 8 }).visible).toBeUndefined();
    expect(readPaletteFields({ ...data, visible: null }).visible).toBeUndefined();
    expect(readPaletteFields(data).visible).toBeUndefined();
  });

  it('refuses what cannot be a number of colours', () => {
    const data = { colours: ['#ff0000', '#00ff00'] };
    for (const visible of [0, -1, 1.5, '1', true]) {
      expect(() => readPaletteFields({ ...data, visible })).toThrow(
        new PaletteError('the number of colours a palette shows is a whole number, 1 or more'),
      );
    }
  });

  it('is written back only when it is set', () => {
    const data = { colours: ['#ff0000', '#00ff00'], mode: 'cycle' };
    expect(paletteData(readPaletteFields(data))).not.toHaveProperty('visible');
    expect(paletteData(readPaletteFields({ ...data, visible: 1 }))).toHaveProperty('visible', 1);
  });

  it('counts the slots that show', () => {
    expect(shownSlots(fields(pool))).toBe(3);
    expect(shownSlots(fields(pool, { visible: 1 }))).toBe(1);
    expect(shownSlots(fields(pool, { visible: 7 }))).toBe(3);
  });

  it('shows one colour that goes through all of them on a cycle, with the others dark', () => {
    const cycle = fields(pool, { mode: 'cycle', visible: 1 });
    expect([0, 1, 2, 3].map((step) => colourAt(cycle, 0, step))).toEqual([RED, GREEN, BLUE, RED]);
    expect(colourAt(cycle, 1, 0)).toBeNull();
    expect(colourAt(cycle, 2, 5)).toBeNull();
  });

  it('fades the one colour to the next of the pool', () => {
    const fade = fields(pool, { mode: 'cycle', change: 'fade', visible: 1 });
    const half = colourAt(fade, 0, 0.5);
    expect(half?.red).toBeCloseTo(0.5);
    expect(half?.green).toBeCloseTo(0.5);
    expect(colourAt(fade, 1, 0.5)).toBeNull();
  });

  it('cuts a static palette to its first colours', () => {
    const still = fields(pool, { visible: 2 });
    expect(colourAt(still, 1, 0)).toEqual(GREEN);
    expect(colourAt(still, 2, 0)).toBeNull();
  });
});
