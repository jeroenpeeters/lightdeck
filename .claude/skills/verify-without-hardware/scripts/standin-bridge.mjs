#!/usr/bin/env node
// A stand-in for the Android bridge, to run lightdeck without the phone and the LR512.
//
// It speaks the wire protocol of android-bridge/: it takes binary frames of
// [universe: 1 byte][512 DMX bytes], sends the status message a real bridge sends and the
// alive message once a second, and takes the limits message of the client. It keeps the
// newest frame per universe, prints what changed, and can write what is being "sent" to a
// file, so that a check can read the output instead of guessing.
//
//   node standin-bridge.mjs [--port 9010] [--channels 512,0] [--device open|lost]
//                           [--dump <file.json>] [--quiet] [--no-alive] [--client-idle <ms>]
//
//   --port      where to listen, default 9010 (the port of the real bridge)
//   --channels  licensed channels per universe, as the LR512 reports them, default 512,0
//   --device    what the status says about the LR512 at the start, default open
//   --dump      write the newest state to this file on every change:
//               { "connected": true, "device": "open", "frames": 12,
//                 "universes": { "0": { "6": 255 } },
//                 "silent": false, "limits": { "type": "limits", "maxFps": 25 }, "capFps": 25,
//                 "framesByUniverse": { "0": 12 }, "changedByUniverse": { "0": 3 }, "alives": 4 }
//               `universes` has only the channels that are not 0, by 1-based channel number.
//               `limits` is the last limits message as it came, null when there has been
//               none (or the client has gone: the real bridge then goes back to its default
//               of 25). `capFps` is what the real bridge would apply: maxFps clamped to 1..60,
//               25 without a limits message. `framesByUniverse` counts every frame received,
//               `changedByUniverse` those that differ from the one before.
//   --quiet     print connections and limits only, not the channels or the rates
//   --no-alive  never send the alive message: an APK from before it existed
//   --client-idle <ms>
//               what the real bridge does with a client that went quiet: once a client has
//               sent a valid limits message, a connection from which no byte has come for
//               this long is closed (with a close frame), and the limits are forgotten. The
//               real bridge uses 6000. Default 0: never, the stand-in leaves connections
//               alone. A client that never sent limits is never closed.
//
// Every 5 seconds with traffic it prints, per universe, frames per second and how many of
// them differ from the one before.
//
// Send it SIGUSR1 to switch the device between open and lost, to see what the console
// says when the LR512 is gone:  kill -USR1 <pid>
//
// Send it SIGUSR2 to switch "silent" on and off. Silent is a half-open connection: the TCP
// connections stay open and are read, but nothing is answered and nothing is sent, no
// alive, no status, no pong, no handshake. What arrives meanwhile is queued and handled
// when silent ends, like an app that was frozen.  kill -USR2 <pid>
//
// The `frames` of its alive message is the number of frames received so far. The real
// bridge counts the frames it has handed to the vendor library, refreshes included.
//
// No dependencies: Node's own net and crypto, with a WebSocket handshake by hand, the
// way the test of the bridge client does it.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { parseArgs } from 'node:util';

const UNIVERSE_SIZE = 512;
/** At most this many lines per second about channels, so an effect does not flood. */
const PRINTS_PER_SECOND = 4;
const ALIVE_MS = 1000;
const RATE_MS = 5000;
/** What the real bridge applies without a limits message, and the range it clamps to. */
const DEFAULT_FPS = 25;
const MIN_FPS = 1;
const MAX_FPS = 60;

const { values: options } = parseArgs({
  options: {
    port: { type: 'string', default: '9010' },
    channels: { type: 'string', default: '512,0' },
    device: { type: 'string', default: 'open' },
    dump: { type: 'string' },
    quiet: { type: 'boolean', default: false },
    'no-alive': { type: 'boolean', default: false },
    'client-idle': { type: 'string', default: '0' },
  },
});

const port = Number(options.port);
const channels = options.channels.split(',').map(Number);
const clientIdleMs = Number(options['client-idle']);
let device = options.device === 'lost' ? 'lost' : 'open';

