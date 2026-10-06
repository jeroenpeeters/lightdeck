/**
 * How well the output path keeps to the beat, measured with the real rig, tempo, controllers and
 * bridge client, and a bridge in another process (`recorder.mjs`) that notes when each frame
 * arrives. Nothing of the phone, the LR512 or a fixture is in it.
 *
 *   pnpm perf --where receiver --effect kick --seconds 30 --bpm 126
 *
 *   --where     `controller` (when a frame is made) or `receiver` (when it arrives at the bridge)
 *   --effect    `kick` (a flash that falls on every beat: how full it is, how early or late it
 *               arrives) or `chase` (a step on every beat)
 *   --seconds   how long to run, default 30
 *   --bpm       the tempo, default 126
 *   --audio 1   with the microphone feed analysed on the same event loop
 *   --laser 1   with the laser effect running too
 *
 * It prints the frame rate, how many frames equal the one before, how far from the ideal grid a
 * beat shows up (negative is early), how full the first frame of a flash is, how late the timers
 * of the engine ran, the delay of the event loop and the CPU. The numbers that came out when the
 * output path was made push-driven and locked to the beat are in docs/output-timing-plan.md.
 */

import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import { Rig } from '../../src/server/rig.js';
import { Lr512BridgeClient } from '../../src/outputs/lr512/bridgeClient.js';
import { toInt16 } from '../../src/inputs/audio/wav.js';
import { kickTrack } from '../../src/inputs/audio/synth.js';
import { type Frame, identicalShare, intervalStats, show } from './analyze.js';

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1]! : d; };
const where = arg('where', 'controller'), effect = arg('effect', 'chase'), seconds = Number(arg('seconds', '30'));
const audio = arg('audio', '0') === '1', bpm = Number(arg('bpm', '126')), laser = arg('laser', '0') === '1';
const beatMs = 60000 / bpm;
const wall = () => performance.timeOrigin + performance.now();

const own: Frame[] = [];
let output: { setUniverse(i: number, d: Uint8Array): void };
let client: Lr512BridgeClient | undefined;
let recorder: ReturnType<typeof spawn> | undefined;
const outFile = join(tmpdir(), `lightdeck-perf-${process.pid}.json`);

