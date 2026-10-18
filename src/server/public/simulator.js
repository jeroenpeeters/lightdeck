// The simulator: the spiders drawn in 3D from the bytes lightdeck sends them, with a
// bridge or without one. It is a page of its own and does not use the shell. It reads the
// fixtures from /api/state and then the `fixture` and `frame` events of /api/events, which
// carry the bytes of each fixture as they go out (the master and the blackout are in them
// already), and works out what the fixture would show from those bytes alone. So what is
// drawn is what the LR512 would be given, whether a bridge is listening or not.
//
// What the fixture really does with the bytes is not known here, and these are guesses
// that are easy to find and change:
//   - How a bar turns for its tilt: the calibration `tiltCurve` of the layout, which is a
//     reading of what Jeroen saw on the real spider and not in the manual. The Calibrate
//     panel (calibrate.js) lets him correct it by eye, and this browser keeps what he sets.
//   - How fast a bar turns for the motor speed: the calibration `motorSpeedCurve` of the layout,
//     in degrees per second at a constant speed, which the same panel takes timings for.
//   - The strobe's speed in flashes per second, in spiderPose.js.
//
// How the spider is built is in `SPIDER_LAYOUT` (src/fixtures/spider.ts), which reaches this
// page as `details.layout`: which bar is at the back, in which order its LEDs sit, which way
// each bar turns when its tilt goes up, and how far each lens faces to the side. The fixture
// is drawn in its own frame: the front is +Z, the lenses face +Y when a bar is upright, and
// the back, with the LCD display and the cables, is -Z.
//
// The room (room.js, roomGeometry.js) is a shell with a panorama photo of the living room on
// it, which the key Room puts in the scene, so that the fixtures can be hung where they will
// hang. It is drawn apart from the fixtures and changes nothing about them.
//
// The smoke machine (smoke.js, smokeSim.js) is a small box that the key Smoke machine puts in
// the scene. It is moved and turned like a fixture, and its settings (output, density, throw,
// spread, nozzle angle, rise and hang time) are in a panel. Its smoke is lit by the lenses.
//
// The lamps of the room (roomLamps.js) are one fixture for lightdeck and hang in the room one by one.
// A zone of the rig is a rail: a straight bar that is moved and turned as a whole, with the lamps of
// that zone on it. A lamp is moved along its rail and nowhere else, so the lamps of one rail stay in
// line, and between two rails they are free. A light that is in no zone has a rail of its own. They
// are drawn from the state of the room and the grand master and the blackout (what lightdeck asks
// of them), and light the smoke like a lens. Where they hang is kept in this browser.
//
// The fixtures can be moved and turned by hand, with the gizmo of three.js, and mounted with
// the lights down, up, forward or back. Where they stand is kept per fixture in this browser
// (localStorage), not on the server.

import * as THREE from 'three';
import { createCalibration } from '/calibrate.js';
import { OrbitControls } from '/lib/three/OrbitControls.js';
import { TransformControls } from '/lib/three/TransformControls.js';
import { createRoom } from '/room.js';
import {
  clampAlong,
  cleanPlacement,
  defaultPlacement,
  lampLook,
  railSpan,
  railsOf,
} from '/roomLamps.js';
import { createSmoke } from '/smoke.js';
import { cleanSmoke, SMOKE_RANGES } from '/smokeSim.js';
import {
  cleanCurve,
  curveAt,
  lensColour,
  readSpider,
  stepToward,
  strobeOpen,
  tiltAngle,
} from '/spiderPose.js';

const STORE = 'lightdeck.simulator.v1';
const DEFAULT_HAZE = 60;
const DEFAULT_ROOM_LIGHT = 60;
const DEFAULT_CEILING = 2.6;
/** Looking into the room from above and behind the dining end, over the ceiling that is not drawn from there. */
const ROOM_VIEW = { position: [-2.5, 7.5, 9.5], target: [0.3, 0.9, -0.5] };
const FIELD_OF_VIEW = 50;
const PHOTO_FIELD_OF_VIEW = 75;
/** How high the smoke goes on the empty stage, which has no ceiling. */
const EMPTY_STAGE_CEILING = 4;
/** How much light the smoke gets from the room itself; the lenses come on top. */
const SMOKE_AMBIENT = 0.06;
const SMOKE_AMBIENT_DARK = 0.02;
/** A bar always turns at least this fast, so that a mistaken calibration does not freeze it. */
const MIN_DEGREES_PER_SECOND = 1;
/** Metres. The fixture's own frame has the origin in the middle of the underside. */
const HOUSING = { x: 0.6, y: 0.16, z: 0.34 };
const BAR = { length: 0.52, thick: 0.06, pivotY: 0.17, pivotZ: 0.09 };
const BEAM = { length: 6, half: 0.2 };
const SPOT_INTENSITY = 110;
const HUNG_AT = 2.4;
const SPACING = 1.6;
const SNAP_METRES = 0.05;
/** A rail of lamps: its bar, and a lamp that hangs under it. */
const RAIL = { thick: 0.045 };
const LAMP_BODY = { radius: 0.05, height: 0.13 };
const LAMP_SPOT_INTENSITY = 60;
const LAMP_SPOT_ANGLE = 0.5;
const SNAP_DEGREES = 5;
/** A press that moves more than this many pixels is a drag, not a pick. */
const CLICK_SLOP = 5;

const $ = (id) => document.getElementById(id);

// ---- what this browser keeps ----

function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '{}') ?? {};
  } catch {
    return {};
  }
}
const store = loadStore();
store.fixtures ??= {};
function saveStore() {
  try {
    localStorage.setItem(STORE, JSON.stringify(store));
  } catch {
    // Without storage the page works, it only forgets where things stood.
  }
}

// ---- the scene ----

const canvas = $('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d10);
const camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, 1, 0.05, 80);
const DEFAULT_VIEW = { position: [2.2, 2.7, 3.4], target: [0, 1.7, 0] };

const orbit = new OrbitControls(camera, canvas);
orbit.enableDamping = true;
orbit.maxPolarAngle = Math.PI * 0.52;
orbit.minDistance = 0.5;
orbit.maxDistance = 30;

function setView(view) {
  camera.position.fromArray(view.position);
  orbit.target.fromArray(view.target);
  orbit.update();
}
setView(store.view ?? DEFAULT_VIEW);
orbit.addEventListener('end', () => {
  // Looking round from the spot of the photo is not a view to come back to.
  if (photoView) return;
  store.view = { position: camera.position.toArray(), target: orbit.target.toArray() };
  saveStore();
});

