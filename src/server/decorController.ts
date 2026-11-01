/**
 * The decor (Jeroen, 2026-10-30 and 2026-10-31): what is part of the set and not of the lighting,
 * driven through Home Assistant. It is a fixture of its own, "Decor", and not lamps of the room,
 * because it has none of what the room has: no palette, no scene, no look. There are two sorts of
 * thing in it.
 *
 * **Switches** (the two UV lamps that light the symbols on a cabinet, `switch.uv_lamp_1` and
 * `switch.uv_lamp_2`): on or off, apart or together, and nothing else.
 *
 * **Strips** (three strips of WLED in white dryer hoses, `light.wled_buis1` to `3`, for an industrial
 * look, with an effect as if a liquid flows through the pipe): each is on or off and has a colour of
 * its own (they do not follow the palettes of the show), a brightness and an effect of WLED's own,
 * which the strip itself lists (`effect_list`) and Home Assistant passes on. The speed of the effect
 * follows the tempo: the bpm times the master speed, as a number of 0 to 255 for WLED's `number`
 * entity of the strip (`SPEED_PER_BPM`, a first guess to be set by eye). The strips run on whatever
 * the tempo is, also while the music has stopped: the tempo keeps its last bpm. They are not driven
 * by the beat itself: a liquid does not have to hit the beat, and what Home Assistant can take
 * (about 4 commands a second for everything) does not allow it.
 *
 * Nothing of the decor is in a scene: a look, a recall, a step of a sequence or the Off of a group
 * neither switches a switch or a strip on nor off, as nothing but the operator switches the rails of
 * the room, so a scene that names one is refused. The blackout is not state, it changes what goes
 * out and leaves what is set: an item goes off at once with the blackout of the console when it
 * follows it (`follows`, which the rig file gives at the start and the tablet changes while the show
 * runs, per switch and per strip: Jeroen "I want to be able to set whether they take part in the
 * general blackout"), and back on when it is lifted, if it was set on. The blackout of the decor
 * alone (`blackout` in the state) is the operator pressing it on purpose, and switches everything of
 * the decor off whether it follows or not. The grand master scales the brightness of the strips (Jeroen,
 * 2026-10-31), together with the dimmer of the pipes (`pipesDimmer`, Jeroen: the UV lamps and the pipes are
 * not the same at all, so each has a dimmer of its own, and there is no dimmer of the decor; a switch cannot
 * dim, so the UV lamps have none to set), which is for the strips alone and in no scene; at 0
 * the strips are off, and so is what follows the master, a switch too.
 *
 * A press is urgent (a few things, pressed by hand: they answer at once, not after the second that a
 * lamp waits between two commands; the budget of the output still counts), a change of brightness
 * alone is not: a fader or the master makes many, and the newest wins.
 *
 * Strips have looks (Jeroen, 2026-10-31): an effect with its colours, which a key sets on the pipes.
 * WLED's effects have more than one colour, but Home Assistant sets one (`rgb_color`, colour 1); the
 * others come from the palette of WLED, a `select` entity, so a look is an effect, a palette, a colour
 * 1, an intensity and a pace. The looks are in the rig file; the page sends what a look names.
 *
 * Lightdeck never touches anything at startup: it stays as it is until something is set, and what
 * Home Assistant says is shown next to what is wanted (`reported`, `problems`) and never changes
 * it. The decor stays as it is when lightdeck stops, as the lamps of the room do.
 */

import { EventEmitter } from 'node:events';
import { SPEEDS } from '../engine/effects.js';
import { type PaletteBook, shownSlots } from '../engine/palette.js';
import {
  findPipeEffect,
  PIPE_EFFECTS,
  type PipeColour,
  pipeColours,
  renderPipe,
  segmentBytes,
} from '../engine/pipeEffects.js';
import type { SceneType } from '../fixtures/profile.js';
import {
  numberCommand,
  paletteCommand,
  stripCommand,
  switchCommand,
} from '../outputs/hass/encode.js';
import type { EntityReport, HassCommand, HassOutput } from '../outputs/hass/types.js';
import { DdpSender } from '../outputs/wled/ddp.js';
import { type DecorSetup, defaultSetup, fitSetup } from './decorSetup.js';
import { type FixtureController, PatchError, readObject } from './fixture.js';
import type { Tempo } from './tempo.js';

/** One switch of Home Assistant in the decor. */
export interface SwitchDefinition {
  /** Names the switch within the fixture: `uv1`. */
  id: string;
  /** What the operator calls it. */
  label: string;
  /** The entity in Home Assistant: `switch.uv_lamp_1`. */
  entity: string;
  /** Whether it goes off in the blackout of the console, at the start. Default false. */
  blackout?: boolean;
}

/** One strip of WLED in the decor. */
export interface StripDefinition {
  /** Names the strip within the fixture: `buis1`. */
  id: string;
  label: string;
  /** The light of the strip in Home Assistant: `light.wled_buis1`. */
  entity: string;
  /** The `number` entity of its speed. Default: the one WLED makes, `number.wled_buis1_speed`. */
  speed?: string;
  /** The `number` entity of its intensity. Default `number.wled_buis1_intensity`. */
  intensity?: string;
  /** The `select` entity of its palette. Default `select.wled_buis1_color_palette`. */
  palette?: string;
  /** Its colour at the start, `#rrggbb`. Default white. */
  colour?: string;
  /**
   * Who draws the effects: `lightdeck`, the default (the effects of `engine/pipeEffects.ts`, in the
   * colours of a palette of the show, sent over DDP to the strip), or `wled` (an effect of WLED's own,
   * chosen through Home Assistant).
   */
  draw?: 'lightdeck' | 'wled';
  /**
   * The address of the strip on the network, for the effects lightdeck draws. Without it lightdeck asks
   * Home Assistant, which knows it from WLED (`sensor.wled_buis1_ip`), and the strip is drawn as soon as
   * it is online.
   */
  host?: string;
  /** The `sensor` entity that says the address. Default `sensor.wled_buis1_ip`. */
  ip?: string;
  /** How many LEDs the strip has, for the effects lightdeck draws. Default 300. */
  leds?: number;
  /** Whether it goes off in the blackout of the console, at the start. Default false. */
  blackout?: boolean;
}

/**
 * A look of the pipes: an effect with its colours, as a key to press (Jeroen, 2026-10-31). It names what
 * it sets and leaves the rest: whether the pipes are on and how bright stay as they are.
 */
