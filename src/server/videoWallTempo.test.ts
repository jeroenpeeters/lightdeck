import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackInfo } from '../inputs/rkbx/follower.js';
import { Tempo } from './tempo.js';
import { VideoWall } from './videoWall.js';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

/** The tempo goes to Dreamscape Player's `POST /api/bpm`, on its own, and never makes anything fail. */
describe('VideoWall tempo', () => {
  let calls: Call[];
  let answer: () => Response | Promise<Response>;
  let tempo: Tempo;
  let wall: VideoWall;
  const logged: string[] = [];

  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? '', body: JSON.parse(String(init.body ?? '{}')) });
    return answer();
  }) as unknown as typeof fetch;
  const bpmCalls = () => calls.filter((c) => c.url.endsWith('/api/bpm'));

  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    logged.length = 0;
    answer = () => new Response('{"success":true}', { status: 200 });
    tempo = new Tempo();
    tempo.update({ bpm: 120 });
    const source = Object.assign(new EventEmitter(), {
      getTrack: (): TrackInfo | undefined => undefined,
    });
    wall = new VideoWall({ source, tempo, fetch: fetcher, log: (m) => logged.push(m) });
  });
  afterEach(() => {
    wall.close();
    vi.useRealTimers();
  });

  it('is on at the start, and says beat one at the first bar line', async () => {
    expect(wall.getState().settings.syncTempo).toBe(true);
    expect(wall.getState().tempo).toBeNull();
    await vi.advanceTimersByTimeAsync(2100);
    expect(bpmCalls()).toEqual([
      {
        url: 'http://192.168.68.30:3000/api/bpm',
        method: 'POST',
        body: { bpm: 120, downbeat: true },
      },
    ]);
    expect(wall.getState().tempo).toMatchObject({ bpm: 120, downbeat: true, ok: true });
  });

  it('sends a bpm that changes without a downbeat, and the PIN in the body', async () => {
    wall.update({ pin: '1234' });
    await vi.advanceTimersByTimeAsync(100);
    tempo.update({ bpm: 128 });
    await vi.advanceTimersByTimeAsync(0);
    expect(bpmCalls()).toEqual([
      {
        url: 'http://192.168.68.30:3000/api/bpm',
        method: 'POST',
        body: { bpm: 128, pin: '1234' },
      },
    ]);
  });

  it('sends nothing when it is switched off, and picks up at a bar line when switched on', async () => {
    wall.update({ syncTempo: false });
    tempo.update({ bpm: 130 });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(bpmCalls()).toEqual([]);
    wall.update({ syncTempo: true });
    await vi.advanceTimersByTimeAsync(2100);
    expect(bpmCalls().map((c) => c.body)).toEqual([{ bpm: 130, downbeat: true }]);
  });

  it('says a wall that refuses once, keeps going, and does not touch the text of the wall', async () => {
    answer = () => new Response('{"error":"nope"}', { status: 500 });
    await vi.advanceTimersByTimeAsync(2100);
    tempo.update({ bpm: 125 });
    await vi.advanceTimersByTimeAsync(0);
    expect(wall.getState().tempo).toMatchObject({ ok: false, error: 'The video wall says: nope' });
    expect(wall.getState().last).toBeNull();
    expect(logged).toEqual(['video wall: tempo not sent: The video wall says: nope']);
    answer = () => new Response('{}', { status: 200 });
    tempo.update({ bpm: 126 });
    await vi.advanceTimersByTimeAsync(300);
    expect(wall.getState().tempo).toMatchObject({ bpm: 126, ok: true });
  });

  it('does not wait for a wall that does not answer', async () => {
    answer = () => new Promise<Response>(() => undefined);
    await vi.advanceTimersByTimeAsync(2100);
    tempo.update({ bpm: 125 });
    await vi.advanceTimersByTimeAsync(SYNC_PLUS);
    // the downbeats of later minutes are made though the earlier calls never came back
    expect(bpmCalls().filter((c) => c.body.downbeat === true).length).toBeGreaterThanOrEqual(2);
  });

  it('validates the setting', () => {
    expect(() => wall.update({ syncTempo: 'yes' })).toThrow(/syncTempo/);
  });
});

const SYNC_PLUS = 65_000;
