import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Palette, PaletteBook } from '../engine/palette.js';
import { PERIOD_BEATS } from '../engine/roomEffects.js';
import { PatchError } from './fixture.js';
import {
  DEFAULT_FADE,
  type LampDefinition,
  RoomController,
  type RoomState,
  type ZoneDefinition,
} from './roomController.js';
import { Tempo } from './tempo.js';
import { RecordingHass } from './testing.js';

const LAMPS: LampDefinition[] = [
  { id: 'bar', label: 'Bar', entity: 'light.bar' },
  { id: 'shelf', label: 'Shelf', entity: 'light.shelf' },
  { id: 'ceiling', label: 'Ceiling', entity: 'light.ceiling' },
  { id: 'fog', label: 'Fog', entity: 'switch.fog', blackout: true },
  { id: 'heater', label: 'Heater', entity: 'switch.heater' },
];
const ZONES: ZoneDefinition[] = [
  { id: 'low', label: 'Low', lamps: ['bar', 'shelf'] },
  { id: 'high', label: 'High', lamps: ['ceiling'] },
];

const RED = { red: 1, green: 0, blue: 0, white: 0 };
const GREEN = { red: 0, green: 1, blue: 0, white: 0 };
const BLUE = { red: 0, green: 0, blue: 1, white: 0 };
const palette = (
  id: string,
  colours: Palette['colours'],
  extra: Partial<Palette> = {},
): Palette => ({
  id,
  label: id,
  colours,
  mode: 'static',
  change: 'step',
  speed: 1,
  ...extra,
});
const TRIO = palette('trio', [RED, GREEN, BLUE]);
const PAIR = palette('pair', [RED, null]);

/** The command a light gets when it is on with this colour. */
const on = (brightness: number, rgbw: number[], transition: number) => ({
  domain: 'light',
  service: 'turn_on',
  data: { brightness, rgbw_color: rgbw, transition },
});
const off = (transition: number) => ({
  domain: 'light',
  service: 'turn_off',
  data: { transition },
});

