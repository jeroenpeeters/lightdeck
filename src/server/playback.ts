/**
 * The playback: the groups and scenes of the show, and which scenes the fixtures are
 * set to.
 *
 * There is one state per fixture. A scene has a type, lights, colour or motion, and
 * recalling it sets that type of properties on the fixtures of its group through their
 * controllers, the way their pages do, and leaves the other types as they are. After that
 * the operator can go on by hand. Fixtures outside the group are left alone, so several
 * groups have a scene on at once, and so do the three types within a group. Per group and
 * type the playback remembers which scene is on and whether the fixtures of the group
 * still are what it made them, in the properties of that type: `changed` says they are not.
 *
 * Groups can share a fixture, and then the last press of a type wins. A scene of "All" sets
 * the spider, so after it no scene of the same type in "Spider" is on. The other way
 * round, a scene of "Spider" leaves the scene of "All" on and shows it as changed.
 *
 * Storing takes the properties of the type from the fixtures of the group as they are now.
 * A fixture that has none of them set is left out of the scene, which comes to the same:
 * within its group and type a scene is complete, and what it does not name goes to rest.
 * Off is the lights: it darkens the fixtures and leaves their colours and motion.
 *
 * Events: `show` (summary), `playback` (state). The playback has an emitter instead of
 * being one, because `off` is what a group has and cannot also take a listener away.
 */

import { EventEmitter } from 'node:events';
import { SCENE_TYPES, type SceneType } from '../fixtures/profile.js';
import { ShowFile, setIn } from '../show/file.js';
import {
  type Group,
  groupId,
  readGroupFixtures,
  readLabel,
  readSceneType,
  type Scene,
  type Show,
  sceneId,
} from '../show/show.js';
import { PatchError } from './fixture.js';
import type { RigFixture } from './rig.js';

export interface SceneSummary {
  id: string;
  label: string;
  type: SceneType;
  /** Ids of the fixtures the scene sets. The others of its group have the type at rest. */
  fixtures: string[];
}

export interface GroupSummary {
  id: string;
  label: string;
  /** Ids of the fixtures of the group. */
  fixtures: string[];
  scenes: SceneSummary[];
}

export interface ShowSummary {
  /** Where the show is kept, or null when it is kept in memory only. */
  file: string | null;
  /** What is wrong with the file, or null. While it is wrong the show stays as it was. */
  problem: string | null;
  groups: GroupSummary[];
}

/** What is on in a group for one type of scene. */
export interface GroupState {
  /** Id of the scene of this type that is on in the group, or null. */
  scene: string | null;
  /** True when the fixtures of the group are no longer what that scene made them. */
  changed: boolean;
}

export interface PlaybackState {
  /** By the id of the group, then by type. Every group of the show is there. */
  groups: Record<string, Record<SceneType, GroupState>>;
}

export interface PlaybackOptions {
  fixtures: readonly RigFixture[];
  /** Where the show file is. Without it the show is kept in memory only. */
  path?: string;
}

interface On extends GroupState {
  /** The fixtures of the group as the scene made them, to tell a change by. */
  made: string;
}

const nothingOn = (): On => ({ scene: null, changed: false, made: '' });
const nothingOnAtAll = (): Record<SceneType, On> => ({
  lights: nothingOn(),
  colour: nothingOn(),
  motion: nothingOn(),
});

export class Playback {
  private readonly events = new EventEmitter();
  private readonly fixtures: readonly RigFixture[];
  private readonly file: ShowFile;
  /** By the id of the group, then by type, what is on in it. */
  private readonly groups = new Map<string, Record<SceneType, On>>();
  /** The state as it was told last, to tell a change by. */
  private told = '';
  private recalling = false;

