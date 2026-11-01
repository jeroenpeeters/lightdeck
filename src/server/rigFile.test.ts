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

const DECOR = `
fixtures:
  - id: decor
    kind: decor
    label: Decor
    switches:
      - { id: uv1, label: UV 1, entity: switch.uv_lamp_1, blackout: true }
      - { id: uv2, entity: switch.uv_lamp_2 }
`;

describe('parseRig', () => {
  it('reads the switches of the decor', () => {
    expect(parseRig(DECOR)).toEqual([
      {
        id: 'decor',
        kind: 'decor',
        label: 'Decor',
        switches: [
          { id: 'uv1', label: 'UV 1', entity: 'switch.uv_lamp_1', blackout: true },
          { id: 'uv2', label: 'uv2', entity: 'switch.uv_lamp_2' },
        ],
      },
    ]);
  });

  it('reads the strips of WLED of the decor, with their speed entity, colour and blackout', () => {
    const [decor] = parseRig(`
fixtures:
  - id: decor
    kind: decor
    strips:
      - { id: buis1, label: Buis 1, entity: light.wled_buis1 }
      - { id: buis2, entity: light.wled_buis2, speed: number.buis2_speed, colour: '#33ddaa', blackout: true }
`);
    expect(decor).toEqual({
      id: 'decor',
      kind: 'decor',
      label: 'decor',
      strips: [
        { id: 'buis1', label: 'Buis 1', entity: 'light.wled_buis1' },
        {
          id: 'buis2',
          label: 'buis2',
          entity: 'light.wled_buis2',
          speed: 'number.buis2_speed',
          colour: '#33ddaa',
          blackout: true,
        },
      ],
    });
  });

  it('reads the looks of the pipes and the entities of a strip that are not the usual ones', () => {
    const [decor] = parseRig(`
fixtures:
  - id: decor
    kind: decor
    strips:
      - { id: a, entity: light.a, intensity: number.a_i, palette: select.a_p }
    looks:
      - { id: flow, label: Flow, effect: Flow, palette: Ocean, colour: '#00e5ff', intensity: 90, pace: 2 }
      - { id: plain, effect: null }
`);
    expect(decor?.strips?.[0]).toMatchObject({ intensity: 'number.a_i', palette: 'select.a_p' });
    expect(decor?.looks).toEqual([
      {
        id: 'flow',
        label: 'Flow',
        effect: 'Flow',
        palette: 'Ocean',
        colour: '#00e5ff',
        intensity: 90,
        pace: 2,
      },
      { id: 'plain', label: 'plain', effect: null },
    ]);
  });

  it('reads the address and the LEDs of a strip that lightdeck draws', () => {
    const [decor] = parseRig(
      'fixtures:\n  - { id: d, kind: decor, strips: [{ id: a, entity: light.a, host: 192.168.68.32, leds: 300 }] }',
    );
    expect(decor?.strips?.[0]).toMatchObject({ host: '192.168.68.32', leds: 300 });
    expect(() =>
      parseRig(
        'fixtures:\n  - { id: d, kind: decor, strips: [{ id: a, entity: light.a, leds: many }] }',
      ),
    ).toThrow(/number of LEDs/);
  });

  it('reads who draws a strip and the entity of its address', () => {
    const [decor] = parseRig(
      'fixtures:\n  - { id: d, kind: decor, strips: [{ id: a, entity: light.a, draw: wled }, { id: b, entity: light.b, ip: sensor.b_address }] }',
    );
    expect(decor?.strips?.[0]).toMatchObject({ draw: 'wled' });
    expect(decor?.strips?.[1]).toMatchObject({ ip: 'sensor.b_address' });
    expect(() =>
      parseRig(
        'fixtures:\n  - { id: d, kind: decor, strips: [{ id: a, entity: light.a, draw: neon }] }',
      ),
    ).toThrow(/lightdeck or wled/);
  });

  it('answers a look without an effect, or with a key it does not know', () => {
    const one = (look: string) =>
      parseRig(
        `fixtures:\n  - { id: d, kind: decor, strips: [{ id: a, entity: light.a }], looks: [${look}] }`,
      );
    expect(() => one('{ id: x }')).toThrow(/needs an effect/);
    expect(() => one('{ id: x, effect: Flow, nope: 1 }')).toThrow(/cannot have "nope"/);
    expect(() => one('{ id: x, effect: Flow, pace: fast }')).toThrow(/pace.*number/);
  });

  it('needs switches or strips in the decor, and keeps strips out of the room', () => {
    expect(() => parseRig('fixtures:\n  - { id: d, kind: decor, strips: [] }')).toThrow(
      /switches or strips, at least one/,
    );
    expect(() => parseRig('fixtures:\n  - { id: d, kind: decor, strips: 3 }')).toThrow(
      /must be a list/,
    );
    expect(() =>
      parseRig(
        'fixtures:\n  - { id: d, kind: decor, strips: [{ id: a, entity: light.a, nope: 1 }] }',
      ),
    ).toThrow(/cannot have "nope"/);
    expect(() =>
      parseRig(
        'fixtures:\n  - { id: r, kind: room, lamps: [{ id: a, entity: light.a }], strips: [] }',
      ),
    ).toThrow(/its switches are lamps/);
  });

  it('keeps the lamps and the switches apart', () => {
    expect(() =>
      parseRig('fixtures:\n  - { id: d, kind: decor, lamps: [{ id: a, entity: light.a }] }'),
    ).toThrow(/switches and strips, not lamps or zones/);
    expect(() => parseRig('fixtures:\n  - { id: d, kind: decor }')).toThrow(
      /needs a list of switches or strips/,
    );
    expect(() =>
      parseRig(
        'fixtures:\n  - { id: r, kind: room, lamps: [{ id: a, entity: light.a }], switches: [] }',
      ),
    ).toThrow(/its switches are lamps/);
    expect(() =>
      parseRig(
        'fixtures:\n  - { id: d, kind: decor, switches: [{ id: a, entity: x, blackout: 1 }] }',
      ),
    ).toThrow(/blackout of switch 1 of "d" must be true or false/);
  });

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
    expect(() => parseRig('fixtures:\n  - { id: x, kind: spider }')).toThrow(
      /kinds room and decor only/,
    );
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
