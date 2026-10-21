/**
 * The show: what has been programmed. That is the palettes, the groups with their scenes
 * and their looks, and the sequences that change the looks of the groups by themselves.
 *
 * A palette is a list of colours that the effects take their colours from, kept once for the
 * whole show (`engine/palette.ts`). Colour is the one type of the three that belongs to no
 * fixture, so it is a palette and not a scene.
 *
 * A group is a named set of fixtures, and a scene is a part of a look for the fixtures of
 * one group, of one type: lights or motion. For every fixture it names, a scene
 * holds the properties of its type that fixture should have, in the form the controller of
 * the fixture gives and takes; a fixture of the group that it does not name has those
 * properties at rest. A look is a key that sets a light scene, a palette and a motion scene of
 * its group together; it names them and holds no copy of them. A mood is a list of the scenes
 * and palettes of the group that go together (a minimal mood, a stormy one): a look can be in
 * one, and the tablet then offers the rest of the mood to vary the look with. A mood changes
 * nothing by itself. The show knows fixtures by
 * their id only. Which fixtures there are, and whether one of them can take a part, is handed
 * to it.
 *
 * In the file the palettes, the groups, and the scenes and looks of a group are maps from id:
 *
 *   palettes:
 *     sunset:
 *       label: Sunset
 *       colours: ['#ff4a00', off, '#ffb000']
 *       mode: cycle                     # static | cycle
 *       change: fade                    # step | fade
 *       speed: 0.25
 *   limits:                             # what a fixture may not do, whatever sets it
 *     spider:
 *       tilt:                           # per bar, in the order of the bars
 *         - { min: 0, max: 0.87 }
 *         - { min: 0, max: 0.87 }
 *   groups:
 *     spider:
 *       label: Spider
 *       fixtures: [spider]
 *       scenes:
 *         chase:
 *           label: Chase
 *           type: lights
 *           fixtures:
 *             spider:
 *               levels: { dimmer: 1 }
 *               effect: { id: chase }
 *       moods:                        # what fits together, for the tablet (Jeroen, 2026-10-20)
 *         minimal:
 *           label: Minimal
 *           lights: [chase, pulse]        # scenes of lights
 *           colour: [sunset, ice]         # palettes
 *           motion: [scissor-slow]        # scenes of motion
 *       looks:
 *         drop:
 *           label: Drop
 *           mood: minimal                 # optional: the mood the look is in
 *           lights: chase
 *           colour: { palette: sunset, speed: 0.25 }
 *           motion: scissor-slow
 *
 *   sequences:                          # the looks of the groups, changing on the bars
 *     night:
 *       label: The night
 *       steps:
 *         - bars: 32                  # a step lasts a number of bars
 *           looks: { spider: doors-open, room: welcome }
 *         - bars: 32
 *           looks: { spider: haunted }   # the room is left on welcome
 *         - bars: 4
 *           looks: { spider: off }       # off is the lights of the group
 *
 * A show without a file starts with a group for every fixture and one for all of them, and
 * the palettes `startingPalettes` gives. A file from before there were groups has `scenes:` at
 * the top. It is read as those starting groups, with its scenes in the group of all fixtures.
 * A scene without a type is a mistake, and so is a scene of the colour type: the scenes of
 * before there were types and the colour scenes of before there were palettes are not read.
 */

import { SPEEDS } from '../engine/effects.js';
import {
  type Palette,
  PaletteError,
  readPaletteFields,
  startingPalettes,
} from '../engine/palette.js';
import type { SceneType } from '../fixtures/profile.js';
import { PatchError } from '../server/fixture.js';

/** The types of scene that are stored in a group. Colour is a palette of the show. */
export const STORED_TYPES = ['lights', 'motion'] as const;
export type StoredType = (typeof STORED_TYPES)[number];

export const isStoredType = (value: unknown): value is StoredType =>
  STORED_TYPES.includes(value as StoredType);

