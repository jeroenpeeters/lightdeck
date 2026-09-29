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

  it('goes from the front door to the page of the first fixture', async () => {
    const response = await fetch(`${base}/`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/fixtures/spider');
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
    expect(laser.details).toEqual({ gate: 'mode' });
    expect(laser.controls[0].ranges[1]).toEqual(
      expect.objectContaining({ from: 64, to: 127, key: 'manual', name: 'Manual' }),
    );
    expect(laser.state.raw.mode).toBe(0);
    expect(laser.dmx).toEqual(new Array(10).fill(0));

    expect(body.tempo).toEqual(
      expect.objectContaining({ bpm: 126, rate: 1, min: 60, max: 200, rates: [0.5, 1, 2] }),
    );
    expect(typeof body.tempo.beat).toBe('number');
    expect(body.blackout).toBe(false);
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

    rig.setBridgeConnected(true);
    await readUntil('"bridge":true');
    expect(text).toContain('"bridge":true');
    abort.abort();
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
});
