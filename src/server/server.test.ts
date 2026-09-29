import { mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPIDER_43CH, SPIDER_LAYOUT } from '../fixtures/spider.js';
import { PatchError, SpiderController, type SpiderState } from './controller.js';
import { createHttpServer } from './http.js';

class RecordingOutput {
  frames: { index: number; data: Uint8Array }[] = [];
  setUniverse(index: number, data: Uint8Array): void {
    this.frames.push({ index, data: data.slice() });
  }
  get last(): Uint8Array {
    return (this.frames[this.frames.length - 1] as { data: Uint8Array }).data;
  }
}

/** 1-based DMX channel in the last frame that was sent. */
const ch = (output: RecordingOutput, channel: number) => output.last[channel - 1];

describe('SpiderController', () => {
  let output: RecordingOutput;
  let controller: SpiderController;

  beforeEach(() => {
    output = new RecordingOutput();
    controller = new SpiderController({
      profile: SPIDER_43CH,
      layout: SPIDER_LAYOUT,
      output,
      universe: 1,
      address: 1,
      resetHoldMs: 3500,
    });
  });
  afterEach(() => controller.close());

  it('sends a dark frame on its universe when it starts', () => {
    expect(output.frames).toHaveLength(1);
    expect(output.frames[0]?.index).toBe(1);
    expect(output.last).toHaveLength(512);
    expect([...output.last].every((b) => b === 0)).toBe(true);
  });

  it('turns a change into DMX and tells the listeners who made it', () => {
    const seen: { state: SpiderState; origin: string | undefined }[] = [];
    controller.on('state', (state, origin) => seen.push({ state, origin }));
    controller.update({ levels: { dimmer: 1, red3: 0.5 } }, 'tablet');
    expect(ch(output, 6)).toBe(255);
    expect(ch(output, 15)).toBe(128);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.origin).toBe('tablet');
    expect(seen[0]?.state.levels.red3).toBe(0.5);
  });

  it('keeps earlier values when only one thing changes', () => {
    controller.update({ levels: { dimmer: 1, blue8: 1 } });
    controller.update({ levels: { tilt1: 0.5 } });
    expect(ch(output, 6)).toBe(255);
    expect(ch(output, 37)).toBe(255);
    expect([ch(output, 1), ch(output, 2)]).toEqual([0x80, 0x00]);
  });

  it('places the fixture at its start address', () => {
    const shifted = new SpiderController({
      profile: SPIDER_43CH,
      layout: SPIDER_LAYOUT,
      output,
      universe: 0,
      address: 101,
    });
    shifted.update({ levels: { dimmer: 1 } });
    expect(output.frames[output.frames.length - 1]?.index).toBe(0);
    expect(ch(output, 106)).toBe(255);
    expect(ch(output, 6)).toBe(0);
    shifted.close();
  });

  it('refuses an address where the fixture does not fit', () => {
    expect(
      () =>
        new SpiderController({
          profile: SPIDER_43CH,
          layout: SPIDER_LAYOUT,
          output,
          universe: 0,
          address: 480,
        }),
    ).toThrow(RangeError);
  });

  it('clamps levels instead of rejecting them', () => {
    controller.update({ levels: { dimmer: 7, red1: -2 } });
    expect(controller.getState().levels.dimmer).toBe(1);
    expect(controller.getState().levels.red1).toBe(0);
  });

  it('applies nothing when part of a change is invalid', () => {
    expect(() => controller.update({ levels: { dimmer: 1, red9: 1 } })).toThrow(PatchError);
    expect(() => controller.update({ levels: { dimmer: 'full' } })).toThrow(PatchError);
    expect(() => controller.update({ levels: { function: 1 } })).toThrow(PatchError);
    expect(() => controller.update({ raw: { function: 300 } })).toThrow(PatchError);
    expect(() => controller.update({ raw: { dimmer: 10 } })).toThrow(PatchError);
    expect(() => controller.update({ blackout: 'yes' })).toThrow(PatchError);
    expect(controller.getState().levels.dimmer).toBe(0);
    expect(output.frames).toHaveLength(1);
  });

  it('blackout darkens the light but keeps colour, position and the stored levels', () => {
    controller.update({ levels: { dimmer: 0.8, strobe: 0.5, red1: 1, tilt1: 1 } });
    controller.update({ blackout: true });
    expect(ch(output, 6)).toBe(0);
    expect(ch(output, 39)).toBe(0);
    expect(ch(output, 7)).toBe(255);
    expect(ch(output, 1)).toBe(255);
    expect(controller.getState().levels.dimmer).toBe(0.8);

    controller.update({ blackout: false });
    expect(ch(output, 6)).toBe(204);
    expect(ch(output, 39)).toBeGreaterThan(0);
  });

  it('sets a built-in program only through its raw byte', () => {
    controller.update({ raw: { function: 5, effectSpeed: 200 } });
    expect(ch(output, 40)).toBe(5);
    expect(ch(output, 42)).toBe(200);
    expect(ch(output, 43)).toBe(0);
  });

  it('cannot be reset through an ordinary change', () => {
    expect(() => controller.update({ raw: { reset: 255 } })).toThrow(PatchError);
    expect(ch(output, 43)).toBe(0);
  });

  it('holds the reset byte for the hold time and then releases it', () => {
    vi.useFakeTimers();
    try {
      controller.update({ levels: { dimmer: 1 } });
      controller.resetFixture();
      expect(ch(output, 43)).toBe(255);
      expect(controller.getState().resetting).toBe(true);
      vi.advanceTimersByTime(3499);
      expect(ch(output, 43)).toBe(255);
      vi.advanceTimersByTime(1);
      expect(ch(output, 43)).toBe(0);
      expect(controller.getState().resetting).toBe(false);
      expect(ch(output, 6)).toBe(255);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the DMX bytes of the fixture', () => {
    controller.update({ levels: { dimmer: 1, white8: 1 } });
    const dmx = controller.getDmx();
    expect(dmx).toHaveLength(43);
    expect(dmx[5]).toBe(255);
    expect(dmx[37]).toBe(255);
  });

  it('tracks the link and forgets the device when the bridge goes away', () => {
    const seen: unknown[] = [];
    controller.on('status', (s) => seen.push(s));
    controller.setBridgeConnected(true);
    controller.setDeviceStatus({ device: 'open', universes: 2, channels: [512, 0] });
    expect(controller.getStatus()).toEqual({
      bridge: true,
      device: 'open',
      universes: 2,
      channels: [512, 0],
    });
    controller.setBridgeConnected(false);
    expect(controller.getStatus()).toEqual({
      bridge: false,
      device: 'unknown',
      universes: 0,
      channels: [],
    });
    expect(seen).toHaveLength(3);
  });
});

