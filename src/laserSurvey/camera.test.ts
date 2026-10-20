import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CameraError, cameraUrl, HttpCamera, SETTINGS_HEADER } from './camera.js';

let server: Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

async function app(
  handler: (
    url: URL,
    method: string,
  ) => { status?: number; body: string | Uint8Array; headers?: Record<string, string> },
): Promise<HttpCamera> {
  server = createServer((req, res) => {
    const {
      status = 200,
      body,
      headers = {},
    } = handler(new URL(req.url ?? '/', 'http://x'), req.method ?? '');
    res.writeHead(status, headers);
    res.end(body);
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  return new HttpCamera(`127.0.0.1:${(server.address() as AddressInfo).port}`);
}

describe('cameraUrl', () => {
  it('adds the scheme and the port of the app', () => {
    expect(cameraUrl('192.168.68.102')).toBe('http://192.168.68.102:9020');
    expect(cameraUrl('192.168.68.102:9999/')).toBe('http://192.168.68.102:9999');
    expect(cameraUrl('http://phone.local')).toBe('http://phone.local:9020');
    expect(() => cameraUrl('')).toThrow(CameraError);
  });
});

describe('HttpCamera', () => {
  it('reads the status and sends settings as a query', async () => {
    const seen: string[] = [];
    const camera = await app((url, method) => {
      seen.push(`${method} ${url.pathname}${url.search}`);
      return { body: JSON.stringify({ ready: true, iso: 100 }) };
    });
    expect(await camera.status()).toMatchObject({ ready: true });
    await camera.configure({ iso: 200, exposureMs: 50, focus: 0.5 });
    expect(seen).toEqual(['GET /status', 'POST /settings?iso=200&exposureMs=50&focus=0.5']);
  });

  it('gets a photo with what the phone says it used', async () => {
    const camera = await app(() => ({
      body: Uint8Array.of(1, 2, 3),
      headers: { [SETTINGS_HEADER]: JSON.stringify({ iso: 100, exposureMs: 99.9 }) },
    }));
    const photo = await camera.photo();
    expect([...photo.data]).toEqual([1, 2, 3]);
    expect(photo.settings).toEqual({ iso: 100, exposureMs: 99.9 });
  });

  it('asks for a clip of a length', async () => {
    let query = '';
    const camera = await app((url) => {
      query = url.search;
      return { body: Uint8Array.of(9) };
    });
    await camera.clip(10);
    expect(query).toBe('?seconds=10');
    await expect(camera.clip(0)).rejects.toThrow(CameraError);
  });

  it('turns the reason of the app into the error', async () => {
    const camera = await app(() => ({
      status: 503,
      body: 'camera is not open: bring the app to the screen',
    }));
    await expect(camera.photo()).rejects.toThrow(/bring the app to the screen/);
  });

  it('says so when it cannot reach the app', async () => {
    const camera = new HttpCamera('127.0.0.1:1');
    await expect(camera.status()).rejects.toThrow(/cannot reach the camera app/);
  });

  it('is not fooled by an empty answer', async () => {
    const camera = await app(() => ({ body: '' }));
    await expect(camera.photo()).rejects.toThrow(/no data/);
  });
});
