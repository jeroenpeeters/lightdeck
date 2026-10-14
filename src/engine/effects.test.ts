import { describe, expect, it } from 'vitest';
import type { Rgbw } from './colour.js';
import {
  EFFECTS,
  type EffectContext,
  type EffectFrame,
  findEffect,
  limitSpeed,
  MAX_FLASH_HZ,
  SPEEDS,
} from './effects.js';
import { type PaletteColour, paint } from './palette.js';

/** The main colour. */
const A: Rgbw = { red: 1, green: 0.5, blue: 0, white: 0 };
/** The backdrop: dimmer than the main colour, as it is when a flash has to stand out of it. */
const B: Rgbw = { red: 0, green: 0, blue: 0.25, white: 0 };
/** The accent. */
const C: Rgbw = { red: 0, green: 0, blue: 0, white: 1 };
const DARK: Rgbw = { red: 0, green: 0, blue: 0, white: 0 };
const BARS = [
  [0, 1, 2, 3],
  [4, 5, 6, 7],
];

function context(beat: number, extra: Partial<EffectContext> = {}): EffectContext {
  return { beat, cells: 8, bars: BARS, slots: 2, ...extra };
}

function render(id: string, beat: number, extra: Partial<EffectContext> = {}): EffectFrame {
  const effect = findEffect(id);
  if (!effect) throw new Error(`no effect ${id}`);
  return effect.render(context(beat, extra));
}

/** The lenses of an effect as they look with a palette: the effect is given as many slots as it has. */
function look(
  id: string,
  beat: number,
  colours: PaletteColour[] = [A, B],
  extra: Partial<EffectContext> = {},
): Rgbw[] {
  const frame = render(id, beat, { slots: colours.length, ...extra });
  return paint(frame.levels, { colours, mode: 'static', change: 'step', speed: 1 }, 0);
}

/** Brightest colour part of a cell, 0..1. */
const peak = (c: Rgbw | undefined) => (c ? Math.max(c.red, c.green, c.blue, c.white) : 0);
/** All the light of a cell. A fade from one colour to another never rises while it falls. */
const light = (c: Rgbw | undefined) => (c ? c.red + c.green + c.blue + c.white : 0);
const total = (cells: Rgbw[]) => cells.reduce((sum, c) => sum + peak(c), 0);
const brightest = (cells: Rgbw[]) =>
  cells.reduce((best, c, i) => (peak(c) > peak(cells[best]) ? i : best), 0);

/** Effects that do not change over time. */
const STATIC = ['solid', 'bars', 'alternate'];

describe('the set of effects', () => {
  it('has twenty-two, each with its own id, a name and a description', () => {
    expect(EFFECTS).toHaveLength(22);
    expect(new Set(EFFECTS.map((e) => e.id)).size).toBe(22);
    for (const effect of EFFECTS) {
      expect(effect.name.length).toBeGreaterThan(0);
      expect(effect.description.length).toBeGreaterThan(20);
    }
  });

  it('no longer has the effects that move the bars, nor the rainbow', () => {
    for (const id of ['tiltwave', 'scissor', 'scissor-motor', 'spectrum']) {
      expect(findEffect(id)).toBeUndefined();
    }
  });

  it('finds an effect by id', () => {
    expect(findEffect('chase')?.name).toBe('Chase');
    expect(findEffect('nope')).toBeUndefined();
  });

  it('says how many slots of the palette each uses: one to three, or all for the spread', () => {
    const slots = Object.fromEntries(EFFECTS.map((effect) => [effect.id, effect.slots]));
    expect(slots).toMatchObject({
      kick: 3,
      chase: 3,
      sparkle: 3,
      bounce: 2,
      swap: 2,
      wave: 2,
      build: 2,
      burst: 2,
      pump: 2,
      solid: 1,
      bars: 2,
      alternate: 2,
      spread: 8,
      cross: 2,
      ticktock: 2,
      scan: 2,
      pairs: 2,
      stab: 2,
      fade: 2,
      strobe: 2,
      seesaw: 2,
      glow: 2,
    });
  });
});

