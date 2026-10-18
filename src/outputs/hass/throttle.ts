/**
 * The budget for commands to Home Assistant: a Zigbee mesh takes a few commands per second
 * and a lamp more than about one per second badly. Two limits, both settings of the
 * throttle and not constants spread through the code:
 *
 * - **A gap per entity.** An entity gets its next command no sooner than `minGapMs` (1 s) after
 *   its last one.
 * - **A limit in all.** No more than `perSecond` (10) commands in any window of one second,
 *   for all entities together.
 * - **Answers.** An entity gets no new command while its last one has no answer, and no more than
 *   `maxInFlight` (4) commands are on the way in all. The soak of 2026-10-18 sent 10 per second
 *   to 14 lamps and Home Assistant answered about 4 per second: the answers came 26 s late on
 *   average and 172 s at the end, so the lamps ran minutes behind. The clock cannot know what the
 *   mesh can take, the answers can: the pace follows them, and since the newest command wins
 *   what the mesh cannot take is dropped and not queued. A command whose answer does not come
 *   in `answerTimeoutMs` stops counting, so one that hangs does not block the rest.
 *
 * There is one place per entity, and the newest command wins: what waited there is dropped, so
 * a fader that is dragged costs one command per gap and not one per step. The one that waited
 * longest goes first. `urgent` goes before the rest and does not wait for the gap of its
 * entity, as the blackout needs, but it still counts for the limit in all, because that limit
 * protects the mesh.
 *
 * Pure: the clock is passed in, so the tests do not wait.
 */

export const DEFAULT_MIN_GAP_MS = 1000;
export const DEFAULT_PER_SECOND = 10;
export const DEFAULT_MAX_IN_FLIGHT = 4;
export const DEFAULT_ANSWER_TIMEOUT_MS = 10_000;
const WINDOW_MS = 1000;

export interface ThrottleOptions {
  /** The least time between two commands for one entity. Default 1000. */
  minGapMs?: number;
  /** The most commands in any second, for all entities together. Default 10. */
  perSecond?: number;
  /** The most commands without an answer, for all entities together. Default 4. */
  maxInFlight?: number;
  /** After this long a command without an answer stops counting. Default 10000. */
  answerTimeoutMs?: number;
  /** Monotonic clock in milliseconds. Default `performance.now()`. */
  now?: () => number;
}

interface Waiting<T> {
  item: T;
  /** When the first command that is still waiting here was pushed. */
  since: number;
  urgent: boolean;
}

export class Throttle<T> {
  private readonly minGapMs: number;
  private readonly perSecond: number;
  private readonly maxInFlight: number;
  private readonly answerTimeoutMs: number;
  private readonly now: () => number;
  private readonly waiting = new Map<string, Waiting<T>>();
  private readonly lastSent = new Map<string, number>();
  /** The moments of the commands sent in the last second, oldest first. */
  private readonly sentAt: number[] = [];
  /** Per entity the moments of the commands that have no answer yet, oldest first. */
  private readonly inFlight = new Map<string, number[]>();

  constructor(options: ThrottleOptions = {}) {
    this.minGapMs = options.minGapMs ?? DEFAULT_MIN_GAP_MS;
    this.perSecond = options.perSecond ?? DEFAULT_PER_SECOND;
    this.maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    this.answerTimeoutMs = options.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS;
    this.now = options.now ?? (() => performance.now());
    if (!(this.minGapMs >= 0)) throw new RangeError('the gap per entity cannot be negative');
    if (!Number.isInteger(this.perSecond) || this.perSecond < 1) {
      throw new RangeError('the limit per second must be a whole number of 1 or more');
    }
    if (!Number.isInteger(this.maxInFlight) || this.maxInFlight < 1) {
      throw new RangeError('the limit of commands on the way must be a whole number of 1 or more');
    }
    if (!(this.answerTimeoutMs > 0)) throw new RangeError('the answer timeout must be above 0');
  }

  /** How many commands are on the way without an answer. */
  get inFlightCount(): number {
    let count = 0;
    for (const sent of this.inFlight.values()) count += sent.length;
    return count;
  }

