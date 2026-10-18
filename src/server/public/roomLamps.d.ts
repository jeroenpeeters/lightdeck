// The types of roomLamps.js, for its test. The pages do not read this file.

export const RAIL_HEIGHT: number;
export const RAIL_SPACING: number;
export const RAIL_FIRST_Z: number;
export const LAMP_SPACING: number;
export const MAX_ALONG: number;

export interface RoomLamp {
  id: string;
  label: string;
  kind: 'light' | 'switch';
  zone?: string | null;
}
export interface RoomDetails {
  lamps: readonly RoomLamp[];
  zones: readonly { id: string; label: string; lamps: readonly string[] }[];
}
export interface Rail {
  id: string;
  label: string;
  lamps: RoomLamp[];
  /** True for a light that is in no zone: a rail of its own with that one lamp on it. */
  loose?: boolean;
}
export interface Placement {
  /** By rail: where it hangs, a position and a quaternion. Its axis is its own X. */
  rails: Record<string, { p: number[]; q: number[] }>;
  /** By lamp: how far along its rail it hangs, in metres from the middle. */
  along: Record<string, number>;
}

export function railsOf(details: RoomDetails | undefined): Rail[];
export function defaultPlacement(rails: readonly Rail[]): Placement;
export function cleanPlacement(kept: unknown, rails: readonly Rail[]): Placement;
export function clampAlong(value: unknown): number;
export function railSpan(alongs: readonly number[]): {
  from: number;
  to: number;
  length: number;
  middle: number;
};

export interface RoomState {
  levels?: Record<string, number>;
  dimmer?: number;
  zones?: Record<string, number>;
  shown?: Record<string, { red?: number; green?: number; blue?: number; white?: number }>;
}
export function lampLook(
  state: RoomState | undefined,
  lampId: string,
  options?: { master?: number; blackout?: boolean; zone?: string | null },
): { r: number; g: number; b: number; brightness: number };
