// How many frames are the same as the one before, per effect and per frame rate (deterministic: a fake clock, no timers).
import { SPIDER_43CH, SPIDER_LAYOUT } from '../../src/fixtures/spider.js';
import { SpiderController } from '../../src/server/spiderController.js';
import { Tempo } from '../../src/server/tempo.js';
import { EFFECTS } from '../../src/engine/effects.js';
import { FIXTURE_KINDS } from '../../src/server/kinds.js';
const red = { red: 1, green: 0.4, blue: 0, white: 0 }, blue = { red: 0, green: 0.2, blue: 1, white: 0 };
const bpm = 126;
function run(make: (tempo: Tempo, out: any) => any, setup: (c: any) => void, stepMs: number, seconds = 120) {
  let clock = 1000; const tempo = new Tempo({ now: () => clock }); tempo.update({ bpm, sync: true });
  const frames: Uint8Array[] = []; const out = { setUniverse: (_: number, d: Uint8Array) => { frames.push(d.slice()); } };
  const c = make(tempo, out); setup(c); frames.length = 0;
  const n = Math.round(seconds * 1000 / stepMs);
  for (let i = 0; i < n; i++) { clock += stepMs; c.tick(); }
  c.close();
  let same = 0, changed = 0;
  for (let i = 1; i < frames.length; i++) { let d = 0; for (let k = 0; k < 512; k++) if (frames[i]![k] !== frames[i - 1]![k]) d++; if (d === 0) same++; else changed += d; }
  const sent = frames.length - 1 - same;
  return { same: same / (frames.length - 1), perSec: sent / seconds, avgChanged: sent ? changed / sent : 0 };
}
const spider = (tempo: Tempo, out: any) => new SpiderController({ profile: SPIDER_43CH, layout: SPIDER_LAYOUT, output: out, tempo, universe: 0, address: 1 }) as any;
console.log('SPIDER, 126 bpm, speed x1.   "sent" = frames that differ from the one before; channels changed per such frame');
console.log('effect       @40 fps: identical  sent/s    @25 fps: identical  sent/s    @10 fps: sent/s   channels changed/frame (@25)');
for (const e of EFFECTS) {
  const set = (c: any) => c.update({ levels: { dimmer: 1 }, effect: { id: e.id, speed: 1, colourA: red, colourB: blue } });
  const a = run(spider, set, 25), b = run(spider, set, 40), d = run(spider, set, 100);
  console.log(`${e.id.padEnd(10)}  ${(a.same * 100).toFixed(0).padStart(10)}%  ${a.perSec.toFixed(1).padStart(6)}      ${(b.same * 100).toFixed(0).padStart(10)}%  ${b.perSec.toFixed(1).padStart(6)}         ${d.perSec.toFixed(1).padStart(6)}            ${b.avgChanged.toFixed(1)}`);
}
// the laser
const laserKind = FIXTURE_KINDS.laser!;
const laser = (tempo: Tempo, out: any) => laserKind.create({ output: out, tempo, universe: 0, address: 44 }) as any;
const ids = (laser(new Tempo(), { setUniverse() {} }) as any).describe().effects.map((e: any) => e.id);
console.log('\nLASER, manual mode');
for (const id of ids) {
  const set = (c: any) => c.update({ raw: { mode: 95 }, effect: { id, speed: 1 } });
  const a = run(laser, set, 25), b = run(laser, set, 40), d = run(laser, set, 100);
  console.log(`${String(id).padEnd(10)}  ${(a.same * 100).toFixed(0).padStart(10)}%  ${a.perSec.toFixed(1).padStart(6)}      ${(b.same * 100).toFixed(0).padStart(10)}%  ${b.perSec.toFixed(1).padStart(6)}         ${d.perSec.toFixed(1).padStart(6)}            ${b.avgChanged.toFixed(1)}`);
}