export interface PipeLookDefinition {
  id: string;
  label: string;
  /**
   * The effect: for a pipe that lightdeck draws the id of one of its effects (`flow`, `shot` ...), for
   * one that WLED draws the name of an effect of WLED; null is the solid colour.
   */
  effect: string | null;
  /**
   * The palette: for a pipe that lightdeck draws the id of a palette of the show, for one that WLED draws
   * the name of a palette of WLED. A look with more than one colour is mostly a palette.
   */
  palette?: string;
  /** Colour 1, `#rrggbb`: what an effect that works on colour 1 shows, and `* Color 1` as palette. */
  colour?: string;
  /** WLED's intensity, 0 to 255 (for a comet the length of the tail). */
  intensity?: number;
  /** The pace on top of the bpm, one of the speeds of the console. Default 1. */
  pace?: number;
}

/** What Home Assistant says about a switch or a strip. */
export interface ItemReport {
  available: boolean;
  on: boolean;
  /** The effects a strip offers, when it has said. */
  effects?: string[];
  /** The effect a strip shows, when it has said. */
  effect?: string | null;
}

/** The colour of a strip, each 0..1. */
export interface StripColour {
  red: number;
  green: number;
  blue: number;
}

export interface DecorState {
  /** Per switch and per strip, whether it is set on. At rest off. */
  on: Record<string, boolean>;
  /** Per switch and per strip, whether it goes off with the blackout of the console. Part of no scene. */
  follows: Record<string, boolean>;
  /** The blackout of the decor alone: everything off, with what is set kept. */
  blackout: boolean;
  /** Per strip, the effect of WLED it shows, or null for the solid colour. */
  effect: Record<string, string | null>;
  /** Per strip, its colour. */
  colour: Record<string, StripColour>;
  /** Per strip, its brightness, 0..1. */
  level: Record<string, number>;
  /** The brightness of all the strips together, 0..1. Not part of any scene. At rest 1. */
  pipesDimmer: number;
  /** Per strip, the palette of WLED by name, or null: then the strip's own palette is left as it is. */
  palette: Record<string, string | null>;
  /** Per strip, WLED's intensity 0 to 255, or null: then it is left as it is. */
  intensity: Record<string, number | null>;
  /** Per strip, the pace on top of the bpm, one of the speeds of the console. At rest 1. */
  pace: Record<string, number>;
  /** Per pipe that lightdeck draws, where it is, or null while it is not known. Not set with `update`. */
  hosts: Record<string, string | null>;
  /** Per strip, the palettes it lists (its `select` entity), when it has said. Not set with `update`. */
  palettes: Record<string, string[]>;
  /**
   * Whether the pipes that lightdeck draws are one long pipe (Jeroen, 2026-11-01): one effect runs through
   * them one after the other, in the order of `order`. Then the effect, the palette and the pace are set on
   * all of them at once; on and the brightness stay per pipe.
   */
  linked: boolean;
  /** The pipes that lightdeck draws, in the order they follow each other when linked. */
  order: string[];
  /** Per pipe that lightdeck draws, whether it is mounted the other way round (linked or not). */
  reverse: Record<string, boolean>;
  /** What Home Assistant says per item. Not set with `update`. */
  reported: Record<string, ItemReport | null>;
  /** Why the last command for an item did not arrive, or null. */
  problems: Record<string, string | null>;
}

export interface DecorOptions {
  hass: HassOutput;
  switches?: readonly SwitchDefinition[];
  strips?: readonly StripDefinition[];
  /** The looks of the pipes. */
  looks?: readonly PipeLookDefinition[];
  /** The tempo that the speed of the strips follows. Without it the speed is left to the strips. */
  tempo?: Tempo;
  /** The palettes of the show, whose colours the pipes that lightdeck draws are given. */
  palettes?: PaletteBook;
  /** How a sender of pixels is made for a host. Tests pass their own. */
  makeSender?: (host: string) => PixelSender;
  /** How a strip that lightdeck draws is put in its safe state (on, solid black). Tests pass their own. */
  setIdle?: (host: string) => Promise<unknown>;
  /** How the pipes are put together at the start (see `decorSetup.ts`); without it apart, in the order of the rig. */
  setup?: DecorSetup;
  /** Told whenever the linking, the order or the direction of the pipes changes, so that it can be kept. */
  onSetup?: (setup: DecorSetup) => void;
}

/** What the controller needs of a sender of pixels. */
export interface PixelSender {
  send(pixels: Uint8Array): void;
  close(): void;
}

const ID = /^[a-z0-9][a-z0-9-]*$/;
const SWITCH_ENTITY = /^switch\.[a-z0-9_]+$/;
const LIGHT_ENTITY = /^light\.[a-z0-9_]+$/;
const NUMBER_ENTITY = /^number\.[a-z0-9_]+$/;
const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const SELECT_ENTITY = /^select\.[a-z0-9_]+$/;
const SENSOR_ENTITY = /^sensor\.[a-z0-9_]+$/;
/** An address of the kind that WLED says: four numbers. */
const ADDRESS = /^\d{1,3}(\.\d{1,3}){3}$/;
const UPDATE_KEYS = [
  'on',
  'follows',
  'blackout',
  'effect',
  'colour',
  'level',
  'pipesDimmer',
  'palette',
  'intensity',
  'pace',
  'look',
  'linked',
  'order',
  'reverse',
];
/** WLED's own intensity when nothing is said: a look without one goes back to it. */
export const DEFAULT_INTENSITY = 128;
/** The palette that lets an effect use its own colours: a look without one goes back to it. */
export const DEFAULT_PALETTE = 'Default';

/**
 * WLED's speed (0 to 255) for each beat per minute: at 126 bpm a speed of 126. A first guess, to be
 * set by eye on the real strips, for the effect that is chosen: WLED's speed is no tempo.
 */
export const SPEED_PER_BPM = 1;
/** A strip's speed is sent again when it would differ by this much: a bpm that wobbles sends nothing. */
export const SPEED_STEP = 3;
/** The seconds a strip takes to go to a new colour or brightness. */
const TRANSITION_S = 0.4;
const WHITE: StripColour = { red: 1, green: 1, blue: 1 };

/** The speed number that WLED gets for a tempo: bpm times the master speed, 1 to 255. */
export function stripSpeed(bpm: number, rate: number): number {
  return Math.min(255, Math.max(1, Math.round(bpm * rate * SPEED_PER_BPM)));
}

/** The colour of `#rrggbb`, or undefined for anything else. */
export function readHex(value: string): StripColour | undefined {
  const parsed = HEX.exec(value);
  if (!parsed) return undefined;
  const [red = 0, green = 0, blue = 0] = parsed
    .slice(1)
    .map((part) => Number.parseInt(part, 16) / 255);
  return { red, green, blue };
}

