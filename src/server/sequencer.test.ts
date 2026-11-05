import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sequence } from '../show/show.js';
import { PatchError } from './fixture.js';
import { Sequencer, type SequenceState } from './sequencer.js';
import { Tempo } from './tempo.js';

/** What the sequencer asks of the playback, recorded. */
class FakePlayback {
  private readonly bus = new EventEmitter();
  sequences: Sequence[] = [];
  calls: string[] = [];
  refuse = new Set<string>();

  getShow() {
    return { sequences: this.sequences };
  }
  playLook(group: string, look: string, origin?: string) {
    if (this.refuse.has(`${group}:${look}`)) throw new PatchError(`cannot set ${look}`);
    this.calls.push(`${group}:${look}${origin === undefined ? '' : `@${origin}`}`);
  }
  off(group: string, origin?: string) {
    this.calls.push(`${group}:off${origin === undefined ? '' : `@${origin}`}`);
  }
  on(event: string, listener: () => void) {
    this.bus.on(event, listener);
  }
  /** The show file changed. */
  changed(sequences: Sequence[]) {
    this.sequences = sequences;
    this.bus.emit('show');
  }
}

/** The state of the first sequence that runs, in the shape the tests of one sequence were written in. */
interface OldState {
  running: string | null;
  step: number;
  steps: number;
  barsLeft: number;
  paused: boolean;
  held: boolean;
  problem: string | null;
}
const flat = (state: SequenceState): OldState => {
  const first = state.runs[0];
  if (!first) {
    return {
      running: null,
      step: -1,
      steps: 0,
      barsLeft: 0,
      paused: false,
      held: false,
      problem: null,
    };
  }
  const { id, ...rest } = first;
  return { running: id, ...rest };
};

const step = (bars: number, looks: Record<string, string>) => ({ bars, looks });
const seq = (id: string, steps: Sequence['steps']): Sequence => ({ id, label: id, steps });

