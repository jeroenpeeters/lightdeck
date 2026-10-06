/** What the listening comes up with, in the words of the console. */

/** `silent`: no music. `music`: sound without a pulse. `beat`: sound with a pulse. */
export type Heard = 'silent' | 'music' | 'beat';

export interface Hearing {
  /**
   * The moment this is about, in seconds on the clock of the feed: the position of the
   * last sample it has heard divided by the sample rate.
   */
  at: number;
  heard: Heard;
  /** The tempo it holds. Stays what it was while nothing better is found, undefined before the first. */
  bpm: number | undefined;
  /** 0 to 1: how clearly the held tempo stands out from all the tempos tried. */
  confidence: number;
  /**
   * A moment, in seconds on the clock of the feed, at which a beat fell: at or before
   * `at`, and not more than one beat before it. Undefined while there is no beat.
   */
  beatAt: number | undefined;
  /** Loudness in dBFS. */
  level: number;
}
