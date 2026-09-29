/**
 * Holds what one spider should be doing and keeps the output in step with it.
 *
 * The web UI changes the state through `update`; every change is encoded with the
 * fixture profile into the spider's universe and handed to the output. Browsers
 * subscribe to `state` and `status` events to stay in sync with each other.
 *
 * While an effect is chosen, a ticker renders it 40 times per second. The effect sets
 * the colours of the cells, and the tilt when it moves; brightness, strobe, motor
 * speed and blackout stay with the operator. Rendered frames are not state: browsers
 * get them as `frame` events, at a lower rate, only to draw what the fixture shows.
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
import type { BridgeStatus } from '../outputs/lr512/bridgeClient.js';

/** Where the frames go. `Lr512BridgeClient` fits. */
export interface UniverseOutput {
  setUniverse(index: number, data: Uint8Array): void;
}

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
  /** Tempo in beats per minute. */
  bpm: number;
  /** Speed of the effect relative to the tempo: 0.5, 1 or 2. */
  rate: number;
  colourA: Rgbw;
  colourB: Rgbw;
}

export interface SpiderState {
  /** Normalized 0..1 by control name, for level and strobe controls. */
  levels: Record<string, number>;
  /** Raw bytes by control name, for function controls. */
  raw: Record<string, number>;
  /** While true the fixture is dark; the levels are kept for when it is lifted. */
  blackout: boolean;
  /** True while the reset byte is being held. */
  resetting: boolean;
  effect: EffectSettings;
}

export interface EffectPatch {
  id?: unknown;
  bpm?: unknown;
  rate?: unknown;
  colourA?: unknown;
  colourB?: unknown;
  /** True restarts the beat count: "the one is now". */
  sync?: unknown;
}

export interface StatePatch {
  levels?: Record<string, unknown>;
  raw?: Record<string, unknown>;
  blackout?: unknown;
  effect?: EffectPatch;
}

export interface LinkStatus {
  /** The server has a connection to the bridge app. */
  bridge: boolean;
  /** What the bridge says about the LR512. Unknown until it has reported. */
  device: 'open' | 'lost' | 'unknown';
  universes: number;
  /** Licensed channels per universe as reported by the bridge; empty when unknown. */
  channels: number[];
}

export interface ControllerOptions {
  profile: FixtureProfile;
  layout: CellLayout;
  output: UniverseOutput;
  /** 0-based universe index on the bridge. */
  universe: number;
  /** 1-based DMX start address of the fixture. */
  address: number;
  /** How long the reset byte is held. The manual asks for 3 seconds. */
  resetHoldMs?: number;
  /** Monotonic clock in milliseconds. Tests pass their own. */
  now?: () => number;
}

export class PatchError extends Error {}

export const MIN_BPM = 60;
export const MAX_BPM = 200;
export const RATES: readonly number[] = [0.5, 1, 2];

/** Controls that a blackout forces to zero. Position and colour are left alone. */
const BLACKOUT_CONTROLS = ['dimmer', 'strobe'];
const RESET_CONTROL = 'reset';
const RESET_VALUE = 255;
/** Effect frames per second sent to the fixture. */
const TICK_MS = 25;
/** Effect frames per second shown to browsers. */
const FRAME_EVENT_MS = 50;

