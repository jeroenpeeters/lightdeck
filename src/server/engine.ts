/**
 * The one clock that makes the frames of every fixture that animates.
 *
 * Before this every controller had a timer of its own that asked, every 25 ms, for a frame.
 * A beat then came out 0 to 25 ms late, depending on where the timer happened to lie
 * against it, the first frame of a flash was often already on the way down, and a second
 * timer further on sent what the first had made.
 *
 * The engine ticks on a grid locked to the beat: a whole number of points per beat, so
 * that every beat is a point of the grid and the first frame of a beat is made for the
 * beat itself. A tick is armed for an absolute moment, worked out from the tempo, so a
 * timer that runs a little early or late does not move the next one. What is rendered is
 * the grid point and not the moment the timer ran.
 *
 * It ticks only while some fixture wants frames, which is while an effect is chosen and the
 * tempo runs. A static look costs no timer at all. It never ticks faster than `maxFps`,
 * which protects the LR512: the original Light Rider app sends 25 frames per second, and
 * nothing is known about what the device takes beyond that.
 *
 * The output flushes by itself when a frame has been made (see `Lr512BridgeClient`), so
 * the engine does not hand anything on.
 */

import { PatchError } from './fixture.js';
import type { Tempo } from './tempo.js';

export const DEFAULT_MAX_FPS = 25;
export const MIN_MAX_FPS = 1;
export const MAX_MAX_FPS = 60;

/** A timer is armed this much early, in milliseconds: they run a little late, never early by this much. */
const EARLY_MS = 1;

/** What the engine drives: a fixture that makes frames while it animates. */
export interface Animated {
  /** True while it needs frames from the clock: an effect is chosen and the tempo runs. */
  wantsFrames(): boolean;
  /** Makes the frame for the moment `at`, on the clock of the tempo, and hands it to the patch. */
  render(at: number): void;
  /** `wants` is emitted when `wantsFrames()` may have changed. */
  on(event: 'wants', listener: () => void): unknown;
  off(event: 'wants', listener: () => void): unknown;
}

/** True for a controller that makes frames on the clock of the engine, as the spider and the laser do. */
export function isAnimated(controller: unknown): controller is Animated {
  const candidate = controller as Partial<Animated> | null;
  return (
    typeof candidate?.wantsFrames === 'function' &&
    typeof candidate.render === 'function' &&
    typeof candidate.on === 'function'
  );
}

export interface EngineOptions {
  tempo: Tempo;
  /** The most frames per second. Default 25. */
  maxFps?: number;
  /** Told when a fixture could not make its frame. Default: written to the error output. */
  onError?: (error: unknown) => void;
}

export interface EngineStats {
  /** Frames made by the clock. */
  ticks: number;
  /** Grid points that were not made because the event loop was held up past them. */
  skipped: number;
  /** Frames that a fixture could not make: it threw. The clock goes on without them. */
  errors: number;
  /** How late the timers ran, in milliseconds: the mean and the worst, over what ran late. */
  late: { mean: number; max: number };
}

export function readMaxFps(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < MIN_MAX_FPS ||
    value > MAX_MAX_FPS
  ) {
    throw new PatchError(
      `the most frames per second must be a number between ${MIN_MAX_FPS} and ${MAX_MAX_FPS}`,
    );
  }
  return value;
}

export class Engine {
  private readonly tempo: Tempo;
  private maxFps: number;
  private readonly animated = new Set<Animated>();
  /** Those that wanted frames when the clock last looked. */
  private active = new Set<Animated>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The grid point the timer is armed for. */
  private target = 0;
  /** Points per beat of the grid the timer was armed on. */
  private perBeat = 1;
  private lastTarget = Number.NEGATIVE_INFINITY;
  /** The moment of the last frame made for a change in the tempo, which the grid then does not repeat. */
  private lastRender = Number.NEGATIVE_INFINITY;
  /** The count of taps when the clock last looked: a tap makes this moment beat one. */
  private lastEpoch: number;
  private counters = { ticks: 0, skipped: 0, errors: 0, lateSum: 0, lateCount: 0, lateMax: 0 };
  private readonly onError: (error: unknown) => void;
  private readonly onWants = () => this.rearm();
  private readonly onTempo = () => this.tempoChanged();

  constructor(options: EngineOptions) {
    this.tempo = options.tempo;
    this.maxFps = readMaxFps(options.maxFps ?? DEFAULT_MAX_FPS);
    this.lastEpoch = this.tempo.epoch;
    this.onError =
      options.onError ?? ((error) => console.error('a fixture could not make a frame:', error));
    this.tempo.on('tempo', this.onTempo);
  }

