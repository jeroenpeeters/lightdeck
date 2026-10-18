// The smoke machine of the simulator: a small box with a nozzle that can be put anywhere in
// the scene, and the smoke it makes, drawn as soft points that the lenses of the fixtures
// light. The smoke itself is worked out in smokeSim.js; this file is the model, the points
// and the shader.
//
// The smoke is lit by the lenses and by next to nothing else: each point asks which beams it
// is in (a cone from the lens along its axis) and takes their colour, so smoke in a dark
// room shows where the light goes, and smoke outside the beams is nearly invisible, as on a
// stage. The points are added to what is behind them, so they need no sorting.

import * as THREE from 'three';
import {
  cleanSmoke,
  createCloud,
  emissionRate,
  growth,
  MAX_RATE,
  PUFF_SECONDS,
  SMOKE_DEFAULTS,
  takeEmission,
} from '/smokeSim.js';

/** The most lenses that can light the smoke at once: 8 per spider. */
const MAX_LIGHTS = 32;
const BODY = { x: 0.3, y: 0.14, z: 0.18 };
/** How strongly a lens lights the smoke. */
const LIGHT_GAIN = 1.4;
/** Per particle, at a density of 100 percent. */
const OPACITY = 0.3;

const VERTEX = `
  uniform vec3 uLightPos[${MAX_LIGHTS}];
  uniform vec3 uLightDir[${MAX_LIGHTS}];
  uniform vec3 uLightCol[${MAX_LIGHTS}];
  uniform int uLights;
  uniform vec3 uAmbient;
  uniform float uScale;
  uniform float uDensity;
  uniform float uGrow;
  attribute float aSize;
  attribute float aPhase;
  varying vec3 vLight;
  varying float vAlpha;

  void main() {
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    float grow = 1.0 + uGrow * aPhase;
    gl_PointSize = min(aSize * grow * uScale / max(-view.z, 0.05), 512.0);
    gl_Position = projectionMatrix * view;

    vec3 light = uAmbient;
    for (int i = 0; i < ${MAX_LIGHTS}; i++) {
      if (i >= uLights) break;
      vec3 d = position - uLightPos[i];
      float dist = max(length(d), 0.05);
      // In the beam: a wide, soft edge, because a point is as big as a cloud.
      float cone = smoothstep(0.93, 0.99, dot(d / dist, uLightDir[i]));
      light += uLightCol[i] * cone / (1.0 + 0.12 * dist * dist);
    }
    vLight = light;
    // Thin in, thin out, and thinner as it spreads.
    vAlpha = uDensity * smoothstep(0.0, 0.04, aPhase) * (1.0 - smoothstep(0.45, 1.0, aPhase))
      / pow(grow, 1.5);
  }
`;
const FRAGMENT = `
  varying vec3 vLight;
  varying float vAlpha;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    gl_FragColor = vec4(vLight, vAlpha * exp(-r2 * 3.5));
    #include <colorspace_fragment>
  }
`;

/**
 * Makes the machine and its smoke and puts them in `scene`, hidden. `renderer` and `camera` give
 * the size of the picture and of the view, which the size of a point depends on.
 */
