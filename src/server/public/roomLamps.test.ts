import { describe, expect, it } from 'vitest';
import {
  clampAlong,
  cleanPlacement,
  defaultPlacement,
  LAMP_SPACING,
  lampLook,
  MAX_ALONG,
  RAIL_FIRST_Z,
  RAIL_HEIGHT,
  RAIL_SPACING,
  type RoomDetails,
  railSpan,
  railsOf,
} from './roomLamps.js';

const DETAILS: RoomDetails = {
  lamps: [
    { id: 'a1', label: 'A 1', kind: 'light', zone: 'rail-a' },
    { id: 'a2', label: 'A 2', kind: 'light', zone: 'rail-a' },
    { id: 'a3', label: 'A 3', kind: 'light', zone: 'rail-a' },
    { id: 'b1', label: 'B 1', kind: 'light', zone: 'rail-b' },
    { id: 'tree', label: 'Tree', kind: 'light', zone: null },
    { id: 'fog', label: 'Fog', kind: 'switch', zone: null },
  ],
  zones: [
    { id: 'rail-a', label: 'Rail A', lamps: ['a1', 'a2', 'a3'] },
    { id: 'rail-b', label: 'Rail B', lamps: ['b1'] },
  ],
};

describe('railsOf', () => {
  it('makes a rail of each zone, and one of its own for a light that is in no zone', () => {
    const rails = railsOf(DETAILS);
    expect(rails.map((rail) => [rail.id, rail.lamps.map((lamp) => lamp.id)])).toEqual([
      ['rail-a', ['a1', 'a2', 'a3']],
      ['rail-b', ['b1']],
      ['tree', ['tree']],
    ]);
    expect(rails[2]?.loose).toBe(true);
    expect(rails[0]?.loose).toBeUndefined();
  });

  it('draws no switch', () => {
    const ids = railsOf(DETAILS).flatMap((rail) => rail.lamps.map((lamp) => lamp.id));
    expect(ids).not.toContain('fog');
  });

  it('leaves a zone that has no light out, and has no rails for a room without details', () => {
    expect(
      railsOf({
        lamps: [{ id: 'fog', label: 'Fog', kind: 'switch', zone: null }],
        zones: [{ id: 'z', label: 'Z', lamps: ['fog'] }],
      }),
    ).toEqual([]);
    expect(railsOf(undefined)).toEqual([]);
  });
});

describe('defaultPlacement', () => {
  const rails = railsOf(DETAILS);
  const placement = defaultPlacement(rails);

  it('hangs the rails side by side under the ceiling, in front of the spiders, each along its own axis', () => {
    const z = rails.map((rail) => placement.rails[rail.id]?.p[2] ?? 0);
    expect(z[0]).toBe(RAIL_FIRST_Z);
    expect(z[1]).toBeCloseTo(RAIL_FIRST_Z + RAIL_SPACING);
    expect(z[2]).toBeCloseTo(RAIL_FIRST_Z + 2 * RAIL_SPACING);
    for (const rail of rails) {
      expect(placement.rails[rail.id]?.p[1]).toBe(RAIL_HEIGHT);
      expect(placement.rails[rail.id]?.q).toEqual([0, 0, 0, 1]);
    }
  });

  it('spaces the lamps of a rail evenly around its middle', () => {
    expect(placement.along.a1).toBeCloseTo(-LAMP_SPACING);
    expect(placement.along.a2).toBeCloseTo(0);
    expect(placement.along.a3).toBeCloseTo(LAMP_SPACING);
    expect(placement.along.b1).toBe(0);
  });
});

describe('cleanPlacement', () => {
  const rails = railsOf(DETAILS);
  const defaults = defaultPlacement(rails);

  it('is the defaults when nothing was kept, or what was kept is not an object', () => {
    expect(cleanPlacement(undefined, rails)).toEqual(defaults);
    expect(cleanPlacement(null, rails)).toEqual(defaults);
    expect(cleanPlacement('x', rails)).toEqual(defaults);
  });

  it('keeps a rail where it was put, and a lamp where it was moved along its rail', () => {
    const kept = {
      rails: { 'rail-a': { p: [1, 2, 3], q: [0, 1, 0, 0] } },
      along: { a2: 1.25 },
    };
    const clean = cleanPlacement(kept, rails);
    expect(clean.rails['rail-a']).toEqual({ p: [1, 2, 3], q: [0, 1, 0, 0] });
    expect(clean.along.a2).toBe(1.25);
    // The rest is as before.
    expect(clean.rails['rail-b']).toEqual(defaults.rails['rail-b']);
    expect(clean.along.a1).toBe(defaults.along.a1);
  });

  it('drops what is wrong, and what is for a rail or a lamp that is not there', () => {
    const clean = cleanPlacement(
      {
        rails: {
          'rail-a': { p: [1, 2], q: [0, 0, 0, 1] },
          'rail-b': { p: [1, 'x', 3], q: [0, 0, 0, 1] },
          ghost: { p: [1, 2, 3], q: [0, 0, 0, 1] },
        },
        along: { a1: 'far', a2: Number.NaN, ghost: 3 },
      },
      rails,
    );
    expect(clean).toEqual(defaults);
    expect(Object.keys(clean.rails)).not.toContain('ghost');
    expect(Object.keys(clean.along)).not.toContain('ghost');
  });

  it('keeps a lamp on its rail: no further than a rail goes', () => {
    expect(cleanPlacement({ along: { a3: 100 } }, rails).along.a3).toBe(MAX_ALONG);
    expect(cleanPlacement({ along: { a3: -100 } }, rails).along.a3).toBe(-MAX_ALONG);
    expect(clampAlong(undefined)).toBe(0);
    expect(clampAlong('1')).toBe(0);
    expect(clampAlong(0.4)).toBe(0.4);
  });
});

