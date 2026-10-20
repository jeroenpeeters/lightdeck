#!/usr/bin/env node
// A stand-in for the camera app of android-camera/, to run `pnpm laser-survey` without the phone.
//
// It speaks the HTTP of the app: GET /status, POST /settings?iso=&exposureMs=&focus=&width=,
// POST /photo (a small JPEG) and POST /clip?seconds= (a few bytes that are not a real video), with
// the settings of the shot in the x-lightdeck-settings header. It prints each request, so that a
// check can see when the photo was taken.
//
//   node standin-camera.mjs [--port 9020] [--manual false] [--not-ready] [--slow <ms>]
//
//   --port       where to listen, default 9020 (the port of the app)
//   --manual     false: say that the phone cannot set the exposure by hand
//   --not-ready  answer 503 to photos and clips, like an app that is behind another one
//   --slow       wait this long before a photo or clip is answered
//
// No dependencies.

import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '9020' },
    manual: { type: 'string', default: 'true' },
    'not-ready': { type: 'boolean', default: false },
    slow: { type: 'string', default: '0' },
  },
});

const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//wAALCAAkAEABAREA/8QAFgABAQEAAAAAAAAAAAAAAAAAAAYF/8QAGRAAAwADAAAAAAAAAAAAAAAAABRhAhNR/9oACAEBAAA/AIBKBKBKBKBKBKBKBKFIlAlAlAlAlAlAlAlCkSgSgSgSgSgSgSgShSJQJQJQJQJQJQJQJQ3tWHBqw4NWHBqw4NWHBqw4NWHBqw4f/9k=', 'base64');
const state = { iso: 100, exposureMs: 100, focus: 0, width: 1600 };
const height = () => Math.round((state.width * 9) / 16);

const status = () => ({
  ready: !values['not-ready'],
  ...(values['not-ready'] ? { problem: 'camera is not open: bring the app to the screen' } : {}),
  manualSensor: values.manual !== 'false',
  ...state,
  isoRange: [50, 3200],
  exposureRangeMs: [0.05, 30000],
  minFocus: 10,
  still: { width: state.width, height: height() },
  video: { width: 1280, height: 720 },
});

const stamp = () => new Date().toISOString().slice(11, 23);

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  console.log(`${stamp()} ${req.method} ${url.pathname}${url.search}`);
  const json = (body, code = 200) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const settings = () => JSON.stringify({ ...state, manual: values.manual !== 'false', at: Date.now() });
  if (url.pathname === '/status') return json(status());
  if (url.pathname === '/settings') {
    for (const key of Object.keys(state)) {
      const value = Number(url.searchParams.get(key));
      if (url.searchParams.has(key) && Number.isFinite(value)) state[key] = value;
    }
    return json(status());
  }
  if (url.pathname === '/photo' || url.pathname === '/clip') {
    if (values['not-ready']) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      return res.end('camera is not open: bring the app to the screen');
    }
    await new Promise((r) => setTimeout(r, Number(values.slow)));
    const clip = url.pathname === '/clip';
    res.writeHead(200, {
      'content-type': clip ? 'video/mp4' : 'image/jpeg',
      'x-lightdeck-settings': settings(),
    });
    return res.end(clip ? Buffer.from('not a video, a stand-in') : JPEG);
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('no such thing');
}).listen(Number(values.port), () => console.log(`stand-in camera on port ${values.port}`));
