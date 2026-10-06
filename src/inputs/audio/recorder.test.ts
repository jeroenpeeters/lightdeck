import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserMicSource } from './browserMic.js';
import { FeedRecorder } from './recorder.js';
import { toInt16, WAV_HEADER_BYTES } from './wav.js';

describe('FeedRecorder', () => {
  let dir: string;
  let mic: BrowserMicSource;
  let recorder: FeedRecorder;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lightdeck-rec-'));
    mic = new BrowserMicSource();
    recorder = new FeedRecorder({
      directory: join(dir, 'out'),
      date: () => new Date(2026, 9, 2, 20, 5, 9),
    });
    recorder.attach(mic);
  });

  afterEach(() => {
    recorder.detach();
    rmSync(dir, { recursive: true, force: true });
  });

  const send = (index: number, count: number, feed = 'f1', rate = 8000) =>
    mic.push({
      bytes: toInt16(new Float32Array(count).fill(0.5)),
      sampleRate: rate,
      index,
      feed,
    });
  const files = () => readdirSync(join(dir, 'out')).sort();

  it('writes a feed to a file named for the time, with the right header', () => {
    send(0, 100);
    send(100, 100);
    recorder.detach();
    expect(files()).toEqual(['20261002-200509-1.wav']);
    const bytes = readFileSync(join(dir, 'out', '20261002-200509-1.wav'));
    expect(bytes.length).toBe(WAV_HEADER_BYTES + 400);
    expect(bytes.readUInt32LE(24)).toBe(8000);
    expect(bytes.readUInt32LE(40)).toBe(400);
    expect(bytes.readInt16LE(WAV_HEADER_BYTES)).toBeGreaterThan(16000);
  });

  it('fills sound that was lost with silence, so a position is a time', () => {
    send(0, 100);
    send(300, 100);
    recorder.detach();
    const bytes = readFileSync(join(dir, 'out', files()[0] ?? ''));
    expect(bytes.readUInt32LE(40)).toBe(800);
    expect(bytes.readInt16LE(WAV_HEADER_BYTES + 150 * 2)).toBe(0);
    expect(bytes.readInt16LE(WAV_HEADER_BYTES + 350 * 2)).toBeGreaterThan(16000);
  });

  it('skips a block that repeats what is written', () => {
    send(0, 100);
    send(50, 100);
    recorder.detach();
    const bytes = readFileSync(join(dir, 'out', files()[0] ?? ''));
    expect(bytes.readUInt32LE(40)).toBe(300);
  });

  it('starts a new file for a new feed', () => {
    send(0, 100, 'f1');
    send(0, 100, 'f2');
    recorder.detach();
    expect(files()).toHaveLength(2);
  });

  it('ends the file at a gap of more than ten seconds instead of writing minutes of silence', () => {
    send(0, 100);
    send(8000 * 11 + 100, 100);
    recorder.detach();
    expect(files()).toHaveLength(2);
  });

  it('keeps the header true while the file grows, so it can be played at once', () => {
    send(0, 4000);
    send(4000, 4000);
    send(8000, 4000);
    const bytes = readFileSync(join(dir, 'out', files()[0] ?? ''));
    // Two seconds of sound at 8 kHz have been written; the header says at least one second.
    expect(bytes.readUInt32LE(40)).toBeGreaterThanOrEqual(16_000);
    expect(bytes.readUInt32LE(40)).toBeLessThanOrEqual(24_000);
  });

  it('ends the file when the sound is lost, and starts a new one when it comes back', () => {
    let clock = 0;
    const lossy = new BrowserMicSource({ now: () => clock });
    const other = new FeedRecorder({
      directory: join(dir, 'lossy'),
      date: () => new Date(2026, 9, 2, 20, 5, 9),
    });
    other.attach(lossy);
    const push = (index: number) =>
      lossy.push({
        bytes: toInt16(new Float32Array(100).fill(0.5)),
        sampleRate: 8000,
        index,
        feed: 'f1',
      });
    push(0);
    clock = 5000;
    lossy.check();
    const first = readFileSync(join(dir, 'lossy', readdirSync(join(dir, 'lossy'))[0] ?? ''));
    expect(first.readUInt32LE(40)).toBe(200);
    push(100);
    other.detach();
    expect(readdirSync(join(dir, 'lossy'))).toHaveLength(2);
  });

  it('stops writing when it is detached', () => {
    send(0, 100);
    recorder.detach();
    send(100, 100);
    expect(files()).toHaveLength(1);
  });
});
