import { describe, expect, it } from 'vitest';
import { encodeFixture } from '../../fixtures/profile.js';
import { SPIDER_43CH, SPIDER_LAYOUT } from '../../fixtures/spider.js';
import {
  cleanCurve,
  curveAt,
  lensColour,
  MAX_STROBE_HZ,
  readSpider,
  removePoint,
  replacePoint,
  setPoint,
  stepToward,
  strobeOpen,
  tiltAngle,
  tiltDegrees,
} from './spiderPose.js';

const controls = SPIDER_43CH.controls;
const frame = (levels: Record<string, number>, raw: Record<string, number> = {}) =>
  Array.from(encodeFixture(SPIDER_43CH, { levels, raw }));

describe('readSpider', () => {
  it('reads the colour of each LED and the dimmer from the bytes', () => {
    const look = readSpider(frame({ dimmer: 1, red1: 1, blue8: 0.5 }), controls, SPIDER_LAYOUT);
    expect(look.dimmer).toBe(1);
    expect(look.bars).toHaveLength(2);
    expect(look.bars[0]?.cells[3]).toEqual({ r: 1, g: 0, b: 0, w: 0 });
    // The front bar lists its LEDs from left to right, looking at the front: L5 L6 L7 L8.
    expect(look.bars[1]?.cells[3]?.b).toBeCloseTo(0.5, 1);
    expect(look.bars[1]?.cells[3]?.r).toBe(0);
  });

  it('lists the LEDs of each bar from left to right, looking at the front', () => {
    const look = readSpider(
      frame({ red1: 1, green4: 1, blue8: 1, white5: 1 }),
      controls,
      SPIDER_LAYOUT,
    );
    // Back bar: L4 L3 L2 L1. Front bar: L5 L6 L7 L8.
    expect(look.bars[0]?.cells[0]?.g).toBe(1);
    expect(look.bars[0]?.cells[3]?.r).toBe(1);
    expect(look.bars[1]?.cells[0]?.w).toBe(1);
    expect(look.bars[1]?.cells[3]?.b).toBe(1);
  });

  it('reads each bar its own tilt, with the 16 bits of the level', () => {
    const look = readSpider(frame({ tilt1: 0.25, tilt2: 0.75 }), controls, SPIDER_LAYOUT);
    expect(look.bars[0]?.tilt).toBeCloseTo(0.25, 4);
    expect(look.bars[1]?.tilt).toBeCloseTo(0.75, 4);
  });

  it('says when the fixture runs a program of its own', () => {
    expect(readSpider(frame({}), controls, SPIDER_LAYOUT).program).toBe(false);
    expect(readSpider(frame({}, { function: 100 }), controls, SPIDER_LAYOUT).program).toBe(true);
    expect(readSpider(frame({}, { autoMode: 200 }), controls, SPIDER_LAYOUT).program).toBe(true);
  });

  it('reads silence from a short or empty frame', () => {
    const look = readSpider([], controls, SPIDER_LAYOUT);
    expect(look.dimmer).toBe(0);
    expect(look.bars[0]?.tilt).toBe(0);
  });
});

describe('lensColour', () => {
  it('adds the white to every colour and scales by the dimmer', () => {
    expect(lensColour({ r: 1, g: 0, b: 0, w: 0 }, 0.5)).toEqual({ r: 0.5, g: 0, b: 0 });
    expect(lensColour({ r: 0, g: 0, b: 0, w: 0.4 }, 1)).toEqual({ r: 0.4, g: 0.4, b: 0.4 });
    expect(lensColour({ r: 0.8, g: 0, b: 0, w: 0.8 }, 1).r).toBe(1);
  });
});

describe('tiltAngle', () => {
  const [front, back] = SPIDER_LAYOUT.tiltCurve;
  const degrees = (tilt: number, curve: readonly (readonly [number, number])[]) =>
    (tiltAngle(tilt, curve) * 180) / Math.PI;

  it('puts both bars at neutral at tilt 30', () => {
    expect(degrees(0.3, front)).toBeCloseTo(0, 6);
    expect(degrees(0.3, back)).toBeCloseTo(0, 6);
  });

  it('turns the bars opposite ways for the same tilt, and as the calibration says at the ends', () => {
    expect(degrees(0, front)).toBeCloseTo(20, 6);
    expect(degrees(0, back)).toBeCloseTo(-20, 6);
    expect(degrees(0.87, front)).toBeCloseTo(-90, 6);
    expect(degrees(0.87, back)).toBeCloseTo(90, 6);
    expect(degrees(1, front)).toBeCloseTo(-108, 6);
    expect(degrees(1, back)).toBeCloseTo(108, 6);
  });

  it('is not linear: a step of the same size turns a bar more on one side of the neutral than on the other', () => {
    const before = degrees(0.3, front) - degrees(0.2, front);
    const after = degrees(0.5, front) - degrees(0.6, front);
    expect(before).not.toBeCloseTo(after, 0);
  });

  it('turns in a straight line between two points', () => {
    expect(degrees(0.15, front)).toBeCloseTo(10, 6);
    expect(degrees(0.585, front)).toBeCloseTo(-45, 6);
  });

  it('stays at the last point beyond it, and neutral without a curve', () => {
    expect(degrees(1.5, front)).toBeCloseTo(-108, 6);
    expect(tiltAngle(0.5, undefined)).toBe(0);
    expect(tiltAngle(0.5, [])).toBe(0);
  });
});

