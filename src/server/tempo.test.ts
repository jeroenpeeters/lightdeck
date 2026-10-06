import { beforeEach, describe, expect, it } from 'vitest';
import { PatchError } from './fixture.js';
import { Tempo, type TempoState } from './tempo.js';

describe('Tempo', () => {
  let clock: number;
  let tempo: Tempo;

  beforeEach(() => {
    clock = 1000;
    tempo = new Tempo({ now: () => clock });
  });

  it('starts at a house tempo and normal speed', () => {
    expect(tempo.getState()).toEqual({ bpm: 126, rate: 1, source: 'manual', running: true });
    expect(tempo.getBeat()).toBe(0);
  });

  it('counts beats at the tempo and restarts the count on sync', () => {
    tempo.update({ bpm: 120, sync: true });
    expect(tempo.getBeat()).toBe(0);
    clock += 1000;
    expect(tempo.getBeat()).toBeCloseTo(2);
    tempo.update({ sync: true });
    expect(tempo.getBeat()).toBe(0);
  });

  it('keeps the beat it is on when the tempo changes', () => {
    tempo.update({ bpm: 120, sync: true });
    clock += 1500;
    expect(tempo.getBeat()).toBeCloseTo(3);
    tempo.update({ bpm: 140 });
    expect(tempo.getBeat()).toBeCloseTo(3);
    clock += 60_000 / 140;
    expect(tempo.getBeat()).toBeCloseTo(4);
  });

  it('does not scale the beat by the speed: that is up to what runs on it', () => {
    tempo.update({ bpm: 120, rate: 2, sync: true });
    clock += 1000;
    expect(tempo.getBeat()).toBeCloseTo(2);
    expect(tempo.getState().rate).toBe(2);
  });

  it('tells the listeners what changed and who did it', () => {
    const seen: { state: TempoState; origin: string | undefined }[] = [];
    tempo.on('tempo', (state, origin) => seen.push({ state, origin }));
    tempo.update({ bpm: 128 }, 'tablet');
    tempo.update({ rate: 0.5 });
    expect(seen).toEqual([
      { state: { bpm: 128, rate: 1, source: 'manual', running: true }, origin: 'tablet' },
      { state: { bpm: 128, rate: 0.5, source: 'manual', running: true }, origin: undefined },
    ]);
  });

  it('takes a quarter of the speed up to four times the speed', () => {
    const tempo = new Tempo();
    for (const rate of [0.25, 0.5, 1, 2, 4]) {
      tempo.update({ rate });
      expect(tempo.getState().rate).toBe(rate);
    }
  });

  it('refuses settings that make no sense, and changes nothing', () => {
    const seen: unknown[] = [];
    tempo.on('tempo', (state) => seen.push(state));
    const bad: unknown[] = [
      { bpm: 59 },
      { bpm: 201 },
      { bpm: 'fast' },
      { bpm: Number.NaN },
      { rate: 3 },
      { rate: 8 },
      { rate: 0.125 },
      { rate: '1' },
      { sync: 'yes' },
      { source: 'link' },
      { source: true },
      { bpm: 120, rate: 3 },
      { tempo: 120 },
      'fast',
      null,
      [120],
    ];
    for (const patch of bad) expect(() => tempo.update(patch)).toThrow(PatchError);
    expect(tempo.getState()).toEqual({ bpm: 126, rate: 1, source: 'manual', running: true });
    expect(seen).toHaveLength(0);
  });
});

