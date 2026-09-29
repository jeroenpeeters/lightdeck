/**
 * The tempo of the console: beats per minute, the speed of effects relative to it, and
 * where beat one lies. It belongs to no fixture. Everything that moves in time with the
 * music counts on this one clock, so that fixtures stay together.
 */

import { EventEmitter } from 'node:events';
import { PatchError, readObject } from './fixture.js';

export const MIN_BPM = 60;
export const MAX_BPM = 200;
export const RATES: readonly number[] = [0.5, 1, 2];
const DEFAULT_BPM = 126;

export interface TempoState {
  /** Tempo in beats per minute. */
  bpm: number;
  /** Speed of effects relative to the tempo: 0.5, 1 or 2. */
  rate: number;
}

export interface TempoPatch {
  bpm?: unknown;
  rate?: unknown;
  /** True restarts the beat count: "the one is now". */
  sync?: unknown;
}

export interface TempoOptions {
  /** Monotonic clock in milliseconds. Tests pass their own. */
  now?: () => number;
}

export class Tempo extends EventEmitter {
  /** The clock the beat is counted on. */
  readonly now: () => number;
  private state: TempoState = { bpm: DEFAULT_BPM, rate: 1 };
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

  /** Applies a partial change. Nothing is applied when any part of it is invalid. */
  update(patch: unknown, origin?: string): void {
    const { bpm, rate, sync } = readObject(patch, 'the tempo', [
      'bpm',
      'rate',
      'sync',
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
}
