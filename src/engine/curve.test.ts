import { describe, expect, it } from 'vitest';
import { curveAt, curveInverse, curveRange } from './curve.js';

const tilt = [
  [0, 90],
  [0.23, 0],
  [0.45, -90],
] as const;

describe('curveAt', () => {
  it('runs in straight lines between points and holds the ends', () => {
    expect(curveAt(tilt, 0.115)).toBeCloseTo(45, 6);
    expect(curveAt(tilt, -1)).toBe(90);
    expect(curveAt(tilt, 0.9)).toBe(-90);
    expect(curveAt([], 0.5)).toBe(0);
  });
});

describe('curveInverse', () => {
  it('finds the x for a value, on a falling curve too', () => {
    expect(curveInverse(tilt, 45)).toBeCloseTo(0.115, 6);
    expect(curveInverse(tilt, 0)).toBeCloseTo(0.23, 6);
    expect(curveInverse(tilt, -45)).toBeCloseTo(0.34, 6);
    const rising = [
      [0, 30],
      [1, 300],
    ] as const;
    expect(curveInverse(rising, 165)).toBeCloseTo(0.5, 6);
  });

  it('comes back to curveAt', () => {
    for (const degrees of [80, 30, -10, -75]) {
      expect(curveAt(tilt, curveInverse(tilt, degrees) ?? Number.NaN)).toBeCloseTo(degrees, 6);
    }
  });

  it('gives the nearest end for a value the curve does not reach', () => {
    expect(curveInverse(tilt, 200)).toBe(0);
    expect(curveInverse(tilt, -200)).toBe(0.45);
  });

  it('cannot tell on a curve with the same value everywhere, or with one point', () => {
    expect(
      curveInverse(
        [
          [0, 200],
          [1, 200],
        ],
        200,
      ),
    ).toBeUndefined();
    expect(curveInverse([[0.5, 10]], 10)).toBeUndefined();
    expect(curveInverse([], 10)).toBeUndefined();
  });
});

describe('curveRange', () => {
  it('has the smallest and the largest value', () => {
    expect(curveRange(tilt)).toEqual({ min: -90, max: 90 });
    expect(curveRange([])).toBeUndefined();
  });
});