  getMaxFps(): number {
    return this.maxFps;
  }

  /** Changes the most frames per second. Throws a `PatchError` for a value that makes no sense. */
  setMaxFps(fps: unknown): void {
    this.maxFps = readMaxFps(fps);
    this.rearm();
  }

  get stats(): EngineStats {
    const { ticks, skipped, errors, lateSum, lateCount, lateMax } = this.counters;
    return {
      ticks,
      skipped,
      errors,
      late: { mean: lateCount ? lateSum / lateCount : 0, max: lateMax },
    };
  }

  add(animated: Animated): void {
    this.animated.add(animated);
    animated.on('wants', this.onWants);
    this.rearm();
  }

  remove(animated: Animated): void {
    this.animated.delete(animated);
    this.active.delete(animated);
    animated.off('wants', this.onWants);
    this.rearm();
  }

  close(): void {
    this.stopTimer();
    this.tempo.off('tempo', this.onTempo);
    for (const animated of this.animated) animated.off('wants', this.onWants);
    this.animated.clear();
    this.active.clear();
  }

  private get minIntervalMs(): number {
    return 1000 / this.maxFps;
  }

  /**
   * The tempo changed: a new bpm moves the grid, and `running` changing leaves the effects
   * idle or brings them back. What was animating and no longer wants frames gets one more,
   * so that the fixture shows what is set under the effect and not the last picture of it.
   * What starts to want frames gets one at once, and not at the next point of the grid.
   * So does everything after a tap: it made this moment beat one, and the lights are to show it.
   */
  private tempoChanged(): void {
    const now = this.tempo.now();
    const tapped = this.tempo.epoch !== this.lastEpoch;
    this.lastEpoch = this.tempo.epoch;
    for (const animated of this.animated) {
      const wants = animated.wantsFrames();
      const was = this.active.has(animated);
      if ((was && !wants) || (!was && wants) || (tapped && wants)) {
        this.make(animated, now);
        this.lastRender = now;
      }
    }
    this.rearm();
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Looks at who wants frames, and arms the next tick, or none. */
  private rearm(): void {
    this.stopTimer();
    this.active = new Set([...this.animated].filter((animated) => animated.wantsFrames()));
    if (this.active.size === 0) return;

    const beatMs = 60_000 / this.tempo.getState().bpm;
    this.perBeat = Math.max(1, Math.floor(beatMs / this.minIntervalMs + 1e-9));
    const now = this.tempo.now();
    let k = Math.ceil(this.tempo.beatAt(now) * this.perBeat - 1e-9);
    let target = this.tempo.timeOfBeat(k / this.perBeat);
    // Not the point that was just made, however often this is asked for: not by a tick, and not
    // by a fixture that rendered for this very moment when it changed.
    const earliest = Math.max(this.lastTarget + 0.9 * this.minIntervalMs, this.lastRender + 1e-6);
    while (target < earliest) {
      k += 1;
      target = this.tempo.timeOfBeat(k / this.perBeat);
    }
    this.target = target;
    this.timer = setTimeout(() => this.tick(), Math.max(0, target - now - EARLY_MS));
  }

  private tick(): void {
    this.timer = undefined;
    const now = this.tempo.now();
    let target = this.target;
    const gridMs = 60_000 / this.tempo.getState().bpm / this.perBeat;

    const behind = now - target;
    if (behind > gridMs) {
      // The loop was held up past a point. The frames that were missed are not made one after
      // the other: the latest point is made, and the ones before it are counted.
      const k = Math.floor(this.tempo.beatAt(now) * this.perBeat + 1e-9);
      const latest = this.tempo.timeOfBeat(k / this.perBeat);
      this.counters.skipped += Math.max(0, Math.round((latest - target) / gridMs));
      target = latest;
    }
    if (behind > 0) {
      this.counters.lateSum += behind;
      this.counters.lateCount += 1;
      this.counters.lateMax = Math.max(this.counters.lateMax, behind);
    }

    this.lastTarget = target;
    this.counters.ticks += 1;
    for (const animated of [...this.active]) {
      if (animated.wantsFrames()) this.make(animated, target);
    }
    this.rearm();
  }

  /**
   * One fixture's frame. A fixture that throws costs its own frame and is reported, and the clock
   * goes on: a show does not stop because one frame could not be made, and a server that dies in
   * a timer takes every light with it.
   */
  private make(animated: Animated, at: number): void {
    try {
      animated.render(at);
    } catch (error) {
      this.counters.errors += 1;
      this.onError(error);
    }
  }
}
