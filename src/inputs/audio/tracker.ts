/**
 * From onset strength to what is heard: silence, music without a beat, or music with one,
 * and the tempo and the place of the beat. Pure: no clock, no timers, only the frames it is
 * given, so it is tested on made-up sound.
 *
 * How it decides, in order:
 *
 * 1. Tempo. Every half second a bank of combs is held against the last eight seconds of
 *    onset strength: for every tempo in range, and every place of the first beat, the
 *    mean strength where the beats would fall. The best comb gives the tempo and the place
 *    of the beat. What falls halfway between the beats is not held against a comb: dense
 *    techno has its bass there, and a comb at one and a half beats then beats the real one.
 *    How far the best comb stands out from all the combs tried, in standard deviations,
 *    says whether it is a tempo at all. A tempo that differs from the held one replaces it
 *    only when it has been the same for `lockAfter` beats and the held one has lost its
 *    support.
 * 2. Phase. The held tempo is looked for again every half second, and the held beat moves
 *    gently towards what is found (a phase-locked loop at two updates a second).
 * 3. Beat or not. With the comb of the held tempo standing out there is a beat. It is lost
 *    only after `beatLostAfter` beats of it not standing out, so one missed kick does not
 *    end it. Without a beat the tempo and the place of the beat keep running as they were.
 *    This is not judged by whether an onset stands out at each beat: in dense music no
 *    single beat does, and only the sum over many beats does.
 * 4. Silence is judged against the music itself: quiet is `silenceDrop` dB under the loud
 *    level of the last minute, or under `silenceFloor`. A quiet passage is not a stop.
 */

import { type FeatureFrame, FRAMES_PER_SECOND } from './features.js';
import type { Heard, Hearing } from './hearing.js';
import type { AudioSettings } from './settings.js';

const FPS = FRAMES_PER_SECOND;
/** Onset strength kept, in frames. */
const KEPT = 1000;
/** The stretch of strength a tempo is looked for in, and the least that is needed for it. */
const WINDOW = 800;
const MIN_WINDOW = 300;
const ESTIMATE_EVERY = 50;
const HEAR_EVERY = 10;
/** The time it takes the average of a band to follow, in frames. */
const MEAN_FRAMES = 400;
/** What the mean of a band is raised by, so that a stillness is not made into a roar. */
const MEAN_FLOOR = 0.02;
const HIGH_WEIGHT = 0.5;
/** Seconds from a beat to where its onset shows in the frames. */
const ONSET_LAG = 0.011;
/**
 * How far the best of all combs has to stand out, in standard deviations, to be taken up
 * as the tempo. The best comb in made-up noise or melody gets 4 to 10, dense techno 6 to 12,
 * a kick pattern 10 to 20; so this is a high bar, and a tempo must also hold for a number
 * of beats before it counts.
 */
const TAKE_UP = 7.5;
/**
 * How far the comb of a tempo that is held has to stand out for it to be a beat. This is
 * the comb of one tempo, not the best of all of them, and so an easier bar.
 */
const STAND_OUT = 5.5;
/** A held tempo that stands out less than this is not heard any more. */
const FADED = 4.5;
/** The z-score at which confidence is 0, and the span up to where it is 1. */
const CONFIDENCE_FROM = 3;
const CONFIDENCE_SPAN = 5;
/** Tempos this close, as a ratio, are the same tempo. */
const SAME_TEMPO = 0.02;
/** The held tempo is kept while its comb scores at least this share of the best one. */
const SUPPORT = 0.6;
const BLEND_PERIOD = 0.25;
const BLEND_PHASE = 0.3;
const COMB_STEP = 0.5;
const FINE_STEP = 0.1;
const FINE_REACH = 1;
/** The stretch, in frames, that the place of the beat is taken from: what it does now, not on average. */
const RECENT = 300;
const LEVELS_KEPT = 600;
const WAKE_FRAMES = 50;
/** Sound that comes in bursts, like a kick, counts as there for this many frames after each burst. */
const HOLD_FRAMES = 30;
const FLOOR_DB = -120;

