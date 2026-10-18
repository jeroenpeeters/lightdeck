/**
 * The playback: the palettes, the groups, their scenes and looks, and what the fixtures are
 * set to.
 *
 * There is one state per fixture. What a group does is three lanes, one per type: lights,
 * colour and motion. A scene of lights or of motion is stored in the group, and recalling it
 * sets that type of properties on the fixtures of the group through their controllers, the way
 * their pages do, and leaves the other types as they are. The colour lane is not a scene: it is
 * one of the palettes of the show, which belong to no fixture, and setting one sets it on the
 * fixtures of the group that take palettes (the laser has colours of its own). After that the
 * operator can go on by hand. Fixtures outside the group are left alone, so several groups have
 * something on at once, and so do the three lanes within a group. Per group and lane the
 * playback remembers which scene or palette is on and whether the fixtures of the group still
 * are what it made them, in the properties of that type: `changed` says they are not.
 *
 * A look sets the lanes it names together, as the same presses would, and leaves a lane it does
 * not name alone. It is on until another is, and shows as changed as soon as a lane it named is
 * not what it set.
 *
 * Groups can share a fixture, and then the last press of a lane wins. A scene of "All" sets
 * the spider, so after it no scene of the same type in "Spider" is on. The other way
 * round, a scene of "Spider" leaves the scene of "All" on and shows it as changed.
 *
 * Storing takes the properties of the type from the fixtures of the group as they are now.
 * A fixture that has none of them set is left out of the scene, which comes to the same:
 * within its group and type a scene is complete, and what it does not name goes to rest.
 * Off is the lights: it darkens the fixtures and leaves their colours and motion.
 *
 * A scene that a look uses, and a palette that is on in a group or that a look uses, cannot be
 * deleted: the operator is told what uses it.
 *
 * Events: `show` (summary), `playback` (state). The playback has an emitter instead of
 * being one, because `off` is what a group has and cannot also take a listener away.
 */

import { EventEmitter } from 'node:events';
import { isMap } from 'yaml';
import { formatColour } from '../engine/colour.js';
import { SPEEDS } from '../engine/effects.js';
import {
  type Palette,
  PaletteBook,
  type PaletteChange,
  PaletteError,
  type PaletteMode,
  paletteData,
  readPaletteFields,
} from '../engine/palette.js';
import { SCENE_TYPES, type SceneType } from '../fixtures/profile.js';
import { ShowFile, setIn } from '../show/file.js';
import {
  type Group,
  groupId,
  type Look,
  lookId,
  paletteId,
  readGroupFixtures,
  readLabel,
  readSceneType,
  type Scene,
  type Show,
  type StoredType,
  sceneId,
} from '../show/show.js';
import { PatchError } from './fixture.js';
import type { RigFixture } from './rig.js';

export interface SceneSummary {
  id: string;
  label: string;
  type: StoredType;
  /** Ids of the fixtures the scene sets. The others of its group have the type at rest. */
  fixtures: string[];
}

export interface LookSummary {
  id: string;
  label: string;
  /** Id of the scene of lights it sets, or null. */
  lights: string | null;
  /** The palette it sets, with the speed that is its own, or null. */
  colour: { palette: string; speed: number | null } | null;
  /** Id of the scene of motion it sets, or null. */
  motion: string | null;
}

export interface PaletteSummary {
  id: string;
  label: string;
  /** Each as `#rrggbb`, `#rrggbbww` or `off`. */
  colours: string[];
  mode: PaletteMode;
  change: PaletteChange;
  speed: number;
}

export interface GroupSummary {
  id: string;
  label: string;
  /** Ids of the fixtures of the group. */
  fixtures: string[];
  /** True when a fixture of the group takes palettes, so that the colour lane means something. */
  palettes: boolean;
  scenes: SceneSummary[];
  looks: LookSummary[];
}

