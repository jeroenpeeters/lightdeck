/**
 * Listen to a file the way lightdeck listens to the room, and say what it hears.
 *
 *   pnpm beat-eval <file> [options]
 *
 * The file is decoded by ffmpeg, cut into blocks of 100 ms like a source would give
 * them, and handed to the same `Hearer` that the follower uses. One line is printed per
 * second: the time, what is heard, the tempo it holds, how clearly that tempo stands
 * out (confidence, 0 to 1), and the loudness. It is how the tracker is tuned on real
 * tracks, with no microphone and no fixture.
 */

import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { Hearer } from '../inputs/audio/hearer.js';
import type { Heard, Hearing } from '../inputs/audio/hearing.js';
import {
  type AudioSettings,
  DEFAULT_AUDIO_SETTINGS,
  readAudioSettings,
} from '../inputs/audio/settings.js';
import { PatchError } from '../server/fixture.js';

const USAGE = `usage: pnpm beat-eval <file> [options]

options:
  -t, --tempo <bpm>        the tempo the file is known to have: the report says how far off it was
  -r, --rate <hz>          sample rate to listen at (default 22050)
  -s, --settings <k=v>     a listening setting, such as silenceAfter=4 (can be repeated)
  -h, --help               this text

settings (defaults): ${Object.entries(DEFAULT_AUDIO_SETTINGS)
  .map(([name, value]) => `${name}=${value}`)
  .join(' ')}

example:
  pnpm beat-eval ~/Music/track.flac --tempo 126 --settings bpmMin=100`;

const BLOCK_S = 0.1;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

function numberOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) fail(`--${name} must be a positive number, got "${value}"`);
  return n;
}

function readSettings(pairs: string[]): AudioSettings {
  const patch: Record<string, unknown> = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at < 1) fail(`a setting is written name=value, got "${pair}"`);
    const name = pair.slice(0, at);
    const text = pair.slice(at + 1);
    patch[name] = text !== '' && Number.isFinite(Number(text)) ? Number(text) : text;
  }
  try {
    return readAudioSettings(patch, DEFAULT_AUDIO_SETTINGS);
  } catch (error) {
    if (error instanceof PatchError) fail(error.message);
    throw error;
  }
}

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tempo: { type: 'string', short: 't' },
    rate: { type: 'string', short: 'r' },
    settings: { type: 'string', short: 's', multiple: true },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (options.help) {
  console.log(USAGE);
  process.exit(0);
}
const [file] = positionals;
if (!file || positionals.length > 1) fail('give one file to listen to');
const rate = Math.round(numberOption(options.rate, 'rate') ?? 22050);
const known = numberOption(options.tempo, 'tempo');
const settings = readSettings(options.settings ?? []);

/** Decodes the file to mono samples and gives them to `each` in blocks of 100 ms. */
function decode(path: string, each: (samples: Float32Array, index: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      'ffmpeg',
      ['-v', 'error', '-i', path, '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    const size = Math.round(BLOCK_S * rate);
    let pending = new Float32Array(0);
    let index = 0;
    let rest = Buffer.alloc(0);
    ffmpeg.on('error', (error) => {
      reject(new Error(`cannot run ffmpeg (${error.message}). Is it installed?`));
    });
    ffmpeg.stdout.on('data', (chunk: Buffer) => {
      const bytes = Buffer.concat([rest, chunk]);
      const whole = bytes.length - (bytes.length % 4);
      rest = bytes.subarray(whole);
      const floats = new Float32Array(whole / 4);
      for (let i = 0; i < floats.length; i++) floats[i] = bytes.readFloatLE(i * 4);
      const joined = new Float32Array(pending.length + floats.length);
      joined.set(pending, 0);
      joined.set(floats, pending.length);
      let from = 0;
      for (; from + size <= joined.length; from += size) {
        each(joined.subarray(from, from + size), index);
        index += size;
      }
      pending = joined.slice(from);
    });
    ffmpeg.on('close', (code) => {
      if (pending.length > 0) each(pending, index);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg could not read "${path}" (exit code ${code})`));
    });
  });
}

const hearer = new Hearer(settings);
const hearings: Hearing[] = [];
let printed = -1;

function show(hearing: Hearing): void {
  const second = Math.floor(hearing.at + 1e-6);
  if (second === printed) return;
  printed = second;
  const bpm = hearing.bpm === undefined ? '    -' : hearing.bpm.toFixed(1).padStart(5);
  console.log(
    `${String(second).padStart(5)} s  ${hearing.heard.padEnd(6)} ${bpm} bpm  ` +
      `conf ${hearing.confidence.toFixed(2)}  ${hearing.level.toFixed(0).padStart(4)} dB`,
  );
}

/** The spread of where the beats fall in the bar of the tempo, in milliseconds: how steady they are. */
function phaseSpread(beats: Hearing[], bpm: number): number | undefined {
  const period = 60 / bpm;
  const angles = beats
    .filter((h): h is Hearing & { beatAt: number } => h.beatAt !== undefined)
    .map((h) => ((h.beatAt % period) / period) * 2 * Math.PI);
  if (angles.length < 10) return undefined;
  const x = angles.reduce((sum, a) => sum + Math.cos(a), 0);
  const y = angles.reduce((sum, a) => sum + Math.sin(a), 0);
  const centre = Math.atan2(y, x);
  const off = angles
    .map((a) => Math.abs(Math.atan2(Math.sin(a - centre), Math.cos(a - centre))))
    .sort((a, b) => a - b);
  const median = off[Math.floor(off.length / 2)] ?? 0;
  return (median / (2 * Math.PI)) * period * 1000;
}

try {
  await decode(file, (samples, index) => {
    for (const hearing of hearer.push({ samples, sampleRate: rate, index, feed: 1 })) {
      hearings.push(hearing);
      show(hearing);
    }
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (hearings.length === 0) fail('there was no sound to listen to');
const last = hearings[hearings.length - 1] as Hearing;
const share = (heard: Heard) =>
  `${Math.round((100 * hearings.filter((h) => h.heard === heard).length) / hearings.length)}%`;
console.log(
  `\n${last.at.toFixed(0)} s heard: beat ${share('beat')}, music ${share('music')}, silent ${share('silent')}`,
);
if (last.bpm === undefined) {
  console.log('no tempo was found');
} else {
  const error = known === undefined ? '' : ` (${(last.bpm - known).toFixed(2)} off ${known})`;
  console.log(`final tempo ${last.bpm.toFixed(2)} bpm${error}`);
  const spread = phaseSpread(
    hearings.filter((h) => h.heard === 'beat'),
    known ?? last.bpm,
  );
  if (spread !== undefined) {
    console.log(
      `the beats fall within ${spread.toFixed(0)} ms of each other (median distance from their centre)`,
    );
  }
}
