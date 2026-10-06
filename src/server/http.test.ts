import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPIDER_43CH } from '../fixtures/spider.js';
import type { AudioBlock } from '../inputs/audio/source.js';
import { toInt16 } from '../inputs/audio/wav.js';
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
    writeFileSync(join(publicDir, 'listen.html'), '<!doctype html><title>Listen</title>');
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

  it('serves the listen page', async () => {
    const page = await fetch(`${base}/listen`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>Listen</title>');
  });

  describe('sound from the listen page', () => {
    const sound = (count = 4800) => toInt16(new Float32Array(count).fill(0.5));
    const audio = (
      body: Uint8Array,
      headers: Record<string, string> = { 'x-rate': '48000', 'x-index': '0', 'x-feed': 'f1' },
    ) =>
      fetch(`${base}/api/audio`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', ...headers },
        body,
      });

    it('takes a block of sound and hands it to the microphone source', async () => {
      const blocks: AudioBlock[] = [];
      rig.mic.on('block', (block: AudioBlock) => blocks.push(block));
      const response = await audio(sound(), {
        'x-rate': '48000',
        'x-index': '9600',
        'x-feed': 'f1',
      });
      expect(response.status).toBe(204);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.samples.length).toBe(4800);
      expect(blocks[0]?.index).toBe(9600);
      expect(blocks[0]?.sampleRate).toBe(48_000);
      expect(rig.mic.getStatus()).toBe('live');
    });

    it('says what is wrong with sound that cannot be used, and keeps nothing of it', async () => {
      const blocks: AudioBlock[] = [];
      rig.mic.on('block', (block: AudioBlock) => blocks.push(block));
      const noRate = await audio(sound(), { 'x-index': '0', 'x-feed': 'f1' });
      expect(noRate.status).toBe(400);
      expect(await error(noRate)).toMatch(/x-rate/);
      const noFeed = await audio(sound(), { 'x-rate': '48000', 'x-index': '0' });
      expect(noFeed.status).toBe(400);
      expect(await error(noFeed)).toMatch(/x-feed/);
      const odd = await audio(new Uint8Array(3));
      expect(odd.status).toBe(400);
      expect(await error(odd)).toMatch(/even/);
      expect(blocks).toHaveLength(0);
      expect(rig.mic.getStatus()).toBe('waiting');
    });

    it('refuses a body that is too large', async () => {
      const response = await audio(new Uint8Array(300 * 1024));
      expect(response.status).toBe(400);
      expect(await error(response)).toMatch(/too large/);
    });
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
    expect(spider.details.effects).toHaveLength(10);
    expect(spider.details.layout.cells).toBe(8);
    expect(spider.state.levels.dimmer).toBe(0);
    expect(spider.state.effect.id).toBeNull();
    expect(spider.dmx).toHaveLength(43);
    expect(second.address).toBe(101);

    expect(laser).toEqual(expect.objectContaining({ kind: 'laser', footprint: 10, address: 44 }));
    expect(laser.details).toEqual(expect.objectContaining({ gate: 'mode', effectsIn: 'manual' }));
    expect(laser.details.effects.map((e: { id: string }) => e.id)).toEqual([
      'patterns',
      'colours',
      'pulse',
      'sweep',
      'twist',
    ]);
    expect(laser.state.effect).toEqual({ id: null, speed: 1 });
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
    expect((await post('/api/fixtures/spider/update', { blackout: true })).status).toBe(400);
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

  describe('listening', () => {
    it('describes who sets the tempo and what is heard', async () => {
      const got = await state();
      expect(got.tempo).toMatchObject({ source: 'manual', running: true });
      expect(got.audio).toMatchObject({
        following: false,
        heard: 'none',
        source: { id: 'browser-mic', status: 'waiting' },
      });
      expect(got.audio.settings).toMatchObject({ onSilence: 'stop', onNoBeat: 'hold' });
    });

    it('hands the tempo to the listening and takes it back', async () => {
      expect((await post('/api/tempo', { source: 'audio' })).status).toBe(200);
      let got = await state();
      expect(got.tempo.source).toBe('audio');
      expect(got.audio.following).toBe(true);
      expect((await post('/api/tempo', { source: 'manual', bpm: 130 })).status).toBe(200);
      got = await state();
      expect(got.tempo).toMatchObject({ source: 'manual', bpm: 130, running: true });
      expect(got.audio.following).toBe(false);
    });

    it('refuses a source it does not know, and changes nothing', async () => {
      const response = await post('/api/tempo', { source: 'link' });
      expect(response.status).toBe(400);
      expect(await error(response)).toMatch(/manual or audio/);
      expect((await state()).tempo.source).toBe('manual');
    });

    it('changes the settings and answers with all of them', async () => {
      const response = await post('/api/audio/settings', { onSilence: 'hold', silenceAfter: 4 });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { settings: Record<string, unknown> };
      expect(body.settings).toMatchObject({ onSilence: 'hold', silenceAfter: 4, onNoBeat: 'hold' });
      expect((await state()).audio.settings).toMatchObject({ onSilence: 'hold', silenceAfter: 4 });
    });

    it('says what is wrong with a setting, and changes nothing', async () => {
      const response = await post('/api/audio/settings', { silenceAfter: 4, onSilence: 'dim' });
      expect(response.status).toBe(400);
      expect(await error(response)).toMatch(/stop or hold/);
      const unknown = await post('/api/audio/settings', { colour: 'red' });
      expect(unknown.status).toBe(400);
      expect((await state()).audio.settings.silenceAfter).toBe(2);
    });

    it('streams what is heard, now and when it changes', async () => {
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
      await readUntil('event: audio');
      expect(text).toContain('"heard":"none"');
      await post('/api/audio/settings', { silenceAfter: 7 });
      await readUntil('"silenceAfter":7');
      expect(text).toContain('"silenceAfter":7');
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
  const STARTING = [
    { id: 'spider', label: 'Spider', fixtures: ['spider'], scenes: [] },
    { id: 'spider-2', label: 'Spider 2', fixtures: ['spider-2'], scenes: [] },
    { id: 'laser', label: 'Laser', fixtures: ['laser'], scenes: [] },
    { id: 'all', label: 'All', fixtures: ['spider', 'spider-2', 'laser'], scenes: [] },
  ];

  it('describes the show and what is on', async () => {
    const body = await state();
    expect(body.show).toEqual({ file: null, problem: null, groups: STARTING });
    expect(body.playback).toEqual({
      groups: { spider: NONE, 'spider-2': NONE, laser: NONE, all: NONE },
    });
  });

  it('stores the fixtures of a group as a scene and sets them to it again', async () => {
    await post('/api/fixtures/spider/update', { levels: { dimmer: 1 } });
    await post('/api/fixtures/laser/update', { raw: { mode: MANUAL } });
    const stored = await post('/api/groups/all/scenes', { label: 'Warm', client: 'tablet-1' });
    expect(await stored.json()).toEqual({ ok: true, id: 'warm' });

    await post('/api/fixtures/spider/update', { levels: { dimmer: 0 } });
    await post('/api/fixtures/laser/update', { raw: { mode: 0 } });
    expect((await state()).playback.groups.all).toEqual({ scene: 'warm', changed: true });

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
        spider: NONE,
        'spider-2': NONE,
        laser: NONE,
        all: { scene: 'warm', changed: false },
      },
    });
    expect(now.show.groups[3].scenes).toEqual([
      { id: 'warm', label: 'Warm', fixtures: ['spider', 'laser'] },
    ]);
    expect(now.show.groups.slice(0, 3)).toEqual(STARTING.slice(0, 3));
  });

  it('has a scene on in two groups at once, and darkens one of them with off', async () => {
    await post('/api/fixtures/spider/update', { levels: { dimmer: 1 } });
    await post('/api/fixtures/laser/update', { raw: { mode: MANUAL } });
    await post('/api/groups/spider/scenes', { label: 'Warm' });
    await post('/api/groups/laser/scenes', { label: 'Open' });
    await post('/api/playback', { group: 'all', off: true });
    expect(ch(output, 6)).toBe(0);
    expect(ch(output, LASER_AT)).toBe(0);

    expect((await post('/api/playback', { group: 'laser', scene: 'open' })).status).toBe(200);
    expect((await post('/api/playback', { group: 'spider', scene: 'warm' })).status).toBe(200);
    expect(ch(output, 6)).toBe(255);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
    expect((await state()).playback.groups).toEqual({
      spider: { scene: 'warm', changed: false },
      'spider-2': NONE,
      laser: { scene: 'open', changed: false },
      all: NONE,
    });

    const off = await post('/api/playback', { group: 'spider', off: true, client: 'tablet-1' });
    expect(off.status).toBe(200);
    expect(ch(output, 6)).toBe(0);
    expect(ch(output, LASER_AT)).toBe(MANUAL);
    expect((await state()).playback.groups).toEqual({
      spider: NONE,
      'spider-2': NONE,
      laser: { scene: 'open', changed: false },
      all: NONE,
    });
  });

  it('stores and recalls under the master without moving it', async () => {
    await post('/api/fixtures/spider/update', { levels: { dimmer: 1 } });
    await post('/api/fixtures/laser/update', { raw: { mode: MANUAL } });
    await post('/api/master', { master: 0.5 });
    await post('/api/groups/all/scenes', { label: 'Warm' });
    expect((await state()).playback.groups.all).toEqual({ scene: 'warm', changed: false });
    await post('/api/master', { master: 0 });
    expect((await state()).playback.groups.all).toEqual({ scene: 'warm', changed: false });

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
    await post('/api/groups/laser/scenes', { label: 'Open' });
    await post('/api/playback', { group: 'laser', off: true });
    await post('/api/blackout', { blackout: true });
    expect((await post('/api/playback', { group: 'laser', scene: 'open' })).status).toBe(200);
    expect(ch(output, LASER_AT)).toBe(0);
    await post('/api/blackout', { blackout: false });
    expect(ch(output, LASER_AT)).toBe(MANUAL);
  });

  it('stores over, renames and deletes a scene of a group', async () => {
    await post('/api/groups/spider-2/scenes', { label: 'Warm' });
    await post('/api/groups/laser/scenes', { label: 'Warm' });
    await post('/api/fixtures/spider-2/update', { levels: { dimmer: 1 } });
    expect((await post('/api/groups/spider-2/scenes/warm/store', {})).status).toBe(200);
    expect(
      (await post('/api/groups/spider-2/scenes/warm/rename', { label: 'Warm up' })).status,
    ).toBe(200);
    const stored = await state();
    expect(stored.show.groups[1].scenes).toEqual([
      { id: 'warm', label: 'Warm up', fixtures: ['spider-2'] },
    ]);
    expect(stored.show.groups[2].scenes).toEqual([{ id: 'warm', label: 'Warm', fixtures: [] }]);

    expect((await post('/api/groups/spider-2/scenes/warm/delete', {})).status).toBe(200);
    const deleted = await state();
    expect(deleted.show.groups[1].scenes).toEqual([]);
    expect(deleted.show.groups[2].scenes).toHaveLength(1);
    expect(deleted.playback.groups['spider-2']).toEqual(NONE);
  });

  it('makes, renames and deletes a group', async () => {
    const made = await post('/api/groups', {
      label: 'Spiders',
      fixtures: ['spider', 'spider-2'],
      client: 'tablet-1',
    });
    expect(made.status).toBe(200);
    expect(await made.json()).toEqual({ ok: true, id: 'spiders' });
    expect((await post('/api/groups/spiders/scenes', { label: 'Warm' })).status).toBe(200);
    expect((await post('/api/groups/spiders/rename', { label: 'Both spiders' })).status).toBe(200);
    const now = await state();
    expect(now.show.groups).toEqual([
      ...STARTING,
      {
        id: 'spiders',
        label: 'Both spiders',
        fixtures: ['spider', 'spider-2'],
        scenes: [{ id: 'warm', label: 'Warm', fixtures: [] }],
      },
    ]);
    expect(now.playback.groups.spiders).toEqual({ scene: 'warm', changed: false });

    expect((await post('/api/groups/spiders/delete', {})).status).toBe(200);
    const after = await state();
    expect(after.show.groups).toEqual(STARTING);
    expect(after.playback.groups.spiders).toBeUndefined();
  });

  it('says what is wrong with a request about groups and scenes', async () => {
    await post('/api/groups/spider/scenes', { label: 'Warm' });
    const refused: [string, unknown, string][] = [
      ['/api/groups/spider/scenes', {}, 'a scene needs a name'],
      ['/api/groups/strobe/scenes', { label: 'Warm' }, 'there is no group called "strobe"'],
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
        'say a scene or off, not both',
      ],
      [
        '/api/playback',
        { group: 'spider', scene: 'warm', fade: 2 },
        'the playback cannot set "fade", only group, scene, off',
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
    await readUntil(
      `event: playback\ndata: {"groups":{"spider":${none},"spider-2":${none},"laser":${none},"all":${none}}}`,
    );
    expect(text).toContain(
      `event: show\ndata: ${JSON.stringify({ file: null, problem: null, groups: STARTING })}`,
    );

    await post('/api/groups/laser/scenes', { label: 'Warm' });
    await readUntil(
      `event: playback\ndata: {"groups":{"spider":${none},"spider-2":${none},"laser":{"scene":"warm","changed":false},"all":${none}}}`,
    );
    expect(text).toContain(
      '{"id":"laser","label":"Laser","fixtures":["laser"],"scenes":[{"id":"warm","label":"Warm","fixtures":[]}]}',
    );

    await post('/api/groups', { label: 'Front', fixtures: ['spider'] });
    await readUntil(`"all":${none},"front":${none}}}`);
    expect(text).toContain('{"id":"front","label":"Front","fixtures":["spider"],"scenes":[]}');
    abort.abort();
  });
});
