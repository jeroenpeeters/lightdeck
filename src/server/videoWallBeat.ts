/**
 * The tempo to the video wall (Jeroen, 2026-11-03): Dreamscape Player has beat effects that follow a
 * tempo, and takes it with `POST /api/bpm { bpm, downbeat? }`. `downbeat: true` means "this moment is
 * beat one", and the player stamps it with the time the call ARRIVES, so a downbeat is sent at the
 * moment of the bar line and not before.
 *
 * When it is sent:
 *   - the bpm, whenever it changes (at most every `MIN_GAP_MS`, the newest value wins);
 *   - bpm and downbeat at once after a tap (the one is now), which is a change of `Tempo.epoch`;
 *   - bpm and downbeat on the first beat of a bar, every `intervalMs` (60 s), so that the video keeps in
 *     step while rekordbox nudges the beat; and again at the first bar line after the music starts.
 *
 * It is all fire and forget. Nothing here waits for the wall, a call that fails is handed to `report`
 * and never raised, never retried (the next change or the next minute is the next call), and a slow
 * wall never delays a downbeat: only calls with the bpm alone are held back while one is on its way.
 */

import type { Tempo, TempoState } from './tempo.js';

const BEATS_PER_BAR = 4;
/** The most often the bpm alone is sent, in milliseconds. */
export const MIN_GAP_MS = 250;
/** How often the bar line is sent as a downbeat, in milliseconds. */
export const SYNC_INTERVAL_MS = 60_000;
/** The beat of a downbeat call may be this far from a bar line (in beats) when the timer fires. */
const BAR_TOLERANCE = 0.1;
/** A bpm that differs less than this is the same. */
const BPM_EPSILON = 0.005;

export interface BeatCall {
  bpm: number;
  downbeat: boolean;
}

export interface BeatOptions {
  tempo: Tempo;
  /** Makes the call. May take long and may raise: this class does not wait for it and does not care. */
  send: (call: BeatCall) => Promise<void>;
  /** Whether the tempo is to go to the wall now (the setting). */
  enabled: () => boolean;
  /** Tells how a call went, for the page. */
  report?: (call: BeatCall, error?: unknown) => void;
  intervalMs?: number;
}

export class VideoWallBeat {
  private readonly tempo: Tempo;
  private readonly intervalMs: number;
  private lastBpm: number | undefined;
  private lastEpoch: number;
  private wasRunning: boolean;
  private lastBpmSentAt = Number.NEGATIVE_INFINITY;
  private bpmInFlight = false;
  private bpmDirty = false;
  private gapTimer: NodeJS.Timeout | undefined;
  private barTimer: NodeJS.Timeout | undefined;
  private periodTimer: NodeJS.Timeout | undefined;
  private closed = false;
  /** Whether the timer waits for a bar line (and not for the minute to pass). */
  private barPending = false;
  private readonly onTempo = (state: TempoState) => this.tempoChanged(state);

  constructor(private readonly options: BeatOptions) {
    this.tempo = options.tempo;
    this.intervalMs = options.intervalMs ?? SYNC_INTERVAL_MS;
    this.lastEpoch = this.tempo.epoch;
    this.wasRunning = this.tempo.isRunning();
    this.tempo.on('tempo', this.onTempo);
    this.restart();
  }

  /** The setting changed: starts, or stops, the schedule. Switching on sends the tempo at the next bar line. */
  refresh(): void {
    this.restart();
  }

  close(): void {
    this.closed = true;
    this.tempo.off('tempo', this.onTempo);
    this.stopTimers();
  }

  private restart(): void {
    this.stopTimers();
    if (this.closed || !this.options.enabled()) return;
    // The first bar line says the bpm; a change before it is sent as it comes.
    this.lastBpm = this.tempo.getState().bpm;
    this.armBar();
  }

  private stopTimers(): void {
    clearTimeout(this.gapTimer);
    clearTimeout(this.barTimer);
    clearTimeout(this.periodTimer);
    this.gapTimer = this.barTimer = this.periodTimer = undefined;
    this.barPending = false;
  }