interface Strip extends StripDefinition {
  speed: string;
  intensity: string;
  palette: string;
  /** Whether lightdeck draws it: the default. */
  rendered: boolean;
  /** The entity that says its address, when the rig file does not. */
  ipEntity: string;
  leds: number;
}

/** Frames per second of the pipes that lightdeck draws: a head crosses a pipe in a few of them. */
export const PIPE_FPS = 40;
/** The most LEDs a strip may have for the effects lightdeck draws. */
const MAX_LEDS = 2000;
/** Black frames sent when a pipe goes dark, before it is let go of. */
const BLACK_FRAMES = 3;

export class DecorController extends EventEmitter implements FixtureController {
  readonly takesPalettes = false;

  private readonly hass: HassOutput;
  private readonly tempo: Tempo | undefined;
  private readonly palettes: PaletteBook | undefined;
  private readonly makeSender: (host: string) => PixelSender;
  private readonly setIdle: (host: string) => Promise<unknown>;
  private readonly onSetup: ((setup: DecorSetup) => void) | undefined;
  /** The picture of the pipes that are drawn together (one long pipe, or one pipe), by number of LEDs. */
  private readonly floatsBySize = new Map<number, Float32Array>();
  private readonly switches: SwitchDefinition[];
  private readonly strips: Strip[];
  private readonly looks: PipeLookDefinition[];
  private readonly stops: Array<() => void> = [];
  /** What each item was last wanted to be, so that only a change is a command. */
  private readonly wanted = new Map<string, string>();
  /** The same without the brightness: a change of brightness alone is not urgent, a drag makes many. */
  private readonly wantedBase = new Map<string, string>();
  /** Why the last command for an item did not arrive: the light, or what else is sent to a strip. */
  private readonly problemsOf = new Map<string, Map<string, string>>();
  /** What each strip was last sent of its speed, its intensity and its palette. */
  private readonly sentSpeed = new Map<string, number>();
  private readonly sentIntensity = new Map<string, number>();
  private readonly sentPalette = new Map<string, string>();
  /** The senders of the pipes that lightdeck draws, by strip, and the pictures they are made in. */
  private readonly senders = new Map<string, PixelSender>();
  private readonly pictures = new Map<string, Uint8Array>();
  /** The pipes that are lit now, and how many black frames each still has to send after going dark. */
  private readonly lit = new Set<string>();
  private readonly blackLeft = new Map<string, number>();
  /** Where each pipe that lightdeck draws is: from the rig file, else from what Home Assistant says. */
  private readonly hosts = new Map<string, string>();
  /** The pipes that were put in their safe state in WLED (on, solid black) since lightdeck started. */
  private readonly idled = new Set<string>();
  private frameTimer: ReturnType<typeof setTimeout> | undefined;
  private frameDue = 0;
  private disposed = false;

  private state: DecorState;
  /** The blackout of the console. It is not part of the state of the fixture. */
  private blackout = false;
  /** The grand master of the console, 0 to 1: it scales the strips and, at 0, switches off what follows it. */
  private master = 1;

