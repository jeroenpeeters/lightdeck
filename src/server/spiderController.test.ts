import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPIDER_43CH, SPIDER_LAYOUT } from '../fixtures/spider.js';
import { PatchError } from './fixture.js';
import { SpiderController, type SpiderState } from './spiderController.js';
import { Tempo } from './tempo.js';
import { ch, RecordingOutput } from './testing.js';

describe('SpiderController', () => {
  let output: RecordingOutput;
  let controller: SpiderController;

  const spider = (universe: number, address: number) =>
    new SpiderController({
      profile: SPIDER_43CH,
      layout: SPIDER_LAYOUT,
      output,
      tempo: new Tempo(),
      universe,
      address,
      resetHoldMs: 3500,
    });

  beforeEach(() => {
    output = new RecordingOutput();
    controller = spider(1, 1);
  });
  afterEach(() => controller.close());

  it('sends a dark frame on its universe when it starts', () => {
    expect(output.frames).toHaveLength(1);
    expect(output.frames[0]?.index).toBe(1);
    expect(output.last).toHaveLength(512);
    expect([...output.last].every((b) => b === 0)).toBe(true);
  });

  it('turns a change into DMX and tells the listeners who made it', () => {
    const seen: { state: SpiderState; origin: string | undefined }[] = [];
    controller.on('state', (state, origin) => seen.push({ state, origin }));
    controller.update({ levels: { dimmer: 1, red3: 0.5 } }, 'tablet');
    expect(ch(output, 6)).toBe(255);
    expect(ch(output, 15)).toBe(128);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.origin).toBe('tablet');
    expect(seen[0]?.state.levels.red3).toBe(0.5);
  });

  it('keeps earlier values when only one thing changes', () => {
    controller.update({ levels: { dimmer: 1, blue8: 1 } });
    controller.update({ levels: { tilt1: 0.5 } });
    expect(ch(output, 6)).toBe(255);
    expect(ch(output, 37)).toBe(255);
    expect([ch(output, 1), ch(output, 2)]).toEqual([0x80, 0x00]);
  });

  it('places the fixture at its start address', () => {
    const shifted = spider(0, 101);
    shifted.update({ levels: { dimmer: 1 } });
    expect(output.frames[output.frames.length - 1]?.index).toBe(0);
    expect(ch(output, 106)).toBe(255);
    expect(ch(output, 6)).toBe(0);
    shifted.close();
  });

  it('refuses an address where the fixture does not fit', () => {
    expect(() => spider(0, 480)).toThrow(RangeError);
  });

  it('clamps levels instead of rejecting them', () => {
    controller.update({ levels: { dimmer: 7, red1: -2 } });
    expect(controller.getState().levels.dimmer).toBe(1);
    expect(controller.getState().levels.red1).toBe(0);
  });

  it('applies nothing when part of a change is invalid', () => {
    const bad: unknown[] = [
      { levels: { dimmer: 1, red9: 1 } },
      { levels: { dimmer: 'full' } },
      { levels: { function: 1 } },
      { levels: 'full' },
      { raw: { function: 300 } },
      { raw: { dimmer: 10 } },
      { raw: [1] },
      { levels: { dimmer: 1 }, blackout: true },
      { levels: { dimmer: 1 }, bpm: 120 },
      'dimmer',
      null,
    ];
    for (const patch of bad) expect(() => controller.update(patch)).toThrow(PatchError);
    expect(controller.getState().levels.dimmer).toBe(0);
    expect(output.frames).toHaveLength(1);
  });

  it("says that the blackout and the tempo are not the spider's to set", () => {
    expect(() => controller.update({ blackout: true })).toThrow(/cannot set "blackout"/);
    expect(() => controller.update({ effect: { bpm: 120 } })).toThrow(/cannot set "bpm"/);
  });

  it('goes dark in a blackout but keeps colour, position and the stored levels', () => {
    controller.update({ levels: { dimmer: 0.8, strobe: 0.5, red1: 1, tilt1: 1 } });
    controller.setBlackout(true);
    expect(ch(output, 6)).toBe(0);
    expect(ch(output, 39)).toBe(0);
    expect(ch(output, 7)).toBe(255);
    expect(ch(output, 1)).toBe(255);
    expect(controller.getState().levels.dimmer).toBe(0.8);
    expect(controller.getDmx()[5]).toBe(0);

    controller.setBlackout(false);
    expect(ch(output, 6)).toBe(204);
    expect(ch(output, 39)).toBeGreaterThan(0);
  });

  it('tells the listeners when the blackout changes what is sent, and only then', () => {
    const seen: unknown[] = [];
    controller.on('state', (state) => seen.push(state));
    controller.setBlackout(false);
    controller.setBlackout(true);
    controller.setBlackout(true);
    expect(seen).toHaveLength(1);
    expect(output.frames).toHaveLength(2);
  });

  it('sends the brightness that is set times the master', () => {
    const sent = (dimmer: number, master: number) => {
      controller.update({ levels: { dimmer } });
      controller.setMaster(master);
      expect(controller.getDmx()[5]).toBe(ch(output, 6));
      return ch(output, 6);
    };
    expect([sent(1, 1), sent(1, 0.5), sent(1, 0)]).toEqual([255, 128, 0]);
    expect([sent(0.5, 1), sent(0.5, 0.5), sent(0.5, 0)]).toEqual([128, 64, 0]);
    expect(sent(0, 1)).toBe(0);
  });

  it('starts with the master at full', () => {
    controller.update({ levels: { dimmer: 0.8 } });
    expect(ch(output, 6)).toBe(204);
  });

  it('scales nothing but the dimmer with the master', () => {
    controller.update({
      levels: {
        dimmer: 1,
        strobe: 0.5,
        motorSpeed: 0.3,
        tilt1: 1,
        tilt2: 0.5,
        red1: 1,
        white8: 0.5,
      },
      raw: { function: 5, effectSpeed: 200 },
    });
    const full = controller.getDmx();
    for (const master of [0.5, 0.01, 0]) {
      controller.setMaster(master);
      const dimmed = controller.getDmx();
      expect(dimmed[5]).toBe(Math.round(255 * master));
      expect(dimmed.filter((_, index) => index !== 5)).toEqual(
        full.filter((_, index) => index !== 5),
      );
    }
    expect(ch(output, 7)).toBe(255); // red1
    expect(ch(output, 38)).toBe(128); // white8
    expect(ch(output, 39)).toBe(full[38]); // strobe
    expect([ch(output, 1), ch(output, 2)]).toEqual([255, 255]); // tilt1
    expect(ch(output, 5)).toBe(77); // motor speed
  });

  it('keeps what is set whatever the master says', () => {
    controller.update({ levels: { dimmer: 0.8, red1: 1 }, effect: { id: 'wave' } });
    const state = controller.getState();
    const kept = controller.snapshot();
    for (const master of [0.5, 0, 0.01, 1]) {
      controller.setMaster(master);
      expect(controller.getState()).toEqual(state);
      expect(controller.snapshot()).toEqual(kept);
    }
    expect(kept.levels).toEqual({ dimmer: 0.8, red1: 1 });
  });

  it('dims a change that comes while the master is down', () => {
    controller.setMaster(0.5);
    controller.update({ levels: { dimmer: 1 } });
    expect(ch(output, 6)).toBe(128);
    controller.recall({ levels: { dimmer: 0.5 } });
    expect(ch(output, 6)).toBe(64);
    expect(controller.getState().levels.dimmer).toBe(0.5);
    controller.setMaster(1);
    expect(ch(output, 6)).toBe(128);
  });

  it('tells the listeners what is sent when the master changes, and only then', () => {
    controller.update({ levels: { dimmer: 1 } });
    const seen: unknown[] = [];
    controller.on('state', (state, origin) => seen.push([state, origin, controller.getDmx()[5]]));
    controller.setMaster(1);
    controller.setMaster(0.5);
    controller.setMaster(0.5);
    expect(seen).toEqual([[controller.getState(), undefined, 128]]);
    expect(output.frames).toHaveLength(3);
  });

  it('keeps the master between nothing and full', () => {
    controller.update({ levels: { dimmer: 1 } });
    controller.setMaster(7);
    expect(ch(output, 6)).toBe(255);
    controller.setMaster(-1);
    expect(ch(output, 6)).toBe(0);
    controller.setMaster(1);
    controller.setMaster(Number.NaN);
    expect(ch(output, 6)).toBe(0);
  });

  it('is dark in a blackout whatever the master says, and dimmed again after it', () => {
    controller.update({ levels: { dimmer: 1, strobe: 0.5 } });
    const strobe = ch(output, 39);

    controller.setBlackout(true);
    controller.setMaster(0.5);
    expect([ch(output, 6), ch(output, 39)]).toEqual([0, 0]);
    controller.setBlackout(false);
    expect([ch(output, 6), ch(output, 39)]).toEqual([128, strobe]);

    controller.setBlackout(true);
    expect(ch(output, 6)).toBe(0);
    controller.setMaster(1);
    expect(ch(output, 6)).toBe(0);
    controller.setBlackout(false);
    expect(ch(output, 6)).toBe(255);

    controller.setMaster(0);
    controller.setBlackout(true);
    controller.setBlackout(false);
    expect([ch(output, 6), ch(output, 39)]).toEqual([0, strobe]);
    controller.setMaster(1);
    expect(ch(output, 6)).toBe(255);
  });

  it('sets a built-in program only through its raw byte', () => {
    controller.update({ raw: { function: 5, effectSpeed: 200 } });
    expect(ch(output, 40)).toBe(5);
    expect(ch(output, 42)).toBe(200);
    expect(ch(output, 43)).toBe(0);
  });

  it('cannot be reset through an ordinary change', () => {
    expect(() => controller.update({ raw: { reset: 255 } })).toThrow(PatchError);
    expect(ch(output, 43)).toBe(0);
  });

  it('holds the reset byte for the hold time and then releases it', () => {
    vi.useFakeTimers();
    try {
      controller.update({ levels: { dimmer: 1 } });
      controller.act('reset');
      expect(ch(output, 43)).toBe(255);
      expect(controller.getState().resetting).toBe(true);
      vi.advanceTimersByTime(3499);
      expect(ch(output, 43)).toBe(255);
      vi.advanceTimersByTime(1);
      expect(ch(output, 43)).toBe(0);
      expect(controller.getState().resetting).toBe(false);
      expect(ch(output, 6)).toBe(255);
    } finally {
      vi.useRealTimers();
    }
  });

  it('can do nothing else by name', () => {
    expect(() => controller.act('explode')).toThrow(PatchError);
    expect(output.frames).toHaveLength(1);
  });

  it('stays as it is when lightdeck stops', () => {
    controller.update({ levels: { dimmer: 1 } });
    controller.darken();
    expect(ch(output, 6)).toBe(255);
  });

  it('reports the DMX bytes of the fixture', () => {
    controller.update({ levels: { dimmer: 1, white8: 1 } });
    const dmx = controller.getDmx();
    expect(dmx).toHaveLength(43);
    expect(dmx[5]).toBe(255);
    expect(dmx[37]).toBe(255);
  });

  it('tells the page how the lenses are arranged and which effects there are', () => {
    // biome-ignore lint/suspicious/noExplicitAny: shape is asserted field by field below
    const details = controller.describe() as any;
    expect(details.layout.bars).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ]);
    expect(details.effects).toHaveLength(10);
    expect(details.effects[0]).toEqual(
      expect.objectContaining({ id: 'kick', name: 'Kick', colours: 'both', moves: false }),
    );
  });
});

