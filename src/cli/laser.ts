/**
 * Drive the laser by channel name through the LR512 bridge.
 *
 *   pnpm laser <phone-ip> [options] [name=value ...]
 *
 * Every channel of the laser is a byte divided into ranges. A value is the raw byte
 * 0..255, or the key of a range, with a number behind it where the range sets
 * something: a percentage of the range, or the pattern number for `program=pattern`.
 *
 * The whole universe is sent; every channel outside the laser is 0. Without `mode` the
 * laser stays closed.
 */

import { parseArgs } from 'node:util';
import { ALIEN_LASER_10CH } from '../fixtures/laser.js';
import {
  byteForStep,
  byteInRange,
  encodeFixture,
  type FunctionControl,
  findRange,
  UNIVERSE_SIZE,
  writeFixture,
} from '../fixtures/profile.js';
import { printBytes, printTable, sendToBridge } from './shared.js';

const profile = ALIEN_LASER_10CH;

const USAGE = `usage: pnpm laser <phone-ip> [options] [name=value ...]

options:
  -u, --universe <n>   bridge universe index, 0-based (default 0, the LR512's first port)
  -a, --address <n>    DMX start address of the laser (default 44)
  -p, --port <n>       bridge port (default 9010)
      --once           send the frame once and exit (the bridge keeps holding it)
      --blackout       send all zeros once and exit: the laser closes
      --list           print the channel table with the keys of the ranges, and exit

values:
  name=<byte>          raw byte 0..255
  name=<key>           a range by its key: mode=manual drawing=dots
  name=<key>:<n>       a place in the range, in percent: rotation=forward:40
                       or the pattern 1..51: program=pattern:12

examples:
  pnpm laser 192.168.68.101 mode=manual program=pattern:12
  pnpm laser 192.168.68.101 mode=manual program=pattern:3 rotation=forward:40 colour=mix:50
  pnpm laser 192.168.68.101 mode=sound program=sound2
  pnpm laser 192.168.68.101 --blackout

This sends the laser only, so a spider on the same universe goes dark.`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

function integerOption(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) fail(`--${name} must be a whole number, got "${value}"`);
  return n;
}

/** The byte that `text` asks for on a control: a raw byte, a key, or a key and a number. */
function byteFor(control: FunctionControl, text: string): number {
  if (/^\d+$/.test(text)) {
    const byte = Number(text);
    if (byte > 255) fail(`${control.name} is a byte 0..255, got ${text}`);
    return byte;
  }
  const [key = '', amount, ...rest] = text.split(':');
  const range = findRange(control, key);
  if (!range || rest.length > 0) {
    const keys = control.ranges.flatMap((r) => (r.key === undefined ? [] : [r.key]));
    fail(`${control.name} takes a byte 0..255 or one of: ${keys.join(', ')}. Got "${text}".`);
  }
  if (amount === undefined) return byteInRange(control, range);

  const n = Number(amount);
  if (amount === '' || Number.isNaN(n)) fail(`"${amount}" is not a number in "${text}"`);
  if (range.steps !== undefined) {
    if (!Number.isInteger(n) || n < 1 || n > range.steps) {
      fail(`${control.name}=${key} takes a whole number 1..${range.steps}, got ${amount}`);
    }
    return byteForStep(range, n);
  }
  if (range.scale === undefined) {
    fail(`${control.name}=${key} is a plain choice, it takes no number`);
  }
  if (n < 0 || n > 100) fail(`${control.name}=${key} takes a percentage 0..100, got ${amount}`);
  return byteInRange(control, range, n / 100);
}

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    universe: { type: 'string', short: 'u' },
    address: { type: 'string', short: 'a' },
    port: { type: 'string', short: 'p' },
    once: { type: 'boolean', default: false },
    blackout: { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (options.help) {
  console.log(USAGE);
  process.exit(0);
}
if (options.list) {
  printTable(profile);
  process.exit(0);
}

const [host, ...assignments] = positionals;
if (!host) fail('missing <phone-ip>');

const universeIndex = integerOption(options.universe, 0, 'universe');
const address = integerOption(options.address, 44, 'address');
const port = integerOption(options.port, 9010, 'port');

const raw: Record<string, number> = {};
if (options.blackout && assignments.length > 0) fail('--blackout takes no values');
for (const assignment of assignments) {
  const [name, ...parts] = assignment.split('=');
  const text = parts.join('=');
  if (!name || text === '') fail(`expected name=value, got "${assignment}"`);
  const control = profile.controls.find((c) => c.name === name);
  if (control?.kind !== 'function') {
    fail(`unknown channel "${name}". Run with --list to see the names.`);
  }
  raw[name] = byteFor(control, text);
}

const universe = new Uint8Array(UNIVERSE_SIZE);
let footprint: Uint8Array;
try {
  writeFixture(universe, address, profile, { raw });
  footprint = encodeFixture(profile, { raw });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

console.log(`Laser at address ${address}, universe index ${universeIndex}:`);
printBytes(profile, footprint, 'all channels 0 (the laser is closed)');
if (footprint[0] === 0 && !options.blackout && assignments.length > 0) {
  console.log('  mode is not set, so the laser stays closed. Add mode=manual to open it.');
}

sendToBridge({
  host,
  port,
  universeIndex,
  universe,
  once: options.once || options.blackout,
});