export interface ShowSummary {
  /** Where the show is kept, or null when it is kept in memory only. */
  file: string | null;
  /** What is wrong with the file, or null. While it is wrong the show stays as it was. */
  problem: string | null;
  /** What the show limits of a fixture, by the id of the fixture: the form its controller reads. */
  limits: Record<string, unknown>;
  palettes: PaletteSummary[];
  groups: GroupSummary[];
}

/** What is on in a lane of a group. */
export interface GroupState {
  /** Id of the scene of this type that is on in the group, or for colour of the palette. */
  scene: string | null;
  /** True when the fixtures of the group are no longer what that scene made them. */
  changed: boolean;
}

export interface LookState {
  /** Id of the look that was set last in the group, or null. */
  look: string | null;
  /** True when a lane the look set is not what it set any more. */
  changed: boolean;
}

export type GroupPlayback = Record<SceneType, GroupState> & { look: LookState };

export interface PlaybackState {
  /** By the id of the group, then by type. Every group of the show is there. */
  groups: Record<string, GroupPlayback>;
}

export interface PlaybackOptions {
  fixtures: readonly RigFixture[];
  /** Where the fixtures look the palettes up. The playback keeps it as the show says. */
  palettes?: PaletteBook;
  /** Where the show file is. Without it the show is kept in memory only. */
  path?: string;
}

interface On extends GroupState {
  /** The fixtures of the group as the scene made them, to tell a change by. */
  made: string;
  /** For colour, the speed that was set with the palette, or null for its own pace. */
  speed: number | null;
}

const nothingOn = (): On => ({ scene: null, changed: false, made: '', speed: null });
const nothingOnAtAll = (): Record<SceneType, On> => ({
  lights: nothingOn(),
  colour: nothingOn(),
  motion: nothingOn(),
});

function readSpeed(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !SPEEDS.includes(value)) {
    throw new PatchError(`the speed of a palette must be one of ${SPEEDS.join(', ')}`);
  }
  return value;
}

/** Turns what the palette module says is wrong into what the operator is told. */
function palette<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof PaletteError) throw new PatchError(error.message);
    throw error;
  }
}

export class Playback {
  private readonly events = new EventEmitter();
  private readonly fixtures: readonly RigFixture[];
  private readonly palettes: PaletteBook;
  private readonly file: ShowFile;
  /** By the id of the group, then by type, what is on in it. */
  private readonly groups = new Map<string, Record<SceneType, On>>();
  /** By the id of the group, the look that was set last. */
  private readonly looksOn = new Map<string, string>();
  /** The state as it was told last, to tell a change by. */
  private told = '';
  private recalling = false;

  constructor(options: PlaybackOptions) {
    this.fixtures = options.fixtures;
    this.palettes = options.palettes ?? new PaletteBook();
    this.file = new ShowFile({
      ...(options.path === undefined ? {} : { path: options.path }),
      fixtures: this.fixtures.map(({ id, label }) => ({ id, label })),
      check: (id, type, part) => this.fixture(id).controller.check(type, part),
      readLimits: (id, limits) => {
        const { controller } = this.fixture(id);
        if (!controller.readLimits) throw new PatchError('this fixture cannot be limited');
        return controller.readLimits(limits);
      },
    });
    this.follow();
    this.told = JSON.stringify(this.getState());
    this.file.on('show', () => {
      this.follow();
      this.events.emit('show', this.getShow());
      if (JSON.stringify(this.getState()) !== this.told) this.tell();
    });
    this.file.watch();
    for (const { controller } of this.fixtures) {
      controller.on('state', () => this.compare());
    }
  }

  /** After the show or the problem of its file changed. */
  on(event: 'show', listener: (show: ShowSummary) => void): void;
  /** After what is on changed, or whether it was changed by hand. */
  on(event: 'playback', listener: (state: PlaybackState) => void): void;
  on(event: string, listener: (data: never) => void): void {
    this.events.on(event, listener as (data: unknown) => void);
  }

