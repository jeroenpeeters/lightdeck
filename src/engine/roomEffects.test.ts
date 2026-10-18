import { describe, expect, it } from 'vitest';
import type { Rgbw } from './colour.js';
import type { EffectContext } from './effects.js';
import { type PaletteColour, paint } from './palette.js';
import { findRoomEffect, PERIOD_BEATS, ROOM_EFFECTS } from './roomEffects.js';

const RED: Rgbw = { red: 1, green: 0, blue: 0, white: 0 };
const GREEN: Rgbw = { red: 0, green: 1, blue: 0, white: 0 };
const BLUE: Rgbw = { red: 0, green: 0, blue: 1, white: 0 };
const DARK: Rgbw = { red: 0, green: 0, blue: 0, white: 0 };

function context(beat: number, extra: Partial<EffectContext> = {}): EffectContext {
  return {
    beat,
    cells: 6,
    bars: [
      [0, 1],
      [2, 3, 4],
    ],
    slots: 3,
    ...extra,
  };
}

/** The slot each lamp gets (the one with level 1), or -1 for a dark lamp. */
function slotsOf(id: string, beat: number, extra: Partial<EffectContext> = {}): number[] {
  const effect = findRoomEffect(id);
  if (!effect) throw new Error(`no effect ${id}`);
  return effect.render(context(beat, extra)).levels.map((row) => row.indexOf(1));
}

/** The lamps as they look with a palette. */
function look(
  id: string,
  beat: number,
  colours: PaletteColour[] = [RED, GREEN, BLUE],
  extra: Partial<EffectContext> = {},
): Rgbw[] {
  const effect = findRoomEffect(id);
  if (!effect) throw new Error(`no effect ${id}`);
  const frame = effect.render(context(beat, { slots: colours.length, ...extra }));
  return paint(frame.levels, { colours, mode: 'static', change: 'step', speed: 1 }, 0);
}

describe('the set of room effects', () => {
  it('has four, each with its own id, a name and a description', () => {
    expect(ROOM_EFFECTS.map((effect) => effect.id)).toEqual([
      'still',
      'rotate',
      'shuffle',
      'zones',
    ]);
    for (const effect of ROOM_EFFECTS) {
      expect(effect.name).not.toBe('');
      expect(effect.description).not.toBe('');
      expect(findRoomEffect(effect.id)).toBe(effect);
    }
    expect(findRoomEffect('kick')).toBeUndefined();
  });

  it('gives every lamp one slot, or no light when the palette has none', () => {
    for (const effect of ROOM_EFFECTS) {
      for (const lamps of [1, 2, 5, 12]) {
        for (const slots of [1, 2, 3, 8]) {
          for (const beat of [0, 7.3, 19.99, 20, 41, 400]) {
            const { levels } = effect.render(context(beat, { cells: lamps, bars: [], slots }));
            expect(levels).toHaveLength(lamps);
            for (const row of levels) {
              expect(row).toHaveLength(slots);
              expect(row.reduce((sum, level) => sum + level, 0)).toBe(1);
            }
          }
        }
      }
      const none = effect.render(context(0, { slots: 0 }));
      expect(none.levels).toHaveLength(6);
      expect(none.levels.every((row) => row.length === 0)).toBe(true);
    }
  });

  it('is the same picture for the same moment', () => {
    for (const effect of ROOM_EFFECTS) {
      expect(effect.render(context(63.4))).toEqual(effect.render(context(63.4)));
    }
  });

  it('changes only at the end of a period, and then once', () => {
    for (const effect of ROOM_EFFECTS) {
      const pictures: string[] = [];
      for (let beat = 0; beat < PERIOD_BEATS * 6; beat += 0.25) {
        const picture = JSON.stringify(effect.render(context(beat)));
        if (pictures[pictures.length - 1] !== picture) pictures.push(picture);
      }
      // Never more than one new picture per period.
      expect(pictures.length).toBeLessThanOrEqual(6);
    }
  });
});

