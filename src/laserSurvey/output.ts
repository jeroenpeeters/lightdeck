/**
 * The two real ends of a survey: the laser, through the LR512 bridge, and the folder the shots are
 * saved in.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { ALIEN_LASER_10CH } from '../fixtures/laser.js';
import { UNIVERSE_SIZE, writeFixture } from '../fixtures/profile.js';
import { Lr512BridgeClient } from '../outputs/lr512/bridgeClient.js';
import type { LaserOutput, Store } from './run.js';

export interface BridgeOutputOptions {
  /** `ws://192.168.68.101:9010` */
  url: string;
  /** 0-based universe of the bridge. */
  universeIndex: number;
  /** DMX start address of the laser, 1-based. */
  address: number;
  /** How long to wait for the bridge and the LR512. Default 10 s. */
  readyTimeoutMs?: number;
  log?: (message: string) => void;
}

/**
 * Connects to the bridge and waits until the LR512 is open, with the laser closed (all zeros) on
 * the wire. Rejects when that takes too long, so a survey does not start into the dark.
 */
export function connectLaser(options: BridgeOutputOptions): Promise<LaserOutput> {
  const log = options.log ?? (() => {});
  const timeoutMs = options.readyTimeoutMs ?? 10_000;
  const dark = new Uint8Array(UNIVERSE_SIZE);
  let closed = false;

  return new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const client = new Lr512BridgeClient({
      url: options.url,
      log,
      onStatus: (status) => {
        if (settled || status.device !== 'open') return;
        const usable = status.channels[options.universeIndex];
        if (status.channels.length > 0 && usable === 0) {
          settled = true;
          clearTimeout(timer);
          client.stop();
          rejectReady(
            new Error(
              `universe index ${options.universeIndex} has 0 channels on this LR512, so nothing would reach the laser`,
            ),
          );
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolveReady(output);
      },
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.stop();
      rejectReady(
        new Error(
          `the bridge at ${options.url} did not say that the LR512 is open within ${timeoutMs / 1000} s`,
        ),
      );
    }, timeoutMs);

    const output: LaserOutput = {
      set(footprint) {
        if (closed) return;
        const universe = new Uint8Array(UNIVERSE_SIZE);
        universe.set(footprint, options.address - 1);
        client.setUniverse(options.universeIndex, universe);
      },
      async close() {
        if (closed) return;
        closed = true;
        client.setUniverse(options.universeIndex, dark);
        client.flush();
        // Give the frame time to leave the socket and a keep-alive a chance to repeat it.
        await new Promise((r) => setTimeout(r, 600));
        client.flush();
        await new Promise((r) => setTimeout(r, 200));
        client.stop();
      },
    };

    // Check the address now, not at the first shot.
    writeFixture(new Uint8Array(UNIVERSE_SIZE), options.address, ALIEN_LASER_10CH);
    client.setUniverse(options.universeIndex, dark);
    client.start();
  });
}

/** Writes below `root`, a file at a time, so that a stopped run never leaves half a file. */
export function folderStore(root: string): Store {
  const base = resolve(root);
  const pathOf = (file: string): string => {
    const full = resolve(join(base, file));
    if (full !== base && !full.startsWith(base + sep))
      throw new Error(`${file} is outside ${root}`);
    return full;
  };
  return {
    exists: (file) => existsSync(pathOf(file)),
    write(file, data) {
      const full = pathOf(file);
      mkdirSync(dirname(full), { recursive: true });
      const temporary = `${full}.part`;
      writeFileSync(temporary, data);
      renameSync(temporary, full);
    },
  };
}
