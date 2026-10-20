/**
 * Photograph the laser at every setting, with a phone running the camera app (`android-camera/`),
 * and save each photo with the bytes that were sent. The pictures are what a simulation of the
 * laser is made from (`docs/laser-simulator-plan.md`).
 *
 *   pnpm laser-survey <command> --bridge <ip> --camera <ip> [options] [name=value ...]
 *
 * Run it instead of lightdeck, not beside it: it sends the laser only, so a spider on the same
 * universe goes dark, and two senders would fight over the universe.
 */

import { parseArgs } from 'node:util';
import { ALIEN_LASER_10CH } from '../fixtures/laser.js';
import { CameraError, HttpCamera } from '../laserSurvey/camera.js';
import { connectLaser, folderStore } from '../laserSurvey/output.js';
import { baseBytes, checkName, PlanError, pilot, type Shot, sweep } from '../laserSurvey/plan.js';
import { runSurvey } from '../laserSurvey/run.js';
import { parseAssignments, UsageError } from './assign.js';

const USAGE = `usage: pnpm laser-survey <command> --camera <ip> [--bridge <ip>] [options] [name=value ...]

commands:
  status               what the camera app says, and nothing else (the laser is not touched)
  shot                 one photo with the laser set to the name=value bytes
  clip                 one clip (--seconds, default 10)
  pilot                the pilot of docs/laser-simulator-plan.md: 3 shapes, rotation, position,
                       size, flip and colour of one pattern (--pattern), and a clip of it spinning
  sweep <channel>      one channel through its bytes (--step, default 8; --from, --to), the
                       rest held. "sweep program --step 1" is all 256 bytes of the pattern channel

options:
      --camera <ip[:port]>  the camera app (port 9020)
      --bridge <ip[:port]>  the LR512 bridge (port 9010)
  -u, --universe <n>        bridge universe index (default 0)
  -a, --address <n>         DMX start address of the laser (default 44)
      --out <folder>        where the shots go (default docs/laser-photos)
      --pattern <1..51>     the pattern held while a channel is swept
      --name <name>         for shot and clip: the file name below --out (default shots/<time>)
      --seconds <n>         length of a clip
      --step <n>            sweep: every n-th byte (default 8)
      --from <byte>, --to <byte>   sweep: only this part of 0..255
      --settle <ms>         wait after setting the laser, before the shot (default 800)
      --iso <n>             camera ISO (default 100)
      --exposure-ms <n>     camera exposure in ms (default 100: the scanner draws a whole picture)
      --focus <diopters>    camera focus; with --distance it is worked out (default infinity)
      --width <px>          width of the photos (default 1600)
      --distance <m>        distance from the laser to the wall, kept with every shot
      --note <text>         kept with every shot
      --again               shoot shots again that are already there
      --yes                 do not wait 5 seconds before the laser comes on
  -h, --help

A run can be stopped with Ctrl-C and continued by running the same command again: shots that are
there are skipped. The laser is closed at the end, however the run ends.

SAFETY: 500 mW. Nobody in the beam, no glass or mirrors, and the beam not into the camera lens.
The phone goes beside the laser, looking at the wall.

examples:
  pnpm laser-survey status --camera 192.168.68.102
  pnpm laser-survey shot --camera 192.168.68.102 --bridge 192.168.68.101 --name aim program=pattern:26
  pnpm laser-survey pilot --camera 192.168.68.102 --bridge 192.168.68.101 --pattern 26 --distance 3
  pnpm laser-survey sweep program --step 1 --camera ... --bridge ... moveH=64 moveV=64`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

function numberOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (value.trim() === '' || Number.isNaN(n)) fail(`--${name} must be a number, got "${value}"`);
  return n;
}

function integerOption(value: string | undefined, name: string): number | undefined {
  const n = numberOption(value, name);
  if (n !== undefined && !Number.isInteger(n))
    fail(`--${name} must be a whole number, got "${value}"`);
  return n;
}

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    camera: { type: 'string' },
    bridge: { type: 'string' },
    universe: { type: 'string', short: 'u' },
    address: { type: 'string', short: 'a' },
    out: { type: 'string', default: 'docs/laser-photos' },
    pattern: { type: 'string' },
    name: { type: 'string' },
    seconds: { type: 'string' },
    step: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    settle: { type: 'string' },
    iso: { type: 'string' },
    'exposure-ms': { type: 'string' },
    focus: { type: 'string' },
    width: { type: 'string' },
    distance: { type: 'string' },
    note: { type: 'string' },
    again: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (options.help) {
  console.log(USAGE);
  process.exit(0);
}

const [command, ...rest] = positionals;
if (!command) fail('missing the command');
if (!options.camera) fail('missing --camera <ip>');

