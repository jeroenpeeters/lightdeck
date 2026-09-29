/**
 * DMX fixture profiles: which channel of a fixture does what, and how normalized
 * values become DMX bytes.
 *
 * A profile describes one DMX mode of one fixture type. Channels are 1-based and
 * relative to the fixture; the start address places the fixture in a universe.
 */

import { type Attribute, clamp01, type Look } from '../model/fixture.js';

export const UNIVERSE_SIZE = 512;

/** What a byte range on a channel means, as printed in the fixture manual. */
export interface ByteRange {
  from: number;
  to: number;
  meaning: string;
}

interface ControlBase {
  /** Unique within the profile, for example `red3`. */
  name: string;
  /** 1-based channel within the fixture's footprint. */
  channel: number;
  /** The manual's wording for this channel. */
  label: string;
  /** Links the control to the normalized fixture model. */
  attribute?: Attribute;
  /** 1-based cell (LED, head) this control belongs to, when the fixture has several. */
  cell?: number;
}

/** A continuous value, driven with a normalized level 0..1. */
export interface LevelControl extends ControlBase {
  kind: 'level';
  /** Second channel carrying the low byte, for 16-bit resolution. */
  fineChannel?: number;
}

/** Driven with 0..1: 0 is off, anything above maps linearly onto the active byte range. */
export interface StrobeControl extends ControlBase {
  kind: 'strobe';
  activeFrom: number;
  activeTo: number;
}

/**
 * A mode or trigger channel. It rests at `idle` and only changes when a raw byte
 * is given, so a scene can never switch the fixture into an automatic program or
 * reset it by accident.
 */
export interface FunctionControl extends ControlBase {
  kind: 'function';
  idle: number;
  ranges: readonly ByteRange[];
}

export type Control = LevelControl | StrobeControl | FunctionControl;

export interface FixtureProfile {
  id: string;
  name: string;
  /** Number of DMX channels the fixture occupies in this mode. */
  footprint: number;
  controls: readonly Control[];
}

export interface FixtureValues {
  /** Normalized 0..1 by control name, for `level` and `strobe` controls. */
  levels?: Readonly<Record<string, number>>;
  /**
   * Raw DMX values by control name. Takes precedence over `levels` and is the only
   * way to set a `function` control. 0..255, or 0..65535 for a 16-bit level control.
   */
  raw?: Readonly<Record<string, number>>;
}

/** Validates a profile and returns it frozen. Throws on overlapping or out-of-range channels. */
export function defineProfile(profile: FixtureProfile): FixtureProfile {
  const names = new Set<string>();
  const used = new Map<number, string>();
  const claim = (channel: number, name: string) => {
    if (!Number.isInteger(channel) || channel < 1 || channel > profile.footprint) {
      throw new RangeError(
        `${profile.id}: control "${name}" uses channel ${channel}, outside 1..${profile.footprint}`,
      );
    }
    const owner = used.get(channel);
    if (owner !== undefined) {
      throw new Error(`${profile.id}: channel ${channel} is used by both "${owner}" and "${name}"`);
    }
    used.set(channel, name);
  };
  if (!Number.isInteger(profile.footprint) || profile.footprint < 1) {
    throw new RangeError(`${profile.id}: footprint must be a positive integer`);
  }
  if (profile.footprint > UNIVERSE_SIZE) {
    throw new RangeError(`${profile.id}: footprint ${profile.footprint} exceeds a universe`);
  }
  for (const control of profile.controls) {
    if (names.has(control.name)) {
      throw new Error(`${profile.id}: duplicate control name "${control.name}"`);
    }
    names.add(control.name);
    claim(control.channel, control.name);
    if (control.kind === 'level' && control.fineChannel !== undefined) {
      claim(control.fineChannel, `${control.name} (fine)`);
    }
  }
  return Object.freeze({ ...profile, controls: Object.freeze([...profile.controls]) });
}

