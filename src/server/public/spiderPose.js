// What a spider does, worked out from the bytes it is sent. Plain functions with nothing
// of the browser in them, so that they can have a test: the simulator page only draws what
// this says.
//
// Everything is read from the controls of the profile (`fixture.controls` of /api/state),
// by name and by channel, so a change of the channel map in the profile reaches the
// simulator without a change here.

/** The most flashes per second the simulator draws, the same limit the effects keep. */
export const MAX_STROBE_HZ = 10;
/** Where the strobe starts to flash, in flashes per second, at its first byte. */
const MIN_STROBE_HZ = 1;

/** One byte, or the 16 bits of a level with a fine channel, as 0..1. */
function level(dmx, control) {
  if (!control) return 0;
  const high = dmx[control.channel - 1] ?? 0;
  if (control.fineChannel === undefined) return high / 255;
  const low = dmx[control.fineChannel - 1] ?? 0;
  return (high * 256 + low) / 65535;
}

/**
 * What the spider shows for these bytes, as the page needs it:
 *
 *   dimmer     total dimming, 0..1
 *   strobe     the byte of the strobe channel
 *   motorSpeed the motor speed, 0..1
 *   program    true while the fixture runs a program of its own (an automatic or sound
 *              effect, which the simulator cannot draw: what the channels say is not
 *              what the fixture shows then)
 *   bars       per bar: `tilt`, 0..1 as sent, and `cells`, one { r, g, b, w } of 0..1 per LED
 *
 * `layout` is `details.layout` of the fixture.
 */
export function readSpider(dmx, controls, layout) {
  const byName = new Map(controls.map((control) => [control.name, control]));
  const byte = (name) => {
    const control = byName.get(name);
    return control ? (dmx[control.channel - 1] ?? 0) : 0;
  };
  return {
    dimmer: level(dmx, byName.get('dimmer')),
    strobe: byte('strobe'),
    motorSpeed: level(dmx, byName.get('motorSpeed')),
    program: byte('function') > 0 || byte('autoMode') > 15,
    bars: layout.bars.map((cells, index) => ({
      tilt: level(dmx, byName.get(layout.tilt[index])),
      cells: cells.map((cell) => {
        const [r, g, b, w] = layout.colours.map((colour) =>
          level(dmx, byName.get(`${colour}${cell + 1}`)),
        );
        return { r, g, b, w };
      }),
    })),
  };
}

/**
 * The colour of a cell as it is seen: red, green and blue, each with the white added, times
 * the total dimming. 0..1 each.
 */
export function lensColour({ r, g, b, w }, dimmer) {
  const mix = (part) => Math.min(1, part + w) * dimmer;
  return { r: mix(r), g: mix(g), b: mix(b) };
}

/** Two tilts this close are the same point of a calibration: 0.2 percent of the tilt. */
export const SAME_TILT = 0.002;

/**
 * The value of a calibration at `x`: `curve` is points of [x, value] in the order of x. It
 * runs in a straight line between two points and keeps the value of the first or the last point
 * beyond them. Without a curve it is 0. The tilt of a bar and the motor speed are both
 * calibrated like this.
 */
export function curveAt(x, curve) {
  const first = curve?.[0];
  const last = curve?.[curve.length - 1];
  if (!first || !last) return 0;
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < curve.length; i++) {
    const [to, toValue] = curve[i];
    if (x <= to) {
      const [from, fromValue] = curve[i - 1];
      return fromValue + (toValue - fromValue) * ((x - from) / (to - from));
    }
  }
  return last[1];
}

/**
 * The angle of a bar in degrees for a tilt of 0..1, positive to the front, from the
 * calibration of the fixture: points of [tilt, degrees]. See `curveAt`.
 */
export function tiltDegrees(tilt, curve) {
  return curveAt(tilt, curve);
}

/** The same in radians. */
export function tiltAngle(tilt, curve) {
  return (tiltDegrees(tilt, curve) * Math.PI) / 180;
}

/**
 * A calibration with the bar at `degrees` for `tilt`: a point at about that tilt is replaced,
 * and otherwise one is added in its place in the order. Gives a new curve.
 */
export function setPoint(curve, tilt, degrees) {
  const kept = curve.filter(([at]) => Math.abs(at - tilt) > SAME_TILT);
  kept.push([tilt, degrees]);
  return kept.sort((a, b) => a[0] - b[0]);
}

/**
 * A calibration with its point number `index` given another place and value, for who types a
 * measured value in by hand. A point that lands within `SAME_TILT` of another replaces it.
 */
export function replacePoint(curve, index, x, value) {
  return setPoint(removePoint(curve, index), x, value);
}

/** A calibration without its point number `index`. Gives a new curve. */
export function removePoint(curve, index) {
  return curve.filter((_, i) => i !== index);
}

/**
 * A calibration that came from somewhere that may have kept it wrong (the storage of the
 * browser): the points in the order of the tilt, or null when it is not one.
 */
export function cleanCurve(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const points = [];
  for (const point of value) {
    if (!Array.isArray(point) || point.length !== 2) return null;
    const [tilt, degrees] = point;
    if (!Number.isFinite(tilt) || !Number.isFinite(degrees) || tilt < 0 || tilt > 1) return null;
    points.push([tilt, degrees]);
  }
  return points.sort((a, b) => a[0] - b[0]);
}

/**
 * Whether the strobe lets the light through at `seconds`. Bytes 0 and 251 to 255 are no
 * strobe, 1 to 250 run from slow to fast, held at `MAX_STROBE_HZ`.
 */
export function strobeOpen(byte, seconds) {
  if (byte < 1 || byte > 250) return true;
  const hz = Math.min(
    MAX_STROBE_HZ,
    MIN_STROBE_HZ + ((byte - 1) / 249) * (MAX_STROBE_HZ - MIN_STROBE_HZ),
  );
  return (seconds * hz) % 1 < 0.5;
}

/**
 * Moves `current` towards `target` by at most `maxStep`, as a motor does that turns at a
 * constant speed: it gets there and stops, and never goes past.
 */
export function stepToward(current, target, maxStep) {
  const distance = target - current;
  if (Math.abs(distance) <= maxStep) return target;
  return current + Math.sign(distance) * maxStep;
}
