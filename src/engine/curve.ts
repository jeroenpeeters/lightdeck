/**
 * Calibration tables: points of [x, value] in the order of x, with straight lines between
 * them and the end values held beyond them. The tilt of a bar (tilt 0..1 to degrees) and the
 * motor speed (motor speed 0..1 to degrees per second) are both given like this, see
 * `SPIDER_LAYOUT`. The simulator reads them with the same rule in `spiderPose.js`.
 */

export type Curve = readonly (readonly [number, number])[];

/** The value of `curve` at `x`. Without points it is 0. */
export function curveAt(curve: Curve, x: number): number {
  const first = curve[0];
  const last = curve[curve.length - 1];
  if (!first || !last) return 0;
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < curve.length; i++) {
    const [x1, y1] = curve[i] as readonly [number, number];
    if (x <= x1) {
      const [x0, y0] = curve[i - 1] as readonly [number, number];
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return last[1];
}

/** The smallest and the largest value of a curve, or undefined without points. */
export function curveRange(curve: Curve): { min: number; max: number } | undefined {
  if (curve.length === 0) return undefined;
  const values = curve.map(([, y]) => y);
  return { min: Math.min(...values), max: Math.max(...values) };
}

/**
 * The x at which `curve` has the value `y`: the first place on the curve that does, and the end
 * point that comes nearest when `y` lies outside what the curve reaches. It is undefined when
 * the curve cannot tell: fewer than two points, or the same value everywhere, so that every x
 * gives the same.
 */
export function curveInverse(curve: Curve, y: number): number | undefined {
  const range = curveRange(curve);
  if (!range || curve.length < 2 || range.max - range.min < 1e-9) return undefined;
  if (y <= range.min || y >= range.max) {
    const target = y <= range.min ? range.min : range.max;
    return (curve.find(([, value]) => value === target) as readonly [number, number])[0];
  }
  for (let i = 1; i < curve.length; i++) {
    const [x0, y0] = curve[i - 1] as readonly [number, number];
    const [x1, y1] = curve[i] as readonly [number, number];
    if (y0 !== y1 && y >= Math.min(y0, y1) && y <= Math.max(y0, y1)) {
      return x0 + ((y - y0) * (x1 - x0)) / (y1 - y0);
    }
  }
  return undefined;
}
