import { describe, expect, it } from 'vitest';
import { Hearer } from './hearer.js';
import type { Hearing } from './hearing.js';
import { DEFAULT_AUDIO_SETTINGS } from './settings.js';
import type { AudioBlock } from './source.js';
import { kickTrack, silence, toBlocks, whiteNoise } from './synth.js';

const RATE = 16000;
const track = kickTrack(126, { seconds: 16, rate: RATE, hatsDb: -20 });

function hear(blocks: AudioBlock[], hearer = new Hearer({ ...DEFAULT_AUDIO_SETTINGS })): Hearing[] {
  return blocks.flatMap((block) => hearer.push(block));
}
const last = (hearings: Hearing[]): Hearing => hearings[hearings.length - 1] as Hearing;

describe('Hearer', () => {
  it('finds the tempo from the blocks of a source', () => {
    const hearings = hear(toBlocks(track, RATE));
    expect(last(hearings).heard).toBe('beat');
    expect(Math.abs((last(hearings).bpm ?? 0) - 126)).toBeLessThan(1);
  });

  it('starts over when a new feed starts', () => {
    const hearer = new Hearer({ ...DEFAULT_AUDIO_SETTINGS });
    hear(toBlocks(track, RATE, 0.1, { feed: 1 }), hearer);
    const fresh = hear(toBlocks(track.subarray(0, RATE * 2), RATE, 0.1, { feed: 2 }), hearer);
    expect(fresh.length).toBeGreaterThan(10);
    expect(fresh.every((hearing) => hearing.bpm === undefined)).toBe(true);
    expect(fresh[0]?.at).toBeLessThan(0.5);
  });

  it('starts over when the sample rate changes', () => {
    const hearer = new Hearer({ ...DEFAULT_AUDIO_SETTINGS });
    hear(toBlocks(track, RATE, 0.1, { feed: 1 }), hearer);
    const other = hear(toBlocks(whiteNoise(2, 8000, -40), 8000, 0.1, { feed: 1 }), hearer);
    expect(other.every((hearing) => hearing.bpm === undefined)).toBe(true);
  });

  it('fills a short gap, and carries on with the tempo it had', () => {
    const blocks = toBlocks(track, RATE);
    // Half a second of sound is lost.
    const gapped = blocks.filter((_, i) => i < 100 || i >= 105);
    const hearings = hear(gapped);
    expect(last(hearings).at).toBeCloseTo(16, 1);
    expect(last(hearings).heard).toBe('beat');
    expect(Math.abs((last(hearings).bpm ?? 0) - 126)).toBeLessThan(1);
  });

  it('starts over after a long gap, and does not go on counting from before it', () => {
    const blocks = toBlocks(track, RATE);
    const gapped = blocks.filter((_, i) => i < 100 || i >= 130);
    const hearings = hear(gapped);
    const after = hearings.filter((hearing) => hearing.at > 13);
    expect(after.length).toBeGreaterThan(5);
    // Three seconds are missing: the first thing it says after them knows no tempo.
    expect(after[0]?.bpm).toBeUndefined();
    expect(after[0]?.heard).toBe('music');
  });

  it('ignores sound that it has already had', () => {
    const blocks = toBlocks(track.subarray(0, RATE * 12), RATE);
    const doubled = blocks.flatMap((block, i) => (i % 7 === 3 ? [block, block] : [block]));
    expect(hear(doubled)).toEqual(hear(blocks));
  });

  it('keeps only what is new of a block that overlaps the last', () => {
    const rate = RATE;
    const samples = track.subarray(0, rate * 12);
    const plain = toBlocks(samples, rate);
    const overlapping = plain.map((block, i) => {
      if (i === 0) return block;
      const back = Math.min(400, block.index);
      return {
        ...block,
        index: block.index - back,
        samples: samples.subarray(block.index - back, block.index + block.samples.length),
      };
    });
    expect(hear(overlapping)).toEqual(hear(plain));
  });

  it('hears silence when it is told to go on after a stop, and music when it starts again', () => {
    const hearer = new Hearer({ ...DEFAULT_AUDIO_SETTINGS });
    const all = new Float32Array([...track.subarray(0, RATE * 8), ...silence(5, RATE)]);
    const hearings = hear(toBlocks(all, RATE), hearer);
    expect(last(hearings).heard).toBe('silent');
  });

  it('takes new settings, and can be reset', () => {
    const hearer = new Hearer({ ...DEFAULT_AUDIO_SETTINGS });
    hearer.setSettings({ ...DEFAULT_AUDIO_SETTINGS, silenceAfter: 6 });
    const all = new Float32Array([...track.subarray(0, RATE * 8), ...silence(5, RATE)]);
    // Five seconds of silence is not enough when six are asked for.
    expect(last(hear(toBlocks(all, RATE), hearer)).heard).not.toBe('silent');
    hearer.reset();
    const again = hear(toBlocks(track.subarray(0, RATE * 2), RATE, 0.1, { feed: 5 }), hearer);
    expect(again.every((hearing) => hearing.bpm === undefined)).toBe(true);
  });
});
