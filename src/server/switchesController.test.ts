import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PatchError } from './fixture.js';
import { type SwitchDefinition, SwitchesController } from './switchesController.js';
import { RecordingHass } from './testing.js';

const SWITCHES: SwitchDefinition[] = [
  { id: 'uv1', label: 'UV 1', entity: 'switch.uv_lamp_1', blackout: true },
  { id: 'uv2', label: 'UV 2', entity: 'switch.uv_lamp_2' },
];

const ON = { domain: 'switch', service: 'turn_on' };
const OFF = { domain: 'switch', service: 'turn_off' };

describe('SwitchesController', () => {
  let hass: RecordingHass;
  let decor: SwitchesController;

  const make = (switches = SWITCHES) => new SwitchesController({ hass, switches });

  beforeEach(() => {
    hass = new RecordingHass();
    decor = make();
  });
  afterEach(() => decor.close());

  describe('the switches', () => {
    it('does not touch a switch when it starts', () => {
      expect(hass.commands).toEqual([]);
      expect(decor.getState().on).toEqual({ uv1: false, uv2: false });
    });

    it('says what the decor is made of', () => {
      expect(decor.describe()).toEqual({
        switches: [
          { id: 'uv1', label: 'UV 1', entity: 'switch.uv_lamp_1' },
          { id: 'uv2', label: 'UV 2', entity: 'switch.uv_lamp_2' },
        ],
      });
      expect(decor.takesPalettes).toBe(false);
    });

    it('starts with the blackout setting of the rig file', () => {
      expect(decor.getState().follows).toEqual({ uv1: true, uv2: false });
    });

    it('refuses what cannot be a switch', () => {
      expect(() => make([])).toThrow(/at least one switch/);
      expect(() => make([{ id: 'Bad', label: 'x', entity: 'switch.a' }])).toThrow(/cannot name/);
      expect(() => make([{ id: 'a', label: 'x', entity: 'light.a' }])).toThrow(/not a switch/);
      expect(() =>
        make([
          { id: 'a', label: 'x', entity: 'switch.a' },
          { id: 'a', label: 'y', entity: 'switch.b' },
        ]),
      ).toThrow(/two switches/);
      expect(() =>
        make([
          { id: 'a', label: 'x', entity: 'switch.a' },
          { id: 'b', label: 'y', entity: 'switch.a' },
        ]),
      ).toThrow(/same entity/);
    });

    it('switches one apart from the other, or both together', () => {
      decor.update({ on: { uv1: true } }, 'tablet');
      expect(hass.to('switch.uv_lamp_1')).toEqual([ON]);
      expect(hass.to('switch.uv_lamp_2')).toEqual([]);
      decor.update({ on: { uv1: false, uv2: true } });
      expect(hass.to('switch.uv_lamp_1')).toEqual([ON, OFF]);
      expect(hass.to('switch.uv_lamp_2')).toEqual([ON]);
      decor.update({ on: { uv1: true, uv2: true } });
      expect(decor.getState().on).toEqual({ uv1: true, uv2: true });
    });

    it('sends nothing for a change that changes nothing, and says it to the page', () => {
      const heard: unknown[] = [];
      decor.on('state', (state, origin) => heard.push([state, origin]));
      decor.update({ on: { uv1: false } }, 'tablet');
      expect(hass.commands).toEqual([]);
      expect(heard).toHaveLength(1);
    });

    it('refuses a change it does not understand, and changes nothing', () => {
      expect(() => decor.update({ on: { nope: true } })).toThrow(/no switch called "nope"/);
      expect(() => decor.update({ on: { uv1: 1 } })).toThrow(PatchError);
      expect(() => decor.update({ follows: { uv1: 'yes' } })).toThrow(PatchError);
      expect(() => decor.update({ blackout: 'yes' })).toThrow(PatchError);
      expect(() => decor.update({ levels: {} })).toThrow(/cannot set "levels"/);
      expect(() => decor.update({ on: { uv1: true }, blackout: 'yes' })).toThrow(PatchError);
      expect(decor.getState().on.uv1).toBe(false);
      expect(hass.commands).toEqual([]);
    });
  });

  describe('the blackout of the console', () => {
    beforeEach(() => {
      decor.update({ on: { uv1: true, uv2: true } });
      hass.commands = [];
    });

    it('switches off the switches that follow it, and leaves the others', () => {
      decor.setBlackout(true);
      expect(hass.commands).toEqual([{ entity: 'switch.uv_lamp_1', command: OFF, urgent: true }]);
      expect(decor.getState().on).toEqual({ uv1: true, uv2: true });
    });

    it('brings them back, set as they were, when it is lifted', () => {
      decor.setBlackout(true);
      hass.commands = [];
      decor.setBlackout(false);
      expect(hass.commands).toEqual([{ entity: 'switch.uv_lamp_1', command: ON, urgent: true }]);
    });

    it('does not bring back a switch that was set off during it', () => {
      decor.setBlackout(true);
      decor.update({ on: { uv1: false } });
      hass.commands = [];
      decor.setBlackout(false);
      expect(hass.commands).toEqual([]);
    });

    it('lets the operator change whether a switch follows it, also while it is on', () => {
      decor.setBlackout(true);
      hass.commands = [];
      decor.update({ follows: { uv2: true } });
      expect(hass.commands).toEqual([{ entity: 'switch.uv_lamp_2', command: OFF, urgent: true }]);
      hass.commands = [];
      decor.update({ follows: { uv1: false } });
      expect(hass.commands).toEqual([{ entity: 'switch.uv_lamp_1', command: ON, urgent: true }]);
      expect(decor.getState().follows).toEqual({ uv1: false, uv2: true });
    });

    it('does nothing when the blackout is already as it was', () => {
      decor.setBlackout(false);
      expect(hass.commands).toEqual([]);
    });

    it('does not follow the master', () => {
      decor.setMaster(0);
      expect(hass.commands).toEqual([]);
    });
  });

  describe('the blackout of the decor alone', () => {
    beforeEach(() => {
      decor.update({ on: { uv1: true, uv2: true } });
      hass.commands = [];
    });

    it('switches every switch off, whether it follows the console or not, and lifts again', () => {
      decor.update({ blackout: true }, 'tablet');
      expect(decor.getState().blackout).toBe(true);
      expect(hass.commands.map((sent) => [sent.entity, sent.command, sent.urgent])).toEqual([
        ['switch.uv_lamp_1', OFF, true],
        ['switch.uv_lamp_2', OFF, true],
      ]);
      hass.commands = [];
      decor.update({ blackout: false });
      expect(hass.commands.map((sent) => [sent.entity, sent.command])).toEqual([
        ['switch.uv_lamp_1', ON],
        ['switch.uv_lamp_2', ON],
      ]);
    });

    it('and the blackout of the console do not undo each other', () => {
      decor.update({ blackout: true });
      decor.setBlackout(true);
      decor.update({ blackout: false });
      // uv1 follows the console, which is still dark; uv2 is back.
      expect(hass.to('switch.uv_lamp_1')).toEqual([OFF]);
      expect(hass.to('switch.uv_lamp_2')).toEqual([OFF, ON]);
      decor.setBlackout(false);
      expect(hass.to('switch.uv_lamp_1')).toEqual([OFF, ON]);
    });
  });

  describe('scenes', () => {
    it('keeps nothing of the decor in any scene', () => {
      decor.update({ on: { uv1: true } });
      for (const type of ['lights', 'colour', 'motion', 'zone'] as const) {
        expect(decor.snapshot(type)).toEqual({});
      }
    });

    it('leaves the switches as they are on a recall, whatever the type, also without a part', () => {
      decor.update({ on: { uv1: true } });
      hass.commands = [];
      for (const type of ['lights', 'colour', 'motion', 'zone'] as const) {
        decor.recall(type, undefined);
        decor.recall(type, {});
      }
      expect(hass.commands).toEqual([]);
      expect(decor.getState().on.uv1).toBe(true);
    });

    it('refuses a scene that names a switch', () => {
      expect(() => decor.check('lights', { on: { uv1: true } })).toThrow(/part of no scene/);
      expect(() => decor.recall('lights', { on: { uv1: true } })).toThrow(PatchError);
      expect(() => decor.check('lights', undefined)).not.toThrow();
    });

    it('has nothing to do called by name', () => {
      expect(() => decor.act('reset')).toThrow(PatchError);
    });
  });

  describe('what Home Assistant says', () => {
    it('shows what each switch is, and why a command did not arrive, and changes nothing', () => {
      hass.report('switch.uv_lamp_1', { available: true, on: true, colourModes: [] });
      expect(decor.getState().reported.uv1).toEqual({ available: true, on: true });
      expect(decor.getState().on.uv1).toBe(false);
      expect(hass.commands).toEqual([]);
      hass.complain('switch.uv_lamp_2', 'not found');
      expect(decor.getState().problems.uv2).toBe('not found');
      hass.complain('switch.uv_lamp_2', null);
      expect(decor.getState().problems.uv2).toBeNull();
      hass.report('switch.uv_lamp_1', undefined);
      expect(decor.getState().reported.uv1).toBeNull();
    });

    it('stays as it is when lightdeck stops', () => {
      decor.update({ on: { uv1: true } });
      hass.commands = [];
      decor.darken();
      expect(hass.commands).toEqual([]);
    });
  });
});
