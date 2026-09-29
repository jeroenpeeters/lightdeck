import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PatchConflict } from '../outputs/patch.js';
import { PatchError } from './fixture.js';
import { type FixtureDefinition, Rig } from './rig.js';
import { ch, RecordingOutput } from './testing.js';

const MANUAL = 95;
const LASER_AT = 44;

const SPIDER: FixtureDefinition = {
  id: 'spider',
  kind: 'spider',
  label: 'Spider',
  universe: 0,
  address: 1,
};
const LASER: FixtureDefinition = {
  id: 'laser',
  kind: 'laser',
  label: 'Laser',
  universe: 0,
  address: LASER_AT,
};

describe('Rig', () => {
  let output: RecordingOutput;
  let rig: Rig;

  const change = (id: string, patch: unknown, origin?: string) =>
    rig.find(id)?.controller.update(patch, origin);

  beforeEach(() => {
    output = new RecordingOutput();
    rig = new Rig({ output, fixtures: [SPIDER, LASER] });
  });
  afterEach(() => rig.close());

  it('has the fixtures in the order they were given, each with its controller', () => {
    expect(rig.fixtures.map((f) => [f.id, f.kind, f.controller.profile.footprint])).toEqual([
      ['spider', 'spider', 43],
      ['laser', 'laser', 10],
    ]);
    expect(rig.find('laser')?.address).toBe(LASER_AT);
    expect(rig.find('strobe')).toBeUndefined();
  });

  it('sends whole universes with every fixture in its place', () => {
    change('spider', { levels: { dimmer: 1, white8: 1 } });
    change('laser', { raw: { mode: MANUAL, drawing: 191 } });
    change('spider', { levels: { red1: 0.5 } });
    expect(output.last).toHaveLength(512);
    expect(ch(output, 6)).toBe(255);
    expect(ch(output, 7)).toBe(128);
    expect(ch(output, 38)).toBe(255);
    expect(ch(output, 43)).toBe(0);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
    expect(ch(output, LASER_AT + 9)).toBe(191);
    expect(ch(output, LASER_AT + 10)).toBe(0);
  });

  it('takes more than one fixture of a kind', () => {
    const many = new Rig({
      output,
      fixtures: [SPIDER, { ...SPIDER, id: 'spider-2', label: 'Spider 2', address: 101 }, LASER],
    });
    many.find('spider')?.controller.update({ levels: { dimmer: 1 } });
    many.find('spider-2')?.controller.update({ levels: { dimmer: 0.5 } });
    expect(ch(output, 6)).toBe(255);
    expect(ch(output, 106)).toBe(128);
    many.close();
  });

  it('passes on what the fixtures tell, with their name', () => {
    const seen: unknown[][] = [];
    rig.on('fixture', (...args) => seen.push(args));
    change('laser', { raw: { mode: MANUAL } }, 'tablet');
    expect(seen).toEqual([
      [
        'laser',
        rig.find('laser')?.controller.getState(),
        [MANUAL, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        'tablet',
      ],
    ]);
  });

  it('darkens every fixture with one blackout, and lights them again', () => {
    change('spider', { levels: { dimmer: 1 } });
    change('laser', { raw: { mode: MANUAL } });
    const seen: unknown[][] = [];
    rig.on('blackout', (...args) => seen.push(args));
    const fixtures: string[] = [];
    rig.on('fixture', (id) => fixtures.push(id));

    rig.setBlackout(true, 'tablet');
    expect(rig.getBlackout()).toBe(true);
    expect(ch(output, 6)).toBe(0);
    expect(ch(output, LASER_AT)).toBe(0);
    expect(seen).toEqual([[true, 'tablet']]);
    // Each fixture tells what it sends now.
    expect(fixtures).toEqual(['spider', 'laser']);

    rig.setBlackout(false);
    expect(ch(output, 6)).toBe(255);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
  });

  it('refuses a blackout that is not true or false', () => {
    for (const bad of ['yes', 1, null, undefined]) {
      expect(() => rig.setBlackout(bad)).toThrow(PatchError);
    }
    expect(rig.getBlackout()).toBe(false);
  });

  it('gives every fixture the one tempo', () => {
    vi.useFakeTimers();
    let clock = 0;
    const timed = new Rig({ output, fixtures: [SPIDER], now: () => clock });
    const seen: unknown[][] = [];
    timed.on('tempo', (...args) => seen.push(args));
    const frames: unknown[] = [];
    timed.on('frame', (id, _dmx, beat) => frames.push([id, beat]));
    try {
      timed.tempo.update({ bpm: 120, sync: true }, 'tablet');
      expect(seen).toEqual([[{ bpm: 120, rate: 1 }, 0, 'tablet']]);
      timed.find('spider')?.controller.update({ effect: { id: 'chase' } });
      for (let i = 0; i < 20; i++) {
        clock += 25;
        vi.advanceTimersByTime(25);
      }
      expect(frames.length).toBeGreaterThan(5);
      expect(frames[frames.length - 1]).toEqual(['spider', 1]);
    } finally {
      timed.close();
      vi.useRealTimers();
    }
  });

  it('closes the laser and leaves the spider when lightdeck stops', () => {
    change('spider', { levels: { dimmer: 1 } });
    change('laser', { raw: { mode: MANUAL } });
    rig.darken();
    expect(ch(output, 6)).toBe(255);
    expect(ch(output, LASER_AT)).toBe(0);
  });

  it('tracks the link and forgets the device when the bridge goes away', () => {
    const seen: unknown[] = [];
    rig.on('status', (s) => seen.push(s));
    rig.setBridgeConnected(true);
    rig.setDeviceStatus({ device: 'open', universes: 2, channels: [512, 0] });
    expect(rig.getStatus()).toEqual({
      bridge: true,
      device: 'open',
      universes: 2,
      channels: [512, 0],
    });
    rig.setBridgeConnected(false);
    expect(rig.getStatus()).toEqual({
      bridge: false,
      device: 'unknown',
      universes: 0,
      channels: [],
    });
    expect(seen).toHaveLength(3);
  });

  it('refuses fixtures that do not fit together, and says why', () => {
    const make = (fixtures: FixtureDefinition[]) => () => new Rig({ output, fixtures });
    expect(make([SPIDER, { ...LASER, address: 40 }])).toThrow(PatchConflict);
    expect(make([SPIDER, { ...LASER, address: 40 }])).toThrow(/Spider has 1\.\.43/);
    expect(make([SPIDER, { ...LASER, address: 504 }])).toThrow(RangeError);
    expect(make([SPIDER, { ...LASER, id: 'spider' }])).toThrow(/two fixtures/);
    expect(make([{ ...SPIDER, id: 'Spider 1' }])).toThrow(/cannot name a fixture/);
    expect(make([{ ...SPIDER, kind: 'smoke' }])).toThrow(/does not know/);
    expect(make([SPIDER, { ...LASER, universe: 1, address: 1 }])).not.toThrow();
  });
});
