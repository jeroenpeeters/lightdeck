// Statistics about when frames showed what the beat grid says they should.
export interface Frame { t: number; ch: number[] }   // t in ms on one clock; ch = channels firstChannel..
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN; };
const f1 = (n: number) => n.toFixed(1);
export function intervalStats(frames: Frame[]) {
  const d: number[] = [];
  for (let i = 1; i < frames.length; i++) d.push(frames[i]!.t - frames[i - 1]!.t);
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length);
  return { frames: frames.length, perSecond: 1000 / mean, mean, sd, p50: pct(d, .5), p95: pct(d, .95), p99: pct(d, .99), max: Math.max(...d), min: Math.min(...d),
    over40: d.filter((x) => x > 40).length / d.length, under10: d.filter((x) => x < 10).length / d.length };
}
export function identicalShare(frames: Frame[]) {
  let same = 0; for (let i = 1; i < frames.length; i++) if (frames[i]!.ch.join() === frames[i - 1]!.ch.join()) same++;
  return same / (frames.length - 1);
}
/** For every beat: when did the frame that shows that beat first appear, relative to the beat? And how bright is the peak of the beat? */
export function beatStats(frames: Frame[], origin: number, beatMs: number, level: (f: Frame) => number, beats: number, firstBeat = 4) {
  const late: number[] = [], peak: number[] = [];
  for (let k = firstBeat; k < beats; k++) {
    const t0 = origin + k * beatMs, t1 = t0 + beatMs;
    const inBeat = frames.filter((f) => f.t >= t0 && f.t < t1);
    if (inBeat.length === 0) continue;
    peak.push(Math.max(...inBeat.map(level)));
    late.push(inBeat[0]!.t - t0);
  }
  return { beats: late.length, late, peak };
}
export function show(label: string, xs: number[], unit = 'ms') {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  console.log(`  ${label.padEnd(34)} mean ${f1(mean).padStart(6)}  p50 ${f1(pct(xs, .5)).padStart(6)}  p95 ${f1(pct(xs, .95)).padStart(6)}  max ${f1(Math.max(...xs)).padStart(6)}  min ${f1(Math.min(...xs)).padStart(6)} ${unit}`);
}