  getShow(): ShowSummary {
    const show = this.file.getShow();
    return {
      file: this.file.path ?? null,
      problem: this.file.getProblem(),
      limits: { ...show.limits },
      palettes: show.palettes.map(({ id, label, colours, mode, change, speed }) => ({
        id,
        label,
        colours: colours.map((colour) => formatColour(colour)),
        mode,
        change,
        speed,
      })),
      groups: show.groups.map(({ id, label, fixtures, scenes, looks }) => ({
        id,
        label,
        fixtures: [...fixtures],
        palettes: this.palettesIn(fixtures).length > 0,
        scenes: scenes.map((scene) => ({
          id: scene.id,
          label: scene.label,
          type: scene.type,
          fixtures: Object.keys(scene.fixtures),
        })),
        looks: looks.map((look) => ({
          id: look.id,
          label: look.label,
          lights: look.lights ?? null,
          colour: look.colour
            ? { palette: look.colour.palette, speed: look.colour.speed ?? null }
            : null,
          motion: look.motion ?? null,
        })),
      })),
    };
  }

  getState(): PlaybackState {
    const groups: PlaybackState['groups'] = {};
    for (const group of this.file.getShow().groups) {
      const on = this.groups.get(group.id) ?? nothingOnAtAll();
      groups[group.id] = {
        lights: { scene: on.lights.scene, changed: on.lights.changed },
        colour: { scene: on.colour.scene, changed: on.colour.changed },
        motion: { scene: on.motion.scene, changed: on.motion.changed },
        look: this.lookState(group, on),
      };
    }
    return { groups };
  }

  /**
   * Sets the properties of the scene's type on the fixtures of the group to their part of
   * the scene. Fixtures of the group that the scene does not name get those properties at
   * rest, other types and fixtures outside the group are not touched.
   */
  recall(group: unknown, scene: unknown, origin?: string): void {
    const found = this.needGroup(group);
    const { id, type, fixtures } = this.needScene(found, scene);
    this.set(type, found.fixtures, fixtures, origin);
    this.turnOn(found, type, id, null);
    this.tell();
  }

  /**
   * Sets a palette of the show on the fixtures of the group that take palettes. `speed` is the
   * pace of the cycle for this use, and without it the palette has its own.
   */
  setPalette(group: unknown, name: unknown, speed?: unknown, origin?: string): void {
    const found = this.needGroup(group);
    const id = this.needPalette(name).id;
    const pace = readSpeed(speed);
    const takers = this.palettesIn(found.fixtures);
    this.setColour(found, takers, id, pace, origin);
    this.turnOn(found, 'colour', id, pace);
    this.tell();
  }

  /**
   * Darkens the fixtures of the group: that is the lights, so the colours and the motion
   * stay as they are. After that no scene of lights is on in the group.
   */
  off(group: unknown, origin?: string): void {
    const found = this.needGroup(group);
    this.set('lights', found.fixtures, {}, origin);
    this.turnOn(found, 'lights', null, null);
    this.tell();
  }

  /**
   * Sets the lanes a look names, as the same presses would. Nothing is set when any of them
   * cannot be.
   */
  playLook(group: unknown, look: unknown, origin?: string): void {
    const found = this.needGroup(group);
    const { id, lights, colour, motion } = this.needLook(found, look);
    const lightsScene = lights === undefined ? undefined : this.needScene(found, lights);
    const motionScene = motion === undefined ? undefined : this.needScene(found, motion);
    const takers = this.palettesIn(found.fixtures);
    const pace = colour ? readSpeed(colour.speed) : null;
    if (colour) this.needPalette(colour.palette);
    // All or nothing: nothing is set when a lane cannot be.
    if (lightsScene) this.checkSet(found.fixtures, 'lights', lightsScene.fixtures);
    if (colour && takers.length > 0) {
      this.checkSet(takers, 'colour', this.colourParts(takers, colour.palette, pace));
    }
    if (motionScene) this.checkSet(found.fixtures, 'motion', motionScene.fixtures);

    if (lightsScene) {
      this.set('lights', found.fixtures, lightsScene.fixtures, origin);
      this.turnOn(found, 'lights', lightsScene.id, null);
    }
    if (colour && takers.length > 0) {
      this.setColour(found, takers, colour.palette, pace, origin);
      this.turnOn(found, 'colour', colour.palette, pace);
    }
    if (motionScene) {
      this.set('motion', found.fixtures, motionScene.fixtures, origin);
      this.turnOn(found, 'motion', motionScene.id, null);
    }
    this.looksOn.set(found.id, id);
    this.tell();
  }

