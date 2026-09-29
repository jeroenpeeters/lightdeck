import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LASER_EFFECTS, LASER_EFFECTS_MODE, type LaserEffect } from '../engine/laserEffects.js';
import { ALIEN_LASER_10CH, LASER_GATE } from '../fixtures/laser.js';
import { PatchError } from './fixture.js';
import { LaserController, type LaserState } from './laserController.js';
import { Tempo } from './tempo.js';
import { ch, RecordingOutput } from './testing.js';

const MANUAL = 95;
const AUTO = 159;
const LASER_AT = 44;
const EFFECTS = { list: LASER_EFFECTS, mode: LASER_EFFECTS_MODE };
/** One beat at the tempo the console starts with. */
const BEAT_MS = 60_000 / 126;

describe('LaserController', () => {
  let output: RecordingOutput;
  let laser: LaserController;

  const at = (address: number, gate = LASER_GATE) =>
    new LaserController({
      profile: ALIEN_LASER_10CH,
      gate,
      output,
      tempo: new Tempo(),
      effects: EFFECTS,
      universe: 0,
      address,
    });

  beforeEach(() => {
    output = new RecordingOutput();
    laser = at(LASER_AT);
  });
  afterEach(() => laser.close());

  it('starts closed and says so to the fixture straight away', () => {
    expect(output.frames).toHaveLength(1);
    expect(output.frames[0]?.index).toBe(0);
    expect([...output.last].every((b) => b === 0)).toBe(true);
    expect(laser.getState()).toEqual({
      raw: {
        mode: 0,
        program: 0,
        rotation: 0,
        flipH: 0,
        flipV: 0,
        moveH: 0,
        moveV: 0,
        size: 0,
        colour: 0,
        drawing: 0,
      },
      effect: { id: null },
    });
  });

  it('turns a change into DMX at the start address and tells who made it', () => {
    const seen: { state: LaserState; origin: string | undefined }[] = [];
    laser.on('state', (state, origin) => seen.push({ state, origin }));
    laser.update({ raw: { mode: MANUAL, program: 57, rotation: 160 } }, 'tablet');
    expect(ch(output, LASER_AT)).toBe(MANUAL);
    expect(ch(output, LASER_AT + 1)).toBe(57);
    expect(ch(output, LASER_AT + 2)).toBe(160);
    expect(ch(output, LASER_AT - 1)).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.origin).toBe('tablet');
    expect(seen[0]?.state.raw.program).toBe(57);
  });

  it('keeps earlier values when only one thing changes', () => {
    laser.update({ raw: { mode: MANUAL, colour: 70 } });
    laser.update({ raw: { size: 200 } });
    expect(laser.getDmx()).toEqual([MANUAL, 0, 0, 0, 0, 0, 0, 200, 70, 0]);
  });

  it('applies nothing when part of a change is invalid', () => {
    const bad: unknown[] = [
      { raw: { mode: MANUAL, zoom: 1 } },
      { raw: { mode: 256 } },
      { raw: { mode: -1 } },
      { raw: { mode: 1.5 } },
      { raw: { mode: 'manual' } },
      { raw: { mode: null } },
      { raw: 'manual' },
      { raw: { mode: MANUAL }, blackout: false },
      { levels: { mode: 1 } },
      'manual',
      null,
    ];
    for (const patch of bad) expect(() => laser.update(patch)).toThrow(PatchError);
    expect(laser.getState().raw.mode).toBe(0);
    expect(output.frames).toHaveLength(1);
  });

  it('closes during a blackout and keeps what was set', () => {
    laser.update({ raw: { mode: MANUAL, program: 57, colour: 70 } });
    laser.setBlackout(true);
    expect(ch(output, LASER_AT)).toBe(0);
    expect(ch(output, LASER_AT + 1)).toBe(57);
    expect(laser.getState().raw.mode).toBe(MANUAL);
    expect(laser.getDmx()[0]).toBe(0);
  });

  it('stays closed when the mode changes during a blackout', () => {
    laser.setBlackout(true);
    laser.update({ raw: { mode: 223 } });
    expect(ch(output, LASER_AT)).toBe(0);
    laser.setBlackout(false);
    expect(ch(output, LASER_AT)).toBe(223);
  });

  it('sends and tells nothing when the blackout does not change', () => {
    const seen: unknown[] = [];
    laser.on('state', (state) => seen.push(state));
    laser.setBlackout(false);
    expect(output.frames).toHaveLength(1);
    laser.setBlackout(true);
    laser.setBlackout(true);
    expect(output.frames).toHaveLength(2);
    expect(seen).toHaveLength(1);
  });

  it('is closed while the master is at 0, and as it is set above 0', () => {
    laser.update({ raw: { mode: MANUAL, program: 57, size: 200, colour: 70 } });
    const set = [MANUAL, 57, 0, 0, 0, 0, 0, 200, 70, 0];

    laser.setMaster(0);
    expect(ch(output, LASER_AT)).toBe(0);
    expect(laser.getDmx()).toEqual([0, ...set.slice(1)]);
    expect(laser.getState().raw.mode).toBe(MANUAL);

    for (const master of [0.01, 0.5, 1]) {
      laser.setMaster(master);
      expect(laser.getDmx()).toEqual(set);
      expect([...output.last.slice(LASER_AT - 1, LASER_AT + 9)]).toEqual(set);
    }
  });

  it('stays closed when the mode changes while the master is at 0', () => {
    laser.setMaster(0);
    laser.update({ raw: { mode: 223 } });
    expect(ch(output, LASER_AT)).toBe(0);
    laser.update({ raw: { mode: MANUAL } });
    expect(ch(output, LASER_AT)).toBe(0);
    for (const { data } of output.frames) expect(data[LASER_AT - 1]).toBe(0);
    laser.setMaster(0.01);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
  });

  it('is not opened by the master: it stays closed when that is what is set', () => {
    laser.update({ raw: { program: 57 } });
    laser.setMaster(0);
    laser.setMaster(1);
    expect(ch(output, LASER_AT)).toBe(0);
    for (const { data } of output.frames) expect(data[LASER_AT - 1]).toBe(0);
  });

  it('keeps what is set whatever the master says', () => {
    laser.update({ raw: { mode: MANUAL, program: 57 }, effect: { id: 'pulse' } });
    const state = laser.getState();
    const kept = laser.snapshot();
    for (const master of [0.5, 0, 0.01, 1]) {
      laser.setMaster(master);
      expect(laser.getState()).toEqual(state);
      expect(laser.snapshot()).toEqual(kept);
    }
    expect(kept).toEqual({ raw: { mode: MANUAL, program: 57 }, effect: { id: 'pulse' } });
  });

  it('sends and tells nothing when the master does not change', () => {
    laser.update({ raw: { mode: MANUAL } });
    const seen: unknown[] = [];
    laser.on('state', (state, origin) => seen.push([state, origin, laser.getDmx()[0]]));
    laser.setMaster(1);
    expect(output.frames).toHaveLength(2);
    laser.setMaster(0);
    laser.setMaster(0);
    expect(output.frames).toHaveLength(3);
    expect(seen).toEqual([[laser.getState(), undefined, 0]]);
  });

  it('is closed by a master that is no number from 0 to 1, unless it is above 1', () => {
    laser.update({ raw: { mode: MANUAL } });
    for (const master of [Number.NaN, -1, Number.NEGATIVE_INFINITY]) {
      laser.setMaster(1);
      expect(ch(output, LASER_AT)).toBe(MANUAL);
      laser.setMaster(master);
      expect(ch(output, LASER_AT)).toBe(0);
    }
    laser.setMaster(7);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
  });

  it('is closed in a blackout whatever the master says, and by the master after it', () => {
    laser.update({ raw: { mode: MANUAL } });

    laser.setBlackout(true);
    laser.setMaster(0.5);
    expect(ch(output, LASER_AT)).toBe(0);
    laser.setBlackout(false);
    expect(ch(output, LASER_AT)).toBe(MANUAL);

    laser.setMaster(0);
    expect(ch(output, LASER_AT)).toBe(0);
    laser.setBlackout(true);
    laser.setMaster(1);
    expect(ch(output, LASER_AT)).toBe(0);
    laser.setMaster(0);
    laser.setBlackout(false);
    expect(ch(output, LASER_AT)).toBe(0);
    laser.setMaster(1);
    expect(ch(output, LASER_AT)).toBe(MANUAL);

    laser.setMaster(0);
    laser.setBlackout(true);
    laser.setBlackout(false);
    expect(ch(output, LASER_AT)).toBe(0);
  });

  it('closes for good when lightdeck stops', () => {
    laser.update({ raw: { mode: MANUAL, program: 57 } });
    laser.darken();
    expect(ch(output, LASER_AT)).toBe(0);
    expect(laser.getState().raw.mode).toBe(0);
    expect(laser.getState().raw.program).toBe(57);
  });

  it('is not opened by a change that comes after lightdeck stopped', () => {
    laser.update({ raw: { mode: MANUAL } });
    laser.darken();
    laser.close();
    // A request that was under way when lightdeck was told to stop is still handled.
    laser.update({ raw: { mode: MANUAL, program: 57 } }, 'tablet');
    expect(ch(output, LASER_AT)).toBe(0);
    expect(laser.getDmx()[0]).toBe(0);
    laser.update({ raw: { mode: AUTO } });
    expect(ch(output, LASER_AT)).toBe(0);
    for (const { data } of output.frames.slice(-2)) expect(data[LASER_AT - 1]).toBe(0);
  });

  it('is not opened by the master or the blackout after lightdeck stopped', () => {
    laser.setMaster(0);
    laser.setBlackout(true);
    laser.darken();
    laser.update({ raw: { mode: MANUAL } });
    laser.setMaster(1);
    laser.setBlackout(false);
    expect(ch(output, LASER_AT)).toBe(0);
  });

  it('can do nothing by name', () => {
    expect(() => laser.act('reset')).toThrow(PatchError);
  });

  it('tells the page which control opens it and which effects there are', () => {
    const details = laser.describe() as { gate: string; effects: unknown[]; effectsIn: string };
    expect(details.gate).toBe('mode');
    expect(details.effectsIn).toBe('manual');
    expect(details.effects).toHaveLength(5);
    expect(details.effects[0]).toEqual({
      id: 'patterns',
      name: 'Pattern chase',
      description: expect.any(String),
      drives: ['program'],
    });
  });

  it('refuses an address where the fixture does not fit', () => {
    expect(() => at(504)).toThrow(RangeError);
    expect(() => at(0)).toThrow(RangeError);
    at(503).close();
  });

  it('refuses a gate that the fixture does not have', () => {
    expect(() => at(1, 'shutter')).toThrow(/shutter/);
  });
});

