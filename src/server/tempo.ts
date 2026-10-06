/**
 * The tempo of the console: beats per minute, the speed of effects relative to it, and
 * where beat one lies. It belongs to no fixture. Everything that moves in time with the
 * music counts on this one clock, so that fixtures stay together.
 */

import { EventEmitter } from 'node:events';
import { SPEEDS } from '../engine/effects.js';
import { PatchError, readObject } from './fixture.js';

export const MIN_BPM = 60;
export const MAX_BPM = 200;
/** The speeds of the console as a whole. They multiply with the speed of each effect. */
export const RATES: readonly number[] = SPEEDS;
const DEFAULT_BPM = 126;

/** Who sets the bpm and the place of the beat: the operator, or the listening. */
export type TempoSource = 'manual' | 'audio';
export const TEMPO_SOURCES: readonly TempoSource[] = ['manual', 'audio'];

export interface TempoState {
  /** Tempo in beats per minute. */
  bpm: number;
  /** Speed of every effect relative to the tempo, one of `RATES`. */
  rate: number;
  source: TempoSource;
  /**
   * False while the effects are to be idle, as when the music has stopped. Always true
   * with the source `manual`.
   */
  running: boolean;
}

export interface TempoPatch {
  bpm?: unknown;
  rate?: unknown;
  /** True restarts the beat count: "the one is now". */
  sync?: unknown;
  source?: unknown;
}

/** What listening found, for `Tempo.follow`. */
export interface TempoFollow {
  bpm?: number;
  /** A moment on `now()` at which a beat fell. */
  beatAt?: number;
  running?: boolean;
  /** Put the beat right at once instead of a part of the way. */
  snap?: boolean;
}

/** The part of the way to the heard beat that the origin moves per beat that is heard. */
const PHASE_GAIN = 0.25;
/** An origin that moves less than this, in milliseconds, is not worth telling anyone. */
const MIN_SHIFT_MS = 1;

export interface TempoOptions {
  /** Monotonic clock in milliseconds. Tests pass their own. */
  now?: () => number;
}

export class Tempo extends EventEmitter {
  /** The clock the beat is counted on. */
  readonly now: () => number;
  private state: TempoState = { bpm: DEFAULT_BPM, rate: 1, source: 'manual', running: true };
  /** Moment of beat 0, on the clock. */
  private beatOrigin: number;

  constructor(options: TempoOptions = {}) {
    super();
    this.now = options.now ?? (() => performance.now());
    this.beatOrigin = this.now();
  }

  getState(): TempoState {
    return { ...this.state };
  }

  /** Beats since the tempo was last synced, not scaled by the rate. */
  getBeat(): number {
    return ((this.now() - this.beatOrigin) / 60_000) * this.state.bpm;
  }

  /** Whether the effects are to run. The beat is counted whether they do or not. */
  isRunning(): boolean {
    return this.state.running;
  }

  /** Applies a partial change. Nothing is applied when any part of it is invalid. */
  update(patch: unknown, origin?: string): void {
    const { bpm, rate, sync, source } = readObject(patch, 'the tempo', [
      'bpm',
      'rate',
      'sync',
      'source',
    ]) as TempoPatch;
    const next = { ...this.state };
    if (bpm !== undefined) {
      if (typeof bpm !== 'number' || !Number.isFinite(bpm)) {
        throw new PatchError('bpm must be a number');
      }
      if (bpm < MIN_BPM || bpm > MAX_BPM) {
        throw new PatchError(`bpm must be between ${MIN_BPM} and ${MAX_BPM}`);
      }
      next.bpm = bpm;
    }
    if (rate !== undefined) {
      if (typeof rate !== 'number' || !RATES.includes(rate)) {
        throw new PatchError(`rate must be one of ${RATES.join(', ')}`);
      }
      next.rate = rate;
    }
    if (sync !== undefined && typeof sync !== 'boolean') {
      throw new PatchError('sync must be true or false');
    }
    if (source !== undefined) {
      if (typeof source !== 'string' || !TEMPO_SOURCES.includes(source as TempoSource)) {
        throw new PatchError(`source must be ${TEMPO_SOURCES.join(' or ')}`);
      }
      next.source = source as TempoSource;
      // By hand the effects always run: there is no one to say the music has stopped.
      if (next.source === 'manual') next.running = true;
    }

    const now = this.now();
    if (sync === true) {
      this.beatOrigin = now;
    } else if (next.bpm !== this.state.bpm) {
      // Keep the beat we are on, so a tempo change does not make the effects jump.
      const beat = this.getBeat();
      this.beatOrigin = now - (beat * 60_000) / next.bpm;
    }
    this.state = next;
    this.emit('tempo', this.getState(), origin);
  }

  /**
   * What listening found. Ignored while the source is `manual`.
   *
   * The beat we are on is kept when the bpm changes. `beatAt` is a moment at which a beat
   * really fell: the count at that moment should be a whole number, and the difference,
   * which is less than half a beat, is how far the origin has to move. So the beats are
   * only ever moved by less than half a beat, and the bar that was tapped stays the bar:
   * the beat that was one stays one.
   */
  follow(change: TempoFollow): void {
    if (this.state.source !== 'audio') return;
    const next = { ...this.state };
    let moved = false;

    const now = this.now();
    if (change.bpm !== undefined && Number.isFinite(change.bpm)) {
      const bpm = Math.min(MAX_BPM, Math.max(MIN_BPM, change.bpm));
      if (bpm !== next.bpm) {
        const beat = this.getBeat();
        this.beatOrigin = now - (beat * 60_000) / bpm;
        next.bpm = bpm;
        moved = true;
      }
    }
    if (change.beatAt !== undefined && Number.isFinite(change.beatAt)) {
      const beatMs = 60_000 / next.bpm;
      const counted = (change.beatAt - this.beatOrigin) / beatMs;
      const error = counted - Math.round(counted);
      const shift = error * beatMs * (change.snap === true ? 1 : PHASE_GAIN);
      if (Math.abs(shift) >= MIN_SHIFT_MS) {
        this.beatOrigin += shift;
        moved = true;
      }
    }
    if (change.running !== undefined && change.running !== next.running) {
      next.running = change.running;
      moved = true;
    }
    if (!moved) return;
    this.state = next;
    this.emit('tempo', this.getState(), 'audio');
  }
}
