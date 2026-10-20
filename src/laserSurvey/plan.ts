/**
 * What the laser survey shoots: lists of shots, each a set of bytes for the laser and whether to
 * take a photo or a clip of it. Pure, so the lists can be checked without a laser or a camera.
 *
 * Why these lists (`docs/laser-simulator-plan.md`): the photos have to settle what the manual
 * leaves open, which is how the 51 patterns lie on channel 2, what each other channel does to the
 * shape and how fast the speed ranges are. So there is the pilot (about fifteen photos and a
 * clip, to see whether the method works), and a sweep of one control through its bytes with
 * everything else held.
 */

import { ALIEN_LASER_10CH } from '../fixtures/laser.js';
import {
  type ByteRange,
  byteForStep,
  byteInRange,
  type FunctionControl,
  findRange,
} from '../fixtures/profile.js';

const profile = ALIEN_LASER_10CH;

export interface Shot {
  /** Path without extension, below the output folder: `pilot/rotation-064`. */
  name: string;
  /** The raw byte for each control that is not at rest, by control name. */
  raw: Record<string, number>;
  /** A clip of this many seconds instead of a photo. */
  seconds?: number;
}

export class PlanError extends Error {}

export function functionControl(name: string): FunctionControl {
  const control = profile.controls.find((c) => c.name === name);
  if (control?.kind !== 'function') throw new PlanError(`the laser has no channel "${name}"`);
  return control;
}

function range(control: FunctionControl, key: string): ByteRange {
  const found = findRange(control, key);
  if (!found) throw new PlanError(`${control.name} has no range "${key}"`);
  return found;
}

/** The byte on channel 2 that chooses pattern `n` (1..51) in manual mode. */
export function patternByte(n: number): number {
  if (!Number.isInteger(n)) throw new PlanError(`the pattern is a whole number, got ${n}`);
  try {
    return byteForStep(range(functionControl('program'), 'pattern'), n);
  } catch (error) {
    if (error instanceof RangeError) throw new PlanError(error.message);
    throw error;
  }
}

/** The mode byte for manual mode. The survey is always in manual mode. */
export function manualMode(): number {
  const mode = functionControl('mode');
  return byteInRange(mode, range(mode, 'manual'));
}

/**
 * What every shot of a run starts from: manual mode, the pattern if one is asked for, and the
 * bytes the operator named. A byte the operator named wins over the pattern.
 */
export function baseBytes(
  assigned: Readonly<Record<string, number>>,
  pattern?: number,
): Record<string, number> {
  const base: Record<string, number> = { mode: manualMode() };
  if (pattern !== undefined) base.program = patternByte(pattern);
  return { ...base, ...assigned };
}

/** `b042`: how a byte appears in a file name, so that the names sort in order. */
export function byteLabel(byte: number): string {
  return `b${String(byte).padStart(3, '0')}`;
}

export interface SweepOptions {
  /** Every this many bytes. Default 8. */
  step?: number;
  /** First byte. Default 0. */
  from?: number;
  /** Last byte. Default 255. */
  to?: number;
}

/** The bytes of a sweep: every `step`th, plus the last, plus both edges of every range. */
export function sweepBytes(control: FunctionControl, options: SweepOptions = {}): number[] {
  const step = options.step ?? 8;
  const from = options.from ?? 0;
  const to = options.to ?? 255;
  if (!Number.isInteger(step) || step < 1) throw new PlanError(`--step is a whole number from 1`);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > 255 || from > to) {
    throw new PlanError(`--from and --to are bytes 0..255 with from not above to`);
  }
  const bytes = new Set<number>([from, to]);
  for (let b = from; b <= to; b += step) bytes.add(b);
  for (const r of control.ranges) {
    for (const edge of [r.from, r.to]) if (edge >= from && edge <= to) bytes.add(edge);
  }
  return [...bytes].sort((a, b) => a - b);
}

/** One control through its bytes, everything else as in `base`. */
export function sweep(
  base: Readonly<Record<string, number>>,
  controlName: string,
  options: SweepOptions = {},
): Shot[] {
  if (controlName === 'mode') throw new PlanError('a sweep leaves the mode in manual');
  const control = functionControl(controlName);
  return sweepBytes(control, options).map((byte) => ({
    name: `sweep-${controlName}/${byteLabel(byte)}`,
    raw: { ...base, [controlName]: byte },
  }));
}

/** The shapes of the pilot: three patterns far apart. */
export const PILOT_SHAPES = [1, 26, 51] as const;

/** The pilot clip: forward spin at this byte, for this long. */
export const PILOT_SPIN = { byte: 160, seconds: 10 } as const;

/**
 * The pilot of `docs/laser-simulator-plan.md`: three shapes, then one pattern (`pattern`, which
 * should be asymmetric, with an obvious top) through rotation, position, size, flip and colour,
 * and a clip of it spinning. `base` has what the operator wants held, such as the middle of the
 * position range; the pilot sets the channel it varies.
 */
export function pilot(base: Readonly<Record<string, number>>, pattern: number): Shot[] {
  const series: Array<[string, number]> = [
    ['rotation', 0],
    ['rotation', 32],
    ['rotation', 64],
    ['rotation', 96],
    ['rotation', 127],
    ['moveH', 0],
    ['moveH', 64],
    ['moveH', 127],
    ['size', 0],
    ['size', 63],
    ['flipH', 0],
    ['flipH', 64],
    // One byte in the single-colour range, one in the mix range.
    ['colour', 20],
    ['colour', 96],
  ];
  const withPattern = { ...base, program: base.program ?? patternByte(pattern) };
  const shots: Shot[] = PILOT_SHAPES.map((n) => ({
    name: `pilot/shape-${String(n).padStart(2, '0')}`,
    raw: { ...base, program: patternByte(n) },
  }));
  for (const [control, byte] of series) {
    functionControl(control);
    shots.push({
      name: `pilot/${control}-${byteLabel(byte)}`,
      raw: { ...withPattern, [control]: byte },
    });
  }
  shots.push({
    name: `pilot/spin-${byteLabel(PILOT_SPIN.byte)}`,
    raw: { ...withPattern, rotation: PILOT_SPIN.byte },
    seconds: PILOT_SPIN.seconds,
  });
  return shots;
}

/** Names that are safe as files below the output folder: no dots, no way out of it. */
export function checkName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*(\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/.test(name)) {
    throw new PlanError(
      `"${name}" is not a usable name: letters, digits, - and _, with / for a folder`,
    );
  }
  return name;
}
