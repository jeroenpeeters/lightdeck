/**
 * The microphone of the browser as a source. It opens nothing itself: the listen page
 * on the laptop captures the sound and posts it to `POST /api/audio`, and the route
 * hands every post to `push`.
 *
 * The body of a post is raw 16-bit little-endian mono samples, about 100 ms of them.
 * The sample rate, the position of the first sample in the feed and the name of the feed
 * come as headers, so that the body can stay raw: `x-rate`, `x-index`, `x-feed`.
 */

import { EventEmitter } from 'node:events';
import { PatchError } from '../../server/fixture.js';
import type { AudioBlock, AudioSource, SourceStatus } from './source.js';
import { fromInt16 } from './wav.js';

/** How long without a block before the source is lost. */
export const LOST_AFTER_MS = 1500;
const CHECK_MS = 250;
const MIN_RATE = 8000;
const MAX_RATE = 96_000;
const FEED_NAME = /^[A-Za-z0-9._-]{1,40}$/;

export interface BrowserMicOptions {
  /** Monotonic clock in milliseconds. Tests pass their own. */
  now?: () => number;
  /** Milliseconds without a block before the source is lost. */
  lostAfterMs?: number;
}

export interface MicPost {
  bytes: Uint8Array;
  sampleRate: number;
  index: number;
  /** The name the page gave this feed. A new name is a new feed. */
  feed: string;
}

export class BrowserMicSource extends EventEmitter implements AudioSource {
  readonly id = 'browser-mic';
  readonly label = 'Microphone of the laptop';

  private readonly now: () => number;
  private readonly lostAfterMs: number;
  private status: SourceStatus = 'waiting';
  private lastArrival = 0;
  private feedName: string | undefined;
  private feedRate = 0;
  private feedNumber = 0;
  private watchdog: NodeJS.Timeout | undefined;

  constructor(options: BrowserMicOptions = {}) {
    super();
    this.now = options.now ?? (() => performance.now());
    this.lostAfterMs = options.lostAfterMs ?? LOST_AFTER_MS;
  }

  getStatus(): SourceStatus {
    return this.status;
  }

  start(): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => this.check(), CHECK_MS);
    this.watchdog.unref();
  }

  stop(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  /** Takes what a post brought. Throws a `PatchError` when it cannot be a block of sound. */
  push(post: MicPost): void {
    const { bytes, sampleRate, index, feed } = post;
    if (!Number.isInteger(sampleRate) || sampleRate < MIN_RATE || sampleRate > MAX_RATE) {
      throw new PatchError(`x-rate must be a whole number between ${MIN_RATE} and ${MAX_RATE}`);
    }
    if (!Number.isInteger(index) || index < 0) {
      throw new PatchError('x-index must be a whole number, 0 or more');
    }
    if (!FEED_NAME.test(feed)) {
      throw new PatchError(
        'x-feed must be a name of letters, digits, dots, dashes and underscores',
      );
    }
    if (bytes.length < 2 || bytes.length % 2 !== 0) {
      throw new PatchError('the body must be 16-bit samples, an even number of bytes');
    }

    if (feed !== this.feedName || sampleRate !== this.feedRate) {
      this.feedName = feed;
      this.feedRate = sampleRate;
      this.feedNumber += 1;
    }
    const arrivedAt = this.now();
    this.lastArrival = arrivedAt;
    this.setStatus('live');
    const block: AudioBlock = {
      samples: fromInt16(bytes),
      sampleRate,
      index,
      feed: this.feedNumber,
    };
    this.emit('block', block, arrivedAt);
  }

  /** Marks the source lost when blocks have stopped. The watchdog calls this. */
  check(): void {
    if (this.status === 'live' && this.now() - this.lastArrival > this.lostAfterMs) {
      this.setStatus('lost');
    }
  }

  private setStatus(status: SourceStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.emit('status', status);
  }
}
