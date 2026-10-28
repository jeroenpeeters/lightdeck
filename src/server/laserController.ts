/**
 * Holds what the laser should be doing and keeps the output in step with it.
 *
 * Every channel of the laser is a byte with ranges, so the state is one raw byte per
 * control. The page and the CLI work out the bytes from the ranges in the profile.
 *
 * A laser of this power must go dark when asked. The `gate` control keeps it closed
 * while it rests at its idle value, and the blackout of the console holds it there
 * whatever the state says. So does the grand master at 0: the laser has no dimmer, so
 * it is closed at 0 and shows what it is set to above 0. It starts closed, and `darken`
 * closes it for good when lightdeck stops: a change that comes after it is kept, and
 * does not reach the fixture.
 *
 * Like the spider it has two kinds of effects that are chosen apart and go together: an effect
 * of the lights (which pattern, in what colour) and an effect of the motion (size, place,
 * rotation). The laser does not follow the palettes of the show. It has a colour setting of its
 * own, up to three single colours, which its colour chase steps through, and which is kept with
 * what it does, in a scene of lights.
 *
 * While an effect is chosen, the laser is in the mode the effects count in and the tempo
 * runs, the engine of the console asks for a frame at every point of the grid of the beat
 * (`render`). The controller has no timer of its own. The effects set the channels they
 * drive, the others stay with the operator. An effect never opens the laser: the gate is
 * not for effects to drive. Rendered frames are not state: browsers get them as `frame`
 * events, to draw what is being sent, and what they get is the frame that was sent.
 */

import { EventEmitter } from 'node:events';
import { EffectClock } from '../engine/effectClock.js';
import { SPEEDS } from '../engine/effects.js';
import type { LaserEffect } from '../engine/laserEffects.js';
import {
  controlsOf,
  type FixtureProfile,
  findControl,
  findRange,
  rangeAt,
  type SceneType,
  UNIVERSE_SIZE,
  writeFixture,
} from '../fixtures/profile.js';
import { clamp01 } from '../model/fixture.js';
import type { UniverseOutput } from '../outputs/patch.js';
import { type DmxFixtureController, PatchError, readObject } from './fixture.js';
import type { Tempo } from './tempo.js';

export interface LaserEffectSettings {
  /** Id of the chosen effect, or null when the operator sets every channel. */
  id: string | null;
  /** Speed of the effect relative to the tempo, one of `SPEEDS`. At 1 it changes per beat. */
  speed: number;
}

export interface LaserState {
  /** Raw bytes by control name. */
  raw: Record<string, number>;
  /** The effect of the lights. */
  effect: LaserEffectSettings;
  /** The effect of the motion. */
  motion: LaserEffectSettings;
  /** The colour setting: bytes of the single colours, in order, up to the most it can have. */
  colours: number[];
  /**
   * The blackout of this laser alone (Jeroen, 2026-10-28): closed, with everything it is set to
   * kept, as the blackout of the console does for all. Part of no scene.
   */
  blackout: boolean;
}

export interface LaserPatch {
  raw?: unknown;
  effect?: unknown;
  motion?: unknown;
  colours?: unknown;
  blackout?: unknown;
}

/** What of the state a change can set: all of it but the blackout. A scene keeps the part of its type. */
type Look = Omit<LaserState, 'blackout'>;

/** Which type of scene keeps which of the effects and the colour setting. */
const KEPT_BY: Record<'effect' | 'motion' | 'colours', SceneType> = {
  effect: 'lights',
  motion: 'motion',
  colours: 'lights',
};

/** The effects of a laser, and the range of the gate in which they count. */
export interface LaserEffects {
  /** The effects of the lights. */
  list: readonly LaserEffect[];
  /** The effects of the motion. */
  motion?: readonly LaserEffect[];
  /** Key of a range of the gate, such as `manual`. */
  mode: string;
}

/** The colour setting: which control it sets, from which range, and how many colours at most. */
export interface LaserColourSetting {
  control: string;
  range: string;
  max: number;
}

export interface LaserOptions {
  profile: FixtureProfile;
  /** Name of the control that keeps the laser closed while it is at its idle value. */
  gate: string;
  output: UniverseOutput;
  /** The tempo of the console, which the effects run on. */
  tempo: Tempo;
  /** Without effects the laser is set by hand only. */
  effects?: LaserEffects;
  /** Without it the laser has no colour setting of its own. */
  colourSetting?: LaserColourSetting;
  /** 0-based universe index on the bridge. */
  universe: number;
  /** 1-based DMX start address of the fixture. */
  address: number;
}

export class LaserController extends EventEmitter implements DmxFixtureController {
  readonly profile: FixtureProfile;
  readonly gate: string;
  readonly universe: number;
  readonly address: number;
  /** The laser has colours of its own and does not follow the palettes of the show. */
  readonly takesPalettes = false;