describe('calibrating', () => {
  const curve: [number, number][] = [
    [0, 90],
    [0.23, 0],
    [0.45, -90],
  ];

  it('gives the angle in degrees for a tilt', () => {
    expect(tiltDegrees(0.115, curve)).toBeCloseTo(45, 6);
    expect(tiltDegrees(0.3, curve)).toBeCloseTo(-28.636, 2);
  });

  it('adds a point in its place in the order', () => {
    const made = setPoint(curve, 0.3, -20);
    expect(made).toEqual([
      [0, 90],
      [0.23, 0],
      [0.3, -20],
      [0.45, -90],
    ]);
    expect(tiltDegrees(0.3, made)).toBe(-20);
    expect(curve).toHaveLength(3);
  });

  it('replaces the point at about the same tilt instead of adding one', () => {
    const made = setPoint(curve, 0.231, 5);
    expect(made).toHaveLength(3);
    expect(made[1]).toEqual([0.231, 5]);
  });

  it('removes a point by its place', () => {
    expect(removePoint(curve, 1)).toEqual([
      [0, 90],
      [0.45, -90],
    ]);
  });

  it('gives a point another place and value, and keeps the order', () => {
    expect(replacePoint(curve, 1, 0.5, -10)).toEqual([
      [0, 90],
      [0.45, -90],
      [0.5, -10],
    ]);
    expect(replacePoint(curve, 1, 0.231, 4)[1]).toEqual([0.231, 4]);
    expect(curve[1]).toEqual([0.23, 0]);
  });

  it('takes a calibration from the storage of the browser only when it is one', () => {
    expect(
      cleanCurve([
        [0.5, 10],
        [0.1, 20],
      ]),
    ).toEqual([
      [0.1, 20],
      [0.5, 10],
    ]);
    expect(cleanCurve([])).toBeNull();
    expect(cleanCurve('nope')).toBeNull();
    expect(cleanCurve([[0.5]])).toBeNull();
    expect(cleanCurve([[2, 10]])).toBeNull();
    expect(cleanCurve([[0.5, Number.NaN]])).toBeNull();
  });
});

describe('strobeOpen', () => {
  it('is always open without a strobe', () => {
    for (const byte of [0, 251, 255]) expect(strobeOpen(byte, 0.37)).toBe(true);
  });

  it('flashes at no more than the limit', () => {
    let changes = 0;
    let last = strobeOpen(250, 0);
    for (let ms = 1; ms < 1000; ms++) {
      const now = strobeOpen(250, ms / 1000);
      if (now !== last) changes++;
      last = now;
    }
    expect(changes).toBeLessThanOrEqual(2 * MAX_STROBE_HZ);
    expect(changes).toBeGreaterThan(0);
  });
});

describe('stepToward', () => {
  it('moves by at most the step, at a constant speed, in either direction', () => {
    expect(stepToward(0, 10, 3)).toBe(3);
    expect(stepToward(10, 0, 3)).toBe(7);
    let value = 0;
    for (let i = 0; i < 3; i++) value = stepToward(value, 10, 3);
    expect(value).toBe(9);
  });

  it('gets there and stops, and never goes past', () => {
    expect(stepToward(9, 10, 3)).toBe(10);
    expect(stepToward(10, 10, 3)).toBe(10);
  });
});

describe('curveAt', () => {
  const speed: [number, number][] = [
    [0, 100],
    [1, 400],
  ];

  it('reads a value between two points on the straight line', () => {
    expect(curveAt(0.5, speed)).toBeCloseTo(250, 6);
    expect(curveAt(0.25, speed)).toBeCloseTo(175, 6);
  });

  it('holds the value of the end points beyond them, and is 0 without a curve', () => {
    expect(curveAt(-1, speed)).toBe(100);
    expect(curveAt(2, speed)).toBe(400);
    expect(curveAt(0.5, undefined)).toBe(0);
  });

  it('reads the motor speed of the frame', () => {
    expect(readSpider(frame({ motorSpeed: 1 }), controls, SPIDER_LAYOUT).motorSpeed).toBe(1);
    expect(readSpider(frame({}), controls, SPIDER_LAYOUT).motorSpeed).toBe(0);
  });
});
