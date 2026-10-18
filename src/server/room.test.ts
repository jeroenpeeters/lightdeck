/**
 * The room in the rig: a fixture that Home Assistant drives, next to the spider and the laser
 * that DMX drives. What the rig, the playback and the HTTP side do with it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAnimated } from './engine.js';
import { createHttpServer } from './http.js';
import { type FixtureDefinition, Rig } from './rig.js';
import type { RoomState } from './roomController.js';
import { ch, RecordingHass, RecordingOutput } from './testing.js';

const SPIDER: FixtureDefinition = {
  id: 'spider',
  kind: 'spider',
  label: 'Spider',
  universe: 0,
  address: 1,
};
const ROOM: FixtureDefinition = {
  id: 'room',
  kind: 'room',
  label: 'Room Lights',
  lamps: [
    { id: 'bar', label: 'Bar', entity: 'light.bar' },
    { id: 'shelf', label: 'Shelf', entity: 'light.shelf' },
    { id: 'fog', label: 'Fog', entity: 'switch.fog', blackout: true },
  ],
  zones: [{ id: 'low', label: 'Low', lamps: ['bar', 'shelf'] }],
};

describe('a rig with the room', () => {
  let dir: string;
  let output: RecordingOutput;
  let hass: RecordingHass;
  let rig: Rig;

  const start = (fixtures: FixtureDefinition[] = [SPIDER, ROOM]) => {
    rig = new Rig({
      output,
      hass,
      fixtures,
      show: join(dir, 'show.yaml'),
    });
    return rig;
  };
  const room = () => rig.find('room')?.controller;
  const roomState = () => room()?.getState() as RoomState;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lightdeck-room-'));
    output = new RecordingOutput();
    hass = new RecordingHass();
    start();
  });
  afterEach(() => {
    rig.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('the rig', () => {
    it('holds a fixture of each protocol', () => {
      expect(rig.fixtures.map((fixture) => [fixture.id, fixture.protocol])).toEqual([
        ['spider', 'dmx'],
        ['room', 'hass'],
      ]);
    });

    it('does not put the room on a universe', () => {
      room()?.update({ levels: { bar: 1 } });
      // The universe holds the spider only; the first frame is its dark one.
      expect(output.frames.every((frame) => frame.data.every((byte) => byte === 0))).toBe(true);
    });

    it('tells about a change of the room without bytes, and about the spider with', () => {
      const seen: [string, boolean][] = [];
      rig.on('fixture', (id: string, _state: unknown, dmx: number[] | undefined) =>
        seen.push([id, dmx !== undefined]),
      );
      room()?.update({ levels: { bar: 1 } });
      rig.find('spider')?.controller.update({ levels: { dimmer: 1 } });
      expect(seen).toEqual([
        ['room', false],
        ['spider', true],
      ]);
    });

    it('has frames only for the fixtures on DMX', () => {
      const frames: string[] = [];
      rig.on('frame', (id: string) => frames.push(id));
      rig.find('spider')?.controller.update({ effect: { id: 'chase' } });
      rig.engine.close();
      expect(frames.every((id) => id === 'spider')).toBe(true);
    });

    it('gives the room the blackout and the master', () => {
      room()?.update({ levels: { bar: 1, shelf: 1, fog: 1 } });
      hass.commands = [];
      rig.setBlackout(true);
      expect(hass.to('light.bar')).toHaveLength(1);
      expect(hass.to('light.bar')[0]?.service).toBe('turn_off');
      expect(hass.to('switch.fog')[0]?.service).toBe('turn_off');
      rig.setBlackout(false);
      hass.commands = [];
      rig.setMaster(0.5);
      expect(
        (hass.to('light.bar')[0]?.data as { brightness: number } | undefined)?.brightness,
      ).toBe(128);
    });

    it('stays as it is when lightdeck stops', () => {
      room()?.update({ levels: { bar: 1 } });
      hass.commands = [];
      rig.darken();
      expect(hass.commands).toEqual([]);
    });

    it('has the engine ask the room for frames while an effect runs', () => {
      const controller = room();
      expect(isAnimated(controller)).toBe(true);
      if (!isAnimated(controller)) return;
      expect(controller.wantsFrames()).toBe(false);
      rig.playback.setPalette('room', 'rainbow');
      room()?.update({ levels: { bar: 1 }, effect: { id: 'rotate' } });
      expect(controller.wantsFrames()).toBe(true);
    });
  });

  describe('the link to Home Assistant', () => {
    it('has none to show without a fixture that it drives', () => {
      rig.close();
      start([SPIDER]);
      expect(rig.getStatus().hass).toBeUndefined();
      rig.setHassStatus('connected');
      expect(rig.getStatus().hass).toBeUndefined();
    });

    it('starts down and follows what the client says', () => {
      expect(rig.getStatus().hass).toBe('down');
      const seen: unknown[] = [];
      rig.on('status', (status) => seen.push(status));
      rig.setHassStatus('connected');
      rig.setHassStatus('connected');
      rig.setHassStatus('refused');
      expect(rig.getStatus().hass).toBe('refused');
      expect(seen).toHaveLength(2);
    });

    it('keeps it when the bridge goes away', () => {
      rig.setHassStatus('connected');
      rig.setBridgeConnected(true);
      rig.setBridgeConnected(false);
      expect(rig.getStatus().hass).toBe('connected');
    });
  });

  describe('what it refuses', () => {
    const make =
      (...fixtures: FixtureDefinition[]) =>
      () =>
        new Rig({ output, hass, fixtures, show: join(dir, 'other.yaml') });

    it('a room without a connection to Home Assistant', () => {
      expect(() => new Rig({ output, fixtures: [ROOM] })).toThrow(/driven by Home Assistant/);
    });

    it('a lamp that two fixtures both have', () => {
      expect(make(ROOM, { ...ROOM, id: 'room-2' })).toThrow(/light.bar is a lamp of two fixtures/);
    });

    it('a room with a lamp that is no lamp', () => {
      const bad = { ...ROOM, lamps: [{ id: 'bar', label: 'Bar', entity: 'sensor.bar' }] };
      expect(make(bad)).toThrow(/not a light or a switch/);
    });

    it('a fixture on DMX without an address, and a room without lamps', () => {
      expect(make({ id: 'spider', kind: 'spider', label: 'Spider' } as never)).toThrow(
        /needs a universe and an address/,
      );
      expect(make({ id: 'room', kind: 'room', label: 'Room' } as never)).toThrow(/list of lamps/);
    });

    it('lets go of what it made when one fixture fails', () => {
      expect(make(SPIDER, { ...ROOM, lamps: [] })).toThrow(/at least one lamp/);
    });
  });

  describe('the playback', () => {
    const lit = (id: string) => (roomState().levels[id] ?? 0) > 0;

    it('has a group for the room, and all of them in the group of all', () => {
      const groups = rig.playback.getShow().groups;
      expect(groups.map((group) => [group.id, group.fixtures])).toEqual([
        ['spider', ['spider']],
        ['room', ['room']],
        ['all', ['spider', 'room']],
      ]);
    });

    it('stores the lamps that are on as a scene, and sets them again', () => {
      room()?.update({ levels: { bar: 1, shelf: 0.5 } });
      const scene = rig.playback.store('room', 'lights', 'Evening');
      room()?.update({ levels: { bar: 0, shelf: 0, fog: 1 } });
      rig.playback.recall('room', scene);
      expect(roomState().levels).toEqual({ bar: 1, shelf: 0.5, fog: 0 });
    });

    it('sets spider and room together with a scene of the group of all', () => {
      rig.find('spider')?.controller.update({ levels: { dimmer: 0.5 } });
      room()?.update({ levels: { bar: 1, fog: 1 } });
      const scene = rig.playback.store('all', 'lights', 'Everything');
      rig.playback.off('all');
      expect(lit('bar')).toBe(false);
      expect(ch(output, 6)).toBe(0);
      rig.playback.recall('all', scene);
      expect(lit('bar')).toBe(true);
      expect(lit('fog')).toBe(true);
      expect(ch(output, 6)).toBe(128);
    });

    it('switches off a lamp and a switch that the scene does not name', () => {
      room()?.update({ levels: { bar: 1 } });
      const scene = rig.playback.store('room', 'lights', 'Bar only');
      room()?.update({ levels: { shelf: 1, fog: 1 } });
      hass.commands = [];
      rig.playback.recall('room', scene);
      expect(lit('shelf')).toBe(false);
      expect(lit('fog')).toBe(false);
      expect(hass.to('light.shelf')[0]?.service).toBe('turn_off');
      expect(hass.to('switch.fog')[0]?.service).toBe('turn_off');
    });

    it('colours the room with a palette pressed on its group, and the spider with it', () => {
      room()?.update({ levels: { bar: 1 } });
      hass.commands = [];
      rig.playback.setPalette('all', 'rainbow');
      expect(roomState().colour.palette).toBe('rainbow');
      expect(rig.find('spider')?.controller.getState()).toMatchObject({
        colour: { palette: 'rainbow' },
      });
      const sent = hass.to('light.bar').at(-1)?.data as { rgbw_color: number[] };
      // The first colour of the rainbow is red.
      expect(sent.rgbw_color.slice(0, 3)).toEqual([255, 0, 0]);
    });

    it('turns the lights of the room off with the off key and leaves its colour', () => {
      room()?.update({ levels: { bar: 1, fog: 1 } });
      rig.playback.setPalette('room', 'rainbow');
      rig.playback.off('room');
      expect(lit('bar')).toBe(false);
      expect(lit('fog')).toBe(false);
      expect(roomState().colour.palette).toBe('rainbow');
    });

    it('shows a scene as changed when a lamp was moved by hand, and not for a report', () => {
      room()?.update({ levels: { bar: 1 } });
      const scene = rig.playback.store('room', 'lights', 'Bar');
      const changed = () => rig.playback.getState().groups.room?.lights.changed;
      expect(changed()).toBe(false);
      hass.report('light.bar', { available: true, on: false, colourModes: ['rgbw'] });
      hass.complain('light.shelf', 'no such entity');
      expect(changed()).toBe(false);
      room()?.update({ levels: { shelf: 1 } });
      expect(changed()).toBe(true);
      rig.playback.recall('room', scene);
      expect(changed()).toBe(false);
    });

    it('presses a look that sets the lights and the colour of the room', () => {
      room()?.update({ levels: { bar: 1, shelf: 1 } });
      const lights = rig.playback.store('room', 'lights', 'Low');
      rig.playback.setPalette('room', 'rainbow');
      const look = rig.playback.storeLook('room', 'Rainbow low');
      room()?.update({ levels: { bar: 0, shelf: 0 } });
      rig.playback.recall('room', lights);
      rig.playback.playLook('room', look);
      expect(lit('bar')).toBe(true);
      expect(roomState().colour.palette).toBe('rainbow');
    });
  });
});

describe('the page of the room', () => {
  let publicDir: string;
  let rig: Rig;
  let server: Server;
  let base: string;
  let hass: RecordingHass;

  beforeEach(async () => {
    publicDir = mkdtempSync(join(tmpdir(), 'lightdeck-room-public-'));
    mkdirSync(join(publicDir, 'fixtures'));
    writeFileSync(join(publicDir, 'fixtures', 'room.html'), '<!doctype html><title>Room</title>');
    writeFileSync(
      join(publicDir, 'fixtures', 'spider.html'),
      '<!doctype html><title>Spider</title>',
    );
    hass = new RecordingHass();
    rig = new Rig({
      output: new RecordingOutput(),
      hass,
      fixtures: [SPIDER, ROOM],
      show: join(publicDir, 'show.yaml'),
    });
    server = createHttpServer({ rig, publicDir, bridgeUrl: null });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    rig.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(publicDir, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  // biome-ignore lint/suspicious/noExplicitAny: shapes are asserted field by field
  const state = async () => (await (await fetch(`${base}/api/state`)).json()) as any;

  it('serves the page of its kind', async () => {
    const page = await fetch(`${base}/fixtures/room`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>Room</title>');
  });

  it('describes the room with its lamps and no bytes', async () => {
    const { fixtures } = await state();
    const room = fixtures.find((fixture: { id: string }) => fixture.id === 'room');
    expect(room).toMatchObject({
      id: 'room',
      kind: 'room',
      label: 'Room Lights',
      protocol: 'hass',
    });
    expect(room.dmx).toBeUndefined();
    expect(room.universe).toBeUndefined();
    expect(room.controls).toBeUndefined();
    expect(room.details.lamps.map((lamp: { id: string }) => lamp.id)).toEqual([
      'bar',
      'shelf',
      'fog',
    ]);
    expect(room.details.zones).toEqual([{ id: 'low', label: 'Low', lamps: ['bar', 'shelf'] }]);
    expect(room.state.levels).toEqual({ bar: 0, shelf: 0, fog: 0 });
    const spider = fixtures.find((fixture: { id: string }) => fixture.id === 'spider');
    expect(spider.protocol).toBe('dmx');
    expect(spider.dmx).toHaveLength(43);
  });

  it('sets the room by the API, and answers a mistake', async () => {
    const done = await post('/api/fixtures/room/update', { levels: { bar: 1 } });
    expect(done.status).toBe(200);
    expect(hass.to('light.bar')).toHaveLength(1);
    const bad = await post('/api/fixtures/room/update', { levels: { nope: 1 } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/no lamp called "nope"/);
    const act = await post('/api/fixtures/room/reset', {});
    expect(act.status).toBe(400);
  });

  it('says how Home Assistant is, in the status', async () => {
    expect((await state()).status.hass).toBe('down');
    rig.setHassStatus('connected');
    expect((await state()).status.hass).toBe('connected');
  });

  it('streams the state of the room without bytes', async () => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (reader && !text.includes('"id":"room"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    controller.abort();
    const line = text.split('\n\n').find((chunk) => chunk.includes('"id":"room"'));
    expect(line).toBeDefined();
    expect(line).not.toContain('"dmx"');
  });
});
