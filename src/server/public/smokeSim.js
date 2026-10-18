// The smoke of the simulator's smoke machine: the settings, and a cloud of particles that is
// pushed out of a nozzle, rises while it is warm, hangs and fades. No browser and no three.js
// in here, so that it can have a test; smoke.js draws it.
//
// None of the numbers is measured on a real machine. They are made to look like the thin fog
// of a small hazer or fogger in a room: a jet that slows down within a few metres, a rise
// for the first seconds while the smoke is warm, then a slow settling and drifting about,
// and a cloud that thins as it spreads.

/** The most particles alive at once. The output times the hang time must stay under this. */
export const CAPACITY = 6000;
/** Particles per second at an output of 100 percent. */
export const MAX_RATE = 100;
/** How long a puff lasts, in seconds, at full output. */
export const PUFF_SECONDS = 1.5;

/** The settings of the machine, with the range the sliders get. */
export const SMOKE_RANGES = {
  output: { label: 'Output', min: 0, max: 100, step: 5, unit: '%', start: 50 },
  density: { label: 'Density', min: 5, max: 100, step: 5, unit: '%', start: 40 },
  throw: { label: 'Throw', min: 0.3, max: 4, step: 0.1, unit: ' m/s', start: 2 },
  spread: { label: 'Spread', min: 5, max: 60, step: 5, unit: '°', start: 20 },
  angle: { label: 'Nozzle up', min: 0, max: 90, step: 5, unit: '°', start: 30 },
  lift: { label: 'Rise', min: 0, max: 1, step: 0.05, unit: ' m/s²', start: 0.3 },
  hang: { label: 'Hang time', min: 5, max: 60, step: 5, unit: ' s', start: 25 },
};
export const SMOKE_DEFAULTS = Object.fromEntries(
  Object.entries(SMOKE_RANGES).map(([key, range]) => [key, range.start]),
);

/** Settings from whatever was kept: a number in its range, or the default. */
export function cleanSmoke(raw) {
  const settings = {};
  for (const [key, range] of Object.entries(SMOKE_RANGES)) {
    const value = Number(raw?.[key]);
    settings[key] = Number.isFinite(value)
      ? Math.min(range.max, Math.max(range.min, value))
      : range.start;
  }
  return settings;
}

/** Particles per second for an output in percent. */
export function emissionRate(output) {
  return (Math.min(100, Math.max(0, output)) / 100) * MAX_RATE;
}

/** How many whole particles to make in `dt` seconds, and the fraction to carry to the next. */
export function takeEmission(carry, rate, dt) {
  const total = carry + rate * dt;
  const n = Math.floor(total);
  return { n, carry: total - n };
}

// How the smoke moves.
const DRAG = 0.8; // per second: a jet at 2 m/s goes about 2.5 m
const WARM = 4; // seconds that the smoke is warm enough to rise
const SETTLE = 0.02; // m/s² downwards once it has cooled
const SWIRL = 0.12; // m/s² of slow wandering
const GROW = 3; // a particle is four times as wide at the end of its life
const WALL_BOUNCE = -0.3;

/** How much wider a particle is than at its birth, `phase` being 0 at birth and 1 at its end. */
export function growth(phase) {
  return 1 + GROW * phase;
}

/**
 * A cloud of at most `capacity` particles. The arrays are the particles themselves, so that
 * the drawing can use them as they are; only the first `count` are alive.
 */