describe('SpiderController effects', () => {
  let output: RecordingOutput;
  let controller: SpiderController;
  let clock: number;

  /** Moves the controller's clock and the timers forward together. */
  const advance = (ms: number) => {
    for (let done = 0; done < ms; done += 25) {
      clock += 25;
      vi.advanceTimersByTime(25);
    }
  };

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1000;
    output = new RecordingOutput();
    controller = new SpiderController({
      profile: SPIDER_43CH,
      layout: SPIDER_LAYOUT,
      output,
      universe: 0,
      address: 1,
      now: () => clock,
    });
  });
  afterEach(() => {
    controller.close();
    vi.useRealTimers();
  });

  it('starts without an effect and with a house tempo', () => {
    const { effect } = controller.getState();
    expect(effect.id).toBeNull();
    expect(effect.bpm).toBe(126);
    expect(effect.rate).toBe(1);
  });

  it('sends a new frame forty times per second while an effect runs', () => {
    controller.update({ levels: { dimmer: 1 }, effect: { id: 'chase' } });
    const before = output.frames.length;
    advance(1000);
    expect(output.frames.length - before).toBe(40);
    const pictures = new Set(output.frames.slice(before).map((f) => f.data.slice(6, 38).join()));
    expect(pictures.size).toBeGreaterThan(20);
  });

  it('sends nothing on its own when no effect runs', () => {
    controller.update({ levels: { dimmer: 1, red1: 1 } });
    const before = output.frames.length;
    advance(1000);
    expect(output.frames.length).toBe(before);
  });

  it('lets the effect set the colours and keeps the rest with the operator', () => {
    controller.update({
      levels: { dimmer: 0.5, strobe: 0.2, motorSpeed: 0.3, tilt1: 0.9, green5: 1 },
      effect: { id: 'kick', sync: true },
    });
    // On the first beat of the bar the kick shows the second colour, blue by default.
    expect(ch(output, 9)).toBe(255); // blue1
    expect(ch(output, 24)).toBe(38); // green5 comes from the effect, not from the operator
    expect(ch(output, 6)).toBe(128); // dimmer
    expect(ch(output, 5)).toBe(77); // motor speed
    expect(ch(output, 1)).toBe(230); // tilt1, this effect does not move
    expect(ch(output, 39)).toBeGreaterThan(0); // strobe
    expect(controller.getState().levels.green5).toBe(1);
  });

  it('lets a moving effect tilt the bars', () => {
    controller.update({ levels: { tilt1: 0, tilt2: 0 }, effect: { id: 'scissor', sync: true } });
    advance(((60_000 / 126) * 2) | 0); // two beats: a quarter of the swing
    expect(ch(output, 1)).toBeGreaterThan(190);
    expect(ch(output, 3)).toBeLessThan(65);
  });

  it('goes back to the operator colours when the effect stops', () => {
    controller.update({ levels: { dimmer: 1, red1: 1 }, effect: { id: 'wave' } });
    advance(500);
    controller.update({ effect: { id: null } });
    expect(ch(output, 7)).toBe(255);
    expect(ch(output, 8)).toBe(0);
    const before = output.frames.length;
    advance(500);
    expect(output.frames.length).toBe(before);
  });

  it('stays dark during a blackout, while the effect keeps running', () => {
    controller.update({ levels: { dimmer: 1 }, effect: { id: 'kick' }, blackout: true });
    advance(300);
    expect(ch(output, 6)).toBe(0);
    controller.update({ blackout: false });
    expect(ch(output, 6)).toBe(255);
  });

  it('counts beats at the tempo and restarts the count on sync', () => {
    controller.update({ effect: { bpm: 120, sync: true } });
    expect(controller.getBeat()).toBe(0);
    advance(1000);
    expect(controller.getBeat()).toBeCloseTo(2);
    controller.update({ effect: { sync: true } });
    expect(controller.getBeat()).toBe(0);
  });

  it('keeps the beat it is on when the tempo changes', () => {
    controller.update({ effect: { bpm: 120, sync: true } });
    advance(1500);
    expect(controller.getBeat()).toBeCloseTo(3);
    controller.update({ effect: { bpm: 140 } });
    expect(controller.getBeat()).toBeCloseTo(3);
    advance(60_000 / 140);
    expect(controller.getBeat()).toBeCloseTo(4, 1);
  });

  it('runs the effect faster or slower with the rate', () => {
    const headAfterOneBeat = (rate: number) => {
      controller.update({
        levels: { dimmer: 1 },
        effect: { id: 'chase', bpm: 120, rate, sync: true },
      });
      advance(500);
      const reds = Array.from({ length: 8 }, (_, i) => ch(output, 7 + i * 4) ?? 0);
      return reds.indexOf(Math.max(...reds));
    };
    expect(headAfterOneBeat(1)).toBe(4);
    expect(headAfterOneBeat(0.5)).toBe(2);
    expect(headAfterOneBeat(2)).toBe(0);
  });

  it('uses the chosen colours', () => {
    controller.update({
      effect: {
        id: 'kick',
        sync: true,
        colourA: { red: 0, green: 1, blue: 0, white: 0 },
        colourB: { red: 0, green: 0, blue: 0, white: 1 },
      },
    });
    expect(ch(output, 10)).toBe(255); // white1 on the first beat
    advance(60_000 / 126 + 25);
    expect(ch(output, 8)).toBeGreaterThan(150); // green1 on the second
    expect(ch(output, 10)).toBe(0);
  });

  it('tells browsers what is shown, at a lower rate than it sends', () => {
    const frames: { dmx: number[]; beat: number }[] = [];
    controller.on('frame', (dmx, beat) => frames.push({ dmx, beat }));
    controller.update({ levels: { dimmer: 1 }, effect: { id: 'chase', sync: true } });
    advance(1000);
    expect(frames.length).toBeGreaterThanOrEqual(19);
    expect(frames.length).toBeLessThanOrEqual(21);
    expect(frames[0]?.dmx).toHaveLength(43);
    expect(frames[frames.length - 1]?.beat).toBeGreaterThan(1.9);
  });

  it('refuses effect settings that make no sense, and changes nothing', () => {
    const bad = [
      { id: 'disco' },
      { id: 7 },
      { bpm: 59 },
      { bpm: 201 },
      { bpm: 'fast' },
      { rate: 3 },
      { colourA: { red: 1 } },
      { colourB: 'blue' },
      { sync: 'yes' },
    ];
    for (const effect of bad) {
      expect(() => controller.update({ effect })).toThrow(PatchError);
    }
    expect(controller.getState().effect.id).toBeNull();
    expect(controller.getState().effect.bpm).toBe(126);
    advance(200);
    expect(output.frames).toHaveLength(1);
  });
});