  // What changes the show looks up its group, its scene and the ids that are taken in the
  // show as the file has it at that moment, which can be newer than the show in memory.

  /**
   * Stores the properties of this type from the fixtures of the group as they are now as a
   * new scene, and gives its id.
   */
  store(group: unknown, type: unknown, name: unknown): string {
    const kind = readSceneType(type);
    const label = readLabel(name);
    const { found, id } = this.file.edit((document, show) => {
      const found = this.needGroup(group, show);
      const id = sceneId(label, new Set(found.scenes.map((scene) => scene.id)));
      const fixtures = this.look(found, kind);
      setIn(document, ['groups', found.id, 'scenes', id], { label, type: kind, fixtures });
      return { found, id };
    });
    this.stored(found, kind, id);
    return id;
  }

  /**
   * Stores the properties of the type of a scene that is there already from the fixtures of
   * the group as they are now. A scene keeps its type.
   */
  storeOver(group: unknown, scene: unknown): void {
    const { found, id, type } = this.file.edit((document, show) => {
      const found = this.needGroup(group, show);
      const { id, type } = this.needScene(found, scene);
      setIn(document, ['groups', found.id, 'scenes', id, 'fixtures'], this.look(found, type));
      return { found, id, type };
    });
    this.stored(found, type, id);
  }

  rename(group: unknown, scene: unknown, name: unknown): void {
    const label = readLabel(name);
    this.file.edit((document, show) => {
      const found = this.needGroup(group, show);
      const { id } = this.needScene(found, scene);
      setIn(document, ['groups', found.id, 'scenes', id, 'label'], label);
    });
  }

  /** Takes a scene away. A scene that a look of the group uses stays, and the operator is told. */
  remove(group: unknown, scene: unknown): void {
    this.file.edit((document, show) => {
      const found = this.needGroup(group, show);
      const { id, label } = this.needScene(found, scene);
      const user = found.looks.find((each) => each.lights === id || each.motion === id);
      if (user) {
        throw new PatchError(
          `the scene "${label}" is used by the look "${user.label}". Change or delete the look first`,
        );
      }
      if (!document.deleteIn(['groups', found.id, 'scenes', id])) {
        throw new PatchError(`the scene "${label}" could not be taken out of the show file`);
      }
    });
  }

  /**
   * Stores what is on in the group now as a look: the scene of lights, the palette with its
   * speed and the scene of motion. A lane with nothing on is left out. Gives its id.
   */
  storeLook(group: unknown, name: unknown): string {
    const label = readLabel(name, 'look');
    const { found, id } = this.file.edit((document, show) => {
      const found = this.needGroup(group, show);
      const id = lookId(label, new Set(found.looks.map((look) => look.id)));
      setIn(document, ['groups', found.id, 'looks', id], { label, ...this.lanesOn(found) });
      return { found, id };
    });
    this.looksOn.set(found.id, id);
    this.tell();
    return id;
  }

