import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PatchError } from './fixture.js';
import { type FixtureDefinition, Rig } from './rig.js';
import { ch, RecordingOutput } from './testing.js';

const MANUAL = 95;
const LASER_AT = 44;
const FIXTURES: FixtureDefinition[] = [
  { id: 'spider', kind: 'spider', label: 'Spider', universe: 0, address: 1 },
  { id: 'laser', kind: 'laser', label: 'Laser', universe: 0, address: LASER_AT },
];

describe('Playback', () => {
  let dir: string;
  let path: string;
  let output: RecordingOutput;
  let rig: Rig;

  const start = () => {
    output = new RecordingOutput();
    rig = new Rig({ output, fixtures: FIXTURES, show: path });
    return rig;
  };
  const change = (id: string, patch: unknown) => rig.find(id)?.controller.update(patch);
  const state = (id: string) => rig.find(id)?.controller.getState();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lightdeck-playback-'));
    path = join(dir, 'show.yaml');
    start();
  });
  afterEach(() => {
    rig.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts with no scenes and none recalled', () => {
    expect(rig.playback.getShow()).toEqual({ file: path, problem: null, scenes: [] });
    expect(rig.playback.getState()).toEqual({ scene: null, changed: false });
  });

  it('stores the fixtures as they are, and brings them back with one recall', () => {
    change('spider', { levels: { dimmer: 1, red1: 0.5 }, effect: { id: 'chase' } });
    change('laser', { raw: { mode: MANUAL, drawing: 191 }, effect: { id: 'pulse' } });
    const before = [state('spider'), state('laser')];
    expect(rig.playback.store('Amber chase')).toBe('amber-chase');

    change('spider', { levels: { dimmer: 0.2, green3: 1 }, effect: { id: null } });
    change('laser', { raw: { mode: 0, drawing: 0 }, effect: { id: null } });
    rig.playback.recall('amber-chase');

    expect([state('spider'), state('laser')]).toEqual(before);
    expect(ch(output, 6)).toBe(255);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
  });

  it('has the scenes after a restart', () => {
    change('spider', { levels: { dimmer: 1 } });
    rig.playback.store('Warm');
    rig.close();
    start();
    expect(rig.playback.getShow().scenes).toEqual([
      { id: 'warm', label: 'Warm', fixtures: ['spider'] },
    ]);
    rig.playback.recall('warm');
    expect(ch(output, 6)).toBe(255);
  });

  it('leaves a fixture that is dark out of the scene, and darkens it on recall', () => {
    change('spider', { levels: { dimmer: 1 } });
    rig.playback.store('Spider only');
    expect(rig.playback.getShow().scenes[0]?.fixtures).toEqual(['spider']);

    change('laser', { raw: { mode: MANUAL, drawing: 191 }, effect: { id: 'pulse' } });
    rig.playback.recall('spider-only');
    expect(ch(output, LASER_AT)).toBe(0);
    expect(state('laser')).toEqual({
      raw: expect.objectContaining({ mode: 0, drawing: 0 }),
      effect: { id: null },
    });
  });

  it('opens the laser when the scene says so', () => {
    change('laser', { raw: { mode: MANUAL } });
    rig.playback.store('Laser on');
    change('laser', { raw: { mode: 0 } });
    expect(ch(output, LASER_AT)).toBe(0);
    rig.playback.recall('laser-on');
    expect(ch(output, LASER_AT)).toBe(MANUAL);
  });

  it('keeps the laser closed during a blackout, whatever is recalled', () => {
    change('laser', { raw: { mode: MANUAL } });
    rig.playback.store('Laser on');
    change('laser', { raw: { mode: 0 } });
    rig.setBlackout(true);
    rig.playback.recall('laser-on');
    expect(ch(output, LASER_AT)).toBe(0);
    rig.setBlackout(false);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
  });

  it('says which scene the fixtures are set to, and when they no longer are', () => {
    const told = vi.fn();
    rig.on('playback', told);
    change('spider', { levels: { dimmer: 1 } });
    rig.playback.store('Warm');
    expect(told).toHaveBeenLastCalledWith({ scene: 'warm', changed: false });

    change('spider', { levels: { dimmer: 0.5 } });
    expect(told).toHaveBeenLastCalledWith({ scene: 'warm', changed: true });
    change('spider', { levels: { dimmer: 0.4 } });
    expect(told).toHaveBeenCalledTimes(2);

    change('spider', { levels: { dimmer: 1 } });
    expect(told).toHaveBeenLastCalledWith({ scene: 'warm', changed: false });

    change('spider', { levels: { dimmer: 0.5 } });
    rig.playback.recall('warm');
    expect(told).toHaveBeenLastCalledWith({ scene: 'warm', changed: false });
    expect(told).toHaveBeenCalledTimes(5);
  });

  it('stores the fixtures as they are over a scene that is there', () => {
    change('spider', { levels: { dimmer: 1 } });
    rig.playback.store('Warm');
    change('spider', { levels: { dimmer: 0.5 } });
    rig.playback.storeOver('warm');
    expect(rig.playback.getState()).toEqual({ scene: 'warm', changed: false });

    change('spider', { levels: { dimmer: 0 } });
    rig.playback.recall('warm');
    expect(ch(output, 6)).toBe(128);
    expect(rig.playback.getShow().scenes).toHaveLength(1);
  });

  it('renames a scene and keeps its id', () => {
    rig.playback.store('Warm');
    rig.playback.rename('warm', ' Warm up ');
    expect(rig.playback.getShow().scenes).toEqual([{ id: 'warm', label: 'Warm up', fixtures: [] }]);
    expect(() => rig.playback.rename('warm', '')).toThrow(PatchError);
  });

  it('takes a scene away, and no scene is recalled when it was that one', () => {
    rig.playback.store('Warm');
    rig.playback.store('Cold');
    rig.playback.recall('warm');
    rig.playback.remove('warm');
    expect(rig.playback.getShow().scenes.map((scene) => scene.id)).toEqual(['cold']);
    expect(rig.playback.getState()).toEqual({ scene: null, changed: false });
    expect(readFileSync(path, 'utf8')).not.toContain('warm');
  });

  it('gives two scenes of the same name their own id', () => {
    expect(rig.playback.store('Peak')).toBe('peak');
    expect(rig.playback.store('Peak')).toBe('peak-2');
  });

  it('refuses a scene that is not there', () => {
    for (const act of [
      () => rig.playback.recall('nothing'),
      () => rig.playback.recall(undefined),
      () => rig.playback.storeOver('nothing'),
      () => rig.playback.rename('nothing', 'Name'),
      () => rig.playback.remove('nothing'),
    ]) {
      expect(act).toThrow(PatchError);
    }
  });

  it('tells about the show when it changes', () => {
    const told = vi.fn();
    rig.on('show', told);
    rig.playback.store('Warm');
    expect(told).toHaveBeenLastCalledWith({
      file: path,
      problem: null,
      scenes: [{ id: 'warm', label: 'Warm', fixtures: [] }],
    });
  });

  it('reads scenes written by hand, and sets what they do not name to rest', () => {
    rig.close();
    writeFileSync(
      path,
      'scenes:\n  hand:\n    label: By hand\n    fixtures:\n      spider:\n        levels: { dimmer: 0.5 }\n',
    );
    start();
    change('spider', { levels: { red1: 1, strobe: 1 }, effect: { id: 'kick' } });
    rig.playback.recall('hand');
    expect(state('spider')).toMatchObject({
      levels: { dimmer: 0.5, red1: 0, strobe: 0 },
      effect: { id: null },
    });
  });

  it('does not use a file that names what a fixture cannot do', () => {
    rig.close();
    writeFileSync(
      path,
      'scenes:\n  bad:\n    fixtures:\n      laser:\n        raw: { mode: 300 }\n',
    );
    start();
    expect(rig.playback.getShow().scenes).toEqual([]);
    expect(rig.playback.getShow().problem).toMatch(/Scene "bad": "mode" must be a whole number/);
    expect(() => rig.playback.store('Warm')).toThrow(/has a mistake/);
  });
});
