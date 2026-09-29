/**
 * lightdeck: serves the spider control page and keeps the LR512 bridge fed.
 *
 * Settings come from the command line or the environment:
 *   --bridge   LR512_BRIDGE_URL   ws://<phone-ip>:9010, required
 *   --universe SPIDER_UNIVERSE    bridge universe index, 0-based (default 0, the first port)
 *   --address  SPIDER_ADDRESS     DMX start address of the spider (default 1)
 *   --port     PORT               port of the web page (default 8080)
 *   --host     HOST               address to listen on (default 0.0.0.0)
 */

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SPIDER_43CH, SPIDER_LAYOUT } from './fixtures/spider.js';
import { Lr512BridgeClient } from './outputs/lr512/bridgeClient.js';
import { SpiderController } from './server/controller.js';
import { createHttpServer } from './server/http.js';

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
const port = wholeNumber(args.port ?? process.env.PORT ?? '8080', 'port');
const host = args.host ?? process.env.HOST ?? '0.0.0.0';

const log = (message: string) => console.log(`${new Date().toISOString()}  ${message}`);

let controller: SpiderController | undefined;
const bridge = new Lr512BridgeClient({
  url: bridgeUrl,
  log: (message) => log(`bridge: ${message}`),
  onConnection: (connected) => controller?.setBridgeConnected(connected),
  onStatus: (status) => {
    log(
      `bridge: LR512 ${status.device}, ${status.universes} universes, channels per universe [${status.channels.join(', ')}]`,
    );
    if (status.device === 'open' && status.channels[universe] === 0) {
      log(
        `warning: universe index ${universe} has 0 channels on this LR512, nothing sent to it reaches a fixture`,
      );
    }
    controller?.setDeviceStatus(status);
  },
});

try {
  controller = new SpiderController({
    profile: SPIDER_43CH,
    layout: SPIDER_LAYOUT,
    output: bridge,
    universe,
    address,
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const server = createHttpServer({
  controller,
  bridgeUrl,
  publicDir: fileURLToPath(new URL('./server/public/', import.meta.url)),
});

server.on('error', (error) => fail(`cannot listen on ${host}:${port}: ${error.message}`));
server.listen(port, host, () => {
  log(`spider page on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  log(`spider at address ${address}, universe index ${universe}, bridge ${bridgeUrl}`);
  bridge.start();
});

const shutdown = () => {
  bridge.stop();
  controller?.close();
  server.close(() => process.exit(0));
  // Open event streams keep the server alive; do not wait for them.
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
