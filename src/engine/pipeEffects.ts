/**
 * The effects of the pipes (Jeroen, 2026-10-31): three strips of WLED in white dryer hoses, for an
 * industrial look, rendered by lightdeck itself and sent over DDP (`outputs/wled/ddp.ts`) instead of
 * choosing one of WLED's own effects through Home Assistant.
 *
 * An effect is a pure function from the beat to the colour of every LED of a pipe, like the effects
 * of the spider: the same beat gives the same picture, and nothing here keeps a state or a timer.
 * That is what lets the three pipes show the same moment, lets a pipe join in the middle of a bar and
 * lets an effect be tested frame by frame. The beat comes from the tempo of the console (by hand or
 * from rekordbox), so the pipes move with the music at any bpm.
 *
 * An effect colours the LEDs with the colours of a palette of the show (Jeroen, 2026-10-31: the colours of
 * the theme must work on the pipes too): slot 1 is the foreground, slot 2 the background, slot 3 an
 * accent and slot 4 a spare; a palette with fewer colours gets the rest made from the first. It moves at
 * a pace that is one of the speeds of the console, `SPEEDS`. Whoever renders
 * an effect passes the wanted pace through `limitSpeed`, as for the spider, so that nothing flashes
 * faster than the limit; none of these effects changes a pixel more than once per beat at pace 1.
 *
 * The picture is made as floats, 0 to 1 per channel; `toBytes` makes the bytes that a strip gets.
 */

import { limitSpeed } from './effects.js';

/** A colour of a pipe, each channel 0..1. */
export interface PipeColour {
  red: number;
  green: number;
  blue: number;
}

export interface PipeContext {
  /** The beat, counted from beat one of the bar: 0 is the downbeat, 4 the next. Fractions are in between. */
  beat: number;
  /** The tempo, for an effect that has to keep its flashes under the limit by itself. */
  bpm: number;
  /** How many LEDs the pipe has. */
  leds: number;
  /** Up to four colours of the look: foreground, background, accent, spare. At least one. */
  colours: readonly PipeColour[];
  /** The pace on top of the bpm, one of the speeds of the console. Already limited. */
  pace: number;
}

export interface PipeEffect {
  id: string;
  name: string;
  /** What the operator sees, in one sentence. */
  description: string;
  /** Fills `out` (leds x 3 floats) with the picture for this beat. */
  render(context: PipeContext, out: Float32Array): void;
}

const TAU = Math.PI * 2;
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const frac = (value: number): number => value - Math.floor(value);

const BLACK: PipeColour = { red: 0, green: 0, blue: 0 };

/** A colour made dimmer: `share` of it. */
const dim = (colour: PipeColour, share: number): PipeColour => mix(BLACK, colour, share);

/** The foreground: slot 1. */
const foreground = (context: PipeContext): PipeColour =>
  context.colours[0] ?? { red: 1, green: 1, blue: 1 };

/** The background: slot 2, or a dim shade of the foreground when the palette has no second colour. */
const background = (context: PipeContext): PipeColour =>
  context.colours[1] ?? dim(foreground(context), 0.16);

/** The accent: slot 3, or the foreground lifted towards white. */
const accent = (context: PipeContext): PipeColour =>
  context.colours[2] ?? mix(foreground(context), { red: 1, green: 1, blue: 1 }, 0.55);

/** Mixes two colours, `share` of the second. */
function mix(a: PipeColour, b: PipeColour, share: number): PipeColour {
  const t = clamp01(share);
  return {
    red: a.red + (b.red - a.red) * t,
    green: a.green + (b.green - a.green) * t,
    blue: a.blue + (b.blue - a.blue) * t,
  };
}

/** Adds two colours, each channel kept at 1. */
function add(a: PipeColour, b: PipeColour): PipeColour {
  return {
    red: Math.min(1, a.red + b.red),
    green: Math.min(1, a.green + b.green),
    blue: Math.min(1, a.blue + b.blue),
  };
}

function put(out: Float32Array, led: number, colour: PipeColour, level: number): void {
  const at = led * 3;
  out[at] = clamp01(colour.red * level);
  out[at + 1] = clamp01(colour.green * level);
  out[at + 2] = clamp01(colour.blue * level);
}

