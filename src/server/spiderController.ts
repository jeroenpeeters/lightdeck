/**
 * Holds what one spider should be doing and keeps the output in step with it.
 *
 * The page changes the state through `update`; every change is encoded with the
 * fixture profile and handed to the output. Browsers hear about it through `state`
 * events and so stay in sync with each other.
 *
 * Three things are chosen apart from each other, one per type of scene, and put together here:
 * a light effect (lights) says how much of each slot of the palette every lens gets, a palette
 * (colour) says what the slots are, and a motion effect (motion) tilts the bars and, for the
 * ones that say `setsMotorSpeed`, sets the motor speed. Any of the three goes with any other. The
 * palette is one of the show: the fixture holds its id and looks it up in the book of palettes,
 * so an edited palette shows at once, and without one it is a single white.
 *
 * While an effect of either kind is chosen and the tempo runs, the engine of the console asks
 * for a frame at every point of the grid of the beat (`render`). The controller has no timer of
 * its own. The light effect sets the colours of the cells and the motion effect the tilts;
 * brightness and strobe stay with the operator, and so do the tilts and the motor speed unless
 * a motion effect is chosen. Rendered frames are not state: browsers get them as `frame`
 * events, only to draw what the fixture shows, and what they get is the frame that was sent.
 *
 * The blackout and the grand master of the console are not state either. They change
 * what goes out and leave what is set: the master scales the dimmer and nothing else.
 *
 * The sub dimmer (`subDimmer`, 0 to 1, 1 at the start; Jeroen, 2026-10-28: every fixture has one in
 * the same place on the tablet page) is the spider's own master, as the `dimmer` of the room is for
 * the lamps: it scales the dimmer on top of the grand master and leaves what is set. It is in the
 * state, so that every screen shows it, and in no scene: a scene or a look neither moves it nor
 * keeps it, so a look that sets the brightness does not undo what the operator turned down.
 */

import { EventEmitter } from 'node:events';
import { EffectClock } from '../engine/effectClock.js';
import { EFFECTS, findEffect, type Rgbw, SPEEDS } from '../engine/effects.js';
import { findMotionEffect, MOTION_EFFECTS } from '../engine/motionEffects.js';
import {
  colourAt,
  FALLBACK_PALETTE,
  isFast,
  PaletteBook,
  paint,
  shownSlots,
} from '../engine/palette.js';
import {
  controlsOf,
  type FixtureProfile,
  type SceneType,
  UNIVERSE_SIZE,
  writeFixture,
} from '../fixtures/profile.js';
import { clamp01 } from '../model/fixture.js';
import type { UniverseOutput } from '../outputs/patch.js';
import { type DmxFixtureController, PatchError, readObject } from './fixture.js';
import type { Tempo } from './tempo.js';

/** How the fixture's cells and motors are arranged. Cell indices are 0-based. */
export interface CellLayout {
  cells: number;
  bars: readonly (readonly number[])[];
  /** Name of the tilt control per bar. */
  tilt: readonly string[];
  /** Colour names; the control of a cell is the colour name followed by the cell number. */
  colours: readonly (keyof Rgbw)[];
  /** How the fixture is built, for the simulator. See `SPIDER_LAYOUT`. */
  side?: readonly ('back' | 'front')[];
  /** Per bar, points of [tilt 0..1, degrees from neutral, positive to the front]. */
  tiltCurve?: readonly (readonly (readonly [number, number])[])[];
  /** Points of [motor speed 0..1, degrees per second], for both bars. */
  motorSpeedCurve?: readonly (readonly [number, number])[];
  aim?: readonly number[];
}

/** A light effect or a motion effect that is chosen, with its speed. */
export interface EffectSettings {
  /** Id of the chosen effect, or null when the operator controls what it would. */
  id: string | null;
  /** Speed of the effect relative to the tempo, one of `SPEEDS`. At 1 it changes per beat. */
  speed: number;
}

/** The palette that colours the light effect. */
export interface ColourSettings {
  /** Id of a palette of the show, or null: then the lenses get a single white. */
  palette: string | null;
  /** How fast the palette cycles, one of `SPEEDS`, or null: then the pace of the palette itself. */
  speed: number | null;
}