  /** Throws an `Error` that says what is wrong with the switches, the strips or the looks. */
  constructor(options: DecorOptions) {
    super();
    this.hass = options.hass;
    this.tempo = options.tempo;
    this.palettes = options.palettes;
    this.makeSender = options.makeSender ?? ((host) => new DdpSender({ host }));
    this.setIdle = options.setIdle ?? putStripIdle;
    this.onSetup = options.onSetup;
    const switches = [...(options.switches ?? [])];
    const strips = [...(options.strips ?? [])];
    if (switches.length + strips.length === 0) {
      throw new Error('the decor needs at least one switch or strip');
    }
    const ids = new Set<string>();
    const entities = new Set<string>();
    const claim = (id: string, entity: string, what: string) => {
      if (!ID.test(id)) {
        throw new Error(`"${id}" cannot name a ${what}: use small letters, digits and dashes`);
      }
      if (ids.has(id)) throw new Error(`two things in the decor are called "${id}"`);
      ids.add(id);
      if (entities.has(entity)) throw new Error(`${entity} is used twice in the decor`);
      entities.add(entity);
    };
    for (const definition of switches) {
      if (!SWITCH_ENTITY.test(definition.entity)) {
        throw new Error(
          `the switch "${definition.id}" has the entity "${definition.entity}", which is not a switch of Home Assistant (switch.name)`,
        );
      }
      claim(definition.id, definition.entity, 'switch');
    }
    const made: Strip[] = [];
    for (const definition of strips) {
      if (!LIGHT_ENTITY.test(definition.entity)) {
        throw new Error(
          `the strip "${definition.id}" has the entity "${definition.entity}", which is not a light of Home Assistant (light.name)`,
        );
      }
      if (definition.colour !== undefined && !readHex(definition.colour)) {
        throw new Error(`the colour of the strip "${definition.id}" must be #rrggbb`);
      }
      const rendered = definition.draw !== 'wled';
      const leds = definition.leds ?? 300;
      if (!rendered && definition.host !== undefined) {
        throw new Error(`the strip "${definition.id}" is drawn by WLED and has no host`);
      }
      if (rendered) {
        if (definition.host?.trim() === '') {
          throw new Error(`the host of the strip "${definition.id}" must be an address`);
        }
        if (!Number.isInteger(leds) || leds < 1 || leds > MAX_LEDS) {
          throw new Error(`the strip "${definition.id}" needs 1 to ${MAX_LEDS} LEDs`);
        }
      }
      claim(definition.id, definition.entity, 'strip');
      // A strip that lightdeck draws is sent pixels and needs nothing of WLED but its light; one that WLED
      // draws is also given a speed, an intensity and a palette through Home Assistant.
      const name = definition.entity.slice('light.'.length);
      const speed = definition.speed ?? `number.${name}_speed`;
      const intensity = definition.intensity ?? `number.${name}_intensity`;
      const palette = definition.palette ?? `select.${name}_color_palette`;
      if (!rendered) {
        for (const [what, entity, shape] of [
          ['speed', speed, NUMBER_ENTITY],
          ['intensity', intensity, NUMBER_ENTITY],
          ['palette', palette, SELECT_ENTITY],
        ] as const) {
          if (!shape.test(entity)) {
            throw new Error(
              `the ${what} of the strip "${definition.id}" is "${entity}", which is not a ${shape === NUMBER_ENTITY ? 'number' : 'select'} entity of Home Assistant`,
            );
          }
        }
        for (const entity of [speed, intensity, palette]) {
          if (entities.has(entity)) throw new Error(`${entity} is used twice in the decor`);
          entities.add(entity);
        }
      }
      const ipEntity = definition.ip ?? `sensor.${name}_ip`;
      if (rendered && definition.host === undefined && !SENSOR_ENTITY.test(ipEntity)) {
        throw new Error(
          `the address of the strip "${definition.id}" is "${ipEntity}", which is not a sensor of Home Assistant`,
        );
      }
      made.push({ ...definition, speed, intensity, palette, rendered, leds, ipEntity });
    }
    this.switches = switches.map((definition) => ({ ...definition }));
    this.strips = made;
    this.looks = readLooks(options.looks ?? []);

    const items = [...this.switches, ...this.strips];
    this.state = {
      on: Object.fromEntries(items.map(({ id }) => [id, false])),
      follows: Object.fromEntries(items.map(({ id, blackout }) => [id, blackout === true])),
      blackout: false,
      effect: Object.fromEntries(this.strips.map(({ id }) => [id, null])),
      colour: Object.fromEntries(
        this.strips.map(({ id, colour }) => [id, (colour && readHex(colour)) || { ...WHITE }]),
      ),
      level: Object.fromEntries(this.strips.map(({ id }) => [id, 1])),
      pipesDimmer: 1,
      palette: Object.fromEntries(this.strips.map(({ id }) => [id, null])),
      intensity: Object.fromEntries(this.strips.map(({ id }) => [id, null])),
      pace: Object.fromEntries(this.strips.map(({ id }) => [id, 1])),
      palettes: Object.fromEntries(this.strips.map(({ id }) => [id, []])),
      ...this.fitted(options.setup),
      hosts: Object.fromEntries(this.strips.map((each) => [each.id, each.host ?? null])),
      reported: Object.fromEntries(items.map(({ id }) => [id, null])),
      problems: Object.fromEntries(items.map(({ id }) => [id, null])),
    };
    for (const each of this.strips)
      if (each.rendered && each.host) this.hosts.set(each.id, each.host);
    // What everything is wanted to be at the start, so that only a change is a command.
    for (const each of this.switches) this.wanted.set(each.id, this.keyOfSwitch(each.id));
    for (const each of this.strips) this.rememberStrip(each);

    for (const each of items) {
      this.stops.push(
        this.hass.watch(each.entity, (report) => this.heard(each.id, report)),
        this.hass.problems(each.entity, (problem) => this.complained(each.id, 'light', problem)),
      );
    }
    // A pipe that lightdeck draws and has no address in the rig file is found through Home Assistant.
    for (const each of this.strips.filter((strip) => strip.rendered && !strip.host)) {
      this.complained(
        each.id,
        'address',
        'waiting for the address of the strip from Home Assistant',
      );
      this.stops.push(this.hass.watch(each.ipEntity, (report) => this.heardAddress(each, report)));
    }
    for (const each of this.strips.filter((strip) => !strip.rendered)) {
      // What else is sent to a strip may be refused too: it shows under its name.
      for (const [kind, entity] of [
        ['speed', each.speed],
        ['intensity', each.intensity],
        ['palette', each.palette],
      ] as const) {
        this.stops.push(
          this.hass.problems(entity, (problem) =>
            this.complained(each.id, kind, problem === null ? null : `the ${kind}: ${problem}`),
          ),
        );
      }
      // The palettes that the strip offers come from its `select` entity.
      this.stops.push(
        this.hass.watch(each.palette, (report) => this.heardPalettes(each.id, report)),
      );
    }
    // The strips follow the tempo: a bpm that moves (rekordbox, the slider, the master speed) moves them.
    if (this.tempo && this.strips.length > 0) {
      const onTempo = () => this.sync();
      this.tempo.on('tempo', onTempo);
      this.stops.push(() => this.tempo?.off('tempo', onTempo));
    }
  }

  getState(): DecorState {
    return {
      on: { ...this.state.on },
      follows: { ...this.state.follows },
      blackout: this.state.blackout,
      effect: { ...this.state.effect },
      colour: Object.fromEntries(
        Object.entries(this.state.colour).map(([id, colour]) => [id, { ...colour }]),
      ),
      level: { ...this.state.level },
      pipesDimmer: this.state.pipesDimmer,
      palette: { ...this.state.palette },
      intensity: { ...this.state.intensity },
      pace: { ...this.state.pace },
      palettes: Object.fromEntries(
        Object.entries(this.state.palettes).map(([id, list]) => [id, [...list]]),
      ),
      linked: this.state.linked,
      order: [...this.state.order],
      reverse: { ...this.state.reverse },
      hosts: { ...this.state.hosts },
      reported: Object.fromEntries(
        Object.entries(this.state.reported).map(([id, report]) => [
          id,
          report && { ...report, ...(report.effects ? { effects: [...report.effects] } : {}) },
        ]),
      ),
      problems: { ...this.state.problems },
    };
  }

  describe(): Record<string, unknown> {
    return {
      switches: this.switches.map(({ id, label, entity }) => ({ id, label, entity })),
      strips: this.strips.map(
        ({ id, label, entity, speed, intensity, palette, rendered, leds }) => ({
          id,
          label,
          entity,
          speed,
          intensity,
          palette,
          rendered,
          leds,
        }),
      ),
      pipeEffects: PIPE_EFFECTS.map(({ id, name, description }) => ({ id, name, description })),
      looks: this.looks.map((look) => ({ ...look })),
      paces: SPEEDS,
      speedPerBpm: SPEED_PER_BPM,
    };
  }