  /** Stores what is on in the group now in a look that is there already. */
  storeLookOver(group: unknown, look: unknown): void {
    const { found, id } = this.file.edit((document, show) => {
      const found = this.needGroup(group, show);
      const { id, label } = this.needLook(found, look);
      const lanes = this.lanesOn(found);
      // The look is replaced by lanes, and keeps its name.
      document.deleteIn(['groups', found.id, 'looks', id]);
      setIn(document, ['groups', found.id, 'looks', id], { label, ...lanes });
      return { found, id };
    });
    this.looksOn.set(found.id, id);
    this.tell();
  }

  renameLook(group: unknown, look: unknown, name: unknown): void {
    const label = readLabel(name, 'look');
    this.file.edit((document, show) => {
      const found = this.needGroup(group, show);
      const { id } = this.needLook(found, look);
      setIn(document, ['groups', found.id, 'looks', id, 'label'], label);
    });
  }

  removeLook(group: unknown, look: unknown): void {
    this.file.edit((document, show) => {
      const found = this.needGroup(group, show);
      const { id, label } = this.needLook(found, look);
      if (!document.deleteIn(['groups', found.id, 'looks', id])) {
        throw new PatchError(`the look "${label}" could not be taken out of the show file`);
      }
    });
  }

  /**
   * Limits what a fixture may do, in the form its controller reads (the spider: how far each
   * bar may tilt), and writes it to the show file. The limits are on what goes out at once.
   * `null`, or limits that limit nothing, takes them away.
   */
  setLimits(fixture: unknown, limits: unknown): void {
    if (typeof fixture !== 'string') throw new PatchError('say which fixture, by its id');
    const { controller } = this.fixture(fixture);
    if (!controller.readLimits) throw new PatchError(`"${fixture}" cannot be limited`);
    const read = controller.readLimits(limits);
    // What limits nothing is the same as none: it is not kept in the file.
    const none = JSON.stringify(read) === JSON.stringify(controller.readLimits(null));
    this.file.edit((document) => {
      if (none) {
        document.deleteIn(['limits', fixture]);
        // Nothing left to limit: the key goes too.
        const left = document.getIn(['limits']);
        if (isMap(left) && left.items.length === 0) document.deleteIn(['limits']);
      } else {
        setIn(document, ['limits', fixture], read);
      }
    });
  }

  /** Makes a palette, and gives its id. Without colours it is a single white. */
  addPalette(name: unknown, fields?: unknown): string {
    const label = readLabel(name, 'palette');
    const given = fields === undefined ? { colours: ['#000000ff'] } : fields;
    const read = palette(() => readPaletteFields(given));
    return this.file.edit((document, show) => {
      const id = paletteId(label, new Set(show.palettes.map((each) => each.id)));
      setIn(document, ['palettes', id], { label, ...paletteData(read) });
      return id;
    });
  }

  /**
   * Changes a palette: any of `label`, `colours`, `mode`, `change` and `speed`. What the
   * change does not name stays. The fixtures use the new colours at once.
   */
  updatePalette(name: unknown, change: unknown): void {
    if (typeof change !== 'object' || change === null || Array.isArray(change)) {
      throw new PatchError('a change of a palette must be an object');
    }
    const patch = change as Record<string, unknown>;
    const extra = Object.keys(patch).find(
      (key) => !['label', 'colours', 'mode', 'change', 'speed'].includes(key),
    );
    if (extra !== undefined) {
      throw new PatchError(
        `a palette cannot change "${extra}", only label, colours, mode, change and speed`,
      );
    }
    this.file.edit((document, show) => {
      const current = this.needPalette(name, show);
      const { label, ...fields } = patch;
      const merged = { ...paletteData(current), ...fields };
      const read = palette(() => readPaletteFields(merged));
      const data = paletteData(read);
      const base = ['palettes', current.id];
      if (label !== undefined) setIn(document, [...base, 'label'], readLabel(label, 'palette'));
      for (const [key, value] of Object.entries(data)) setIn(document, [...base, key], value);
    });
  }

