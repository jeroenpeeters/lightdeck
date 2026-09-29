/**
 * Holds what one spider should be doing and keeps the output in step with it.
 *
 * The page changes the state through `update`; every change is encoded with the
 * fixture profile and handed to the output. Browsers hear about it through `state`
 * events and so stay in sync with each other.
 *
 * While an effect is chosen, a ticker renders it 40 times per second, on the beat of
 * the console's tempo. The effect sets the colours of the cells, and the tilt when it
 * moves; brightness, strobe and motor speed stay with the operator. Rendered frames
 * are not state: browsers get them as `frame` events, at a lower rate, only to draw
 * what the fixture shows.
 *
 * The blackout and the grand master of the console are not state either. They change
 * what goes out and leave what is set: the master scales the dimmer and nothing else.
 */

import { EventEmitter } from 'node:events';
import { EFFECTS, type EffectFrame, findEffect, type Rgbw } from '../engine/effects.js';
import {
  encodeFixture,
  type FixtureProfile,
  UNIVERSE_SIZE,
  writeFixture,
} from '../fixtures/profile.js';
import { clamp01 } from '../model/fixture.js';
import type { UniverseOutput } from '../outputs/patch.js';
import { type FixtureController, PatchError, readObject } from './fixture.js';
import type { Tempo } from './tempo.js';

/** How the fixture's cells and motors are arranged. Cell indices are 0-based. */
export interface CellLayout {
  cells: number;
  bars: readonly (readonly number[])[];
  /** Name of the tilt control per bar. */
  tilt: readonly string[];
  /** Colour names; the control of a cell is the colour name followed by the cell number. */
  colours: readonly (keyof Rgbw)[];
}

export interface EffectSettings {
  /** Id of the running effect, or null when the operator controls the colours. */
  id: string | null;
  colourA: Rgbw;
  colourB: Rgbw;
}

export interface SpiderState {
  /** Normalized 0..1 by control name, for level and strobe controls. */
  levels: Record<string, number>;
  /** Raw bytes by control name, for function controls. */
  raw: Record<string, number>;
  /** True while the reset byte is being held. */
  resetting: boolean;
  effect: EffectSettings;
}

export interface EffectPatch {
  id?: unknown;
  colourA?: unknown;
  colourB?: unknown;
}

export interface StatePatch {
  levels?: unknown;
  raw?: unknown;
  effect?: unknown;
}

/** What of the state a change can set and a scene keeps. */
type Look = Pick<SpiderState, 'levels' | 'raw' | 'effect'>;

export interface SpiderOptions {
  profile: FixtureProfile;
  layout: CellLayout;
  output: UniverseOutput;
  /** The tempo of the console, which the effects run on. */
  tempo: Tempo;
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
const RESET_VALUE = 255;
/** Effect frames per second sent to the fixture. */
const TICK_MS = 25;
/** Effect frames per second shown to browsers. */
const FRAME_EVENT_MS = 50;

const DEFAULT_EFFECT: EffectSettings = {
  id: null,
  colourA: { red: 1, green: 0.58, blue: 0, white: 0 },
  colourB: { red: 0, green: 0.15, blue: 1, white: 0 },
};

function readColour(value: unknown, name: string): Rgbw {
  if (typeof value !== 'object' || value === null) {
    throw new PatchError(`${name} must have red, green, blue and white`);
  }
  const source = value as Record<string, unknown>;
  const read = (part: keyof Rgbw) => {
    const n = source[part];
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new PatchError(`${name}.${part} must be a number between 0 and 1`);
    }
    return clamp01(n);
  };
  return { red: read('red'), green: read('green'), blue: read('blue'), white: read('white') };
}

export class SpiderController extends EventEmitter implements FixtureController {
  readonly profile: FixtureProfile;
  readonly layout: CellLayout;
  readonly universe: number;
  readonly address: number;

  private readonly output: UniverseOutput;
  private readonly tempo: Tempo;
  private readonly resetHoldMs: number;
  /** Names of the controls that the grand master scales. */
  private readonly dimmers: readonly string[];
  private readonly frame = new Uint8Array(UNIVERSE_SIZE);
  private resetTimer: ReturnType<typeof setTimeout> | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private lastFrameEvent = 0;

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
    this.state = { ...rest, resetting: false };