const AMBIENT = 3.5;
/** With the room dark the room is lit by the fixtures and by next to nothing else. */
const AMBIENT_DARK = 1.3;
const ambient = new THREE.HemisphereLight(0xaab4c6, 0x3a3f48, AMBIENT);
scene.add(ambient);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(16, 16),
  new THREE.MeshStandardMaterial({ color: 0x20252c, roughness: 0.85, metalness: 0 }),
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
const grid = new THREE.GridHelper(16, 16, 0x3b434e, 0x262c34);
grid.position.y = 0.003;
scene.add(grid);

// ---- the room ----

const room = createRoom({
  scene,
  renderer,
  onLoaded(error) {
    if (error) {
      $('note').textContent = error.message;
      $('note').hidden = false;
    }
  },
});
let photoView = null;

const smoke = createSmoke({ scene, renderer, camera });
const machine = smoke.machine;
/** What can be chosen, moved and turned: the spiders, and the smoke machine when it is there. */
const things = () => [...sims, ...railSims, ...lampSims, ...(smoke.present ? [machine] : [])];

function applyDark() {
  room.setDark(roomDark);
  // The empty stage keeps its own light: only the room is dimmed.
  ambient.intensity = roomDark && room.visible ? AMBIENT_DARK : AMBIENT;
}

function showRoomSettings() {
  const on = room.visible;
  $('room-toggle').setAttribute('aria-pressed', String(on));
  $('room-dark').disabled = !on;
  $('room-dark').setAttribute('aria-pressed', String(roomDark));
  $('room-eye').disabled = !on;
  $('room-eye').setAttribute('aria-pressed', String(photoView !== null));
  $('room-light').disabled = !on;
  $('room-ceiling').disabled = !on;
  $('room-light').value = String(roomLight);
  $('room-light-value').textContent = `${roomLight}%`;
  $('room-ceiling').value = String(ceiling);
}

/** The simulator's own floor and grid are for an empty stage: the room has a floor of its own. */
function setRoom(on) {
  room.show(on);
  applyDark();
  floor.visible = !on;
  grid.visible = !on;
  if (!on) setPhotoView(false);
  store.room = on;
  // The first time, look into the room instead of at the place where the stage was.
  if (on && !store.roomSeen) setView(ROOM_VIEW);
  if (on) store.roomSeen = true;
  saveStore();
  showRoomSettings();
}

/**
 * Stands the camera where the photo was taken and lets the operator look round from there,
 * which is the check that the room is the photo: from that spot it looks the same.
 */
function setPhotoView(on) {
  if (on === (photoView !== null)) return;
  if (on) {
    photoView = {
      position: camera.position.toArray(),
      target: orbit.target.toArray(),
      limits: [orbit.minDistance, orbit.maxDistance, orbit.minPolarAngle, orbit.maxPolarAngle],
      rotateSpeed: orbit.rotateSpeed,
    };
    const eye = room.eye();
    orbit.enableZoom = false;
    orbit.enablePan = false;
    orbit.rotateSpeed = -0.5;
    orbit.minDistance = 0.01;
    orbit.maxDistance = 0.01;
    orbit.minPolarAngle = 0.05 * Math.PI;
    orbit.maxPolarAngle = 0.95 * Math.PI;
    camera.fov = PHOTO_FIELD_OF_VIEW;
    camera.position.copy(eye).add(new THREE.Vector3(0, 0, 0.01));
    orbit.target.copy(eye);
  } else {
    const saved = photoView;
    photoView = null;
    orbit.enableZoom = true;
    orbit.enablePan = true;
    orbit.rotateSpeed = saved.rotateSpeed;
    [orbit.minDistance, orbit.maxDistance, orbit.minPolarAngle, orbit.maxPolarAngle] = saved.limits;
    camera.fov = FIELD_OF_VIEW;
    setView({ position: saved.position, target: saved.target });
  }
  camera.updateProjectionMatrix();
  orbit.update();
  showRoomSettings();
}

// ---- a spider ----

const metal = new THREE.MeshStandardMaterial({ color: 0x59616d, roughness: 0.55, metalness: 0.35 });
const darkMetal = new THREE.MeshStandardMaterial({
  color: 0x3a3f48,
  roughness: 0.6,
  metalness: 0.3,
});

/** A soft round spot of light, for the glow around a lens. */
function glowTexture() {
  const size = 64;
  const draw = document.createElement('canvas');
  draw.width = draw.height = size;
  const context = draw.getContext('2d');
  const gradient = context.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(draw);
}
const GLOW = glowTexture();

// The cone of a beam: apex at the lens, opening along the lens's +Y.
const beamGeometry = new THREE.ConeGeometry(
  BEAM.length * Math.tan(BEAM.half),
  BEAM.length,
  24,
  1,
  true,
);
beamGeometry.translate(0, -BEAM.length / 2, 0);
beamGeometry.rotateX(Math.PI);

const BEAM_VERTEX = `
  varying vec3 vNormalView;
  varying vec3 vPositionView;
  varying float vAlong;
  void main() {
    vAlong = position.y / ${BEAM.length.toFixed(1)};
    vNormalView = normalize(normalMatrix * normal);
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    vPositionView = view.xyz;
    gl_Position = projectionMatrix * view;
  }
`;
// Soft at the edge, where the cone is seen edge-on, and fading with the distance.
const BEAM_FRAGMENT = `
  uniform vec3 uColor;
  uniform float uAlpha;
  varying vec3 vNormalView;
  varying vec3 vPositionView;
  varying float vAlong;
  void main() {
    float facing = abs(dot(normalize(vNormalView), normalize(-vPositionView)));
    float along = pow(1.0 - clamp(vAlong, 0.0, 1.0), 1.4) * smoothstep(0.0, 0.04, vAlong);
    gl_FragColor = vec4(uColor, uAlpha * pow(facing, 1.3) * along);
  }
`;