  /** The oldest command of the entity got its answer (or failed to leave). */
  done(entity: string): void {
    const sent = this.inFlight.get(entity);
    if (!sent) return;
    sent.shift();
    if (sent.length === 0) this.inFlight.delete(entity);
  }

  /** Forgets every command on the way, for a connection that is gone. */
  abandon(): void {
    this.inFlight.clear();
  }

  /** How many entities have a command waiting. */
  get size(): number {
    return this.waiting.size;
  }

  /** Puts the command in the place of its entity. What waited there is dropped. */
  push(entity: string, item: T, options: { urgent?: boolean } = {}): void {
    const before = this.waiting.get(entity);
    this.waiting.set(entity, {
      item,
      since: before?.since ?? this.now(),
      urgent: options.urgent === true,
    });
  }

  /** Drops what waits for an entity. */
  drop(entity: string): void {
    this.waiting.delete(entity);
  }

  /** Drops everything that waits. What was sent is remembered, so the budget stays honest. */
  clear(): void {
    this.waiting.clear();
  }

  /**
   * The command that may go out now, or nothing. Taking it counts it against the budget, so
   * ask only when it is going to be sent.
   */
  take(now: number = this.now()): { entity: string; item: T } | undefined {
    if (this.windowOpensAt(now) > now) return undefined;
    if (this.inFlightFreeAt(now) > now) return undefined;
    let best: [string, Waiting<T>] | undefined;
    for (const entry of this.waiting) {
      const [entity, wait] = entry;
      if (this.entityDueAt(entity, wait) > now) continue;
      if (
        !best ||
        (wait.urgent && !best[1].urgent) ||
        (wait.urgent === best[1].urgent && wait.since < best[1].since)
      ) {
        best = entry;
      }
    }
    if (!best) return undefined;
    const [entity, wait] = best;
    this.waiting.delete(entity);
    this.lastSent.set(entity, now);
    this.sentAt.push(now);
    const sent = this.inFlight.get(entity);
    if (sent) sent.push(now);
    else this.inFlight.set(entity, [now]);
    return { entity, item: wait.item };
  }

  /**
   * The earliest moment a waiting command can go, which may already have passed, or nothing
   * when none waits. A command held back for an answer can go sooner than this, when the answer
   * comes: whoever gets answers asks again then.
   */
  nextDueAt(now: number = this.now()): number | undefined {
    let earliest: number | undefined;
    const open = Math.max(this.windowOpensAt(now), this.inFlightFreeAt(now));
    for (const [entity, wait] of this.waiting) {
      const at = Math.max(this.entityDueAt(entity, wait), open);
      if (earliest === undefined || at < earliest) earliest = at;
    }
    return earliest;
  }

  private entityDueAt(entity: string, wait: Waiting<T>): number {
    if (wait.urgent) return Number.NEGATIVE_INFINITY;
    const last = this.lastSent.get(entity);
    const gap = last === undefined ? Number.NEGATIVE_INFINITY : last + this.minGapMs;
    const unanswered = this.inFlight.get(entity)?.[0];
    return unanswered === undefined ? gap : Math.max(gap, unanswered + this.answerTimeoutMs);
  }

  /** When the number of commands on the way lets one more go. */
  private inFlightFreeAt(now: number): number {
    const all: number[] = [];
    for (const [entity, sent] of this.inFlight) {
      const live = sent.filter((at) => at + this.answerTimeoutMs > now);
      if (live.length > 0) this.inFlight.set(entity, live);
      else this.inFlight.delete(entity);
      all.push(...live);
    }
    if (all.length < this.maxInFlight) return Number.NEGATIVE_INFINITY;
    all.sort((a, b) => a - b);
    return (all[all.length - this.maxInFlight] as number) + this.answerTimeoutMs;
  }

  /** When the limit in all lets one more command go: a moment in the past when it already does. */
  private windowOpensAt(now: number): number {
    while (this.sentAt.length > 0 && (this.sentAt[0] as number) <= now - WINDOW_MS) {
      this.sentAt.shift();
    }
    if (this.sentAt.length < this.perSecond) return Number.NEGATIVE_INFINITY;
    return (this.sentAt[this.sentAt.length - this.perSecond] as number) + WINDOW_MS;
  }
}
