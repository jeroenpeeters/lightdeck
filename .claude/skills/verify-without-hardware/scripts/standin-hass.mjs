#!/usr/bin/env node
// A stand-in for Home Assistant, to run lightdeck without the lamps and the Zigbee mesh.
//
// It speaks the part of the WebSocket API that lightdeck uses: auth_required, auth (with a
// token it checks), get_states, call_service (answered with a result) and pings. It keeps no
// state of lamps: it prints every service call it gets and, with --dump, writes them to a file.
// No dependencies: the WebSocket handshake and framing are done on a plain socket.
//
//   node standin-hass.mjs [--port 8123] [--token tok] [--rate <per second>] [--down-after <s>]
//                         [--dump <file.json>] [--quiet]
//                         [--light light.bar[:rgbw|rgb|xy|color_temp|brightness|onoff]]...
//
//   --port        where to listen, default 8123
//   --token       the access token to accept, default "tok"
//   --light       an entity to report as `on` (repeat it). The part after the colon is its
//                 supported_color_modes (comma separated), default "xy,color_temp", which is
//                 what the Zigbee spots of the real room say. `switch.` entities are switches.
//                 Without any --light there are four: light.bar, light.shelf, light.ceiling
//                 and switch.fog
//   --rate        how many service calls per second the "mesh" answers, default: at once. The
//                 real mesh of the room answered about 4 per second (2026-10-18), so
//                 --rate 4 makes the throttle show whether it keeps the answers short
//   --down-after  close every connection after this many seconds and refuse new ones for 5 s,
//                 once, to see lightdeck go down and come back
//   --dump        write { "calls": [ { "at": ms, "entity": "...", "service": "...", "data": {...} } ],
//                 "answered": n, "waiting": n } on every call and every answer
//   --quiet       print nothing

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const port = Number(option('--port', 8123));
const token = option('--token', 'tok');
const rate = option('--rate') === undefined ? 0 : Number(option('--rate'));
const downAfter = option('--down-after') === undefined ? 0 : Number(option('--down-after'));
const dump = option('--dump');
const quiet = args.includes('--quiet');
const lightArgs = args.flatMap((arg, at) => (args[at - 1] === '--light' ? [arg] : []));
if (lightArgs.length === 0) {
  lightArgs.push('light.bar', 'light.shelf', 'light.ceiling', 'switch.fog');
}

const states = lightArgs.map((text) => {
  const [entity, modes] = text.split(':');
  const attributes = entity.startsWith('light.')
    ? { supported_color_modes: (modes ?? 'xy,color_temp').split(','), brightness: 255 }
    : {};
  return { entity_id: entity, state: 'on', attributes };
});

const started = Date.now();
const calls = [];
let answered = 0;
const log = (message) => {
  if (!quiet) console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(7)}s  ${message}`);
};
const write = () => {
  if (!dump) return;
  writeFileSync(dump, JSON.stringify({ calls, answered, waiting: waiting.length }));
};

/** The calls the "mesh" has not answered yet, oldest first. */
const waiting = [];
const open = new Set();
let refusing = false;

function textFrame(text) {
  const payload = Buffer.from(text);
  const head =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([head, payload]);
}

function answer(item) {
  if (item.socket.destroyed) return;
  answered++;
  item.socket.write(textFrame(JSON.stringify({ id: item.id, type: 'result', success: true, result: {} })));
  write();
}

if (rate > 0) {
  setInterval(() => {
    const item = waiting.shift();
    if (item) answer(item);
  }, 1000 / rate);
}

const server = createServer((socket) => {
  if (refusing) {
    socket.destroy();
    return;
  }
  open.add(socket);
  socket.on('close', () => open.delete(socket));
  socket.on('error', () => {});
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  const say = (message) => socket.write(textFrame(JSON.stringify(message)));

  const handle = (message) => {
    if (message.type === 'auth') {
      if (message.access_token === token) {
        say({ type: 'auth_ok', ha_version: 'standin' });
        log('lightdeck logged in');
      } else {
        say({ type: 'auth_invalid', message: 'Invalid access token' });
        log('lightdeck sent a wrong token');
      }
    } else if (message.type === 'get_states') {
      say({ id: message.id, type: 'result', success: true, result: states });
    } else if (message.type === 'call_service') {
      const data = message.service_data ?? {};
      const { entity_id: entity, ...rest } = data;
      calls.push({ at: Date.now() - started, entity, service: `${message.domain}.${message.service}`, data: rest });
      log(`${message.domain}.${message.service} ${entity} ${JSON.stringify(rest)}`);
      if (rate > 0) waiting.push({ socket, id: message.id });
      else answer({ socket, id: message.id });
      write();
    } else if (message.type === 'ping') {
      say({ id: message.id, type: 'pong' });
    } else if (typeof message.id === 'number') {
      say({ id: message.id, type: 'result', success: true, result: null });
    }
  };

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const key = /sec-websocket-key:\s*(.+)\r\n/i.exec(buffer.toString('latin1'))?.[1]?.trim();
      const accept = createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      buffer = buffer.subarray(end + 4);
      upgraded = true;
      say({ type: 'auth_required', ha_version: 'standin' });
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
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (masked) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= buffer[maskOffset + (i & 3)];
      }
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x1) handle(JSON.parse(payload.toString()));
      if (opcode === 0x8) socket.end();
    }
  });
});

if (downAfter > 0) {
  setTimeout(() => {
    log('going down for 5 s');
    refusing = true;
    waiting.length = 0;
    for (const socket of open) socket.destroy();
    setTimeout(() => {
      refusing = false;
      log('up again');
    }, 5000);
  }, downAfter * 1000);
}

server.listen(port, '127.0.0.1', () => {
  log(
    `stand-in Home Assistant on ws://127.0.0.1:${port}/api/websocket, token "${token}", ${states.length} entities${rate > 0 ? `, answers ${rate} calls per second` : ''}`,
  );
  write();
});
