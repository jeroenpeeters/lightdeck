// The types of smokeSim.js, for its test. The pages do not read this file.

export interface SmokeSettings {
  output: number;
  density: number;
  throw: number;
  spread: number;
  angle: number;
  lift: number;
  hang: number;
}
export interface SmokeRange {
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  start: number;
}
export interface Bounds {
  floor?: number;
  ceiling?: number;
  contains?: ((x: number, z: number) => boolean) | null;
}
export interface Cloud {
  capacity: number;
  count: number;
  position: Float32Array;
  velocity: Float32Array;
  age: Float32Array;
  life: Float32Array;
  seed: Float32Array;
  phase: Float32Array;
  size: Float32Array;
  emit(
    n: number,
    origin: readonly [number, number, number],
    direction: readonly [number, number, number],
    settings: Pick<SmokeSettings, 'throw' | 'spread' | 'hang'>,
  ): void;
  step(dt: number, settings: Pick<SmokeSettings, 'lift'>, bounds?: Bounds): void;
  clear(): void;
}

export const CAPACITY: number;
export const MAX_RATE: number;
export const PUFF_SECONDS: number;
export const SMOKE_RANGES: Record<keyof SmokeSettings, SmokeRange>;
export const SMOKE_DEFAULTS: SmokeSettings;
export function cleanSmoke(raw: unknown): SmokeSettings;
export function emissionRate(output: number): number;
export function takeEmission(carry: number, rate: number, dt: number): { n: number; carry: number };
export function growth(phase: number): number;
export function createCloud(options?: { capacity?: number; random?: () => number }): Cloud;