export function findControl(profile: FixtureProfile, name: string): Control | undefined {
  return profile.controls.find((c) => c.name === name);
}

function requireControl(profile: FixtureProfile, name: string): Control {
  const control = findControl(profile, name);
  if (!control) throw new Error(`${profile.id}: unknown control "${name}"`);
  return control;
}

function checkRaw(profile: FixtureProfile, control: Control, value: number): number {
  const max = control.kind === 'level' && control.fineChannel !== undefined ? 65535 : 255;
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(
      `${profile.id}: raw value ${value} for "${control.name}" is outside 0..${max}`,
    );
  }
  return value;
}

/** Normalized level to the control's raw value. */
function levelToRaw(control: LevelControl | StrobeControl, level: number): number {
  const v = clamp01(level);
  if (control.kind === 'strobe') {
    if (v <= 0) return 0;
    return control.activeFrom + Math.round((control.activeTo - control.activeFrom) * v);
  }
  return Math.round(v * (control.fineChannel !== undefined ? 65535 : 255));
}

/**
 * Encodes one fixture into `footprint` bytes. Controls that get no value rest at 0,
 * function controls at their idle value. Unknown control names throw, so a typo in
 * a show file is caught instead of silently doing nothing.
 */
export function encodeFixture(profile: FixtureProfile, values: FixtureValues = {}): Uint8Array {
  const levels = values.levels ?? {};
  const raw = values.raw ?? {};
  for (const name of Object.keys(levels)) {
    const control = requireControl(profile, name);
    if (control.kind === 'function') {
      throw new Error(
        `${profile.id}: "${name}" is a function channel, set it with a raw value instead of a level`,
      );
    }
  }
  for (const name of Object.keys(raw)) requireControl(profile, name);

  const out = new Uint8Array(profile.footprint);
  for (const control of profile.controls) {
    const rawValue = raw[control.name];
    const level = levels[control.name];
    let value: number;
    if (rawValue !== undefined) value = checkRaw(profile, control, rawValue);
    else if (control.kind === 'function') value = control.idle;
    else value = level !== undefined ? levelToRaw(control, level) : 0;

    if (control.kind === 'level' && control.fineChannel !== undefined) {
      out[control.channel - 1] = value >> 8;
      out[control.fineChannel - 1] = value & 0xff;
    } else {
      out[control.channel - 1] = value;
    }
  }
  return out;
}

/** Encodes a fixture into a universe at its 1-based DMX start address. */
export function writeFixture(
  universe: Uint8Array,
  startAddress: number,
  profile: FixtureProfile,
  values: FixtureValues = {},
): void {
  if (universe.length !== UNIVERSE_SIZE) {
    throw new RangeError(`a universe is ${UNIVERSE_SIZE} bytes, got ${universe.length}`);
  }
  const last = startAddress + profile.footprint - 1;
  if (!Number.isInteger(startAddress) || startAddress < 1 || last > UNIVERSE_SIZE) {
    throw new RangeError(
      `${profile.id} at address ${startAddress} needs channels ${startAddress}..${last}, outside 1..${UNIVERSE_SIZE}`,
    );
  }
  universe.set(encodeFixture(profile, values), startAddress - 1);
}

/**
 * Maps a normalized look onto a profile's controls. `look` applies to the whole
 * fixture; `cells` optionally overrides it per cell (index 0 is cell 1). Controls
 * without an attribute, such as motor speed, are not touched.
 */
export function levelsFromLook(
  profile: FixtureProfile,
  look: Look,
  cells: ReadonlyArray<Look | undefined> = [],
): Record<string, number> {
  const levels: Record<string, number> = {};
  for (const control of profile.controls) {
    if (control.kind === 'function' || control.attribute === undefined) continue;
    const cellLook = control.cell !== undefined ? cells[control.cell - 1] : undefined;
    const value = cellLook?.[control.attribute] ?? look[control.attribute];
    if (value !== undefined) levels[control.name] = value;
  }
  return levels;
}
