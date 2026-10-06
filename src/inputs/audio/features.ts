/**
 * From sound to what the tracker counts on: a frame every 10 ms with the loudness and
 * how strongly something started in two bands, whatever the sample rate.
 *
 * Onset strength is the rise of the log-compressed spectrum from one frame to the next,
 * with falls cut off. There are two bands because house and techno have a kick to count
 * on, but a pattern that drops the kick must not make the beat disappear: the low band
 * (about 30 to 150 Hz) is the kick, the high band (150 Hz up to about 8 kHz) is hats,
 * claps and everything else.
 */

import type { AudioBlock } from './source.js';

export interface FeatureFrame {
  /** Seconds on the clock of the feed at the end of the frame. A multiple of 10 ms. */
  at: number;
  /** Loudness over the last 50 ms in dBFS, not below -120. */
  level: number;
  /** How strongly something started in the band of the kick. Not scaled to anything. */
  low: number;
  /** The same above that. */
  high: number;
}

/** Frames per second. */
export const FRAMES_PER_SECOND = 100;

/** The window the spectrum is taken over, the same length of time at every sample rate. */
const WINDOW_S = 0.04;
const LEVEL_S = 0.05;
const LOW_BAND: readonly [number, number] = [30, 150];
const HIGH_TO = 8000;
/** How much the spectrum is compressed: a quiet sound still counts, a loud one not much more. */
const COMPRESS = 1000;
const FLOOR_DB = -120;

/** A fast Fourier transform of a power-of-two size. */
class Fft {
  readonly size: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly reverse: Uint32Array;

  constructor(size: number) {
    this.size = size;
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / size);
    }
    this.reverse = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.reverse[i] = r;
    }
  }

  /** In place. */
  forward(re: Float64Array, im: Float64Array): void {
    const { size, cos, sin, reverse } = this;
    for (let i = 0; i < size; i++) {
      const j = reverse[i] as number;
      if (j > i) {
        const r = re[i] as number;
        re[i] = re[j] as number;
        re[j] = r;
        const m = im[i] as number;
        im[i] = im[j] as number;
        im[j] = m;
      }
    }
    for (let half = 1; half < size; half <<= 1) {
      const step = size / (half << 1);
      for (let start = 0; start < size; start += half << 1) {
        for (let k = 0; k < half; k++) {
          const c = cos[k * step] as number;
          const s = sin[k * step] as number;
          const a = start + k;
          const b = a + half;
          const tr = (re[b] as number) * c - (im[b] as number) * s;
          const ti = (re[b] as number) * s + (im[b] as number) * c;
          re[b] = (re[a] as number) - tr;
          im[b] = (im[a] as number) - ti;
          re[a] = (re[a] as number) + tr;
          im[a] = (im[a] as number) + ti;
        }
      }
    }
  }
}

export class FeatureExtractor {
  private rate = 0;
  private window = 0;
  private fft: Fft | undefined;
  private shape = new Float64Array(0);
  private shapeSum = 1;
  private re = new Float64Array(0);
  private im = new Float64Array(0);
  private lowFrom = 0;
  private lowTo = 0;
  private highTo = 0;
  private levelSamples = 0;
  /** How many samples a frame looks back over: the longer of the two windows. */
  private need = 0;
  /** The log spectrum of the last frame, for the bins that are used. */
  private previous = new Float64Array(0);
  private hasPrevious = false;

  /** The samples that are still needed, and where the first of them lies in the feed. */
  private buffer = new Float32Array(0);
  private bufferStart = 0;
  /** The number of the next frame, counted from 1: it ends at `round(n * rate / 100)`. */
  private next = 1;
  /** Where the feed began, so that the first frame has a whole window of sound under it. */
  private start = 0;

  reset(): void {
    this.rate = 0;
  }