  update(change: unknown, origin?: string): void {
    const given = readObject(change, 'a change of the decor', UPDATE_KEYS);
    const patch = this.withLooks(given);
    const on = { ...this.state.on };
    const follows = { ...this.state.follows };
    const effect = { ...this.state.effect };
    const colour = { ...this.state.colour };
    const level = { ...this.state.level };
    const palette = { ...this.state.palette };
    const intensity = { ...this.state.intensity };
    const pace = { ...this.state.pace };
    const known = (id: string) => [...this.switches, ...this.strips].some((each) => each.id === id);
    const isStrip = (id: string) => this.strips.some((each) => each.id === id);

    const map = (key: string): Record<string, unknown> | undefined => {
      const given = patch[key];
      return given === undefined ? undefined : readObject(given, `"${key}" of the decor`);
    };
    for (const [key, target] of [
      ['on', on],
      ['follows', follows],
    ] as const) {
      for (const [id, value] of Object.entries(map(key) ?? {})) {
        if (!known(id)) throw new PatchError(`there is nothing called "${id}" in the decor`);
        if (typeof value !== 'boolean') {
          throw new PatchError(`"${key}" of "${id}" must be true or false`);
        }
        target[id] = value;
      }
    }
    const strip = (key: string, id: string) => {
      if (!known(id)) throw new PatchError(`there is nothing called "${id}" in the decor`);
      if (!isStrip(id)) throw new PatchError(`"${id}" is a switch: it has no ${key}`);
    };
    for (const [id, value] of Object.entries(map('effect') ?? {})) {
      strip('effect', id);
      if (
        value !== null &&
        (typeof value !== 'string' || value.trim() === '' || value.length > 64)
      ) {
        throw new PatchError(`the effect of "${id}" must be the name of an effect, or null`);
      }
      const offered = this.state.reported[id]?.effects;
      if (this.stripOf(id)?.rendered) {
        if (typeof value === 'string' && !findPipeEffect(value)) {
          throw new PatchError(`there is no effect for the pipes called "${value}"`);
        }
      } else if (
        typeof value === 'string' &&
        offered &&
        offered.length > 0 &&
        !offered.includes(value)
      ) {
        throw new PatchError(`"${id}" has no effect called "${value}"`);
      }
      effect[id] = value as string | null;
    }
    for (const [id, value] of Object.entries(map('palette') ?? {})) {
      strip('palette', id);
      if (
        value !== null &&
        (typeof value !== 'string' || value.trim() === '' || value.length > 64)
      ) {
        throw new PatchError(`the palette of "${id}" must be the name of a palette, or null`);
      }
      const offered = this.state.palettes[id];
      if (this.stripOf(id)?.rendered) {
        // The colours of a pipe that lightdeck draws are those of a palette of the show.
        if (typeof value === 'string' && this.palettes && !this.palettes.get(value)) {
          throw new PatchError(`there is no palette called "${value}"`);
        }
      } else if (
        typeof value === 'string' &&
        offered &&
        offered.length > 0 &&
        !offered.includes(value)
      ) {
        throw new PatchError(`"${id}" has no palette called "${value}"`);
      }
      palette[id] = value as string | null;
    }
    for (const [id, value] of Object.entries(map('colour') ?? {})) {
      strip('colour', id);
      if (this.stripOf(id)?.rendered) {
        throw new PatchError(
          `the colours of "${id}" come from its palette, not from a colour of its own`,
        );
      }
      const given = readObject(value, `the colour of "${id}"`, ['red', 'green', 'blue']);
      const next: StripColour = { red: 0, green: 0, blue: 0 };
      for (const part of ['red', 'green', 'blue'] as const) {
        const number = given[part];
        if (typeof number !== 'number' || !(number >= 0 && number <= 1)) {
          throw new PatchError(`the ${part} of the colour of "${id}" must be a number from 0 to 1`);
        }
        next[part] = number;
      }
      colour[id] = next;
    }
    for (const [id, value] of Object.entries(map('level') ?? {})) {
      strip('level', id);
      if (typeof value !== 'number' || !(value >= 0 && value <= 1)) {
        throw new PatchError(`the level of "${id}" must be a number from 0 to 1`);
      }
      level[id] = value;
    }
    for (const [id, value] of Object.entries(map('intensity') ?? {})) {
      strip('intensity', id);
      if (this.stripOf(id)?.rendered)
        throw new PatchError(`"${id}" is drawn by lightdeck: it has no intensity`);
      if (value !== null && (typeof value !== 'number' || !(value >= 0 && value <= 255))) {
        throw new PatchError(`the intensity of "${id}" must be a number from 0 to 255, or null`);
      }
      intensity[id] = value === null ? null : Math.round(value as number);
    }
    for (const [id, value] of Object.entries(map('pace') ?? {})) {
      strip('pace', id);
      if (typeof value !== 'number' || !SPEEDS.includes(value)) {
        throw new PatchError(`the pace of "${id}" must be one of ${SPEEDS.join(', ')}`);
      }
      pace[id] = value;
    }
    const drawn = this.strips.filter((each) => each.rendered).map((each) => each.id);
    let linked = this.state.linked;
    if (patch.linked !== undefined) {
      if (typeof patch.linked !== 'boolean') throw new PatchError('"linked" must be true or false');
      linked = patch.linked;
    }
    let order = this.state.order;
    if (patch.order !== undefined) {
      const given = patch.order;
      if (
        !Array.isArray(given) ||
        given.length !== drawn.length ||
        new Set(given).size !== drawn.length ||
        !given.every((id) => typeof id === 'string' && drawn.includes(id))
      ) {
        throw new PatchError(
          `the order must list each pipe that lightdeck draws once: ${drawn.join(', ') || 'there are none'}`,
        );
      }
      order = [...(given as string[])];
    }
    const reverse = { ...this.state.reverse };
    for (const [id, value] of Object.entries(map('reverse') ?? {})) {
      if (!drawn.includes(id)) {
        throw new PatchError(
          `"${id}" is not a pipe that lightdeck draws: it has no direction to turn`,
        );
      }
      if (typeof value !== 'boolean') {
        throw new PatchError(`"reverse" of "${id}" must be true or false`);
      }
      reverse[id] = value;
    }
    // Linked pipes are one pipe: what is set on one of them goes to all, and when they come to be linked they
    // all take what the first of them shows.
    if (linked && drawn.length > 1) {
      for (const [key, target] of [
        ['effect', effect],
        ['palette', palette],
        ['pace', pace],
      ] as const) {
        const named = Object.keys(map(key) ?? {}).filter((id) => drawn.includes(id));
        const from = named.at(-1) ?? (this.state.linked ? undefined : order[0]);
        if (from === undefined) continue;
        for (const id of drawn) (target as Record<string, unknown>)[id] = target[from];
      }
    }
    const setupChanged =
      linked !== this.state.linked ||
      order.join() !== this.state.order.join() ||
      drawn.some((id) => reverse[id] !== this.state.reverse[id]);
    let pipesDimmer = this.state.pipesDimmer;
    if (patch.pipesDimmer !== undefined) {
      if (
        typeof patch.pipesDimmer !== 'number' ||
        !(patch.pipesDimmer >= 0 && patch.pipesDimmer <= 1)
      ) {
        throw new PatchError('the dimmer of the pipes must be a number from 0 to 1');
      }
      pipesDimmer = patch.pipesDimmer;
    }
    if (patch.blackout !== undefined && typeof patch.blackout !== 'boolean') {
      throw new PatchError('the blackout must be true or false');
    }
    const blackout = (patch.blackout as boolean | undefined) ?? this.state.blackout;
    this.state = {
      ...this.state,
      on,
      follows,
      effect,
      colour,
      level,
      pipesDimmer,
      palette,
      intensity,
      pace,
      linked,
      order,
      reverse,
      blackout,
    };
    this.sync();
    this.emit('state', this.getState(), origin);
    if (setupChanged) this.onSetup?.({ linked, order: [...order], reverse: { ...reverse } });
  }

