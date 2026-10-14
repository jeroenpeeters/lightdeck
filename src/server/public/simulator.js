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
// The fixtures can be moved and turned by hand, with the gizmo of three.js, and mounted with
// the lights down, up, forward or back. Where they stand is kept per fixture in this browser
// (localStorage), not on the server.

import * as THREE from 'three';
import { createCalibration } from '/calibrate.js';
import { OrbitControls } from '/lib/three/OrbitControls.js';
import { TransformControls } from '/lib/three/TransformControls.js';
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
const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 80);
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
  store.view = { position: camera.position.toArray(), target: orbit.target.toArray() };
  saveStore();
});

scene.add(new THREE.HemisphereLight(0xaab4c6, 0x3a3f48, 3.5));

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(16, 16),
  new THREE.MeshStandardMaterial({ color: 0x20252c, roughness: 0.85, metalness: 0 }),
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
const grid = new THREE.GridHelper(16, 16, 0x3b434e, 0x262c34);
grid.position.y = 0.003;
scene.add(grid);

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
function keepPose(sim) {
  store.fixtures[sim.id] = { p: sim.group.position.toArray(), q: sim.group.quaternion.toArray() };
  saveStore();
}

// ---- the state, from lightdeck ----

const sims = [];
const dmxOf = new Map();
let haze = Number.isFinite(store.haze) ? store.haze : DEFAULT_HAZE;
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
  for (const fixture of state.fixtures) dmxOf.set(fixture.id, fixture.dmx);
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
  on('fixture', (message) => dmxOf.set(message.id, message.dmx));
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
  for (const each of sims) each.outline.visible = each === sim;
  if (sim) transform.attach(sim.group);
  else transform.detach();
  for (const key of document.querySelectorAll('#fixtures .key')) {
    key.setAttribute('aria-pressed', String(key.dataset.id === sim?.id));
  }
  showMount();
  calibration.show(sim);
}

/** Marks the mount that the chosen fixture is in, if it is in one. */
function showMount() {
  const yaw = selected ? yawOf(selected.group.quaternion) : 0;
  for (const key of document.querySelectorAll('#mounts .key')) {
    const same =
      selected !== null &&
      selected.group.quaternion.angleTo(mountQuaternion(yaw, Number(key.dataset.degrees))) <
        SAME_MOUNT;
    key.disabled = selected === null;
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
$('space').addEventListener('click', () => {
  const local = transform.space === 'world';
  transform.setSpace(local ? 'local' : 'world');
  $('space').setAttribute('aria-pressed', String(local));
  $('space').textContent = local ? 'Local axes' : 'World axes';
});
$('space').textContent = 'World axes';
$('snap').addEventListener('click', () => {
  const on = $('snap').getAttribute('aria-pressed') !== 'true';
  $('snap').setAttribute('aria-pressed', String(on));
  transform.setTranslationSnap(on ? SNAP_METRES : null);
  transform.setRotationSnap(on ? THREE.MathUtils.degToRad(SNAP_DEGREES) : null);
});
$('reset-fixture').addEventListener('click', () => {
  if (!selected) return;
  const index = sims.indexOf(selected);
  place(selected, defaultPose(index, sims.length));
  keepPose(selected);
  showMount();
});
$('reset-view').addEventListener('click', () => {
  setView(DEFAULT_VIEW);
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
  const hit = raycaster.intersectObjects(sims.flatMap((sim) => sim.pickable))[0];
  select(sims.find((sim) => sim.id === hit?.object.userData.fixtureId) ?? null);
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
  const note = $('note');
  const text = program
    ? 'A spider runs a program of its own. The simulator only draws the lens bytes, which are not what the fixture shows then.'
    : '';
  if (note.textContent !== text) {
    note.textContent = text;
    note.hidden = text === '';
  }
  orbit.update();
  renderer.render(scene, camera);
}

// ---- start ----

async function start() {
  resize();
  showSettings();
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
  if (sims.length === 0) {
    $('note').textContent = 'There is no spider in this rig to draw.';
    $('note').hidden = false;
  } else {
    select(sims[0]);
  }
  setLamp('link-stream', 'unknown', 'Lightdeck');
  listen();
  requestAnimationFrame(frame);
}
start();