export interface Scene {
  /** Names the scene in the file and in the API: `amber-chase`. Its own within its group. */
  id: string;
  /** What the operator calls it. */
  label: string;
  /** Which properties of the fixtures it sets. */
  type: StoredType;
  /** By fixture id, what the controller of that fixture keeps of it for this type. */
  fixtures: Record<string, unknown>;
}

/** The palette a look sets, and the pace it gives it instead of the pace of the palette. */
export interface LookColour {
  palette: string;
  /** One of `SPEEDS`, or absent for the pace of the palette itself. */
  speed?: number;
}

/**
 * A key that sets a scene of lights, a palette and a scene of motion together. A lane that a
 * look does not name is left as it is.
 */
export interface Look {
  /** Names the look in the file and in the API. Its own within its group. */
  id: string;
  /** What the operator calls it. */
  label: string;
  /** Id of a mood of the group this look is in, or absent. */
  mood?: string;
  /** Id of a scene of the group of type lights. */
  lights?: string;
  colour?: LookColour;
  /** Id of a scene of the group of type motion. */
  motion?: string;
}

/**
 * Scenes and palettes of a group that go together, to vary a look with: a minimal mood, a stormy
 * one. It sets nothing, it only says what the tablet offers while a look of the mood is on.
 */
export interface Mood {
  /** Names the mood in the file and in the API. Its own within its group. */
  id: string;
  /** What the operator calls it. */
  label: string;
  /** Ids of scenes of the group of type lights. */
  lights: string[];
  /** Ids of palettes of the show. */
  colour: string[];
  /** Ids of scenes of the group of type motion. */
  motion: string[];
}

export interface Group {
  /** Names the group in the file and in the API: `spider`. */
  id: string;
  /** What the operator calls it. */
  label: string;
  /** Ids of its fixtures, in order. At least one, and none of them twice. */
  fixtures: string[];
  /** In the order of the file. */
  scenes: Scene[];
  /** In the order of the file. */
  moods: Mood[];
  /** In the order of the file. */
  looks: Look[];
}

/** A step of a sequence: how long it lasts, and the look it sets in each group it names. */
export interface SequenceStep {
  /** A whole number of bars, 1 to `MAX_BARS`. */
  bars: number;
  /**
   * By the id of a group, the id of a look of that group, or `off` for the lights of the group.
   * A group that is not named is left as it is.
   */
  looks: Record<string, string>;
}

/** A list of steps that runs on the tempo, a step after the other, and starts over at the end. */
export interface Sequence {
  /** Names the sequence in the file and in the API. */
  id: string;
  /** What the operator calls it. */
  label: string;
  /** At least one, in the order they run. */
  steps: SequenceStep[];
}

/** The longest a step can last: a bit more than an hour at 126 bpm. */
export const MAX_BARS = 999;

export interface Show {
  /**
   * What the show limits of a fixture, by the id of the fixture, in the form its controller
   * gave back from `readLimits`. A fixture that is not here is not limited.
   */
  limits: Record<string, unknown>;
  /** In the order of the file. */
  palettes: Palette[];
  /** In the order of the file. */
  groups: Group[];
  /** In the order of the file. */
  sequences: Sequence[];
}

/** The data cannot be the show. The message is for the operator. */
export class ShowError extends Error {}

/** A fixture of the rig, as far as the show has to know it. */
export interface ShowFixture {
  id: string;
  label: string;
}

/** Throws when the fixture cannot take this part of a scene of this type. */
export type CheckPart = (fixture: string, type: SceneType, part: unknown) => void;

/** What the show is told about the fixtures of the rig. */
export interface KnownFixtures {
  /** In the order of the rig. */
  fixtures: readonly ShowFixture[];
  check: CheckPart;
  /**
   * Reads the limits that the file has for a fixture and gives them back as the controller
   * takes them, or throws a `PatchError` when the fixture cannot have them. Without it no
   * fixture can have limits.
   */
  readLimits?: (fixture: string, limits: unknown) => unknown;
}