describe('railSpan', () => {
  it('reaches a little past the first and the last lamp', () => {
    const span = railSpan([-0.6, 0, 0.6]);
    expect(span.from).toBeCloseTo(-0.9);
    expect(span.to).toBeCloseTo(0.9);
    expect(span.length).toBeCloseTo(1.8);
    expect(span.middle).toBeCloseTo(0);
  });

  it('follows the lamps when they are moved off the middle', () => {
    const span = railSpan([1, 2]);
    expect(span.from).toBeCloseTo(0.7);
    expect(span.to).toBeCloseTo(2.3);
    expect(span.middle).toBeCloseTo(1.5);
  });

  it('is never shorter than a short rail, also for one lamp or none', () => {
    expect(railSpan([0]).length).toBeCloseTo(0.8);
    expect(railSpan([]).length).toBeCloseTo(1);
  });
});

describe('lampLook', () => {
  const state = {
    levels: { a1: 0.5, a2: 0, b1: 1 },
    dimmer: 0.8,
    shown: {
      a1: { red: 1, green: 0, blue: 0, white: 0 },
      a2: { red: 1, green: 1, blue: 1, white: 0 },
      b1: { red: 0, green: 0, blue: 0, white: 1 },
    },
  };

  it('is the colour, and the level times the dimmer times the master as brightness', () => {
    expect(lampLook(state, 'a1')).toEqual({ r: 1, g: 0, b: 0, brightness: 0.4 });
    expect(lampLook(state, 'a1', { master: 0.5 }).brightness).toBeCloseTo(0.2);
  });

  it('is dark in a blackout, and when the level is 0', () => {
    expect(lampLook(state, 'a1', { blackout: true }).brightness).toBe(0);
    expect(lampLook(state, 'a2').brightness).toBe(0);
  });

  it('puts the white of an RGBW colour into all three', () => {
    expect(lampLook(state, 'b1')).toEqual({ r: 1, g: 1, b: 1, brightness: 0.8 });
    expect(
      lampLook(
        { levels: { x: 1 }, shown: { x: { red: 0.5, green: 0, blue: 0, white: 0.25 } } },
        'x',
      ),
    ).toEqual({ r: 0.75, g: 0.25, b: 0.25, brightness: 1 });
  });

  it('is dark for a lamp the state does not know, and for no state at all', () => {
    expect(lampLook(state, 'nope').brightness).toBe(0);
    expect(lampLook(undefined, 'a1')).toEqual({ r: 0, g: 0, b: 0, brightness: 0 });
  });

  it('keeps every part between 0 and 1', () => {
    const odd = {
      levels: { x: 7 },
      dimmer: 3,
      shown: { x: { red: 2, green: -1, blue: 0, white: 0 } },
    };
    expect(lampLook(odd, 'x', { master: 9 })).toEqual({ r: 1, g: 0, b: 0, brightness: 1 });
  });

  it('is dark when the zone of the lamp is switched off, and only for the lamps of that zone', () => {
    const switched = { ...state, zones: { 'rail-a': 0, 'rail-b': 1 } };
    expect(lampLook(switched, 'a1', { zone: 'rail-a' }).brightness).toBe(0);
    expect(lampLook(switched, 'b1', { zone: 'rail-b' }).brightness).toBe(0.8);
    // A lamp with no zone, or a zone the state does not know, is not switched.
    expect(lampLook(switched, 'a1').brightness).toBe(0.4);
    expect(lampLook(switched, 'a1', { zone: 'other' }).brightness).toBe(0.4);
    expect(lampLook({ ...state, zones: { z: 0.5 } }, 'a1', { zone: 'z' }).brightness).toBeCloseTo(
      0.2,
    );
  });
});
