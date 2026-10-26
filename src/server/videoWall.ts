/**
 * The video wall (Jeroen, 2026-10-23): the track that rekordbox has on the master deck goes to the
 * text overlay of his own video wall program (`src/outputs/videowall/overlay.ts`), as `Title - Artist`.
 *
 * It calls the wall only when the track CHANGES: a track that was sent is not sent again, whatever
 * else rekordbox says. The text stays as long as the settings say and is then taken away; a new
 * track replaces it and starts that time again. All calls go through one chain, so a take-away can
 * never overtake the text it is for. A call that fails is said (`last`), and is not tried again by
 * itself: the next track is the next call.
 *
 * The tablet also plays the wall's own library (videos, effects, texts, playlists), switches its
 * picture to black, and reads what it is doing; see `library()` and the methods under it.
 *
 * The settings are Jeroen's and live in a file of their own (`videowall.json`, with the PIN in it,
 * so not in git), not in the show. A track is remembered while the feature is off, but is not shown
 * when it is switched on: that waits for the next track, or for Send current track on the page.
 */

import { EventEmitter } from 'node:events';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { TrackInfo } from '../inputs/rkbx/follower.js';
import {
  DEFAULT_SETTINGS,
  OverlayError,
  overlayText,
  readSettings,
  TRANSITIONS,
  type Transition,
  VideoWallClient,
  type VideoWallSettings,
  type WallLibrary,
  type WallStatus,
} from '../outputs/videowall/overlay.js';
import { PatchError } from './fixture.js';

/** What a page is told: the settings without the PIN, and what is on the wall. */
export interface VideoWallState {
  settings: Omit<VideoWallSettings, 'pin'> & { pinSet: boolean };
  /** The track on the master deck, as far as rkbx_link has said. */
  track: TrackInfo | null;
  /** What the track that plays would show on the wall with the settings as they are (the sample when none plays). */
  preview: string;
  /** The text that is on the wall, when it came (ms since the epoch) and when it goes. */
  shown: { text: string; since: number; hideAt: number | null } | null;
  /** The last call to the wall and how it went. */
  last: { action: 'show' | 'clear'; ok: boolean; at: number; error?: string } | null;
}

export interface VideoWallOptions {
  /** Tells of the track (`track`) and says which it is now (`getTrack`). */
  source: EventEmitter & { getTrack(): TrackInfo | undefined };
  /** The settings file. Without it the settings live in memory only. */
  file?: string;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
}

const SAMPLE: TrackInfo = { title: 'Track title (Original Mix)', artist: 'Artist' };
/** How long a test stays up when the settings leave a text up for good. */
const TEST_SECONDS = 5;

export class VideoWall extends EventEmitter {
  private settings: VideoWallSettings = { ...DEFAULT_SETTINGS };
  private track: TrackInfo | null = null;
  private shown: VideoWallState['shown'] = null;
  private last: VideoWallState['last'] = null;
  /** The track that was sent last, so that the same track is never sent twice. */
  private sentKey: string | undefined;
  private hideTimer: NodeJS.Timeout | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly client: VideoWallClient;
  private readonly now: () => number;
  private readonly onTrack = (track: TrackInfo) => this.trackChanged(track);

  constructor(private readonly options: VideoWallOptions) {
    super();
    this.client = new VideoWallClient(options.fetch);
    this.now = options.now ?? Date.now;
    this.load();
    this.track = options.source.getTrack() ?? null;
    options.source.on('track', this.onTrack);
  }

  getState(): VideoWallState {
    const { pin, ...settings } = this.settings;
    return {
      settings: { ...settings, pinSet: pin !== '' },
      track: this.track ? { ...this.track } : null,
      preview: this.textOf(this.track ?? SAMPLE),
      shown: this.shown ? { ...this.shown } : null,
      last: this.last ? { ...this.last } : null,
    };
  }

  // ---- the player's own library and playback (for the tablet) ----
  //
  // These go straight to the player and do not wait for the overlay: the text and the picture are
  // two things. A call that fails is raised to whoever pressed, and is not tried again.

  async library(): Promise<WallLibrary> {
    return this.asked(() => this.client.library(this.settings));
  }

  async status(): Promise<WallStatus> {
    return this.asked(() => this.client.status(this.settings));
  }

  async play(id: unknown, transition?: unknown): Promise<void> {
    const kind = readTransition(transition);
    await this.asked(() => this.client.play(this.settings, readId(id), kind));
  }

  async playPlaylist(id: unknown, transition?: unknown): Promise<void> {
    const kind = readTransition(transition);
    await this.asked(() => this.client.playPlaylist(this.settings, readId(id), kind));
  }

  async blackout(value: unknown): Promise<void> {
    if (typeof value !== 'boolean') throw new PatchError('"value" must be true or false');
    await this.asked(() => this.client.blackout(this.settings, value));
  }