export const MAX_LABEL = 40;
/** What every group has besides its scenes, so no scene can be called this. */
export const OFF = 'off';
const ID = /^[a-z0-9][a-z0-9-]*$/;
const ID_RULE = 'an id has small letters, digits and dashes only';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The ids in a map of the file, with what they name. A `Map` has them in the order of the
 * file. A plain object has not, where an id is a number.
 */
const entries = (listed: Record<string, unknown>): [string, unknown][] =>
  listed instanceof Map
    ? [...listed].map(([id, named]) => [String(id), named])
    : Object.entries(listed);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const tidyLabel = (label: string) => label.replace(/\s+/g, ' ').trim();

/** A name as the operator typed it, without the space around it. `what` is what it names. */
export function readLabel(value: unknown, what = 'scene'): string {
  if (typeof value !== 'string') throw new PatchError(`a ${what} needs a name`);
  const label = tidyLabel(value);
  if (label === '') throw new PatchError(`a ${what} needs a name`);
  if (label.length > MAX_LABEL) {
    throw new PatchError(`the name of a ${what} can have ${MAX_LABEL} characters at most`);
  }
  return label;
}

/** The type of a scene as it was given. Throws a `PatchError` when it is neither lights nor motion. */
export function readSceneType(value: unknown): StoredType {
  if (value === 'colour') {
    throw new PatchError('colours are palettes now, and not scenes: a scene is lights or motion');
  }
  if (!isStoredType(value)) {
    throw new PatchError(`a scene needs a type: ${STORED_TYPES.join(' or ')}`);
  }
  return value;
}

/** An id made from the name, with a number behind it when that id is taken. */
function makeId(label: string, taken: ReadonlySet<string>, nameless: string): string {
  const base =
    label
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || nameless;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** The id of a new scene, by its name. `taken` has the ids of the scenes of its group. */
export function sceneId(label: string, taken: ReadonlySet<string>): string {
  return makeId(label, new Set([...taken, OFF]), 'scene');
}

/** The id of a new group, by its name. */
export function groupId(label: string, taken: ReadonlySet<string>): string {
  return makeId(label, taken, 'group');
}

/** The id of a new palette, by its name. */
export function paletteId(label: string, taken: ReadonlySet<string>): string {
  return makeId(label, taken, 'palette');
}

/** The id of a new look, by its name. `taken` has the ids of the looks of its group. */
export function lookId(label: string, taken: ReadonlySet<string>): string {
  return makeId(label, new Set([...taken, OFF]), 'look');
}

function noFixture(id: string, fixtures: readonly ShowFixture[]): string {
  const known = fixtures.map((fixture) => fixture.id).join(', ');
  return `there is no fixture called "${id}"${known === '' ? '' : `, only ${known}`}`;
}

/** The fixtures of a group as they were given. Throws a `PatchError` when they cannot be. */
export function readGroupFixtures(value: unknown, fixtures: readonly ShowFixture[]): string[] {
  if (!Array.isArray(value)) {
    throw new PatchError('"fixtures" must be a list of the fixtures of the group');
  }
  if (value.length === 0) throw new PatchError('a group needs at least one fixture');
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id !== 'string') throw new PatchError('a fixture of a group is named by its id');
    if (!fixtures.some((fixture) => fixture.id === id)) {
      throw new PatchError(noFixture(id, fixtures));
    }
    if (ids.includes(id)) throw new PatchError(`"${id}" is in the group twice`);
    ids.push(id);
  }
  return ids;
}

/**
 * The groups a show starts with: one for every fixture, and after those one for all of
 * them. With one fixture its own group is the group of all.
 */
export function startingGroups(fixtures: readonly ShowFixture[]): Group[] {
  const groups: Group[] = fixtures.map(({ id, label }) => ({
    id,
    label: tidyLabel(label).slice(0, MAX_LABEL).trim() || id,
    fixtures: [id],
    scenes: [],
    moods: [],
    looks: [],
  }));
  if (fixtures.length > 1) {
    const ids = fixtures.map((fixture) => fixture.id);
    groups.push({
      id: makeId('All', new Set(ids), 'all'),
      label: 'All',
      fixtures: ids,
      scenes: [],
      moods: [],
      looks: [],
    });
  }
  return groups;
}