describe('Sequencer', () => {
  const BAR = 2000; // 120 bpm: a beat is 500 ms, a bar is four of them
  let tempo: Tempo;
  let playback: FakePlayback;
  let sequencer: Sequencer;
  let states: OldState[];
  /** When the bar lines are: 0 is the origin of the beat count. */
  let origin: number;

  const run = (ms: number) => vi.advanceTimersByTime(ms);
  /** Moves to just past a bar line, counted in bars from the origin of the beat. */
  const goTo = (bars: number) => run(origin + bars * BAR + 5 - Date.now());
  /** Moves to just before a bar line. */
  const goBefore = (bars: number) => run(origin + bars * BAR - 5 - Date.now());
  const stopMusic = () => {
    tempo.update({ source: 'rekordbox' });
    tempo.follow({ running: false });
  };
  const startMusic = () => tempo.follow({ running: true });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    origin = Date.now();
    tempo = new Tempo({ now: () => Date.now() });
    tempo.update({ bpm: 120 });
    playback = new FakePlayback();
    sequencer = new Sequencer({ tempo, playback: playback as never });
    states = [];
    sequencer.on('sequence', (state: SequenceState) => states.push(flat(state)));
  });

  afterEach(() => {
    sequencer.close();
    vi.useRealTimers();
  });

  it('is stopped until it is started, and never starts by itself', () => {
    playback.sequences = [seq('a', [step(1, { spider: 'drop' })])];
    run(60_000);
    expect(flat(sequencer.getState())).toEqual({
      running: null,
      step: -1,
      steps: 0,
      barsLeft: 0,
      paused: false,
      held: false,
      problem: null,
    });
    expect(playback.calls).toEqual([]);
  });

  it('sets the first step at once, as a look is set by a press, and says where it is', () => {
    playback.sequences = [
      seq('night', [step(4, { spider: 'drop', laser: 'off' }), step(2, { spider: 'calm' })]),
    ];
    sequencer.start('night');
    expect(playback.calls).toEqual(['spider:drop@sequence', 'laser:off@sequence']);
    expect(flat(sequencer.getState())).toEqual({
      running: 'night',
      step: 0,
      steps: 2,
      barsLeft: 4,
      paused: false,
      held: false,
      problem: null,
    });
    expect(states).toHaveLength(1);
  });

  it('lets a step last its bars from the first bar line after the start, and lands on a bar line', () => {
    playback.sequences = [seq('a', [step(2, { spider: 'drop' }), step(2, { spider: 'calm' })])];
    // Half way into the first bar.
    run(BAR / 2);
    sequencer.start('a');
    playback.calls = [];
    goTo(1);
    expect(flat(sequencer.getState()).barsLeft).toBe(1);
    goBefore(2);
    expect(playback.calls).toEqual([]);
    goTo(2);
    // Two bar lines have gone by since the start: the first step is done, on the second one.
    expect(playback.calls).toEqual(['spider:calm@sequence']);
    expect(flat(sequencer.getState())).toMatchObject({ step: 1, barsLeft: 2 });
  });

  it('does not set the next step before its bar line', () => {
    playback.sequences = [seq('a', [step(1, { spider: 'drop' }), step(1, { spider: 'calm' })])];
    sequencer.start('a');
    playback.calls = [];
    goBefore(1);
    expect(playback.calls).toEqual([]);
    goTo(1);
    expect(playback.calls).toEqual(['spider:calm@sequence']);
  });

  it('only sets what changes, and starts over after the last step', () => {
    playback.sequences = [
      seq('a', [
        step(1, { spider: 'drop', laser: 'tunnel' }),
        step(1, { spider: 'calm' }),
        step(1, { spider: 'drop', laser: 'tunnel' }),
      ]),
    ];
    sequencer.start('a');
    expect(playback.calls).toEqual(['spider:drop@sequence', 'laser:tunnel@sequence']);
    playback.calls = [];
    goTo(1);
    expect(playback.calls).toEqual(['spider:calm@sequence']);
    playback.calls = [];
    goTo(2);
    // The laser was set to tunnel and nothing else was set in it since: it stays as it is.
    expect(playback.calls).toEqual(['spider:drop@sequence']);
    playback.calls = [];
    goTo(3);
    // Back at step 1: the last step counts as the step before, and it named the same looks, so
    // nothing is set again.
    expect(playback.calls).toEqual([]);
    expect(flat(sequencer.getState()).step).toBe(0);
    goTo(4);
    expect(playback.calls).toEqual(['spider:calm@sequence']);
  });

  it('sets nothing again when a step names the look that is set already', () => {
    playback.sequences = [seq('a', [step(1, { spider: 'drop' }), step(1, { spider: 'drop' })])];
    sequencer.start('a');
    playback.calls = [];
    goTo(5);
    expect(playback.calls).toEqual([]);
    expect(flat(sequencer.getState()).step).toBeGreaterThanOrEqual(0);
  });

  it('takes a group back at the next step that changes it, and not before', () => {
    // The operator presses a look by hand; the sequencer does not look at it.
    playback.sequences = [
      seq('a', [step(2, { spider: 'drop' }), step(2, { laser: 'x' }), step(2, { spider: 'calm' })]),
    ];
    sequencer.start('a');
    playback.calls = [];
    // (a press by hand would be playback.playLook('spider', 'other'): the sequencer is not told)
    goTo(2);
    expect(playback.calls).toEqual(['laser:x@sequence']);
    playback.calls = [];
    goTo(4);
    expect(playback.calls).toEqual(['spider:calm@sequence']);
  });

  it('counts the bar lines of the tempo as it is, and moves the next one when it changes', () => {
    playback.sequences = [seq('a', [step(2, { spider: 'drop' }), step(2, { spider: 'calm' })])];
    sequencer.start('a');
    playback.calls = [];
    // 1000 ms in is beat 2. The tempo goes to 180 and the beat count goes on from there: the bar
    // line, at beat 4, is two beats of 333 ms away, where at 120 bpm it would be 1000 ms away.
    run(BAR / 2);
    tempo.update({ bpm: 180 });
    run(340);
    expect(flat(sequencer.getState()).barsLeft).toBe(2);
    run(340);
    expect(flat(sequencer.getState()).barsLeft).toBe(1);
    // The next bar line is a bar of 1333 ms later, and the step lands on it.
    run(1333);
    expect(playback.calls).toEqual(['spider:calm@sequence']);
  });

  it('sets the next step at once when asked, counts its bars from there, and starts over after the last', () => {
    playback.sequences = [
      seq('a', [
        step(4, { spider: 'drop' }),
        step(2, { spider: 'calm' }),
        step(1, { spider: 'low' }),
      ]),
    ];
    sequencer.start('a');
    playback.calls = [];
    sequencer.next();
    expect(playback.calls).toEqual(['spider:calm@sequence']);
    expect(flat(sequencer.getState())).toMatchObject({ step: 1, barsLeft: 2 });
    sequencer.next();
    sequencer.next();
    expect(playback.calls).toEqual([
      'spider:calm@sequence',
      'spider:low@sequence',
      'spider:drop@sequence',
    ]);
    expect(flat(sequencer.getState())).toMatchObject({ step: 0, barsLeft: 4 });
    // The bars go on being counted from the bar lines.
    goTo(1);
    expect(flat(sequencer.getState()).barsLeft).toBe(3);
  });

  it('does nothing for a next when no sequence runs', () => {
    playback.sequences = [seq('a', [step(1, { spider: 'drop' })])];
    sequencer.next();
    expect(playback.calls).toEqual([]);
    expect(states).toEqual([]);
  });

  describe('hold', () => {
    const night = () =>
      seq('a', [
        step(4, { spider: 'drop' }),
        step(4, { spider: 'calm' }),
        step(4, { spider: 'low' }),
      ]);

    it('freezes the sequence where it is, and sets nothing while it holds', () => {
      playback.sequences = [night()];
      sequencer.start('a');
      goTo(1);
      goTo(2);
      expect(flat(sequencer.getState())).toMatchObject({ step: 0, barsLeft: 2, held: false });
      playback.calls = [];
      sequencer.hold(true);
      expect(flat(sequencer.getState())).toMatchObject({
        running: 'a',
        step: 0,
        barsLeft: 2,
        held: true,
      });
      expect(vi.getTimerCount()).toBe(0);
      run(BAR * 20);
      expect(playback.calls).toEqual([]);
      expect(flat(sequencer.getState())).toMatchObject({
        running: 'a',
        step: 0,
        barsLeft: 2,
        held: true,
      });
    });

    it('goes on with the bars the step has left when it is let go, from the next bar line', () => {
      playback.sequences = [night()];
      sequencer.start('a');
      goTo(1);
      goTo(2);
      sequencer.hold(true);
      // Held for a while, half way into a bar when it is let go.
      run(BAR * 10 + BAR / 2);
      playback.calls = [];
      sequencer.hold(false);
      expect(flat(sequencer.getState())).toMatchObject({ step: 0, barsLeft: 2, held: false });
      // The bar that is going on is not counted: the next bar line is the first of the two.
      goBefore(13);
      expect(flat(sequencer.getState()).barsLeft).toBe(2);
      goTo(13);
      expect(flat(sequencer.getState()).barsLeft).toBe(1);
      expect(playback.calls).toEqual([]);
      goTo(14);
      expect(playback.calls).toEqual(['spider:calm@sequence']);
      expect(flat(sequencer.getState())).toMatchObject({ step: 1, barsLeft: 4 });
    });

    it('tells of a hold and of a release, and a second hold of the same kind says nothing', () => {
      playback.sequences = [night()];
      sequencer.start('a');
      states.length = 0;
      sequencer.hold(true);
      sequencer.hold(true);
      sequencer.hold(false);
      sequencer.hold(false);
      expect(states.map((state) => state.held)).toEqual([true, false]);
    });

    it('refuses a hold when no sequence runs, and refuses a next while it holds', () => {
      playback.sequences = [night()];
      expect(() => sequencer.hold(true)).toThrow(PatchError);
      sequencer.start('a');
      sequencer.hold(true);
      playback.calls = [];
      expect(() => sequencer.next()).toThrow(/on hold/);
      expect(playback.calls).toEqual([]);
      sequencer.hold(false);
      sequencer.next();
      expect(playback.calls).toEqual(['spider:calm@sequence']);
    });

    it('lets go of the hold when a sequence is started or stopped', () => {
      playback.sequences = [night(), seq('b', [step(2, { spider: 'other' })])];
      sequencer.start('a');
      sequencer.hold(true);
      sequencer.start('b');
      expect(flat(sequencer.getState())).toMatchObject({ running: 'b', held: false });
      goTo(1);
      expect(flat(sequencer.getState()).barsLeft).toBe(1);
      sequencer.hold(true);
      sequencer.stop();
      expect(flat(sequencer.getState())).toMatchObject({ running: null, held: false });
    });

    it('stays held while the music stops and starts, and counts nothing when it comes back', () => {
      playback.sequences = [night()];
      sequencer.start('a');
      goTo(1);
      sequencer.hold(true);
      stopMusic();
      run(BAR * 3);
      startMusic();
      run(BAR * 5);
      expect(flat(sequencer.getState())).toMatchObject({ step: 0, barsLeft: 3, held: true });
    });
  });

  it('is stopped by a stop and leaves the fixtures as they are', () => {
    playback.sequences = [seq('a', [step(1, { spider: 'drop' }), step(1, { spider: 'calm' })])];
    sequencer.start('a');
    playback.calls = [];
    sequencer.stop();
    expect(flat(sequencer.getState())).toMatchObject({ running: null, step: -1, barsLeft: 0 });
    run(BAR * 10);
    expect(playback.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops the one that runs when another starts, and starts that one at its first step', () => {
    playback.sequences = [
      seq('a', [step(1, { spider: 'drop' }), step(1, { spider: 'calm' })]),
      seq('b', [step(1, { spider: 'drop' }), step(1, { laser: 'z' })]),
    ];
    sequencer.start('a');
    sequencer.start('b');
    playback.calls = [];
    expect(flat(sequencer.getState())).toMatchObject({ running: 'b', step: 0 });
    // The look the first one set is not remembered: b sets its first step for every group.
    sequencer.start('b');
    expect(playback.calls).toEqual(['spider:drop@sequence']);
    playback.calls = [];
    goTo(1);
    expect(playback.calls).toEqual(['laser:z@sequence']);
  });

  it('refuses a sequence that is not there', () => {
    expect(() => sequencer.start('nope')).toThrow(
      new PatchError('there is no sequence called "nope"'),
    );
    expect(() => sequencer.start(3)).toThrow(/say which sequence/);
    expect(flat(sequencer.getState()).running).toBeNull();
  });

  it('waits while the music is stopped, and counts again from the next bar line', () => {
    playback.sequences = [seq('a', [step(2, { spider: 'drop' }), step(2, { spider: 'calm' })])];
    sequencer.start('a');
    playback.calls = [];
    goTo(1);
    expect(flat(sequencer.getState()).barsLeft).toBe(1);
    stopMusic();
    expect(flat(sequencer.getState()).paused).toBe(true);
    goTo(10);
    expect(playback.calls).toEqual([]);
    expect(flat(sequencer.getState())).toMatchObject({ step: 0, barsLeft: 1, paused: true });
    expect(vi.getTimerCount()).toBe(0);
    startMusic();
    expect(flat(sequencer.getState()).paused).toBe(false);
    // The bar that is going on is not counted: the next bar line is.
    run(BAR + 5);
    expect(playback.calls).toEqual(['spider:calm@sequence']);
  });

  it('starts paused when the music is stopped, with the first step set', () => {
    playback.sequences = [seq('a', [step(1, { spider: 'drop' }), step(1, { spider: 'calm' })])];
    stopMusic();
    sequencer.start('a');
    expect(playback.calls).toEqual(['spider:drop@sequence']);
    expect(flat(sequencer.getState()).paused).toBe(true);
    run(BAR * 5);
    expect(playback.calls).toEqual(['spider:drop@sequence']);
  });

  it('does not count a tap that restarts the beat as a bar', () => {
    playback.sequences = [seq('a', [step(3, { spider: 'drop' }), step(1, { spider: 'calm' })])];
    sequencer.start('a');
    run(BAR + 5);
    expect(flat(sequencer.getState()).barsLeft).toBe(2);
    run(BAR / 2);
    tempo.update({ sync: true });
    expect(flat(sequencer.getState()).barsLeft).toBe(2);
    // The next bar line is a bar after the tap.
    run(BAR + 5);
    expect(flat(sequencer.getState()).barsLeft).toBe(1);
  });

  it('counts a stall as two bars at most, and does not run through the steps', () => {
    playback.sequences = [
      seq('a', [
        step(1, { spider: 'one' }),
        step(1, { spider: 'two' }),
        step(1, { spider: 'three' }),
        step(1, { spider: 'four' }),
        step(1, { spider: 'five' }),
      ]),
    ];
    sequencer.start('a');
    playback.calls = [];
    // The clock jumps ten bars at once (a suspended machine).
    vi.setSystemTime(Date.now() + BAR * 10);
    run(BAR);
    expect(playback.calls.length).toBeLessThanOrEqual(3);
  });

  it('says what went wrong with a step, goes on with the groups that did not fail, and tries again at the next step', () => {
    const lines: string[] = [];
    sequencer.close();
    sequencer = new Sequencer({ tempo, playback: playback as never, log: (m) => lines.push(m) });
    playback.sequences = [
      seq('a', [step(1, { spider: 'drop', laser: 'bad' }), step(1, { laser: 'good' })]),
    ];
    playback.refuse.add('laser:bad');
    sequencer.start('a');
    expect(playback.calls).toEqual(['spider:drop@sequence']);
    expect(flat(sequencer.getState()).problem).toBe('laser: cannot set bad');
    expect(lines).toEqual(['sequence "a", step 1: laser: cannot set bad']);
    playback.calls = [];
    goTo(1);
    expect(playback.calls).toEqual(['laser:good@sequence']);
    expect(flat(sequencer.getState()).problem).toBeNull();
  });

  it('stops when the sequence goes out of the show, and clamps when it gets shorter', () => {
    playback.sequences = [seq('a', [step(4, { spider: 'drop' }), step(4, { spider: 'calm' })])];
    sequencer.start('a');
    goTo(4);
    expect(flat(sequencer.getState()).step).toBe(1);
    playback.changed([seq('a', [step(2, { spider: 'drop' })])]);
    expect(flat(sequencer.getState())).toMatchObject({
      running: 'a',
      step: 0,
      steps: 1,
      barsLeft: 2,
    });
    playback.changed([]);
    expect(flat(sequencer.getState()).running).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps no timer when it is closed', () => {
    playback.sequences = [seq('a', [step(1, { spider: 'drop' })])];
    sequencer.start('a');
    sequencer.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('several at once', () => {
    const runIds = () => sequencer.getState().runs.map((run) => run.id);

    beforeEach(() => {
      playback.sequences = [
        seq('begin', [step(4, { spider: 'glow' }), step(4, { spider: 'aurora' })]),
        seq('midden', [step(2, { spider: 'bounce' })]),
        seq('alternate', [step(1, { laser: 'discobal' }), step(1, { laser: 'discobal-big' })]),
        seq('both', [step(1, { spider: 'glow', laser: 'off' })]),
      ];
    });

    it('runs sequences of different groups side by side, each with its own count', () => {
      sequencer.start('begin');
      sequencer.start('alternate');
      expect(runIds()).toEqual(['begin', 'alternate']);
      playback.calls = [];
      goTo(1);
      // The laser steps every bar; the spider holds for four.
      expect(playback.calls).toEqual(['laser:discobal-big@sequence']);
      goTo(2);
      expect(playback.calls).toEqual(['laser:discobal-big@sequence', 'laser:discobal@sequence']);
      const [spider, laser] = sequencer.getState().runs;
      expect(spider).toMatchObject({ id: 'begin', step: 0, barsLeft: 2 });
      expect(laser).toMatchObject({ id: 'alternate', step: 0, barsLeft: 1 });
    });

    it('stops only the sequences that set a group the new one sets too', () => {
      sequencer.start('begin');
      sequencer.start('alternate');
      sequencer.start('midden');
      expect(runIds()).toEqual(['alternate', 'midden']);
      // A sequence that names both groups takes both places.
      sequencer.start('both');
      expect(runIds()).toEqual(['both']);
    });

    it('starts a sequence that runs over again, and no more than once', () => {
      sequencer.start('alternate');
      goTo(1);
      sequencer.start('alternate');
      expect(runIds()).toEqual(['alternate']);
      expect(flat(sequencer.getState())).toMatchObject({ step: 0, barsLeft: 1 });
      expect(vi.getTimerCount()).toBe(1);
    });

    it('holds, skips and stops the one that is named and leaves the others', () => {
      sequencer.start('begin');
      sequencer.start('alternate');
      sequencer.hold(true, 'begin');
      expect(sequencer.getState().runs.map((run) => run.held)).toEqual([true, false]);
      goTo(1);
      expect(sequencer.getState().runs[0]?.barsLeft).toBe(4);
      expect(sequencer.getState().runs[1]?.step).toBe(1);
      expect(() => sequencer.next('begin')).toThrow(/on hold/);
      sequencer.hold(false, 'begin');
      sequencer.next('begin');
      expect(sequencer.getState().runs[0]).toMatchObject({ step: 1, held: false });
      sequencer.stop('alternate');
      expect(runIds()).toEqual(['begin']);
    });

    it('needs a name for hold, next and stop-one when more than one runs, and not when one does', () => {
      sequencer.start('begin');
      sequencer.hold(true);
      expect(sequencer.getState().runs[0]?.held).toBe(true);
      sequencer.hold(false);
      sequencer.start('alternate');
      expect(() => sequencer.hold(true)).toThrow(/say which one/);
      expect(() => sequencer.next()).toThrow(/say which one/);
      expect(() => sequencer.hold(true, 'midden')).toThrow(/does not run/);
      // A stop without a name stops them all.
      sequencer.stop();
      expect(runIds()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('waits for the music in every sequence, and goes on in all of them', () => {
      sequencer.start('begin');
      sequencer.start('alternate');
      stopMusic();
      expect(sequencer.getState().runs.every((run) => run.paused)).toBe(true);
      startMusic();
      expect(sequencer.getState().runs.some((run) => run.paused)).toBe(false);
    });

    it('stops the later one when the file makes two sequences set the same group', () => {
      sequencer.start('begin');
      sequencer.start('alternate');
      playback.changed([
        seq('begin', [step(4, { spider: 'glow' })]),
        seq('alternate', [step(1, { laser: 'discobal', spider: 'glow' })]),
      ]);
      expect(runIds()).toEqual(['begin']);
      expect(vi.getTimerCount()).toBe(1);
    });
  });
});
