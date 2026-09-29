import { describe, expect, it } from 'vitest';
import { Patch, PatchConflict } from './patch.js';

class RecordingOutput {
  frames: { index: number; data: Uint8Array }[] = [];
  setUniverse(index: number, data: Uint8Array): void {
    this.frames.push({ index, data: data.slice() });
  }
  get last(): Uint8Array {
    return (this.frames[this.frames.length - 1] as { data: Uint8Array }).data;
  }
}

/** A universe with one value on a run of 1-based channels. */
function universe(first: number, last: number, value: number): Uint8Array {
  const data = new Uint8Array(512);
  data.fill(value, first - 1, last);
  return data;
}

describe('Patch', () => {
  it('puts two fixtures in one universe without one wiping out the other', () => {
    const output = new RecordingOutput();
    const patch = new Patch(output);
    const spider = patch.claim('spider', 0, 1, 43);
    const laser = patch.claim('laser', 0, 44, 10);

    spider.setUniverse(0, universe(1, 43, 200));
    laser.setUniverse(0, universe(44, 53, 100));
    expect([...output.last.subarray(0, 43)].every((b) => b === 200)).toBe(true);
    expect([...output.last.subarray(43, 53)].every((b) => b === 100)).toBe(true);
    expect(output.last[53]).toBe(0);

    spider.setUniverse(0, universe(1, 43, 7));
    expect(output.last[0]).toBe(7);
    expect(output.last[43]).toBe(100);
    expect(output.frames.every((f) => f.index === 0)).toBe(true);
  });

  it('takes only the channels of the fixture from what it is given', () => {
    const output = new RecordingOutput();
    const laser = new Patch(output).claim('laser', 0, 44, 10);
    laser.setUniverse(0, universe(1, 512, 9));
    expect(output.last[42]).toBe(0);
    expect(output.last[43]).toBe(9);
    expect(output.last[52]).toBe(9);
    expect(output.last[53]).toBe(0);
  });

  it('keeps universes apart', () => {
    const output = new RecordingOutput();
    const patch = new Patch(output);
    const a = patch.claim('a', 0, 1, 10);
    const b = patch.claim('b', 1, 1, 10);
    a.setUniverse(0, universe(1, 10, 1));
    b.setUniverse(1, universe(1, 10, 2));
    expect(output.frames.map((f) => [f.index, f.data[0]])).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(() => a.setUniverse(1, universe(1, 10, 1))).toThrow(RangeError);
  });

  it('refuses channels that another fixture has, and says which', () => {
    const patch = new Patch(new RecordingOutput());
    patch.claim('spider', 0, 1, 43);
    expect(() => patch.claim('laser', 0, 43, 10)).toThrow(PatchConflict);
    expect(() => patch.claim('laser', 0, 43, 10)).toThrow(/spider has 1\.\.43/);
    expect(() => patch.claim('laser', 0, 1, 10)).toThrow(PatchConflict);
    expect(() => patch.claim('laser', 1, 1, 10)).not.toThrow();
    expect(() => patch.claim('laser', 0, 44, 10)).not.toThrow();
  });

  it('refuses channels outside the universe', () => {
    const patch = new Patch(new RecordingOutput());
    expect(() => patch.claim('laser', 0, 504, 10)).toThrow(RangeError);
    expect(() => patch.claim('laser', 0, 0, 10)).toThrow(RangeError);
    expect(() => patch.claim('laser', -1, 1, 10)).toThrow(RangeError);
    expect(() => patch.claim('laser', 0, 1.5, 10)).toThrow(RangeError);
    expect(() => patch.claim('laser', 0, 503, 10)).not.toThrow();
  });
});