describe('LaserController effects', () => {
  let output: RecordingOutput;
  let laser: LaserController;
  let tempo: Tempo;
  let clock: number;

  const advance = (ms: number) => {
    for (let passed = 0; passed < ms; passed += 25) {
      clock += 25;
      vi.advanceTimersByTime(25);
    }
  };
  const make = (effects: { list: readonly LaserEffect[]; mode: string } | undefined) =>
    new LaserController({
      profile: ALIEN_LASER_10CH,
      gate: LASER_GATE,
      output,
      tempo,
      ...(effects ? { effects } : {}),
      universe: 0,
      address: LASER_AT,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 0;
    output = new RecordingOutput();
    tempo = new Tempo({ now: () => clock });
    laser = make(EFFECTS);
  });
  afterEach(() => {
    laser.close();
    vi.useRealTimers();
  });

  it('sends a new frame forty times per second while an effect shows', () => {
    laser.update({ raw: { mode: MANUAL }, effect: { id: 'sweep' } });
    const before = output.frames.length;
    advance(1000);
    expect(output.frames.length - before).toBe(40);
  });

  it('sends nothing on its own without an effect', () => {
    laser.update({ raw: { mode: MANUAL } });
    const before = output.frames.length;
    advance(1000);
    expect(output.frames.length).toBe(before);
  });

  it('lets the effect set what it drives and keeps the rest with the operator', () => {
    laser.update({
      raw: { mode: MANUAL, program: 57, moveH: 20, colour: 70, size: 200 },
      effect: { id: 'sweep' },
    });
    expect(laser.getDmx()).toEqual([MANUAL, 57, 0, 0, 0, 1, 0, 200, 70, 0]);
    advance(BEAT_MS);
    expect(ch(output, LASER_AT + 5)).toBeGreaterThan(125);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
    expect(ch(output, LASER_AT + 1)).toBe(57);
    expect(ch(output, LASER_AT + 7)).toBe(200);
    expect(ch(output, LASER_AT + 8)).toBe(70);
    expect(laser.getState().raw.moveH).toBe(20);
  });

  it('follows the tempo and the speed of the console', () => {
    laser.update({ raw: { mode: MANUAL }, effect: { id: 'patterns' } });
    advance(BEAT_MS * 2 + 25);
    expect(ch(output, LASER_AT + 1)).toBe(12); // pattern 3
    tempo.update({ rate: 2 });
    advance(25);
    expect(ch(output, LASER_AT + 1)).toBe(22); // pattern 5
    tempo.update({ sync: true });
    advance(25);
    expect(ch(output, LASER_AT + 1)).toBe(2); // pattern 1
  });

  it('never opens the laser: a chosen effect waits until the operator does', () => {
    laser.update({ effect: { id: 'pulse' } });
    const before = output.frames.length;
    advance(500);
    expect(output.frames.length).toBe(before);
    expect(laser.getDmx()).toEqual(new Array(10).fill(0));
    expect(laser.getState().effect.id).toBe('pulse');

    laser.update({ raw: { mode: MANUAL } });
    advance(250);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
    expect(ch(output, LASER_AT + 7)).toBeGreaterThan(0);
  });

  it('leaves the channels alone in auto and sound mode', () => {
    laser.update({ raw: { mode: AUTO, program: 100, colour: 70 }, effect: { id: 'colours' } });
    const before = output.frames.length;
    advance(1000);
    expect(output.frames.length).toBe(before);
    expect(laser.getDmx()).toEqual([AUTO, 100, 0, 0, 0, 0, 0, 0, 70, 0]);
  });

  it('goes back to what the operator set when the effect stops', () => {
    laser.update({ raw: { mode: MANUAL, moveH: 20 }, effect: { id: 'sweep' } });
    advance(BEAT_MS);
    laser.update({ effect: { id: null } });
    expect(ch(output, LASER_AT + 5)).toBe(20);
    const before = output.frames.length;
    advance(500);
    expect(output.frames.length).toBe(before);
  });

  it('stays closed during a blackout, while the effect keeps running', () => {
    laser.update({ raw: { mode: MANUAL }, effect: { id: 'sweep' } });
    laser.setBlackout(true);
    advance(BEAT_MS);
    expect(ch(output, LASER_AT)).toBe(0);
    expect(ch(output, LASER_AT + 5)).toBeGreaterThan(125);
    for (const frame of output.frames.slice(-10)) expect(frame.data[LASER_AT - 1]).toBe(0);
    laser.setBlackout(false);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
  });

  it('stays closed while the master is at 0, while the effect keeps running', () => {
    const frames: number[][] = [];
    laser.on('frame', (dmx) => frames.push(dmx));
    laser.update({ raw: { mode: MANUAL }, effect: { id: 'sweep' } });
    laser.setMaster(0);
    const before = output.frames.length;
    advance(BEAT_MS);
    expect(ch(output, LASER_AT + 5)).toBeGreaterThan(125);
    expect(output.frames.length).toBeGreaterThan(before + 10);
    for (const { data } of output.frames.slice(before)) expect(data[LASER_AT - 1]).toBe(0);
    expect(frames.length).toBeGreaterThan(5);
    for (const dmx of frames) expect(dmx[0]).toBe(0);

    laser.setMaster(0.01);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
    advance(100);
    expect(frames[frames.length - 1]?.[0]).toBe(MANUAL);
  });

  it('is not opened by anything while the master is at 0', () => {
    laser.setMaster(0);
    laser.update({ effect: { id: 'pulse' } });
    laser.update({ raw: { mode: MANUAL } });
    advance(BEAT_MS);
    for (const id of ['patterns', 'colours', 'pulse', 'sweep', 'twist']) {
      laser.update({ effect: { id } });
      advance(BEAT_MS);
    }
    laser.recall({ raw: { mode: MANUAL, program: 57 }, effect: { id: 'twist' } });
    advance(BEAT_MS);
    laser.setBlackout(true);
    laser.setBlackout(false);
    advance(BEAT_MS);
    expect(output.frames.length).toBeGreaterThan(100);
    for (const { data } of output.frames) expect(data[LASER_AT - 1]).toBe(0);
    expect(laser.getState().raw.mode).toBe(MANUAL);
  });

  it('closes and stops sending when lightdeck stops', () => {
    laser.update({ raw: { mode: MANUAL }, effect: { id: 'twist' } });
    advance(200);
    laser.darken();
    expect(ch(output, LASER_AT)).toBe(0);
    const before = output.frames.length;
    advance(500);
    expect(output.frames.length).toBe(before);
  });

  it('starts no effect and stays closed after lightdeck stopped', () => {
    laser.darken();
    laser.close();
    laser.update({ raw: { mode: MANUAL }, effect: { id: 'pulse' } });
    expect(ch(output, LASER_AT)).toBe(0);
    const before = output.frames.length;
    advance(500);
    expect(output.frames.length).toBe(before);
    for (const { data } of output.frames) expect(data[LASER_AT - 1]).not.toBe(MANUAL);
  });

  it('stops sending when it is closed', () => {
    laser.update({ raw: { mode: MANUAL }, effect: { id: 'twist' } });
    laser.close();
    const before = output.frames.length;
    advance(500);
    expect(output.frames.length).toBe(before);
  });

  it('shows browsers what is being sent, twenty times per second', () => {
    const frames: { dmx: number[]; beat: number }[] = [];
    laser.on('frame', (dmx, beat) => frames.push({ dmx, beat }));
    laser.update({ raw: { mode: MANUAL }, effect: { id: 'sweep' } });
    advance(1000);
    expect(frames).toHaveLength(20);
    expect(frames[0]?.dmx).toHaveLength(10);
    expect(frames[19]?.beat).toBeCloseTo(2.1, 1);
  });

  it('tells the state with the effect in it', () => {
    const seen: LaserState[] = [];
    laser.on('state', (state) => seen.push(state as LaserState));
    laser.update({ effect: { id: 'twist' } }, 'tablet');
    expect(seen).toEqual([{ raw: expect.any(Object), effect: { id: 'twist' } }]);
  });

  it('refuses effect settings that make no sense, and changes nothing', () => {
    const bad: unknown[] = [
      { id: 'tunnel' },
      { id: 'kick' },
      { id: 5 },
      { id: 'sweep', bpm: 120 },
      { colourA: {} },
      'sweep',
      null,
    ];
    for (const effect of bad) {
      expect(() => laser.update({ raw: { mode: MANUAL }, effect })).toThrow(PatchError);
    }
    expect(laser.getState()).toEqual(expect.objectContaining({ effect: { id: null } }));
    expect(laser.getState().raw.mode).toBe(0);
  });

  it('works without effects', () => {
    laser.close();
    laser = make(undefined);
    expect(laser.describe()).toEqual({ gate: 'mode', effects: [], effectsIn: null });
    expect(() => laser.update({ effect: { id: 'sweep' } })).toThrow(PatchError);
    laser.update({ raw: { mode: MANUAL }, effect: { id: null } });
    expect(ch(output, LASER_AT)).toBe(MANUAL);
  });

  it('refuses an effect that would open or close the laser', () => {
    const opener: LaserEffect = {
      id: 'opener',
      name: 'Opener',
      description: 'Opens the laser by itself.',
      drives: ['mode'],
      render: () => ({ mode: MANUAL }),
    };
    expect(() => make({ list: [opener], mode: 'manual' })).toThrow(/cannot drive "mode"/);
    const stray: LaserEffect = { ...opener, id: 'stray', drives: ['shutter'] };
    expect(() => make({ list: [stray], mode: 'manual' })).toThrow(/cannot drive "shutter"/);
    expect(() => make({ list: LASER_EFFECTS, mode: 'off' })).toThrow(/opens the laser/);
    expect(() => make({ list: LASER_EFFECTS, mode: 'party' })).toThrow(/opens the laser/);
  });

  it('sends only what an effect drives, whatever else it gives', () => {
    const greedy: LaserEffect = {
      id: 'greedy',
      name: 'Greedy',
      description: 'Gives bytes for more than it drives.',
      drives: ['size'],
      render: () => ({ size: 30, mode: 0, colour: 99 }),
    };
    laser.close();
    laser = make({ list: [greedy], mode: 'manual' });
    laser.update({ raw: { mode: MANUAL, colour: 70 }, effect: { id: 'greedy' } });
    expect(laser.getDmx()).toEqual([MANUAL, 0, 0, 0, 0, 0, 0, 30, 70, 0]);
  });
});

