/**
 * Drive lamps and switches through Home Assistant by entity id: the tool for the Zigbee proof.
 *
 *   pnpm lamp <entity>... [options] [name=value ...]
 *
 * Values are percentages 0..100: dimmer (default 100), red, green, blue, white (the colour;
 * white 100 when none is given). `fade` is the transition in seconds (default 1). A switch is
 * turned on by a dimmer above 0 and off by dimmer=0.
 *
 * The address and the token come from the environment, as for lightdeck itself: HASS_URL
 * (or --url) and HASS_TOKEN. The token is never taken from a flag: a flag shows in the list of
 * processes.
 *
 * --list prints what Home Assistant says about the entities. --soak <minutes> fades the lights
 * through the colours of the rainbow for that long, through the same budget lightdeck keeps
 * to, and reports what was sent, what was refused, how long the answers took and which
 * entities became unavailable.
 */

import { parseArgs } from 'node:util';
import type { Rgbw } from '../engine/colour.js';
import { type CommandResult, HassClient } from '../outputs/hass/client.js';
import { lightCommand, switchCommand } from '../outputs/hass/encode.js';
import type { EntityReport } from '../outputs/hass/types.js';
import { hassWebSocketUrl } from '../outputs/hass/url.js';

const USAGE = `usage: pnpm lamp <entity>... [options] [name=value ...]

options:
      --url <ws-url>    Home Assistant, ws://host:8123/api/websocket, or http://host:8123 (or HASS_URL)
      --list            print what Home Assistant says about the entities and exit
      --soak <minutes>  fade the lights through colours for that long, then report

The access token is read from HASS_TOKEN only.

values:
  percent 0..100   dimmer (default 100)  red green blue white (white 100 if none given)
  seconds          fade (default 1)

examples:
  pnpm lamp light.bar dimmer=50 red=100 fade=2
  pnpm lamp light.bar switch.fog --list
  pnpm lamp light.a light.b light.c light.d light.e --soak 10`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string' },
    list: { type: 'boolean', default: false },
    soak: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (options.help) {
  console.log(USAGE);
  process.exit(0);
}

const entities = positionals.filter((each) => !each.includes('='));
const assignments = positionals.filter((each) => each.includes('='));
if (entities.length === 0) fail('name at least one entity, such as light.bar');
for (const entity of entities) {
  if (!/^(light|switch)\.[a-z0-9_]+$/.test(entity)) {
    fail(`"${entity}" is not a light or a switch entity id, such as light.bar`);
  }
}

const urlText = options.url ?? process.env.HASS_URL;
const token = process.env.HASS_TOKEN;
if (!urlText) fail('give the address of Home Assistant with --url or HASS_URL');
let url: string;
try {
  url = hassWebSocketUrl(urlText);
} catch (error) {
  fail((error as Error).message);
}
if (!token) fail('give the access token in HASS_TOKEN');
const soakMinutes = options.soak === undefined ? undefined : Number(options.soak);
if (soakMinutes !== undefined && !(soakMinutes > 0)) fail('--soak takes a number of minutes');

const values = { dimmer: 100, red: 0, green: 0, blue: 0, white: 0, fade: 1 };
let colourGiven = false;
for (const assignment of assignments) {
  const [name, text] = assignment.split('=');
  if (!name || !(name in values) || text === undefined || text === '') {
    fail(`expected dimmer, red, green, blue, white or fade = a number, got "${assignment}"`);
  }
  const value = Number(text);
  if (Number.isNaN(value)) fail(`"${text}" is not a number in "${assignment}"`);
  if (name === 'fade') {
    if (value < 0 || value > 300) fail(`fade is seconds between 0 and 300, got ${text}`);
  } else if (value < 0 || value > 100) {
    fail(`${name} is a percentage 0..100, got ${text}`);
  }
  if (['red', 'green', 'blue', 'white'].includes(name)) colourGiven = true;
  (values as Record<string, number>)[name] = value;
}
if (!colourGiven) values.white = 100;

const log = (message: string) => console.log(`${new Date().toISOString()}  ${message}`);

/** How long each answer took, and who answered. */
const results: CommandResult[] = [];
const client = new HassClient({
  url,
  token,
  entities,
  log,
  onResult: (result) => results.push(result),
  onStatus: (status) => log(`Home Assistant: ${status}`),
});

const stats = (numbers: number[]) =>
  numbers.length === 0
    ? 'no answers'
    : `mean ${(numbers.reduce((a, b) => a + b, 0) / numbers.length).toFixed(0)} ms, max ${Math.max(...numbers).toFixed(0)} ms`;

/** Waits until Home Assistant has told about every entity, or the time is up. */
async function knownStates(timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (entities.every((entity) => client.reports().has(entity))) return [];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return entities.filter((entity) => !client.reports().has(entity));
}

async function connect(): Promise<void> {
  client.start();
  try {
    await client.whenConnected(10_000);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    client.stop();
    process.exit(1);
  }
}

function finish(code = 0): never {
  client.stop();
  process.exit(code);
}

async function list(): Promise<void> {
  await connect();
  await knownStates(3000);
  for (const entity of entities) {
    const info = client.reports().get(entity);
    if (!info) {
      console.log(`${entity.padEnd(32)} not known to Home Assistant`);
      continue;
    }
    const modes = info.report.colourModes.length > 0 ? info.report.colourModes.join(', ') : '-';
    const brightness = info.brightness === undefined ? '' : `  brightness ${info.brightness}`;
    console.log(
      `${entity.padEnd(32)} ${info.state.padEnd(12)} ${info.report.available ? 'available' : 'UNAVAILABLE'}  modes: ${modes}${brightness}`,
    );
  }
  finish();
}

