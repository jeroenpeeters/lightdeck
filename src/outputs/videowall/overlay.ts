/**
 * The text overlay of the video wall (Jeroen, 2026-10-23): Dreamscape Player, his own program that
 * runs the projector, shows one line of text on top of the video. Plain HTTP and JSON:
 * `POST /api/overlay` shows or replaces the text, `DELETE /api/overlay` removes it. There is one
 * overlay at a time, it does not expire, and a 200 does not mean that anyone is watching.
 *
 * This file is the settings (what to show, where, how big), the text made of a track, and the calls
 * to the player: the two for the overlay, and the ones to play something from its library
 * (`GET /api/videos`, `/effects`, `/texts`, `/playlists`, `/status`, `POST /api/play`, `/playlist`,
 * `/blackout`, from its OpenAPI spec at `/api/openapi.json`). Nothing here knows rekordbox or the rig.
 */

import { PatchError, readObject } from '../../server/fixture.js';

export const VERTICALS = ['top', 'center', 'bottom'] as const;
export const HORIZONTALS = ['left', 'center', 'right'] as const;
/** The title and the artist on one line (`Title - Artist`), or the artist under the title. */
export const LINES = ['one', 'two'] as const;

/** What the player takes: a text of at most this many characters. */
export const MAX_TEXT = 300;
export const MIN_SIZE = 1;
export const MAX_SIZE = 50;
/** How long a text stays on the wall, at the most. 0 is: until the next track. */
export const MAX_SECONDS = 3600;
const MAX_COLOUR = 40;
const MAX_PIN = 40;
const MAX_FILTER = 200;

export interface VideoWallSettings {
  /** Whether a new track is sent to the wall at all. */
  enabled: boolean;
  /** Where the player is, as `http://host:port`. */
  url: string;
  /** The PIN of the player, when it has one. Never sent to a browser. */
  pin: string;
  /** Seconds the text stays; 0 leaves it until another track replaces it. */
  durationSeconds: number;
  vertical: (typeof VERTICALS)[number];
  horizontal: (typeof HORIZONTALS)[number];
  /** Text height as a percent of the screen height. */
  size: number;
  color: string;
  lines: (typeof LINES)[number];
  /**
   * A regular expression (case does not count) whose matches are cut out of the title, such as
   * ` (Original Mix)`. Empty leaves the title as it is.
   */
  titleFilter: string;
}

/** Brackets with Original, Extended or Radio (and Mix, Edit or Version), or the same after a dash at the end. */
export const DEFAULT_TITLE_FILTER =
  '\\s*[(\\[]\\s*(?:original|extended|radio)(?:\\s+(?:mix|edit|version))?\\s*[)\\]]' +
  '|\\s+-\\s+(?:original|extended|radio)\\s+(?:mix|edit|version)$';

export const DEFAULT_SETTINGS: VideoWallSettings = {
  enabled: false,
  url: 'http://192.168.68.30:3000',
  pin: '',
  durationSeconds: 15,
  vertical: 'bottom',
  horizontal: 'left',
  size: 6,
  color: '#ffffff',
  lines: 'one',
  titleFilter: DEFAULT_TITLE_FILTER,
};

const KEYS = [
  'enabled',
  'url',
  'pin',
  'durationSeconds',
  'vertical',
  'horizontal',
  'size',
  'color',
  'lines',
  'titleFilter',
];

function oneOf<T extends string>(value: unknown, list: readonly T[], what: string): T {
  if (typeof value === 'string' && (list as readonly string[]).includes(value)) return value as T;
  throw new PatchError(`"${what}" must be ${list.join(', ')}`);
}

function readNumber(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new PatchError(`"${what}" must be a number from ${min} to ${max}`);
  }
  return value;
}

/** The address of the player as `http://host:port`: a missing `http://` is added. */
export function readUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PatchError('say where the player is, as http://host:3000');
  }
  const text = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z]+:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    throw new PatchError(`"${text}" is not an address, say it as http://192.168.68.30:3000`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PatchError('the player is reached over http or https');
  }
  return parsed.origin;
}

/**
 * The settings with a change laid over them. Strict: a key it does not know, or a value that the
 * player would refuse, is a mistake and changes nothing.
 */