describe('Tempo that follows the music', () => {
  let clock: number;
  let tempo: Tempo;
  const seen: { state: TempoState; origin: string | undefined }[] = [];

  beforeEach(() => {
    clock = 1000;
    seen.length = 0;
    tempo = new Tempo({ now: () => clock });
    tempo.update({ bpm: 120, sync: true });
    tempo.update({ source: 'audio' });
    tempo.on('tempo', (state, origin) => seen.push({ state, origin }));
  });

  it('takes the listening as its source, and the effects run until it says they should not', () => {
    expect(tempo.getState().source).toBe('audio');
    expect(tempo.isRunning()).toBe(true);
  });

  it('ignores what listening finds while the source is by hand', () => {
    tempo.update({ source: 'manual' });
    seen.length = 0;
    tempo.follow({ bpm: 140, running: false, beatAt: clock + 100 });
    expect(tempo.getState()).toMatchObject({ bpm: 120, running: true });
    expect(seen).toHaveLength(0);
  });

  it('can be told to stop and to run again, and says who told it', () => {
    tempo.follow({ running: false });
    expect(tempo.isRunning()).toBe(false);
    expect(seen).toEqual([{ state: expect.objectContaining({ running: false }), origin: 'audio' }]);
    tempo.follow({ running: true });
    expect(tempo.isRunning()).toBe(true);
  });

  it('counts the beat while it does not run, so nothing has to be put back', () => {
    tempo.follow({ running: false });
    clock += 1000;
    expect(tempo.getBeat()).toBeCloseTo(2);
    tempo.follow({ running: true });
    expect(tempo.getBeat()).toBeCloseTo(2);
  });

  it('is running again as soon as the operator takes it by hand', () => {
    tempo.follow({ running: false });
    tempo.update({ source: 'manual' });
    expect(tempo.getState()).toMatchObject({ source: 'manual', running: true });
  });

  it('takes a new bpm and keeps the beat it is on', () => {
    clock += 1500;
    expect(tempo.getBeat()).toBeCloseTo(3);
    tempo.follow({ bpm: 126 });
    expect(tempo.getState().bpm).toBe(126);
    expect(tempo.getBeat()).toBeCloseTo(3);
    clock += 60_000 / 126;
    expect(tempo.getBeat()).toBeCloseTo(4);
  });

  it('keeps the bpm inside what the console allows', () => {
    tempo.follow({ bpm: 400 });
    expect(tempo.getState().bpm).toBe(200);
    tempo.follow({ bpm: 5 });
    expect(tempo.getState().bpm).toBe(60);
    tempo.follow({ bpm: Number.NaN });
    expect(tempo.getState().bpm).toBe(60);
  });

  it('moves the beats a part of the way to a beat that was heard late', () => {
    // 500 ms per beat. A beat was heard at 4.1 beats: the count is 0.1 beat ahead.
    clock += 2000;
    tempo.follow({ beatAt: 1000 + 2050 });
    // 0.1 of a beat is 50 ms, and a quarter of that is 12.5 ms later.
    expect(tempo.getBeat()).toBeCloseTo(4 - 0.025 + 0, 2);
  });

  it('puts the beats right at once when it is told to snap', () => {
    clock += 2000;
    tempo.follow({ beatAt: 1000 + 2050, snap: true });
    expect(tempo.getBeat()).toBeCloseTo(4 - 0.1, 2);
    clock += 50 - 0; // at the heard beat the count is whole
    expect(Math.abs(tempo.getBeat() - Math.round(tempo.getBeat()))).toBeLessThan(0.001);
  });

  it('never moves the beats by more than half a beat, so the bar stays the bar', () => {
    // Heard just over half a beat after the count's beat: the nearest whole beat is the next one.
    tempo.follow({ beatAt: 1000 + 4 * 500 + 260, snap: true });
    // The count at that moment is now 5, not 4: the bar did not move a whole beat.
    clock = 1000 + 4 * 500 + 260;
    expect(tempo.getBeat()).toBeCloseTo(5, 3);
  });

  it('is quiet about a beat that is already where it should be', () => {
    tempo.follow({ beatAt: 1000 + 2000 });
    expect(seen).toHaveLength(0);
  });

  it('keeps the bar that was tapped: one stays one', () => {
    // A tap makes beat one now. The listening then finds beats a little off, and the count stays.
    tempo.update({ sync: true });
    clock += 2000;
    tempo.follow({ beatAt: clock - 20, snap: true });
    expect(Math.floor(tempo.getBeat() + 0.5)).toBe(4);
  });
});
