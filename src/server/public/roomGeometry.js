// The living room of the simulator, worked out from one panorama photo
// (`room/living-room.jpg`, a Pixel panorama taken from one spot, 2026-10-14). No browser and
// no three.js in here, so that it can have a test; room.js draws it.
//
// How the room was found, because none of it was measured with a tape:
//   - The photo is (nearly) a cylinder around the camera: a pixel column is a direction, and
//     a row is the height above the horizon divided by the distance to the wall. So a point
//     on the floor at distance `d` lies `f * CAMERA_HEIGHT / d` pixels under the horizon, and
//     a point on the ceiling lies `f * (CEILING_HEIGHT - CAMERA_HEIGHT) / d` over it.
//   - At each corner the row of the floor and the row of the ceiling are both visible, and
//     their distance in pixels is `f * CEILING_HEIGHT / d`. That gives `d` without knowing
//     where the horizon is, which is how the corners below were read off the photo.
//   - Everything depends on the ceiling being 2.6 m. If it is not, the whole room scales:
//     room.js has a key for it, and nothing in here needs to change.
//
// The photo is a stitched panorama of a bit more than a turn, and the phone drifted up and
// down while it was swept, so the horizon is not a straight row. `HORIZON` says where it is
// at a few columns. The first and the last stretch of the photo show the same wall, and the
// horizon there differs by 380 pixels; room.js blends the two.
//
// Everything is in the room's own frame: metres, the camera on the floor at the origin, +X
// towards the long window wall, the dining end at +Z and the living end at -Z. The photo's
// column x is the direction `x / turn * 2 PI` plus `ROTATION` (a turn clockwise seen from
// above, the same way the photo was swept).

/** Pixels of the photo that room/living-room.jpg is a scaled copy of. */
export const PANO = { width: 19840, height: 3072, turn: 19685 };
/** Where the camera was, above the floor, in metres. A guess: held at chest height. */
export const CAMERA_HEIGHT = 1.45;
/** The height of the room that the corners were read with; room.js scales it. */
export const CEILING_HEIGHT = 2.6;
/** Turns the photo's directions so that the long window wall faces +X. */
export const ROTATION = (58.9 * Math.PI) / 180;

/** Where the horizon is in the photo, row by column. Piecewise linear between the points. */
export const HORIZON = [
  [0, 1500],
  [2200, 1430],
  [7800, 1340],
  [10000, 1370],
  [12300, 1450],
  [14500, 1420],
  [17000, 1100],
  [19685, 1120],
  [19840, 1120],
];

/**
 * The corners of the floor, in the order of the photo (clockwise from above): the column
 * where each is in the photo, and its distance from the camera in metres.
 */
export const CORNERS = [
  { name: 'window wall, dining end', x: 5290, d: 7.5 },
  { name: 'kitchen wall, dining end', x: 7780, d: 6.3 },
  { name: 'kitchen wall, end of the cabinets', x: 12300, d: 2.5 },
  { name: 'window niche, left', x: 12850, d: 2.95 },
  { name: 'window niche, right', x: 14440, d: 3.0 },
  { name: 'glass door', x: 15450, d: 2.58 },
  { name: 'glass door, living side', x: 16460, d: 2.45 },
  { name: 'living end, left', x: 16650, d: 7.6 },
  { name: 'living end, right', x: 18100, d: 6.2 },
  { name: 'television wall', x: 19170, d: 4.08 },
];

/** The row of the horizon at column `x` of the photo. */
export function horizonAt(x, knots = HORIZON) {
  if (x <= knots[0][0]) return knots[0][1];
  for (let i = 1; i < knots.length; i++) {
    const [x1, y1] = knots[i];
    if (x <= x1) {
      const [x0, y0] = knots[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return knots[knots.length - 1][1];
}

/** Where a column and a distance of the photo lie on the floor plan: [x, z] in metres. */
export function planPoint(x, d, rotation = ROTATION) {
  const angle = (x / PANO.turn) * 2 * Math.PI + rotation;
  return [d * Math.sin(angle), -d * Math.cos(angle)];
}

/** The floor plan of the room as [x, z] points, clockwise seen from above. */
export function roomOutline(corners = CORNERS, rotation = ROTATION) {
  return corners.map((corner) => planPoint(corner.x, corner.d, rotation));
}

/**
 * Where a point of the room shows in the photo: the column and the row (in pixels of the
 * photo itself), or null for a point right above or under the camera, which has no column.
 * The same sum as the shader of room.js does for each pixel.
 */
export function projectToPano(point, camera = [0, CAMERA_HEIGHT, 0], rotation = ROTATION) {
  const dx = point[0] - camera[0];
  const dz = point[2] - camera[2];
  const rho = Math.hypot(dx, dz);
  if (rho < 1e-6) return null;
  const turns = (Math.atan2(dx, -dz) - rotation) / (2 * Math.PI);
  const x = (turns - Math.floor(turns)) * PANO.turn;
  const f = PANO.turn / (2 * Math.PI);
  return { x, y: horizonAt(x) - (f * (point[1] - camera[1])) / rho };
}

/** Is the point (x, z) inside the polygon of [x, z] points? */
export function insidePolygon(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i];
    const [xj, zj] = polygon[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