  /** Takes a palette away, unless it is on in a group or a look uses it. */
  removePalette(name: unknown): void {
    this.file.edit((document, show) => {
      const { id, label } = this.needPalette(name, show);
      const using = this.usersOf(id, show);
      if (using.length > 0) {
        throw new PatchError(`the palette "${label}" is in use: ${using.join(', ')}`);
      }
      if (!document.deleteIn(['palettes', id])) {
        throw new PatchError(`the palette "${label}" could not be taken out of the show file`);
      }
    });
  }

  /** Makes a group of these fixtures, without scenes, and gives its id. */
  addGroup(name: unknown, fixtures: unknown): string {
    const label = readLabel(name, 'group');
    const ids = readGroupFixtures(
      fixtures,
      this.fixtures.map(({ id, label: called }) => ({ id, label: called })),
    );
    return this.file.edit((document, show) => {
      const id = groupId(label, new Set(show.groups.map((group) => group.id)));
      setIn(document, ['groups', id], { label, fixtures: ids, scenes: {} });
      return id;
    });
  }

  renameGroup(group: unknown, name: unknown): void {
    const label = readLabel(name, 'group');
    this.file.edit((document, show) => {
      const { id } = this.needGroup(group, show);
      setIn(document, ['groups', id, 'label'], label);
    });
  }

  /** Takes the group away, and its scenes and looks with it. The fixtures stay as they are. */
  removeGroup(group: unknown): void {
    this.file.edit((document, show) => {
      const { id, label } = this.needGroup(group, show);
      if (!document.deleteIn(['groups', id])) {
        throw new PatchError(`the group "${label}" could not be taken out of the show file`);
      }
    });
  }

  close(): void {
    this.file.close();
    this.events.removeAllListeners();
  }

  private fixture(id: string): RigFixture {
    const fixtures = this.fixtures.find((each) => each.id === id);
    if (!fixtures) throw new PatchError(`there is no fixture called "${id}"`);
    return fixtures;
  }

  /** The ids of those of these fixtures that take palettes. */
  private palettesIn(ids: readonly string[]): string[] {
    return ids.filter((id) => this.fixture(id).controller.takesPalettes);
  }

  private needGroup(id: unknown, show: Show = this.file.getShow()): Group {
    if (typeof id !== 'string') throw new PatchError('say which group, by its id');
    const group = show.groups.find((each) => each.id === id);
    if (!group) throw new PatchError(`there is no group called "${id}"`);
    return group;
  }

  private needScene(group: Group, id: unknown): Scene {
    if (typeof id !== 'string') throw new PatchError('say which scene, by its id');
    const scene = group.scenes.find((each) => each.id === id);
    if (!scene) {
      throw new PatchError(`there is no scene called "${id}" in the group "${group.id}"`);
    }
    return scene;
  }

  private needLook(group: Group, id: unknown): Look {
    if (typeof id !== 'string') throw new PatchError('say which look, by its id');
    const look = group.looks.find((each) => each.id === id);
    if (!look) throw new PatchError(`there is no look called "${id}" in the group "${group.id}"`);
    return look;
  }

  private needPalette(id: unknown, show: Show = this.file.getShow()): Palette {
    if (typeof id !== 'string') throw new PatchError('say which palette, by its id');
    const found = show.palettes.find((each) => each.id === id);
    if (!found) throw new PatchError(`there is no palette called "${id}"`);
    return found;
  }

  /**
   * What uses a palette, in words for the operator: the groups it is on in and the looks that
   * name it.
   */
  private usersOf(id: string, show: Show): string[] {
    const users: string[] = [];
    for (const group of show.groups) {
      if (this.groups.get(group.id)?.colour.scene === id)
        users.push(`it is on in "${group.label}"`);
      for (const look of group.looks) {
        if (look.colour?.palette === id)
          users.push(`the look "${look.label}" of "${group.label}" uses it`);
      }
    }
    return users;
  }

