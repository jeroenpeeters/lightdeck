import { describe, expect, it } from 'vitest';
import { FeatureExtractor, type FeatureFrame } from './features.js';
import { kickTimes, kickTrack, scale, toBlocks, whiteNoise } from './synth.js';

function extract(samples: Float32Array, rate: number, blockSeconds = 0.1): FeatureFrame[] {
  const extractor = new FeatureExtractor();
  return toBlocks(samples, rate, blockSeconds).flatMap((block) => extractor.push(block));
}

/** The time of the strongest onset in the low band within a stretch. */
function peakNear(frames: FeatureFrame[], from: number, to: number): number {
  let best = -1;
  let at = 0;
  for (const frame of frames) {
    if (frame.at >= from && frame.at <= to && frame.low > best) {
      best = frame.low;
      at = frame.at;
    }
  }
  return at;
}

describe('FeatureExtractor', () => {
  it('gives a frame every 10 ms, at whatever the sample rate', () => {
    for (const rate of [16000, 22050, 44100, 48000]) {
      const frames = extract(whiteNoise(2, rate, -30), rate);
      expect(frames.length).toBeGreaterThan(190);
      frames.forEach((frame, i) => {
        expect(frame.at).toBeCloseTo((frames[0]?.at ?? 0) + i / 100, 6);
      });
    }
  });

  it('hears how loud it is', () => {
    const rate = 16000;
    const tone = new Float32Array(rate * 2).map(
      (_, i) => 0.1414 * Math.sin((2 * Math.PI * 440 * i) / rate),
    );
    const frames = extract(tone, rate);
    expect(frames[100]?.level).toBeCloseTo(-20, 0);
    expect(extract(scale(tone, -20), rate)[100]?.level).toBeCloseTo(-40, 0);
    expect(extract(new Float32Array(rate), rate)[50]?.level).toBe(-120);
  });

  it('finds the onset of a kick within a frame or two', () => {
    const rate = 16000;
    const frames = extract(kickTrack(120, { seconds: 4, rate }), rate);
    for (const time of kickTimes(120, 4).slice(1, -1)) {
      const found = peakNear(frames, time - 0.05, time + 0.12);
      expect(found - time).toBeGreaterThan(0);
      expect(found - time).toBeLessThan(0.025);
    }
  });

  it('hears no onset where nothing starts', () => {
    const rate = 16000;
    const tone = new Float32Array(rate * 3).map(
      (_, i) => 0.2 * Math.sin((2 * Math.PI * 100 * i) / rate),
    );
    const frames = extract(tone, rate).slice(20);
    expect(Math.max(...frames.map((frame) => frame.low))).toBeLessThan(0.02);
  });

  it('is the same at 16, 44.1 and 48 kHz', () => {
    const lows: FeatureFrame[][] = [];
    for (const rate of [16000, 44100, 48000]) {
      lows.push(extract(kickTrack(126, { seconds: 4, rate }), rate));
    }
    const [a, b, c] = lows as [FeatureFrame[], FeatureFrame[], FeatureFrame[]];
    const n = Math.min(a.length, b.length, c.length);
    for (let i = 5; i < n; i++) {
      const frames = [a[i], b[i], c[i]] as FeatureFrame[];
      // The same kick in each: onset strength within a tenth of the loudest, level within a dB.
      const lowest = Math.min(...frames.map((frame) => frame.low));
      const highest = Math.max(...frames.map((frame) => frame.low));
      expect(highest - lowest).toBeLessThan(0.4);
      const levels = frames.map((frame) => frame.level);
      expect(Math.max(...levels) - Math.min(...levels)).toBeLessThan(1.5);
    }
  });

  it('gives the same frames for uneven blocks as for one big one', () => {
    const rate = 16000;
    const samples = kickTrack(126, { seconds: 3, rate, hatsDb: -20 });
    const whole = new FeatureExtractor().push({ samples, sampleRate: rate, index: 0, feed: 1 });

    const extractor = new FeatureExtractor();
    const uneven: FeatureFrame[] = [];
    const sizes = [1, 7, 333, 1600, 50, 4099, 12, 800];
    let from = 0;
    for (let i = 0; from < samples.length; i++) {
      const size = sizes[i % sizes.length] as number;
      uneven.push(
        ...extractor.push({
          samples: samples.subarray(from, from + size),
          sampleRate: rate,
          index: from,
          feed: 1,
        }),
      );
      from += size;
    }
    expect(uneven).toEqual(whole);
  });

  it('starts over when a block does not follow on, or the rate changes', () => {
    const extractor = new FeatureExtractor();
    const noise = whiteNoise(1, 16000, -30);
    const first = extractor.push({ samples: noise, sampleRate: 16000, index: 0, feed: 1 });
    expect(first.length).toBeGreaterThan(90);
    // A block that skips ahead has no window of sound behind it, so its first frames wait.
    const later = extractor.push({ samples: noise, sampleRate: 16000, index: 100000, feed: 1 });
    expect(later[0]?.at).toBeCloseTo(100000 / 16000 + 0.05, 1);
    const other = extractor.push({
      samples: whiteNoise(1, 8000, -30),
      sampleRate: 8000,
      index: 0,
      feed: 2,
    });
    expect(other.length).toBeGreaterThan(90);
    expect(other[0]?.at).toBeLessThan(0.1);
  });

  it('can be reset', () => {
    const extractor = new FeatureExtractor();
    const noise = whiteNoise(1, 16000, -30);
    extractor.push({ samples: noise, sampleRate: 16000, index: 0, feed: 1 });
    extractor.reset();
    const again = extractor.push({ samples: noise, sampleRate: 16000, index: 0, feed: 1 });
    expect(again[0]?.at).toBeLessThan(0.1);
  });
});
