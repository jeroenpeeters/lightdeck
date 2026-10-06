import { describe, expect, it } from 'vitest';
import {
  concat,
  dbToGain,
  kickRamp,
  kickTimes,
  kickTrack,
  levelDb,
  melody,
  mix,
  rng,
  scale,
  silence,
  toBlocks,
  whiteNoise,
} from './synth.js';

describe('test sound', () => {
  it('comes out the same every time from the same seed', () => {
    const a = rng(5);
    const b = rng(5);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(whiteNoise(0.1, 8000, -30, 4)).toEqual(whiteNoise(0.1, 8000, -30, 4));
    expect(whiteNoise(0.1, 8000, -30, 4)).not.toEqual(whiteNoise(0.1, 8000, -30, 5));
    expect(melody(1, 8000, -20, 2)).toEqual(melody(1, 8000, -20, 2));
  });

  it('has the loudness it is asked for', () => {
    expect(levelDb(whiteNoise(2, 8000, -40))).toBeCloseTo(-40, 0);
    expect(levelDb(melody(4, 8000, -18))).toBeCloseTo(-18, 0);
    expect(levelDb(scale(whiteNoise(1, 8000, -20), -10))).toBeCloseTo(-30, 0);
    expect(dbToGain(-20)).toBeCloseTo(0.1);
    expect(levelDb(silence(1, 8000))).toBeLessThan(-100);
  });

  it('puts the kicks where kickTimes says, one per beat', () => {
    expect(kickTimes(120, 3, 0.2)).toEqual([0.2, 0.7, 1.2, 1.7, 2.2, 2.7]);
    const rate = 8000;
    const track = kickTrack(120, { seconds: 2, rate });
    const peak = (from: number, to: number) =>
      Math.max(...track.subarray(Math.round(from * rate), Math.round(to * rate)).map(Math.abs));
    expect(peak(0.2, 0.3)).toBeGreaterThan(0.3);
    expect(peak(0.5, 0.6)).toBeLessThan(0.02);
    expect(peak(0.7, 0.8)).toBeGreaterThan(0.3);
  });

  it('leaves out the kicks it is told to', () => {
    const rate = 8000;
    const track = kickTrack(120, { seconds: 2, rate, skip: (beat) => beat === 1 });
    expect(
      Math.max(...track.subarray(Math.round(0.7 * rate), Math.round(0.8 * rate))),
    ).toBeLessThan(0.02);
  });

  it('speeds up along a ramp', () => {
    const { times } = kickRamp(100, 140, { seconds: 20, rate: 8000 });
    const first = (times[1] ?? 0) - (times[0] ?? 0);
    const last = (times[times.length - 1] ?? 0) - (times[times.length - 2] ?? 0);
    expect(first).toBeGreaterThan(last);
    expect(first).toBeCloseTo(0.6, 1);
  });

  it('joins and mixes', () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([10, 20, 30]);
    expect([...concat(a, b)]).toEqual([1, 2, 10, 20, 30]);
    expect([...mix(a, b)]).toEqual([11, 22, 30]);
  });

  it('cuts into numbered blocks of one feed', () => {
    const samples = new Float32Array(25);
    const blocks = toBlocks(samples, 100, 0.1, { feed: 3, startIndex: 7 });
    expect(blocks.map((block) => block.samples.length)).toEqual([10, 10, 5]);
    expect(blocks.map((block) => block.index)).toEqual([7, 17, 27]);
    expect(blocks.every((block) => block.feed === 3 && block.sampleRate === 100)).toBe(true);
  });
});