describe('SpiderController effects', () => {
  let output: RecordingOutput;
  let tempo: Tempo;
  let controller: SpiderController;
  let clock: number;

  /** Moves the clock of the tempo and the timers forward together. */
  const advance = (ms: number) => {
    for (let done = 0; done < ms; done += 25) {
      clock += 25;
      vi.advanceTimersByTime(25);
    }
  };

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1000;
    output = new RecordingOutput();
    tempo = new Tempo({ now: () => clock });
    controller = new SpiderController({
      profile: SPIDER_43CH,
      layout: SPIDER_LAYOUT,
      output,
      tempo,
      universe: 0,
      address: 1,
    });
  });
  afterEach(() => {
    controller.close();
    vi.useRealTimers();
  });

  /** A second spider on the same tempo with the master at full, to compare with. */
  const undimmed = (change: unknown) => {
    const sent = new RecordingOutput();
    const other = new SpiderController({
      profile: SPIDER_43CH,
      layout: SPIDER_LAYOUT,
      output: sent,
      tempo,
      universe: 0,
      address: 1,
    });
    other.update(change);
    return { sent, other };
  };
  /** The bytes of a spider without its dimmer, which is channel 6. */
  const butDimmer = (dmx: ArrayLike<number>) => [
    ...Array.from(dmx).slice(0, 5),
    ...Array.from(dmx).slice(6, 43),
  ];

  it('starts without an effect', () => {
    expect(controller.getState().effect.id).toBeNull();
  });

  it('sends a new frame forty times per second while an effect runs', () => {
    controller.update({ levels: { dimmer: 1 }, effect: { id: 'wave' } });
    const before = output.frames.length;
    advance(1000);
    expect(output.frames.length - before).toBe(40);
    const pictures = new Set(output.frames.slice(before).map((f) => f.data.slice(6, 38).join()));
    expect(pictures.size).toBeGreaterThan(20);
  });

  it('sends nothing on its own when no effect runs', () => {
    controller.update({ levels: { dimmer: 1, red1: 1 } });
    const before = output.frames.length;
    advance(1000);
    expect(output.frames.length).toBe(before);
  });

  it('lets the effect set the colours and keeps the rest with the operator', () => {
    tempo.update({ sync: true });
    controller.update({
      levels: { dimmer: 0.5, strobe: 0.2, motorSpeed: 0.3, tilt1: 0.9, green5: 1 },
      effect: { id: 'kick' },
    });
    // On the first beat of the bar the kick shows the second colour, blue by default.
    expect(ch(output, 9)).toBe(255); // blue1
    expect(ch(output, 24)).toBe(38); // green5 comes from the effect, not from the operator
    expect(ch(output, 6)).toBe(128); // dimmer
    expect(ch(output, 5)).toBe(77); // motor speed
    expect(ch(output, 1)).toBe(230); // tilt1, this effect does not move
    expect(ch(output, 39)).toBeGreaterThan(0); // strobe
    expect(controller.getState().levels.green5).toBe(1);
  });

  it('lets a moving effect tilt the bars', () => {
    tempo.update({ sync: true });
    controller.update({ levels: { tilt1: 0, tilt2: 0 }, effect: { id: 'scissor' } });
    advance(((60_000 / 126) * 2) | 0); // two beats: a quarter of the swing
    expect(ch(output, 1)).toBeGreaterThan(190);
    expect(ch(output, 3)).toBeLessThan(65);
  });

  it('goes back to the operator colours when the effect stops', () => {
    controller.update({ levels: { dimmer: 1, red1: 1 }, effect: { id: 'wave' } });
    advance(500);
    controller.update({ effect: { id: null } });
    expect(ch(output, 7)).toBe(255);
    expect(ch(output, 8)).toBe(0);
    const before = output.frames.length;
    advance(500);
    expect(output.frames.length).toBe(before);
  });

  it('stays dark during a blackout, while the effect keeps running', () => {
    controller.update({ levels: { dimmer: 1 }, effect: { id: 'kick' } });
    controller.setBlackout(true);
    advance(300);
    expect(ch(output, 6)).toBe(0);
    controller.setBlackout(false);
    expect(ch(output, 6)).toBe(255);
  });

  it('dims with the master while an effect runs, and leaves its colours and tilt alone', () => {
    tempo.update({ sync: true });
    controller.update({
      levels: { dimmer: 1, strobe: 0.2, motorSpeed: 0.3, tilt1: 0.9 },
      effect: { id: 'kick' },
    });
    expect(ch(output, 9)).toBe(255); // blue1, from the effect
    controller.setMaster(0.5);
    expect(ch(output, 6)).toBe(128);
    expect(ch(output, 9)).toBe(255);
    expect(ch(output, 1)).toBe(230); // tilt1
    expect(ch(output, 5)).toBe(77); // motor speed

    controller.setMaster(0);
    advance(200);
    expect(ch(output, 6)).toBe(0);
    controller.setMaster(1);
    expect(ch(output, 6)).toBe(255);
  });

  it('sends the frames of an effect with the dimmer scaled and nothing else', () => {
    for (const id of ['chase', 'scissor', 'burst']) {
      const change = {
        levels: { dimmer: 1, strobe: 0.2, motorSpeed: 0.3, tilt1: 0.9 },
        effect: { id, speed: 4 },
      };
      tempo.update({ sync: true });
      controller.update(change);
      controller.setMaster(0.5);
      const { sent, other } = undimmed(change);
      const before = output.frames.length;
      const beforeOther = sent.frames.length;
      advance(1000);
      other.close();

      const dimmed = output.frames.slice(before);
      const full = sent.frames.slice(beforeOther);
      expect(dimmed).toHaveLength(40);
      expect(dimmed.map((f) => f.data[5])).toEqual(new Array(40).fill(128));
      expect(full.map((f) => f.data[5])).toEqual(new Array(40).fill(255));
      expect(dimmed.map((f) => butDimmer(f.data))).toEqual(full.map((f) => butDimmer(f.data)));
      expect(new Set(dimmed.map((f) => butDimmer(f.data).join())).size).toBeGreaterThan(5);
    }
  });

  it('shows browsers the bytes that go out, with the master in them', () => {
    const change = { levels: { dimmer: 1 }, effect: { id: 'chase' } };
    const frames: number[][] = [];
    controller.on('frame', (dmx) => frames.push(dmx));
    controller.update(change);
    const { other } = undimmed(change);
    const full: number[][] = [];
    other.on('frame', (dmx) => full.push(dmx));

    controller.setMaster(0.5);
    advance(500);
    controller.setMaster(0);
    advance(500);
    other.close();

    expect(frames).toHaveLength(20);
    expect(frames.map((dmx) => dmx[5])).toEqual([
      ...new Array(10).fill(128),
      ...new Array(10).fill(0),
    ]);
    expect(frames.map(butDimmer)).toEqual(full.map(butDimmer));
    expect(Math.max(...frames.slice(10).flatMap((dmx) => dmx.slice(6, 38)))).toBeGreaterThan(200);
  });

  /** The lens the chase is on, a little after `beats` beats at 120 beats per minute. */
  const headAfter = (beats: number, settings: { rate?: number; speed?: number; bpm?: number }) => {
    tempo.update({ bpm: 120, rate: settings.rate ?? 1, sync: true });
    controller.update({
      levels: { dimmer: 1 },
      effect: { id: 'chase', speed: settings.speed ?? 1 },
    });
    if (settings.bpm !== undefined) tempo.update({ bpm: settings.bpm });
    advance(beats * 500 + 50);
    const reds = Array.from({ length: 8 }, (_, i) => ch(output, 7 + i * 4) ?? 0);
    return reds.indexOf(Math.max(...reds));
  };

  it('takes one step per beat at normal speed', () => {
    expect(headAfter(1, {})).toBe(1);
    expect(headAfter(3, {})).toBe(3);
  });

  it('runs on the tempo of the console, faster or slower with its speed', () => {
    expect(headAfter(2, { rate: 0.25 })).toBe(0);
    expect(headAfter(2, { rate: 0.5 })).toBe(1);
    expect(headAfter(2, { rate: 2 })).toBe(4);
    expect(headAfter(1, { rate: 4 })).toBe(4);
  });

  it('runs faster or slower with the speed of the effect', () => {
    expect(headAfter(2, { speed: 0.25 })).toBe(0);
    expect(headAfter(2, { speed: 0.5 })).toBe(1);
    expect(headAfter(2, { speed: 2 })).toBe(4);
    expect(headAfter(1, { speed: 4 })).toBe(4);
  });

  it('multiplies the speed of the effect with the speed of the console', () => {
    expect(headAfter(2, { speed: 2, rate: 0.5 })).toBe(2);
    expect(headAfter(2, { speed: 0.5, rate: 0.5 })).toBe(0);
    expect(headAfter(1, { speed: 2, rate: 2 })).toBe(4);
  });

  it('falls back to a lower speed when the effect would change more than ten times per second', () => {
    // 120 beats per minute times 8 is 16 per second: halved to times 4, which is 8.
    expect(headAfter(1, { speed: 4, rate: 2 })).toBe(4);
    expect(headAfter(1, { speed: 4, rate: 4 })).toBe(4);
    // At 180 beats per minute times 4 is 12 per second: halved to times 2.
    expect(headAfter(1, { speed: 4, bpm: 180 })).toBe(3);
  });

  it('follows a change of tempo while it runs', () => {
    expect(headAfter(2, { bpm: 120 })).toBe(2);
    expect(headAfter(2, { bpm: 60 })).toBe(1);
  });

  it('is idle while the tempo does not run: the fixture shows what is set under the effect', () => {
    const reds = () => Array.from({ length: 8 }, (_, i) => ch(output, 7 + i * 4) ?? 0);
    tempo.update({ source: 'audio', bpm: 120, sync: true });
    controller.update({ levels: { dimmer: 1, red1: 0.5 }, effect: { id: 'chase' } });
    advance(1050);
    expect(Math.max(...reds())).toBeGreaterThan(200);

    tempo.follow({ running: false });
    advance(50);
    expect(reds()).toEqual([128, 0, 0, 0, 0, 0, 0, 0]);
    // It is still the chosen effect, and it is back by itself when the tempo runs.
    expect(controller.getState().effect.id).toBe('chase');
    tempo.follow({ running: true });
    advance(50);
    expect(Math.max(...reds())).toBeGreaterThan(200);
  });

  it('keeps its speed when another effect is chosen, and tells it with the state', () => {
    controller.update({ effect: { id: 'chase', speed: 0.5 } });
    controller.update({ effect: { id: 'wave' } });
    expect(controller.getState().effect).toEqual(
      expect.objectContaining({ id: 'wave', speed: 0.5 }),
    );
    expect(controller.describe().speeds).toEqual([0.25, 0.5, 1, 2, 4]);
  });

  it('uses the chosen colours', () => {
    tempo.update({ sync: true });
    controller.update({
      effect: {
        id: 'kick',
        colourA: { red: 0, green: 1, blue: 0, white: 0 },
        colourB: { red: 0, green: 0, blue: 0, white: 1 },
      },
    });
    expect(ch(output, 10)).toBe(255); // white1 on the first beat
    advance(60_000 / 126 + 25);
    expect(ch(output, 8)).toBeGreaterThan(150); // green1 on the second
    expect(ch(output, 10)).toBe(0);
  });

  it('tells browsers what is shown, at a lower rate than it sends', () => {
    const frames: { dmx: number[]; beat: number }[] = [];
    controller.on('frame', (dmx, beat) => frames.push({ dmx, beat }));
    tempo.update({ sync: true });
    controller.update({ levels: { dimmer: 1 }, effect: { id: 'chase' } });
    advance(1000);
    expect(frames.length).toBeGreaterThanOrEqual(19);
    expect(frames.length).toBeLessThanOrEqual(21);
    expect(frames[0]?.dmx).toHaveLength(43);
    expect(frames[frames.length - 1]?.beat).toBeGreaterThan(1.9);
  });

  it('refuses effect settings that make no sense, and changes nothing', () => {
    const bad = [
      { id: 'disco' },
      { id: 7 },
      { colourA: { red: 1 } },
      { colourB: 'blue' },
      { bpm: 120 },
      { rate: 2 },
      { sync: true },
      { speed: 3 },
      { speed: '2' },
      { speed: 0 },
    ];
    for (const effect of bad) {
      expect(() => controller.update({ effect })).toThrow(PatchError);
    }
    expect(() => controller.update({ effect: 'kick' })).toThrow(PatchError);
    expect(controller.getState().effect.id).toBeNull();
    advance(200);
    expect(output.frames).toHaveLength(1);
  });
});

