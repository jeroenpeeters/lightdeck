/**
 * What every fixture on the console has in common.
 *
 * A fixture has a controller that holds what the fixture should be doing, validates
 * changes and encodes its channels. What the state and a change look like is up to the
 * kind of fixture; the rig, the HTTP side and the shell of the page only pass them on.
 * A new kind of fixture is a controller that fits this interface, an entry in
 * `kinds.ts` and a page in `public/fixtures/`.
 *
 * The same goes for scenes: what a scene keeps of a fixture is up to its controller,
 * which gives it with `snapshot` and takes it back with `recall`.
 */

import type { FixtureProfile } from '../fixtures/profile.js';

/** A change that cannot be applied. The message is for the operator. */
export class PatchError extends Error {}

export interface FixtureController {
  readonly profile: FixtureProfile;
  /** 0-based universe index on the bridge. */
  readonly universe: number;
  /** 1-based DMX start address of the fixture. */
  readonly address: number;

  /** What the fixture is set to, as plain data for the page. */
  getState(): unknown;
  /** The fixture's bytes as they are being sent, channel 1 first. */
  getDmx(): number[];
  /** What the page of this kind of fixture needs to know besides the profile. */
  describe(): Record<string, unknown>;

  /**
   * Applies a partial change, or nothing at all when any part of it is invalid: then it
   * throws a `PatchError`. `origin` is passed on with the event so that a browser can
   * skip its own echo.
   */
  update(patch: unknown, origin?: string): void;
  /** Does something by name, such as `reset`. Throws a `PatchError` for an unknown name. */
  act(name: string, origin?: string): void;

  /**
   * What a scene keeps of this fixture, as plain data that `recall` takes back. What is
   * at rest is left out, so a fixture that is dark gives an empty object.
   */
  snapshot(): Record<string, unknown>;
  /** Throws a `PatchError` when `recall` would refuse this part. Changes nothing. */
  check(part: unknown): void;
  /**
   * Sets the fixture to its part of a scene. A scene is a complete look: what the part
   * does not name goes to rest, and without a part the fixture goes dark.
   */
  recall(part: unknown, origin?: string): void;
  /** The blackout of the console. While on, the fixture is dark and keeps its state. */
  setBlackout(blackout: boolean): void;
  /**
   * Called when lightdeck stops. The bridge holds the last frame, so a fixture that must
   * not stay on without anybody at the controls goes dark here.
   */
  darken(): void;
  close(): void;

  /** After every change. */
  on(event: 'state', listener: (state: unknown, origin?: string) => void): unknown;
  /** While the fixture animates: what is being sent, and the beat it is on. */
  on(event: 'frame', listener: (dmx: number[], beat: number) => void): unknown;
}

/**
 * Reads a change as an object with only the keys that are allowed, so that a mistake in
 * a name is answered instead of silently doing nothing.
 */
export function readObject(
  value: unknown,
  what: string,
  allowed?: readonly string[],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PatchError(`${what} must be an object`);
  }
  if (allowed) {
    const unknown = Object.keys(value).find((key) => !allowed.includes(key));
    if (unknown !== undefined) {
      throw new PatchError(`${what} cannot set "${unknown}", only ${allowed.join(', ')}`);
    }
  }
  return value as Record<string, unknown>;
}
