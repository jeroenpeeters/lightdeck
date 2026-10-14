// The types of spiderPose.js, for its test. The pages do not read this file.

export const MAX_STROBE_HZ: number;

export interface SpiderControl {
  name: string;
  channel: number;
  fineChannel?: number;
}
export interface SpiderLayout {
  bars: readonly (readonly number[])[];
  tilt: readonly string[];
  colours: readonly string[];
  side?: readonly ('back' | 'front')[];
  tiltCurve?: readonly (readonly (readonly [number, number])[])[];
  motorSpeedCurve?: readonly (readonly [number, number])[];
  aim?: readonly number[];
}
export interface Cell {
  r: number;
  g: number;
  b: number;
  w: number;
}
export interface SpiderLook {
  dimmer: number;
  strobe: number;
  program: boolean;
  /** The motor speed, 0..1. */
  motorSpeed: number;
  bars: { tilt: number; cells: Cell[] }[];
}

export function readSpider(
  dmx: ArrayLike<number>,
  controls: readonly SpiderControl[],
  layout: SpiderLayout,
): SpiderLook;
export function lensColour(cell: Cell, dimmer: number): { r: number; g: number; b: number };
export type Curve = readonly (readonly [number, number])[];

export const SAME_TILT: number;
export function curveAt(x: number, curve: Curve | undefined): number;
export function tiltDegrees(tilt: number, curve: Curve | undefined): number;
export function tiltAngle(tilt: number, curve: Curve | undefined): number;
export function setPoint(curve: Curve, tilt: number, degrees: number): [number, number][];
export function replacePoint(
  curve: Curve,
  index: number,
  x: number,
  value: number,
): [number, number][];
export function removePoint(curve: Curve, index: number): [number, number][];
export function cleanCurve(value: unknown): [number, number][] | null;
export function strobeOpen(byte: number, seconds: number): boolean;
export function stepToward(current: number, target: number, maxStep: number): number;