describe.each(EFFECTS.map((e) => [e.id, e] as const))('%s', (_id, effect) => {
  it('gives every cell valid levels at any moment and with any palette length', () => {
    // Collected and asserted once: an assertion per value makes this sweep slow.
    const wrong: string[] = [];
    for (const slots of [1, 2, 3, 6, 8]) {
      for (let beat = 0; beat < 40; beat += 0.037) {
        const frame = effect.render(context(beat, { slots }));
        const at = `beat ${beat.toFixed(3)}, ${slots} slots`;
        if (frame.levels.length !== 8) wrong.push(`${frame.levels.length} cells, ${at}`);
        frame.levels.forEach((cell, i) => {
          let sum = 0;
          for (const level of cell) {
            if (!Number.isFinite(level) || level < 0 || level > 1) {
              wrong.push(`cell ${i} has ${level}, ${at}`);
            }
            sum += level;
          }
          if (sum > 1 + 1e-9) wrong.push(`cell ${i} adds up to ${sum}, ${at}`);
        });
      }
    }
    expect(wrong.slice(0, 5)).toEqual([]);
  });

  it('shows the same picture for the same moment', () => {
    expect(effect.render(context(13.37))).toEqual(effect.render(context(13.37)));
  });

  it(STATIC.includes(effect.id) ? 'stays as it is' : 'changes over time', () => {
    const pictures = new Set<string>();
    for (let beat = 0; beat < 16; beat += 0.1) {
      pictures.add(JSON.stringify(effect.render(context(beat, { slots: 8 }))));
    }
    if (STATIC.includes(effect.id)) expect(pictures.size).toBe(1);
    // The strobe has only three pictures: a flash of each colour, and dark.
    else expect(pictures.size).toBeGreaterThan(effect.id === 'strobe' ? 2 : 4);
  });

  it('copes with a different number of cells and bars', () => {
    const frame = effect.render(context(3.2, { cells: 4, bars: [[0, 1, 2, 3]] }));
    expect(frame.levels).toHaveLength(4);
  });

  it('uses no more slots than it says, and no slot past the second that the palette lacks', () => {
    // The backdrop is the second slot and is given even when the palette has one colour: it is
    // then off. The slots after it are optional and are asked for only when they are there.
    for (const slots of [1, 2, 3, 8]) {
      for (let beat = 0; beat < 40; beat += 0.5) {
        const frame = effect.render(context(beat, { slots }));
        for (const cell of frame.levels) {
          expect(cell.length).toBeLessThanOrEqual(effect.slots);
          cell.forEach((level, slot) => {
            if (slot >= 2 && slot >= slots) expect(level).toBe(0);
          });
        }
      }
    }
  });

  it('does not touch what it was given', () => {
    const bars = BARS.map((bar) => [...bar]);
    effect.render(context(1.5, { bars }));
    expect(bars).toEqual(BARS);
  });
});

describe('kick', () => {
  it('is brightest on the beat and fades until the next one', () => {
    const all = (beat: number) => light(look('kick', beat)[0]);
    expect(all(1)).toBeGreaterThan(all(1.5));
    expect(all(1.5)).toBeGreaterThan(all(1.95));
    expect(all(2)).toBeCloseTo(all(1));
  });

  it('rings a little longer on the first beat of the bar', () => {
    expect(light(look('kick', 4.5)[0])).toBeGreaterThan(light(look('kick', 5.5)[0]));
  });

  it('hits in the main colour on every beat and falls back to the second', () => {
    for (const beat of [1, 2, 3, 5]) {
      expect(look('kick', beat)[0]).toEqual(A);
      const after = look('kick', beat + 0.99)[0];
      expect(after?.red).toBeLessThan(0.05);
      expect(after?.blue).toBeGreaterThan(0.2);
    }
  });

  it('with one colour hits and falls back to dark', () => {
    expect(look('kick', 1, [A])[0]).toEqual(A);
    expect(peak(look('kick', 1.99, [A])[0])).toBeLessThan(0.01);
  });

  it('hits the first beat of a bar in the third colour when the palette has one', () => {
    for (const beat of [0, 4, 8]) {
      expect(look('kick', beat, [A, B, C])[0]).toEqual(C);
      const after = look('kick', beat + 0.99, [A, B, C])[0];
      expect(after?.white).toBeLessThan(0.05);
    }
    // The other beats are as they are with two.
    expect(look('kick', 1, [A, B, C])).toEqual(look('kick', 1, [A, B]));
  });

  it('hits the first beat of a bar in the main colour when the palette has no third', () => {
    expect(look('kick', 4, [A, B])[0]).toEqual(A);
  });
});

