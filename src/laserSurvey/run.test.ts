import { describe, expect, it } from 'vitest';
import { type Camera, CameraError, type Capture } from './camera.js';
import type { Shot } from './plan.js';
import { type LaserOutput, runSurvey, type Store } from './run.js';

function memoryStore(): Store & { files: Map<string, Uint8Array | string> } {
  const files = new Map<string, Uint8Array | string>();
  return {
    files,
    exists: (file) => files.has(file),
    write: (file, data) => void files.set(file, data),
  };
}

function fakeLaser() {
  const events: string[] = [];
  const laser: LaserOutput = {
    set: (footprint) => void events.push(`set ${footprint[0]},${footprint[1]}`),
    close: async () => void events.push('close'),
  };
  return { laser, events };
}

function fakeCamera(events: string[], failures: Array<Error | null> = []): Camera {
  let n = 0;
  const shoot = async (kind: string): Promise<Capture> => {
    events.push(kind);
    const failure = failures.shift();
    if (failure) throw failure;
    return { data: Uint8Array.of(++n), settings: { iso: 100, exposureMs: 100 } };
  };
  return { photo: () => shoot('photo'), clip: (s) => shoot(`clip ${s}`) };
}

const shots: Shot[] = [
  { name: 'a/one', raw: { mode: 95, program: 10 } },
  { name: 'a/two', raw: { mode: 95, program: 20 }, seconds: 5 },
];
const quick = { settleMs: 800, sleep: async () => {}, now: () => new Date('2026-10-19T12:00:00Z') };

describe('runSurvey', () => {
  it('sets the laser, waits, shoots, saves the picture with its bytes, and closes the laser', async () => {
    const { laser, events } = fakeLaser();
    const store = memoryStore();
    const result = await runSurvey(shots, {
      ...quick,
      laser,
      camera: fakeCamera(events),
      store,
      context: { distanceM: 3 },
    });
    expect(events).toEqual(['set 95,10', 'photo', 'set 95,20', 'clip 5', 'close']);
    expect(result).toMatchObject({ taken: 2, skipped: 0, failed: null, aborted: false });
    expect([...store.files.keys()].sort()).toEqual([
      'a/one.jpg',
      'a/one.json',
      'a/two.json',
      'a/two.mp4',
    ]);
    const json = JSON.parse(store.files.get('a/one.json') as string);
    expect(json).toMatchObject({
      name: 'a/one',
      kind: 'photo',
      raw: { mode: 95, program: 10 },
      camera: { iso: 100 },
      distanceM: 3,
      settleMs: 800,
      at: '2026-10-19T12:00:00.000Z',
    });
    expect(json.footprint).toHaveLength(10);
    expect(json.footprint.slice(0, 2)).toEqual([95, 10]);
    expect(JSON.parse(store.files.get('a/two.json') as string)).toMatchObject({
      kind: 'clip',
      seconds: 5,
    });
  });

  it('continues a run: shots that are there are skipped, unless asked again', async () => {
    const store = memoryStore();
    store.write('a/one.json', '{}');
    const first = fakeLaser();
    const result = await runSurvey(shots, {
      ...quick,
      laser: first.laser,
      camera: fakeCamera(first.events),
      store,
    });
    expect(result).toMatchObject({ taken: 1, skipped: 1 });
    expect(first.events).toEqual(['set 95,20', 'clip 5', 'close']);

    const second = fakeLaser();
    const again = await runSurvey(shots, {
      ...quick,
      laser: second.laser,
      camera: fakeCamera(second.events),
      store,
      again: true,
    });
    expect(again.taken).toBe(2);
  });

  it('tries a shot again when the camera does not answer, then gives up and still closes the laser', async () => {
    const { laser, events } = fakeLaser();
    const store = memoryStore();
    const result = await runSurvey(shots, {
      ...quick,
      laser,
      camera: fakeCamera(events, [new CameraError('slow'), new CameraError('slow')]),
      store,
    });
    expect(result.failed).toMatch(/a\/one: slow/);
    expect(result.taken).toBe(0);
    expect(events).toEqual(['set 95,10', 'photo', 'photo', 'close']);
    expect(store.files.size).toBe(0);
  });

  it('survives one failure', async () => {
    const { laser, events } = fakeLaser();
    const result = await runSurvey(shots, {
      ...quick,
      laser,
      camera: fakeCamera(events, [new CameraError('slow')]),
      store: memoryStore(),
    });
    expect(result).toMatchObject({ taken: 2, failed: null });
  });

  it('stops between shots when aborted, and closes the laser', async () => {
    const { laser, events } = fakeLaser();
    const abort = new AbortController();
    const camera = fakeCamera(events);
    const result = await runSurvey(shots, {
      ...quick,
      laser,
      camera: {
        photo: async () => {
          const capture = await camera.photo();
          abort.abort();
          return capture;
        },
        clip: camera.clip,
      },
      store: memoryStore(),
      signal: abort.signal,
    });
    expect(result).toMatchObject({ taken: 1, aborted: true });
    expect(events.at(-1)).toBe('close');
    expect(events).not.toContain('clip 5');
  });

  it('closes the laser when something unexpected throws', async () => {
    const { laser, events } = fakeLaser();
    const camera: Camera = {
      photo: async () => {
        throw new TypeError('boom');
      },
      clip: async () => {
        throw new TypeError('boom');
      },
    };
    await expect(
      runSurvey(shots, { ...quick, laser, camera, store: memoryStore() }),
    ).resolves.toMatchObject({
      failed: expect.stringContaining('boom'),
    });
    expect(events.at(-1)).toBe('close');
  });
});
