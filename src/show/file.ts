/**
 * The show file: one YAML file that the deck writes and that can be edited by hand.
 *
 * The file is watched. When it changes and can be read as a show, that is the show from
 * then on. When it cannot, the show that runs stays as it is, and `getProblem` says what
 * is wrong with the file. While the file has a problem nothing is written to it, so that
 * what somebody is typing is never lost to a press on the deck.
 *
 * Changes from the deck are made in the document as it was read, so that comments and
 * the order of a file edited by hand stay.
 *
 * Reading never writes. A file from before there were groups, or no file at all, is read
 * as the groups a show starts with. The first change from the deck writes those groups
 * out, with the scenes that were in the file in the group of all fixtures.
 *
 * Without a path the show is kept in memory only.
 *
 * Events: `show`, after the show or the problem changed.
 */

import { EventEmitter } from 'node:events';
import { type FSWatcher, readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { Document, isMap, isScalar, parseDocument, visit } from 'yaml';
import { PatchError } from '../server/fixture.js';
import {
  type KnownFixtures,
  readShow,
  type Show,
  ShowError,
  type ShowFixture,
  startingGroups,
} from './show.js';

export interface ShowFileOptions extends KnownFixtures {
  /** Where the file is. It does not have to exist yet, the directory does. */
  path?: string;
}

/** How long the file is left alone after a change, for an editor to finish writing. */
const SETTLE_MS = 150;
/** Maps this small are written on one line. */
const ONE_LINE_KEYS = 4;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The id that a key of a map is. A key that was read is a node, one that was added is not. */
function idOf(key: unknown): string | undefined {
  const id: unknown = isScalar(key) ? key.value : key;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Makes the ids in a map of the document what was typed. YAML reads a key such as `12`
 * or `true` as a number or a yes, and the document would not find it under its id.
 * `what` says what the ids name: `group`, or `scene` with ` of group "x"` as its place.
 * Throws a `ShowError` when two of them come to the same id.
 */
function asTyped(map: unknown, what: string, place = ''): void {
  if (!isMap(map)) return;
  const seen = new Set<string>();
  for (const { key } of map.items) {
    if (isScalar(key) && typeof key.value !== 'string') {
      key.value = key.source ?? String(key.value);
    }
    const id = idOf(key);
    if (id === undefined) continue;
    if (seen.has(id)) throw new ShowError(`${what} "${id}"${place} is in the file twice`);
    seen.add(id);
  }
}

/** Does that for the groups and their scenes, and for scenes from before there were groups. */
function idsAsTyped(document: Document): void {
  const top = document.contents;
  if (!isMap(top)) return;
  asTyped(top.get('scenes', true), 'scene');
  const groups = top.get('groups', true);
  asTyped(groups, 'group');
  if (!isMap(groups)) return;
  for (const { key, value } of groups.items) {
    if (isMap(value)) asTyped(value.get('scenes', true), 'scene', ` of group "${idOf(key)}"`);
  }
}

/** What was read of a map, in the order of the file: a plain object puts numbers first. */
function inOrder(map: unknown, read: unknown): unknown {
  if (!isMap(map) || !isObject(read)) return read;
  const ordered = new Map<string, unknown>();
  for (const { key } of map.items) {
    const id = idOf(key);
    if (id !== undefined && Object.hasOwn(read, id)) ordered.set(id, read[id]);
  }
  // What did not come from a key of its own, such as what a merge brought in.
  for (const [id, value] of Object.entries(read)) {
    if (!ordered.has(id)) ordered.set(id, value);
  }
  return ordered;
}

/**
 * What the document holds, to be read as a show. The groups and the scenes of a group
 * are in the order of the file.
 */
function dataOf(document: Document): unknown {
  const data: unknown = document.toJS();
  const top = document.contents;
  if (!isObject(data) || !isMap(top)) return data;
  data.scenes = inOrder(top.get('scenes', true), data.scenes);
  const groups = top.get('groups', true);
  data.groups = inOrder(groups, data.groups);
  if (!isMap(groups) || !(data.groups instanceof Map)) return data;
  for (const [id, group] of data.groups) {
    const node = groups.get(id, true);
    if (!isObject(group) || !isMap(node)) continue;
    group.scenes = inOrder(node.get('scenes', true), group.scenes);
  }
  return data;
}

/** Puts small maps of plain values on one line, such as a colour, and lists of names. */
function tidy(document: Document): void {
  visit(document, {
    Map(_key, node) {
      const plain = node.items.every((pair) => isScalar(pair.value));
      if (plain && node.items.length > 0 && node.items.length <= ONE_LINE_KEYS) node.flow = true;
    },
    Seq(_key, node) {
      if (node.items.every((item) => isScalar(item))) node.flow = true;
    },
  });
}

/**
 * Gives a document without groups the groups a show starts with. The scenes of a file
 * from before there were groups go to the group of all fixtures, as they are in the
 * document, so that their comments come along.
 */
function addGroups(document: Document, fixtures: readonly ShowFixture[]): void {
  if (!isMap(document.contents)) document.contents = document.createNode({});
  const top = document.contents;
  if (!isMap(top) || top.has('groups')) return;
  // A file that holds `{}` only: what is added does not go on that one line.
  top.flow = false;

  const starting = startingGroups(fixtures);
  const groups = document.createNode(
    Object.fromEntries(
      starting.map((group) => [
        group.id,
        { label: group.label, fixtures: group.fixtures, scenes: {} },
      ]),
    ),
    { aliasDuplicateObjects: false },
  );
  const old = top.items.find((pair) => isScalar(pair.key) && pair.key.value === 'scenes');
  if (!old) {
    top.add(document.createPair('groups', groups));
    return;
  }
  const all = starting[starting.length - 1];
  if (all && isMap(old.value)) groups.setIn([all.id, 'scenes'], old.value);
  // The place in the file and the comment above it stay: "scenes" becomes "groups".
  if (isScalar(old.key)) old.key.value = 'groups';
  old.value = groups;
}

/**
 * Sets a value in the document, making the maps on the way there. A scene or a group
 * that is added gets lines of its own: a map on the way there that was written on one
 * line, such as the `scenes: {}` of a group without scenes, is no longer.
 */
export function setIn(document: Document, path: readonly string[], value: unknown): void {
  if (!isMap(document.contents)) document.contents = document.createNode({});
  for (let depth = 1; depth < path.length; depth++) {
    const above = path.slice(0, depth);
    if (!isMap(document.getIn(above))) document.setIn(above, document.createNode({}));
  }
  const there = document.getIn(path, true);
  if (isScalar(there) && (value === null || typeof value !== 'object')) {
    // A name takes the place of a name: the comment behind it stays.
    there.value = value;
    return;
  }
  if (isObject(value)) {
    for (let depth = 0; depth < path.length; depth++) {
      const above: unknown = depth === 0 ? document.contents : document.getIn(path.slice(0, depth));
      if (isMap(above)) above.flow = false;
    }
  }
  // Two colours that are the same are written twice, not as a reference to each other.
  document.setIn(path, document.createNode(value, { aliasDuplicateObjects: false }));
}

export class ShowFile extends EventEmitter {
  readonly path: string | undefined;
  private readonly known: KnownFixtures;
  private document = new Document();
  private show: Show;
  /** The file as it was last read or written. */
  private seen: string | undefined;
  private problem: string | null = null;
  private watcher: FSWatcher | undefined;
  private settle: ReturnType<typeof setTimeout> | undefined;

  constructor(options: ShowFileOptions) {
    super();
    this.path = options.path === undefined ? undefined : resolve(options.path);
    this.known = { fixtures: options.fixtures, check: options.check };
    this.show = readShow(null, this.known);
    this.refresh();
  }

  getShow(): Show {
    return this.show;
  }

  /** What is wrong with the file, or null when it is the show. */
  getProblem(): string | null {
    return this.problem;
  }

  /**
   * Changes the show and writes it to the file. Throws a `PatchError` and changes
   * nothing when the file has a problem or the result would not be a show.
   *
   * The change gets the document and the show as the file has them at this moment, and
   * what it gives is given back. What it looks up, such as an id that is still free,
   * it must look up in that show: the file may have changed by hand a moment ago.
   */
  edit<Given>(change: (document: Document, show: Show) => Given): Given {
    // The file may have changed without the watcher having said so yet.
    this.refresh();
    if (this.problem !== null) {
      throw new PatchError(
        `The show file has a mistake, so nothing can be stored in it. ${this.problem}`,
      );
    }
    const document = this.document.clone();
    addGroups(document, this.known.fixtures);
    const given = change(document, this.show);
    tidy(document);
    let show: Show;
    try {
      show = readShow(dataOf(document), this.known);
    } catch (error) {
      throw new PatchError(message(error));
    }
    const text = document.toString({ lineWidth: 0 });
    if (this.path !== undefined) {
      const partial = `${this.path}.tmp`;
      try {
        writeFileSync(partial, text);
        renameSync(partial, this.path);
      } catch (error) {
        throw new PatchError(`The show file cannot be written: ${message(error)}`);
      }
    }
    this.document = document;
    this.show = show;
    this.seen = text;
    this.emit('show');
    return given;
  }

  /** Follows the file from now on. */
  watch(): void {
    if (this.path === undefined || this.watcher) return;
    const name = basename(this.path);
    this.watcher = watch(dirname(this.path), (_event, changed) => {
      if (changed !== null && changed !== name) return;
      if (this.settle) clearTimeout(this.settle);
      this.settle = setTimeout(() => this.refresh(), SETTLE_MS);
    });
    // A watcher that fails must not take the show down: the file is read before every write.
    this.watcher.on('error', () => {});
  }

  close(): void {
    if (this.settle) clearTimeout(this.settle);
    this.watcher?.close();
    this.watcher = undefined;
    this.removeAllListeners();
  }

  /** Reads the file when it is not what was seen last. */
  private refresh(): void {
    if (this.path === undefined) return;
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (error) {
      // No file: the show that is there stays, and the next change writes it.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (this.problem !== null) {
          this.problem = null;
          this.seen = undefined;
          this.emit('show');
        }
        return;
      }
      // When it can be read again it is read anew, also when it still says the same.
      this.seen = undefined;
      this.fail(`It cannot be read: ${message(error)}`);
      return;
    }
    if (text === this.seen) return;
    this.seen = text;

    const document = parseDocument(text, { prettyErrors: true });
    const broken = document.errors[0];
    if (broken) {
      this.fail(broken.message);
      return;
    }
    try {
      idsAsTyped(document);
      this.show = readShow(dataOf(document), this.known);
    } catch (error) {
      // Whatever it is, it is a mistake in the file, such as a reference to nothing. It
      // must not stop lightdeck: the show that runs stays.
      this.fail(message(error));
      return;
    }
    this.document = document;
    this.problem = null;
    this.emit('show');
  }

  private fail(found: string): void {
    // It is shown as a sentence of its own.
    const problem = found.charAt(0).toUpperCase() + found.slice(1);
    if (problem === this.problem) return;
    this.problem = problem;
    this.emit('show');
  }
}
