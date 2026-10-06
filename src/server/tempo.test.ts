import { beforeEach, describe, expect, it } from 'vitest';
import { PatchError } from './fixture.js';
import { readLead, Tempo, type TempoState } from './tempo.js';

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

describe('Tempo grid, taps and lead', () => {
  let clock: number;
  let tempo: Tempo;

  beforeEach(() => {
    clock = 1000;
    tempo = new Tempo({ now: () => clock });
    tempo.update({ bpm: 120, sync: true });
  });

  it('says the beat at any moment, and the moment of any beat, as the tempo is now', () => {
    expect(tempo.beatAt(1000)).toBeCloseTo(0, 9);
    expect(tempo.beatAt(2500)).toBeCloseTo(3, 9);
    expect(tempo.beatAt(500)).toBeCloseTo(-1, 9);
    expect(tempo.timeOfBeat(0)).toBeCloseTo(1000, 9);
    expect(tempo.timeOfBeat(3)).toBeCloseTo(2500, 9);
    expect(tempo.timeOfBeat(0.5)).toBeCloseTo(1250, 9);
    for (const beat of [-2.5, 0, 0.3, 7, 1234.5]) {
      expect(tempo.beatAt(tempo.timeOfBeat(beat))).toBeCloseTo(beat, 6);
    }
  });

  it('counts the beat at the moment it is asked for, as before', () => {
    clock += 1750;
    expect(tempo.getBeat()).toBeCloseTo(3.5, 9);
    expect(tempo.getBeat()).toBe(tempo.beatAt(clock));
  });

  it('keeps the grid with the beat it is on when the bpm changes', () => {
    clock += 1250;
    const beat = tempo.getBeat();
    tempo.update({ bpm: 150 });
    expect(tempo.beatAt(clock)).toBeCloseTo(beat, 9);
    expect(tempo.timeOfBeat(beat)).toBeCloseTo(clock, 9);
    expect(tempo.timeOfBeat(beat + 1)).toBeCloseTo(clock + 400, 9);
  });

  it('counts the taps, and only the taps', () => {
    const first = tempo.epoch;
    tempo.update({ bpm: 130 });
    tempo.update({ rate: 2 });
    expect(tempo.epoch).toBe(first);
    tempo.update({ sync: true });
    expect(tempo.epoch).toBe(first + 1);
    tempo.update({ source: 'audio' });
    tempo.follow({ beatAt: clock + 30, snap: true, bpm: 131 });
    expect(tempo.epoch).toBe(first + 1);
    tempo.update({ bpm: 120, sync: true });
    expect(tempo.epoch).toBe(first + 2);
  });

  describe('the lead', () => {
    it('is nothing to start with, and the output beat is then the beat', () => {
      expect(tempo.leadMs).toBe(0);
      expect(tempo.outputBeat(2000)).toBeCloseTo(tempo.beatAt(2000), 9);
      clock += 300;
      expect(tempo.outputBeat()).toBeCloseTo(tempo.getBeat(), 9);
    });

    it('makes the output for a little later, by the lead', () => {
      tempo.setLead(50);
      expect(tempo.leadMs).toBe(50);
      // 50 ms is a tenth of a beat at 120 beats per minute.
      expect(tempo.outputBeat(2000)).toBeCloseTo(tempo.beatAt(2000) + 0.1, 9);
      expect(tempo.getBeat()).toBe(tempo.beatAt(clock));
    });

    it('can be negative, to make up for an output that is early', () => {
      tempo.setLead(-30);
      expect(tempo.outputBeat(2000)).toBeCloseTo(tempo.beatAt(2000) - 0.06, 9);
    });

    it('refuses what makes no sense, and keeps what it had', () => {
      tempo.setLead(40);
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '40', null, 600, -200, undefined]) {
        expect(() => tempo.setLead(bad)).toThrow(PatchError);
      }
      expect(tempo.leadMs).toBe(40);
      expect(readLead(0)).toBe(0);
      expect(readLead(-100)).toBe(-100);
      expect(readLead(500)).toBe(500);
    });
  });
});

describe('Tempo at the points of the grid', () => {
  // A frame is made for a point of the grid, which is worked out as a moment. Turning the moment
  // back into a beat has to give the beat it was made from, or a flash that belongs to the beat
  // comes out as the end of the beat before it: 12.999999999999998 is on beat 12.
  it('gives back a whole beat for the moment of a whole beat, at any tempo and origin', () => {
    for (const bpm of [60, 90, 120, 126, 133.3, 140, 150.1, 170, 187.5, 200]) {
      for (const origin of [0, 1000, 123456.789, 987654.321]) {
        const tempo = new Tempo({ now: () => origin });
        tempo.update({ bpm, sync: true });
        for (let beat = 0; beat <= 600; beat++) {
          expect(Math.floor(tempo.beatAt(tempo.timeOfBeat(beat)))).toBe(beat);
          expect(tempo.beatAt(tempo.timeOfBeat(beat))).toBe(beat);
        }
      }
    }
  });

  it('gives back a whole beat for a point on the grid too, and the lead does not undo it', () => {
    const tempo = new Tempo({ now: () => 5000 });
    tempo.update({ bpm: 170, sync: true });
    for (let k = 0; k <= 8 * 300; k++) {
      const beat = tempo.beatAt(tempo.timeOfBeat(k / 8));
      expect(beat).toBe(k / 8);
    }
    // Ahead by a whole number of beats, which is 352.94... ms at 170 beats per minute.
    tempo.setLead(0);
    expect(tempo.outputBeat(tempo.timeOfBeat(41))).toBe(41);
  });

  it('still tells a moment a hair before a beat from the beat', () => {
    const tempo = new Tempo({ now: () => 0 });
    tempo.update({ bpm: 120, sync: true });
    expect(Math.floor(tempo.beatAt(499.99))).toBe(0);
    expect(Math.floor(tempo.beatAt(500))).toBe(1);
    expect(Math.floor(tempo.beatAt(500.01))).toBe(1);
  });
});
