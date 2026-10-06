/**
 * The patch: which fixture has which channels of which universe.
 *
 * Every fixture controller sends whole universes, with its own fixture in it and zeros
 * everywhere else. The output keeps only the newest frame per universe, so two
 * controllers on one universe would wipe out each other's fixture. The patch stands in
 * between: a controller claims its channels and gets an output of its own, and the
 * patch copies just those channels into the one frame that goes out.
 */

import { UNIVERSE_SIZE } from '../fixtures/profile.js';

/** Where the frames go. `Lr512BridgeClient` fits. */
export interface UniverseOutput {
  setUniverse(index: number, data: Uint8Array): void;
  /** Changes the most frames per second the output sends, when it has such a limit. */
  setMaxFps?(fps: number): void;
}

interface Claim {
  name: string;
  universe: number;
  /** 1-based first and last channel. */
  first: number;
  last: number;
}

export class PatchConflict extends Error {}

export class Patch {
  private readonly output: UniverseOutput;
  private readonly claims: Claim[] = [];
  private readonly frames = new Map<number, Uint8Array>();

  constructor(output: UniverseOutput) {
    this.output = output;
  }

  /**
   * Gives `footprint` channels from `address` on to one fixture. Throws when they do not
   * fit in a universe, and a `PatchConflict` when another fixture has some of them.
   */
  claim(name: string, universe: number, address: number, footprint: number): UniverseOutput {
    const first = address;
    const last = address + footprint - 1;
    if (!Number.isInteger(universe) || universe < 0) {
      throw new RangeError(`${name}: universe index ${universe} is not a whole number from 0`);
    }
    if (!Number.isInteger(address) || !Number.isInteger(footprint) || footprint < 1) {
      throw new RangeError(`${name}: address ${address} with ${footprint} channels makes no sense`);
    }
    if (first < 1 || last > UNIVERSE_SIZE) {
      throw new RangeError(
        `${name} at address ${address} needs channels ${first}..${last}, outside 1..${UNIVERSE_SIZE}`,
      );
    }
    for (const other of this.claims) {
      if (other.universe === universe && first <= other.last && last >= other.first) {
        throw new PatchConflict(
          `${name} needs channels ${first}..${last}, but ${other.name} has ${other.first}..${other.last} on the same universe. Give one of them another start address.`,
        );
      }
    }
    this.claims.push({ name, universe, first, last });

    return {
      setUniverse: (index, data) => {
        if (index !== universe) {
          throw new RangeError(`${name} is patched on universe ${universe}, not ${index}`);
        }
        if (data.length !== UNIVERSE_SIZE) {
          throw new RangeError(`a universe is ${UNIVERSE_SIZE} bytes, got ${data.length}`);
        }
        let frame = this.frames.get(universe);
        if (!frame) {
          frame = new Uint8Array(UNIVERSE_SIZE);
          this.frames.set(universe, frame);
        }
        frame.set(data.subarray(first - 1, last), first - 1);
        this.output.setUniverse(universe, frame);
      },
    };
  }
}