/** `place` says where the scenes are: nothing at the top of the file, or ` of group "x"`. */
function readScenes(listed: unknown, group: Group, known: KnownFixtures, place: string): Scene[] {
  if (listed === null || listed === undefined) return [];
  if (!isObject(listed)) {
    const where = place === '' ? '' : `group "${group.id}": `;
    throw new ShowError(`${where}"scenes" must be a list of scenes by their id`);
  }

  const scenes: Scene[] = [];
  for (const [id, scene] of entries(listed)) {
    const where = `scene "${id}"${place}`;
    if (!ID.test(id)) throw new ShowError(`${where}: ${ID_RULE}`);
    if (id === OFF) {
      throw new ShowError(
        `${where}: "${OFF}" cannot be the id of a scene, every group has an off already`,
      );
    }
    if (!isObject(scene)) throw new ShowError(`${where} must have a label, a type and fixtures`);
    const extra = Object.keys(scene).find(
      (key) => key !== 'label' && key !== 'type' && key !== 'fixtures',
    );
    if (extra !== undefined) {
      throw new ShowError(`${where} cannot have "${extra}", only label, type and fixtures`);
    }
    const fixtures = scene.fixtures ?? {};
    if (!isObject(fixtures)) throw new ShowError(`${where}: "fixtures" must name fixtures`);
    try {
      const label = scene.label === undefined ? id : readLabel(scene.label);
      const type = readSceneType(scene.type);
      for (const [fixture, part] of Object.entries(fixtures)) {
        if (!known.fixtures.some((each) => each.id === fixture)) {
          throw new PatchError(noFixture(fixture, known.fixtures));
        }
        if (!group.fixtures.includes(fixture)) {
          throw new PatchError(
            `"${fixture}" is not a fixture of this group, which has ${group.fixtures.join(', ')}`,
          );
        }
        known.check(fixture, type, part);
      }
      scenes.push({ id, label, type, fixtures });
    } catch (error) {
      throw new ShowError(`${where}: ${message(error)}`);
    }
  }
  return scenes;
}

/** The limits of the fixtures, as their controllers read them. */
function readLimits(listed: unknown, known: KnownFixtures): Record<string, unknown> {
  if (listed === null || listed === undefined) return {};
  if (!isObject(listed)) throw new ShowError('"limits" must be a list of limits by fixture');
  const limits: Record<string, unknown> = {};
  for (const [id, value] of entries(listed)) {
    const where = `limits of "${id}"`;
    try {
      if (!known.fixtures.some((each) => each.id === id)) {
        throw new PatchError(noFixture(id, known.fixtures));
      }
      if (!known.readLimits) throw new PatchError('this fixture cannot be limited');
      limits[id] = known.readLimits(id, value);
    } catch (error) {
      throw new ShowError(`${where}: ${message(error)}`);
    }
  }
  return limits;
}

function readPalettes(listed: unknown): Palette[] {
  if (listed === null) return [];
  if (!isObject(listed)) throw new ShowError('"palettes" must be a list of palettes by their id');

  const palettes: Palette[] = [];
  for (const [id, palette] of entries(listed)) {
    const where = `palette "${id}"`;
    if (!ID.test(id)) throw new ShowError(`${where}: ${ID_RULE}`);
    if (!isObject(palette)) throw new ShowError(`${where} must have colours`);
    try {
      const { label, ...fields } = palette;
      palettes.push({
        id,
        label: label === undefined ? id : readLabel(label, 'palette'),
        ...readPaletteFields(fields),
      });
    } catch (error) {
      if (error instanceof PaletteError || error instanceof PatchError) {
        throw new ShowError(`${where}: ${error.message}`);
      }
      throw error;
    }
  }
  return palettes;
}

