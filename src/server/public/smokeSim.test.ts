import { describe, expect, it } from 'vitest';
import {
  CAPACITY,
  cleanSmoke,
  createCloud,
  emissionRate,
  growth,
  MAX_RATE,
  SMOKE_DEFAULTS,
  SMOKE_RANGES,
  takeEmission,
} from './smokeSim.js';

/** The same numbers every time, so that a test does not depend on luck. */
function seeded(start = 1) {
  let state = start;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const UP: [number, number, number] = [0, 1, 0];
const ORIGIN: [number, number, number] = [0, 1, 0];

describe('cleanSmoke', () => {
  it('starts from the defaults when nothing was kept', () => {
    expect(cleanSmoke(undefined)).toEqual(SMOKE_DEFAULTS);
    expect(cleanSmoke({ output: 'much' })).toEqual(SMOKE_DEFAULTS);
  });

  it('keeps a value in its range and holds one outside it to the end of the range', () => {
    const settings = cleanSmoke({ output: 80, spread: 500, hang: -4, lift: 0.5 });
    expect(settings.output).toBe(80);
    expect(settings.spread).toBe(SMOKE_RANGES.spread.max);
    expect(settings.hang).toBe(SMOKE_RANGES.hang.min);
    expect(settings.lift).toBe(0.5);
  });

  it('has room for the cloud at its highest output and longest hang time', () => {
    // On average a particle lives for the hang time.
    expect(MAX_RATE * SMOKE_RANGES.hang.max).toBeLessThanOrEqual(CAPACITY);
  });
});

describe('takeEmission', () => {
  it('makes the rate over time and carries the fraction', () => {
    let carry = 0;
    let total = 0;
    for (let i = 0; i < 100; i++) {
      const taken = takeEmission(carry, emissionRate(33), 0.016);
      carry = taken.carry;
      total += taken.n;
    }
    // 33 percent of 100 a second, over 1.6 seconds.
    expect(total).toBe(52);
  });

  it('makes nothing at an output of zero', () => {
    expect(takeEmission(0, emissionRate(0), 1).n).toBe(0);
  });
});

describe('emit', () => {
  it('sends the smoke out within the spread, at about the throw speed', () => {
    const cloud = createCloud({ random: seeded() });
    const direction: [number, number, number] = [0, Math.SQRT1_2, Math.SQRT1_2];
    cloud.emit(300, ORIGIN, direction, { throw: 2, spread: 20, hang: 25 });
    expect(cloud.count).toBe(300);
    const widest = Math.cos((20 * Math.PI) / 180);
    for (let i = 0; i < cloud.count; i++) {
      const vx = cloud.velocity[i * 3] ?? 0;
      const vy = cloud.velocity[i * 3 + 1] ?? 0;
      const vz = cloud.velocity[i * 3 + 2] ?? 0;
      const speed = Math.hypot(vx, vy, vz);
      expect(speed).toBeGreaterThanOrEqual(2 * 0.7 - 1e-4);
      expect(speed).toBeLessThanOrEqual(2 * 1.3 + 1e-4);
      const along = (vy * direction[1] + vz * direction[2]) / speed;
      expect(along).toBeGreaterThanOrEqual(widest - 1e-4);
    }
  });

  it('stops at the capacity', () => {
    const cloud = createCloud({ capacity: 10, random: seeded() });
    cloud.emit(50, ORIGIN, UP, { throw: 1, spread: 10, hang: 10 });
    expect(cloud.count).toBe(10);
  });
});

describe('step', () => {
  const settings = { throw: 2, spread: 20, hang: 10 };

  it('lets the smoke die after its hang time', () => {
    const cloud = createCloud({ random: seeded() });
    cloud.emit(200, ORIGIN, UP, settings);
    for (let t = 0; t < 10 * 1.3 + 0.2; t += 0.05) cloud.step(0.05, { lift: 0.3 });
    expect(cloud.count).toBe(0);
  });

  it('keeps the particles it has left whole when others die', () => {
    const cloud = createCloud({ random: seeded(7) });
    cloud.emit(100, ORIGIN, UP, settings);
    for (let t = 0; t < 8; t += 0.05) cloud.step(0.05, { lift: 0.3 });
    expect(cloud.count).toBeGreaterThan(0);
    expect(cloud.count).toBeLessThan(100);
    for (let i = 0; i < cloud.count; i++) {
      expect(cloud.age[i]).toBeLessThan(cloud.life[i] ?? 0);
      expect(Number.isFinite(cloud.position[i * 3 + 1])).toBe(true);
    }
  });

  it('rises more with more lift', () => {
    const height = (lift: number) => {
      const cloud = createCloud({ random: seeded() });
      cloud.emit(100, ORIGIN, [1, 0, 0], settings);
      for (let t = 0; t < 4; t += 0.05) cloud.step(0.05, { lift });
      let sum = 0;
      for (let i = 0; i < cloud.count; i++) sum += cloud.position[i * 3 + 1] ?? 0;
      return sum / cloud.count;
    };
    expect(height(1)).toBeGreaterThan(height(0) + 0.5);
  });

  it('does not go through the floor or the ceiling', () => {
    const cloud = createCloud({ random: seeded() });
    cloud.emit(200, [0, 0.3, 0], [0, -1, 0], { throw: 4, spread: 60, hang: 20 });
    cloud.emit(200, [0, 2, 0], UP, { throw: 4, spread: 60, hang: 20 });
    for (let t = 0; t < 6; t += 0.05) cloud.step(0.05, { lift: 1 }, { floor: 0.02, ceiling: 2.6 });
    for (let i = 0; i < cloud.count; i++) {
      expect(cloud.position[i * 3 + 1]).toBeGreaterThanOrEqual(0.02 - 1e-6);
      expect(cloud.position[i * 3 + 1]).toBeLessThanOrEqual(2.6 + 1e-6);
    }
  });

  it('does not go through a wall', () => {
    const cloud = createCloud({ random: seeded() });
    cloud.emit(200, [0, 1, 0], [1, 0, 0], { throw: 4, spread: 40, hang: 20 });
    const inside = (x: number) => x <= 1.5;
    for (let t = 0; t < 8; t += 0.05) cloud.step(0.05, { lift: 0 }, { contains: inside });
    expect(cloud.count).toBeGreaterThan(0);
    for (let i = 0; i < cloud.count; i++) {
      expect(cloud.position[i * 3]).toBeLessThanOrEqual(1.5 + 1e-6);
    }
  });

  it('slows the jet down within a few metres', () => {
    const cloud = createCloud({ random: seeded() });
    cloud.emit(100, [0, 1, 0], [1, 0, 0], { throw: 2, spread: 5, hang: 60 });
    for (let t = 0; t < 10; t += 0.05) cloud.step(0.05, { lift: 0 });
    let farthest = 0;
    for (let i = 0; i < cloud.count; i++) farthest = Math.max(farthest, cloud.position[i * 3] ?? 0);
    expect(farthest).toBeGreaterThan(1.5);
    expect(farthest).toBeLessThan(5);
  });

  it('clears', () => {
    const cloud = createCloud({ random: seeded() });
    cloud.emit(10, ORIGIN, UP, settings);
    cloud.clear();
    expect(cloud.count).toBe(0);
  });
});

describe('growth', () => {
  it('is 1 at birth and wider later', () => {
    expect(growth(0)).toBe(1);
    expect(growth(1)).toBeGreaterThan(growth(0.5));
  });
});
