/**
 * The playback: the scenes of the show, and which of them the fixtures are set to.
 *
 * There is one state per fixture. Recalling a scene sets the fixtures through their
 * controllers, the way their pages do, and after that the operator can go on by hand.
 * The playback remembers which scene was recalled last and whether the fixtures still
 * are what it made them: `changed` says they are not.
 *
 * Storing takes the fixtures as they are now. A fixture that is dark is left out of the
 * scene, which comes to the same: a scene is a complete look, and what it does not name
 * goes dark.
 *
 * Events: `show` (summary), `playback` (state).
 */

import { EventEmitter } from 'node:events';
import { ShowFile, setIn } from '../show/file.js';
import { readLabel, type Scene, sceneId } from '../show/show.js';
import { PatchError } from './fixture.js';
import type { RigFixture } from './rig.js';

export interface SceneSummary {
  id: string;
  label: string;
  /** Ids of the fixtures the scene sets. The others go dark. */
  fixtures: string[];
}

export interface ShowSummary {
  /** Where the show is kept, or null when it is kept in memory only. */
  file: string | null;
  /** What is wrong with the file, or null. While it is wrong the show stays as it was. */
  problem: string | null;
  scenes: SceneSummary[];
}

export interface PlaybackState {
  /** Id of the scene that was recalled or stored last, or null. */
  scene: string | null;
  /** True when the fixtures are no longer what that scene made them. */
  changed: boolean;
}

export interface PlaybackOptions {
  fixtures: readonly RigFixture[];
  /** Where the show file is. Without it the show is kept in memory only. */
  path?: string;
}

export class Playback extends EventEmitter {
  private readonly fixtures: readonly RigFixture[];
  private readonly file: ShowFile;
  private scene: string | null = null;
  /** The fixtures as the scene made them, to tell a change by. */
  private made = '';
  private changed = false;
  private recalling = false;

  constructor(options: PlaybackOptions) {
    super();
    this.fixtures = options.fixtures;
    this.file = new ShowFile({
      ...(options.path === undefined ? {} : { path: options.path }),
      check: (id, part) => {
        const fixture = this.fixtures.find((each) => each.id === id);
        if (!fixture) {
          throw new PatchError(
            `there is no fixture called "${id}", only ${this.fixtures.map((f) => f.id).join(', ')}`,
          );
        }
        fixture.controller.check(part);
      },
    });
    this.file.on('show', () => {
      if (this.scene !== null && !this.find(this.scene)) this.setScene(null);
      this.emit('show', this.getShow());
    });
    this.file.watch();
    for (const { controller } of this.fixtures) {
      controller.on('state', () => this.compare());
    }
  }

  getShow(): ShowSummary {
    return {
      file: this.file.path ?? null,
      problem: this.file.getProblem(),
      scenes: this.file.getShow().scenes.map(({ id, label, fixtures }) => ({
        id,
        label,
        fixtures: Object.keys(fixtures),
      })),
    };
  }

  getState(): PlaybackState {
    return { scene: this.scene, changed: this.changed };
  }

  /** Stores the fixtures as they are now as a new scene, and gives its id. */
  store(name: unknown): string {
    const label = readLabel(name);
    const id = sceneId(label, new Set(this.file.getShow().scenes.map((scene) => scene.id)));
    const fixtures = this.look();
    this.file.edit((document) => setIn(document, ['scenes', id], { label, fixtures }));
    this.setScene(id);
    return id;
  }

  /** Stores the fixtures as they are now in a scene that is there already. */
  storeOver(id: string): void {
    this.need(id);
    const fixtures = this.look();
    this.file.edit((document) => setIn(document, ['scenes', id, 'fixtures'], fixtures));
    this.setScene(id);
  }

  rename(id: string, name: unknown): void {
    this.need(id);
    const label = readLabel(name);
    this.file.edit((document) => setIn(document, ['scenes', id, 'label'], label));
  }

  remove(id: string): void {
    this.need(id);
    this.file.edit((document) => document.deleteIn(['scenes', id]));
  }

  /** Sets every fixture to its part of the scene. Fixtures the scene does not name go dark. */
  recall(id: unknown, origin?: string): void {
    if (typeof id !== 'string') throw new PatchError('say which scene, by its id');
    const scene = this.need(id);
    // All or nothing: no fixture changes when one of them cannot.
    for (const { id: fixture, controller } of this.fixtures) {
      controller.check(scene.fixtures[fixture]);
    }
    this.recalling = true;
    try {
      for (const { id: fixture, controller } of this.fixtures) {
        controller.recall(scene.fixtures[fixture], origin);
      }
    } finally {
      this.recalling = false;
    }
    this.setScene(id);
  }

  close(): void {
    this.file.close();
    this.removeAllListeners();
  }

  private find(id: string): Scene | undefined {
    return this.file.getShow().scenes.find((scene) => scene.id === id);
  }

  private need(id: string): Scene {
    const scene = this.find(id);
    if (!scene) throw new PatchError(`there is no scene called "${id}"`);
    return scene;
  }

  /** The fixtures as they are now, without the ones that are dark. */
  private look(): Record<string, unknown> {
    const look: Record<string, unknown> = {};
    for (const { id, controller } of this.fixtures) {
      const part = controller.snapshot();
      if (Object.keys(part).length > 0) look[id] = part;
    }
    return look;
  }

  private setScene(id: string | null): void {
    this.scene = id;
    this.made = id === null ? '' : JSON.stringify(this.look());
    this.changed = false;
    this.emit('playback', this.getState());
  }

  private compare(): void {
    if (this.recalling || this.scene === null) return;
    const changed = JSON.stringify(this.look()) !== this.made;
    if (changed === this.changed) return;
    this.changed = changed;
    this.emit('playback', this.getState());
  }
}