export function createSmoke({ scene, renderer, camera }) {
  let settings = { ...SMOKE_DEFAULTS };
  let emitting = false;
  let puffLeft = 0;
  let carry = 0;
  const cloud = createCloud();

  // ---- the machine ----

  const group = new THREE.Group();
  group.name = 'smoke-machine';
  group.visible = false;
  const plastic = new THREE.MeshStandardMaterial({
    color: 0x23262b,
    roughness: 0.6,
    metalness: 0.2,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(BODY.x, BODY.y, BODY.z), plastic);
  body.position.y = BODY.y / 2;
  group.add(body);
  // The nozzle sits at the front (+Z), on top, and tilts up by the angle of the settings.
  const nozzle = new THREE.Group();
  nozzle.position.set(0, BODY.y, BODY.z / 2 - 0.03);
  const pipe = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.03, 0.09, 16),
    new THREE.MeshStandardMaterial({ color: 0x59616d, roughness: 0.5, metalness: 0.5 }),
  );
  pipe.position.y = 0.04;
  nozzle.add(pipe);
  const tip = new THREE.Object3D();
  tip.position.y = 0.09;
  nozzle.add(tip);
  group.add(nozzle);
  const lamp = new THREE.Mesh(
    new THREE.BoxGeometry(0.03, 0.01, 0.03),
    new THREE.MeshBasicMaterial({ color: 0x3a3f48 }),
  );
  lamp.position.set(-BODY.x / 2 + 0.05, BODY.y + 0.005, -0.03);
  group.add(lamp);
  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(BODY.x + 0.1, 0.3, BODY.z + 0.1)),
    new THREE.LineBasicMaterial({ color: 0xffb400 }),
  );
  outline.position.y = 0.1;
  outline.visible = false;
  group.add(outline);
  body.userData.fixtureId = 'smoke';
  pipe.userData.fixtureId = 'smoke';
  scene.add(group);

  function aim() {
    // Tilting +Y about +X by (90 - angle) degrees points it up and forward by `angle`.
    nozzle.rotation.x = Math.PI / 2 - THREE.MathUtils.degToRad(settings.angle);
  }
  aim();

  // ---- the points ----

  const geometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.BufferAttribute(cloud.position, 3).setUsage(
    THREE.DynamicDrawUsage,
  );
  const sizeAttribute = new THREE.BufferAttribute(cloud.size, 1).setUsage(THREE.DynamicDrawUsage);
  const phaseAttribute = new THREE.BufferAttribute(cloud.phase, 1).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttribute);
  geometry.setAttribute('aSize', sizeAttribute);
  geometry.setAttribute('aPhase', phaseAttribute);
  geometry.setDrawRange(0, 0);

  const uniforms = {
    uLightPos: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) },
    uLightDir: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3(0, -1, 0)) },
    uLightCol: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) },
    uLights: { value: 0 },
    uAmbient: { value: new THREE.Vector3() },
    uScale: { value: 1 },
    uDensity: { value: 0 },
    uGrow: { value: growth(1) - 1 },
  };
  const points = new THREE.Points(
    geometry,
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  points.frustumCulled = false;
  points.visible = false;
  scene.add(points);

  // ---- working it ----

  const origin = new THREE.Vector3();
  const along = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const size = new THREE.Vector2();
  const lensPosition = new THREE.Vector3();
  const lensAxis = new THREE.Vector3();
  const lensQuaternion = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);

  /** The smoke by `step` seconds: what comes out of the nozzle, and how the cloud moves. */
  function run(step, bounds) {
    group.updateMatrixWorld(true);
    const rate = Math.max(
      emitting ? emissionRate(settings.output) : 0,
      puffLeft > 0 ? MAX_RATE : 0,
    );
    puffLeft = Math.max(0, puffLeft - step);
    const taken = takeEmission(carry, rate, step);
    carry = taken.carry;
    if (taken.n > 0) {
      tip.getWorldPosition(origin);
      group.getWorldQuaternion(quaternion);
      // The way the nozzle points: +Z of the machine, turned up by the angle.
      const up = THREE.MathUtils.degToRad(settings.angle);
      along.set(0, Math.sin(up), Math.cos(up)).applyQuaternion(quaternion);
      cloud.emit(taken.n, origin.toArray(), along.toArray(), settings);
    }
    lamp.material.color.setHex(rate > 0 ? 0xffb400 : 0x3a3f48);
    cloud.step(step, settings, bounds);
    positionAttribute.needsUpdate = true;
    sizeAttribute.needsUpdate = true;
    phaseAttribute.needsUpdate = true;
    geometry.setDrawRange(0, cloud.count);
  }

  return {
    /** The thing the simulator selects, moves and turns, like a fixture. */
    machine: {
      id: 'smoke',
      label: 'Smoke machine',
      kind: 'smoke',
      group,
      outline,
      pickable: [body, pipe],
    },
    get settings() {
      return { ...settings };
    },
    get present() {
      return group.visible;
    },
    get emitting() {
      return emitting;
    },
    /** Puts the machine in the scene or takes it out, with its smoke. */
    show(on) {
      group.visible = on;
      points.visible = on;
      if (!on) {
        emitting = false;
        puffLeft = 0;
        cloud.clear();
      }
    },
    /** Changes the settings; what is not given stays. */
    set(change) {
      settings = cleanSmoke({ ...settings, ...change });
      aim();
      return this.settings;
    },
    /** Smoke without end, until it is put off. */
    setEmitting(on) {
      emitting = on;
    },
    /** A short burst at full output. */
    puff() {
      puffLeft = PUFF_SECONDS;
    },
    /** Lets `seconds` of smoke go by at once, for looking at a cloud that is already there. */
    advance(seconds, bounds) {
      for (let t = 0; t < seconds; t += 0.05) run(0.05, bounds);
    },
    /** All the smoke gone at once. */
    clear() {
      cloud.clear();
    },
    get count() {
      return cloud.count;
    },
    /**
     * Moves the smoke on by `dt` seconds and lights it. `lenses` are the fixtures' lenses that
     * shine: `{ object, colour }`, the lens object (its +Y is the way it faces) and its colour
     * with the brightness in it. `bounds` is where the smoke cannot go (see smokeSim.js) and
     * `ambient` how much light it gets from the room.
     */
    update(dt, { lenses, bounds, ambient }) {
      if (!group.visible) return;
      run(Math.min(dt, 0.1), bounds);

      let lights = 0;
      for (const { object, colour } of lenses) {
        if (lights >= MAX_LIGHTS) break;
        object.getWorldPosition(lensPosition);
        object.getWorldQuaternion(lensQuaternion);
        lensAxis.copy(UP).applyQuaternion(lensQuaternion);
        uniforms.uLightPos.value[lights]?.copy(lensPosition);
        uniforms.uLightDir.value[lights]?.copy(lensAxis);
        uniforms.uLightCol.value[lights]?.set(
          colour.r * LIGHT_GAIN,
          colour.g * LIGHT_GAIN,
          colour.b * LIGHT_GAIN,
        );
        lights++;
      }
      uniforms.uLights.value = lights;
      uniforms.uAmbient.value.setScalar(ambient);
      uniforms.uDensity.value = (settings.density / 100) * OPACITY;
      renderer.getDrawingBufferSize(size);
      // The size of a point on screen: its width in metres, over its distance, in pixels.
      uniforms.uScale.value = size.y * 0.5 * camera.projectionMatrix.elements[5];
    },
  };
}
