/**
 * Show what rkbx_link sends. Run it on the lightdeck laptop, point `osc.destination` in the
 * config of rkbx_link at this computer, and see which addresses arrive, how often and with
 * what. It is how the tempo from rekordbox is checked before anything uses it.
 *
 *   pnpm rkbx-monitor [--port 4460] [--raw]
 */

import { networkInterfaces } from 'node:os';
import { parseArgs } from 'node:util';
import type { OscArg, OscMessage } from '../inputs/rkbx/osc.js';
import { DEFAULT_OSC_PORT, OscReceiver } from '../inputs/rkbx/receiver.js';

const USAGE = `usage: pnpm rkbx-monitor [options]

options:
  -p, --port <n>     UDP port to listen on (default ${DEFAULT_OSC_PORT}, what rkbx_link sends to)
      --host <ip>    address to listen on (default 0.0.0.0, every interface)
      --raw          print every message, however often it comes
  -h, --help         this text

In the config of rkbx_link: osc.enabled = true and osc.destination = <this computer>:${DEFAULT_OSC_PORT}.
The frequent messages (beat/trigger, beat/subdiv, time) are off there until you turn them on.`;

/** An address that comes faster than this is summarised instead of printed on every change. */
const QUIET_RATE_HZ = 5;
const SUMMARY_EVERY_MS = 2000;

const { values } = parseArgs({
  options: {
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    raw: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const port = values.port === undefined ? DEFAULT_OSC_PORT : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`--port must be a port number, got "${values.port}"\n\n${USAGE}`);
  process.exit(1);
}

/** Names of interfaces that are not the network the lights and the DJ computer are on. */
const VIRTUAL_INTERFACE =
  /^(lo|docker|br-|veth|virbr|lxc|lxd|tun|tap|tailscale|wg|zt|cni|flannel|cali)/;

/** The addresses of this computer on a real network, to put in `osc.destination` of rkbx_link. */
function lanAddresses(): { name: string; address: string }[] {
  const found: { name: string; address: string }[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (VIRTUAL_INTERFACE.test(name)) continue;
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal) found.push({ name, address: info.address });
    }
  }
  return found;
}

function show(args: OscArg[]): string {
  if (args.length === 0) return '(no arguments)';
  return args
    .map((arg) => {
      if (typeof arg === 'number') return Number.isInteger(arg) ? String(arg) : arg.toFixed(3);
      if (arg instanceof Uint8Array) return `<${arg.length} bytes>`;
      return JSON.stringify(arg);
    })
    .join(' ');
}

interface Seen {
  count: number;
  /** Arrivals in the last second. */
  recent: number[];
  last: string;
  /** What was last printed for it. */
  printed: string;
}

const seen = new Map<string, Seen>();
const startedAt = performance.now();
const stamp = (): string => `${((performance.now() - startedAt) / 1000).toFixed(1).padStart(6)}s`;

const receiver = new OscReceiver({
  port,
  ...(values.host === undefined ? {} : { host: values.host }),
});

receiver.on('message', (message: OscMessage, arrivedAt: number) => {
  const text = show(message.args);
  let entry = seen.get(message.address);
  if (entry === undefined) {
    entry = { count: 0, recent: [], last: '', printed: '' };
    seen.set(message.address, entry);
    console.log(`${stamp()}  new address ${message.address}`);
  }
  entry.count += 1;
  entry.last = text;
  entry.recent.push(arrivedAt);
  while (entry.recent.length > 0 && arrivedAt - (entry.recent[0] ?? arrivedAt) > 1000) {
    entry.recent.shift();
  }
  const quiet = entry.recent.length < QUIET_RATE_HZ;
  if (values.raw || (quiet && text !== entry.printed)) {
    console.log(`${stamp()}  ${message.address}  ${text}`);
    entry.printed = text;
  }
});

receiver.on('malformed', (error: Error, from: string) => {
  console.log(`${stamp()}  not OSC from ${from}: ${error.message}`);
});
receiver.on('problem', (error: Error) => console.error(`socket problem: ${error.message}`));

try {
  await receiver.start();
} catch (error) {
  console.error(`Could not listen on UDP ${port}: ${(error as Error).message}`);
  process.exit(1);
}
console.log(`Listening for OSC on UDP ${receiver.port}. Ctrl-C stops.`);
const addresses = lanAddresses();
if (addresses.length === 0) {
  console.log('No network address found: this computer is not on a network.');
} else {
  console.log('Set this in the config of rkbx_link, on the rekordbox computer:');
  for (const { name, address } of addresses) {
    console.log(`  osc.destination = ${address}:${receiver.port}    (${name})`);
  }
}

const summary = setInterval(() => {
  if (seen.size === 0) {
    console.log(`${stamp()}  nothing yet`);
    return;
  }
  const now = performance.now();
  const rows = [...seen.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([address, entry]) => {
      const rate = entry.recent.filter((t) => now - t <= 1000).length;
      return `  ${address.padEnd(34)} ${String(rate).padStart(4)}/s  ${String(entry.count).padStart(7)} total  last: ${entry.last}`;
    });
  console.log(`${stamp()}  addresses:\n${rows.join('\n')}`);
}, SUMMARY_EVERY_MS);

const stop = () => {
  clearInterval(summary);
  receiver.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
