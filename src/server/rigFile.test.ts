import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRig, readRigFile } from './rigFile.js';

const ROOM = `
fixtures:
  - id: room
    kind: room
    label: Room Lights
    lamps:
      - { id: bar, label: Bar, entity: light.bar }
      - { id: shelf, entity: light.shelf }
      - { id: fog, label: Fog machine, entity: switch.fog, blackout: true }
    zones:
      - { id: low, label: Low, lamps: [bar, shelf] }
`;

describe('parseRig', () => {
  it('reads the lamps and the zones of a room', () => {
    expect(parseRig(ROOM)).toEqual([
      {
        id: 'room',
        kind: 'room',
        label: 'Room Lights',
        lamps: [
          { id: 'bar', label: 'Bar', entity: 'light.bar' },
          { id: 'shelf', label: 'shelf', entity: 'light.shelf' },
          { id: 'fog', label: 'Fog machine', entity: 'switch.fog', blackout: true },
        ],
        zones: [{ id: 'low', label: 'Low', lamps: ['bar', 'shelf'] }],
      },
    ]);
  });

  it('takes the id for the label and leaves the zones out when there are none', () => {
    const [room] = parseRig(
      'fixtures:\n  - { id: room, kind: room, lamps: [{ id: a, entity: light.a }] }',
    );
    expect(room).toEqual({
      id: 'room',
      kind: 'room',
      label: 'room',
      lamps: [{ id: 'a', label: 'a', entity: 'light.a' }],
    });
  });

  it('is an empty rig when there is nothing in it', () => {
    expect(parseRig('')).toEqual([]);
    expect(parseRig('fixtures:')).toEqual([]);
    expect(parseRig('fixtures: []')).toEqual([]);
  });

  it('answers a mistake with where it is', () => {
    const room = (extra: string) =>
      `fixtures:\n  - { id: room, kind: room, lamps: [{ id: a, entity: light.a${extra} }] }`;
    expect(() => parseRig('fixtures: 3', 'rig.yaml')).toThrow(
      /"fixtures" in rig.yaml must be a list/,
    );
    expect(() => parseRig('lamps: []', 'rig.yaml')).toThrow(/cannot have "lamps"/);
    expect(() => parseRig('fixtures:\n  - { id: x, kind: spider }')).toThrow(/kind room only/);
    expect(() => parseRig('fixtures:\n  - { id: room, kind: room }')).toThrow(/list of lamps/);
    expect(() => parseRig(room(', colour: red'))).toThrow(/cannot have "colour"/);
    expect(() => parseRig(room(', blackout: yes please'))).toThrow(/true or false/);
    expect(() => parseRig('fixtures:\n  - { id: room, kind: room, lamps: [{ id: a }] }')).toThrow(
      /entity of lamp 1 of "room" must be some text/,
    );
    expect(() =>
      parseRig(
        'fixtures:\n  - { id: room, kind: room, lamps: [{ id: a, entity: light.a }], zones: [{ id: z, lamps: [] }] }',
      ),
    ).toThrow(/zone 1 of "room" needs a list of lamps/);
    expect(() => parseRig('fixtures: [unclosed')).toThrow(/not valid YAML/);
  });
});

describe('readRigFile', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
  });
  const dir = () => {
    const directory = mkdtempSync(join(tmpdir(), 'rig-'));
    directories.push(directory);
    return directory;
  };

  it('is an empty rig when the file is not there', () => {
    expect(readRigFile(join(dir(), 'rig.yaml'))).toEqual([]);
  });

  it('reads the file', () => {
    const path = join(dir(), 'rig.yaml');
    writeFileSync(path, ROOM);
    expect(readRigFile(path)).toHaveLength(1);
  });

  it('names the file in a mistake', () => {
    const path = join(dir(), 'rig.yaml');
    writeFileSync(path, 'fixtures: 3');
    expect(() => readRigFile(path)).toThrow(path);
  });
});
