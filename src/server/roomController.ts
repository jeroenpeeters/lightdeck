/**
 * Holds what the lamps and switches of the room should be doing, and keeps Home Assistant in
 * step with it.
 *
 * The room is one fixture, "Room Lights" (Jeroen, 2026-10-18), with a lamp for each entity of
 * Home Assistant and zones of lamps in it, the way the spider has bars of lenses. A lamp is a
 * `light` (RGBW, RGB or just a dimmer, which Home Assistant says) or a `switch` (on or off). A
 * switch is in no zone, and no effect ever touches it, as no effect ever opens the laser.
 *
 * The lamps are the slow layer under the spider and the laser: scenery that changes now and
 * then. So the only effects are those of `roomEffects.ts`, which move the colours of the
 * palette over the lamps every 128 beats (about a minute). A lamp takes one command per second at the most
 * (the throttle of the output sees to that), and a command carries a `transition`, so a lamp
 * glides to where it is told to go: a change by hand glides for a second, a scene, a palette
 * and a step of an effect for `fade` seconds, and the blackout does not glide.
 *
 * What a scene keeps of the room is the lights: the level of every lamp that is on, the fade and
 * the effect. The colour is the palette of the show, set on the fixture by the playback like it
 * is on the spider; a colour set by hand per lamp is no part of any scene. The room has no
 * motion. A lamp that a scene of lights does not name goes off, and so does a switch.
 *
 * There is one state per fixture and lightdeck holds it. What Home Assistant says is shown
 * next to it (`reported`, `problems`) and never changes it: a lamp that somebody set from the
 * Home Assistant app shows as differing, until the next scene sets it again.
 *
 * The blackout and the grand master are not state: they change what goes out and leave what is
 * set. The blackout switches every lamp off at once, and the master scales the brightness of the
 * lamps. A switch is left alone by both, unless it is set to follow them. The `dimmer` of the room
 * (Jeroen, 2026-10-18) is a second master for the lights of the room alone: it is state, because
 * it is set on the page of the room, but it is part of no scene, so a scene does not move it.
 * Switches have no brightness and are left alone by it.
 */

import { EventEmitter } from 'node:events';
import { EffectClock } from '../engine/effectClock.js';
import { type Rgbw, SPEEDS } from '../engine/effects.js';
import { colourAt, FALLBACK_PALETTE, PaletteBook, paint } from '../engine/palette.js';
import { findRoomEffect, PERIOD_BEATS, ROOM_EFFECTS } from '../engine/roomEffects.js';
import type { SceneType } from '../fixtures/profile.js';
import { clamp01 } from '../model/fixture.js';
import { lightCommand, switchCommand } from '../outputs/hass/encode.js';
import type { EntityReport, HassCommand, HassOutput } from '../outputs/hass/types.js';
import { type FixtureController, PatchError, readObject } from './fixture.js';
import type { Tempo } from './tempo.js';

/** One entity of Home Assistant in the room. */
export interface LampDefinition {
  /** Names the lamp within the fixture: `bar`, `ceiling-a`. */
  id: string;
  /** What the operator calls it. */
  label: string;
  /** The entity in Home Assistant: `light.bar` or `switch.fog`. */
  entity: string;
  /** For a switch: whether it goes off in a blackout, and with the master at 0. */
  blackout?: boolean;
}

/** A named list of lights, like a bar of the spider. */
export interface ZoneDefinition {
  id: string;
  label: string;
  lamps: string[];
}

export interface RoomOptions {
  hass: HassOutput;
  tempo: Tempo;
  /** The palettes of the show. Without it there are none, and the lamps get a single white. */
  palettes?: PaletteBook;
  lamps: readonly LampDefinition[];
  /** Without zones all the lights are one zone. */
  zones?: readonly ZoneDefinition[];
}

/** What Home Assistant says about a lamp, as the page shows it. */
export interface LampReport {
  available: boolean;
  on: boolean;
  /** `supported_color_modes` of a light, empty for a switch and until it has reported. */
  colourModes: string[];
}

/** The scenery effect that is chosen, with its speed. */
export interface RoomEffectSettings {
  /** Id of the chosen effect, or null: then the lamps show the first colour of the palette. */
  id: string | null;
  /** Speed of the effect relative to the tempo, one of `SPEEDS`. At 1 it moves every 20 beats. */
  speed: number;
}

