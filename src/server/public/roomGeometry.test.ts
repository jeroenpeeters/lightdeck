import { describe, expect, it } from 'vitest';
import {
  CAMERA_HEIGHT,
  CEILING_HEIGHT,
  CORNERS,
  HORIZON,
  horizonAt,
  insidePolygon,
  PANO,
  planPoint,
  projectToPano,
  roomOutline,
} from './roomGeometry.js';

const F = PANO.turn / (2 * Math.PI);

describe('horizonAt', () => {
  it('goes in straight lines between the points and stays at the ends', () => {
    expect(horizonAt(-50)).toBe(HORIZON[0]?.[1]);
    expect(horizonAt(0)).toBe(1500);
    expect(horizonAt(1100)).toBeCloseTo(1465, 5);
    expect(horizonAt(PANO.width + 10)).toBe(1120);
  });
});

describe('the corners', () => {
  it('lie in the photo where they were read off it', () => {
    for (const corner of CORNERS) {
      const [x, z] = planPoint(corner.x, corner.d);
      const floor = projectToPano([x, 0, z]);
      expect(floor?.x).toBeCloseTo(corner.x, 3);
      // On the floor, f * height / d under the horizon.
      expect(floor?.y).toBeCloseTo(horizonAt(corner.x) + (F * CAMERA_HEIGHT) / corner.d, 3);
    }
  });

  it('put the ceiling in the photo at the pixel distance that gave the distance', () => {
    for (const corner of CORNERS) {
      const [x, z] = planPoint(corner.x, corner.d);
      const floor = projectToPano([x, 0, z]);
      const ceiling = projectToPano([x, CEILING_HEIGHT, z]);
      expect((floor?.y ?? 0) - (ceiling?.y ?? 0)).toBeCloseTo((F * CEILING_HEIGHT) / corner.d, 3);
    }
  });

  it('make a floor plan that goes round once, clockwise seen from above', () => {
    const outline = roomOutline();
    // Shoelace with z pointing towards the viewer: clockwise from above is positive.
    let area = 0;
    for (let i = 0; i < outline.length; i++) {
      const [x0, z0] = outline[i] ?? [0, 0];
      const [x1, z1] = outline[(i + 1) % outline.length] ?? [0, 0];
      area += x0 * z1 - x1 * z0;
    }
    expect(area / 2).toBeGreaterThan(30);
    expect(area / 2).toBeLessThan(120);
  });

  it('keep the camera inside the room', () => {
    const outline = roomOutline();
    let inside = false;
    for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
      const [xi, zi] = outline[i] ?? [0, 0];
      const [xj, zj] = outline[j] ?? [0, 0];
      if (zi > 0 !== zj > 0 && 0 < ((xj - xi) * (0 - zi)) / (zj - zi) + xi) inside = !inside;
    }
    expect(inside).toBe(true);
  });
});

describe('projectToPano', () => {
  it('has no column for a point right above the camera', () => {
    expect(projectToPano([0, 2, 0])).toBeNull();
  });

  it('turns clockwise with the column, as the photo was swept', () => {
    const a = projectToPano([1, CAMERA_HEIGHT, 0]);
    const b = projectToPano([0, CAMERA_HEIGHT, 1]);
    // +X to +Z is a quarter turn clockwise seen from above.
    const quarter = PANO.turn / 4;
    const step = (((b?.x ?? 0) - (a?.x ?? 0)) % PANO.turn) + PANO.turn;
    expect(step % PANO.turn).toBeCloseTo(quarter, 3);
  });

  it('rises in the photo as the point rises', () => {
    const low = projectToPano([3, 0.5, 1]);
    const high = projectToPano([3, 2, 1]);
    expect(high?.y).toBeLessThan(low?.y ?? 0);
  });
});

describe('insidePolygon', () => {
  const square = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
  ];
  it('tells inside from outside', () => {
    expect(insidePolygon(1, 1, square)).toBe(true);
    expect(insidePolygon(3, 1, square)).toBe(false);
    expect(insidePolygon(1, -1, square)).toBe(false);
  });
});