  private readonly output: UniverseOutput;
  private readonly tempo: Tempo;
  private readonly effects: readonly LaserEffect[];
  private readonly motionEffects: readonly LaserEffect[];
  private readonly effectsMode: string | undefined;
  private readonly colourSetting: LaserColourSetting | undefined;
  private readonly frame = new Uint8Array(UNIVERSE_SIZE);
  private readonly closed: number;
  /** Keep the beat of the effect of the lights and the one of the motion continuous when a speed changes. */
  private readonly effectClock = new EffectClock();
  private readonly motionClock = new EffectClock();
  /** True once the controller was closed: the engine then stops asking it for frames. */
  private disposed = false;
  private state: Look;
  /** The blackout of this laser alone. It is in the state the page gets, and in no scene. */
  private own = false;
  /** The blackout of the console. It is not part of the state of the fixture. */
  private blackout = false;
  /** The grand master of the console, 0 to 1. It is not part of the state either. */
  private master = 1;
  /** True from the moment lightdeck stops. Nothing opens the laser after that. */
  private stopped = false;

  constructor(options: LaserOptions) {
    super();
    this.profile = options.profile;
    this.gate = options.gate;
    this.output = options.output;
    this.tempo = options.tempo;
    this.effects = options.effects?.list ?? [];
    this.motionEffects = options.effects?.motion ?? [];
    this.effectsMode = options.effects?.mode;
    this.colourSetting = options.colourSetting;
    this.universe = options.universe;
    this.address = options.address;

    for (const control of this.profile.controls) {
      if (control.kind !== 'function') {
        throw new Error(`${this.profile.id}: "${control.name}" is not a function control`);
      }
    }
    const rest = this.rest();
    const closed = rest.raw[this.gate];
    if (closed === undefined) {
      throw new Error(`${this.profile.id} has no control "${this.gate}" to close the laser with`);
    }
    this.closed = closed;
    this.checkEffects();
    this.state = rest;

    // Fails here, at startup, when the fixture does not fit at this address.
    this.send();
  }

  getState(): LaserState {
    return {
      raw: { ...this.state.raw },
      effect: { ...this.state.effect },
      motion: { ...this.state.motion },
      colours: [...this.state.colours],
      blackout: this.own,
    };
  }

  /**
   * The control that opens and closes the laser, the effects of the lights and of the motion
   * and their speeds there are to choose from, the range of the gate in which the effects count,
   * and the colour setting.
   */
  describe(): Record<string, unknown> {
    const list = (effects: readonly LaserEffect[]) =>
      effects.map(({ id, name, description, drives }) => ({ id, name, description, drives }));
    return {
      gate: this.gate,
      speeds: SPEEDS,
      effects: list(this.effects),
      motionEffects: list(this.motionEffects),
      effectsIn: this.effectsMode ?? null,
      colourSetting: this.colourSetting ? { ...this.colourSetting, ...this.colourBytes() } : null,
    };
  }

  /** The fixture's bytes as they are being sent, channel 1 first. */
  getDmx(): number[] {
    return Array.from(
      this.frame.subarray(this.address - 1, this.address - 1 + this.profile.footprint),
    );
  }

  /**
   * True while an effect shows and the tempo runs: the engine then asks for frames. A laser
   * that was darkened for good wants none.
   */
  wantsFrames(): boolean {
    return (
      !this.disposed &&
      !this.stopped &&
      this.tempo.isRunning() &&
      (this.showing('effect') !== undefined || this.showing('motion') !== undefined)
    );
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
    const look = this.apply(this.state, change, 'a change of the laser');
    const { blackout } = change as LaserPatch;
    if (blackout !== undefined && typeof blackout !== 'boolean') {
      throw new PatchError('the blackout must be true or false');
    }
    this.state = look;
    if (blackout !== undefined) this.own = blackout;
    this.emit('wants');
    this.push(origin);
  }

  /**
   * The channels of this type that are not at rest, and the chosen effect of the type. Lights
   * has the mode, so it is what opens the laser, and the colour setting is kept with it. The
   * laser has no palette, so a scene of colour keeps nothing of it.
   */
  snapshot(type: SceneType): Record<string, unknown> {
    const rest = this.rest();
    const own = new Set(controlsOf(this.profile, type));
    const raw: Record<string, number> = {};
    for (const [name, value] of Object.entries(this.state.raw)) {
      if (own.has(name) && value !== rest.raw[name]) raw[name] = value;
    }
    const { effect, motion, colours } = this.state;
    return {
      ...(Object.keys(raw).length > 0 ? { raw } : {}),
      ...(type === 'lights' && effect.id !== null ? { effect: { ...effect } } : {}),
      ...(type === 'lights' && colours.length > 0 ? { colours: [...colours] } : {}),
      ...(type === 'motion' && motion.id !== null ? { motion: { ...motion } } : {}),
    };
  }

