import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Palette, PaletteBook, startingPalettes } from '../engine/palette.js';
import { SPIDER_43CH, SPIDER_LAYOUT } from '../fixtures/spider.js';
import { Engine } from './engine.js';
import { PatchError } from './fixture.js';
import { type CellLayout, SpiderController, type SpiderState } from './spiderController.js';
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

  describe('the limits of the tilt', () => {
    const limits = { tilt: [{ min: 0.2, max: 0.6 }, { max: 0.5 }] };

    it('keeps a bar within its limits, whoever sets the tilt', () => {
      controller.setLimits(limits);
      controller.update({ levels: { tilt1: 1, tilt2: 1 } });
      expect([ch(output, 1), ch(output, 3)]).toEqual([153, 128]); // 0.6 and 0.5
      controller.update({ levels: { tilt1: 0, tilt2: 0 } });
      expect([ch(output, 1), ch(output, 3)]).toEqual([51, 0]); // 0.2, and bar 2 is free below
      controller.update({ levels: { tilt1: 0.4 } });
      expect(ch(output, 1)).toBe(102);
    });

    it('leaves the state alone: what was asked is kept, and what goes out is limited', () => {
      controller.update({ levels: { tilt1: 1 } });
      controller.setLimits(limits);
      expect(controller.getState().levels.tilt1).toBe(1);
      expect(controller.snapshot('motion')).toEqual({ levels: { tilt1: 1 } });
      expect(ch(output, 1)).toBe(153);
      // Taking the limits away gives back what was asked.
      controller.setLimits(null);
      expect(ch(output, 1)).toBe(255);
    });

    it('tells the listeners when the limits change what is sent, and not when they do not', () => {
      const seen: unknown[] = [];
      controller.on('state', (state) => seen.push(state));
      controller.setLimits(limits);
      controller.setLimits({ tilt: [{ min: 0.2, max: 0.6 }, { max: 0.5 }] });
      expect(seen).toHaveLength(1);
    });

    it('reads limits as a min and a max per bar, and fills in what is left out', () => {
      expect(controller.readLimits(limits)).toEqual({
        tilt: [
          { min: 0.2, max: 0.6 },
          { min: 0, max: 0.5 },
        ],
      });
      expect(controller.readLimits({})).toEqual({
        tilt: [
          { min: 0, max: 1 },
          { min: 0, max: 1 },
        ],
      });
      expect(controller.readLimits(null)).toEqual(controller.readLimits({}));
    });

    it('refuses what cannot be a limit, and changes nothing', () => {
      const bad: unknown[] = [
        'tilt',
        { tilt: 'wide' },
        { tilt: [{}, {}, {}] },
        { tilt: [{ min: 0.5, max: 0.5 }] },
        { tilt: [{ min: 0.7, max: 0.2 }] },
        { tilt: [{ min: -0.1 }] },
        { tilt: [{ max: 1.5 }] },
        { tilt: [{ min: 'low' }] },
        { tilt: [{ lowest: 0.1 }] },
        { pan: [] },
      ];
      for (const given of bad) expect(() => controller.setLimits(given)).toThrow(PatchError);
      controller.update({ levels: { tilt1: 1 } });
      expect(ch(output, 1)).toBe(255);
    });
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
    const kept = controller.snapshot('lights');
    for (const master of [0.5, 0, 0.01, 1]) {
      controller.setMaster(master);
      expect(controller.getState()).toEqual(state);
      expect(controller.snapshot('lights')).toEqual(kept);
    }
    expect(kept.levels).toEqual({ dimmer: 0.8 });
    // The colour of a lens by hand is in no scene.
    expect(controller.snapshot('colour')).toEqual({});
  });

  it('dims a change that comes while the master is down', () => {
    controller.setMaster(0.5);
    controller.update({ levels: { dimmer: 1 } });
    expect(ch(output, 6)).toBe(128);
    controller.recall('lights', { levels: { dimmer: 0.5 } });
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
    // From left to right, looking at the front: L4 L3 L2 L1 on the back bar, L5 L6 L7 L8 on the
    // front bar. From the back, where the LCD is, it reads L1 L2 L3 L4 and L8 L7 L6 L5.
    expect(details.layout.bars).toEqual([
      [3, 2, 1, 0],
      [4, 5, 6, 7],
    ]);
    expect(details.layout.side).toEqual(['back', 'front']);
    // Neutral at 30 for both bars, which turn opposite ways, and the movement is not linear.
    expect(details.layout.tiltCurve[0]).toContainEqual([0.3, 0]);
    expect(details.layout.tiltCurve[1]).toContainEqual([0.3, 0]);
    expect(details.layout.motorSpeedCurve.length).toBeGreaterThanOrEqual(2);
    expect(details.layout.aim).toEqual([-12, -5, 5, 12]);
    expect(details.effects).toHaveLength(22);
    expect(details.effects[0]).toEqual(
      expect.objectContaining({ id: 'kick', name: 'Kick', slots: 3 }),
    );
    expect(details.effects.map((e: { id: string }) => e.id)).not.toContain('scissor');
    expect(details.motionEffects.map((e: { id: string }) => e.id)).toEqual([
      'tiltwave',
      'scissor',
      'scissor-motor',
      'creep',
      'drift',
      'slice',
    ]);
    expect(details.motionEffects[2]).toEqual(
      expect.objectContaining({ id: 'scissor-motor', setsMotorSpeed: true }),
    );
    expect(details.motionEffects.every((e: { setsMotorSpeed: boolean }) => e.setsMotorSpeed)).toBe(
      true,
    );
  });

  it('is coloured by the palettes of the show', () => {
    expect(controller.takesPalettes).toBe(true);
  });
});