/** A lens at `x` along its bar, facing `aim` degrees to the right of straight ahead. */
function makeLens(bar, x, aim) {
  const lens = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.022, 0.01, 20),
    new THREE.MeshBasicMaterial({ color: 0x000000 }),
  );
  lens.position.set(x, BAR.thick / 2 + 0.004, 0);
  // A turn about the bar's Z axis takes +Y towards -X, so to the right is a negative angle.
  lens.rotation.z = -THREE.MathUtils.degToRad(aim);
  bar.add(lens);

  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: GLOW,
      color: 0x000000,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }),
  );
  glow.position.y = 0.02;
  glow.scale.setScalar(0.28);
  lens.add(glow);

  const beam = new THREE.Mesh(
    beamGeometry,
    new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color() }, uAlpha: { value: 0 } },
      vertexShader: BEAM_VERTEX,
      fragmentShader: BEAM_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    }),
  );
  beam.frustumCulled = false;
  lens.add(beam);

  const spot = new THREE.SpotLight(0x000000, 0, 0, BEAM.half * 1.4, 0.7, 2);
  const target = new THREE.Object3D();
  target.position.y = 1;
  lens.add(spot, target);
  spot.target = target;
  return { lens, glow, beam, spot };
}

/** What the LCD display shows: the DMX address, as the fixture does (A001 to A512). */
function lcdTexture(address) {
  const draw = document.createElement('canvas');
  draw.width = 192;
  draw.height = 72;
  const context = draw.getContext('2d');
  context.fillStyle = '#0d3a2c';
  context.fillRect(0, 0, draw.width, draw.height);
  context.fillStyle = '#8dffc8';
  context.font = '600 52px "Barlow", monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(`A${String(address).padStart(3, '0')}`, draw.width / 2, draw.height / 2 + 3);
  const texture = new THREE.CanvasTexture(draw);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const connectorMetal = new THREE.MeshStandardMaterial({
  color: 0x7d838c,
  roughness: 0.4,
  metalness: 0.8,
});
const buttonMaterial = new THREE.MeshStandardMaterial({
  color: 0x3a3f47,
  roughness: 0.6,
  metalness: 0.2,
});
const cableMaterial = new THREE.MeshStandardMaterial({
  color: 0x08090b,
  roughness: 0.7,
  metalness: 0,
});

/**
 * The back of the fixture, which is -Z: the LCD display with its buttons, the DMX sockets and
 * the power socket, with cables going out. It is how the page shows which side is which.
 */
function makeBack(group, address) {
  const z = -HOUSING.z / 2;
  const y = HOUSING.y / 2;
  const face = (geometry, material, x, level, depth) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, level, z - depth);
    return mesh;
  };

  const lcd = new THREE.Mesh(
    new THREE.PlaneGeometry(0.12, 0.045),
    new THREE.MeshBasicMaterial({ map: lcdTexture(address) }),
  );
  lcd.rotation.y = Math.PI;
  lcd.position.set(-0.17, y, z - 0.002);
  group.add(lcd);

  for (const x of [-0.08, -0.04, 0]) {
    const button = face(
      new THREE.CylinderGeometry(0.009, 0.009, 0.008, 12),
      buttonMaterial,
      x,
      y,
      0.004,
    );
    button.rotation.x = Math.PI / 2;
    group.add(button);
  }

  // DMX in, DMX out and power, each with a short collar.
  for (const [x, radius] of [
    [0.09, 0.02],
    [0.16, 0.02],
    [0.24, 0.024],
  ]) {
    const socket = face(
      new THREE.CylinderGeometry(radius, radius, 0.02, 16),
      connectorMetal,
      x,
      y,
      0.01,
    );
    socket.rotation.x = Math.PI / 2;
    group.add(socket);
  }
  // Two cables leave the back: the DMX line and the power.
  for (const [x, radius] of [
    [0.09, 0.008],
    [0.24, 0.012],
  ]) {
    const path = new THREE.CatmullRomCurve3([
      new THREE.Vector3(x, y, z - 0.02),
      new THREE.Vector3(x, y, z - 0.16),
      new THREE.Vector3(x + 0.04, y - 0.04, z - 0.3),
      new THREE.Vector3(x + 0.1, y - 0.13, z - 0.42),
    ]);
    group.add(new THREE.Mesh(new THREE.TubeGeometry(path, 24, radius, 8), cableMaterial));
  }
}

/** One spider: a housing with two bars that swing on their own, four LEDs on each. */
function makeSpider(fixture) {
  const layout = fixture.details.layout;
  const group = new THREE.Group();
  group.name = fixture.id;

  const housing = new THREE.Mesh(new THREE.BoxGeometry(HOUSING.x, HOUSING.y, HOUSING.z), metal);
  housing.position.y = HOUSING.y / 2;
  group.add(housing);
  const pickable = [housing];
  makeBack(group, fixture.address);

  const bars = layout.bars.map((cells, index) => {
    const pivot = new THREE.Group();
    // The first bar is at the back unless the layout says otherwise.
    const side = (layout.side?.[index] ?? (index === 0 ? 'back' : 'front')) === 'front' ? 1 : -1;
    pivot.position.set(0, BAR.pivotY, side * BAR.pivotZ);
    group.add(pivot);
    const body = new THREE.Mesh(new THREE.BoxGeometry(BAR.length, BAR.thick, BAR.thick), darkMetal);
    pivot.add(body);
    pickable.push(body);
    // The axle between the housing and the middle of the bar.
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.1), metal);
    axle.rotation.z = Math.PI / 2;
    group.add(axle);
    axle.position.set(0, BAR.pivotY, side * BAR.pivotZ);
    const pitch = BAR.length / cells.length;
    // The LEDs of a bar are listed from left to right, looking at the front.
    const lenses = cells.map((_, i) =>
      makeLens(pivot, (i - (cells.length - 1) / 2) * pitch, layout.aim?.[i] ?? 0),
    );
    // What the operator calibrated is kept in this browser and goes before the fixture's own.
    const base = layout.tiltCurve?.[index] ?? [];
    const kept = cleanCurve(store.calibration?.[fixture.id]?.[index]);
    return {
      pivot,
      lenses,
      angle: 0,
      base,
      curve: kept ?? base,
      custom: kept !== null,
      preview: null,
      tilt: 0.5,
      placed: false,
    };
  });

  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(HOUSING.x + 0.1, 0.4, HOUSING.z + 0.2)),
    new THREE.LineBasicMaterial({ color: 0xffb400 }),
  );
  outline.position.y = 0.15;
  outline.visible = false;
  group.add(outline);
  for (const part of pickable) part.userData.fixtureId = fixture.id;

  // How fast the bars turn is calibrated for both of them together.
  const baseSpeed = layout.motorSpeedCurve ?? [];
  const keptSpeed = cleanCurve(store.speedCalibration?.[fixture.id]);
  const speed = { base: baseSpeed, curve: keptSpeed ?? baseSpeed, custom: keptSpeed !== null };

  scene.add(group);
  return {
    id: fixture.id,
    label: fixture.label,
    group,
    bars,
    pickable,
    outline,
    fixture,
    speed,
    motorSpeed: 0,
  };
}

