import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Palette, PaletteBook } from '../engine/palette.js';
import {
  DecorController,
  SPEED_STEP,
  type StripDefinition,
  type SwitchDefinition,
  stripSpeed,
} from './decorController.js';
import { PatchError } from './fixture.js';
import { Tempo } from './tempo.js';
import { RecordingHass } from './testing.js';

const SWITCHES: SwitchDefinition[] = [
  { id: 'uv1', label: 'UV 1', entity: 'switch.uv_lamp_1', blackout: true },
  { id: 'uv2', label: 'UV 2', entity: 'switch.uv_lamp_2' },
];

const ON = { domain: 'switch', service: 'turn_on' };
const OFF = { domain: 'switch', service: 'turn_off' };

describe('DecorController', () => {
  let hass: RecordingHass;
  let decor: DecorController;

  const make = (switches = SWITCHES) => new DecorController({ hass, switches });

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
      expect(decor.describe()).toMatchObject({
        switches: [
          { id: 'uv1', label: 'UV 1', entity: 'switch.uv_lamp_1' },
          { id: 'uv2', label: 'UV 2', entity: 'switch.uv_lamp_2' },
        ],
        strips: [],
      });
      expect(decor.takesPalettes).toBe(false);
    });

    it('starts with the blackout setting of the rig file', () => {
      expect(decor.getState().follows).toEqual({ uv1: true, uv2: false });
    });

    it('refuses what cannot be a switch', () => {
      expect(() => make([])).toThrow(/at least one switch or strip/);
      expect(() => make([{ id: 'Bad', label: 'x', entity: 'switch.a' }])).toThrow(/cannot name/);
      expect(() => make([{ id: 'a', label: 'x', entity: 'light.a' }])).toThrow(/not a switch/);
      expect(() =>
        make([
          { id: 'a', label: 'x', entity: 'switch.a' },
          { id: 'a', label: 'y', entity: 'switch.b' },
        ]),
      ).toThrow(/two things in the decor are called/);
      expect(() =>
        make([
          { id: 'a', label: 'x', entity: 'switch.a' },
          { id: 'b', label: 'y', entity: 'switch.a' },
        ]),
      ).toThrow(/used twice in the decor/);
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
      expect(() => decor.update({ on: { nope: true } })).toThrow(/nothing called "nope"/);
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

    it('follows the master at 0 for the switch that follows it, and not the others', () => {
      decor.setMaster(0);
      expect(hass.commands).toEqual([{ entity: 'switch.uv_lamp_1', command: OFF, urgent: true }]);
      hass.commands = [];
      decor.setMaster(0.5);
      expect(hass.commands).toEqual([{ entity: 'switch.uv_lamp_1', command: ON, urgent: true }]);
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

const STRIPS: StripDefinition[] = [
  { id: 'buis1', label: 'Buis 1', entity: 'light.wled_buis1', colour: '#ff0000', draw: 'wled' },
  {
    id: 'buis2',
    label: 'Buis 2',
    entity: 'light.wled_buis2',
    speed: 'number.my_speed',
    draw: 'wled',
    blackout: true,
  },
];

describe('the strips of WLED in the decor', () => {
  let hass: RecordingHass;
  let tempo: Tempo;
  let decor: DecorController;
  let clock: number;

  const make = (strips = STRIPS, switches = SWITCHES) =>
    new DecorController({ hass, tempo, switches, strips });
  const sent = (entity: string) => hass.to(entity);

  beforeEach(() => {
    hass = new RecordingHass();
    clock = 0;
    tempo = new Tempo({ now: () => clock });
    tempo.update({ bpm: 126 });
    decor = make();
  });
  afterEach(() => decor.close());

  it('does not touch a strip when it starts, and says what it is made of', () => {
    expect(hass.commands).toEqual([]);
    expect(decor.describe()).toMatchObject({
      strips: [
        { id: 'buis1', entity: 'light.wled_buis1', speed: 'number.wled_buis1_speed' },
        { id: 'buis2', entity: 'light.wled_buis2', speed: 'number.my_speed' },
      ],
    });
    const state = decor.getState();
    expect(state.colour.buis1).toEqual({ red: 1, green: 0, blue: 0 });
    expect(state.colour.buis2).toEqual({ red: 1, green: 1, blue: 1 });
    expect(state.level).toEqual({ buis1: 1, buis2: 1 });
    expect(state.effect).toEqual({ buis1: null, buis2: null });
    expect(state.follows).toEqual({ uv1: true, uv2: false, buis1: false, buis2: true });
  });

  it('refuses what cannot be a strip', () => {
    const one = (extra: Partial<StripDefinition>) =>
      make([{ id: 'a', label: 'A', entity: 'light.a', draw: 'wled', ...extra }]);
    expect(() => one({ entity: 'switch.a' })).toThrow(/not a light/);
    expect(() => one({ speed: 'light.x' })).toThrow(/not a number entity/);
    expect(() => one({ colour: 'red' })).toThrow(/#rrggbb/);
    expect(() => one({ id: 'uv1' })).toThrow(/two things in the decor/);
    expect(() => one({ entity: 'switch.uv_lamp_1' })).toThrow();
    expect(() => one({ speed: 'number.wled_buis1_speed' })).not.toThrow();
    expect(() =>
      make([
        { id: 'a', label: 'A', entity: 'light.a', draw: 'wled' },
        { id: 'b', label: 'B', entity: 'light.b', draw: 'wled', speed: 'number.a_speed' },
      ]),
    ).toThrow(/number.a_speed is used twice/);
    expect(() => make([], [])).toThrow(/at least one/);
  });

  it('turns a strip on with its speed first, then its colour, effect and brightness', () => {
    decor.update({ on: { buis1: true } }, 'tablet');
    expect(sent('number.wled_buis1_speed')).toEqual([
      { domain: 'number', service: 'set_value', data: { value: 126 } },
    ]);
    expect(sent('light.wled_buis1')).toEqual([
      {
        domain: 'light',
        service: 'turn_on',
        data: { brightness: 255, rgb_color: [255, 0, 0], effect: 'Solid', transition: 0.4 },
      },
    ]);
    expect(hass.commands.map((each) => each.entity)).toEqual([
      'number.wled_buis1_speed',
      'light.wled_buis1',
    ]);
    expect(sent('light.wled_buis2')).toEqual([]);
  });

  it('changes colour, brightness and effect of one strip', () => {
    decor.update({ on: { buis1: true } });
    hass.commands = [];
    decor.update({ colour: { buis1: { red: 0, green: 0.5, blue: 1 } }, level: { buis1: 0.5 } });
    decor.update({ effect: { buis1: 'Flow' } });
    expect(sent('light.wled_buis1')).toEqual([
      {
        domain: 'light',
        service: 'turn_on',
        data: { brightness: 128, rgb_color: [0, 128, 255], effect: 'Solid', transition: 0.4 },
      },
      {
        domain: 'light',
        service: 'turn_on',
        data: { brightness: 128, rgb_color: [0, 128, 255], effect: 'Flow', transition: 0.4 },
      },
    ]);
    expect(decor.getState().effect.buis1).toBe('Flow');
    // A colour is a direction: a dim colour is the same colour at a lower brightness.
    decor.update({ colour: { buis1: { red: 0, green: 0.25, blue: 0.5 } } });
    expect(sent('light.wled_buis1').at(-1)?.data).toMatchObject({
      rgb_color: [0, 128, 255],
      brightness: 128,
    });
  });

  it('keeps a change of an off strip until it is switched on, and sends nothing for it', () => {
    decor.update({ level: { buis2: 0.3 }, effect: { buis2: 'Chase' } });
    expect(hass.commands).toEqual([]);
    decor.update({ on: { buis2: true } });
    expect(sent('light.wled_buis2')[0]?.data).toMatchObject({ effect: 'Chase', brightness: 77 });
    decor.update({ on: { buis2: false } });
    expect(sent('light.wled_buis2').at(-1)).toEqual({
      domain: 'light',
      service: 'turn_off',
      data: { transition: 0 },
    });
  });

  it('knows the effects that the strip lists, and refuses another', () => {
    hass.report('light.wled_buis1', {
      available: true,
      on: false,
      colourModes: ['rgb'],
      effects: ['Solid', 'Flow', 'Chase'],
      effect: 'Solid',
    });
    expect(decor.getState().reported.buis1).toEqual({
      available: true,
      on: false,
      effects: ['Solid', 'Flow', 'Chase'],
      effect: 'Solid',
    });
    expect(() => decor.update({ effect: { buis1: 'Nope' } })).toThrow(/no effect called "Nope"/);
    expect(() => decor.update({ effect: { buis1: 'Flow' } })).not.toThrow();
    expect(() => decor.update({ effect: { buis1: null } })).not.toThrow();
    // Not yet reported: whatever name is passed on, and Home Assistant says if it is wrong.
    expect(() => decor.update({ effect: { buis2: 'Anything' } })).not.toThrow();
  });

  it('refuses what a strip cannot do, and what a switch cannot', () => {
    expect(() => decor.update({ effect: { uv1: 'Flow' } })).toThrow(/"uv1" is a switch/);
    expect(() => decor.update({ colour: { uv1: { red: 1, green: 1, blue: 1 } } })).toThrow(
      /switch/,
    );
    expect(() => decor.update({ level: { uv1: 1 } })).toThrow(/switch/);
    expect(() => decor.update({ level: { buis1: 2 } })).toThrow(/0 to 1/);
    expect(() => decor.update({ level: { buis1: 'x' } })).toThrow(PatchError);
    expect(() => decor.update({ colour: { buis1: { red: 1, green: 1 } } })).toThrow(PatchError);
    expect(() => decor.update({ colour: { buis1: { red: 1, green: 1, blue: 3 } } })).toThrow(
      /blue/,
    );
    expect(() => decor.update({ effect: { buis1: 5 } })).toThrow(PatchError);
    expect(() => decor.update({ effect: { nope: 'Flow' } })).toThrow(/nothing called/);
    expect(hass.commands).toEqual([]);
  });

  describe('the speed follows the tempo', () => {
    beforeEach(() => {
      decor.update({ on: { buis1: true } });
      hass.commands = [];
    });

    it('works out the speed as the bpm times the master speed, from 1 to 255', () => {
      expect(stripSpeed(126, 1)).toBe(126);
      expect(stripSpeed(126, 2)).toBe(252);
      expect(stripSpeed(200, 4)).toBe(255);
      expect(stripSpeed(0, 1)).toBe(1);
    });

    it('sends a new speed for a real change, and not for a wobble', () => {
      tempo.update({ bpm: 126 + SPEED_STEP - 1 });
      expect(sent('number.wled_buis1_speed')).toEqual([]);
      tempo.update({ bpm: 140 });
      expect(sent('number.wled_buis1_speed')).toEqual([
        { domain: 'number', service: 'set_value', data: { value: 140 } },
      ]);
      tempo.update({ rate: 2 });
      expect(sent('number.wled_buis1_speed').at(-1)?.data).toEqual({ value: 255 });
    });

    it('does not tell a strip that is off', () => {
      decor.update({ on: { buis1: false } });
      hass.commands = [];
      tempo.update({ bpm: 170 });
      expect(hass.commands).toEqual([]);
      decor.update({ on: { buis1: true } });
      expect(sent('number.wled_buis1_speed')).toEqual([
        { domain: 'number', service: 'set_value', data: { value: 170 } },
      ]);
    });

    it('runs on when the music stops: the tempo keeps its bpm and nothing is sent', () => {
      tempo.update({ source: 'rekordbox' });
      tempo.follow({ running: false });
      expect(sent('number.wled_buis1_speed')).toEqual([]);
      expect(decor.getState().on.buis1).toBe(true);
    });

    it('stops listening to the tempo when it is closed', () => {
      decor.close();
      tempo.update({ bpm: 180 });
      expect(hass.commands).toEqual([]);
    });
  });

  describe('the blackouts', () => {
    beforeEach(() => {
      decor.update({ on: { buis1: true, buis2: true } });
      hass.commands = [];
    });

    it('switches off the strips that follow the console, and brings them back', () => {
      decor.setBlackout(true);
      expect(hass.commands.map((each) => [each.entity, each.command.service])).toEqual([
        ['light.wled_buis2', 'turn_off'],
      ]);
      hass.commands = [];
      decor.setBlackout(false);
      expect(sent('light.wled_buis2')[0]?.service).toBe('turn_on');
      expect(sent('light.wled_buis1')).toEqual([]);
    });

    it('lets one strip follow the console or not, per strip', () => {
      decor.update({ follows: { buis1: true, buis2: false } });
      decor.setBlackout(true);
      expect(hass.commands.map((each) => each.entity)).toEqual(['light.wled_buis1']);
    });

    it('puts the strips, the switches and everything out with the decor blackout alone', () => {
      decor.update({ on: { uv1: true } });
      hass.commands = [];
      decor.update({ blackout: true });
      expect(hass.commands.map((each) => [each.entity, each.command.service]).sort()).toEqual([
        ['light.wled_buis1', 'turn_off'],
        ['light.wled_buis2', 'turn_off'],
        ['switch.uv_lamp_1', 'turn_off'],
      ]);
      hass.commands = [];
      decor.update({ blackout: false });
      expect(hass.commands.map((each) => each.entity).sort()).toEqual([
        'light.wled_buis1',
        'light.wled_buis2',
        'switch.uv_lamp_1',
      ]);
    });

    it('scales the brightness of the strips by the master and the dimmer of the pipes, and switches off at 0', () => {
      decor.setMaster(0.5);
      expect(sent('light.wled_buis1').at(-1)?.data).toMatchObject({ brightness: 128 });
      decor.update({ pipesDimmer: 0.5 });
      expect(sent('light.wled_buis1').at(-1)?.data).toMatchObject({ brightness: 64 });
      decor.update({ level: { buis1: 0.5 } });
      expect(sent('light.wled_buis1').at(-1)?.data).toMatchObject({ brightness: 32 });
      hass.commands = [];
      decor.setMaster(0);
      expect(sent('light.wled_buis1')).toEqual([
        { domain: 'light', service: 'turn_off', data: { transition: 0 } },
      ]);
      hass.commands = [];
      decor.setMaster(1);
      expect(sent('light.wled_buis1')[0]?.data).toMatchObject({ brightness: 64 });
    });

    it('sends a press urgently, and a change of brightness alone not', () => {
      decor.update({ effect: { buis1: 'Flow' } });
      expect(hass.commands.every((each) => each.urgent)).toBe(true);
      hass.commands = [];
      decor.update({ level: { buis1: 0.5 } });
      decor.setMaster(0.8);
      // The level of buis1, and the master for both strips.
      expect(hass.commands).toHaveLength(3);
      expect(hass.commands.every((each) => !each.urgent)).toBe(true);
      hass.commands = [];
      decor.update({ on: { buis1: false } });
      expect(hass.commands.every((each) => each.urgent)).toBe(true);
    });
  });

  it('shows what Home Assistant says, and a refused speed or light under the strip', () => {
    hass.report('light.wled_buis1', { available: true, on: true, colourModes: ['rgb'] });
    expect(decor.getState().reported.buis1).toMatchObject({ available: true, on: true });
    hass.complain('number.wled_buis1_speed', 'not found');
    expect(decor.getState().problems.buis1).toBe('the speed: not found');
    hass.complain('light.wled_buis1', 'unavailable');
    expect(decor.getState().problems.buis1).toBe('unavailable');
    hass.complain('light.wled_buis1', null);
    expect(decor.getState().problems.buis1).toBe('the speed: not found');
    hass.complain('number.wled_buis1_speed', null);
    expect(decor.getState().problems.buis1).toBeNull();
  });

  it('is in no scene, strips included', () => {
    decor.update({ on: { buis1: true }, effect: { buis1: 'Flow' } });
    for (const type of ['lights', 'colour', 'motion', 'zone'] as const) {
      expect(decor.snapshot(type)).toEqual({});
    }
    hass.commands = [];
    decor.recall('lights', undefined);
    expect(hass.commands).toEqual([]);
    expect(() => decor.check('lights', { effect: { buis1: 'Flow' } })).toThrow(/part of no scene/);
  });

  describe('looks: palette, intensity and pace', () => {
    beforeEach(() => {
      hass.report('select.wled_buis1_color_palette', {
        available: true,
        on: false,
        colourModes: [],
        options: ['Default', '* Color 1', 'Ocean', 'Lava'],
      });
    });

    it('knows the palettes the strip lists, and refuses another', () => {
      expect(decor.getState().palettes.buis1).toEqual(['Default', '* Color 1', 'Ocean', 'Lava']);
      expect(decor.getState().palettes.buis2).toEqual([]);
      expect(() => decor.update({ palette: { buis1: 'Nope' } })).toThrow(
        /no palette called "Nope"/,
      );
      expect(() => decor.update({ palette: { buis2: 'Anything' } })).not.toThrow();
    });

    it('sends a palette, an intensity and the speed before the light, once the strip is on', () => {
      decor.update({ palette: { buis1: 'Ocean' }, intensity: { buis1: 40 }, pace: { buis1: 2 } });
      // Off: nothing is sent, and the settings wait.
      expect(hass.commands).toEqual([]);
      decor.update({ on: { buis1: true }, effect: { buis1: 'Meteor' } });
      expect(hass.commands.map((each) => [each.entity, each.command.service])).toEqual([
        ['select.wled_buis1_color_palette', 'select_option'],
        ['number.wled_buis1_intensity', 'set_value'],
        ['number.wled_buis1_speed', 'set_value'],
        ['light.wled_buis1', 'turn_on'],
      ]);
      expect(sent('select.wled_buis1_color_palette')[0]?.data).toEqual({ option: 'Ocean' });
      expect(sent('number.wled_buis1_intensity')[0]?.data).toEqual({ value: 40 });
      // The pace multiplies the bpm: 126 times 2.
      expect(sent('number.wled_buis1_speed')[0]?.data).toEqual({ value: 252 });
    });

    it('sends only what changed, and leaves a palette and an intensity alone that were never set', () => {
      decor.update({ on: { buis1: true } });
      expect(sent('select.wled_buis1_color_palette')).toEqual([]);
      expect(sent('number.wled_buis1_intensity')).toEqual([]);
      decor.update({ palette: { buis1: 'Lava' } });
      decor.update({ palette: { buis1: 'Lava' }, level: { buis1: 0.9 } });
      expect(sent('select.wled_buis1_color_palette')).toHaveLength(1);
      decor.update({ pace: { buis1: 0.5 } });
      expect(sent('number.wled_buis1_speed').at(-1)?.data).toEqual({ value: 63 });
    });

    it('refuses a bad intensity, pace and dimmer of the pipes', () => {
      expect(() => decor.update({ intensity: { buis1: 300 } })).toThrow(/0 to 255/);
      expect(() => decor.update({ intensity: { buis1: null } })).not.toThrow();
      expect(() => decor.update({ pace: { buis1: 3 } })).toThrow(/one of/);
      expect(() => decor.update({ pipesDimmer: 2 })).toThrow(/0 to 1/);
      // The UV lamps are switches: there is no dimmer of the decor and none of the lamps.
      expect(() => decor.update({ dimmer: 0.5 })).toThrow(/cannot set "dimmer"/);
      expect(() => decor.update({ palette: { uv1: 'Ocean' } })).toThrow(/switch/);
    });

    it('shows a refused palette or intensity under the strip', () => {
      hass.complain('select.wled_buis1_color_palette', 'not found');
      expect(decor.getState().problems.buis1).toBe('the palette: not found');
      hass.complain('select.wled_buis1_color_palette', null);
      expect(decor.getState().problems.buis1).toBeNull();
    });

    it('says the looks of the pipes, checked at the start', () => {
      const looks = [
        { id: 'flow', label: 'Flow', effect: 'Flow', palette: 'Ocean', colour: '#00e5ff', pace: 1 },
        { id: 'shot', label: 'Shot', effect: 'Meteor', intensity: 40, pace: 4 },
        { id: 'plain', label: 'Plain', effect: null },
      ];
      const made = new DecorController({ hass, tempo, strips: STRIPS, looks });
      expect(made.describe().looks).toEqual(looks);
      made.close();
      const bad = (extra: object) =>
        new DecorController({
          hass,
          tempo,
          strips: STRIPS,
          looks: [{ id: 'x', label: 'X', effect: 'Flow', ...extra }],
        });
      expect(() => bad({ colour: 'red' })).toThrow(/#rrggbb/);
      expect(() => bad({ pace: 3 })).toThrow(/pace/);
      expect(() => bad({ intensity: 999 })).toThrow(/intensity/);
      expect(() => bad({ id: 'Bad id' })).toThrow(/cannot name a look/);
      expect(
        () =>
          new DecorController({
            hass,
            tempo,
            strips: STRIPS,
            looks: [...looks.slice(0, 1), ...looks.slice(0, 1)],
          }),
      ).toThrow(/two looks/);
    });
  });

  describe('pressing a look', () => {
    const LOOKS = [
      {
        id: 'flow',
        label: 'Flow',
        effect: 'Flow',
        palette: 'Ocean',
        colour: '#00e5ff',
        intensity: 90,
        pace: 2,
      },
      { id: 'shot', label: 'Shot', effect: 'Meteor', pace: 4 },
      { id: 'plain', label: 'Plain', effect: null },
    ];
    let looked: DecorController;
    beforeEach(() => {
      looked = new DecorController({ hass, tempo, strips: STRIPS, looks: LOOKS });
    });
    afterEach(() => looked.close());

    it('sets the effect, palette, colour, intensity and pace of the look on the strip', () => {
      looked.update({ look: { buis1: 'flow' } });
      const state = looked.getState();
      expect(state.effect.buis1).toBe('Flow');
      expect(state.palette.buis1).toBe('Ocean');
      expect(state.intensity.buis1).toBe(90);
      expect(state.pace.buis1).toBe(2);
      expect(state.colour.buis1?.green).toBeCloseTo(0.898, 2);
      expect(state.effect.buis2).toBeNull();
    });

    it('sets back what WLED starts with where a look says nothing, and keeps the colour', () => {
      looked.update({ look: { buis1: 'flow' } });
      looked.update({ look: { buis1: 'shot' } });
      const state = looked.getState();
      expect(state.palette.buis1).toBe('Default');
      expect(state.intensity.buis1).toBe(128);
      expect(state.pace.buis1).toBe(4);
      expect(state.colour.buis1?.green).toBeCloseTo(0.898, 2);
      looked.update({ look: { buis1: 'plain' } });
      expect(looked.getState().effect.buis1).toBeNull();
    });

    it('lets what the change says itself win over the look, and refuses a look that is not there', () => {
      looked.update({ look: { buis1: 'flow' }, pace: { buis1: 0.5 } });
      expect(looked.getState().pace.buis1).toBe(0.5);
      expect(() => looked.update({ look: { buis1: 'nope' } })).toThrow(/no look called "nope"/);
      expect(() => looked.update({ look: { uv1: 'flow' } })).toThrow(/no strip called "uv1"/);
      expect(() => looked.update({ look: 3 })).toThrow(PatchError);
    });

    it('keeps its looks as ids and sets one on every pipe, for a step of a sequence', () => {
      expect(looked.lookIds()).toEqual(['flow', 'shot', 'plain']);
      looked.playLook('shot');
      const state = looked.getState();
      expect(state.effect.buis1).toBe('Meteor');
      expect(state.effect.buis2).toBe('Meteor');
      expect(() => looked.playLook('nope')).toThrow(/no look called "nope"/);
    });

    it('is one press for all the pipes, and nothing goes out while they are off', () => {
      looked.update({ look: { buis1: 'shot', buis2: 'shot' } });
      expect(hass.commands).toEqual([]);
      looked.update({ on: { buis1: true, buis2: true } });
      expect(sent('number.wled_buis1_speed')[0]?.data).toEqual({ value: 255 });
      expect(sent('light.wled_buis2')[0]?.data).toMatchObject({ effect: 'Meteor' });
    });
  });
});

describe('the pipes that lightdeck draws', () => {
  const COPPER: Palette = {
    id: 'copper',
    label: 'Copper',
    colours: [
      { red: 1, green: 0, blue: 0, white: 0 },
      { red: 0, green: 0, blue: 1, white: 0 },
    ],
    mode: 'static',
    change: 'step',
    speed: 1,
  };
  const DARKWHITE: Palette = {
    ...COPPER,
    id: 'white',
    colours: [{ red: 0, green: 0, blue: 0, white: 1 }],
  };
  const PIPES: StripDefinition[] = [
    { id: 'buis1', label: 'Buis 1', entity: 'light.wled_buis1', host: '10.0.0.1', leds: 4 },
    {
      id: 'buis2',
      label: 'Buis 2',
      entity: 'light.wled_buis2',
      host: '10.0.0.2',
      leds: 4,
      blackout: true,
    },
  ];
  let hass: RecordingHass;
  let tempo: Tempo;
  let decor: DecorController;
  let sent: { host: string; bytes: number[] }[];
  let closed: string[];
  let idled: string[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    hass = new RecordingHass();
    tempo = new Tempo();
    tempo.update({ bpm: 120 });
    sent = [];
    closed = [];
    idled = [];
    const palettes = new PaletteBook();
    palettes.set([COPPER, DARKWHITE]);
    decor = new DecorController({
      hass,
      tempo,
      palettes,
      strips: PIPES,
      looks: [{ id: 'brew', label: 'Brew', effect: 'flow', palette: 'copper', pace: 2 }],
      makeSender: (host) => ({
        send: (bytes) => sent.push({ host, bytes: [...bytes] }),
        close: () => closed.push(host),
      }),
      setIdle: async (host) => {
        idled.push(host);
      },
    });
  });
  afterEach(() => {
    decor.close();
    vi.useRealTimers();
  });

  const to = (host: string) => sent.filter((each) => each.host === host);

  it('does not touch a pipe at the start, and never asks Home Assistant for an effect, palette or speed', () => {
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([]);
    expect(idled).toEqual([]);
    decor.update({ on: { buis1: true }, effect: { buis1: 'solid' }, palette: { buis1: 'copper' } });
    vi.advanceTimersByTime(1000);
    expect(hass.commands).toEqual([]);
  });

  it('says that it draws the pipe, how many LEDs it has and the effects it can draw', () => {
    const details = decor.describe() as {
      strips: { id: string; rendered: boolean; leds: number }[];
      pipeEffects: { id: string }[];
    };
    expect(details.strips.map((each) => [each.id, each.rendered, each.leds])).toEqual([
      ['buis1', true, 4],
      ['buis2', true, 4],
    ]);
    expect(details.pipeEffects.map((each) => each.id)).toContain('lightning');
  });

  it('puts the strip in its safe state once, and sends 40 frames a second in the colours of the palette', () => {
    decor.update({ on: { buis1: true }, effect: { buis1: 'solid' }, palette: { buis1: 'copper' } });
    vi.advanceTimersByTime(1000);
    expect(idled).toEqual(['10.0.0.1']);
    expect(to('10.0.0.1').length).toBeGreaterThanOrEqual(39);
    expect(to('10.0.0.1').length).toBeLessThanOrEqual(42);
    expect(to('10.0.0.2')).toEqual([]);
    // Solid in the first colour, red, on 4 LEDs.
    expect(to('10.0.0.1')[5]?.bytes).toEqual([255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0]);
    decor.update({ on: { buis1: false } });
    decor.update({ on: { buis1: true } });
    expect(idled).toEqual(['10.0.0.1']);
  });

  it('scales the picture by the level, the dimmer of the pipes and the master, and makes it black in a blackout', () => {
    decor.update({ on: { buis1: true }, effect: { buis1: 'solid' }, palette: { buis1: 'copper' } });
    vi.advanceTimersByTime(100);
    decor.update({ level: { buis1: 0.5 } });
    decor.update({ pipesDimmer: 0.5 });
    decor.setMaster(0.5);
    sent.length = 0;
    vi.advanceTimersByTime(100);
    expect(sent.at(-1)?.bytes.slice(0, 3)).toEqual([32, 0, 0]);
    decor.update({ blackout: true });
    vi.advanceTimersByTime(1000);
    expect(sent.at(-1)?.bytes.every((byte) => byte === 0)).toBe(true);
  });

  it('sends a few black frames when a pipe goes dark, and then nothing', () => {
    decor.update({ on: { buis1: true }, effect: { buis1: 'solid' }, palette: { buis1: 'copper' } });
    vi.advanceTimersByTime(200);
    decor.update({ on: { buis1: false } });
    sent.length = 0;
    vi.advanceTimersByTime(1000);
    expect(sent.length).toBe(3);
    expect(sent.every((each) => each.bytes.every((byte) => byte === 0))).toBe(true);
    sent.length = 0;
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([]);
  });

  it('follows the tempo: the same effect at another bpm is another picture at the same moment', () => {
    decor.update({ on: { buis1: true }, effect: { buis1: 'chase' }, palette: { buis1: 'copper' } });
    vi.advanceTimersByTime(2000);
    const slow = sent.at(-1)?.bytes;
    decor.close();
    expect(slow).toBeDefined();
  });

  it('refuses what a pipe that lightdeck draws cannot take', () => {
    expect(() => decor.update({ effect: { buis1: 'Meteor' } })).toThrow(
      /no effect for the pipes called "Meteor"/,
    );
    expect(() => decor.update({ palette: { buis1: 'Ocean' } })).toThrow(
      /no palette called "Ocean"/,
    );
    expect(() => decor.update({ colour: { buis1: { red: 1, green: 1, blue: 1 } } })).toThrow(
      /palette/,
    );
    expect(() => decor.update({ intensity: { buis1: 50 } })).toThrow(/no intensity/);
    expect(() =>
      decor.update({ effect: { buis1: 'flow' }, palette: { buis1: 'white' }, pace: { buis1: 4 } }),
    ).not.toThrow();
  });

  it('a look sets the effect, the palette and the pace and leaves the palette alone when it names none', () => {
    decor.update({ look: { buis1: 'brew' } });
    expect(decor.getState().effect.buis1).toBe('flow');
    expect(decor.getState().palette.buis1).toBe('copper');
    expect(decor.getState().pace.buis1).toBe(2);
    decor.update({ palette: { buis1: 'white' } });
    decor.update({ look: { buis1: 'brew' } });
    expect(decor.getState().palette.buis1).toBe('copper');
  });

  it('says when the strip cannot be reached to be put in its safe state', async () => {
    decor.close();
    const palettes = new PaletteBook();
    palettes.set([COPPER]);
    const failing = new DecorController({
      hass,
      tempo,
      palettes,
      strips: PIPES,
      makeSender: () => ({ send: () => {}, close: () => {} }),
      setIdle: async () => {
        throw new Error('timed out');
      },
    });
    failing.update({ on: { buis1: true } });
    await vi.advanceTimersByTimeAsync(10);
    expect(failing.getState().problems.buis1).toMatch(
      /could not reach the strip at 10.0.0.1: timed out/,
    );
    failing.close();
  });

  describe('finding the address of a strip through Home Assistant', () => {
    let found: DecorController;
    const address = (value: string, available = true) =>
      hass.report('sensor.wled_buis1_ip', { available, on: false, colourModes: [], value });
    beforeEach(() => {
      const palettes = new PaletteBook();
      palettes.set([COPPER]);
      found = new DecorController({
        hass,
        tempo,
        palettes,
        strips: [{ id: 'buis1', label: 'Buis 1', entity: 'light.wled_buis1', leds: 4 }],
        makeSender: (host) => ({
          send: (bytes) => sent.push({ host, bytes: [...bytes] }),
          close: () => closed.push(host),
        }),
        setIdle: async (host) => {
          idled.push(host);
        },
      });
    });
    afterEach(() => found.close());

    it('is drawn by lightdeck by default, waits for an address and says so', () => {
      expect((found.describe() as { strips: { rendered: boolean }[] }).strips[0]?.rendered).toBe(
        true,
      );
      expect(found.getState().hosts.buis1).toBeNull();
      expect(found.getState().problems.buis1).toMatch(/waiting for the address/);
      found.update({
        on: { buis1: true },
        effect: { buis1: 'solid' },
        palette: { buis1: 'copper' },
      });
      vi.advanceTimersByTime(500);
      expect(sent).toEqual([]);
      expect(idled).toEqual([]);
    });

    it('starts when the address arrives, with the safe state first, and clears the problem', () => {
      found.update({
        on: { buis1: true },
        effect: { buis1: 'solid' },
        palette: { buis1: 'copper' },
      });
      vi.advanceTimersByTime(200);
      address('10.0.0.9');
      vi.advanceTimersByTime(300);
      expect(found.getState().hosts.buis1).toBe('10.0.0.9');
      expect(found.getState().problems.buis1).toBeNull();
      expect(idled).toEqual(['10.0.0.9']);
      expect(to('10.0.0.9').length).toBeGreaterThan(5);
    });

    it('does not take what is not an address, and goes on from the new place when it changes', () => {
      address('unavailable', false);
      address('not an address');
      expect(found.getState().hosts.buis1).toBeNull();
      found.update({
        on: { buis1: true },
        effect: { buis1: 'solid' },
        palette: { buis1: 'copper' },
      });
      address('10.0.0.9');
      vi.advanceTimersByTime(200);
      address('10.0.0.10');
      vi.advanceTimersByTime(200);
      expect(closed).toContain('10.0.0.9');
      expect(to('10.0.0.10').length).toBeGreaterThan(3);
      expect(idled).toEqual(['10.0.0.9', '10.0.0.10']);
      // The strip goes away: nothing is sent, and it says it waits.
      address('unavailable', false);
      sent.length = 0;
      vi.advanceTimersByTime(500);
      expect(sent).toEqual([]);
      expect(found.getState().problems.buis1).toMatch(/waiting for the address/);
    });

    it('takes the address of the rig file over the one of Home Assistant', () => {
      const withHost = new DecorController({
        hass,
        tempo,
        strips: [{ id: 'buis1', label: 'Buis 1', entity: 'light.wled_buis1', host: '10.0.0.1' }],
        makeSender: () => ({ send: () => {}, close: () => {} }),
        setIdle: async () => {},
      });
      address('10.0.0.99');
      expect(withHost.getState().hosts.buis1).toBe('10.0.0.1');
      expect(withHost.getState().problems.buis1).toBeNull();
      withHost.close();
    });

    it('refuses a host for a strip that WLED draws, and a bad address entity', () => {
      const make = (extra: object) =>
        new DecorController({
          hass,
          strips: [{ id: 'a', label: 'A', entity: 'light.a', ...extra }],
        });
      expect(() => make({ draw: 'wled', host: '10.0.0.1' })).toThrow(
        /drawn by WLED and has no host/,
      );
      expect(() => make({ ip: 'light.x' })).toThrow(/not a sensor/);
    });
  });

  it('goes dark when lightdeck stops, and closes its senders', () => {
    decor.update({ on: { buis1: true }, effect: { buis1: 'solid' }, palette: { buis1: 'copper' } });
    vi.advanceTimersByTime(200);
    sent.length = 0;
    decor.darken();
    expect(sent.length).toBe(3);
    expect(sent.every((each) => each.bytes.every((byte) => byte === 0))).toBe(true);
    decor.close();
    expect(closed).toEqual(['10.0.0.1']);
  });
});

describe('the pipes linked into one long pipe', () => {
  const PALETTE: Palette = {
    id: 'copper',
    label: 'Copper',
    colours: [
      { red: 1, green: 0, blue: 0, white: 0 },
      { red: 0, green: 0, blue: 1, white: 0 },
      { red: 0, green: 1, blue: 0, white: 0 },
    ],
    mode: 'static',
    change: 'step',
    speed: 1,
  };
  const PIPES: StripDefinition[] = [
    { id: 'a', label: 'A', entity: 'light.wled_a', host: '10.0.0.1', leds: 6 },
    { id: 'b', label: 'B', entity: 'light.wled_b', host: '10.0.0.2', leds: 6 },
    { id: 'c', label: 'C', entity: 'light.wled_c', host: '10.0.0.3', leds: 6 },
  ];
  let tempo: Tempo;
  let sent: { host: string; bytes: number[] }[];
  let made: DecorController[];
  let saved: unknown[];

  const decorOf = (strips: StripDefinition[], setup?: unknown) => {
    const palettes = new PaletteBook();
    palettes.set([PALETTE]);
    const one = new DecorController({
      hass: new RecordingHass(),
      tempo,
      palettes,
      strips,
      makeSender: (host) => ({
        send: (bytes) => sent.push({ host, bytes: [...bytes] }),
        close: () => {},
      }),
      setIdle: async () => {},
      ...(setup ? { setup: setup as never } : {}),
      onSetup: (next) => saved.push(next),
    });
    made.push(one);
    return one;
  };
  const lastOf = (host: string) => sent.filter((each) => each.host === host).at(-1)?.bytes ?? [];
  const leds = (bytes: number[]) =>
    Array.from({ length: bytes.length / 3 }, (_, i) => bytes.slice(i * 3, i * 3 + 3));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    tempo = new Tempo();
    tempo.update({ bpm: 120 });
    sent = [];
    made = [];
    saved = [];
  });
  afterEach(() => {
    for (const one of made) one.close();
    vi.useRealTimers();
  });

  /**
   * A pipe of 18 LEDs that shows the same effect at the same moments as the three of 6 LEDs: the picture that
   * they are cut from. It is told to everything in the same instant so that both draw the same beat.
   */
  function withLongPipe() {
    const reference = decorOf([
      { id: 'long', label: 'Long', entity: 'light.wled_long', host: '10.0.0.9', leds: 18 },
    ]);
    reference.update({ on: { long: true }, effect: { long: 'flow' }, palette: { long: 'copper' } });
    return () => {
      const picture = leds(lastOf('10.0.0.9'));
      expect(new Set(picture.map((led) => led.join())).size).toBeGreaterThan(1);
      return picture;
    };
  }

  it('starts apart, in the order of the rig, nothing reversed', () => {
    const decor = decorOf(PIPES);
    expect(decor.getState()).toMatchObject({
      linked: false,
      order: ['a', 'b', 'c'],
      reverse: { a: false, b: false, c: false },
    });
  });

  it('draws one effect through the pipes, each its piece, in the order of the setup', () => {
    const pictureOfLong = withLongPipe();
    const decor = decorOf(PIPES);
    decor.update({
      linked: true,
      on: { a: true, b: true, c: true },
      effect: { a: 'flow' },
      palette: { a: 'copper' },
    });
    vi.advanceTimersByTime(200);
    const picture = pictureOfLong();
    expect(leds(lastOf('10.0.0.1'))).toEqual(picture.slice(0, 6));
    expect(leds(lastOf('10.0.0.2'))).toEqual(picture.slice(6, 12));
    expect(leds(lastOf('10.0.0.3'))).toEqual(picture.slice(12, 18));
  });

  it('follows the order: the pipe that is first gets the first piece', () => {
    const pictureOfLong = withLongPipe();
    const decor = decorOf(PIPES);
    decor.update({
      linked: true,
      order: ['c', 'a', 'b'],
      on: { a: true, b: true, c: true },
      effect: { a: 'flow' },
      palette: { a: 'copper' },
    });
    vi.advanceTimersByTime(200);
    const picture = pictureOfLong();
    expect(leds(lastOf('10.0.0.3'))).toEqual(picture.slice(0, 6));
    expect(leds(lastOf('10.0.0.1'))).toEqual(picture.slice(6, 12));
    expect(leds(lastOf('10.0.0.2'))).toEqual(picture.slice(12, 18));
  });

  it('turns a pipe round: it gets its piece back to front', () => {
    const pictureOfLong = withLongPipe();
    const decor = decorOf(PIPES);
    decor.update({
      linked: true,
      reverse: { b: true },
      on: { a: true, b: true, c: true },
      effect: { a: 'flow' },
      palette: { a: 'copper' },
    });
    vi.advanceTimersByTime(200);
    const picture = pictureOfLong();
    expect(leds(lastOf('10.0.0.2'))).toEqual(picture.slice(6, 12).reverse());
    expect(leds(lastOf('10.0.0.1'))).toEqual(picture.slice(0, 6));
  });

  it('turns a pipe round that is not linked, too', () => {
    const alone = decorOf([{ ...(PIPES[0] as StripDefinition), host: '10.0.0.9' }]);
    alone.update({ on: { a: true }, effect: { a: 'flow' }, palette: { a: 'copper' } });
    const turned = decorOf([PIPES[0] as StripDefinition]);
    turned.update({
      reverse: { a: true },
      on: { a: true },
      effect: { a: 'flow' },
      palette: { a: 'copper' },
    });
    vi.advanceTimersByTime(200);
    expect(leds(lastOf('10.0.0.1'))).toEqual([...leds(lastOf('10.0.0.9'))].reverse());
  });

  it('keeps a pipe that is off dark, and the effect goes on through its piece', () => {
    const pictureOfLong = withLongPipe();
    const decor = decorOf(PIPES);
    decor.update({
      linked: true,
      on: { a: true, b: false, c: true },
      effect: { a: 'flow' },
      palette: { a: 'copper' },
    });
    vi.advanceTimersByTime(200);
    const picture = pictureOfLong();
    expect(leds(lastOf('10.0.0.3'))).toEqual(picture.slice(12, 18));
    expect(sent.filter((each) => each.host === '10.0.0.2')).toEqual([]);
  });

  it('sets the effect, the palette and the pace of one pipe on all of them while linked', () => {
    const decor = decorOf(PIPES);
    decor.update({ effect: { b: 'shot' }, palette: { b: 'copper' }, pace: { b: 2 } });
    expect(decor.getState().effect).toEqual({ a: null, b: 'shot', c: null });
    decor.update({ linked: true });
    // Come to be linked, they all take what the first shows.
    expect(decor.getState().effect).toEqual({ a: null, b: null, c: null });
    decor.update({ effect: { c: 'bubbles' }, palette: { c: 'copper' }, pace: { c: 0.5 } });
    expect(decor.getState().effect).toEqual({ a: 'bubbles', b: 'bubbles', c: 'bubbles' });
    expect(decor.getState().palette).toEqual({ a: 'copper', b: 'copper', c: 'copper' });
    expect(decor.getState().pace).toEqual({ a: 0.5, b: 0.5, c: 0.5 });
    // On and the level stay with each pipe.
    decor.update({ on: { a: true }, level: { b: 0.5 } });
    expect(decor.getState().on).toEqual({ a: true, b: false, c: false });
    expect(decor.getState().level).toEqual({ a: 1, b: 0.5, c: 1 });
  });

  it('refuses an order or a direction that does not fit the pipes', () => {
    const decor = decorOf(PIPES);
    expect(() => decor.update({ order: ['a', 'b'] })).toThrow(PatchError);
    expect(() => decor.update({ order: ['a', 'a', 'b'] })).toThrow(PatchError);
    expect(() => decor.update({ order: ['a', 'b', 'x'] })).toThrow(PatchError);
    expect(() => decor.update({ reverse: { x: true } })).toThrow(PatchError);
    expect(() => decor.update({ reverse: { a: 1 } })).toThrow(PatchError);
    expect(() => decor.update({ linked: 'yes' })).toThrow(PatchError);
    expect(decor.getState().order).toEqual(['a', 'b', 'c']);
    expect(saved).toEqual([]);
  });

  it('tells what to keep when the linking, the order or a direction changes, and only then', () => {
    const decor = decorOf(PIPES);
    decor.update({ on: { a: true } });
    expect(saved).toEqual([]);
    decor.update({ linked: true });
    decor.update({ order: ['b', 'c', 'a'] });
    decor.update({ reverse: { c: true } });
    decor.update({ reverse: { c: true } });
    expect(saved).toEqual([
      { linked: true, order: ['a', 'b', 'c'], reverse: { a: false, b: false, c: false } },
      { linked: true, order: ['b', 'c', 'a'], reverse: { a: false, b: false, c: false } },
      { linked: true, order: ['b', 'c', 'a'], reverse: { a: false, b: false, c: true } },
    ]);
  });

  it('starts as it was kept, fitted to the pipes there are', () => {
    const decor = decorOf(PIPES, {
      linked: true,
      order: ['c', 'gone', 'a'],
      reverse: { c: true, gone: true },
    });
    expect(decor.getState()).toMatchObject({
      linked: true,
      order: ['c', 'a', 'b'],
      reverse: { a: false, b: false, c: true },
    });
  });

  it('leaves the pipes that WLED draws out of the order', () => {
    const decor = decorOf([
      ...PIPES,
      { id: 'w', label: 'W', entity: 'light.wled_w', draw: 'wled' },
    ]);
    expect(decor.getState().order).toEqual(['a', 'b', 'c']);
    expect(() => decor.update({ reverse: { w: true } })).toThrow(PatchError);
  });
});