/** The palettes the tests use, besides the white and the rainbow that a show starts with. */
const PALETTES: Palette[] = [
  ...startingPalettes(),
  {
    id: 'amber',
    label: 'Amber',
    colours: [{ red: 1, green: 148 / 255, blue: 0, white: 0 }],
    mode: 'static',
    change: 'step',
    speed: 0.25,
  },
  {
    id: 'red',
    label: 'Red',
    colours: [{ red: 1, green: 0, blue: 0, white: 0 }],
    mode: 'static',
    change: 'step',
    speed: 0.25,
  },
  {
    id: 'green-white',
    label: 'Green on white',
    colours: [
      { red: 0, green: 1, blue: 0, white: 0 },
      { red: 0, green: 0, blue: 0, white: 1 },
    ],
    mode: 'static',
    change: 'step',
    speed: 0.25,
  },
  {
    id: 'trio',
    label: 'Trio',
    colours: [
      { red: 1, green: 0, blue: 0, white: 0 },
      { red: 0, green: 1, blue: 0, white: 0 },
      { red: 0, green: 0, blue: 1, white: 0 },
    ],
    mode: 'cycle',
    change: 'step',
    speed: 1,
  },
  {
    id: 'pool',
    label: 'Pool',
    colours: [
      { red: 1, green: 0, blue: 0, white: 0 },
      { red: 0, green: 1, blue: 0, white: 0 },
      { red: 0, green: 0, blue: 1, white: 0 },
    ],
    mode: 'cycle',
    change: 'step',
    speed: 1,
    visible: 1,
  },
  {
    id: 'fader',
    label: 'Fader',
    colours: [
      { red: 1, green: 0, blue: 0, white: 0 },
      { red: 0, green: 0, blue: 1, white: 0 },
    ],
    mode: 'cycle',
    change: 'fade',
    speed: 1,
  },
  {
    id: 'ember',
    label: 'Ember',
    colours: [{ red: 1, green: 0.3, blue: 0, white: 0 }],
    mode: 'static',
    change: 'step',
    speed: 0.25,
  },
  {
    id: 'ice',
    label: 'Ice',
    colours: [{ red: 0, green: 0.6, blue: 1, white: 0 }],
    mode: 'static',
    change: 'step',
    speed: 0.25,
  },
];

