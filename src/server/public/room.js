// The living room of the simulator: a shell of a floor, walls and a ceiling that has the
// panorama photo of the room on it, so that the lights can be hung where they will hang.
// The geometry is in roomGeometry.js (how it was read off the photo) and this file draws it.
//
// The photo is not wrapped round the walls with texture coordinates. Each pixel of the shell
// asks where it is seen from the spot where the photo was taken and takes the colour of the
// photo in that direction (a projection, as a slide projector would put it on the walls). So
// the shell looks like the photo from that spot and, from anywhere else, like the room as
// far as the walls are right. What stood in front of a wall, the furniture, is painted on the
// wall behind it and does not have a shape of its own.
//
// The shell is built in the units of the corners, with a ceiling of CEILING_HEIGHT, and
// `setCeiling` scales the group: a projection does not change when everything is scaled.
//
// The walls and the ceiling are single-sided, so that seen from outside they are not there,
// and a view from above looks into the room like into a doll's house.

import * as THREE from 'three';
import {
  CAMERA_HEIGHT,
  CEILING_HEIGHT,
  HORIZON,
  insidePolygon,
  PANO,
  ROTATION,
  roomOutline,
} from '/roomGeometry.js';

const PHOTO = '/room/living-room.jpg';
/** The stretch where the start and the end of the photo show the same wall, in photo pixels. */
const OVERLAP = PANO.width - PANO.turn;

const VERTEX = `
  varying vec3 vRoom;
`;
const FRAGMENT_HEAD = `
  uniform sampler2D uPhoto;
  uniform float uCamera;
  uniform float uRotation;
  uniform float uTurn;
  uniform float uOverlap;
  uniform vec2 uSize;
  uniform vec2 uHorizon[${HORIZON.length}];
  uniform float uBright;
  uniform float uDark;
  varying vec3 vRoom;

  float horizonAt(float x) {
    float y = uHorizon[0].y;
    for (int i = 1; i < ${HORIZON.length}; i++) {
      vec2 a = uHorizon[i - 1];
      vec2 b = uHorizon[i];
      if (x >= a.x) y = mix(a.y, b.y, clamp((x - a.x) / (b.x - a.x), 0.0, 1.0));
    }
    return y;
  }

  // The photo at column x, \`lift\` pixels above the horizon of that column. The photo does
  // not reach the floor right under the camera or the ceiling right above it: there the
  // colour of its last rows takes over, blurred, and closer to the spot under the camera,
  // where every direction meets, the average of all of them.
  vec3 fromPhoto(float x, float lift, float rho, vec2 gx, vec2 gy) {
    float row = horizonAt(x) - lift;
    float u = x / uSize.x;
    vec3 sharp = textureGrad(uPhoto, vec2(u, 1.0 - row / uSize.y), gx, gy).rgb;
    float last = row < uSize.y * 0.5 ? 0.995 : 0.005;
    vec3 soft = textureGrad(uPhoto, vec2(u, last), vec2(0.012, 0.0), vec2(0.0, 0.012)).rgb;
    vec3 mean = textureGrad(uPhoto, vec2(0.5, last), vec2(1.0, 0.0), vec2(0.0, 0.012)).rgb;
    soft = mix(mean, soft, smoothstep(0.0, 3.0, rho));
    return mix(soft, sharp, smoothstep(0.0, 60.0, min(row, uSize.y - row)));
  }

  // Dark: most of the light that was in the room when the photo was taken is taken out, so
  // that the lights of the fixtures are what lights it. The colour of that light (the blue
  // lamp, the warm one) goes with it: what is left is the colour of the surfaces, as far as
  // a photo can tell.
  vec3 roomTone(vec3 c) {
    float grey = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(c, vec3(grey), 0.85 * uDark);
    return c * mix(1.0, 0.4, uDark);
  }

  vec3 roomColour(vec3 p) {
    vec3 d = p - vec3(0.0, uCamera, 0.0);
    float rho = max(length(d.xz), 0.001);
    float turns = (atan(d.x, -d.z) - uRotation) / 6.28318530718;
    float t0 = fract(turns);
    float t1 = fract(turns + 0.5);
    // fract jumps where the photo's seam is; the other one jumps on the far side of it.
    float tc = (t0 < 0.25 || t0 > 0.75) ? t1 : t0;
    float lift = uTurn / 6.28318530718 * d.y / rho;
    float dtx = (t0 < 0.25 || t0 > 0.75) ? dFdx(t1) : dFdx(t0);
    float dty = (t0 < 0.25 || t0 > 0.75) ? dFdy(t1) : dFdy(t0);
    vec2 gx = vec2(dtx * uTurn / uSize.x, dFdx(lift) / uSize.y);
    vec2 gy = vec2(dty * uTurn / uSize.x, dFdy(lift) / uSize.y);

    float x = t0 * uTurn;
    vec3 seen = fromPhoto(x, lift, rho, gx, gy);
    if (x < uOverlap) {
      // The first stretch of the photo is also its last: fade from one to the other.
      vec3 other = fromPhoto(x + uTurn, lift, rho, gx, gy);
      seen = mix(other, seen, smoothstep(0.0, 1.0, x / uOverlap));
    }
    return seen;
  }
`;