/** The palette that colours the lamps. */
export interface RoomColourSettings {
  /** Id of a palette of the show, or null: then the colours set by hand. */
  palette: string | null;
  /** How fast the palette cycles, one of `SPEEDS`, or null: then the pace of the palette itself. */
  speed: number | null;
}

export interface RoomState {
  /** Per lamp, 0..1; a switch is on above 0. At rest 0. */
  levels: Record<string, number>;
  /** Per light, by hand, used while there is no palette. Left out of scenes. At rest white. */
  colours: Record<string, Rgbw>;
  /** Seconds a scene, a palette and a step of an effect take to come in. */
  fade: number;
  /** The brightness of all lights of the room together, 0..1. Left out of scenes. At rest 1. */
  dimmer: number;
  effect: RoomEffectSettings;
  colour: RoomColourSettings;
  /**
   * The colour each light is being sent, its brightest channel at 1, for the page to draw a
   * swatch with. Not part of a look and not set with `update`; a switch has none.
   */
  shown: Record<string, Rgbw>;
  /** What Home Assistant says per lamp. Not part of a look, not set with `update`. */
  reported: Record<string, LampReport | null>;
  /** Why the last command for a lamp did not arrive, or null. */
  problems: Record<string, string | null>;
}

export interface StatePatch {
  levels?: unknown;
  colours?: unknown;
  fade?: unknown;
  dimmer?: unknown;
  effect?: unknown;
  colour?: unknown;
}

/** What of the state a change can set. */
type Look = Pick<RoomState, 'levels' | 'colours' | 'fade' | 'dimmer' | 'effect' | 'colour'>;

/** The fade of a scene when it does not say, in seconds. */
export const DEFAULT_FADE = 2;
export const MAX_FADE = 60;
/** A change by hand glides for as long as a lamp has to wait for its next command. */
export const GLIDE_S = 1;

const ID = /^[a-z0-9][a-z0-9-]*$/;
const ENTITY = /^(light|switch)\.[a-z0-9_]+$/;
const WHITE: Rgbw = { red: 0, green: 0, blue: 0, white: 1 };
const COLOUR_KEYS = ['red', 'green', 'blue', 'white'] as const;
const EFFECT_KEYS = ['id', 'speed'];
const PALETTE_KEYS = ['palette', 'speed'];

/** Which type of scene keeps which of the parts of the state. */
const KEPT_BY: Record<'levels' | 'fade' | 'effect' | 'colour', SceneType> = {
  levels: 'lights',
  fade: 'lights',
  effect: 'lights',
  colour: 'colour',
};

const restEffect = (): RoomEffectSettings => ({ id: null, speed: 1 });
const restColour = (): RoomColourSettings => ({ palette: null, speed: null });

function readSpeed(value: unknown, what: string): number {
  if (typeof value !== 'number' || !SPEEDS.includes(value)) {
    throw new PatchError(`the speed of ${what} must be one of ${SPEEDS.join(', ')}`);
  }
  return value;
}

interface Lamp extends LampDefinition {
  domain: 'light' | 'switch';
  /** Place among the cells that the effects count, or -1 for a switch. */
  cell: number;
  zone: string | null;
}

/** What one lamp should be, before it is turned into a command. */
interface Wanted {
  command: HassCommand;
  on: boolean;
}

export class RoomController extends EventEmitter implements FixtureController {
  readonly takesPalettes = true;

  private readonly hass: HassOutput;
  private readonly tempo: Tempo;
  private readonly palettes: PaletteBook;
  private readonly lamps: Lamp[];
  private readonly zones: ZoneDefinition[];
  /** The zones as the effects see them: the cells of their lights, in order. */
  private readonly bars: number[][];
  private readonly cells: number;
  private readonly stops: Array<() => void> = [];
  /** Keeps the step of the effect and of the palette continuous when a speed changes. */
  private readonly lightClock = new EffectClock();
  private readonly paletteClock = new EffectClock();
  /** What each lamp was last wanted to be, so that only a lamp that changes gets a command. */
  private readonly wanted = new Map<string, string>();
  /** The colours of the effect as they were while the music ran, for when it stops. */
  private frozen: { key: string; colours: Rgbw[] } | undefined;
  private disposed = false;

