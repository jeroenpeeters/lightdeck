/**
 * Runs a sequence: the looks of the groups changing by themselves, on the bars of the music.
 *
 * A sequence is a list of steps (`show/show.ts`). A step lasts a number of bars and names a look,
 * or `off`, for one or more groups. The sequencer starts a sequence at the first step, counts the
 * bar lines of the tempo, and at the bar line where a step has had its bars it sets the next one,
 * and after the last it starts again at the first. It sets looks the way a press on their keys
 * does (`Playback.playLook`), so everything that goes for a look goes for a step.
 *
 * - **A step lasts its bars from the first bar line.** The first step is set at once when the
 *   sequence starts, and the first bar line after that is the first of its bars, so the next
 *   step always lands on a bar line, which is the point of counting bars. The first step is
 *   therefore up to one bar shorter than it says; the others are as long as they say.
 * - **A step only sets what changes.** A group gets its look when the step names another look
 *   for it than the sequence set last. A group the step does not name is left alone. When the
 *   sequence starts over from the first step, the last step counts as the step before.
 * - **A press by hand wins, and the sequence goes on.** The sequencer does not look at what the
 *   operator set. It takes the group back at the next step that sets another look in it than it
 *   set last, which is the design of `docs/show-design.md`.
 * - **The music stops: the sequence waits.** Like the effects, a sequence does not go on while
 *   the tempo is not running (the audio source says the music has stopped), and counts again
 *   from the next bar line when it does.
 * - **One sequence runs at a time.** Starting one stops the one that runs. Stopping leaves the
 *   fixtures as they are. A sequence is never started by itself, not at startup either.
 *
 * It counts bar lines crossed and not moments: a tap, which restarts the count of the beat, or a
 * change of the bpm moves the next bar line, and the timer is armed again for it. The time on
 * the wall is never what a step is measured in.
 */

import { EventEmitter } from 'node:events';
import type { Sequence } from '../show/show.js';
import { PatchError } from './fixture.js';
import type { Playback } from './playback.js';
import type { Tempo } from './tempo.js';

/** A bar is four beats, with beat one of the tempo as the start of a bar. */
export const BEATS_PER_BAR = 4;

/**
 * More bar lines than this found at one look are a stall (the machine was suspended, or the
 * clock jumped) and not music: they count as this many, so that a sequence does not run
 * through its steps in one go.
 */
const MAX_BARS_AT_ONCE = 2;

export interface SequenceState {
  /** Id of the sequence that runs, or null. */
  running: string | null;
  /** Index of the step that is on, from 0, or -1 when none runs. */
  step: number;
  /** How many steps the running sequence has, or 0. */
  steps: number;
  /** How many bar lines there are to go until the next step. */
  barsLeft: number;
  /** True while the music has stopped and the bars are not counted. */
  paused: boolean;
  /** What went wrong at the last step, in words, or null. */
  problem: string | null;
}

export interface SequencerOptions {
  tempo: Tempo;
  playback: Pick<Playback, 'getShow' | 'playLook' | 'off' | 'on'>;
  /** For a line when a step could not be set. */
  log?: (message: string) => void;
}

export class Sequencer extends EventEmitter {
  private readonly tempo: Tempo;
  private readonly playback: SequencerOptions['playback'];
  private readonly log: ((message: string) => void) | undefined;
  private runningId: string | null = null;
  private step = -1;
  private barsLeft = 0;
  private paused = false;
  private problem: string | null = null;
  /** The bar line that was last counted. */
  private lastBar = 0;
  /** By group, the look the sequence set last. */
  private readonly lastSet = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly onTempo = () => this.tick();

  constructor(options: SequencerOptions) {
    super();
    this.tempo = options.tempo;
    this.playback = options.playback;
    this.log = options.log;
    this.tempo.on('tempo', this.onTempo);
    this.playback.on('show', () => this.reconcile());
  }

  getState(): SequenceState {
    return {
      running: this.runningId,
      step: this.step,
      steps: this.current()?.steps.length ?? 0,
      barsLeft: this.barsLeft,
      paused: this.paused,
      problem: this.problem,
    };
  }

