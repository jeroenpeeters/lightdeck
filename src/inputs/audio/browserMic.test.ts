import { beforeEach, describe, expect, it } from 'vitest';
import { PatchError } from '../../server/fixture.js';
import { BrowserMicSource, LOST_AFTER_MS } from './browserMic.js';
import type { AudioBlock, SourceStatus } from './source.js';
import { toInt16 } from './wav.js';

describe('BrowserMicSource', () => {
  let clock: number;
  let mic: BrowserMicSource;
  let blocks: { block: AudioBlock; arrivedAt: number }[];
  let statuses: SourceStatus[];

  const post = (over: Partial<Parameters<BrowserMicSource['push']>[0]> = {}) =>
    mic.push({
      bytes: toInt16(new Float32Array([0, 0.5, -0.5, 0.25])),
      sampleRate: 48_000,
      index: 0,
      feed: 'a1',
      ...over,
    });

  beforeEach(() => {
    clock = 1000;
    mic = new BrowserMicSource({ now: () => clock });
    blocks = [];
    statuses = [];
    mic.on('block', (block: AudioBlock, arrivedAt: number) => blocks.push({ block, arrivedAt }));
    mic.on('status', (status: SourceStatus) => statuses.push(status));
  });

  it('is waiting until sound comes', () => {
    expect(mic.getStatus()).toBe('waiting');
    expect(mic.id).toBe('browser-mic');
  });

  it('turns a post into a block with samples, position and the time it came', () => {
    post({ index: 4800 });
    expect(blocks).toHaveLength(1);
    const { block, arrivedAt } = blocks[0] ?? { block: undefined, arrivedAt: 0 };
    expect(block?.sampleRate).toBe(48_000);
    expect(block?.index).toBe(4800);
    expect(arrivedAt).toBe(1000);
    expect(Array.from(block?.samples ?? [])[1]).toBeCloseTo(0.5, 3);
    expect(mic.getStatus()).toBe('live');
    expect(statuses).toEqual(['live']);
  });

  it('keeps the same feed number while the feed goes on, and a new one for a new feed', () => {
    post({ index: 0 });
    post({ index: 4 });
    post({ index: 0, feed: 'b2' });
    expect(blocks.map((each) => each.block.feed)).toEqual([1, 1, 2]);
  });

  it('starts a new feed when the sample rate changes under the same name', () => {
    post();
    post({ sampleRate: 44_100, index: 4 });
    expect(blocks.map((each) => each.block.feed)).toEqual([1, 2]);
  });

  it('is lost when blocks stop, which is not silence, and live again when they come back', () => {
    post();
    clock += LOST_AFTER_MS - 1;
    mic.check();
    expect(mic.getStatus()).toBe('live');
    clock += 2;
    mic.check();
    expect(mic.getStatus()).toBe('lost');
    post({ index: 4 });
    expect(mic.getStatus()).toBe('live');
    expect(statuses).toEqual(['live', 'lost', 'live']);
  });

  it('is never lost before it was live', () => {
    clock += 60_000;
    mic.check();
    expect(mic.getStatus()).toBe('waiting');
  });

  it('refuses what cannot be sound, and says what is wrong', () => {
    expect(() => post({ sampleRate: 12 })).toThrow(/x-rate/);
    expect(() => post({ sampleRate: 44_100.5 })).toThrow(PatchError);
    expect(() => post({ index: -1 })).toThrow(/x-index/);
    expect(() => post({ index: 1.5 })).toThrow(PatchError);
    expect(() => post({ feed: '' })).toThrow(/x-feed/);
    expect(() => post({ feed: 'a b' })).toThrow(PatchError);
    expect(() => post({ bytes: new Uint8Array(3) })).toThrow(/even/);
    expect(() => post({ bytes: new Uint8Array(0) })).toThrow(PatchError);
    expect(blocks).toHaveLength(0);
    expect(mic.getStatus()).toBe('waiting');
  });

  it('starts and stops its watchdog without keeping the process alive', () => {
    mic.start();
    mic.start();
    mic.stop();
    mic.stop();
  });
});