  private state: RoomState;
  /** The blackout of the console. It is not part of the state of the fixture. */
  private blackout = false;
  /** The grand master of the console, 0 to 1. It is not part of the state either. */
  private master = 1;

  /** Throws an `Error` that says what is wrong with the lamps or the zones. */
  constructor(options: RoomOptions) {
    super();
    this.hass = options.hass;
    this.tempo = options.tempo;
    this.palettes = options.palettes ?? new PaletteBook();
    const { lamps, zones } = this.read(options.lamps, options.zones ?? []);
    this.lamps = lamps;
    this.zones = zones;
    this.cells = lamps.filter((lamp) => lamp.cell >= 0).length;
    this.bars = this.zonesAsBars();

    this.state = { ...this.rest(), shown: {}, reported: {}, problems: {} };
    for (const lamp of this.lamps) {
      this.state.reported[lamp.id] = null;
      this.state.problems[lamp.id] = null;
    }
    // What the lamps are wanted to be at the start, so that only a change is a command. A
    // room that starts does not touch the lamps: they stay as they are until something is set.
    const cells = this.cellColours(this.tempo.now());
    for (const lamp of this.lamps) {
      this.wanted.set(lamp.id, this.key(this.target(lamp, cells, 0).command));
    }
    this.state.shown = this.shownOf(cells);

    for (const lamp of this.lamps) {
      this.stops.push(
        this.hass.watch(lamp.entity, (report) => this.heard(lamp, report)),
        this.hass.problems(lamp.entity, (problem) => this.complained(lamp, problem)),
      );
    }
  }

  getState(): RoomState {
    return {
      levels: { ...this.state.levels },
      colours: Object.fromEntries(
        Object.entries(this.state.colours).map(([id, colour]) => [id, { ...colour }]),
      ),
      fade: this.state.fade,
      dimmer: this.state.dimmer,
      effect: { ...this.state.effect },
      colour: { ...this.state.colour },
      shown: Object.fromEntries(
        Object.entries(this.state.shown).map(([id, colour]) => [id, { ...colour }]),
      ),
      reported: Object.fromEntries(
        Object.entries(this.state.reported).map(([id, report]) => [
          id,
          report && { ...report, colourModes: [...report.colourModes] },
        ]),
      ),
      problems: { ...this.state.problems },
    };
  }

  /** The lamps and the zones, and the effects and speeds to choose from. */
  describe(): Record<string, unknown> {
    return {
      lamps: this.lamps.map(({ id, label, entity, domain, blackout, zone }) => ({
        id,
        label,
        entity,
        kind: domain,
        zone,
        ...(domain === 'switch' ? { blackout: blackout === true } : {}),
      })),
      zones: this.zones.map(({ id, label, lamps }) => ({ id, label, lamps: [...lamps] })),
      speeds: SPEEDS,
      defaultFade: DEFAULT_FADE,
      periodBeats: PERIOD_BEATS,
      maxFade: MAX_FADE,
      effects: ROOM_EFFECTS.map(({ id, name, description }) => ({ id, name, description })),
    };
  }

  /** True while an effect runs on the beat, or a palette cycles: the engine then asks for frames. */
  wantsFrames(): boolean {
    if (this.disposed || !this.tempo.isRunning()) return false;
    const palette = this.palettes.get(this.state.colour.palette);
    const cycles = palette?.mode === 'cycle' && palette.colours.length > 1;
    return this.state.effect.id !== null || cycles === true;
  }

  /** Makes the commands for the moment `at`. The engine calls this on the grid of the beat. */
  render(at: number): void {
    if (this.sync(this.state.fade, false, at)) this.emit('state', this.getState());
  }

  update(change: unknown, origin?: string): void {
    const look = this.apply(this.state, change, 'a change of the room');
    this.state = { ...this.state, ...look };
    this.emit('wants');
    this.sync(GLIDE_S, false);
    this.emit('state', this.getState(), origin);
  }

