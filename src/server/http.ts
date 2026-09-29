/**
 * HTTP side of the spider UI, on Node's own http module.
 *
 *   GET  /                static page and its assets from `publicDir`
 *   GET  /api/state       everything a browser needs to draw itself
 *   GET  /api/events      server-sent events: `state` (with the beat the tempo is on),
 *                         `status` and, while an effect runs, `frame` with the bytes
 *                         being sent and the beat
 *   POST /api/update      partial state change, JSON
 *   POST /api/reset       reset the fixture
 *
 * Browsers send changes with POST and hear about everyone's changes over the
 * event stream. There is no login: this is meant for the home network only.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, relative, sep } from 'node:path';
import { EFFECTS } from '../engine/effects.js';
import {
  type LinkStatus,
  MAX_BPM,
  MIN_BPM,
  PatchError,
  RATES,
  type SpiderController,
  type SpiderState,
  type StatePatch,
} from './controller.js';

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

export interface HttpOptions {
  controller: SpiderController;
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

function readJson(req: IncomingMessage): Promise<unknown> {
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
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new PatchError('request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function describe(options: HttpOptions) {
  const { controller } = options;
  return {
    fixture: {
      id: controller.profile.id,
      name: controller.profile.name,
      footprint: controller.profile.footprint,
      controls: controller.profile.controls,
      layout: controller.layout,
    },
    effects: EFFECTS.map(({ id, name, description, colours, moves }) => ({
      id,
      name,
      description,
      colours,
      moves,
    })),
    tempo: { min: MIN_BPM, max: MAX_BPM, rates: RATES },
    config: {
      universe: controller.universe,
      address: controller.address,
      bridgeUrl: options.bridgeUrl,
    },
    state: controller.getState(),
    dmx: controller.getDmx(),
    beat: controller.getBeat(),
    status: controller.getStatus(),
  };
}

export function createHttpServer(options: HttpOptions): Server {
  const { controller } = options;
  const files = loadStatic(options.publicDir);
  const streams = new Set<ServerResponse>();

  const broadcast = (event: string, data: unknown) => {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const stream of streams) stream.write(message);
  };
  controller.on('state', (state: SpiderState, origin?: string) => {
    broadcast('state', {
      state,
      dmx: controller.getDmx(),
      beat: controller.getBeat(),
      origin: origin ?? null,
    });
  });
  controller.on('status', (status: LinkStatus) => broadcast('status', status));
  controller.on('frame', (dmx: number[], beat: number) => {
    if (streams.size > 0) broadcast('frame', { dmx, beat: Math.round(beat * 100) / 100 });
  });

  const keepAlive = setInterval(() => {
    for (const stream of streams) stream.write(': keep-alive\n\n');
  }, KEEP_ALIVE_MS);

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
      res.write(
        `event: state\ndata: ${JSON.stringify({ state: controller.getState(), dmx: controller.getDmx(), beat: controller.getBeat(), origin: null })}\n\n`,
      );
      res.write(`event: status\ndata: ${JSON.stringify(controller.getStatus())}\n\n`);
      req.on('close', () => streams.delete(res));
      return;
    }

    if (req.method === 'POST' && path === '/api/update') {
      const body = (await readJson(req)) as StatePatch & { client?: unknown };
      if (typeof body !== 'object' || body === null) throw new PatchError('expected a JSON object');
      const origin = typeof body.client === 'string' ? body.client : undefined;
      controller.update(body, origin);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && path === '/api/reset') {
      controller.resetFixture();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const file = files.get(path === '/' ? '/index.html' : path);
      if (file) {
        res.writeHead(200, {
          'content-type': file.type,
          'content-length': file.body.length,
          'cache-control': path.startsWith('/fonts/') ? 'public, max-age=604800' : 'no-cache',
        });
        res.end(req.method === 'HEAD' ? undefined : file.body);
        return;
      }
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
