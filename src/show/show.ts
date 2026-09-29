/**
 * The show: what has been programmed. For now that is the groups with their scenes.
 *
 * A group is a named set of fixtures, and a scene is a look for the fixtures of one
 * group. For every fixture it names, a scene holds what that fixture should be doing, in
 * the form the controller of the fixture gives and takes; a fixture of the group that it
 * does not name is dark. The show knows fixtures by their id only. Which fixtures there
 * are, and whether one of them can take a part, is handed to it.
 *
 * In the file the groups are a map from id to group, and so are the scenes of a group:
 *
 *   groups:
 *     spider:
 *       label: Spider
 *       fixtures: [spider]
 *       scenes:
 *         amber-chase:
 *           label: Amber chase
 *           fixtures:
 *             spider:
 *               levels: { dimmer: 1 }
 *               effect: { id: chase, colourA: ..., colourB: ... }
 *
 * A show without a file starts with a group for every fixture and one for all of them.
 * A file from before there were groups has `scenes:` at the top. It is read as those
 * starting groups, with its scenes in the group of all fixtures.
 */

import { PatchError } from '../server/fixture.js';

export interface Scene {
  /** Names the scene in the file and in the API: `amber-chase`. Its own within its group. */
  id: string;
  /** What the operator calls it. */
  label: string;
  /** By fixture id, what the controller of that fixture keeps of it. */
  fixtures: Record<string, unknown>;
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
}

export interface Show {
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

/** Throws when the fixture cannot take this part. */
export type CheckPart = (fixture: string, part: unknown) => void;

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
  }));
  if (fixtures.length > 1) {
    const ids = fixtures.map((fixture) => fixture.id);
    groups.push({
      id: makeId('All', new Set(ids), 'all'),
      label: 'All',
      fixtures: ids,
      scenes: [],
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
    if (!isObject(scene)) throw new ShowError(`${where} must have a label and fixtures`);
    const extra = Object.keys(scene).find((key) => key !== 'label' && key !== 'fixtures');
    if (extra !== undefined) {
      throw new ShowError(`${where} cannot have "${extra}", only label and fixtures`);
    }
    const fixtures = scene.fixtures ?? {};
    if (!isObject(fixtures)) throw new ShowError(`${where}: "fixtures" must name fixtures`);
    try {
      const label = scene.label === undefined ? id : readLabel(scene.label);
      for (const [fixture, part] of Object.entries(fixtures)) {
        if (!known.fixtures.some((each) => each.id === fixture)) {
          throw new PatchError(noFixture(fixture, known.fixtures));
        }
        if (!group.fixtures.includes(fixture)) {
          throw new PatchError(
            `"${fixture}" is not a fixture of this group, which has ${group.fixtures.join(', ')}`,
          );
        }
        known.check(fixture, part);
      }
      scenes.push({ id, label, fixtures });
    } catch (error) {
      throw new ShowError(`${where}: ${message(error)}`);
    }
  }
  return scenes;
}

function readGroups(listed: unknown, known: KnownFixtures): Group[] {
  if (listed === null) return [];
  if (!isObject(listed)) throw new ShowError('"groups" must be a list of groups by their id');

  const groups: Group[] = [];
  for (const [id, group] of entries(listed)) {
    const where = `group "${id}"`;
    if (!ID.test(id)) throw new ShowError(`${where}: ${ID_RULE}`);
    if (!isObject(group)) throw new ShowError(`${where} must have a label, fixtures and scenes`);
    const extra = Object.keys(group).find(
      (key) => key !== 'label' && key !== 'fixtures' && key !== 'scenes',
    );
    if (extra !== undefined) {
      throw new ShowError(`${where} cannot have "${extra}", only label, fixtures and scenes`);
    }
    const read: Group = { id, label: id, fixtures: [], scenes: [] };
    try {
      if (group.label !== undefined) read.label = readLabel(group.label, 'group');
      read.fixtures = readGroupFixtures(group.fixtures ?? [], known.fixtures);
    } catch (error) {
      throw new ShowError(`${where}: ${message(error)}`);
    }
    read.scenes = readScenes(group.scenes, read, known, ` of ${where}`);
    groups.push(read);
  }
  return groups;
}

/**
 * Reads what the file holds as a show. Throws a `ShowError` that says what is wrong. The
 * groups, and the scenes of a group, can be a `Map`, which keeps their order.
 */
export function readShow(data: unknown, known: KnownFixtures): Show {
  if (data === null || data === undefined) return { groups: startingGroups(known.fixtures) };
  if (!isObject(data)) throw new ShowError('the show must start with "groups:"');
  const unknown = Object.keys(data).find((key) => key !== 'groups' && key !== 'scenes');
  if (unknown !== undefined) {
    throw new ShowError(`the show cannot have "${unknown}", only groups`);
  }
  if (data.groups !== undefined) {
    if (data.scenes !== undefined) {
      throw new ShowError(
        'the show has "scenes" next to "groups". A scene belongs to a group: put it under the "scenes" of its group',
      );
    }
    return { groups: readGroups(data.groups, known) };
  }

  // From before there were groups: the scenes are for every fixture.
  const groups = startingGroups(known.fixtures);
  const all = groups[groups.length - 1];
  if (all) {
    all.scenes = readScenes(data.scenes, all, known, '');
  } else if (isObject(data.scenes) && entries(data.scenes).length > 0) {
    throw new ShowError('the show has scenes, and there is no fixture they can be for');
  }
  return { groups };
}