// ---- the rails and the lamps of the room ----

/** A lamp hangs from its rail with the lens at the bottom, facing down. */
function makeLamp(fixture, rail, railSim, lamp, along) {
  const holder = new THREE.Group();
  holder.position.set(along, 0, 0);
  railSim.group.add(holder);
  const id = `${railSim.id}/${lamp.id}`;

  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.06), metal);
  stem.position.y = -0.03;
  holder.add(stem);
  // The lens is at the bottom of the body, and the body is above it.
  const bottom = new THREE.Group();
  bottom.position.y = -0.06 - LAMP_BODY.height;
  holder.add(bottom);
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(LAMP_BODY.radius, LAMP_BODY.radius * 0.8, LAMP_BODY.height, 24),
    darkMetal,
  );
  body.position.y = LAMP_BODY.height / 2;
  bottom.add(body);

  const made = makeLens(bottom, 0, 0);
  // A lens faces +Y of its parent: turn it over, so that it faces down, and wider than a lens of the spider.
  made.lens.rotation.set(Math.PI, 0, 0);
  made.lens.position.set(0, 0, 0);
  made.lens.scale.setScalar(1.6);
  made.beam.scale.set(2.2, 0.6, 2.2);
  made.spot.angle = LAMP_SPOT_ANGLE;

  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(0.2, 0.32, 0.2)),
    new THREE.LineBasicMaterial({ color: 0xffb400 }),
  );
  outline.position.y = -0.14;
  outline.visible = false;
  holder.add(outline);
  body.userData.fixtureId = id;
  stem.userData.fixtureId = id;
  return {
    kind: 'lamp',
    id,
    label: lamp.label,
    group: holder,
    pickable: [body, stem],
    outline,
    fixtureId: fixture.id,
    lampId: lamp.id,
    rail: railSim,
    lens: made,
  };
}

/** A rail: a bar with its lamps, moved and turned as a whole. Its axis is its own X. */
function makeRail(fixture, rail, placement) {
  const group = new THREE.Group();
  const id = `${fixture.id}/${rail.id}`;
  group.name = id;
  const bar = new THREE.Mesh(new THREE.BoxGeometry(1, RAIL.thick, RAIL.thick), darkMetal);
  group.add(bar);
  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 0.12, 0.12)),
    new THREE.LineBasicMaterial({ color: 0xffb400 }),
  );
  outline.visible = false;
  group.add(outline);
  bar.userData.fixtureId = id;
  scene.add(group);

  const sim = {
    kind: 'rail',
    id,
    label: rail.label,
    group,
    pickable: [bar],
    outline,
    fixtureId: fixture.id,
    rail,
    lamps: [],
  };
  sim.lamps = rail.lamps.map((lamp) =>
    makeLamp(fixture, rail, sim, lamp, placement.along[lamp.id] ?? 0),
  );
  /** The bar reaches a little past the first and the last lamp, wherever they are put. */
  sim.updateSpan = () => {
    const span = railSpan(sim.lamps.map((lamp) => lamp.group.position.x));
    for (const part of [bar, outline]) {
      part.scale.x = span.length;
      part.position.x = span.middle;
    }
  };
  sim.updateSpan();
  return sim;
}

// ---- where the fixtures stand ----

/**
 * How a fixture is mounted: the direction the lenses face when a bar is upright, as a turn
 * about the fixture's own X axis (the bars' axis) from standing. A turn about the vertical,
 * which says where the front points, comes on top of it and is left as it is.
 */
const MOUNTS = [
  { label: 'Lights down', degrees: 180 },
  { label: 'Lights forward', degrees: 90 },
  { label: 'Lights up', degrees: 0 },
  { label: 'Lights back', degrees: 270 },
];
const UP = new THREE.Vector3(0, 1, 0);
const ALONG_BARS = new THREE.Vector3(1, 0, 0);
const SAME_MOUNT = 0.02;

/** Where the front points, as a turn about the vertical, from where the bars point. */
function yawOf(quaternion) {
  const along = ALONG_BARS.clone().applyQuaternion(quaternion);
  return Math.atan2(-along.z, along.x);
}
function mountQuaternion(yaw, degrees) {
  return new THREE.Quaternion()
    .setFromAxisAngle(UP, yaw)
    .multiply(
      new THREE.Quaternion().setFromAxisAngle(ALONG_BARS, THREE.MathUtils.degToRad(degrees)),
    );
}

function defaultPose(index, count) {
  return {
    p: [(index - (count - 1) / 2) * SPACING, HUNG_AT, 0],
    // Hung upside down, so that the lenses look at the floor.
    q: mountQuaternion(0, MOUNTS[0].degrees).toArray(),
  };
}
function place(sim, pose) {
  sim.group.position.fromArray(pose.p);
  sim.group.quaternion.fromArray(pose.q);
}
/** On the floor a little way from the spiders, the nozzle pointing at them. */
const MACHINE_POSE = {
  p: [0.6, 0, 1.4],
  q: new THREE.Quaternion().setFromAxisAngle(UP, Math.PI).toArray(),
};
/** What this browser kept of where the lamps of a room fixture hang. */
function lampStore(fixtureId) {
  store.lamps ??= {};
  store.lamps[fixtureId] ??= { rails: {}, along: {} };
  store.lamps[fixtureId].rails ??= {};
  store.lamps[fixtureId].along ??= {};
  return store.lamps[fixtureId];
}
function keepPose(sim) {
  if (sim.kind === 'lamp') {
    // A lamp stays on its rail's axis: only the way along it is its own.
    const along = clampAlong(sim.group.position.x);
    sim.group.position.set(along, 0, 0);
    lampStore(sim.fixtureId).along[sim.lampId] = along;
    sim.rail.updateSpan();
    saveStore();
    return;
  }
  if (sim.kind === 'rail') {
    lampStore(sim.fixtureId).rails[sim.rail.id] = {
      p: sim.group.position.toArray(),
      q: sim.group.quaternion.toArray(),
    };
    saveStore();
    return;
  }
  if (sim.kind === 'smoke') {
    store.smoke ??= {};
    store.smoke.pose = { p: sim.group.position.toArray(), q: sim.group.quaternion.toArray() };
    saveStore();
    return;
  }
  store.fixtures[sim.id] = { p: sim.group.position.toArray(), q: sim.group.quaternion.toArray() };
  saveStore();
}

