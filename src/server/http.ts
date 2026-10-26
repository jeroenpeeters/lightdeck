/**
 * HTTP side of the control pages, on Node's own http module.
 *
 *   GET  /                            goes to the deck
 *   GET  /deck                        the deck: the groups of the show with their scenes
 *   GET  /palettes                    the palettes of the show: their colours, and how they move
 *   GET  /tablet                      the page for a tablet at the side of the dance floor: the
 *                                     tap, the master, the parts of the evening, the looks of a group
 *                                     by mood with what goes with the mood in a tray under them
 *                                     (Jeroen, 2026-10-20), and a tab for the video wall. `/moods`
 *                                     (the page it was before) goes there
 *   GET  /videowall                   the settings of the text overlay of the video wall: whether the
 *                                     track that plays is sent to it, where, how big, for how long
 *   GET  /simulator                   the simulator: the fixtures drawn in 3D from the bytes
 *                                     being sent, with or without a bridge
 *   GET  /fixtures/<id>               the page of a fixture: the file
 *                                     `fixtures/<kind>.html` from `publicDir`
 *   GET  /...                         the other static files from `publicDir`
 *   GET  /api/state                   everything a browser needs to draw itself
 *   GET  /api/events                  server-sent events: `fixture`, `tempo`, `blackout`,
 *                                     `master`, `status`, `show`, `playback`, `sequence` (which
 *                                     sequence runs, and where), `rkbx` (what rekordbox says,
 *                                     see `RkbxFollower`), `output` (the settings of
 *                                     the output) and, while a
 *                                     fixture animates, `frame` with the bytes being sent
 *                                     and the beat
 *   POST /api/tempo                   `bpm`, `rate`, `sync`, `source` (`manual` or `rekordbox`)
 *   POST /api/rkbx                    `breakdown`: true or false, whether the effects are idle while
 *                                     rekordbox is in a breakdown phrase (Down or Bridge). Off at
 *                                     every start
 *   POST /api/videowall               any of `enabled`, `url`, `pin` (never given back), `durationSeconds`
 *                                     (0 is: until the next track), `vertical`, `horizontal`, `size`,
 *                                     `color`, `lines` (`one` or `two`): the settings of the video wall,
 *                                     kept in its own file. `POST /api/videowall/test` shows a sample,
 *                                     `/send` the track that plays now, `/clear` takes the text away.
 *                                     The wall's own playback (tablet): `GET /api/videowall/library`
 *                                     (videos, effects, texts, playlists) and `/status`, `GET
 *                                     /api/videowall/image?path=/media/...` (a preview picture, passed
 *                                     on), `POST /api/videowall/play` and `/playlist` (`id`, and
 *                                     `transition`) and `/blackout` (`value`)
 *   POST /api/output                  how the output is made: `maxFps`, the most frames per
 *                                     second (default 25), and `leadMs`, how far ahead of
 *                                     the beat it is made. Answers with both
 *   POST /api/blackout                `blackout`: true or false, for every fixture
 *   POST /api/master                  `master`: the grand master, 0 to 1, for every fixture
 *   POST /api/fixtures/<id>/update    partial state change of one fixture
 *   POST /api/fixtures/<id>/limits    what the show limits of the fixture, kept in the show file:
 *                                     for the spider `tilt`, a `{ min, max }` (0 to 1) per bar,
 *                                     which no tilt goes beyond. `{}` takes the limits away
 *   POST /api/fixtures/<id>/<action>  something the fixture can do, such as `reset`
 *   POST /api/sequence                `start`, the id of a sequence of the show, which sets its first
 *                                     step at once and goes on on the bars (it stops the one that
 *                                     runs), `next: true` (the next step now) or `stop: true`. A
 *                                     stop leaves the fixtures as they are
 *   POST /api/playback                `group` with one of: `scene`, the id of the scene of
 *                                     lights or motion to set the fixtures of the group to
 *                                     (only the properties of the type of the scene);
 *                                     `palette`, the id of a palette of the show, with
 *                                     `speed` if it should cycle at another pace than its
 *                                     own; `look`, the id of a look of the group, which sets
 *                                     the lanes it names; or `off`: true to darken the
 *                                     fixtures, which is the lights and nothing else
 *   POST /api/palettes                `label` and any of `colours` (each `#rrggbb`,
 *                                     `#rrggbbww` or `off`, eight at most), `mode` (static
 *                                     or cycle), `change` (step or fade) and `speed`: makes a
 *                                     palette of the show, and answers with its `id`
 *   POST /api/palettes/<id>/update    any of `label`, `colours`, `mode`, `change`, `speed`, `visible`
 *   POST /api/palettes/<id>/delete    refused while the palette is on in a group or a look
 *                                     uses it
 *   POST /api/groups                  `label` and `fixtures`, the ids of its fixtures:
 *                                     makes a group, and answers with its `id`
 *   POST /api/groups/<group>/rename   `label`
 *   POST /api/groups/<group>/delete   takes the group away, and its scenes and looks with it
 *   POST /api/groups/<group>/scenes   `label` and `type` (lights or motion): stores those
 *                                     properties of the fixtures of the group as they are as
 *                                     a new scene, and answers with its `id`
 *   POST /api/groups/<group>/looks    `label`: stores what is on in the group (the scene of
 *                                     lights, the palette, the scene of motion) as a look,
 *                                     and answers with its `id`
 *   POST /api/groups/<group>/looks/<look>/store    stores what is on now in this look
 *   POST /api/groups/<group>/looks/<look>/rename   `label`
 *   POST /api/groups/<group>/looks/<look>/delete
 *   POST /api/groups/<group>/scenes/<scene>/store    stores the properties of its type of
 *                                                    the fixtures of the group as they are
 *                                                    in this scene
 *   POST /api/groups/<group>/scenes/<scene>/rename   `label`
 *   POST /api/groups/<group>/scenes/<scene>/delete
 *
 * Every POST but the one with sound takes JSON and may carry `client`, which comes back as
 * `origin` in the event, so that a browser can skip its own echo.
 *
 * Browsers send changes with POST and hear about everyone's changes over the
 * event stream. There is no login: this is meant for the home network only.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, relative, sep } from 'node:path';
import { MAX_FLASH_HZ } from '../engine/effects.js';
import type { RkbxState } from '../inputs/rkbx/follower.js';
import { PatchError, readObject } from './fixture.js';
import type { PlaybackState, ShowSummary } from './playback.js';
import type { LinkStatus, OutputSettings, Rig, RigFixture } from './rig.js';
import type { SequenceState } from './sequencer.js';
import { MAX_BPM, MIN_BPM, RATES, type TempoState } from './tempo.js';
import type { VideoWallState } from './videoWall.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.jpg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const MAX_BODY_BYTES = 64 * 1024;
const KEEP_ALIVE_MS = 15_000;
const FIXTURE_PAGE = /^\/fixtures\/([a-z0-9-]+)$/;
const FIXTURE_POST = /^\/api\/fixtures\/([a-z0-9-]+)\/([a-z]+)$/;
const GROUP_POST = /^\/api\/groups\/([a-z0-9-]+)\/(rename|delete|scenes|looks)$/;
const SCENE_POST = /^\/api\/groups\/([a-z0-9-]+)\/scenes\/([a-z0-9-]+)\/(store|rename|delete)$/;
const LOOK_POST = /^\/api\/groups\/([a-z0-9-]+)\/looks\/([a-z0-9-]+)\/(store|rename|delete)$/;
const PALETTE_POST = /^\/api\/palettes\/([a-z0-9-]+)\/(update|delete)$/;
const VIDEOWALL_POST = /^\/api\/videowall\/(test|send|clear|play|playlist|blackout)$/;
const DECK = '/deck';
const VIDEOWALL = '/videowall';
const PALETTES = '/palettes';
const TABLET = '/tablet';
const MOODS = '/moods';
const INSTALL = '/install';
const SIMULATOR = '/simulator';

export interface HttpOptions {
  rig: Rig;
  publicDir: string;
  /** Shown in the UI so the operator knows which bridge this server talks to; null without one. */
  bridgeUrl: string | null;
}