describe('SpiderController in a scene', () => {
  let output: RecordingOutput;
  let controller: SpiderController;

  beforeEach(() => {
    output = new RecordingOutput();
    controller = new SpiderController({
      profile: SPIDER_43CH,
      layout: SPIDER_LAYOUT,
      output,
      tempo: new Tempo(),
      universe: 0,
      address: 1,
      resetHoldMs: 3500,
    });
  });
  afterEach(() => controller.close());

  it('gives nothing while it is at rest', () => {
    expect(controller.snapshot()).toEqual({});
  });

  it('gives what is set and leaves out what is at rest', () => {
    controller.update({ levels: { dimmer: 1, red3: 0.5, strobe: 0 }, raw: { effectSpeed: 40 } });
    expect(controller.snapshot()).toEqual({
      levels: { dimmer: 1, red3: 0.5 },
      raw: { effectSpeed: 40 },
    });
  });

  it('gives the effect with its colours while one is chosen', () => {
    const colourA = { red: 0, green: 1, blue: 0, white: 0 };
    controller.update({ effect: { id: 'wave', colourA } });
    expect(controller.snapshot()).toEqual({
      effect: { id: 'wave', colourA, colourB: controller.getState().effect.colourB, speed: 1 },
    });
    controller.update({ effect: { id: null } });
    expect(controller.snapshot()).toEqual({});
  });

  it('keeps the speed of the effect, and takes 1 for a scene that names none', () => {
    controller.update({ effect: { id: 'chase', speed: 0.25 } });
    const kept = controller.snapshot();
    expect(kept.effect).toEqual(expect.objectContaining({ id: 'chase', speed: 0.25 }));
    controller.recall({ effect: { id: 'kick' } });
    expect(controller.getState().effect.speed).toBe(1);
    controller.recall(kept);
    expect(controller.getState().effect.speed).toBe(0.25);
    expect(() => controller.check({ effect: { id: 'chase', speed: 3 } })).toThrow(PatchError);
  });

  it('comes back to what was kept, and what the part does not name goes to rest', () => {
    controller.update({ levels: { dimmer: 1, red3: 0.5 }, effect: { id: 'wave' } });
    const kept = controller.snapshot();
    const before = controller.getState();
    controller.update({
      levels: { dimmer: 0.2, green1: 1, tilt1: 0.7 },
      raw: { effectSpeed: 40 },
      effect: { id: 'kick', colourA: { red: 0, green: 0, blue: 1, white: 0 } },
    });
    controller.recall(kept, 'deck');
    expect(controller.getState()).toEqual(before);
    expect(controller.snapshot()).toEqual(kept);
  });

  it('tells the listeners who recalled', () => {
    const told = vi.fn();
    controller.on('state', told);
    controller.recall({ levels: { dimmer: 1 } }, 'deck');
    expect(told).toHaveBeenCalledTimes(1);
    expect(told.mock.calls[0]?.[1]).toBe('deck');
    expect(ch(output, 6)).toBe(255);
  });

  it('goes dark without a part', () => {
    controller.update({ levels: { dimmer: 1, white8: 1 }, effect: { id: 'kick' } });
    controller.recall(undefined);
    expect([...output.last].every((b) => b === 0)).toBe(true);
    expect(controller.getState().effect.id).toBeNull();
  });

  it('lets a reset that is going on go on, and does not keep it in a scene', () => {
    vi.useFakeTimers();
    try {
      controller.resetFixture();
      expect(controller.snapshot()).toEqual({});
      controller.recall({ levels: { dimmer: 1 } });
      expect(controller.getState().resetting).toBe(true);
      expect(ch(output, 43)).toBe(255);
      vi.advanceTimersByTime(3500);
      expect(ch(output, 43)).toBe(0);
      expect(ch(output, 6)).toBe(255);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the brightness that is set in a scene, not what the master makes of it', () => {
    controller.update({ levels: { dimmer: 0.8 } });
    controller.setMaster(0.5);
    expect(ch(output, 6)).toBe(102);
    const kept = controller.snapshot();
    expect(kept).toEqual({ levels: { dimmer: 0.8 } });
    controller.recall(undefined);
    controller.recall(kept);
    expect(ch(output, 6)).toBe(102);
    controller.setMaster(1);
    expect(ch(output, 6)).toBe(204);
  });

  it('refuses a part it cannot take, and stays as it is', () => {
    controller.update({ levels: { dimmer: 1 } });
    const before = controller.getState();
    for (const part of [
      { levels: { glow: 1 } },
      { raw: { reset: 255 } },
      { effect: { id: 'disco' } },
      { colour: 'red' },
      'bright',
    ]) {
      expect(() => controller.check(part)).toThrow(PatchError);
      expect(() => controller.recall(part)).toThrow(PatchError);
    }
    expect(controller.getState()).toEqual(before);
    expect(() => controller.check({ levels: { dimmer: 0.5 } })).not.toThrow();
    expect(controller.getState()).toEqual(before);
  });
});
