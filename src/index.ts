/**
 * lightdeck: serves a control page per fixture, puts the universes together and keeps
 * the LR512 bridge fed.
 *
 * Settings come from the command line or the environment:
 *   --bridge         LR512_BRIDGE_URL   ws://<phone-ip>:9010. Without it nothing is sent to an
 *                                       LR512 and the simulator at /simulator is the output
 *   --universe       SPIDER_UNIVERSE    bridge universe index of the spider, 0-based
 *                                       (default 0, the first port)
 *   --address        SPIDER_ADDRESS     DMX start address of the spider (default 1)
 *   --laser-universe LASER_UNIVERSE     bridge universe index of the laser (default: the
 *                                       spider's)
 *   --laser-address  LASER_ADDRESS      DMX start address of the laser (default 44, right
 *                                       after a spider at 1), or "none" to run without it
 *   --show           SHOW_FILE          the show file, which the deck writes
 *                                       (default show.yaml, where lightdeck is started)
 *   --max-fps        MAX_FPS            the most frames per second to send, 1 to 60 (default 25,
 *                                       which is what the original Light Rider app sends)
 *   --lead-ms        LEAD_MS            how far ahead of the beat the output is made, in
 *                                       milliseconds, to make up for the path to the light
 *                                       (default 0)
 *   --tempo          TEMPO_SOURCE       who sets the tempo at the start: `manual` (default) or
 *                                       `rekordbox`, which follows the OSC of rkbx_link
 *   --rkbx           RKBX_PORT          the UDP port to listen on for the OSC of rkbx_link
 *                                       (default 4460), or "off" to listen on none
 *   --hass           HASS_URL           ws://<home-assistant>:8123/api/websocket, http://<home-assistant>:8123 will do. Needed when the
 *                                       rig file has fixtures
 *                    HASS_TOKEN         a long-lived access token of Home Assistant. Environment
 *                                       only: a flag shows in the list of processes
 *                    HASS_SIMULATE      1 or true (or --hass-simulate): run the lamps of the room
 *                                       against a Home Assistant that lives in lightdeck, so that
 *                                       no real lamp is touched. No URL or token needed
 *   --rig            RIG_FILE           the rig file, with the lamps of the room (default rig.yaml,
 *                                       where lightdeck is started). Without the file there are
 *                                       no lamps and nothing is asked of Home Assistant
 *   --port           PORT               port of the web page (default 8080)
 *   --host           HOST               address to listen on (default 0.0.0.0)
 */

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { HassClient } from './outputs/hass/client.js';
import { simulatedHass } from './outputs/hass/simulated.js';
import { hassWebSocketUrl } from './outputs/hass/url.js';
import { Lr512BridgeClient } from './outputs/lr512/bridgeClient.js';
import { createHttpServer } from './server/http.js';
import { type FixtureDefinition, Rig } from './server/rig.js';
import { readRigFile } from './server/rigFile.js';

/** How long the last frame gets to leave for the bridge when lightdeck stops. */
const LAST_FRAME_MS = 300;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function decimal(value: string, name: string): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n)) fail(`${name} must be a number, got "${value}"`);
  return n;
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
    'max-fps': { type: 'string' },
    'lead-ms': { type: 'string' },
    tempo: { type: 'string' },
    rkbx: { type: 'string' },
    hass: { type: 'string' },
    'hass-simulate': { type: 'boolean' },
    rig: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
  },
});

/** The bridge to the LR512, or none: then only the simulator and the pages see the lights. */
const bridgeUrl = args.bridge ?? process.env.LR512_BRIDGE_URL;
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
const maxFps = decimal(args['max-fps'] ?? process.env.MAX_FPS ?? '25', 'max-fps');
const leadMs = decimal(args['lead-ms'] ?? process.env.LEAD_MS ?? '0', 'lead-ms');
const tempoSourceText = args.tempo ?? process.env.TEMPO_SOURCE ?? 'manual';
if (tempoSourceText !== 'manual' && tempoSourceText !== 'rekordbox') {
  fail(`--tempo must be manual or rekordbox, got "${tempoSourceText}"`);
}
const rkbxText = args.rkbx ?? process.env.RKBX_PORT ?? '4460';
const rkbxPort = rkbxText === 'off' ? undefined : wholeNumber(rkbxText, 'rkbx port');
const hassUrlText = args.hass ?? process.env.HASS_URL;
let hassUrl: string | undefined;
try {
  hassUrl = hassUrlText ? hassWebSocketUrl(hassUrlText) : undefined;
} catch (error) {
  fail((error as Error).message);
}
const hassToken = process.env.HASS_TOKEN;
const hassSimulated =
  args['hass-simulate'] === true || /^(1|true|yes)$/i.test(process.env.HASS_SIMULATE ?? '');