interface Held {
  /** Seconds between beats. */
  period: number;
  /** Seconds on the clock of the feed at which a beat fell. */
  ref: number;
}

/** A comb and how well it fits: where its beats fall and how far it stands out. */
interface Fit {
  bpm: number;
  /** Seconds on the clock of the feed at which a beat fell. */
  ref: number;
  /** Standard deviations above the mean of all the combs tried. */
  z: number;
  /** The score of the comb, before any liking of tempos. */
  raw: number;
}

interface Found {
  best: Fit;
  /** The held tempo looked for again, when there is one. */
  held: Fit | undefined;
}

interface Challenger {
  bpm: number;
  /** The frame at which this tempo first came up. */
  since: number;
}

export class Tracker {
  private settings: AudioSettings;

  /** The onset strength per frame, at the number of the frame modulo `KEPT`. */
  private readonly strength = new Float64Array(KEPT);
  private lastFrame = 0;
  /** The first frame that counts: earlier ones are from before a silence. */
  private signalFrom = 1;
  private meanLow = 0;
  private meanHigh = 0;
  private meanFrames = 0;

  private held: Held | undefined;
  private challenger: Challenger | undefined;
  private beating = false;
  private lowSince: number | undefined;
  /** How far the held tempo stood out the last time it was looked for. */
  private heldZ = 0;

  private lastLevel = FLOOR_DB;
  private levels: number[] = [];
  private loud: number | undefined;
  private quietRun = 0;
  private silent = false;
  private recent: number[] = [];
  private hold: number[] = [];
  private silenceLevel = FLOOR_DB;
  private wakeRun = 0;

  constructor(settings: AudioSettings) {
    this.settings = settings;
  }

  setSettings(settings: AudioSettings): void {
    this.settings = settings;
  }

  reset(): void {
    this.strength.fill(0);
    this.lastFrame = 0;
    this.signalFrom = 1;
    this.meanLow = 0;
    this.meanHigh = 0;
    this.meanFrames = 0;
    this.held = undefined;
    this.challenger = undefined;
    this.beating = false;
    this.lowSince = undefined;
    this.heldZ = 0;
    this.lastLevel = FLOOR_DB;
    this.levels = [];
    this.loud = undefined;
    this.quietRun = 0;
    this.silent = false;
    this.recent = [];
    this.hold = [];
    this.silenceLevel = FLOOR_DB;
    this.wakeRun = 0;
  }

  /** What the frames add up to, about every 100 ms of sound. */
  push(frames: readonly FeatureFrame[]): Hearing[] {
    const out: Hearing[] = [];
    for (const frame of frames) {
      const n = Math.round(frame.at * FPS);
      if (this.lastFrame !== 0 && n !== this.lastFrame + 1) {
        // Frames that do not follow on are not one stretch of sound: start over.
        const settings = this.settings;
        this.reset();
        this.settings = settings;
      }
      this.add(n, frame);
      if (n % HEAR_EVERY === 0) out.push(this.hear(n));
    }
    return out;
  }

  // ---- taking in a frame ----

  private add(n: number, frame: FeatureFrame): void {
    if (this.lastFrame === 0) this.signalFrom = n;
    this.lastFrame = n;
    this.lastLevel = frame.level;

    this.meanFrames++;
    const alpha = Math.max(1 / this.meanFrames, 1 / MEAN_FRAMES);
    this.meanLow += (frame.low - this.meanLow) * alpha;
    this.meanHigh += (frame.high - this.meanHigh) * alpha;
    this.strength[n % KEPT] =
      frame.low / (this.meanLow + MEAN_FLOOR) +
      (HIGH_WEIGHT * frame.high) / (this.meanHigh + MEAN_FLOOR);

    this.listen(n, frame.level);
    if (n % ESTIMATE_EVERY === 0 && !this.silent) this.update(n);
  }