  constructor(options: PlaybackOptions) {
    this.fixtures = options.fixtures;
    this.file = new ShowFile({
      ...(options.path === undefined ? {} : { path: options.path }),
      fixtures: this.fixtures.map(({ id, label }) => ({ id, label })),
      check: (id, type, part) => this.fixture(id).controller.check(type, part),
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
    return {
      file: this.file.path ?? null,
      problem: this.file.getProblem(),
      groups: this.file.getShow().groups.map(({ id, label, fixtures, scenes }) => ({
        id,
        label,
        fixtures: [...fixtures],
        scenes: scenes.map((scene) => ({
          id: scene.id,
          label: scene.label,
          type: scene.type,
          fixtures: Object.keys(scene.fixtures),
        })),
      })),
    };
  }

  getState(): PlaybackState {
    const groups: PlaybackState['groups'] = {};
    for (const { id } of this.file.getShow().groups) {
      const on = this.groups.get(id) ?? nothingOnAtAll();
      groups[id] = {
        lights: { scene: on.lights.scene, changed: on.lights.changed },
        colour: { scene: on.colour.scene, changed: on.colour.changed },
        motion: { scene: on.motion.scene, changed: on.motion.changed },
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
    this.set(found, type, fixtures, origin);
    this.turnOn(found, type, id);
  }

  /**
   * Darkens the fixtures of the group: that is the lights, so the colours and the motion
   * stay as they are. After that no scene of lights is on in the group.
   */
  off(group: unknown, origin?: string): void {
    const found = this.needGroup(group);
    this.set(found, 'lights', {}, origin);
    this.turnOn(found, 'lights', null);
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

  remove(group: unknown, scene: unknown): void {
    this.file.edit((document, show) => {
      const found = this.needGroup(group, show);
      const { id, label } = this.needScene(found, scene);
      if (!document.deleteIn(['groups', found.id, 'scenes', id])) {
        throw new PatchError(`the scene "${label}" could not be taken out of the show file`);
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

  /** Takes the group away, and its scenes with it. The fixtures stay as they are. */
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
    const fixture = this.fixtures.find((each) => each.id === id);
    if (!fixture) throw new PatchError(`there is no fixture called "${id}"`);
    return fixture;
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

  /**
   * The properties of this type of the fixtures of the group as they are now, without the
   * fixtures that have none of them set.
   */
  private look(group: Group, type: SceneType): Record<string, unknown> {
    const look: Record<string, unknown> = {};
    for (const id of group.fixtures) {
      const part = this.fixture(id).controller.snapshot(type);
      if (Object.keys(part).length > 0) look[id] = part;
    }
    return look;
  }

  /**
   * Sets the properties of the type on the fixtures of the group, each to its part. Without
   * a part a fixture has them at rest.
   */
  private set(
    group: Group,
    type: SceneType,
    parts: Record<string, unknown>,
    origin?: string,
  ): void {
    const fixtures = group.fixtures.map((id) => this.fixture(id));
    // All or nothing: no fixture changes when one of them cannot.
    for (const { id, controller } of fixtures) controller.check(type, parts[id]);
    this.recalling = true;
    try {
      for (const { id, controller } of fixtures) controller.recall(type, parts[id], origin);
    } finally {
      this.recalling = false;
    }
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

  /** After the fixtures of the group were set: what is on now, in it and in the others. */
  private turnOn(group: Group, type: SceneType, scene: string | null): void {
    this.onIn(group.id)[type] = this.made(group, type, scene);
    for (const other of this.file.getShow().groups) {
      const on = this.groups.get(other.id)?.[type];
      if (other.id === group.id || !on || on.scene === null) continue;
      // A group that was set as a whole has lost its scene of this type. One that was set
      // in part keeps it, and shows it as changed. Scenes of other types are not touched:
      // they have other properties.
      if (other.fixtures.every((id) => group.fixtures.includes(id))) {
        this.onIn(other.id)[type] = nothingOn();
      } else {
        on.changed = JSON.stringify(this.look(other, type)) !== on.made;
      }
    }
    this.tell();
  }

  /** After the fixtures of the group were stored as the scene: that scene is on in it. */
  private stored(group: Group, type: SceneType, scene: string): void {
    this.onIn(group.id)[type] = this.made(group, type, scene);
    this.tell();
  }

  private made(group: Group, type: SceneType, scene: string | null): On {
    if (scene === null) return nothingOn();
    return { scene, changed: false, made: JSON.stringify(this.look(group, type)) };
  }

  /**
   * After the show changed: what is on can only be what the show still has. A group that
   * got other fixtures is looked at again, so that `changed` does not wait for a fixture
   * to change. `changed` is about what the scene made of the fixtures when it was
   * recalled: a scene that is on and gets another look in the file is not shown as
   * changed, and is what the file says at the next recall.
   */
  private follow(): void {
    const { groups } = this.file.getShow();
    for (const id of [...this.groups.keys()]) {
      if (!groups.some((group) => group.id === id)) this.groups.delete(id);
    }
    for (const group of groups) {
      const ons = this.onIn(group.id);
      for (const type of SCENE_TYPES) {
        const on = ons[type];
        // A scene that is on is a scene of the show still, of the same type.
        if (on.scene !== null && !group.scenes.some((s) => s.id === on.scene && s.type === type)) {
          ons[type] = nothingOn();
        } else if (on.scene !== null) {
          on.changed = JSON.stringify(this.look(group, type)) !== on.made;
        }
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
