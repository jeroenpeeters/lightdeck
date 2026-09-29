/**
 * The show: what has been programmed. For now that is the scenes.
 *
 * A scene is a complete look. For every fixture it names it holds what that fixture
 * should be doing, in the form the controller of the fixture gives and takes; a fixture
 * it does not name is dark. So the show knows fixtures by their id only, and leaves
 * what a part means to `check`.
 *
 * In the file the scenes are a map from id to scene:
 *
 *   scenes:
 *     amber-chase:
 *       label: Amber chase
 *       fixtures:
 *         spider:
 *           levels: { dimmer: 1 }
 *           effect: { id: chase, colourA: ..., colourB: ... }
 *         laser:
 *           raw: { mode: 95 }
 */

import { PatchError } from '../server/fixture.js';

export interface Scene {
  /** Names the scene in the file and in the API: `amber-chase`. */
  id: string;
  /** What the operator calls it. */
  label: string;
  /** By fixture id, what the controller of that fixture keeps of it. */
  fixtures: Record<string, unknown>;
}

export interface Show {
  /** In the order of the file. */
  scenes: Scene[];
}

/** The data cannot be the show. The message is for the operator. */
export class ShowError extends Error {}

/** Throws when the fixture does not exist or cannot take this part. */
export type CheckPart = (fixture: string, part: unknown) => void;

export const MAX_LABEL = 40;
const ID = /^[a-z0-9][a-z0-9-]*$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A name as the operator typed it, without the space around it. */
export function readLabel(value: unknown): string {
  if (typeof value !== 'string') throw new PatchError('a scene needs a name');
  const label = value.replace(/\s+/g, ' ').trim();
  if (label === '') throw new PatchError('a scene needs a name');
  if (label.length > MAX_LABEL) {
    throw new PatchError(`the name of a scene can have ${MAX_LABEL} characters at most`);
  }
  return label;
}

/** An id made from the name, with a number behind it when that id is taken. */
export function sceneId(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'scene';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** Reads what the file holds as a show. Throws a `ShowError` that says what is wrong. */
export function readShow(data: unknown, check: CheckPart): Show {
  if (data === null || data === undefined) return { scenes: [] };
  if (!isObject(data)) throw new ShowError('the show must start with "scenes:"');
  const unknown = Object.keys(data).find((key) => key !== 'scenes');
  if (unknown !== undefined) {
    throw new ShowError(`the show cannot have "${unknown}", only scenes`);
  }
  const listed = data.scenes ?? {};
  if (!isObject(listed)) throw new ShowError('"scenes" must be a list of scenes by their id');

  const scenes: Scene[] = [];
  for (const [id, scene] of Object.entries(listed)) {
    const where = `scene "${id}"`;
    if (!ID.test(id)) {
      throw new ShowError(`${where}: an id has small letters, digits and dashes only`);
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
      for (const [fixture, part] of Object.entries(fixtures)) check(fixture, part);
      scenes.push({ id, label, fixtures });
    } catch (error) {
      throw new ShowError(`${where}: ${message(error)}`);
    }
  }
  return { scenes };
}
