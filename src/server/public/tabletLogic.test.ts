import { describe, expect, it } from 'vitest';
import {
  chipMarks,
  laserOpen,
  nextLook,
  partBars,
  partInfo,
  partPlace,
  roomRails,
  spiderLenses,
  splitNumber,
} from './tabletLogic.js';

const sequence = {
  id: 'midden',
  steps: [
    { bars: 24, looks: { spider: 'creeping' } },
    { bars: 24, looks: { spider: 'heartbeat', room: 'welcome' } },
    { bars: 8, looks: { room: 'ember' } },
    { bars: 24, looks: { spider: 'bounce' } },
  ],
};

describe('splitNumber', () => {
  it('takes the number off the front of a name', () => {
    expect(splitNumber('4 Creeping in')).toEqual({ no: '4', name: 'Creeping in' });
    expect(splitNumber('10 The void')).toEqual({ no: '10', name: 'The void' });
  });
  it('leaves a name without one', () => {
    expect(splitNumber('Heartbeat')).toEqual({ no: '', name: 'Heartbeat' });
    expect(splitNumber('2')).toEqual({ no: '', name: '2' });
  });
});

describe('a part of the evening', () => {
  it('says how long its steps are', () => {
    expect(
      partInfo({
        id: 'a',
        steps: [
          { bars: 32, looks: {} },
          { bars: 32, looks: {} },
        ],
      }),
    ).toBe('2 steps · 32 bars each');
    expect(partInfo(sequence)).toBe('4 steps · 8–24 bars');
    expect(partInfo({ id: 'a', steps: [{ bars: 4, looks: {} }] })).toBe('1 step · 4 bars each');
  });

  it('has a segment per step while it does not run', () => {
    expect(partBars(sequence, undefined)).toEqual(['', '', '', '']);
    expect(partBars(sequence, { running: 'techno', step: 0, barsLeft: 3 })).toHaveLength(4);
  });

  it('has a segment per bar of the step that runs, the bars gone and this one marked', () => {
    const bars = partBars(sequence, { running: 'midden', step: 0, barsLeft: 6 });
    expect(bars).toHaveLength(24);
    expect(bars.filter((each) => each === 'done')).toHaveLength(18);
    expect(bars[18]).toBe('now');
    expect(bars.slice(19).every((each) => each === '')).toBe(true);
  });

  it('starts with the first bar as this one and ends with the last', () => {
    expect(partBars(sequence, { running: 'midden', step: 1, barsLeft: 24 })[0]).toBe('now');
    const last = partBars(sequence, { running: 'midden', step: 2, barsLeft: 1 });
    expect(last).toHaveLength(8);
    expect(last[7]).toBe('now');
  });

  it('says where it is', () => {
    expect(partPlace(sequence, { running: 'midden', step: 0, barsLeft: 6 })).toBe(
      '1/4 · bar 19/24',
    );
    expect(partPlace(sequence, { running: 'midden', step: 2, barsLeft: 8 })).toBe('3/4 · bar 1/8');
  });
});

describe('nextLook', () => {
  const state = { running: 'midden', step: 0, barsLeft: 6 };

  it('is the look of the next step, in the bars that are left', () => {
    expect(nextLook(sequence, state, 'spider', 'creeping')).toEqual({ look: 'heartbeat', bars: 6 });
  });

  it('goes past steps that do not name the group, adding their bars', () => {
    expect(nextLook(sequence, { ...state, step: 1, barsLeft: 10 }, 'spider', 'heartbeat')).toEqual({
      look: 'bounce',
      bars: 10 + 8,
    });
  });

  it('goes round to the start after the last step', () => {
    expect(nextLook(sequence, { ...state, step: 3, barsLeft: 2 }, 'spider', 'bounce')).toEqual({
      look: 'creeping',
      bars: 2,
    });
  });

  it('skips a step that sets the look that is on', () => {
    const same = {
      id: 'x',
      steps: [
        { bars: 4, looks: { spider: 'a' } },
        { bars: 4, looks: { spider: 'a' } },
        { bars: 4, looks: { spider: 'b' } },
      ],
    };
    expect(nextLook(same, { running: 'x', step: 0, barsLeft: 3 }, 'spider', 'a')).toEqual({
      look: 'b',
      bars: 3 + 4,
    });
  });

  it('is nothing when the sequence does not run or never changes the group', () => {
    expect(
      nextLook(sequence, { running: null, step: 0, barsLeft: 0 }, 'spider', undefined),
    ).toBeNull();
    expect(nextLook(undefined, state, 'spider', undefined)).toBeNull();
    expect(nextLook(sequence, state, 'laser', undefined)).toBeNull();
  });
});