  /** The way the pipes are put together at the start, made to fit the pipes that lightdeck draws. */
  private fitted(setup: DecorSetup | undefined): Pick<DecorState, 'linked' | 'order' | 'reverse'> {
    const ids = this.strips.filter((each) => each.rendered).map((each) => each.id);
    return setup ? fitSetup(setup, ids) : defaultSetup(ids);
  }

  /**
   * A change with the looks it names written out: `look: { buis1: 'shot' }` sets the effect, the palette,
   * the colour, the intensity and the pace of that look on that strip. What the look does not say goes back
   * to what WLED starts with (the palette Default, intensity 128, pace 1) so that a look does not carry
   * what the one before it set; its colour is left as it is when it names none. A key that the change names
   * itself wins over the look.
   */
  private withLooks(change: Record<string, unknown>): Record<string, unknown> {
    if (change.look === undefined) return change;
    const named = readObject(change.look, '"look" of the decor');
    const merged: Record<string, unknown> = { ...change };
    delete merged.look;
    const put = (key: string, id: string, value: unknown) => {
      const own = merged[key];
      const map = own === undefined ? {} : { ...readObject(own, `"${key}" of the decor`) };
      if (!(id in map)) map[id] = value;
      merged[key] = map;
    };
    for (const [id, lookId] of Object.entries(named)) {
      if (!this.strips.some((each) => each.id === id)) {
        throw new PatchError(`there is no strip called "${id}" in the decor`);
      }
      const look = this.looks.find((each) => each.id === lookId);
      if (!look) throw new PatchError(`there is no look called "${String(lookId)}"`);
      put('effect', id, look.effect);
      put('pace', id, look.pace ?? 1);
      if (this.stripOf(id)?.rendered) {
        // The colours are those of the palette, which a look without one leaves as it is.
        if (look.palette !== undefined) put('palette', id, look.palette);
        continue;
      }
      put('palette', id, look.palette ?? DEFAULT_PALETTE);
      put('intensity', id, look.intensity ?? DEFAULT_INTENSITY);
      if (look.colour !== undefined) put('colour', id, readHex(look.colour));
    }
    return merged;
  }

  private stripOf(id: string): Strip | undefined {
    return this.strips.find((each) => each.id === id);
  }

  /** The decor is part of no scene: there is nothing to keep. */
  snapshot(_type: SceneType): Record<string, unknown> {
    return {};
  }

  /** A part that names anything is refused, because nothing of the decor is in a scene. */
  check(_type: SceneType, part: unknown): void {
    if (part === undefined || part === null) return;
    const named = Object.keys(readObject(part, 'the decor in a scene'));
    if (named.length > 0) {
      throw new PatchError(
        `the decor is part of no scene, so a scene cannot name "${named[0]}": the decor is set by hand`,
      );
    }
  }

  /** Leaves the decor as it is on a recall, whatever the type: a look or the Off of a group is not for it. */
  recall(type: SceneType, part: unknown): void {
    this.check(type, part);
  }

  act(name: string): void {
    throw new PatchError(`the decor has nothing called "${name}"`);
  }

  setBlackout(blackout: boolean): void {
    if (blackout === this.blackout) return;
    this.blackout = blackout;
    this.sync();
  }