describe('RoomController', () => {
  let hass: RecordingHass;
  let palettes: PaletteBook;
  let clock: number;
  let tempo: Tempo;
  let room: RoomController;

  const make = (lamps = LAMPS, zones: ZoneDefinition[] = ZONES) =>
    new RoomController({ hass, tempo, palettes, lamps, zones });

  /** One beat is half a second at 120 bpm. */
  const beats = (n: number) => n * 500;
  const state = (): RoomState => room.getState();
  /** The tempo only stops when it is following the music, which it does while its source is audio. */
  const stopMusic = () => {
    tempo.update({ source: 'audio' });
    tempo.follow({ running: false });
  };
  const startMusic = () => tempo.follow({ running: true });

  beforeEach(() => {
    hass = new RecordingHass();
    palettes = new PaletteBook();
    palettes.set([TRIO, PAIR]);
    clock = 0;
    tempo = new Tempo({ now: () => clock });
    tempo.update({ bpm: 120 });
    room = make();
  });
  afterEach(() => room.close());

  describe('the lamps and zones', () => {
    it('does not touch the lamps when it starts', () => {
      expect(hass.commands).toEqual([]);
    });

    it('says what the room is made of', () => {
      const details = room.describe() as {
        lamps: { id: string; kind: string; zone: string | null; blackout?: boolean }[];
        zones: ZoneDefinition[];
      };
      expect(details.lamps.map((lamp) => [lamp.id, lamp.kind, lamp.zone])).toEqual([
        ['bar', 'light', 'low'],
        ['shelf', 'light', 'low'],
        ['ceiling', 'light', 'high'],
        ['fog', 'switch', null],
        ['heater', 'switch', null],
      ]);
      expect(details.lamps[3]?.blackout).toBe(true);
      expect(details.lamps[4]?.blackout).toBe(false);
      expect(details.zones.map((zone) => zone.id)).toEqual(['low', 'high']);
    });

    it('puts the lights that are in no zone in one of their own, and all of them in one without zones', () => {
      const loose = make(LAMPS, [{ id: 'low', label: 'Low', lamps: ['bar'] }]);
      const zones = (loose.describe() as { zones: ZoneDefinition[] }).zones;
      expect(zones).toEqual([
        { id: 'low', label: 'Low', lamps: ['bar'] },
        { id: 'rest', label: 'The rest', lamps: ['shelf', 'ceiling'] },
      ]);
      loose.close();
      const none = make(LAMPS, []);
      expect((none.describe() as { zones: ZoneDefinition[] }).zones).toEqual([
        { id: 'room', label: 'Room', lamps: ['bar', 'shelf', 'ceiling'] },
      ]);
      none.close();
    });

    it('refuses a room that does not add up', () => {
      const lamp = (id: string, entity: string, extra: Partial<LampDefinition> = {}) => ({
        id,
        label: id,
        entity,
        ...extra,
      });
      expect(() => make([], [])).toThrow(/at least one lamp/);
      expect(() => make([lamp('Bad Id', 'light.a')], [])).toThrow(/cannot name a lamp/);
      expect(() => make([lamp('a', 'light.a'), lamp('a', 'light.b')], [])).toThrow(/two lamps/);
      expect(() => make([lamp('a', 'sensor.a')], [])).toThrow(/not a light or a switch/);
      expect(() => make([lamp('a', 'light.a'), lamp('b', 'light.a')], [])).toThrow(
        /same entity light.a/,
      );
      expect(() => make([lamp('a', 'light.a', { blackout: true })], [])).toThrow(/switch/);
      const zone = (id: string, lamps: string[]) => ({ id, label: id, lamps });
      expect(() => make(LAMPS, [zone('z', ['nope'])])).toThrow(/not a lamp/);
      expect(() => make(LAMPS, [zone('z', ['fog'])])).toThrow(/only lights are in zones/);
      expect(() => make(LAMPS, [zone('a', ['bar']), zone('b', ['bar'])])).toThrow(
        /in the zones "a" and "b"/,
      );
      expect(() => make(LAMPS, [zone('a', ['bar']), zone('a', ['shelf'])])).toThrow(/two zones/);
    });
  });

  describe('setting the room by hand', () => {
    it('turns a level into a command that glides for a second', () => {
      room.update({ levels: { bar: 1 } });
      expect(hass.to('light.bar')).toEqual([on(255, [0, 0, 0, 255], 1)]);
    });

    it('sends only the lamps that change', () => {
      room.update({ levels: { bar: 1, shelf: 0.5 } });
      room.update({ levels: { bar: 1, ceiling: 1 } });
      expect(hass.to('light.bar')).toHaveLength(1);
      expect(hass.to('light.shelf')).toHaveLength(1);
      expect(hass.to('light.ceiling')).toHaveLength(1);
    });

    it('does not send a lamp that is still off, and sends one that goes off', () => {
      room.update({ levels: { shelf: 0 } });
      expect(hass.commands).toEqual([]);
      room.update({ levels: { shelf: 1 } });
      room.update({ levels: { shelf: 0 } });
      expect(hass.to('light.shelf')).toEqual([on(255, [0, 0, 0, 255], 1), off(1)]);
    });

    it('shows a colour set by hand while there is no palette, with the brightness apart from it', () => {
      room.update({ levels: { bar: 0.5 }, colours: { bar: { red: 0.4, green: 0.2, white: 0 } } });
      // The colour is written at full strength and the brightness is the level times the peak.
      expect(hass.to('light.bar')).toEqual([on(51, [255, 128, 0, 0], 1)]);
    });

    it('keeps the colours of the lamps apart, and all of them white to start with', () => {
      expect(state().colours.bar).toEqual({ red: 0, green: 0, blue: 0, white: 1 });
      room.update({ colours: { bar: { red: 1 } } });
      expect(state().colours.bar).toEqual({ red: 1, green: 0, blue: 0, white: 1 });
      expect(state().colours.shelf).toEqual({ red: 0, green: 0, blue: 0, white: 1 });
    });

    it('switches a switch on and off', () => {
      room.update({ levels: { heater: 1 } });
      room.update({ levels: { heater: 0 } });
      expect(hass.to('switch.heater')).toEqual([
        { domain: 'switch', service: 'turn_on' },
        { domain: 'switch', service: 'turn_off' },
      ]);
    });

    it('clamps levels and tells the listeners who made the change', () => {
      const seen: { state: RoomState; origin: string | undefined }[] = [];
      room.on('state', (next, origin) => seen.push({ state: next as RoomState, origin }));
      room.update({ levels: { bar: 7, shelf: -2 } }, 'tablet');
      expect(state().levels.bar).toBe(1);
      expect(state().levels.shelf).toBe(0);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.origin).toBe('tablet');
    });

    it('applies nothing when part of a change is invalid', () => {
      const bad: unknown[] = [
        { levels: { bar: 1, nope: 1 } },
        { levels: { bar: 'full' } },
        { colours: { fog: { red: 1 } } },
        { colours: { bar: { purple: 1 } } },
        { colours: { bar: { red: 'much' } } },
        { fade: -1 },
        { fade: 61 },
        { effect: { id: 'kick' } },
        { effect: { speed: 3 } },
        { colour: { palette: 'nope' } },
        { colour: { speed: 3 } },
        { nonsense: true },
        'levels',
      ];
      for (const patch of bad) {
        expect(() => room.update({ levels: { bar: 0.5 }, ...(patch as object) })).toThrow(
          PatchError,
        );
        expect(() => room.update(patch)).toThrow(PatchError);
      }
      expect(state().levels.bar).toBe(0);
      expect(hass.commands).toEqual([]);
    });

    it('has nothing to do by name', () => {
      expect(() => room.act('reset')).toThrow(PatchError);
    });
  });

  describe('the blackout and the master', () => {
    beforeEach(() => {
      room.update({ levels: { bar: 1, shelf: 1, ceiling: 1, fog: 1, heater: 1 } });
      hass.commands = [];
    });

    it('turns the lights off at once and urgently, and leaves a switch that does not follow', () => {
      room.setBlackout(true);
      expect(hass.commands.map((sent) => [sent.entity, sent.urgent])).toEqual([
        ['light.bar', true],
        ['light.shelf', true],
        ['light.ceiling', true],
        ['switch.fog', true],
      ]);
      expect(hass.to('light.bar')).toEqual([off(0)]);
      expect(hass.to('switch.fog')).toEqual([{ domain: 'switch', service: 'turn_off' }]);
      expect(hass.to('switch.heater')).toEqual([]);
    });

    it('brings the room back in a second, to what it is set to', () => {
      room.setBlackout(true);
      hass.commands = [];
      room.setBlackout(false);
      expect(hass.to('light.bar')).toEqual([on(255, [0, 0, 0, 255], 1)]);
      expect(hass.to('switch.fog')).toEqual([{ domain: 'switch', service: 'turn_on' }]);
      expect(hass.commands.every((sent) => !sent.urgent)).toBe(true);
    });

    it('keeps the state while it is dark', () => {
      room.setBlackout(true);
      expect(state().levels.bar).toBe(1);
      room.update({ levels: { bar: 0.5 } });
      expect(hass.to('light.bar')).toEqual([off(0)]);
      room.setBlackout(false);
      expect(hass.to('light.bar')[1]).toEqual(on(128, [0, 0, 0, 255], 1));
    });

    it('does nothing when the blackout is already as it was', () => {
      room.setBlackout(false);
      expect(hass.commands).toEqual([]);
    });

    it('scales the lights by the master and a switch that follows goes off at 0', () => {
      room.setMaster(0.5);
      expect(hass.to('light.bar')).toEqual([on(128, [0, 0, 0, 255], 1)]);
      expect(hass.to('switch.fog')).toEqual([]);
      room.setMaster(0);
      expect(hass.to('light.bar')[1]).toEqual(off(1));
      expect(hass.to('switch.fog')).toEqual([{ domain: 'switch', service: 'turn_off' }]);
      expect(hass.to('switch.heater')).toEqual([]);
      room.setMaster(1);
      expect(hass.to('switch.fog')[1]).toEqual({ domain: 'switch', service: 'turn_on' });
    });

    it('does not change what is set', () => {
      room.setMaster(0.2);
      expect(state().levels.bar).toBe(1);
    });
  });

  describe('the switch of a zone', () => {
    beforeEach(() => {
      room.update({ levels: { bar: 1, shelf: 1, ceiling: 1, fog: 1 } });
      hass.commands = [];
    });

    it('has every zone on at the start', () => {
      expect(state().zones).toEqual({ low: 1, high: 1 });
    });

    it('switches the lights of that zone off and leaves the others, and a switch', () => {
      room.update({ zones: { low: 0 } });
      expect(hass.to('light.bar')).toEqual([off(1)]);
      expect(hass.to('light.shelf')).toEqual([off(1)]);
      expect(hass.to('light.ceiling')).toEqual([]);
      expect(hass.to('switch.fog')).toEqual([]);
      expect(state().zones).toEqual({ low: 0, high: 1 });
    });

    it('brings them back to what is set, and sends nothing for a zone that does not change', () => {
      room.update({ zones: { low: 0 } });
      hass.commands = [];
      room.update({ zones: { low: 1 } });
      expect(hass.to('light.bar')).toEqual([on(255, [0, 0, 0, 255], 1)]);
      expect(hass.to('light.ceiling')).toEqual([]);
      hass.commands = [];
      room.update({ zones: { low: 1 } });
      expect(hass.commands).toEqual([]);
    });

    it('is not undone by a scene, a look, an effect or a palette', () => {
      room.update({ zones: { low: 0 } });
      hass.commands = [];
      room.recall('lights', {
        levels: { bar: 1, shelf: 0.5, ceiling: 1 },
        effect: { id: 'still' },
      });
      room.recall('colour', { colour: { palette: 'trio' } });
      room.recall('lights', {});
      room.recall('lights', { levels: { bar: 1, shelf: 1 } });
      expect(state().zones.low).toBe(0);
      // Whatever was sent to the lamps of the zone was to switch them off, and nothing lit them.
      for (const sent of [...hass.to('light.bar'), ...hass.to('light.shelf')]) {
        expect(sent.service).toBe('turn_off');
      }
    });

    it('is no part of a scene: it is not kept, and a scene that names it is refused', () => {
      room.update({ zones: { low: 0 } });
      expect(room.snapshot('lights')).not.toHaveProperty('zones');
      expect(() => room.check('lights', { zones: { low: 1 } })).toThrow(/part of no scene/);
      expect(() => room.recall('lights', { zones: { low: 1 } })).toThrow(/part of no scene/);
    });

    it('goes together with the dimmer, the master and the level, and the blackout', () => {
      room.update({ dimmer: 0.5, zones: { high: 0 } });
      expect(hass.to('light.bar').at(-1)).toEqual(on(128, [0, 0, 0, 255], 1));
      expect(hass.to('light.ceiling').at(-1)).toEqual(off(1));
      room.setBlackout(true);
      room.setBlackout(false);
      expect(hass.to('light.ceiling').at(-1)).toEqual(off(1));
      room.update({ zones: { high: 1 } });
      expect(hass.to('light.ceiling').at(-1)).toEqual(on(128, [0, 0, 0, 255], 1));
    });

    it('lets an effect go on under a zone that is off', () => {
      room.update({ zones: { low: 0 } });
      room.recall('colour', { colour: { palette: 'trio' } });
      room.update({ effect: { id: 'rotate' } });
      hass.commands = [];
      clock = beats(PERIOD_BEATS);
      room.render(clock);
      expect(hass.to('light.bar')).toEqual([]);
      room.update({ zones: { low: 1 } });
      expect(hass.to('light.bar').at(-1)?.service).toBe('turn_on');
    });

    it('refuses a zone that is not there, and what is not a number', () => {
      expect(() => room.update({ zones: { ghost: 0 } })).toThrow(
        'there is no zone called "ghost", the zones are low, high',
      );
      expect(() => room.update({ zones: { low: 'off' } })).toThrow(/between 0 and 1/);
      expect(() => room.update({ zones: { low: null } })).toThrow(/between 0 and 1/);
      expect(() => room.update({ zones: [] })).toThrow(PatchError);
      room.update({ zones: { low: 5 } });
      expect(state().zones.low).toBe(1);
      room.update({ zones: { low: -2 } });
      expect(state().zones.low).toBe(0);
    });
  });

  describe('the dimmer of the room', () => {
    beforeEach(() => {
      room.update({ levels: { bar: 1, shelf: 0.5, ceiling: 1, fog: 1, heater: 1 } });
      hass.commands = [];
    });

    it('starts at full', () => {
      expect(state().dimmer).toBe(1);
    });

    it('scales every light, glides for a second and leaves a switch alone', () => {
      room.update({ dimmer: 0.5 });
      expect(hass.to('light.bar')).toEqual([on(128, [0, 0, 0, 255], 1)]);
      expect(hass.to('light.shelf')).toEqual([on(64, [0, 0, 0, 255], 1)]);
      expect(hass.to('switch.fog')).toEqual([]);
      expect(hass.to('switch.heater')).toEqual([]);
    });

    it('goes together with the master', () => {
      room.update({ dimmer: 0.5 });
      room.setMaster(0.5);
      expect(hass.to('light.bar').at(-1)).toEqual(on(64, [0, 0, 0, 255], 1));
      room.setMaster(1);
      room.update({ dimmer: 1 });
      expect(hass.to('light.bar').at(-1)).toEqual(on(255, [0, 0, 0, 255], 1));
    });

    it('puts the lights out at 0, and brings them back', () => {
      room.update({ dimmer: 0 });
      expect(hass.to('light.bar')).toEqual([off(1)]);
      room.update({ dimmer: 0.25 });
      expect(hass.to('light.bar').at(-1)).toEqual(on(64, [0, 0, 0, 255], 1));
    });

    it('is no part of a scene: a scene does not move it and does not keep it', () => {
      room.update({ dimmer: 0.3 });
      expect(room.snapshot('lights')).not.toHaveProperty('dimmer');
      room.recall('lights', { levels: { bar: 1 } });
      expect(state().dimmer).toBe(0.3);
      expect(() => room.check('lights', { dimmer: 0.5 })).toThrow(/part of no scene/);
      expect(() => room.recall('lights', { dimmer: 0.5 })).toThrow(/part of no scene/);
    });

    it('refuses what is not a number, and keeps it between 0 and 1', () => {
      expect(() => room.update({ dimmer: 'half' })).toThrow(/dimmer/);
      expect(() => room.update({ dimmer: null })).toThrow(/dimmer/);
      room.update({ dimmer: 7 });
      expect(state().dimmer).toBe(1);
      room.update({ dimmer: -1 });
      expect(state().dimmer).toBe(0);
    });

    it('is not reset by the blackout', () => {
      room.update({ dimmer: 0.5 });
      room.setBlackout(true);
      room.setBlackout(false);
      expect(state().dimmer).toBe(0.5);
      expect(hass.to('light.bar').at(-1)).toEqual(on(128, [0, 0, 0, 255], 1));
    });
  });

  describe('palettes', () => {
    beforeEach(() => {
      room.update({ levels: { bar: 1, shelf: 1, ceiling: 1 } });
      hass.commands = [];
    });

    it('shows the first colour of the palette on every light', () => {
      room.recall('colour', { colour: { palette: 'trio' } });
      expect(hass.to('light.bar')).toEqual([on(255, [255, 0, 0, 0], DEFAULT_FADE)]);
      expect(hass.to('light.shelf')).toEqual([on(255, [255, 0, 0, 0], DEFAULT_FADE)]);
      expect(hass.to('light.ceiling')).toEqual([on(255, [255, 0, 0, 0], DEFAULT_FADE)]);
    });

    it('keeps a lamp dark that is off, however it is coloured', () => {
      room.update({ levels: { shelf: 0 } });
      hass.commands = [];
      room.recall('colour', { colour: { palette: 'trio' } });
      expect(hass.to('light.shelf')).toEqual([]);
    });

    it('puts a first slot that is off in the dark', () => {
      palettes.set([TRIO, palette('dark-first', [null, RED])]);
      room.recall('colour', { colour: { palette: 'dark-first' } });
      expect(hass.to('light.bar')).toEqual([off(DEFAULT_FADE)]);
    });

    it('goes back to the colours by hand without one', () => {
      room.update({ colours: { bar: { red: 0, green: 1, white: 0 } } });
      room.recall('colour', { colour: { palette: 'trio' } });
      hass.commands = [];
      room.recall('colour', undefined);
      expect(hass.to('light.bar')).toEqual([on(255, [0, 255, 0, 0], DEFAULT_FADE)]);
      expect(state().colour).toEqual({ palette: null, speed: null });
    });

    it('does not let a switch take a colour', () => {
      expect(() => room.update({ colours: { fog: { red: 1 } } })).toThrow(/switch/);
    });
  });

  describe('the effects', () => {
    beforeEach(() => {
      room.update({ levels: { bar: 1, shelf: 1, ceiling: 1 } });
      room.recall('colour', { colour: { palette: 'trio' } });
    });

    const colourOf = (entity: string): number[] => {
      const last = hass.to(entity).at(-1);
      return ((last?.data as { rgbw_color?: number[] })?.rgbw_color ?? []).slice(0, 3);
    };

    it('wants frames only while an effect is chosen and the tempo runs', () => {
      expect(room.wantsFrames()).toBe(false);
      room.update({ effect: { id: 'rotate' } });
      expect(room.wantsFrames()).toBe(true);
      stopMusic();
      expect(room.wantsFrames()).toBe(false);
      startMusic();
      room.update({ effect: { id: null } });
      expect(room.wantsFrames()).toBe(false);
    });

    it('spreads the colours over the lights when an effect is chosen', () => {
      room.update({ effect: { id: 'still' } });
      expect(colourOf('light.bar')).toEqual([255, 0, 0]);
      expect(colourOf('light.shelf')).toEqual([0, 255, 0]);
      expect(colourOf('light.ceiling')).toEqual([0, 0, 255]);
    });

    it('moves the colours on one lamp after twenty beats, over the fade', () => {
      room.update({ effect: { id: 'rotate' } });
      const from = hass.commands.length;
      room.render(beats(PERIOD_BEATS - 1));
      expect(hass.commands.slice(from)).toEqual([]);
      clock = beats(PERIOD_BEATS);
      room.render(clock);
      expect(colourOf('light.bar')).toEqual([0, 255, 0]);
      expect(colourOf('light.shelf')).toEqual([0, 0, 255]);
      expect(colourOf('light.ceiling')).toEqual([255, 0, 0]);
      expect(hass.to('light.bar').at(-1)).toEqual(on(255, [0, 255, 0, 0], DEFAULT_FADE));
    });

    it('sends nothing on frames inside a period', () => {
      room.update({ effect: { id: 'rotate' } });
      const from = hass.commands.length;
      for (let frame = 0; frame < PERIOD_BEATS * 25; frame++) room.render(beats(frame / 25));
      expect(hass.commands.slice(from)).toEqual([]);
    });

    it('goes a step further for each period, and in a ÷2 speed takes twice as long', () => {
      room.update({ effect: { id: 'rotate', speed: 0.5 } });
      const from = hass.commands.length;
      clock = beats(PERIOD_BEATS);
      room.render(clock);
      expect(hass.commands.slice(from)).toEqual([]);
      clock = beats(2 * PERIOD_BEATS);
      room.render(clock);
      expect(colourOf('light.bar')).toEqual([0, 255, 0]);
    });

    it('gives the lights of a zone one colour with the zones effect', () => {
      room.update({ effect: { id: 'zones' } });
      expect(colourOf('light.bar')).toEqual([255, 0, 0]);
      expect(colourOf('light.shelf')).toEqual([255, 0, 0]);
      expect(colourOf('light.ceiling')).toEqual([0, 255, 0]);
    });

    it('never touches a switch', () => {
      room.update({ levels: { heater: 1 }, effect: { id: 'rotate' } });
      clock = beats(PERIOD_BEATS);
      room.render(clock);
      expect(hass.to('switch.heater')).toEqual([{ domain: 'switch', service: 'turn_on' }]);
    });

    it('tells the page the colours it sends, and when a step moves them', () => {
      room.update({ effect: { id: 'rotate' } });
      expect(state().shown.bar).toEqual({ red: 1, green: 0, blue: 0, white: 0 });
      expect(state().shown.shelf).toEqual({ red: 0, green: 1, blue: 0, white: 0 });
      expect(state().shown.fog).toBeUndefined();
      const seen: RoomState[] = [];
      room.on('state', (next) => seen.push(next as RoomState));
      room.render(beats(1));
      expect(seen).toHaveLength(0);
      clock = beats(PERIOD_BEATS);
      room.render(clock);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.shown.bar).toEqual({ red: 0, green: 1, blue: 0, white: 0 });
    });

    it('keeps the picture while the music has stopped', () => {
      room.update({ effect: { id: 'rotate' } });
      clock = beats(PERIOD_BEATS);
      room.render(clock);
      stopMusic();
      clock = beats(5 * PERIOD_BEATS);
      room.update({ levels: { bar: 0.5 } });
      expect(colourOf('light.bar')).toEqual([0, 255, 0]);
    });

    it('dims with the level and the master', () => {
      room.update({ effect: { id: 'still' }, levels: { shelf: 0.5 } });
      room.setMaster(0.5);
      expect(hass.to('light.shelf').at(-1)).toEqual(on(64, [0, 255, 0, 0], 1));
    });

    it('steps through a cycling palette once per period, and not in between', () => {
      palettes.set([palette('cycle', [RED, GREEN, BLUE], { mode: 'cycle', speed: 1 })]);
      room.recall('colour', { colour: { palette: 'cycle' } });
      expect(room.wantsFrames()).toBe(true);
      clock = beats(1);
      room.render(clock);
      expect(colourOf('light.bar')).toEqual([255, 0, 0]);
      clock = beats(PERIOD_BEATS - 1);
      room.render(clock);
      expect(colourOf('light.bar')).toEqual([255, 0, 0]);
      clock = beats(PERIOD_BEATS);
      room.render(clock);
      expect(colourOf('light.bar')).toEqual([0, 255, 0]);
      clock = beats(2 * PERIOD_BEATS);
      room.render(clock);
      expect(colourOf('light.bar')).toEqual([0, 0, 255]);
    });

    it('steps a palette that fades as hard as any other: one command per lamp per period', () => {
      palettes.set([
        palette('fader', [RED, GREEN, BLUE], { mode: 'cycle', change: 'fade', speed: 1 }),
      ]);
      room.update({ levels: { bar: 1 } });
      room.recall('colour', { colour: { palette: 'fader' } });
      hass.commands = [];
      for (let beat = 0; beat < PERIOD_BEATS; beat += 0.25) {
        clock = beats(beat);
        room.render(clock);
      }
      expect(hass.to('light.bar')).toEqual([]);
      clock = beats(PERIOD_BEATS);
      room.render(clock);
      expect(hass.to('light.bar')).toHaveLength(1);
    });

    it('moves the palette by its speed against the period, not by the pace of the palette', () => {
      palettes.set([palette('cycle', [RED, GREEN, BLUE], { mode: 'cycle', speed: 4 })]);
      room.recall('colour', { colour: { palette: 'cycle', speed: 2 } });
      clock = beats(PERIOD_BEATS / 2 - 1);
      room.render(clock);
      expect(colourOf('light.bar')).toEqual([255, 0, 0]);
      clock = beats(PERIOD_BEATS / 2);
      room.render(clock);
      expect(colourOf('light.bar')).toEqual([0, 255, 0]);
    });
  });

  describe('scenes', () => {
    it('keeps the lamps that are on, the fade and the effect in a scene of lights', () => {
      room.update({
        levels: { bar: 1, shelf: 0.5, fog: 1 },
        fade: 5,
        effect: { id: 'shuffle', speed: 0.5 },
      });
      expect(room.snapshot('lights')).toEqual({
        levels: { bar: 1, shelf: 0.5, fog: 1 },
        fade: 5,
        effect: { id: 'shuffle', speed: 0.5 },
      });
    });

    it('leaves out what is at rest', () => {
      expect(room.snapshot('lights')).toEqual({});
      expect(room.snapshot('colour')).toEqual({});
      expect(room.snapshot('motion')).toEqual({});
      room.update({ levels: { bar: 1 }, colours: { bar: { red: 1 } } });
      expect(room.snapshot('lights')).toEqual({ levels: { bar: 1 } });
    });

    it('keeps a palette as the colour, with the pace when it has one, and no motion', () => {
      room.recall('colour', { colour: { palette: 'trio', speed: 0.5 } });
      expect(room.snapshot('colour')).toEqual({ colour: { palette: 'trio', speed: 0.5 } });
      expect(room.snapshot('motion')).toEqual({});
    });

    it('sets a scene back as it was stored', () => {
      room.update({ levels: { bar: 1, fog: 1 }, fade: 5, effect: { id: 'rotate' } });
      const part = room.snapshot('lights');
      room.recall('lights', undefined);
      expect(room.snapshot('lights')).toEqual({});
      room.recall('lights', part);
      expect(room.snapshot('lights')).toEqual(part);
    });

    it('switches off a lamp and a switch that the scene does not name', () => {
      room.update({ levels: { bar: 1, shelf: 1, fog: 1, heater: 1 } });
      hass.commands = [];
      room.recall('lights', { levels: { bar: 1 } });
      expect(hass.to('light.bar')).toEqual([]);
      expect(hass.to('light.shelf')).toEqual([off(DEFAULT_FADE)]);
      expect(hass.to('switch.fog')).toEqual([{ domain: 'switch', service: 'turn_off' }]);
      expect(hass.to('switch.heater')).toEqual([{ domain: 'switch', service: 'turn_off' }]);
    });

    it('brings the lamps in over the fade of the scene', () => {
      room.recall('lights', { levels: { bar: 1, shelf: 1 }, fade: 7 });
      expect(hass.to('light.bar')).toEqual([on(255, [0, 0, 0, 255], 7)]);
      expect(hass.to('light.shelf')).toEqual([on(255, [0, 0, 0, 255], 7)]);
    });

    it('goes to the usual fade when the scene has none', () => {
      room.update({ fade: 9 });
      room.recall('lights', { levels: { bar: 1 } });
      expect(state().fade).toBe(DEFAULT_FADE);
    });

    it('leaves the colour alone when lights are recalled, and the lights when a colour is', () => {
      room.recall('lights', { levels: { bar: 1 } });
      room.recall('colour', { colour: { palette: 'trio' } });
      expect(state().levels.bar).toBe(1);
      room.recall('lights', undefined);
      expect(state().colour.palette).toBe('trio');
    });

    it('refuses a part of another type, a lamp it does not have and colours by hand', () => {
      expect(() => room.check('lights', { colour: { palette: 'trio' } })).toThrow(
        /not part of a lights scene/,
      );
      expect(() => room.check('colour', { levels: { bar: 1 } })).toThrow(
        /not part of a colour scene/,
      );
      expect(() => room.check('motion', { levels: { bar: 1 } })).toThrow(PatchError);
      expect(() => room.check('lights', { levels: { nope: 1 } })).toThrow(PatchError);
      expect(() => room.check('lights', { colours: { bar: { red: 1 } } })).toThrow(
        /part of no scene/,
      );
      expect(() => room.check('colour', { colour: { palette: 'nope' } })).toThrow(
        /unknown palette/,
      );
      expect(() => room.check('lights', { levels: { bar: 1 } })).not.toThrow();
      expect(() => room.check('lights', undefined)).not.toThrow();
    });

    it('changes nothing when a recall is refused', () => {
      room.update({ levels: { bar: 1 } });
      hass.commands = [];
      expect(() => room.recall('lights', { levels: { nope: 1 } })).toThrow(PatchError);
      expect(state().levels.bar).toBe(1);
      expect(hass.commands).toEqual([]);
    });

    it('sets a lamp again that Home Assistant has turned off, also for the same scene', () => {
      room.recall('lights', { levels: { bar: 1, shelf: 1 } });
      hass.report('light.bar', { available: true, on: true, colourModes: ['rgbw'] });
      hass.report('light.shelf', { available: true, on: true, colourModes: ['rgbw'] });
      hass.commands = [];
      // Somebody turned the shelf off in the Home Assistant app.
      hass.report('light.shelf', { available: true, on: false, colourModes: ['rgbw'] });
      expect(hass.commands).toEqual([]);
      room.recall('lights', { levels: { bar: 1, shelf: 1 } });
      expect(hass.commands.map((sent) => sent.entity)).toEqual(['light.shelf']);
    });
  });

  describe('what Home Assistant says', () => {
    it('shows what it reports and never changes what is set', () => {
      room.update({ levels: { bar: 1 } });
      const seen: RoomState[] = [];
      room.on('state', (next) => seen.push(next as RoomState));
      hass.report('light.bar', { available: true, on: false, colourModes: ['rgbw'] });
      expect(state().reported.bar).toEqual({ available: true, on: false, colourModes: ['rgbw'] });
      expect(state().levels.bar).toBe(1);
      expect(seen).toHaveLength(1);
      hass.report('light.bar', { available: true, on: false, colourModes: ['rgbw'] });
      expect(seen).toHaveLength(1);
    });

    it('does not set a lamp again because it differs', () => {
      room.update({ levels: { bar: 1 } });
      hass.commands = [];
      hass.report('light.bar', { available: true, on: false, colourModes: ['rgbw'] });
      hass.report('light.bar', { available: false, on: false, colourModes: ['rgbw'] });
      expect(hass.commands).toEqual([]);
    });

    it('sends a lamp that is on its look in the colour mode it has told', () => {
      room.update({ levels: { bar: 1 }, colours: { bar: { red: 1, white: 0 } } });
      hass.commands = [];
      hass.report('light.bar', { available: true, on: true, colourModes: ['xy', 'color_temp'] });
      expect(hass.to('light.bar')).toEqual([
        {
          domain: 'light',
          service: 'turn_on',
          data: { brightness: 255, rgb_color: [255, 0, 0], transition: 1 },
        },
      ]);
    });

    it('does not send anything to a lamp that is off when it reports', () => {
      hass.report('light.bar', { available: true, on: false, colourModes: ['xy'] });
      expect(hass.commands).toEqual([]);
    });

    it('shows why a command did not arrive, and forgets it when the next one does', () => {
      hass.complain('light.bar', 'entity not found');
      expect(state().problems.bar).toBe('entity not found');
      hass.complain('light.bar', null);
      expect(state().problems.bar).toBeNull();
    });

    it('keeps the colour modes of a light that becomes unavailable', () => {
      hass.report('light.bar', { available: true, on: true, colourModes: ['xy'] });
      hass.report('light.bar', { available: false, on: false, colourModes: [] });
      expect(state().reported.bar).toEqual({ available: false, on: false, colourModes: ['xy'] });
    });

    it('knows what was reported before it started', () => {
      room.close();
      hass.report('light.bar', { available: true, on: true, colourModes: ['rgb'] });
      room = make();
      expect(state().reported.bar?.colourModes).toEqual(['rgb']);
    });
  });

  it('stays as it is when lightdeck stops', () => {
    room.update({ levels: { bar: 1 } });
    hass.commands = [];
    room.darken();
    expect(hass.commands).toEqual([]);
  });

  it('stops listening to Home Assistant when it is closed', () => {
    room.close();
    hass.report('light.bar', { available: true, on: true, colourModes: [] });
    expect(room.getState().reported.bar).toBeNull();
  });
});
