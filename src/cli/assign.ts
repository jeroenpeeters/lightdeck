/**
 * `name=value` arguments of the command-line tools for a function-channel fixture: a raw byte,
 * the key of a range, or a key and a place in the range. Shared by `pnpm laser` and
 * `pnpm laser-survey`.
 */

import {
  byteForStep,
  byteInRange,
  type FixtureProfile,
  type FunctionControl,
  findRange,
} from '../fixtures/profile.js';

/** A mistake in what the operator typed; the message says what to type instead. */
export class UsageError extends Error {}

/** The byte that `text` asks for on a control: a raw byte, a key, or a key and a number. */
export function byteFor(control: FunctionControl, text: string): number {
  if (/^\d+$/.test(text)) {
    const byte = Number(text);
    if (byte > 255) throw new UsageError(`${control.name} is a byte 0..255, got ${text}`);
    return byte;
  }
  const [key = '', amount, ...rest] = text.split(':');
  const range = findRange(control, key);
  if (!range || rest.length > 0) {
    const keys = control.ranges.flatMap((r) => (r.key === undefined ? [] : [r.key]));
    throw new UsageError(
      `${control.name} takes a byte 0..255 or one of: ${keys.join(', ')}. Got "${text}".`,
    );
  }
  if (amount === undefined) return byteInRange(control, range);

  const n = Number(amount);
  if (amount === '' || Number.isNaN(n)) {
    throw new UsageError(`"${amount}" is not a number in "${text}"`);
  }
  if (range.steps !== undefined) {
    if (!Number.isInteger(n) || n < 1 || n > range.steps) {
      throw new UsageError(
        `${control.name}=${key} takes a whole number 1..${range.steps}, got ${amount}`,
      );
    }
    return byteForStep(range, n);
  }
  if (range.scale === undefined) {
    throw new UsageError(`${control.name}=${key} is a plain choice, it takes no number`);
  }
  if (n < 0 || n > 100) {
    throw new UsageError(`${control.name}=${key} takes a percentage 0..100, got ${amount}`);
  }
  return byteInRange(control, range, n / 100);
}

/** Turns `["mode=manual", "rotation=forward:40"]` into raw bytes by control name. */
export function parseAssignments(
  profile: FixtureProfile,
  assignments: readonly string[],
): Record<string, number> {
  const raw: Record<string, number> = {};
  for (const assignment of assignments) {
    const [name, ...parts] = assignment.split('=');
    const text = parts.join('=');
    if (!name || text === '') throw new UsageError(`expected name=value, got "${assignment}"`);
    const control = profile.controls.find((c) => c.name === name);
    if (control?.kind !== 'function') {
      throw new UsageError(`unknown channel "${name}". Run with --list to see the names.`);
    }
    raw[name] = byteFor(control, text);
  }
  return raw;
}