  /**
   * What a scene of this type keeps: for lights the levels that are above 0, the fade when it
   * is not the usual one and the effect when one is chosen; for colour the palette when one is
   * chosen; the room has no motion.
   */
  snapshot(type: SceneType): Record<string, unknown> {
    const { levels, fade, effect, colour } = this.state;
    if (type === 'lights') {
      const on = Object.fromEntries(Object.entries(levels).filter(([, level]) => level > 0));
      return {
        ...(Object.keys(on).length > 0 ? { levels: on } : {}),
        ...(fade !== DEFAULT_FADE ? { fade } : {}),
        ...(effect.id !== null ? { effect: { ...effect } } : {}),
      };
    }
    if (type === 'colour') {
      return colour.palette === null
        ? {}
        : {
            colour: {
              palette: colour.palette,
              ...(colour.speed === null ? {} : { speed: colour.speed }),
            },
          };
    }
    return {};
  }

  check(type: SceneType, part: unknown): void {
    this.apply(this.rest(), part ?? {}, 'the room in a scene', type);
  }

  /**
   * Sets what the type keeps, from rest and the part, and leaves the rest of the state. A lamp
   * that the part does not name goes off. The lamps come in over `fade` seconds. A lamp whose
   * state in Home Assistant is not what it should be is set again, also when the scene is the
   * one that was already on.
   */
  recall(type: SceneType, part: unknown, origin?: string): void {
    const look = this.apply(this.rest(), part ?? {}, 'the room in a scene', type);
    if (type === 'lights') {
      this.state = { ...this.state, levels: look.levels, fade: look.fade, effect: look.effect };
    } else if (type === 'colour') {
      this.state = { ...this.state, colour: look.colour };
    }
    this.emit('wants');
    this.sync(this.state.fade, false, undefined, true);
    this.emit('state', this.getState(), origin);
  }

  act(name: string): void {
    throw new PatchError(`the room has nothing called "${name}"`);
  }

  setBlackout(blackout: boolean): void {
    if (blackout === this.blackout) return;
    this.blackout = blackout;
    // Dark at once, and back in a second.
    this.sync(blackout ? 0 : GLIDE_S, blackout);
  }

  setMaster(level: number): void {
    const master = clamp01(level);
    if (master === this.master) return;
    this.master = master;
    this.sync(GLIDE_S, false);
  }

  /** Lamps and switches stay as they are when lightdeck stops. */
  darken(): void {}

  close(): void {
    this.disposed = true;
    this.emit('wants');
    for (const stop of this.stops) stop();
    this.stops.length = 0;
    this.removeAllListeners();
  }

  // --- reading what the lamps are ---------------------------------------------------------

  private read(
    lamps: readonly LampDefinition[],
    zones: readonly ZoneDefinition[],
  ): { lamps: Lamp[]; zones: ZoneDefinition[] } {
    if (lamps.length === 0) throw new Error('the room needs at least one lamp');
    const made: Lamp[] = [];
    let cell = 0;
    for (const definition of lamps) {
      const { id, entity } = definition;
      if (!ID.test(id)) {
        throw new Error(`"${id}" cannot name a lamp: use small letters, digits and dashes`);
      }
      if (made.some((each) => each.id === id)) throw new Error(`two lamps are called "${id}"`);
      if (!ENTITY.test(entity)) {
        throw new Error(
          `the lamp "${id}" has the entity "${entity}", which is not a light or a switch of Home Assistant (light.name or switch.name)`,
        );
      }
      const used = made.find((each) => each.entity === entity);
      if (used) throw new Error(`the lamps "${used.id}" and "${id}" are the same entity ${entity}`);
      const domain = entity.startsWith('light.') ? 'light' : 'switch';
      if (definition.blackout !== undefined && domain !== 'switch') {
        throw new Error(`"blackout" is a setting of a switch, and "${id}" is a light`);
      }
      made.push({ ...definition, domain, cell: domain === 'light' ? cell++ : -1, zone: null });
    }

    const listed: ZoneDefinition[] = [];
    for (const zone of zones) {
      if (!ID.test(zone.id)) {
        throw new Error(`"${zone.id}" cannot name a zone: use small letters, digits and dashes`);
      }
      if (listed.some((each) => each.id === zone.id)) {
        throw new Error(`two zones are called "${zone.id}"`);
      }
      for (const name of zone.lamps) {
        const lamp = made.find((each) => each.id === name);
        if (!lamp) throw new Error(`the zone "${zone.id}" names "${name}", which is not a lamp`);
        if (lamp.domain !== 'light') {
          throw new Error(
            `the zone "${zone.id}" names "${name}", a switch: only lights are in zones`,
          );
        }
        if (lamp.zone !== null) {
          throw new Error(`the lamp "${name}" is in the zones "${lamp.zone}" and "${zone.id}"`);
        }
        lamp.zone = zone.id;
      }
      listed.push({ id: zone.id, label: zone.label, lamps: [...zone.lamps] });
    }
    // The lights that are in no zone are a zone of their own after the last, and without zones
    // all the lights are one.
    const rest = made.filter((lamp) => lamp.domain === 'light' && lamp.zone === null);
    if (rest.length > 0) {
      const id = listed.length === 0 ? 'room' : 'rest';
      for (const lamp of rest) lamp.zone = id;
      listed.push({
        id,
        label: listed.length === 0 ? 'Room' : 'The rest',
        lamps: rest.map((lamp) => lamp.id),
      });
    }
    return { lamps: made, zones: listed };
  }

