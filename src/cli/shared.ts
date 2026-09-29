/**
 * What the command-line tools for the fixtures have in common: printing a profile and
 * the bytes that go out, and handing one universe to the LR512 bridge.
 */

import type { Control, FixtureProfile } from '../fixtures/profile.js';
import { Lr512BridgeClient } from '../outputs/lr512/bridgeClient.js';

export function channelsOf(control: Control): string {
  return control.kind === 'level' && control.fineChannel !== undefined
    ? `${control.channel}+${control.fineChannel}`
    : String(control.channel);
}

export function printTable(profile: FixtureProfile): void {
  console.log(`${profile.name} (${profile.footprint} channels)\n`);
  for (const control of profile.controls) {
    const unit = control.kind === 'function' ? 'raw 0..255' : 'percent';
    console.log(
      `  ${channelsOf(control).padStart(5)}  ${control.name.padEnd(12)} ${unit.padEnd(11)} ${control.label}`,
    );
    if (control.kind === 'function') {
      for (const r of control.ranges) {
        const key = r.key === undefined ? '' : `${r.key.padEnd(11)} `;
        const when = r.when ? ` (while ${r.when.control} is ${r.when.key})` : '';
        console.log(`${' '.repeat(33)}${`${r.from}-${r.to}`.padEnd(8)} ${key}${r.meaning}${when}`);
      }
    }
  }
}

/** Prints the channels of an encoded fixture that are not 0. */
export function printBytes(profile: FixtureProfile, bytes: Uint8Array, dark: string): void {
  let any = false;
  for (const control of profile.controls) {
    const values =
      control.kind === 'level' && control.fineChannel !== undefined
        ? [bytes[control.channel - 1], bytes[control.fineChannel - 1]]
        : [bytes[control.channel - 1]];
    if (values.every((b) => b === 0)) continue;
    any = true;
    console.log(
      `  ch ${channelsOf(control).padStart(5)}  ${control.name.padEnd(12)} = ${values.join(', ')}`,
    );
  }
  if (!any) console.log(`  ${dark}`);
}

export interface SendOptions {
  host: string;
  port: number;
  universeIndex: number;
  universe: Uint8Array;
  /** Send the frame once and exit, instead of holding it. */
  once: boolean;
}

/** Hands the universe to the bridge, and holds it there unless `once` is set. */
export function sendToBridge(options: SendOptions): void {
  const { host, port, universeIndex, universe, once } = options;
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
      if (!connected || !once) return;
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
  if (once) {
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
}
