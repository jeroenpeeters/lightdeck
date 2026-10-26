import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackInfo } from '../inputs/rkbx/follower.js';
import { VideoWall, type VideoWallState } from './videoWall.js';

interface Call {
  method: string;
  body: Record<string, unknown>;
}

describe('VideoWall', () => {
  let source: EventEmitter & { getTrack(): TrackInfo | undefined; playing?: TrackInfo };
  let calls: Call[];
  let answer: () => Response;
  let wall: VideoWall;

  const fetcher = (async (_url: string, init: RequestInit) => {
    calls.push({ method: init.method ?? '', body: JSON.parse(String(init.body ?? '{}')) });
    return answer();
  }) as unknown as typeof fetch;

  const track = (title: string, artist = 'Artist'): TrackInfo => ({ title, artist });
  /** rekordbox names a track, and the calls that follow have been made. */
  const play = async (next: TrackInfo) => {
    source.playing = next;
    source.emit('track', next);
    await vi.advanceTimersByTimeAsync(0);
  };
  const texts = () => calls.filter((c) => c.method === 'POST').map((c) => c.body.text);
  const state = (): VideoWallState => wall.getState();

  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    answer = () => new Response('{}', { status: 200 });
    source = Object.assign(new EventEmitter(), {
      getTrack(): TrackInfo | undefined {
        return source.playing;
      },
    });
    wall = new VideoWall({ source, fetch: fetcher });
  });
  afterEach(() => {
    wall.close();
    vi.useRealTimers();
  });

  it('is off at the start and calls the wall for no track', async () => {
    expect(state().settings.enabled).toBe(false);
    await play(track('Doppler'));
    expect(calls).toEqual([]);
    expect(state().track).toEqual(track('Doppler'));
  });

  describe('switched on', () => {
    beforeEach(() => wall.update({ enabled: true, durationSeconds: 10 }));

    it('shows a new track, as Title - Artist, in the place that was set', async () => {
      wall.update({ vertical: 'top', horizontal: 'right', size: 7, color: '#ffd700' });
      await play(track('Doppler', 'Charlotte de Witte'));
      expect(calls).toEqual([
        {
          method: 'POST',
          body: {
            text: 'Doppler - Charlotte de Witte',
            color: '#ffd700',
            vertical: 'top',
            horizontal: 'right',
            size: 7,
          },
        },
      ]);
      expect(state().shown?.text).toBe('Doppler - Charlotte de Witte');
      expect(state().last).toMatchObject({ action: 'show', ok: true });
    });

    it('calls the wall only for a new track, not for the same one again', async () => {
      await play(track('Doppler'));
      await play(track('Doppler'));
      await play(track('Doppler'));
      expect(calls).toHaveLength(1);
      await play(track('Exhale'));
      expect(texts()).toEqual(['Doppler - Artist', 'Exhale - Artist']);
    });

    it('takes the text away when the time is up, and not before', async () => {
      await play(track('Doppler'));
      await vi.advanceTimersByTimeAsync(9_900);
      expect(calls.map((c) => c.method)).toEqual(['POST']);
      await vi.advanceTimersByTimeAsync(200);
      expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE']);
      expect(state().shown).toBeNull();
      expect(state().last).toMatchObject({ action: 'clear', ok: true });
    });

    it('starts the time again for the next track, and does not take that one away early', async () => {
      await play(track('Doppler'));
      await vi.advanceTimersByTimeAsync(8_000);
      await play(track('Exhale'));
      await vi.advanceTimersByTimeAsync(8_000);
      expect(calls.map((c) => c.method)).toEqual(['POST', 'POST']);
      await vi.advanceTimersByTimeAsync(2_100);
      expect(calls.map((c) => c.method)).toEqual(['POST', 'POST', 'DELETE']);
    });

    it('leaves the text until the next track when the time is 0', async () => {
      wall.update({ durationSeconds: 0 });
      await play(track('Doppler'));
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(calls.map((c) => c.method)).toEqual(['POST']);
      expect(state().shown?.hideAt).toBeNull();
    });

    it('can show the artist under the title', async () => {
      wall.update({ lines: 'two' });
      await play(track('Doppler', 'Charlotte de Witte'));
      expect(texts()).toEqual(['Doppler\nCharlotte de Witte']);
    });

    it('cuts (Original Mix) off the title, sends it once, and keeps a new filter for the next track', async () => {
      await play(track('Doppler (Original Mix)', 'Charlotte de Witte'));
      expect(texts()).toEqual(['Doppler - Charlotte de Witte']);
      expect(state().track?.title).toBe('Doppler (Original Mix)');
      wall.update({ titleFilter: '' });
      expect(state().preview).toBe('Doppler (Original Mix) - Charlotte de Witte');
      expect(() => wall.update({ titleFilter: '(' })).toThrow(/regular expression/);
      expect(state().settings.titleFilter).toBe('');
      await play(track('Exhale (Original Mix)'));
      expect(texts()[1]).toBe('Exhale (Original Mix) - Artist');
    });

    it('says when the wall does not answer, and does not try again by itself', async () => {
      answer = () => new Response('{"error":"nope"}', { status: 400 });
      await play(track('Doppler'));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toHaveLength(1);
      expect(state().shown).toBeNull();
      expect(state().last).toMatchObject({ action: 'show', ok: false });
      expect(state().last?.error).toMatch(/nope/);
      answer = () => new Response('{}', { status: 200 });
      await play(track('Exhale'));
      expect(state().last).toMatchObject({ ok: true });
    });

    it('takes the text away when it is switched off', async () => {
      await play(track('Doppler'));
      wall.update({ enabled: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE']);
      await play(track('Exhale'));
      expect(calls).toHaveLength(2);
    });

    it('does not show the track that plays when it is switched on, but can on a press', async () => {
      wall.update({ enabled: false });
      await play(track('Doppler'));
      wall.update({ enabled: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual([]);
      await wall.sendCurrent();
      expect(texts()).toEqual(['Doppler - Artist']);
      await play(track('Doppler'));
      expect(calls).toHaveLength(1);
    });
  });

  describe('by hand', () => {
    it('tests with a sample and takes the text away for a press, and says why when it fails', async () => {
      await wall.test();
      expect(texts()).toEqual(['Track title - Artist']);
      await wall.clear();
      expect(calls.at(-1)?.method).toBe('DELETE');
      answer = () => new Response('{}', { status: 401 });
      await expect(wall.test()).rejects.toThrow(/PIN/);
    });

    it('takes a test away after 5 seconds when the text is to stay for good', async () => {
      wall.update({ durationSeconds: 0 });
      await wall.test();
      await vi.advanceTimersByTimeAsync(5_100);
      expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE']);
    });

    it('has no current track to send before rekordbox has said one', async () => {
      await expect(wall.sendCurrent()).rejects.toThrow(/not said/);
    });
  });

  describe('the settings', () => {
    let dir: string;
    let file: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'videowall-'));
      file = join(dir, 'videowall.json');
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('are kept in a file, with the PIN in it and not in what a page is told', () => {
      const first = new VideoWall({ source, file, fetch: fetcher });
      first.update({ enabled: true, pin: '1234', size: 10 });
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ pin: '1234', size: 10 });
      expect(JSON.stringify(first.getState())).not.toContain('1234');
      expect(first.getState().settings.pinSet).toBe(true);
      first.close();

      const again = new VideoWall({ source, file, fetch: fetcher });
      expect(again.getState().settings).toMatchObject({ enabled: true, size: 10, pinSet: true });
      again.close();
    });

    it('fall back to the defaults when the file is no use, and say so', () => {
      writeFileSync(file, '{"size": 99}');
      const log: string[] = [];
      const broken = new VideoWall({ source, file, fetch: fetcher, log: (m) => log.push(m) });
      expect(broken.getState().settings.size).toBe(6);
      expect(log[0]).toMatch(/not used/);
      broken.close();
    });

    it('are not changed by a change that is refused', () => {
      expect(() => wall.update({ size: 500 })).toThrow();
      expect(state().settings.size).toBe(6);
    });
  });

  it('tells the pages when something changes', async () => {
    const seen: VideoWallState[] = [];
    wall.on('videowall', (s: VideoWallState) => seen.push(s));
    wall.update({ enabled: true });
    await play(track('Doppler'));
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.at(-1)?.shown?.text).toBe('Doppler - Artist');
  });

  describe('the library and playback of the wall', () => {
    const asked: Call[] = [];
    beforeEach(() => {
      asked.length = 0;
      answer = () => new Response('{"videos":[{"id":"a","title":"Liquid"}]}', { status: 200 });
    });

    it('reads the library and the status through the settings', async () => {
      const library = await wall.library();
      expect(library.videos).toEqual([
        { id: 'a', title: 'Liquid', type: 'video', detail: '', thumb: null },
      ]);
      expect((await wall.status()).playing).toBe(false);
    });

    it('plays by id, with a transition if one is named, and refuses what is no id or transition', async () => {
      await wall.play('a', 'wipe');
      await wall.playPlaylist('p');
      await wall.blackout(true);
      expect(calls).toEqual([
        { method: 'POST', body: { videoId: 'a', transition: 'wipe' } },
        { method: 'POST', body: { playlistId: 'p' } },
        { method: 'POST', body: { value: true } },
      ]);
      await expect(wall.play('')).rejects.toThrow(/id/);
      await expect(wall.play('a', 'spin')).rejects.toThrow(/transition/);
      await expect(wall.blackout('yes')).rejects.toThrow(/true or false/);
    });

    it('tells the operator when the wall refuses, as a mistake of the request', async () => {
      answer = () => new Response('{"error":"nothing with this id"}', { status: 404 });
      await expect(wall.play('x')).rejects.toThrow(/nothing with this id/);
    });

    it('does not wait for the overlay, and does not touch it', async () => {
      await wall.play('a');
      expect(state().shown).toBeNull();
      expect(state().last).toBeNull();
    });
  });
});