describe('SpiderController effects', () => {
  let output: RecordingOutput;
  let tempo: Tempo;
  let palettes: PaletteBook;
  let controller: SpiderController;
  let engine: Engine;
  let clock: number;

  /** Moves the clock of the tempo and the timers forward together. */
  const advance = (ms: number) => {
    for (let done = 0; done < ms; done += 25) {
      clock += 25;
      vi.advanceTimersByTime(25);
    }
  };

  const make = (layout: CellLayout = SPIDER_LAYOUT) =>
    new SpiderController({
      profile: SPIDER_43CH,
      layout,
      output,
      tempo,
      palettes,
      universe: 0,
      address: 1,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1000;
    output = new RecordingOutput();
    tempo = new Tempo({ now: () => clock });
    palettes = new PaletteBook();
    palettes.set(PALETTES);
    controller = make();
    // The controller has no timer of its own: the engine asks it for a frame on the grid of the beat.
    engine = new Engine({ tempo });
    engine.add(controller);
  });
  afterEach(() => {
    engine.close();
    controller.close();
    vi.useRealTimers();
  });

  /** Takes a second spider out of the clock and closes it. */
  const release = (other: SpiderController) => {
    engine.remove(other);
    other.close();
  };

  /** A second spider on the same tempo with the master at full, to compare with. */
  const undimmed = (change: unknown) => {
    const sent = new RecordingOutput();
    const other = new SpiderController({
      profile: SPIDER_43CH,
      layout: SPIDER_LAYOUT,
      output: sent,
      tempo,
      palettes,
      universe: 0,
      address: 1,
    });
    engine.add(other);
    other.update(change);
    return { sent, other };
  };
  /** The bytes of a spider without its dimmer, which is channel 6. */
  const butDimmer = (dmx: ArrayLike<number>) => [
    ...Array.from(dmx).slice(0, 5),
    ...Array.from(dmx).slice(6, 43),
  ];

  it('starts without an effect, a motion effect or a palette', () => {
    const state = controller.getState();
    expect(state.effect).toEqual({ id: null, speed: 1 });
    expect(state.motion).toEqual({ id: null, speed: 1 });
    expect(state.colour).toEqual({ palette: null, speed: null });
  });

  it('sends a frame at every point of the grid while an effect runs, and never more than 25 a second', () => {
    controller.update({ levels: { dimmer: 1 }, effect: { id: 'wave' } });
    const before = output.frames.length;
    advance(1000);
    // 126 beats per minute and 25 per second at most: 11 points per beat, 23 a second.
    const made = output.frames.length - before;
    expect(made).toBeGreaterThanOrEqual(22);
    expect(made).toBeLessThanOrEqual(25);
    const pictures = new Set(output.frames.slice(before).map((f) => f.data.slice(6, 38).join()));
    expect(pictures.size).toBeGreaterThan(15);
  });

  it('has no timer of its own', () => {
    controller.update({ levels: { dimmer: 1 }, effect: { id: 'wave' } });
    engine.close();
    expect(vi.getTimerCount()).toBe(0);
    const before = output.frames.length;
    advance(500);
    expect(output.frames.length).toBe(before);
  });

  it('wants frames while an effect of either kind is chosen and the tempo runs, and says when that changes', () => {
    const wants: boolean[] = [];
    controller.on('wants', () => wants.push(controller.wantsFrames()));
    expect(controller.wantsFrames()).toBe(false);
    controller.update({ effect: { id: 'chase' } });
    expect(controller.wantsFrames()).toBe(true);
    tempo.update({ source: 'audio' });
    tempo.follow({ running: false });
    expect(controller.wantsFrames()).toBe(false);
    tempo.follow({ running: true });
    controller.update({ effect: { id: null } });
    expect(controller.wantsFrames()).toBe(false);
    controller.update({ motion: { id: 'tiltwave' } });
    expect(controller.wantsFrames()).toBe(true);
    controller.update({ motion: { id: null } });
    expect(controller.wantsFrames()).toBe(false);
    // A palette alone makes nothing move.
    controller.update({ colour: { palette: 'trio' } });
    expect(controller.wantsFrames()).toBe(false);
    expect(wants).toEqual([true, false, true, false, false]);
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
      colour: { palette: 'amber' },
    });
    // On the beat the kick hits in the main colour of the palette, amber here.
    expect(ch(output, 7)).toBe(255); // red1
    expect(ch(output, 24)).toBe(148); // green5 comes from the effect, not from the operator
    expect(ch(output, 6)).toBe(128); // dimmer
    expect(ch(output, 5)).toBe(77); // motor speed
    expect(ch(output, 1)).toBe(230); // tilt1, this effect does not move
    expect(ch(output, 39)).toBeGreaterThan(0); // strobe
    expect(controller.getState().levels.green5).toBe(1);
  });

  it('gives the lenses a single white when no palette was chosen', () => {
    tempo.update({ sync: true });
    controller.update({ levels: { dimmer: 1 }, effect: { id: 'solid' } });
    expect(ch(output, 10)).toBe(255); // white1
    expect([ch(output, 7), ch(output, 8), ch(output, 9)]).toEqual([0, 0, 0]);
  });

  it('gives the lenses a single white when the palette it names is no longer in the show', () => {
    controller.update({
      levels: { dimmer: 1 },
      effect: { id: 'solid' },
      colour: { palette: 'ice' },
    });
    expect(ch(output, 9)).toBe(255); // blue1
    palettes.set(PALETTES.filter((palette) => palette.id !== 'ice'));
    advance(100);
    expect(ch(output, 10)).toBe(255);
    expect(ch(output, 9)).toBe(0);
    // The fixture still holds the id: the palette is back when the show has it again.
    expect(controller.getState().colour.palette).toBe('ice');
  });

  it('shows an edited palette at once, while an effect runs', () => {
    tempo.update({ sync: true });
    controller.update({
      levels: { dimmer: 1 },
      effect: { id: 'solid' },
      colour: { palette: 'amber' },
    });
    expect(ch(output, 7)).toBe(255);
    palettes.set(
      PALETTES.map((p) =>
        p.id === 'amber' ? { ...p, colours: [{ red: 0, green: 0, blue: 1, white: 0 }] } : p,
      ),
    );
    advance(100);
    expect([ch(output, 7), ch(output, 9)]).toEqual([0, 255]);
  });

  it('lets a motion effect tilt the bars, and leaves the colours with the operator', () => {
    tempo.update({ sync: true });
    controller.update({
      levels: { tilt1: 0, tilt2: 0, red3: 1 },
      motion: { id: 'tiltwave' },
    });
    advance(((60_000 / 126) * 1) | 0); // one beat in: the bars have been sent to the high end
    expect(ch(output, 1)).toBeGreaterThan(190);
    expect(ch(output, 3)).toBeLessThan(65);
    expect(ch(output, 15)).toBe(255); // red3, set by hand
    expect(controller.getState().levels.tilt1).toBe(0);
  });

  it('puts a light effect, a motion effect and a palette together', () => {
    tempo.update({ bpm: 120, sync: true });
    controller.update({
      levels: { dimmer: 1, tilt1: 0, tilt2: 0 },
      effect: { id: 'chase' },
      motion: { id: 'tiltwave' },
      colour: { palette: 'amber' },
    });
    advance(1050); // two beats and a bit
    const reds = Array.from({ length: 8 }, (_, i) => ch(output, 7 + i * 4) ?? 0);
    expect(reds.indexOf(Math.max(...reds))).toBe(2);
    expect(Math.max(...reds)).toBe(255);
    expect(ch(output, 1)).toBeGreaterThan(40); // the bar has been sent to the low end of the wave
    expect(ch(output, 1)).not.toBe(0);
  });

  it('lets the scissor by motor speed set the motor speed when the spider is calibrated for it', () => {
    controller.close();
    engine.remove(controller);
    controller = make({
      ...SPIDER_LAYOUT,
      motorSpeedCurve: [
        [0, 30],
        [1, 300],
      ],
    });
    engine.add(controller);
    tempo.update({ sync: true });
    controller.update({ levels: { motorSpeed: 0.9 }, motion: { id: 'scissor-motor' } });
    advance(((60_000 / 126) * 2) | 0);
    // 80 degrees in three beats at 126 bpm is 56 degrees per second, which is 10% of the range.
    expect(ch(output, 5)).toBe(Math.round(((56 - 30) / 270) * 255));
    expect(controller.getState().levels.motorSpeed).toBe(0.9);
    controller.update({ motion: { id: null } });
    expect(ch(output, 5)).toBe(Math.round(0.9 * 255));
  });

  it('sets the motor speed of the spider as timed while the scissor by motor speed runs', () => {
    tempo.update({ sync: true });
    controller.update({ levels: { motorSpeed: 0.3 }, motion: { id: 'scissor-motor' } });
    advance(((60_000 / 126) * 2) | 0);
    // The motor is slow at the top of the channel: 56 degrees per second is between 50 and 90 percent.
    expect(ch(output, 5)).toBeGreaterThan(Math.round(0.5 * 255));
    expect(ch(output, 5)).toBeLessThan(Math.round(0.9 * 255));
    expect(controller.getState().levels.motorSpeed).toBe(0.3);
  });

  it('leaves the motor speed with the operator while the scissor by motor speed has a calibration that cannot tell', () => {
    controller.close();
    engine.remove(controller);
    controller = make({
      ...SPIDER_LAYOUT,
      motorSpeedCurve: [
        [0, 200],
        [1, 200],
      ],
    });
    engine.add(controller);
    tempo.update({ sync: true });
    controller.update({ levels: { motorSpeed: 0.3 }, motion: { id: 'scissor-motor' } });
    advance(((60_000 / 126) * 2) | 0);
    expect(ch(output, 5)).toBe(77);
  });

  it('leaves the motor speed with the operator while a light effect runs', () => {
    controller.update({ levels: { motorSpeed: 0.3, dimmer: 1 }, effect: { id: 'chase' } });
    advance(500);
    expect(ch(output, 5)).toBe(77);
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

  it('maps the tilts of a motion effect into the limits, and does not cut it off at them', () => {
    controller.setLimits({
      tilt: [
        { min: 0.4, max: 0.6 },
        { min: 0.4, max: 0.6 },
      ],
    });
    controller.update({ motion: { id: 'tiltwave' } });
    const seen: number[] = [];
    for (let i = 0; i < 80; i++) {
      advance(100);
      seen.push(ch(output, 1) ?? 0, ch(output, 3) ?? 0);
    }
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(102);
    expect(Math.max(...seen)).toBeLessThanOrEqual(153);
    // The wave goes from 0.2 to 0.8 of the window, which is 0.44 to 0.56 of the tilt: it swings all
    // the way within the limits and does not stand still at one of them.
    expect(Math.max(...seen)).toBe(Math.round(0.56 * 255));
    expect(Math.min(...seen)).toBe(Math.round(0.44 * 255));
  });

  it('still cuts off a tilt that is set by hand at the limits', () => {
    controller.setLimits({ tilt: [{ min: 0.4, max: 0.6 }] });
    controller.update({ levels: { tilt1: 1 } });
    expect(ch(output, 1)).toBe(153);
    controller.update({ levels: { tilt1: 0 } });
    expect(ch(output, 1)).toBe(102);
  });

  it('goes back to the tilts of the operator when the motion effect stops', () => {
    controller.update({ levels: { tilt1: 0.1, tilt2: 0.1 }, motion: { id: 'tiltwave' } });
    advance(1500);
    controller.update({ motion: { id: null } });
    // The tilt is 16 bits; the first channel is the high byte of 0.1.
    expect(ch(output, 1)).toBe(25);
    expect(ch(output, 3)).toBe(25);
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
      colour: { palette: 'amber' },
    });
    expect(ch(output, 7)).toBe(255); // red1, from the effect
    controller.setMaster(0.5);
    expect(ch(output, 6)).toBe(128);
    expect(ch(output, 7)).toBe(255);
    expect(ch(output, 1)).toBe(230); // tilt1
    expect(ch(output, 5)).toBe(77); // motor speed

    controller.setMaster(0);
    advance(200);
    expect(ch(output, 6)).toBe(0);
    controller.setMaster(1);
    expect(ch(output, 6)).toBe(255);
  });

  it('sends the frames of an effect with the dimmer scaled and nothing else', () => {
    const cases: [string, string][] = [
      ['effect', 'chase'],
      ['motion', 'tiltwave'],
      ['motion', 'scissor'],
      ['effect', 'burst'],
    ];
    for (const [kind, id] of cases) {
      controller.update({ effect: { id: null }, motion: { id: null } });
      const change = {
        levels: { dimmer: 1, strobe: 0.2, motorSpeed: 0.3, tilt1: 0.9 },
        [kind]: { id, speed: 4 },
        colour: { palette: 'amber' },
      };
      tempo.update({ sync: true });
      controller.update(change);
      controller.setMaster(0.5);
      const { sent, other } = undimmed(change);
      const before = output.frames.length;
      const beforeOther = sent.frames.length;
      advance(1000);
      release(other);

      const dimmed = output.frames.slice(before);
      const full = sent.frames.slice(beforeOther);
      const made = dimmed.length;
      expect(made).toBeGreaterThanOrEqual(22);
      expect(made).toBeLessThanOrEqual(25);
      expect(full).toHaveLength(made);
      expect(dimmed.map((f) => f.data[5])).toEqual(new Array(made).fill(128));
      expect(full.map((f) => f.data[5])).toEqual(new Array(made).fill(255));
      expect(dimmed.map((f) => butDimmer(f.data))).toEqual(full.map((f) => butDimmer(f.data)));
      // A light effect makes a new picture most frames; a motion effect sends the bars to an end and
      // holds it, so it has only the few that its legs make in a second.
      const pictures = new Set(dimmed.map((f) => butDimmer(f.data).join())).size;
      expect(pictures).toBeGreaterThan(kind === 'effect' ? 5 : 1);
    }
  });

  it('shows browsers the bytes that go out, with the master in them', () => {
    const change = { levels: { dimmer: 1 }, effect: { id: 'chase' }, colour: { palette: 'amber' } };
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
    release(other);

    // A frame at every point of the grid, 23 a second, and each is what was sent.
    expect(frames.length).toBeGreaterThanOrEqual(22);
    expect(frames.length).toBeLessThanOrEqual(25);
    const half = frames.filter((dmx) => dmx[5] === 128).length;
    const dark = frames.filter((dmx) => dmx[5] === 0).length;
    expect(half + dark).toBe(frames.length);
    expect(half).toBeGreaterThanOrEqual(10);
    expect(dark).toBeGreaterThanOrEqual(10);
    expect(frames.map(butDimmer)).toEqual(full.map(butDimmer));
    expect(Math.max(...frames.slice(10).flatMap((dmx) => dmx.slice(6, 38)))).toBeGreaterThan(200);
  });

  /** The lens the chase is on, a little after `beats` beats at 120 beats per minute. */
  const headAfter = (beats: number, settings: { rate?: number; speed?: number; bpm?: number }) => {
    tempo.update({ bpm: 120, rate: settings.rate ?? 1, sync: true });
    controller.update({
      levels: { dimmer: 1 },
      effect: { id: 'chase', speed: settings.speed ?? 1 },
      colour: { palette: 'amber' },
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
    controller.update({
      levels: { dimmer: 1, red1: 0.5 },
      effect: { id: 'chase' },
      colour: { palette: 'amber' },
    });
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
    expect(controller.getState().effect).toEqual({ id: 'wave', speed: 0.5 });
    expect(controller.describe().speeds).toEqual([0.25, 0.5, 1, 2, 4]);
  });

  it('keeps the speed of the light effect and of the motion effect apart', () => {
    controller.update({ effect: { id: 'chase', speed: 0.5 }, motion: { id: 'scissor', speed: 2 } });
    expect(controller.getState().effect.speed).toBe(0.5);
    expect(controller.getState().motion.speed).toBe(2);
  });

  describe('the palette', () => {
    const lens = (n: number) => [1, 2, 3, 4].map((part) => ch(output, 7 + (n - 1) * 4 + part - 1));

    it('gives the main colour to the foreground and the second to the background', () => {
      tempo.update({ sync: true });
      controller.update({
        effect: { id: 'kick' },
        colour: { palette: 'green-white' },
      });
      expect(ch(output, 8)).toBe(255); // green1 hits on the beat
      expect(ch(output, 10)).toBe(0);
      advance(400);
      expect(ch(output, 8)).toBeLessThan(40); // it has fallen back to white1
      expect(ch(output, 10)).toBeGreaterThan(200);
    });

    it('with one colour falls back to dark, not to a dim first colour', () => {
      tempo.update({ sync: true });
      controller.update({ effect: { id: 'kick' }, colour: { palette: 'amber' } });
      expect(ch(output, 7)).toBe(255);
      advance(400);
      expect(ch(output, 7)).toBeLessThan(20);
      // The amber has green in it, and that has fallen as far; blue and white were never there.
      expect(ch(output, 8)).toBeLessThan(12);
      expect([9, 10].map((channel) => ch(output, channel))).toEqual([0, 0]);
    });

    it('takes the palette back with null, and refuses one the show does not have', () => {
      controller.update({ colour: { palette: 'amber' } });
      expect(controller.getState().colour.palette).toBe('amber');
      controller.update({ colour: { palette: null } });
      expect(controller.getState().colour.palette).toBeNull();
      expect(() => controller.update({ colour: { palette: 'nope' } })).toThrow(
        /unknown palette "nope"/,
      );
      expect(() => controller.update({ colour: { palette: 7 } })).toThrow(PatchError);
      expect(controller.getState().colour.palette).toBeNull();
    });

    it('steps through the colours of a palette that cycles, one step per beat at speed 1', () => {
      tempo.update({ bpm: 120, sync: true });
      controller.update({
        levels: { dimmer: 1 },
        effect: { id: 'solid' },
        colour: { palette: 'trio' },
      });
      expect(lens(1)).toEqual([255, 0, 0, 0]); // red
      advance(550);
      expect(lens(1)).toEqual([0, 255, 0, 0]); // green after a beat
      advance(500);
      expect(lens(1)).toEqual([0, 0, 255, 0]); // blue after two
      advance(500);
      expect(lens(1)).toEqual([255, 0, 0, 0]); // and round again
    });

    it('shows one colour that changes through the pool, with nothing behind it, when the palette shows one', () => {
      tempo.update({ bpm: 120, sync: true });
      // Bars puts the first colour on the first bar and the second colour on the second bar.
      controller.update({
        levels: { dimmer: 1 },
        effect: { id: 'bars' },
        colour: { palette: 'pool' },
      });
      expect(lens(1)).toEqual([255, 0, 0, 0]);
      expect(lens(5)).toEqual([0, 0, 0, 0]);
      advance(550);
      expect(lens(1)).toEqual([0, 255, 0, 0]);
      expect(lens(5)).toEqual([0, 0, 0, 0]);
      advance(500);
      expect(lens(1)).toEqual([0, 0, 255, 0]);
    });

    it('runs at the pace of the palette, or at the one that is set for this use', () => {
      tempo.update({ bpm: 120, sync: true });
      controller.update({
        levels: { dimmer: 1 },
        effect: { id: 'solid' },
        colour: { palette: 'trio', speed: 0.25 },
      });
      advance(1550); // three beats: still the first step of a bar
      expect(lens(1)).toEqual([255, 0, 0, 0]);
      advance(500); // the fourth beat
      expect(lens(1)).toEqual([0, 255, 0, 0]);
      controller.update({ colour: { speed: null } }); // back to the pace of the palette: a step per beat
      advance(550);
      expect(lens(1)).not.toEqual([0, 255, 0, 0]);
    });

    it('fades from colour to colour when the palette says fade', () => {
      tempo.update({ bpm: 120, sync: true });
      controller.update({
        levels: { dimmer: 1 },
        effect: { id: 'solid' },
        colour: { palette: 'fader' },
      });
      expect(lens(1)).toEqual([255, 0, 0, 0]);
      advance(275); // half a beat
      const [red, , blue] = lens(1);
      expect(red).toBeGreaterThan(90);
      expect(red).toBeLessThan(170);
      expect(blue).toBeGreaterThan(90);
      expect(blue).toBeLessThan(170);
    });

    it('does not move a palette that is static', () => {
      tempo.update({ bpm: 120, sync: true });
      controller.update({
        levels: { dimmer: 1 },
        effect: { id: 'solid' },
        colour: { palette: 'amber' },
      });
      const first = lens(1);
      advance(2000);
      expect(lens(1)).toEqual(first);
    });

    it('keeps its place in the cycle when the speed of the palette is pressed', () => {
      tempo.update({ bpm: 120, sync: true });
      controller.update({
        levels: { dimmer: 1 },
        effect: { id: 'solid' },
        colour: { palette: 'trio' },
      });
      advance(1050); // on the third colour
      const before = lens(1);
      expect(before).toEqual([0, 0, 255, 0]);
      controller.update({ colour: { speed: 2 } });
      expect(lens(1)).toEqual(before);
    });
  });

  it('tells browsers every frame it sends, with the beat the frame is for', () => {
    const frames: { dmx: number[]; beat: number }[] = [];
    controller.on('frame', (dmx, beat) => frames.push({ dmx, beat }));
    tempo.update({ sync: true });
    controller.update({ levels: { dimmer: 1 }, effect: { id: 'chase' } });
    const before = output.frames.length;
    advance(1000);
    // One frame event for every frame the engine made.
    expect(frames.length).toBe(output.frames.length - before);
    expect(frames[0]?.dmx).toHaveLength(43);
    expect(frames[frames.length - 1]?.beat).toBeGreaterThan(1.9);
    // And it is the frame that went out, byte for byte.
    expect(frames.at(-1)?.dmx).toEqual(Array.from(output.last.slice(0, 43)));
    // The beats are the points of the grid: 11 to a beat at 126 beats per minute.
    for (const { beat } of frames)
      expect(Math.abs(beat * 11 - Math.round(beat * 11))).toBeLessThan(1e-6);
  });

  it('shows the flash of a kick at its full level on every beat, at any tempo', () => {
    for (const bpm of [90, 120, 126, 133.3, 150, 170, 190]) {
      const frames: { dmx: number[]; beat: number }[] = [];
      const record = (dmx: number[], beat: number) => frames.push({ dmx, beat });
      controller.on('frame', record);
      tempo.update({ bpm, sync: true });
      controller.update({
        levels: { dimmer: 1 },
        effect: { id: 'kick', speed: 1 },
        colour: { palette: 'red' },
      });
      advance(30_000);
      controller.off('frame', record);
      const onTheBeat = frames.filter(({ beat }) => Number.isInteger(beat));
      // A frame is made for every beat, and in each the first lens is at full level. If a point
      // of the grid fell a hair short of its beat, the frame would show the end of the beat before.
      expect(onTheBeat.length).toBeGreaterThan((30 * bpm) / 60 - 3);
      for (const { dmx } of onTheBeat) expect(dmx[6]).toBe(255);
    }
  });

  describe('when the speed is changed while the effect runs', () => {
    /** The lens the chase is on. */
    const head = () => {
      const reds = Array.from({ length: 8 }, (_, i) => controller.getDmx()[6 + i * 4] ?? 0);
      return reds.indexOf(Math.max(...reds));
    };
    const chase = (speed: number) => ({
      levels: { dimmer: 1 },
      effect: { id: 'chase', speed },
      colour: { palette: 'amber' },
    });

    it('stays on the lens it is on when the speed of the effect is pressed', () => {
      tempo.update({ bpm: 120, sync: true });
      controller.update(chase(1));
      advance(3400);
      const before = head();
      expect(before).toBe(6);
      controller.update({ effect: { speed: 2 } });
      expect(head()).toBe(before);
      controller.update({ effect: { speed: 0.5 } });
      expect(head()).toBe(before);
    });

    it('stays on the lens it is on when the master speed is pressed', () => {
      tempo.update({ bpm: 120, sync: true });
      controller.update(chase(1));
      advance(3400);
      const before = head();
      tempo.update({ rate: 4 });
      expect(head()).toBe(before);
      tempo.update({ rate: 1 });
      expect(head()).toBe(before);
    });

    it('goes on from there on the beat, at the new speed', () => {
      tempo.update({ bpm: 120, sync: true });
      controller.update(chase(1));
      advance(3400);
      controller.update({ effect: { speed: 2 } });
      const seen: number[] = [];
      for (let i = 0; i < 24; i++) {
        advance(25);
        seen.push(head());
      }
      // At ×2 and 120 beats per minute a step comes every 250 ms, on the half beats.
      const steps = seen.filter((lens, i) => i > 0 && lens !== seen[i - 1]).length;
      expect(steps).toBeGreaterThanOrEqual(2);
      expect(steps).toBeLessThanOrEqual(3);
    });

    it('keeps stepping at ×2 while the tempo wanders around 150 with ×4 chosen, and does not flap', () => {
      tempo.update({ bpm: 150.2, sync: true });
      controller.update(chase(4));
      // 150 beats per minute at ×4 would be 10 steps a second; the limit takes it to ×2, 5 a second.
      advance(2000);
      let steps = 0;
      let last = head();
      for (let i = 0; i < 120; i++) {
        // The tempo wanders either side of the threshold every 100 ms.
        if (i % 4 === 0) tempo.update({ bpm: i % 8 === 0 ? 149.8 : 150.2 });
        advance(25);
        const now = head();
        if (now !== last) steps++;
        last = now;
      }
      // Three seconds at ×2 are 15 steps. A limit that flapped would average 7.5 a second.
      expect(steps).toBeGreaterThanOrEqual(14);
      expect(steps).toBeLessThanOrEqual(16);
    });
  });

  it('refuses effect settings that make no sense, and changes nothing', () => {
    const bad = [
      { id: 'disco' },
      { id: 7 },
      { id: 'scissor' }, // a motion effect is not a light effect
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
    for (const motion of [{ id: 'kick' }, { id: 7 }, { speed: 3 }, { palette: 'amber' }]) {
      expect(() => controller.update({ motion })).toThrow(PatchError);
    }
    for (const colour of [{ id: 'kick' }, { speed: 3 }, { palette: 'amber', speed: '2' }]) {
      expect(() => controller.update({ colour })).toThrow(PatchError);
    }
    expect(controller.getState().effect.id).toBeNull();
    expect(controller.getState().motion.id).toBeNull();
    expect(controller.getState().colour.palette).toBeNull();
    advance(200);
    expect(output.frames).toHaveLength(1);
  });
});