  /** Silence: has the music stopped, or has it started again. */
  private listen(n: number, level: number): void {
    const { silenceAfter, silenceDrop, silenceFloor, wakeRise } = this.settings;
    if (!this.silent) {
      const quiet =
        level < silenceFloor || (this.loud !== undefined && level < this.loud - silenceDrop);
      this.quietRun = quiet ? this.quietRun + 1 : 0;
      this.pushRecent(level);
      if (n % HEAR_EVERY === 0) {
        this.levels.push(level);
        if (this.levels.length > LEVELS_KEPT) this.levels.shift();
        this.loud = this.levels.length >= 5 ? percentile(this.levels, 0.9) : undefined;
      }
      if (this.quietRun >= Math.ceil(silenceAfter * FPS)) {
        this.silent = true;
        this.beating = false;
        this.lowSince = undefined;
        this.challenger = undefined;
        this.heldZ = 0;
        this.wakeRun = 0;
        this.hold = [];
        // What it was like before the sound came back is the level the rise is judged from.
        this.silenceLevel = mean(this.recent.slice(-Math.min(this.quietRun, FPS)));
      }
      return;
    }

    // The loudest of the last moments, so that a kick and then quiet is still sound.
    this.hold.push(level);
    if (this.hold.length > HOLD_FRAMES) this.hold.shift();
    const loudest = Math.max(...this.hold);
    const awake = loudest > silenceFloor && loudest > this.silenceLevel + wakeRise;
    this.wakeRun = awake ? this.wakeRun + 1 : 0;
    if (!awake) {
      // A room that gets quieter lowers the level the rise is judged from, never raises it.
      this.pushRecent(level);
      this.silenceLevel = Math.min(this.silenceLevel, mean(this.recent));
    }
    if (this.wakeRun >= WAKE_FRAMES) {
      this.silent = false;
      this.levels = [];
      this.loud = undefined;
      this.quietRun = 0;
      this.wakeRun = 0;
      this.recent = [];
      this.hold = [];
      this.signalFrom = n - WAKE_FRAMES + 1;
    }
  }

  private pushRecent(level: number): void {
    this.recent.push(level);
    if (this.recent.length > FPS) this.recent.shift();
  }

  // ---- the tempo ----

  private update(n: number): void {
    const found = this.find(n);
    if (!found) {
      this.challenger = undefined;
      return;
    }
    const { best, held: fit } = found;
    const held = this.held;

    // The tempo that is held: is it still there, and where does its beat fall now.
    if (held && fit) {
      this.heldZ = fit.z;
      if (fit.z >= STAND_OUT) {
        if (this.beating) {
          // Gently: the beat has been landing, and a small correction keeps it from jumping.
          held.period += (60 / fit.bpm - held.period) * BLEND_PERIOD;
          held.ref += wrap(fit.ref - held.ref, held.period) * BLEND_PHASE;
        } else {
          this.held = { period: 60 / fit.bpm, ref: fit.ref };
          this.beating = true;
        }
        this.lowSince = undefined;
        this.challenger = undefined;
      } else if (this.beating && fit.z < FADED) {
        const now = n / FPS;
        this.lowSince ??= now;
        if (now - this.lowSince >= this.settings.beatLostAfter * held.period) {
          this.beating = false;
          this.lowSince = undefined;
        }
      }
      // Between the two nothing changes, so a beat that has started to go is not saved by chance.
    }

    // A tempo that is not the held one has to stand out, and hold for a number of beats.
    if (best.z < TAKE_UP) {
      this.challenger = undefined;
      return;
    }
    const heldBpm = this.held ? 60 / this.held.period : undefined;
    if (heldBpm !== undefined && Math.abs(best.bpm / heldBpm - 1) < SAME_TEMPO) {
      this.challenger = undefined;
      return;
    }
    // A pattern of 3 against 4 is not a new tempo: the held one must have lost its support.
    if (this.held && fit && fit.raw >= SUPPORT * best.raw) {
      this.challenger = undefined;
      return;
    }

    const { lockAfter } = this.settings;
    const beatsNeeded = this.held ? lockAfter : Math.ceil(lockAfter / 2);
    const challenger = this.challenger;
    if (!challenger || Math.abs(best.bpm / challenger.bpm - 1) >= SAME_TEMPO) {
      this.challenger = { bpm: best.bpm, since: n };
      return;
    }
    challenger.bpm = best.bpm;
    const beats = ((n - challenger.since) / FPS) * (best.bpm / 60);
    if (beats >= beatsNeeded) {
      this.held = { period: 60 / best.bpm, ref: best.ref };
      this.heldZ = best.z;
      this.beating = true;
      this.lowSince = undefined;
      this.challenger = undefined;
    }
  }