  /** The lanes of a group as they are on now, for a look. */
  private lanesOn(group: Group): Record<string, unknown> {
    const on = this.groups.get(group.id) ?? nothingOnAtAll();
    const lanes: Record<string, unknown> = {};
    for (const type of SCENE_TYPES) {
      if (on[type].scene !== null && on[type].changed) {
        throw new PatchError(
          `the ${type} of "${group.label}" were changed by hand since they were set. Store them as a scene first, or set them again`,
        );
      }
    }
    if (on.lights.scene !== null) lanes.lights = on.lights.scene;
    if (on.colour.scene !== null) {
      lanes.colour =
        on.colour.speed === null
          ? { palette: on.colour.scene }
          : { palette: on.colour.scene, speed: on.colour.speed };
    }
    if (on.motion.scene !== null) lanes.motion = on.motion.scene;
    if (Object.keys(lanes).length === 0) {
      throw new PatchError(
        `nothing is on in "${group.label}", so there is nothing to store as a look`,
      );
    }
    return lanes;
  }

  /**
   * The properties of this type of the fixtures of the group as they are now, without the
   * fixtures that have none of them set. Colour is looked at on the fixtures that take palettes.
   */
  private look(group: Group, type: SceneType): Record<string, unknown> {
    const look: Record<string, unknown> = {};
    const ids = type === 'colour' ? this.palettesIn(group.fixtures) : group.fixtures;
    for (const id of ids) {
      const part = this.fixture(id).controller.snapshot(type);
      if (Object.keys(part).length > 0) look[id] = part;
    }
    return look;
  }

  /** Throws when a fixture cannot take its part. Changes nothing. */
  private checkSet(ids: readonly string[], type: SceneType, parts: Record<string, unknown>): void {
    for (const id of ids) this.fixture(id).controller.check(type, parts[id]);
  }

  /**
   * Sets the properties of the type on these fixtures of the group, each to its part. Without
   * a part a fixture has them at rest.
   */
  private set(
    type: SceneType,
    ids: readonly string[],
    parts: Record<string, unknown>,
    origin?: string,
  ): void {
    const fixtures = ids.map((id) => this.fixture(id));
    // All or nothing: no fixture changes when one of them cannot.
    for (const { id, controller } of fixtures) controller.check(type, parts[id]);
    this.recalling = true;
    try {
      for (const { id, controller } of fixtures) controller.recall(type, parts[id], origin);
    } finally {
      this.recalling = false;
    }
  }

  /** What a palette is as a part of a fixture. */
  private colourParts(
    ids: readonly string[],
    name: string,
    speed: number | null,
  ): Record<string, unknown> {
    const part = { colour: { palette: name, ...(speed === null ? {} : { speed }) } };
    return Object.fromEntries(ids.map((id) => [id, part]));
  }

  private setColour(
    group: Group,
    takers: readonly string[],
    name: string,
    speed: number | null,
    origin?: string,
  ): void {
    if (takers.length === 0) {
      throw new PatchError(`no fixture of "${group.label}" is coloured by palettes`);
    }
    this.set('colour', takers, this.colourParts(takers, name, speed), origin);
  }

  /** What is on in a group, by type. */
  private onIn(group: string): Record<SceneType, On> {
    let on = this.groups.get(group);
    if (!on) {
      on = nothingOnAtAll();
      this.groups.set(group, on);
    }
    return on;
  }

  /**
   * After the fixtures of the group were set: what is on now, in it and in the others. The
   * caller tells the browsers when everything it sets is set.
   */
  private turnOn(group: Group, type: SceneType, scene: string | null, speed: number | null): void {
    this.onIn(group.id)[type] = this.made(group, type, scene, speed);
    for (const other of this.file.getShow().groups) {
      const on = this.groups.get(other.id)?.[type];
      if (other.id === group.id || !on || on.scene === null) continue;
      // A group that was set as a whole has lost its scene of this type. One that was set
      // in part keeps it, and shows it as changed. Scenes of other types are not touched:
      // they have other properties.
      const mine = type === 'colour' ? this.palettesIn(other.fixtures) : other.fixtures;
      const set = type === 'colour' ? this.palettesIn(group.fixtures) : group.fixtures;
      if (mine.every((id) => set.includes(id))) {
        this.onIn(other.id)[type] = nothingOn();
      } else {
        on.changed = JSON.stringify(this.look(other, type)) !== on.made;
      }
    }
  }