/** Newest frame per universe index. */
const universes = new Map();
/** Connections that have done the handshake. */
const sockets = new Set();
/** Every open connection, with what it needs to handle its data. */
const connections = new Set();
let frames = 0;
let alives = 0;
let silent = false;
/** The status that was not sent because the stand-in was silent. */
let statusMissed = false;
let limits = null;
let capFps = DEFAULT_FPS;
/** Per universe index: every frame received, and those that differ from the one before. */
const received = new Map();
const changedCount = new Map();
/** The same since the last rate line. */
const windowReceived = new Map();
const windowChanged = new Map();
let lastPrint = 0;
let printTimer;

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (text) => console.log(`${stamp()}  ${text}`);
const bump = (map, index) => map.set(index, (map.get(index) ?? 0) + 1);

function statusText() {
  return JSON.stringify(
    device === 'open'
      ? { type: 'status', device, universes: channels.length, channels }
      : { type: 'status', device, universes: 0, channels: [] },
  );
}

function aliveText() {
  return JSON.stringify({ type: 'alive', device, frames });
}

/** A text frame from server to client: not masked, and short enough for one length byte. */
function textFrame(text) {
  const payload = Buffer.from(text);
  if (payload.length > 125) throw new Error('message too long for a short frame');
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function nonZero(frame) {
  const set = {};
  frame.forEach((value, index) => {
    if (value !== 0) set[index + 1] = value;
  });
  return set;
}

const counts = (map) => Object.fromEntries([...map].sort(([a], [b]) => a - b));

function dump() {
  if (!options.dump) return;
  const state = {
    connected: sockets.size > 0,
    device,
    frames,
    universes: {},
    silent,
    limits,
    capFps,
    framesByUniverse: counts(received),
    changedByUniverse: counts(changedCount),
    alives,
  };
  for (const [index, frame] of universes) state.universes[index] = nonZero(frame);
  writeFileSync(options.dump, `${JSON.stringify(state, null, 2)}\n`);
}

function print() {
  printTimer = undefined;
  lastPrint = Date.now();
  for (const [index, frame] of universes) {
    const set = Object.entries(nonZero(frame))
      .map(([channel, value]) => `${channel}=${value}`)
      .join(' ');
    log(`universe ${index}: ${set || 'all 0'}`);
  }
}

function changed() {
  dump();
  if (options.quiet || printTimer) return;
  const wait = Math.max(0, 1000 / PRINTS_PER_SECOND - (Date.now() - lastPrint));
  printTimer = setTimeout(print, wait);
}

function onFrame(payload) {
  if (payload.length !== 1 + UNIVERSE_SIZE) {
    log(`ignored a frame of ${payload.length} bytes, expected ${1 + UNIVERSE_SIZE}`);
    return;
  }
  frames += 1;
  const index = payload[0];
  const data = payload.subarray(1);
  bump(received, index);
  bump(windowReceived, index);
  const before = universes.get(index);
  if (before && before.equals(data)) {
    // The same frame again: counted, not printed.
    if (options.dump && frames % 40 === 0) dump();
    return;
  }
  bump(changedCount, index);
  bump(windowChanged, index);
  universes.set(index, Buffer.from(data));
  if ((channels[index] ?? 0) === 0) {
    log(`universe ${index} has 0 channels on an LR512: a real one refuses this frame`);
  }
  changed();
}

/** A text message from the client. The one that exists is {"type":"limits","maxFps":25}. */
function onText(text, connection) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    message = undefined;
  }
  const fps = message?.maxFps;
  if (message?.type !== 'limits' || typeof fps !== 'number' || Number.isNaN(fps)) {
    log(`ignored a text message that is not a valid limits message: ${text.slice(0, 80)}`);
    return;
  }
  limits = message;
  capFps = Math.max(MIN_FPS, Math.min(MAX_FPS, fps));
  log(`limits: ${text}, so a real bridge caps at ${capFps} fps`);
  if (clientIdleMs > 0 && !connection.idleArmed) {
    connection.idleArmed = true;
    connection.restartIdle();
  }
  dump();
}

function printRates() {
  const seconds = RATE_MS / 1000;
  if (!options.quiet) {
    for (const [index, count] of windowReceived) {
      const differ = windowChanged.get(index) ?? 0;
      log(
        `universe ${index}: ${(count / seconds).toFixed(1)} frames/s received, ` +
          `${(differ / seconds).toFixed(1)} per second differ from the one before`,
      );
    }
  }
  windowReceived.clear();
  windowChanged.clear();
}

