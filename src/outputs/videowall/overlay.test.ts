import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  DEFAULT_TITLE_FILTER,
  isMediaPath,
  MAX_TEXT,
  OverlayError,
  overlayText,
  readSettings,
  readUrl,
  VideoWallClient,
  type VideoWallSettings,
} from './overlay.js';

const settings = (change: Partial<VideoWallSettings> = {}): VideoWallSettings => ({
  ...DEFAULT_SETTINGS,
  ...change,
});

describe('overlayText', () => {
  const track = { title: 'Doppler', artist: 'Charlotte de Witte' };

  it('puts the title and the artist on one line, or the artist under the title', () => {
    expect(overlayText(track, 'one')).toBe('Doppler - Charlotte de Witte');
    expect(overlayText(track, 'two')).toBe('Doppler\nCharlotte de Witte');
  });

  describe('the title filter', () => {
    const cut = (title: string, filter = DEFAULT_TITLE_FILTER) =>
      overlayText({ title, artist: 'A' }, 'one', filter);

    it('takes (Original Mix) and its kin off a title, whatever the case', () => {
      expect(cut('Doppler (Original Mix)')).toBe('Doppler - A');
      expect(cut('Doppler (original mix)')).toBe('Doppler - A');
      expect(cut('Doppler [Extended Mix]')).toBe('Doppler - A');
      expect(cut('Doppler (Radio Edit)')).toBe('Doppler - A');
      expect(cut('Doppler - Original Mix')).toBe('Doppler - A');
    });

    it('leaves other brackets alone', () => {
      expect(cut('Doppler (Charlotte de Witte Remix)')).toBe(
        'Doppler (Charlotte de Witte Remix) - A',
      );
      expect(cut('Doppler')).toBe('Doppler - A');
    });

    it('uses any expression, and nothing when it is empty', () => {
      expect(cut('Doppler (Original Mix)', '')).toBe('Doppler (Original Mix) - A');
      expect(cut('Doppler (Charlotte Remix)', '\\s*\\(.*Remix\\)')).toBe('Doppler - A');
    });

    it('keeps the title when the filter would leave nothing', () => {
      expect(cut('(Original Mix)')).toBe('(Original Mix) - A');
    });
  });

  it('is just the title when there is no artist', () => {
    expect(overlayText({ title: 'Doppler', artist: '' }, 'one')).toBe('Doppler');
    expect(overlayText({ title: 'Doppler', artist: '  ' }, 'two')).toBe('Doppler');
  });

  it('flattens line breaks inside a name, so that the lines are the ones the setting says', () => {
    expect(overlayText({ title: 'A\nB', artist: 'C   D' }, 'two')).toBe('A B\nC D');
  });

  it('stays within what the player takes', () => {
    const long = overlayText({ title: 'x'.repeat(400), artist: 'y' }, 'one');
    expect(long).toHaveLength(MAX_TEXT);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('readUrl', () => {
  it('takes the address of the player as host and port, with or without http://', () => {
    expect(readUrl('192.168.68.30:3000')).toBe('http://192.168.68.30:3000');
    expect(readUrl(' http://192.168.68.30:3000/ ')).toBe('http://192.168.68.30:3000');
    expect(readUrl('https://wall.local/api/overlay')).toBe('https://wall.local');
  });

  it('refuses what is no address', () => {
    expect(() => readUrl('')).toThrow(/say where/);
    expect(() => readUrl('http://')).toThrow(/not an address/);
    expect(() => readUrl('ftp://wall')).toThrow(/http or https/);
    expect(() => readUrl(3000)).toThrow(/say where/);
  });
});

describe('readSettings', () => {
  it('starts off, so that nothing goes to the wall until it is switched on', () => {
    expect(DEFAULT_SETTINGS.enabled).toBe(false);
  });

  it('lays a change over the settings and leaves the rest', () => {
    const next = readSettings({ enabled: true, size: 12, vertical: 'top' }, settings());
    expect(next).toEqual(settings({ enabled: true, size: 12, vertical: 'top' }));
  });

  it('refuses what the player would refuse, and a key it does not know', () => {
    const bad: unknown[] = [
      { enabled: 'yes' },
      { size: 0 },
      { size: 51 },
      { size: 'big' },
      { vertical: 'middle' },
      { horizontal: 'centre' },
      { durationSeconds: -1 },
      { durationSeconds: 7200 },
      { color: '' },
      { color: 'a\nb' },
      { lines: 'three' },
      { titleFilter: '(' },
      { titleFilter: 5 },
      { titleFilter: 'x'.repeat(201) },
      { pin: 5 },
      { text: 'hello' },
    ];
    for (const change of bad) expect(() => readSettings(change, settings())).toThrow();
  });

  it('rounds the seconds and lets 0 mean: until the next track', () => {
    expect(readSettings({ durationSeconds: 7.6 }, settings()).durationSeconds).toBe(8);
    expect(readSettings({ durationSeconds: 0 }, settings()).durationSeconds).toBe(0);
  });
});

describe('VideoWallClient', () => {
  const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];
  const answering = (status: number, body: unknown = {}) =>
    (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;

  it('posts the text with its place, and leaves the PIN out when there is none', async () => {
    calls.length = 0;
    const client = new VideoWallClient(answering(200));
    await client.show(settings({ url: 'http://wall:3000', vertical: 'top', size: 9 }), 'Hello');
    expect(calls).toEqual([
      {
        url: 'http://wall:3000/api/overlay',
        method: 'POST',
        body: { text: 'Hello', color: '#ffffff', vertical: 'top', horizontal: 'left', size: 9 },
      },
    ]);
  });

  it('sends the PIN, and deletes with it', async () => {
    calls.length = 0;
    const client = new VideoWallClient(answering(200));
    await client.show(settings({ pin: '1234' }), 'Hello');
    await client.clear(settings({ pin: '1234' }));
    expect(calls[0]?.body.pin).toBe('1234');
    expect(calls[1]).toMatchObject({ method: 'DELETE', body: { pin: '1234' } });
  });

  it('says what went wrong, in words for the operator', async () => {
    await expect(new VideoWallClient(answering(401)).clear(settings())).rejects.toThrow(/PIN/);
    await expect(
      new VideoWallClient(answering(400, { error: 'text too long' })).show(settings(), 'x'),
    ).rejects.toThrow(/text too long/);
    await expect(new VideoWallClient(answering(500)).show(settings(), 'x')).rejects.toThrow(/500/);
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(new VideoWallClient(down).show(settings(), 'x')).rejects.toThrow(OverlayError);
    await expect(new VideoWallClient(down).show(settings(), 'x')).rejects.toThrow(/Cannot reach/);
  });
});

describe('the library of the player', () => {
  interface Seen {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: Record<string, unknown>;
  }
  const seen: Seen[] = [];
  const player = (answers: Record<string, unknown>, status = 200, type = 'application/json') =>
    (async (url: string, init: RequestInit) => {
      seen.push({
        url,
        method: init.method ?? 'GET',
        headers: (init.headers ?? {}) as Record<string, string>,
        ...(init.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}),
      });
      const path = url.replace(/^http:\/\/wall:3000/, '');
      const body = answers[path] ?? {};
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': type },
      });
    }) as unknown as typeof fetch;
  const wall = settings({ url: 'http://wall:3000' });

  it('reads the four lists into items for a page, and keeps only a preview path that is safe', async () => {
    seen.length = 0;
    const client = new VideoWallClient(
      player({
        '/api/videos': {
          videos: [
            {
              id: 'a',
              title: 'Liquid',
              type: 'video',
              loopLength: '30s',
              thumbnailUrl: '/media/a/x.thumb.jpg',
            },
            {
              id: 'b',
              title: 'Evil',
              type: 'video',
              loopLength: null,
              thumbnailUrl: '/media/../etc/passwd',
            },
            { title: 'No id' },
          ],
        },
        '/api/effects': { effects: [{ id: 'e', title: 'Tunnel', duration: 60 }] },
        '/api/texts': { texts: [{ id: 't', title: 'Hello', content: 'Welcome' }] },
        '/api/playlists': {
          playlists: [
            {
              id: 'p',
              title: 'All',
              count: 1,
              items: [{ id: 'a', title: 'Liquid', type: 'video' }],
            },
          ],
        },
      }),
    );
    const library = await client.library(wall);
    expect(seen.map((call) => call.url).sort()).toEqual([
      'http://wall:3000/api/effects',
      'http://wall:3000/api/playlists',
      'http://wall:3000/api/texts',
      'http://wall:3000/api/videos',
    ]);
    expect(library.videos).toEqual([
      { id: 'a', title: 'Liquid', type: 'video', detail: '30s', thumb: '/media/a/x.thumb.jpg' },
      { id: 'b', title: 'Evil', type: 'video', detail: '', thumb: null },
    ]);
    expect(library.effects[0]).toMatchObject({ id: 'e', type: 'effect', detail: '60 s' });
    expect(library.texts[0]).toMatchObject({ id: 't', detail: 'Welcome' });
    expect(library.playlists).toEqual([
      { id: 'p', title: 'All', count: 1, items: [{ id: 'a', title: 'Liquid' }] },
    ]);
  });

  it('sends the PIN as a header on a read', async () => {
    seen.length = 0;
    await new VideoWallClient(player({})).status({ ...wall, pin: '1234' });
    expect(seen[0]?.headers['x-pin']).toBe('1234');
    expect(seen[0]?.body).toBeUndefined();
  });

  it('reads the status, with what is not there as nothing', async () => {
    const client = new VideoWallClient(
      player({
        '/api/status': {
          playing: true,
          blackout: true,
          media: { id: 'a', title: 'Liquid', type: 'video' },
          playlist: null,
          currentTime: 6.5,
          duration: 20,
          transition: 'fade',
        },
      }),
    );
    expect(await client.status(wall)).toEqual({
      playing: true,
      blackout: true,
      media: { id: 'a', title: 'Liquid', type: 'video' },
      playlist: null,
      currentTime: 6.5,
      duration: 20,
      transition: 'fade',
    });
    expect(await new VideoWallClient(player({})).status(wall)).toMatchObject({
      playing: false,
      media: null,
      transition: null,
    });
  });

  it('plays, plays a playlist and blacks out with the calls the spec names', async () => {
    seen.length = 0;
    const client = new VideoWallClient(player({}));
    await client.play(wall, 'a', 'fade');
    await client.play(wall, 'b');
    await client.playPlaylist(wall, 'p');
    await client.blackout(wall, true);
    expect(seen.map((call) => [call.method, call.url.slice(16), call.body])).toEqual([
      ['POST', '/api/play', { videoId: 'a', transition: 'fade' }],
      ['POST', '/api/play', { videoId: 'b' }],
      ['POST', '/api/playlist', { playlistId: 'p' }],
      ['POST', '/api/blackout', { value: true }],
    ]);
  });

  it('passes on a picture, and only a picture below /media/', async () => {
    const jpeg = new VideoWallClient(player({ '/media/a.jpg': 'JPEG' }, 200, 'image/jpeg'));
    const picture = await jpeg.image(wall, '/media/a.jpg');
    expect(picture.type).toBe('image/jpeg');
    expect(picture.body.toString()).toBe('JPEG');
    await expect(jpeg.image(wall, '/api/status')).rejects.toThrow(OverlayError);
    await expect(jpeg.image(wall, '/media/../api/status')).rejects.toThrow(OverlayError);
    const page = new VideoWallClient(player({ '/media/x': '<html>' }, 200, 'text/html'));
    await expect(page.image(wall, '/media/x')).rejects.toThrow(/no picture/);
  });

  it('knows a path that is below /media/ and does not climb', () => {
    expect(isMediaPath('/media/a/b.thumb.jpg')).toBe(true);
    for (const bad of [
      '/api/x',
      '/media/../x',
      '/media/a?x=1',
      '/media/%2e%2e/x',
      '/media/a#b',
      'media/a',
    ]) {
      expect(isMediaPath(bad)).toBe(false);
    }
  });
});
