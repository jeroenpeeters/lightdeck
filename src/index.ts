/**
 * lightdeck: serves a control page per fixture, puts the universes together and keeps
 * the LR512 bridge fed.
 *
 * Settings come from the command line or the environment:
 *   --bridge         LR512_BRIDGE_URL   ws://<phone-ip>:9010, required
 *   --universe       SPIDER_UNIVERSE    bridge universe index of the spider, 0-based
 *                                       (default 0, the first port)
 *   --address        SPIDER_ADDRESS     DMX start address of the spider (default 1)
 *   --laser-universe LASER_UNIVERSE     bridge universe index of the laser (default: the
 *                                       spider's)
 *   --laser-address  LASER_ADDRESS      DMX start address of the laser (default 44, right
 *                                       after a spider at 1), or "none" to run without it
 *   --show           SHOW_FILE          the show file, which the deck writes
 *                                       (default show.yaml, where lightdeck is started)
 *   --port           PORT               port of the web page (default 8080)
 *   --host           HOST               address to listen on (default 0.0.0.0)
 */

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Lr512BridgeClient } from './outputs/lr512/bridgeClient.js';
import { createHttpServer } from './server/http.js';
import { type FixtureDefinition, Rig } from './server/rig.js';

/** How long the last frame gets to leave for the bridge when lightdeck stops. */
const LAST_FRAME_MS = 300;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function wholeNumber(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) fail(`${name} must be a whole number, got "${value}"`);
  return n;
}

const { values: args } = parseArgs({
  options: {
    bridge: { type: 'string' },
    universe: { type: 'string' },
    address: { type: 'string' },
    'laser-universe': { type: 'string' },
    'laser-address': { type: 'string' },
    show: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
  },
});

const bridgeUrl = args.bridge ?? process.env.LR512_BRIDGE_URL;
if (!bridgeUrl) {
  fail(
    'Where is the bridge? Set LR512_BRIDGE_URL or pass --bridge, for example:\n' +
      '  pnpm dev --bridge ws://192.168.68.101:9010',
  );
}
const universe = wholeNumber(args.universe ?? process.env.SPIDER_UNIVERSE ?? '0', 'universe');
const address = wholeNumber(args.address ?? process.env.SPIDER_ADDRESS ?? '1', 'address');
const laserAddressText = args['laser-address'] ?? process.env.LASER_ADDRESS ?? '44';
const laserAddress =
  laserAddressText === 'none' ? undefined : wholeNumber(laserAddressText, 'laser address');
const laserUniverse = wholeNumber(
  args['laser-universe'] ?? process.env.LASER_UNIVERSE ?? String(universe),
  'laser universe',
);
const showFile = args.show ?? process.env.SHOW_FILE ?? 'show.yaml';
const port = wholeNumber(args.port ?? process.env.PORT ?? '8080', 'port');
const host = args.host ?? process.env.HOST ?? '0.0.0.0';

// The fixtures on the console. One more fixture is one more line here.
const fixtures: FixtureDefinition[] = [
  { id: 'spider', kind: 'spider', label: 'Spider', universe, address },
];
if (laserAddress !== undefined) {
  fixtures.push({
    id: 'laser',
    kind: 'laser',
    label: 'Laser',
    universe: laserUniverse,
    address: laserAddress,
  });
}

const log = (message: string) => console.log(`${new Date().toISOString()}  ${message}`);

let rig: Rig | undefined;
const bridge = new Lr512BridgeClient({
  url: bridgeUrl,
  log: (message) => log(`bridge: ${message}`),
  onConnection: (connected) => rig?.setBridgeConnected(connected),
  onStatus: (status) => {
    log(
      `bridge: LR512 ${status.device}, ${status.universes} universes, channels per universe [${status.channels.join(', ')}]`,
    );
    for (const index of new Set(fixtures.map((fixture) => fixture.universe))) {
      if (status.device === 'open' && status.channels[index] === 0) {
        log(
          `warning: universe index ${index} has 0 channels on this LR512, nothing sent to it reaches a fixture`,
        );
      }
    }
    rig?.setDeviceStatus(status);
  },
});

try {
  rig = new Rig({ output: bridge, fixtures, show: showFile });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const server = createHttpServer({
  rig,
  bridgeUrl,
  publicDir: fileURLToPath(new URL('./server/public/', import.meta.url)),
});

server.on('error', (error) => fail(`cannot listen on ${host}:${port}: ${error.message}`));
server.listen(port, host, () => {
  log(`control pages on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  log(`bridge ${bridgeUrl}`);
  for (const fixture of fixtures) {
    log(
      `${fixture.label} at address ${fixture.address}, universe index ${fixture.universe}, page /fixtures/${fixture.id}`,
    );
  }
  if (laserAddress === undefined) log('no laser: started with laser address "none"');
  const show = rig?.playback.getShow();
  if (show) {
    const scenes = show.groups.reduce((count, group) => count + group.scenes.length, 0);
    log(`show ${show.file}, ${show.groups.length} groups, ${scenes} scenes`);
  }
  if (show?.problem) log(`warning: the show file is not used, it has a mistake. ${show.problem}`);
  bridge.start();
});

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  // The bridge holds the last frame it got. A laser must not keep burning with nobody at
  // the controls: fixtures like that go dark now, and that frame gets time to leave.
  rig?.darken();
  bridge.tick();
  rig?.close();
  // Open event streams keep the server alive; do not wait for them. A request that is
  // under way is cut off too: what it asks would come after the last frame.
  server.close();
  server.closeAllConnections();
  setTimeout(
    () => {
      bridge.stop();
      process.exit(0);
    },
    bridge.connected ? LAST_FRAME_MS : 0,
  );
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