  /** The zones as lists of cells, which is what the effects want to know. */
  private zonesAsBars(): number[][] {
    return this.zones.map((zone) =>
      zone.lamps.map((id) => this.lamp(id).cell).filter((cell) => cell >= 0),
    );
  }

  private lamp(id: string): Lamp {
    const found = this.lamps.find((lamp) => lamp.id === id);
    if (!found) throw new PatchError(`there is no lamp called "${id}"`);
    return found;
  }

  // --- the state --------------------------------------------------------------------------

  /** The room with nothing set: every lamp off, white, no effect, no palette. */
  private rest(): Look {
    const levels: Record<string, number> = {};
    const colours: Record<string, Rgbw> = {};
    for (const lamp of this.lamps) {
      levels[lamp.id] = 0;
      if (lamp.domain === 'light') colours[lamp.id] = { ...WHITE };
    }
    return {
      levels,
      colours,
      fade: DEFAULT_FADE,
      dimmer: 1,
      effect: restEffect(),
      colour: restColour(),
    };
  }

  /**
   * `base` with the change on top. Throws when any part of the change is invalid. With `only`
   * the change may name properties of that type of scene and no others.
   */
  private apply(base: Look, change: unknown, what: string, only?: SceneType): Look {
    const patch = readObject(change, what, [
      'levels',
      'colours',
      'fade',
      'dimmer',
      'effect',
      'colour',
    ]) as StatePatch;
    if (only !== undefined) {
      for (const key of ['levels', 'fade', 'effect', 'colour'] as const) {
        if (patch[key] !== undefined && KEPT_BY[key] !== only) {
          throw new PatchError(`"${key}" is not part of a ${only} scene`);
        }
      }
      if (patch.colours !== undefined) {
        throw new PatchError(`"colours" are set by hand and are part of no scene`);
      }
      if (patch.dimmer !== undefined) {
        throw new PatchError(`the "dimmer" of the room is part of no scene`);
      }
    }

    const levels = { ...base.levels };
    if (patch.levels !== undefined) {
      for (const [id, value] of Object.entries(readObject(patch.levels, 'levels'))) {
        this.lamp(id);
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new PatchError(`the level of "${id}" must be a number between 0 and 1`);
        }
        levels[id] = clamp01(value);
      }
    }

    const colours = { ...base.colours };
    if (patch.colours !== undefined) {
      for (const [id, value] of Object.entries(readObject(patch.colours, 'colours'))) {
        if (this.lamp(id).domain !== 'light')
          throw new PatchError(`"${id}" is a switch, it has no colour`);
        const given = readObject(value, `the colour of "${id}"`, COLOUR_KEYS);
        const next = { ...(colours[id] ?? WHITE) };
        for (const key of COLOUR_KEYS) {
          const part = given[key];
          if (part === undefined) continue;
          if (typeof part !== 'number' || !Number.isFinite(part)) {
            throw new PatchError(`${key} of "${id}" must be a number between 0 and 1`);
          }
          next[key] = clamp01(part);
        }
        colours[id] = next;
      }
    }

