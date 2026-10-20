/**
 * Runs a survey: for each shot, sets the laser, waits for the scanner to settle, asks the camera
 * for a photo or a clip, and saves it with the bytes that were sent.
 *
 * Three things matter more than speed:
 * - **The laser is closed at the end, however the run ends.** A mistake, a camera that stops
 *   answering or Ctrl-C all close it (`laser.close()` in a `finally`). The bridge holds the last
 *   frame it got, so a run that just stopped would leave a 500 mW laser burning on the wall.
 * - **A run can be continued.** A shot whose `.json` exists is skipped, so a sweep of 256 photos
 *   that stopped at 140 starts at 141 (`--again` shoots them again).
 * - **A photo is never kept without the bytes of the laser.** The `.json` is written after the
 *   picture, and it is what says the shot is done.
 */

import { ALIEN_LASER_10CH } from '../fixtures/laser.js';
import { encodeFixture } from '../fixtures/profile.js';
import { type Camera, CameraError, type Capture } from './camera.js';
import type { Shot } from './plan.js';

export interface LaserOutput {
  /** Puts the ten bytes of the laser on the wire. */
  set(footprint: Uint8Array): void;
  /** Closes the laser and makes sure that the frame has left. Called once, at the end. */
  close(): Promise<void>;
}

export interface Store {
  exists(file: string): boolean;
  write(file: string, data: Uint8Array | string): void;
}

export interface SurveyOptions {
  laser: LaserOutput;
  camera: Camera;
  store: Store;
  /** How long to wait after the bytes are set, for the scanner to draw the new picture. */
  settleMs: number;
  /** Shoot shots again that are already there. */
  again?: boolean;
  /** Said in each shot's json. */
  context?: Record<string, unknown>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  log?: (message: string) => void;
  /** Checked between shots and while waiting: the run stops at the next one when it is aborted. */
  signal?: AbortSignal;
  /** How often a shot is tried again when the camera does not answer. Default 1. */
  retries?: number;
}

export interface SurveyResult {
  taken: number;
  skipped: number;
  failed: string | null;
  aborted: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What a shot's json says about the bytes: by name, and as the ten channels. */
export function describeBytes(shot: Shot): { raw: Record<string, number>; footprint: number[] } {
  const footprint = encodeFixture(ALIEN_LASER_10CH, { raw: shot.raw });
  return { raw: shot.raw, footprint: [...footprint] };
}

export async function runSurvey(
  shots: readonly Shot[],
  options: SurveyOptions,
): Promise<SurveyResult> {
  const { laser, camera, store, settleMs } = options;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const retries = options.retries ?? 1;
  const result: SurveyResult = { taken: 0, skipped: 0, failed: null, aborted: false };

  try {
    for (const [index, shot] of shots.entries()) {
      if (options.signal?.aborted) {
        result.aborted = true;
        break;
      }
      if (!options.again && store.exists(`${shot.name}.json`)) {
        result.skipped++;
        continue;
      }
      const label = `[${index + 1}/${shots.length}] ${shot.name}`;
      const { raw, footprint } = describeBytes(shot);
      laser.set(Uint8Array.from(footprint));
      await sleep(settleMs);
      if (options.signal?.aborted) {
        result.aborted = true;
        break;
      }

      let capture: Capture | undefined;
      let lastError = '';
      for (let attempt = 0; attempt <= retries && !capture; attempt++) {
        try {
          capture =
            shot.seconds === undefined ? await camera.photo() : await camera.clip(shot.seconds);
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          log(`${label}: ${lastError}${attempt < retries ? ', trying again' : ''}`);
          if (!(error instanceof CameraError)) break;
          await sleep(1000);
        }
      }
      if (!capture) {
        result.failed = `${shot.name}: ${lastError}`;
        break;
      }

      const extension = shot.seconds === undefined ? 'jpg' : 'mp4';
      store.write(`${shot.name}.${extension}`, capture.data);
      store.write(
        `${shot.name}.json`,
        `${JSON.stringify(
          {
            name: shot.name,
            kind: shot.seconds === undefined ? 'photo' : 'clip',
            file: `${shot.name}.${extension}`,
            ...(shot.seconds === undefined ? {} : { seconds: shot.seconds }),
            raw,
            footprint,
            settleMs,
            camera: capture.settings,
            at: now().toISOString(),
            ...options.context,
          },
          null,
          2,
        )}\n`,
      );
      result.taken++;
      log(`${label}: ${bytesText(raw)}`);
    }
  } finally {
    await laser.close();
  }
  return result;
}

function bytesText(raw: Record<string, number>): string {
  return Object.entries(raw)
    .map(([name, byte]) => `${name}=${byte}`)
    .join(' ');
}