  private tempoChanged(state: TempoState): void {
    if (this.closed || !this.options.enabled()) return;
    const epoch = this.tempo.epoch;
    if (epoch !== this.lastEpoch) {
      // A tap: the one is now. Say so now, and count the minute from here.
      this.lastEpoch = epoch;
      this.wasRunning = state.running;
      clearTimeout(this.barTimer);
      clearTimeout(this.periodTimer);
      this.fire(true);
      this.armPeriod();
      return;
    }
    if (state.running !== this.wasRunning) {
      this.wasRunning = state.running;
      // The music starts: the bar line after it is the first thing to say. Stopped: nothing to say.
      if (state.running) {
        clearTimeout(this.barTimer);
        clearTimeout(this.periodTimer);
        this.armBar();
      }
    }
    // The bar line is somewhere else when the bpm or the beat moved: aim again.
    if (this.barPending && state.running) this.armBar();
    if (state.running && Math.abs(state.bpm - (this.lastBpm ?? Number.NaN)) >= BPM_EPSILON) {
      this.sendBpm();
    }
  }

  /** Waits for the next bar line, then says it. */
  private armBar(): void {
    clearTimeout(this.barTimer);
    const beat = this.tempo.getBeat();
    const line = (Math.floor(beat / BEATS_PER_BAR) + 1) * BEATS_PER_BAR;
    const wait = Math.max(0, this.tempo.timeOfBeat(line) - this.tempo.now()) + 1;
    this.barPending = true;
    this.barTimer = setTimeout(() => this.barLine(), wait);
    this.barTimer.unref();
  }

  private barLine(): void {
    this.barPending = false;
    if (this.closed || !this.options.enabled()) return;
    if (!this.tempo.isRunning()) return; // armed again when the music starts
    const beat = this.tempo.getBeat();
    const off = beat - Math.round(beat / BEATS_PER_BAR) * BEATS_PER_BAR;
    if (Math.abs(off) > BAR_TOLERANCE) {
      // The tempo changed under the timer: this is not the bar line any more.
      this.armBar();
      return;
    }
    this.fire(true);
    this.armPeriod();
  }

  /** A minute from now, find the next bar line again. */
  private armPeriod(): void {
    clearTimeout(this.periodTimer);
    this.periodTimer = setTimeout(() => this.armBar(), this.intervalMs);
    this.periodTimer.unref();
  }

  /** The bpm alone: held back to one call at a time and one per `MIN_GAP_MS`, the newest value goes. */
  private sendBpm(): void {
    if (this.bpmInFlight) {
      this.bpmDirty = true;
      return;
    }
    const wait = this.lastBpmSentAt + MIN_GAP_MS - performance.now();
    if (wait > 0) {
      if (this.gapTimer === undefined) {
        this.gapTimer = setTimeout(() => {
          this.gapTimer = undefined;
          this.sendBpm();
        }, wait);
        this.gapTimer.unref();
      }
      return;
    }
    this.fire(false);
  }

  private fire(downbeat: boolean): void {
    const bpm = Math.round(this.tempo.getState().bpm * 100) / 100;
    const call: BeatCall = { bpm, downbeat };
    this.lastBpm = bpm;
    if (!downbeat) {
      this.bpmInFlight = true;
      this.lastBpmSentAt = performance.now();
    }
    let result: Promise<void>;
    try {
      result = Promise.resolve(this.options.send(call));
    } catch (error) {
      result = Promise.reject(error);
    }
    void result.then(
      () => this.done(call, downbeat),
      (error) => this.done(call, downbeat, error),
    );
  }

  private done(call: BeatCall, downbeat: boolean, error?: unknown): void {
    try {
      this.options.report?.(call, error);
    } catch {
      // a report that fails must not stop the schedule
    }
    if (downbeat) return;
    this.bpmInFlight = false;
    if (this.bpmDirty) {
      this.bpmDirty = false;
      if (
        this.options.enabled() &&
        this.lastBpm !== undefined &&
        Math.abs(this.tempo.getState().bpm - this.lastBpm) >= BPM_EPSILON
      ) {
        this.sendBpm();
      }
    }
  }
}