describe('HTTP server', () => {
  let output: RecordingOutput;
  let controller: SpiderController;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    const publicDir = mkdtempSync(join(tmpdir(), 'lightdeck-public-'));
    writeFileSync(join(publicDir, 'index.html'), '<!doctype html><title>Spider</title>');
    writeFileSync(join(publicDir, 'app.js'), 'export {};');
    writeFileSync(join(publicDir, 'secret.key'), 'not served');

    output = new RecordingOutput();
    controller = new SpiderController({
      profile: SPIDER_43CH,
      layout: SPIDER_LAYOUT,
      output,
      universe: 1,
      address: 1,
    });
    server = createHttpServer({ controller, publicDir, bridgeUrl: 'ws://bridge:9010' });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    controller.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (path: string, body: unknown) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('serves the page and its assets', async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('Spider');
    const script = await fetch(`${base}/app.js`);
    expect(script.headers.get('content-type')).toContain('text/javascript');
  });

  it('serves nothing outside the public files', async () => {
    expect((await fetch(`${base}/secret.key`)).status).toBe(404);
    expect((await fetch(`${base}/../package.json`)).status).toBe(404);
    expect((await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`)).status).toBe(404);
    expect((await fetch(`${base}/missing.css`)).status).toBe(404);
  });

  it('describes the fixture, the settings and the state', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: shape is asserted field by field below
    const body = (await (await fetch(`${base}/api/state`)).json()) as any;
    expect(body.fixture.footprint).toBe(43);
    expect(body.fixture.controls).toHaveLength(SPIDER_43CH.controls.length);
    expect(body.config).toEqual({ universe: 1, address: 1, bridgeUrl: 'ws://bridge:9010' });
    expect(body.state.levels.dimmer).toBe(0);
    expect(body.state.raw.function).toBe(0);
    expect(body.dmx).toHaveLength(43);
    expect(body.status.bridge).toBe(false);
  });

  it('applies an update and sends it to the output', async () => {
    const response = await post('/api/update', { client: 'a', levels: { dimmer: 1, green2: 1 } });
    expect(response.status).toBe(200);
    expect(ch(output, 6)).toBe(255);
    expect(ch(output, 12)).toBe(255);
  });

  it('answers a bad update with 400 and says what is wrong', async () => {
    const unknown = await post('/api/update', { levels: { red9: 1 } });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toContain('red9');
    expect((await post('/api/update', 'not json')).status).toBe(400);
    expect((await post('/api/update', { raw: { reset: 255 } })).status).toBe(400);
    expect(output.frames).toHaveLength(1);
  });

  it('lists the ten effects and the tempo range', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: shape is asserted field by field below
    const body = (await (await fetch(`${base}/api/state`)).json()) as any;
    expect(body.effects).toHaveLength(10);
    expect(body.effects[0]).toEqual(
      expect.objectContaining({ id: 'kick', name: 'Kick', colours: 'both', moves: false }),
    );
    expect(body.tempo).toEqual({ min: 60, max: 200, rates: [0.5, 1, 2] });
    expect(body.fixture.layout.bars).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ]);
    expect(body.state.effect.id).toBeNull();
  });

  it('starts and stops an effect', async () => {
    expect((await post('/api/update', { effect: { id: 'sparkle', bpm: 128 } })).status).toBe(200);
    expect(controller.getState().effect).toEqual(
      expect.objectContaining({ id: 'sparkle', bpm: 128 }),
    );
    const unknown = await post('/api/update', { effect: { id: 'disco' } });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toContain('disco');
    expect((await post('/api/update', { effect: { id: null } })).status).toBe(200);
    expect(controller.getState().effect.id).toBeNull();
  });

  it('resets the fixture', async () => {
    expect((await post('/api/reset', {})).status).toBe(200);
    expect(ch(output, 43)).toBe(255);
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
    expect(text).toContain('event: state');

    await post('/api/update', { client: 'tablet-1', levels: { dimmer: 0.5 } });
    await readUntil('"origin":"tablet-1"');
    expect(text).toContain('"dimmer":0.5');

    controller.setBridgeConnected(true);
    await readUntil('"bridge":true');
    expect(text).toContain('"bridge":true');
    abort.abort();
  });
});