  /**
   * Starts a sequence at its first step, which is set at once. Stops the one that runs. Throws a
   * `PatchError` when there is no such sequence.
   */
  start(id: unknown): void {
    if (typeof id !== 'string') throw new PatchError('say which sequence, by its id');
    const sequence = this.find(id);
    if (!sequence) throw new PatchError(`there is no sequence called "${id}"`);
    this.clearTimer();
    this.runningId = id;
    this.lastSet.clear();
    this.step = 0;
    this.barsLeft = sequence.steps[0]?.bars ?? 1;
    this.paused = !this.tempo.isRunning();
    this.lastBar = this.barNow();
    this.apply(sequence, 0);
    this.emit('sequence', this.getState());
    this.arm();
  }

  /** Stops the sequence that runs. The fixtures stay as they are. */
  stop(): void {
    if (this.runningId === null) return;
    this.clearTimer();
    this.runningId = null;
    this.step = -1;
    this.barsLeft = 0;
    this.paused = false;
    this.problem = null;
    this.lastSet.clear();
    this.emit('sequence', this.getState());
  }

  close(): void {
    this.clearTimer();
    this.runningId = null;
    this.tempo.off('tempo', this.onTempo);
    this.removeAllListeners();
  }

  // --- counting ---------------------------------------------------------------------------

  private find(id: string): Sequence | undefined {
    return this.playback.getShow().sequences.find((sequence) => sequence.id === id) as
      | Sequence
      | undefined;
  }

  private current(): Sequence | undefined {
    return this.runningId === null ? undefined : this.find(this.runningId);
  }

  private barNow(): number {
    return Math.floor(this.tempo.beatAt(this.tempo.now()) / BEATS_PER_BAR);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Looks at the bar lines that went by, steps on when a step is done, and arms the next look. */
  private tick(): void {
    this.clearTimer();
    if (this.runningId === null) return;
    if (!this.tempo.isRunning()) {
      if (!this.paused) {
        this.paused = true;
        this.emit('sequence', this.getState());
      }
      return;
    }
    if (this.paused) {
      // It counts again from here: the bar that is going on is not one of the bars of the step.
      this.paused = false;
      this.lastBar = this.barNow();
      this.emit('sequence', this.getState());
    }
    const bar = this.barNow();
    const crossed = bar - this.lastBar;
    this.lastBar = bar;
    if (crossed > 0) this.countBars(Math.min(crossed, MAX_BARS_AT_ONCE));
    this.arm();
  }

  private countBars(bars: number): void {
    const sequence = this.current();
    if (!sequence) return;
    for (let n = 0; n < bars; n++) {
      this.barsLeft--;
      if (this.barsLeft > 0) continue;
      this.step = (this.step + 1) % sequence.steps.length;
      this.barsLeft = sequence.steps[this.step]?.bars ?? 1;
      this.apply(sequence, this.step);
    }
    this.emit('sequence', this.getState());
  }

  /** Arms the timer for the next bar line, as the tempo is now. */
  private arm(): void {
    this.clearTimer();
    if (this.runningId === null || this.paused) return;
    const at = this.tempo.timeOfBeat((this.lastBar + 1) * BEATS_PER_BAR);
    // A millisecond late, so that the look lands past the bar line and not just before it.
    this.timer = setTimeout(() => this.tick(), Math.max(0, at - this.tempo.now()) + 1);
  }

  // --- setting ----------------------------------------------------------------------------

  /** Sets the looks of a step where they differ from what the sequence set last. */
  private apply(sequence: Sequence, index: number): void {
    const step = sequence.steps[index];
    if (!step) return;
    const problems: string[] = [];
    for (const [group, look] of Object.entries(step.looks)) {
      if (this.lastSet.get(group) === look) continue;
      try {
        if (look === 'off') this.playback.off(group, 'sequence');
        else this.playback.playLook(group, look, 'sequence');
        this.lastSet.set(group, look);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        problems.push(`${group}: ${why}`);
      }
    }
    this.problem = problems.length === 0 ? null : problems.join('; ');
    if (this.problem) {
      this.log?.(`sequence "${sequence.id}", step ${index + 1}: ${this.problem}`);
    }
  }

  /** The show changed: a sequence that is gone stops, and one that got shorter stays on a step. */
  private reconcile(): void {
    if (this.runningId === null) return;
    const sequence = this.current();
    if (!sequence) {
      this.stop();
      return;
    }
    this.step = Math.min(this.step, sequence.steps.length - 1);
    this.barsLeft = Math.min(this.barsLeft, sequence.steps[this.step]?.bars ?? 1);
    this.emit('sequence', this.getState());
  }
}