if (where === 'receiver') {
  recorder = spawn('node', [new URL('./recorder.mjs', import.meta.url).pathname, '9021', outFile], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((r) => recorder!.stdout!.once('data', () => r()));
  client = new Lr512BridgeClient({ url: 'ws://127.0.0.1:9021' });
  // Tap what the controller hands over, with the moment it did, to pair it with what arrives.
  output = { setUniverse: (i, d) => { own.push({ t: performance.timeOrigin + performance.now(), ch: Array.from(d.subarray(0, 43)) }); client!.setUniverse(i, d); } };
} else {
  output = { setUniverse: (_i, d) => { own.push({ t: performance.now(), ch: Array.from(d.subarray(0, 43)) }); } };
}

const rig = new Rig({ output, fixtures: [
  { id: 'spider', kind: 'spider', label: 'Spider', universe: 0, address: 1 },
  ...(laser ? [{ id: 'laser', kind: 'laser', label: 'Laser', universe: 0, address: 44 }] : []),
] });
client?.start();
if (client) await new Promise((r) => setTimeout(r, 400));
own.length = 0;

const red = { red: 1, green: 0, blue: 0, white: 0 };
rig.tempo.update({ bpm, sync: true });
const spider = rig.find('spider')!.controller;
spider.update({ levels: { dimmer: 1 }, effect: { id: effect, speed: 1, colourA: red, colourB: red } });
if (laser) rig.find('laser')!.controller.update({ raw: { mode: 95 }, effect: { id: 'sweep', speed: 1 } });
// the beat grid, on the clock of this process
const t = performance.now(); const beat = rig.tempo.getBeat();
const originPerf = t - beat * beatMs;

let pushTimer: NodeJS.Timeout | undefined;
if (audio) {
  const rate = 48000, sig = kickTrack(126, { seconds: 12, rate }), pcm = toInt16(sig);
  let index = 0; const per = rate / 10;
  pushTimer = setInterval(() => {
    const from = (index % sig.length), bytes = pcm.subarray(from * 2, (from + per) * 2);
    rig.mic.push({ bytes: new Uint8Array(bytes), sampleRate: rate, index, feed: 'perf' }); index += per;
  }, 100);
}

const loop = monitorEventLoopDelay({ resolution: 1 }); loop.enable();
let gcCount = 0, gcMs = 0, gcMax = 0;
const gc = new PerformanceObserver((list) => { for (const e of list.getEntries()) { gcCount++; gcMs += e.duration; gcMax = Math.max(gcMax, e.duration); } }); gc.observe({ entryTypes: ['gc'] });
const cpu0 = process.cpuUsage(), w0 = performance.now(), heap0 = process.memoryUsage().heapUsed;
await new Promise((r) => setTimeout(r, seconds * 1000));
const cpu = process.cpuUsage(cpu0), wallMs = performance.now() - w0;
loop.disable(); if (pushTimer) clearInterval(pushTimer);
const heap1 = process.memoryUsage().heapUsed;

let frames: Frame[] = own, origin = originPerf;
if (where === 'receiver') {
  client!.stop(); recorder!.kill('SIGTERM'); await new Promise((r) => recorder!.once('exit', r));
  frames = JSON.parse(readFileSync(outFile, 'utf8')).frames as { t: number; ch: number[] }[];
  rmSync(outFile, { force: true });
  origin = performance.timeOrigin + originPerf;
}
const engineStats = rig.engine.stats;
rig.close();
const handed = where === 'receiver' ? [...own] : [];
if (where === 'receiver') own.length = 0;

// What the frames show: the head of the chase, or the brightness of lens 1 for the kick.
const REDS = [6, 10, 14, 18, 22, 26, 30, 34];
const head = (f: Frame) => { let h = 0; for (const i of REDS) if (f.ch[i]! > f.ch[REDS[h]!]!) h = REDS.indexOf(i); return h; };
const lateOf = (ta: number) => { const m = ((ta - origin) % beatMs + beatMs) % beatMs; return m > beatMs / 2 ? m - beatMs : m; };  // signed: negative is early
const late: number[] = [], peaks: number[] = [], outliers: number[] = [];
for (let i = 1; i < frames.length; i++) {
  const a = frames[i - 1]!, b = frames[i]!;
  if (effect === 'chase') { if (head(b) !== head(a)) late.push(lateOf(b.t)); }
  else if (b.ch[6]! > a.ch[6]! + 30) { late.push(lateOf(b.t)); peaks.push(b.ch[6]!); if (Math.abs(lateOf(b.t)) > 10) outliers.push(b.t); }
}
if (where === 'receiver' && effect !== 'chase') {
  // The controller hands over a frame every 25 ms and the client sends the newest every 25 ms, so a
  // frame can be replaced before it is sent. Match each received frame to the last frame handed over
  // before it with the same content, and read the delay from there.
  const delays: number[] = []; let j = 0;
  for (const r of frames) {
    while (j + 1 < handed.length && handed[j + 1]!.t <= r.t && handed[j + 1]!.ch.join() === r.ch.join()) j++;
    let k = j; while (k > 0 && handed[k]!.ch.join() !== r.ch.join()) k--;
    if (handed[k]!.ch.join() === r.ch.join() && r.t >= handed[k]!.t) delays.push(r.t - handed[k]!.t);
  }
  console.log(`\n-- from the controller handing a frame over to the bridge having it (n=${delays.length}) --`);
  show('delay in the client and the socket', delays);
}
// Around each flash that came late: what the controller handed over and what arrived, in ms from the flash that came.
if (where === 'receiver') for (const at of outliers) {
  const near = (list: Frame[]) => list.filter((f) => Math.abs(f.t - at) < 130).map((f) => `${(f.t - at).toFixed(0)}:${f.ch[6]}`).join('  ');
  console.log(`\n-- a flash ${lateOf(at).toFixed(0)} ms late, at ${((at - origin) / beatMs).toFixed(2)} beats --`);
  console.log(`  handed over  ${near(handed)}`);
  console.log(`  received     ${near(frames)}`);
}
console.log(`\n== ${where}, effect ${effect}, ${bpm} bpm, ${seconds} s${audio ? ', with the microphone feed analysed' : ''}${laser ? ', laser effect running' : ''} ==`);
const iv = intervalStats(frames.slice(40));
console.log(`  frames ${iv.frames}  (${iv.perSecond.toFixed(1)} per second)   identical to the one before: ${(identicalShare(frames) * 100).toFixed(0)}%`);
console.log(`  frame interval   mean ${iv.mean.toFixed(1)}  sd ${iv.sd.toFixed(1)}  p50 ${iv.p50.toFixed(1)}  p95 ${iv.p95.toFixed(1)}  p99 ${iv.p99.toFixed(1)}  min ${iv.min.toFixed(1)}  max ${iv.max.toFixed(1)} ms;  >40 ms: ${(iv.over40 * 100).toFixed(1)}%  <10 ms: ${(iv.under10 * 100).toFixed(1)}%`);
if (late.length) show(`change shows up after the beat (n=${late.length})`, late);
if (peaks.length) { show('flash level at first frame (255=full)', peaks, ''); console.log(`  flashes under 90% of full: ${(peaks.filter((p) => p < 230).length / peaks.length * 100).toFixed(0)}%`); }
console.log(`  engine: ${engineStats.ticks} ticks, ${engineStats.skipped} skipped, timers late mean ${engineStats.late.mean.toFixed(2)} max ${engineStats.late.max.toFixed(2)} ms`);
console.log(`  event loop delay  p50 ${(loop.percentile(50) / 1e6).toFixed(2)}  p99 ${(loop.percentile(99) / 1e6).toFixed(2)}  max ${(loop.max / 1e6).toFixed(2)} ms`);
console.log(`  cpu ${((cpu.user + cpu.system) / 1000 / wallMs * 100).toFixed(1)}% of a core   gc ${gcCount} runs, ${gcMs.toFixed(1)} ms in total, the longest ${gcMax.toFixed(1)} ms   heap ${((heap1 - heap0) / 1e6).toFixed(1)} MB change`);
process.exit(0);
