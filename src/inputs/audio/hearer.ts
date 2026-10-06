/**
 * What the follower listens with: the features and the tracker as one, fed with the
 * blocks of a source. It starts over when a new feed starts, and makes up for sound
 * that was lost in between.
 */

import { FeatureExtractor } from './features.js';
import type { Hearing } from './hearing.js';
import type { AudioSettings } from './settings.js';
import type { AudioBlock } from './source.js';
import { Tracker } from './tracker.js';

/** Sound that is missing for no longer than this is filled with silence. For longer, start over. */
const MAX_GAP_S = 1;

export class Hearer {
  private readonly features = new FeatureExtractor();
  private readonly tracker: Tracker;
  private feed: number | undefined;
  private rate = 0;
  /** Where the next block should begin in the feed. */
  private expected = 0;

  constructor(settings: AudioSettings) {
    this.tracker = new Tracker(settings);
  }

  setSettings(settings: AudioSettings): void {
    this.tracker.setSettings(settings);
  }

  reset(): void {
    this.features.reset();
    this.tracker.reset();
    this.feed = undefined;
    this.rate = 0;
    this.expected = 0;
  }

  push(block: AudioBlock): Hearing[] {
    if (block.feed !== this.feed || block.sampleRate !== this.rate) {
      this.reset();
      this.feed = block.feed;
      this.rate = block.sampleRate;
      this.expected = block.index;
    }

    const out: Hearing[] = [];
    let samples = block.samples;
    let index = block.index;

    if (index > this.expected) {
      const gap = index - this.expected;
      if (gap <= MAX_GAP_S * this.rate) {
        out.push(...this.run(new Float32Array(gap), this.expected, block));
      } else {
        const feed = this.feed;
        this.reset();
        this.feed = feed;
        this.rate = block.sampleRate;
      }
    } else if (index < this.expected) {
      // Sound that was already given: keep only what is new.
      const seen = this.expected - index;
      if (seen >= samples.length) return out;
      samples = samples.subarray(seen);
      index = this.expected;
    }

    out.push(...this.run(samples, index, block));
    this.expected = index + samples.length;
    return out;
  }

  private run(samples: Float32Array, index: number, like: AudioBlock): Hearing[] {
    const frames = this.features.push({
      samples,
      index,
      sampleRate: like.sampleRate,
      feed: like.feed,
    });
    return this.tracker.push(frames);
  }
}