describe('SpiderController in a scene', () => {
  let output: RecordingOutput;
  let controller: SpiderController;
  let palettes: PaletteBook;

  /** Everything set at once, a bit of every type. */
  const everything = () =>
    controller.update({
      levels: { dimmer: 1, red3: 0.5, tilt1: 0.7, motorSpeed: 0.4, strobe: 0.2 },
      raw: { effectSpeed: 40 },
      effect: { id: 'wave', speed: 0.5 },
      motion: { id: 'tiltwave', speed: 2 },
      colour: { palette: 'ember', speed: 0.5 },
    });

  beforeEach(() => {
    output = new RecordingOutput();
    palettes = new PaletteBook();
    palettes.set(PALETTES);
    controller = new SpiderController({
      profile: SPIDER_43CH,
      layout: SPIDER_LAYOUT,
      output,
      tempo: new Tempo(),
      palettes,
      universe: 0,
      address: 1,
      resetHoldMs: 3500,
    });
  });
  afterEach(() => controller.close());

  it('gives nothing while it is at rest', () => {
    for (const type of ['lights', 'colour', 'motion'] as const) {
      expect(controller.snapshot(type)).toEqual({});
    }
  });

  it('gives every type its own properties and no others', () => {
    everything();
    expect(controller.snapshot('lights')).toEqual({
      levels: { dimmer: 1, strobe: 0.2 },
      raw: { effectSpeed: 40 },
      effect: { id: 'wave', speed: 0.5 },
    });
    expect(controller.snapshot('colour')).toEqual({ colour: { palette: 'ember', speed: 0.5 } });
    expect(controller.snapshot('motion')).toEqual({
      levels: { tilt1: 0.7, motorSpeed: 0.4 },
      motion: { id: 'tiltwave', speed: 2 },
    });
  });

  it('keeps the colour of a lens set by hand in no scene', () => {
    controller.update({ levels: { red3: 0.5, white8: 1 } });
    for (const type of ['lights', 'colour', 'motion'] as const) {
      expect(controller.snapshot(type)).toEqual({});
    }
  });

  it('leaves out what is at rest', () => {
    controller.update({ levels: { dimmer: 1, tilt1: 0, strobe: 0 }, effect: { id: 'kick' } });
    expect(controller.snapshot('lights')).toEqual({
      levels: { dimmer: 1 },
      effect: { id: 'kick', speed: 1 },
    });
    controller.update({ effect: { id: null } });
    expect(controller.snapshot('lights')).toEqual({ levels: { dimmer: 1 } });
    expect(controller.snapshot('motion')).toEqual({});
  });

  it('names the speed of a palette only while it is set', () => {
    controller.update({ colour: { palette: 'ice' } });
    expect(controller.snapshot('colour')).toEqual({ colour: { palette: 'ice' } });
    controller.update({ colour: { speed: 2 } });
    expect(controller.snapshot('colour')).toEqual({ colour: { palette: 'ice', speed: 2 } });
    controller.update({ colour: { palette: null } });
    expect(controller.snapshot('colour')).toEqual({});
  });

  it('sets what its type keeps and leaves the other types alone', () => {
    everything();
    const before = controller.getState();
    for (const type of ['lights', 'colour', 'motion'] as const) {
      const kept = controller.snapshot(type);
      controller.update({
        levels: { dimmer: 0.1, red3: 0.1, red5: 1, tilt1: 0.1, tilt2: 0.9, motorSpeed: 1 },
        raw: { effectSpeed: 200 },
        effect: { id: 'kick', speed: 2 },
        motion: { id: 'scissor', speed: 0.25 },
        colour: { palette: 'ice', speed: 4 },
      });
      const others = {
        lights: controller.snapshot('lights'),
        colour: controller.snapshot('colour'),
        motion: controller.snapshot('motion'),
      };
      controller.recall(type, kept, 'deck');
      expect(controller.snapshot(type)).toEqual(kept);
      for (const other of ['lights', 'colour', 'motion'] as const) {
        if (other !== type) expect(controller.snapshot(other)).toEqual(others[other]);
      }
    }
    expect(controller.getState()).not.toEqual(before);
  });

  it('puts a look together from a scene of every type', () => {
    everything();
    const lights = controller.snapshot('lights');
    const colour = controller.snapshot('colour');
    const motion = controller.snapshot('motion');
    const before = controller.getState();
    controller.recall('lights', undefined);
    controller.recall('colour', { colour: { palette: 'ice' } });
    controller.recall('motion', undefined);
    expect(controller.getState()).not.toEqual(before);
    controller.recall('lights', lights);
    controller.recall('colour', colour);
    controller.recall('motion', motion);
    // The colour of a lens by hand was in no scene, and is as it was set.
    expect(controller.getState()).toEqual(before);
  });

  it('keeps an effect going when a palette or a motion scene is set', () => {
    controller.update({ levels: { dimmer: 1 }, effect: { id: 'chase', speed: 0.25 } });
    controller.recall('colour', { colour: { palette: 'ice' } });
    controller.recall('motion', { levels: { tilt1: 0.3 } });
    expect(controller.getState().effect).toEqual({ id: 'chase', speed: 0.25 });
    expect(controller.getState().colour).toEqual({ palette: 'ice', speed: null });
    expect(controller.getState().levels.tilt1).toBe(0.3);
    expect(ch(output, 6)).toBe(255);
  });

  it('keeps a motion effect going when a lights scene is set, and the other way round', () => {
    controller.update({ motion: { id: 'scissor', speed: 2 } });
    controller.recall('lights', { levels: { dimmer: 1 }, effect: { id: 'chase' } });
    expect(controller.getState().motion).toEqual({ id: 'scissor', speed: 2 });
    controller.recall('motion', undefined);
    expect(controller.getState().motion).toEqual({ id: null, speed: 1 });
    expect(controller.getState().effect.id).toBe('chase');
  });

  it('takes the pace of the palette back when a colour part does not name one', () => {
    controller.update({ colour: { palette: 'trio', speed: 4 } });
    controller.recall('colour', { colour: { palette: 'trio' } });
    expect(controller.getState().colour.speed).toBeNull();
    controller.recall('colour', { colour: { palette: 'trio', speed: 0.5 } });
    expect(controller.getState().colour.speed).toBe(0.5);
    controller.recall('colour', undefined);
    expect(controller.getState().colour).toEqual({ palette: null, speed: null });
  });

  it('keeps the speed of the effect with lights, and takes 1 for a scene that names none', () => {
    controller.update({ effect: { id: 'chase', speed: 0.25 } });
    const kept = controller.snapshot('lights');
    expect(kept.effect).toEqual({ id: 'chase', speed: 0.25 });
    controller.recall('lights', { effect: { id: 'kick' } });
    expect(controller.getState().effect.speed).toBe(1);
    controller.recall('lights', kept);
    expect(controller.getState().effect.speed).toBe(0.25);
    expect(() => controller.check('lights', { effect: { id: 'chase', speed: 3 } })).toThrow(
      PatchError,
    );
  });

  it('is what off is: lights without a part darkens and leaves colour and motion', () => {
    controller.update({
      levels: { dimmer: 1, red1: 1, white8: 1, tilt1: 0.4, strobe: 0.5 },
      raw: { effectSpeed: 40 },
      effect: { id: 'kick' },
      motion: { id: 'tiltwave' },
      colour: { palette: 'ice' },
    });
    controller.recall('lights', undefined);
    const state = controller.getState();
    expect(state.levels.dimmer).toBe(0);
    expect(state.levels.strobe).toBe(0);
    expect(state.raw.effectSpeed).toBe(0);
    expect(state.effect.id).toBeNull();
    expect(ch(output, 6)).toBe(0);
    expect(state.levels.red1).toBe(1);
    expect(state.levels.white8).toBe(1);
    expect(state.levels.tilt1).toBe(0.4);
    expect(state.motion.id).toBe('tiltwave');
    expect(state.colour.palette).toBe('ice');
  });

  it('tells the listeners who recalled', () => {
    const told = vi.fn();
    controller.on('state', told);
    controller.recall('lights', { levels: { dimmer: 1 } }, 'deck');
    expect(told).toHaveBeenCalledTimes(1);
    expect(told.mock.calls[0]?.[1]).toBe('deck');
    expect(ch(output, 6)).toBe(255);
  });

  it('lets a reset that is going on go on, and does not keep it in a scene', () => {
    vi.useFakeTimers();
    try {
      controller.resetFixture();
      for (const type of ['lights', 'colour', 'motion'] as const) {
        expect(controller.snapshot(type).raw).toBeUndefined();
      }
      controller.recall('lights', { levels: { dimmer: 1 } });
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
    const kept = controller.snapshot('lights');
    expect(kept).toEqual({ levels: { dimmer: 0.8 } });
    controller.recall('lights', undefined);
    controller.recall('lights', kept);
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
      expect(() => controller.check('lights', part)).toThrow(PatchError);
      expect(() => controller.recall('lights', part)).toThrow(PatchError);
    }
    expect(controller.getState()).toEqual(before);
    expect(() => controller.check('lights', { levels: { dimmer: 0.5 } })).not.toThrow();
    expect(controller.getState()).toEqual(before);
  });

  it('refuses a palette the show does not have', () => {
    const before = controller.getState();
    expect(() => controller.check('colour', { colour: { palette: 'nope' } })).toThrow(
      /unknown palette "nope"/,
    );
    expect(() => controller.recall('colour', { colour: { palette: 'nope' } })).toThrow(PatchError);
    expect(controller.getState()).toEqual(before);
    expect(() => controller.check('colour', { colour: { palette: 'ice' } })).not.toThrow();
  });

  it('refuses a part that names what belongs to another type', () => {
    controller.update({ levels: { dimmer: 1 } });
    const before = controller.getState();
    const cases: [Parameters<typeof controller.check>[0], unknown][] = [
      ['colour', { levels: { dimmer: 1 } }],
      ['colour', { raw: { effectSpeed: 3 } }],
      ['colour', { effect: { id: 'kick' } }],
      ['colour', { motion: { id: 'scissor' } }],
      ['colour', { levels: { red1: 1 } }],
      ['motion', { levels: { red1: 1 } }],
      ['motion', { effect: { id: 'kick' } }],
      ['motion', { colour: { palette: 'ice' } }],
      ['lights', { levels: { tilt1: 0.5 } }],
      ['lights', { levels: { red1: 1 } }],
      ['lights', { motion: { id: 'scissor' } }],
      ['lights', { colour: { palette: 'ice' } }],
    ];
    for (const [type, part] of cases) {
      expect(() => controller.check(type, part)).toThrow(/not part of a|cannot set/);
      expect(() => controller.recall(type, part)).toThrow(PatchError);
    }
    expect(controller.getState()).toEqual(before);
  });
});
