import { describe, expect, it } from 'vitest';
import { hassWebSocketUrl } from './url.js';

describe('hassWebSocketUrl', () => {
  it('turns the address of the browser into the WebSocket', () => {
    expect(hassWebSocketUrl('http://192.168.68.4:8123')).toBe(
      'ws://192.168.68.4:8123/api/websocket',
    );
    expect(hassWebSocketUrl('http://192.168.68.4:8123/')).toBe(
      'ws://192.168.68.4:8123/api/websocket',
    );
    expect(hassWebSocketUrl('https://ha.example.org')).toBe('wss://ha.example.org/api/websocket');
  });

  it('adds the path to a ws address and a bare host', () => {
    expect(hassWebSocketUrl('ws://ha:8123')).toBe('ws://ha:8123/api/websocket');
    expect(hassWebSocketUrl('homeassistant.local:8123')).toBe(
      'ws://homeassistant.local:8123/api/websocket',
    );
  });

  it('leaves a complete address alone', () => {
    expect(hassWebSocketUrl('ws://ha:8123/api/websocket')).toBe('ws://ha:8123/api/websocket');
    expect(hassWebSocketUrl(' wss://ha.example.org/ha/api/websocket ')).toBe(
      'wss://ha.example.org/ha/api/websocket',
    );
  });

  it('refuses what is not an address', () => {
    expect(() => hassWebSocketUrl('ftp://ha')).toThrow(/must start with/);
    expect(() => hassWebSocketUrl('ws://')).toThrow(/not an address/);
  });
});
