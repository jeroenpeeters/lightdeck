import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tempo } from './tempo.js';
import { type BeatCall, MIN_GAP_MS, SYNC_INTERVAL_MS, VideoWallBeat } from './videoWallBeat.js';

/** 120 bpm: a beat is 500 ms, a bar 2000 ms. */
describe('VideoWallBeat', () => {
  let tempo: Tempo;
  let calls: BeatCall[];
  let reports: { call: BeatCall; failed: boolean }[];
  let enabled: boolean;
  let fail: boolean;
  let beat: VideoWallBeat;

  const make = () =>
    new VideoWallBeat({
      tempo,
      enabled: () => enabled,
      send: async (call) => {
        calls.push(call);
        if (fail) throw new Error('down');
      },
      report: (call, error) => reports.push({ call, failed: error !== undefined }),
    });

  beforeEach(() => {
    vi.useFakeTimers();
    tempo = new Tempo();
    tempo.update({ bpm: 120 });
    calls = [];
    reports = [];
    enabled = true;
    fail = false;
    beat = make();
  });
  afterEach(() => {
    beat.close();
    vi.useRealTimers();
  });

  it('says beat one at the first bar line, and not before', async () => {
    await vi.advanceTimersByTimeAsync(1990);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(20);
    expect(calls).toEqual([{ bpm: 120, downbeat: true }]);
  });

  it('says it again on a bar line every minute', async () => {
    await vi.advanceTimersByTimeAsync(2100);
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS + 2100);
    expect(calls).toEqual([{ bpm: 120, downbeat: true }]);
  });

  it('makes each downbeat call on a bar line', async () => {
    const beats: number[] = [];
    beat.close();
    beat = new VideoWallBeat({
      tempo,
      enabled: () => true,
      send: async () => {
        beats.push(tempo.getBeat());
      },
    });
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS * 3 + 5000);
    expect(beats.length).toBe(3);
    for (const each of beats) {
      expect(Math.abs(each - Math.round(each / 4) * 4)).toBeLessThan(0.05);
    }
  });

  it('sends a bpm that changes, without a downbeat', async () => {
    await vi.advanceTimersByTimeAsync(100);
    tempo.update({ bpm: 128 });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([{ bpm: 128, downbeat: false }]);
  });

  it('keeps the bpm that wobbles to one call per gap, the newest value last', async () => {
    await vi.advanceTimersByTimeAsync(100);
    tempo.update({ bpm: 121 });
    await vi.advanceTimersByTimeAsync(0);
    tempo.update({ bpm: 122 });
    tempo.update({ bpm: 123 });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([{ bpm: 121, downbeat: false }]);
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 10);
    expect(calls).toEqual([
      { bpm: 121, downbeat: false },
      { bpm: 123, downbeat: false },
    ]);
  });

  it('says beat one at once after a tap, and counts the minute from there', async () => {
    await vi.advanceTimersByTimeAsync(1000);
    tempo.update({ sync: true });
    expect(calls).toEqual([{ bpm: 120, downbeat: true }]);
    calls.length = 0;
    // the bar line the tap would have had is not sent again, the next one is a minute away
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS - 1000);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(3100);
    expect(calls).toEqual([{ bpm: 120, downbeat: true }]);
  });

  it('says nothing while the music is stopped, and beat one after it starts', async () => {
    tempo.update({ source: 'rekordbox' });
    tempo.follow({ running: false });
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS + 5000);
    expect(calls).toEqual([]);
    tempo.follow({ running: true });
    await vi.advanceTimersByTimeAsync(2100);
    expect(calls).toEqual([{ bpm: 120, downbeat: true }]);
  });

  it('does not wait for the wall and is not troubled by a failing one', async () => {
    fail = true;
    await vi.advanceTimersByTimeAsync(2100);
    expect(calls).toHaveLength(1);
    expect(reports).toEqual([{ call: { bpm: 120, downbeat: true }, failed: true }]);
    tempo.update({ bpm: 130 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS + 2000);
    expect(calls.map((c) => c.bpm)).toEqual([120, 130, 130]);
  });

  it('does not hold a downbeat behind a bpm call that has not been answered', async () => {
    let release: () => void = () => undefined;
    beat.close();
    const seen: BeatCall[] = [];
    beat = new VideoWallBeat({
      tempo,
      enabled: () => true,
      send: (call) => {
        seen.push(call);
        return call.downbeat
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              release = resolve;
            });
      },
    });
    await vi.advanceTimersByTimeAsync(100);
    tempo.update({ bpm: 125 });
    await vi.advanceTimersByTimeAsync(2500);
    expect(seen.map((c) => c.downbeat)).toEqual([false, true]);
    release();
  });

  it('is silent while it is off and starts at the next bar line when switched on', async () => {
    enabled = false;
    beat.refresh();
    tempo.update({ bpm: 140 });
    tempo.update({ sync: true });
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS + 5000);
    expect(calls).toEqual([]);
    enabled = true;
    beat.refresh();
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toEqual([{ bpm: 140, downbeat: true }]);
  });

  it('follows a bpm change that moves the bar line under the timer', async () => {
    const beats: number[] = [];
    beat.close();
    beat = new VideoWallBeat({
      tempo,
      enabled: () => true,
      send: async (call) => {
        if (call.downbeat) beats.push(tempo.getBeat());
      },
    });
    await vi.advanceTimersByTimeAsync(100);
    tempo.update({ bpm: 125 }); // the bar line comes sooner than the timer was set for
    await vi.advanceTimersByTimeAsync(2500);
    expect(beats).toHaveLength(1);
    expect(Math.abs((beats[0] ?? 0) - 4)).toBeLessThan(0.05);
  });
});