// ---- the state, from lightdeck ----

const sims = [];
/** The rails and the lamps of the room, which are chosen, moved and drawn like the fixtures. */
const railSims = [];
const lampSims = [];
/** By the id of a room fixture, its rails as `railsOf` made them. */
const railsOfFixture = new Map();
const defaultPlacementOf = (fixtureId) => defaultPlacement(railsOfFixture.get(fixtureId) ?? []);
const dmxOf = new Map();
/** By the id of a room fixture, the state lightdeck last told of it, and what the room is given. */
const roomStates = new Map();
let master = 1;
let blackout = false;
let haze = Number.isFinite(store.haze) ? store.haze : DEFAULT_HAZE;
let roomDark = store.roomDark === true;
let roomLight = Number.isFinite(store.roomLight) ? store.roomLight : DEFAULT_ROOM_LIGHT;
let ceiling = Number.isFinite(store.ceiling) ? store.ceiling : DEFAULT_CEILING;
let selected = null;

async function fetchState() {
  const response = await fetch('/api/state');
  if (!response.ok) throw new Error(response.statusText);
  return response.json();
}

function setLamp(id, state, text) {
  const item = $(id);
  item.dataset.state = state;
  item.querySelector('.link-text').textContent = text;
}
function showBridge(state, status) {
  if (!state.bridgeUrl) setLamp('link-bridge', 'unknown', 'No bridge');
  else if (status?.bridge) setLamp('link-bridge', 'ok', 'Bridge connected');
  else setLamp('link-bridge', 'down', 'Bridge not connected');
}

let bridgeUrl = null;
function adopt(state) {
  bridgeUrl = state.bridgeUrl;
  for (const fixture of state.fixtures) {
    dmxOf.set(fixture.id, fixture.dmx);
    if (fixture.protocol === 'hass') roomStates.set(fixture.id, fixture.state);
  }
  master = state.master ?? master;
  blackout = state.blackout ?? blackout;
  showBridge(state, state.status);
}

// ---- the stream ----

let events;
function listen() {
  if (events) return;
  events = new EventSource('/api/events');
  const on = (name, handler) =>
    events.addEventListener(name, (event) => handler(JSON.parse(event.data)));
  events.addEventListener('open', async () => {
    setLamp('link-stream', 'ok', 'Lightdeck');
    // What the stream told while it was away is lost: start from what is real.
    try {
      adopt(await fetchState());
    } catch {
      // The next event says more.
    }
  });
  events.addEventListener('error', () => setLamp('link-stream', 'down', 'Lightdeck lost'));
  on('fixture', (message) => {
    dmxOf.set(message.id, message.dmx);
    // A fixture without bytes is one of Home Assistant's: its state is what the lamps are drawn from.
    if (message.state && !message.dmx) roomStates.set(message.id, message.state);
  });
  on('master', (message) => {
    master = message.master;
  });
  on('blackout', (message) => {
    blackout = message.blackout;
  });
  on('frame', (message) => dmxOf.set(message.id, message.dmx));
  on('status', (status) => showBridge({ bridgeUrl }, status));
}
function hush() {
  events?.close();
  events = undefined;
}
// A browser has six connections per server for all its tabs: a page holds its stream only
// while it is on screen.
document.addEventListener('visibilitychange', () => (document.hidden ? hush() : listen()));
window.addEventListener('pagehide', hush);
window.addEventListener('pageshow', () => {
  if (!document.hidden) listen();
});

// ---- moving and turning ----

const transform = new TransformControls(camera, canvas);
transform.setSize(0.8);
scene.add(transform.getHelper());
transform.addEventListener('dragging-changed', (event) => {
  orbit.enabled = !event.value;
  dragged = true;
  if (!event.value && selected) keepPose(selected);
});
transform.addEventListener('objectChange', () => {
  if (selected) keepPose(selected);
  showMount();
});

let dragged = false;

function select(sim) {
  selected = sim;
  for (const each of things()) each.outline.visible = each === sim;
  if (sim) transform.attach(sim.group);
  else transform.detach();
  // A lamp goes along its rail and nowhere else, and is not turned: only the axis of the rail is
  // offered, in the rail's own directions.
  const lamp = sim?.kind === 'lamp';
  transform.showX = true;
  transform.showY = !lamp;
  transform.showZ = !lamp;
  if (lamp) {
    setMode('translate');
    showSpace(true);
  }
  $('mode-rotate').disabled = lamp;
  $('space').disabled = lamp;
  for (const key of document.querySelectorAll('#fixtures .key')) {
    key.setAttribute('aria-pressed', String(key.dataset.id === sim?.id));
  }
  showLampKeys();
  showMount();
  // Only a spider has bars to calibrate.
  calibration.show(sim && !sim.kind ? sim : null);
}

/** The lamps of the chosen rail, as keys, and the one that is chosen marked. */
function showLampKeys() {
  const rail =
    selected?.kind === 'rail' ? selected : selected?.kind === 'lamp' ? selected.rail : null;
  const group = $('lamps-group');
  group.hidden = rail === null;
  const row = $('lamp-keys');
  if (rail === null) {
    row.replaceChildren();
    return;
  }
  if (row.dataset.rail !== rail.id) {
    row.dataset.rail = rail.id;
    row.replaceChildren(
      ...rail.lamps.map((lamp) => {
        const key = document.createElement('button');
        key.type = 'button';
        key.className = 'key';
        key.dataset.id = lamp.id;
        key.textContent = lamp.label;
        key.addEventListener('click', () => select(lamp));
        return key;
      }),
    );
  }
  for (const key of row.children)
    key.setAttribute('aria-pressed', String(key.dataset.id === selected.id));
}

/** Where the chosen fixture hangs, in metres from the spot where the photo was taken. */
function showPosition() {
  const lamp = selected?.kind === 'lamp';
  // For a lamp the first field is how far along its rail it hangs, and the others do not apply.
  document.querySelector('label[for="pos-x"]').textContent = lamp ? 'Along the rail' : 'Across';
  for (const id of ['pos-y', 'pos-z']) {
    $(id).style.visibility = lamp ? 'hidden' : 'visible';
    document.querySelector(`label[for="${id}"]`).style.visibility = lamp ? 'hidden' : 'visible';
  }
  for (const [id, axis] of [
    ['pos-x', 'x'],
    ['pos-y', 'y'],
    ['pos-z', 'z'],
  ]) {
    const field = $(id);
    field.disabled = selected === null;
    if (selected && document.activeElement !== field) {
      field.value = selected.group.position[axis].toFixed(2);
    }
  }
}
for (const [id, axis] of [
  ['pos-x', 'x'],
  ['pos-y', 'y'],
  ['pos-z', 'z'],
]) {
  $(id).addEventListener('change', () => {
    const value = Number($(id).value);
    if (!selected || !Number.isFinite(value)) return showPosition();
    selected.group.position[axis] = value;
    keepPose(selected);
    showPosition();
  });
}