const DEFAULT_EFFECT: EffectSettings = {
  id: null,
  bpm: 126,
  rate: 1,
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

export class SpiderController extends EventEmitter {
  readonly profile: FixtureProfile;
  readonly layout: CellLayout;
  readonly universe: number;
  readonly address: number;

  private readonly output: UniverseOutput;
  private readonly resetHoldMs: number;
  private readonly now: () => number;
  private readonly frame = new Uint8Array(UNIVERSE_SIZE);
  private resetTimer: ReturnType<typeof setTimeout> | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;
  /** Moment of beat 0, on the controller's clock. */
  private beatOrigin: number;
  private lastFrameEvent = 0;

  private state: SpiderState;
  private link: LinkStatus = { bridge: false, device: 'unknown', universes: 0, channels: [] };

  constructor(options: ControllerOptions) {
    super();
    this.profile = options.profile;
    this.layout = options.layout;
    this.output = options.output;
    this.universe = options.universe;
    this.address = options.address;
    this.resetHoldMs = options.resetHoldMs ?? 3500;
    this.now = options.now ?? (() => performance.now());
    this.beatOrigin = this.now();

    const levels: Record<string, number> = {};
    const raw: Record<string, number> = {};
    for (const control of this.profile.controls) {
      if (control.kind === 'function') raw[control.name] = control.idle;
      else levels[control.name] = 0;
    }
    for (const name of this.cellControls()) {
      if (!(name in levels)) throw new Error(`layout names "${name}", which the profile lacks`);
    }
    this.state = {
      levels,
      raw,
      blackout: false,
      resetting: false,
      effect: {
        ...DEFAULT_EFFECT,
        colourA: { ...DEFAULT_EFFECT.colourA },
        colourB: { ...DEFAULT_EFFECT.colourB },
      },
    };

    // Fails here, at startup, when the fixture does not fit at this address.
    this.send();
  }

  getState(): SpiderState {
    return {
      levels: { ...this.state.levels },
      raw: { ...this.state.raw },
      blackout: this.state.blackout,
      resetting: this.state.resetting,
      effect: {
        ...this.state.effect,
        colourA: { ...this.state.effect.colourA },
        colourB: { ...this.state.effect.colourB },
      },
    };
  }

  getStatus(): LinkStatus {
    return { ...this.link, channels: [...this.link.channels] };
  }

  /** The fixture's bytes as they are being sent, channel 1 first. */
  getDmx(): number[] {
    return [...encodeFixture(this.profile, this.outputValues())];
  }

  /** Beats since the tempo was last synced, not scaled by the rate. */
  getBeat(): number {
    return ((this.now() - this.beatOrigin) / 60_000) * this.state.effect.bpm;
  }

  /**
   * Applies a partial change. Nothing is applied when any part of the patch is
   * invalid. `origin` is passed on with the event so a browser can skip its own echo.
   */
  update(patch: StatePatch, origin?: string): void {
    const levels = { ...this.state.levels };
    const raw = { ...this.state.raw };
    let blackout = this.state.blackout;

    for (const [name, value] of Object.entries(patch.levels ?? {})) {
      if (!(name in this.state.levels))
        throw new PatchError(`"${name}" is not a level of this fixture`);
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new PatchError(`level "${name}" must be a number between 0 and 1`);
      }
      levels[name] = clamp01(value);
    }
    for (const [name, value] of Object.entries(patch.raw ?? {})) {
      if (!(name in this.state.raw)) throw new PatchError(`"${name}" is not a function channel`);
      if (name === RESET_CONTROL) throw new PatchError('use the reset action to reset the fixture');
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
        throw new PatchError(`"${name}" must be a whole number between 0 and 255`);
      }
      raw[name] = value;
    }
    if (patch.blackout !== undefined) {
      if (typeof patch.blackout !== 'boolean')
        throw new PatchError('blackout must be true or false');
      blackout = patch.blackout;
    }
    const { effect, beatOrigin } = this.readEffect(patch.effect);

    this.state = { ...this.state, levels, raw, blackout, effect };
    this.beatOrigin = beatOrigin;
    this.runTicker();
    this.push(origin);
  }

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

  setBridgeConnected(connected: boolean): void {
    this.link = connected
      ? { ...this.link, bridge: true }
      : { bridge: false, device: 'unknown', universes: 0, channels: [] };
    this.emit('status', this.getStatus());
  }

  setDeviceStatus(status: BridgeStatus): void {
    this.link = {
      ...this.link,
      device: status.device,
      universes: status.universes,
      channels: [...status.channels],
    };
    this.emit('status', this.getStatus());
  }

  close(): void {
    if (this.resetTimer) clearTimeout(this.resetTimer);
    if (this.ticker) clearInterval(this.ticker);
    this.resetTimer = undefined;
    this.ticker = undefined;
    this.removeAllListeners();
  }

  /** Validates an effect patch and works out where beat 0 lies afterwards. */
  private readEffect(patch: EffectPatch | undefined): {
    effect: EffectSettings;
    beatOrigin: number;
  } {
    const current = this.state.effect;
    if (patch === undefined) return { effect: current, beatOrigin: this.beatOrigin };
    if (typeof patch !== 'object' || patch === null) {
      throw new PatchError('effect must be an object');
    }

    const effect: EffectSettings = { ...current };
    if (patch.id !== undefined) {
      if (patch.id !== null && (typeof patch.id !== 'string' || !findEffect(patch.id))) {
        throw new PatchError(
          `unknown effect "${String(patch.id)}", choose one of ${EFFECTS.map((e) => e.id).join(', ')}`,
        );
      }
      effect.id = patch.id;
    }
    if (patch.bpm !== undefined) {
      if (typeof patch.bpm !== 'number' || !Number.isFinite(patch.bpm)) {
        throw new PatchError('bpm must be a number');
      }
      if (patch.bpm < MIN_BPM || patch.bpm > MAX_BPM) {
        throw new PatchError(`bpm must be between ${MIN_BPM} and ${MAX_BPM}`);
      }
      effect.bpm = patch.bpm;
    }
    if (patch.rate !== undefined) {
      if (typeof patch.rate !== 'number' || !RATES.includes(patch.rate)) {
        throw new PatchError(`rate must be one of ${RATES.join(', ')}`);
      }
      effect.rate = patch.rate;
    }
    if (patch.colourA !== undefined) effect.colourA = readColour(patch.colourA, 'colourA');
    if (patch.colourB !== undefined) effect.colourB = readColour(patch.colourB, 'colourB');
    if (patch.sync !== undefined && typeof patch.sync !== 'boolean') {
      throw new PatchError('sync must be true or false');
    }

    const now = this.now();
    let beatOrigin = this.beatOrigin;
    if (patch.sync === true) {
      beatOrigin = now;
    } else if (effect.bpm !== current.bpm) {
      // Keep the beat we are on, so a tempo change does not make the effect jump.
      const beat = ((now - this.beatOrigin) / 60_000) * current.bpm;
      beatOrigin = now - (beat * 60_000) / effect.bpm;
    }
    return { effect, beatOrigin };
  }

  private cellControls(): string[] {
    const names: string[] = [...this.layout.tilt];
    for (let cell = 1; cell <= this.layout.cells; cell++) {
      for (const colour of this.layout.colours) names.push(`${colour}${cell}`);
    }
    return names;
  }

  private renderEffect(): EffectFrame | undefined {
    const { id, bpm, rate, colourA, colourB } = this.state.effect;
    const effect = id === null ? undefined : findEffect(id);
    if (!effect) return undefined;
    return effect.render({
      beat: this.getBeat() * rate,
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
    if (this.state.blackout) {
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
    const now = this.now();
    if (now - this.lastFrameEvent >= FRAME_EVENT_MS) {
      this.lastFrameEvent = now;
      this.emit('frame', this.getDmx(), this.getBeat());
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
