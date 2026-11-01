/**
 * How the pipes of the decor are put together (Jeroen, 2026-11-01): in which order they follow each other
 * when they are linked into one long pipe, which of them are mounted the other way round, and whether they
 * are linked at all. It is a thing of how the set is built and not of the show, so it is in a file of its own
 * (`decor.json`, `--decor` / `DECOR_FILE`) that the setup page `/decor` writes, and not in the show file.
 *
 * ```json
 * { "linked": true, "order": ["buis2", "buis1", "buis3"], "reverse": { "buis3": true } }
 * ```
 *
 * A file that is not there is the order of the rig file, nothing reversed and the pipes apart. A file that
 * cannot be read is no reason to stop: lightdeck starts with that and says so, and the next change writes it
 * again. Ids that the rig no longer has are dropped and pipes the file does not know follow at the end.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface DecorSetup {
  /** Whether the pipes that lightdeck draws are one long pipe. */
  linked: boolean;
  /** The pipes in the order they follow each other: the effect enters the first and leaves the last. */
  order: string[];
  /** Per pipe, whether it is mounted the other way round. */
  reverse: Record<string, boolean>;
}

/** The setup for these pipes (in the order of the rig file) when nothing else is said. */
export function defaultSetup(ids: readonly string[]): DecorSetup {
  return {
    linked: false,
    order: [...ids],
    reverse: Object.fromEntries(ids.map((id) => [id, false])),
  };
}

/**
 * A setup as it was read, made to fit the pipes there are: the known ids once each in the given order, the
 * others behind them in the order of `ids`, a reverse for every pipe. Anything else in it is left out.
 */
export function fitSetup(read: unknown, ids: readonly string[]): DecorSetup {
  const given = typeof read === 'object' && read !== null ? (read as Record<string, unknown>) : {};
  const order: string[] = [];
  if (Array.isArray(given.order)) {
    for (const id of given.order) {
      if (typeof id === 'string' && ids.includes(id) && !order.includes(id)) order.push(id);
    }
  }
  for (const id of ids) if (!order.includes(id)) order.push(id);
  const flipped =
    typeof given.reverse === 'object' && given.reverse !== null
      ? (given.reverse as Record<string, unknown>)
      : {};
  return {
    linked: given.linked === true,
    order,
    reverse: Object.fromEntries(ids.map((id) => [id, flipped[id] === true])),
  };
}

/** The setup in a file, fitted to the pipes. `problem` says what went wrong when the file is there but cannot be read. */
export function readSetupFile(
  path: string,
  ids: readonly string[],
): { setup: DecorSetup; problem?: string } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { setup: defaultSetup(ids) };
    return {
      setup: defaultSetup(ids),
      problem: `cannot read ${path}: ${(error as Error).message}`,
    };
  }
  try {
    return { setup: fitSetup(JSON.parse(text), ids) };
  } catch (error) {
    return {
      setup: defaultSetup(ids),
      problem: `${path} is not valid JSON, so the pipes start unlinked: ${(error as Error).message}`,
    };
  }
}

/** Writes the setup next to its place and moves it over, so that a stop in the middle leaves the old file whole. */
export function writeSetupFile(path: string, setup: DecorSetup): void {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(setup, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}