/** Marks the mount that the chosen fixture is in, if it is in one. */
function showMount() {
  showPosition();
  const yaw = selected ? yawOf(selected.group.quaternion) : 0;
  for (const key of document.querySelectorAll('#mounts .key')) {
    // Only a spider is mounted: a rail is hung, and a lamp hangs from it.
    const same =
      selected !== null &&
      !selected.kind &&
      selected.group.quaternion.angleTo(mountQuaternion(yaw, Number(key.dataset.degrees))) <
        SAME_MOUNT;
    key.disabled = selected === null || Boolean(selected.kind);
    key.setAttribute('aria-pressed', String(same));
  }
}
for (const mount of MOUNTS) {
  const key = document.createElement('button');
  key.type = 'button';
  key.className = 'key';
  key.dataset.degrees = String(mount.degrees);
  key.textContent = mount.label;
  key.setAttribute('aria-pressed', 'false');
  key.addEventListener('click', () => {
    if (!selected) return;
    selected.group.quaternion.copy(
      mountQuaternion(yawOf(selected.group.quaternion), mount.degrees),
    );
    keepPose(selected);
    showMount();
  });
  $('mounts').append(key);
}

function setMode(mode) {
  transform.setMode(mode);
  $('mode-translate').setAttribute('aria-pressed', String(mode === 'translate'));
  $('mode-rotate').setAttribute('aria-pressed', String(mode === 'rotate'));
}
$('mode-translate').addEventListener('click', () => setMode('translate'));
$('mode-rotate').addEventListener('click', () => setMode('rotate'));
/** Moves and turns about the axes of the fixture itself, or about those of the room. */
function showSpace(local) {
  transform.setSpace(local ? 'local' : 'world');
  $('space').setAttribute('aria-pressed', String(local));
  $('space').textContent = local ? 'Local axes' : 'World axes';
}
$('space').addEventListener('click', () => showSpace(transform.space === 'world'));
$('space').textContent = 'World axes';
$('snap').addEventListener('click', () => {
  const on = $('snap').getAttribute('aria-pressed') !== 'true';
  $('snap').setAttribute('aria-pressed', String(on));
  transform.setTranslationSnap(on ? SNAP_METRES : null);
  transform.setRotationSnap(on ? THREE.MathUtils.degToRad(SNAP_DEGREES) : null);
});
$('reset-fixture').addEventListener('click', () => {
  if (!selected) return;
  if (selected.kind === 'lamp' || selected.kind === 'rail') {
    const defaults = defaultPlacementOf(selected.fixtureId);
    if (selected.kind === 'rail') {
      const pose = defaults.rails[selected.rail.id];
      selected.group.position.fromArray(pose.p);
      selected.group.quaternion.fromArray(pose.q);
    } else {
      selected.group.position.set(defaults.along[selected.lampId] ?? 0, 0, 0);
    }
    keepPose(selected);
    showMount();
    return;
  }
  const index = sims.indexOf(selected);
  place(selected, selected.kind === 'smoke' ? MACHINE_POSE : defaultPose(index, sims.length));
  keepPose(selected);
  showMount();
});
$('room-toggle').addEventListener('click', () => setRoom(!room.visible));
$('room-eye').addEventListener('click', () => setPhotoView(photoView === null));
$('room-dark').addEventListener('click', () => {
  roomDark = !roomDark;
  store.roomDark = roomDark;
  saveStore();
  applyDark();
  showRoomSettings();
});
$('room-light').addEventListener('input', () => {
  roomLight = Number($('room-light').value);
  store.roomLight = roomLight;
  saveStore();
  room.setBrightness(roomLight / 100);
  showRoomSettings();
});
$('room-ceiling').addEventListener('change', () => {
  const value = Number($('room-ceiling').value);
  if (Number.isFinite(value) && value >= 2 && value <= 4) {
    ceiling = value;
    store.ceiling = value;
    saveStore();
    room.setCeiling(value);
  }
  showRoomSettings();
});
$('reset-view').addEventListener('click', () => {
  setPhotoView(false);
  setView(room.visible ? ROOM_VIEW : DEFAULT_VIEW);
  delete store.view;
  saveStore();
});
window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey) return;
  if (event.key === 'w') setMode('translate');
  else if (event.key === 'e') setMode('rotate');
});

// A press that does not move and is not on the gizmo picks the fixture under it, or none.
const raycaster = new THREE.Raycaster();
let pressedAt = null;
canvas.addEventListener('pointerdown', (event) => {
  pressedAt = { x: event.clientX, y: event.clientY };
  dragged = false;
});
canvas.addEventListener('pointerup', (event) => {
  if (!pressedAt) return;
  const moved = Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y);
  pressedAt = null;
  if (moved > CLICK_SLOP || dragged || transform.axis) return;
  const bounds = canvas.getBoundingClientRect();
  raycaster.setFromCamera(
    new THREE.Vector2(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    ),
    camera,
  );
  const hit = raycaster.intersectObjects(things().flatMap((thing) => thing.pickable))[0];
  select(things().find((thing) => thing.id === hit?.object.userData.fixtureId) ?? null);
});

// ---- calibrating the movement ----

/** What the operator calibrated of a fixture goes in the storage of this browser. */
function saveCalibration(sim) {
  const mine = {};
  sim.bars.forEach((bar, index) => {
    if (bar.custom) mine[index] = bar.curve;
  });
  store.calibration ??= {};
  if (Object.keys(mine).length > 0) store.calibration[sim.id] = mine;
  else delete store.calibration[sim.id];
  store.speedCalibration ??= {};
  if (sim.speed.custom) store.speedCalibration[sim.id] = sim.speed.curve;
  else delete store.speedCalibration[sim.id];
  saveStore();
}
const calibration = createCalibration({
  root: $('calibrate'),
  save: saveCalibration,
  reset(sim, index) {
    const bar = sim.bars[index];
    if (!bar) return;
    bar.curve = bar.base;
    bar.custom = false;
    bar.preview = null;
    saveCalibration(sim);
  },
  resetSpeed(sim) {
    sim.speed.curve = sim.speed.base;
    sim.speed.custom = false;
    saveCalibration(sim);
  },
});
let calibrating = false;
$('calibrate-toggle').addEventListener('click', () => {
  calibrating = !calibrating;
  $('calibrate-toggle').setAttribute('aria-pressed', String(calibrating));
  $('calibrate').hidden = !calibrating;
  if (!calibrating) for (const sim of sims) for (const bar of sim.bars) bar.preview = null;
});

