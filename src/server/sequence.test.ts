import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpServer } from './http.js';
import { Rig } from './rig.js';
import type { SequenceState } from './sequencer.js';
import { RecordingOutput } from './testing.js';

const SHOW = `groups:
  spider:
    label: Spider
    fixtures: [spider]
    scenes:
      bright: { type: lights, fixtures: { spider: { levels: { dimmer: 1 } } } }
      dim: { type: lights, fixtures: { spider: { levels: { dimmer: 0.5 } } } }
    looks:
      bright: { lights: bright }
      dim: { lights: dim }
      spare: { lights: dim }
  laser:
    label: Laser
    fixtures: [laser]
    scenes:
      open: { type: lights, fixtures: { laser: { raw: { mode: 95 } } } }
    looks:
      open: { lights: open }
sequences:
  night:
    label: The night
    steps:
      - { bars: 2, looks: { spider: bright, laser: open } }
      - { bars: 1, looks: { spider: dim } }
  other:
    steps:
      - { bars: 1, looks: { spider: off } }
`;

const FIXTURES = [
  { id: 'spider', kind: 'spider', label: 'Spider', universe: 0, address: 1 },
  { id: 'laser', kind: 'laser', label: 'Laser', universe: 0, address: 44 },
];

describe('a sequence on a rig', () => {
  const BAR = 2000;
  let dir: string;
  let rig: Rig;
  let origin: number;
  let laserChanges: number;

  const dimmer = () => {
    const spider = rig.find('spider');
    if (!spider) throw new Error('no spider in the rig');
    return (spider.controller.getState() as { levels: { dimmer: number } }).levels.dimmer;
  };
  const goTo = (bars: number) => vi.advanceTimersByTime(origin + bars * BAR + 5 - Date.now());

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    dir = mkdtempSync(join(tmpdir(), 'lightdeck-sequence-'));
    const path = join(dir, 'show.yaml');
    writeFileSync(path, SHOW);
    origin = Date.now();
    rig = new Rig({
      output: new RecordingOutput(),
      fixtures: FIXTURES as never,
      show: path,
      now: () => Date.now(),
    });
    rig.tempo.update({ bpm: 120 });
    laserChanges = 0;
    rig.on('fixture', (id: string) => {
      if (id === 'laser') laserChanges++;
    });
  });

  afterEach(() => {
    rig.close();
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('is in the show, and does nothing until it is started', () => {
    expect(rig.playback.getShow().sequences).toEqual([
      {
        id: 'night',
        label: 'The night',
        steps: [
          { bars: 2, looks: { spider: 'bright', laser: 'open' } },
          { bars: 1, looks: { spider: 'dim' } },
        ],
      },
      { id: 'other', label: 'other', steps: [{ bars: 1, looks: { spider: 'off' } }] },
    ]);
    vi.advanceTimersByTime(BAR * 10);
    expect(rig.sequencer.getState().running).toBeNull();
    expect(dimmer()).toBe(0);
  });

  it('sets the looks of the first step as a press does, and then steps on the bars', () => {
    const seen: SequenceState[] = [];
    rig.on('sequence', (state: SequenceState) => seen.push(state));
    rig.sequencer.start('night');
    expect(dimmer()).toBe(1);
    expect(rig.playback.getState().groups.spider?.look).toEqual({ look: 'bright', changed: false });
    expect(rig.playback.getState().groups.laser?.look).toEqual({ look: 'open', changed: false });
    expect(laserChanges).toBeGreaterThan(0);
    const changes = laserChanges;

    goTo(1);
    expect(dimmer()).toBe(1);
    goTo(2);
    expect(dimmer()).toBe(0.5);
    expect(rig.playback.getState().groups.spider?.look).toEqual({ look: 'dim', changed: false });
    goTo(3);
    expect(dimmer()).toBe(1);
    // The laser is in no step after the first and is never set again.
    expect(laserChanges).toBe(changes);
    expect(seen.length).toBeGreaterThan(3);
    expect(seen.at(-1)).toMatchObject({ running: 'night', step: 0 });
  });

  it('lets a press by hand stand until the next step that changes that group', () => {
    rig.sequencer.start('night');
    goTo(2);
    expect(dimmer()).toBe(0.5);
    // The operator presses the bright look of the spider by hand.
    rig.playback.playLook('spider', 'bright');
    expect(dimmer()).toBe(1);
    // The sequence goes on, and its next step sets the spider again: bright, as the pressed
    // look was set by hand and the sequence last set dim.
    goTo(3);
    expect(dimmer()).toBe(1);
    goTo(5);
    expect(dimmer()).toBe(0.5);
  });

  it('leaves the fixtures as they are when it stops', () => {
    rig.sequencer.start('night');
    goTo(2);
    rig.sequencer.stop();
    goTo(10);
    expect(dimmer()).toBe(0.5);
    expect(rig.sequencer.getState().running).toBeNull();
  });

  it('can set the lights of a group off', () => {
    rig.sequencer.start('other');
    expect(dimmer()).toBe(0);
    expect(rig.playback.getState().groups.spider?.lights.scene).toBeNull();
  });

  it('does not let a look or a group that a sequence uses be deleted', () => {
    expect(() => rig.playback.removeLook('spider', 'bright')).toThrow(
      'the look "bright" is used by the sequence "The night". Change or delete the sequence first',
    );
    expect(() => rig.playback.removeLook('spider', 'dim')).toThrow(/used by the sequence/);
    expect(() => rig.playback.removeGroup('laser')).toThrow(
      'the group "Laser" is used by the sequence "The night". Change or delete the sequence first',
    );
    expect(() => rig.playback.removeGroup('spider')).toThrow(/used by the sequence/);
    // A look that no sequence names can go.
    rig.playback.removeLook('spider', 'spare');
    expect(rig.playback.getShow().groups[0]?.looks.map((look) => look.id)).toEqual([
      'bright',
      'dim',
    ]);
  });
});