interface StaticFile {
  body: Buffer;
  type: string;
}

/** Reads the public directory once. Only files found here can ever be served. */
function loadStatic(dir: string): Map<string, StaticFile> {
  const files = new Map<string, StaticFile>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      const type = CONTENT_TYPES[extname(entry)];
      if (!type) continue;
      const url = `/${relative(dir, path).split(sep).join('/')}`;
      files.set(url, { body: readFileSync(path), type });
    }
  };
  walk(dir);
  return files;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

function readBytes(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    // A body over the limit is read and thrown away, so that the answer can reach the sender.
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) chunks.length = 0;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > limit) reject(new PatchError('request body is too large'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const bytes = await readBytes(req, MAX_BODY_BYTES);
  let body: unknown;
  try {
    body = JSON.parse(bytes.toString('utf8') || '{}');
  } catch {
    throw new PatchError('request body is not valid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new PatchError('expected a JSON object');
  }
  return body as Record<string, unknown>;
}

/** What came with the request, without the name of the browser that sent it. */
function split(body: Record<string, unknown>): { change: unknown; origin: string | undefined } {
  const { client, ...change } = body;
  return { change, origin: typeof client === 'string' ? client : undefined };
}

/**
 * What a browser needs to draw a fixture. A fixture on DMX has its profile, its place on the
 * universe and its bytes; one that Home Assistant drives has none of those, and its lamps are
 * in `details`.
 */
function describeFixture(fixture: RigFixture) {
  const { id, kind, label, protocol, controller } = fixture;
  const common = {
    id,
    kind,
    label,
    protocol,
    details: controller.describe(),
    state: controller.getState(),
  };
  if (fixture.protocol !== 'dmx') return common;
  return {
    ...common,
    name: fixture.controller.profile.name,
    footprint: fixture.controller.profile.footprint,
    controls: fixture.controller.profile.controls,
    universe: fixture.universe,
    address: fixture.address,
    dmx: fixture.controller.getDmx(),
  };
}

function describeTempo(rig: Rig) {
  return { ...rig.tempo.getState(), beat: rig.tempo.getBeat() };
}

function describe({ rig, bridgeUrl }: HttpOptions) {
  return {
    fixtures: rig.fixtures.map(describeFixture),
    tempo: {
      ...describeTempo(rig),
      min: MIN_BPM,
      max: MAX_BPM,
      rates: RATES,
      // What the speed of an effect is held to, for a page to say what an effect gets.
      changesPerSecond: MAX_FLASH_HZ,
    },
    blackout: rig.getBlackout(),
    master: rig.getMaster(),
    status: rig.getStatus(),
    rkbx: rig.rkbx.getState(),
    videowall: rig.videoWall.getState(),
    output: rig.getOutput(),
    show: rig.playback.getShow(),
    playback: rig.playback.getState(),
    sequence: rig.sequencer.getState(),
    bridgeUrl,
  };
}

export function createHttpServer(options: HttpOptions): Server {
  const { rig } = options;
  const files = loadStatic(options.publicDir);
  const streams = new Set<ServerResponse>();

  const message = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const broadcast = (event: string, data: unknown) => {
    const text = message(event, data);
    for (const stream of streams) stream.write(text);
  };
  rig.on('fixture', (id: string, state: unknown, dmx: number[] | undefined, origin?: string) => {
    broadcast('fixture', { id, state, ...(dmx ? { dmx } : {}), origin: origin ?? null });
  });
  rig.on('frame', (id: string, dmx: number[], beat: number) => {
    if (streams.size > 0) broadcast('frame', { id, dmx, beat: Math.round(beat * 100) / 100 });
  });
  rig.on('tempo', (state: TempoState, beat: number, origin?: string) => {
    broadcast('tempo', { ...state, beat, origin: origin ?? null });
  });
  rig.on('blackout', (blackout: boolean, origin?: string) => {
    broadcast('blackout', { blackout, origin: origin ?? null });
  });
  rig.on('master', (master: number, origin?: string) => {
    broadcast('master', { master, origin: origin ?? null });
  });
  rig.on('status', (status: LinkStatus) => broadcast('status', status));
  rig.on('show', (show: ShowSummary) => broadcast('show', show));
  rig.on('playback', (state: PlaybackState) => broadcast('playback', state));
  rig.on('sequence', (state: SequenceState) => broadcast('sequence', state));
  rig.on('rkbx', (state: RkbxState) => broadcast('rkbx', state));
  rig.on('output', (settings: OutputSettings) => broadcast('output', settings));
  rig.on('videowall', (state: VideoWallState) => broadcast('videowall', state));

  const keepAlive = setInterval(() => {
    for (const stream of streams) stream.write(': keep-alive\n\n');
  }, KEEP_ALIVE_MS);

  const sendFile = (req: IncomingMessage, res: ServerResponse, path: string): boolean => {
    const file = files.get(path);
    if (!file) return false;
    res.writeHead(200, {
      'content-type': file.type,
      'content-length': file.body.length,
      'cache-control':
        path.startsWith('/fonts/') || path.startsWith('/lib/')
          ? 'public, max-age=604800'
          : path.startsWith('/room/')
            ? 'public, max-age=3600'
            : 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : file.body);
    return true;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/api/state') {
      sendJson(res, 200, describe(options));
      return;
    }

    if (req.method === 'GET' && path === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 1000\n\n');
      streams.add(res);
      // A browser that reconnects gets the current picture straight away.
      for (const fixture of rig.fixtures) {
        res.write(
          message('fixture', {
            id: fixture.id,
            state: fixture.controller.getState(),
            ...(fixture.protocol === 'dmx' ? { dmx: fixture.controller.getDmx() } : {}),
            origin: null,
          }),
        );
      }
      res.write(message('tempo', { ...describeTempo(rig), origin: null }));
      res.write(message('blackout', { blackout: rig.getBlackout(), origin: null }));
      res.write(message('master', { master: rig.getMaster(), origin: null }));
      res.write(message('status', rig.getStatus()));
      res.write(message('show', rig.playback.getShow()));
      res.write(message('playback', rig.playback.getState()));
      res.write(message('sequence', rig.sequencer.getState()));
      res.write(message('rkbx', rig.rkbx.getState()));
      res.write(message('output', rig.getOutput()));
      res.write(message('videowall', rig.videoWall.getState()));
      req.on('close', () => streams.delete(res));
      return;
    }

    if (req.method === 'POST' && path === '/api/output') {
      const { change } = split(await readJson(req));
      sendJson(res, 200, { ok: true, output: rig.setOutput(change) });
      return;
    }

    if (req.method === 'POST' && path === '/api/videowall') {
      const { change } = split(await readJson(req));
      rig.videoWall.update(change);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && VIDEOWALL_POST.test(path)) {
      const body = await readJson(req);
      const action = path.slice('/api/videowall/'.length);
      if (action === 'test') await rig.videoWall.test();
      else if (action === 'send') await rig.videoWall.sendCurrent();
      else if (action === 'clear') await rig.videoWall.clear();
      else if (action === 'blackout') await rig.videoWall.blackout(body.value);
      else if (action === 'play') await rig.videoWall.play(body.id, body.transition);
      else await rig.videoWall.playPlaylist(body.id, body.transition);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && path === '/api/videowall/library') {
      sendJson(res, 200, await rig.videoWall.library());
      return;
    }

    if (req.method === 'GET' && path === '/api/videowall/status') {
      sendJson(res, 200, await rig.videoWall.status());
      return;
    }

    if (req.method === 'GET' && path === '/api/videowall/image') {
      const picture = await rig.videoWall.image(url.searchParams.get('path') ?? '');
      res.writeHead(200, {
        'content-type': picture.type,
        'content-length': picture.body.length,
        'cache-control': 'private, max-age=3600',
      });
      res.end(picture.body);
      return;
    }

    if (req.method === 'POST' && path === '/api/rkbx') {
      const { change } = split(await readJson(req));
      rig.rkbx.update(change);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && path === '/api/tempo') {
      const { change, origin } = split(await readJson(req));
      rig.tempo.update(change, origin);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && path === '/api/blackout') {
      const body = await readJson(req);
      rig.setBlackout(body.blackout, split(body).origin);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && path === '/api/master') {
      const body = await readJson(req);
      rig.setMaster(body.master, split(body).origin);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && path === '/api/sequence') {
      const { change } = split(await readJson(req));
      const { start, stop, next } = readObject(change, 'the sequence', ['start', 'stop', 'next']);
      if ([start, stop, next].filter((given) => given !== undefined).length !== 1) {
        throw new PatchError('say which sequence to start, or stop: true, or next: true');
      }
      if (start !== undefined) {
        rig.sequencer.start(start);
      } else if (next !== undefined) {
        if (next !== true) throw new PatchError('"next" can only be true');
        rig.sequencer.next();
      } else {
        if (stop !== true) throw new PatchError('"stop" can only be true');
        rig.sequencer.stop();
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && path === '/api/playback') {
      const { change, origin } = split(await readJson(req));
      const { group, scene, palette, speed, look, off } = readObject(change, 'the playback', [
        'group',
        'scene',
        'palette',
        'speed',
        'look',
        'off',
      ]);
      const named = [scene, palette, look, off].filter((each) => each !== undefined).length;
      if (named > 1) throw new PatchError('say a scene, a palette, a look or off, one of them');
      if (speed !== undefined && palette === undefined) {
        throw new PatchError('a speed goes with a palette');
      }
      if (palette !== undefined) {
        rig.playback.setPalette(group, palette, speed, origin);
      } else if (look !== undefined) {
        rig.playback.playLook(group, look, origin);
      } else if (off !== undefined) {
        if (off !== true) throw new PatchError('"off" can only be true');
        rig.playback.off(group, origin);
      } else {
        rig.playback.recall(group, scene, origin);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && path === '/api/palettes') {
      const { label, ...fields } = await readJson(req);
      const { client: _client, ...rest } = fields;
      sendJson(res, 200, {
        ok: true,
        id: rig.playback.addPalette(label, Object.keys(rest).length === 0 ? undefined : rest),
      });
      return;
    }

    const palette = req.method === 'POST' ? PALETTE_POST.exec(path) : null;
    if (palette) {
      const id = palette[1] ?? '';
      const body = await readJson(req);
      if (palette[2] === 'update') rig.playback.updatePalette(id, split(body).change);
      else rig.playback.removePalette(id);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && path === '/api/groups') {
      const body = await readJson(req);
      sendJson(res, 200, { ok: true, id: rig.playback.addGroup(body.label, body.fixtures) });
      return;
    }

    const group = req.method === 'POST' ? GROUP_POST.exec(path) : null;
    if (group) {
      const id = group[1] ?? '';
      const body = await readJson(req);
      if (group[2] === 'scenes') {
        sendJson(res, 200, { ok: true, id: rig.playback.store(id, body.type, body.label) });
        return;
      }
      if (group[2] === 'looks') {
        sendJson(res, 200, { ok: true, id: rig.playback.storeLook(id, body.label) });
        return;
      }
      if (group[2] === 'rename') rig.playback.renameGroup(id, body.label);
      else rig.playback.removeGroup(id);
      sendJson(res, 200, { ok: true });
      return;
    }

    const scene = req.method === 'POST' ? SCENE_POST.exec(path) : null;
    if (scene) {
      const [, of = '', id = '', action] = scene;
      const body = await readJson(req);
      if (action === 'store') rig.playback.storeOver(of, id);
      else if (action === 'rename') rig.playback.rename(of, id, body.label);
      else rig.playback.remove(of, id);
      sendJson(res, 200, { ok: true });
      return;
    }

    const look = req.method === 'POST' ? LOOK_POST.exec(path) : null;
    if (look) {
      const [, of = '', id = '', action] = look;
      const body = await readJson(req);
      if (action === 'store') rig.playback.storeLookOver(of, id);
      else if (action === 'rename') rig.playback.renameLook(of, id, body.label);
      else rig.playback.removeLook(of, id);
      sendJson(res, 200, { ok: true });
      return;
    }

    const post = req.method === 'POST' ? FIXTURE_POST.exec(path) : null;
    const fixture = post ? rig.find(post[1] ?? '') : undefined;
    if (post && fixture) {
      const action = post[2] ?? '';
      const { change, origin } = split(await readJson(req));
      if (action === 'update') fixture.controller.update(change, origin);
      else if (action === 'limits') rig.playback.setLimits(fixture.id, change);
      else fixture.controller.act(action, origin);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (path === '/') {
        res.writeHead(302, { location: DECK, 'cache-control': 'no-store' });
        res.end();
        return;
      }
      if (path === DECK && sendFile(req, res, '/deck.html')) return;
      if (path === PALETTES && sendFile(req, res, '/palettes.html')) return;
      if (path === VIDEOWALL && sendFile(req, res, '/videowall.html')) return;
      if (path === TABLET && sendFile(req, res, '/tablet.html')) return;
      if (path === MOODS) {
        // The page for moods is the tablet page now; an old bookmark goes there.
        res.writeHead(302, { location: TABLET, 'cache-control': 'no-store' });
        res.end();
        return;
      }
      if (path === INSTALL && sendFile(req, res, '/install.html')) return;
      if (path === SIMULATOR && sendFile(req, res, '/simulator.html')) return;
      const page = FIXTURE_PAGE.exec(path);
      const shown = page ? rig.find(page[1] ?? '') : undefined;
      if (shown && sendFile(req, res, `/fixtures/${shown.kind}.html`)) return;
      if (!page && sendFile(req, res, path)) return;
    }

    sendJson(res, 404, { error: `nothing at ${path}` });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof PatchError) sendJson(res, 400, { error: error.message });
      else sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  server.on('close', () => {
    clearInterval(keepAlive);
    for (const stream of streams) stream.end();
    streams.clear();
  });
  return server;
}