/** How far a bar may tilt, as a tilt value from 0 to 1. The bar stays within `min` and `max`. */
export interface TiltLimit {
  min: number;
  max: number;
}

/** What the show says the spider may do: the limits of the tilt, per bar in the order of the layout. */
export interface SpiderLimits {
  tilt: TiltLimit[];
}

export interface SpiderState {
  /** Normalized 0..1 by control name, for level and strobe controls. */
  levels: Record<string, number>;
  /** Raw bytes by control name, for function controls. */
  raw: Record<string, number>;
  /** True while the reset byte is being held. */
  resetting: boolean;
  /** The light effect. */
  effect: EffectSettings;
  /** The motion effect: the bars stay where the tilts are set while it is null. */
  motion: EffectSettings;
  colour: ColourSettings;
  /**
   * The zone: the window of tilt of each bar that the motion effect works inside (an effect's 0
   * is the `min` of the bar and its 100 the `max`), or null: then the swing limits of the show
   * are the window. Hand and scene tilts are not held to it.
   */
  zone: SpiderLimits | null;
  /** The sub dimmer, 0 to 1: the master of this fixture. Part of no scene. */
  subDimmer: number;
  /**
   * The blackout of this fixture alone (Jeroen, 2026-10-28): dark, with everything it is set to kept,
   * as the blackout of the console does for all. Part of no scene. The two do not undo each other.
   */
  blackout: boolean;
}

export interface StatePatch {
  levels?: unknown;
  raw?: unknown;
  effect?: unknown;
  motion?: unknown;
  colour?: unknown;
  zone?: unknown;
  subDimmer?: unknown;
  blackout?: unknown;
}

/** What of the state a change can set and a scene keeps. */
type Look = Pick<SpiderState, 'levels' | 'raw' | 'effect' | 'motion' | 'colour' | 'zone'>;

export interface SpiderOptions {
  profile: FixtureProfile;
  layout: CellLayout;
  output: UniverseOutput;
  /** The tempo of the console, which the effects run on. */
  tempo: Tempo;
  /** The palettes of the show. Without it there are none, and the lenses get a single white. */
  palettes?: PaletteBook;
  /** 0-based universe index on the bridge. */
  universe: number;
  /** 1-based DMX start address of the fixture. */
  address: number;
  /** How long the reset byte is held. The manual asks for 3 seconds. */
  resetHoldMs?: number;
}

/** Controls that a blackout forces to zero. Position and colour are left alone. */
const BLACKOUT_CONTROLS = ['dimmer', 'strobe'];
/** The attribute of the controls that the grand master scales. */
const MASTER_ATTRIBUTE = 'dimmer';
const RESET_CONTROL = 'reset';
/** The control that a motion effect may set when it says `setsMotorSpeed`. */
const MOTOR_SPEED_CONTROL = 'motorSpeed';
const RESET_VALUE = 255;

/** Which type of scene keeps which of the effects, the colour and the zone. */
const KEPT_BY: Record<'effect' | 'motion' | 'colour' | 'zone', SceneType> = {
  effect: 'lights',
  motion: 'motion',
  colour: 'colour',
  zone: 'zone',
};
const EFFECT_KEYS = ['id', 'speed'];
const COLOUR_KEYS = ['palette', 'speed'];

const restEffect = (): EffectSettings => ({ id: null, speed: 1 });
const restColour = (): ColourSettings => ({ palette: null, speed: null });

/** What a frame sets over the state: the colours of the cells, the tilts and the motor speed. */
interface Frame {
  cells?: Rgbw[];
  tilt?: number[];
  motorSpeed?: number;
}

function readSpeed(value: unknown, what: string): number {
  if (typeof value !== 'number' || !SPEEDS.includes(value)) {
    throw new PatchError(`the speed of ${what} must be one of ${SPEEDS.join(', ')}`);
  }
  return value;
}

export class SpiderController extends EventEmitter implements DmxFixtureController {
  readonly profile: FixtureProfile;
  readonly layout: CellLayout;
  readonly universe: number;
  readonly address: number;
  readonly takesPalettes = true;