/** One surface of the shell. The photo's colour is the colour of the surface, lit by the lights. */
function surface(shared) {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.9,
    metalness: 0,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared);
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `${VERTEX}\nvoid main() {`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vRoom = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${FRAGMENT_HEAD}\nvoid main() {`)
      .replace(
        '#include <map_fragment>',
        'diffuseColor.rgb *= roomTone(roomColour(vRoom)) * uBright;',
      );
  };
  return material;
}

/** A wall from the floor to the ceiling along one edge of the plan, facing the camera's side. */
function wallGeometry([x0, z0], [x1, z1], height) {
  const positions = [
    x0,
    0,
    z0,
    x1,
    0,
    z1,
    x1,
    height,
    z1,
    x0,
    0,
    z0,
    x1,
    height,
    z1,
    x0,
    height,
    z0,
  ];
  // Wound so that the front is on the side of the origin, the room.
  const edge = new THREE.Vector3(x1 - x0, 0, z1 - z0);
  const up = new THREE.Vector3(0, 1, 0);
  const normal = new THREE.Vector3().crossVectors(edge, up);
  const toCamera = new THREE.Vector3(-(x0 + x1) / 2, 0, -(z0 + z1) / 2);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (normal.dot(toCamera) < 0) {
    // The other way round: swap the second and third vertex of each triangle.
    const flipped = [
      positions.slice(0, 3),
      positions.slice(6, 9),
      positions.slice(3, 6),
      positions.slice(9, 12),
      positions.slice(15, 18),
      positions.slice(12, 15),
    ].flat();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(flipped, 3));
  }
  geometry.computeVertexNormals();
  return geometry;
}

function placeholder() {
  const texture = new THREE.DataTexture(new Uint8Array([110, 105, 100, 255]), 1, 1);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Builds the room and puts it in `scene`, hidden. The photo is fetched the first time the room
 * is shown, so that a page that never shows it never loads it.
 */
export function createRoom({ scene, renderer, onLoaded }) {
  const group = new THREE.Group();
  group.name = 'room';
  group.visible = false;
  scene.add(group);

  const shared = {
    // A grey pixel until the photo is there.
    uPhoto: { value: placeholder() },
    uCamera: { value: CAMERA_HEIGHT },
    uRotation: { value: ROTATION },
    uTurn: { value: PANO.turn },
    uOverlap: { value: OVERLAP },
    uSize: { value: new THREE.Vector2(PANO.width, PANO.height) },
    uHorizon: { value: HORIZON.map(([x, y]) => new THREE.Vector2(x, y)) },
    uBright: { value: 0.6 },
    uDark: { value: 0 },
  };

  const outline = roomOutline();
  const floorMaterial = surface(shared);
  const wallMaterial = surface(shared);
  const ceilingMaterial = surface(shared);

  const floor = new THREE.Mesh(
    new THREE.ShapeGeometry(
      new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, -z))),
    ).rotateX(-Math.PI / 2),
    floorMaterial,
  );
  const ceiling = new THREE.Mesh(
    new THREE.ShapeGeometry(
      new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, z))),
    ).rotateX(Math.PI / 2),
    ceilingMaterial,
  );
  ceiling.position.y = CEILING_HEIGHT;
  group.add(floor, ceiling);
  outline.forEach((from, i) => {
    group.add(
      new THREE.Mesh(
        wallGeometry(from, outline[(i + 1) % outline.length], CEILING_HEIGHT),
        wallMaterial,
      ),
    );
  });

  let loading = false;
  function load() {
    if (loading) return;
    loading = true;
    new THREE.TextureLoader().load(
      PHOTO,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        shared.uPhoto.value = texture;
        onLoaded?.(null);
      },
      undefined,
      () => {
        loading = false;
        onLoaded?.(new Error(`The photo of the room (${PHOTO}) did not load.`));
      },
    );
  }

  return {
    group,
    /** Where the photo was taken, from the floor, in the units of the scene. */
    eye() {
      return new THREE.Vector3(0, CAMERA_HEIGHT * group.scale.y, 0);
    },
    show(on) {
      group.visible = on;
      if (on) load();
    },
    get visible() {
      return group.visible;
    },
    /** How much of the photo's own light the shell keeps, 0..1; the lights come on top. */
    setBrightness(value) {
      shared.uBright.value = value;
    },
    /** Takes most of the photo's own light out of the shell (see roomTone in the shader). */
    setDark(on) {
      shared.uDark.value = on ? 1 : 0;
    },
    /** Is the point (x, z), in the units of the scene, inside the walls? */
    contains(x, z) {
      const scale = group.scale.x;
      return insidePolygon(x / scale, z / scale, outline);
    },
    /** The height of the ceiling in metres. The corners were read with CEILING_HEIGHT. */
    setCeiling(metres) {
      group.scale.setScalar(metres / CEILING_HEIGHT);
    },
  };
}
