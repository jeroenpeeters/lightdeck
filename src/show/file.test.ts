import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Document } from 'yaml';
import { PatchError } from '../server/fixture.js';
import { ShowFile, setIn } from './file.js';
import { type ShowFixture, startingGroups } from './show.js';

const FIXTURES: ShowFixture[] = [
  { id: 'spider', label: 'Spider' },
  { id: 'laser', label: 'Laser' },
];
const check = (_fixture: string, part: unknown) => {
  if (part === 'wrong') throw new PatchError('this is not what the fixture can do');
};

const HAND_MADE = `# The show of the evening.
groups:
  spider:
    label: Spider # the one on the truss
    fixtures: [spider]
    scenes:
      warm:
        label: Warm # the opener
        fixtures:
          spider:
            levels:
              dimmer: 1
  # Both of them, for the peaks.
  both:
    label: Both
    fixtures:
      - spider
      - laser
`;

const STEP_ONE = `# The show of the evening.
scenes:
  # Starts the night.
  warm:
    label: Warm # the opener
    fixtures:
      spider:
        levels:
          dimmer: 1
      laser: { raw: { mode: 95 } }
  dark:
    label: Dark
    fixtures: {}
`;

/** Ids as YAML reads them when nobody looks: a number, a yes, a thousand. */
const NUMBERS = `groups:
  spider:
    label: Spider
    fixtures: [spider]
    scenes:
      warm:
        label: Warm
      2:
        label: Two
        fixtures: { spider: { levels: { dimmer: 0.5 } } }
      1:
        label: One # the first
        fixtures: { spider: { levels: { dimmer: 1 } } }
      true:
        label: Sure
  2024:
    label: This year
    fixtures: [laser]
`;

/** A reference to something that is not there. YAML reads it, and cannot say what it holds. */
const NOWHERE = `groups:
  laser:
    label: *name
    fixtures: [laser]
`;

/** A change that adds a scene without fixtures to a group. */
const addScene = (group: string, id: string) => (document: Document) =>
  setIn(document, ['groups', group, 'scenes', id], { label: id, fixtures: {} });

