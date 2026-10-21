/**
 * Rekordbox, applied to the tempo. rkbx_link reads the deck that is master from the memory of
 * rekordbox and sends it as OSC; this takes two of its messages and, while the tempo has
 * `rekordbox` as its source, moves the tempo by them:
 *
 *   /master/bpm/current        the bpm, with the pitch of the deck in it
 *   /master/beat/trigger/1     1.0 on every beat (turn `osc.msg.master/beat/trigger` on, with 1)
 *
 * The bpm is followed as it comes. The place of the beat is where the triggers fall: the first
 * one puts the beat right at once, the ones after it pull the beats a quarter of the way per
 * beat (the network is not exact, and the tempo does not shiver for it). Which beat is beat
 * one of the bar is not taken from rekordbox: a tap sets it, as it does with Auto.
 *
 * When the beats stop coming (the deck is paused, the track has ended, rkbx_link is gone) the
 * tempo stops running, so the effects are idle, as when the music stops. They start with the
 * next beat. The bpm without beats (the trigger is not turned on) leaves the beat where it was.
 *
 * Events: `rkbx` with the state, when what it shows changes.
 */

import { EventEmitter } from 'node:events';
import { MAX_BPM, MIN_BPM, type Tempo } from '../../server/tempo.js';
import type { OscMessage } from './osc.js';
import type { OscReceiver } from './receiver.js';

export const BPM_ADDRESS = '/master/bpm/current';
export const BEAT_ADDRESS = '/master/beat/trigger/1';

/** A new bpm is only passed on when it differs by at least this, so the tempo does not shiver. */
const MIN_BPM_STEP = 0.05;
/** A trigger sooner than this after the last one is the same beat (the release of a trigger is 0.0). */
const MIN_BEAT_GAP_MS = 200;
/** No beat for this long and the music has stopped. Slower than a beat at 60 bpm, with room. */
const STOP_AFTER_MS = 3000;
const CHECK_EVERY_MS = 500;

export interface RkbxState {
  /** `waiting`: nothing has come from rkbx_link since lightdeck started. */
  status: 'waiting' | 'live';
  /** Whether the tempo follows rekordbox: its source is `rekordbox`. */
  following: boolean;
  /** The bpm rekordbox says, whether the tempo follows it or not. */
  bpm: number | undefined;
  /** Whether beats are coming now. False with a bpm and no beats: the trigger is not turned on. */
  beats: boolean;
  /** The UDP port rkbx_link has to send to, for the pages to tell the operator. */
  port: number | undefined;
}

export interface RkbxFollowerOptions {
  tempo: Tempo;
  receiver: OscReceiver;
}

export class RkbxFollower extends EventEmitter {
  private readonly tempo: Tempo;
  private readonly receiver: OscReceiver;
  private readonly timer: NodeJS.Timeout;

  private status: RkbxState['status'] = 'waiting';
  private bpm: number | undefined;
  /** The moment of the last beat that was passed on, on the clock of the tempo. */
  private lastBeatAt: number | undefined;
  /** Beats have come in this session, so that their absence means something. */
  private beatsSeen = false;
  /** The beats stopped coming, and the tempo was told. */
  private stopped = false;
  /** The next beat puts the origin right at once instead of a part of the way. */
  private needsSnap = true;
  private wasFollowing: boolean;
  private lastShown = '';

  private readonly onMessage = (message: OscMessage, arrivedAt: number) =>
    this.take(message, arrivedAt);
  private readonly onTempo = () => this.tempoChanged();

  constructor(options: RkbxFollowerOptions) {
    super();
    this.tempo = options.tempo;
    this.receiver = options.receiver;
    this.wasFollowing = this.following();
    this.receiver.on('message', this.onMessage);
    this.tempo.on('tempo', this.onTempo);
    this.timer = setInterval(() => this.check(this.tempo.now()), CHECK_EVERY_MS);
    this.timer.unref();
  }

  getState(): RkbxState {
    return {
      status: this.status,
      following: this.following(),
      bpm: this.bpm,
      beats: this.beatsSeen && !this.stopped,
      port: this.receiver.port,
    };
  }

  close(): void {
    clearInterval(this.timer);
    this.receiver.off('message', this.onMessage);
    this.tempo.off('tempo', this.onTempo);
    this.removeAllListeners();
  }

  /** Looks for beats that stopped coming. The timer calls it; tests call it with their own clock. */
  check(now: number): void {
    if (
      this.stopped ||
      !this.beatsSeen ||
      this.lastBeatAt === undefined ||
      now - this.lastBeatAt <= STOP_AFTER_MS
    ) {
      return;
    }
    this.stopped = true;
    // The beat that comes next is a new start: put it right at once.
    this.needsSnap = true;
    this.follow({ running: false });
    this.announce();
  }

  /** Tells the listeners again, as when the port has just been bound and the state shows it. */
  refresh(): void {
    this.announce();
  }

  private following(): boolean {
    return this.tempo.getState().source === 'rekordbox';
  }

  private follow(change: Parameters<Tempo['follow']>[0]): void {
    this.tempo.follow(change);
  }

  private take(message: OscMessage, arrivedAt: number): void {
    const value = message.args[0];
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    if (message.address === BPM_ADDRESS) {
      this.status = 'live';
      this.bpm = value;
      if (value >= MIN_BPM && value <= MAX_BPM) {
        const held = this.tempo.getState().bpm;
        if (Math.abs(value - held) >= MIN_BPM_STEP) this.follow({ bpm: value });
      }
    } else if (message.address === BEAT_ADDRESS) {
      this.status = 'live';
      // The release of a trigger (0.0) and a repeat of the same beat are not beats.
      if (value <= 0.5) return;
      if (this.lastBeatAt !== undefined && arrivedAt - this.lastBeatAt < MIN_BEAT_GAP_MS) return;
      this.lastBeatAt = arrivedAt;
      this.beatsSeen = true;
      this.stopped = false;
      this.follow({ running: true, beatAt: arrivedAt, snap: this.needsSnap });
      this.needsSnap = false;
    } else {
      return;
    }
    this.announce();
  }

  private tempoChanged(): void {
    const following = this.following();
    if (following && !this.wasFollowing) {
      // Just chosen: the beat is wherever it was, so the first beat that comes sets it right.
      this.needsSnap = true;
      // Chosen while the beats are not coming: the effects wait for them.
      if (this.stopped) this.follow({ running: false });
    }
    this.wasFollowing = following;
    this.announce();
  }

  private announce(): void {
    const state = this.getState();
    const shown = JSON.stringify([
      state.status,
      state.following,
      state.bpm === undefined ? null : Math.round(state.bpm * 10),
      state.beats,
      state.port ?? null,
    ]);
    if (shown === this.lastShown) return;
    this.lastShown = shown;
    this.emit('rkbx', state);
  }
}
