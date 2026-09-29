/**
 * Drive the spider by channel name through the LR512 bridge.
 *
 *   pnpm spider <phone-ip> [options] [name=value ...]
 *
 * Levels are percentages 0..100: dimmer, tilt1, tilt2, motorSpeed, strobe, red1..white8.
 * Shortcuts: red, green, blue, white set all eight LEDs; tilt sets both motors.
 * Function channels take the raw byte 0..255 from the manual: function, autoMode,
 * effectSpeed, reset.
 *
 * The whole universe is sent; every channel outside the spider is 0.
 */

import { parseArgs } from 'node:util';
import { type Control, encodeFixture, UNIVERSE_SIZE, writeFixture } from '../fixtures/profile.js';
import { SPIDER_43CH, SPIDER_CELLS } from '../fixtures/spider.js';
import { Lr512BridgeClient } from '../outputs/lr512/bridgeClient.js';

const profile = SPIDER_43CH;
const COLOURS = ['red', 'green', 'blue', 'white'];

const USAGE = `usage: pnpm spider <phone-ip> [options] [name=value ...]

options:
  -u, --universe <n>   bridge universe index, 0-based (default 0, the LR512's first port)
  -a, --address <n>    DMX start address of the spider (default 1)
  -p, --port <n>       bridge port (default 9010)
      --once           send the frame once and exit (the bridge keeps holding it)
      --blackout       send all zeros once and exit
      --list           print the channel table and exit

values:
  levels in percent 0..100   dimmer tilt1 tilt2 motorSpeed strobe red1..white8
  shortcuts                  red green blue white (all 8 LEDs), tilt (both motors)
  raw bytes 0..255           function autoMode effectSpeed reset

examples:
  pnpm spider 192.168.68.101 dimmer=100 red=100
  pnpm spider 192.168.68.101 dimmer=100 red1=100 blue8=50 tilt=25
  pnpm spider 192.168.68.101 --blackout`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

function channelsOf(control: Control): string {
  return control.kind === 'level' && control.fineChannel !== undefined
    ? `${control.channel}+${control.fineChannel}`
    : String(control.channel);
}

function printTable(): void {
  console.log(`${profile.name} (${profile.footprint} channels)\n`);
  for (const control of profile.controls) {
    const unit = control.kind === 'function' ? 'raw 0..255' : 'percent';
    console.log(
      `  ${channelsOf(control).padStart(5)}  ${control.name.padEnd(12)} ${unit.padEnd(11)} ${control.label}`,
    );
    if (control.kind === 'function') {
      for (const r of control.ranges) {
        console.log(`${' '.repeat(33)}${`${r.from}-${r.to}`.padEnd(8)} ${r.meaning}`);
      }
    }
  }
}

function integerOption(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) fail(`--${name} must be a whole number, got "${value}"`);
  return n;
}

/** Expands shortcuts and returns the control names an assignment applies to. */
function targets(name: string): string[] {
  if (COLOURS.includes(name)) {
    return Array.from({ length: SPIDER_CELLS }, (_, i) => `${name}${i + 1}`);
  }
  if (name === 'tilt') return ['tilt1', 'tilt2'];
  return [name];
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
  printTable();
  process.exit(0);
}

const [host, ...assignments] = positionals;
if (!host) fail('missing <phone-ip>');

const universeIndex = integerOption(options.universe, 0, 'universe');
const address = integerOption(options.address, 1, 'address');
const port = integerOption(options.port, 9010, 'port');

const levels: Record<string, number> = {};
const raw: Record<string, number> = {};
if (options.blackout && assignments.length > 0) fail('--blackout takes no values');
for (const assignment of assignments) {
  const [name, text] = assignment.split('=');
  if (!name || text === undefined || text === '') fail(`expected name=value, got "${assignment}"`);
  const value = Number(text);
  if (Number.isNaN(value)) fail(`"${text}" is not a number in "${assignment}"`);
  for (const target of targets(name)) {
    const control = profile.controls.find((c) => c.name === target);
    if (!control) fail(`unknown channel "${name}". Run with --list to see the names.`);
    if (control.kind === 'function') {
      raw[target] = value;
    } else {
      if (value < 0 || value > 100) fail(`${name} is a percentage 0..100, got ${text}`);
      levels[target] = value / 100;
    }
  }
}

const universe = new Uint8Array(UNIVERSE_SIZE);
let footprint: Uint8Array;
try {
  writeFixture(universe, address, profile, { levels, raw });
  footprint = encodeFixture(profile, { levels, raw });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

console.log(`Spider at address ${address}, universe index ${universeIndex}:`);
let any = false;
for (const control of profile.controls) {
  const bytes =
    control.kind === 'level' && control.fineChannel !== undefined
      ? [footprint[control.channel - 1], footprint[control.fineChannel - 1]]
      : [footprint[control.channel - 1]];
  if (bytes.every((b) => b === 0)) continue;
  any = true;
  console.log(
    `  ch ${channelsOf(control).padStart(5)}  ${control.name.padEnd(12)} = ${bytes.join(', ')}`,
  );
}
if (!any) console.log('  all channels 0 (blackout)');

const sendOnce = options.once || options.blackout;
const client = new Lr512BridgeClient({
  url: `ws://${host}:${port}`,
  log: (message) => console.log(message),
  onStatus: (status) => {
    console.log(
      status.device === 'open'
        ? `bridge: LR512 open, ${status.universes} universes`
        : 'bridge: LR512 not connected, the bridge holds the frame until it is back',
    );
    if (status.device === 'open' && universeIndex >= status.universes) {
      console.log(`warning: universe index ${universeIndex} does not exist on this device`);
    } else if (status.device === 'open' && status.channels[universeIndex] === 0) {
      const usable = status.channels.flatMap((c, i) => (c > 0 ? [i] : []));
      console.log(
        `warning: universe index ${universeIndex} has 0 channels on this LR512, so nothing reaches the fixture.` +
          (usable.length > 0 ? ` Use --universe ${usable.join(' or ')}.` : ''),
      );
    }
  },
  onConnection: (connected) => {
    if (!connected || !sendOnce) return;
    // Give the frame time to leave the socket, then exit.
    client.tick();
    setTimeout(() => {
      client.stop();
      process.exit(0);
    }, 300);
  },
});

client.setUniverse(universeIndex, universe);
client.start();
if (sendOnce) {
  setTimeout(() => {
    console.error(`could not reach the bridge at ws://${host}:${port} within 10 s`);
    client.stop();
    process.exit(1);
  }, 10_000);
} else {
  console.log('Holding this state. Ctrl-C to stop; the lights stay as they are.');
  // Keep the state fresh in case the bridge app restarts.
  setInterval(() => client.setUniverse(universeIndex, universe), 1000);
}

process.on('SIGINT', () => {
  client.stop();
  process.exit(0);
});
