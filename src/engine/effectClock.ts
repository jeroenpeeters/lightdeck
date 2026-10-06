/**
 * The beat an effect is given, and the speed it runs at.
 *
 * An effect is a pure function of its beat, and its beat is the beat of the tempo times
 * the speed. Taken as it is, that has two faults. A change of the speed moves the effect
 * to wherever the new product lies: a chase that is on lens 7 when ×2 is pressed is on
 * lens 6 the next moment, and the master speed does it too. And the limit on the speed
 * (`limitSpeed`) halves it the instant the tempo crosses a threshold, so a track at 150
 * beats per minute with ×4 chosen flaps between ×4 and ×2 as the tempo wanders.
 *
 * This keeps the effect where it is when the speed changes, and puts a dead band on the
 * limit. Each effect of a fixture has one of these; the effect itself stays pure.
 *
 * Continuity is of the step, not of the place within the step. The effect beat is the
 * beat times the speed plus a whole number, so the steps of the effect stay on the grid
 * of the beat at every speed: a chase that went on from lens 7 at ×1 steps on the half
 * beats at ×2, and a flash still falls on a beat. A whole number is the most that keeps
 * both. The place within a step does jump at the moment of a change, as it must: the
 * speed of what happens within a step has changed.
 */

import { limitSpeed, MAX_FLASH_HZ } from './effects.js';

/**
 * A speed that was lowered by the limit comes back up only when the tempo is this share
 * under the limit.
 */
export const LIMIT_DEAD_BAND = 0.03;

export interface EffectClockInput {
  /** The beat of the tempo, not scaled by any speed. */
  beat: number;
  bpm: number;
  /** The speed that is wanted: the speed of the effect times the master speed. */
  wanted: number;
  /** Changes when the beat count was restarted by a tap. */
  epoch: number;
  /** Which effect it is: another effect starts over. */
  key: string;
}

export interface EffectClockReading {
  /** What the effect is given as its beat. */
  beat: number;
  /** The speed it runs at, after the limit. */
  speed: number;
}

export class EffectClock {
  private key: string | undefined;
  private epoch: number | undefined;
  private wanted: number | undefined;
  private speed: number | undefined;
  private offset = 0;

  read({ beat, bpm, wanted, epoch, key }: EffectClockInput): EffectClockReading {
    if (key !== this.key || epoch !== this.epoch) {
      this.key = key;
      this.epoch = epoch;
      this.wanted = undefined;
      this.speed = undefined;
      this.offset = 0;
    }

    const speed = this.limited(bpm, wanted);
    if (this.speed !== undefined && speed !== this.speed) {
      const before = this.offset + beat * this.speed;
      this.offset = Math.floor(before) - Math.floor(beat * speed);
    }
    this.wanted = wanted;
    this.speed = speed;
    return { beat: this.offset + beat * speed, speed };
  }

  /** The limit, with the dead band: down at once, up again only when well clear of it. */
  private limited(bpm: number, wanted: number): number {
    const strict = limitSpeed(bpm, wanted);
    if (this.speed === undefined || this.wanted !== wanted) return strict;
    if (strict <= this.speed) return strict;
    const clear = (bpm / 60) * strict <= MAX_FLASH_HZ * (1 - LIMIT_DEAD_BAND);
    return clear ? strict : this.speed;
  }
}