  private readonly output: UniverseOutput;
  private readonly tempo: Tempo;
  private readonly palettes: PaletteBook;
  private readonly resetHoldMs: number;
  /** Names of the controls that the grand master scales. */
  private readonly dimmers: readonly string[];
  private readonly frame = new Uint8Array(UNIVERSE_SIZE);
  private resetTimer: ReturnType<typeof setTimeout> | undefined;
  /** Keep the beat of the light effect, the motion effect and the palette continuous when a speed changes. */
  private readonly lightClock = new EffectClock();
  private readonly motionClock = new EffectClock();
  private readonly paletteClock = new EffectClock();
  /** The limits of the show. They are put on what goes out, and are no part of the state. */
  private limits: SpiderLimits;
  /** True once the controller was closed: the engine then stops asking it for frames. */
  private disposed = false;

  private state: SpiderState;
  /** The blackout of the console. It is not part of the state of the fixture. */
  private blackout = false;
  /** The grand master of the console, 0 to 1. It is not part of the state either. */
  private master = 1;

  constructor(options: SpiderOptions) {
    super();
    this.profile = options.profile;
    this.layout = options.layout;
    this.output = options.output;
    this.tempo = options.tempo;
    this.palettes = options.palettes ?? new PaletteBook();
    this.limits = this.readLimits(null);
    this.universe = options.universe;
    this.address = options.address;
    this.resetHoldMs = options.resetHoldMs ?? 3500;
    this.dimmers = this.profile.controls
      .filter((control) => control.kind === 'level' && control.attribute === MASTER_ATTRIBUTE)
      .map((control) => control.name);

    const rest = this.rest();
    for (const name of this.cellControls()) {
      if (!(name in rest.levels)) {
        throw new Error(`layout names "${name}", which the profile lacks`);
      }
    }
    this.state = { ...rest, resetting: false, subDimmer: 1, blackout: false };

    // Fails here, at startup, when the fixture does not fit at this address.
    this.send();
  }

  getState(): SpiderState {
    return {
      levels: { ...this.state.levels },
      raw: { ...this.state.raw },
      resetting: this.state.resetting,
      effect: { ...this.state.effect },
      motion: { ...this.state.motion },
      colour: { ...this.state.colour },
      zone: this.state.zone === null ? null : { tilt: this.state.zone.tilt.map((t) => ({ ...t })) },
      subDimmer: this.state.subDimmer,
      blackout: this.state.blackout,
    };
  }

  /**
   * The arrangement of the cells, and the light effects, the motion effects and their speeds to
   * choose from.
   */
  describe(): Record<string, unknown> {
    return {
      layout: this.layout,
      speeds: SPEEDS,
      effects: EFFECTS.map(({ id, name, description, slots }) => ({
        id,
        name,
        description,
        slots,
      })),
      motionEffects: MOTION_EFFECTS.map(({ id, name, description, setsMotorSpeed }) => ({
        id,
        name,
        description,
        setsMotorSpeed: setsMotorSpeed === true,
      })),
    };
  }

  /**
   * The limits as the show file has them: `{ tilt: [{ min, max }, ...] }`, a limit per bar in
   * the order of the layout, from 0 to 1 and with `min` below `max`. A bar or a key that is
   * left out is not limited. `null` is no limits at all. Throws a `PatchError`.
   */
  readLimits(value: unknown): SpiderLimits {
    return this.readWindows(value, 'the limits of the spider', 'limit');
  }

  /**
   * Windows of tilt per bar, as the limits of the show and the zones are written: `{ tilt: [{ min,
   * max }, ...] }`. A bar that is left out has the whole of the tilt.
   */
  private readWindows(value: unknown, what: string, name: string): SpiderLimits {
    const bars = this.layout.bars.length;
    const free = (): TiltLimit => ({ min: 0, max: 1 });
    const limits: SpiderLimits = { tilt: Array.from({ length: bars }, free) };
    if (value === null || value === undefined) return limits;
    const given = readObject(value, what, ['tilt']);
    if (given.tilt === undefined) return limits;
    if (!Array.isArray(given.tilt) || given.tilt.length > bars) {
      throw new PatchError(`"tilt" must list a ${name} for each of the ${bars} bars at most`);
    }
    given.tilt.forEach((each: unknown, bar: number) => {
      const where = `the tilt ${name} of bar ${bar + 1}`;
      const { min = 0, max = 1 } = readObject(each, where, ['min', 'max']);
      if (typeof min !== 'number' || typeof max !== 'number' || !(min >= 0 && max <= 1)) {
        throw new PatchError(`${where} must be a min and a max between 0 and 1`);
      }
      if (!(min < max)) throw new PatchError(`${where} must have a min below its max`);
      limits.tilt[bar] = { min, max };
    });
    return limits;
  }

