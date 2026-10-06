/**
 * Writes what a source hears to WAV files, one per feed, so that the sound of the real
 * room can be played back and the tracker tuned on it. Sound that was lost on the way is
 * written as silence, so that a position in the file is a time in the room.
 *
 * It is off unless lightdeck is started with `--audio-record <directory>`. Nothing else
 * in lightdeck keeps sound.
 */

import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { AudioBlock, AudioSource, SourceStatus } from './source.js';
import { toInt16, WAV_HEADER_BYTES, wavHeader } from './wav.js';

/** The longest gap that is filled with silence, in seconds. A longer one ends the file. */
const MAX_GAP_SECONDS = 10;
/** How often, in seconds of sound, the header gets the true size, so a file can be played while it grows. */
const HEADER_EVERY_SECONDS = 1;

interface Open {
  fd: number;
  feed: number;
  sampleRate: number;
  /** Samples written so far, which is also where the next block should start. */
  samples: number;
  /** How many samples the header says there are. */
  headed: number;
  path: string;
}

export interface RecorderOptions {
  directory: string;
  /** The wall clock, for the name of a file. Tests pass their own. */
  date?: () => Date;
  log?: (message: string) => void;
}

const two = (n: number) => String(n).padStart(2, '0');

export class FeedRecorder {
  private readonly directory: string;
  private readonly date: () => Date;
  private readonly log: (message: string) => void;
  private current: Open | undefined;
  private source: AudioSource | undefined;
  private files = 0;
  private readonly onBlock = (block: AudioBlock) => this.write(block);
  // Sound that has stopped coming ends the file: a feed that comes back is a new file.
  private readonly onStatus = (status: SourceStatus) => {
    if (status === 'lost') this.finish();
  };

  constructor(options: RecorderOptions) {
    this.directory = options.directory;
    this.date = options.date ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  attach(source: AudioSource): void {
    this.detach();
    mkdirSync(this.directory, { recursive: true });
    this.source = source;
    source.on('block', this.onBlock);
    source.on('status', this.onStatus);
  }

  detach(): void {
    this.source?.off('block', this.onBlock);
    this.source?.off('status', this.onStatus);
    this.source = undefined;
    this.finish();
  }

  /** Writes one block. A new feed, or a gap that is too long, starts a new file. */
  private write(block: AudioBlock): void {
    let open = this.current;
    if (open && (open.feed !== block.feed || open.sampleRate !== block.sampleRate)) {
      this.finish();
      open = undefined;
    }
    if (open && block.index > open.samples + MAX_GAP_SECONDS * open.sampleRate) {
      this.finish();
      open = undefined;
    }
    if (!open) open = this.begin(block);

    if (block.index > open.samples) {
      const gap = block.index - open.samples;
      writeSync(open.fd, toInt16(new Float32Array(gap)));
      open.samples += gap;
    }
    // A block that starts before what is written is a repeat or arrived late: skip the overlap.
    const skip = Math.max(0, open.samples - block.index);
    if (skip >= block.samples.length) return;
    const fresh = skip > 0 ? block.samples.subarray(skip) : block.samples;
    writeSync(open.fd, toInt16(fresh));
    open.samples += fresh.length;
    if (open.samples - open.headed >= HEADER_EVERY_SECONDS * open.sampleRate) this.head(open);
  }

  /** Puts the size so far in the header. */
  private head(open: Open): void {
    writeSync(open.fd, wavHeader(open.samples * 2, open.sampleRate), 0, WAV_HEADER_BYTES, 0);
    open.headed = open.samples;
  }

  private begin(block: AudioBlock): Open {
    const when = this.date();
    const stamp =
      `${when.getFullYear()}${two(when.getMonth() + 1)}${two(when.getDate())}-` +
      `${two(when.getHours())}${two(when.getMinutes())}${two(when.getSeconds())}`;
    this.files += 1;
    const path = join(this.directory, `${stamp}-${this.files}.wav`);
    const fd = openSync(path, 'w');
    writeSync(fd, wavHeader(0, block.sampleRate));
    this.log(`recording the feed to ${path}`);
    const open: Open = {
      fd,
      feed: block.feed,
      sampleRate: block.sampleRate,
      samples: 0,
      headed: 0,
      path,
    };
    this.current = open;
    return open;
  }

  /** Puts the true size in the header and closes the file. */
  private finish(): void {
    const open = this.current;
    if (!open) return;
    this.current = undefined;
    this.head(open);
    closeSync(open.fd);
    this.log(`recorded ${(open.samples / open.sampleRate).toFixed(1)} s to ${open.path}`);
  }
}
