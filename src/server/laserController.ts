/**
 * Holds what the laser should be doing and keeps the output in step with it.
 *
 * Every channel of the laser is a byte with ranges, so the state is one raw byte per
 * control. The page and the CLI work out the bytes from the ranges in the profile.
 *
 * A laser of this power must go dark when asked. The `gate` control keeps it closed
 * while it rests at its idle value, and the blackout of the console holds it there
 * whatever the state says. It starts closed, and `darken` closes it for good when
 * lightdeck stops.
 */

import { EventEmitter } from 'node:events';
import {
  encodeFixture,
  type FixtureProfile,
  UNIVERSE_SIZE,
  writeFixture,
} from '../fixtures/profile.js';
import type { UniverseOutput } from '../outputs/patch.js';
import { type FixtureController, PatchError, readObject } from './fixture.js';

export interface LaserState {
  /** Raw bytes by control name. */
  raw: Record<string, number>;
}

export interface LaserPatch {
  raw?: unknown;
}

export interface LaserOptions {
  profile: FixtureProfile;
  /** Name of the control that keeps the laser closed while it is at its idle value. */
  gate: string;
  output: UniverseOutput;
  /** 0-based universe index on the bridge. */
  universe: number;
  /** 1-based DMX start address of the fixture. */
  address: number;
}

export class LaserController extends EventEmitter implements FixtureController {
  readonly profile: FixtureProfile;
  readonly gate: string;
  readonly universe: number;
  readonly address: number;

  private readonly output: UniverseOutput;
  private readonly frame = new Uint8Array(UNIVERSE_SIZE);
  private readonly closed: number;
  private state: LaserState;
  /** The blackout of the console. It is not part of the state of the fixture. */
  private blackout = false;

  constructor(options: LaserOptions) {
    super();
    this.profile = options.profile;
    this.gate = options.gate;
    this.output = options.output;
    this.universe = options.universe;
    this.address = options.address;

    const raw: Record<string, number> = {};
    for (const control of this.profile.controls) {
      if (control.kind !== 'function') {
        throw new Error(`${this.profile.id}: "${control.name}" is not a function control`);
      }
      raw[control.name] = control.idle;
    }
    const closed = raw[this.gate];
    if (closed === undefined) {
      throw new Error(`${this.profile.id} has no control "${this.gate}" to close the laser with`);
    }
    this.closed = closed;
    this.state = { raw };

    // Fails here, at startup, when the fixture does not fit at this address.
    this.send();
  }

  getState(): LaserState {
    return { raw: { ...this.state.raw } };
  }

  /** The control that opens and closes the laser. */
  describe(): Record<string, unknown> {
    return { gate: this.gate };
  }

  /** The fixture's bytes as they are being sent, channel 1 first. */
  getDmx(): number[] {
    return [...encodeFixture(this.profile, this.outputValues())];
  }

  /**
   * Applies a partial change. Nothing is applied when any part of the patch is
   * invalid. `origin` is passed on with the event so a browser can skip its own echo.
   */
  update(change: unknown, origin?: string): void {
    const patch = readObject(change, 'a change of the laser', ['raw']) as LaserPatch;
    const raw = { ...this.state.raw };
    const newRaw = patch.raw === undefined ? {} : readObject(patch.raw, 'raw');
    for (const [name, value] of Object.entries(newRaw)) {
      if (!(name in this.state.raw))
        throw new PatchError(`"${name}" is not a channel of the laser`);
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
        throw new PatchError(`"${name}" must be a whole number between 0 and 255`);
      }
      raw[name] = value;
    }
    this.state = { ...this.state, raw };
    this.push(origin);
  }

  act(name: string): void {
    throw new PatchError(`the laser has nothing called "${name}"`);
  }

  /** Closes the laser, or lets it show again what the state says. */
  setBlackout(blackout: boolean): void {
    if (blackout === this.blackout) return;
    this.blackout = blackout;
    this.push();
  }

  /** Closes the laser and forgets the mode, so that nothing opens it again by itself. */
  darken(): void {
    this.state = { ...this.state, raw: { ...this.state.raw, [this.gate]: this.closed } };
    this.push();
  }

  close(): void {
    this.removeAllListeners();
  }

  private outputValues() {
    const raw = this.blackout ? { ...this.state.raw, [this.gate]: this.closed } : this.state.raw;
    return { raw };
  }

  private send(): void {
    writeFixture(this.frame, this.address, this.profile, this.outputValues());
    this.output.setUniverse(this.universe, this.frame);
  }

  private push(origin?: string): void {
    this.send();
    this.emit('state', this.getState(), origin);
  }
}
