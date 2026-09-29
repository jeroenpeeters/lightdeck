import { describe, expect, it } from 'vitest';
import {
  EFFECTS,
  type EffectContext,
  type EffectFrame,
  findEffect,
  flashesPerBeat,
  MAX_FLASH_HZ,
  type Rgbw,
} from './effects.js';

const A: Rgbw = { red: 1, green: 0.5, blue: 0, white: 0 };
const B: Rgbw = { red: 0, green: 0, blue: 1, white: 0 };
const BARS = [
  [0, 1, 2, 3],
  [4, 5, 6, 7],
];

function context(beat: number, extra: Partial<EffectContext> = {}): EffectContext {
  return { beat, bpm: 126, cells: 8, bars: BARS, a: A, b: B, ...extra };
}

function render(id: string, beat: number, extra: Partial<EffectContext> = {}): EffectFrame {
  const effect = findEffect(id);
  if (!effect) throw new Error(`no effect ${id}`);
  return effect.render(context(beat, extra));
}

/** Brightest colour part of a cell, 0..1. */
const peak = (c: Rgbw | undefined) => (c ? Math.max(c.red, c.green, c.blue, c.white) : 0);
const total = (frame: EffectFrame) => frame.cells.reduce((sum, c) => sum + peak(c), 0);
const brightest = (frame: EffectFrame) =>
  frame.cells.reduce((best, c, i) => (peak(c) > peak(frame.cells[best]) ? i : best), 0);

describe('the set of effects', () => {
  it('has ten, each with its own id, a name and a description', () => {
    expect(EFFECTS).toHaveLength(10);
    expect(new Set(EFFECTS.map((e) => e.id)).size).toBe(10);
    for (const effect of EFFECTS) {
      expect(effect.name.length).toBeGreaterThan(0);
      expect(effect.description.length).toBeGreaterThan(20);
    }
  });

  it('finds an effect by id', () => {
    expect(findEffect('chase')?.name).toBe('Chase');
    expect(findEffect('nope')).toBeUndefined();
  });
});

describe.each(EFFECTS.map((e) => [e.id, e] as const))('%s', (_id, effect) => {
  it('gives every cell a valid colour at any moment and any tempo', () => {
    // Collected and asserted once: an assertion per value makes this sweep slow.
    const wrong: string[] = [];
    const valid = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;
    for (const bpm of [60, 126, 140, 200, 400]) {
      for (let beat = 0; beat < 40; beat += 0.037) {
        const frame = effect.render(context(beat, { bpm }));
        const at = `beat ${beat.toFixed(3)} at ${bpm} bpm`;
        if (frame.cells.length !== 8) wrong.push(`${frame.cells.length} cells, ${at}`);
        frame.cells.forEach((cell, i) => {
          for (const value of [cell.red, cell.green, cell.blue, cell.white]) {
            if (!valid(value)) wrong.push(`cell ${i} has ${value}, ${at}`);
          }
        });
        for (const tilt of frame.tilt ?? []) {
          if (!valid(tilt)) wrong.push(`tilt ${tilt}, ${at}`);
        }
      }
    }
    expect(wrong.slice(0, 5)).toEqual([]);
  });

  it('shows the same picture for the same moment', () => {
    expect(effect.render(context(13.37))).toEqual(effect.render(context(13.37)));
  });

  it('changes over time', () => {
    const pictures = new Set<string>();
    for (let beat = 0; beat < 16; beat += 0.25) {
      pictures.add(JSON.stringify(effect.render(context(beat))));
    }
    expect(pictures.size).toBeGreaterThan(4);
  });

  it('copes with a different number of cells and bars', () => {
    const frame = effect.render(context(3.2, { cells: 4, bars: [[0, 1, 2, 3]] }));
    expect(frame.cells).toHaveLength(4);
  });

  it('only tilts the bars when it says it moves', () => {
    const frame = effect.render(context(2.5));
    expect(frame.tilt !== undefined).toBe(effect.moves);
    if (frame.tilt) expect(frame.tilt).toHaveLength(BARS.length);
  });

  it('does not change the colours it was given', () => {
    const a = { ...A };
    const b = { ...B };
    effect.render(context(1.5, { a, b }));
    expect(a).toEqual(A);
    expect(b).toEqual(B);
  });
});

describe('kick', () => {
  it('is brightest on the beat and fades until the next one', () => {
    const on = total(render('kick', 1));
    const mid = total(render('kick', 1.5));
    const late = total(render('kick', 1.95));
    expect(on).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(late);
    expect(total(render('kick', 2))).toBeCloseTo(on);
  });

  it('uses the second colour on the first beat of the bar only', () => {
    expect(render('kick', 0).cells[0]?.blue).toBeGreaterThan(0.9);
    expect(render('kick', 4).cells[0]?.blue).toBeGreaterThan(0.9);
    expect(render('kick', 1).cells[0]?.blue).toBe(0);
    expect(render('kick', 1).cells[0]?.red).toBeGreaterThan(0.9);
  });
});

describe('chase', () => {
  it('moves the bright lens along all eight, twice per bar', () => {
    const order = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75].map((beat) =>
      brightest(render('chase', beat + 0.01)),
    );
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(brightest(render('chase', 2.01))).toBe(0);
  });

  it('leaves a tail behind the head, not in front of it', () => {
    const frame = render('chase', 0.76); // head just past lens 3
    expect(peak(frame.cells[2])).toBeGreaterThan(peak(frame.cells[4]));
  });
});

describe('bounce', () => {
  it('goes to the far end and comes back within one bar', () => {
    expect(brightest(render('bounce', 0))).toBe(0);
    expect(brightest(render('bounce', 2))).toBe(7);
    expect(brightest(render('bounce', 4))).toBe(0);
    expect(brightest(render('bounce', 1))).toBe(brightest(render('bounce', 3)));
  });
});

