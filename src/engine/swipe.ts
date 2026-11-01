/**
 * What the light effect `swipe` and the motion effect `swipe` share (Jeroen, 2026-11-01): the two are chosen
 * apart, like every light effect and every motion effect, so they must agree on when a bar goes up and when
 * it goes down without knowing about each other. Both ask here.
 *
 * The bars take turns. Leg 0 sends bar 0 up, lit, while bar 1 goes back down, dark; leg 1 sends bar 1 up and
 * bar 0 down, and so on, so there is always one bar sweeping up with its beams on. A leg is `SWIPE_BEATS`
 * beats, which at speed 1 is about a second at 126 bpm: a fast swipe, and faster still with the speed.
 */

import { frac, mod } from './beat.js';

/** The beats of one leg: the time a bar takes from the floor to the top, or back down. */
export const SWIPE_BEATS = 2;

/** The leg a beat is in, counted from 0, and how far through it the beat is, 0 to 1. */
export function swipeLeg(beat: number): { leg: number; phase: number } {
  const whole = beat / SWIPE_BEATS;
  return { leg: Math.floor(whole), phase: frac(whole) };
}

/**
 * Whether bar number `bar` goes up on the leg that ends in `arrival` (the leg that began at `arrival - 1`).
 * The first leg, which ends in arrival 1, sends bar 0 up.
 */
export const swipesUp = (bar: number, arrival: number): boolean => mod(arrival + bar, 2) === 1;
