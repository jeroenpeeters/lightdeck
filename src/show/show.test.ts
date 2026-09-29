import { describe, expect, it } from 'vitest';
import { PatchError } from '../server/fixture.js';
import { readLabel, readShow, ShowError, sceneId } from './show.js';

const anything = () => {};

describe('readLabel', () => {
  it('takes a name without the space around it', () => {
    expect(readLabel('  Amber   chase ')).toBe('Amber chase');
  });

  it('refuses what is not a name', () => {
    expect(() => readLabel('   ')).toThrow(PatchError);
    expect(() => readLabel(12)).toThrow(PatchError);
    expect(() => readLabel('x'.repeat(41))).toThrow(/40 characters/);
  });
});

describe('sceneId', () => {
  it('makes an id from the name', () => {
    expect(sceneId('Amber chase', new Set())).toBe('amber-chase');
    expect(sceneId('Café 2 (blauw)!', new Set())).toBe('cafe-2-blauw');
    expect(sceneId('***', new Set())).toBe('scene');
  });

  it('counts on when the id is taken', () => {
    expect(sceneId('Peak', new Set(['peak']))).toBe('peak-2');
    expect(sceneId('Peak', new Set(['peak', 'peak-2']))).toBe('peak-3');
  });
});

describe('readShow', () => {
  it('reads nothing as a show without scenes', () => {
    expect(readShow(null, anything)).toEqual({ scenes: [] });
    expect(readShow({}, anything)).toEqual({ scenes: [] });
    expect(readShow({ scenes: null }, anything)).toEqual({ scenes: [] });
  });

  it('reads the scenes in the order of the file', () => {
    const show = readShow(
      {
        scenes: {
          warm: { label: 'Warm', fixtures: { spider: { levels: { dimmer: 1 } } } },
          dark: {},
        },
      },
      anything,
    );
    expect(show.scenes).toEqual([
      { id: 'warm', label: 'Warm', fixtures: { spider: { levels: { dimmer: 1 } } } },
      { id: 'dark', label: 'dark', fixtures: {} },
    ]);
  });

  it('hands every part to the check, and says which scene it refused', () => {
    const seen: unknown[] = [];
    const check = (fixture: string, part: unknown) => {
      seen.push([fixture, part]);
      if (fixture === 'strobe') throw new PatchError('there is no fixture called "strobe"');
    };
    expect(() =>
      readShow({ scenes: { one: { fixtures: { spider: { a: 1 }, strobe: {} } } } }, check),
    ).toThrow(new ShowError('scene "one": there is no fixture called "strobe"'));
    expect(seen).toEqual([
      ['spider', { a: 1 }],
      ['strobe', {}],
    ]);
  });

  it('says what is wrong with a show that is not one', () => {
    const wrong: [unknown, RegExp][] = [
      [[], /must start with "scenes:"/],
      [{ sequences: {} }, /cannot have "sequences"/],
      [{ scenes: [] }, /by their id/],
      [{ scenes: { 'Amber chase': {} } }, /small letters, digits and dashes/],
      [{ scenes: { one: 'warm' } }, /must have a label and fixtures/],
      [{ scenes: { one: { colour: 'red' } } }, /cannot have "colour"/],
      [{ scenes: { one: { fixtures: ['spider'] } } }, /must name fixtures/],
      [{ scenes: { one: { label: '' } } }, /scene "one": a scene needs a name/],
    ];
    for (const [data, message] of wrong) {
      expect(() => readShow(data, anything)).toThrow(message);
      expect(() => readShow(data, anything)).toThrow(ShowError);
    }
  });
});
