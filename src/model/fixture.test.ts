import { describe, expect, it } from 'vitest';
import { applyLook, blackState, blend, clamp01 } from './fixture.js';

describe('clamp01', () => {
  it('clamps into 0..1 and maps NaN to 0', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(Number.NaN)).toBe(0);
  });
});

describe('applyLook', () => {
  it('overrides only the given attributes and clamps them', () => {
    const s = applyLook(blackState(), { red: 1.5, dimmer: 0.4, kelvin: 2700 });
    expect(s.red).toBe(1);
    expect(s.dimmer).toBe(0.4);
    expect(s.blue).toBe(0);
    expect(s.kelvin).toBe(2700);
  });
});

describe('blend', () => {
  it('interpolates linearly, including kelvin when both sides have it', () => {
    const a = applyLook(blackState(), { dimmer: 0, kelvin: 2000 });
    const b = applyLook(blackState(), { dimmer: 1, kelvin: 4000 });
    const mid = blend(a, b, 0.5);
    expect(mid.dimmer).toBeCloseTo(0.5);
    expect(mid.kelvin).toBeCloseTo(3000);
    expect(blend(a, b, 0)).toEqual(a);
    expect(blend(a, b, 1)).toEqual(b);
  });
});