async function set(): Promise<void> {
  await connect();
  const missing = await knownStates(2000);
  for (const entity of missing) log(`${entity} is not known to Home Assistant, sending anyway`);
  const peak = Math.max(values.red, values.green, values.blue, values.white);
  const colour: Rgbw =
    peak === 0
      ? { red: 0, green: 0, blue: 0, white: 0 }
      : {
          red: values.red / peak,
          green: values.green / peak,
          blue: values.blue / peak,
          white: values.white / peak,
        };
  const brightness = (values.dimmer / 100) * (peak / 100);
  for (const entity of entities) {
    if (entity.startsWith('switch.')) {
      client.setEntity(entity, switchCommand(values.dimmer > 0));
      continue;
    }
    const modes = client.reports().get(entity)?.report.colourModes;
    client.setEntity(entity, lightCommand({ brightness, colour, modes, transition: values.fade }));
  }
  const deadline = Date.now() + 10_000;
  while (results.length < entities.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const entity of entities) {
    const result = results.find((each) => each.entity === entity);
    console.log(
      !result
        ? `${entity}: no answer`
        : result.ok
          ? `${entity}: accepted in ${result.ms.toFixed(0)} ms`
          : `${entity}: refused (${result.error})`,
    );
  }
  finish(results.length === entities.length && results.every((each) => each.ok) ? 0 : 1);
}

/** A colour of the rainbow, fully saturated. `hue` is 0..1. */
function rainbow(hue: number): Rgbw {
  const h = (((hue % 1) + 1) % 1) * 6;
  const x = 1 - Math.abs((h % 2) - 1);
  const [red, green, blue] =
    h < 1
      ? [1, x, 0]
      : h < 2
        ? [x, 1, 0]
        : h < 3
          ? [0, 1, x]
          : h < 4
            ? [0, x, 1]
            : h < 5
              ? [x, 0, 1]
              : [1, 0, x];
  return { red: red ?? 0, green: green ?? 0, blue: blue ?? 0, white: 0 };
}

async function soak(minutes: number): Promise<void> {
  const lights = entities.filter((entity) => entity.startsWith('light.'));
  const skipped = entities.filter((entity) => entity.startsWith('switch.'));
  if (lights.length === 0) fail('--soak needs at least one light');
  if (skipped.length > 0) log(`switches are left out of the soak: ${skipped.join(', ')}`);

  await connect();
  const missing = await knownStates(3000);
  for (const entity of missing) log(`${entity} is not known to Home Assistant`);

  /** Entities that were unavailable at some point during the soak, and how often they went. */
  const unavailable = new Map<string, number>();
  const wasAvailable = new Map<string, boolean>();
  for (const entity of lights) {
    client.watch(entity, (report: EntityReport | undefined) => {
      const available = report?.available ?? false;
      if (wasAvailable.get(entity) !== false && !available) {
        unavailable.set(entity, (unavailable.get(entity) ?? 0) + 1);
        log(`${entity} became unavailable`);
      }
      wasAvailable.set(entity, available);
    });
  }

  const started = Date.now();
  const endAt = started + minutes * 60_000;
  /** One colour round takes this long. */
  const roundMs = 60_000;
  log(`soak: ${lights.length} lights for ${minutes} minutes. Ctrl-C ends it early.`);

  const report = () => {
    const stats_ = client.stats;
    const ms = results.map((each) => each.ms);
    console.log('\nsoak result');
    console.log(`  ran for         ${((Date.now() - started) / 60_000).toFixed(1)} minutes`);
    console.log(
      `  commands        ${stats_.sent} sent, ${stats_.accepted} accepted, ${stats_.refused} refused, ${stats_.lost} lost on the way`,
    );
    console.log(`  answers         ${stats(ms)}`);
    console.log(
      `  no answer yet   ${client.unanswered} (the lamps are that far behind at the end)`,
    );
    console.log(
      `  rate            ${(stats_.sent / ((Date.now() - started) / 1000)).toFixed(1)} commands per second`,
    );
    console.log(`  logins          ${stats_.connections}`);
    console.log(
      `  unavailable     ${unavailable.size === 0 ? 'none' : [...unavailable].map(([entity, times]) => `${entity} (${times}x)`).join(', ')}`,
    );
    const refused = results.filter((each) => !each.ok);
    for (const each of refused.slice(0, 5)) console.log(`  refused: ${each.entity}: ${each.error}`);
  };
  process.on('SIGINT', () => {
    report();
    finish();
  });

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (Date.now() >= endAt) {
        clearInterval(timer);
        resolve();
        return;
      }
      const phase = (Date.now() - started) / roundMs;
      lights.forEach((entity, index) => {
        const modes = client.reports().get(entity)?.report.colourModes;
        client.setEntity(
          entity,
          lightCommand({
            brightness: 0.8,
            colour: rainbow(phase + index / lights.length),
            modes,
            transition: 1,
          }),
        );
      });
    }, 250);
  });
  report();
  finish();
}

if (options.list) await list();
else if (soakMinutes !== undefined) await soak(soakMinutes);
else await set();