const camera = (() => {
  try {
    return new HttpCamera(options.camera);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
})();

/** Lets a mistake in what was typed end the run with the usage, and anything else pass. */
function typed<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof UsageError || error instanceof PlanError || error instanceof CameraError) {
      return fail(error.message);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const status = await camera.status().catch((error) => fail(String(error.message ?? error)));
  console.log(`camera app at ${camera.url}:`);
  console.log(JSON.stringify(status, null, 2));
  if (command === 'status') return;
  if (!status.ready) fail(`the camera is not ready: ${status.problem ?? 'unknown reason'}`);
  if (status.manualSensor === false) {
    console.log(
      '\nwarning: this phone cannot set the exposure by hand, so the photos are auto exposed and ' +
        'will not be comparable. Another phone is better.',
    );
  }

  const distance = numberOption(options.distance, 'distance');
  const focus =
    numberOption(options.focus, 'focus') ??
    (distance !== undefined && distance > 0 ? 1 / distance : 0);
  const settings = await camera
    .configure({
      iso: integerOption(options.iso, 'iso') ?? 100,
      exposureMs: numberOption(options['exposure-ms'], 'exposure-ms') ?? 100,
      focus,
      width: integerOption(options.width, 'width') ?? 1600,
    })
    .catch((error) => fail(String(error.message ?? error)));
  console.log(
    `\nset: iso ${settings.iso}, exposure ${settings.exposureMs} ms, focus ${settings.focus} diopters, photos ${settings.still?.width}x${settings.still?.height}`,
  );

  const pattern = integerOption(options.pattern, 'pattern');
  const shots = typed((): Shot[] => {
    const assigned = parseAssignments(ALIEN_LASER_10CH, command === 'sweep' ? rest.slice(1) : rest);
    const base = baseBytes(assigned, pattern);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').toLowerCase();
    switch (command) {
      case 'shot':
        return [{ name: checkName(options.name ?? `shots/${stamp}`), raw: base }];
      case 'clip':
        return [
          {
            name: checkName(options.name ?? `shots/${stamp}`),
            raw: base,
            seconds: numberOption(options.seconds, 'seconds') ?? 10,
          },
        ];
      case 'pilot':
        return pilot(base, pattern ?? 26);
      case 'sweep': {
        const channel = rest[0];
        if (!channel) fail('sweep needs a channel, for example: sweep rotation');
        const step = integerOption(options.step, 'step');
        const from = integerOption(options.from, 'from');
        const to = integerOption(options.to, 'to');
        return sweep(base, channel, {
          ...(step === undefined ? {} : { step }),
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
        });
      }
      default:
        return fail(`unknown command "${command}"`);
    }
  });

  const settleMs = integerOption(options.settle, 'settle') ?? 800;
  const minutes = Math.ceil((shots.length * (settleMs + 1500)) / 60_000);
  console.log(`\n${shots.length} shots into ${options.out}, about ${minutes} min.`);

  const bridge = options.bridge;
  if (!bridge) fail('missing --bridge <ip> (the phone with the LR512 bridge app)');
  const universeIndex = integerOption(options.universe, 'universe') ?? 0;
  const address = integerOption(options.address, 'address') ?? 44;
  const url = /^wss?:\/\//.test(bridge)
    ? bridge
    : `ws://${bridge.includes(':') ? bridge : `${bridge}:9010`}`;

  if (!options.yes) {
    console.log(
      '\nThe laser comes on in 5 seconds. Nobody in the beam, no glass or mirrors, not into the camera lens. Ctrl-C to stop.',
    );
    await new Promise((r) => setTimeout(r, 5000));
  }

  const laser = await connectLaser({
    url,
    universeIndex,
    address,
    log: (message) => console.log(`bridge: ${message}`),
  }).catch((error) => fail(String(error.message ?? error)));

  const abort = new AbortController();
  process.once('SIGINT', () => {
    console.log('\nstopping, closing the laser');
    abort.abort();
    void laser.close().then(() => process.exit(130));
  });

  const result = await runSurvey(shots, {
    laser,
    camera,
    store: folderStore(options.out),
    settleMs,
    again: options.again,
    signal: abort.signal,
    log: (message) => console.log(message),
    context: {
      command,
      ...(distance === undefined ? {} : { distanceM: distance }),
      ...(options.note === undefined ? {} : { note: options.note }),
      universe: universeIndex,
      address,
    },
  });
  console.log(
    `\ntaken ${result.taken}, skipped ${result.skipped}${result.aborted ? ', stopped' : ''}; the laser is closed.`,
  );
  if (result.failed) {
    console.error(`failed at ${result.failed}`);
    process.exitCode = 1;
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  },
);