describe('still', () => {
  it('spreads the colours over the lamps and goes on round', () => {
    expect(slotsOf('still', 0)).toEqual([0, 1, 2, 0, 1, 2]);
    expect(slotsOf('still', 0, { cells: 5, slots: 2 })).toEqual([0, 1, 0, 1, 0]);
  });

  it('never moves', () => {
    expect(slotsOf('still', 10_000)).toEqual(slotsOf('still', 0));
  });

  it('shows the colours of the palette', () => {
    expect(look('still', 0)).toEqual([RED, GREEN, BLUE, RED, GREEN, BLUE]);
  });

  it('leaves a lamp dark when its slot is off', () => {
    expect(look('still', 0, [RED, null])).toEqual([RED, DARK, RED, DARK, RED, DARK]);
  });
});

describe('rotate', () => {
  it('starts like still and moves on one lamp every period', () => {
    expect(slotsOf('rotate', 0)).toEqual([0, 1, 2, 0, 1, 2]);
    expect(slotsOf('rotate', PERIOD_BEATS - 0.01)).toEqual([0, 1, 2, 0, 1, 2]);
    expect(slotsOf('rotate', PERIOD_BEATS)).toEqual([1, 2, 0, 1, 2, 0]);
    expect(slotsOf('rotate', 2 * PERIOD_BEATS)).toEqual([2, 0, 1, 2, 0, 1]);
  });

  it('comes back to its start after as many periods as there are colours', () => {
    expect(slotsOf('rotate', 3 * PERIOD_BEATS)).toEqual(slotsOf('rotate', 0));
  });

  it('turns two colours over each period', () => {
    const before = look('rotate', 0, [RED, GREEN]);
    const after = look('rotate', PERIOD_BEATS, [RED, GREEN]);
    expect(before.slice(0, 2)).toEqual([RED, GREEN]);
    expect(after.slice(0, 2)).toEqual([GREEN, RED]);
  });

  it('does not go negative before the first beat', () => {
    expect(slotsOf('rotate', -5)).toEqual(slotsOf('rotate', 0));
  });
});

describe('shuffle', () => {
  it('keeps the same colours on the lamps and only changes who has which', () => {
    for (let block = 0; block < 12; block++) {
      const slots = slotsOf('shuffle', block * PERIOD_BEATS + 3);
      expect([...slots].sort()).toEqual([0, 0, 1, 1, 2, 2]);
    }
  });

  it('holds the arrangement for a period and deals a new one at the next', () => {
    expect(slotsOf('shuffle', 0.5)).toEqual(slotsOf('shuffle', PERIOD_BEATS - 0.5));
    expect(slotsOf('shuffle', PERIOD_BEATS + 0.5)).toEqual(
      slotsOf('shuffle', 2 * PERIOD_BEATS - 0.5),
    );
  });

  it('does not deal the same arrangement twice in a row', () => {
    for (const lamps of [3, 4, 6, 9]) {
      let before = slotsOf('shuffle', 0, { cells: lamps });
      for (let block = 1; block < 60; block++) {
        const now = slotsOf('shuffle', block * PERIOD_BEATS, { cells: lamps });
        expect(now).not.toEqual(before);
        before = now;
      }
    }
  });

  it('is the same on every run: a fixture that joins in the middle shows the same picture', () => {
    expect(slotsOf('shuffle', 7 * PERIOD_BEATS + 1)).toEqual(
      slotsOf('shuffle', 7 * PERIOD_BEATS + 9),
    );
    expect(slotsOf('shuffle', 7 * PERIOD_BEATS + 1)).toEqual([1, 1, 2, 2, 0, 0]);
  });
});

describe('zones', () => {
  it('gives the lamps of a zone one colour', () => {
    // Zone one is lamps 0 and 1, zone two is lamps 2 to 4, lamp 5 is in none: a zone of its own.
    expect(slotsOf('zones', 0)).toEqual([0, 0, 1, 1, 1, 2]);
  });

  it('moves the zones on one colour every period', () => {
    expect(slotsOf('zones', PERIOD_BEATS)).toEqual([1, 1, 2, 2, 2, 0]);
    expect(slotsOf('zones', 2 * PERIOD_BEATS)).toEqual([2, 2, 0, 0, 0, 1]);
  });

  it('is one colour for the room without zones', () => {
    expect(slotsOf('zones', 0, { bars: [] })).toEqual([0, 0, 0, 0, 0, 0]);
    expect(slotsOf('zones', PERIOD_BEATS, { bars: [] })).toEqual([1, 1, 1, 1, 1, 1]);
  });
});