  /** A preview picture of the player, for the tablet, which may not reach the player itself. */
  async image(path: string): Promise<{ type: string; body: Buffer }> {
    return this.asked(() => this.client.image(this.settings, path));
  }

  private async asked<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof OverlayError) throw new PatchError(error.message);
      throw error;
    }
  }

  /** Changes the settings (validated as a whole, then kept in the file). Switching off takes the text away. */
  update(change: unknown): void {
    const next = readSettings(change, this.settings);
    const wasEnabled = this.settings.enabled;
    this.settings = next;
    this.save();
    if (wasEnabled && !next.enabled && this.shown) this.hide();
    this.announce();
  }

  /** The current track, shown now: for a track that came before the feature was on. */
  async sendCurrent(): Promise<void> {
    const track = this.track;
    if (!track) throw new PatchError('rekordbox has not said which track is playing yet');
    this.sentKey = keyOf(track);
    await this.display(this.textOf(track), true);
  }

  /** A sample text, to see where it lands. It goes as the settings say, for 5 seconds at the most if they leave it up for good. */
  async test(): Promise<void> {
    await this.display(this.textOf(SAMPLE), true, TEST_SECONDS);
  }

  /** Takes the text away now. */
  async clear(): Promise<void> {
    await this.hide(true);
  }

  close(): void {
    clearTimeout(this.hideTimer);
    this.options.source.off('track', this.onTrack);
    this.removeAllListeners();
  }

  private textOf(track: TrackInfo): string {
    return overlayText(track, this.settings.lines, this.settings.titleFilter);
  }

  private trackChanged(track: TrackInfo): void {
    this.track = track;
    const key = keyOf(track);
    if (!this.settings.enabled || key === this.sentKey) {
      this.announce();
      return;
    }
    this.sentKey = key;
    this.announce();
    void this.display(this.textOf(track), false);
  }

  /**
   * Shows `text` and sets the time it goes away. Raises the problem when `strict` (a press on
   * the page); otherwise it is said in `last` and nothing else.
   */
  private display(text: string, strict: boolean, limit?: number): Promise<void> {
    const settings = this.settings;
    return this.enqueue(async () => {
      try {
        await this.client.show(settings, text);
      } catch (error) {
        this.fail('show', error, strict);
        return;
      }
      const at = this.now();
      const seconds =
        settings.durationSeconds > 0
          ? Math.min(settings.durationSeconds, limit ?? Infinity)
          : (limit ?? 0);
      const hideAt = seconds > 0 ? at + seconds * 1000 : null;
      this.shown = { text, since: at, hideAt };
      this.last = { action: 'show', ok: true, at };
      clearTimeout(this.hideTimer);
      if (hideAt !== null) {
        this.hideTimer = setTimeout(() => void this.hide(), seconds * 1000);
        this.hideTimer.unref();
      }
      this.announce();
    });
  }

  private hide(strict = false): Promise<void> {
    clearTimeout(this.hideTimer);
    const settings = this.settings;
    return this.enqueue(async () => {
      try {
        await this.client.clear(settings);
      } catch (error) {
        this.fail('clear', error, strict);
        return;
      }
      this.shown = null;
      this.last = { action: 'clear', ok: true, at: this.now() };
      this.announce();
    });
  }

  /** One call after the other, and a failure never breaks the chain. */
  private enqueue(call: () => Promise<void>): Promise<void> {
    const run = this.chain.then(call);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private fail(action: 'show' | 'clear', error: unknown, strict: boolean): void {
    const message = error instanceof OverlayError ? error.message : String(error);
    this.last = { action, ok: false, at: this.now(), error: message };
    this.options.log?.(`video wall: ${message}`);
    this.announce();
    if (strict) throw new PatchError(message);
  }

  private announce(): void {
    this.emit('videowall', this.getState());
  }

  private load(): void {
    const { file } = this.options;
    if (!file) return;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return; // no file yet: the defaults, and the first change writes it
    }
    try {
      this.settings = readSettings(JSON.parse(text), DEFAULT_SETTINGS);
    } catch (error) {
      this.options.log?.(`video wall: ${file} is not used (${String(error)}), the defaults apply`);
    }
  }

  private save(): void {
    const { file } = this.options;
    if (!file) return;
    try {
      writeFileSync(`${file}.tmp`, `${JSON.stringify(this.settings, null, 2)}\n`);
      renameSync(`${file}.tmp`, file);
    } catch (error) {
      this.options.log?.(`video wall: cannot write ${file}: ${String(error)}`);
    }
  }
}

function readId(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > 300) {
    throw new PatchError('"id" must be the id of something the video wall can play');
  }
  return value;
}

function readTransition(value: unknown): Transition | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && (TRANSITIONS as readonly string[]).includes(value)) {
    return value as Transition;
  }
  throw new PatchError(`"transition" must be ${TRANSITIONS.join(', ')}`);
}

const keyOf = (track: TrackInfo) => `${track.title}\n${track.artist}`;
