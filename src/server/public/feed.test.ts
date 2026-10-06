import { describe, expect, it } from 'vitest';
import {
  explainMicrophone,
  FLOOR_DB,
  feedName,
  MAX_QUEUED,
  measure,
  meterPosition,
  postHeaders,
  processingNote,
  SendQueue,
} from './feed.js';

describe('measure', () => {
  it('reads a full-scale square wave as 0 dBFS and silence as the floor', () => {
    const loud = new Int16Array(100).fill(32767);
    expect(measure(loud).rms).toBeCloseTo(0, 1);
    expect(measure(loud).peak).toBeCloseTo(0, 1);
    expect(measure(new Int16Array(100)).rms).toBe(FLOOR_DB);
    expect(measure(new Int16Array(0)).peak).toBe(FLOOR_DB);
  });

  it('reads half the amplitude as 6 dB down, and a peak above the loudness', () => {
    const half = new Int16Array(100).fill(16384);
    expect(measure(half).rms).toBeCloseTo(-6.02, 1);
    const click = new Int16Array(100);
    click[10] = 32767;
    const { rms, peak } = measure(click);
    expect(peak).toBeCloseTo(0, 1);
    expect(rms).toBeLessThan(peak - 15);
  });
});

describe('meterPosition', () => {
  it('puts 0 dBFS at the end and the low end at the start, and keeps to between', () => {
    expect(meterPosition(0)).toBe(1);
    expect(meterPosition(-60)).toBe(0);
    expect(meterPosition(-30)).toBeCloseTo(0.5);
    expect(meterPosition(-100)).toBe(0);
    expect(meterPosition(6)).toBe(1);
  });
});

describe('SendQueue', () => {
  it('gives blocks in the order they came', () => {
    const queue = new SendQueue<number>();
    queue.push(1);
    queue.push(2);
    expect(queue.length).toBe(2);
    expect(queue.next()).toBe(1);
    expect(queue.next()).toBe(2);
    expect(queue.next()).toBeUndefined();
  });

  it('drops the oldest when more wait than it keeps, and counts them', () => {
    const queue = new SendQueue<number>(3);
    for (let i = 1; i <= 5; i++) queue.push(i);
    expect(queue.dropped).toBe(2);
    expect(queue.next()).toBe(3);
    expect(MAX_QUEUED).toBe(20);
  });
});

describe('what goes to the server', () => {
  it('sends the rate, the position and the feed as headers', () => {
    expect(postHeaders({ rate: 48000, index: 9600, feed: 'a-b' })).toEqual({
      'content-type': 'application/octet-stream',
      'x-rate': '48000',
      'x-index': '9600',
      'x-feed': 'a-b',
    });
  });

  it('names a feed with what the server accepts, and differently each time', () => {
    const a = feedName(1_700_000_000_000, () => 0.123);
    const b = feedName(1_700_000_000_000, () => 0.9);
    expect(a).toMatch(/^[a-z0-9]+-[a-z0-9]{6}$/);
    expect(a).not.toBe(b);
  });
});

describe('explaining a microphone that cannot be had', () => {
  it('says what to do in each case', () => {
    expect(explainMicrophone({ name: 'NotSecure' }, '192.168.1.5:8080')).toMatch(
      /localhost:8080\/listen.*192\.168\.1\.5/,
    );
    expect(explainMicrophone({ name: 'NotAllowedError' })).toMatch(/Allow it/);
    expect(explainMicrophone({ name: 'NotFoundError' })).toMatch(/no microphone/);
    expect(explainMicrophone({ name: 'NotReadableError' })).toMatch(/another program/i);
    expect(explainMicrophone(undefined)).toMatch(/Reload the page/);
  });

  it('notices when the browser kept the processing on', () => {
    expect(
      processingNote({ echoCancellation: false, noiseSuppression: false, autoGainControl: false }),
    ).toBe('');
    expect(processingNote(undefined)).toBe('');
    expect(processingNote({ noiseSuppression: true })).toMatch(/flattens music/);
  });
});
