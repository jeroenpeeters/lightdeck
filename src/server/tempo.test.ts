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
    expect(tempo.getState()).toEqual({ bpm: 126, rate: 1 });
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
      { state: { bpm: 128, rate: 1 }, origin: 'tablet' },
      { state: { bpm: 128, rate: 0.5 }, origin: undefined },
    ]);
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
      { rate: '1' },
      { sync: 'yes' },
      { bpm: 120, rate: 3 },
      { tempo: 120 },
      'fast',
      null,
      [120],
    ];
    for (const patch of bad) expect(() => tempo.update(patch)).toThrow(PatchError);
    expect(tempo.getState()).toEqual({ bpm: 126, rate: 1 });
    expect(seen).toHaveLength(0);
  });
});
