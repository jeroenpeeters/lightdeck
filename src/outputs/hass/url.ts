/**
 * The address of the WebSocket of Home Assistant, from what a person types. The address
 * of Home Assistant in a browser is http://host:8123, and that is what ends up in a settings
 * file: http becomes ws, https becomes wss, and a bare host:port or an address without a path
 * gets /api/websocket. An address that already has a path is left alone, so a proxy that
 * serves Home Assistant under another path still works.
 */
export function hassWebSocketUrl(text: string): string {
  const trimmed = text.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `ws://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`"${text}" is not an address, give one like ws://host:8123/api/websocket`);
  }
  const scheme = { 'http:': 'ws:', 'https:': 'wss:', 'ws:': 'ws:', 'wss:': 'wss:' }[url.protocol];
  if (!scheme) {
    throw new Error(`"${text}" must start with http://, https://, ws:// or wss://`);
  }
  // `URL` only lets the scheme of a special URL change to another special one, so build it.
  const path = url.pathname === '/' ? '/api/websocket' : url.pathname;
  return `${scheme}//${url.host}${path}${url.search}`;
}
