// The service worker of the tablet app. Lightdeck is live: what the page shows comes from the
// event stream and what the operator does goes to the API, and none of that is ever kept or
// answered from here. All this does is keep the pieces of the tablet page itself (the page, its
// scripts and styles, the fonts and the icons), so that the app opens at once and, when lightdeck
// cannot be reached, still opens and says so, where a browser would show an error page.
//
// - Network first for those pieces: after an update of lightdeck the new page is what loads. The
//   copy is only used when the network does not answer.
// - Everything else is left to the browser: the API and the event stream, every other page, and
//   anything that is not a GET. A service worker that answers `/api/events` breaks the page.
//
// A browser only runs a service worker on https or on localhost. On a plain http address on the
// local network there is none, and the page works as it always did.

const CACHE = 'lightdeck-tablet-v1';

/** The pieces of the two pages for a tablet, /tablet and /moods. Nothing else is kept. */
const KEPT =
  /^\/(tablet|tablet\.js|tablet\.css|tabletKit\.js|tabletParts\.js|moods|moods\.js|moods\.css|shell\.js|ui\.js|changes\.js|styles\.css|manifest\.webmanifest|fonts\/[^/]+|icons\/[^/]+)$/;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !KEPT.test(url.pathname)) return;
  event.respondWith(answer(request));
});

async function answer(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const kept = await cache.match(request, { ignoreSearch: true });
    if (kept) return kept;
    throw error;
  }
}