export function readSettings(change: unknown, current: VideoWallSettings): VideoWallSettings {
  const given = readObject(change, 'the video wall', KEYS);
  const next = { ...current };
  if (given.enabled !== undefined) {
    if (typeof given.enabled !== 'boolean') throw new PatchError('"enabled" must be true or false');
    next.enabled = given.enabled;
  }
  if (given.url !== undefined) next.url = readUrl(given.url);
  if (given.pin !== undefined) {
    if (typeof given.pin !== 'string' || given.pin.length > MAX_PIN) {
      throw new PatchError(`"pin" must be text of at most ${MAX_PIN} characters`);
    }
    next.pin = given.pin;
  }
  if (given.durationSeconds !== undefined) {
    next.durationSeconds = Math.round(
      readNumber(given.durationSeconds, 'durationSeconds', 0, MAX_SECONDS),
    );
  }
  if (given.vertical !== undefined) next.vertical = oneOf(given.vertical, VERTICALS, 'vertical');
  if (given.horizontal !== undefined) {
    next.horizontal = oneOf(given.horizontal, HORIZONTALS, 'horizontal');
  }
  if (given.size !== undefined) next.size = readNumber(given.size, 'size', MIN_SIZE, MAX_SIZE);
  if (given.color !== undefined) {
    if (
      typeof given.color !== 'string' ||
      given.color.trim() === '' ||
      given.color.length > MAX_COLOUR ||
      /[\r\n]/.test(given.color)
    ) {
      throw new PatchError('"color" must be a colour such as #ff00aa');
    }
    next.color = given.color.trim();
  }
  if (given.lines !== undefined) next.lines = oneOf(given.lines, LINES, 'lines');
  if (given.titleFilter !== undefined) {
    if (typeof given.titleFilter !== 'string' || given.titleFilter.length > MAX_FILTER) {
      throw new PatchError(`"titleFilter" must be text of at most ${MAX_FILTER} characters`);
    }
    compileTitleFilter(given.titleFilter);
    next.titleFilter = given.titleFilter;
  }
  return next;
}

/** The filter as a regular expression, or null for none. Raises a mistake in it as a `PatchError`. */
export function compileTitleFilter(source: string): RegExp | null {
  if (source.trim() === '') return null;
  try {
    return new RegExp(source, 'gi');
  } catch (error) {
    const reason =
      error instanceof Error ? error.message.replace(/^Invalid regular expression: /, '') : '';
    throw new PatchError(`"${source}" is not a regular expression${reason ? ` (${reason})` : ''}`);
  }
}

/**
 * A track as the wall shows it: `Title - Artist`, or the artist under the title. What the filter
 * matches is cut out of the title; a filter that would leave nothing leaves the title alone.
 */
export function overlayText(
  track: { title: string; artist: string },
  lines: VideoWallSettings['lines'],
  titleFilter = '',
): string {
  const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
  const filter = compileTitleFilter(titleFilter);
  const cut = filter ? flat(track.title.replace(filter, '')) : '';
  const title = cut === '' ? flat(track.title) : cut;
  const artist = flat(track.artist);
  const joined =
    artist === '' ? title : lines === 'two' ? `${title}\n${artist}` : `${title} - ${artist}`;
  return joined.length <= MAX_TEXT ? joined : `${joined.slice(0, MAX_TEXT - 1)}…`;
}

const REQUEST_TIMEOUT_MS = 3000;

/** The player did not take the call, with what to tell the operator. */
export class OverlayError extends Error {}

type Fetch = typeof fetch;

/** The transitions the player knows. */
export const TRANSITIONS = ['none', 'fade', 'zoom', 'slide', 'wipe'] as const;
export type Transition = (typeof TRANSITIONS)[number];

/** One thing the player can play, as the tablet shows it. */
export interface WallItem {
  id: string;
  title: string;
  type: 'video' | 'effect' | 'text';
  /** How long it plays, or what it says: a few words under the name. */
  detail: string;
  /** Path of the preview image on the player (`/media/...`), if it has one. */
  thumb: string | null;
}

export interface WallPlaylist {
  id: string;
  title: string;
  count: number;
  items: { id: string; title: string }[];
}

export interface WallLibrary {
  videos: WallItem[];
  effects: WallItem[];
  texts: WallItem[];
  playlists: WallPlaylist[];
}