  /** The best comb over the last stretch of strength, or nothing when there is too little of it. */
  private find(n: number): Found | undefined {
    const first = Math.max(this.signalFrom, n - KEPT + 1, n - WINDOW + 1);
    const size = n - first + 1;
    if (size < MIN_WINDOW) return undefined;
    const raw = new Float64Array(size);
    for (let i = 0; i < size; i++) raw[i] = this.strength[(first + i) % KEPT] as number;
    const v = prepare(raw);

    const { bpmMin, bpmMax } = this.settings;
    const heldBpm = this.held ? 60 / this.held.period : undefined;

    // Every comb: the best of them, and how the rest of them are spread.
    let coarse = { score: -Infinity, raw: 0, bpm: 0, phase: 0 };
    let count = 0;
    let sum = 0;
    let squares = 0;
    for (let bpm = bpmMin; bpm <= bpmMax; bpm += COMB_STEP) {
      const period = (60 * FPS) / bpm;
      const weight = prior(bpm, heldBpm);
      for (let phase = 0; phase < period; phase++) {
        const comb = combScore(v, size, period, phase);
        if (comb === undefined) continue;
        count++;
        sum += comb;
        squares += comb * comb;
        const score = Math.max(0, comb) * weight;
        if (score > coarse.score) coarse = { score, raw: comb, bpm, phase };
      }
    }
    if (count === 0 || coarse.score <= 0) return undefined;
    const centre = sum / count;
    const spread = Math.sqrt(Math.max(1e-12, squares / count - centre * centre));

    // Closer: a finer tempo and a place of the beat between frames.
    let fine = coarse;
    for (
      let bpm = coarse.bpm - FINE_REACH;
      bpm <= coarse.bpm + FINE_REACH + 1e-9;
      bpm += FINE_STEP
    ) {
      if (bpm < bpmMin || bpm > bpmMax) continue;
      const period = (60 * FPS) / bpm;
      const weight = prior(bpm, heldBpm);
      for (let step = -6; step <= 6; step++) {
        const phase = wrapPhase(coarse.phase + step * 0.25, period);
        const comb = combScore(v, size, period, phase);
        if (comb === undefined) continue;
        const score = Math.max(0, comb) * weight;
        if (score > fine.score) fine = { score, raw: comb, bpm, phase };
      }
    }
    const best = toFit(v, size, first, fine, centre, spread);

    // The held tempo looked for again, on its own, wherever it stands among the rest.
    let held: Fit | undefined;
    if (heldBpm !== undefined) {
      let near = { raw: -Infinity, bpm: heldBpm, phase: 0 };
      for (let bpm = heldBpm - 0.5; bpm <= heldBpm + 0.5 + 1e-9; bpm += FINE_STEP) {
        const period = (60 * FPS) / bpm;
        for (let phase = 0; phase < period; phase += 0.5) {
          const comb = combScore(v, size, period, phase);
          if (comb !== undefined && comb > near.raw) near = { raw: comb, bpm, phase };
        }
      }
      if (near.raw > -Infinity) held = toFit(v, size, first, near, centre, spread);
    }
    return { best, held };
  }

  // ---- what is heard ----

  private hear(n: number): Hearing {
    const at = n / FPS;
    const held = this.held;
    const bpm = held ? 60 / held.period : undefined;
    const level = this.lastLevel;

    if (this.silent) {
      return { at, heard: 'silent', bpm, confidence: 0, beatAt: undefined, level };
    }
    if (!held) {
      return { at, heard: 'music', bpm, confidence: 0, beatAt: undefined, level };
    }
    const heard: Heard = this.beating ? 'beat' : 'music';
    const confidence = Math.max(0, Math.min(1, (this.heldZ - CONFIDENCE_FROM) / CONFIDENCE_SPAN));
    const beatAt = this.beating
      ? held.ref + Math.floor((at - held.ref) / held.period) * held.period
      : undefined;
    return { at, heard, bpm, confidence, beatAt, level };
  }
}

