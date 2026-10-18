import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CommandResult, HassClient } from './client.js';
import { SIMULATED_RATE, simulatedHass } from './simulated.js';
import type { EntityReport, HassCommand, HassStatus } from './types.js';

const ON = (brightness: number): HassCommand => ({
  domain: 'light',
  service: 'turn_on',
  data: { brightness, rgb_color: [255, 0, 0], transition: 1 },
});
const OFF: HassCommand = { domain: 'light', service: 'turn_off', data: { transition: 0 } };

describe('the simulated Home Assistant', () => {
  let client: HassClient;
  let statuses: HassStatus[];
  let results: CommandResult[];
  const entities = ['light.a', 'light.b', 'light.c', 'light.d', 'light.e', 'light.f', 'switch.fog'];
  const heard = new Map<string, EntityReport | undefined>();

  beforeEach(() => {
    vi.useFakeTimers();
    statuses = [];
    results = [];
    heard.clear();
    client = new HassClient({
      url: 'ws://simulated/api/websocket',
      token: 'whatever',
      entities,
      now: () => Date.now(),
      socketFactory: simulatedHass(entities),
      onStatus: (status) => statuses.push(status),
      onResult: (result) => results.push(result),
    });
    for (const entity of entities) client.watch(entity, (report) => heard.set(entity, report));
    client.start();
    vi.advanceTimersByTime(10);
  });

  afterEach(() => {
    client.stop();
    vi.useRealTimers();
  });

  it('logs in with any token and says what the lamps are: off, with the colour modes of the room', () => {
    expect(statuses).toContain('connected');
    expect(heard.get('light.a')).toEqual({
      available: true,
      on: false,
      colourModes: ['xy', 'color_temp'],
    });
    expect(heard.get('switch.fog')).toEqual({ available: true, on: false, colourModes: [] });
  });

  it('does what a command says and reports it back', () => {
    client.setEntity('light.a', ON(128));
    vi.advanceTimersByTime(1000);
    expect(results).toMatchObject([{ entity: 'light.a', ok: true }]);
    expect(heard.get('light.a')?.on).toBe(true);
    client.setEntity('light.a', OFF);
    vi.advanceTimersByTime(1000);
    expect(heard.get('light.a')?.on).toBe(false);
  });

  it('turns a switch on and off', () => {
    client.setEntity('switch.fog', { domain: 'switch', service: 'turn_on' });
    vi.advanceTimersByTime(1000);
    expect(heard.get('switch.fog')?.on).toBe(true);
  });

  it('takes the commands one after the other, at the pace of the mesh', () => {
    for (const entity of entities.slice(0, 6)) client.setEntity(entity, ON(100));
    // The first answer comes after one turn of the mesh, and then one per turn.
    vi.advanceTimersByTime(1000 / SIMULATED_RATE - 10);
    expect(results).toHaveLength(0);
    vi.advanceTimersByTime(20);
    expect(results).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(results.length).toBeGreaterThanOrEqual(4);
    vi.advanceTimersByTime(2000);
    expect(results).toHaveLength(6);
    expect(results.every((result) => result.ok)).toBe(true);
  });

  it('keeps the answers short when the room asks for more than the mesh takes', () => {
    // 6 lamps asking again and again: the throttle waits for the answers and the newest wins.
    for (let second = 0; second < 20; second++) {
      for (const entity of entities.slice(0, 6)) client.setEntity(entity, ON(50 + second));
      vi.advanceTimersByTime(1000);
    }
    const slowest = Math.max(...results.map((result) => result.ms));
    expect(slowest).toBeLessThan(2000);
    expect(results.length).toBeGreaterThan(40);
  });

  it('answers a command for a lamp it does not have with a refusal', () => {
    const problems: (string | null)[] = [];
    client.problems('light.ghost', (problem) => problems.push(problem));
    client.setEntity('light.ghost', ON(10));
    vi.advanceTimersByTime(1000);
    expect(results).toMatchObject([{ entity: 'light.ghost', ok: false }]);
    expect(problems).toHaveLength(1);
  });

  it('keeps the lamps when the client connects again', () => {
    client.setEntity('light.b', ON(200));
    vi.advanceTimersByTime(1000);
    expect(heard.get('light.b')?.on).toBe(true);
    client.stop();
    client.start();
    vi.advanceTimersByTime(10);
    expect(heard.get('light.b')?.on).toBe(true);
  });
});
