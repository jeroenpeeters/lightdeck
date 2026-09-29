/**
 * HTTP side of the control pages, on Node's own http module.
 *
 *   GET  /                            goes to the page of the first fixture
 *   GET  /fixtures/<id>               the page of a fixture: the file
 *                                     `fixtures/<kind>.html` from `publicDir`
 *   GET  /...                         the other static files from `publicDir`
 *   GET  /api/state                   everything a browser needs to draw itself
 *   GET  /api/events                  server-sent events: `fixture`, `tempo`, `blackout`,
 *                                     `status` and, while a fixture animates, `frame`
 *                                     with the bytes being sent and the beat
 *   POST /api/tempo                   `bpm`, `rate`, `sync`
 *   POST /api/blackout                `blackout`: true or false, for every fixture
 *   POST /api/fixtures/<id>/update    partial state change of one fixture
 *   POST /api/fixtures/<id>/<action>  something the fixture can do, such as `reset`
 *
 * Every POST takes JSON and may carry `client`, which comes back as `origin` in the
 * event, so that a browser can skip its own echo.
 *
 * Browsers send changes with POST and hear about everyone's changes over the
 * event stream. There is no login: this is meant for the home network only.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, relative, sep } from 'node:path';
import { PatchError } from './fixture.js';
import type { LinkStatus, Rig, RigFixture } from './rig.js';
import { MAX_BPM, MIN_BPM, RATES, type TempoState } from './tempo.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const MAX_BODY_BYTES = 64 * 1024;
const KEEP_ALIVE_MS = 15_000;
const FIXTURE_PAGE = /^\/fixtures\/([a-z0-9-]+)$/;
const FIXTURE_POST = /^\/api\/fixtures\/([a-z0-9-]+)\/([a-z]+)$/;

export interface HttpOptions {
  rig: Rig;
  publicDir: string;
  /** Shown in the UI so the operator knows which bridge this server talks to. */
  bridgeUrl: string;
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

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new PatchError('request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        reject(new PatchError('request body is not valid JSON'));
        return;
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        reject(new PatchError('expected a JSON object'));
        return;
      }
      resolve(body as Record<string, unknown>);
    });
    req.on('error', reject);
  });
}

/** What came with the request, without the name of the browser that sent it. */
function split(body: Record<string, unknown>): { change: unknown; origin: string | undefined } {
  const { client, ...change } = body;
  return { change, origin: typeof client === 'string' ? client : undefined };
}

function describeFixture({ id, kind, label, universe, address, controller }: RigFixture) {
  return {
    id,
    kind,
    label,
    name: controller.profile.name,
    footprint: controller.profile.footprint,
    controls: controller.profile.controls,
    universe,
    address,
    details: controller.describe(),
    state: controller.getState(),
    dmx: controller.getDmx(),
  };
}

function describeTempo(rig: Rig) {
  return { ...rig.tempo.getState(), beat: rig.tempo.getBeat() };
}

function describe({ rig, bridgeUrl }: HttpOptions) {
  return {
    fixtures: rig.fixtures.map(describeFixture),
    tempo: { ...describeTempo(rig), min: MIN_BPM, max: MAX_BPM, rates: RATES },
    blackout: rig.getBlackout(),
    status: rig.getStatus(),
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
  rig.on('fixture', (id: string, state: unknown, dmx: number[], origin?: string) => {
    broadcast('fixture', { id, state, dmx, origin: origin ?? null });
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
  rig.on('status', (status: LinkStatus) => broadcast('status', status));

  const keepAlive = setInterval(() => {
    for (const stream of streams) stream.write(': keep-alive\n\n');
  }, KEEP_ALIVE_MS);

  const sendFile = (req: IncomingMessage, res: ServerResponse, path: string): boolean => {
    const file = files.get(path);
    if (!file) return false;
    res.writeHead(200, {
      'content-type': file.type,
      'content-length': file.body.length,
      'cache-control': path.startsWith('/fonts/') ? 'public, max-age=604800' : 'no-cache',
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
      for (const { id, controller } of rig.fixtures) {
        res.write(
          message('fixture', {
            id,
            state: controller.getState(),
            dmx: controller.getDmx(),
            origin: null,
          }),
        );
      }
      res.write(message('tempo', { ...describeTempo(rig), origin: null }));
      res.write(message('blackout', { blackout: rig.getBlackout(), origin: null }));
      res.write(message('status', rig.getStatus()));
      req.on('close', () => streams.delete(res));
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

    const post = req.method === 'POST' ? FIXTURE_POST.exec(path) : null;
    const fixture = post ? rig.find(post[1] ?? '') : undefined;
    if (post && fixture) {
      const action = post[2] ?? '';
      const { change, origin } = split(await readJson(req));
      if (action === 'update') fixture.controller.update(change, origin);
      else fixture.controller.act(action, origin);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const first = rig.fixtures[0];
      if (path === '/' && first) {
        res.writeHead(302, { location: `/fixtures/${first.id}`, 'cache-control': 'no-store' });
        res.end();
        return;
      }
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
