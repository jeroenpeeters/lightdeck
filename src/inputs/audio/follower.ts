/**
 * Listening, applied to the tempo. The follower takes the blocks of a source, lets the
 * hearer say what is heard, and, while the tempo has `audio` as its source, moves the
 * tempo the way the settings say:
 *
 *   beat     the bpm and the place of the beat follow what is heard
 *   music    `onNoBeat: hold` (the default) leaves the tempo running as it was
 *   silent   `onSilence: stop` (the default) makes the tempo not run, so effects are idle
 *   lost     a source that stopped sending is not silence: the tempo runs on at its last bpm
 *
 * The hearer runs while sound comes, whoever the tempo's source is, so that a switch to
 * Auto finds the tempo at once instead of after ten seconds of listening. Only the
 * tempo's source decides whether what is heard moves it.
 *
 * Events: `audio` with the state, when what is heard, the bpm or the source changes.
 */

import { EventEmitter } from 'node:events';
import type { Tempo } from '../../server/tempo.js';
import { Hearer } from './hearer.js';
import type { Heard, Hearing } from './hearing.js';
import { type AudioSettings, DEFAULT_AUDIO_SETTINGS, readAudioSettings } from './settings.js';
import type { AudioBlock, AudioSource, SourceStatus } from './source.js';

/** What the follower needs of the hearer, so that tests can put their own. */
export interface HearerLike {
  setSettings(settings: AudioSettings): void;
  push(block: AudioBlock): Hearing[];
  reset(): void;
}

/** How long the offset between the clock of the feed and the clock of the tempo is looked back over. */
const OFFSET_WINDOW_MS = 30_000;
/** A new bpm is only passed on when it differs by at least this, so the tempo does not shiver. */
const MIN_BPM_STEP = 0.1;
/** A beat that is not this much later than the last one passed on is the same beat. */
const MIN_BEAT_GAP_S = 0.2;

export interface FollowerOptions {
  tempo: Tempo;
  source: AudioSource;
  settings?: Partial<AudioSettings>;
  /** For tests. */
  hearer?: HearerLike;
}

export interface AudioState {
  source: { id: string; label: string; status: SourceStatus };
  /** Whether the tempo follows what is heard: its source is `audio`. */
  following: boolean;
  /** What is heard now, or `none` while there is no sound coming. */
  heard: Heard | 'none';
  /** The tempo the tracker holds, whether the tempo follows it or not. */
  bpm: number | undefined;
  /** 0 to 1 */
  confidence: number;
  settings: AudioSettings;
}

export class Follower extends EventEmitter {
  private readonly tempo: Tempo;
  private readonly source: AudioSource;
  private readonly hearer: HearerLike;
  private settings: AudioSettings;

  private heard: Heard | 'none' = 'none';
  private bpm: number | undefined;
  private confidence = 0;
  private status: SourceStatus;
  private lastShown = '';

  /** Differences between when a block arrived and where its end lies in the feed, in ms. */
  private offsets: { at: number; offset: number }[] = [];
  private feed: number | undefined;
  private lastBeatAt: number | undefined;

  private readonly onBlock = (block: AudioBlock, arrivedAt: number) => this.hear(block, arrivedAt);
  private readonly onStatus = (status: SourceStatus) => this.statusChanged(status);
  private readonly onTempo = () => this.announce();

  constructor(options: FollowerOptions) {
    super();
    this.tempo = options.tempo;
    this.source = options.source;
    this.settings = readAudioSettings(options.settings ?? {}, { ...DEFAULT_AUDIO_SETTINGS });
    this.hearer = options.hearer ?? new Hearer(this.settings);
    this.status = this.source.getStatus();
    this.source.on('block', this.onBlock);
    this.source.on('status', this.onStatus);
    this.tempo.on('tempo', this.onTempo);
  }

  getState(): AudioState {
    return {
      source: { id: this.source.id, label: this.source.label, status: this.status },
      following: this.tempo.getState().source === 'audio',
      heard: this.heard,
      bpm: this.bpm,
      confidence: this.confidence,
      settings: { ...this.settings },
    };
  }

