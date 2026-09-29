/**
 * Normalized fixture model shared by every output adapter (DMX and Zigbee).
 *
 * All attributes are 0..1 except `kelvin`, which is absolute. An adapter maps
 * these to its own protocol (DMX channel bytes, HA `light.turn_on` payloads).
 */

export const ATTRIBUTES = [
  'dimmer',
  'red',
  'green',
  'blue',
  'white',
  'pan',
  'tilt',
  'strobe',
] as const;

export type Attribute = (typeof ATTRIBUTES)[number];

/** Partial look: only the attributes a scene wants to set. */
export type Look = Partial<Record<Attribute, number>> & { kelvin?: number };

/** Fully resolved state: every attribute has a value. */
export type FixtureState = Record<Attribute, number> & { kelvin?: number };

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function blackState(): FixtureState {
  return { dimmer: 0, red: 0, green: 0, blue: 0, white: 0, pan: 0, tilt: 0, strobe: 0 };
}

/** Resolve a look on top of a base state, clamping every attribute. */
export function applyLook(base: FixtureState, look: Look): FixtureState {
  const next: FixtureState = { ...base };
  for (const attr of ATTRIBUTES) {
    const v = look[attr];
    if (v !== undefined) next[attr] = clamp01(v);
  }
  if (look.kelvin !== undefined) next.kelvin = look.kelvin;
  return next;
}

/** Linear crossfade between two states; `t` is 0 (all `from`) .. 1 (all `to`). */
export function blend(from: FixtureState, to: FixtureState, t: number): FixtureState {
  const k = clamp01(t);
  const out: FixtureState = { ...from };
  for (const attr of ATTRIBUTES) {
    out[attr] = from[attr] + (to[attr] - from[attr]) * k;
  }
  const fk = from.kelvin;
  const tk = to.kelvin;
  if (fk !== undefined && tk !== undefined) out.kelvin = fk + (tk - fk) * k;
  else if (tk !== undefined) out.kelvin = tk;
  return out;
}
