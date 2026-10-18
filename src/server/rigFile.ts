/**
 * The rig file: what hangs in the room, as far as Home Assistant drives it.
 *
 * It is not the show file. The show is what was programmed and the deck writes it; the rig is
 * which lamps there are, and it is written by hand and read once, at startup. For now it holds
 * the fixtures that Home Assistant drives, which are the room. The spider and the laser are on
 * flags (`src/index.ts`), and their definitions are of the same kind, so they can move here
 * later.
 *
 * ```yaml
 * fixtures:
 *   - id: room
 *     kind: room
 *     label: Room Lights
 *     lamps:
 *       - { id: bar, label: Bar, entity: light.bar }
 *       - { id: fog, label: Fog machine, entity: switch.fog, blackout: true }
 *     zones:
 *       - { id: low, label: Low, lamps: [bar] }
 * ```
 *
 * A file that is not there is a rig without Home Assistant fixtures. A file with a mistake is
 * an error that says where, and lightdeck does not start: a rig that is half read is a room
 * that is half dark.
 */

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { HassFixtureDefinition } from './rig.js';
import type { LampDefinition, ZoneDefinition } from './roomController.js';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Throws when something other than the given keys is there, so that a typo is answered. */
function only(value: Record<string, unknown>, keys: readonly string[], where: string): void {
  const extra = Object.keys(value).find((key) => !keys.includes(key));
  if (extra !== undefined) {
    throw new Error(`${where} cannot have "${extra}", only ${keys.join(', ')}`);
  }
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${where} must be some text`);
  }
  return value;
}

function lampOf(value: unknown, where: string): LampDefinition {
  if (!isObject(value)) throw new Error(`${where} must be a mapping with an id and an entity`);
  only(value, ['id', 'label', 'entity', 'blackout'], where);
  const id = text(value.id, `the id of ${where}`);
  const lamp: LampDefinition = {
    id,
    label: value.label === undefined ? id : text(value.label, `the label of ${where}`),
    entity: text(value.entity, `the entity of ${where}`),
  };
  if (value.blackout !== undefined) {
    if (typeof value.blackout !== 'boolean')
      throw new Error(`blackout of ${where} must be true or false`);
    lamp.blackout = value.blackout;
  }
  return lamp;
}

function zoneOf(value: unknown, where: string): ZoneDefinition {
  if (!isObject(value)) throw new Error(`${where} must be a mapping with an id and lamps`);
  only(value, ['id', 'label', 'lamps'], where);
  const id = text(value.id, `the id of ${where}`);
  if (!Array.isArray(value.lamps) || value.lamps.length === 0) {
    throw new Error(`${where} needs a list of lamps, at least one`);
  }
  return {
    id,
    label: value.label === undefined ? id : text(value.label, `the label of ${where}`),
    lamps: value.lamps.map((lamp, i) => text(lamp, `lamp ${i + 1} of ${where}`)),
  };
}

/** The fixtures of a rig file as it was read. Throws an `Error` that says what is wrong. */
export function parseRig(source: string, file = 'the rig file'): HassFixtureDefinition[] {
  let data: unknown;
  try {
    data = parse(source);
  } catch (error) {
    throw new Error(`${file} is not valid YAML. ${error instanceof Error ? error.message : error}`);
  }
  if (data === null || data === undefined) return [];
  if (!isObject(data)) throw new Error(`${file} must be a mapping with a list of fixtures`);
  only(data, ['fixtures'], file);
  if (data.fixtures === undefined || data.fixtures === null) return [];
  if (!Array.isArray(data.fixtures)) throw new Error(`"fixtures" in ${file} must be a list`);

  return data.fixtures.map((each, index): HassFixtureDefinition => {
    const where = `fixture ${index + 1} of ${file}`;
    if (!isObject(each)) throw new Error(`${where} must be a mapping`);
    only(each, ['id', 'kind', 'label', 'lamps', 'zones'], where);
    const id = text(each.id, `the id of ${where}`);
    if (each.kind !== 'room') {
      throw new Error(
        `"${id}" in ${file} is a "${String(each.kind)}": the rig file holds fixtures of the kind room only, for now`,
      );
    }
    if (!Array.isArray(each.lamps)) throw new Error(`"${id}" in ${file} needs a list of lamps`);
    const fixture: HassFixtureDefinition = {
      id,
      kind: each.kind,
      label: each.label === undefined ? id : text(each.label, `the label of ${where}`),
      lamps: each.lamps.map((lamp, i) => lampOf(lamp, `lamp ${i + 1} of "${id}"`)),
    };
    if (each.zones !== undefined && each.zones !== null) {
      if (!Array.isArray(each.zones)) throw new Error(`"zones" of "${id}" must be a list`);
      fixture.zones = each.zones.map((zone, i) => zoneOf(zone, `zone ${i + 1} of "${id}"`));
    }
    return fixture;
  });
}

/**
 * Reads the rig file. A file that is not there gives no fixtures. Any other trouble with it
 * throws an `Error` that says what and where.
 */
export function readRigFile(path: string): HassFixtureDefinition[] {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`cannot read the rig file ${path}: ${(error as Error).message}`);
  }
  return parseRig(source, path);
}
