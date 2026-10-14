import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { PatchError } from './fixture.js';
import type { PlaybackState } from './playback.js';
import { type FixtureDefinition, Rig } from './rig.js';
import { ch, RecordingOutput } from './testing.js';

const MANUAL = 95;
const LASER_AT = 44;
const FIXTURES: FixtureDefinition[] = [
  { id: 'spider', kind: 'spider', label: 'Spider', universe: 0, address: 1 },
  { id: 'laser', kind: 'laser', label: 'Laser', universe: 0, address: LASER_AT },
];
const NONE = { scene: null, changed: false };
/** What is on in a group when nothing is, by type. */
const NOTHING = { lights: NONE, colour: NONE, motion: NONE };
/** What is on in a group when only a scene of lights is. Most of what follows is about lights. */
const lights = (scene: string, changed = false) => ({
  ...NOTHING,
  lights: { scene, changed },
});
const GREEN = { red: 0, green: 1, blue: 0, white: 0 };
const RED = { red: 1, green: 0, blue: 0, white: 0 };

const STEP_ONE = `# The show of the evening.
scenes:
  warm:
    label: Warm # the opener
    type: lights
    fixtures:
      spider:
        levels: { dimmer: 1 }
      laser:
        raw: { mode: 95 }
`;

describe('Playback', () => {
  let dir: string;
  let path: string;
  let output: RecordingOutput;
  let rig: Rig;

  const start = (fixtures: FixtureDefinition[] = FIXTURES) => {
    output = new RecordingOutput();
    rig = new Rig({ output, fixtures, show: path });
    return rig;
  };
  const change = (id: string, patch: unknown) => rig.find(id)?.controller.update(patch);
  const state = (id: string) => rig.find(id)?.controller.getState();
  const on = () =>
    rig.playback.getState().groups as Record<
      'spider' | 'laser' | 'all' | 'both' | 'front',
      NonNullable<PlaybackState['groups'][string]>
    >;
  const group = (id: string) => rig.playback.getShow().groups.find((each) => each.id === id);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lightdeck-playback-'));
    path = join(dir, 'show.yaml');
    start();
  });
  afterEach(() => {
    rig.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts with a group for every fixture and one for all, and no scene on', () => {
    expect(rig.playback.getShow()).toEqual({
      file: path,
      problem: null,
      groups: [
        { id: 'spider', label: 'Spider', fixtures: ['spider'], scenes: [] },
        { id: 'laser', label: 'Laser', fixtures: ['laser'], scenes: [] },
        { id: 'all', label: 'All', fixtures: ['spider', 'laser'], scenes: [] },
      ],
    });
    expect(rig.playback.getState()).toEqual({
      groups: { spider: NOTHING, laser: NOTHING, all: NOTHING },
    });
    expect(existsSync(path)).toBe(false);
  });

  it('has the group of the fixture only when there is one fixture', () => {
    rig.close();
    start(FIXTURES.slice(0, 1));
    expect(rig.playback.getShow().groups.map((each) => each.id)).toEqual(['spider']);
    expect(rig.playback.getState()).toEqual({ groups: { spider: NOTHING } });
  });

  it('stores one type at a time, and brings a look back from a scene of each', () => {
    change('spider', {
      levels: { dimmer: 1, red1: 0.5, tilt1: 0.3, motorSpeed: 0.6 },
      effect: { id: 'chase', colourA: GREEN, colourB: RED },
    });
    change('laser', {
      raw: { mode: MANUAL, drawing: 191, colour: 100, rotation: 30 },
      effect: { id: 'pulse' },
    });
    const before = [state('spider'), state('laser')];
    expect(rig.playback.store('all', 'lights', 'Chase on')).toBe('chase-on');
    expect(rig.playback.store('all', 'colour', 'Green on red')).toBe('green-on-red');
    expect(rig.playback.store('all', 'motion', 'Leaning')).toBe('leaning');

    change('spider', {
      levels: { dimmer: 0.2, red1: 0, tilt1: 0, motorSpeed: 0, green3: 1 },
      effect: { id: null, colourA: RED, colourB: null },
    });
    change('laser', {
      raw: { mode: 0, drawing: 0, colour: 0, rotation: 0 },
      effect: { id: null },
    });
    for (const scene of ['chase-on', 'green-on-red', 'leaning']) {
      rig.playback.recall('all', scene);
    }

    // The only difference is green3, which no scene of the three has a say in until it is
    // stored: a colour scene sets every colour level, so it is gone as well.
    expect([state('spider'), state('laser')]).toEqual(before);
    expect(ch(output, 6)).toBe(255);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
    expect(on().all).toEqual({
      lights: { scene: 'chase-on', changed: false },
      colour: { scene: 'green-on-red', changed: false },
      motion: { scene: 'leaning', changed: false },
    });
  });

  it('keeps the type in the file, and only the properties of it', () => {
    change('spider', {
      levels: { dimmer: 1, red1: 0.5, tilt1: 0.3 },
      effect: { id: 'chase', colourA: GREEN },
    });
    rig.playback.store('spider', 'lights', 'Chase');
    rig.playback.store('spider', 'colour', 'Green');
    rig.playback.store('spider', 'motion', 'Lean');
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('type: lights');
    expect(text).toContain('type: colour');
    expect(text).toContain('type: motion');
    const { scenes } = parse(text).groups.spider;
    expect(scenes.chase).toEqual({
      label: 'Chase',
      type: 'lights',
      fixtures: { spider: { levels: { dimmer: 1 }, effect: { id: 'chase', speed: 1 } } },
    });
    expect(scenes.green).toEqual({
      label: 'Green',
      type: 'colour',
      fixtures: { spider: { levels: { red1: 0.5 }, effect: { colourA: GREEN } } },
    });
    expect(scenes.lean).toEqual({
      label: 'Lean',
      type: 'motion',
      fixtures: { spider: { levels: { tilt1: 0.3 } } },
    });
    // The second colour is only in a scene when it was set.
    expect(text).not.toContain('colourB');
  });

  it('stores the fixtures of the group only', () => {
    change('spider', { levels: { dimmer: 1 } });
    change('laser', { raw: { mode: MANUAL } });
    rig.playback.store('spider', 'lights', 'Warm');
    rig.playback.store('laser', 'lights', 'Open');
    expect(group('spider')?.scenes).toEqual([
      { id: 'warm', label: 'Warm', type: 'lights', fixtures: ['spider'] },
    ]);
    expect(group('laser')?.scenes).toEqual([
      { id: 'open', label: 'Open', type: 'lights', fixtures: ['laser'] },
    ]);
    expect(group('all')?.scenes).toEqual([]);
    expect(on()).toEqual({
      spider: lights('warm'),
      laser: lights('open'),
      all: NOTHING,
    });
  });

  it('has the groups and their scenes after a restart', () => {
    change('spider', { levels: { dimmer: 1 } });
    rig.playback.store('spider', 'lights', 'Warm');
    rig.playback.addGroup('Front', ['laser', 'spider']);
    rig.close();
    start();
    expect(rig.playback.getShow().groups).toEqual([
      {
        id: 'spider',
        label: 'Spider',
        fixtures: ['spider'],
        scenes: [{ id: 'warm', label: 'Warm', type: 'lights', fixtures: ['spider'] }],
      },
      { id: 'laser', label: 'Laser', fixtures: ['laser'], scenes: [] },
      { id: 'all', label: 'All', fixtures: ['spider', 'laser'], scenes: [] },
      { id: 'front', label: 'Front', fixtures: ['laser', 'spider'], scenes: [] },
    ]);
    expect(on().spider).toEqual(NOTHING);
    rig.playback.recall('spider', 'warm');
    expect(ch(output, 6)).toBe(255);
  });

  it('has two groups on at once, and leaves fixtures outside the group alone', () => {
    change('spider', { levels: { dimmer: 1 } });
    rig.playback.store('spider', 'lights', 'Warm');
    change('spider', { levels: { dimmer: 0.5 } });
    rig.playback.store('spider', 'lights', 'Half');
    change('laser', { raw: { mode: MANUAL, drawing: 191 }, effect: { id: 'pulse' } });
    rig.playback.store('laser', 'lights', 'Tunnel');
    const laser = state('laser');

    rig.playback.recall('spider', 'warm');
    expect(ch(output, 6)).toBe(255);
    expect(state('laser')).toEqual(laser);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
    expect(on()).toEqual({
      spider: lights('warm'),
      laser: lights('tunnel'),
      all: NOTHING,
    });

    const spider = state('spider');
    rig.playback.off('laser');
    rig.playback.recall('laser', 'tunnel');
    expect(state('spider')).toEqual(spider);
    expect(state('laser')).toEqual(laser);
    expect(on().spider).toEqual(lights('warm'));
  });

  describe('with scenes of different types', () => {
    beforeEach(() => {
      change('spider', {
        levels: { dimmer: 1, red1: 1, tilt1: 0.2 },
        effect: { id: 'chase', colourA: GREEN },
      });
      rig.playback.store('spider', 'lights', 'Chase');
      rig.playback.store('spider', 'colour', 'Green');
      rig.playback.store('spider', 'motion', 'Low');
      change('spider', {
        levels: { dimmer: 0.5, red1: 0, tilt1: 0.9 },
        effect: { id: 'kick', colourA: RED },
      });
      rig.playback.store('spider', 'lights', 'Kick');
      rig.playback.store('spider', 'colour', 'Red');
      rig.playback.store('spider', 'motion', 'High');
    });

    it('is on for one scene of each type in a group, and each press sets only its type', () => {
      rig.playback.recall('spider', 'chase');
      rig.playback.recall('spider', 'green');
      rig.playback.recall('spider', 'low');
      expect(state('spider')).toMatchObject({
        levels: { dimmer: 1, red1: 1, tilt1: 0.2 },
        effect: { id: 'chase', colourA: GREEN },
      });
      expect(on().spider).toEqual({
        lights: { scene: 'chase', changed: false },
        colour: { scene: 'green', changed: false },
        motion: { scene: 'low', changed: false },
      });

      // A scene of another type takes the colour and leaves the chase going.
      rig.playback.recall('spider', 'red');
      expect(state('spider')).toMatchObject({ effect: { id: 'chase', colourA: RED } });
      expect(on().spider.lights).toEqual({ scene: 'chase', changed: false });
      expect(on().spider.colour).toEqual({ scene: 'red', changed: false });
      expect(on().spider.motion).toEqual({ scene: 'low', changed: false });
    });

    it('takes the scene of the same type off the place and no other', () => {
      rig.playback.recall('spider', 'chase');
      rig.playback.recall('spider', 'kick');
      expect(on().spider.lights).toEqual({ scene: 'kick', changed: false });
      rig.playback.recall('spider', 'low');
      rig.playback.recall('spider', 'high');
      expect(on().spider.motion).toEqual({ scene: 'high', changed: false });
      expect(on().spider.lights).toEqual({ scene: 'kick', changed: false });
    });

    it('shows only the type that was changed by hand as changed', () => {
      for (const scene of ['chase', 'green', 'low']) rig.playback.recall('spider', scene);
      const told = vi.fn();
      rig.on('playback', told);

      change('spider', { levels: { tilt1: 0.7 } });
      expect(on().spider).toEqual({
        lights: { scene: 'chase', changed: false },
        colour: { scene: 'green', changed: false },
        motion: { scene: 'low', changed: true },
      });
      expect(told).toHaveBeenCalledTimes(1);

      change('spider', { levels: { dimmer: 0.1 } });
      expect(on().spider.lights).toEqual({ scene: 'chase', changed: true });
      expect(on().spider.colour).toEqual({ scene: 'green', changed: false });

      change('spider', { effect: { colourA: RED } });
      expect(on().spider.colour).toEqual({ scene: 'green', changed: true });

      change('spider', { levels: { tilt1: 0.2 } });
      expect(on().spider.motion).toEqual({ scene: 'low', changed: false });
    });

    it('is told by the second colour too: a colour scene is changed when it is set or cleared', () => {
      rig.playback.recall('spider', 'green');
      change('spider', { effect: { colourB: RED } });
      expect(on().spider.colour).toEqual({ scene: 'green', changed: true });
      change('spider', { effect: { colourB: null } });
      expect(on().spider.colour).toEqual({ scene: 'green', changed: false });
    });

    it('takes the second colour back when a colour scene does not name it', () => {
      change('spider', { effect: { colourA: RED, colourB: GREEN } });
      rig.playback.store('spider', 'colour', 'Both');
      change('spider', { effect: { colourB: null } });
      rig.playback.recall('spider', 'green');
      expect(state('spider')).toMatchObject({ effect: { colourB: null } });
      rig.playback.recall('spider', 'both');
      expect(state('spider')).toMatchObject({ effect: { colourB: GREEN } });
    });

    it('stores over a scene of its own type only', () => {
      rig.playback.recall('spider', 'green');
      change('spider', { levels: { red1: 0.25, dimmer: 0.9 }, effect: { colourA: RED } });
      rig.playback.storeOver('spider', 'green');
      expect(group('spider')?.scenes.find((scene) => scene.id === 'green')?.type).toBe('colour');
      expect(on().spider.colour).toEqual({ scene: 'green', changed: false });
      // The brightness was changed too, and a colour scene does not keep that.
      change('spider', { levels: { dimmer: 0 } });
      rig.playback.recall('spider', 'green');
      expect(state('spider')).toMatchObject({
        levels: { red1: 0.25, dimmer: 0 },
        effect: { colourA: RED },
      });
    });

    it('does not let a scene of another type of a group that is set as a whole go', () => {
      change('laser', { raw: { mode: MANUAL, colour: 80, rotation: 20 } });
      rig.playback.store('all', 'colour', 'Everywhere');
      rig.playback.recall('spider', 'chase');
      rig.playback.recall('spider', 'green');

      // The scene of colour in "All" sets every fixture of "Spider": the one of "Spider" is off.
      rig.playback.recall('all', 'everywhere');
      expect(on().spider.colour).toEqual(NONE);
      expect(on().all.colour).toEqual({ scene: 'everywhere', changed: false });
      // Its lights scene is another type, and was not touched.
      expect(on().spider.lights).toEqual({ scene: 'chase', changed: false });
      expect(on().all.lights).toEqual(NONE);
    });
  });

  it('darkens a fixture of the group that the scene does not name', () => {
    change('spider', { levels: { dimmer: 1 } });
    rig.playback.store('all', 'lights', 'Spider only');
    expect(group('all')?.scenes[0]?.fixtures).toEqual(['spider']);

    change('laser', { raw: { mode: MANUAL, drawing: 191 }, effect: { id: 'pulse' } });
    rig.playback.recall('all', 'spider-only');
    expect(ch(output, LASER_AT)).toBe(0);
    expect(state('laser')).toEqual({
      raw: expect.objectContaining({ mode: 0, drawing: 0 }),
      effect: { id: null, speed: 1 },
    });
  });

  it('puts a fixture it does not name to rest for its type only', () => {
    change('spider', { levels: { red1: 1 } });
    rig.playback.store('all', 'colour', 'Spider only');
    expect(group('all')?.scenes[0]?.fixtures).toEqual(['spider']);

    change('laser', { raw: { mode: MANUAL, colour: 80, rotation: 20 } });
    rig.playback.recall('all', 'spider-only');
    // The colour of the laser is at rest, and its mode and its rotation are what they were.
    expect(state('laser')).toMatchObject({ raw: { mode: MANUAL, colour: 0, rotation: 20 } });
    expect(ch(output, LASER_AT)).toBe(MANUAL);
  });

  it('leaves a fixture outside the group alone, whatever the type', () => {
    change('spider', { levels: { red1: 1 } });
    rig.playback.store('spider', 'colour', 'Red');
    change('laser', { raw: { mode: MANUAL, colour: 10, rotation: 20 } });
    rig.playback.recall('spider', 'red');
    expect(state('laser')).toMatchObject({ raw: { mode: MANUAL, colour: 10, rotation: 20 } });
  });

  it('is what off is: only the lights, with the colour and the motion left as they are', () => {
    change('spider', {
      levels: { dimmer: 1, red1: 1, tilt1: 0.4 },
      effect: { id: 'chase', colourA: GREEN },
    });
    change('laser', { raw: { mode: MANUAL } });
    rig.playback.store('spider', 'lights', 'Warm');
    rig.playback.store('spider', 'colour', 'Red');
    rig.playback.store('laser', 'lights', 'Open');
    const told = vi.fn();
    rig.on('playback', told);

    rig.playback.off('spider', 'tablet-1');
    expect(ch(output, 6)).toBe(0);
    expect(state('spider')).toMatchObject({
      levels: { dimmer: 0, red1: 1, tilt1: 0.4 },
      effect: { id: null, colourA: GREEN },
    });
    expect(ch(output, LASER_AT)).toBe(MANUAL);
    expect(told).toHaveBeenCalledTimes(1);
    expect(told).toHaveBeenLastCalledWith({
      groups: {
        spider: {
          lights: NONE,
          colour: { scene: 'red', changed: false },
          motion: NONE,
        },
        laser: lights('open'),
        all: NOTHING,
      },
    });

    rig.playback.off('all');
    expect(ch(output, LASER_AT)).toBe(0);
    expect(on().laser.lights).toEqual(NONE);
    expect(on().spider.colour).toEqual({ scene: 'red', changed: false });
  });

  it('passes on who asked for it', () => {
    rig.playback.store('spider', 'lights', 'Warm');
    const told = vi.fn();
    rig.on('fixture', told);
    rig.playback.recall('spider', 'warm', 'tablet-1');
    rig.playback.off('spider', 'tablet-2');
    expect(told.mock.calls.map((call) => [call[0], call[3]])).toEqual([
      ['spider', 'tablet-1'],
      ['spider', 'tablet-2'],
    ]);
  });

  it('opens the laser when a scene of lights says so', () => {
    change('laser', { raw: { mode: MANUAL } });
    rig.playback.store('laser', 'lights', 'Laser on');
    change('laser', { raw: { mode: 0 } });
    expect(ch(output, LASER_AT)).toBe(0);
    rig.playback.recall('laser', 'laser-on');
    expect(ch(output, LASER_AT)).toBe(MANUAL);
  });

  it('keeps the laser closed during a blackout, whatever is recalled', () => {
    change('laser', { raw: { mode: MANUAL, drawing: 191 }, effect: { id: 'pulse' } });
    rig.playback.store('laser', 'lights', 'Laser on');
    rig.playback.store('all', 'lights', 'Everything');
    rig.playback.off('all');
    rig.setBlackout(true);
    const frames = output.frames.length;

    rig.playback.recall('laser', 'laser-on');
    rig.playback.recall('all', 'everything');
    rig.playback.off('laser');
    rig.playback.recall('laser', 'laser-on');
    for (const { data } of output.frames.slice(frames)) expect(data[LASER_AT - 1]).toBe(0);
    expect(ch(output, LASER_AT)).toBe(0);
    expect(on().laser).toEqual(lights('laser-on'));

    rig.setBlackout(false);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
  });

  it('stores the brightness as it is set, not what the master makes of it', () => {
    change('spider', { levels: { dimmer: 0.8 } });
    change('laser', { raw: { mode: MANUAL } });
    rig.setMaster(0.5);
    expect(ch(output, 6)).toBe(102);
    rig.playback.store('all', 'lights', 'Warm');
    expect(readFileSync(path, 'utf8')).toContain('dimmer: 0.8');
    expect(readFileSync(path, 'utf8')).not.toContain('master');

    rig.setMaster(0);
    rig.playback.store('all', 'lights', 'Dark');
    rig.playback.storeOver('all', 'warm');
    expect(group('all')?.scenes.map((scene) => scene.fixtures)).toEqual([
      ['spider', 'laser'],
      ['spider', 'laser'],
    ]);

    rig.close();
    start();
    expect(rig.getMaster()).toBe(1);
    for (const scene of ['warm', 'dark']) {
      rig.playback.off('all');
      rig.playback.recall('all', scene);
      expect(state('spider')).toEqual(
        expect.objectContaining({ levels: expect.objectContaining({ dimmer: 0.8 }) }),
      );
      expect(ch(output, 6)).toBe(204);
      expect(ch(output, LASER_AT)).toBe(MANUAL);
    }
  });

  it('does not show a scene as changed when the master moves', () => {
    change('spider', { levels: { dimmer: 1 }, effect: { id: 'chase' } });
    change('laser', { raw: { mode: MANUAL } });
    rig.playback.store('spider', 'lights', 'Warm');
    rig.playback.store('laser', 'lights', 'Open');
    rig.playback.store('all', 'lights', 'Everything');
    const told = vi.fn();
    rig.on('playback', told);
    const before = on();

    for (const master of [0.5, 0, 0.01, 1, 0.3]) {
      rig.setMaster(master);
      expect(on()).toEqual(before);
    }
    rig.setBlackout(true);
    rig.setMaster(0.6);
    rig.setBlackout(false);
    expect(told).not.toHaveBeenCalled();
    expect(on().all.lights).toEqual({ scene: 'everything', changed: false });

    // A change by hand still shows, also while the master is down.
    change('spider', { levels: { dimmer: 0.6 } });
    expect(on().spider.lights).toEqual({ scene: 'warm', changed: true });
    // Setting by hand what the master made of it is a change like any other.
    rig.playback.recall('spider', 'warm');
    rig.setMaster(0.5);
    change('spider', { levels: { dimmer: 0.5 } });
    expect(on().spider.lights).toEqual({ scene: 'warm', changed: true });
  });

  it('does not move the master with a recall or with off', () => {
    change('spider', { levels: { dimmer: 1 } });
    rig.playback.store('spider', 'lights', 'Full');
    change('spider', { levels: { dimmer: 0.5 } });
    rig.playback.store('spider', 'lights', 'Half');
    const masters = vi.fn();
    rig.on('master', masters);
    rig.setMaster(0.5);

    rig.playback.recall('spider', 'full');
    expect(rig.getMaster()).toBe(0.5);
    expect(ch(output, 6)).toBe(128);
    rig.playback.recall('spider', 'half');
    expect(ch(output, 6)).toBe(64);
    rig.playback.off('spider');
    expect(ch(output, 6)).toBe(0);
    rig.playback.recall('spider', 'full');
    expect(ch(output, 6)).toBe(128);
    expect(state('spider')).toEqual(
      expect.objectContaining({ levels: expect.objectContaining({ dimmer: 1 }) }),
    );
    expect(on().spider.lights).toEqual({ scene: 'full', changed: false });

    expect(rig.getMaster()).toBe(0.5);
    expect(masters).toHaveBeenCalledTimes(1);
    rig.setMaster(1);
    expect(ch(output, 6)).toBe(255);
  });

  it('keeps the laser closed while the master is at 0, whatever is recalled', () => {
    change('laser', { raw: { mode: MANUAL, drawing: 191 }, effect: { id: 'pulse' } });
    rig.playback.store('laser', 'lights', 'Laser on');
    rig.playback.store('all', 'lights', 'Everything');
    rig.playback.off('all');
    rig.setMaster(0);
    const frames = output.frames.length;

    rig.playback.recall('laser', 'laser-on');
    rig.playback.recall('all', 'everything');
    rig.playback.off('laser');
    rig.playback.recall('laser', 'laser-on');
    change('laser', { raw: { mode: 223 } });
    rig.playback.recall('laser', 'laser-on');
    expect(output.frames.length).toBeGreaterThan(frames + 5);
    for (const { data } of output.frames.slice(frames)) expect(data[LASER_AT - 1]).toBe(0);
    expect(on().laser).toEqual(lights('laser-on'));

    rig.setMaster(0.01);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
  });

  it('says per group when its fixtures are no longer what the scene made them', () => {
    change('spider', { levels: { dimmer: 1 } });
    change('laser', { raw: { mode: MANUAL } });
    rig.playback.store('spider', 'lights', 'Warm');
    rig.playback.store('laser', 'lights', 'Open');
    const told = vi.fn();
    rig.on('playback', told);
    const now = (spider: boolean, laser: boolean) => ({
      groups: {
        spider: lights('warm', spider),
        laser: lights('open', laser),
        all: NOTHING,
      },
    });

    change('spider', { levels: { dimmer: 0.5 } });
    expect(told).toHaveBeenLastCalledWith(now(true, false));
    change('spider', { levels: { dimmer: 0.4 } });
    expect(told).toHaveBeenCalledTimes(1);

    change('laser', { raw: { drawing: 191 } });
    expect(told).toHaveBeenLastCalledWith(now(true, true));
    change('spider', { levels: { dimmer: 1 } });
    expect(told).toHaveBeenLastCalledWith(now(false, true));

    rig.playback.recall('laser', 'open');
    expect(told).toHaveBeenLastCalledWith(now(false, false));
    expect(told).toHaveBeenCalledTimes(4);
  });

  describe('with groups that share a fixture', () => {
    beforeEach(() => {
      change('spider', { levels: { dimmer: 1 } });
      change('laser', { raw: { mode: MANUAL } });
      rig.playback.store('spider', 'lights', 'Warm');
      rig.playback.store('laser', 'lights', 'Open');
      rig.playback.store('all', 'lights', 'Full');
      change('spider', { levels: { dimmer: 0.5 } });
      rig.playback.store('spider', 'lights', 'Half');
      rig.playback.off('all');
    });

    it('takes the scene of a group off when all its fixtures are set by another', () => {
      rig.playback.recall('spider', 'warm');
      rig.playback.recall('laser', 'open');
      rig.playback.recall('all', 'full');
      expect(on()).toEqual({ spider: NOTHING, laser: NOTHING, all: lights('full') });
    });

    it('takes it off also when the other scene made the fixture the same', () => {
      rig.playback.recall('spider', 'warm');
      rig.playback.recall('all', 'full');
      expect(ch(output, 6)).toBe(255);
      expect(on().spider).toEqual(NOTHING);
    });

    it('keeps the scene of a group on, as changed, when some of its fixtures are set', () => {
      rig.playback.recall('all', 'full');
      rig.playback.recall('spider', 'half');
      expect(ch(output, 6)).toBe(128);
      expect(ch(output, LASER_AT)).toBe(MANUAL);
      expect(on()).toEqual({
        spider: lights('half'),
        laser: NOTHING,
        all: lights('full', true),
      });
    });

    it('keeps it on and not changed when the fixtures still are what it made them', () => {
      rig.playback.recall('all', 'full');
      rig.playback.recall('spider', 'warm');
      expect(on()).toEqual({
        spider: lights('warm'),
        laser: NOTHING,
        all: lights('full'),
      });
    });

    it('does the same for off', () => {
      rig.playback.recall('all', 'full');
      rig.playback.off('laser');
      expect(on()).toEqual({ spider: NOTHING, laser: NOTHING, all: lights('full', true) });

      rig.playback.recall('spider', 'warm');
      rig.playback.off('all');
      expect(on()).toEqual({ spider: NOTHING, laser: NOTHING, all: NOTHING });
    });

    it('takes the scene of a group with the same fixtures off', () => {
      rig.playback.addGroup('Both', ['laser', 'spider']);
      rig.playback.store('both', 'lights', 'Peak');
      rig.playback.recall('all', 'full');
      expect(on().both).toEqual(NOTHING);
      rig.playback.recall('both', 'peak');
      expect(on().all).toEqual(NOTHING);
      expect(on().both).toEqual(lights('peak'));
    });

    it('tells once about a press', () => {
      rig.playback.recall('spider', 'warm');
      const told = vi.fn();
      rig.on('playback', told);
      rig.playback.recall('all', 'full');
      expect(told).toHaveBeenCalledTimes(1);
    });
  });

  it('changes no fixture when one of them cannot take its part', () => {
    rig.close();
    writeFileSync(
      path,
      'groups:\n  all:\n    fixtures: [spider, laser]\n    scenes:\n      peak:\n        type: lights\n        fixtures:\n          spider: { levels: { dimmer: 1 } }\n          laser: { raw: { mode: 95 } }\n',
    );
    start();
    change('spider', { levels: { dimmer: 0.5 } });
    rig.playback.store('all', 'lights', 'Half');
    const laser = rig.find('laser')?.controller;
    if (!laser) throw new Error('no laser');
    const check = vi.spyOn(laser, 'check').mockImplementation(() => {
      throw new PatchError('the laser cannot do this');
    });
    const frames = output.frames.length;

    expect(() => rig.playback.recall('all', 'peak')).toThrow('the laser cannot do this');
    expect(() => rig.playback.off('all')).toThrow(PatchError);
    expect(output.frames).toHaveLength(frames);
    expect(state('spider')).toMatchObject({ levels: { dimmer: 0.5 } });
    expect(on()).toEqual({ all: lights('half') });

    check.mockRestore();
    rig.playback.recall('all', 'peak');
    expect(ch(output, 6)).toBe(255);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
  });

  it('stores the fixtures as they are over a scene that is there', () => {
    change('spider', { levels: { dimmer: 1 } });
    rig.playback.store('spider', 'lights', 'Warm');
    change('spider', { levels: { dimmer: 0.5 } });
    change('laser', { raw: { mode: MANUAL } });
    rig.playback.storeOver('spider', 'warm');
    expect(on().spider).toEqual(lights('warm'));
    expect(group('spider')?.scenes).toEqual([
      { id: 'warm', label: 'Warm', type: 'lights', fixtures: ['spider'] },
    ]);

    change('spider', { levels: { dimmer: 0 } });
    rig.playback.recall('spider', 'warm');
    expect(ch(output, 6)).toBe(128);
  });

  it('renames a scene and keeps its id and its type', () => {
    rig.playback.store('spider', 'motion', 'Warm');
    rig.playback.rename('spider', 'warm', ' Warm up ');
    expect(group('spider')?.scenes).toEqual([
      { id: 'warm', label: 'Warm up', type: 'motion', fixtures: [] },
    ]);
    expect(() => rig.playback.rename('spider', 'warm', '')).toThrow(PatchError);
    expect(on().spider.motion).toEqual({ scene: 'warm', changed: false });
  });

  it('takes a scene away, and no scene of the group is on when it was that one', () => {
    rig.playback.store('spider', 'lights', 'Warm');
    rig.playback.store('spider', 'lights', 'Cold');
    rig.playback.store('laser', 'lights', 'Warm');
    rig.playback.recall('spider', 'warm');
    rig.playback.remove('spider', 'warm');
    expect(group('spider')?.scenes.map((scene) => scene.id)).toEqual(['cold']);
    expect(on()).toEqual({ spider: NOTHING, laser: lights('warm'), all: NOTHING });
  });

  it('gives a scene an id of its own within its group, whatever its type', () => {
    expect(rig.playback.store('spider', 'lights', 'Peak')).toBe('peak');
    expect(rig.playback.store('spider', 'lights', 'Peak')).toBe('peak-2');
    expect(rig.playback.store('spider', 'colour', 'Peak')).toBe('peak-3');
    expect(rig.playback.store('laser', 'motion', 'Peak')).toBe('peak');
    expect(rig.playback.store('laser', 'lights', 'Off')).toBe('off-2');
  });

  it('refuses a group or a scene that is not there', () => {
    rig.playback.store('spider', 'lights', 'Warm');
    const refused: [() => void, string][] = [
      [() => rig.playback.recall('strobe', 'warm'), 'there is no group called "strobe"'],
      [() => rig.playback.recall(undefined, 'warm'), 'say which group, by its id'],
      [() => rig.playback.recall('spider', undefined), 'say which scene, by its id'],
      [
        () => rig.playback.recall('spider', 'nothing'),
        'there is no scene called "nothing" in the group "spider"',
      ],
      [
        () => rig.playback.recall('laser', 'warm'),
        'there is no scene called "warm" in the group "laser"',
      ],
      [() => rig.playback.off('strobe'), 'there is no group called "strobe"'],
      [() => rig.playback.store('strobe', 'lights', 'Warm'), 'there is no group called "strobe"'],
      [() => rig.playback.store('spider', 'lights', ' '), 'a scene needs a name'],
      [
        () => rig.playback.storeOver('laser', 'warm'),
        'there is no scene called "warm" in the group "laser"',
      ],
      [
        () => rig.playback.rename('spider', 'nothing', 'Name'),
        'there is no scene called "nothing" in the group "spider"',
      ],
      [
        () => rig.playback.remove('spider', 'nothing'),
        'there is no scene called "nothing" in the group "spider"',
      ],
      [() => rig.playback.renameGroup('strobe', 'Name'), 'there is no group called "strobe"'],
      [() => rig.playback.removeGroup('strobe'), 'there is no group called "strobe"'],
    ];
    for (const [act, message] of refused) expect(act).toThrow(new PatchError(message));
  });

  it('refuses a scene without a type, or with one it does not know, and writes nothing', () => {
    for (const type of [undefined, 'full', 'light', 3, null]) {
      expect(() => rig.playback.store('spider', type, 'Warm')).toThrow(
        new PatchError('a scene needs a type: lights, colour, motion'),
      );
    }
    expect(existsSync(path)).toBe(false);
    expect(group('spider')?.scenes).toEqual([]);
  });

  describe('groups', () => {
    it('makes a group of fixtures, without scenes and with nothing on', () => {
      const show = vi.fn();
      const playback = vi.fn();
      rig.on('show', show);
      rig.on('playback', playback);
      expect(rig.playback.addGroup(' Front  bar ', ['laser', 'spider'])).toBe('front-bar');
      expect(group('front-bar')).toEqual({
        id: 'front-bar',
        label: 'Front bar',
        fixtures: ['laser', 'spider'],
        scenes: [],
      });
      expect(show).toHaveBeenCalledTimes(1);
      expect(show).toHaveBeenLastCalledWith(rig.playback.getShow());
      expect(playback).toHaveBeenLastCalledWith({
        groups: { spider: NOTHING, laser: NOTHING, all: NOTHING, 'front-bar': NOTHING },
      });
      expect(readFileSync(path, 'utf8')).toContain(
        '  front-bar:\n    label: Front bar\n    fixtures: [ laser, spider ]\n    scenes: {}\n',
      );
    });

    it('gives two groups of the same name their own id', () => {
      expect(rig.playback.addGroup('Spider', ['spider'])).toBe('spider-2');
      expect(rig.playback.addGroup('Spider', ['spider'])).toBe('spider-3');
    });

    it('refuses a group that cannot be one', () => {
      const refused: [() => void, string][] = [
        [() => rig.playback.addGroup('', ['spider']), 'a group needs a name'],
        [() => rig.playback.addGroup(undefined, ['spider']), 'a group needs a name'],
        [() => rig.playback.addGroup('Front', []), 'a group needs at least one fixture'],
        [
          () => rig.playback.addGroup('Front', undefined),
          '"fixtures" must be a list of the fixtures of the group',
        ],
        [
          () => rig.playback.addGroup('Front', ['strobe']),
          'there is no fixture called "strobe", only spider, laser',
        ],
        [
          () => rig.playback.addGroup('Front', ['spider', 'spider']),
          '"spider" is in the group twice',
        ],
      ];
      for (const [act, message] of refused) expect(act).toThrow(new PatchError(message));
      expect(rig.playback.getShow().groups).toHaveLength(3);
      expect(existsSync(path)).toBe(false);
    });

    it('renames a group and keeps its id, its scenes and what is on', () => {
      rig.playback.store('spider', 'lights', 'Warm');
      rig.playback.renameGroup('spider', ' Truss ');
      expect(group('spider')).toEqual({
        id: 'spider',
        label: 'Truss',
        fixtures: ['spider'],
        scenes: [{ id: 'warm', label: 'Warm', type: 'lights', fixtures: [] }],
      });
      expect(on().spider).toEqual(lights('warm'));
      expect(() => rig.playback.renameGroup('spider', '')).toThrow('a group needs a name');
    });

    it('takes a group away with its scenes, and leaves the fixtures as they are', () => {
      change('spider', { levels: { dimmer: 1 } });
      rig.playback.store('spider', 'lights', 'Warm');
      rig.playback.store('all', 'lights', 'Full');
      const told = vi.fn();
      rig.on('playback', told);

      rig.playback.removeGroup('spider');
      expect(rig.playback.getShow().groups.map((each) => each.id)).toEqual(['laser', 'all']);
      expect(told).toHaveBeenLastCalledWith({
        groups: { laser: NOTHING, all: lights('full') },
      });
      expect(ch(output, 6)).toBe(255);
      expect(readFileSync(path, 'utf8')).not.toContain('warm');
      expect(() => rig.playback.recall('spider', 'warm')).toThrow(PatchError);
    });

    it('can take every group away, and make one again', () => {
      for (const id of ['spider', 'laser', 'all']) rig.playback.removeGroup(id);
      expect(rig.playback.getShow().groups).toEqual([]);
      expect(rig.playback.getState()).toEqual({ groups: {} });
      rig.close();
      start();
      expect(rig.playback.getShow().groups).toEqual([]);
      expect(rig.playback.addGroup('Both', ['spider', 'laser'])).toBe('both');
      expect(rig.playback.getState()).toEqual({ groups: { both: NOTHING } });
    });

    it('has nothing on in a group that is made again after it was taken away', () => {
      rig.playback.addGroup('Front', ['spider']);
      rig.playback.store('front', 'lights', 'Warm');
      rig.playback.removeGroup('front');
      rig.playback.addGroup('Front', ['spider']);
      expect(on().front).toEqual(NOTHING);
    });
  });

  it('tells about the show when it changes', () => {
    const told = vi.fn();
    rig.on('show', told);
    rig.playback.store('laser', 'colour', 'Warm');
    expect(told).toHaveBeenCalledTimes(1);
    expect(told).toHaveBeenLastCalledWith({
      file: path,
      problem: null,
      groups: [
        { id: 'spider', label: 'Spider', fixtures: ['spider'], scenes: [] },
        {
          id: 'laser',
          label: 'Laser',
          fixtures: ['laser'],
          scenes: [{ id: 'warm', label: 'Warm', type: 'colour', fixtures: [] }],
        },
        { id: 'all', label: 'All', fixtures: ['spider', 'laser'], scenes: [] },
      ],
    });
  });

  describe('with a file from before there were groups', () => {
    beforeEach(() => {
      rig.close();
      writeFileSync(path, STEP_ONE);
      start();
    });

    it('has its scenes in the group of all fixtures, and does not write to the file', () => {
      expect(rig.playback.getShow()).toEqual({
        file: path,
        problem: null,
        groups: [
          { id: 'spider', label: 'Spider', fixtures: ['spider'], scenes: [] },
          { id: 'laser', label: 'Laser', fixtures: ['laser'], scenes: [] },
          {
            id: 'all',
            label: 'All',
            fixtures: ['spider', 'laser'],
            scenes: [{ id: 'warm', label: 'Warm', type: 'lights', fixtures: ['spider', 'laser'] }],
          },
        ],
      });
      rig.playback.recall('all', 'warm');
      rig.playback.off('spider');
      expect(ch(output, LASER_AT)).toBe(MANUAL);
      expect(on().all.lights).toEqual({ scene: 'warm', changed: true });
      expect(readFileSync(path, 'utf8')).toBe(STEP_ONE);
    });

    it('writes the file with groups at the first change, with its scenes kept', () => {
      rig.playback.recall('all', 'warm');
      rig.playback.store('spider', 'lights', 'Cold');
      const text = readFileSync(path, 'utf8');
      expect(text).toMatch(/^# The show of the evening\.\ngroups:\n/);
      expect(text).toContain('label: Warm # the opener');
      expect(on()).toEqual({
        spider: lights('cold'),
        laser: NOTHING,
        all: lights('warm'),
      });

      rig.close();
      start();
      expect(rig.playback.getShow().problem).toBeNull();
      expect(group('all')?.scenes).toEqual([
        { id: 'warm', label: 'Warm', type: 'lights', fixtures: ['spider', 'laser'] },
      ]);
      expect(group('spider')?.scenes.map((scene) => scene.id)).toEqual(['cold']);
      rig.playback.recall('all', 'warm');
      expect(ch(output, 6)).toBe(255);
      expect(ch(output, LASER_AT)).toBe(MANUAL);
    });

    it('does not read the scenes of before there were types', () => {
      rig.close();
      writeFileSync(path, STEP_ONE.replace('    type: lights\n', ''));
      start();
      expect(rig.playback.getShow().problem).toMatch(
        /Scene "warm": a scene needs a type: lights, colour, motion/,
      );
      expect(rig.playback.getShow().groups.every((each) => each.scenes.length === 0)).toBe(true);
    });
  });

  describe('when the file changes by hand', () => {
    const HAND_MADE = `groups:
  spider:
    label: Spider
    fixtures: [spider]
    scenes:
      warm:
        type: lights
        fixtures:
          spider: { levels: { dimmer: 1 } }
      cold:
        type: lights
        fixtures:
          spider: { levels: { dimmer: 0.5 } }
  laser:
    label: Laser
    fixtures: [laser]
    scenes:
      open:
        type: lights
        fixtures:
          laser: { raw: { mode: 95 } }
`;
    const WITHOUT_WARM = HAND_MADE.replace(/ {6}warm:\n.*\n.*\n.*\n/, '');
    const WITHOUT_LASER = HAND_MADE.slice(0, HAND_MADE.indexOf('  laser:'));

    beforeEach(() => {
      rig.close();
      writeFileSync(path, HAND_MADE);
      start();
      rig.playback.recall('spider', 'warm');
      rig.playback.recall('laser', 'open');
    });

    it('has no scene on in a group when the scene that was on is gone', async () => {
      const told = vi.fn();
      rig.on('playback', told);
      writeFileSync(path, WITHOUT_WARM);
      await vi.waitFor(() => expect(on().spider).toEqual(NOTHING), { timeout: 2000 });
      expect(group('spider')?.scenes.map((scene) => scene.id)).toEqual(['cold']);
      expect(on().laser).toEqual(lights('open'));
      expect(told).toHaveBeenLastCalledWith({
        groups: { spider: NOTHING, laser: lights('open') },
      });
      expect(ch(output, 6)).toBe(255);
    });

    it('has no scene on when the scene that was on got another type in the file', async () => {
      writeFileSync(
        path,
        HAND_MADE.replace(
          'warm:\n        type: lights\n        fixtures:\n          spider: { levels: { dimmer: 1 } }',
          'warm:\n        type: motion\n        fixtures:\n          spider: { levels: { tilt1: 0.5 } }',
        ),
      );
      await vi.waitFor(() => expect(group('spider')?.scenes[0]?.type).toBe('motion'), {
        timeout: 2000,
      });
      expect(on().spider).toEqual(NOTHING);
      expect(on().laser).toEqual(lights('open'));
    });

    it('has no entry for a group that is gone', async () => {
      const told = vi.fn();
      rig.on('playback', told);
      writeFileSync(path, WITHOUT_LASER);
      await vi.waitFor(() => expect(Object.keys(on())).toEqual(['spider']), { timeout: 2000 });
      expect(told).toHaveBeenLastCalledWith({ groups: { spider: lights('warm') } });
      expect(ch(output, LASER_AT)).toBe(MANUAL);
      expect(() => rig.playback.recall('laser', 'open')).toThrow(PatchError);
    });

    it('looks at a group again when it gets other fixtures', async () => {
      const told = vi.fn();
      rig.on('playback', told);
      writeFileSync(path, HAND_MADE.replace('fixtures: [spider]', 'fixtures: [spider, laser]'));
      await vi.waitFor(() => expect(group('spider')?.fixtures).toEqual(['spider', 'laser']), {
        timeout: 2000,
      });
      // The laser is open, which is not what the scene made of this group.
      expect(on().spider).toEqual(lights('warm', true));
      expect(told).toHaveBeenCalledTimes(1);
      expect(told).toHaveBeenLastCalledWith({
        groups: { spider: lights('warm', true), laser: lights('open') },
      });
    });

    it('keeps a scene on as it was recalled when its look changes in the file', async () => {
      writeFileSync(path, HAND_MADE.replace('dimmer: 1 ', 'dimmer: 0.3 '));
      await vi.waitFor(() => expect(readFileSync(path, 'utf8')).toContain('0.3'));
      await new Promise((done) => setTimeout(done, 400));
      expect(on().spider).toEqual(lights('warm'));
      expect(ch(output, 6)).toBe(255);
      rig.playback.recall('spider', 'warm');
      expect(ch(output, 6)).toBe(77);
    });

    // The file is read again before it is written, and the watcher has not said so yet.
    describe('a moment before a press on the deck', () => {
      const lines = (...added: string[]) => `${added.join('\n')}\n`;

      it('gives a new scene an id that the file has not', () => {
        writeFileSync(
          path,
          HAND_MADE +
            lines(
              '      peak:',
              '        label: Peak by hand',
              '        type: lights',
              '        fixtures: { laser: { raw: { mode: 95, program: 60 } } }',
            ),
        );
        change('laser', { raw: { mode: MANUAL } });
        expect(rig.playback.store('laser', 'lights', 'Peak')).toBe('peak-2');
        expect(group('laser')?.scenes.map(({ id, label }) => [id, label])).toEqual([
          ['open', 'open'],
          ['peak', 'Peak by hand'],
          ['peak-2', 'Peak'],
        ]);
        expect(readFileSync(path, 'utf8')).toContain('program: 60');
      });

      it('gives a new group an id that the file has not', () => {
        writeFileSync(
          path,
          HAND_MADE +
            lines(
              '  front:',
              '    label: Front by hand',
              '    fixtures: [laser]',
              '    scenes:',
              '      keep:',
              '        label: Keep',
              '        type: colour',
            ),
        );
        expect(rig.playback.addGroup('Front', ['spider'])).toBe('front-2');
        expect(group('front')).toEqual({
          id: 'front',
          label: 'Front by hand',
          fixtures: ['laser'],
          scenes: [{ id: 'keep', label: 'Keep', type: 'colour', fixtures: [] }],
        });
        expect(group('front-2')?.fixtures).toEqual(['spider']);
      });

      it('does not make a scene or a group anew that was taken away', () => {
        writeFileSync(path, WITHOUT_WARM);
        const gone = new PatchError('there is no scene called "warm" in the group "spider"');
        expect(() => rig.playback.storeOver('spider', 'warm')).toThrow(gone);
        expect(() => rig.playback.rename('spider', 'warm', 'Hot')).toThrow(gone);
        expect(() => rig.playback.remove('spider', 'warm')).toThrow(gone);
        expect(readFileSync(path, 'utf8')).toBe(WITHOUT_WARM);

        writeFileSync(path, WITHOUT_LASER);
        const none = new PatchError('there is no group called "laser"');
        expect(() => rig.playback.store('laser', 'lights', 'New')).toThrow(none);
        expect(() => rig.playback.renameGroup('laser', 'Beam')).toThrow(none);
        expect(() => rig.playback.removeGroup('laser')).toThrow(none);
        expect(readFileSync(path, 'utf8')).toBe(WITHOUT_LASER);
      });

      it('stores in a group that was made by hand', () => {
        writeFileSync(path, `${HAND_MADE}  both:\n    fixtures: [spider, laser]\n`);
        expect(rig.playback.store('both', 'lights', 'Peak')).toBe('peak');
        expect(on().both).toEqual(lights('peak'));
      });
    });

    it('keeps what is on when the file gets a mistake', async () => {
      writeFileSync(path, `${HAND_MADE}sequences: {}\n`);
      await vi.waitFor(() => expect(rig.playback.getShow().problem).not.toBeNull(), {
        timeout: 2000,
      });
      expect(on()).toEqual({ spider: lights('warm'), laser: lights('open') });
      rig.playback.recall('spider', 'cold');
      expect(ch(output, 6)).toBe(128);
      expect(() => rig.playback.store('spider', 'lights', 'New')).toThrow(/has a mistake/);
    });
  });

  describe('with ids that are numbers', () => {
    const NUMBERS = `groups:
  spider:
    label: Spider
    fixtures: [spider]
    scenes:
      warm:
        label: Warm
        type: lights
      2:
        label: Two
        type: lights
        fixtures: { spider: { levels: { dimmer: 0.5 } } }
      1:
        label: One
        type: lights
        fixtures: { spider: { levels: { dimmer: 1 } } }
  2024:
    label: This year
    fixtures: [laser]
`;

    beforeEach(() => {
      rig.close();
      writeFileSync(path, NUMBERS);
      start();
    });

    it('has them in the order of the file', () => {
      expect(rig.playback.getShow().problem).toBeNull();
      expect(rig.playback.getShow().groups.map((each) => each.id)).toEqual(['spider', '2024']);
      expect(group('spider')?.scenes.map((scene) => scene.id)).toEqual(['warm', '2', '1']);
      expect(on()).toEqual({ spider: NOTHING, 2024: NOTHING });
    });

    it('renames a scene and stores over it, and keeps the rest of it', () => {
      rig.playback.rename('spider', '1', 'Opening');
      expect(group('spider')?.scenes[2]).toEqual({
        id: '1',
        label: 'Opening',
        type: 'lights',
        fixtures: ['spider'],
      });
      rig.playback.recall('spider', '1');
      expect(ch(output, 6)).toBe(255);

      change('spider', { levels: { dimmer: 0.5 } });
      rig.playback.storeOver('spider', '1');
      expect(group('spider')?.scenes.map(({ id, label }) => [id, label])).toEqual([
        ['warm', 'Warm'],
        ['2', 'Two'],
        ['1', 'Opening'],
      ]);
    });

    it('takes a scene away', () => {
      rig.playback.remove('spider', '2');
      expect(group('spider')?.scenes.map((scene) => scene.id)).toEqual(['warm', '1']);
      expect(readFileSync(path, 'utf8')).not.toContain('Two');
    });

    it('stores in a group, renames it and takes it away', () => {
      change('laser', { raw: { mode: MANUAL } });
      expect(rig.playback.store('2024', 'lights', 'Open')).toBe('open');
      rig.playback.renameGroup('2024', 'Next year');
      expect(group('2024')).toEqual({
        id: '2024',
        label: 'Next year',
        fixtures: ['laser'],
        scenes: [{ id: 'open', label: 'Open', type: 'lights', fixtures: ['laser'] }],
      });
      rig.playback.removeGroup('2024');
      expect(rig.playback.getShow().groups.map((each) => each.id)).toEqual(['spider']);
      expect(readFileSync(path, 'utf8')).not.toContain('2024');
    });
  });

  it('keeps scenes and groups with a number for a name in the order they were made', () => {
    for (const name of ['warm', '2', '1']) rig.playback.store('spider', 'lights', name);
    expect(rig.playback.addGroup('7', ['spider'])).toBe('7');
    const order = () =>
      rig.playback.getShow().groups.map((each) => [each.id, ...each.scenes.map(({ id }) => id)]);
    expect(order()).toEqual([['spider', 'warm', '2', '1'], ['laser'], ['all'], ['7']]);
    rig.close();
    start();
    expect(order()).toEqual([['spider', 'warm', '2', '1'], ['laser'], ['all'], ['7']]);
  });

  it('writes scenes that are stored after a restart on lines of their own', () => {
    change('spider', { levels: { dimmer: 1 } });
    rig.playback.store('spider', 'lights', 'Warm');
    rig.close();
    start();
    change('laser', { raw: { mode: MANUAL } });
    rig.playback.store('laser', 'lights', 'Tunnel');
    rig.playback.store('all', 'lights', 'Every');
    expect(readFileSync(path, 'utf8')).toContain(
      '    scenes:\n      tunnel:\n        label: Tunnel\n        type: lights\n        fixtures:\n          laser:\n',
    );
    expect(readFileSync(path, 'utf8')).toContain(
      '    scenes:\n      every:\n        label: Every\n        type: lights\n',
    );
  });

  it('starts with a show file that cannot be read as one, and keeps the laser closed', () => {
    rig.close();
    const nowhere = 'groups:\n  laser:\n    label: *name\n    fixtures: [laser]\n';
    writeFileSync(path, nowhere);
    start();
    expect(rig.playback.getShow().problem).toMatch(/^Unresolved alias/);
    expect(rig.playback.getShow().groups.map((each) => each.id)).toEqual([
      'spider',
      'laser',
      'all',
    ]);
    expect(() => rig.playback.store('laser', 'lights', 'Open')).toThrow(/has a mistake/);
    expect(readFileSync(path, 'utf8')).toBe(nowhere);
  });

  it('reads scenes written by hand, and sets what they do not name to rest', () => {
    rig.close();
    writeFileSync(
      path,
      'groups:\n  spider:\n    fixtures: [spider]\n    scenes:\n      hand:\n        label: By hand\n        type: lights\n        fixtures:\n          spider:\n            levels: { dimmer: 0.5 }\n',
    );
    start();
    change('spider', { levels: { red1: 1, strobe: 1 }, effect: { id: 'kick' } });
    rig.playback.recall('spider', 'hand');
    // Its colours are another type and stay.
    expect(state('spider')).toMatchObject({
      levels: { dimmer: 0.5, red1: 1, strobe: 0 },
      effect: { id: null },
    });
  });

  it('does not use a file that names what a fixture cannot do', () => {
    rig.close();
    writeFileSync(
      path,
      'groups:\n  laser:\n    fixtures: [laser]\n    scenes:\n      bad:\n        type: lights\n        fixtures:\n          laser:\n            raw: { mode: 300 }\n',
    );
    start();
    expect(rig.playback.getShow().groups.map((each) => each.id)).toEqual([
      'spider',
      'laser',
      'all',
    ]);
    expect(rig.playback.getShow().problem).toMatch(
      /Scene "bad" of group "laser": "mode" must be a whole number/,
    );
    expect(() => rig.playback.store('spider', 'lights', 'Warm')).toThrow(/has a mistake/);
  });

  it('does not use a file with a scene that names what is not of its type', () => {
    rig.close();
    writeFileSync(
      path,
      'groups:\n  spider:\n    fixtures: [spider]\n    scenes:\n      odd:\n        type: colour\n        fixtures:\n          spider:\n            levels: { dimmer: 1 }\n',
    );
    start();
    expect(rig.playback.getShow().problem).toMatch(
      /Scene "odd" of group "spider": "dimmer" is not part of a colour scene/,
    );
  });
});