  /**
   * Gives the frames that the block completes. Blocks must follow one another: one that
   * does not starts the analysis over, and `Hearer` fills a gap before it gets here.
   */
  push(block: AudioBlock): FeatureFrame[] {
    const { samples, sampleRate, index } = block;
    const end = this.bufferStart + this.buffer.length;
    if (this.rate !== sampleRate || index !== end) this.begin(sampleRate, index);

    const joined = new Float32Array(this.buffer.length + samples.length);
    joined.set(this.buffer, 0);
    joined.set(samples, this.buffer.length);
    this.buffer = joined;

    const frames: FeatureFrame[] = [];
    const have = this.bufferStart + this.buffer.length;
    for (;;) {
      const stop = Math.round((this.next * this.rate) / FRAMES_PER_SECOND);
      if (stop > have) break;
      if (stop - this.need >= this.start) frames.push(this.frame(this.next, stop));
      this.next++;
    }

    // Keep what the next frame still needs.
    const nextStop = Math.round((this.next * this.rate) / FRAMES_PER_SECOND);
    const keepFrom = Math.max(this.bufferStart, nextStop - this.need);
    this.buffer = this.buffer.slice(keepFrom - this.bufferStart);
    this.bufferStart = keepFrom;
    return frames;
  }

  private begin(rate: number, index: number): void {
    if (this.rate !== rate) this.configure(rate);
    this.buffer = new Float32Array(0);
    this.bufferStart = index;
    this.start = index;
    this.next = Math.floor((index * FRAMES_PER_SECOND) / rate) + 1;
    this.hasPrevious = false;
  }

  private configure(rate: number): void {
    this.rate = rate;
    this.window = Math.round(WINDOW_S * rate);
    const size = 2 ** Math.ceil(Math.log2(this.window));
    this.fft = new Fft(size);
    this.shape = new Float64Array(this.window);
    this.shapeSum = 0;
    for (let i = 0; i < this.window; i++) {
      this.shape[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / this.window));
      this.shapeSum += this.shape[i] as number;
    }
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    const bin = rate / size;
    this.lowFrom = Math.max(1, Math.ceil(LOW_BAND[0] / bin));
    this.lowTo = Math.max(this.lowFrom, Math.floor(LOW_BAND[1] / bin));
    this.highTo = Math.min(size / 2 - 1, Math.floor(Math.min(HIGH_TO, rate * 0.475) / bin));
    this.previous = new Float64Array(this.highTo + 1);
    this.levelSamples = Math.round(LEVEL_S * rate);
    this.need = Math.max(this.window, this.levelSamples);
  }

  private frame(number: number, stop: number): FeatureFrame {
    const fft = this.fft as Fft;
    const { re, im, shape, window, buffer } = this;
    const from = stop - window - this.bufferStart;
    for (let i = 0; i < window; i++) {
      re[i] = (buffer[from + i] as number) * (shape[i] as number);
      im[i] = 0;
    }
    for (let i = window; i < fft.size; i++) {
      re[i] = 0;
      im[i] = 0;
    }
    fft.forward(re, im);

    // Magnitudes are scaled so that a sine of full scale is 1.
    const scaleMagnitude = 2 / this.shapeSum;
    let low = 0;
    let high = 0;
    for (let k = this.lowFrom; k <= this.highTo; k++) {
      const r = re[k] as number;
      const i = im[k] as number;
      const logMagnitude = Math.log(1 + COMPRESS * Math.sqrt(r * r + i * i) * scaleMagnitude);
      const rise = this.hasPrevious ? logMagnitude - (this.previous[k] as number) : 0;
      this.previous[k] = logMagnitude;
      if (rise <= 0) continue;
      if (k <= this.lowTo) low += rise;
      else high += rise;
    }
    this.hasPrevious = true;

    let sum = 0;
    for (let i = stop - this.levelSamples - this.bufferStart; i < stop - this.bufferStart; i++) {
      const sample = buffer[i] as number;
      sum += sample * sample;
    }
    const level = Math.max(FLOOR_DB, 10 * Math.log10(sum / this.levelSamples + 1e-13));

    return {
      at: number / FRAMES_PER_SECOND,
      level,
      low: low / (this.lowTo - this.lowFrom + 1),
      high: this.highTo > this.lowTo ? high / (this.highTo - this.lowTo) : 0,
    };
  }
}
