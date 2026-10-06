/**
 * How the listening behaves. What Jeroen decided is the default of `onSilence` and
 * `onNoBeat`; the numbers are a starting point, tuned on real recordings.
 */

import { PatchError, readObject } from '../../server/fixture.js';
import { MAX_BPM, MIN_BPM } from '../../server/tempo.js';

export interface AudioSettings {
  /** When the music stops: `stop` makes the tempo not run, so effects are idle. `hold` keeps it running. */
  onSilence: 'stop' | 'hold';
  /** When there is sound but no beat: `hold` keeps the tempo running as it was. */
  onNoBeat: 'hold' | 'stop';
  /** Seconds of quiet before it counts as silence. */
  silenceAfter: number;
  /** Decibels below the recent loud level at which it is quiet. */
  silenceDrop: number;
  /** dBFS below which it is silence whatever came before. */
  silenceFloor: number;
  /** Decibels above the level in the silence at which it counts as sound again. */
  wakeRise: number;
  /** Beats without a pulse before `beat` ends. */
  beatLostAfter: number;
  /** Beats a different tempo must hold to replace the held one. */
  lockAfter: number;
  /** The slowest and fastest tempo it looks for, inside `MIN_BPM` and `MAX_BPM`. */
  bpmMin: number;
  bpmMax: number;
  /** How the place of the beat is corrected: gently, or all at once. */
  phase: 'smooth' | 'snap';
  /** Milliseconds added to the place of the beat, to make up for the time sound takes to get here. */
  latencyMs: number;
}

export const DEFAULT_AUDIO_SETTINGS: Readonly<AudioSettings> = {
  onSilence: 'stop',
  onNoBeat: 'hold',
  silenceAfter: 2,
  silenceDrop: 20,
  silenceFloor: -70,
  wakeRise: 15,
  beatLostAfter: 8,
  lockAfter: 8,
  bpmMin: 80,
  bpmMax: 180,
  phase: 'smooth',
  latencyMs: 0,
};

export const AUDIO_SETTING_NAMES = Object.keys(DEFAULT_AUDIO_SETTINGS) as (keyof AudioSettings)[];

const CHOICES = {
  onSilence: ['stop', 'hold'],
  onNoBeat: ['hold', 'stop'],
  phase: ['smooth', 'snap'],
} as const;

/** The least and the most each number may be, and what it is called in a message. */
const RANGES = {
  silenceAfter: { min: 0.5, max: 30, what: 'the time before silence', unit: 'seconds' },
  silenceDrop: { min: 6, max: 60, what: 'the drop that counts as quiet', unit: 'dB' },
  silenceFloor: { min: -100, max: -20, what: 'the silence floor', unit: 'dBFS' },
  wakeRise: { min: 3, max: 40, what: 'the rise that counts as sound', unit: 'dB' },
  beatLostAfter: { min: 2, max: 64, what: 'the beats before the beat is lost', unit: 'beats' },
  lockAfter: { min: 2, max: 64, what: 'the beats before a new tempo is taken', unit: 'beats' },
  bpmMin: { min: MIN_BPM, max: MAX_BPM, what: 'the slowest tempo', unit: 'bpm' },
  bpmMax: { min: MIN_BPM, max: MAX_BPM, what: 'the fastest tempo', unit: 'bpm' },
  latencyMs: { min: -200, max: 500, what: 'the latency', unit: 'milliseconds' },
} as const;

/** The two ends of the tempo range must leave room for a tempo to be found in. */
const MIN_BPM_SPAN = 20;

/**
 * Applies a partial change to settings and gives the result. Throws a `PatchError`, and
 * changes nothing, when any part of it is wrong.
 */
export function readAudioSettings(patch: unknown, current: AudioSettings): AudioSettings {
  const given = readObject(patch, 'the listening settings', AUDIO_SETTING_NAMES);
  const next: AudioSettings = { ...current };

  for (const [name, choices] of Object.entries(CHOICES)) {
    const value = given[name];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !(choices as readonly string[]).includes(value)) {
      throw new PatchError(`${name} must be ${choices.join(' or ')}`);
    }
    (next as unknown as Record<string, unknown>)[name] = value;
  }

  for (const [name, range] of Object.entries(RANGES)) {
    const value = given[name];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new PatchError(`${range.what} must be a number`);
    }
    if (value < range.min || value > range.max) {
      throw new PatchError(
        `${range.what} must be between ${range.min} and ${range.max} ${range.unit}`,
      );
    }
    (next as unknown as Record<string, unknown>)[name] = value;
  }

  if (next.bpmMax - next.bpmMin < MIN_BPM_SPAN) {
    throw new PatchError(
      `the fastest tempo must be at least ${MIN_BPM_SPAN} bpm above the slowest, to have room to find a tempo`,
    );
  }
  return next;
}