/** What the player is doing. */
export interface WallStatus {
  playing: boolean;
  blackout: boolean;
  media: { id: string; title: string; type: string } | null;
  playlist: { id: string; title: string; index: number; length: number } | null;
  /** Seconds into the item and its length (0 if unknown). */
  currentTime: number;
  duration: number;
  transition: Transition | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function readList(json: unknown, key: string): Record<string, unknown>[] {
  const list = isRecord(json) ? json[key] : undefined;
  return Array.isArray(list) ? list.filter(isRecord).filter((each) => text(each.id) !== '') : [];
}

const seconds = (value: number) =>
  value >= 120 ? `${Math.round(value / 60)} min` : `${Math.round(value)} s`;

/** The player's lists as items for a page. What is not as the spec says is left out. */
export function readItems(
  json: unknown,
  key: 'videos' | 'effects' | 'texts',
  type: WallItem['type'],
): WallItem[] {
  return readList(json, key).map((each) => {
    const thumb = text(each.thumbnailUrl);
    const length = count(each.duration);
    const detail =
      type === 'video'
        ? text(each.loopLength)
        : type === 'effect'
          ? length > 0
            ? seconds(length)
            : ''
          : text(each.content);
    return {
      id: text(each.id),
      title: text(each.title) || text(each.id),
      type,
      detail,
      thumb: isMediaPath(thumb) ? thumb : null,
    };
  });
}

export function readPlaylists(json: unknown): WallPlaylist[] {
  return readList(json, 'playlists').map((each) => ({
    id: text(each.id),
    title: text(each.title) || text(each.id),
    count: count(each.count),
    items: (Array.isArray(each.items) ? each.items.filter(isRecord) : []).map((item) => ({
      id: text(item.id),
      title: text(item.title) || text(item.id),
    })),
  }));
}

export function readStatus(json: unknown): WallStatus {
  const given = isRecord(json) ? json : {};
  const media = isRecord(given.media) ? given.media : null;
  const playlist = isRecord(given.playlist) ? given.playlist : null;
  const transition = (TRANSITIONS as readonly unknown[]).includes(given.transition)
    ? (given.transition as Transition)
    : null;
  return {
    playing: given.playing === true,
    blackout: given.blackout === true,
    media: media
      ? { id: text(media.id), title: text(media.title) || text(media.id), type: text(media.type) }
      : null,
    playlist: playlist
      ? {
          id: text(playlist.id),
          title: text(playlist.title) || text(playlist.id),
          index: count(playlist.index),
          length: count(playlist.length),
        }
      : null,
    currentTime: count(given.currentTime),
    duration: count(given.duration),
    transition,
  };
}

/** A path on the player that holds a picture: `/media/...`, and nothing that climbs out of it. */
export function isMediaPath(path: string): boolean {
  return (
    path.startsWith('/media/') &&
    path.length <= 500 &&
    !/[?#\\\0]|%2e|%2f|%5c/i.test(path) &&
    !path.split('/').some((part) => part === '..' || part === '.')
  );
}

export class VideoWallClient {
  constructor(private readonly fetcher: Fetch = fetch) {}

  /** Shows the text, replacing what is there. */
  async show(settings: VideoWallSettings, text: string): Promise<void> {
    await this.send('POST', '/api/overlay', settings, {
      text,
      color: settings.color,
      vertical: settings.vertical,
      horizontal: settings.horizontal,
      size: settings.size,
    });
  }

  /** Takes the text away. Nothing shown is fine. */
  async clear(settings: VideoWallSettings): Promise<void> {
    await this.send('DELETE', '/api/overlay', settings, {});
  }

  /** Everything the player can play. */
  async library(settings: VideoWallSettings): Promise<WallLibrary> {
    const [videos, effects, texts, playlists] = await Promise.all(
      ['videos', 'effects', 'texts', 'playlists'].map(async (name) =>
        (await this.send('GET', `/api/${name}`, settings)).json().catch(() => ({})),
      ),
    );
    return {
      videos: readItems(videos, 'videos', 'video'),
      effects: readItems(effects, 'effects', 'effect'),
      texts: readItems(texts, 'texts', 'text'),
      playlists: readPlaylists(playlists),
    };
  }

  async status(settings: VideoWallSettings): Promise<WallStatus> {
    const response = await this.send('GET', '/api/status', settings);
    return readStatus(await response.json().catch(() => ({})));
  }

  /** Plays one video, effect or text; stops a playlist that runs. */
  async play(settings: VideoWallSettings, id: string, transition?: Transition): Promise<void> {
    await this.send('POST', '/api/play', settings, {
      videoId: id,
      ...(transition ? { transition } : {}),
    });
  }

  async playPlaylist(
    settings: VideoWallSettings,
    id: string,
    transition?: Transition,
  ): Promise<void> {
    await this.send('POST', '/api/playlist', settings, {
      playlistId: id,
      ...(transition ? { transition } : {}),
    });
  }

  /** The picture black (the overlay goes too) or back. Playback goes on underneath. */
  async blackout(settings: VideoWallSettings, value: boolean): Promise<void> {
    await this.send('POST', '/api/blackout', settings, { value });
  }

  /** A preview picture of the player. */
  async image(settings: VideoWallSettings, path: string): Promise<{ type: string; body: Buffer }> {
    if (!isMediaPath(path)) throw new OverlayError('That is not a picture of the video wall.');
    const response = await this.send('GET', path, settings);
    const type = response.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) throw new OverlayError('The video wall sent no picture.');
    return { type, body: Buffer.from(await response.arrayBuffer()) };
  }

  /** One call. A call that the player does not take raises what to tell the operator. */
  private async send(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    settings: VideoWallSettings,
    body?: Record<string, unknown>,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(`${settings.url}${path}`, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(method === 'GET' && settings.pin !== '' ? { 'x-pin': settings.pin } : {}),
        },
        ...(body
          ? { body: JSON.stringify(settings.pin === '' ? body : { ...body, pin: settings.pin }) }
          : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new OverlayError(
        timedOut
          ? `The video wall does not answer at ${settings.url}.`
          : `Cannot reach the video wall at ${settings.url}.`,
      );
    }
    if (response.ok) return response;
    if (response.status === 401) {
      throw new OverlayError('The video wall refuses the PIN: it is missing or wrong.');
    }
    const answer = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new OverlayError(
      typeof answer.error === 'string'
        ? `The video wall says: ${answer.error}`
        : `The video wall answered ${response.status}.`,
    );
  }
}