  /** After the fixtures of the group were stored as the scene: that scene is on in it. */
  private stored(group: Group, type: SceneType, scene: string): void {
    this.onIn(group.id)[type] = this.made(group, type, scene, null);
    this.tell();
  }

  private made(group: Group, type: SceneType, scene: string | null, speed: number | null): On {
    if (scene === null) return nothingOn();
    return { scene, changed: false, made: JSON.stringify(this.look(group, type)), speed };
  }

  /** Whether a look that is on still is what it set. */
  private lookState(group: Group, on: Record<SceneType, On>): LookState {
    const id = this.looksOn.get(group.id);
    const look = id === undefined ? undefined : group.looks.find((each) => each.id === id);
    if (!look) return { look: null, changed: false };
    const differs = (lane: On, wanted: string | undefined, speed: number | null = null) =>
      wanted !== undefined && (lane.scene !== wanted || lane.changed || lane.speed !== speed);
    const changed =
      differs(on.lights, look.lights) ||
      differs(on.colour, look.colour?.palette, look.colour?.speed ?? null) ||
      differs(on.motion, look.motion);
    return { look: look.id, changed };
  }

  /**
   * After the show changed: what is on can only be what the show still has. A group that
   * got other fixtures is looked at again, so that `changed` does not wait for a fixture
   * to change. `changed` is about what the scene made of the fixtures when it was
   * recalled: a scene that is on and gets another look in the file is not shown as
   * changed, and is what the file says at the next recall.
   */
  private follow(): void {
    const show = this.file.getShow();
    this.palettes.set(show.palettes);
    for (const { id, controller } of this.fixtures) controller.setLimits?.(show.limits[id] ?? null);
    const { groups } = show;
    for (const id of [...this.groups.keys()]) {
      if (!groups.some((group) => group.id === id)) this.groups.delete(id);
    }
    for (const id of [...this.looksOn.keys()]) {
      const group = groups.find((each) => each.id === id);
      if (!group?.looks.some((look) => look.id === this.looksOn.get(id))) {
        this.looksOn.delete(id);
      }
    }
    for (const group of groups) {
      const ons = this.onIn(group.id);
      for (const type of SCENE_TYPES) {
        const on = ons[type];
        if (on.scene === null) continue;
        // A scene that is on is a scene of the show still, of the same type. A palette that is
        // on is a palette of the show still.
        const there =
          type === 'colour'
            ? show.palettes.some((each) => each.id === on.scene)
            : group.scenes.some((s) => s.id === on.scene && s.type === type);
        if (!there) ons[type] = nothingOn();
        else on.changed = JSON.stringify(this.look(group, type)) !== on.made;
      }
    }
  }

  /** After a fixture changed: whether the groups still are what their scenes made them. */
  private compare(): void {
    if (this.recalling) return;
    let news = false;
    for (const group of this.file.getShow().groups) {
      const ons = this.groups.get(group.id);
      if (!ons) continue;
      for (const type of SCENE_TYPES) {
        const on = ons[type];
        if (on.scene === null) continue;
        const changed = JSON.stringify(this.look(group, type)) !== on.made;
        if (changed === on.changed) continue;
        on.changed = changed;
        news = true;
      }
    }
    if (news) this.tell();
  }

  private tell(): void {
    const state = this.getState();
    this.told = JSON.stringify(state);
    this.events.emit('playback', state);
  }
}
