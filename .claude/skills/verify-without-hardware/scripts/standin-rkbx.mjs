#!/usr/bin/env node
// Stand-in for rkbx_link: sends the OSC it is documented to send, for a track of 126 bpm at +2% pitch,
// so the receiver can be checked without rekordbox. It has its own OSC encoder on purpose, so the
// parser in src/inputs/rkbx/osc.ts is not only tested against its own encoder.
//
//   node standin-rkbx.mjs [--to 127.0.0.1:4460] [--bpm 126] [--pitch 0.02] [--seconds 0]
//                         [--phrases string|int] [--phrase-seconds 4]
//
// With --phrases it also sends /master/phrase/current, only when the phrase changes like the real one (a
// capture of 2026-10-21 showed 5 messages in 78 s), and the phrase goes round Intro, Chorus, Down (the
// breakdown), Chorus, each for --phrase-seconds. `int` sends the numbers
// of `osc.phrase_output_format int` (1, 3, 4, 3), `string` the names.
import dgram from 'node:dgram';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    to: { type: 'string', default: '127.0.0.1:4460' },
    bpm: { type: 'string', default: '126' },
    pitch: { type: 'string', default: '0.02' },
    seconds: { type: 'string', default: '0' },
    phrases: { type: 'string' },
    'phrase-seconds': { type: 'string', default: '4' },
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

const PHRASES = [['Intro', 1], ['Chorus', 3], ['Down', 4], ['Chorus', 3]];
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
let phraseSlot = -1;
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
  if (values.phrases) {
    const slot = Math.floor(elapsed / 1000 / Number(values['phrase-seconds'])) % PHRASES.length;
    if (slot !== phraseSlot) {
      phraseSlot = slot;
      const [name, number] = PHRASES[slot];
      send(values.phrases === 'int' ? osc('/master/phrase/current', number) : osc('/master/phrase/current', name));
    }
  }
}, 1000 / 60);

console.log(`sending to ${host}:${port}: ${original} bpm, pitch ${values.pitch} => ${current.toFixed(2)}`);
if (Number(values.seconds) > 0) setTimeout(() => process.exit(0), Number(values.seconds) * 1000);