describe('the sequence API', () => {
  let dir: string;
  let rig: Rig;
  let server: Server;
  let base: string;

  const post = (path: string, body: unknown) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const error = async (response: Response) => ((await response.json()) as { error: string }).error;
  // biome-ignore lint/suspicious/noExplicitAny: shapes are asserted field by field
  const state = async () => (await (await fetch(`${base}/api/state`)).json()) as any;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lightdeck-sequence-api-'));
    const path = join(dir, 'show.yaml');
    writeFileSync(path, SHOW);
    const publicDir = join(dir, 'public');
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, 'deck.html'), '<!doctype html><title>Deck</title>');
    rig = new Rig({ output: new RecordingOutput(), fixtures: FIXTURES as never, show: path });
    server = createHttpServer({ rig, publicDir, bridgeUrl: null });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    rig.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('tells the sequences of the show and that none runs', async () => {
    const body = await state();
    expect(body.show.sequences.map((sequence: { id: string }) => sequence.id)).toEqual([
      'night',
      'other',
    ]);
    expect(body.sequence).toEqual({
      running: null,
      step: -1,
      steps: 0,
      barsLeft: 0,
      paused: false,
      problem: null,
    });
  });

  it('starts a sequence and stops it', async () => {
    const started = await post('/api/sequence', { start: 'night' });
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({ ok: true });
    expect((await state()).sequence).toMatchObject({
      running: 'night',
      step: 0,
      steps: 2,
      barsLeft: 2,
    });
    expect((await state()).playback.groups.spider.look).toEqual({ look: 'bright', changed: false });

    const stopped = await post('/api/sequence', { stop: true });
    expect(stopped.status).toBe(200);
    expect((await state()).sequence.running).toBeNull();
    // The fixtures stay as they are.
    expect((await state()).playback.groups.spider.look.look).toBe('bright');
  });

  it('stops the sequence that runs when another is started', async () => {
    await post('/api/sequence', { start: 'night' });
    await post('/api/sequence', { start: 'other' });
    expect((await state()).sequence).toMatchObject({ running: 'other', steps: 1 });
  });

  it('answers a bad request with 400 and changes nothing', async () => {
    await post('/api/sequence', { start: 'night' });
    for (const [body, message] of [
      [{ start: 'nope' }, 'there is no sequence called "nope"'],
      [{ start: 3 }, 'say which sequence, by its id'],
      [{}, 'say which sequence to start, or stop: true'],
      [{ start: 'night', stop: true }, 'say which sequence to start, or stop: true'],
      [{ stop: false }, '"stop" can only be true'],
      [{ halt: true }, /halt/],
    ] as const) {
      const refused = await post('/api/sequence', body);
      expect(refused.status).toBe(400);
      expect(await error(refused)).toMatch(
        typeof message === 'string'
          ? new RegExp(message.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&'))
          : message,
      );
    }
    expect((await state()).sequence.running).toBe('night');
  });

  it('refuses to delete a look or a group a sequence uses, with the reason', async () => {
    const look = await post('/api/groups/spider/looks/bright/delete', {});
    expect(look.status).toBe(400);
    expect(await error(look)).toMatch(/used by the sequence "The night"/);
    const group = await post('/api/groups/laser/delete', {});
    expect(group.status).toBe(400);
    expect(await error(group)).toMatch(/group "Laser" is used by the sequence/);
    expect((await post('/api/groups/spider/looks/spare/delete', {})).status).toBe(200);
  });

  it('streams where the sequence is, to a page that connects and when it starts', async () => {
    const response = await fetch(`${base}/api/events`);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };
    await readUntil('event: sequence');
    expect(text).toContain('event: sequence\ndata: {"running":null');
    await post('/api/sequence', { start: 'night' });
    await readUntil('"running":"night"');
    expect(text).toContain('"running":"night","step":0');
    await reader.cancel();
  });
});