export function createCloud({ capacity = CAPACITY, random = Math.random } = {}) {
  const position = new Float32Array(capacity * 3);
  const velocity = new Float32Array(capacity * 3);
  const age = new Float32Array(capacity);
  const life = new Float32Array(capacity);
  const seed = new Float32Array(capacity);
  /** Age as a fraction of the life: 0 at birth, 1 at the end. */
  const phase = new Float32Array(capacity);
  /** The width at birth, in metres. */
  const size = new Float32Array(capacity);

  const cloud = {
    capacity,
    count: 0,
    position,
    velocity,
    age,
    life,
    seed,
    phase,
    size,

    /** Pushes `n` particles out of `origin` along the unit vector `direction`. */
    emit(n, origin, direction, { throw: speed, spread, hang }) {
      // Two directions across the jet, to turn a random angle round it.
      const [dx, dy, dz] = direction;
      const helper = Math.abs(dy) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      let ux = dy * helper[2] - dz * helper[1];
      let uy = dz * helper[0] - dx * helper[2];
      let uz = dx * helper[1] - dy * helper[0];
      const ul = Math.hypot(ux, uy, uz) || 1;
      ux /= ul;
      uy /= ul;
      uz /= ul;
      const vx = dy * uz - dz * uy;
      const vy = dz * ux - dx * uz;
      const vz = dx * uy - dy * ux;
      const widest = Math.cos((spread * Math.PI) / 180);
      for (let k = 0; k < n && cloud.count < capacity; k++) {
        const i = cloud.count++;
        const cosT = 1 - random() * (1 - widest);
        const sinT = Math.sqrt(1 - cosT * cosT);
        const phi = random() * 2 * Math.PI;
        const across = Math.cos(phi) * sinT;
        const around = Math.sin(phi) * sinT;
        const v = speed * (0.7 + 0.6 * random());
        velocity[i * 3] = (dx * cosT + ux * across + vx * around) * v;
        velocity[i * 3 + 1] = (dy * cosT + uy * across + vy * around) * v;
        velocity[i * 3 + 2] = (dz * cosT + uz * across + vz * around) * v;
        position[i * 3] = origin[0] + (random() - 0.5) * 0.04;
        position[i * 3 + 1] = origin[1] + (random() - 0.5) * 0.04;
        position[i * 3 + 2] = origin[2] + (random() - 0.5) * 0.04;
        age[i] = 0;
        life[i] = hang * (0.7 + 0.6 * random());
        seed[i] = random();
        phase[i] = 0;
        size[i] = 0.3 + 0.2 * random();
      }
    },

    /**
     * Moves the cloud on by `dt` seconds. `bounds` says where the smoke cannot go: `floor`
     * and `ceiling` in metres, and `contains(x, z)` for the walls, when there are any.
     */
    step(dt, { lift }, bounds = {}) {
      const floor = bounds.floor ?? 0.02;
      const ceiling = bounds.ceiling ?? Number.POSITIVE_INFINITY;
      const contains = bounds.contains ?? null;
      const keep = Math.exp(-DRAG * dt);
      for (let i = 0; i < cloud.count; ) {
        age[i] += dt;
        if (age[i] >= life[i]) {
          // Dead: the last particle takes its place, and is looked at next.
          const last = --cloud.count;
          if (i !== last) {
            for (const array of [position, velocity]) {
              for (let c = 0; c < 3; c++) array[i * 3 + c] = array[last * 3 + c] ?? 0;
            }
            for (const array of [age, life, seed, phase, size]) array[i] = array[last] ?? 0;
          }
          continue;
        }
        phase[i] = age[i] / life[i];
        const s = seed[i] ?? 0;
        const a = age[i] ?? 0;
        const warm = Math.exp(-a / WARM);
        let vx = velocity[i * 3] ?? 0;
        let vy = velocity[i * 3 + 1] ?? 0;
        let vz = velocity[i * 3 + 2] ?? 0;
        vy += (lift * warm - SETTLE * (1 - warm)) * dt;
        vx += Math.sin(a * 1.7 + s * 37) * SWIRL * dt;
        vz += Math.cos(a * 1.3 + s * 91) * SWIRL * dt;
        vy += Math.sin(a * 1.1 + s * 53) * SWIRL * 0.3 * dt;
        vx *= keep;
        vy *= keep;
        vz *= keep;
        let x = position[i * 3] ?? 0;
        let y = (position[i * 3 + 1] ?? 0) + vy * dt;
        let z = position[i * 3 + 2] ?? 0;
        const nx = x + vx * dt;
        const nz = z + vz * dt;
        if (contains && !contains(nx, nz)) {
          // Against a wall: it stays where it was and turns back a little.
          vx *= WALL_BOUNCE;
          vz *= WALL_BOUNCE;
        } else {
          x = nx;
          z = nz;
        }
        if (y < floor) {
          // Along the floor, slowing down.
          y = floor;
          vy = 0;
          vx *= 0.95;
          vz *= 0.95;
        } else if (y > ceiling) {
          y = ceiling;
          vy = 0;
        }
        position[i * 3] = x;
        position[i * 3 + 1] = y;
        position[i * 3 + 2] = z;
        velocity[i * 3] = vx;
        velocity[i * 3 + 1] = vy;
        velocity[i * 3 + 2] = vz;
        i++;
      }
    },

    /** All the smoke gone at once. */
    clear() {
      cloud.count = 0;
    },
  };
  return cloud;
}
