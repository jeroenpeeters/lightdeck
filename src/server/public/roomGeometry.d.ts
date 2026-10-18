// The types of roomGeometry.js, for its test. The pages do not read this file.

export const PANO: { width: number; height: number; turn: number };
export const CAMERA_HEIGHT: number;
export const CEILING_HEIGHT: number;
export const ROTATION: number;
export const HORIZON: readonly (readonly [number, number])[];
export interface Corner {
  name: string;
  x: number;
  d: number;
}
export const CORNERS: readonly Corner[];
export function horizonAt(x: number, knots?: readonly (readonly [number, number])[]): number;
export function planPoint(x: number, d: number, rotation?: number): [number, number];
export function roomOutline(corners?: readonly Corner[], rotation?: number): [number, number][];
export function projectToPano(
  point: readonly [number, number, number],
  camera?: readonly [number, number, number],
  rotation?: number,
): { x: number; y: number } | null;
export function insidePolygon(
  x: number,
  z: number,
  polygon: readonly (readonly number[])[],
): boolean;