describe('chase', () => {
  it('moves the bright lens along all eight, one lens per beat', () => {
    const order = [0, 1, 2, 3, 4, 5, 6, 7].map((beat) => brightest(look('chase', beat + 0.01)));
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(brightest(look('chase', 8.01))).toBe(0);
  });

  it('stays where it is until the next beat', () => {
    expect(render('chase', 3.01)).toEqual(render('chase', 3.99));
    expect(render('chase', 3.99)).not.toEqual(render('chase', 4));
  });

  it('leaves a tail behind the head, not in front of it', () => {
    const cells = look('chase', 3.5); // head on lens 3
    expect(peak(cells[2])).toBeGreaterThan(peak(cells[4]));
  });

  it('puts the tail in the third colour when the palette has one, and the head in the main', () => {
    const cells = look('chase', 3.5, [A, B, C]);
    expect(cells[3]).toEqual(A);
    const tail = cells[2];
    expect(tail?.red).toBe(0);
    expect(tail?.white).toBeGreaterThan(0.2);
    // Far from the head it is the backdrop again, as with two.
    expect(cells[6]?.white).toBeLessThan(0.1);
    expect(cells[6]?.blue).toBeGreaterThan(0.2);
  });
});

describe('bounce', () => {
  it('goes to the far end and back, one lens per beat', () => {
    const order = Array.from({ length: 17 }, (_, beat) => brightest(look('bounce', beat + 0.5)));
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 7, 6, 5, 4, 3, 2, 1, 0, 0]);
  });

  it('is a spot of the main colour over the second', () => {
    expect(look('bounce', 0)[0]).toEqual(A);
    expect(look('bounce', 0)[7]).toEqual(B);
    expect(look('bounce', 7)[7]).toEqual(A);
    expect(look('bounce', 7)[0]).toEqual(B);
  });
});

describe('bar swap', () => {
  it('hits one bar per beat, in turn, in the main colour over the second', () => {
    const first = look('swap', 0.05);
    expect(first[0]?.red).toBeGreaterThan(0.5);
    expect(first[4]).toEqual(B);

    const second = look('swap', 1.05);
    expect(second[0]).toEqual(B);
    expect(second[4]?.red).toBeGreaterThan(0.5);
  });
});

describe('wave', () => {
  it('has the main colour on its crest and the second in its trough', () => {
    expect(look('wave', 1)[0]).toEqual(A);
    const trough = look('wave', 3)[0];
    expect(trough?.red).toBeCloseTo(0);
    expect(trough?.blue).toBeCloseTo(0.25);
  });
});

describe('spread', () => {
  const hues: PaletteColour[] = Array.from({ length: 8 }, (_, i) => ({
    red: i / 7,
    green: 1 - i / 7,
    blue: 0.5,
    white: 0,
  }));

  it('gives neighbouring lenses different colours when the palette has a colour for each', () => {
    const cells = look('spread', 0.5, hues);
    expect(new Set(cells.map((c) => JSON.stringify(c))).size).toBe(8);
  });

  it('spreads fewer colours in bands', () => {
    const cells = look('spread', 0.5, [A, B]);
    expect(new Set(cells.slice(0, 4).map((c) => JSON.stringify(c))).size).toBe(1);
    expect(new Set(cells.slice(4).map((c) => JSON.stringify(c))).size).toBe(1);
    expect(cells[0]).not.toEqual(cells[7]);
  });

  it('is one colour on every lens with one colour', () => {
    const cells = look('spread', 0.5, [A]);
    expect(new Set(cells.map((c) => JSON.stringify(c))).size).toBe(1);
  });

  it('pumps gently on the beat, and never goes dark', () => {
    const level = (beat: number) => look('spread', beat, [A])[0]?.red ?? 0;
    expect(level(0)).toBeCloseTo(1);
    expect(level(0.99)).toBeGreaterThan(0.65);
    expect(level(0.99)).toBeLessThan(0.7);
  });

  it('leaves a lens dark where the palette is off', () => {
    const cells = look('spread', 0.5, [A, null]);
    expect(peak(cells[0])).toBeGreaterThan(0.5);
    expect(peak(cells[7])).toBe(0);
  });
});

