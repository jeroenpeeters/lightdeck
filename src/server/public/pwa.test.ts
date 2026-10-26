import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpServer } from '../http.js';
import { Rig } from '../rig.js';
import { RecordingOutput } from '../testing.js';

const PUBLIC = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(PUBLIC, name));

interface Icon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}
const manifest = JSON.parse(read('manifest.webmanifest').toString()) as {
  name: string;
  short_name: string;
  id: string;
  start_url: string;
  scope: string;
  display: string;
  display_override: string[];
  background_color: string;
  theme_color: string;
  icons: Icon[];
};

/** The width and the height a PNG says it has, from its header. */
function pngSize(file: Buffer): [number, number] {
  expect(file.subarray(1, 4).toString()).toBe('PNG');
  return [file.readUInt32BE(16), file.readUInt32BE(20)];
}

describe('the manifest of the tablet app', () => {
  it('is an app that opens the tablet page full screen', () => {
    expect(manifest.name).toBe('Lightdeck');
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.start_url).toBe('/tablet');
    expect(manifest.id).toBe('/tablet');
    expect(manifest.display).toBe('standalone');
    // Full screen where the browser lets an app have it (no status bar either), else standalone.
    expect(manifest.display_override).toEqual(['fullscreen', 'standalone']);
    // The scope is the whole site, so that the deck and the pages of the fixtures stay in the app.
    expect(manifest.scope).toBe('/');
  });

  it('has the colours of the console, the same as the page', () => {
    const html = read('tablet.html').toString();
    expect(html).toContain(`content="${manifest.theme_color}"`);
    expect(manifest.background_color).toBe(manifest.theme_color);
  });

  it('has icons of the sizes an install asks for, which are there, and are as large as they say', () => {
    const sizes = manifest.icons.map((icon) => icon.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
    expect(manifest.icons.some((icon) => icon.purpose === 'any')).toBe(true);
    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png');
      const [width, height] = pngSize(read(icon.src.slice(1)));
      expect(`${width}x${height}`).toBe(icon.sizes);
    }
  });
});

describe('the page of the tablet', () => {
  const html = read('tablet.html').toString();

  it('points to the manifest and to icons that are there', () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    const touch = /rel="apple-touch-icon" href="([^"]+)"/.exec(html)?.[1];
    expect(touch).toBeDefined();
    expect(pngSize(read((touch as string).slice(1)))).toEqual([180, 180]);
    // A browser on an iPad takes these for an app of its own.
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('viewport-fit=cover');
  });

  it('has a key for full screen, for where the page is not installed', () => {
    expect(html).toContain('id="t-full"');
    const script = read('tabletParts.js').toString();
    expect(script).toContain('requestFullscreen');
    expect(script).toContain("navigationUI: 'hide'");
    // ... and not in the tablet app, which is full screen and says so in its user agent.
    expect(script).toContain("includes('LightdeckTablet')");
    const app = readFileSync(
      join(PUBLIC, '../../../android-tablet/src/nl/lightdeck/tablet/MainActivity.java'),
      'utf8',
    );
    expect(app).toContain('LightdeckTablet/1');
  });

  it('has the design of the console, with its fonts from the app and nothing from elsewhere', () => {
    expect(html).toContain('href="/plex.css"');
    expect(html).toContain('href="/lightdeck.css"');
    expect(html).not.toMatch(/(?:href|src)="https?:/);
    const fonts = read('plex.css').toString();
    for (const name of fonts.match(/\/fonts\/[a-z0-9-]+\.woff2/g) ?? []) {
      expect(read(name.slice(1)).length, name).toBeGreaterThan(1000);
    }
    expect(fonts).not.toMatch(/https?:/);
  });

  it('registers the service worker, where the browser has one', () => {
    // The page calls registerWorker of tabletParts.js.
    expect(read('tablet.js').toString()).toContain('registerWorker()');
    const script = read('tabletParts.js').toString();
    expect(script).toContain("'serviceWorker' in navigator");
    expect(script).toContain("register('/sw.js')");
  });
});

