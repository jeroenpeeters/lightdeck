import { describe, expect, it } from 'vitest';
import { changesOnTheWay, merge } from './changes.js';

describe('merge', () => {
  it('lays the newer over the older, one level deep', () => {
    const older = { levels: { dimmer: 1, red1: 0.5 }, effect: { id: 'chase' } };
    const newer = { levels: { dimmer: 0.2 }, raw: { macro: 8 } };
    expect(merge(older, newer)).toEqual({
      levels: { dimmer: 0.2, red1: 0.5 },
      effect: { id: 'chase' },
      raw: { macro: 8 },
    });
    expect(older.levels.dimmer).toBe(1);
  });

  it('takes a colour as a whole, as the server does', () => {
    const older = { effect: { id: 'kick', colourA: { red: 1, green: 0.5, blue: 0, white: 0 } } };
    const newer = { effect: { colourA: { red: 0, green: 0, blue: 1, white: 0 } } };
    expect(merge(older, newer)).toEqual({
      effect: { id: 'kick', colourA: { red: 0, green: 0, blue: 1, white: 0 } },
    });
  });

  it('takes nothing for an empty change', () => {
    expect(merge(null, { raw: { mode: 95 } })).toEqual({ raw: { mode: 95 } });
    expect(merge({ raw: { mode: 95 } }, null)).toEqual({ raw: { mode: 95 } });
  });
});

describe('changesOnTheWay', () => {
  /** What the server says, with what is on its way over it: what the page shows. */
  const shown = (state: Record<string, unknown>, changes: ReturnType<typeof changesOnTheWay>) =>
    merge(state, changes.all());

  it('has nothing on its way at first', () => {
    const changes = changesOnTheWay('tablet');
    expect(changes.all()).toBeNull();
    expect(changes.all({ raw: { mode: 95 } })).toEqual({ raw: { mode: 95 } });
  });

  it('gives every change that leaves a name of its own', () => {
    const changes = changesOnTheWay('tablet');
    const first = changes.leave({ levels: { dimmer: 1 } });
    const second = changes.leave({ levels: { dimmer: 0.9 } });
    expect(first).not.toBe(second);
    expect(changes.mine(first)).toBe(true);
    expect(changes.mine(second)).toBe(true);
  });

  it('knows its own changes from those of another screen', () => {
    const changes = changesOnTheWay('tablet');
    expect(changes.mine('tablet')).toBe(true);
    expect(changes.mine('tablet/3')).toBe(true);
    expect(changes.mine('tablet-2/3')).toBe(false);
    expect(changes.mine('laptop')).toBe(false);
    expect(changes.mine(null)).toBe(false);
    expect(changes.mine(undefined)).toBe(false);
  });

  it('keeps a change that was answered until the stream tells of it', () => {
    const changes = changesOnTheWay('tablet');
    const name = changes.leave({ raw: { mode: 95 } });
    // The master moved on another screen just before the server got the change. That
    // event says the laser is closed, and it comes in after the change was answered.
    expect(shown({ raw: { mode: 0, program: 12 } }, changes)).toEqual({
      raw: { mode: 95, program: 12 },
    });
    changes.heard(name);
    expect(changes.all()).toBeNull();
    // From here on the server is right: another screen closed the laser.
    expect(shown({ raw: { mode: 0, program: 12 } }, changes)).toEqual({
      raw: { mode: 0, program: 12 },
    });
  });

  it('keeps the fader where the finger is while the master fades on another screen', () => {
    const changes = changesOnTheWay('tablet');
    /** The steps of a drag that have left, and what the server has of them: one less. */
    const names: string[] = [];
    const steps = [0.97, 0.95, 0.93, 0.91];
    steps.forEach((dimmer, i) => {
      names.push(changes.leave({ levels: { dimmer } }));
      const told = names[i - 1];
      if (told !== undefined) changes.heard(told);
      // An event of the master, from before the server got this step.
      const server = { levels: { dimmer: steps[i - 1] ?? 1, red1: 1 } };
      expect(shown(server, changes)).toEqual({ levels: { dimmer, red1: 1 } });
    });
    expect(changes.all()).toEqual({ levels: { dimmer: 0.91 } });
  });

  it('puts what waits to leave over what has left', () => {
    const changes = changesOnTheWay('tablet');
    changes.leave({ levels: { dimmer: 0.5, strobe: 0.2 } });
    expect(changes.all({ levels: { dimmer: 0.4 } })).toEqual({
      levels: { dimmer: 0.4, strobe: 0.2 },
    });
  });

  it('takes what left before a change as told of with it', () => {
    const changes = changesOnTheWay('tablet');
    changes.leave({ levels: { dimmer: 0.5 } });
    const second = changes.leave({ levels: { strobe: 0.2 } });
    changes.leave({ raw: { macro: 8 } });
    changes.heard(second);
    expect(changes.all()).toEqual({ raw: { macro: 8 } });
  });

  it('leaves what is on its way alone when the stream tells of something else', () => {
    const changes = changesOnTheWay('tablet');
    changes.leave({ levels: { dimmer: 0.5 } });
    changes.heard(null);
    changes.heard('laptop/1');
    // A press that is asked once, such as a reset, goes under the plain name.
    changes.heard('tablet');
    expect(changes.all()).toEqual({ levels: { dimmer: 0.5 } });
  });

  it('forgets a change that failed or was refused', () => {
    const changes = changesOnTheWay('tablet');
    changes.leave({ levels: { dimmer: 0.5 } });
    const refused = changes.leave({ raw: { macro: 300 } });
    changes.drop(refused);
    expect(changes.all()).toEqual({ levels: { dimmer: 0.5 } });
  });

  it('forgets everything when the stream starts again', () => {
    const changes = changesOnTheWay('tablet');
    const name = changes.leave({ levels: { dimmer: 0.5 } });
    changes.forget();
    expect(changes.all()).toBeNull();
    // Its event may still come, over the new stream.
    changes.heard(name);
    expect(changes.mine(name)).toBe(true);
    expect(changes.leave({ levels: { dimmer: 0.4 } })).not.toBe(name);
  });
});