    // Fails here, at startup, when the fixture does not fit at this address.
    this.send();
  }

  getState(): SpiderState {
    return {
      levels: { ...this.state.levels },
      raw: { ...this.state.raw },
      resetting: this.state.resetting,
      effect: {
        ...this.state.effect,
        colourA: { ...this.state.effect.colourA },
        colourB: { ...this.state.effect.colourB },
      },
    };
  }

  /** The arrangement of the cells, and the effects there are to choose from. */
  describe(): Record<string, unknown> {
    return {
      layout: this.layout,
      effects: EFFECTS.map(({ id, name, description, colours, moves }) => ({
        id,
        name,
        description,
        colours,
        moves,
      })),
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
    this.state = { ...this.state, ...this.apply(this.state, change, 'a change of the spider') };
    this.runTicker();
    this.push(origin);
  }

  /** Levels that are not 0, function channels that are not at rest, and a chosen effect. */
  snapshot(): Record<string, unknown> {
    const rest = this.rest();
    const levels: Record<string, number> = {};
    const raw: Record<string, number> = {};
    for (const [name, value] of Object.entries(this.state.levels)) {
      if (value !== rest.levels[name]) levels[name] = value;
    }
    for (const [name, value] of Object.entries(this.state.raw)) {
      if (name !== RESET_CONTROL && value !== rest.raw[name]) raw[name] = value;
    }
    const { effect } = this.getState();
    return {
      ...(Object.keys(levels).length > 0 ? { levels } : {}),
      ...(Object.keys(raw).length > 0 ? { raw } : {}),
      ...(effect.id !== null ? { effect } : {}),
    };
  }

  check(part: unknown): void {
    this.apply(this.rest(), part ?? {}, 'the spider in a scene');
  }

  /** A reset that is going on goes on: it is not part of a look. */
  recall(part: unknown, origin?: string): void {
    const look = this.apply(this.rest(), part ?? {}, 'the spider in a scene');
    const reset = this.state.raw[RESET_CONTROL];
    if (reset !== undefined) look.raw[RESET_CONTROL] = reset;
    this.state = { ...this.state, ...look };
    this.runTicker();
    this.push(origin);
  }

  /** The fixture with nothing set: dark, its function channels at rest, no effect. */
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
      effect: {
        ...DEFAULT_EFFECT,
        colourA: { ...DEFAULT_EFFECT.colourA },
        colourB: { ...DEFAULT_EFFECT.colourB },
      },
    };
  }

  /** `base` with the change on top. Throws when any part of the change is invalid. */
  private apply(base: Look, change: unknown, what: string): Look {
    const patch = readObject(change, what, ['levels', 'raw', 'effect']) as StatePatch;
    const levels = { ...base.levels };
    const raw = { ...base.raw };

    const newLevels = patch.levels === undefined ? {} : readObject(patch.levels, 'levels');
    const newRaw = patch.raw === undefined ? {} : readObject(patch.raw, 'raw');
    for (const [name, value] of Object.entries(newLevels)) {
      if (!(name in base.levels)) throw new PatchError(`"${name}" is not a level of this fixture`);
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new PatchError(`level "${name}" must be a number between 0 and 1`);
      }
      levels[name] = clamp01(value);
    }
    for (const [name, value] of Object.entries(newRaw)) {
      if (!(name in base.raw)) throw new PatchError(`"${name}" is not a function channel`);
      if (name === RESET_CONTROL) throw new PatchError('use the reset action to reset the fixture');
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
        throw new PatchError(`"${name}" must be a whole number between 0 and 255`);
      }
      raw[name] = value;
    }
    return { levels, raw, effect: this.readEffect(base.effect, patch.effect) };
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
    if (this.ticker) clearInterval(this.ticker);
    this.resetTimer = undefined;
    this.ticker = undefined;
    this.removeAllListeners();
  }

  private readEffect(current: EffectSettings, change: unknown): EffectSettings {
    if (change === undefined) return current;
    const patch = readObject(change, 'effect', ['id', 'colourA', 'colourB']) as EffectPatch;

    const effect: EffectSettings = { ...current };
    if (patch.id !== undefined) {
      if (patch.id !== null && (typeof patch.id !== 'string' || !findEffect(patch.id))) {
        throw new PatchError(
          `unknown effect "${String(patch.id)}", choose one of ${EFFECTS.map((e) => e.id).join(', ')}`,
        );
      }
      effect.id = patch.id;
    }
    if (patch.colourA !== undefined) effect.colourA = readColour(patch.colourA, 'colourA');
    if (patch.colourB !== undefined) effect.colourB = readColour(patch.colourB, 'colourB');
    return effect;
  }

  private cellControls(): string[] {
    const names: string[] = [...this.layout.tilt];
    for (let cell = 1; cell <= this.layout.cells; cell++) {
      for (const colour of this.layout.colours) names.push(`${colour}${cell}`);
    }
    return names;
  }

  private renderEffect(): EffectFrame | undefined {
    const { id, colourA, colourB } = this.state.effect;
    const effect = id === null ? undefined : findEffect(id);
    if (!effect) return undefined;
    const { bpm, rate } = this.tempo.getState();
    return effect.render({
      beat: this.tempo.getBeat() * rate,
      bpm: bpm * rate,
      cells: this.layout.cells,
      bars: this.layout.bars,
      a: colourA,
      b: colourB,
    });
  }

  private outputValues() {
    const levels = { ...this.state.levels };
    const frame = this.renderEffect();
    if (frame) {
      frame.cells.forEach((colour, index) => {
        for (const part of this.layout.colours) {
          levels[`${part}${index + 1}`] = clamp01(colour[part]);
        }
      });
      frame.tilt?.forEach((tilt, bar) => {
        const name = this.layout.tilt[bar];
        if (name !== undefined) levels[name] = clamp01(tilt);
      });
    }
    for (const name of this.dimmers) levels[name] = (levels[name] ?? 0) * this.master;
    if (this.blackout) {
      for (const name of BLACKOUT_CONTROLS) if (name in levels) levels[name] = 0;
    }
    return { levels, raw: this.state.raw };
  }

  private runTicker(): void {
    const wanted = this.state.effect.id !== null;
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
