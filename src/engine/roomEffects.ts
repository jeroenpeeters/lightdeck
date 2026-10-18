/**
 * Scenery effects for the lamps of the room (Jeroen, 2026-10-18): static lighting that
 * changes now and then, to stand under the spider and the laser. Nothing heavy: about once a
 * minute (Jeroen, 2026-10-18: "once per minute a change of colours is fine").
 *
 * They are made like the light effects of the spider (`effects.ts`): a pure function from a
 * beat to how much of each slot of the palette every cell gets, and the cells are the lamps.
 * But a lamp takes one command per second at the most, so these are not rhythm. Every
 * `PERIOD_BEATS` beats, at speed 1, the colours move: that is the one change they make, and
 * it is far under one change per beat. The speed scales the period like it scales the beat
 * of the other effects, so ÷2 is 256 beats and ×2 is 64.
 *
 * Every lamp has exactly one slot, so the levels are one-hot and `paint` gives it that
 * slot's colour as it is. The palette decides what the slots are, and a lamp whose slot is
 * empty (off) is dark.
 *
 * An effect that is chosen when the lamps are idle (the music stopped) is not run: the
 * controller keeps the picture it last made.
 */

import type { Effect, EffectContext, EffectFrame } from './effects.js';
import { MAX_PALETTE_COLOURS } from './palette.js';

/**
 * How many beats the colours stay where they are at speed 1: 32 bars, a phrase, which is about
 * a minute at 126 bpm. The lamps are scenery and the mesh takes about 4 commands per second, so
 * a change of the whole room (every lamp a command) is something to do once in a while.
 */
export const PERIOD_BEATS = 128;

/** Which block of `PERIOD_BEATS` the beat is in. Beats before the first one are block 0. */
function blockOf(beat: number): number {
  return Math.max(0, Math.floor(beat / PERIOD_BEATS));
}

/** A small seeded random number generator (mulberry32), so the same block deals the same way. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One lamp per row, with its slot as the one level of 1. A slot that is -1 is dark. */
function oneHot(slots: number, slotOf: readonly number[]): EffectFrame {
  return {
    levels: slotOf.map((slot) => Array.from({ length: slots }, (_, i) => (i === slot ? 1 : 0))),
  };
}

/** A palette without slots: every lamp dark. */
const nothing = (cells: number): EffectFrame => ({
  levels: Array.from({ length: cells }, () => []),
});

const mod = (n: number, m: number) => ((n % m) + m) % m;

/** The colours spread over the lamps in order: lamp 1 slot 1, lamp 2 slot 2, and round again. */
function spread(lamps: number, slots: number): number[] {
  return Array.from({ length: lamps }, (_, lamp) => lamp % slots);
}

/** Which zone each lamp is in. A lamp in no zone is in one more zone after the last. */
function zonesOf(lamps: number, bars: EffectContext['bars']): number[] {
  return Array.from({ length: lamps }, (_, lamp) => {
    const zone = bars.findIndex((bar) => bar.includes(lamp));
    return zone === -1 ? bars.length : zone;
  });
}

/**
 * The colours dealt out in an order of block `block`: the same colours, shuffled by the block,
 * and turned so that the first lamp has the colour that comes next in the palette. That is
 * what makes every block differ from the one before without having to work out the one
 * before: the first lamp never has the same colour twice in a row.
 */
function dealt(lamps: number, slots: number, block: number): number[] {
  const order = spread(lamps, slots);
  const next = random(block * 7919 + 17);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j] as number, order[i] as number];
  }
  const colours = Math.min(lamps, slots);
  const first = order.indexOf(block % colours);
  return order.map((_, lamp) => order[mod(lamp + first, lamps)] as number);
}

const still: Effect = {
  id: 'still',
  name: 'Still',
  description:
    'The colours of the palette are spread over the lamps, the first lamp the first colour, the next lamp the next, and round again. Nothing moves.',
  slots: MAX_PALETTE_COLOURS,
  render({ cells, slots }) {
    return slots > 0 ? oneHot(slots, spread(cells, slots)) : nothing(cells);
  },
};

const rotate: Effect = {
  id: 'rotate',
  name: 'Rotate',
  description: `The colours are spread over the lamps, and every ${PERIOD_BEATS} beats each lamp takes the colour of the lamp next to it.`,
  slots: MAX_PALETTE_COLOURS,
  render({ beat, cells, slots }) {
    if (slots === 0) return nothing(cells);
    const step = blockOf(beat);
    return oneHot(
      slots,
      Array.from({ length: cells }, (_, lamp) => mod(lamp + step, slots)),
    );
  },
};

const shuffle: Effect = {
  id: 'shuffle',
  name: 'Shuffle',
  description: `The colours are spread over the lamps, and every ${PERIOD_BEATS} beats they are dealt out again in another order.`,
  slots: MAX_PALETTE_COLOURS,
  render({ beat, cells, slots }) {
    if (slots === 0) return nothing(cells);
    return oneHot(slots, dealt(cells, slots, blockOf(beat)));
  },
};

const zones: Effect = {
  id: 'zones',
  name: 'Zones',
  description: `Every zone of the room has one colour, and every ${PERIOD_BEATS} beats the zones take the next colour of the palette.`,
  slots: MAX_PALETTE_COLOURS,
  render({ beat, cells, bars, slots }) {
    if (slots === 0) return nothing(cells);
    const step = blockOf(beat);
    return oneHot(
      slots,
      zonesOf(cells, bars).map((zone) => mod(zone + step, slots)),
    );
  },
};

export const ROOM_EFFECTS: readonly Effect[] = [still, rotate, shuffle, zones];

export function findRoomEffect(id: string): Effect | undefined {
  return ROOM_EFFECTS.find((effect) => effect.id === id);
}