  check(type: SceneType, part: unknown): void {
    this.apply(this.rest(), part ?? {}, 'the laser in a scene', type);
  }

  /**
   * Sets what the type keeps, from rest and the part, and leaves the rest of the state. A
   * scene of lights may open the laser, which an effect may not: recalling one is something
   * the operator does, or a sequence the operator started.
   */
  recall(type: SceneType, part: unknown, origin?: string): void {
    const look = this.apply(this.rest(), part ?? {}, 'the laser in a scene', type);
    // A zone is about the tilt of bars: the laser has none, so there is nothing to set.
    if (type === 'zone') return;
    const raw = { ...this.state.raw };
    for (const name of controlsOf(this.profile, type)) raw[name] = look.raw[name] ?? 0;
    this.state = {
      raw,
      effect: type === 'lights' ? look.effect : this.state.effect,
      motion: type === 'motion' ? look.motion : this.state.motion,
      colours: type === 'lights' ? look.colours : this.state.colours,
    };
    this.emit('wants');
    this.push(origin);
  }

  /** The laser with nothing set: closed, every channel at rest, no effect, no colours of its own. */
  private rest(): Look {
    const raw: Record<string, number> = {};
    for (const control of this.profile.controls) {
      if (control.kind === 'function') raw[control.name] = control.idle;
    }
    return {
      raw,
      effect: { id: null, speed: 1 },
      motion: { id: null, speed: 1 },
      colours: [],
    };
  }

