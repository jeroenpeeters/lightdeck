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

  it('starts without an effect', () => {
    expect(controller.getState().effect.id).toBeNull();
  });

  it('sends a new frame forty times per second while an effect runs', () => {
    controller.update({ levels: { dimmer: 1 }, effect: { id: 'chase' } });
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

  it('runs on the tempo of the console, faster or slower with its speed', () => {
    const headAfterOneBeat = (rate: number) => {
      tempo.update({ bpm: 120, rate, sync: true });
      controller.update({ levels: { dimmer: 1 }, effect: { id: 'chase' } });
      advance(500);
      const reds = Array.from({ length: 8 }, (_, i) => ch(output, 7 + i * 4) ?? 0);
      return reds.indexOf(Math.max(...reds));
    };
    expect(headAfterOneBeat(1)).toBe(4);
    expect(headAfterOneBeat(0.5)).toBe(2);
    expect(headAfterOneBeat(2)).toBe(0);
  });

  it('follows a change of tempo while it runs', () => {
    const headAfter = (bpm: number) => {
      tempo.update({ bpm: 120, rate: 1, sync: true });
      controller.update({ levels: { dimmer: 1 }, effect: { id: 'chase' } });
      tempo.update({ bpm });
      advance(500);
      const reds = Array.from({ length: 8 }, (_, i) => ch(output, 7 + i * 4) ?? 0);
      return reds.indexOf(Math.max(...reds));
    };
    expect(headAfter(120)).toBe(4);
    expect(headAfter(60)).toBe(2);
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
