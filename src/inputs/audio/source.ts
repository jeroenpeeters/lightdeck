/**
 * Where sound comes from. A source hands over mono samples and a status and knows
 * nothing about beats, so the microphone of the browser can be replaced by a line-in, a
 * file or anything else without a change anywhere downstream.
 */

import type { EventEmitter } from 'node:events';

export interface AudioBlock {
  /** Mono samples, -1 to 1. */
  samples: Float32Array;
  /** Samples per second. */
  sampleRate: number;
  /**
   * Where `samples[0]` lies in the feed, counted in samples from its start. A jump in
   * the numbers is sound that was lost.
   */
  index: number;
  /**
   * Changes when a new feed starts, as when the listen page is reloaded or another
   * device is chosen: positions start over at 0 and the analysis has to start over too.
   */
  feed: number;
}

/**
 * `waiting`: nothing has come yet. `live`: blocks are coming. `lost`: they were coming
 * and have stopped, which is not the same as silence.
 */
export type SourceStatus = 'waiting' | 'live' | 'lost';

/**
 * Emits `block` with an `AudioBlock` and the moment it arrived, on the clock of the
 * tempo (`Tempo.now`), and `status` with a `SourceStatus` when it changes.
 */
export interface AudioSource extends EventEmitter {
  /** A short name for the state and the logs, such as `browser-mic`. */
  readonly id: string;
  /** What the page calls it, such as "Microphone of the laptop". */
  readonly label: string;
  getStatus(): SourceStatus;
  start(): void;
  stop(): void;
}

/** A block of a source and when it arrived, as `block` listeners get them. */
export type BlockListener = (block: AudioBlock, arrivedAt: number) => void;
