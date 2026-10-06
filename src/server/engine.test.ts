import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine, readMaxFps } from './engine.js';
import { PatchError } from './fixture.js';
import { Tempo } from './tempo.js';

class FakeFixture extends EventEmitter {
  wants = true;
  renders: number[] = [];
  wantsFrames(): boolean {
    return this.wants;
  }
  render(at: number): void {
    this.renders.push(at);
  }
  /** Says that what it wants may have changed, as a controller does. */
  change(wants: boolean): void {
    this.wants = wants;
    this.emit('wants');
  }
}

describe('Engine', () => {
  let clock: number;
  let tempo: Tempo;
  let engine: Engine;
  let fixture: FakeFixture;
  const origin = () => tempo.timeOfBeat(0);

  /** Moves the clock and the timers forward together, a millisecond at a time. */
  const run = (ms: number) => {
    for (let i = 0; i < ms; i++) {
      clock += 1;
      vi.advanceTimersByTime(1);
    }
  };

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1000;
    tempo = new Tempo({ now: () => clock });
    tempo.update({ bpm: 120, sync: true });
    engine = new Engine({ tempo });
    fixture = new FakeFixture();
    engine.add(fixture);
  });
  afterEach(() => {
    engine.close();
    vi.useRealTimers();
  });

  it('makes frames on a grid with a whole number of points per beat, beats included', () => {
    run(3000);
    // 500 ms per beat and 25 frames per second at most: 12 points per beat.
    const step = 500 / 12;
    expect(fixture.renders.length).toBeGreaterThan(70);
    for (const at of fixture.renders) {
      const point = (at - origin()) / step;
      expect(Math.abs(point - Math.round(point))).toBeLessThan(1e-6);
    }
    // Every beat is made for itself, not for a moment a little after it.
    for (let beat = 1; beat <= 5; beat++) {
      expect(fixture.renders.some((at) => Math.abs(at - (origin() + beat * 500)) < 1e-6)).toBe(
        true,
      );
    }
  });

  it('never makes frames faster than the most frames per second', () => {
    for (const bpm of [60, 90, 126, 150, 170, 200]) {
      const quick = new Tempo({ now: () => clock });
      quick.update({ bpm, sync: true });
      const own = new Engine({ tempo: quick, maxFps: 25 });
      const watched = new FakeFixture();
      own.add(watched);
      run(4000);
      own.close();
      const gaps = watched.renders.slice(1).map((at, i) => at - (watched.renders[i] ?? 0));
      expect(gaps.length).toBeGreaterThan(20);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(40 - 1e-6);
    }
  });

  it('is on the grid when the timers run early or late', () => {
    run(2000);
    const step = 500 / 12;
    // Every frame was made for a point of the grid, none for the moment its timer ran.
    expect(
      fixture.renders.every(
        (at) =>
          Math.abs(((at - origin()) / step) % 1) < 1e-6 ||
          Math.abs((((at - origin()) / step) % 1) - 1) < 1e-6,
      ),
    ).toBe(true);
  });

  it('has no timer while nothing wants frames, and one while something does', () => {
    engine.close();
    const quiet = new FakeFixture();
    quiet.wants = false;
    const own = new Engine({ tempo });
    own.add(quiet);
    expect(vi.getTimerCount()).toBe(0);
    quiet.change(true);
    expect(vi.getTimerCount()).toBe(1);
    run(200);
    expect(quiet.renders.length).toBeGreaterThan(2);
    quiet.change(false);
    expect(vi.getTimerCount()).toBe(0);
    const seen = quiet.renders.length;
    run(500);
    expect(quiet.renders.length).toBe(seen);
    own.close();
  });

  it('makes a frame for the new grid when the tempo changes, and not twice for a point', () => {
    run(1200);
    tempo.update({ bpm: 150 });
    const before = fixture.renders.length;
    run(2000);
    const after = fixture.renders.slice(before);
    // 400 ms per beat at 150 bpm and 25 per second at most: 10 points per beat.
    const step = 400 / 10;
    for (const at of after) {
      const point = (at - origin()) / step;
      // The origin moved with the tempo so as to keep the beat, so the grid is that of the new tempo.
      expect(
        Math.abs((tempo.beatAt(at) * 10) % 1) < 1e-6 ||
          Math.abs(((tempo.beatAt(at) * 10) % 1) - 1) < 1e-6,
      ).toBe(true);
      expect(Number.isFinite(point)).toBe(true);
    }
    const unique = new Set(fixture.renders.map((at) => at.toFixed(4)));
    expect(unique.size).toBe(fixture.renders.length);
  });

  it('follows the beat when it is moved by what is heard', () => {
    tempo.update({ source: 'audio' });
    run(600);
    tempo.follow({ beatAt: clock + 30, snap: true });
    const before = fixture.renders.length;
    run(1500);
    const after = fixture.renders.slice(before);
    expect(after.length).toBeGreaterThan(20);
    for (const at of after) {
      const point = tempo.beatAt(at) * 12;
      expect(Math.abs(point - Math.round(point))).toBeLessThan(1e-6);
    }
  });

  it('makes the latest point and counts the ones it missed when the loop was held up', () => {
    run(600);
    const before = fixture.renders.length;
    // The event loop is held up for a quarter of a second: the clock moves, no timer runs.
    clock += 250;
    vi.advanceTimersByTime(1);
    run(60);
    const made = fixture.renders.slice(before);
    // One frame for the point that is current, not a burst for each point that went by.
    expect(made.length).toBeLessThanOrEqual(3);
    expect(engine.stats.skipped).toBeGreaterThanOrEqual(4);
    expect(engine.stats.late.max).toBeGreaterThan(150);
  });

  it('gives the fixtures one last frame when the music stops, and goes quiet', () => {
    tempo.update({ source: 'audio' });
    const own = new FakeFixture();
    own.wantsFrames = () => tempo.isRunning();
    engine.close();
    const stopping = new Engine({ tempo });
    stopping.add(own);
    run(300);
    const seen = own.renders.length;
    clock += 5;
    tempo.follow({ running: false });
    // Once more, at the moment it stopped, so that the fixture shows what is under the effect.
    expect(own.renders.length).toBe(seen + 1);
    expect(own.renders.at(-1)).toBe(clock);
    expect(vi.getTimerCount()).toBe(0);
    run(500);
    expect(own.renders.length).toBe(seen + 1);
    // And it is back when the music is.
    tempo.follow({ running: true });
    run(300);
    expect(own.renders.length).toBeGreaterThan(seen + 3);
    stopping.close();
  });

  it('makes a frame at once when the tempo brings an effect back, not at the next point', () => {
    tempo.update({ source: 'audio' });
    const own = new FakeFixture();
    own.wantsFrames = () => tempo.isRunning();
    engine.close();
    const resuming = new Engine({ tempo });
    resuming.add(own);
    run(200);
    tempo.follow({ running: false });
    run(300);
    const seen = own.renders.length;
    clock += 3;
    tempo.follow({ running: true });
    expect(own.renders.length).toBe(seen + 1);
    expect(own.renders.at(-1)).toBe(clock);
    resuming.close();
  });

  it('makes a frame at once for a tap, which makes that moment beat one', () => {
    run(220);
    const seen = fixture.renders.length;
    clock += 7;
    tempo.update({ sync: true });
    expect(fixture.renders.length).toBe(seen + 1);
    // Beat 0, exactly: the lights show the downbeat when the finger lands.
    expect(tempo.beatAt(fixture.renders.at(-1) ?? 0)).toBeCloseTo(0, 9);
    // And a new bpm is not a tap: the clock waits for its next point.
    const afterTap = fixture.renders.length;
    tempo.update({ bpm: 130 });
    expect(fixture.renders.length).toBe(afterTap);
  });

  it('changes the grid with the most frames per second', () => {
    engine.setMaxFps(10);
    expect(engine.getMaxFps()).toBe(10);
    const before = fixture.renders.length;
    run(3000);
    const made = fixture.renders.slice(before);
    // 100 ms at the most, so 5 points per beat of 500 ms.
    const gaps = made.slice(1).map((at, i) => at - (made[i] ?? 0));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(100 - 1e-6);
    expect(made.length).toBeLessThanOrEqual(31);
  });

  it('stops for good when it is closed', () => {
    run(200);
    engine.close();
    const seen = fixture.renders.length;
    expect(vi.getTimerCount()).toBe(0);
    run(500);
    expect(fixture.renders.length).toBe(seen);
    tempo.update({ bpm: 130 });
    fixture.change(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forgets a fixture that is taken away', () => {
    run(200);
    engine.remove(fixture);
    const seen = fixture.renders.length;
    run(500);
    expect(fixture.renders.length).toBe(seen);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('goes on when a fixture cannot make its frame, and says so', () => {
    const broken = new FakeFixture();
    broken.render = () => {
      throw new Error('no frame today');
    };
    const told: unknown[] = [];
    engine.close();
    const own = new Engine({ tempo, onError: (error) => told.push(error) });
    own.add(broken);
    own.add(fixture);
    run(1000);
    // The other fixture has its frames, every one, and the clock was not stopped.
    expect(fixture.renders.length).toBeGreaterThan(18);
    expect(told.length).toBe(own.stats.ticks);
    expect(own.stats.errors).toBe(told.length);
    expect(String(told[0])).toContain('no frame today');
    own.close();
  });

  it('counts what it has made', () => {
    run(1000);
    expect(engine.stats.ticks).toBe(fixture.renders.length);
    expect(engine.stats.skipped).toBe(0);
  });

  it('refuses a rate that makes no sense', () => {
    for (const bad of [0, -1, 61, Number.NaN, '25', undefined]) {
      expect(() => engine.setMaxFps(bad)).toThrow(PatchError);
    }
    expect(engine.getMaxFps()).toBe(25);
    expect(() => new Engine({ tempo, maxFps: 0 })).toThrow(PatchError);
    expect(readMaxFps(40)).toBe(40);
  });
});