// ---- the settings of the look ----

function showSettings() {
  $('haze').value = String(haze);
  $('haze-value').textContent = `${haze}%`;
}
$('haze').addEventListener('input', () => {
  haze = Number($('haze').value);
  store.haze = haze;
  saveStore();
  showSettings();
});

// ---- the smoke machine ----

smoke.set(cleanSmoke(store.smoke?.settings));

function machineKey() {
  const key = document.createElement('button');
  key.type = 'button';
  key.className = 'key';
  key.dataset.id = machine.id;
  key.textContent = machine.label;
  key.setAttribute('aria-pressed', String(selected === machine));
  key.addEventListener('click', () => select(machine));
  return key;
}

function showSmoke() {
  $('smoke-toggle').setAttribute('aria-pressed', String(smoke.present));
  $('smoke').hidden = !smoke.present;
  $('smoke-on').setAttribute('aria-pressed', String(smoke.emitting));
  const settings = smoke.settings;
  for (const [name, range] of Object.entries(SMOKE_RANGES)) {
    const field = $(`smoke-${name}`);
    if (document.activeElement !== field) field.value = String(settings[name]);
    $(`smoke-${name}-value`).textContent = `${settings[name]}${range.unit}`;
  }
}

/** Puts the smoke machine in the scene, where it was last put, or takes it out. */
function setMachine(on) {
  if (on === smoke.present) return;
  smoke.show(on);
  if (on) {
    place(machine, store.smoke?.pose ?? MACHINE_POSE);
    $('fixtures').append(machineKey());
  } else {
    for (const key of document.querySelectorAll('#fixtures .key')) {
      if (key.dataset.id === machine.id) key.remove();
    }
    if (selected === machine) select(sims[0] ?? railSims[0] ?? null);
  }
  store.smoke ??= {};
  store.smoke.present = on;
  saveStore();
  showSmoke();
}

for (const [name, range] of Object.entries(SMOKE_RANGES)) {
  const label = document.createElement('label');
  label.htmlFor = `smoke-${name}`;
  label.append(`${range.label} `);
  const value = document.createElement('output');
  value.id = `smoke-${name}-value`;
  label.append(value);
  const input = document.createElement('input');
  input.type = 'range';
  input.id = `smoke-${name}`;
  input.min = String(range.min);
  input.max = String(range.max);
  input.step = String(range.step);
  input.addEventListener('input', () => {
    smoke.set({ [name]: Number(input.value) });
    store.smoke ??= {};
    store.smoke.settings = smoke.settings;
    saveStore();
    showSmoke();
  });
  $('smoke-settings').append(label, input);
}
$('smoke-toggle').addEventListener('click', () => setMachine(!smoke.present));
$('smoke-on').addEventListener('click', () => {
  smoke.setEmitting(!smoke.emitting);
  showSmoke();
});
$('smoke-puff').addEventListener('click', () => smoke.puff());
$('smoke-clear').addEventListener('click', () => smoke.clear());

/** Where the smoke cannot go: the floor, and the ceiling and the walls when the room is there. */
function smokeBounds() {
  return {
    floor: 0.02,
    ceiling: room.visible ? ceiling : EMPTY_STAGE_CEILING,
    contains: room.visible ? (x, z) => room.contains(x, z) : null,
  };
}

/** The fixtures' lenses that shine, which light the smoke. */
function shiningLenses() {
  const lenses = [];
  for (const sim of sims) {
    for (const bar of sim.bars) {
      for (const lens of bar.lenses) {
        const colour = lens.spot.color;
        if (Math.max(colour.r, colour.g, colour.b) > 0.002) {
          lenses.push({ object: lens.lens, colour });
        }
      }
    }
  }
  for (const sim of lampSims) {
    const colour = sim.lens.spot.color;
    if (Math.max(colour.r, colour.g, colour.b) > 0.002) {
      lenses.push({ object: sim.lens.lens, colour });
    }
  }
  return lenses;
}

// ---- drawing ----

const colour = new THREE.Color();
let last = performance.now();

function drawSpider(sim, dt, seconds) {
  const look = readSpider(
    dmxOf.get(sim.id) ?? [],
    sim.fixture.controls,
    sim.fixture.details.layout,
  );
  const open = strobeOpen(look.strobe, seconds);
  sim.motorSpeed = look.motorSpeed;
  // The bars turn at a constant speed that the motor speed gives, the same for both.
  const degreesPerSecond = Math.max(
    MIN_DEGREES_PER_SECOND,
    curveAt(look.motorSpeed, sim.speed.curve),
  );
  look.bars.forEach((data, index) => {
    const bar = sim.bars[index];
    if (!bar) return;
    bar.tilt = data.tilt;
    // While the angle is being moved in the Calibrate panel the bar shows that angle.
    const target =
      bar.preview === null ? tiltAngle(data.tilt, bar.curve) : (bar.preview * Math.PI) / 180;
    if (bar.preview !== null || !bar.placed) {
      // At once: the operator is placing it, or the page has just come up and the bar is
      // where it already is.
      bar.angle = target;
      bar.placed = true;
    } else {
      bar.angle = stepToward(bar.angle, target, ((degreesPerSecond * Math.PI) / 180) * dt);
    }
    bar.pivot.rotation.x = bar.angle;
    data.cells.forEach((cell, i) => {
      const lens = bar.lenses[i];
      if (!lens) return;
      const seen = lensColour(cell, open ? look.dimmer : 0);
      const brightness = Math.max(seen.r, seen.g, seen.b);
      lens.lens.material.color.setRGB(seen.r, seen.g, seen.b, THREE.SRGBColorSpace);
      lens.glow.material.color.setRGB(seen.r, seen.g, seen.b, THREE.SRGBColorSpace);
      lens.glow.material.opacity = Math.min(1, brightness * 1.2);
      // The beam is drawn at its own full colour, and as faint as the lens is dim.
      if (brightness > 0.001)
        colour.setRGB(seen.r / brightness, seen.g / brightness, seen.b / brightness);
      else colour.setRGB(0, 0, 0);
      lens.beam.material.uniforms.uColor.value.copy(colour);
      lens.beam.material.uniforms.uAlpha.value = brightness * (haze / 100) * 0.55;
      lens.spot.color.setRGB(seen.r, seen.g, seen.b, THREE.SRGBColorSpace);
      lens.spot.intensity = SPOT_INTENSITY;
    });
  });
  if (calibrating && sim === selected) calibration.update(sim);
  return look.program;
}

