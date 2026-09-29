import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PatchError } from '../server/fixture.js';
import { ShowFile, setIn } from './file.js';

const check = (fixture: string) => {
  if (fixture !== 'spider' && fixture !== 'laser') {
    throw new PatchError(`there is no fixture called "${fixture}"`);
  }
};

const HAND_MADE = `# The show of the evening.
scenes:
  warm:
    label: Warm # the opener
    fixtures:
      spider:
        levels:
          dimmer: 1
`;

describe('ShowFile', () => {
  let dir: string;
  let path: string;
  let file: ShowFile | undefined;

  const open = () => {
    file = new ShowFile({ path, check });
    return file;
  };
  const ids = (from: ShowFile) => from.getShow().scenes.map((scene) => scene.id);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lightdeck-show-'));
    path = join(dir, 'show.yaml');
  });
  afterEach(() => {
    file?.close();
    file = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts without scenes when there is no file, and does not make one', () => {
    const show = open();
    expect(show.getShow()).toEqual({ scenes: [] });
    expect(show.getProblem()).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it('reads the file that is there', () => {
    writeFileSync(path, HAND_MADE);
    expect(open().getShow().scenes).toEqual([
      { id: 'warm', label: 'Warm', fixtures: { spider: { levels: { dimmer: 1 } } } },
    ]);
  });

  it('writes a change to the file, which reads back as the same show', () => {
    const show = open();
    const colour = { red: 1, green: 0.58, blue: 0, white: 0 };
    show.edit((document) =>
      setIn(document, ['scenes', 'amber'], {
        label: 'Amber',
        fixtures: { spider: { effect: { id: 'chase', colourA: colour, colourB: colour } } },
      }),
    );
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('colourA: { red: 1, green: 0.58, blue: 0, white: 0 }');
    expect(existsSync(`${path}.tmp`)).toBe(false);
    show.close();
    expect(open().getShow()).toEqual(show.getShow());
  });

  it('keeps the comments and the order of a file made by hand', () => {
    writeFileSync(path, HAND_MADE);
    const show = open();
    show.edit((document) => setIn(document, ['scenes', 'cold'], { label: 'Cold', fixtures: {} }));
    show.edit((document) => setIn(document, ['scenes', 'warm', 'fixtures'], { laser: {} }));
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('# The show of the evening.');
    expect(text).toContain('# the opener');
    expect(ids(show)).toEqual(['warm', 'cold']);
    expect(show.getShow().scenes[0]?.fixtures).toEqual({ laser: {} });
  });

  it('starts a file that has "scenes:" and nothing under it', () => {
    writeFileSync(path, 'scenes:\n');
    const show = open();
    show.edit((document) => setIn(document, ['scenes', 'one'], { label: 'One', fixtures: {} }));
    expect(ids(show)).toEqual(['one']);
  });

  it('tells about every change', () => {
    const show = open();
    const told = vi.fn();
    show.on('show', told);
    show.edit((document) => setIn(document, ['scenes', 'one'], { label: 'One', fixtures: {} }));
    expect(told).toHaveBeenCalledTimes(1);
  });

  it('does not use a file with a mistake, and does not write over it', () => {
    const broken = 'scenes:\n  warm:\n    fixtures:\n      strobe: {}\n';
    writeFileSync(path, broken);
    const show = open();
    expect(show.getShow()).toEqual({ scenes: [] });
    expect(show.getProblem()).toBe('Scene "warm": there is no fixture called "strobe"');
    expect(() =>
      show.edit((document) => setIn(document, ['scenes', 'one'], { label: 'One' })),
    ).toThrow(PatchError);
    expect(readFileSync(path, 'utf8')).toBe(broken);
  });

  it('says where YAML that cannot be read goes wrong', () => {
    writeFileSync(path, 'scenes:\n  warm: [unfinished\n');
    expect(open().getProblem()).toMatch(/line 2|line 3/);
  });

  it('refuses a change that would not leave a show, and changes nothing', () => {
    writeFileSync(path, HAND_MADE);
    const show = open();
    expect(() =>
      show.edit((document) => setIn(document, ['scenes', 'one'], { fixtures: { strobe: {} } })),
    ).toThrow(/no fixture called "strobe"/);
    expect(ids(show)).toEqual(['warm']);
    expect(readFileSync(path, 'utf8')).toBe(HAND_MADE);
  });

  it('reads a file that changed by hand before it writes to it', () => {
    const show = open();
    writeFileSync(path, HAND_MADE);
    show.edit((document) => setIn(document, ['scenes', 'cold'], { label: 'Cold', fixtures: {} }));
    expect(ids(show)).toEqual(['warm', 'cold']);
    expect(readFileSync(path, 'utf8')).toContain('# the opener');
  });

  it('follows the file: a good one is the show, a bad one leaves the show as it was', async () => {
    const show = open();
    const told = vi.fn();
    show.on('show', told);
    show.watch();

    writeFileSync(path, HAND_MADE);
    await vi.waitFor(() => expect(ids(show)).toEqual(['warm']), { timeout: 2000 });

    writeFileSync(path, `${HAND_MADE}  cold: nothing\n`);
    await vi.waitFor(() => expect(show.getProblem()).toMatch(/Scene "cold"/), { timeout: 2000 });
    expect(ids(show)).toEqual(['warm']);

    writeFileSync(path, `${HAND_MADE}  cold:\n    label: Cold\n`);
    await vi.waitFor(() => expect(ids(show)).toEqual(['warm', 'cold']), { timeout: 2000 });
    expect(show.getProblem()).toBeNull();
    expect(told).toHaveBeenCalledTimes(3);
  });

  it('keeps the show in memory without a path', () => {
    file = new ShowFile({ check });
    file.edit((document) => setIn(document, ['scenes', 'one'], { label: 'One', fixtures: {} }));
    expect(ids(file)).toEqual(['one']);
    expect(file.path).toBeUndefined();
  });
});