  /**
   * `base` with the change on top. Throws when any part of the change is invalid. With `only`
   * the change may name properties of that type of scene and no others.
   */
  private apply(base: Look, change: unknown, what: string, only?: SceneType): Look {
    const patch = readObject(change, what, [
      'raw',
      'effect',
      'motion',
      'colours',
      'blackout',
    ]) as LaserPatch;
    if (only !== undefined && patch.blackout !== undefined) {
      throw new PatchError('the "blackout" of the laser is part of no scene');
    }
    const raw = { ...base.raw };
    for (const key of ['effect', 'motion', 'colours'] as const) {
      if (only !== undefined && patch[key] !== undefined && KEPT_BY[key] !== only) {
        throw new PatchError(`"${key}" is not part of a ${only} scene`);
      }
    }
    const own = only === undefined ? undefined : new Set(controlsOf(this.profile, only));
    const newRaw = patch.raw === undefined ? {} : readObject(patch.raw, 'raw');
    for (const [name, value] of Object.entries(newRaw)) {
      if (!(name in base.raw)) throw new PatchError(`"${name}" is not a channel of the laser`);
      if (own && !own.has(name)) throw new PatchError(`"${name}" is not part of a ${only} scene`);
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
        throw new PatchError(`"${name}" must be a whole number between 0 and 255`);
      }
      raw[name] = value;
    }
    return {
      raw,
      effect: this.readEffect(base.effect, patch.effect, 'effect'),
      motion: this.readEffect(base.motion, patch.motion, 'motion'),
      colours: this.readColours(base.colours, patch.colours),
    };
  }

  act(name: string): void {
    throw new PatchError(`the laser has nothing called "${name}"`);
  }

  /** Closes the laser, or lets it show again what the state says. */
  setBlackout(blackout: boolean): void {
    if (blackout === this.blackout) return;
    this.blackout = blackout;
    this.push();
  }

  /** Closes the laser at 0. Above 0 it shows what the state says: it has no dimmer. */
  setMaster(level: number): void {
    const master = clamp01(level);
    if (master === this.master) return;
    this.master = master;
    this.push();
  }

  /**
   * Closes the laser for good. It forgets the mode, and a change, a scene, the master or
   * the blackout that comes after this does not open it: the bridge holds the last frame
   * it got, and a request that was under way is still handled while lightdeck stops.
   */
  darken(): void {
    this.stopped = true;
    this.state = { ...this.state, raw: { ...this.state.raw, [this.gate]: this.closed } };
    this.emit('wants');
    this.push();
  }

  close(): void {
    // The engine stops asking for frames from a laser that is closed.
    this.disposed = true;
    this.emit('wants');
    this.removeAllListeners();
  }

  /** An effect may drive any control of the laser but the one that opens it. */
  private checkEffects(): void {
    const all = [...this.effects, ...this.motionEffects];
    if (all.length > 0) {
      const gate = findControl(this.profile, this.gate);
      const mode = this.effectsMode;
      const open = gate?.kind === 'function' ? gate.ranges.find((r) => r.key === mode) : undefined;
      if (!open || (this.closed >= open.from && this.closed <= open.to)) {
        throw new Error(
          `${this.profile.id}: effects need a range "${mode}" of "${this.gate}" that opens the laser`,
        );
      }
    }
    for (const effect of all) {
      for (const name of effect.drives) {
        if (name === this.gate || !findControl(this.profile, name)) {
          throw new Error(`${this.profile.id}: the effect "${effect.id}" cannot drive "${name}"`);
        }
      }
    }
    if (this.colourSetting) {
      const { control, range } = this.colourSetting;
      const found = findControl(this.profile, control);
      if (found?.kind !== 'function' || !findRange(found, range)) {
        throw new Error(
          `${this.profile.id}: the colour setting needs a range "${range}" of "${control}"`,
        );
      }
    }
  }

  /** From and to of the range the colour setting takes its bytes from. */
  private colourBytes(): { from: number; to: number } | Record<string, never> {
    if (!this.colourSetting) return {};
    const found = findControl(this.profile, this.colourSetting.control);
    const range =
      found?.kind === 'function' ? findRange(found, this.colourSetting.range) : undefined;
    return range ? { from: range.from, to: range.to } : {};
  }

  /** The effect of the lights (`effect`) or the one of the motion (`motion`) with the change on top. */
  private readEffect(
    current: LaserEffectSettings,
    change: unknown,
    kind: 'effect' | 'motion',
  ): LaserEffectSettings {
    if (change === undefined) return current;
    const { id, speed } = readObject(change, kind, ['id', 'speed']);
    const list = kind === 'effect' ? this.effects : this.motionEffects;
    const effect = { ...current };
    if (id !== undefined) {
      if (id !== null && !list.some((each) => each.id === id)) {
        throw new PatchError(
          `unknown ${kind === 'effect' ? 'effect' : 'motion effect'} "${String(id)}", choose one of ${list.map((e) => e.id).join(', ')}`,
        );
      }
      effect.id = id as string | null;
    }
    if (speed !== undefined) {
      if (typeof speed !== 'number' || !SPEEDS.includes(speed)) {
        throw new PatchError(`the speed of an effect must be one of ${SPEEDS.join(', ')}`);
      }
      effect.speed = speed;
    }
    return effect;
  }

  /** The colour setting with the change on top: a whole list of bytes of the single colours. */
  private readColours(current: number[], change: unknown): number[] {
    if (change === undefined) return current;
    if (!this.colourSetting) throw new PatchError('this laser has no colour setting');
    const { max } = this.colourSetting;
    if (!Array.isArray(change)) {
      throw new PatchError(`"colours" must be a list of ${max} colours at most`);
    }
    if (change.length > max) throw new PatchError(`the laser can have ${max} colours at most`);
    const { from, to } = this.colourBytes() as { from: number; to: number };
    return change.map((value) => {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < from || value > to) {
        throw new PatchError(`a colour must be a whole number from ${from} to ${to}`);
      }
      return value;
    });
  }

  /** The chosen effect of the lights or of the motion, when the laser is in the mode in which effects count. */
  private showing(kind: 'effect' | 'motion'): LaserEffect | undefined {
    const { id } = this.state[kind];
    if (id === null) return undefined;
    const gate = findControl(this.profile, this.gate);
    if (gate?.kind !== 'function') return undefined;
    if (rangeAt(this.profile, gate, this.state.raw)?.key !== this.effectsMode) return undefined;
    return (kind === 'effect' ? this.effects : this.motionEffects).find((each) => each.id === id);
  }

  private outputValues(at: number) {
    const raw = { ...this.state.raw };
    // An idle effect drives nothing, and does not open or close the laser: the laser shows
    // what it is set to. The engine asks again when the tempo runs, so the effect is back.
    if (this.tempo.isRunning()) {
      const { bpm, rate } = this.tempo.getState();
      for (const kind of ['effect', 'motion'] as const) {
        const effect = this.showing(kind);
        if (!effect) continue;
        // The beat of the output, a little ahead of the beat itself by the lead. Its speed is
        // limited, and the effect goes on from where it is when the speed changes.
        const { beat, speed } = (kind === 'effect' ? this.effectClock : this.motionClock).read({
          beat: this.tempo.outputBeat(at),
          bpm,
          wanted: this.state[kind].speed * rate,
          epoch: this.tempo.epoch,
          key: effect.id,
        });
        const rendered = effect.render({
          beat,
          bpm: bpm * speed,
          raw: this.state.raw,
          colours: this.state.colours,
        });
        for (const name of effect.drives) {
          const byte = rendered[name];
          if (byte !== undefined) raw[name] = byte;
        }
      }
    }
    // Open only when the master is known to be above 0, so that nothing else opens it.
    if (this.stopped || this.blackout || this.own || !(this.master > 0))
      raw[this.gate] = this.closed;
    return { raw };
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