  /** Puts the limits of the show on what goes out. Without any the bars are free. */
  setLimits(value: unknown): void {
    const limits = this.readLimits(value);
    if (JSON.stringify(limits) === JSON.stringify(this.limits)) return;
    this.limits = limits;
    this.emit('wants');
    this.push();
  }

  /** The fixture's bytes as they are being sent, channel 1 first. */
  getDmx(): number[] {
    return Array.from(
      this.frame.subarray(this.address - 1, this.address - 1 + this.profile.footprint),
    );
  }

  /** True while an effect of either kind is chosen and the tempo runs: the engine then asks for frames. */
  wantsFrames(): boolean {
    const { effect, motion } = this.state;
    return !this.disposed && (effect.id !== null || motion.id !== null) && this.tempo.isRunning();
  }

  /**
   * Makes the frame for the moment `at`, on the clock of the tempo, hands it to the patch and
   * tells the browsers what it is. The engine calls this on the grid of the beat.
   */
  render(at: number): void {
    this.send(at);
    this.emit('frame', this.getDmx(), this.tempo.beatAt(at));
  }

  /**
   * Applies a partial change. Nothing is applied when any part of the patch is
   * invalid. `origin` is passed on with the event so a browser can skip its own echo.
   */
  update(change: unknown, origin?: string): void {
    const next = this.apply(this.state, change, 'a change of the spider');
    const subDimmer = this.readSubDimmer(change);
    const blackout = this.readBlackout(change);
    this.state = { ...this.state, ...next, subDimmer, blackout };
    this.emit('wants');
    this.push(origin);
  }

  /**
   * What a scene of this type keeps: the levels that are not 0 and the function channels
   * that are not at rest among the controls of the type, and the effect of the type when one
   * is chosen. Lights keeps the light effect with its speed, motion keeps the motion effect with
   * its speed, and colour keeps the palette that is chosen, with the speed when it is set.
   */
  snapshot(type: SceneType): Record<string, unknown> {
    const rest = this.rest();
    const own = new Set(controlsOf(this.profile, type));
    const levels: Record<string, number> = {};
    const raw: Record<string, number> = {};
    for (const [name, value] of Object.entries(this.state.levels)) {
      if (own.has(name) && value !== rest.levels[name]) levels[name] = value;
    }
    for (const [name, value] of Object.entries(this.state.raw)) {
      if (own.has(name) && name !== RESET_CONTROL && value !== rest.raw[name]) raw[name] = value;
    }
    const { effect, motion, colour, zone } = this.state;
    return {
      ...(Object.keys(levels).length > 0 ? { levels } : {}),
      ...(type === 'zone' && zone !== null
        ? { zone: { tilt: zone.tilt.map(({ min, max }) => ({ min, max })) } }
        : {}),
      ...(Object.keys(raw).length > 0 ? { raw } : {}),
      ...(type === 'lights' && effect.id !== null ? { effect: { ...effect } } : {}),
      ...(type === 'motion' && motion.id !== null ? { motion: { ...motion } } : {}),
      ...(type === 'colour' && colour.palette !== null
        ? {
            colour: {
              palette: colour.palette,
              ...(colour.speed === null ? {} : { speed: colour.speed }),
            },
          }
        : {}),
    };
  }

  check(type: SceneType, part: unknown): void {
    this.apply(this.rest(), part ?? {}, 'the spider in a scene', type);
  }

  /**
   * Sets what the type keeps, from rest and the part, and leaves the rest of the state.
   * A reset that is going on goes on: it is not part of a look.
   */
  recall(type: SceneType, part: unknown, origin?: string): void {
    const look = this.apply(this.rest(), part ?? {}, 'the spider in a scene', type);
    const own = controlsOf(this.profile, type);
    const levels = { ...this.state.levels };
    const raw = { ...this.state.raw };
    for (const name of own) {
      if (name in look.levels) levels[name] = look.levels[name] ?? 0;
      if (name in look.raw) raw[name] = look.raw[name] ?? 0;
    }
    this.state = {
      ...this.state,
      levels,
      raw,
      effect: type === 'lights' ? look.effect : this.state.effect,
      motion: type === 'motion' ? look.motion : this.state.motion,
      colour: type === 'colour' ? look.colour : this.state.colour,
      zone: type === 'zone' ? look.zone : this.state.zone,
    };
    this.emit('wants');
    this.push(origin);
  }

