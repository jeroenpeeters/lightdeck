/**
 * Rekordbox, applied to the tempo. rkbx_link reads the deck that is master from the memory of
 * rekordbox and sends it as OSC; this takes four of its messages and, while the tempo has
 * `rekordbox` as its source, moves the tempo by them:
 *
 *   /master/bpm/current        the bpm, with the pitch of the deck in it
 *   /master/beat/trigger/1     1.0 on every beat (turn `osc.msg.master/beat/trigger` on, with 1)
 *   /master/time               the position in the track, in seconds (turn `osc.msg.master/time` on)
 *   /master/phrase/current     the phrase of the track (turn `osc.msg.master/phrase` on; a number
 *                              or a name, by `osc.phrase_output_format`)
 *
 * The bpm is followed as it comes. The place of the beat is where the triggers fall: the first
 * one puts the beat right at once, the ones after it pull the beats a quarter of the way per
 * beat (the network is not exact, and the tempo does not shiver for it). Which beat is beat
 * one of the bar is not taken from rekordbox: a tap sets it.
 *
 * The music has stopped (the deck is paused, the track has ended, rkbx_link is gone) when the
 * position stops moving (0.3 s: this is the direct one, and needs the time messages) or when
 * the beats stop coming (2.5 beats without one, about 1.2 s at 128 bpm: this works with the
 * trigger alone). Then the tempo stops running, so the effects are idle, as when there is no
 * music. They start again when the position moves or a beat comes. The bpm alone leaves the
 * beat where it was and never stops anything.
 *
 * A breakdown is a phrase that rekordbox calls Down or Bridge (4 in the numbers). It is only
 * used when the operator turned it on (`update({ breakdown: true })`, off at every start): the
 * effects are then idle for as long as that phrase lasts, and the beat goes on being followed
 * under it. rkbx_link sends the phrase only when it changes (not on every tick, as the position),
 * so the phrase stands until a new one comes. It is let go when the track changes
 * (`/master/track/title`), so that a track without phrase analysis cannot leave the effects idle
 * on the Down of the track before it.
 *
 * Events: `rkbx` with the state, when what it shows changes.
 */

import { EventEmitter } from 'node:events';
import { PatchError, readObject } from '../../server/fixture.js';
import { MAX_BPM, MIN_BPM, type Tempo } from '../../server/tempo.js';
import type { OscArg, OscMessage } from './osc.js';
import type { OscReceiver } from './receiver.js';

export const BPM_ADDRESS = '/master/bpm/current';
export const BEAT_ADDRESS = '/master/beat/trigger/1';
export const TIME_ADDRESS = '/master/time';
export const PHRASE_ADDRESS = '/master/phrase/current';
export const TITLE_ADDRESS = '/master/track/title';

/** A new bpm is only passed on when it differs by at least this, so the tempo does not shiver. */
const MIN_BPM_STEP = 0.05;
/** A trigger sooner than this after the last one is the same beat (the release of a trigger is 0.0). */
const MIN_BEAT_GAP_MS = 200;
/**
 * No beat for this many beats and the music has stopped. One beat that did not arrive (a lost
 * datagram) leaves a gap of two beats, which must not stop the effects; the third missing does.
 */
const STOP_AFTER_BEATS = 2.5;
/**
 * The position in the track has not moved for this long and the deck is not playing. rkbx_link
 * sends it about 60 times a second, so this is many messages, and it must stay well above a
 * hiccup of the network.
 */
const TIME_STALL_MS = 300;
/** A position that differs by less than this, in seconds, has not moved. */
const MIN_TIME_STEP = 0.0005;
/**
 * A phrase and a new title that come within this of each other are one update of rkbx_link, in
 * whichever order: the phrase is the new track's and stays. Any older phrase goes with the title.
 */
const TRACK_CHANGE_MS = 1000;
const CHECK_EVERY_MS = 100;

/** The phrases as rkbx_link numbers them (`osc.phrase_output_format int`), for the page. */
const PHRASE_NAMES = ['', 'Intro', 'Verse / Up', 'Chorus', 'Bridge / Down', 'Outro'];
const BREAKDOWN_NUMBER = 4;
const BREAKDOWN_NAME = /^(down|bridge)\b/i;

export interface Phrase {
  /** What the page shows. */
  name: string;
  /** Rekordbox calls it Down or Bridge. */
  breakdown: boolean;
}