describe('chipMarks', () => {
  it('says what is on and what is the look own', () => {
    expect(chipMarks('a', 'a', 'b')).toEqual({ on: true, own: false });
    expect(chipMarks('b', 'a', 'b')).toEqual({ on: false, own: true });
    expect(chipMarks('a', 'a', 'a')).toEqual({ on: true, own: true });
    expect(chipMarks('a', undefined, undefined)).toEqual({ on: false, own: false });
  });
});

describe('what the tiles of the rail show', () => {
  const fixture = {
    controls: [
      { name: 'dimmer', channel: 1 },
      { name: 'red1', channel: 2 },
      { name: 'green1', channel: 3 },
      { name: 'blue1', channel: 4 },
      { name: 'white1', channel: 5 },
      { name: 'tilt1', channel: 6 },
      { name: 'red2', channel: 7 },
      { name: 'green2', channel: 8 },
      { name: 'blue2', channel: 9 },
      { name: 'white2', channel: 10 },
    ],
    details: {
      layout: { bars: [[0, 1]], tilt: ['tilt1'], colours: ['red', 'green', 'blue', 'white'] },
    },
  };

  it('gives the colour of each lens as it is seen, and nothing for a dark one', () => {
    const lenses = spiderLenses([255, 255, 0, 0, 0, 0, 0, 0, 0, 0], fixture);
    expect(lenses).toEqual(['rgb(255 0 0)', '']);
    // Half the dimmer, half the light.
    expect(spiderLenses([128, 0, 0, 255, 0, 0, 0, 0, 0, 0], fixture)[0]).toBe('rgb(0 0 128)');
  });

  it('gives nothing without bytes or a layout', () => {
    expect(spiderLenses(undefined, fixture)).toEqual([]);
    expect(spiderLenses([0], {})).toEqual([]);
  });

  it('says whether the laser is open, by the range called off', () => {
    const laser = {
      controls: [
        {
          name: 'mode',
          channel: 1,
          ranges: [
            { from: 0, to: 63, key: 'off' },
            { from: 64, to: 127, key: 'manual' },
          ],
        },
      ],
    };
    expect(laserOpen([0], laser)).toBe(false);
    expect(laserOpen([63], laser)).toBe(false);
    expect(laserOpen([64], laser)).toBe(true);
    expect(laserOpen(undefined, laser)).toBe(false);
  });

  it('says how bright a rail is and in what colour', () => {
    const state = {
      levels: { a: 0.5, b: 1, c: 0 },
      shown: {
        a: { red: 1, green: 0, blue: 0, white: 0 },
        b: { red: 0, green: 1, blue: 0, white: 0 },
      },
      dimmer: 0.5,
      zones: { one: 1, two: 0 },
    };
    const zones = [
      { id: 'one', lamps: ['a', 'b'] },
      { id: 'two', lamps: ['c'] },
      { id: 'three', lamps: ['b'] },
    ];
    expect(roomRails(state, zones)).toEqual([
      { id: 'one', level: 0.5, colour: 'rgb(0 255 0)' },
      { id: 'two', level: 0, colour: '' },
      { id: 'three', level: 0.5, colour: 'rgb(0 255 0)' },
    ]);
    expect(roomRails(undefined, zones)).toEqual([]);
  });
});