describe('sparkle', () => {
  it('flashes only some lenses in the main colour and leaves the rest the second', () => {
    let flashes = 0;
    let slots = 0;
    for (let beat = 0; beat < 128; beat += 1) {
      for (const cell of look('sparkle', beat + 0.01)) {
        slots++;
        if (cell.red > 0.5) flashes++;
        else expect(cell).toEqual(B);
      }
    }
    expect(flashes / slots).toBeGreaterThan(0.1);
    expect(flashes / slots).toBeLessThan(0.35);
  });

  it('with blue first and red second flashes blue on a red wash', () => {
    const blue: Rgbw = { red: 0, green: 0, blue: 1, white: 0 };
    const red: Rgbw = { red: 1, green: 0, blue: 0, white: 0 };
    const cells = look('sparkle', 5.01, [blue, red]);
    expect(cells.some((cell) => cell.blue > 0.9)).toBe(true);
    for (const cell of cells) {
      expect(cell.blue > 0.9 || (cell.red === 1 && cell.blue === 0)).toBe(true);
    }
  });

  it('with one colour flashes it over darkness', () => {
    const blue: Rgbw = { red: 0, green: 0, blue: 1, white: 0 };
    const cells = look('sparkle', 5.01, [blue]);
    expect(Math.max(...cells.map((cell) => cell.blue))).toBeGreaterThan(0.9);
    for (const cell of cells) {
      expect(cell.blue > 0.9 || cell.blue === 0).toBe(true);
      expect(cell.red + cell.green + cell.white).toBe(0);
    }
  });

  it('flashes the same lenses for a whole beat, and others on the next', () => {
    const lit = (beat: number) => look('sparkle', beat).map((cell) => cell.red > 0.011);
    expect(lit(5.01)).toEqual(lit(5.6));
    const sets = new Set([0, 1, 2, 3, 4, 5, 6, 7].map((beat) => lit(beat + 0.01).join()));
    expect(sets.size).toBeGreaterThan(4);
  });

  it('now and then flashes in the third colour when the palette has one', () => {
    let accents = 0;
    let sparks = 0;
    for (let beat = 0; beat < 256; beat += 1) {
      for (const cell of look('sparkle', beat + 0.01, [A, B, C])) {
        if (cell.white > 0.5) accents++;
        if (cell.white > 0.5 || cell.red > 0.5) sparks++;
      }
    }
    expect(accents).toBeGreaterThan(0);
    expect(accents / sparks).toBeGreaterThan(0.15);
    expect(accents / sparks).toBeLessThan(0.45);
  });

  it('flashes the same lenses with a third colour as without, only not all in the main', () => {
    const lit = (colours: PaletteColour[]) =>
      look('sparkle', 5.01, colours).map((cell) => cell.red > 0.5 || cell.white > 0.5);
    expect(lit([A, B, C])).toEqual(lit([A, B]));
  });
});

describe('build-up', () => {
  /** How many lenses show the main colour. */
  const flashing = (cells: Rgbw[]) => cells.filter((c) => c.red > 0.001).length;

  it('gets brighter and wider, then drops on the main colour', () => {
    const early = look('build', 1.1);
    const late = look('build', 27.01);
    expect(total(late)).toBeGreaterThan(total(early));
    expect(flashing(early)).toBeLessThan(flashing(late));
    expect(early[0]).toEqual(B);
    expect(look('build', 0)[3]?.red).toBeGreaterThan(0);

    for (const cell of look('build', 31.02)) expect(cell.red).toBeGreaterThan(0.9);
  });

  it('flashes once per bar, then every two beats, then on every beat', () => {
    const on = (beat: number) => flashing(look('build', beat)) > 0;
    /** The beats in a stretch on which the light comes on. */
    const starts = (from: number, to: number) => {
      const found: number[] = [];
      for (let beat = from; beat < to; beat += 0.25) {
        if (on(beat) && !(beat > from && on(beat - 0.25))) found.push(beat);
      }
      return found;
    };
    expect(starts(0, 16)).toEqual([0, 4, 8, 12]);
    expect(starts(16, 24)).toEqual([16, 18, 20, 22]);
    expect(starts(24, 31)).toEqual([24, 25, 26, 27, 28, 29, 30]);
  });

  it('starts again after eight bars', () => {
    expect(render('build', 33.3)).toEqual(render('build', 1.3));
  });
});

describe('strobe burst', () => {
  it('flashes only during the fourth bar, on the beat', () => {
    for (const beat of [0.3, 5.3, 11.3, 16.3]) {
      expect(look('burst', beat)[0]?.red).toBeLessThan(0.7);
    }
    for (const beat of [12, 13, 14, 15]) {
      expect(look('burst', beat + 0.01)[0]).toEqual(A);
      expect(look('burst', beat + 0.5)[0]).toEqual(B);
    }
  });
});

describe('pump', () => {
  it('breathes the main colour on all lenses together, over the second', () => {
    const cells = look('pump', 0);
    expect(cells[0]).toEqual(A);
    expect(cells[7]).toEqual(A);
    expect(look('pump', 0.99)[0]?.blue).toBeGreaterThan(0.01);
    expect(look('pump', 0.99)[0]?.red).toBeGreaterThan(0.7);
  });
});