  /** Changes settings. Throws a `PatchError`, and changes nothing, when any part is wrong. */
  update(patch: unknown): AudioSettings {
    this.settings = readAudioSettings(patch, this.settings);
    this.hearer.setSettings(this.settings);
    this.lastShown = '';
    this.announce();
    return { ...this.settings };
  }

  close(): void {
    this.source.off('block', this.onBlock);
    this.source.off('status', this.onStatus);
    this.tempo.off('tempo', this.onTempo);
    this.removeAllListeners();
  }

  private hear(block: AudioBlock, arrivedAt: number): void {
    if (block.feed !== this.feed) {
      this.feed = block.feed;
      this.offsets = [];
      this.lastBeatAt = undefined;
    }
    const endMs = ((block.index + block.samples.length) / block.sampleRate) * 1000;
    this.offsets.push({ at: arrivedAt, offset: arrivedAt - endMs });
    while (this.offsets.length > 0 && arrivedAt - (this.offsets[0]?.at ?? 0) > OFFSET_WINDOW_MS) {
      this.offsets.shift();
    }

    for (const hearing of this.hearer.push(block)) this.take(hearing);
    this.announce();
  }

  /**
   * Delays only add, so the smallest difference between arrival and position is the true
   * one. It also follows the small difference in speed between the clock of the sound
   * card and the clock of the computer.
   */
  private offset(): number {
    let least = Number.POSITIVE_INFINITY;
    for (const { offset } of this.offsets) least = Math.min(least, offset);
    return least;
  }

  /** A moment on the clock of the feed, in seconds, as a moment on the clock of the tempo. */
  private onTempoClock(seconds: number): number {
    return seconds * 1000 + this.offset() + this.settings.latencyMs;
  }

  private take(hearing: Hearing): void {
    this.heard = hearing.heard;
    this.confidence = hearing.confidence;
    if (hearing.bpm !== undefined) this.bpm = hearing.bpm;
    if (this.tempo.getState().source !== 'audio') return;

    const { onSilence, onNoBeat, phase } = this.settings;
    const stops =
      (hearing.heard === 'silent' && onSilence === 'stop') ||
      (hearing.heard === 'music' && onNoBeat === 'stop');

    if (hearing.heard !== 'beat' || hearing.bpm === undefined) {
      this.tempo.follow({ running: !stops });
      return;
    }

    const held = this.tempo.getState().bpm;
    const rounded = Math.round(hearing.bpm * 10) / 10;
    const change: Parameters<Tempo['follow']>[0] = { running: true };
    if (Math.abs(rounded - held) >= MIN_BPM_STEP) change.bpm = rounded;
    if (
      hearing.beatAt !== undefined &&
      (this.lastBeatAt === undefined || hearing.beatAt - this.lastBeatAt > MIN_BEAT_GAP_S)
    ) {
      this.lastBeatAt = hearing.beatAt;
      change.beatAt = this.onTempoClock(hearing.beatAt);
      change.snap = phase === 'snap';
    }
    this.tempo.follow(change);
  }

  private statusChanged(status: SourceStatus): void {
    this.status = status;
    if (status === 'lost') {
      // Not silence. The sound stopped coming, which says nothing about the music, so the
      // tempo runs on at the last bpm instead of leaving the effects idle.
      this.heard = 'none';
      this.confidence = 0;
      if (this.tempo.getState().source === 'audio') this.tempo.follow({ running: true });
    }
    this.announce();
  }

  /** Tells the listeners, when what they show has changed. */
  private announce(): void {
    const state = this.getState();
    const shown = JSON.stringify([
      state.source.status,
      state.following,
      state.heard,
      state.bpm === undefined ? null : Math.round(state.bpm),
      Math.round(state.confidence * 10),
      state.settings,
    ]);
    if (shown === this.lastShown) return;
    this.lastShown = shown;
    this.emit('audio', state);
  }
}