describe('bar swap', () => {
  it('lights one bar per beat, in turn, each in its own colour', () => {
    const first = render('swap', 0.05);
    expect(peak(first.cells[0])).toBeGreaterThan(0.5);
    expect(peak(first.cells[4])).toBeLessThan(0.1);
    expect(first.cells[0]?.red).toBeGreaterThan(first.cells[0]?.blue ?? 0);

    const second = render('swap', 1.05);
    expect(peak(second.cells[0])).toBeLessThan(0.1);
    expect(peak(second.cells[4])).toBeGreaterThan(0.5);
    expect(second.cells[4]?.blue).toBeGreaterThan(second.cells[4]?.red ?? 0);
  });
});

describe('spectrum', () => {
  it('ignores the chosen colours', () => {
    const black: Rgbw = { red: 0, green: 0, blue: 0, white: 0 };
    expect(render('spectrum', 2.2, { a: black, b: black })).toEqual(render('spectrum', 2.2));
    expect(total(render('spectrum', 2.2, { a: black, b: black }))).toBeGreaterThan(2);
  });

  it('gives neighbouring lenses different colours', () => {
    const frame = render('spectrum', 0.5);
    expect(new Set(frame.cells.map((c) => JSON.stringify(c))).size).toBe(8);
  });
});

describe('sparkle', () => {
  it('keeps a dim wash and lets only some lenses flash', () => {
    let flashes = 0;
    let slots = 0;
    for (let beat = 0; beat < 32; beat += 0.25) {
      const frame = render('sparkle', beat + 0.01);
      for (const cell of frame.cells) {
        slots++;
        if (cell.blue > 0.5) flashes++;
        else expect(peak(cell)).toBeLessThan(0.2);
      }
    }
    expect(flashes / slots).toBeGreaterThan(0.1);
    expect(flashes / slots).toBeLessThan(0.35);
  });
});

describe('build-up', () => {
  it('gets brighter and wider, then drops on the second colour', () => {
    const early = render('build', 1.1);
    const late = render('build', 13.01);
    expect(total(late)).toBeGreaterThan(total(early));
    expect(early.cells.filter((c) => peak(c) > 0).length).toBeLessThan(
      late.cells.filter((c) => peak(c) > 0).length,
    );
    expect(peak(early.cells[0])).toBe(0);

    const drop = render('build', 15.02);
    for (const cell of drop.cells) {
      expect(cell.blue).toBeGreaterThan(0.9);
      expect(cell.red).toBe(0);
    }
  });

  it('starts again after sixteen beats', () => {
    expect(render('build', 17.3)).toEqual(render('build', 1.3));
  });
});

describe('strobe burst', () => {
  it('flashes only during the fourth beat', () => {
    for (const beat of [0.3, 1.3, 2.3]) {
      const frame = render('burst', beat);
      expect(frame.cells[0]?.blue).toBe(0);
      expect(peak(frame.cells[0])).toBeLessThan(0.7);
    }
    const on = render('burst', 3.01);
    const off = render('burst', 3.2);
    expect(on.cells[0]?.blue).toBe(1);
    expect(total(off)).toBe(0);
  });
});

describe('scissor', () => {
  it('tilts the bars against each other around the middle', () => {
    for (let beat = 0; beat < 8; beat += 0.5) {
      const tilt = render('scissor', beat).tilt ?? [];
      expect((tilt[0] ?? 0) + (tilt[1] ?? 0)).toBeCloseTo(1);
    }
    const quarter = render('scissor', 2).tilt ?? [];
    expect(quarter[0]).toBeCloseTo(0.8);
    expect(quarter[1]).toBeCloseTo(0.2);
  });

  it('gives each bar its own colour', () => {
    const frame = render('scissor', 0);
    expect(frame.cells[0]?.red).toBeGreaterThan(0.9);
    expect(frame.cells[7]?.blue).toBeGreaterThan(0.9);
  });
});

describe('flash rate limit', () => {
  it('halves the subdivision until the rate is within the limit', () => {
    expect(flashesPerBeat(126, 4)).toBe(4); // 8.4 per second
    expect(flashesPerBeat(160, 4)).toBe(2); // 10.7 would be too fast
    expect(flashesPerBeat(280, 4)).toBe(2);
    expect(flashesPerBeat(400, 4)).toBe(1);
    expect(flashesPerBeat(126, 1)).toBe(1);
  });

  /** Counts dark-to-bright changes of lens 0 per second over a stretch of music. */
  function flashesPerSecond(id: string, bpm: number, fromBeat: number, toBeat: number): number {
    const step = 0.002;
    let flashes = 0;
    let wasOn = false;
    for (let beat = fromBeat; beat < toBeat; beat += step) {
      const on = peak(render(id, beat, { bpm }).cells[3]) > 0.5;
      if (on && !wasOn) flashes++;
      wasOn = on;
    }
    const seconds = ((toBeat - fromBeat) / bpm) * 60;
    return flashes / seconds;
  }

  it.each([126, 140, 180, 252, 400])('keeps strobe burst within the limit at %i bpm', (bpm) => {
    expect(flashesPerSecond('burst', bpm, 3, 4)).toBeLessThanOrEqual(MAX_FLASH_HZ + 0.5);
  });

  it.each([126, 140, 180, 252, 400])('keeps build-up within the limit at %i bpm', (bpm) => {
    expect(flashesPerSecond('build', bpm, 12, 15)).toBeLessThanOrEqual(MAX_FLASH_HZ + 0.5);
  });
});
