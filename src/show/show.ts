/**
 * The show: what has been programmed. That is the palettes, and the groups with their scenes
 * and their looks.
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
 * its group together; it names them and holds no copy of them. The show knows fixtures by
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
 *       looks:
 *         drop:
 *           label: Drop
 *           lights: chase
 *           colour: { palette: sunset, speed: 0.25 }
 *           motion: scissor-slow
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
  /** Id of a scene of the group of type lights. */
  lights?: string;
  colour?: LookColour;
  /** Id of a scene of the group of type motion. */
  motion?: string;
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
  looks: Look[];
}

export interface Show {
  /** In the order of the file. */
  palettes: Palette[];
  /** In the order of the file. */
  groups: Group[];
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
  return makeId(label, taken, 'look');
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
    looks: [],
  }));
  if (fixtures.length > 1) {
    const ids = fixtures.map((fixture) => fixture.id);
    groups.push({
      id: makeId('All', new Set(ids), 'all'),
      label: 'All',
      fixtures: ids,
      scenes: [],
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

function readLooks(listed: unknown, group: Group, palettes: readonly Palette[]): Look[] {
  if (listed === null || listed === undefined) return [];
  if (!isObject(listed)) {
    throw new ShowError(`group "${group.id}": "looks" must be a list of looks by their id`);
  }

  const looks: Look[] = [];
  for (const [id, look] of entries(listed)) {
    const where = `look "${id}" of group "${group.id}"`;
    if (!ID.test(id)) throw new ShowError(`${where}: ${ID_RULE}`);
    if (!isObject(look)) throw new ShowError(`${where} must have a label and what it sets`);
    const extra = Object.keys(look).find(
      (key) => !['label', 'lights', 'colour', 'motion'].includes(key),
    );
    if (extra !== undefined) {
      throw new ShowError(`${where} cannot have "${extra}", only label, lights, colour and motion`);
    }
    try {
      const read: Look = {
        id,
        label: look.label === undefined ? id : readLabel(look.label, 'look'),
      };
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
      (key) => key !== 'label' && key !== 'fixtures' && key !== 'scenes' && key !== 'looks',
    );
    if (extra !== undefined) {
      throw new ShowError(
        `${where} cannot have "${extra}", only label, fixtures, scenes and looks`,
      );
    }
    const read: Group = { id, label: id, fixtures: [], scenes: [], looks: [] };
    try {
      if (group.label !== undefined) read.label = readLabel(group.label, 'group');
      read.fixtures = readGroupFixtures(group.fixtures ?? [], known.fixtures);
    } catch (error) {
      throw new ShowError(`${where}: ${message(error)}`);
    }
    read.scenes = readScenes(group.scenes, read, known, ` of ${where}`);
    read.looks = readLooks(group.looks, read, palettes);
    groups.push(read);
  }
  return groups;
}

/**
 * Reads what the file holds as a show. Throws a `ShowError` that says what is wrong. The
 * palettes, the groups, and the scenes and looks of a group, can be a `Map`, which keeps their
 * order.
 */
export function readShow(data: unknown, known: KnownFixtures): Show {
  if (data === null || data === undefined) {
    return { palettes: startingPalettes(), groups: startingGroups(known.fixtures) };
  }
  if (!isObject(data)) throw new ShowError('the show must start with "groups:"');
  const unknown = Object.keys(data).find(
    (key) => key !== 'groups' && key !== 'scenes' && key !== 'palettes',
  );
  if (unknown !== undefined) {
    throw new ShowError(`the show cannot have "${unknown}", only palettes and groups`);
  }
  // A show without the key has the palettes a show starts with. Writing it to the file is what
  // the first change from the deck does.
  const palettes = data.palettes === undefined ? startingPalettes() : readPalettes(data.palettes);
  if (data.groups !== undefined) {
    if (data.scenes !== undefined) {
      throw new ShowError(
        'the show has "scenes" next to "groups". A scene belongs to a group: put it under the "scenes" of its group',
      );
    }
    return { palettes, groups: readGroups(data.groups, known, palettes) };
  }

  // From before there were groups: the scenes are for every fixture.
  const groups = startingGroups(known.fixtures);
  const all = groups[groups.length - 1];
  if (all) {
    all.scenes = readScenes(data.scenes, all, known, '');
  } else if (isObject(data.scenes) && entries(data.scenes).length > 0) {
    throw new ShowError('the show has scenes, and there is no fixture they can be for');
  }
  return { palettes, groups };
}
