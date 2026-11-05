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
 * - **Hold freezes it, and letting go goes on.** `hold(true)` stops the counting where it is: the step
 *   that is on stays on with the bars it has left, and the fixtures are not touched. `hold(false)`
 *   lets the sequence go on from there, counting again from the next bar line (the bar that is going
 *   on is not one of the bars of the step, as after the music stops). A hold is not a stop: the
 *   sequence is still the one that runs. Starting or stopping a sequence lets go of the hold, and
 *   `next()` is refused while it holds, so that what is frozen stays as it is.
 * - **Next skips ahead.** `next()` sets the following step at once, as the bar line does, for an
 *   operator who has had enough of a look: it counts its bars from here, and the sequence goes on.
 * - **Several sequences run at once, one per group** (Jeroen, 2026-11-05: the laser alternates two
 *   looks while the spider goes through a part of the evening). A sequence owns the groups that its
 *   steps name. Starting one stops the sequences that run and share a group with it, and leaves the
 *   others alone, so Begin, Midden and Techno (spider) replace each other while the sequence of the
 *   room, the laser or the strips goes on. Each has its own step, bars left, hold and problem.
 *   Stopping leaves the fixtures as they are. A sequence is never started by itself, not at startup
 *   either.
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

/** Where one running sequence is. */
export interface SequenceRunState {
  /** Id of the sequence. */
  id: string;
  /** Index of the step that is on, from 0. */
  step: number;
  /** How many steps the sequence has. */
  steps: number;
  /** How many bar lines there are to go until the next step. */
  barsLeft: number;
  /** True while the music has stopped and the bars are not counted. */
  paused: boolean;
  /** True while the operator holds the sequence: the bars are not counted until it is let go. */
  held: boolean;
  /** What went wrong at the last step, in words, or null. */
  problem: string | null;
}

export interface SequenceState {
  /** The sequences that run, in the order they were started. Empty when none does. */
  runs: SequenceRunState[];
}

export interface SequencerOptions {
  tempo: Tempo;
  playback: Pick<Playback, 'getShow' | 'playLook' | 'off' | 'on'>;
  /** For a line when a step could not be set. */
  log?: (message: string) => void;
}

/** The groups a sequence sets: those its steps name. */
export function groupsOf(sequence: Sequence): Set<string> {
  return new Set(sequence.steps.flatMap((step) => Object.keys(step.looks)));
}

