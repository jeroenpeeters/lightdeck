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
 * While an effect is chosen and the laser is in the mode the effects count in, a ticker
 * renders the effect 40 times per second, on the beat of the console's tempo. The effect
 * sets the channels it drives, the others stay with the operator. An effect never opens
 * the laser: the gate is not for effects to drive. Rendered frames are not state:
 * browsers get them as `frame` events, at a lower rate, to draw what is being sent.
 */

import { EventEmitter } from 'node:events';
import { limitSpeed, SPEEDS } from '../engine/effects.js';
import type { LaserEffect } from '../engine/laserEffects.js';
import {
  encodeFixture,
  type FixtureProfile,
  findControl,
  rangeAt,
  UNIVERSE_SIZE,
  writeFixture,
} from '../fixtures/profile.js';
import { clamp01 } from '../model/fixture.js';
import type { UniverseOutput } from '../outputs/patch.js';
import { type FixtureController, PatchError, readObject } from './fixture.js';
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
  effect: LaserEffectSettings;
}

export interface LaserPatch {
  raw?: unknown;
  effect?: unknown;
}

/** What of the state a change can set and a scene keeps: all of it. */
type Look = LaserState;

/** The effects of a laser, and the range of the gate in which they count. */
export interface LaserEffects {
  list: readonly LaserEffect[];
  /** Key of a range of the gate, such as `manual`. */
  mode: string;
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
  /** 0-based universe index on the bridge. */
  universe: number;
  /** 1-based DMX start address of the fixture. */
  address: number;
}

/** Effect frames per second sent to the fixture. */
const TICK_MS = 25;
/** Effect frames per second shown to browsers. */
const FRAME_EVENT_MS = 50;

export class LaserController extends EventEmitter implements FixtureController {
  readonly profile: FixtureProfile;
  readonly gate: string;
  readonly universe: number;
  readonly address: number;

