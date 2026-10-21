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

const step = (bars: number, looks: Record<string, string>) => ({ bars, looks });
const seq = (id: string, steps: Sequence['steps']): Sequence => ({ id, label: id, steps });

describe('Sequencer', () => {
  const BAR = 2000; // 120 bpm: a beat is 500 ms, a bar is four of them
  let tempo: Tempo;
  let playback: FakePlayback;
  let sequencer: Sequencer;
  let states: SequenceState[];
  /** When the bar lines are: 0 is the origin of the beat count. */
  let origin: number;

  const run = (ms: number) => vi.advanceTimersByTime(ms);
  /** Moves to just past a bar line, counted in bars from the origin of the beat. */
  const goTo = (bars: number) => run(origin + bars * BAR + 5 - Date.now());
  /** Moves to just before a bar line. */
  const goBefore = (bars: number) => run(origin + bars * BAR - 5 - Date.now());
  const stopMusic = () => {
    tempo.update({ source: 'audio' });
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
    sequencer.on('sequence', (state: SequenceState) => states.push(state));
  });

  afterEach(() => {
    sequencer.close();
    vi.useRealTimers();
  });

  it('is stopped until it is started, and never starts by itself', () => {
    playback.sequences = [seq('a', [step(1, { spider: 'drop' })])];
    run(60_000);
    expect(sequencer.getState()).toEqual({
      running: null,
      step: -1,
      steps: 0,
      barsLeft: 0,
      paused: false,
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
    expect(sequencer.getState()).toEqual({
      running: 'night',
      step: 0,
      steps: 2,
      barsLeft: 4,
      paused: false,
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
    expect(sequencer.getState().barsLeft).toBe(1);
    goBefore(2);
    expect(playback.calls).toEqual([]);
    goTo(2);
    // Two bar lines have gone by since the start: the first step is done, on the second one.
    expect(playback.calls).toEqual(['spider:calm@sequence']);
    expect(sequencer.getState()).toMatchObject({ step: 1, barsLeft: 2 });
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
    expect(sequencer.getState().step).toBe(0);
    goTo(4);
    expect(playback.calls).toEqual(['spider:calm@sequence']);
  });

  it('sets nothing again when a step names the look that is set already', () => {
    playback.sequences = [seq('a', [step(1, { spider: 'drop' }), step(1, { spider: 'drop' })])];
    sequencer.start('a');
    playback.calls = [];
    goTo(5);
    expect(playback.calls).toEqual([]);
    expect(sequencer.getState().step).toBeGreaterThanOrEqual(0);
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
    expect(sequencer.getState().barsLeft).toBe(2);
    run(340);
    expect(sequencer.getState().barsLeft).toBe(1);
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
    expect(sequencer.getState()).toMatchObject({ step: 1, barsLeft: 2 });
    sequencer.next();
    sequencer.next();
    expect(playback.calls).toEqual([
      'spider:calm@sequence',
      'spider:low@sequence',
      'spider:drop@sequence',
    ]);
    expect(sequencer.getState()).toMatchObject({ step: 0, barsLeft: 4 });
    // The bars go on being counted from the bar lines.
    goTo(1);
    expect(sequencer.getState().barsLeft).toBe(3);
  });

  it('does nothing for a next when no sequence runs', () => {
    playback.sequences = [seq('a', [step(1, { spider: 'drop' })])];
    sequencer.next();
    expect(playback.calls).toEqual([]);
    expect(states).toEqual([]);
  });

  it('is stopped by a stop and leaves the fixtures as they are', () => {
    playback.sequences = [seq('a', [step(1, { spider: 'drop' }), step(1, { spider: 'calm' })])];
    sequencer.start('a');
    playback.calls = [];
    sequencer.stop();
    expect(sequencer.getState()).toMatchObject({ running: null, step: -1, barsLeft: 0 });
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
    expect(sequencer.getState()).toMatchObject({ running: 'b', step: 0 });
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
    expect(sequencer.getState().running).toBeNull();
  });

  it('waits while the music is stopped, and counts again from the next bar line', () => {
    playback.sequences = [seq('a', [step(2, { spider: 'drop' }), step(2, { spider: 'calm' })])];
    sequencer.start('a');
    playback.calls = [];
    goTo(1);
    expect(sequencer.getState().barsLeft).toBe(1);
    stopMusic();
    expect(sequencer.getState().paused).toBe(true);
    goTo(10);
    expect(playback.calls).toEqual([]);
    expect(sequencer.getState()).toMatchObject({ step: 0, barsLeft: 1, paused: true });
    expect(vi.getTimerCount()).toBe(0);
    startMusic();
    expect(sequencer.getState().paused).toBe(false);
    // The bar that is going on is not counted: the next bar line is.
    run(BAR + 5);
    expect(playback.calls).toEqual(['spider:calm@sequence']);
  });

  it('starts paused when the music is stopped, with the first step set', () => {
    playback.sequences = [seq('a', [step(1, { spider: 'drop' }), step(1, { spider: 'calm' })])];
    stopMusic();
    sequencer.start('a');
    expect(playback.calls).toEqual(['spider:drop@sequence']);
    expect(sequencer.getState().paused).toBe(true);
    run(BAR * 5);
    expect(playback.calls).toEqual(['spider:drop@sequence']);
  });

  it('does not count a tap that restarts the beat as a bar', () => {
    playback.sequences = [seq('a', [step(3, { spider: 'drop' }), step(1, { spider: 'calm' })])];
    sequencer.start('a');
    run(BAR + 5);
    expect(sequencer.getState().barsLeft).toBe(2);
    run(BAR / 2);
    tempo.update({ sync: true });
    expect(sequencer.getState().barsLeft).toBe(2);
    // The next bar line is a bar after the tap.
    run(BAR + 5);
    expect(sequencer.getState().barsLeft).toBe(1);
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
    expect(sequencer.getState().problem).toBe('laser: cannot set bad');
    expect(lines).toEqual(['sequence "a", step 1: laser: cannot set bad']);
    playback.calls = [];
    goTo(1);
    expect(playback.calls).toEqual(['laser:good@sequence']);
    expect(sequencer.getState().problem).toBeNull();
  });

  it('stops when the sequence goes out of the show, and clamps when it gets shorter', () => {
    playback.sequences = [seq('a', [step(4, { spider: 'drop' }), step(4, { spider: 'calm' })])];
    sequencer.start('a');
    goTo(4);
    expect(sequencer.getState().step).toBe(1);
    playback.changed([seq('a', [step(2, { spider: 'drop' })])]);
    expect(sequencer.getState()).toMatchObject({ running: 'a', step: 0, steps: 1, barsLeft: 2 });
    playback.changed([]);
    expect(sequencer.getState().running).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps no timer when it is closed', () => {
    playback.sequences = [seq('a', [step(1, { spider: 'drop' })])];
    sequencer.start('a');
    sequencer.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