    let fade = base.fade;
    if (patch.fade !== undefined) {
      if (
        typeof patch.fade !== 'number' ||
        !Number.isFinite(patch.fade) ||
        patch.fade < 0 ||
        patch.fade > MAX_FADE
      ) {
        throw new PatchError(`the fade must be a number of seconds between 0 and ${MAX_FADE}`);
      }
      fade = patch.fade;
    }
    let dimmer = base.dimmer;
    if (patch.dimmer !== undefined) {
      if (typeof patch.dimmer !== 'number' || !Number.isFinite(patch.dimmer)) {
        throw new PatchError('the dimmer must be a number between 0 and 1');
      }
      dimmer = clamp01(patch.dimmer);
    }
    return {
      levels,
      colours,
      fade,
      dimmer,
      effect: this.readEffect(base.effect, patch.effect),
      colour: this.readColour(base.colour, patch.colour),
    };
  }

  private readEffect(current: RoomEffectSettings, change: unknown): RoomEffectSettings {
    if (change === undefined) return current;
    const patch = readObject(change, 'effect', EFFECT_KEYS);
    const effect = { ...current };
    if (patch.id !== undefined) {
      if (patch.id !== null && (typeof patch.id !== 'string' || !findRoomEffect(patch.id))) {
        throw new PatchError(
          `unknown effect "${String(patch.id)}", choose one of ${ROOM_EFFECTS.map((e) => e.id).join(', ')}`,
        );
      }
      effect.id = patch.id;
    }
    if (patch.speed !== undefined) effect.speed = readSpeed(patch.speed, 'an effect');
    return effect;
  }

  private readColour(current: RoomColourSettings, change: unknown): RoomColourSettings {
    if (change === undefined) return current;
    const patch = readObject(change, 'colour', PALETTE_KEYS);
    const colour = { ...current };
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

  // --- what Home Assistant says -----------------------------------------------------------

  private heard(lamp: Lamp, report: EntityReport | undefined): void {
    if (this.disposed) return;
    const before = this.state.reported[lamp.id];
    // A light that is unavailable tells no colour modes. It keeps the ones it had told.
    const after: LampReport | null = report
      ? {
          available: report.available,
          on: report.on,
          colourModes:
            report.colourModes.length === 0 && before
              ? before.colourModes
              : [...report.colourModes],
        }
      : null;
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    this.state = { ...this.state, reported: { ...this.state.reported, [lamp.id]: after } };
    // A light that has just told how it takes a colour gets its look in that form, once.
    if (
      before === null ||
      JSON.stringify(before?.colourModes) !== JSON.stringify(after?.colourModes)
    ) {
      this.sync(GLIDE_S, false);
    }
    this.emit('state', this.getState());
  }

  private complained(lamp: Lamp, problem: string | null): void {
    if (this.disposed || this.state.problems[lamp.id] === problem) return;
    this.state = { ...this.state, problems: { ...this.state.problems, [lamp.id]: problem } };
    this.emit('state', this.getState());
  }

  // --- what goes out ----------------------------------------------------------------------

  /** The colours of the lights as the effects and the palette make them, by cell. */
  private cellColours(at: number): Rgbw[] {
    const { effect, colour, colours } = this.state;
    const lights = this.lamps.filter((lamp) => lamp.cell >= 0);
    const palette = this.palettes.get(colour.palette);
    const chosen = effect.id === null ? undefined : findRoomEffect(effect.id);

    // Without a palette and without an effect the colours are the ones set by hand.
    if (!palette && !chosen) return lights.map((lamp) => colours[lamp.id] ?? WHITE);

    const used = palette ?? FALLBACK_PALETTE;
    const running = this.tempo.isRunning();
    const { bpm, rate } = this.tempo.getState();
    const beat = this.tempo.outputBeat(at);
    const epoch = this.tempo.epoch;
    // A cycling palette steps once per `PERIOD_BEATS` at speed 1, as a hard step whatever the
    // palette says about fading: a fade by steps would be a command per lamp per second for as
    // long as it runs, and the mesh takes about 4 per second for all the lamps. The lamps glide
    // from one colour to the next over `fade`. The pace of the palette itself is not used: it is
    // made for lenses that change every beat.
    let step = 0;
    if (used.mode === 'cycle' && used.colours.length > 1 && running) {
      step = Math.floor(
        this.paletteClock.read({
          beat,
          bpm,
          wanted: (colour.speed ?? 1) * rate,
          epoch,
          key: used.id,
        }).beat / PERIOD_BEATS,
      );
    }

    if (!chosen) {
      const first = colourAt(used, 0, step);
      return lights.map(() => first ?? { red: 0, green: 0, blue: 0, white: 0 });
    }

    // While the music has stopped the effect stays where it was.
    const key = `${chosen.id}/${used.id}/${used.colours.length}`;
    if (!running && this.frozen?.key === key) return this.frozen.colours;
    const read = this.lightClock.read({
      beat,
      bpm,
      wanted: effect.speed * rate,
      epoch,
      key: chosen.id,
    });
    const { levels } = chosen.render({
      beat: read.beat,
      cells: this.cells,
      bars: this.bars,
      slots: used.colours.length,
    });
    const painted = paint(levels, used, step);
    if (running) this.frozen = { key, colours: painted };
    return painted;
  }

  private target(lamp: Lamp, cells: Rgbw[], transition: number): Wanted {
    const level = this.state.levels[lamp.id] ?? 0;
    if (lamp.domain === 'switch') {
      const follows = lamp.blackout === true;
      const on = level > 0 && !(follows && (this.blackout || this.master === 0));
      return { command: switchCommand(on), on };
    }
    const colour = cells[lamp.cell] ?? WHITE;
    const peak = Math.max(colour.red, colour.green, colour.blue, colour.white);
    const brightness = this.blackout ? 0 : peak * level * this.state.dimmer * this.master;
    const direction: Rgbw =
      peak > 0
        ? {
            red: colour.red / peak,
            green: colour.green / peak,
            blue: colour.blue / peak,
            white: colour.white / peak,
          }
        : colour;
    const modes = this.state.reported[lamp.id]?.colourModes;
    return {
      command: lightCommand({
        brightness,
        colour: direction,
        modes: modes && modes.length > 0 ? modes : undefined,
        transition,
      }),
      on: brightness > 0 && peak > 0,
    };
  }

  /** A command without its transition, which is how two commands are told apart. */
  private key(command: HassCommand): string {
    const { transition: _transition, ...data } = (command.data ?? {}) as Record<string, unknown>;
    return JSON.stringify([command.domain, command.service, data]);
  }

  /**
   * Sends a command to every lamp that is to be something else than it was last wanted to be.
   * With `force` a lamp whose state in Home Assistant is not what it should be gets its command
   * again, which is what a scene is for. `urgent` goes before the rest, for the blackout.
   */
  private sync(transition: number, urgent: boolean, at?: number, force = false): boolean {
    if (this.disposed) return false;
    const cells = this.cellColours(at ?? this.tempo.now());
    for (const lamp of this.lamps) {
      const { command, on } = this.target(lamp, cells, transition);
      const key = this.key(command);
      const reported = this.state.reported[lamp.id];
      const differs = force && reported?.available === true && reported.on !== on;
      if (key === this.wanted.get(lamp.id) && !differs) continue;
      this.wanted.set(lamp.id, key);
      this.hass.setEntity(lamp.entity, command, { urgent });
    }
    // What the page draws: the colour of each light. True when it moved.
    const shown = this.shownOf(cells);
    if (JSON.stringify(shown) === JSON.stringify(this.state.shown)) return false;
    this.state = { ...this.state, shown };
    return true;
  }

  /** The colour of every light, its brightest channel at 1: the colour and not the brightness. */
  private shownOf(cells: Rgbw[]): Record<string, Rgbw> {
    const shown: Record<string, Rgbw> = {};
    for (const lamp of this.lamps) {
      if (lamp.cell < 0) continue;
      const colour = cells[lamp.cell] ?? WHITE;
      const peak = Math.max(colour.red, colour.green, colour.blue, colour.white);
      const round = (part: number) => Math.round((peak > 0 ? part / peak : part) * 100) / 100;
      shown[lamp.id] = {
        red: round(colour.red),
        green: round(colour.green),
        blue: round(colour.blue),
        white: round(colour.white),
      };
    }
    return shown;
  }
}