/** The colour a look sets: a palette by its id, or `{ palette, speed }`. */
function readLookColour(value: unknown, palettes: readonly Palette[]): LookColour {
  const given = typeof value === 'string' ? { palette: value } : value;
  if (!isObject(given))
    throw new PatchError('"colour" must name a palette, with a speed if you like');
  const extra = Object.keys(given).find((key) => key !== 'palette' && key !== 'speed');
  if (extra !== undefined) {
    throw new PatchError(`"colour" cannot have "${extra}", only palette and speed`);
  }
  const { palette, speed } = given;
  if (typeof palette !== 'string' || !palettes.some((each) => each.id === palette)) {
    throw new PatchError(`there is no palette called "${String(palette)}"`);
  }
  if (speed === undefined) return { palette };
  if (typeof speed !== 'number' || !SPEEDS.includes(speed)) {
    throw new PatchError(`the speed of a palette must be one of ${SPEEDS.join(', ')}`);
  }
  return { palette, speed };
}

/** A scene of the group of this type, by its id. */
function sceneOfType(group: Group, id: unknown, type: StoredType): string {
  if (typeof id !== 'string') throw new PatchError(`"${type}" must name a scene by its id`);
  const scene = group.scenes.find((each) => each.id === id);
  if (!scene) throw new PatchError(`there is no scene called "${id}" in this group`);
  if (scene.type !== type) {
    throw new PatchError(`the scene "${id}" is ${scene.type}, and not ${type}`);
  }
  return id;
}

/** A list of ids in a mood, without one twice. */
function readMoodList(value: unknown, key: string, check: (id: string) => string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new PatchError(`"${key}" must be a list of ids`);
  const ids: string[] = [];
  for (const entry of value) {
    const id = check(entry as string);
    if (ids.includes(id)) throw new PatchError(`"${id}" is in "${key}" twice`);
    ids.push(id);
  }
  return ids;
}

/** The moods of a group: scenes of its own and palettes of the show that go together. */
function readMoods(listed: unknown, group: Group, palettes: readonly Palette[]): Mood[] {
  if (listed === null || listed === undefined) return [];
  if (!isObject(listed)) {
    throw new ShowError(`group "${group.id}": "moods" must be a list of moods by their id`);
  }

  const moods: Mood[] = [];
  for (const [id, mood] of entries(listed)) {
    const where = `mood "${id}" of group "${group.id}"`;
    if (!ID.test(id)) throw new ShowError(`${where}: ${ID_RULE}`);
    if (!isObject(mood)) throw new ShowError(`${where} must have a label and what goes together`);
    const extra = Object.keys(mood).find(
      (key) => !['label', 'lights', 'colour', 'motion'].includes(key),
    );
    if (extra !== undefined) {
      throw new ShowError(`${where} cannot have "${extra}", only label, lights, colour and motion`);
    }
    try {
      const read: Mood = {
        id,
        label: mood.label === undefined ? id : readLabel(mood.label, 'mood'),
        lights: readMoodList(mood.lights, 'lights', (each) => sceneOfType(group, each, 'lights')),
        colour: readMoodList(mood.colour, 'colour', (each) => {
          if (typeof each !== 'string' || !palettes.some((palette) => palette.id === each)) {
            throw new PatchError(`there is no palette called "${String(each)}"`);
          }
          return each;
        }),
        motion: readMoodList(mood.motion, 'motion', (each) => sceneOfType(group, each, 'motion')),
      };
      if (read.lights.length + read.colour.length + read.motion.length === 0) {
        throw new PatchError(
          'a mood lists at least one scene of lights, palette or scene of motion',
        );
      }
      moods.push(read);
    } catch (error) {
      throw new ShowError(`${where}: ${message(error)}`);
    }
  }
  return moods;
}