describe('the service worker', () => {
  type Listener = (event: unknown) => void;
  let listeners: Record<string, Listener>;
  let store: Map<string, Response>;
  let network: (request: unknown) => Promise<Response>;
  let deleted: string[];
  let claimed: boolean;

  beforeEach(() => {
    listeners = {};
    store = new Map();
    deleted = [];
    claimed = false;
    network = async () => new Response('from the network');
    const cache = {
      put: async (request: { url: string }, response: Response) => {
        store.set(request.url, response);
      },
      match: async (request: { url: string }) => store.get(request.url)?.clone(),
    };
    const context = vm.createContext({
      self: {
        location: { origin: 'http://lightdeck:8080' },
        addEventListener: (type: string, listener: Listener) => {
          listeners[type] = listener;
        },
        skipWaiting: () => {},
        clients: {
          claim: async () => {
            claimed = true;
          },
        },
      },
      caches: {
        open: async () => cache,
        keys: async () => ['lightdeck-tablet-v0', 'lightdeck-tablet-v1'],
        delete: async (name: string) => {
          deleted.push(name);
        },
      },
      fetch: (request: unknown) => network(request),
      URL,
    });
    vm.runInContext(read('sw.js').toString(), context);
  });

  /** What the worker does with a request: the answer it gives, or nothing, which leaves it to the browser. */
  async function ask(url: string, method = 'GET') {
    const respond = vi.fn();
    listeners.fetch?.({ request: { url, method }, respondWith: respond });
    return respond.mock.calls.length === 0 ? undefined : await respond.mock.calls[0]?.[0];
  }

  it('keeps only the pieces of the page for a tablet', async () => {
    for (const path of [
      '/tablet',
      '/tablet.js',
      '/tablet.css',
      '/tabletKit.js',
      '/tabletParts.js',
      '/tabletRail.js',
      '/tabletLogic.js',
      '/spiderPose.js',
      '/videowallPanel.js',
      '/videowall.css',
      '/lightdeck.css',
      '/plex.css',
      '/shell.js',
      '/ui.js',
      '/changes.js',
      '/manifest.webmanifest',
      '/fonts/barlow-500.woff2',
      '/fonts/plex-condensed-500.woff2',
      '/icons/icon-192.png',
    ]) {
      expect(await ask(`http://lightdeck:8080${path}`), path).toBeInstanceOf(Response);
    }
  });

  it('never touches the API, the event stream, another page, a post or another site', async () => {
    for (const path of [
      '/api/events',
      '/api/state',
      '/api/sequence',
      '/deck',
      '/deck.js',
      '/simulator',
      '/fixtures/spider',
      '/lib/three/three.module.min.js',
      '/sw.js',
    ]) {
      expect(await ask(`http://lightdeck:8080${path}`), path).toBeUndefined();
    }
    expect(await ask('http://lightdeck:8080/tablet', 'POST')).toBeUndefined();
    expect(await ask('http://lightdeck:8080/api/playback', 'POST')).toBeUndefined();
    expect(await ask('http://elsewhere.example/tablet.js')).toBeUndefined();
  });

  it('answers from the network first, and keeps what it got', async () => {
    const answer = (await ask('http://lightdeck:8080/tablet.js')) as Response;
    expect(await answer.text()).toBe('from the network');
    expect(store.has('http://lightdeck:8080/tablet.js')).toBe(true);
  });

  it('uses what it kept only when the network does not answer', async () => {
    await ask('http://lightdeck:8080/tablet.js');
    network = async () => {
      throw new TypeError('network error');
    };
    const answer = (await ask('http://lightdeck:8080/tablet.js')) as Response;
    expect(await answer.text()).toBe('from the network');
    // A change of lightdeck is what loads while it can be reached.
    network = async () => new Response('the new page');
    const fresh = (await ask('http://lightdeck:8080/tablet.js')) as Response;
    expect(await fresh.text()).toBe('the new page');
  });

  it('lets the failure through when there is nothing kept', async () => {
    network = async () => {
      throw new TypeError('network error');
    };
    await expect(ask('http://lightdeck:8080/tablet.css')).rejects.toThrow('network error');
  });

  it('does not keep an answer that is an error', async () => {
    network = async () => new Response('gone', { status: 500 });
    await ask('http://lightdeck:8080/tablet.js');
    expect(store.size).toBe(0);
  });

  it('takes the old caches away and the pages over when it starts', async () => {
    let done: Promise<unknown> | undefined;
    listeners.activate?.({
      waitUntil: (promise: Promise<unknown>) => {
        done = promise;
      },
    });
    await done;
    expect(deleted).toEqual(['lightdeck-tablet-v0']);
    expect(claimed).toBe(true);
  });
});

describe('serving the app', () => {
  let rig: Rig;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    rig = new Rig({
      output: new RecordingOutput(),
      fixtures: [{ id: 'spider', kind: 'spider', label: 'Spider', universe: 0, address: 1 }],
    });
    server = createHttpServer({ rig, publicDir: PUBLIC, bridgeUrl: null });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    rig.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('serves the page that says why the app cannot be installed, at a short address', async () => {
    const page = await fetch(`${base}/install`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('rel="manifest"');
    const script = await (await fetch(`${base}/install.js`)).text();
    expect(script).toContain('beforeinstallprompt');
    expect(script).toContain('isSecureContext');
  });

  it('serves the manifest as a manifest, the icons as images and the worker as a script', async () => {
    const served = await fetch(`${base}/manifest.webmanifest`);
    expect(served.headers.get('content-type')).toMatch(/^application\/manifest\+json/);
    expect(((await served.json()) as { start_url: string }).start_url).toBe('/tablet');

    const icon = await fetch(`${base}/icons/icon-512.png`);
    expect(icon.headers.get('content-type')).toBe('image/png');
    expect(pngSize(Buffer.from(await icon.arrayBuffer()))).toEqual([512, 512]);

    const worker = await fetch(`${base}/sw.js`);
    expect(worker.headers.get('content-type')).toMatch(/^text\/javascript/);
    // A worker that is cached by the browser is a worker that cannot be updated.
    expect(worker.headers.get('cache-control')).toBe('no-cache');
  });

  it('sends an old bookmark of /moods to the tablet page', async () => {
    const answer = await fetch(`${base}/moods`, { redirect: 'manual' });
    expect(answer.status).toBe(302);
    expect(answer.headers.get('location')).toBe('/tablet');
  });

  it('still serves the tablet page', async () => {
    const page = await fetch(`${base}/tablet`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('rel="manifest"');
  });
});
