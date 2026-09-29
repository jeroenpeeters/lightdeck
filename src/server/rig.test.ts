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

  it('starts with the master at full', () => {
    expect(rig.getMaster()).toBe(1);
    change('spider', { levels: { dimmer: 1 } });
    change('laser', { raw: { mode: MANUAL } });
    expect(ch(output, 6)).toBe(255);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
  });

  it('dims every fixture with one master, and closes the laser at 0', () => {
    change('spider', { levels: { dimmer: 1, red1: 1 } });
    change('laser', { raw: { mode: MANUAL, drawing: 191 } });
    const seen: unknown[][] = [];
    rig.on('master', (...args) => seen.push(args));
    const fixtures: unknown[][] = [];
    rig.on('fixture', (id, _state, dmx) => fixtures.push([id, dmx[id === 'spider' ? 5 : 0]]));

    rig.setMaster(0.5, 'tablet');
    expect(rig.getMaster()).toBe(0.5);
    expect(ch(output, 6)).toBe(128);
    expect(ch(output, 7)).toBe(255);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
    expect(seen).toEqual([[0.5, 'tablet']]);
    // Each fixture tells what it sends now.
    expect(fixtures).toEqual([
      ['spider', 128],
      ['laser', MANUAL],
    ]);

    rig.setMaster(0);
    expect(ch(output, 6)).toBe(0);
    expect(ch(output, 7)).toBe(255);
    expect(ch(output, LASER_AT)).toBe(0);
    expect(ch(output, LASER_AT + 9)).toBe(191);
    expect(seen[1]).toEqual([0, undefined]);

    rig.setMaster(1);
    expect(ch(output, 6)).toBe(255);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
  });

  it('leaves what the fixtures are set to when the master moves', () => {
    change('spider', { levels: { dimmer: 0.8 }, effect: { id: 'wave' } });
    change('laser', { raw: { mode: MANUAL }, effect: { id: 'pulse' } });
    const controllers = rig.fixtures.map((fixture) => fixture.controller);
    const states = controllers.map((controller) => controller.getState());
    const kept = controllers.map((controller) => controller.snapshot());
    for (const master of [0.5, 0, 0.01, 1]) {
      rig.setMaster(master);
      expect(controllers.map((controller) => controller.getState())).toEqual(states);
      expect(controllers.map((controller) => controller.snapshot())).toEqual(kept);
    }
  });

  it('refuses a master that is not a number from 0 to 1, and changes nothing', () => {
    change('spider', { levels: { dimmer: 1 } });
    change('laser', { raw: { mode: MANUAL } });
    rig.setMaster(0.5);
    const seen: unknown[] = [];
    rig.on('master', (level) => seen.push(level));
    rig.on('fixture', (id) => seen.push(id));
    const frames = output.frames.length;

    const bad = [-0.1, 1.1, 50, Number.NaN, Number.POSITIVE_INFINITY, '0.5', true, null, {}];
    for (const level of [...bad, undefined]) {
      expect(() => rig.setMaster(level)).toThrow(PatchError);
      expect(() => rig.setMaster(level)).toThrow('the master must be a number between 0 and 1');
    }
    expect(rig.getMaster()).toBe(0.5);
    expect(output.frames).toHaveLength(frames);
    expect(seen).toEqual([]);
    expect(ch(output, 6)).toBe(128);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
  });

  it('has the blackout next to the master: neither moves the other', () => {
    change('spider', { levels: { dimmer: 1 } });
    change('laser', { raw: { mode: MANUAL } });
    const sent = () => [ch(output, 6), ch(output, LASER_AT)];
    const masters: unknown[] = [];
    rig.on('master', (level) => masters.push(level));
    const blackouts: unknown[] = [];
    rig.on('blackout', (blackout) => blackouts.push(blackout));

    rig.setMaster(0.5);
    rig.setBlackout(true);
    expect(sent()).toEqual([0, 0]);
    expect(rig.getMaster()).toBe(0.5);
    rig.setBlackout(false);
    expect(sent()).toEqual([128, MANUAL]);

    rig.setBlackout(true);
    rig.setMaster(1);
    expect(sent()).toEqual([0, 0]);
    expect(rig.getBlackout()).toBe(true);
    rig.setMaster(0);
    rig.setBlackout(false);
    expect(sent()).toEqual([0, 0]);
    expect(rig.getMaster()).toBe(0);
    rig.setMaster(1);
    expect(sent()).toEqual([255, MANUAL]);

    expect(masters).toEqual([0.5, 1, 0, 1]);
    expect(blackouts).toEqual([true, false, true, false]);
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

  it('passes on the frames of an effect with the master in them', () => {
    vi.useFakeTimers();
    let clock = 0;
    const timed = new Rig({ output, fixtures: [SPIDER, LASER], now: () => clock });
    const frames: unknown[][] = [];
    timed.on('frame', (id, dmx) => frames.push([id, dmx[id === 'spider' ? 5 : 0]]));
    try {
      timed.find('spider')?.controller.update({ levels: { dimmer: 1 }, effect: { id: 'chase' } });
      timed.find('laser')?.controller.update({ raw: { mode: MANUAL }, effect: { id: 'sweep' } });
      timed.setMaster(0.5);
      for (let i = 0; i < 4; i++) {
        clock += 25;
        vi.advanceTimersByTime(25);
      }
      expect(frames).toEqual([
        ['spider', 128],
        ['laser', MANUAL],
        ['spider', 128],
        ['laser', MANUAL],
      ]);
      timed.setMaster(0);
      for (let i = 0; i < 4; i++) {
        clock += 25;
        vi.advanceTimersByTime(25);
      }
      expect(frames.slice(4)).toEqual([
        ['spider', 0],
        ['laser', 0],
        ['spider', 0],
        ['laser', 0],
      ]);
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

  it('keeps the laser closed after lightdeck stopped, whatever comes by which way', () => {
    change('laser', { raw: { mode: MANUAL } });
    const scene = rig.playback.store('laser', 'Open');
    rig.setMaster(0);
    // The order in which lightdeck stops. The server still handles what was under way.
    rig.darken();
    rig.close();

    rig.setMaster(1);
    rig.setBlackout(true);
    rig.setBlackout(false);
    expect(ch(output, LASER_AT)).toBe(0);
    change('laser', { raw: { mode: MANUAL } }, 'tablet');
    expect(ch(output, LASER_AT)).toBe(0);
    rig.playback.recall('laser', scene, 'deck');
    expect(ch(output, LASER_AT)).toBe(0);
    for (const { data } of output.frames.slice(-5)) expect(data[LASER_AT - 1]).toBe(0);
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
