import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPIDER_43CH } from '../fixtures/spider.js';
import { createHttpServer } from './http.js';
import { Rig } from './rig.js';
import { ch, RecordingOutput } from './testing.js';

const MANUAL = 95;
const LASER_AT = 44;

describe('HTTP server', () => {
  let output: RecordingOutput;
  let rig: Rig;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    const publicDir = mkdtempSync(join(tmpdir(), 'lightdeck-public-'));
    mkdirSync(join(publicDir, 'fixtures'));
    writeFileSync(join(publicDir, 'shell.js'), 'export {};');
    writeFileSync(join(publicDir, 'deck.html'), '<!doctype html><title>Deck</title>');
    writeFileSync(join(publicDir, 'simulator.html'), '<!doctype html><title>Simulator</title>');
    mkdirSync(join(publicDir, 'lib'));
    writeFileSync(join(publicDir, 'lib', 'three.js'), 'export {};');
    writeFileSync(
      join(publicDir, 'fixtures', 'spider.html'),
      '<!doctype html><title>Spider</title>',
    );
    writeFileSync(join(publicDir, 'fixtures', 'spider.js'), 'export {};');
    writeFileSync(join(publicDir, 'fixtures', 'laser.html'), '<!doctype html><title>Laser</title>');
    writeFileSync(join(publicDir, 'secret.key'), 'not served');

    output = new RecordingOutput();
    rig = new Rig({
      output,
      fixtures: [
        { id: 'spider', kind: 'spider', label: 'Spider', universe: 0, address: 1 },
        { id: 'spider-2', kind: 'spider', label: 'Spider 2', universe: 0, address: 101 },
        { id: 'laser', kind: 'laser', label: 'Laser', universe: 0, address: LASER_AT },
      ],
    });
    server = createHttpServer({ rig, publicDir, bridgeUrl: 'ws://bridge:9010' });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    rig.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (path: string, body: unknown) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const error = async (response: Response) => ((await response.json()) as { error: string }).error;
  // biome-ignore lint/suspicious/noExplicitAny: shapes are asserted field by field
  const state = async () => (await (await fetch(`${base}/api/state`)).json()) as any;

  it('limits the tilt of a spider, and tells the show about it', async () => {
    await post('/api/fixtures/spider/update', { levels: { tilt1: 1 } });
    const done = await post('/api/fixtures/spider/limits', {
      tilt: [{ min: 0, max: 0.5 }],
      client: 'tablet',
    });
    expect(done.status).toBe(200);
    expect((await state()).show.limits).toEqual({
      spider: {
        tilt: [
          { min: 0, max: 0.5 },
          { min: 0, max: 1 },
        ],
      },
    });
    expect(ch(output, 1)).toBe(128);
    // The other spider is not limited.
    await post('/api/fixtures/spider-2/update', { levels: { tilt1: 1 } });
    expect(ch(output, 101)).toBe(255);
    expect((await post('/api/fixtures/spider/limits', {})).status).toBe(200);
    expect((await state()).show.limits).toEqual({});
  });

  it('answers a limit that cannot be, and a fixture that has none', async () => {
    const wide = await post('/api/fixtures/spider/limits', { tilt: [{ min: 0.9, max: 0.1 }] });
    expect(wide.status).toBe(400);
    expect(await error(wide)).toMatch(/min below its max/);
    const laser = await post('/api/fixtures/laser/limits', {});
    expect(laser.status).toBe(400);
    expect(await error(laser)).toMatch(/cannot be limited/);
  });

  it('goes from the front door to the deck', async () => {
    const response = await fetch(`${base}/`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/deck');
    const deck = await fetch(`${base}/deck`);
    expect(deck.status).toBe(200);
    expect(await deck.text()).toContain('<title>Deck</title>');
  });

  it('serves every fixture the page of its kind', async () => {
    for (const [id, title] of [
      ['spider', 'Spider'],
      ['spider-2', 'Spider'],
      ['laser', 'Laser'],
    ]) {
      const page = await fetch(`${base}/fixtures/${id}`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      expect(await page.text()).toContain(`<title>${title}</title>`);
    }
    expect((await fetch(`${base}/fixtures/strobe`)).status).toBe(404);
  });

  it('serves the files of the pages', async () => {
    const script = await fetch(`${base}/fixtures/spider.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('text/javascript');
    expect((await fetch(`${base}/shell.js`)).status).toBe(200);
  });

  it('serves the simulator, and keeps the libraries in the cache for a week', async () => {
    const page = await fetch(`${base}/simulator`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>Simulator</title>');
    expect(page.headers.get('cache-control')).toBe('no-cache');
    const library = await fetch(`${base}/lib/three.js`);
    expect(library.status).toBe(200);
    expect(library.headers.get('cache-control')).toBe('public, max-age=604800');
  });

  it('serves nothing outside the public files', async () => {
    expect((await fetch(`${base}/secret.key`)).status).toBe(404);
    expect((await fetch(`${base}/../package.json`)).status).toBe(404);
    expect((await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`)).status).toBe(404);
    expect((await fetch(`${base}/missing.css`)).status).toBe(404);
  });

  it('describes the fixtures and what they share', async () => {
    const body = await state();
    expect(body.fixtures.map((f: { id: string }) => f.id)).toEqual(['spider', 'spider-2', 'laser']);
    const [spider, second, laser] = body.fixtures;

    expect(spider).toEqual(
      expect.objectContaining({
        kind: 'spider',
        label: 'Spider',
        footprint: 43,
        universe: 0,
        address: 1,
      }),
    );
    expect(spider.controls).toHaveLength(SPIDER_43CH.controls.length);
    expect(spider.details.effects).toHaveLength(22);
    expect(spider.details.motionEffects).toHaveLength(6);
    expect(spider.details.layout.cells).toBe(8);
    expect(spider.state.levels.dimmer).toBe(0);
    expect(spider.state.effect.id).toBeNull();
    expect(spider.dmx).toHaveLength(43);
    expect(second.address).toBe(101);

    expect(laser).toEqual(expect.objectContaining({ kind: 'laser', footprint: 10, address: 44 }));
    expect(laser.details).toEqual(expect.objectContaining({ gate: 'mode', effectsIn: 'manual' }));
    expect(laser.details.effects.map((e: { id: string }) => e.id)).toEqual(['patterns', 'colours']);
    expect(laser.details.motionEffects.map((e: { id: string }) => e.id)).toEqual([
      'pulse',
      'sweep',
      'twist',
    ]);
    expect(laser.details.colourSetting).toEqual({
      control: 'colour',
      range: 'single',
      max: 3,
      from: 0,
      to: 63,
    });
    expect(laser.state.effect).toEqual({ id: null, speed: 1 });
    expect(laser.state.motion).toEqual({ id: null, speed: 1 });
    expect(laser.state.colours).toEqual([]);
    expect(laser.controls[0].ranges[1]).toEqual(
      expect.objectContaining({ from: 64, to: 127, key: 'manual', name: 'Manual' }),
    );
    expect(laser.state.raw.mode).toBe(0);
    expect(laser.dmx).toEqual(new Array(10).fill(0));

    expect(body.tempo).toEqual(
      expect.objectContaining({
        bpm: 126,
        rate: 1,
        min: 60,
        max: 200,
        rates: [0.25, 0.5, 1, 2, 4],
        changesPerSecond: 10,
      }),
    );
    expect(typeof body.tempo.beat).toBe('number');
    expect(body.blackout).toBe(false);
    expect(body.master).toBe(1);
    expect(body.status.bridge).toBe(false);
    expect(body.bridgeUrl).toBe('ws://bridge:9010');
  });

  it('changes one fixture and leaves the others alone', async () => {
    const response = await post('/api/fixtures/spider-2/update', {
      client: 'a',
      levels: { dimmer: 1, green2: 1 },
    });
    expect(response.status).toBe(200);
    expect(ch(output, 106)).toBe(255);
    expect(ch(output, 112)).toBe(255);
    expect(ch(output, 6)).toBe(0);

    expect((await post('/api/fixtures/laser/update', { raw: { mode: MANUAL } })).status).toBe(200);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
    expect(ch(output, 106)).toBe(255);
  });

  it('answers a bad change with 400 and says what is wrong', async () => {
    const before = output.frames.length;
    const unknown = await post('/api/fixtures/spider/update', { levels: { red9: 1 } });
    expect(unknown.status).toBe(400);
    expect(await error(unknown)).toContain('red9');
    expect((await post('/api/fixtures/spider/update', 'not json')).status).toBe(400);
    expect((await post('/api/fixtures/spider/update', '[1]')).status).toBe(400);
    expect((await post('/api/fixtures/spider/update', { raw: { reset: 255 } })).status).toBe(400);
    expect((await post('/api/fixtures/spider/update', { blackout: 'yes' })).status).toBe(400);
    expect((await post('/api/fixtures/laser/update', { raw: { mode: 300 } })).status).toBe(400);
    expect((await post('/api/fixtures/laser/update', { levels: { mode: 1 } })).status).toBe(400);
    expect(output.frames).toHaveLength(before);
  });

  it('has nothing for a fixture that is not there', async () => {
    expect((await post('/api/fixtures/strobe/update', { levels: { dimmer: 1 } })).status).toBe(404);
  });

  it('starts and stops an effect', async () => {
    const update = '/api/fixtures/spider/update';
    expect((await post(update, { effect: { id: 'sparkle' } })).status).toBe(200);
    expect((await state()).fixtures[0].state.effect.id).toBe('sparkle');
    const unknown = await post(update, { effect: { id: 'disco' } });
    expect(unknown.status).toBe(400);
    expect(await error(unknown)).toContain('disco');
    expect((await post(update, { effect: { id: null } })).status).toBe(200);
    expect((await state()).fixtures[0].state.effect.id).toBeNull();
  });

  it('lets a fixture do what it can do by name', async () => {
    expect((await post('/api/fixtures/spider/reset', {})).status).toBe(200);
    expect(ch(output, 43)).toBe(255);
    expect((await state()).fixtures[0].state.resetting).toBe(true);
    const refused = await post('/api/fixtures/laser/reset', {});
    expect(refused.status).toBe(400);
    expect(await error(refused)).toContain('reset');
  });

  it('sets the tempo and the speed of the console', async () => {
    expect((await post('/api/tempo', { client: 'a', bpm: 128, rate: 2 })).status).toBe(200);
    expect((await state()).tempo).toEqual(expect.objectContaining({ bpm: 128, rate: 2 }));
    expect((await post('/api/tempo', { sync: true })).status).toBe(200);
    expect((await state()).tempo.beat).toBeLessThan(0.5);

    const refused = await post('/api/tempo', { bpm: 300 });
    expect(refused.status).toBe(400);
    expect(await error(refused)).toContain('between 60 and 200');
    expect((await post('/api/tempo', { rate: 3 })).status).toBe(400);
    expect((await state()).tempo).toEqual(expect.objectContaining({ bpm: 128, rate: 2 }));
  });

  it('blacks out every fixture at once', async () => {
    await post('/api/fixtures/spider/update', { levels: { dimmer: 1 } });
    await post('/api/fixtures/laser/update', { raw: { mode: MANUAL } });
    expect((await post('/api/blackout', { blackout: true })).status).toBe(200);
    expect(ch(output, 6)).toBe(0);
    expect(ch(output, LASER_AT)).toBe(0);
    const dark = await state();
    expect(dark.blackout).toBe(true);
    expect(dark.fixtures[2].dmx[0]).toBe(0);
    expect(dark.fixtures[2].state.raw.mode).toBe(MANUAL);

    expect((await post('/api/blackout', { blackout: false })).status).toBe(200);
    expect(ch(output, 6)).toBe(255);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
    expect((await post('/api/blackout', { blackout: 'yes' })).status).toBe(400);
    expect((await post('/api/blackout', {})).status).toBe(400);
  });

  it('dims every fixture with the master, and leaves what they are set to', async () => {
    await post('/api/fixtures/spider/update', { levels: { dimmer: 1, red1: 1 } });
    await post('/api/fixtures/spider-2/update', { levels: { dimmer: 0.5 } });
    await post('/api/fixtures/laser/update', { raw: { mode: MANUAL } });

    const half = await post('/api/master', { master: 0.5, client: 'tablet-1' });
    expect(half.status).toBe(200);
    expect(await half.json()).toEqual({ ok: true });
    expect([ch(output, 6), ch(output, 7), ch(output, 106)]).toEqual([128, 255, 64]);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
    const dimmed = await state();
    expect(dimmed.master).toBe(0.5);
    expect(dimmed.blackout).toBe(false);
    expect(dimmed.fixtures[0].dmx[5]).toBe(128);
    expect(dimmed.fixtures[0].state.levels.dimmer).toBe(1);
    expect(dimmed.fixtures[1].dmx[5]).toBe(64);
    expect(dimmed.fixtures[1].state.levels.dimmer).toBe(0.5);

    expect((await post('/api/master', { master: 0 })).status).toBe(200);
    expect([ch(output, 6), ch(output, 7), ch(output, 106)]).toEqual([0, 255, 0]);
    expect(ch(output, LASER_AT)).toBe(0);
    const dark = await state();
    expect(dark.master).toBe(0);
    expect(dark.fixtures[2].dmx[0]).toBe(0);
    expect(dark.fixtures[2].state.raw.mode).toBe(MANUAL);

    expect((await post('/api/master', { master: 1 })).status).toBe(200);
    expect([ch(output, 6), ch(output, 106), ch(output, LASER_AT)]).toEqual([255, 128, MANUAL]);
  });

  it('answers a master that is not a number from 0 to 1 with 400, and changes nothing', async () => {
    await post('/api/fixtures/spider/update', { levels: { dimmer: 1 } });
    await post('/api/master', { master: 0.5 });
    const before = output.frames.length;
    for (const body of [
      { master: 1.5 },
      { master: -0.1 },
      { master: 50 },
      { master: '0.5' },
      { master: true },
      { master: null },
      { level: 0.2 },
      {},
    ]) {
      const refused = await post('/api/master', body);
      expect(refused.status).toBe(400);
      expect(await error(refused)).toBe('the master must be a number between 0 and 1');
    }
    expect((await post('/api/master', 'not json')).status).toBe(400);
    expect((await state()).master).toBe(0.5);
    expect(output.frames).toHaveLength(before);
    expect(ch(output, 6)).toBe(128);
  });

  it('has the blackout next to the master', async () => {
    await post('/api/fixtures/spider/update', { levels: { dimmer: 1 } });
    await post('/api/fixtures/laser/update', { raw: { mode: MANUAL } });
    await post('/api/master', { master: 0.5 });
    await post('/api/blackout', { blackout: true });
    expect([ch(output, 6), ch(output, LASER_AT)]).toEqual([0, 0]);
    expect(await state()).toEqual(expect.objectContaining({ master: 0.5, blackout: true }));
    await post('/api/master', { master: 1 });
    expect([ch(output, 6), ch(output, LASER_AT)]).toEqual([0, 0]);
    await post('/api/master', { master: 0.5 });
    await post('/api/blackout', { blackout: false });
    expect([ch(output, 6), ch(output, LASER_AT)]).toEqual([128, MANUAL]);
    expect(await state()).toEqual(expect.objectContaining({ master: 0.5, blackout: false }));
  });

  it('streams the current picture and later changes, with their origin', async () => {
    const abort = new AbortController();
    const response = await fetch(`${base}/api/events`, { signal: abort.signal });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    };

    await readUntil('event: status');
    expect(text).toContain('event: fixture\ndata: {"id":"spider",');
    expect(text).toContain('event: fixture\ndata: {"id":"spider-2",');
    expect(text).toContain('event: fixture\ndata: {"id":"laser",');
    expect(text).toContain('event: tempo\ndata: {"bpm":126,"rate":1,');
    expect(text).toContain('event: blackout\ndata: {"blackout":false,"origin":null}');
    expect(text).toContain('event: master\ndata: {"master":1,"origin":null}');

    await post('/api/fixtures/spider/update', { client: 'tablet-1', levels: { dimmer: 0.5 } });
    await readUntil('"origin":"tablet-1"');
    expect(text).toContain('"dimmer":0.5');

    await post('/api/fixtures/laser/update', { client: 'tablet-2', raw: { colour: 70 } });
    await readUntil('"origin":"tablet-2"');
    expect(text).toContain('"colour":70');

    await post('/api/tempo', { client: 'tablet-3', bpm: 140 });
    await readUntil('"origin":"tablet-3"');
    expect(text).toContain('event: tempo\ndata: {"bpm":140,"rate":1,');

    await post('/api/blackout', { client: 'tablet-4', blackout: true });
    await readUntil('event: blackout\ndata: {"blackout":true,"origin":"tablet-4"}');
    expect(text).toContain('{"blackout":true,"origin":"tablet-4"}');

    await post('/api/master', { client: 'tablet-5', master: 0.25 });
    await readUntil('event: master\ndata: {"master":0.25,"origin":"tablet-5"}');
    expect(text).toContain('event: master\ndata: {"master":0.25,"origin":"tablet-5"}');
    await post('/api/master', { master: 0 });
    await readUntil('event: master\ndata: {"master":0,"origin":null}');
    expect(text).toContain('event: master\ndata: {"master":0,"origin":null}');

    rig.setBridgeConnected(true);
    await readUntil('"bridge":true');
    expect(text).toContain('"bridge":true');
    abort.abort();
  });

  describe('the output settings', () => {
    it('are in the state', async () => {
      expect((await state()).output).toEqual({ maxFps: 25, leadMs: 0 });
    });

    it('change, and the answer has all of them', async () => {
      const response = await post('/api/output', { maxFps: 30, leadMs: 25 });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { output: unknown }).output).toEqual({
        maxFps: 30,
        leadMs: 25,
      });
      expect((await state()).output).toEqual({ maxFps: 30, leadMs: 25 });
      const part = await post('/api/output', { leadMs: 10 });
      expect(((await part.json()) as { output: unknown }).output).toEqual({
        maxFps: 30,
        leadMs: 10,
      });
    });

    it('say what is wrong with a change, and keep what they were', async () => {
      const tooFast = await post('/api/output', { maxFps: 500 });
      expect(tooFast.status).toBe(400);
      expect(await error(tooFast)).toMatch(/frames per second/);
      const lead = await post('/api/output', { leadMs: 'now' });
      expect(lead.status).toBe(400);
      expect(await error(lead)).toMatch(/lead/);
      const unknown = await post('/api/output', { colour: 'red' });
      expect(unknown.status).toBe(400);
      expect((await state()).output).toEqual({ maxFps: 25, leadMs: 0 });
    });

    it('are streamed, now and when they change', async () => {
      const abort = new AbortController();
      const response = await fetch(`${base}/api/events`, { signal: abort.signal });
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let text = '';
      const readUntil = async (needle: string) => {
        while (!text.includes(needle)) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
        }
      };
      await readUntil('event: output');
      expect(text).toContain('"maxFps":25');
      await post('/api/output', { maxFps: 20 });
      await readUntil('"maxFps":20');
      expect(text).toContain('"maxFps":20');
      abort.abort();
    });
  });

  describe('rekordbox', () => {
    it('describes who sets the tempo and what rekordbox says', async () => {
      const got = await state();
      expect(got.tempo).toMatchObject({ source: 'manual', running: true });
      expect(got.rkbx).toMatchObject({ status: 'waiting', following: false, beats: false });
    });

    it('hands the tempo to rekordbox and takes it back', async () => {
      expect((await post('/api/tempo', { source: 'rekordbox' })).status).toBe(200);
      let got = await state();
      expect(got.tempo.source).toBe('rekordbox');
      expect(got.rkbx.following).toBe(true);
      expect((await post('/api/tempo', { source: 'manual', bpm: 130 })).status).toBe(200);
      got = await state();
      expect(got.tempo).toMatchObject({ source: 'manual', bpm: 130, running: true });
      expect(got.rkbx.following).toBe(false);
    });

    it('turns the breakdown on and off, and refuses what it does not know', async () => {
      expect((await state()).rkbx.breakdown.enabled).toBe(false);
      expect((await post('/api/rkbx', { breakdown: true })).status).toBe(200);
      expect((await state()).rkbx.breakdown.enabled).toBe(true);
      expect((await post('/api/rkbx', { breakdown: false })).status).toBe(200);
      expect((await state()).rkbx.breakdown.enabled).toBe(false);
      const wrong = await post('/api/rkbx', { breakdown: 'yes' });
      expect(wrong.status).toBe(400);
      expect(await error(wrong)).toMatch(/true or false/);
      expect((await post('/api/rkbx', { colour: 'red' })).status).toBe(400);
    });

    it('refuses a source it does not know, and changes nothing', async () => {
      const response = await post('/api/tempo', { source: 'link' });
      expect(response.status).toBe(400);
      expect(await error(response)).toMatch(/manual or rekordbox/);
      expect((await state()).tempo.source).toBe('manual');
    });

    it('streams what rekordbox says, now and when it changes', async () => {
      const abort = new AbortController();
      const response = await fetch(`${base}/api/events`, { signal: abort.signal });
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let text = '';
      const readUntil = async (needle: string) => {
        while (!text.includes(needle)) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
        }
      };
      await readUntil('event: rkbx');
      expect(text).toContain('"following":false');
      await post('/api/tempo', { source: 'rekordbox' });
      await readUntil('"following":true');
      expect(text).toContain('"following":true');
      abort.abort();
    });
  });

  it('streams what an effect shows, with the name of the fixture', async () => {
    const abort = new AbortController();
    const response = await fetch(`${base}/api/events`, { signal: abort.signal });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = '';
    await post('/api/fixtures/spider-2/update', { effect: { id: 'chase' } });
    while (!text.includes('event: frame')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toContain('event: frame\ndata: {"id":"spider-2","dmx":[');
    abort.abort();
  });

  const NONE = { scene: null, changed: false };
  const NO_LOOK = { look: null, changed: false };
  const NOTHING = { lights: NONE, colour: NONE, motion: NONE, zone: NONE, look: NO_LOOK };
  /** What is on in a group when only a scene of lights is. */
  const lights = (scene: string, changed = false) => ({ ...NOTHING, lights: { scene, changed } });
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
  const STARTING = [
    {
      id: 'spider',
      label: 'Spider',
      fixtures: ['spider'],
      palettes: true,
      scenes: [],
      moods: [],
      looks: [],
    },
    {
      id: 'spider-2',
      label: 'Spider 2',
      fixtures: ['spider-2'],
      palettes: true,
      scenes: [],
      moods: [],
      looks: [],
    },
    {
      id: 'laser',
      label: 'Laser',
      fixtures: ['laser'],
      palettes: false,
      scenes: [],
      moods: [],
      looks: [],
    },
    {
      id: 'all',
      label: 'All',
      fixtures: ['spider', 'spider-2', 'laser'],
      palettes: true,
      scenes: [],
      moods: [],
      looks: [],
    },
  ];

  it('describes the show and what is on', async () => {
    const body = await state();
    expect(body.show).toEqual({
      file: null,
      problem: null,
      limits: {},
      sequences: [],
      palettes: STARTING_PALETTES,
      groups: STARTING,
    });
    expect(body.playback).toEqual({
      groups: { spider: NOTHING, 'spider-2': NOTHING, laser: NOTHING, all: NOTHING },
    });
  });

  it('stores the lights of a group as a scene and sets them to it again', async () => {
    await post('/api/fixtures/spider/update', { levels: { dimmer: 1 } });
    await post('/api/fixtures/laser/update', { raw: { mode: MANUAL } });
    const stored = await post('/api/groups/all/scenes', {
      label: 'Warm',
      type: 'lights',
      client: 'tablet-1',
    });
    expect(await stored.json()).toEqual({ ok: true, id: 'warm' });

    await post('/api/fixtures/spider/update', { levels: { dimmer: 0 } });
    await post('/api/fixtures/laser/update', { raw: { mode: 0 } });
    expect((await state()).playback.groups.all).toEqual(lights('warm', true));

    const recalled = await post('/api/playback', {
      group: 'all',
      scene: 'warm',
      client: 'tablet-1',
    });
    expect(recalled.status).toBe(200);
    expect(await recalled.json()).toEqual({ ok: true });
    expect(ch(output, 6)).toBe(255);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
    const now = await state();
    expect(now.playback).toEqual({
      groups: {
        spider: NOTHING,
        'spider-2': NOTHING,
        laser: NOTHING,
        all: lights('warm'),
      },
    });
    expect(now.show.groups[3].scenes).toEqual([
      { id: 'warm', label: 'Warm', type: 'lights', fixtures: ['spider', 'laser'] },
    ]);
    expect(now.show.groups.slice(0, 3)).toEqual(STARTING.slice(0, 3));
  });

  it('has a scene on in two groups at once, and darkens one of them with off', async () => {
    await post('/api/fixtures/spider/update', { levels: { dimmer: 1 } });
    await post('/api/fixtures/laser/update', { raw: { mode: MANUAL } });
    await post('/api/groups/spider/scenes', { label: 'Warm', type: 'lights' });
    await post('/api/groups/laser/scenes', { label: 'Open', type: 'lights' });
    await post('/api/playback', { group: 'all', off: true });
    expect(ch(output, 6)).toBe(0);
    expect(ch(output, LASER_AT)).toBe(0);

    expect((await post('/api/playback', { group: 'laser', scene: 'open' })).status).toBe(200);
    expect((await post('/api/playback', { group: 'spider', scene: 'warm' })).status).toBe(200);
    expect(ch(output, 6)).toBe(255);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
    expect((await state()).playback.groups).toEqual({
      spider: lights('warm'),
      'spider-2': NOTHING,
      laser: lights('open'),
      all: NOTHING,
    });

    const off = await post('/api/playback', { group: 'spider', off: true, client: 'tablet-1' });
    expect(off.status).toBe(200);
    expect(ch(output, 6)).toBe(0);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
    expect((await state()).playback.groups).toEqual({
      spider: NOTHING,
      'spider-2': NOTHING,
      laser: lights('open'),
      all: NOTHING,
    });
  });

  it('stores a scene of lights and of motion, sets a palette, and sets each alone', async () => {
    await post('/api/fixtures/spider/update', {
      levels: { dimmer: 1, red1: 1, tilt1: 0.3 },
      effect: { id: 'chase' },
      motion: { id: 'scissor', speed: 0.5 },
    });
    const scenes = [
      { label: 'Chase', type: 'lights' },
      { label: 'Lean', type: 'motion' },
    ];
    for (const { label, type } of scenes) {
      const stored = await post('/api/groups/spider/scenes', { label, type });
      expect(await stored.json()).toEqual({ ok: true, id: label.toLowerCase() });
    }
    const types = (await state()).show.groups[0].scenes.map(
      (scene: { id: string; type: string }) => [scene.id, scene.type],
    );
    expect(types).toEqual([
      ['chase', 'lights'],
      ['lean', 'motion'],
    ]);

    await post('/api/fixtures/spider/update', {
      levels: { dimmer: 0.2, red1: 0, tilt1: 0.9 },
      effect: { id: 'kick' },
      motion: { id: null },
    });
    expect((await post('/api/playback', { group: 'spider', scene: 'lean' })).status).toBe(200);
    let spider = (await state()).fixtures[0].state;
    expect(spider.levels).toMatchObject({ dimmer: 0.2, red1: 0, tilt1: 0.3 });
    expect(spider.effect.id).toBe('kick');
    expect(spider.motion).toEqual({ id: 'scissor', speed: 0.5 });

    const coloured = await post('/api/playback', {
      group: 'spider',
      palette: 'rainbow',
      speed: 2,
      client: 'tablet-1',
    });
    expect(coloured.status).toBe(200);
    spider = (await state()).fixtures[0].state;
    expect(spider.colour).toEqual({ palette: 'rainbow', speed: 2 });
    expect(spider.effect.id).toBe('kick');

    await post('/api/playback', { group: 'spider', scene: 'chase' });
    await post('/api/playback', { group: 'spider', off: true });
    spider = (await state()).fixtures[0].state;
    expect(spider.levels).toMatchObject({ dimmer: 0, red1: 0, tilt1: 0.3 });
    expect(spider.effect.id).toBeNull();
    expect((await state()).playback.groups.spider).toEqual({
      lights: NONE,
      colour: { scene: 'rainbow', changed: false },
      motion: { scene: 'lean', changed: false },
      zone: NONE,
      look: NO_LOOK,
    });
  });

  it('stores and recalls under the master without moving it', async () => {
    await post('/api/fixtures/spider/update', { levels: { dimmer: 1 } });
    await post('/api/fixtures/laser/update', { raw: { mode: MANUAL } });
    await post('/api/master', { master: 0.5 });
    await post('/api/groups/all/scenes', { label: 'Warm', type: 'lights' });
    expect((await state()).playback.groups.all).toEqual(lights('warm'));
    await post('/api/master', { master: 0 });
    expect((await state()).playback.groups.all).toEqual(lights('warm'));

    await post('/api/playback', { group: 'all', off: true });
    expect((await post('/api/playback', { group: 'all', scene: 'warm' })).status).toBe(200);
    expect([ch(output, 6), ch(output, LASER_AT)]).toEqual([0, 0]);
    const recalled = await state();
    expect(recalled.master).toBe(0);
    expect(recalled.fixtures[0].state.levels.dimmer).toBe(1);
    expect(recalled.fixtures[2].state.raw.mode).toBe(MANUAL);

    await post('/api/master', { master: 1 });
    expect([ch(output, 6), ch(output, LASER_AT)]).toEqual([255, MANUAL]);
  });

  it('keeps the laser closed during a blackout, whatever is recalled', async () => {
    await post('/api/fixtures/laser/update', { raw: { mode: MANUAL } });
    await post('/api/groups/laser/scenes', { label: 'Open', type: 'lights' });
    await post('/api/playback', { group: 'laser', off: true });
    await post('/api/blackout', { blackout: true });
    expect((await post('/api/playback', { group: 'laser', scene: 'open' })).status).toBe(200);
    expect(ch(output, LASER_AT)).toBe(0);
    await post('/api/blackout', { blackout: false });
    expect(ch(output, LASER_AT)).toBe(MANUAL);
  });

  it('stores over, renames and deletes a scene of a group', async () => {
    await post('/api/groups/spider-2/scenes', { label: 'Warm', type: 'lights' });
    await post('/api/groups/laser/scenes', { label: 'Warm', type: 'lights' });
    await post('/api/fixtures/spider-2/update', { levels: { dimmer: 1 } });
    expect((await post('/api/groups/spider-2/scenes/warm/store', {})).status).toBe(200);
    expect(
      (await post('/api/groups/spider-2/scenes/warm/rename', { label: 'Warm up' })).status,
    ).toBe(200);
    const stored = await state();
    expect(stored.show.groups[1].scenes).toEqual([
      { id: 'warm', label: 'Warm up', type: 'lights', fixtures: ['spider-2'] },
    ]);
    expect(stored.show.groups[2].scenes).toEqual([
      { id: 'warm', label: 'Warm', type: 'lights', fixtures: [] },
    ]);

    expect((await post('/api/groups/spider-2/scenes/warm/delete', {})).status).toBe(200);
    const deleted = await state();
    expect(deleted.show.groups[1].scenes).toEqual([]);
    expect(deleted.show.groups[2].scenes).toHaveLength(1);
    expect(deleted.playback.groups['spider-2']).toEqual(NOTHING);
  });

  it('makes, renames and deletes a group', async () => {
    const made = await post('/api/groups', {
      label: 'Spiders',
      fixtures: ['spider', 'spider-2'],
      client: 'tablet-1',
    });
    expect(made.status).toBe(200);
    expect(await made.json()).toEqual({ ok: true, id: 'spiders' });
    expect(
      (await post('/api/groups/spiders/scenes', { label: 'Warm', type: 'lights' })).status,
    ).toBe(200);
    expect((await post('/api/groups/spiders/rename', { label: 'Both spiders' })).status).toBe(200);
    const now = await state();
    expect(now.show.groups).toEqual([
      ...STARTING,
      {
        id: 'spiders',
        label: 'Both spiders',
        fixtures: ['spider', 'spider-2'],
        palettes: true,
        scenes: [{ id: 'warm', label: 'Warm', type: 'lights', fixtures: [] }],
        moods: [],
        looks: [],
      },
    ]);
    expect(now.playback.groups.spiders).toEqual(lights('warm'));

    expect((await post('/api/groups/spiders/delete', {})).status).toBe(200);
    const after = await state();
    expect(after.show.groups).toEqual(STARTING);
    expect(after.playback.groups.spiders).toBeUndefined();
  });

  it('says what is wrong with a request about groups and scenes', async () => {
    await post('/api/groups/spider/scenes', { label: 'Warm', type: 'lights' });
    const refused: [string, unknown, string][] = [
      ['/api/groups/spider/scenes', { type: 'lights' }, 'a scene needs a name'],
      [
        '/api/groups/spider/scenes',
        { label: 'Warm' },
        'a scene needs a type: lights, motion or zone',
      ],
      [
        '/api/groups/spider/scenes',
        { label: 'Warm', type: 'full' },
        'a scene needs a type: lights, motion or zone',
      ],
      [
        '/api/groups/spider/scenes',
        { label: 'Warm', type: 'colour' },
        'colours are palettes now, and not scenes: a scene is lights, motion or zone',
      ],
      [
        '/api/groups/strobe/scenes',
        { label: 'Warm', type: 'lights' },
        'there is no group called "strobe"',
      ],
      ['/api/playback', { scene: 'warm' }, 'say which group, by its id'],
      ['/api/playback', { group: 'spider' }, 'say which scene, by its id'],
      ['/api/playback', { group: 'strobe', scene: 'warm' }, 'there is no group called "strobe"'],
      ['/api/playback', { group: 'strobe', off: true }, 'there is no group called "strobe"'],
      [
        '/api/playback',
        { group: 'laser', scene: 'warm' },
        'there is no scene called "warm" in the group "laser"',
      ],
      ['/api/playback', { group: 'spider', off: false }, '"off" can only be true'],
      [
        '/api/playback',
        { group: 'spider', scene: 'warm', off: true },
        'say a scene, a palette, a look or off, one of them',
      ],
      [
        '/api/playback',
        { group: 'spider', palette: 'white', look: 'drop' },
        'say a scene, a palette, a look or off, one of them',
      ],
      ['/api/playback', { group: 'spider', speed: 2 }, 'a speed goes with a palette'],
      ['/api/playback', { group: 'spider', palette: 'nope' }, 'there is no palette called "nope"'],
      [
        '/api/playback',
        { group: 'laser', palette: 'white' },
        'no fixture of "Laser" is coloured by palettes',
      ],
      [
        '/api/playback',
        { group: 'spider', palette: 'white', speed: 3 },
        'the speed of a palette must be one of 0.25, 0.5, 1, 2, 4',
      ],
      [
        '/api/playback',
        { group: 'spider', look: 'nope' },
        'there is no look called "nope" in the group "spider"',
      ],
      [
        '/api/playback',
        { group: 'spider', scene: 'warm', fade: 2 },
        'the playback cannot set "fade", only group, scene, palette, speed, look, off',
      ],
      [
        '/api/groups/spider/scenes/nothing/delete',
        {},
        'there is no scene called "nothing" in the group "spider"',
      ],
      ['/api/groups/spider/scenes/warm/rename', {}, 'a scene needs a name'],
      ['/api/groups/strobe/rename', { label: 'Strobe' }, 'there is no group called "strobe"'],
      ['/api/groups/strobe/delete', {}, 'there is no group called "strobe"'],
      ['/api/groups/spider/rename', { label: ' ' }, 'a group needs a name'],
      ['/api/groups', { fixtures: ['spider'] }, 'a group needs a name'],
      ['/api/groups', { label: 'Front' }, '"fixtures" must be a list of the fixtures of the group'],
      ['/api/groups', { label: 'Front', fixtures: [] }, 'a group needs at least one fixture'],
      [
        '/api/groups',
        { label: 'Front', fixtures: ['strobe'] },
        'there is no fixture called "strobe", only spider, spider-2, laser',
      ],
    ];
    for (const [path, body, message] of refused) {
      const response = await post(path, body);
      expect([path, response.status]).toEqual([path, 400]);
      expect(await error(response)).toBe(message);
    }
    expect((await state()).show.groups).toHaveLength(4);
  });

  it('has nothing where the scenes were before there were groups', async () => {
    expect((await post('/api/scenes', { label: 'Warm' })).status).toBe(404);
    expect((await post('/api/scenes/warm/store', {})).status).toBe(404);
    expect((await post('/api/groups/spider/burn', {})).status).toBe(404);
    expect((await post('/api/groups/spider/scenes/warm/burn', {})).status).toBe(404);
    expect((await state()).show.groups).toEqual(STARTING);
  });

  it('streams the show and the playback', async () => {
    const abort = new AbortController();
    const response = await fetch(`${base}/api/events`, { signal: abort.signal });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (marker: string) => {
      while (!text.includes(marker)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    };
    const none = '{"scene":null,"changed":false}';
    const nothing = `{"lights":${none},"colour":${none},"motion":${none},"zone":${none},"look":{"look":null,"changed":false}}`;
    await readUntil(
      `event: playback\ndata: {"groups":{"spider":${nothing},"spider-2":${nothing},"laser":${nothing},"all":${nothing}}}`,
    );
    expect(text).toContain(
      `event: show\ndata: ${JSON.stringify({ file: null, problem: null, limits: {}, palettes: STARTING_PALETTES, groups: STARTING, sequences: [] })}`,
    );

    await post('/api/groups/laser/scenes', { label: 'Warm', type: 'lights' });
    const warm = `{"lights":{"scene":"warm","changed":false},"colour":${none},"motion":${none},"zone":${none},"look":{"look":null,"changed":false}}`;
    await readUntil(
      `event: playback\ndata: {"groups":{"spider":${nothing},"spider-2":${nothing},"laser":${warm},"all":${nothing}}}`,
    );
    expect(text).toContain(
      '{"id":"laser","label":"Laser","fixtures":["laser"],"palettes":false,"scenes":[{"id":"warm","label":"Warm","type":"lights","fixtures":[]}],"moods":[],"looks":[]}',
    );

    await post('/api/groups', { label: 'Front', fixtures: ['spider'] });
    await readUntil(`"all":${nothing},"front":${nothing}}}`);
    expect(text).toContain(
      '{"id":"front","label":"Front","fixtures":["spider"],"palettes":true,"scenes":[],"moods":[],"looks":[]}',
    );
    abort.abort();
  });

  it('makes, changes and deletes a palette', async () => {
    const made = await post('/api/palettes', {
      label: 'Sunset',
      colours: ['#ff4a00', 'off', '#ffb000'],
      mode: 'cycle',
      client: 'tablet-1',
    });
    expect(made.status).toBe(200);
    expect(await made.json()).toEqual({ ok: true, id: 'sunset' });
    const plain = await post('/api/palettes', { label: 'Plain' });
    expect(await plain.json()).toEqual({ ok: true, id: 'plain' });

    expect(
      (await post('/api/palettes/sunset/update', { speed: 1, client: 'tablet-1' })).status,
    ).toBe(200);
    expect(
      (await post('/api/palettes/plain/update', { label: 'Plainer', colours: ['#00ff00'] })).status,
    ).toBe(200);
    const now = (await state()).show.palettes;
    expect(now.slice(2)).toEqual([
      {
        id: 'sunset',
        label: 'Sunset',
        colours: ['#ff4a00', 'off', '#ffb000'],
        mode: 'cycle',
        change: 'step',
        speed: 1,
      },
      {
        id: 'plain',
        label: 'Plainer',
        colours: ['#00ff00'],
        mode: 'static',
        change: 'step',
        speed: 0.25,
      },
    ]);

    expect((await post('/api/palettes/sunset/delete', {})).status).toBe(200);
    expect((await state()).show.palettes.map((each: { id: string }) => each.id)).toEqual([
      'white',
      'rainbow',
      'plain',
    ]);
  });

  it('says what is wrong with a request about palettes', async () => {
    await post('/api/playback', { group: 'spider', palette: 'rainbow' });
    const refused: [string, unknown, string][] = [
      ['/api/palettes', {}, 'a palette needs a name'],
      [
        '/api/palettes',
        { label: 'Odd', colours: ['blue'] },
        '"blue" is not a colour: write #rrggbb, #rrggbbww or off',
      ],
      [
        '/api/palettes',
        { label: 'Empty', colours: [] },
        'a palette needs a list of colours, at least one',
      ],
      [
        '/api/palettes',
        { label: 'Spin', colours: ['#ffffff'], mode: 'spin' },
        'the mode of a palette is static or cycle',
      ],
      ['/api/palettes/nope/update', { label: 'Nope' }, 'there is no palette called "nope"'],
      [
        '/api/palettes/white/update',
        { tint: 1 },
        'a palette cannot change "tint", only label, colours, mode, change, speed and visible',
      ],
      ['/api/palettes/nope/delete', {}, 'there is no palette called "nope"'],
      ['/api/palettes/rainbow/delete', {}, 'the palette "Rainbow" is in use: it is on in "Spider"'],
    ];
    for (const [path, body, message] of refused) {
      const response = await post(path, body);
      expect([path, response.status]).toEqual([path, 400]);
      expect(await error(response)).toBe(message);
    }
    expect((await post('/api/palettes/white/burn', {})).status).toBe(404);
    expect((await state()).show.palettes).toHaveLength(2);
  });

  it('stores a look from what is on, presses it, and takes it away', async () => {
    await post('/api/fixtures/spider/update', {
      levels: { dimmer: 1, tilt1: 0.2 },
      effect: { id: 'chase' },
    });
    await post('/api/groups/spider/scenes', { label: 'Chase', type: 'lights' });
    await post('/api/groups/spider/scenes', { label: 'Low', type: 'motion' });
    await post('/api/playback', { group: 'spider', palette: 'rainbow', speed: 0.5 });

    const stored = await post('/api/groups/spider/looks', { label: 'Drop' });
    expect(await stored.json()).toEqual({ ok: true, id: 'drop' });
    const now = await state();
    expect(now.show.groups[0].looks).toEqual([
      {
        id: 'drop',
        label: 'Drop',
        mood: null,
        lights: 'chase',
        colour: { palette: 'rainbow', speed: 0.5 },
        motion: 'low',
        zone: null,
      },
    ]);
    expect(now.playback.groups.spider.look).toEqual({ look: 'drop', changed: false });

    await post('/api/fixtures/spider/update', {
      levels: { dimmer: 0 },
      colour: { palette: 'white' },
    });
    expect((await state()).playback.groups.spider.look).toEqual({ look: 'drop', changed: true });
    expect((await post('/api/playback', { group: 'spider', look: 'drop' })).status).toBe(200);
    const spider = (await state()).fixtures[0].state;
    expect(spider.levels.dimmer).toBe(1);
    expect(spider.colour).toEqual({ palette: 'rainbow', speed: 0.5 });
    expect((await state()).playback.groups.spider.look).toEqual({ look: 'drop', changed: false });

    expect((await post('/api/groups/spider/looks/drop/rename', { label: 'Big drop' })).status).toBe(
      200,
    );
    expect((await post('/api/groups/spider/looks/drop/store', {})).status).toBe(200);
    expect((await state()).show.groups[0].looks[0].label).toBe('Big drop');
    const refused = await post('/api/groups/spider/scenes/chase/delete', {});
    expect(await error(refused)).toBe(
      'the scene "Chase" is used by the look "Big drop". Change or delete the look first',
    );
    expect((await post('/api/groups/spider/looks/drop/delete', {})).status).toBe(200);
    expect((await state()).show.groups[0].looks).toEqual([]);
    expect((await post('/api/groups/spider/looks/drop/burn', {})).status).toBe(404);
  });
});