/** A phrase message as a phrase, or undefined for what is no phrase (0, an empty name, a blob). */
export function readPhrase(value: OscArg | undefined): Phrase | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = Math.round(value);
    const name = PHRASE_NAMES[n];
    return n >= 1 && name ? { name, breakdown: n === BREAKDOWN_NUMBER } : undefined;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const name = value.trim();
    return { name, breakdown: BREAKDOWN_NAME.test(name) };
  }
  return undefined;
}

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
  breakdown: {
    /** The operator turned it on. Off at every start. */
    enabled: boolean;
    /** The phrase rekordbox is in, as long as it is heard; undefined when it is not. */
    phrase: string | undefined;
    /** On, and the phrase is a breakdown: the effects are idle for it. */
    active: boolean;
  };
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
  /** The position in the track, and when it last moved. */
  private lastTime: number | undefined;
  private lastMovedAt: number | undefined;
  /** The position has come in this session, so that its standing still means something. */
  private timeSeen = false;
  /** The last phrase and when it came. It stands until another comes or the track changes. */
  private phrase: Phrase | undefined;
  private phraseAt: number | undefined;
  /** The title of the track on the master deck. */
  private title: string | undefined;
  private breakdownEnabled = false;
  /** The music has stopped: no beats, or a position that stands still. */
  private gone = false;
  /** The effects are idle, for that or for a breakdown, and the tempo was told. */
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
    const phrase = this.phrase;
    return {
      status: this.status,
      following: this.following(),
      bpm: this.bpm,
      beats: this.beatsSeen && !this.gone,
      port: this.receiver.port,
      breakdown: {
        enabled: this.breakdownEnabled,
        phrase: phrase?.name,
        active: this.breakdownEnabled && phrase?.breakdown === true,
      },
    };
  }

  /**
   * Changes what the operator can set: `breakdown`, true or false. Throws a `PatchError`, and
   * changes nothing, when any part is wrong.
   */
  update(patch: unknown): void {
    const { breakdown } = readObject(patch, 'rekordbox', ['breakdown']);
    if (breakdown !== undefined && typeof breakdown !== 'boolean') {
      throw new PatchError('breakdown must be true or false');
    }
    if (breakdown !== undefined) this.breakdownEnabled = breakdown;
    this.evaluate(this.tempo.now());
    this.announce();
  }

  close(): void {
    clearInterval(this.timer);
    this.receiver.off('message', this.onMessage);
    this.tempo.off('tempo', this.onTempo);
    this.removeAllListeners();
  }

  /** Looks for music that stopped. The timer calls it; tests call it with their own clock. */
  check(now: number): void {
    this.evaluate(now);
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

  /** Whether the music is playing, as far as the messages say, and the tempo told when that changes. */
  private evaluate(now: number): void {
    const beatsGone =
      this.beatsSeen &&
      this.lastBeatAt !== undefined &&
      now - this.lastBeatAt > STOP_AFTER_BEATS * (60_000 / this.tempo.getState().bpm);
    const timeStill =
      this.timeSeen && this.lastMovedAt !== undefined && now - this.lastMovedAt > TIME_STALL_MS;
    const gone = beatsGone || timeStill;
    // The beat that comes after the music stopped is a new start: put it right at once. Under
    // a breakdown the beats go on and are followed, so nothing is lost there.
    if (gone && !this.gone) this.needsSnap = true;
    this.gone = gone;

    const idle = gone || (this.breakdownEnabled && this.phrase?.breakdown === true);
    if (idle === this.stopped) return;
    this.stopped = idle;
    this.follow({ running: !idle });
  }

  /** The phrase came with this message (or just before it): it is the new track's. */
  private phrasePartOfUpdate(at: number): boolean {
    return this.phraseAt !== undefined && Math.abs(at - this.phraseAt) <= TRACK_CHANGE_MS;
  }

  private take(message: OscMessage, arrivedAt: number): void {
    const value = message.args[0];
    if (message.address === PHRASE_ADDRESS) {
      this.status = 'live';
      this.phrase = readPhrase(value);
      this.phraseAt = arrivedAt;
    } else if (message.address === TITLE_ADDRESS) {
      // Another track: what was said of the one before is not about this one. The first title only
      // says which track it is.
      if (typeof value !== 'string' || value === this.title) return;
      if (this.title !== undefined && !this.phrasePartOfUpdate(arrivedAt)) this.phrase = undefined;
      this.title = value;
    } else if (typeof value !== 'number' || !Number.isFinite(value)) {
      return;
    } else if (message.address === BPM_ADDRESS) {
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
      this.follow({ beatAt: arrivedAt, snap: this.needsSnap });
      this.needsSnap = false;
    } else if (message.address === TIME_ADDRESS) {
      this.status = 'live';
      if (this.lastTime === undefined || Math.abs(value - this.lastTime) > MIN_TIME_STEP) {
        this.lastTime = value;
        this.lastMovedAt = arrivedAt;
      }
      this.timeSeen = true;
    } else {
      return;
    }
    this.evaluate(arrivedAt);
    this.announce();
  }

  private tempoChanged(): void {
    const following = this.following();
    if (following && !this.wasFollowing) {
      // Just chosen: the beat is wherever it was, so the first beat that comes sets it right.
      this.needsSnap = true;
      // Chosen while the effects are to be idle: they wait.
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
      state.breakdown,
    ]);
    if (shown === this.lastShown) return;
    this.lastShown = shown;
    this.emit('rkbx', state);
  }
}
