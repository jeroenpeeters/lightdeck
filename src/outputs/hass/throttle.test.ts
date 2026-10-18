import { describe, expect, it } from 'vitest';
import { Throttle } from './throttle.js';

/** Home Assistant answers at once, unless the test says it does not. */
class Answering extends Throttle<string> {
  override take(now?: number) {
    const taken = super.take(now);
    if (taken) this.done(taken.entity);
    return taken;
  }
}

function make(
  options: {
    minGapMs?: number;
    perSecond?: number;
    maxInFlight?: number;
    answerTimeoutMs?: number;
    answers?: boolean;
  } = {},
) {
  const clock = { t: 0 };
  const { answers = true, ...rest } = options;
  const Kind = answers ? Answering : Throttle<string>;
  const throttle = new Kind({ maxInFlight: 1000, ...rest, now: () => clock.t });
  return { clock, throttle };
}

describe('Throttle', () => {
  it('lets the first command of an entity go at once', () => {
    const { throttle } = make();
    throttle.push('light.a', 'on');
    expect(throttle.take(0)).toEqual({ entity: 'light.a', item: 'on' });
    expect(throttle.take(0)).toBeUndefined();
  });

  it('keeps only the newest command of an entity', () => {
    const { throttle } = make();
    throttle.push('light.a', 'one');
    throttle.push('light.a', 'two');
    throttle.push('light.a', 'three');
    expect(throttle.size).toBe(1);
    expect(throttle.take(0)?.item).toBe('three');
    expect(throttle.take(0)).toBeUndefined();
  });

  it('makes an entity wait the gap after its last command, and sends the newest then', () => {
    const { throttle } = make();
    throttle.push('light.a', 'one');
    throttle.take(0);
    throttle.push('light.a', 'two');
    throttle.push('light.a', 'three');
    expect(throttle.take(500)).toBeUndefined();
    expect(throttle.nextDueAt(500)).toBe(1000);
    expect(throttle.take(999)).toBeUndefined();
    expect(throttle.take(1000)).toEqual({ entity: 'light.a', item: 'three' });
  });

  it('does not make one entity wait for the gap of another', () => {
    const { throttle } = make();
    throttle.push('light.a', 'a1');
    throttle.take(0);
    throttle.push('light.a', 'a2');
    throttle.push('light.b', 'b1');
    expect(throttle.take(10)).toEqual({ entity: 'light.b', item: 'b1' });
    expect(throttle.take(10)).toBeUndefined();
  });

  it('sends at most perSecond commands in any second, and the rest when the window opens', () => {
    const { clock, throttle } = make({ perSecond: 3 });
    for (const name of ['a', 'b', 'c', 'd', 'e']) throttle.push(`light.${name}`, name);
    const sent: string[] = [];
    for (let t = 0; t <= 1000; t += 10) {
      clock.t = t;
      for (let taken = throttle.take(t); taken; taken = throttle.take(t)) {
        sent.push(`${t}:${taken.item}`);
      }
    }
    expect(sent).toEqual(['0:a', '0:b', '0:c', '1000:d', '1000:e']);
  });

  it('counts a window as the last 1000 ms, not as the calendar second', () => {
    const { throttle } = make({ perSecond: 2, minGapMs: 0 });
    throttle.push('light.a', '1');
    throttle.take(0);
    throttle.push('light.a', '2');
    throttle.take(600);
    throttle.push('light.a', '3');
    expect(throttle.take(700)).toBeUndefined();
    expect(throttle.nextDueAt(700)).toBe(1000);
    expect(throttle.take(1000)?.item).toBe('3');
  });

  it('sends who waited longest first', () => {
    const { clock, throttle } = make({ perSecond: 1 });
    throttle.push('light.a', 'first');
    throttle.take(0);
    clock.t = 100;
    throttle.push('light.b', 'second');
    clock.t = 200;
    throttle.push('light.c', 'third');
    // A new command for b does not send it to the back: it has waited since 100.
    clock.t = 300;
    throttle.push('light.b', 'second again');
    expect(throttle.take(1000)).toEqual({ entity: 'light.b', item: 'second again' });
    expect(throttle.take(2000)).toEqual({ entity: 'light.c', item: 'third' });
  });

  it('sends an urgent command before the rest, without waiting for the gap of its entity', () => {
    const { clock, throttle } = make();
    throttle.push('light.a', 'on');
    throttle.take(0);
    clock.t = 10;
    throttle.push('light.b', 'plain');
    throttle.push('light.a', 'blackout', { urgent: true });
    expect(throttle.take(10)).toEqual({ entity: 'light.a', item: 'blackout' });
    expect(throttle.take(10)).toEqual({ entity: 'light.b', item: 'plain' });
  });

  it('still counts an urgent command for the limit in all', () => {
    const { throttle } = make({ perSecond: 2 });
    for (const name of ['a', 'b', 'c']) throttle.push(`light.${name}`, name, { urgent: true });
    expect(throttle.take(0)).toBeDefined();
    expect(throttle.take(0)).toBeDefined();
    expect(throttle.take(0)).toBeUndefined();
    expect(throttle.nextDueAt(0)).toBe(1000);
    expect(throttle.take(1000)?.item).toBe('c');
  });

  it('lets the newest command decide whether it is urgent', () => {
    const { throttle } = make();
    throttle.push('light.a', 'x');
    throttle.take(0);
    throttle.push('light.a', 'dark', { urgent: true });
    throttle.push('light.a', 'back');
    expect(throttle.take(10)).toBeUndefined();
    expect(throttle.nextDueAt(10)).toBe(1000);
  });

  it('reports when the next command can go, and nothing when none waits', () => {
    const { throttle } = make();
    expect(throttle.nextDueAt(0)).toBeUndefined();
    throttle.push('light.a', 'x');
    expect(throttle.nextDueAt(5)).toBeLessThanOrEqual(5);
  });

  it('drops what waits, and remembers what was sent', () => {
    const { throttle } = make();
    throttle.push('light.a', 'x');
    throttle.take(0);
    throttle.push('light.a', 'y');
    throttle.clear();
    expect(throttle.size).toBe(0);
    throttle.push('light.a', 'z');
    expect(throttle.take(100)).toBeUndefined();
    throttle.drop('light.a');
    expect(throttle.size).toBe(0);
  });

  it('refuses limits that make no sense', () => {
    expect(() => new Throttle({ perSecond: 0 })).toThrow(RangeError);
    expect(() => new Throttle({ minGapMs: -1 })).toThrow(RangeError);
  });

  describe('answers', () => {
    it('holds a lamp until its last command is answered, also after the gap', () => {
      const { throttle } = make({ answers: false });
      throttle.push('light.a', 'one');
      expect(throttle.take(0)?.item).toBe('one');
      throttle.push('light.a', 'two');
      expect(throttle.take(5000)).toBeUndefined();
      throttle.done('light.a');
      expect(throttle.take(5000)?.item).toBe('two');
    });

    it('lets no more than maxInFlight commands be on the way, and one more when one is answered', () => {
      const { throttle } = make({ answers: false, maxInFlight: 2, perSecond: 100 });
      for (const name of ['a', 'b', 'c']) throttle.push(`light.${name}`, name);
      expect(throttle.take(0)?.item).toBe('a');
      expect(throttle.take(0)?.item).toBe('b');
      expect(throttle.take(0)).toBeUndefined();
      expect(throttle.inFlightCount).toBe(2);
      throttle.done('light.b');
      expect(throttle.take(0)?.item).toBe('c');
    });

    it('lets the newest win while the mesh is behind: what waited is dropped, not queued', () => {
      const { throttle } = make({ answers: false, maxInFlight: 1, perSecond: 100 });
      throttle.push('light.a', 'a0');
      throttle.take(0);
      for (let i = 1; i <= 50; i++) throttle.push('light.a', `a${i}`);
      throttle.push('light.b', 'b1');
      expect(throttle.take(2000)).toBeUndefined();
      throttle.done('light.a');
      expect(throttle.take(2000)?.item).toBe('a50');
      throttle.done('light.a');
      expect(throttle.take(2000)?.item).toBe('b1');
      expect(throttle.take(2000)).toBeUndefined();
    });

    it('stops counting a command whose answer does not come', () => {
      const { throttle } = make({ answers: false, maxInFlight: 1, answerTimeoutMs: 3000 });
      throttle.push('light.a', 'a1');
      throttle.take(0);
      throttle.push('light.b', 'b1');
      expect(throttle.take(1000)).toBeUndefined();
      expect(throttle.nextDueAt(1000)).toBe(3000);
      expect(throttle.take(3000)?.item).toBe('b1');
      throttle.push('light.a', 'a2');
      throttle.done('light.b');
      expect(throttle.take(3000)?.item).toBe('a2');
    });

    it('sends an urgent command past the unanswered command of its lamp, but not past maxInFlight', () => {
      const { throttle } = make({ answers: false, maxInFlight: 2, perSecond: 100 });
      throttle.push('light.a', 'on');
      throttle.take(0);
      throttle.push('light.a', 'off', { urgent: true });
      expect(throttle.take(1)?.item).toBe('off');
      throttle.push('light.b', 'off', { urgent: true });
      expect(throttle.take(2)).toBeUndefined();
    });

    it('forgets what is on the way when the connection is gone', () => {
      const { throttle } = make({ answers: false, maxInFlight: 1 });
      throttle.push('light.a', 'one');
      throttle.take(0);
      throttle.abandon();
      throttle.push('light.a', 'two');
      expect(throttle.take(1000)?.item).toBe('two');
    });

    it('refuses a limit that is not a whole number of 1 or more', () => {
      expect(() => new Throttle({ maxInFlight: 0 })).toThrow(RangeError);
      expect(() => new Throttle({ answerTimeoutMs: 0 })).toThrow(RangeError);
    });
  });
});