  /**
   * The grand master scales the brightness of the strips, and at 0 it switches off what follows it, as it
   * does for the switches of the room (Jeroen, 2026-10-31: the pipes did not keep to the master).
   */
  setMaster(level: number): void {
    const master = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0));
    if (master === this.master) return;
    this.master = master;
    this.sync();
  }

  /**
   * The switches and the strips of WLED stay as they are when lightdeck stops, as the lamps of the room do.
   * The pipes that lightdeck draws go dark: they get black frames, and what is left of them is the dark
   * state they were put in.
   */
  darken(): void {
    this.blackAll();
  }

  private blackAll(): void {
    for (const strip of this.strips) {
      if (!strip.rendered || !this.senders.has(strip.id)) continue;
      for (let i = 0; i < BLACK_FRAMES; i++) this.drawBlack(strip);
    }
    this.lit.clear();
    this.blackLeft.clear();
  }

  close(): void {
    this.blackAll();
    for (const sender of this.senders.values()) sender.close();
    this.senders.clear();
    if (this.frameTimer) clearTimeout(this.frameTimer);
    this.frameTimer = undefined;
    this.disposed = true;
    for (const stop of this.stops) stop();
    this.stops.length = 0;
    this.removeAllListeners();
  }

  // --- what goes out ----------------------------------------------------------------------

  /** What an item should be now: set on, and not blacked out by the decor's own blackout or the console's. */
  private goal(id: string): boolean {
    if (!this.state.on[id]) return false;
    if (this.state.blackout) return false;
    const follows = this.state.follows[id];
    return !(follows && (this.blackout || this.master === 0));
  }

  private keyOfSwitch(id: string): string {
    return String(this.goal(id));
  }

  /** The brightness a strip is sent: its own level, the dimmer of the pipes and the master. */
  private brightnessOf(id: string): number {
    if (!this.goal(id)) return 0;
    return (this.state.level[id] ?? 1) * this.state.pipesDimmer * this.master;
  }

  /** The command a strip should have: its look while it is on, off while it is not. */
  private stripCommandOf(strip: Strip): HassCommand {
    const brightness = this.brightnessOf(strip.id);
    return stripCommand({
      brightness,
      colour: this.state.colour[strip.id] ?? WHITE,
      effect: this.state.effect[strip.id] ?? null,
      transition: brightness > 0 ? TRANSITION_S : 0,
    });
  }

  /** What a strip was wanted to be, as two keys: all of it, and all of it but the brightness. */
  private keysOfStrip(strip: Strip): { full: string; base: string } {
    const command = this.stripCommandOf(strip);
    const {
      transition: _transition,
      brightness,
      ...rest
    } = (command.data ?? {}) as Record<string, unknown>;
    return {
      base: JSON.stringify([command.service, rest]),
      full: JSON.stringify([command.service, rest, brightness ?? 0]),
    };
  }

  private rememberStrip(strip: Strip): void {
    const { full, base } = this.keysOfStrip(strip);
    this.wanted.set(strip.id, full);
    this.wantedBase.set(strip.id, base);
  }

  /** Sends a command to everything that is to be something else than it was last wanted to be. */
  private sync(): void {
    if (this.disposed) return;
    for (const each of this.switches) {
      const key = this.keyOfSwitch(each.id);
      if (key === this.wanted.get(each.id)) continue;
      this.wanted.set(each.id, key);
      this.hass.setEntity(each.entity, switchCommand(this.goal(each.id)), { urgent: true });
    }
    for (const each of this.strips) {
      if (each.rendered) {
        this.syncRendered(each);
        continue;
      }
      this.syncSettings(each);
      const { full, base } = this.keysOfStrip(each);
      if (full === this.wanted.get(each.id)) continue;
      // A change of brightness alone waits its turn (a drag of a fader makes many, the newest wins); a
      // press on an effect, a colour or the switch does not.
      const urgent = base !== this.wantedBase.get(each.id);
      this.wanted.set(each.id, full);
      this.wantedBase.set(each.id, base);
      this.hass.setEntity(each.entity, this.stripCommandOf(each), { urgent });
    }
  }

  /**
   * What else a strip that is on is told, before its light: the palette and the intensity when they have
   * been set, and the speed, which follows the tempo in steps of `SPEED_STEP` so that a bpm that wobbles by
   * tenths sends nothing. A strip that is off is told when it comes on.
   */
  private syncSettings(strip: Strip): void {
    if (!this.goal(strip.id)) return;
    const { id } = strip;
    const palette = this.state.palette[id];
    if (palette !== null && palette !== undefined && this.sentPalette.get(id) !== palette) {
      this.sentPalette.set(id, palette);
      this.hass.setEntity(strip.palette, paletteCommand(palette), { urgent: true });
    }
    const intensity = this.state.intensity[id];
    if (intensity !== null && intensity !== undefined && this.sentIntensity.get(id) !== intensity) {
      this.sentIntensity.set(id, intensity);
      this.hass.setEntity(strip.intensity, numberCommand(intensity), { urgent: true });
    }
    if (!this.tempo) return;
    const { bpm, rate } = this.tempo.getState();
    const speed = stripSpeed(bpm, rate * (this.state.pace[id] ?? 1));
    const last = this.sentSpeed.get(id);
    if (last !== undefined && Math.abs(speed - last) < SPEED_STEP) return;
    this.sentSpeed.set(id, speed);
    this.hass.setEntity(strip.speed, numberCommand(speed), { urgent: true });
  }

  // --- the pipes that lightdeck draws -----------------------------------------------------

  /**
   * A pipe that lightdeck draws is lit while it is set on, not dark and above 0: then frames go to it, 40 a
   * second. When it goes dark it gets a few black frames and is let go of. The first time it is lit it is
   * put in its safe state in WLED (on, solid black): WLED shows no stream while it is off, and it shows its
   * own state when the stream stops, which must be dark (Jeroen, 2026-10-31).
   */
  private syncRendered(strip: Strip): void {
    const id = strip.id;
    if (this.brightnessOf(id) > 0) {
      this.blackLeft.delete(id);
      this.lit.add(id);
      this.ensureFrames();
    } else if (this.lit.delete(id)) {
      this.blackLeft.set(id, BLACK_FRAMES);
      this.ensureFrames();
    }
  }

  private putIdle(strip: Strip): void {
    const host = this.hosts.get(strip.id) ?? '';
    this.setIdle(host).then(
      () => this.complained(strip.id, 'idle', null),
      (error: unknown) =>
        this.complained(
          strip.id,
          'idle',
          `could not reach the strip at ${host}: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
  }

  private ensureFrames(): void {
    if (this.frameTimer !== undefined || this.disposed) return;
    this.frameDue = performance.now();
    this.frameTimer = setTimeout(() => this.frame(), 0);
  }

  /** One frame for every pipe that is lit, and the black frames of those that went dark. */
  private frame(): void {
    this.frameTimer = undefined;
    if (this.disposed) return;
    const tempo = this.tempo?.getState();
    const bpm = tempo?.bpm ?? 126;
    const rate = tempo?.rate ?? 1;
    const beat = this.tempo ? this.tempo.outputBeat() : (performance.now() / 60_000) * bpm;
    for (const group of this.groups()) {
      // Not before a strip's address is known, and the safe state first.
      const sendable = group.filter((strip) => this.lit.has(strip.id) && this.hosts.has(strip.id));
      for (const strip of sendable) {
        if (this.idled.has(strip.id)) continue;
        this.idled.add(strip.id);
        this.putIdle(strip);
      }
      if (sendable.length > 0) this.drawGroup(group, sendable, beat, bpm, rate);
      for (const strip of group) {
        const left = this.blackLeft.get(strip.id) ?? 0;
        if (this.lit.has(strip.id) || left <= 0 || !this.hosts.has(strip.id)) continue;
        this.drawBlack(strip);
        if (left <= 1) this.blackLeft.delete(strip.id);
        else this.blackLeft.set(strip.id, left - 1);
      }
    }
    if (this.lit.size === 0 && this.blackLeft.size === 0) return;
    // On a grid of its own, from the moment it started, so that a late frame does not push the rest.
    this.frameDue += 1000 / PIPE_FPS;
    const now = performance.now();
    if (this.frameDue < now - 250) this.frameDue = now;
    this.frameTimer = setTimeout(() => this.frame(), Math.max(0, this.frameDue - now));
  }

  private bytesOf(strip: Strip): Uint8Array {
    let made = this.pictures.get(strip.id);
    if (!made) {
      made = new Uint8Array(strip.leds * 3);
      this.pictures.set(strip.id, made);
    }
    return made;
  }

  /**
   * The pipes that lightdeck draws, in groups that are drawn as one picture: all of them in the order of the
   * setup when they are linked, else each alone.
   */
  private groups(): Strip[][] {
    const drawn = this.state.order
      .map((id) => this.stripOf(id))
      .filter((strip): strip is Strip => strip?.rendered === true);
    return this.state.linked ? (drawn.length > 0 ? [drawn] : []) : drawn.map((strip) => [strip]);
  }

  private senderOf(strip: Strip): PixelSender {
    let sender = this.senders.get(strip.id);
    if (!sender) {
      sender = this.makeSender(this.hosts.get(strip.id) ?? '');
      this.senders.set(strip.id, sender);
    }
    return sender;
  }

  /**
   * Home Assistant says the address of a strip (WLED's own sensor): the strip is drawn from then on, and
   * from the new place when the address changes. A strip that is not online says `unavailable`.
   */
  private heardAddress(strip: Strip, report: EntityReport | undefined): void {
    if (this.disposed) return;
    const value = report?.available ? (report.value ?? '').trim() : '';
    const address = ADDRESS.test(value) ? value : undefined;
    if (address === this.hosts.get(strip.id)) return;
    this.senders.get(strip.id)?.close();
    this.senders.delete(strip.id);
    this.idled.delete(strip.id);
    if (address) this.hosts.set(strip.id, address);
    else this.hosts.delete(strip.id);
    this.complained(
      strip.id,
      'address',
      address ? null : 'waiting for the address of the strip from Home Assistant',
    );
    this.state = {
      ...this.state,
      hosts: { ...this.state.hosts, [strip.id]: address ?? null },
    };
    // A pipe that is lit gets its frames as soon as it can.
    if (address && this.lit.has(strip.id)) this.ensureFrames();
    this.emit('state', this.getState());
  }

  /** The colours of the palette of a pipe, as far as it shows them; white when it has none. */
  private coloursOf(id: string): PipeColour[] {
    const palette = this.palettes?.get(this.state.palette[id] ?? null);
    if (!palette) return [{ red: 1, green: 1, blue: 1 }];
    const colours = pipeColours(palette.colours.slice(0, shownSlots(palette)));
    return colours.length > 0 ? colours : [{ red: 1, green: 1, blue: 1 }];
  }

  /**
   * Draws one effect over the whole group, as long as its pipes are together, and gives each of its pipes that
   * is lit its piece, from the first pipe on and back to front for one that is mounted the other way round.
   * The effect, the palette and the pace are the first pipe's (linked pipes have the same).
   */
  private drawGroup(
    group: readonly Strip[],
    sendable: readonly Strip[],
    beat: number,
    bpm: number,
    rate: number,
  ): void {
    const head = group[0];
    if (!head) return;
    const effect = findPipeEffect(this.state.effect[head.id] ?? 'solid');
    if (!effect) return;
    const total = group.reduce((sum, strip) => sum + strip.leds, 0);
    let floats = this.floatsBySize.get(total);
    if (!floats) {
      floats = new Float32Array(total * 3);
      this.floatsBySize.set(total, floats);
    }
    renderPipe(
      effect,
      beat,
      bpm,
      (this.state.pace[head.id] ?? 1) * rate,
      total,
      this.coloursOf(head.id),
      floats,
    );
    let offset = 0;
    for (const strip of group) {
      if (sendable.includes(strip)) {
        const bytes = this.bytesOf(strip);
        segmentBytes(
          floats,
          offset,
          strip.leds,
          this.state.reverse[strip.id] === true,
          this.brightnessOf(strip.id),
          bytes,
        );
        this.senderOf(strip).send(bytes);
      }
      offset += strip.leds;
    }
  }

  private drawBlack(strip: Strip): void {
    const bytes = this.bytesOf(strip);
    bytes.fill(0);
    this.senderOf(strip).send(bytes);
  }

  // --- what Home Assistant says -----------------------------------------------------------

  private heard(id: string, report: EntityReport | undefined): void {
    if (this.disposed) return;
    const before = this.state.reported[id];
    const after: ItemReport | null = report
      ? {
          available: report.available,
          on: report.on,
          ...(report.effects ? { effects: [...report.effects] } : {}),
          ...(report.effect !== undefined ? { effect: report.effect } : {}),
        }
      : null;
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    this.state = { ...this.state, reported: { ...this.state.reported, [id]: after } };
    this.emit('state', this.getState());
  }

  /** The palettes that a strip lists. */
  private heardPalettes(id: string, report: EntityReport | undefined): void {
    if (this.disposed) return;
    const list = report?.options ?? [];
    if (JSON.stringify(this.state.palettes[id]) === JSON.stringify(list)) return;
    this.state = { ...this.state, palettes: { ...this.state.palettes, [id]: [...list] } };
    this.emit('state', this.getState());
  }

  /**
   * Why a command of an item did not arrive. Of the things a strip is sent, the light, the speed, the
   * intensity and the palette, any may be what went wrong; the light's comes first.
   */
  private complained(id: string, kind: string, problem: string | null): void {
    if (this.disposed) return;
    const here = this.problemsOf.get(id) ?? new Map<string, string>();
    this.problemsOf.set(id, here);
    if (problem === null) here.delete(kind);
    else here.set(kind, problem);
    const now = here.get('light') ?? [...here.values()][0] ?? null;
    if (this.state.problems[id] === now) return;
    this.state = { ...this.state, problems: { ...this.state.problems, [id]: now } };
    this.emit('state', this.getState());
  }
}

/**
 * Puts a strip of WLED in its safe state through its own JSON API: on, solid black, full brightness. It has to
 * be on to show a stream, and what it shows when the stream stops is this, which is dark.
 */
async function putStripIdle(host: string): Promise<void> {
  const answer = await fetch(`http://${host}/json/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      on: true,
      bri: 255,
      transition: 0,
      seg: [
        {
          id: 0,
          fx: 0,
          col: [
            [0, 0, 0],
            [0, 0, 0],
            [0, 0, 0],
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(3000),
  });
  if (!answer.ok) throw new Error(`the strip answered ${answer.status}`);
}

/** The looks of the pipes of a rig file, checked. */
function readLooks(looks: readonly PipeLookDefinition[]): PipeLookDefinition[] {
  const made: PipeLookDefinition[] = [];
  for (const look of looks) {
    const where = `the look "${look.id}"`;
    if (!ID.test(look.id)) {
      throw new Error(`"${look.id}" cannot name a look: use small letters, digits and dashes`);
    }
    if (made.some((each) => each.id === look.id))
      throw new Error(`two looks are called "${look.id}"`);
    if (look.effect !== null && (typeof look.effect !== 'string' || look.effect.trim() === '')) {
      throw new Error(`${where} needs the name of an effect, or null for the solid colour`);
    }
    if (look.colour !== undefined && !readHex(look.colour)) {
      throw new Error(`the colour of ${where} must be #rrggbb`);
    }
    if (look.intensity !== undefined && !(look.intensity >= 0 && look.intensity <= 255)) {
      throw new Error(`the intensity of ${where} must be from 0 to 255`);
    }
    if (look.pace !== undefined && !SPEEDS.includes(look.pace)) {
      throw new Error(`the pace of ${where} must be one of ${SPEEDS.join(', ')}`);
    }
    made.push({ ...look });
  }
  return made;
}
