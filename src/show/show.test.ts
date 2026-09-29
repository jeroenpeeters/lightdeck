import { describe, expect, it } from 'vitest';
import { PatchError } from '../server/fixture.js';
import {
  groupId,
  type KnownFixtures,
  readGroupFixtures,
  readLabel,
  readShow,
  ShowError,
  sceneId,
  startingGroups,
} from './show.js';

const SPIDER = { id: 'spider', label: 'Spider' };
const LASER = { id: 'laser', label: 'Laser' };
const RIG: KnownFixtures = { fixtures: [SPIDER, LASER], check: () => {} };

describe('readLabel', () => {
  it('takes a name without the space around it', () => {
    expect(readLabel('  Amber   chase ')).toBe('Amber chase');
  });

  it('refuses what is not a name', () => {
    expect(() => readLabel('   ')).toThrow(PatchError);
    expect(() => readLabel(12)).toThrow(new PatchError('a scene needs a name'));
    expect(() => readLabel('x'.repeat(41))).toThrow(/40 characters/);
  });

  it('says what the name is for', () => {
    expect(() => readLabel('', 'group')).toThrow(new PatchError('a group needs a name'));
    expect(() => readLabel('x'.repeat(41), 'group')).toThrow(/name of a group/);
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

  it('never gives "off"', () => {
    expect(sceneId('Off', new Set())).toBe('off-2');
  });
});

describe('groupId', () => {
  it('makes an id from the name, and counts on when it is taken', () => {
    expect(groupId('Front bar', new Set())).toBe('front-bar');
    expect(groupId('Spider', new Set(['spider']))).toBe('spider-2');
    expect(groupId('!!', new Set())).toBe('group');
    expect(groupId('Off', new Set())).toBe('off');
  });
});

describe('readGroupFixtures', () => {
  it('takes the fixtures in the order they were given', () => {
    expect(readGroupFixtures(['laser', 'spider'], RIG.fixtures)).toEqual(['laser', 'spider']);
  });

  it('refuses what cannot be the fixtures of a group', () => {
    const wrong: [unknown, string][] = [
      ['spider', '"fixtures" must be a list of the fixtures of the group'],
      [undefined, '"fixtures" must be a list of the fixtures of the group'],
      [[], 'a group needs at least one fixture'],
      [[1], 'a fixture of a group is named by its id'],
      [['strobe'], 'there is no fixture called "strobe", only spider, laser'],
      [['spider', 'laser', 'spider'], '"spider" is in the group twice'],
    ];
    for (const [fixtures, message] of wrong) {
      expect(() => readGroupFixtures(fixtures, RIG.fixtures)).toThrow(new PatchError(message));
    }
  });
});

describe('startingGroups', () => {
  it('has a group for every fixture, and then one for all of them', () => {
    expect(startingGroups([SPIDER, LASER])).toEqual([
      { id: 'spider', label: 'Spider', fixtures: ['spider'], scenes: [] },
      { id: 'laser', label: 'Laser', fixtures: ['laser'], scenes: [] },
      { id: 'all', label: 'All', fixtures: ['spider', 'laser'], scenes: [] },
    ]);
  });

  it('has no separate group for all with one fixture', () => {
    expect(startingGroups([SPIDER])).toEqual([
      { id: 'spider', label: 'Spider', fixtures: ['spider'], scenes: [] },
    ]);
    expect(startingGroups([])).toEqual([]);
  });

  it('gives the group of all another id when a fixture is called "all"', () => {
    const groups = startingGroups([SPIDER, { id: 'all', label: 'All round' }]);
    expect(groups.map((group) => [group.id, group.label])).toEqual([
      ['spider', 'Spider'],
      ['all', 'All round'],
      ['all-2', 'All'],
    ]);
    expect(groups[2]?.fixtures).toEqual(['spider', 'all']);
  });

  it('makes a name of a group from whatever a fixture is called', () => {
    const [group] = startingGroups([{ id: 'wash', label: `  ${'long '.repeat(12)}` }]);
    expect(group?.label).toHaveLength(39);
    expect(startingGroups([{ id: 'wash', label: ' ' }])[0]?.label).toBe('wash');
  });
});

describe('readShow', () => {
  it('reads nothing as the groups a show starts with', () => {
    const starting = { groups: startingGroups(RIG.fixtures) };
    expect(readShow(null, RIG)).toEqual(starting);
    expect(readShow(undefined, RIG)).toEqual(starting);
    expect(readShow({}, RIG)).toEqual(starting);
  });

  it('reads the groups and their scenes in the order of the file', () => {
    const show = readShow(
      {
        groups: {
          laser: {
            label: 'Laser',
            fixtures: ['laser'],
            scenes: { tunnel: { label: 'Tunnel', fixtures: { laser: { raw: { mode: 95 } } } } },
          },
          both: {
            fixtures: ['laser', 'spider'],
            scenes: {
              warm: { label: 'Warm', fixtures: { spider: { levels: { dimmer: 1 } } } },
              dark: {},
            },
          },
          bare: { fixtures: ['spider'] },
        },
      },
      RIG,
    );
    expect(show.groups).toEqual([
      {
        id: 'laser',
        label: 'Laser',
        fixtures: ['laser'],
        scenes: [{ id: 'tunnel', label: 'Tunnel', fixtures: { laser: { raw: { mode: 95 } } } }],
      },
      {
        id: 'both',
        label: 'both',
        fixtures: ['laser', 'spider'],
        scenes: [
          { id: 'warm', label: 'Warm', fixtures: { spider: { levels: { dimmer: 1 } } } },
          { id: 'dark', label: 'dark', fixtures: {} },
        ],
      },
      { id: 'bare', label: 'bare', fixtures: ['spider'], scenes: [] },
    ]);
  });

  it('keeps the order of a map, also where an id is a number', () => {
    const scenes = new Map([
      ['warm', { label: 'Warm' }],
      ['2', { label: 'Two' }],
      ['1', { label: 'One' }],
    ]);
    const groups = new Map([
      ['spider', { fixtures: ['spider'], scenes }],
      ['7', { fixtures: ['laser'] }],
    ]);
    const show = readShow({ groups }, RIG);
    expect(show.groups.map((group) => group.id)).toEqual(['spider', '7']);
    expect(show.groups[0]?.scenes.map((scene) => scene.id)).toEqual(['warm', '2', '1']);
    expect(readShow({ scenes }, RIG).groups[2]?.scenes.map((scene) => scene.id)).toEqual([
      'warm',
      '2',
      '1',
    ]);
  });

  it('can have no groups at all', () => {
    expect(readShow({ groups: {} }, RIG)).toEqual({ groups: [] });
    expect(readShow({ groups: null }, RIG)).toEqual({ groups: [] });
  });

  it('gives two groups a scene of the same id', () => {
    const scenes = { peak: {} };
    const show = readShow(
      {
        groups: {
          spider: { fixtures: ['spider'], scenes },
          laser: { fixtures: ['laser'], scenes },
        },
      },
      RIG,
    );
    expect(show.groups.map((group) => group.scenes[0]?.id)).toEqual(['peak', 'peak']);
  });

  it('reads a file from before there were groups, with its scenes in the group of all', () => {
    const show = readShow(
      {
        scenes: {
          warm: { label: 'Warm', fixtures: { spider: { levels: { dimmer: 1 } }, laser: {} } },
          dark: {},
        },
      },
      RIG,
    );
    expect(show.groups.map((group) => [group.id, group.scenes.map((scene) => scene.id)])).toEqual([
      ['spider', []],
      ['laser', []],
      ['all', ['warm', 'dark']],
    ]);
    expect(show.groups[2]?.scenes[0]).toEqual({
      id: 'warm',
      label: 'Warm',
      fixtures: { spider: { levels: { dimmer: 1 } }, laser: {} },
    });
    expect(readShow({ scenes: null }, RIG)).toEqual({ groups: startingGroups(RIG.fixtures) });
  });

  it('puts the scenes from before there were groups with the one fixture there is', () => {
    const show = readShow({ scenes: { warm: {} } }, { ...RIG, fixtures: [SPIDER] });
    expect(show.groups).toEqual([
      {
        id: 'spider',
        label: 'Spider',
        fixtures: ['spider'],
        scenes: [{ id: 'warm', label: 'warm', fixtures: {} }],
      },
    ]);
  });

  it('hands every part to the check, and says which scene it refused', () => {
    const seen: unknown[] = [];
    const check = (fixture: string, part: unknown) => {
      seen.push([fixture, part]);
      if (fixture === 'laser') throw new PatchError('"mode" must be a whole number');
    };
    const fixtures = { spider: { a: 1 }, laser: {} };
    expect(() =>
      readShow(
        { groups: { both: { fixtures: ['spider', 'laser'], scenes: { one: { fixtures } } } } },
        { ...RIG, check },
      ),
    ).toThrow(new ShowError('scene "one" of group "both": "mode" must be a whole number'));
    expect(seen).toEqual([
      ['spider', { a: 1 }],
      ['laser', {}],
    ]);

    expect(() => readShow({ scenes: { one: { fixtures } } }, { ...RIG, check })).toThrow(
      new ShowError('scene "one": "mode" must be a whole number'),
    );
  });

  it('says what is wrong with a show that is not one', () => {
    const group = (scenes: unknown) => ({ groups: { spider: { fixtures: ['spider'], scenes } } });
    const wrong: [unknown, string][] = [
      [[], 'the show must start with "groups:"'],
      ['groups', 'the show must start with "groups:"'],
      [{ sequences: {} }, 'the show cannot have "sequences", only groups'],
      [{ groups: {}, sequences: {} }, 'the show cannot have "sequences", only groups'],
      [
        { scenes: {}, groups: {} },
        'the show has "scenes" next to "groups". A scene belongs to a group: put it under the "scenes" of its group',
      ],
      [{ groups: [] }, '"groups" must be a list of groups by their id'],
      [
        { groups: { 'Front bar': {} } },
        'group "Front bar": an id has small letters, digits and dashes only',
      ],
      [{ groups: { spider: 'spider' } }, 'group "spider" must have a label, fixtures and scenes'],
      [
        { groups: { spider: { fixtures: ['spider'], colour: 'red' } } },
        'group "spider" cannot have "colour", only label, fixtures and scenes',
      ],
      [
        { groups: { spider: { fixtures: ['spider'], label: '' } } },
        'group "spider": a group needs a name',
      ],
      [{ groups: { spider: {} } }, 'group "spider": a group needs at least one fixture'],
      [
        { groups: { spider: { fixtures: [] } } },
        'group "spider": a group needs at least one fixture',
      ],
      [
        { groups: { spider: { fixtures: 'spider' } } },
        'group "spider": "fixtures" must be a list of the fixtures of the group',
      ],
      [
        { groups: { front: { fixtures: ['spider', 'strobe'] } } },
        'group "front": there is no fixture called "strobe", only spider, laser',
      ],
      [
        { groups: { front: { fixtures: ['spider', 'spider'] } } },
        'group "front": "spider" is in the group twice',
      ],
      [group([]), 'group "spider": "scenes" must be a list of scenes by their id'],
      [
        group({ 'Amber chase': {} }),
        'scene "Amber chase" of group "spider": an id has small letters, digits and dashes only',
      ],
      [
        group({ off: {} }),
        'scene "off" of group "spider": "off" cannot be the id of a scene, every group has an off already',
      ],
      [group({ one: 'warm' }), 'scene "one" of group "spider" must have a label and fixtures'],
      [
        group({ one: { colour: 'red' } }),
        'scene "one" of group "spider" cannot have "colour", only label and fixtures',
      ],
      [
        group({ one: { fixtures: ['spider'] } }),
        'scene "one" of group "spider": "fixtures" must name fixtures',
      ],
      [group({ one: { label: '' } }), 'scene "one" of group "spider": a scene needs a name'],
      [
        group({ one: { fixtures: { laser: {} } } }),
        'scene "one" of group "spider": "laser" is not a fixture of this group, which has spider',
      ],
      [
        group({ one: { fixtures: { strobe: {} } } }),
        'scene "one" of group "spider": there is no fixture called "strobe", only spider, laser',
      ],
      [{ scenes: [] }, '"scenes" must be a list of scenes by their id'],
      [
        { scenes: { 'Amber chase': {} } },
        'scene "Amber chase": an id has small letters, digits and dashes only',
      ],
      [
        { scenes: { off: {} } },
        'scene "off": "off" cannot be the id of a scene, every group has an off already',
      ],
      [{ scenes: { one: 'warm' } }, 'scene "one" must have a label and fixtures'],
      [
        { scenes: { one: { fixtures: { strobe: {} } } } },
        'scene "one": there is no fixture called "strobe", only spider, laser',
      ],
    ];
    for (const [data, message] of wrong) {
      expect(() => readShow(data, RIG)).toThrow(new ShowError(message));
      expect(() => readShow(data, RIG)).toThrow(ShowError);
    }
  });

  it('cannot put scenes from before there were groups anywhere without a fixture', () => {
    const nothing: KnownFixtures = { fixtures: [], check: () => {} };
    expect(readShow({ scenes: {} }, nothing)).toEqual({ groups: [] });
    expect(() => readShow({ scenes: { warm: {} } }, nothing)).toThrow(
      new ShowError('the show has scenes, and there is no fixture they can be for'),
    );
  });
});