describe('ShowFile', () => {
  let dir: string;
  let path: string;
  let file: ShowFile | undefined;

  const open = (fixtures: readonly ShowFixture[] = FIXTURES) => {
    file = new ShowFile({ path, fixtures, check });
    return file;
  };
  /** The ids of the groups, each with the ids of its scenes. */
  const ids = (from: ShowFile) =>
    from.getShow().groups.map((group) => [group.id, ...group.scenes.map((scene) => scene.id)]);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lightdeck-show-'));
    path = join(dir, 'show.yaml');
  });
  afterEach(() => {
    file?.close();
    file = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts with a group per fixture and one for all, and makes no file', () => {
    const show = open();
    expect(show.getShow()).toEqual({ groups: startingGroups(FIXTURES) });
    expect(ids(show)).toEqual([['spider'], ['laser'], ['all']]);
    expect(show.getProblem()).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it('reads an empty file as the groups a show starts with, and leaves it empty', () => {
    for (const text of ['', '# Nothing yet.\n']) {
      writeFileSync(path, text);
      const show = open();
      expect(ids(show)).toEqual([['spider'], ['laser'], ['all']]);
      expect(show.getProblem()).toBeNull();
      expect(readFileSync(path, 'utf8')).toBe(text);
      show.close();
    }
  });

  it('reads the file that is there', () => {
    writeFileSync(path, HAND_MADE);
    expect(open().getShow().groups).toEqual([
      {
        id: 'spider',
        label: 'Spider',
        fixtures: ['spider'],
        scenes: [{ id: 'warm', label: 'Warm', fixtures: { spider: { levels: { dimmer: 1 } } } }],
      },
      { id: 'both', label: 'Both', fixtures: ['spider', 'laser'], scenes: [] },
    ]);
    expect(readFileSync(path, 'utf8')).toBe(HAND_MADE);
  });

  it('writes a change to the file, which reads back as the same show', () => {
    const show = open();
    const colour = { red: 1, green: 0.58, blue: 0, white: 0 };
    show.edit((document) =>
      setIn(document, ['groups', 'spider', 'scenes', 'amber'], {
        label: 'Amber',
        fixtures: { spider: { effect: { id: 'chase', colourA: colour, colourB: colour } } },
      }),
    );
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('colourA: { red: 1, green: 0.58, blue: 0, white: 0 }');
    expect(text).toContain('colourB: { red: 1, green: 0.58, blue: 0, white: 0 }');
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(ids(show)).toEqual([['spider', 'amber'], ['laser'], ['all']]);
    show.close();
    expect(open().getShow()).toEqual(show.getShow());
  });

  it('writes the groups a show starts with at the first change', () => {
    const show = open();
    show.edit(addScene('laser', 'tunnel'));
    expect(readFileSync(path, 'utf8')).toBe(`groups:
  spider:
    label: Spider
    fixtures: [ spider ]
    scenes: {}
  laser:
    label: Laser
    fixtures: [ laser ]
    scenes:
      tunnel:
        label: tunnel
        fixtures: {}
  all:
    label: All
    fixtures: [ spider, laser ]
    scenes: {}
`);
  });

  it('keeps the comments and the order of a file made by hand', () => {
    writeFileSync(path, HAND_MADE);
    const show = open();
    show.edit(addScene('spider', 'cold'));
    show.edit(addScene('both', 'peak'));
    show.edit((document) =>
      setIn(document, ['groups', 'spider', 'scenes', 'warm', 'fixtures'], { spider: {} }),
    );
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('# The show of the evening.');
    expect(text).toContain('# the one on the truss');
    expect(text).toContain('# the opener');
    expect(text).toContain('# Both of them, for the peaks.');
    expect(ids(show)).toEqual([
      ['spider', 'warm', 'cold'],
      ['both', 'peak'],
    ]);
    expect(show.getShow().groups[0]?.scenes[0]?.fixtures).toEqual({ spider: {} });
  });

  describe('with a file from before there were groups', () => {
    it('reads it without writing to it', () => {
      writeFileSync(path, STEP_ONE);
      const show = open();
      expect(show.getProblem()).toBeNull();
      expect(ids(show)).toEqual([['spider'], ['laser'], ['all', 'warm', 'dark']]);
      expect(show.getShow().groups[2]?.scenes[0]).toEqual({
        id: 'warm',
        label: 'Warm',
        fixtures: { spider: { levels: { dimmer: 1 } }, laser: { raw: { mode: 95 } } },
      });
      expect(readFileSync(path, 'utf8')).toBe(STEP_ONE);
    });

    it('does not write to it when it is followed either', async () => {
      writeFileSync(path, 'scenes: {}\n');
      const show = open();
      show.watch();
      writeFileSync(path, STEP_ONE);
      await vi.waitFor(() => expect(ids(show)[2]).toEqual(['all', 'warm', 'dark']), {
        timeout: 2000,
      });
      expect(readFileSync(path, 'utf8')).toBe(STEP_ONE);
    });

    it('writes it with groups at the first change, and keeps what was stored', () => {
      writeFileSync(path, STEP_ONE);
      const show = open();
      const before = show.getShow().groups[2]?.scenes;
      show.edit(addScene('spider', 'cold'));

      expect(ids(show)).toEqual([['spider', 'cold'], ['laser'], ['all', 'warm', 'dark']]);
      expect(show.getShow().groups[2]?.scenes).toEqual(before);
      const text = readFileSync(path, 'utf8');
      expect(text).toMatch(/^# The show of the evening\.\ngroups:\n {2}spider:\n/);
      expect(text).not.toMatch(/^scenes:/m);
      expect(text).toContain('fixtures: [ spider, laser ]');
      expect(text).toContain('      # Starts the night.\n      warm:\n');
      expect(text).toContain('label: Warm # the opener');

      show.close();
      const again = open();
      expect(again.getProblem()).toBeNull();
      expect(again.getShow()).toEqual(show.getShow());
    });

    it('keeps the scenes with the one fixture there is', () => {
      writeFileSync(path, 'scenes:\n  warm:\n    label: Warm\n');
      const show = open([{ id: 'spider', label: 'Spider' }]);
      expect(ids(show)).toEqual([['spider', 'warm']]);
      show.edit(addScene('spider', 'cold'));
      expect(ids(show)).toEqual([['spider', 'warm', 'cold']]);
      expect(readFileSync(path, 'utf8')).toContain('groups:\n  spider:\n');
    });

    it('starts a file that has "scenes:" and nothing under it', () => {
      writeFileSync(path, 'scenes:\n');
      const show = open();
      show.edit(addScene('all', 'one'));
      expect(ids(show)).toEqual([['spider'], ['laser'], ['all', 'one']]);
      expect(readFileSync(path, 'utf8')).not.toMatch(/^scenes:/m);
    });

    it('leaves it as it is when the first change is refused', () => {
      writeFileSync(path, STEP_ONE);
      const show = open();
      expect(() => show.edit(addScene('strobe', 'one'))).toThrow(PatchError);
      expect(readFileSync(path, 'utf8')).toBe(STEP_ONE);
      expect(ids(show)).toEqual([['spider'], ['laser'], ['all', 'warm', 'dark']]);
    });
  });

  describe('with ids that are numbers', () => {
    it('reads them as they were typed, in the order of the file', () => {
      writeFileSync(path, NUMBERS);
      const show = open();
      expect(show.getProblem()).toBeNull();
      expect(ids(show)).toEqual([['spider', 'warm', '2', '1', 'true'], ['2024']]);
      expect(readFileSync(path, 'utf8')).toBe(NUMBERS);
    });

    it('changes the one that is there, and makes no second one', () => {
      writeFileSync(path, NUMBERS);
      const show = open();
      show.edit((document) => {
        setIn(document, ['groups', 'spider', 'scenes', '1', 'label'], 'Opening');
        setIn(document, ['groups', 'spider', 'scenes', 'true', 'label'], 'Certain');
        setIn(document, ['groups', '2024', 'label'], 'Next year');
      });
      expect(show.getShow().groups[0]?.scenes[2]).toEqual({
        id: '1',
        label: 'Opening',
        fixtures: { spider: { levels: { dimmer: 1 } } },
      });
      expect(show.getShow().groups[0]?.scenes[3]?.label).toBe('Certain');
      expect(show.getShow().groups[1]?.label).toBe('Next year');
      const text = readFileSync(path, 'utf8');
      expect(text.match(/^ {6}"?1"?:/gm)).toHaveLength(1);
      expect(text.match(/^ {6}"?true"?:/gm)).toHaveLength(1);
      expect(text.match(/^ {2}"?2024"?:/gm)).toHaveLength(1);
      expect(text).toContain('# the first');

      show.close();
      expect(open().getShow()).toEqual(show.getShow());
    });

    it('takes them away', () => {
      writeFileSync(path, NUMBERS);
      const show = open();
      show.edit((document) => {
        expect(document.deleteIn(['groups', 'spider', 'scenes', '2'])).toBe(true);
        expect(document.deleteIn(['groups', '2024'])).toBe(true);
      });
      expect(ids(show)).toEqual([['spider', 'warm', '1', 'true']]);
      expect(readFileSync(path, 'utf8')).not.toMatch(/2024|Two/);
    });

    it('keeps the order of what the deck added', () => {
      const show = open();
      for (const id of ['warm', '2', '1']) show.edit(addScene('spider', id));
      show.edit((document) =>
        setIn(document, ['groups', '7'], { label: '7', fixtures: ['spider'], scenes: {} }),
      );
      const order = [['spider', 'warm', '2', '1'], ['laser'], ['all'], ['7']];
      expect(ids(show)).toEqual(order);
      show.close();
      expect(ids(open())).toEqual(order);
    });

    it('does not use a file that has the same id as a number and as a word', () => {
      const twice = NUMBERS.replace('      true:', '      "1":\n        label: Again\n      true:');
      writeFileSync(path, twice);
      const show = open();
      expect(show.getProblem()).toBe('Scene "1" of group "spider" is in the file twice');
      expect(() => show.edit(addScene('spider', 'one'))).toThrow(/has a mistake/);
      expect(readFileSync(path, 'utf8')).toBe(twice);
    });

    it('says so when what was typed cannot be an id', () => {
      writeFileSync(path, NUMBERS.replace('2024:', '1.5:'));
      expect(open().getProblem()).toBe(
        `Group "1.5": an id has small letters, digits and dashes only`,
      );
    });
  });

  describe('after it was read again', () => {
    /** The longest line of the file. */
    const longest = () =>
      Math.max(
        ...readFileSync(path, 'utf8')
          .split('\n')
          .map((line) => line.length),
      );
    const tunnel = (document: Document) =>
      setIn(document, ['groups', 'laser', 'scenes', 'tunnel'], {
        label: 'Tunnel',
        fixtures: { laser: { raw: { mode: 95, program: 60 }, effect: { id: 'twist' } } },
      });

    it('gives a scene lines of its own in a group that had none', () => {
      open().edit(addScene('spider', 'warm'));
      expect(readFileSync(path, 'utf8')).toContain(
        '  laser:\n    label: Laser\n    fixtures: [ laser ]\n    scenes: {}\n',
      );
      file?.close();

      const show = open();
      show.edit(tunnel);
      show.edit(addScene('laser', 'second'));
      expect(readFileSync(path, 'utf8')).toContain(`  laser:
    label: Laser
    fixtures: [ laser ]
    scenes:
      tunnel:
        label: Tunnel
        fixtures:
          laser:
            raw: { mode: 95, program: 60 }
            effect: { id: twist }
      second:
        label: second
        fixtures: {}
`);
    });

    it('gives a group lines of its own in a show that had none', () => {
      for (const empty of ['groups: {}\n', '{}\n', '{ groups: {} }\n']) {
        writeFileSync(path, empty);
        const show = open();
        show.edit((document) =>
          setIn(document, ['groups', 'laser'], { label: 'Laser', fixtures: ['laser'], scenes: {} }),
        );
        show.edit(tunnel);
        expect(longest()).toBeLessThan(50);
        expect(ids(show)).toEqual(
          empty === '{}\n' ? [['spider'], ['laser', 'tunnel'], ['all']] : [['laser', 'tunnel']],
        );
        show.close();
      }
    });

    it('leaves what was written by hand on one line on its line', () => {
      const byHand =
        '      warm: { label: Warm, fixtures: { spider: { levels: { dimmer: 1 } } } }\n';
      writeFileSync(path, `groups:\n  spider:\n    fixtures: [spider]\n    scenes:\n${byHand}`);
      const show = open();
      show.edit(addScene('spider', 'cold'));
      show.edit((document) =>
        setIn(document, ['groups', 'spider', 'scenes', 'warm', 'label'], 'Hot'),
      );
      expect(readFileSync(path, 'utf8')).toContain(byHand.replace('Warm', 'Hot'));
    });
  });

  it('keeps a show without groups without groups', () => {
    const show = open();
    for (const id of ['spider', 'laser', 'all']) {
      show.edit((document) => document.deleteIn(['groups', id]));
    }
    expect(show.getShow()).toEqual({ groups: [] });
    show.close();
    expect(open().getShow()).toEqual({ groups: [] });
  });

  it('tells about every change', () => {
    const show = open();
    const told = vi.fn();
    show.on('show', told);
    show.edit(addScene('all', 'one'));
    expect(told).toHaveBeenCalledTimes(1);
  });

  it('does not use a file with a mistake, and does not write over it', () => {
    const broken = 'groups:\n  front:\n    fixtures: [spider, strobe]\n';
    writeFileSync(path, broken);
    const show = open();
    expect(show.getShow()).toEqual({ groups: startingGroups(FIXTURES) });
    expect(show.getProblem()).toBe(
      'Group "front": there is no fixture called "strobe", only spider, laser',
    );
    expect(() => show.edit(addScene('spider', 'one'))).toThrow(/has a mistake/);
    expect(readFileSync(path, 'utf8')).toBe(broken);
  });

  it('does not use a file that has scenes both at the top and in groups', () => {
    const both = `${STEP_ONE}groups:\n  spider:\n    fixtures: [spider]\n`;
    writeFileSync(path, both);
    const show = open();
    expect(show.getProblem()).toMatch(/^The show has "scenes" next to "groups"/);
    expect(() => show.edit(addScene('spider', 'one'))).toThrow(PatchError);
    expect(readFileSync(path, 'utf8')).toBe(both);
  });

  describe('with a reference to something that is not there', () => {
    it('starts with the groups a show starts with, and says what is wrong', () => {
      writeFileSync(path, NOWHERE);
      const show = open();
      expect(ids(show)).toEqual([['spider'], ['laser'], ['all']]);
      expect(show.getProblem()).toMatch(/^Unresolved alias .*: name$/);
      expect(() => show.edit(addScene('spider', 'one'))).toThrow(/has a mistake/);
      expect(readFileSync(path, 'utf8')).toBe(NOWHERE);
    });

    it('goes on with the show it had when the file gets one', async () => {
      writeFileSync(path, HAND_MADE);
      const show = open();
      show.watch();
      writeFileSync(path, NOWHERE);
      await vi.waitFor(() => expect(show.getProblem()).toMatch(/^Unresolved alias/), {
        timeout: 2000,
      });
      expect(ids(show)).toEqual([['spider', 'warm'], ['both']]);
      expect(() => show.edit(addScene('spider', 'one'))).toThrow(/has a mistake/);
      expect(readFileSync(path, 'utf8')).toBe(NOWHERE);
    });
  });

  // Whoever runs as root can read everything.
  it.skipIf(process.getuid?.() === 0)(
    'uses a file again that could not be read for a moment',
    () => {
      writeFileSync(path, HAND_MADE);
      const show = open();
      chmodSync(path, 0o000);
      expect(() => show.edit(addScene('spider', 'one'))).toThrow(/It cannot be read/);
      expect(show.getProblem()).toMatch(/^It cannot be read/);
      expect(ids(show)).toEqual([['spider', 'warm'], ['both']]);

      chmodSync(path, 0o644);
      show.edit(addScene('spider', 'one'));
      expect(show.getProblem()).toBeNull();
      expect(ids(show)).toEqual([['spider', 'warm', 'one'], ['both']]);
      expect(readFileSync(path, 'utf8')).toContain('# the opener');
    },
  );

  it('does not know sequences yet', () => {
    writeFileSync(path, `${HAND_MADE}sequences: {}\n`);
    expect(open().getProblem()).toBe('The show cannot have "sequences", only groups');
  });

  it('says where YAML that cannot be read goes wrong', () => {
    writeFileSync(path, 'groups:\n  warm: [unfinished\n');
    expect(open().getProblem()).toMatch(/line 2|line 3/);
  });

  it('refuses a change that would not leave a show, and changes nothing', () => {
    writeFileSync(path, HAND_MADE);
    const show = open();
    expect(() =>
      show.edit((document) =>
        setIn(document, ['groups', 'spider', 'scenes', 'one'], { fixtures: { laser: {} } }),
      ),
    ).toThrow(/"laser" is not a fixture of this group/);
    expect(() =>
      show.edit((document) =>
        setIn(document, ['groups', 'both', 'scenes', 'one'], { fixtures: { laser: 'wrong' } }),
      ),
    ).toThrow(/not what the fixture can do/);
    expect(ids(show)).toEqual([['spider', 'warm'], ['both']]);
    expect(readFileSync(path, 'utf8')).toBe(HAND_MADE);
  });

  it('reads a file that changed by hand before it writes to it', () => {
    const show = open();
    writeFileSync(path, HAND_MADE);
    show.edit(addScene('both', 'cold'));
    expect(ids(show)).toEqual([
      ['spider', 'warm'],
      ['both', 'cold'],
    ]);
    expect(readFileSync(path, 'utf8')).toContain('# the opener');
  });

  it('hands a change the show as the file has it at that moment', () => {
    const show = open();
    writeFileSync(path, HAND_MADE);
    const given = show.edit((document, now) => {
      addScene('both', 'cold')(document);
      return now.groups.map((group) => group.id);
    });
    expect(given).toEqual(['spider', 'both']);
  });

  it('follows the file: a good one is the show, a bad one leaves the show as it was', async () => {
    const show = open();
    const told = vi.fn();
    show.on('show', told);
    show.watch();

    writeFileSync(path, HAND_MADE);
    await vi.waitFor(() => expect(ids(show)).toEqual([['spider', 'warm'], ['both']]), {
      timeout: 2000,
    });

    writeFileSync(path, `${HAND_MADE}  cold: nothing\n`);
    await vi.waitFor(() => expect(show.getProblem()).toMatch(/Group "cold"/), { timeout: 2000 });
    expect(ids(show)).toEqual([['spider', 'warm'], ['both']]);

    writeFileSync(path, `${HAND_MADE}  cold:\n    fixtures: [laser]\n`);
    await vi.waitFor(() => expect(ids(show)).toEqual([['spider', 'warm'], ['both'], ['cold']]), {
      timeout: 2000,
    });
    expect(show.getProblem()).toBeNull();
    expect(told).toHaveBeenCalledTimes(3);
  });

  it('keeps the show in memory without a path', () => {
    file = new ShowFile({ fixtures: FIXTURES, check });
    expect(ids(file)).toEqual([['spider'], ['laser'], ['all']]);
    file.edit(addScene('all', 'one'));
    expect(ids(file)).toEqual([['spider'], ['laser'], ['all', 'one']]);
    expect(file.path).toBeUndefined();
  });
});