  /** The fixture with nothing set: dark, its function channels at rest, no effect, no palette. */
  private rest(): Look {
    const levels: Record<string, number> = {};
    const raw: Record<string, number> = {};
    for (const control of this.profile.controls) {
      if (control.kind === 'function') raw[control.name] = control.idle;
      else levels[control.name] = 0;
    }
    return {
      levels,
      raw,
      effect: restEffect(),
      motion: restEffect(),
      colour: restColour(),
      zone: null,
    };
  }

  /**
   * `base` with the change on top. Throws when any part of the change is invalid. With `only`
   * the change may name properties of that type of scene and no others.
   */
  private apply(base: Look, change: unknown, what: string, only?: SceneType): Look {
    const patch = readObject(change, what, [
      'levels',
      'raw',
      'effect',
      'motion',
      'colour',
      'zone',
      'subDimmer',
      'blackout',
    ]) as StatePatch;
    if (only !== undefined && patch.subDimmer !== undefined) {
      throw new PatchError('the "subDimmer" of the spider is part of no scene');
    }
    if (only !== undefined && patch.blackout !== undefined) {
      throw new PatchError('the "blackout" of the spider is part of no scene');
    }
    const levels = { ...base.levels };
    const raw = { ...base.raw };
    const own = only === undefined ? undefined : new Set(controlsOf(this.profile, only));
    const owned = (name: string) => {
      if (own && only && !own.has(name))
        throw new PatchError(`"${name}" is not part of a ${only} scene`);
    };
    for (const key of ['effect', 'motion', 'colour', 'zone'] as const) {
      if (only !== undefined && patch[key] !== undefined && KEPT_BY[key] !== only) {
        throw new PatchError(`"${key}" is not part of a ${only} scene`);
      }
    }

    const newLevels = patch.levels === undefined ? {} : readObject(patch.levels, 'levels');
    const newRaw = patch.raw === undefined ? {} : readObject(patch.raw, 'raw');
    for (const [name, value] of Object.entries(newLevels)) {
      if (!(name in base.levels)) throw new PatchError(`"${name}" is not a level of this fixture`);
      owned(name);
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new PatchError(`level "${name}" must be a number between 0 and 1`);
      }
      levels[name] = clamp01(value);
    }
    for (const [name, value] of Object.entries(newRaw)) {
      if (!(name in base.raw)) throw new PatchError(`"${name}" is not a function channel`);
      if (name === RESET_CONTROL) throw new PatchError('use the reset action to reset the fixture');
      owned(name);
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
        throw new PatchError(`"${name}" must be a whole number between 0 and 255`);
      }
      raw[name] = value;
    }
    return {
      levels,
      raw,
      effect: this.readEffect(base.effect, patch.effect, 'effect'),
      motion: this.readEffect(base.motion, patch.motion, 'motion'),
      colour: this.readColour(base.colour, patch.colour),
      zone: this.readZone(base.zone, patch.zone),
    };
  }

  /** The sub dimmer with the change on top; the change has been read as an object already. */
  private readSubDimmer(change: unknown): number {
    const { subDimmer } = change as StatePatch;
    if (subDimmer === undefined) return this.state.subDimmer;
    if (typeof subDimmer !== 'number' || !Number.isFinite(subDimmer)) {
      throw new PatchError('the subDimmer must be a number between 0 and 1');
    }
    return clamp01(subDimmer);
  }

  /** The blackout of this fixture with the change on top; the change has been read as an object already. */
  private readBlackout(change: unknown): boolean {
    const { blackout } = change as StatePatch;
    if (blackout === undefined) return this.state.blackout;
    if (typeof blackout !== 'boolean') throw new PatchError('the blackout must be true or false');
    return blackout;
  }

  /** The zone with the change on top: `null` takes it away, an object sets the windows of the bars. */
  private readZone(current: SpiderLimits | null, change: unknown): SpiderLimits | null {
    if (change === undefined) return current;
    if (change === null) return null;
    return this.readWindows(change, 'the zone of the spider', 'zone window');
  }

  act(name: string, origin?: string): void {
    if (name !== 'reset') throw new PatchError(`the spider has nothing called "${name}"`);
    this.resetFixture(origin);
  }

  setBlackout(blackout: boolean): void {
    if (blackout === this.blackout) return;
    this.blackout = blackout;
    this.push();
  }

  /** Dims what goes out. The brightness that is set stays what it is. */
  setMaster(level: number): void {
    const master = clamp01(level);
    if (master === this.master) return;
    this.master = master;
    this.push();
  }

  /** The spider may stay as it is when lightdeck stops. */
  darken(): void {}

  /** Holds the reset byte for the time the fixture needs, then releases it. */
  resetFixture(origin?: string): void {
    if (!(RESET_CONTROL in this.state.raw))
      throw new PatchError('this fixture has no reset channel');
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.state = {
      ...this.state,
      resetting: true,
      raw: { ...this.state.raw, [RESET_CONTROL]: RESET_VALUE },
    };
    this.push(origin);
    this.resetTimer = setTimeout(() => {
      this.resetTimer = undefined;
      this.state = {
        ...this.state,
        resetting: false,
        raw: { ...this.state.raw, [RESET_CONTROL]: 0 },
      };
      this.push();
    }, this.resetHoldMs);
  }

  close(): void {
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.resetTimer = undefined;
    // The engine stops asking for frames from a spider that is closed.
    this.disposed = true;
    this.emit('wants');
    this.removeAllListeners();
  }

  /** The light effect (`effect`) or the motion effect (`motion`) with the change on top. */
  private readEffect(
    current: EffectSettings,
    change: unknown,
    kind: 'effect' | 'motion',
  ): EffectSettings {
    if (change === undefined) return current;
    const patch = readObject(change, kind, EFFECT_KEYS);
    const effect: EffectSettings = { ...current };
    if (patch.id !== undefined) {
      const list = kind === 'effect' ? EFFECTS : MOTION_EFFECTS;
      const find = kind === 'effect' ? findEffect : findMotionEffect;
      if (patch.id !== null && (typeof patch.id !== 'string' || !find(patch.id))) {
        throw new PatchError(
          `unknown ${kind === 'effect' ? 'effect' : 'motion effect'} "${String(patch.id)}", choose one of ${list.map((e) => e.id).join(', ')}`,
        );
      }
      effect.id = patch.id;
    }
    if (patch.speed !== undefined) {
      effect.speed = readSpeed(patch.speed, kind === 'effect' ? 'an effect' : 'a motion effect');
    }
    return effect;
  }

  private readColour(current: ColourSettings, change: unknown): ColourSettings {
    if (change === undefined) return current;
    const patch = readObject(change, 'colour', COLOUR_KEYS);
    const colour: ColourSettings = { ...current };
    if (patch.palette !== undefined) {
      if (patch.palette !== null) {
        if (typeof patch.palette !== 'string' || !this.palettes.get(patch.palette)) {
          const known = this.palettes.list().map((palette) => palette.id);
          throw new PatchError(
            `unknown palette "${String(patch.palette)}"${known.length > 0 ? `, choose one of ${known.join(', ')}` : ''}`,
          );
        }
      }
      colour.palette = patch.palette;
    }
    // Null goes back to the pace of the palette itself.
    if (patch.speed !== undefined) {
      colour.speed = patch.speed === null ? null : readSpeed(patch.speed, 'a palette');
    }
    return colour;
  }

  private cellControls(): string[] {
    const names: string[] = [...this.layout.tilt];
    for (let cell = 1; cell <= this.layout.cells; cell++) {
      for (const colour of this.layout.colours) names.push(`${colour}${cell}`);
    }
    return names;
  }

  /** What the chosen effects set at this moment, or nothing while the tempo is idle. */
  private renderEffects(at: number): Frame | undefined {
    const { effect, motion, colour } = this.state;
    const light = effect.id === null ? undefined : findEffect(effect.id);
    const moving = motion.id === null ? undefined : findMotionEffect(motion.id);
    if (!light && !moving) return undefined;
    // An idle effect drives nothing: the fixture shows what is set under it. It stays chosen.
    if (!this.tempo.isRunning()) return undefined;
    const { bpm, rate } = this.tempo.getState();
    // The beat of the output, a little ahead of the beat itself by the lead. Its speed is
    // limited, and the effect goes on from where it is when the speed changes.
    const beat = this.tempo.outputBeat(at);
    const epoch = this.tempo.epoch;
    const frame: Frame = {};

    if (light) {
      const palette = this.palettes.get(colour.palette) ?? FALLBACK_PALETTE;
      const read = this.lightClock.read({
        beat,
        bpm,
        wanted: effect.speed * rate,
        epoch,
        key: light.id,
      });
      let step = 0;
      let fast = isFast(bpm, read.speed);
      if (palette.mode === 'cycle' && palette.colours.length > 1) {
        const cycle = this.paletteClock.read({
          beat,
          bpm,
          wanted: (colour.speed ?? palette.speed) * rate,
          epoch,
          key: palette.id,
        });
        step = cycle.beat;
        fast ||= isFast(bpm, cycle.speed);
      }
      const { levels } = light.render({
        beat: read.beat,
        cells: this.layout.cells,
        bars: this.layout.bars,
        slots: shownSlots(palette),
        filled: Array.from(
          { length: shownSlots(palette) },
          (_, slot) => colourAt(palette, slot, Math.floor(step)) !== null,
        ),
      });
      // A fast effect or a fast cycle changes hard: no fade between the colours.
      frame.cells = paint(levels, fast ? { ...palette, change: 'step' } : palette, step);
    }

    if (moving) {
      const read = this.motionClock.read({
        beat,
        bpm,
        wanted: motion.speed * rate,
        epoch,
        key: moving.id,
      });
      const moved = moving.render({
        beat: read.beat,
        bpm: bpm * read.speed,
        bars: this.layout.bars.length,
        // The effect works inside the zone when one is chosen, and inside the swing limits of
        // the show when not: mapped into the window and not cut off by it.
        motion: {
          tilt: this.layout.tiltCurve,
          motorSpeed: this.layout.motorSpeedCurve,
          limits: (this.state.zone ?? this.limits).tilt,
        },
      });
      frame.tilt = moved.tilt;
      if (moved.motorSpeed !== undefined) frame.motorSpeed = moved.motorSpeed;
    }
    return frame;
  }

  private outputValues(at: number) {
    const levels = { ...this.state.levels };
    const frame = this.renderEffects(at);
    if (frame) {
      frame.cells?.forEach((colour, index) => {
        for (const part of this.layout.colours) {
          levels[`${part}${index + 1}`] = clamp01(colour[part]);
        }
      });
      frame.tilt?.forEach((tilt, bar) => {
        const name = this.layout.tilt[bar];
        if (name !== undefined) levels[name] = clamp01(tilt);
      });
      if (frame.motorSpeed !== undefined) levels[MOTOR_SPEED_CONTROL] = clamp01(frame.motorSpeed);
    }
    // Whatever sets a tilt by hand or in a scene, the bar stays within the swing limits of the show.
    // A motion effect works inside its window already (the zone, or those limits) and is not cut
    // off here: a zone may lie outside the limits, and then it is the zone that is wanted.
    this.layout.tilt.forEach((name, bar) => {
      const limit = this.limits.tilt[bar];
      if (limit && name in levels && frame?.tilt === undefined) {
        levels[name] = Math.min(limit.max, Math.max(limit.min, levels[name] ?? 0));
      }
    });
    for (const name of this.dimmers) {
      levels[name] = (levels[name] ?? 0) * this.master * this.state.subDimmer;
    }
    if (this.blackout || this.state.blackout) {
      for (const name of BLACKOUT_CONTROLS) if (name in levels) levels[name] = 0;
    }
    return { levels, raw: this.state.raw };
  }

  private send(at: number = this.tempo.now()): void {
    writeFixture(this.frame, this.address, this.profile, this.outputValues(at));
    this.output.setUniverse(this.universe, this.frame);
  }

  private push(origin?: string): void {
    this.send();
    this.emit('state', this.getState(), origin);
  }
}