function readLooks(listed: unknown, group: Group, palettes: readonly Palette[]): Look[] {
  if (listed === null || listed === undefined) return [];
  if (!isObject(listed)) {
    throw new ShowError(`group "${group.id}": "looks" must be a list of looks by their id`);
  }

  const looks: Look[] = [];
  for (const [id, look] of entries(listed)) {
    const where = `look "${id}" of group "${group.id}"`;
    if (!ID.test(id)) throw new ShowError(`${where}: ${ID_RULE}`);
    if (id === OFF) {
      throw new ShowError(
        `${where}: "${OFF}" cannot be the id of a look, a step of a sequence says off for the lights of a group`,
      );
    }
    if (!isObject(look)) throw new ShowError(`${where} must have a label and what it sets`);
    const extra = Object.keys(look).find(
      (key) => !['label', 'mood', 'lights', 'colour', 'motion'].includes(key),
    );
    if (extra !== undefined) {
      throw new ShowError(
        `${where} cannot have "${extra}", only label, mood, lights, colour and motion`,
      );
    }
    try {
      const read: Look = {
        id,
        label: look.label === undefined ? id : readLabel(look.label, 'look'),
      };
      if (look.mood !== undefined) {
        if (typeof look.mood !== 'string' || !group.moods.some((each) => each.id === look.mood)) {
          throw new PatchError(`there is no mood called "${String(look.mood)}" in this group`);
        }
        read.mood = look.mood;
      }
      if (look.lights !== undefined) read.lights = sceneOfType(group, look.lights, 'lights');
      if (look.colour !== undefined) read.colour = readLookColour(look.colour, palettes);
      if (look.motion !== undefined) read.motion = sceneOfType(group, look.motion, 'motion');
      if (!read.lights && !read.colour && !read.motion) {
        throw new PatchError('a look sets a scene of lights, a palette or a scene of motion');
      }
      looks.push(read);
    } catch (error) {
      throw new ShowError(`${where}: ${message(error)}`);
    }
  }
  return looks;
}

function readGroups(listed: unknown, known: KnownFixtures, palettes: readonly Palette[]): Group[] {
  if (listed === null) return [];
  if (!isObject(listed)) throw new ShowError('"groups" must be a list of groups by their id');

  const groups: Group[] = [];
  for (const [id, group] of entries(listed)) {
    const where = `group "${id}"`;
    if (!ID.test(id)) throw new ShowError(`${where}: ${ID_RULE}`);
    if (!isObject(group)) throw new ShowError(`${where} must have a label, fixtures and scenes`);
    const extra = Object.keys(group).find(
      (key) =>
        key !== 'label' &&
        key !== 'fixtures' &&
        key !== 'scenes' &&
        key !== 'moods' &&
        key !== 'looks',
    );
    if (extra !== undefined) {
      throw new ShowError(
        `${where} cannot have "${extra}", only label, fixtures, scenes, moods and looks`,
      );
    }
    const read: Group = { id, label: id, fixtures: [], scenes: [], moods: [], looks: [] };
    try {
      if (group.label !== undefined) read.label = readLabel(group.label, 'group');
      read.fixtures = readGroupFixtures(group.fixtures ?? [], known.fixtures);
    } catch (error) {
      throw new ShowError(`${where}: ${message(error)}`);
    }
    read.scenes = readScenes(group.scenes, read, known, ` of ${where}`);
    read.moods = readMoods(group.moods, read, palettes);
    read.looks = readLooks(group.looks, read, palettes);
    groups.push(read);
  }
  return groups;
}

/** The sequences of the file. Every look a step names must be there, in the group it names. */
function readSequences(listed: unknown, groups: readonly Group[]): Sequence[] {
  if (listed === null || listed === undefined) return [];
  if (!isObject(listed)) {
    throw new ShowError('"sequences" must be a list of sequences by their id');
  }

  const sequences: Sequence[] = [];
  for (const [id, sequence] of entries(listed)) {
    const where = `sequence "${id}"`;
    if (!ID.test(id)) throw new ShowError(`${where}: ${ID_RULE}`);
    if (!isObject(sequence)) throw new ShowError(`${where} must have a label and steps`);
    const extra = Object.keys(sequence).find((key) => key !== 'label' && key !== 'steps');
    if (extra !== undefined) {
      throw new ShowError(`${where} cannot have "${extra}", only label and steps`);
    }
    let label = id;
    try {
      if (sequence.label !== undefined) label = readLabel(sequence.label, 'sequence');
    } catch (error) {
      throw new ShowError(`${where}: ${message(error)}`);
    }
    if (!Array.isArray(sequence.steps) || sequence.steps.length === 0) {
      throw new ShowError(`${where} needs a list of steps, at least one`);
    }
    const steps = sequence.steps.map((step, index) =>
      readStep(step, `${where}, step ${index + 1}`, groups),
    );
    sequences.push({ id, label, steps });
  }
  return sequences;
}

