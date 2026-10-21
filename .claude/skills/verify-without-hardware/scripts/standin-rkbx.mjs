#!/usr/bin/env node
// Stand-in for rkbx_link: sends the OSC it is documented to send, for a track of 126 bpm at +2% pitch,
// so the receiver can be checked without rekordbox. It has its own OSC encoder on purpose, so the
// parser in src/inputs/rkbx/osc.ts is not only tested against its own encoder.
//
//   node standin-rkbx.mjs [--to 127.0.0.1:4460] [--bpm 126] [--pitch 0.02] [--seconds 0]
import dgram from 'node:dgram';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    to: { type: 'string', default: '127.0.0.1:4460' },
    bpm: { type: 'string', default: '126' },
    pitch: { type: 'string', default: '0.02' },
    seconds: { type: 'string', default: '0' },
  },
});
const [host, portText] = values.to.split(':');
const port = Number(portText);
const original = Number(values.bpm);
const current = original * (1 + Number(values.pitch));

const pad = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
const str = (s) => pad(Buffer.from(`${s}\0`));
function osc(address, ...args) {
  let tags = ',';
  const data = [];
  for (const a of args) {
    if (typeof a === 'string') {
      tags += 's';
      data.push(str(a));
    } else {
      tags += 'f';
      const b = Buffer.alloc(4);
      b.writeFloatBE(a);
      data.push(b);
    }
  }
  return Buffer.concat([str(address), str(tags), ...data]);
}

const socket = dgram.createSocket('udp4');
const send = (packet) => socket.send(packet, port, host);
const t0 = performance.now();
const beatMs = 60000 / current;

send(osc('/master/track/title', 'Stand-in track'));
setInterval(() => {
  send(osc('/master/bpm/current', current));
  send(osc('/master/bpm/original', original));
}, 500);

let beat = -1;
setInterval(() => {
  const elapsed = performance.now() - t0;
  const now = Math.floor(elapsed / beatMs);
  if (now !== beat) {
    beat = now;
    send(osc('/master/beat/trigger/1', 1));
    setTimeout(() => send(osc('/master/beat/trigger/1', 0)), beatMs / 5);
  }
  send(osc('/master/beat/subdiv/1', (elapsed / beatMs) % 1));
  send(osc('/master/time', elapsed / 1000));
}, 1000 / 60);

console.log(`sending to ${host}:${port}: ${original} bpm, pitch ${values.pitch} => ${current.toFixed(2)}`);
if (Number(values.seconds) > 0) setTimeout(() => process.exit(0), Number(values.seconds) * 1000);