  private readonly output: UniverseOutput;
  private readonly tempo: Tempo;
  private readonly effects: readonly LaserEffect[];
  private readonly effectsMode: string | undefined;
  private readonly frame = new Uint8Array(UNIVERSE_SIZE);
  private readonly closed: number;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private lastFrameEvent = 0;
  private state: LaserState;
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
    this.effectsMode = options.effects?.mode;
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
    return { raw: { ...this.state.raw }, effect: { ...this.state.effect } };
  }

  /**
   * The control that opens and closes the laser, the effects and their speeds there are
   * to choose from, and the range of the gate in which the effects count.
   */
  describe(): Record<string, unknown> {
    return {
      gate: this.gate,
      speeds: SPEEDS,
      effects: this.effects.map(({ id, name, description, drives }) => ({
        id,
        name,
        description,
        drives,
      })),
      effectsIn: this.effectsMode ?? null,
    };
  }

  /** The fixture's bytes as they are being sent, channel 1 first. */
  getDmx(): number[] {
    return [...encodeFixture(this.profile, this.outputValues())];
  }

  /**
   * Applies a partial change. Nothing is applied when any part of the patch is
   * invalid. `origin` is passed on with the event so a browser can skip its own echo.
   */
  update(change: unknown, origin?: string): void {
    this.state = this.apply(this.state, change, 'a change of the laser');
    this.runTicker();
    this.push(origin);
  }

  /** The channels that are not at rest, and a chosen effect. */
  snapshot(): Record<string, unknown> {
    const rest = this.rest();
    const raw: Record<string, number> = {};
    for (const [name, value] of Object.entries(this.state.raw)) {
      if (value !== rest.raw[name]) raw[name] = value;
    }
    const { effect } = this.state;
    return {
      ...(Object.keys(raw).length > 0 ? { raw } : {}),
      ...(effect.id !== null ? { effect: { ...effect } } : {}),
    };
  }

  check(part: unknown): void {
    this.apply(this.rest(), part ?? {}, 'the laser in a scene');
  }

  /**
   * A scene may open the laser, which an effect may not: recalling one is something the
   * operator does, or a sequence the operator started.
   */
  recall(part: unknown, origin?: string): void {
    this.state = this.apply(this.rest(), part ?? {}, 'the laser in a scene');
    this.runTicker();
    this.push(origin);
  }

  /** The laser with nothing set: closed, every channel at rest, no effect. */
  private rest(): Look {
    const raw: Record<string, number> = {};
    for (const control of this.profile.controls) {
      if (control.kind === 'function') raw[control.name] = control.idle;
    }
    return { raw, effect: { id: null, speed: 1 } };
  }

  /** `base` with the change on top. Throws when any part of the change is invalid. */
  private apply(base: Look, change: unknown, what: string): Look {
    const patch = readObject(change, what, ['raw', 'effect']) as LaserPatch;
    const raw = { ...base.raw };
    const newRaw = patch.raw === undefined ? {} : readObject(patch.raw, 'raw');
    for (const [name, value] of Object.entries(newRaw)) {
      if (!(name in base.raw)) throw new PatchError(`"${name}" is not a channel of the laser`);
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
        throw new PatchError(`"${name}" must be a whole number between 0 and 255`);
      }
      raw[name] = value;
    }
    return { raw, effect: this.readEffect(base.effect, patch.effect) };
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
    this.runTicker();
    this.push();
  }

  close(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    this.removeAllListeners();
  }

  /** An effect may drive any control of the laser but the one that opens it. */
  private checkEffects(): void {
    if (this.effects.length === 0) return;
    const gate = findControl(this.profile, this.gate);
    const mode = this.effectsMode;
    const open = gate?.kind === 'function' ? gate.ranges.find((r) => r.key === mode) : undefined;
    if (!open || (this.closed >= open.from && this.closed <= open.to)) {
      throw new Error(
        `${this.profile.id}: effects need a range "${mode}" of "${this.gate}" that opens the laser`,
      );
    }
    for (const effect of this.effects) {
      for (const name of effect.drives) {
        if (name === this.gate || !findControl(this.profile, name)) {
          throw new Error(`${this.profile.id}: the effect "${effect.id}" cannot drive "${name}"`);
        }
      }
    }
  }

  private readEffect(current: LaserEffectSettings, change: unknown): LaserEffectSettings {
    if (change === undefined) return current;
    const { id, speed } = readObject(change, 'effect', ['id', 'speed']);
    const effect = { ...current };
    if (id !== undefined) {
      if (id !== null && !this.effects.some((each) => each.id === id)) {
        throw new PatchError(
          `unknown effect "${String(id)}", choose one of ${this.effects.map((e) => e.id).join(', ')}`,
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

  /** The chosen effect, when the laser is in the mode in which effects count. */
  private showing(): LaserEffect | undefined {
    const { id } = this.state.effect;
    if (id === null) return undefined;
    const gate = findControl(this.profile, this.gate);
    if (gate?.kind !== 'function') return undefined;
    if (rangeAt(this.profile, gate, this.state.raw)?.key !== this.effectsMode) return undefined;
    return this.effects.find((effect) => effect.id === id);
  }

  private outputValues() {
    const raw = { ...this.state.raw };
    // An idle effect drives nothing, and does not open or close the laser: the laser shows
    // what it is set to. The ticker keeps asking, so the effect is back when the tempo runs.
    const effect = this.tempo.isRunning() ? this.showing() : undefined;
    if (effect) {
      const { bpm, rate } = this.tempo.getState();
      const speed = limitSpeed(bpm, this.state.effect.speed * rate);
      const rendered = effect.render({
        beat: this.tempo.getBeat() * speed,
        bpm: bpm * speed,
        raw: this.state.raw,
      });
      for (const name of effect.drives) {
        const byte = rendered[name];
        if (byte !== undefined) raw[name] = byte;
      }
    }
    // Open only when the master is known to be above 0, so that nothing else opens it.
    if (this.stopped || this.blackout || !(this.master > 0)) raw[this.gate] = this.closed;
    return { raw };
  }

  private runTicker(): void {
    const wanted = !this.stopped && this.showing() !== undefined;
    if (wanted && !this.ticker) {
      this.ticker = setInterval(() => this.tick(), TICK_MS);
    } else if (!wanted && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  private tick(): void {
    this.send();
    const now = this.tempo.now();
    if (now - this.lastFrameEvent >= FRAME_EVENT_MS) {
      this.lastFrameEvent = now;
      this.emit('frame', this.getDmx(), this.tempo.getBeat());
    }
  }

  private send(): void {
    writeFixture(this.frame, this.address, this.profile, this.outputValues());
    this.output.setUniverse(this.universe, this.frame);
  }

  private push(origin?: string): void {
    this.send();
    this.emit('state', this.getState(), origin);
  }
}