describe('LaserController in a scene', () => {
  let output: RecordingOutput;
  let laser: LaserController;

  beforeEach(() => {
    output = new RecordingOutput();
    laser = new LaserController({
      profile: ALIEN_LASER_10CH,
      gate: LASER_GATE,
      output,
      tempo: new Tempo(),
      effects: EFFECTS,
      universe: 0,
      address: LASER_AT,
    });
  });
  afterEach(() => laser.close());

  it('gives nothing while it is closed and at rest', () => {
    expect(laser.snapshot()).toEqual({});
  });

  it('gives the channels that are set and the chosen effect', () => {
    laser.update({ raw: { mode: MANUAL, drawing: 191, size: 0 }, effect: { id: 'pulse' } });
    expect(laser.snapshot()).toEqual({
      raw: { mode: MANUAL, drawing: 191 },
      effect: { id: 'pulse' },
    });
  });

  it('comes back to what was kept, and opens when the part says so', () => {
    laser.update({ raw: { mode: MANUAL, drawing: 191 }, effect: { id: 'pulse' } });
    const kept = laser.snapshot();
    const before = laser.getState();
    laser.update({ raw: { mode: 0, drawing: 0, size: 80 }, effect: { id: null } });
    expect(ch(output, LASER_AT)).toBe(0);
    laser.recall(kept, 'deck');
    expect(laser.getState()).toEqual(before);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
  });

  it('closes without a part', () => {
    laser.update({ raw: { mode: MANUAL, drawing: 191 }, effect: { id: 'pulse' } });
    laser.recall(undefined);
    expect([...output.last].every((b) => b === 0)).toBe(true);
    expect(laser.getState().effect.id).toBeNull();
  });

  it('stays closed during a blackout, whatever is recalled', () => {
    laser.setBlackout(true);
    laser.recall({ raw: { mode: MANUAL } });
    expect(ch(output, LASER_AT)).toBe(0);
    laser.setBlackout(false);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
  });

  it('stays closed while the master is at 0, whatever is recalled', () => {
    laser.setMaster(0);
    laser.recall({ raw: { mode: MANUAL } });
    expect(ch(output, LASER_AT)).toBe(0);
    expect(laser.snapshot()).toEqual({ raw: { mode: MANUAL } });
    laser.setMaster(0.01);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
  });

  it('stays closed after lightdeck stopped, whatever is recalled', () => {
    laser.darken();
    laser.close();
    laser.recall({ raw: { mode: MANUAL, program: 57 }, effect: { id: 'twist' } }, 'deck');
    expect(ch(output, LASER_AT)).toBe(0);
    expect(ch(output, LASER_AT + 1)).toBe(57);
  });

  it('refuses a part it cannot take, and stays as it is', () => {
    laser.update({ raw: { mode: MANUAL } });
    const before = laser.getState();
    for (const part of [
      { raw: { mode: 300 } },
      { raw: { beam: 1 } },
      { effect: { id: 'disco' } },
      { levels: { dimmer: 1 } },
      [],
    ]) {
      expect(() => laser.check(part)).toThrow(PatchError);
      expect(() => laser.recall(part)).toThrow(PatchError);
    }
    expect(laser.getState()).toEqual(before);
  });
});