function readStep(step: unknown, where: string, groups: readonly Group[]): SequenceStep {
  if (!isObject(step)) throw new ShowError(`${where} must have bars and looks`);
  const extra = Object.keys(step).find((key) => key !== 'bars' && key !== 'looks');
  if (extra !== undefined)
    throw new ShowError(`${where} cannot have "${extra}", only bars and looks`);
  const { bars } = step;
  if (typeof bars !== 'number' || !Number.isInteger(bars) || bars < 1 || bars > MAX_BARS) {
    throw new ShowError(`${where}: bars must be a whole number from 1 to ${MAX_BARS}`);
  }
  if (!isObject(step.looks) || entries(step.looks).length === 0) {
    throw new ShowError(`${where} must set a look in at least one group: looks: { group: look }`);
  }
  const looks: Record<string, string> = {};
  for (const [groupId, lookId] of entries(step.looks)) {
    const group = groups.find((each) => each.id === groupId);
    if (!group) throw new ShowError(`${where}: there is no group called "${groupId}"`);
    if (typeof lookId !== 'string') {
      throw new ShowError(`${where}: the look for "${groupId}" must be the id of a look, or off`);
    }
    if (lookId !== OFF && !group.looks.some((look) => look.id === lookId)) {
      throw new ShowError(
        `${where}: there is no look called "${lookId}" in the group "${groupId}"`,
      );
    }
    looks[groupId] = lookId;
  }
  return { bars, looks };
}

/**
 * Reads what the file holds as a show. Throws a `ShowError` that says what is wrong. The
 * palettes, the groups, and the scenes and looks of a group, can be a `Map`, which keeps their
 * order.
 */
export function readShow(data: unknown, known: KnownFixtures): Show {
  if (data === null || data === undefined) {
    return {
      limits: {},
      palettes: startingPalettes(),
      groups: startingGroups(known.fixtures),
      sequences: [],
    };
  }
  if (!isObject(data)) throw new ShowError('the show must start with "groups:"');
  const unknown = Object.keys(data).find(
    (key) => !['groups', 'scenes', 'palettes', 'limits', 'sequences'].includes(key),
  );
  if (unknown !== undefined) {
    throw new ShowError(
      `the show cannot have "${unknown}", only limits, palettes, groups and sequences`,
    );
  }
  const limits = readLimits(data.limits, known);
  // A show without the key has the palettes a show starts with. Writing it to the file is what
  // the first change from the deck does.
  const palettes = data.palettes === undefined ? startingPalettes() : readPalettes(data.palettes);
  if (data.groups !== undefined) {
    if (data.scenes !== undefined) {
      throw new ShowError(
        'the show has "scenes" next to "groups". A scene belongs to a group: put it under the "scenes" of its group',
      );
    }
    const groups = readGroups(data.groups, known, palettes);
    return { limits, palettes, groups, sequences: readSequences(data.sequences, groups) };
  }

  // From before there were groups: the scenes are for every fixture.
  const groups = startingGroups(known.fixtures);
  const all = groups[groups.length - 1];
  if (all) {
    all.scenes = readScenes(data.scenes, all, known, '');
  } else if (isObject(data.scenes) && entries(data.scenes).length > 0) {
    throw new ShowError('the show has scenes, and there is no fixture they can be for');
  }
  // A file from before there were groups has no looks, so no sequence can name one.
  return { limits, palettes, groups, sequences: readSequences(data.sequences, groups) };
}