function sendAlive(socket) {
  if (options['no-alive'] || silent) return;
  alives += 1;
  socket.write(textFrame(aliveText()));
}

const server = createServer((socket) => {
  const connection = {
    buffer: Buffer.alloc(0),
    upgraded: false,
    handle: undefined,
    aliveTimer: undefined,
    idleArmed: false,
    idleTimer: undefined,
    restartIdle: undefined,
  };
  connections.add(connection);
  socket.on('error', () => {});

  /** Every byte that comes restarts the idle timer, once a limits message has armed it. */
  connection.restartIdle = () => {
    clearTimeout(connection.idleTimer);
    if (!connection.idleArmed) return;
    connection.idleTimer = setTimeout(() => {
      log(`client silent for ${clientIdleMs / 1000} s, closing the connection so that it can reconnect.`);
      socket.end(Buffer.from([0x88, 0x02, 0x03, 0xe8])); // close frame, 1000
      setTimeout(() => socket.destroy(), 500).unref();
    }, clientIdleMs);
  };
  socket.on('close', () => {
    clearInterval(connection.aliveTimer);
    clearTimeout(connection.idleTimer);
    connections.delete(connection);
    if (!sockets.delete(socket)) return;
    log('lightdeck disconnected');
    if (sockets.size === 0) {
      // The real bridge goes back to its default cap when the client has gone.
      limits = null;
      capFps = DEFAULT_FPS;
    }
    dump();
  });

  /** Handles what is queued in the buffer. Does nothing while silent. */
  connection.handle = () => {
    if (silent) return;
    if (!connection.upgraded) {
      const end = connection.buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const key = /sec-websocket-key:\s*(.+)\r\n/i.exec(connection.buffer.toString('latin1'))?.[1]?.trim();
      if (!key) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }
      const accept = createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.write(textFrame(statusText()));
      sendAlive(socket);
      if (!options['no-alive']) connection.aliveTimer = setInterval(() => sendAlive(socket), ALIVE_MS);
      connection.buffer = connection.buffer.subarray(end + 4);
      connection.upgraded = true;
      sockets.add(socket);
      log('lightdeck connected');
      dump();
    }
    for (;;) {
      const buffer = connection.buffer;
      if (silent || buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        socket.destroy();
        return;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (masked) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= buffer[maskOffset + (i & 3)];
      }
      connection.buffer = buffer.subarray(offset + length);
      if (opcode === 0x2) onFrame(payload);
      else if (opcode === 0x1) onText(payload.toString('utf8'), connection);
      else if (opcode === 0x9) socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
      else if (opcode === 0x8) socket.end();
    }
  };

  socket.on('data', (chunk) => {
    connection.restartIdle();
    connection.buffer = Buffer.concat([connection.buffer, chunk]);
    connection.handle();
  });
});

process.on('SIGUSR1', () => {
  device = device === 'open' ? 'lost' : 'open';
  log(`device is now ${device}${silent ? ' (silent: the status is sent when it ends)' : ''}`);
  if (silent) statusMissed = true;
  else for (const socket of sockets) socket.write(textFrame(statusText()));
  dump();
});

process.on('SIGUSR2', () => {
  silent = !silent;
  log(silent ? 'silent: nothing is sent or answered, the connections stay open' : 'not silent any more');
  if (!silent) {
    if (statusMissed) for (const socket of sockets) socket.write(textFrame(statusText()));
    statusMissed = false;
    for (const connection of [...connections]) connection.handle();
  }
  dump();
});

const rateTimer = setInterval(printRates, RATE_MS);

const stop = () => {
  clearInterval(rateTimer);
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

server.on('error', (error) => {
  console.error(`cannot listen on port ${port}: ${error.message}`);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  log(`stand-in bridge on ws://127.0.0.1:${port}, pid ${process.pid}, device ${device}`);
  log(
    `channels per universe [${channels.join(', ')}]${options['no-alive'] ? ', no alive messages' : ''}` +
      (clientIdleMs > 0 ? `, closes a client silent for ${clientIdleMs} ms after its limits` : ''),
  );
  dump();
});