/** Turns a comb into where the last beat of the stretch fell, with how far the comb stands out. */
function toFit(
  v: Float64Array,
  size: number,
  first: number,
  comb: { raw: number; bpm: number; phase: number },
  centre: number,
  spread: number,
): Fit {
  const period = (60 * FPS) / comb.bpm;
  let lastBeat = comb.phase + Math.floor((size - 1 - comb.phase) / period) * period;
  lastBeat += recentShift(v, size, period, lastBeat);
  return {
    bpm: comb.bpm,
    ref: (first + lastBeat) / FPS - ONSET_LAG,
    z: (comb.raw - centre) / spread,
    raw: comb.raw,
  };
}

/** Smooths the strength a little and takes away what is there all the time. */
function prepare(raw: Float64Array): Float64Array {
  const size = raw.length;
  const v = new Float64Array(size);
  const trail = new Float64Array(size + 1);
  let running = 0;
  for (let i = 0; i < size; i++) {
    const before = raw[Math.max(0, i - 1)] as number;
    const after = raw[Math.min(size - 1, i + 1)] as number;
    v[i] = (before + 2 * (raw[i] as number) + after) / 4;
    running += v[i] as number;
    trail[i + 1] = running;
  }
  for (let i = 0; i < size; i++) {
    const from = Math.max(0, i - 49);
    const average = ((trail[i + 1] as number) - (trail[from] as number)) / (i + 1 - from);
    v[i] = Math.max(0, (v[i] as number) - average);
  }
  return v;
}

/**
 * The mean strength at the beats of a comb, which lie at `phase`, `phase + period`, and
 * so on, in frames from the first.
 */
function combScore(
  v: Float64Array,
  size: number,
  period: number,
  phase: number,
): number | undefined {
  const last = size - 1.0001;
  let on = 0;
  let count = 0;
  for (let x = phase; x <= last; x += period) {
    on += sample(v, x);
    count++;
  }
  return count < 3 ? undefined : on / count;
}

/**
 * How far the last beat has to move, in frames, to sit on what the last stretch of
 * strength does. A tempo that moves leaves the beat found over the whole stretch early or
 * late; the beats of the last moments are where the next beat will be.
 */
function recentShift(v: Float64Array, size: number, period: number, lastBeat: number): number {
  const last = size - 1.0001;
  let best = 0;
  let bestScore = -Infinity;
  for (let step = -20; step <= 20; step++) {
    const shift = step * 0.25;
    let on = 0;
    let count = 0;
    for (let x = lastBeat + shift; x >= size - RECENT; x -= period) {
      if (x < 0 || x > last) continue;
      on += sample(v, x);
      count++;
    }
    if (count < 2) continue;
    const score = on / count - 0.002 * Math.abs(shift);
    if (score > bestScore) {
      bestScore = score;
      best = shift;
    }
  }
  return best;
}

function sample(v: Float64Array, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  return (v[i] as number) * (1 - f) + (v[i + 1] as number) * f;
}

/**
 * How much a tempo is liked before it is heard: house and techno sit around 125, and a
 * tempo near the one that is held is liked more, which keeps 126 from becoming 63 or 252.
 */
function prior(bpm: number, held: number | undefined): number {
  const general = 0.6 + 0.4 * Math.exp(-0.5 * (Math.log2(bpm / 125) / 0.7) ** 2);
  const near = held ? 1 + 0.2 * Math.exp(-0.5 * (Math.log2(bpm / held) / 0.05) ** 2) : 1;
  return general * near;
}

/** `value` moved by whole periods to lie between minus half a period and half a period. */
function wrap(value: number, period: number): number {
  return value - Math.round(value / period) * period;
}

/** A phase moved by a period to lie from 0 up to the period. */
function wrapPhase(phase: number, period: number): number {
  if (phase < 0) return phase + period;
  if (phase >= period) return phase - period;
  return phase;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return FLOOR_DB;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function percentile(values: readonly number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] as number;
}
