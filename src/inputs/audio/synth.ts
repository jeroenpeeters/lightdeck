/**
 * Test sound: kick patterns, hats, melody, room noise and silence. Everything is made
 * from a seed, so a test hears the same thing every time. Nothing here is used outside
 * tests and the tools that check the tracker.
 */

import type { AudioBlock } from './source.js';

/** A small seeded generator, 0 up to but not including 1. */
export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

/** Loudness of a signal over all of it, in dBFS. */
export function levelDb(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return 10 * Math.log10(Math.max(sum / Math.max(1, samples.length), 1e-12));
}

export function silence(seconds: number, rate: number): Float32Array {
  return new Float32Array(Math.round(seconds * rate));
}

/** White noise whose samples have the level `db` as their RMS. */
export function whiteNoise(seconds: number, rate: number, db: number, seed = 1): Float32Array {
  const random = rng(seed);
  const out = new Float32Array(Math.round(seconds * rate));
  // Uniform noise has an RMS of 1/sqrt(3) of its peak.
  const gain = dbToGain(db) * Math.sqrt(3);
  for (let i = 0; i < out.length; i++) out[i] = (random() * 2 - 1) * gain;
  return out;
}

export function scale(samples: Float32Array, db: number): Float32Array {
  const gain = dbToGain(db);
  return samples.map((sample) => sample * gain);
}

export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The sum of signals, as long as the longest. */
export function mix(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(Math.max(0, ...parts.map((part) => part.length)));
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) out[i] = (out[i] ?? 0) + (part[i] ?? 0);
  }
  return out;
}

export interface KickOptions {
  seconds: number;
  rate: number;
  /** Peak level of a kick in dBFS (default -6). */
  db?: number;
  /** Seconds before the first kick (default 0.2). */
  offset?: number;
  /** Hats between the kicks, at this peak level in dBFS (default none). */
  hatsDb?: number;
  /** True for a kick that is left out, by the number of the beat counted from 0. */
  skip?: (beat: number) => boolean;
  seed?: number;
}

/** Where kicks lie, in seconds, for a steady tempo. */
export function kickTimes(bpm: number, seconds: number, offset = 0.2): number[] {
  const times: number[] = [];
  for (let t = offset; t < seconds; t += 60 / bpm) times.push(t);
  return times;
}

/** One kick: a sine that drops from 120 to 50 Hz and dies away over about a tenth of a second. */
function addKick(out: Float32Array, rate: number, at: number, gain: number): void {
  const start = Math.round(at * rate);
  const length = Math.round(0.6 * rate);
  for (let n = 0; n < length && start + n < out.length; n++) {
    const t = n / rate;
    const phase = 2 * Math.PI * (50 * t + 70 * 0.03 * (1 - Math.exp(-t / 0.03)));
    const attack = Math.min(1, t / 0.001);
    out[start + n] = (out[start + n] ?? 0) + gain * attack * Math.exp(-t / 0.09) * Math.sin(phase);
  }
}

/** One hat: a short burst of noise with the low end taken out. */
function addHat(out: Float32Array, rate: number, at: number, gain: number, random: () => number) {
  const start = Math.round(at * rate);
  const length = Math.round(0.05 * rate);
  let last = 0;
  for (let n = 0; n < length && start + n < out.length; n++) {
    const noise = random() * 2 - 1;
    const high = noise - last;
    last = noise;
    out[start + n] = (out[start + n] ?? 0) + gain * 0.5 * high * Math.exp(-n / (0.012 * rate));
  }
}

/** Kicks on every beat of a steady tempo, with hats between them when asked. */
export function kickTrack(bpm: number, options: KickOptions): Float32Array {
  const { seconds, rate, db = -6, offset = 0.2, hatsDb, skip, seed = 7 } = options;
  const out = new Float32Array(Math.round(seconds * rate));
  const random = rng(seed);
  const period = 60 / bpm;
  kickTimes(bpm, seconds, offset).forEach((at, beat) => {
    if (!skip?.(beat)) addKick(out, rate, at, dbToGain(db));
    if (hatsDb !== undefined) addHat(out, rate, at + period / 2, dbToGain(hatsDb), random);
  });
  return out;
}

/** Kicks at a tempo that moves in a straight line from one bpm to another. */
export function kickRamp(
  from: number,
  to: number,
  options: Omit<KickOptions, 'skip' | 'hatsDb'>,
): { samples: Float32Array; times: number[] } {
  const { seconds, rate, db = -6, offset = 0.2 } = options;
  const out = new Float32Array(Math.round(seconds * rate));
  const times: number[] = [];
  let at = offset;
  while (at < seconds) {
    times.push(at);
    addKick(out, rate, at, dbToGain(db));
    const bpm = from + ((to - from) * at) / seconds;
    at += 60 / bpm;
  }
  return { samples: out, times };
}

/**
 * Sustained notes with no hard start: each one fades in and out over a tenth of a second
 * or more, and they last different lengths, so nothing repeats on a beat.
 */
export function melody(seconds: number, rate: number, db = -20, seed = 3): Float32Array {
  const random = rng(seed);
  const out = new Float32Array(Math.round(seconds * rate));
  const pitches = [220, 247, 262, 294, 330, 349, 392, 440];
  let at = 0;
  while (at < seconds) {
    const length = 0.4 + random() * 0.9;
    const pitch = pitches[Math.floor(random() * pitches.length)] ?? 220;
    const from = Math.round(at * rate);
    const count = Math.round((length + 0.3) * rate);
    for (let n = 0; n < count && from + n < out.length; n++) {
      const t = n / rate;
      const fade = Math.min(1, t / 0.15, (length + 0.3 - t) / 0.15);
      const tone = Math.sin(2 * Math.PI * pitch * t) + 0.3 * Math.sin(2 * Math.PI * pitch * 2 * t);
      out[from + n] = (out[from + n] ?? 0) + Math.max(0, fade) * tone;
    }
    at += length;
  }
  // Scale so that the RMS of the whole is `db`.
  const rms = dbToGain(levelDb(out));
  return scale(out, db - 20 * Math.log10(rms));
}

/** The signal cut into blocks of `blockSeconds`, numbered as a source would number them. */
export function toBlocks(
  samples: Float32Array,
  rate: number,
  blockSeconds = 0.1,
  { feed = 1, startIndex = 0 }: { feed?: number; startIndex?: number } = {},
): AudioBlock[] {
  const size = Math.max(1, Math.round(blockSeconds * rate));
  const blocks: AudioBlock[] = [];
  for (let from = 0; from < samples.length; from += size) {
    blocks.push({
      samples: samples.slice(from, from + size),
      sampleRate: rate,
      index: startIndex + from,
      feed,
    });
  }
  return blocks;
}
