import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALIEN_LASER_10CH, LASER_GATE } from '../fixtures/laser.js';
import { PatchError } from './fixture.js';
import { LaserController, type LaserState } from './laserController.js';
import { ch, RecordingOutput } from './testing.js';

const MANUAL = 95;
const LASER_AT = 44;

describe('LaserController', () => {
  let output: RecordingOutput;
  let laser: LaserController;

  const at = (address: number, gate = LASER_GATE) =>
    new LaserController({ profile: ALIEN_LASER_10CH, gate, output, universe: 0, address });

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

  it('closes for good when lightdeck stops', () => {
    laser.update({ raw: { mode: MANUAL, program: 57 } });
    laser.darken();
    expect(ch(output, LASER_AT)).toBe(0);
    expect(laser.getState().raw.mode).toBe(0);
    expect(laser.getState().raw.program).toBe(57);
  });

  it('can do nothing by name', () => {
    expect(() => laser.act('reset')).toThrow(PatchError);
  });

  it('tells the page which control opens and closes it', () => {
    expect(laser.describe()).toEqual({ gate: 'mode' });
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
