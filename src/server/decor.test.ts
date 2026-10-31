/**
 * The decor in the rig: the two UV switches, a fixture that Home Assistant drives and that no scene
 * keeps. What the rig, the playback and the HTTP side do with it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHttpServer } from './http.js';
import { type FixtureDefinition, Rig } from './rig.js';
import type { SwitchesState } from './switchesController.js';
import { RecordingHass, RecordingOutput } from './testing.js';

const SPIDER: FixtureDefinition = {
  id: 'spider',
  kind: 'spider',
  label: 'Spider',
  universe: 0,
  address: 1,
};
const DECOR: FixtureDefinition = {
  id: 'decor',
  kind: 'switches',
  label: 'Decor',
  switches: [
    { id: 'uv1', label: 'UV 1', entity: 'switch.uv_lamp_1', blackout: true },
    { id: 'uv2', label: 'UV 2', entity: 'switch.uv_lamp_2' },
  ],
};

describe('a rig with the decor', () => {
  let dir: string;
  let hass: RecordingHass;
  let rig: Rig;

  const start = (fixtures: FixtureDefinition[] = [SPIDER, DECOR]) => {
    rig = new Rig({
      output: new RecordingOutput(),
      hass,
      fixtures,
      show: join(dir, 'show.yaml'),
    });
    return rig;
  };
  const decor = () => rig.find('decor')?.controller;
  const decorState = () => decor()?.getState() as SwitchesState;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lightdeck-decor-'));
    hass = new RecordingHass();
    start();
  });
  afterEach(() => {
    rig.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('holds a fixture that Home Assistant drives, and does not touch it at the start', () => {
    expect(rig.fixtures.map((fixture) => [fixture.id, fixture.protocol])).toEqual([
      ['spider', 'dmx'],
      ['decor', 'hass'],
    ]);
    expect(hass.commands).toEqual([]);
  });

  it('refuses an entity that two fixtures have', () => {
    rig.close();
    const room: FixtureDefinition = {
      id: 'room',
      kind: 'room',
      label: 'Room',
      lamps: [{ id: 'uv', label: 'UV', entity: 'switch.uv_lamp_1' }],
    };
    expect(() => start([room, DECOR])).toThrow(/switch.uv_lamp_1 is a lamp of two fixtures/);
  });

  it('has a group of its own, and the group of all holds it', () => {
    const groups = rig.playback.getShow().groups;
    expect(groups.map((group) => [group.id, group.fixtures])).toEqual([
      ['spider', ['spider']],
      ['decor', ['decor']],
      ['all', ['spider', 'decor']],
    ]);
  });

  it('is left alone by a scene of lights, a look and the Off of a group, also of all', () => {
    decor()?.update({ on: { uv1: true, uv2: true } });
    rig.find('spider')?.controller.update({ levels: { dimmer: 0.5 } });
    hass.commands = [];
    const scene = rig.playback.store('all', 'lights', 'Everything');
    rig.playback.off('all');
    rig.playback.recall('all', scene);
    rig.playback.off('decor');
    expect(decorState().on).toEqual({ uv1: true, uv2: true });
    expect(hass.commands).toEqual([]);
  });

  it('does not keep the switches in a scene that is stored', () => {
    decor()?.update({ on: { uv1: true } });
    rig.find('spider')?.controller.update({ levels: { dimmer: 0.5 } });
    rig.playback.store('all', 'lights', 'Everything');
    const stored = JSON.stringify(rig.playback.getShow());
    expect(stored).not.toContain('uv1');
  });

  it('follows the blackout of the console, for the switch that follows it', () => {
    decor()?.update({ on: { uv1: true, uv2: true } });
    hass.commands = [];
    rig.setBlackout(true);
    expect(hass.commands.map((sent) => [sent.entity, sent.command.service, sent.urgent])).toEqual([
      ['switch.uv_lamp_1', 'turn_off', true],
    ]);
    rig.setBlackout(false);
    expect(hass.to('switch.uv_lamp_1').map((command) => command.service)).toEqual([
      'turn_off',
      'turn_on',
    ]);
  });
});

describe('the decor over HTTP', () => {
  let publicDir: string;
  let hass: RecordingHass;
  let rig: Rig;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    publicDir = mkdtempSync(join(tmpdir(), 'lightdeck-decor-http-'));
    mkdirSync(join(publicDir, 'fixtures'));
    writeFileSync(join(publicDir, 'index.html'), '<html></html>');
    hass = new RecordingHass();
    rig = new Rig({
      output: new RecordingOutput(),
      hass,
      fixtures: [SPIDER, DECOR],
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

  it('puts the decor in the state, with its switches and no bytes', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: shapes are asserted field by field
    const state = (await (await fetch(`${base}/api/state`)).json()) as any;
    const fixture = state.fixtures.find((each: { id: string }) => each.id === 'decor');
    expect(fixture.kind).toBe('switches');
    expect(fixture.protocol).toBe('hass');
    expect(fixture.dmx).toBeUndefined();
    expect(fixture.details.switches.map((each: { id: string }) => each.id)).toEqual(['uv1', 'uv2']);
    expect(fixture.state.on).toEqual({ uv1: false, uv2: false });
  });

  it('switches one, both, and the blackout setting, and answers a mistake with 400', async () => {
    expect((await post('/api/fixtures/decor/update', { on: { uv1: true } })).status).toBe(200);
    expect(hass.to('switch.uv_lamp_1')).toHaveLength(1);
    expect((await post('/api/fixtures/decor/update', { follows: { uv2: true } })).status).toBe(200);
    const bad = await post('/api/fixtures/decor/update', { on: { nope: true } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/no switch called "nope"/);
  });
});
