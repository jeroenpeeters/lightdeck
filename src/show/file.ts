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
 * Without a path the show is kept in memory only.
 *
 * Events: `show`, after the show or the problem changed.
 */

import { EventEmitter } from 'node:events';
import { type FSWatcher, readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { Document, isMap, isScalar, parseDocument, visit } from 'yaml';
import { PatchError } from '../server/fixture.js';
import { type CheckPart, readShow, type Show, ShowError } from './show.js';

export interface ShowFileOptions {
  /** Where the file is. It does not have to exist yet, the directory does. */
  path?: string;
  check: CheckPart;
}

/** How long the file is left alone after a change, for an editor to finish writing. */
const SETTLE_MS = 150;
/** Maps this small are written on one line. */
const ONE_LINE_KEYS = 4;

/** Puts small maps of plain values on one line, such as a colour. */
function tidy(document: Document): void {
  visit(document, {
    Map(_key, node) {
      const plain = node.items.every((pair) => isScalar(pair.value));
      if (plain && node.items.length > 0 && node.items.length <= ONE_LINE_KEYS) node.flow = true;
    },
  });
}

/** Sets a value in the document, making the maps on the way there. */
export function setIn(document: Document, path: readonly string[], value: unknown): void {
  if (!isMap(document.contents)) document.contents = document.createNode({});
  for (let depth = 1; depth < path.length; depth++) {
    const above = path.slice(0, depth);
    if (!isMap(document.getIn(above))) document.setIn(above, document.createNode({}));
  }
  // Two colours that are the same are written twice, not as a reference to each other.
  document.setIn(path, document.createNode(value, { aliasDuplicateObjects: false }));
}

export class ShowFile extends EventEmitter {
  readonly path: string | undefined;
  private readonly check: CheckPart;
  private document = new Document();
  private show: Show = { scenes: [] };
  /** The file as it was last read or written. */
  private seen: string | undefined;
  private problem: string | null = null;
  private watcher: FSWatcher | undefined;
  private settle: ReturnType<typeof setTimeout> | undefined;

  constructor(options: ShowFileOptions) {
    super();
    this.path = options.path === undefined ? undefined : resolve(options.path);
    this.check = options.check;
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
   */
  edit(change: (document: Document) => void): void {
    // The file may have changed without the watcher having said so yet.
    this.refresh();
    if (this.problem !== null) {
      throw new PatchError(
        `The show file has a mistake, so nothing can be stored in it. ${this.problem}`,
      );
    }
    const document = this.document.clone();
    change(document);
    tidy(document);
    let show: Show;
    try {
      show = readShow(document.toJS(), this.check);
    } catch (error) {
      throw new PatchError(error instanceof Error ? error.message : String(error));
    }
    const text = document.toString({ lineWidth: 0 });
    if (this.path !== undefined) {
      const partial = `${this.path}.tmp`;
      try {
        writeFileSync(partial, text);
        renameSync(partial, this.path);
      } catch (error) {
        throw new PatchError(
          `The show file cannot be written: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.document = document;
    this.show = show;
    this.seen = text;
    this.emit('show');
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
      this.fail(`It cannot be read: ${error instanceof Error ? error.message : String(error)}`);
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
      this.show = readShow(document.toJS(), this.check);
    } catch (error) {
      if (!(error instanceof ShowError)) throw error;
      this.fail(error.message);
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
