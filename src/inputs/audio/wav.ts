/** Mono 16-bit WAV files: for the recording of a feed and for test sound. */

import { writeFileSync } from 'node:fs';

/** The size of the header in front of the samples. */
export const WAV_HEADER_BYTES = 44;

/** Samples between -1 and 1 as 16-bit integers, little-endian, clipped at the ends. */
export function toInt16(samples: Float32Array): Buffer {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clipped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out.writeInt16LE(Math.round(clipped * 32767), i * 2);
  }
  return out;
}

/** 16-bit little-endian integers as samples between -1 and 1. A last odd byte is dropped. */
export function fromInt16(bytes: Uint8Array): Float32Array {
  const count = bytes.length >> 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** The header of a mono 16-bit file with `dataBytes` of samples after it. */
export function wavHeader(dataBytes: number, sampleRate: number): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // size of the fmt chunk
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // bytes per second
  header.writeUInt16LE(2, 32); // bytes per frame
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/** Writes a whole file at once. */
export function writeWavFile(path: string, samples: Float32Array, sampleRate: number): void {
  const data = toInt16(samples);
  writeFileSync(path, Buffer.concat([wavHeader(data.length, sampleRate), data]));
}
