import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHttpServer } from './http.js';
import { Rig } from './rig.js';
import { RecordingOutput } from './testing.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), 'public');

/** What the routes of the video wall do, against a player that is a function. */
describe('the video wall routes', () => {
  let rig: Rig;
  let server: Server;
  let base: string;
  const asked: { method: string; url: string; body: string }[] = [];
  let status = 200;

  const player = (async (url: string, init: RequestInit) => {
    asked.push({ method: init.method ?? 'GET', url, body: String(init.body ?? '') });
    const path = url.replace('http://wall:3000', '');
    if (path === '/media/a/x.thumb.jpg') {
      return new Response('JPEG', { status, headers: { 'content-type': 'image/jpeg' } });
    }
    const bodies: Record<string, unknown> = {
      '/api/videos': {
        videos: [{ id: 'a', title: 'Liquid', thumbnailUrl: '/media/a/x.thumb.jpg' }],
      },
      '/api/effects': { effects: [] },
      '/api/texts': { texts: [] },
      '/api/playlists': { playlists: [] },
      '/api/status': { playing: true, media: { id: 'a', title: 'Liquid', type: 'video' } },
    };
    return new Response(JSON.stringify(bodies[path] ?? { error: 'nothing here' }), {
      status: path in bodies || init.method === 'POST' ? status : 404,
    });
  }) as unknown as typeof fetch;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    asked.length = 0;
    status = 200;
    rig = new Rig({
      output: new RecordingOutput(),
      fixtures: [{ id: 'spider', kind: 'spider', label: 'Spider', universe: 0, address: 1 }],
      videoWallFetch: player,
    });
    rig.videoWall.update({ url: 'http://wall:3000' });
    server = createHttpServer({ rig, publicDir: PUBLIC, bridgeUrl: null });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    rig.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('gives the library and the status of the player', async () => {
    const library = (await (await fetch(`${base}/api/videowall/library`)).json()) as {
      videos: { id: string; thumb: string }[];
    };
    expect(library.videos).toEqual([
      { id: 'a', title: 'Liquid', type: 'video', detail: '', thumb: '/media/a/x.thumb.jpg' },
    ]);
    const state = (await (await fetch(`${base}/api/videowall/status`)).json()) as {
      media: { id: string };
    };
    expect(state.media.id).toBe('a');
  });

  it('plays, plays a playlist and blacks out, and refuses what is not an id or a boolean', async () => {
    expect((await post('/api/videowall/play', { id: 'a', transition: 'fade' })).status).toBe(200);
    expect((await post('/api/videowall/playlist', { id: 'p' })).status).toBe(200);
    expect((await post('/api/videowall/blackout', { value: true })).status).toBe(200);
    expect(asked.map((call) => [call.url.slice(16), call.body])).toEqual([
      ['/api/play', '{"videoId":"a","transition":"fade"}'],
      ['/api/playlist', '{"playlistId":"p"}'],
      ['/api/blackout', '{"value":true}'],
    ]);
    expect((await post('/api/videowall/play', {})).status).toBe(400);
    expect((await post('/api/videowall/blackout', { value: 'yes' })).status).toBe(400);
  });

  it('passes a preview picture on, and only from below /media/', async () => {
    const picture = await fetch(
      `${base}/api/videowall/image?path=${encodeURIComponent('/media/a/x.thumb.jpg')}`,
    );
    expect(picture.status).toBe(200);
    expect(picture.headers.get('content-type')).toBe('image/jpeg');
    expect(await picture.text()).toBe('JPEG');
    asked.length = 0;
    for (const bad of ['/api/status', '/media/../api/status', '']) {
      const answer = await fetch(`${base}/api/videowall/image?path=${encodeURIComponent(bad)}`);
      expect(answer.status).toBe(400);
    }
    expect(asked).toEqual([]);
  });

  it('says what the player said when it refuses', async () => {
    status = 500;
    const answer = await post('/api/videowall/play', { id: 'a' });
    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { error: string }).error).toMatch(/video wall/);
  });
});
