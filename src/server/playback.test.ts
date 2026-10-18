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
const NO_LOOK = { look: null, changed: false };
/** What is on in a group when nothing is, by type, and no look. */
const NOTHING = { lights: NONE, colour: NONE, motion: NONE, look: NO_LOOK };
/** What is on in a group when only a scene of lights is. Most of what follows is about lights. */
const lights = (scene: string, changed = false) => ({
  ...NOTHING,
  lights: { scene, changed },
});
/** What the show has for palettes before anybody makes one: a white and a rainbow. */
const STARTING_PALETTES = [
  {
    id: 'white',
    label: 'White',
    colours: ['#000000ff'],
    mode: 'static',
    change: 'step',
    speed: 0.25,
  },
  {
    id: 'rainbow',
    label: 'Rainbow',
    colours: ['#ff0000', '#ffaa00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff'],
    mode: 'cycle',
    change: 'fade',
    speed: 0.25,
  },
];
/** A group as the summary of the show has it. The laser does not take palettes. */
const GROUP = (
  id: string,
  label: string,
  fixtures: string[],
  scenes: unknown[] = [],
  looks: unknown[] = [],
) => ({ id, label, fixtures, palettes: fixtures.includes('spider'), scenes, looks });

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
      limits: {},
      palettes: STARTING_PALETTES,
      groups: [
        GROUP('spider', 'Spider', ['spider']),
        GROUP('laser', 'Laser', ['laser']),
        GROUP('all', 'All', ['spider', 'laser']),
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
      effect: { id: 'chase' },
      motion: { id: 'tiltwave', speed: 2 },
    });
    change('laser', {
      raw: { mode: MANUAL, drawing: 191, colour: 100, rotation: 30 },
      motion: { id: 'pulse' },
    });
    const before = [state('spider'), state('laser')];
    expect(rig.playback.store('all', 'lights', 'Chase on')).toBe('chase-on');
    expect(rig.playback.store('all', 'motion', 'Leaning')).toBe('leaning');
    rig.playback.setPalette('all', 'rainbow');

    change('spider', {
      levels: { dimmer: 0.2, tilt1: 0, motorSpeed: 0 },
      effect: { id: null },
      motion: { id: null, speed: 1 },
      colour: { palette: null },
    });
    change('laser', {
      raw: { mode: 0, drawing: 0, colour: 0, rotation: 0 },
      effect: { id: null },
    });
    for (const scene of ['chase-on', 'leaning']) rig.playback.recall('all', scene);
    rig.playback.setPalette('all', 'rainbow');

    // The colour of a lens by hand is in no scene, so it stays as it was set.
    expect([state('spider'), state('laser')]).toEqual([
      { ...(before[0] as object), colour: { palette: 'rainbow', speed: null } },
      before[1],
    ]);
    expect(ch(output, 6)).toBe(255);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
    expect(on().all).toEqual({
      lights: { scene: 'chase-on', changed: false },
      colour: { scene: 'rainbow', changed: false },
      motion: { scene: 'leaning', changed: false },
      look: NO_LOOK,
    });
  });

  it('keeps the type in the file, and only the properties of it', () => {
    change('spider', {
      levels: { dimmer: 1, red1: 0.5, tilt1: 0.3 },
      effect: { id: 'chase' },
      motion: { id: 'scissor', speed: 0.5 },
    });
    rig.playback.store('spider', 'lights', 'Chase');
    rig.playback.store('spider', 'motion', 'Lean');
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('type: lights');
    expect(text).toContain('type: motion');
    expect(text).not.toContain('type: colour');
    const { scenes } = parse(text).groups.spider;
    expect(scenes.chase).toEqual({
      label: 'Chase',
      type: 'lights',
      fixtures: { spider: { levels: { dimmer: 1 }, effect: { id: 'chase', speed: 1 } } },
    });
    expect(scenes.lean).toEqual({
      label: 'Lean',
      type: 'motion',
      fixtures: {
        spider: { levels: { tilt1: 0.3 }, motion: { id: 'scissor', speed: 0.5 } },
      },
    });
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
      GROUP(
        'spider',
        'Spider',
        ['spider'],
        [{ id: 'warm', label: 'Warm', type: 'lights', fixtures: ['spider'] }],
      ),
      GROUP('laser', 'Laser', ['laser']),
      GROUP('all', 'All', ['spider', 'laser']),
      GROUP('front', 'Front', ['laser', 'spider']),
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
    change('laser', { raw: { mode: MANUAL, drawing: 191 }, motion: { id: 'pulse' } });
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

  describe('with a scene of each lane', () => {
    beforeEach(() => {
      change('spider', {
        levels: { dimmer: 1, tilt1: 0.2 },
        effect: { id: 'chase' },
        colour: { palette: 'white' },
      });
      rig.playback.store('spider', 'lights', 'Chase');
      rig.playback.store('spider', 'motion', 'Low');
      change('spider', {
        levels: { dimmer: 0.5, tilt1: 0.9 },
        effect: { id: 'kick' },
      });
      rig.playback.store('spider', 'lights', 'Kick');
      rig.playback.store('spider', 'motion', 'High');
    });

    it('is on for one thing in each lane of a group, and each press sets only its lane', () => {
      rig.playback.recall('spider', 'chase');
      rig.playback.setPalette('spider', 'rainbow');
      rig.playback.recall('spider', 'low');
      expect(state('spider')).toMatchObject({
        levels: { dimmer: 1, tilt1: 0.2 },
        effect: { id: 'chase' },
        colour: { palette: 'rainbow', speed: null },
      });
      expect(on().spider).toEqual({
        lights: { scene: 'chase', changed: false },
        colour: { scene: 'rainbow', changed: false },
        motion: { scene: 'low', changed: false },
        look: NO_LOOK,
      });

      // Another palette takes the colours and leaves the chase going.
      rig.playback.setPalette('spider', 'white');
      expect(state('spider')).toMatchObject({
        effect: { id: 'chase' },
        colour: { palette: 'white' },
      });
      expect(on().spider.lights).toEqual({ scene: 'chase', changed: false });
      expect(on().spider.colour).toEqual({ scene: 'white', changed: false });
      expect(on().spider.motion).toEqual({ scene: 'low', changed: false });
    });

    it('takes the scene of the same lane off the place and no other', () => {
      rig.playback.recall('spider', 'chase');
      rig.playback.recall('spider', 'kick');
      expect(on().spider.lights).toEqual({ scene: 'kick', changed: false });
      rig.playback.recall('spider', 'low');
      rig.playback.recall('spider', 'high');
      expect(on().spider.motion).toEqual({ scene: 'high', changed: false });
      expect(on().spider.lights).toEqual({ scene: 'kick', changed: false });
    });

    it('shows only the lane that was changed by hand as changed', () => {
      rig.playback.recall('spider', 'chase');
      rig.playback.setPalette('spider', 'rainbow');
      rig.playback.recall('spider', 'low');
      const told = vi.fn();
      rig.on('playback', told);

      change('spider', { levels: { tilt1: 0.7 } });
      expect(on().spider).toEqual({
        lights: { scene: 'chase', changed: false },
        colour: { scene: 'rainbow', changed: false },
        motion: { scene: 'low', changed: true },
        look: NO_LOOK,
      });
      expect(told).toHaveBeenCalledTimes(1);

      change('spider', { levels: { dimmer: 0.1 } });
      expect(on().spider.lights).toEqual({ scene: 'chase', changed: true });
      expect(on().spider.colour).toEqual({ scene: 'rainbow', changed: false });

      change('spider', { colour: { palette: 'white' } });
      expect(on().spider.colour).toEqual({ scene: 'rainbow', changed: true });

      change('spider', { levels: { tilt1: 0.2 } });
      expect(on().spider.motion).toEqual({ scene: 'low', changed: false });
    });

    it('is told by the speed of the palette too: it is changed when it is set or cleared', () => {
      rig.playback.setPalette('spider', 'rainbow');
      change('spider', { colour: { speed: 2 } });
      expect(on().spider.colour).toEqual({ scene: 'rainbow', changed: true });
      change('spider', { colour: { speed: null } });
      expect(on().spider.colour).toEqual({ scene: 'rainbow', changed: false });
    });

    it('stores over a scene of its own type only', () => {
      rig.playback.recall('spider', 'low');
      change('spider', { levels: { tilt1: 0.25, dimmer: 0.9 } });
      rig.playback.storeOver('spider', 'low');
      expect(group('spider')?.scenes.find((scene) => scene.id === 'low')?.type).toBe('motion');
      expect(on().spider.motion).toEqual({ scene: 'low', changed: false });
      // The brightness was changed too, and a scene of motion does not keep that.
      change('spider', { levels: { tilt1: 0 } });
      rig.playback.recall('spider', 'low');
      expect(state('spider')).toMatchObject({ levels: { tilt1: 0.25, dimmer: 0.9 } });
    });

    it('does not let a scene of another type of a group that is set as a whole go', () => {
      change('laser', { raw: { mode: MANUAL, rotation: 20 } });
      rig.playback.store('all', 'motion', 'Everywhere');
      rig.playback.recall('spider', 'chase');
      rig.playback.recall('spider', 'low');

      // The scene of motion in "All" sets every fixture of "Spider": the one of "Spider" is off.
      rig.playback.recall('all', 'everywhere');
      expect(on().spider.motion).toEqual(NONE);
      expect(on().all.motion).toEqual({ scene: 'everywhere', changed: false });
      // Its lights scene is another type, and was not touched.
      expect(on().spider.lights).toEqual({ scene: 'chase', changed: false });
      expect(on().all.lights).toEqual(NONE);
    });
  });

  it('darkens a fixture of the group that the scene does not name', () => {
    change('spider', { levels: { dimmer: 1 } });
    rig.playback.store('all', 'lights', 'Spider only');
    expect(group('all')?.scenes[0]?.fixtures).toEqual(['spider']);

    change('laser', { raw: { mode: MANUAL, drawing: 191 }, motion: { id: 'pulse' } });
    rig.playback.recall('all', 'spider-only');
    expect(ch(output, LASER_AT)).toBe(0);
    // The lights are dark, and the motion effect is another type: it stays.
    expect(state('laser')).toEqual({
      raw: expect.objectContaining({ mode: 0, drawing: 0 }),
      effect: { id: null, speed: 1 },
      motion: { id: 'pulse', speed: 1 },
      colours: [],
    });
  });

  it('puts a fixture it does not name to rest for its type only', () => {
    change('spider', { levels: { tilt1: 1 } });
    rig.playback.store('all', 'motion', 'Spider only');
    expect(group('all')?.scenes[0]?.fixtures).toEqual(['spider']);

    change('laser', { raw: { mode: MANUAL, colour: 80, rotation: 20 } });
    rig.playback.recall('all', 'spider-only');
    // The rotation of the laser is at rest, and its mode and its colour are what they were.
    expect(state('laser')).toMatchObject({ raw: { mode: MANUAL, colour: 80, rotation: 0 } });
    expect(ch(output, LASER_AT)).toBe(MANUAL);
  });

  it('leaves a fixture outside the group alone, whatever the type', () => {
    change('spider', { levels: { tilt1: 1 } });
    rig.playback.store('spider', 'motion', 'Lean');
    change('laser', { raw: { mode: MANUAL, colour: 10, rotation: 20 } });
    rig.playback.recall('spider', 'lean');
    rig.playback.setPalette('spider', 'rainbow');
    expect(state('laser')).toMatchObject({ raw: { mode: MANUAL, colour: 10, rotation: 20 } });
  });

  it('is what off is: only the lights, with the colour and the motion left as they are', () => {
    change('spider', {
      levels: { dimmer: 1, red1: 1, tilt1: 0.4 },
      effect: { id: 'chase' },
      motion: { id: 'tiltwave' },
    });
    change('laser', { raw: { mode: MANUAL } });
    rig.playback.store('spider', 'lights', 'Warm');
    rig.playback.setPalette('spider', 'rainbow');
    rig.playback.store('laser', 'lights', 'Open');
    const told = vi.fn();
    rig.on('playback', told);

    rig.playback.off('spider', 'tablet-1');
    expect(ch(output, 6)).toBe(0);
    expect(state('spider')).toMatchObject({
      levels: { dimmer: 0, red1: 1, tilt1: 0.4 },
      effect: { id: null },
      motion: { id: 'tiltwave' },
      colour: { palette: 'rainbow' },
    });
    expect(ch(output, LASER_AT)).toBe(MANUAL);
    expect(told).toHaveBeenCalledTimes(1);
    expect(told).toHaveBeenLastCalledWith({
      groups: {
        spider: {
          lights: NONE,
          colour: { scene: 'rainbow', changed: false },
          motion: NONE,
          look: NO_LOOK,
        },
        laser: lights('open'),
        all: NOTHING,
      },
    });

    rig.playback.off('all');
    expect(ch(output, LASER_AT)).toBe(0);
    expect(on().laser.lights).toEqual(NONE);
    expect(on().spider.colour).toEqual({ scene: 'rainbow', changed: false });
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
    change('laser', { raw: { mode: MANUAL, drawing: 191 }, motion: { id: 'pulse' } });
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
    change('laser', { raw: { mode: MANUAL, drawing: 191 }, motion: { id: 'pulse' } });
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
    expect(rig.playback.store('spider', 'motion', 'Peak')).toBe('peak-3');
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
        new PatchError('a scene needs a type: lights or motion'),
      );
    }
    expect(existsSync(path)).toBe(false);
    expect(group('spider')?.scenes).toEqual([]);
  });

  it('says that colours are palettes when a scene of colour is asked for', () => {
    expect(() => rig.playback.store('spider', 'colour', 'Warm')).toThrow(
      new PatchError('colours are palettes now, and not scenes: a scene is lights or motion'),
    );
    expect(existsSync(path)).toBe(false);
  });

  describe('groups', () => {
    it('makes a group of fixtures, without scenes and with nothing on', () => {
      const show = vi.fn();
      const playback = vi.fn();
      rig.on('show', show);
      rig.on('playback', playback);
      expect(rig.playback.addGroup(' Front  bar ', ['laser', 'spider'])).toBe('front-bar');
      expect(group('front-bar')).toEqual(GROUP('front-bar', 'Front bar', ['laser', 'spider']));
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
      expect(group('spider')).toEqual(
        GROUP(
          'spider',
          'Truss',
          ['spider'],
          [{ id: 'warm', label: 'Warm', type: 'lights', fixtures: [] }],
        ),
      );
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
    rig.playback.store('laser', 'motion', 'Warm');
    expect(told).toHaveBeenCalledTimes(1);
    expect(told).toHaveBeenLastCalledWith({
      file: path,
      problem: null,
      limits: {},
      palettes: STARTING_PALETTES,
      groups: [
        GROUP('spider', 'Spider', ['spider']),
        GROUP(
          'laser',
          'Laser',
          ['laser'],
          [{ id: 'warm', label: 'Warm', type: 'motion', fixtures: [] }],
        ),
        GROUP('all', 'All', ['spider', 'laser']),
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
        limits: {},
        palettes: STARTING_PALETTES,
        groups: [
          GROUP('spider', 'Spider', ['spider']),
          GROUP('laser', 'Laser', ['laser']),
          GROUP(
            'all',
            'All',
            ['spider', 'laser'],
            [{ id: 'warm', label: 'Warm', type: 'lights', fixtures: ['spider', 'laser'] }],
          ),
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
      expect(text).toMatch(/^# The show of the evening\.\npalettes:\n/);
      expect(text).toContain('\ngroups:\n');
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
        /Scene "warm": a scene needs a type: lights or motion/,
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
              '        type: motion',
            ),
        );
        expect(rig.playback.addGroup('Front', ['spider'])).toBe('front-2');
        expect(group('front')).toEqual(
          GROUP(
            'front',
            'Front by hand',
            ['laser'],
            [{ id: 'keep', label: 'Keep', type: 'motion', fixtures: [] }],
          ),
        );
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
      expect(group('2024')).toEqual(
        GROUP(
          '2024',
          'Next year',
          ['laser'],
          [{ id: 'open', label: 'Open', type: 'lights', fixtures: ['laser'] }],
        ),
      );
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
      'groups:\n  spider:\n    fixtures: [spider]\n    scenes:\n      odd:\n        type: motion\n        fixtures:\n          spider:\n            levels: { dimmer: 1 }\n',
    );
    start();
    expect(rig.playback.getShow().problem).toMatch(
      /Scene "odd" of group "spider": "dimmer" is not part of a motion scene/,
    );
  });

  it('does not read a scene of colour: colours are palettes now', () => {
    rig.close();
    writeFileSync(
      path,
      'groups:\n  spider:\n    fixtures: [spider]\n    scenes:\n      amber:\n        type: colour\n        fixtures:\n          spider:\n            effect: { colourA: { red: 1, green: 0.5, blue: 0, white: 0 } }\n',
    );
    start();
    expect(rig.playback.getShow().problem).toMatch(
      /Scene "amber" of group "spider": colours are palettes now/,
    );
  });

  describe('palettes', () => {
    const palette = (id: string) => rig.playback.getShow().palettes.find((each) => each.id === id);

    it('starts with a white and a rainbow, and writes them to the file with the first change', () => {
      expect(rig.playback.getShow().palettes).toEqual(STARTING_PALETTES);
      expect(existsSync(path)).toBe(false);
      expect(rig.palettes.list().map((each) => each.id)).toEqual(['white', 'rainbow']);

      rig.playback.store('spider', 'lights', 'Warm');
      const text = readFileSync(path, 'utf8');
      expect(text).toMatch(
        /^palettes:\n {2}white:\n {4}label: White\n {4}colours: \[ "#000000ff" \]\n/,
      );
      expect(parse(text).palettes.rainbow).toEqual({
        label: 'Rainbow',
        colours: ['#ff0000', '#ffaa00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff'],
        mode: 'cycle',
        change: 'fade',
        speed: 0.25,
      });
      rig.close();
      start();
      expect(rig.playback.getShow().palettes).toEqual(STARTING_PALETTES);
    });

    it('sets a palette on the fixtures of the group that take palettes, and leaves the laser alone', () => {
      change('laser', { raw: { mode: MANUAL, colour: 100 } });
      const laser = state('laser');
      const told = vi.fn();
      rig.on('playback', told);
      rig.playback.setPalette('all', 'rainbow');
      expect(state('spider')).toMatchObject({ colour: { palette: 'rainbow', speed: null } });
      expect(state('laser')).toEqual(laser);
      expect(on().all.colour).toEqual({ scene: 'rainbow', changed: false });
      expect(told).toHaveBeenCalledTimes(1);
    });

    it('says which groups have a colour lane: the ones with a fixture that takes palettes', () => {
      expect(rig.playback.getShow().groups.map((each) => [each.id, each.palettes])).toEqual([
        ['spider', true],
        ['laser', false],
        ['all', true],
      ]);
    });

    it('refuses a palette for a group without a fixture that takes palettes, and changes nothing', () => {
      const frames = output.frames.length;
      expect(() => rig.playback.setPalette('laser', 'rainbow')).toThrow(
        new PatchError('no fixture of "Laser" is coloured by palettes'),
      );
      expect(output.frames).toHaveLength(frames);
      expect(on().laser).toEqual(NOTHING);
    });

    it('refuses a palette that is not in the show, and a speed that is not one', () => {
      const refused: [() => void, string][] = [
        [() => rig.playback.setPalette('spider', 'nope'), 'there is no palette called "nope"'],
        [() => rig.playback.setPalette('spider', undefined), 'say which palette, by its id'],
        [() => rig.playback.setPalette('strobe', 'white'), 'there is no group called "strobe"'],
        [
          () => rig.playback.setPalette('spider', 'rainbow', 3),
          'the speed of a palette must be one of 0.25, 0.5, 1, 2, 4',
        ],
      ];
      for (const [act, message] of refused) expect(act).toThrow(new PatchError(message));
      expect(state('spider')).toMatchObject({ colour: { palette: null } });
      expect(on().spider.colour).toEqual(NONE);
    });

    it('sets the speed for this use, and takes it back with the next press', () => {
      rig.playback.setPalette('spider', 'rainbow', 2);
      expect(state('spider')).toMatchObject({ colour: { palette: 'rainbow', speed: 2 } });
      expect(on().spider.colour).toEqual({ scene: 'rainbow', changed: false });
      rig.playback.setPalette('spider', 'rainbow');
      expect(state('spider')).toMatchObject({ colour: { palette: 'rainbow', speed: null } });
    });

    it('takes the palette of a group off when another group sets all its fixtures', () => {
      rig.playback.setPalette('spider', 'white');
      rig.playback.setPalette('all', 'rainbow');
      expect(on().spider.colour).toEqual(NONE);
      expect(on().all.colour).toEqual({ scene: 'rainbow', changed: false });

      // The laser takes no palette, so "Spider" sets everything "All" has a palette for.
      rig.playback.setPalette('spider', 'white');
      expect(on().all.colour).toEqual(NONE);
      expect(on().spider.colour).toEqual({ scene: 'white', changed: false });
    });

    it('keeps the palette of a group on, as changed, when only some of its fixtures are set', () => {
      rig.close();
      start([
        { id: 'spider', kind: 'spider', label: 'Spider', universe: 0, address: 1 },
        { id: 'spider-2', kind: 'spider', label: 'Spider 2', universe: 0, address: 100 },
      ]);
      rig.playback.setPalette('all', 'rainbow');
      rig.playback.setPalette('spider', 'white');
      expect(on().all.colour).toEqual({ scene: 'rainbow', changed: true });
      expect(on().spider.colour).toEqual({ scene: 'white', changed: false });
    });

    it('does not take a palette off a group of the laser alone', () => {
      rig.playback.setPalette('all', 'rainbow');
      expect(on().laser).toEqual(NOTHING);
    });

    it('makes one with an id from its name, white when it has no colours given', () => {
      expect(rig.playback.addPalette(' Warm  glow ')).toBe('warm-glow');
      expect(palette('warm-glow')).toEqual({
        id: 'warm-glow',
        label: 'Warm glow',
        colours: ['#000000ff'],
        mode: 'static',
        change: 'step',
        speed: 0.25,
      });
      expect(rig.playback.addPalette('White', { colours: ['#ff0000', 'off'] })).toBe('white-2');
      expect(palette('white-2')?.colours).toEqual(['#ff0000', 'off']);
      expect(rig.palettes.get('white-2')?.colours).toHaveLength(2);
      expect(readFileSync(path, 'utf8')).toContain('white-2:');
    });

    it('refuses a palette that cannot be one, and writes nothing', () => {
      const refused: [unknown, unknown, RegExp][] = [
        ['', undefined, /a palette needs a name/],
        ['Empty', { colours: [] }, /at least one/],
        ['Long', { colours: Array.from({ length: 9 }, () => '#ffffff') }, /8 colours at most/],
        ['Odd', { colours: ['blue'] }, /not a colour/],
        ['Spin', { colours: ['#ffffff'], mode: 'spin' }, /static or cycle/],
        ['Pace', { colours: ['#ffffff'], speed: 3 }, /one of/],
        ['Extra', { colours: ['#ffffff'], tint: 1 }, /cannot have "tint"/],
      ];
      for (const [name, fields, message] of refused) {
        expect(() => rig.playback.addPalette(name, fields)).toThrow(message);
      }
      expect(existsSync(path)).toBe(false);
      expect(rig.playback.getShow().palettes).toEqual(STARTING_PALETTES);
    });

    it('changes the parts of a palette that are named and keeps the rest', () => {
      rig.playback.updatePalette('rainbow', { colours: ['#ff0000', 'off', '#0000ff'], speed: 1 });
      expect(palette('rainbow')).toEqual({
        id: 'rainbow',
        label: 'Rainbow',
        colours: ['#ff0000', 'off', '#0000ff'],
        mode: 'cycle',
        change: 'fade',
        speed: 1,
      });
      rig.playback.updatePalette('rainbow', { label: ' Sunset ', mode: 'static' });
      expect(palette('rainbow')).toMatchObject({
        label: 'Sunset',
        mode: 'static',
        colours: ['#ff0000', 'off', '#0000ff'],
      });
      const written = parse(readFileSync(path, 'utf8')).palettes.rainbow;
      expect(written).toEqual({
        label: 'Sunset',
        colours: ['#ff0000', 'off', '#0000ff'],
        mode: 'static',
        change: 'fade',
        speed: 1,
      });
    });

    it('has the fixtures use an edited palette at once, and keeps it on', () => {
      rig.playback.setPalette('spider', 'white');
      const told = vi.fn();
      rig.on('playback', told);
      rig.playback.updatePalette('white', { colours: ['#00ff00'] });
      expect(rig.palettes.get('white')?.colours).toEqual([{ red: 0, green: 1, blue: 0, white: 0 }]);
      expect(on().spider.colour).toEqual({ scene: 'white', changed: false });
      expect(told).not.toHaveBeenCalled();
    });

    it('refuses a change that makes no sense, and changes nothing', () => {
      const refused: [() => void, RegExp][] = [
        [() => rig.playback.updatePalette('nope', { label: 'Nope' }), /no palette called "nope"/],
        [() => rig.playback.updatePalette('white', { colours: [] }), /at least one/],
        [() => rig.playback.updatePalette('white', { tint: 1 }), /cannot change "tint"/],
        [() => rig.playback.updatePalette('white', 'blue'), /must be an object/],
        [() => rig.playback.updatePalette('white', { label: '' }), /needs a name/],
      ];
      for (const [act, message] of refused) expect(act).toThrow(message);
      expect(palette('white')).toEqual(STARTING_PALETTES[0]);
    });

    it('takes a palette away', () => {
      rig.playback.removePalette('rainbow');
      expect(rig.playback.getShow().palettes.map((each) => each.id)).toEqual(['white']);
      expect(rig.palettes.get('rainbow')).toBeUndefined();
      expect(readFileSync(path, 'utf8')).not.toContain('rainbow');
      expect(() => rig.playback.removePalette('rainbow')).toThrow(/no palette called/);
    });

    it('does not take a palette away that is on in a group, and says where', () => {
      rig.playback.setPalette('spider', 'rainbow');
      expect(() => rig.playback.removePalette('rainbow')).toThrow(
        new PatchError('the palette "Rainbow" is in use: it is on in "Spider"'),
      );
      expect(palette('rainbow')).toBeDefined();
      // Once another palette is on, it can go.
      rig.playback.setPalette('spider', 'white');
      rig.playback.removePalette('rainbow');
      expect(palette('rainbow')).toBeUndefined();
    });

    it('has no palette on in a group when the file loses it', async () => {
      rig.playback.addPalette('Extra', { colours: ['#ff0000'] });
      rig.playback.setPalette('spider', 'extra');
      expect(on().spider.colour).toEqual({ scene: 'extra', changed: false });
      const text = readFileSync(path, 'utf8');
      writeFileSync(path, text.replace(/ {2}extra:\n(?: {4}.*\n)+/, ''));
      await vi.waitFor(() => expect(palette('extra')).toBeUndefined(), { timeout: 2000 });
      expect(on().spider.colour).toEqual(NONE);
      // The fixture still holds the id and shows white until another is set.
      expect(state('spider')).toMatchObject({ colour: { palette: 'extra' } });
    });

    it('does not use a file with a palette that cannot be read', () => {
      rig.close();
      writeFileSync(path, 'palettes:\n  odd:\n    colours: [blue]\n');
      start();
      expect(rig.playback.getShow().problem).toMatch(/Palette "odd": "blue" is not a colour/);
      expect(rig.playback.getShow().palettes).toEqual(STARTING_PALETTES);
      expect(() => rig.playback.addPalette('New')).toThrow(/has a mistake/);
    });

    it('reads palettes written by hand, in the order of the file, with the defaults filled in', () => {
      rig.close();
      writeFileSync(
        path,
        "palettes:\n  2:\n    colours: ['#ff0000']\n  dusk:\n    label: Dusk\n    colours: ['#ff4a00', off, '#ffb000ff']\n    mode: cycle\n    change: fade\n    speed: 1\n",
      );
      start();
      expect(rig.playback.getShow().problem).toBeNull();
      expect(rig.playback.getShow().palettes).toEqual([
        { id: '2', label: '2', colours: ['#ff0000'], mode: 'static', change: 'step', speed: 0.25 },
        {
          id: 'dusk',
          label: 'Dusk',
          colours: ['#ff4a00', 'off', '#ffb000ff'],
          mode: 'cycle',
          change: 'fade',
          speed: 1,
        },
      ]);
    });

    it('starts with no palette at all when the file says so', () => {
      rig.close();
      writeFileSync(path, 'palettes: {}\n');
      start();
      expect(rig.playback.getShow().palettes).toEqual([]);
      expect(() => rig.playback.setPalette('spider', 'white')).toThrow(/no palette called/);
    });

    it('tells about the show when a palette changes', () => {
      const told = vi.fn();
      rig.on('show', told);
      rig.playback.addPalette('Warm');
      rig.playback.updatePalette('warm', { speed: 1 });
      rig.playback.removePalette('warm');
      expect(told).toHaveBeenCalledTimes(3);
    });
  });

  describe('looks', () => {
    const look = (group: string, id: string) =>
      rig.playback
        .getShow()
        .groups.find((each) => each.id === group)
        ?.looks.find((l) => l.id === id);

    beforeEach(() => {
      change('spider', { levels: { dimmer: 1, tilt1: 0.2 }, effect: { id: 'chase' } });
      rig.playback.store('spider', 'lights', 'Chase');
      rig.playback.store('spider', 'motion', 'Low');
      change('spider', { levels: { dimmer: 0.5, tilt1: 0.9 }, effect: { id: 'kick' } });
      rig.playback.store('spider', 'lights', 'Kick');
      rig.playback.store('spider', 'motion', 'High');
      // Stored scenes are on; start again from the file, with the fixtures at rest.
      rig.close();
      start();
    });

    /** Puts a scene of each lane on, so that a look can be stored from it. */
    const setUp = () => {
      rig.playback.recall('spider', 'chase');
      rig.playback.setPalette('spider', 'rainbow');
      rig.playback.recall('spider', 'low');
    };

    it('stores what is on in the group, by reference, and has it on', () => {
      setUp();
      expect(rig.playback.storeLook('spider', ' Drop ')).toBe('drop');
      expect(look('spider', 'drop')).toEqual({
        id: 'drop',
        label: 'Drop',
        lights: 'chase',
        colour: { palette: 'rainbow', speed: null },
        motion: 'low',
      });
      expect(on().spider.look).toEqual({ look: 'drop', changed: false });
      const written = parse(readFileSync(path, 'utf8')).groups.spider.looks;
      expect(written).toEqual({
        drop: { label: 'Drop', lights: 'chase', colour: { palette: 'rainbow' }, motion: 'low' },
      });
    });

    it('leaves out a lane with nothing on, and stores the speed of the palette that was set', () => {
      rig.playback.setPalette('spider', 'rainbow', 4);
      rig.playback.storeLook('spider', 'Just colour');
      expect(look('spider', 'just-colour')).toEqual({
        id: 'just-colour',
        label: 'Just colour',
        lights: null,
        colour: { palette: 'rainbow', speed: 4 },
        motion: null,
      });
      expect(parse(readFileSync(path, 'utf8')).groups.spider.looks['just-colour']).toEqual({
        label: 'Just colour',
        colour: { palette: 'rainbow', speed: 4 },
      });
    });

    it('does not store a look when nothing is on, or when a lane was changed by hand', () => {
      expect(() => rig.playback.storeLook('spider', 'Nothing')).toThrow(
        new PatchError('nothing is on in "Spider", so there is nothing to store as a look'),
      );
      setUp();
      change('spider', { levels: { tilt1: 0.7 } });
      expect(() => rig.playback.storeLook('spider', 'Changed')).toThrow(
        /the motion of "Spider" were changed by hand/,
      );
      expect(rig.playback.getShow().groups.find((g) => g.id === 'spider')?.looks).toEqual([]);
    });

    it('sets the lanes it names together, as the presses would, and tells once', () => {
      setUp();
      rig.playback.storeLook('spider', 'Drop');
      rig.playback.recall('spider', 'kick');
      rig.playback.setPalette('spider', 'white');
      rig.playback.recall('spider', 'high');
      expect(on().spider.look).toEqual({ look: 'drop', changed: true });

      const told = vi.fn();
      rig.on('playback', told);
      rig.playback.playLook('spider', 'drop', 'tablet-1');
      expect(state('spider')).toMatchObject({
        levels: { dimmer: 1, tilt1: 0.2 },
        effect: { id: 'chase' },
        colour: { palette: 'rainbow', speed: null },
      });
      expect(on().spider).toEqual({
        lights: { scene: 'chase', changed: false },
        colour: { scene: 'rainbow', changed: false },
        motion: { scene: 'low', changed: false },
        look: { look: 'drop', changed: false },
      });
      expect(told).toHaveBeenCalledTimes(1);
    });

    it('leaves a lane alone that it does not name', () => {
      setUp();
      rig.close();
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace(
          '    scenes:',
          '    looks:\n      tint:\n        label: Tint\n        colour: white\n    scenes:',
        ),
      );
      rig = new Rig({ output, fixtures: FIXTURES, show: path });
      rig.playback.recall('spider', 'chase');
      rig.playback.setPalette('spider', 'rainbow');
      rig.playback.recall('spider', 'low');
      rig.playback.playLook('spider', 'tint');
      expect(state('spider')).toMatchObject({
        levels: { dimmer: 1, tilt1: 0.2 },
        effect: { id: 'chase' },
        colour: { palette: 'white' },
      });
      expect(on().spider.lights).toEqual({ scene: 'chase', changed: false });
      expect(on().spider.motion).toEqual({ scene: 'low', changed: false });
      expect(on().spider.look).toEqual({ look: 'tint', changed: false });
    });

    it('sets the pace it names for the palette, and is changed when the palette is pressed without it', () => {
      setUp();
      rig.playback.setPalette('spider', 'rainbow', 4);
      rig.playback.storeLook('spider', 'Quick');
      rig.playback.setPalette('spider', 'white');
      rig.playback.playLook('spider', 'quick');
      expect(state('spider')).toMatchObject({ colour: { palette: 'rainbow', speed: 4 } });
      expect(on().spider.look).toEqual({ look: 'quick', changed: false });

      rig.playback.setPalette('spider', 'rainbow');
      expect(state('spider')).toMatchObject({ colour: { palette: 'rainbow', speed: null } });
      expect(on().spider.look).toEqual({ look: 'quick', changed: true });
      rig.playback.setPalette('spider', 'rainbow', 4);
      expect(on().spider.look).toEqual({ look: 'quick', changed: false });
    });

    it('is shown as changed when a lane it set is pressed again, and not when it is put back', () => {
      setUp();
      rig.playback.storeLook('spider', 'Drop');
      rig.playback.recall('spider', 'kick');
      expect(on().spider.look).toEqual({ look: 'drop', changed: true });
      rig.playback.recall('spider', 'chase');
      expect(on().spider.look).toEqual({ look: 'drop', changed: false });
      change('spider', { levels: { dimmer: 0.4 } });
      expect(on().spider.look).toEqual({ look: 'drop', changed: true });
      rig.playback.off('spider');
      expect(on().spider.look).toEqual({ look: 'drop', changed: true });
    });

    it('is not changed by a lane it does not name', () => {
      rig.playback.setPalette('spider', 'rainbow');
      rig.playback.storeLook('spider', 'Colour only');
      rig.playback.recall('spider', 'chase');
      rig.playback.recall('spider', 'high');
      expect(on().spider.look).toEqual({ look: 'colour-only', changed: false });
    });

    it('is replaced by another look, and forgotten when a look is not what the group does any more', () => {
      setUp();
      rig.playback.storeLook('spider', 'Drop');
      rig.playback.recall('spider', 'kick');
      rig.playback.storeLook('spider', 'Hit');
      expect(on().spider.look).toEqual({ look: 'hit', changed: false });
      rig.playback.playLook('spider', 'drop');
      expect(on().spider.look).toEqual({ look: 'drop', changed: false });
    });

    it('changes no fixture when one of them cannot take its part', () => {
      change('spider', { levels: { dimmer: 1 } });
      change('laser', { raw: { mode: MANUAL } });
      rig.playback.store('all', 'lights', 'Everything');
      rig.playback.store('all', 'motion', 'Lean');
      rig.playback.off('all');
      rig.playback.recall('all', 'everything');
      rig.playback.recall('all', 'lean');
      rig.playback.storeLook('all', 'Whole');
      rig.playback.off('all');
      const laser = rig.find('laser')?.controller;
      if (!laser) throw new Error('no laser');
      const check = vi.spyOn(laser, 'check').mockImplementation((type) => {
        if (type === 'motion') throw new PatchError('the laser cannot move');
      });
      const frames = output.frames.length;
      expect(() => rig.playback.playLook('all', 'whole')).toThrow('the laser cannot move');
      expect(output.frames).toHaveLength(frames);
      expect(state('spider')).toMatchObject({ levels: { dimmer: 0 } });
      expect(on().all.look).toEqual({ look: 'whole', changed: true });
      check.mockRestore();
      rig.playback.playLook('all', 'whole');
      expect(ch(output, 6)).toBe(255);
    });

    it('sets the palette on the fixtures that take palettes in a group of several', () => {
      change('laser', { raw: { mode: MANUAL } });
      rig.playback.store('all', 'lights', 'Open');
      rig.playback.recall('all', 'open');
      rig.playback.setPalette('all', 'rainbow');
      rig.playback.storeLook('all', 'Open rainbow');
      rig.playback.off('all');
      rig.playback.setPalette('all', 'white');
      rig.playback.playLook('all', 'open-rainbow');
      expect(state('spider')).toMatchObject({ colour: { palette: 'rainbow' } });
      expect(ch(output, LASER_AT)).toBe(MANUAL);
    });

    it('stores over a look that is there, renames it and takes it away', () => {
      setUp();
      rig.playback.storeLook('spider', 'Drop');
      rig.playback.recall('spider', 'kick');
      rig.playback.storeLookOver('spider', 'drop');
      expect(look('spider', 'drop')).toMatchObject({ label: 'Drop', lights: 'kick' });
      expect(on().spider.look).toEqual({ look: 'drop', changed: false });

      rig.playback.renameLook('spider', 'drop', ' Big drop ');
      expect(look('spider', 'drop')?.label).toBe('Big drop');
      rig.playback.removeLook('spider', 'drop');
      expect(look('spider', 'drop')).toBeUndefined();
      expect(on().spider.look).toEqual(NO_LOOK);
      expect(() => rig.playback.playLook('spider', 'drop')).toThrow(
        new PatchError('there is no look called "drop" in the group "spider"'),
      );
    });

    it('does not take a scene away that a look uses, nor a palette', () => {
      setUp();
      rig.playback.storeLook('spider', 'Drop');
      expect(() => rig.playback.remove('spider', 'chase')).toThrow(
        new PatchError(
          'the scene "Chase" is used by the look "Drop". Change or delete the look first',
        ),
      );
      expect(() => rig.playback.remove('spider', 'low')).toThrow(/used by the look "Drop"/);
      rig.playback.setPalette('spider', 'white');
      expect(() => rig.playback.removePalette('rainbow')).toThrow(
        new PatchError('the palette "Rainbow" is in use: the look "Drop" of "Spider" uses it'),
      );
      rig.playback.remove('spider', 'kick');

      rig.playback.removeLook('spider', 'drop');
      rig.playback.remove('spider', 'chase');
      rig.playback.removePalette('rainbow');
      expect(group('spider')?.scenes.map((scene) => scene.id)).toEqual(['low', 'high']);
    });

    it('is taken away with its group', () => {
      setUp();
      rig.playback.storeLook('spider', 'Drop');
      rig.playback.removeGroup('spider');
      expect(readFileSync(path, 'utf8')).not.toContain('drop');
      expect(on().spider).toBeUndefined();
    });

    it('has its looks after a restart, with nothing on', () => {
      setUp();
      rig.playback.storeLook('spider', 'Drop');
      rig.close();
      start();
      expect(look('spider', 'drop')).toBeDefined();
      expect(on().spider).toEqual(NOTHING);
      rig.playback.playLook('spider', 'drop');
      expect(state('spider')).toMatchObject({
        effect: { id: 'chase' },
        colour: { palette: 'rainbow' },
      });
    });

    it('gives a look an id of its own within its group', () => {
      setUp();
      expect(rig.playback.storeLook('spider', 'Drop')).toBe('drop');
      expect(rig.playback.storeLook('spider', 'Drop')).toBe('drop-2');
      expect(() => rig.playback.storeLook('spider', ' ')).toThrow('a look needs a name');
    });

    it('refuses what is not there, and a look that names nothing', () => {
      const refused: [() => void, string][] = [
        [() => rig.playback.playLook('strobe', 'drop'), 'there is no group called "strobe"'],
        [() => rig.playback.playLook('spider', undefined), 'say which look, by its id'],
        [
          () => rig.playback.renameLook('spider', 'nope', 'X'),
          'there is no look called "nope" in the group "spider"',
        ],
        [
          () => rig.playback.removeLook('spider', 'nope'),
          'there is no look called "nope" in the group "spider"',
        ],
        [() => rig.playback.storeLook('strobe', 'X'), 'there is no group called "strobe"'],
      ];
      for (const [act, message] of refused) expect(act).toThrow(new PatchError(message));
    });

    describe('written by hand', () => {
      const WITH_LOOK = (extra: string) =>
        `groups:\n  spider:\n    fixtures: [spider]\n    scenes:\n      chase:\n        type: lights\n        fixtures:\n          spider: { levels: { dimmer: 1 }, effect: { id: chase } }\n      low:\n        type: motion\n        fixtures:\n          spider: { levels: { tilt1: 0.2 } }\n    looks:\n${extra}`;

      const problem = (extra: string) => {
        rig.close();
        writeFileSync(path, WITH_LOOK(extra));
        start();
        return rig.playback.getShow().problem;
      };

      it('reads a look with the palette as a plain id, or with a pace', () => {
        rig.close();
        writeFileSync(
          path,
          WITH_LOOK(
            '      a:\n        lights: chase\n        colour: rainbow\n      b:\n        label: B\n        colour: { palette: white, speed: 0.5 }\n        motion: low\n',
          ),
        );
        start();
        expect(rig.playback.getShow().problem).toBeNull();
        expect(group('spider')?.looks).toEqual([
          {
            id: 'a',
            label: 'a',
            lights: 'chase',
            colour: { palette: 'rainbow', speed: null },
            motion: null,
          },
          {
            id: 'b',
            label: 'B',
            lights: null,
            colour: { palette: 'white', speed: 0.5 },
            motion: 'low',
          },
        ]);
        rig.playback.playLook('spider', 'b');
        expect(state('spider')).toMatchObject({ colour: { palette: 'white', speed: 0.5 } });
        expect(readFileSync(path, 'utf8')).toContain('colour: rainbow');
      });

      it('does not use a look that names what is not there', () => {
        expect(problem('      a:\n        lights: nope\n')).toMatch(
          /Look "a" of group "spider": there is no scene called "nope" in this group/,
        );
        expect(problem('      a:\n        colour: nope\n')).toMatch(
          /there is no palette called "nope"/,
        );
        expect(problem('      a:\n        lights: low\n')).toMatch(
          /the scene "low" is motion, and not lights/,
        );
        expect(problem('      a:\n        motion: chase\n')).toMatch(
          /the scene "chase" is lights, and not motion/,
        );
      });

      it('does not use a look that sets nothing, or with a pace that is none', () => {
        expect(problem('      a:\n        label: Nothing\n')).toMatch(
          /a look sets a scene of lights, a palette or a scene of motion/,
        );
        expect(problem('      a:\n        colour: { palette: white, speed: 3 }\n')).toMatch(
          /the speed of a palette must be one of/,
        );
        expect(problem('      a:\n        colour: { palette: white, tint: 1 }\n')).toMatch(
          /"colour" cannot have "tint"/,
        );
        expect(problem('      a:\n        lights: chase\n        sound: loud\n')).toMatch(
          /cannot have "sound", only label, lights, colour and motion/,
        );
        expect(problem('      Big:\n        lights: chase\n')).toMatch(/an id has small letters/);
      });

      it('has a look that is on gone when the file loses it', async () => {
        rig.close();
        writeFileSync(path, WITH_LOOK('      a:\n        lights: chase\n'));
        start();
        rig.playback.playLook('spider', 'a');
        expect(on().spider.look).toEqual({ look: 'a', changed: false });
        writeFileSync(path, WITH_LOOK('      b:\n        lights: chase\n'));
        await vi.waitFor(() => expect(on().spider.look).toEqual(NO_LOOK), { timeout: 2000 });
      });
    });
  });
  describe('the limits of a fixture', () => {
    const LIMITS = { tilt: [{ min: 0.1, max: 0.6 }, { max: 0.5 }] };
    const spiderTilt = () => [ch(output, 1), ch(output, 3)];

    it('limits what the fixture sends, and keeps them in the show file', () => {
      change('spider', { levels: { tilt1: 1, tilt2: 1 } });
      expect(spiderTilt()).toEqual([255, 255]);
      rig.playback.setLimits('spider', LIMITS);
      expect(spiderTilt()).toEqual([153, 128]);
      expect(rig.playback.getShow().limits).toEqual({
        spider: {
          tilt: [
            { min: 0.1, max: 0.6 },
            { min: 0, max: 0.5 },
          ],
        },
      });
      const written = parse(readFileSync(path, 'utf8'));
      expect(written.limits.spider.tilt).toEqual([
        { min: 0.1, max: 0.6 },
        { min: 0, max: 0.5 },
      ]);
    });

    it('is as it was after a restart', () => {
      rig.playback.setLimits('spider', LIMITS);
      rig.close();
      start();
      change('spider', { levels: { tilt1: 1 } });
      expect(ch(output, 1)).toBe(153);
    });

    it('tells the pages, and takes the key out of the file when nothing is limited any more', () => {
      const told = vi.fn();
      rig.playback.setLimits('spider', LIMITS);
      rig.on('show', told);
      rig.playback.setLimits('spider', {});
      expect(told).toHaveBeenCalledTimes(1);
      expect(rig.playback.getShow().limits).toEqual({});
      expect(parse(readFileSync(path, 'utf8')).limits).toBeUndefined();
      change('spider', { levels: { tilt1: 1 } });
      expect(ch(output, 1)).toBe(255);
    });

    it('follows a change of the file by hand', async () => {
      rig.playback.setLimits('spider', LIMITS);
      change('spider', { levels: { tilt1: 1 } });
      writeFileSync(path, readFileSync(path, 'utf8').replace('max: 0.6', 'max: 0.3'));
      await vi.waitFor(() => expect(ch(output, 1)).toBe(76), { timeout: 2000 });
    });

    it('refuses limits that cannot be, and a fixture that cannot be limited', () => {
      expect(() => rig.playback.setLimits('spider', { tilt: [{ min: 0.8, max: 0.2 }] })).toThrow(
        PatchError,
      );
      expect(() => rig.playback.setLimits('laser', {})).toThrow(/cannot be limited/);
      expect(() => rig.playback.setLimits('lamp', {})).toThrow(/no fixture called "lamp"/);
      expect(() => rig.playback.setLimits(3, {})).toThrow(/say which fixture/);
      expect(rig.playback.getShow().limits).toEqual({});
    });

    it('does not use a file whose limits are wrong, and the show that runs stays', async () => {
      rig.playback.setLimits('spider', LIMITS);
      writeFileSync(path, readFileSync(path, 'utf8').replace('min: 0.1', 'min: 0.9'));
      await vi.waitFor(() => expect(rig.playback.getShow().problem).toMatch(/Limits of "spider"/), {
        timeout: 2000,
      });
      change('spider', { levels: { tilt1: 0 } });
      expect(ch(output, 1)).toBe(25);
    });
  });
});
