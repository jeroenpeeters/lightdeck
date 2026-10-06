import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fromInt16, toInt16, WAV_HEADER_BYTES, wavHeader, writeWavFile } from './wav.js';

describe('wav', () => {
  it('turns samples into 16-bit integers and back', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const back = fromInt16(toInt16(samples));
    expect(back.length).toBe(5);
    samples.forEach((sample, i) => {
      expect(back[i]).toBeCloseTo(sample, 3);
    });
  });

  it('clips what is out of range instead of wrapping it', () => {
    const back = fromInt16(toInt16(new Float32Array([2, -2])));
    expect(back[0]).toBeGreaterThan(0.99);
    expect(back[1]).toBeLessThan(-0.99);
  });

  it('drops a last odd byte', () => {
    expect(fromInt16(new Uint8Array([1, 0, 7])).length).toBe(1);
  });

  it('reads from the middle of a larger buffer', () => {
    const outer = Buffer.concat([Buffer.from([9, 9]), toInt16(new Float32Array([0.25]))]);
    const back = fromInt16(outer.subarray(2));
    expect(back[0]).toBeCloseTo(0.25, 3);
  });

  it('writes a header that says how much sound follows and at what rate', () => {
    const header = wavHeader(1000, 16000);
    expect(header.length).toBe(WAV_HEADER_BYTES);
    expect(header.toString('ascii', 0, 4)).toBe('RIFF');
    expect(header.readUInt32LE(4)).toBe(1036);
    expect(header.readUInt32LE(24)).toBe(16000);
    expect(header.readUInt32LE(40)).toBe(1000);
  });

  it('writes a file of the right size', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lightdeck-wav-'));
    try {
      const path = join(dir, 'a.wav');
      writeWavFile(path, new Float32Array(100), 8000);
      expect(readFileSync(path).length).toBe(WAV_HEADER_BYTES + 200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