const rigFile = args.rig ?? process.env.RIG_FILE ?? 'rig.yaml';
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

// The lamps of the room, from the rig file. No file, no lamps, and nothing asks Home Assistant.
try {
  fixtures.push(...readRigFile(rigFile));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const lampEntities = fixtures.flatMap((fixture) =>
  'lamps' in fixture ? fixture.lamps.map((lamp) => lamp.entity) : [],
);
if (lampEntities.length > 0 && !hassSimulated) {
  if (!hassUrl)
    fail(`${rigFile} has lamps, so lightdeck needs --hass (or HASS_URL) to reach Home Assistant`);
  if (!hassToken) fail(`${rigFile} has lamps, so lightdeck needs HASS_TOKEN in its environment`);
}

const log = (message: string) => console.log(`${new Date().toISOString()}  ${message}`);

let rig: Rig | undefined;
/** What the bridge client offers the rest, for when there is no bridge. */
const noBridge = {
  connected: false,
  setUniverse() {},
  setMaxFps() {},
  flush() {},
  start() {},
  stop() {},
};
const bridge = bridgeUrl
  ? new Lr512BridgeClient({
      url: bridgeUrl,
      maxFps,
      log: (message) => log(`bridge: ${message}`),
      onConnection: (connected) => rig?.setBridgeConnected(connected),
      onStatus: (status) => {
        log(
          `bridge: LR512 ${status.device}, ${status.universes} universes, channels per universe [${status.channels.join(', ')}]`,
        );
        const universes = fixtures.flatMap((fixture) =>
          'universe' in fixture ? [fixture.universe] : [],
        );
        for (const index of new Set(universes)) {
          if (status.device === 'open' && status.channels[index] === 0) {
            log(
              `warning: universe index ${index} has 0 channels on this LR512, nothing sent to it reaches a fixture`,
            );
          }
        }
        rig?.setDeviceStatus(status);
      },
    })
  : noBridge;

/** The link to Home Assistant, or none when no lamp needs it. It never keeps lightdeck waiting. */
const hass =
  lampEntities.length > 0 && hassSimulated
    ? new HassClient({
        url: 'ws://simulated/api/websocket',
        token: 'simulated',
        entities: lampEntities,
        socketFactory: simulatedHass(lampEntities),
        log: (message) => log(`home assistant (simulated): ${message}`),
        // The real client says connected; the pages must say what this is.
        onStatus: (status) => rig?.setHassStatus(status === 'connected' ? 'simulated' : status),
      })
    : lampEntities.length > 0 && hassUrl && hassToken
      ? new HassClient({
          url: hassUrl,
          token: hassToken,
          entities: lampEntities,
          log: (message) => log(`home assistant: ${message}`),
          onStatus: (status) => rig?.setHassStatus(status),
        })
      : undefined;

try {
  rig = new Rig({
    output: bridge,
    ...(hass ? { hass } : {}),
    fixtures,
    show: showFile,
    maxFps,
    leadMs,
    tempoSource: tempoSourceText,
    ...(rkbxPort === undefined ? {} : { rkbxPort }),
    log,
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const server = createHttpServer({
  rig,
  bridgeUrl: bridgeUrl ?? null,
  publicDir: fileURLToPath(new URL('./server/public/', import.meta.url)),
});

server.on('error', (error) => fail(`cannot listen on ${host}:${port}: ${error.message}`));
server.listen(port, host, () => {
  log(`control pages on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  log(bridgeUrl ? `bridge ${bridgeUrl}` : 'no bridge: the simulator at /simulator is the output');
  for (const fixture of fixtures) {
    log(
      'lamps' in fixture
        ? `${fixture.label}: ${fixture.lamps.length} lamps and switches, page /fixtures/${fixture.id}`
        : `${fixture.label} at address ${fixture.address}, universe index ${fixture.universe}, page /fixtures/${fixture.id}`,
    );
  }
  if (hass) {
    log(
      hassSimulated
        ? 'home assistant SIMULATED: no lamp is touched, the lamps are made up'
        : `home assistant ${hassUrl}`,
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
  hass?.start();
});

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  // The bridge holds the last frame it got. A laser must not keep burning with nobody at
  // the controls: fixtures like that go dark now, and that frame gets time to leave.
  rig?.darken();
  bridge.flush();
  rig?.close();
  hass?.stop();
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