/** One running sequence: its own place, its own count of bars and its own timer. */
class Run {
  step = 0;
  barsLeft = 0;
  paused = false;
  held = false;
  problem: string | null = null;
  /** The bar line that was last counted. */
  lastBar = 0;
  /** By group, the look this run set last. */
  readonly lastSet = new Map<string, string>();
  timer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly id: string) {}

  clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export class Sequencer extends EventEmitter {
  private readonly tempo: Tempo;
  private readonly playback: SequencerOptions['playback'];
  private readonly log: ((message: string) => void) | undefined;
  /** By the id of the sequence, in the order they were started. */
  private readonly runs = new Map<string, Run>();
  private readonly onTempo = () => {
    for (const run of [...this.runs.values()]) this.tick(run);
  };

  constructor(options: SequencerOptions) {
    super();
    this.tempo = options.tempo;
    this.playback = options.playback;
    this.log = options.log;
    this.tempo.on('tempo', this.onTempo);
    this.playback.on('show', () => this.reconcile());
  }

  getState(): SequenceState {
    return { runs: [...this.runs.values()].map((run) => this.stateOf(run)) };
  }

  private stateOf(run: Run): SequenceRunState {
    return {
      id: run.id,
      step: run.step,
      steps: this.find(run.id)?.steps.length ?? 0,
      barsLeft: run.barsLeft,
      paused: run.paused,
      held: run.held,
      problem: run.problem,
    };
  }

  private changed(): void {
    this.emit('sequence', this.getState());
  }

  /**
   * Starts a sequence at its first step, which is set at once. Stops the sequences that run and
   * set a group that this one sets too, and leaves the others. Starting one that runs starts it
   * over. Throws a `PatchError` when there is no such sequence.
   */
  start(id: unknown): void {
    if (typeof id !== 'string') throw new PatchError('say which sequence, by its id');
    const sequence = this.find(id);
    if (!sequence) throw new PatchError(`there is no sequence called "${id}"`);
    const groups = groupsOf(sequence);
    for (const other of [...this.runs.values()]) {
      const theirs = this.find(other.id);
      if (other.id === id || !theirs || [...groupsOf(theirs)].some((group) => groups.has(group))) {
        this.release(other);
      }
    }
    const run = new Run(id);
    this.runs.set(id, run);
    run.barsLeft = sequence.steps[0]?.bars ?? 1;
    run.paused = !this.tempo.isRunning();
    run.lastBar = this.barNow();
    this.apply(run, sequence, 0);
    this.changed();
    this.arm(run);
  }

  /**
   * Sets the next step of a sequence now, in place of waiting for the bar line, and counts its
   * bars from here. After the last step it is the first again. Without an id it is the sequence
   * that runs when only one does. Throws a `PatchError` when it is held.
   */
  next(id?: string): void {
    const run = this.pick(id);
    if (!run) return;
    const sequence = this.find(run.id);
    if (!sequence) return;
    if (run.held) throw new PatchError('the sequence is on hold: press Hold again to let it go');
    run.step = (run.step + 1) % sequence.steps.length;
    run.barsLeft = sequence.steps[run.step]?.bars ?? 1;
    this.apply(run, sequence, run.step);
    this.changed();
  }

  /**
   * Holds a sequence that runs, or lets it go: a held sequence counts no bars and sets nothing, a
   * released one goes on with the bars the step has left. Throws a `PatchError` when it does not
   * run. Without an id it is the sequence that runs when only one does.
   */
  hold(on: boolean, id?: string): void {
    const run = this.pick(id, 'there is nothing to hold');
    if (!run || run.held === on) return;
    run.held = on;
    if (on) {
      run.clearTimer();
    } else {
      // It counts again from here: the bar that is going on is not one of the bars of the step.
      run.lastBar = this.barNow();
    }
    this.changed();
    if (!on) this.arm(run);
  }

  /**
   * Stops a sequence, or all of them without an id. The fixtures stay as they are.
   */
  stop(id?: string): void {
    const stopping = id === undefined ? [...this.runs.values()] : [this.runs.get(id)];
    let any = false;
    for (const run of stopping) {
      if (!run) continue;
      this.release(run);
      any = true;
    }
    if (any) this.changed();
  }

  close(): void {
    for (const run of this.runs.values()) run.clearTimer();
    this.runs.clear();
    this.tempo.off('tempo', this.onTempo);
    this.removeAllListeners();
  }

  // --- counting ---------------------------------------------------------------------------

  /** The run an operator means: the one named, or the only one that runs. */
  private pick(id: string | undefined, nothing = 'there is nothing to do'): Run | undefined {
    if (id !== undefined) {
      const run = this.runs.get(id);
      if (!run) throw new PatchError(`the sequence "${id}" does not run`);
      return run;
    }
    if (this.runs.size === 0) {
      if (nothing === 'there is nothing to do') return undefined;
      throw new PatchError(`no sequence runs, so ${nothing}`);
    }
    if (this.runs.size > 1) {
      throw new PatchError('several sequences run: say which one, by its id');
    }
    return [...this.runs.values()][0];
  }

  private release(run: Run): void {
    run.clearTimer();
    this.runs.delete(run.id);
  }

  private find(id: string): Sequence | undefined {
    return this.playback.getShow().sequences.find((sequence) => sequence.id === id) as
      | Sequence
      | undefined;
  }

  private barNow(): number {
    return Math.floor(this.tempo.beatAt(this.tempo.now()) / BEATS_PER_BAR);
  }

  /** Looks at the bar lines that went by, steps on when a step is done, and arms the next look. */
  private tick(run: Run): void {
    run.clearTimer();
    if (this.runs.get(run.id) !== run || run.held) return;
    if (!this.tempo.isRunning()) {
      if (!run.paused) {
        run.paused = true;
        this.changed();
      }
      return;
    }
    if (run.paused) {
      // It counts again from here: the bar that is going on is not one of the bars of the step.
      run.paused = false;
      run.lastBar = this.barNow();
      this.changed();
    }
    const bar = this.barNow();
    const crossed = bar - run.lastBar;
    run.lastBar = bar;
    if (crossed > 0) this.countBars(run, Math.min(crossed, MAX_BARS_AT_ONCE));
    this.arm(run);
  }

  private countBars(run: Run, bars: number): void {
    const sequence = this.find(run.id);
    if (!sequence) return;
    for (let n = 0; n < bars; n++) {
      run.barsLeft--;
      if (run.barsLeft > 0) continue;
      run.step = (run.step + 1) % sequence.steps.length;
      run.barsLeft = sequence.steps[run.step]?.bars ?? 1;
      this.apply(run, sequence, run.step);
    }
    this.changed();
  }

  /** Arms the timer for the next bar line, as the tempo is now. */
  private arm(run: Run): void {
    run.clearTimer();
    if (this.runs.get(run.id) !== run || run.paused || run.held) return;
    const at = this.tempo.timeOfBeat((run.lastBar + 1) * BEATS_PER_BAR);
    // A millisecond late, so that the look lands past the bar line and not just before it.
    run.timer = setTimeout(() => this.tick(run), Math.max(0, at - this.tempo.now()) + 1);
  }

  // --- setting ----------------------------------------------------------------------------

  /** Sets the looks of a step where they differ from what the run set last. */
  private apply(run: Run, sequence: Sequence, index: number): void {
    const step = sequence.steps[index];
    if (!step) return;
    const problems: string[] = [];
    for (const [group, look] of Object.entries(step.looks)) {
      if (run.lastSet.get(group) === look) continue;
      try {
        if (look === 'off') this.playback.off(group, 'sequence');
        else this.playback.playLook(group, look, 'sequence');
        run.lastSet.set(group, look);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        problems.push(`${group}: ${why}`);
      }
    }
    run.problem = problems.length === 0 ? null : problems.join('; ');
    if (run.problem) {
      this.log?.(`sequence "${sequence.id}", step ${index + 1}: ${run.problem}`);
    }
  }

  /**
   * The show changed: a sequence that is gone stops, one that got shorter stays on a step, and when
   * the file made two runs set the same group the one started later stops.
   */
  private reconcile(): void {
    if (this.runs.size === 0) return;
    const taken = new Set<string>();
    for (const run of [...this.runs.values()]) {
      const sequence = this.find(run.id);
      if (!sequence) {
        this.release(run);
        continue;
      }
      const groups = groupsOf(sequence);
      if ([...groups].some((group) => taken.has(group))) {
        this.log?.(`sequence "${sequence.id}" stopped: another sequence sets the same group now`);
        this.release(run);
        continue;
      }
      for (const group of groups) taken.add(group);
      run.step = Math.min(run.step, sequence.steps.length - 1);
      run.barsLeft = Math.min(run.barsLeft, sequence.steps[run.step]?.bars ?? 1);
    }
    this.changed();
  }
}