describe('the static effects', () => {
  it('solid puts the main colour on every lens', () => {
    for (const cell of look('solid', 3.3, [A])) expect(cell).toEqual(A);
  });

  it('bars puts the main colour on the first bar and the second colour on the other', () => {
    const cells = look('bars', 3.3);
    for (const i of [0, 1, 2, 3]) expect(cells[i]).toEqual(A);
    for (const i of [4, 5, 6, 7]) expect(cells[i]).toEqual(B);
  });

  it('bars leaves the second bar dark with one colour', () => {
    expect(peak(look('bars', 0, [A])[5])).toBe(0);
  });

  it('alternate takes the lenses in turn', () => {
    const cells = look('alternate', 0);
    expect(cells.map((c) => c.red > 0.5)).toEqual([
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
    ]);
    expect(cells[1]).toEqual(B);
  });

  it('leave a lens dark that gets an entry that is off', () => {
    expect(peak(look('alternate', 0, [A, null])[1])).toBe(0);
    expect(look('solid', 0, [null])[0]).toEqual(DARK);
  });
});

describe('the techno effects', () => {
  const TECHNO = ['cross', 'ticktock', 'scan', 'pairs', 'stab'];
  const BLUE: Rgbw = { red: 0, green: 0, blue: 1, white: 0 };
  /** The lenses that show any light at all, and the ones that are bright. */
  const showing = (cells: Rgbw[]) => cells.flatMap((c, i) => (peak(c) > 0 ? [i] : []));
  const bright = (cells: Rgbw[]) => cells.flatMap((c, i) => (peak(c) > 0.5 ? [i] : []));
  /** What the effect shows a little after the beat `beat`, with the first colour orange and the second blue. */
  const at = (id: string, beat: number, colours: PaletteColour[] = [A, BLUE]) =>
    look(id, beat + 0.01, colours);
  /** A lens in the first colour of these tests (orange, no blue) or in the second (blue, no red). */
  const same = (cell: Rgbw | undefined, colour: Rgbw) =>
    cell !== undefined &&
    (colour === BLUE ? cell.blue > 0.5 && cell.red === 0 : cell.red > 0.5 && cell.blue === 0);

  it.each(TECHNO)('lights two lenses at the most, and leaves every other lens dark: %s', (id) => {
    for (const colours of [[A, BLUE], [A], [A, BLUE, C], [A, null], [null, BLUE]]) {
      for (const [cells, bars] of [
        [8, BARS],
        [4, [[0, 1, 2, 3]]],
        [5, [[0, 1, 2, 3, 4]]],
        [1, [[0]]],
      ] as const) {
        for (let beat = 0; beat < 40; beat += 0.37) {
          const shown = showing(look(id, beat, colours, { cells, bars }));
          expect(shown.length).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it.each(TECHNO)('does not use the second colour as a backdrop: %s', (id) => {
    // Between the beats nothing is lit that was not hit: no wash of the second colour.
    for (let beat = 0; beat < 32; beat++) {
      const end = look(id, beat + 0.99, [A, BLUE]);
      for (const cell of end) expect(peak(cell)).toBeLessThan(0.02);
    }
  });

  it.each(TECHNO)('hits on the beat at full level and falls fast: %s', (id) => {
    for (let beat = 0; beat < 16; beat++) {
      const on = look(id, beat, [A, BLUE]);
      expect(Math.max(...on.map((c) => peak(c)))).toBe(1);
      expect(Math.max(...look(id, beat + 0.5, [A, BLUE]).map((c) => peak(c)))).toBeLessThan(0.1);
    }
  });

  it.each(TECHNO)('is dark when the colour of a turn is off or not there: %s', (id) => {
    // Colour 1 off: the turns of colour 1 are dark, the others are not.
    const counts = Array.from(
      { length: 16 },
      (_, beat) => showing(look(id, beat, [null, BLUE])).length,
    );
    expect(Math.max(...counts)).toBeGreaterThan(0);
    // Cross has a beam of each colour at once, so one beam is left. The others blink.
    if (id === 'cross') expect(new Set(counts)).toEqual(new Set([1]));
    else expect(counts).toContain(0);
  });

  describe('cross', () => {
    it('steps the first colour along the lenses and the second colour the other way', () => {
      for (const beat of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
        const cells = at('cross', beat);
        const step = beat % 8;
        expect(bright(cells).sort()).toEqual([step, 7 - step].sort());
        expect(same(cells[step], A)).toBe(true);
        expect(same(cells[7 - step], BLUE)).toBe(true);
      }
    });

    it('is one beam of the first colour with one colour, and the second is dark', () => {
      expect(bright(at('cross', 2, [A]))).toEqual([2]);
    });
  });

  describe('tick-tock', () => {
    it('takes one lens per beat, the left half in the first colour and the right half in the second', () => {
      const lenses = Array.from({ length: 8 }, (_, beat) => bright(at('ticktock', beat)));
      expect(lenses).toEqual([[0], [7], [1], [6], [2], [5], [3], [4]]);
      for (const beat of [0, 2, 4, 6])
        expect(same(at('ticktock', beat)[bright(at('ticktock', beat))[0] ?? 0], A)).toBe(true);
      for (const beat of [1, 3, 5, 7])
        expect(same(at('ticktock', beat)[bright(at('ticktock', beat))[0] ?? 0], BLUE)).toBe(true);
      expect(bright(at('ticktock', 8))).toEqual([0]);
    });
  });

  describe('scan', () => {
    it('goes along the lenses in the first colour and back in the second', () => {
      const out = Array.from({ length: 8 }, (_, beat) => bright(at('scan', beat)));
      expect(out).toEqual([[0], [1], [2], [3], [4], [5], [6], [7]]);
      const back = Array.from({ length: 8 }, (_, beat) => bright(at('scan', 8 + beat)));
      expect(back).toEqual([[7], [6], [5], [4], [3], [2], [1], [0]]);
      expect(same(at('scan', 3)[3], A)).toBe(true);
      expect(same(at('scan', 11)[4], BLUE)).toBe(true);
      expect(bright(at('scan', 16))).toEqual([0]);
    });
  });

  describe('pairs', () => {
    it('hits a lens on each side of the middle, the outside pair in the first colour and the inside pair in the second', () => {
      const lenses = Array.from({ length: 8 }, (_, beat) => bright(at('pairs', beat)));
      expect(lenses).toEqual([
        [0, 7],
        [3, 4],
        [1, 6],
        [2, 5],
        [2, 5],
        [1, 6],
        [3, 4],
        [0, 7],
      ]);
      for (const beat of [0, 2, 4, 6]) {
        const cells = at('pairs', beat);
        for (const lens of bright(cells)) expect(same(cells[lens], A)).toBe(true);
      }
      for (const beat of [1, 3, 5, 7]) {
        const cells = at('pairs', beat);
        for (const lens of bright(cells)) expect(same(cells[lens], BLUE)).toBe(true);
      }
    });
  });

  describe('stab', () => {
    const lensAt = (beat: number) => bright(at('stab', beat))[0] as number;

    it('stabs one lens in the first colour and in the second colour on the next beat', () => {
      for (const beat of [0, 2, 4, 10]) {
        expect(lensAt(beat)).toBe(lensAt(beat + 1));
        expect(same(at('stab', beat)[lensAt(beat)], A)).toBe(true);
        expect(same(at('stab', beat + 1)[lensAt(beat + 1)], BLUE)).toBe(true);
      }
    });

    it('jumps to another lens every two beats and visits all of them before it comes round', () => {
      const turns = Array.from({ length: 8 }, (_, turn) => lensAt(turn * 2));
      expect(new Set(turns).size).toBe(8);
      for (let turn = 1; turn < 40; turn++) expect(lensAt(turn * 2)).not.toBe(lensAt(turn * 2 - 2));
    });

    it('jumps far, not to the next lens', () => {
      const distances = Array.from({ length: 12 }, (_, turn) =>
        Math.abs(lensAt((turn + 1) * 2) - lensAt(turn * 2)),
      );
      expect(Math.min(...distances)).toBeGreaterThan(1);
    });
  });
});

describe('fade', () => {
  it('fades all lenses together from the first colour to the second and back, in two bars', () => {
    expect(look('fade', 0)[0]).toEqual(A);
    expect(look('fade', 4)[3]).toEqual(B);
    expect(look('fade', 8)[7]).toEqual(A);
    const half = look('fade', 2)[0];
    expect(half?.red).toBeCloseTo(0.5);
    expect(half?.blue).toBeCloseTo(0.125);
    for (const cell of look('fade', 1.3)) expect(cell).toEqual(look('fade', 1.3)[0]);
  });

  it('is a slow breath of light when the second colour is off', () => {
    const level = (beat: number) => look('fade', beat, [A, null])[0]?.red ?? 0;
    expect(level(0)).toBe(1);
    expect(level(4)).toBeCloseTo(0);
    expect(level(8)).toBe(1);
    for (let beat = 0; beat < 8; beat += 0.1) {
      expect(Math.abs(level(beat + 0.1) - level(beat))).toBeLessThan(0.2);
    }
  });
});

describe('seesaw', () => {
  const barsOf = (beat: number, colours: PaletteColour[] = [A, B]) => {
    const cells = look('seesaw', beat, colours);
    return [cells[0], cells[4]] as const;
  };

  it('fades the two bars against each other, and swaps them in the time of one fade', () => {
    const [first, second] = barsOf(0);
    expect(first).toEqual(A);
    expect(second).toEqual(B);
    const [swappedFirst, swappedSecond] = barsOf(4);
    expect(swappedFirst).toEqual(B);
    expect(swappedSecond).toEqual(A);
    expect(barsOf(8)[0]).toEqual(A);
  });

  it('keeps the lenses of a bar together', () => {
    const cells = look('seesaw', 2.7);
    for (const i of [1, 2, 3]) expect(cells[i]).toEqual(cells[0]);
    for (const i of [5, 6, 7]) expect(cells[i]).toEqual(cells[4]);
    expect(cells[0]).not.toEqual(cells[4]);
  });

  it('is never dark when the second colour is off: one bar glows while the other fades', () => {
    for (let beat = 0; beat < 16; beat += 0.1) {
      const [first, second] = barsOf(beat, [A, null]);
      // What the two bars give together stays the same, so the fixture does not go dark.
      expect((first?.red ?? 0) + (second?.red ?? 0)).toBeCloseTo(1, 6);
    }
    expect(barsOf(0, [A, null])).toEqual([A, DARK]);
    expect(barsOf(4, [A, null])).toEqual([DARK, A]);
  });

  it('goes with the first bar for a lens that is on no bar', () => {
    const cells = look('seesaw', 1, [A, B], { cells: 3, bars: [[0]] });
    expect(cells[1]).toEqual(cells[0]);
    expect(cells[2]).toEqual(cells[0]);
  });
});

describe('glow', () => {
  const shown = (beat: number, colours: PaletteColour[] = [A, B]) => look('glow', beat, colours);
  const lit = (beat: number) => shown(beat).flatMap((c, i) => (peak(c) > 0.02 ? [i] : []));

  it('lights three lenses at the most, a pool with a heart and an edge, and the rest are dark', () => {
    for (let beat = 0; beat < 40; beat += 0.1) {
      expect(lit(beat).length).toBeLessThanOrEqual(3);
      expect(lit(beat).length).toBeGreaterThanOrEqual(1);
    }
    // On a lens: the heart, and a neighbour on each side that has faded to a part of it.
    expect(lit(0)).toEqual([0, 1, 7]);
    expect(shown(0)[0]).toEqual(A);
    expect(peak(shown(0)[1])).toBeLessThan(peak(shown(0)[0]));
  });

  it('moves one lens in two beats, along the lenses and round again', () => {
    const heart = (beat: number) => {
      const cells = shown(beat);
      return cells.reduce((best, c, i) => (peak(c) > peak(cells[best]) ? i : best), 0);
    };
    expect([0, 2, 4, 6, 14, 16].map(heart)).toEqual([0, 1, 2, 3, 7, 0]);
  });

  it('fades one lens into the next: between two lenses both glow, and it never jumps', () => {
    const between = shown(1);
    expect(peak(between[0])).toBeGreaterThan(0.3);
    expect(peak(between[1])).toBeGreaterThan(0.3);
    expect(peak(between[0])).toBeCloseTo(peak(between[1]), 6);
    for (let beat = 0; beat < 32; beat += 0.05) {
      const now = shown(beat);
      const later = shown(beat + 0.05);
      for (let i = 0; i < 8; i++) {
        expect(Math.abs(peak(later[i]) - peak(now[i]))).toBeLessThan(0.1);
      }
    }
  });

  it('is never dark, and not lit as a whole: some lens always glows well', () => {
    for (let beat = 0; beat < 32; beat += 0.1) {
      expect(Math.max(...shown(beat).map((c) => peak(c)))).toBeGreaterThan(0.6);
    }
  });

  it('is only the first colour in the heart, and with one colour only a heart and an edge of it', () => {
    const one = shown(0, [A]);
    expect(one[0]).toEqual(A);
    expect(peak(one[1])).toBeGreaterThan(0);
    expect(peak(one[4])).toBe(0);
  });
});

describe('strobe', () => {
  it('flashes every lens hard at the start of each beat and is dark for the rest of it', () => {
    for (const beat of [0, 1, 2, 3.1, 7]) {
      for (const cell of look('strobe', beat + 0.01)) expect(peak(cell)).toBeGreaterThan(0.2);
    }
    for (const beat of [0.5, 1.9, 4.6]) {
      for (const cell of look('strobe', beat)) expect(peak(cell)).toBe(0);
    }
  });

  it('flashes the first colour and the second colour in turn', () => {
    expect(look('strobe', 0.01)[0]).toEqual(A);
    expect(look('strobe', 1.01)[0]).toEqual(B);
    expect(look('strobe', 2.01)[5]).toEqual(A);
  });

  it('flashes every other beat with one colour, and all lenses flash together', () => {
    expect(peak(look('strobe', 0.01, [A])[0])).toBe(1);
    expect(peak(look('strobe', 1.01, [A])[0])).toBe(0);
    const cells = look('strobe', 2.01);
    expect(new Set(cells.map((c) => JSON.stringify(c))).size).toBe(1);
  });
});

describe('speed', () => {
  it('has a normal speed, and two slower and two faster', () => {
    expect(SPEEDS).toEqual([0.25, 0.5, 1, 2, 4]);
  });

  it('is given as wanted while a change per beat stays within the flash limit', () => {
    expect(limitSpeed(126, 4)).toBe(4); // 8.4 per second
    expect(limitSpeed(150, 4)).toBe(4); // 10 per second, the limit itself
    expect(limitSpeed(60, 0.25)).toBe(0.25);
    expect(limitSpeed(200, 2)).toBe(2);
  });

  it('is halved until a change per beat is within the limit', () => {
    expect(limitSpeed(160, 4)).toBe(2); // 10.7 would be too fast
    expect(limitSpeed(200, 4)).toBe(2);
    expect(limitSpeed(126, 16)).toBe(4);
    expect(limitSpeed(200, 16)).toBe(2);
  });

  /** The highest tempo an effect is given, whatever tempo and speeds are chosen. */
  const fastest = Math.max(
    ...[60, 126, 150, 151, 200].flatMap((bpm) =>
      SPEEDS.flatMap((effect) => SPEEDS.map((console) => bpm * limitSpeed(bpm, effect * console))),
    ),
  );

  it('never gives an effect a tempo at which a change per beat is over the flash limit', () => {
    expect(fastest).toBe(600);
    expect(fastest / 60).toBeLessThanOrEqual(MAX_FLASH_HZ);
  });

  /** Counts dark-to-bright changes of a lens per second, over 64 beats of the effect. */
  function flashesPerSecond(id: string, bpm: number, cell: number): number {
    const beats = 64;
    let flashes = 0;
    let wasOn = false;
    for (let beat = 0; beat < beats; beat += 0.01) {
      const on = peak(look(id, beat)[cell]) > 0.5;
      if (on && !wasOn) flashes++;
      wasOn = on;
    }
    return flashes / ((beats / bpm) * 60);
  }

  it.each(EFFECTS.map((effect) => effect.id))(
    'keeps %s within the flash limit at the highest tempo it is given',
    (id) => {
      for (const cell of [0, 3, 7]) {
        expect(flashesPerSecond(id, fastest, cell)).toBeLessThanOrEqual(MAX_FLASH_HZ + 0.2);
      }
    },
  );

  it.each(EFFECTS.map((effect) => effect.id))(
    'changes %s once per beat at most, unless it moves smoothly',
    (id) => {
      const smooth = ['wave', 'spread', 'fade', 'seesaw', 'glow'];
      if (smooth.includes(id)) return;
      // Between two beats a lens may fade or go out, but no lens may come on. It holds with
      // one colour, with two and with three.
      for (const colours of [[A], [A, B], [A, B, C]]) {
        for (let beat = 0; beat < 64; beat++) {
          for (let cell = 0; cell < 8; cell++) {
            let before = light(look(id, beat + 0.01, colours)[cell]);
            for (let part = 0.05; part < 1; part += 0.05) {
              const now = light(look(id, beat + part, colours)[cell]);
              expect(now - before).toBeLessThan(0.1);
              before = now;
            }
          }
        }
      }
    },
  );
});
