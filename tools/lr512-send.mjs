#!/usr/bin/env node
// Test sender for the LR512 WebSocket bridge.
//
// Connects to the bridge running on the phone and streams DMX frames so you can
// watch a channel move on a real fixture. Frame = [universe:1][512 channels].
//
// Uses Node's built-in global WebSocket (Node 18+/22), no dependencies.
//
// Usage:
//   node tools/lr512-send.mjs <phone-ip> [universe] [channel] [sweep|full|off|all]
//   node tools/lr512-send.mjs <phone-ip> <universe> set <ch>=<val> [<ch>=<val> ...]
//     universe default 0; channel is 1-based; values 0..255.
//
// Examples:
//   node tools/lr512-send.mjs 192.168.68.101                 # sweep channel 1, universe 0
//   node tools/lr512-send.mjs 192.168.68.101 0 1 full        # hold channel 1 at 255
//   node tools/lr512-send.mjs 192.168.68.101 0 1 off         # blackout universe 0
//   node tools/lr512-send.mjs 192.168.68.101 0 1 all         # flood all 512 channels
//   node tools/lr512-send.mjs 192.168.68.101 1 set 4=255 6=255 7=0 8=0
//        # on universe 1, hold ch4=255, ch6=255, ch7=0, ch8=0 (e.g. dimmer + red)

const HOST = process.argv[2];
const UNIVERSE = Number(process.argv[3] ?? 0);
const PORT = 9010;
const FPS = 40;

let MODE, CHANNEL = 1;
const PAIRS = []; // [channel(1-based), value]
if (process.argv[4] === 'set') {
  MODE = 'set';
  for (const tok of process.argv.slice(5)) {
    const [c, v] = tok.split('=');
    const ch = Number(c), val = Number(v);
    if (!(ch >= 1 && ch <= 512) || !(val >= 0 && val <= 255)) {
      console.error(`bad pair "${tok}" (need <1..512>=<0..255>)`); process.exit(1);
    }
    PAIRS.push([ch, val]);
  }
  if (PAIRS.length === 0) { console.error('set needs at least one <ch>=<val>'); process.exit(1); }
} else {
  CHANNEL = Number(process.argv[4] ?? 1);
  MODE = process.argv[5] ?? 'sweep';
}

if (!HOST) {
  console.error('usage: node tools/lr512-send.mjs <phone-ip> [universe] [channel] [sweep|full|off|all]');
  console.error('   or: node tools/lr512-send.mjs <phone-ip> <universe> set <ch>=<val> ...');
  process.exit(1);
}
if (MODE !== 'set' && (CHANNEL < 1 || CHANNEL > 512)) { console.error('channel must be 1..512'); process.exit(1); }

const url = `ws://${HOST}:${PORT}`;
console.log(`Connecting to ${url} (universe ${UNIVERSE}, channel ${CHANNEL}, mode ${MODE})`);
const ws = new WebSocket(url);
ws.binaryType = 'arraybuffer';

function frame(values512) {
  const buf = new Uint8Array(513);
  buf[0] = UNIVERSE & 0xff;
  buf.set(values512, 1);
  return buf;
}

let timer = null;
ws.addEventListener('open', () => {
  console.log('Connected. Streaming... (Ctrl-C to stop)');
  const values = new Uint8Array(512);
  const idx = CHANNEL - 1;

  if (MODE === 'off') {
    ws.send(frame(values));
    console.log('Sent blackout frame.');
    setTimeout(() => { ws.close(); process.exit(0); }, 200);
    return;
  }
  if (MODE === 'set') {
    for (const [ch, val] of PAIRS) values[ch - 1] = val;
    timer = setInterval(() => ws.send(frame(values)), 1000 / FPS);
    console.log('Holding universe ' + UNIVERSE + ': ' + PAIRS.map(([c, v]) => c + '=' + v).join(' '));
    return;
  }
  if (MODE === 'all') {
    // Flood every channel to 255: whatever the fixture's patch, dimmer/color/etc.
    // are all high, so it must show something if DMX output is reaching it.
    values.fill(255);
    timer = setInterval(() => ws.send(frame(values)), 1000 / FPS);
    console.log(`Holding ALL 512 channels of universe ${UNIVERSE} at 255.`);
    return;
  }
  if (MODE === 'full') {
    values[idx] = 255;
    // resend at FPS so it is unmistakable even if a frame is dropped
    timer = setInterval(() => ws.send(frame(values)), 1000 / FPS);
    console.log(`Holding channel ${CHANNEL} at 255.`);
    return;
  }
  // sweep: triangle wave 0..255..0 over ~2s
  let t = 0;
  timer = setInterval(() => {
    t += 1 / FPS;
    const phase = (t % 2) / 2;             // 0..1 over 2s
    const v = Math.round((phase < 0.5 ? phase * 2 : (1 - phase) * 2) * 255);
    values[idx] = v;
    ws.send(frame(values));
  }, 1000 / FPS);
  console.log(`Sweeping channel ${CHANNEL} 0..255..0 every 2s.`);
});

ws.addEventListener('close', () => { console.log('Connection closed.'); if (timer) clearInterval(timer); });
ws.addEventListener('error', (e) => { console.error('WebSocket error:', e.message ?? e); process.exit(1); });
process.on('SIGINT', () => { if (timer) clearInterval(timer); try { ws.close(); } catch {} process.exit(0); });
