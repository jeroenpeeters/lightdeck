import { describe, expect, it } from 'vitest';
import { ALIEN_LASER_10CH } from '../fixtures/laser.js';
import { parseAssignments, UsageError } from './assign.js';

describe('parseAssignments', () => {
  it('reads raw bytes, keys and places in a range', () => {
    const raw = parseAssignments(ALIEN_LASER_10CH, [
      'mode=manual',
      'rotation=200',
      'size=fixed:0',
      'program=pattern:1',
    ]);
    expect(raw.mode).toBe(95);
    expect(raw.rotation).toBe(200);
    expect(raw.size).toBe(0);
    expect(raw.program).toBeGreaterThanOrEqual(0);
    expect(raw.program).toBeLessThan(5);
  });

  it('says what to type for a mistake', () => {
    expect(() => parseAssignments(ALIEN_LASER_10CH, ['nope=1'])).toThrow(UsageError);
    expect(() => parseAssignments(ALIEN_LASER_10CH, ['mode=300'])).toThrow(/0\.\.255/);
    expect(() => parseAssignments(ALIEN_LASER_10CH, ['mode'])).toThrow(/name=value/);
    expect(() => parseAssignments(ALIEN_LASER_10CH, ['program=pattern:52'])).toThrow(/1\.\.51/);
  });
});