/** A lamp shows what lightdeck asks of it: its colour at its level, times the dimmers. */
function drawLamp(sim) {
  const look = lampLook(roomStates.get(sim.fixtureId), sim.lampId, {
    master,
    blackout,
    zone: sim.rail.rail.loose ? null : sim.rail.rail.id,
  });
  const shown = look.brightness;
  const { lens } = sim;
  colour.setRGB(look.r * shown, look.g * shown, look.b * shown);
  lens.lens.material.color.setRGB(
    look.r * shown,
    look.g * shown,
    look.b * shown,
    THREE.SRGBColorSpace,
  );
  lens.glow.material.color.setRGB(
    look.r * shown,
    look.g * shown,
    look.b * shown,
    THREE.SRGBColorSpace,
  );
  lens.glow.material.opacity = Math.min(1, shown * 1.2);
  // The beam is drawn at its own full colour, and as faint as the lamp is dim.
  colour.setRGB(look.r, look.g, look.b);
  lens.beam.material.uniforms.uColor.value.copy(colour);
  lens.beam.material.uniforms.uAlpha.value = shown * (haze / 100) * 0.45;
  lens.spot.color.setRGB(look.r * shown, look.g * shown, look.b * shown, THREE.SRGBColorSpace);
  lens.spot.intensity = LAMP_SPOT_INTENSITY;
}

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  let program = false;
  for (const sim of sims) program = drawSpider(sim, dt, now / 1000) || program;
  for (const sim of lampSims) drawLamp(sim);
  const note = $('note');
  const text = program
    ? 'A spider runs a program of its own. The simulator only draws the lens bytes, which are not what the fixture shows then.'
    : '';
  if (note.textContent !== text) {
    note.textContent = text;
    note.hidden = text === '';
  }
  if (smoke.present) {
    smoke.update(dt, {
      lenses: shiningLenses(),
      bounds: smokeBounds(),
      ambient: room.visible && roomDark ? SMOKE_AMBIENT_DARK : SMOKE_AMBIENT,
    });
  }
  orbit.update();
  renderer.render(scene, camera);
}

// ---- start ----

async function start() {
  resize();
  showSettings();
  room.setBrightness(roomLight / 100);
  room.setCeiling(ceiling);
  // The URL hash can ask for the room, `#room`, for the view from the photo's spot,
  // `#room,photo`, for the room dark, `#room,dark`, and for a camera anywhere, `#view=x:y:z:tx:ty:tz` (the camera and what it
  // looks at, in metres), so that a view can be bookmarked or opened for a check.
  const asked = location.hash.slice(1).split(',');
  if (asked.includes('dark')) {
    roomDark = true;
    applyDark();
  }
  if (store.room || asked.includes('room')) setRoom(true);
  else showRoomSettings();
  if (asked.includes('photo') && room.visible) setPhotoView(true);
  // `#smoke` puts the smoke machine in, `#smoke,on` also starts it and `warm=10` lets ten
  // seconds of smoke go by at once, for a check.
  const at = asked
    .find((part) => part.startsWith('view='))
    ?.slice(5)
    .split(':')
    .map(Number);
  if (at?.length === 6 && at.every(Number.isFinite)) {
    setView({ position: at.slice(0, 3), target: at.slice(3) });
  }
  let state;
  try {
    state = await fetchState();
  } catch {
    $('note').textContent =
      'This page cannot reach lightdeck. Check that it is running, then reload.';
    $('note').hidden = false;
    setLamp('link-stream', 'down', 'Lightdeck lost');
    return;
  }
  adopt(state);
  const spiders = state.fixtures.filter((fixture) => fixture.kind === 'spider');
  showSettings();
  spiders.forEach((fixture, index) => {
    const sim = makeSpider(fixture);
    place(sim, store.fixtures[fixture.id] ?? defaultPose(index, spiders.length));
    sims.push(sim);
    const key = document.createElement('button');
    key.type = 'button';
    key.className = 'key';
    key.dataset.id = fixture.id;
    key.textContent = fixture.label;
    key.setAttribute('aria-pressed', 'false');
    key.addEventListener('click', () => select(sim));
    $('fixtures').append(key);
  });
  // The lamps of the room: a rail for every zone, with its lamps on it.
  for (const fixture of state.fixtures) {
    if (fixture.protocol !== 'hass' || !fixture.details?.lamps) continue;
    const rails = railsOf(fixture.details);
    railsOfFixture.set(fixture.id, rails);
    const placement = cleanPlacement(store.lamps?.[fixture.id], rails);
    for (const rail of rails) {
      const sim = makeRail(fixture, rail, placement);
      const pose = placement.rails[rail.id];
      sim.group.position.fromArray(pose.p);
      sim.group.quaternion.fromArray(pose.q);
      railSims.push(sim);
      lampSims.push(...sim.lamps);
      const key = document.createElement('button');
      key.type = 'button';
      key.className = 'key';
      key.dataset.id = sim.id;
      key.textContent = rail.label;
      key.setAttribute('aria-pressed', 'false');
      key.addEventListener('click', () => select(sim));
      $('fixtures').append(key);
    }
  }
  if (store.smoke?.present || asked.includes('smoke')) setMachine(true);
  if (asked.includes('on') && smoke.present) smoke.setEmitting(true);
  const warm = Number(asked.find((part) => part.startsWith('warm='))?.slice(5));
  if (Number.isFinite(warm) && smoke.present) smoke.advance(warm, smokeBounds());
  showSmoke();
  if (sims.length === 0 && railSims.length === 0) {
    $('note').textContent = 'There is nothing in this rig to draw.';
    $('note').hidden = false;
  } else {
    select(sims[0] ?? railSims[0]);
  }
  setLamp('link-stream', 'unknown', 'Lightdeck');
  listen();
  requestAnimationFrame(frame);
}
start();
