#!/usr/bin/env node
// A stand-in for the Android bridge, to run lightdeck without the phone and the LR512.
//
// It speaks the wire protocol of android-bridge/: it takes binary frames of
// [universe: 1 byte][512 DMX bytes] and sends the status message a real bridge sends.
// It keeps the newest frame per universe, prints what changed, and can write what is
// being "sent" to a file, so that a check can read the output instead of guessing.
//
//   node standin-bridge.mjs [--port 9010] [--channels 512,0] [--device open|lost]
//                           [--dump <file.json>] [--quiet]
//
//   --port      where to listen, default 9010 (the port of the real bridge)
//   --channels  licensed channels per universe, as the LR512 reports them, default 512,0
//   --device    what the status says about the LR512 at the start, default open
//   --dump      write the newest state to this file on every change:
//               { "connected": true, "frames": 12, "universes": { "0": { "6": 255 } } }
//               with only the channels that are not 0, by 1-based channel number
//   --quiet     print connections only, not the channels
//
// Send it SIGUSR1 to switch the device between open and lost, to see what the console
// says when the LR512 is gone:  kill -USR1 <pid>
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

const { values: options } = parseArgs({
  options: {
    port: { type: 'string', default: '9010' },
    channels: { type: 'string', default: '512,0' },
    device: { type: 'string', default: 'open' },
    dump: { type: 'string' },
    quiet: { type: 'boolean', default: false },
  },
});

const port = Number(options.port);
const channels = options.channels.split(',').map(Number);
let device = options.device === 'lost' ? 'lost' : 'open';

/** Newest frame per universe index. */
const universes = new Map();
const sockets = new Set();
let frames = 0;
let lastPrint = 0;
let printTimer;

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (text) => console.log(`${stamp()}  ${text}`);

function statusText() {
  return JSON.stringify(
    device === 'open'
      ? { type: 'status', device, universes: channels.length, channels }
      : { type: 'status', device, universes: 0, channels: [] },
  );
}

/** A text frame from server to client: not masked, and short enough for one length byte. */
function textFrame(text) {
  const payload = Buffer.from(text);
  if (payload.length > 125) throw new Error('status message too long for a short frame');
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function nonZero(frame) {
  const set = {};
  frame.forEach((value, index) => {
    if (value !== 0) set[index + 1] = value;
  });
  return set;
}

function dump() {
  if (!options.dump) return;
  const state = { connected: sockets.size > 0, device, frames, universes: {} };
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
  const before = universes.get(index);
  if (before && before.equals(data)) {
    // The same frame again: counted, not printed.
    if (options.dump && frames % 40 === 0) dump();
    return;
  }
  universes.set(index, Buffer.from(data));
  if ((channels[index] ?? 0) === 0) {
    log(`universe ${index} has 0 channels on an LR512: a real one refuses this frame`);
  }
  changed();
}

const server = createServer((socket) => {
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  socket.on('error', () => {});
  socket.on('close', () => {
    if (!sockets.delete(socket)) return;
    log('lightdeck disconnected');
    dump();
  });
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const key = /sec-websocket-key:\s*(.+)\r\n/i.exec(buffer.toString('latin1'))?.[1]?.trim();
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
      buffer = buffer.subarray(end + 4);
      upgraded = true;
      sockets.add(socket);
      log('lightdeck connected');
      dump();
    }
    for (;;) {
      if (buffer.length < 2) return;
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
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x2) onFrame(payload);
      else if (opcode === 0x9) socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
      else if (opcode === 0x8) socket.end();
    }
  });
});

process.on('SIGUSR1', () => {
  device = device === 'open' ? 'lost' : 'open';
  log(`device is now ${device}`);
  for (const socket of sockets) socket.write(textFrame(statusText()));
  dump();
});

const stop = () => {
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
  log(`channels per universe [${channels.join(', ')}]`);
  dump();
});