/** The place of an LED along the pipe, 0 at the start and 1 at the end. */
const place = (led: number, leds: number): number => (leds <= 1 ? 0 : led / (leds - 1));

/** A number from 0 to 1 that is the same every time for the same `n`: the dice of an effect, with no state. */
function dice(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

const smooth = (edge0: number, edge1: number, value: number): number => {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

// ---- the effects ----

/**
 * Slugs of liquid run through the pipe: the foreground colour in the background colour, thick in the
 * middle and thin at the edges, each of them its own length, brightness and speed, with the accent
 * colour at the front where the liquid is pushed. Between the slugs the pipe holds a dim, slowly
 * moving shade of the background, so it never looks empty. The slugs take about sixteen beats to cross
 * the pipe at pace 1 (Jeroen: at six it ran far too fast).
 */
const flow: PipeEffect = makeFlow(
  'flow',
  'Flow',
  'Slugs of liquid run through the pipe, thick and thin, foreground in background.',
  16,
);

/**
 * The same liquid, four times slower: a slow background flow that takes about a minute (sixty-four beats) to
 * cross the pipe at pace 1 (Jeroen, 2026-10-31: "a really slow flow, as a background").
 */
const slowflow: PipeEffect = makeFlow(
  'slowflow',
  'Slow flow',
  'The liquid again, four times slower: a slow flow for a background.',
  64,
);

/**
 * The liquid with a heartbeat (Jeroen, 2026-11-02: "the pipe in the background pulses along on the
 * beat"): the same slugs at the pace of `flow`, but the pipe under them swells on every beat and falls
 * back, and a little more on the first beat of a bar. The pulse follows the beat itself and not the pace,
 * so it stays on the beat and never changes more than once per beat, whatever the pace of the flow.
 */
const flowbeat: PipeEffect = makeFlow(
  'flowbeat',
  'Flow and pulse',
  'The liquid flows and the pipe behind it pulses on the beat.',
  16,
  true,
);

/**
 * The effect of slugs of liquid, which takes `beats` beats to cross the pipe at pace 1. With `beating`
 * the background liquid swells on the beat.
 */
function makeFlow(
  id: string,
  name: string,
  description: string,
  beats: number,
  beating = false,
): PipeEffect {
  return {
    id,
    name,
    description,
    render(context, out) {
      const fore = foreground(context);
      const back = background(context);
      const front = accent(context);
      const slugs = 6;
      const time = (context.beat * context.pace) / beats;
      // The beat of the background: a hit that falls back, a bit more on the first beat of a bar.
      const inBar = ((context.beat % 4) + 4) % 4;
      const thump = beating ? Math.exp(-3.2 * frac(context.beat)) * (inBar < 1 ? 1 : 0.7) : 0;
      for (let i = 0; i < context.leds; i++) {
        const x = place(i, context.leds);
        // The background liquid: a slow shimmer between 18 and 38 percent, which swells on the beat.
        const shimmer =
          0.28 +
          0.1 * Math.sin(TAU * (3.1 * x - 3 * time + 0.2)) -
          (beating ? 0.1 : 0) +
          0.5 * thump;
        let body = 0;
        let head = 0;
        for (let k = 0; k < slugs; k++) {
          const length = 0.09 + 0.15 * dice(k * 4 + 1);
          const strength = 0.55 + 0.45 * dice(k * 4 + 2);
          const speed = 0.75 + 0.5 * dice(k * 4 + 3);
          // The centre runs from before the start to after the end, so a slug enters and leaves whole.
          const centre = -length + frac(dice(k * 4 + 4) + time * speed) * (1 + 2 * length);
          const d = (x - centre) / (length / 2);
          const weight = strength * Math.exp(-d * d * 1.6);
          body = Math.max(body, weight);
          // The front half of a slug, where it pushes ahead.
          if (d > 0) head = Math.max(head, weight * smooth(0.1, 1.1, d));
        }
        const liquid = mix(fore, front, head * 0.9);
        // The pipe behind the slugs takes some of the foreground on a hit, so it pulses in colour as well.
        const ground = beating ? mix(back, fore, thump * 0.45) : back;
        put(out, i, mix(ground, liquid, body), Math.max(shimmer, 0.2 + 0.8 * body));
      }
    },
  };
}

/**
 * The pipe fills up and runs empty again (Jeroen, 2026-11-02): the liquid rises from the start of the
 * pipe to the end, the pipe stands full for a moment, and then it drains away, the tail leaving at the
 * start so the liquid runs out through the far end. Sixteen beats a round at pace 1: six and a half to
 * fill, one and a half full, six and a half to drain, one empty. The front is a bright edge in the
 * accent colour, the liquid shimmers a little, and the empty pipe holds the dim background.
 */
const fill: PipeEffect = {
  id: 'fill',
  name: 'Fill',
  description: 'The pipe fills up with liquid and runs empty again.',
  render(context, out) {
    const fore = foreground(context);
    const back = background(context);
    const front = accent(context);
    const round = frac((context.beat * context.pace) / 16);
    const ease = (t: number) => t * t * (3 - 2 * t);
    const soft = 0.04;
    // The edges run from before the start to after the end, so the pipe is whole when full and bare when empty.
    const span = (e: number) => -soft + e * (1 + 2 * soft);
    const head = round < 0.4 ? span(ease(round / 0.4)) : span(1);
    const tail = round < 0.5 ? span(0) : round < 0.9 ? span(ease((round - 0.5) / 0.4)) : span(1);
    const time = (context.beat * context.pace) / 16;
    for (let i = 0; i < context.leds; i++) {
      const x = place(i, context.leds);
      const inside = smooth(head + soft, head - soft, x) * smooth(tail - soft, tail + soft, x);
      // The liquid shimmers between 80 and 100 percent, and the edge that moves glows in the accent colour.
      const shimmer = 0.9 + 0.1 * Math.sin(TAU * (4 * x - 6 * time));
      const edge = Math.max(
        round < 0.4 ? Math.exp(-(((head - x) / 0.05) ** 2)) : 0,
        round >= 0.5 && round < 0.9 ? Math.exp(-(((x - tail) / 0.05) ** 2)) : 0,
      );
      const liquid = mix(fore, front, edge * 0.8);
      put(out, i, mix(back, liquid, inside), 0.14 + 0.86 * inside * shimmer);
    }
  },
};

/**
 * A few pixels of light shoot through the pipe on every beat (Jeroen, 2026-11-02: like `shot`, but not so
 * fast, and with no light on the other LEDs). The dot is about four pixels wide, leaves the first LED on
 * the beat quickly and slows down, and reaches the last LED as the next beat leaves; everything else stays
 * black. At pace 1 that is one dot per beat, at pace ½ one every two beats.
 */
const beatshot: PipeEffect = {
  id: 'beatshot',
  name: 'Beat shot',
  description:
    'A few pixels of light shoot through the pipe on every beat, with no light around them.',
  render(context, out) {
    const colour = foreground(context);
    const period = 1 / context.pace;
    const phase = (((context.beat % period) + period) % period) / period;
    // Fast at the start and slower towards the end, so the dot is thrown by the beat.
    const position = (1 - (1 - phase) ** 2) * (context.leds - 1);
    const half = 2.5;
    for (let i = 0; i < context.leds; i++) {
      const distance = Math.abs(i - position);
      const level = distance < half ? 0.5 + 0.5 * Math.cos((Math.PI * distance) / half) : 0;
      put(out, i, colour, level);
    }
  },
};

/**
 * A colour that shoots through the pipe: a bright head with a tail runs from one end to the other, very
 * fast, once per bar at pace 1 and twice per bar at pace 2, always starting on the beat. Between shots the
 * pipe holds a dim glow of the third colour, so it never goes dark.
 */
const shot: PipeEffect = {
  id: 'shot',
  name: 'Shot',
  description: 'A colour shoots through the pipe, head and tail, on the beat.',
  render(context, out) {
    const head = foreground(context);
    const tail = background(context);
    const glow = context.colours[2] ?? tail;
    // One shot per `period` beats, and it crosses in a quarter of its period at most half a beat. The head
    // is at the first LED on the beat, and the pipe is empty again when the tail has left the last.
    const period = 4 / context.pace;
    const cross = Math.min(0.5, period / 4);
    const phase = ((context.beat % period) + period) % period;
    const tailLength = Math.max(2, context.leds * 0.28);
    const position = (phase / cross) * (context.leds + tailLength);
    const running = phase < cross;
    for (let i = 0; i < context.leds; i++) {
      let level = 0;
      let behind = 0;
      if (running) {
        behind = position - i;
        // Ahead of the head nothing, a short bright edge at the head, a tail that fades out behind it.
        level = behind < -1 ? 0 : behind < 0 ? 1 + behind : Math.exp((-behind * 3.2) / tailLength);
      }
      const base = mix(glow, tail, 0.2);
      const shown = mix(tail, head, Math.exp((-behind * 9) / tailLength));
      // The dim glow underneath is 8% of the colour, as under a light effect of the spider.
      put(out, i, level > 0.02 ? shown : base, level > 0.02 ? Math.max(level, 0.08) : 0.08);
    }
  },
};

/**
 * Bubbles rise through the liquid: small bright dots, each its own size, speed and place, that drift
 * along the pipe and fade where they go out, in the foreground colour with the accent colour as their
 * highlight, over the background liquid. The alchemist's brew.
 */
const bubbles: PipeEffect = {
  id: 'bubbles',
  name: 'Bubbles',
  description: 'Bubbles rise through the liquid, small bright dots drifting along the pipe.',
  render(context, out) {
    const fore = foreground(context);
    const back = background(context);
    const spark = accent(context);
    const count = 16;
    const time = (context.beat * context.pace) / 4;
    for (let i = 0; i < context.leds; i++) {
      const x = place(i, context.leds);
      const liquid = 0.2 + 0.08 * Math.sin(TAU * (2.4 * x - time * 0.8));
      let level = 0;
      let glint = 0;
      for (let k = 0; k < count; k++) {
        const size = 0.006 + 0.014 * dice(k * 5 + 1);
        const speed = 0.12 + 0.2 * dice(k * 5 + 2);
        const wobble = 0.004 * Math.sin(TAU * (time * 1.5 * speed * 6 + dice(k * 5 + 3)));
        const centre = frac(dice(k * 5 + 4) + time * speed) + wobble;
        const d = (x - centre) / size;
        const weight = (0.5 + 0.5 * dice(k * 5 + 5)) * Math.exp(-d * d);
        level = Math.max(level, weight);
        glint = Math.max(glint, weight * smooth(0.6, 1, weight));
      }
      put(out, i, mix(mix(back, fore, level), spark, glint), Math.max(liquid, 0.15 + 0.85 * level));
    }
  },
};

/**
 * Transmutation: one colour turns into the other. A front runs through the pipe in eight beats and
 * what it has passed has changed, and then it runs back and changes it again; at the front itself the
 * accent colour glows, the reaction. Sixteen beats for the whole round trip at pace 1.
 */
const transmute: PipeEffect = {
  id: 'transmute',
  name: 'Transmute',
  description:
    'A glowing front runs through the pipe and turns one colour into the other, and back.',
  render(context, out) {
    const from = foreground(context);
    const into = background(context);
    const glow = accent(context);
    const round = frac((context.beat * context.pace) / 16);
    const forward = round < 0.5;
    const front = forward ? round * 2 : 1 - (round - 0.5) * 2;
    for (let i = 0; i < context.leds; i++) {
      const x = place(i, context.leds);
      // Which side of the front has changed: the start side, going out and coming back alike.
      const changed = x < front;
      const base = changed ? into : from;
      const near = Math.exp(-(((x - front) / 0.05) ** 2));
      const shimmer = 0.62 + 0.12 * Math.sin(TAU * (6 * x - (context.beat * context.pace) / 4));
      put(out, i, mix(base, glow, near), Math.max(shimmer, near));
    }
  },
};

/**
 * The shadow: the pipe is lit in the foreground colour and dark patches of shadow drift through it,
 * long and slow, with a faint trace of the background colour where the shadow lies. The opposite of the
 * liquid, for the dark part of the evening.
 */
const shadow: PipeEffect = {
  id: 'shadow',
  name: 'Shadow',
  description: 'The pipe is lit and long shadows drift through it.',
  render(context, out) {
    const lit = foreground(context);
    const trace = background(context);
    const patches = 4;
    const time = (context.beat * context.pace) / 10;
    for (let i = 0; i < context.leds; i++) {
      const x = place(i, context.leds);
      let dark = 0;
      for (let k = 0; k < patches; k++) {
        const length = 0.14 + 0.2 * dice(k * 3 + 1);
        const speed = 0.7 + 0.6 * dice(k * 3 + 2);
        const centre = -length + frac(dice(k * 3 + 3) + time * speed) * (1 + 2 * length);
        const d = (x - centre) / (length / 2);
        dark = Math.max(dark, Math.exp(-d * d * 1.2));
      }
      put(out, i, mix(lit, trace, dark), 0.85 - 0.7 * dark);
    }
  },
};

/**
 * The seal lights up: on beat one of every bar a ring runs out of the middle of the pipe to both ends,
 * as the circle of the alchemist's seal does, and the middle keeps a slow glow of the accent colour.
 */
const seal: PipeEffect = {
  id: 'seal',
  name: 'Seal',
  description: 'A ring runs from the middle of the pipe to both ends on every bar.',
  render(context, out) {
    const ring = foreground(context);
    const back = background(context);
    const centre = accent(context);
    const period = 4 / context.pace;
    const phase = (((context.beat % period) + period) % period) / Math.min(2, period / 2);
    const radius = phase;
    const breath = 0.5 + 0.5 * Math.sin(TAU * ((context.beat * context.pace) / 8));
    for (let i = 0; i < context.leds; i++) {
      const away = Math.abs(place(i, context.leds) - 0.5) * 2;
      const hit =
        phase < 1.4 ? Math.exp(-(((away - radius) / 0.07) ** 2)) * (1 - clamp01(phase / 1.4)) : 0;
      const trail =
        phase < 1.4 && away < radius
          ? 0.3 * (1 - clamp01(phase / 1.4)) * (1 - away / Math.max(radius, 0.01))
          : 0;
      const heart = Math.exp(-((away / 0.06) ** 2)) * (0.35 + 0.35 * breath);
      const colour = add(add(dim(ring, hit), dim(back, 0.25 + trail)), dim(centre, heart));
      put(out, i, colour, 1);
    }
  },
};

/**
 * Lightning, for the hard part of the evening: on some beats a bolt cuts through part of the pipe, a
 * bright jagged flash in the foreground colour that flickers once more a moment later and leaves a
 * short afterglow of the background colour. Which beats is dice, the same every time. It makes at most
 * two flashes per beat and keeps them 0.35 beat apart, and its own pace is held down at a fast tempo,
 * so that it never goes over the limit of ten changes per second.
 */
const lightning: PipeEffect = {
  id: 'lightning',
  name: 'Lightning',
  description: 'Bolts of lightning cut through the pipe on some of the beats.',
  render(context, out) {
    const bolt = foreground(context);
    const glow = background(context);
    const white = accent(context);
    // Two flashes a beat, ten changes a second at the most, so no more than five beats a second.
    const beatsPerSecond = Math.max(1e-6, context.bpm / 60);
    const pace = Math.min(context.pace, 5 / beatsPerSecond);
    const count = context.beat * pace;
    const n = Math.floor(count);
    const since = count - n;
    const struck = dice(n * 1.37 + 5) < 0.45;
    const from = 0.55 * dice(n + 11);
    const to = Math.min(1, from + 0.3 + 0.5 * dice(n + 17));
    const main = Math.exp(-since / 0.05);
    const echo = since > 0.35 ? 0.55 * Math.exp(-(since - 0.35) / 0.06) : 0;
    const after = 0.3 * Math.exp(-since / 0.5);
    for (let i = 0; i < context.leds; i++) {
      const x = place(i, context.leds);
      const inside = struck && x >= from && x <= to;
      const jag = 0.55 + 0.45 * dice(i * 7.3 + n * 131);
      const flash = inside ? Math.min(1, (main + echo) * jag) : 0;
      const colour = mix(bolt, white, flash * flash);
      const level = inside ? Math.max(flash, after * jag) : 0;
      put(out, i, mix(dim(glow, 0.5), colour, clamp01(level * 1.5)), Math.max(0.05, level));
    }
  },
};

/** The whole pipe breathes with the beat: a hit of the first colour on every beat that falls back to the second. */
const pulse: PipeEffect = {
  id: 'pulse',
  name: 'Pulse',
  description: 'The whole pipe hits on the beat and falls back.',
  render(context, out) {
    const hit = foreground(context);
    const rest = background(context);
    const level = Math.exp(-3.2 * frac(context.beat * context.pace));
    for (let i = 0; i < context.leds; i++) put(out, i, mix(rest, hit, level), 0.12 + 0.88 * level);
  },
};

/**
 * Bands of the colours run through the pipe, one band of each colour, and move on by one band length
 * every two beats. With three colours that is the multi colour effect.
 */
const chase: PipeEffect = {
  id: 'chase',
  name: 'Chase',
  description: 'Bands of the colours run through the pipe.',
  render(context, out) {
    const count = Math.max(1, Math.min(4, context.colours.length));
    const bands = count * 2;
    const drift = (context.beat * context.pace) / 2;
    const colour = (index: number) => context.colours[index % count] ?? foreground(context);
    for (let i = 0; i < context.leds; i++) {
      const x = place(i, context.leds) * bands - drift;
      const band = Math.floor(x);
      const inside = frac(x);
      const from = ((band % count) + count) % count;
      // A hard edge with a soft shoulder: the colours do not smear into each other.
      const share = clamp01((inside - 0.85) / 0.15);
      put(out, i, mix(colour(from), colour((from + 1) % count), share), 1);
    }
  },
};

/** The pipe in the foreground colour, as it is without an effect. */
const solid: PipeEffect = {
  id: 'solid',
  name: 'Solid',
  description: 'The pipe in the foreground colour.',
  render(context, out) {
    const colour = foreground(context);
    for (let i = 0; i < context.leds; i++) put(out, i, colour, 1);
  },
};

/** The effects of the pipes, in the order the page shows them. */
export const PIPE_EFFECTS: readonly PipeEffect[] = [
  solid,
  flow,
  slowflow,
  flowbeat,
  fill,
  beatshot,
  shot,
  bubbles,
  transmute,
  shadow,
  seal,
  lightning,
  pulse,
  chase,
];

export function findPipeEffect(id: string): PipeEffect | undefined {
  return PIPE_EFFECTS.find((effect) => effect.id === id);
}

/**
 * Renders an effect for a moment: `bpm` is the tempo, `wanted` the pace on top of it, and the pace is
 * limited as for every effect, so a pace that would flash faster than the limit is halved.
 */
export function renderPipe(
  effect: PipeEffect,
  beat: number,
  bpm: number,
  wanted: number,
  leds: number,
  colours: readonly PipeColour[],
  out: Float32Array,
): void {
  effect.render({ beat, bpm, leds, colours, pace: limitSpeed(bpm, wanted) }, out);
}

/** The bytes a strip gets for a picture: red, green and blue of every LED, scaled by `level` (0..1). */
export function toBytes(picture: Float32Array, level: number, into: Uint8Array): void {
  const scale = clamp01(level) * 255;
  for (let i = 0; i < picture.length; i++) into[i] = Math.round(clamp01(picture[i] ?? 0) * scale);
}

/**
 * The bytes of one strip out of a picture that is longer than it: the strips are put end to end as one long
 * pipe (Jeroen, 2026-11-01), and a strip is the `leds` LEDs from LED `offset` on. A strip that is mounted
 * the other way round (`reverse`) is given them back to front, so that the effect enters it at its far end.
 */
export function segmentBytes(
  picture: Float32Array,
  offset: number,
  leds: number,
  reverse: boolean,
  level: number,
  into: Uint8Array,
): void {
  const scale = clamp01(level) * 255;
  for (let i = 0; i < leds; i++) {
    const from = (offset + (reverse ? leds - 1 - i : i)) * 3;
    for (let c = 0; c < 3; c++) {
      into[i * 3 + c] = Math.round(clamp01(picture[from + c] ?? 0) * scale);
    }
  }
}

/**
 * The colours of a palette of the show as colours of the pipes: a slot that is off is black, and the white of
 * a colour is mixed into all three channels, as a strip without a white LED has to show it. Up to four.
 */
export function pipeColours(
  palette: readonly ({ red: number; green: number; blue: number; white: number } | null)[],
): PipeColour[] {
  return palette.slice(0, 4).map((colour) =>
    colour
      ? {
          red: Math.min(1, colour.red + colour.white),
          green: Math.min(1, colour.green + colour.white),
          blue: Math.min(1, colour.blue + colour.white),
        }
      : { ...BLACK },
  );
}
