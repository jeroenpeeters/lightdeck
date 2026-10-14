/**
 * Small functions of the beat that light effects and motion effects share.
 */

export const TAU = Math.PI * 2;

/** The part behind the point. */
export const frac = (x: number) => x - Math.floor(x);

/** Remainder that is never negative. */
export const mod = (x: number, n: number) => ((x % n) + n) % n;

/** Sharp attack on the beat, then an exponential fall. 1 at the start of each period. */
export function hit(position: number, sharpness: number): number {
  return Math.exp(-sharpness * frac(position));
}

/** Repeatable pseudo-random number 0..1 from two integers. */
export function noise(a: number, b: number): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
