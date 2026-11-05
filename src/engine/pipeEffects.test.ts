import { describe, expect, it } from 'vitest';
import {
  findPipeEffect,
  PIPE_EFFECTS,
  type PipeColour,
  pipeColours,
  renderPipe,
  segmentBytes,
  toBytes,
} from './pipeEffects.js';

const CYAN: PipeColour = { red: 0, green: 0.9, blue: 1 };
const MAGENTA: PipeColour = { red: 1, green: 0.1, blue: 0.66 };
const AMBER: PipeColour = { red: 1, green: 0.5, blue: 0 };
const LOOKS: PipeColour[][] = [[CYAN], [CYAN, MAGENTA], [CYAN, MAGENTA, AMBER]];

const picture = (id: string, beat: number, leds = 60, colours = LOOKS[2] ?? [], pace = 1) => {
  const out = new Float32Array(leds * 3);
  const effect = findPipeEffect(id);
  if (!effect) throw new Error(`no effect ${id}`);
  renderPipe(effect, beat, 126, pace, leds, colours, out);
  return out;
};
const sum = (values: Float32Array) => values.reduce((total, value) => total + value, 0);
/** The brightest LED of a picture. */
const brightest = (values: Float32Array) => {
  let best = 0;
  let at = 0;
  for (let i = 0; i < values.length; i += 3) {
    const level = (values[i] ?? 0) + (values[i + 1] ?? 0) + (values[i + 2] ?? 0);
    if (level > best) {
      best = level;
      at = i / 3;
    }
  }
  return at;
};

describe('the effects of the pipes', () => {
  it('has them all, found by id', () => {
    expect(PIPE_EFFECTS.map((effect) => effect.id)).toEqual([
      'solid',
      'flow',
      'slowflow',
      'flowbeat',
      'fill',
      'beatshot',
      'shot',
      'bubbles',
      'transmute',
      'shadow',
      'seal',
      'lightning',
      'pulse',
      'chase',
    ]);
    expect(findPipeEffect('nope')).toBeUndefined();
  });

  for (const effect of PIPE_EFFECTS) {
    describe(effect.id, () => {
      it('gives a valid colour for every LED, at any beat, with one, two and three colours', () => {
        for (const colours of LOOKS) {
          for (const beat of [0, 0.25, 1, 3.99, 4, 17.3, 1000.123]) {
            const out = picture(effect.id, beat, 37, colours);
            expect(out).toHaveLength(37 * 3);
            expect(
              [...out].every((value) => value >= 0 && value <= 1 && !Number.isNaN(value)),
            ).toBe(true);
          }
        }
      });

      it('gives the same picture for the same moment', () => {
        expect(picture(effect.id, 5.5)).toEqual(picture(effect.id, 5.5));
      });

      it('copes with a pipe of one LED, and with none', () => {
        expect(picture(effect.id, 2, 1)).toHaveLength(3);
        expect(picture(effect.id, 2, 0)).toHaveLength(0);
      });

      it('is not dark: the pipe always shows something', () => {
        for (const beat of [0, 0.5, 1.5, 2.9, 3.9]) {
          expect(sum(picture(effect.id, beat))).toBeGreaterThan(0.5);
        }
      });

      it('changes by little from one frame to the next at 40 frames a second', () => {
        const step = 60 / 126 / 40;
        // The shot is the exception on purpose: a head crosses the pipe in a few frames.
        if (effect.id === 'shot') return;
        const a = picture(effect.id, 7.3);
        const b = picture(effect.id, 7.3 + step);
        const change =
          a.reduce((total, value, i) => total + Math.abs(value - (b[i] ?? 0)), 0) / a.length;
        expect(change).toBeLessThan(0.05);
      });
    });
  }

  describe('shot', () => {
    it('starts on the downbeat of the bar and crosses the pipe in the first beat', () => {
      const leds = 100;
      const at = (beat: number) => brightest(picture('shot', beat, leds, [CYAN, MAGENTA, AMBER]));
      const places = [0.02, 0.1, 0.2, 0.3, 0.4].map(at);
      expect(places).toEqual([...places].sort((x, y) => x - y));
      expect(places[0]).toBeLessThan(places[places.length - 1] ?? 0);
      // Past its crossing the head is gone, and the pipe holds its dim glow.
      const after = picture('shot', 2, leds, [CYAN, MAGENTA, AMBER]);
      expect(Math.max(...after)).toBeLessThan(0.2);
    });

    it('comes again every bar, and twice per bar at pace 2', () => {
      const lit = (beat: number, pace: number) =>
        Math.max(...picture('shot', beat, 100, LOOKS[1] ?? [], pace)) > 0.5;
      expect(lit(0.1, 1)).toBe(true);
      expect(lit(4.1, 1)).toBe(true);
      expect(lit(2.1, 1)).toBe(false);
      expect(lit(2.1, 2)).toBe(true);
    });

    it('gives the head the first colour and the tail the second', () => {
      const out = picture('shot', 0.3, 100, [CYAN, MAGENTA, AMBER]);
      const head = brightest(out);
      const tail = Math.max(0, head - 15);
      // How much of a LED's light is red: the tail is further towards magenta than the head is.
      const redShare = (led: number) => {
        const [r = 0, g = 0, b = 0] = [out[led * 3], out[led * 3 + 1], out[led * 3 + 2]];
        return r / (r + g + b || 1);
      };
      expect(redShare(tail)).toBeGreaterThan(redShare(head));
      expect(out[head * 3 + 2] ?? 0).toBeGreaterThan(0.5);
    });
  });

  describe('pulse', () => {
    it('hits on every beat and falls back in between', () => {
      const level = (beat: number) => sum(picture('pulse', beat, 20, [CYAN, MAGENTA]));
      expect(level(1)).toBeGreaterThan(level(1.5));
      expect(level(2)).toBeCloseTo(level(1), 5);
      expect(level(1.5)).toBeGreaterThan(0);
    });
  });

  describe('chase and flow', () => {
    it('move: the picture of a beat later is not the same', () => {
      for (const id of ['chase', 'flow']) {
        expect(picture(id, 1)).not.toEqual(picture(id, 2));
      }
    });

    it('go faster at a higher pace, and stand still at none', () => {
      const moved = (pace: number) => {
        const a = picture('chase', 1, 60, LOOKS[2] ?? [], pace);
        const b = picture('chase', 1.2, 60, LOOKS[2] ?? [], pace);
        return a.reduce((total, value, i) => total + Math.abs(value - (b[i] ?? 0)), 0);
      };
      expect(moved(2)).toBeGreaterThan(moved(1));
      expect(moved(0)).toBe(0);
    });

    it('uses all three colours of a look', () => {
      const out = picture('chase', 0, 90, [CYAN, MAGENTA, AMBER]);
      const seen = new Set<string>();
      for (let i = 0; i < out.length; i += 3) {
        const red = (out[i] ?? 0) > 0.5 ? 'r' : '-';
        const green = (out[i + 1] ?? 0) > 0.7 ? 'g' : '-';
        seen.add(red + green);
      }
      expect(seen.size).toBeGreaterThanOrEqual(3);
    });
  });

  describe('the pace', () => {
    it('is limited as for every effect: a pace that would flash too fast is halved', () => {
      const fast = new Float32Array(60 * 3);
      const limited = new Float32Array(60 * 3);
      const effect = findPipeEffect('pulse');
      if (!effect) throw new Error('no pulse');
      // At 400 bpm the pace of 4 would be over the limit of 10 per second; it is halved to 2.
      renderPipe(effect, 1.1, 400, 4, 60, LOOKS[1] ?? [], fast);
      renderPipe(effect, 1.1, 400, 2, 60, LOOKS[1] ?? [], limited);
      expect(fast).toEqual(limited);
    });
  });
});

describe('toBytes', () => {
  it('makes the bytes of a picture, scaled by a level and kept from 0 to 255', () => {
    const into = new Uint8Array(6);
    toBytes(Float32Array.of(1, 0.5, 0, 0.2, 1, 3), 1, into);
    expect([...into]).toEqual([255, 128, 0, 51, 255, 255]);
    toBytes(Float32Array.of(1, 0.5, 0, 0.2, 1, 3), 0.5, into);
    expect([...into]).toEqual([128, 64, 0, 26, 128, 128]);
    toBytes(Float32Array.of(1, 1, 1, 1, 1, 1), -2, into);
    expect([...into]).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

/** The brightness of every LED of a picture, as the sum of its channels. */
const levels = (values: Float32Array): number[] =>
  Array.from(
    { length: values.length / 3 },
    (_, i) => (values[i * 3] ?? 0) + (values[i * 3 + 1] ?? 0) + (values[i * 3 + 2] ?? 0),
  );
const spread = (list: number[]) => Math.max(...list) - Math.min(...list);

describe('flow', () => {
  it('has thick and thin: the brightness differs a lot along the pipe, and the slugs move', () => {
    const lights = levels(picture('flow', 7.3, 300, [CYAN, MAGENTA, AMBER]));
    expect(spread(lights)).toBeGreaterThan(1.2);
    // The brightest places are the foreground colour, the dim ones the background.
    expect(picture('flow', 7.3)).not.toEqual(picture('flow', 9.3));
  });

  it('shows the foreground in the background, with the accent at the front of a slug', () => {
    const out = picture('flow', 11.1, 300, [CYAN, MAGENTA, AMBER]);
    const list = levels(out);
    const peak = list.indexOf(Math.max(...list));
    // The peak is mostly cyan, or its accent amber: green or red must be there; blue-less magenta is the background.
    expect((out[peak * 3 + 1] ?? 0) + (out[peak * 3] ?? 0)).toBeGreaterThan(0.5);
  });

  it('is made from one colour too: the background is a dim shade of it', () => {
    const out = picture('flow', 3, 120, [CYAN]);
    expect(Math.max(...out)).toBeGreaterThan(0.5);
    expect(spread(levels(out))).toBeGreaterThan(0.5);
  });
});

describe('slowflow', () => {
  it('is the flow at a quarter of the speed: the same picture four times later', () => {
    for (const beat of [0, 1.3, 5.75, 21]) {
      expect(picture('slowflow', beat * 4)).toEqual(picture('flow', beat));
    }
  });

  it('moves, but by very little in a beat', () => {
    const change = (a: Float32Array, b: Float32Array) =>
      a.reduce((total, value, i) => total + Math.abs(value - (b[i] ?? 0)), 0) / a.length;
    const slow = change(picture('slowflow', 8, 300), picture('slowflow', 9, 300));
    const fast = change(picture('flow', 8, 300), picture('flow', 9, 300));
    expect(slow).toBeGreaterThan(0);
    expect(slow).toBeLessThan(fast / 2);
  });
});

describe('flowbeat', () => {
  const mean = (values: Float32Array) => sum(values) / values.length;

  it('swells the whole pipe on the beat and falls back before the next', () => {
    // Away from the slugs the average is what the background does: high on the beat, low just before the next.
    const onBeat = mean(picture('flowbeat', 5.02, 120));
    const before = mean(picture('flowbeat', 5.95, 120));
    expect(onBeat).toBeGreaterThan(before * 1.3);
  });

  it('hits harder on the first beat of a bar than on the others', () => {
    const first = mean(picture('flowbeat', 4.02, 120));
    const other = mean(picture('flowbeat', 5.02, 120));
    expect(first).toBeGreaterThan(other);
  });

  it('has the same slugs as flow: where the liquid is thick it is brighter than the background', () => {
    const flowing = picture('flowbeat', 9.5, 120);
    const plain = picture('flow', 9.5, 120);
    expect(Math.max(...flowing)).toBeGreaterThanOrEqual(Math.max(...plain) - 1e-6);
  });

  it('pulses once per beat whatever the pace of the flow', () => {
    for (const pace of [0.25, 1, 4]) {
      const a = mean(picture('flowbeat', 6.02, 120, LOOKS[2], pace));
      const b = mean(picture('flowbeat', 6.95, 120, LOOKS[2], pace));
      expect(a).toBeGreaterThan(b);
    }
  });

  it('does not change by more than the limit allows: one hit per beat', () => {
    const effect = findPipeEffect('flowbeat');
    if (!effect) throw new Error('no flowbeat');
    const out = new Float32Array(60 * 3);
    let last = 0;
    let rises = 0;
    const bpm = 126;
    const seconds = 60;
    for (let f = 0; f < seconds * 100; f++) {
      renderPipe(effect, (f / 100) * (bpm / 60), bpm, 1, 60, LOOKS[2] ?? [], out);
      const now = sum(out);
      if (now - last > 3) rises++;
      last = now;
    }
    expect(rises / seconds).toBeLessThanOrEqual(bpm / 60 + 0.1);
  });
});

describe('fill', () => {
  const LEDS = 100;
  /** How many LEDs show the liquid, a good deal brighter than the empty pipe. */
  const wet = (beat: number) => {
    const out = picture('fill', beat, LEDS, LOOKS[1] ?? []);
    let count = 0;
    for (let i = 0; i < LEDS; i++) {
      const level = Math.max(out[i * 3] ?? 0, out[i * 3 + 1] ?? 0, out[i * 3 + 2] ?? 0);
      if (level > 0.5) count++;
    }
    return count;
  };
  /** The highest and the lowest LED that is wet. */
  const reach = (beat: number) => {
    const out = picture('fill', beat, LEDS, LOOKS[1] ?? []);
    const on: number[] = [];
    for (let i = 0; i < LEDS; i++) {
      const level = Math.max(out[i * 3] ?? 0, out[i * 3 + 1] ?? 0, out[i * 3 + 2] ?? 0);
      if (level > 0.5) on.push(i);
    }
    return [on[0] ?? -1, on[on.length - 1] ?? -1];
  };

  it('starts empty, fills from the start, stands full and runs empty again', () => {
    expect(wet(0)).toBe(0);
    expect(wet(2)).toBeGreaterThan(0);
    expect(wet(2)).toBeLessThan(wet(4));
    expect(wet(4)).toBeLessThan(wet(6));
    expect(wet(7.5)).toBe(LEDS);
    expect(wet(8)).toBe(LEDS);
    expect(wet(10)).toBeLessThan(LEDS);
    expect(wet(12)).toBeLessThan(wet(10));
    expect(wet(15.5)).toBe(0);
    expect(wet(16)).toBe(0);
  });

  it('fills from the first LED up and drains from the first LED up, so the liquid leaves by the far end', () => {
    expect(reach(4)[0]).toBe(0);
    expect(reach(4)[1]).toBeGreaterThan(20);
    expect(reach(11)[1]).toBe(LEDS - 1);
    expect(reach(11)[0]).toBeGreaterThan(20);
  });

  it('rounds in sixteen beats at pace 1 and in eight at pace 2', () => {
    const at = (beat: number, pace: number) => picture('fill', beat, 60, LOOKS[2], pace);
    expect(at(3, 1)).toEqual(at(19, 1));
    expect(at(3, 2)).toEqual(at(11, 2));
  });

  it('shows the second colour in the empty pipe, dimly', () => {
    const out = picture('fill', 0, LEDS, [CYAN, MAGENTA]);
    expect(out[0]).toBeGreaterThan(0);
    expect(Math.max(...out)).toBeLessThan(0.3);
  });
});

describe('beatshot', () => {
  const LEDS = 100;
  const lit = (beat: number, pace = 1, leds = LEDS) => {
    const out = picture('beatshot', beat, leds, LOOKS[2], pace);
    const on: number[] = [];
    for (let i = 0; i < leds; i++) {
      if (Math.max(out[i * 3] ?? 0, out[i * 3 + 1] ?? 0, out[i * 3 + 2] ?? 0) > 0) on.push(i);
    }
    return on;
  };

  it('leaves the first LED on the beat and gets to the end as the next beat comes', () => {
    expect(lit(5)[0]).toBe(0);
    expect(lit(5.5)[0]).toBeGreaterThan(30);
    expect(lit(5.5)[0]).toBeLessThan(90);
    expect(lit(5.99).at(-1)).toBe(LEDS - 1);
    expect(lit(6)[0]).toBe(0);
  });

  it('moves one way only within a beat', () => {
    let last = -1;
    for (let beat = 7; beat < 7.99; beat += 0.05) {
      const middle = lit(beat).reduce((a, b) => a + b, 0) / Math.max(1, lit(beat).length);
      expect(middle).toBeGreaterThanOrEqual(last);
      last = middle;
    }
  });

  it('is a few pixels wide and leaves every other LED black', () => {
    for (const beat of [0.2, 1.3, 2.5, 3.7]) {
      const on = lit(beat);
      expect(on.length).toBeGreaterThanOrEqual(3);
      expect(on.length).toBeLessThanOrEqual(6);
    }
    const out = picture('beatshot', 2.5, LEDS);
    const at = lit(2.5);
    for (let i = 0; i < LEDS; i++) {
      if (at.includes(i)) continue;
      expect(out.slice(i * 3, i * 3 + 3)).toEqual(new Float32Array(3));
    }
  });

  it('is as wide on a long pipe as on a short one: pixels, not a share of the pipe', () => {
    expect(lit(2.5, 1, 300).length).toBeLessThanOrEqual(6);
    expect(lit(2.5, 1, 30).length).toBeLessThanOrEqual(6);
  });

  it('shoots once per beat at pace 1, every two beats at pace ½ and twice per beat at pace 2', () => {
    expect(lit(6, 1)[0]).toBe(0);
    // At pace ½ the dot launched on beat 6 is behind the one of pace 1 half a beat later, and not home at beat 7.
    expect(lit(6.5, 0.5)[0]).toBeLessThan(lit(6.5, 1)[0] ?? 0);
    expect(lit(7, 0.5)[0]).toBeGreaterThan(0);
    expect(lit(6.5, 2)[0]).toBe(0);
  });

  it('has the foreground colour', () => {
    const out = picture('beatshot', 5, LEDS, [CYAN, MAGENTA]);
    expect(out[0]).toBeCloseTo(CYAN.red, 5);
    expect(out[2]).toBeCloseTo(CYAN.blue, 5);
  });
});

describe('lightning', () => {
  /** The number of times per second that the brightness of the pipe goes up by a clear step. */
  const flashesPerSecond = (bpm: number, pace: number) => {
    const effect = findPipeEffect('lightning');
    if (!effect) throw new Error('no lightning');
    const out = new Float32Array(60 * 3);
    let last = 0;
    let rises = 0;
    const seconds = 120;
    const frames = seconds * 100;
    for (let f = 0; f < frames; f++) {
      renderPipe(effect, (f / 100) * (bpm / 60), bpm, pace, 60, [CYAN, MAGENTA, AMBER], out);
      const now = sum(out);
      if (now - last > 6) rises++;
      last = now;
    }
    return rises / seconds;
  };

  it('strikes on some of the beats and not on others, the same every time', () => {
    const lit = (beat: number) =>
      Math.max(...picture('lightning', beat, 100, LOOKS[1] ?? [])) > 0.6;
    const beats = Array.from({ length: 40 }, (_, n) => lit(n + 0.02));
    expect(beats.some(Boolean)).toBe(true);
    expect(beats.every(Boolean)).toBe(false);
    expect(beats).toEqual(Array.from({ length: 40 }, (_, n) => lit(n + 0.02)));
  });

  it('never goes over ten changes per second, at any tempo and pace', () => {
    for (const bpm of [90, 126, 150, 180, 200]) {
      for (const pace of [0.5, 1, 2, 4]) {
        expect(flashesPerSecond(bpm, pace)).toBeLessThanOrEqual(10);
      }
    }
  });
});

describe('bubbles, transmute, shadow and seal', () => {
  it('bubbles are small bright dots over a dim liquid', () => {
    const lights = levels(picture('bubbles', 5, 300, [CYAN, MAGENTA, AMBER]));
    expect(Math.max(...lights)).toBeGreaterThan(spread(lights) * 0.6);
    expect(lights.filter((value) => value > 1).length).toBeLessThan(120);
  });

  it('transmute changes the colour of the pipe behind a front, and the front moves on', () => {
    const redShare = (beat: number, at: number) => {
      const out = picture('transmute', beat, 100, [CYAN, MAGENTA]);
      return (out[at * 3] ?? 0) - (out[at * 3 + 2] ?? 0) * 0;
    };
    // Early in the round the start has turned magenta (red) and the end is still cyan (no red).
    expect(redShare(2, 5)).toBeGreaterThan(0.3);
    expect(redShare(2, 95)).toBeLessThan(0.3);
    // Half way through the round the front is at the end and nearly everything has changed.
    expect(redShare(8.5, 50)).toBeGreaterThan(0.3);
    expect(redShare(8.5, 99)).toBeLessThan(0.3);
  });

  it('shadow is mostly lit with dark patches in it', () => {
    const lights = levels(
      picture('shadow', 6, 300, [CYAN, [0, 0, 0].length ? { red: 0, green: 0, blue: 0 } : MAGENTA]),
    );
    expect(Math.max(...lights)).toBeGreaterThan(1);
    expect(Math.min(...lights)).toBeLessThan(0.6);
  });

  it('seal sends a ring out of the middle on the downbeat, towards both ends and in step', () => {
    const at = (beat: number) => {
      const out = picture('seal', beat, 101, [
        CYAN,
        { red: 0, green: 0, blue: 0 },
        { red: 0, green: 0, blue: 0 },
      ]);
      const list = levels(out);
      // The brightest LED away from the middle.
      let best = 0;
      let place = 50;
      list.forEach((value, i) => {
        if (Math.abs(i - 50) > 4 && value > best) {
          best = value;
          place = i;
        }
      });
      return { distance: Math.abs(place - 50), best, left: place < 50 };
    };
    const early = at(0.2);
    const later = at(0.8);
    expect(later.distance).toBeGreaterThan(early.distance);
    expect(later.best).toBeGreaterThan(0.5);
    // The picture is symmetrical about the middle.
    const out = picture('seal', 0.6, 101, LOOKS[1] ?? []);
    for (let i = 0; i < 50; i++) expect(out[i * 3 + 2]).toBeCloseTo(out[(100 - i) * 3 + 2] ?? 0, 5);
  });
});

describe('pipeColours', () => {
  it('turns the colours of a palette into those of a strip without white: white mixed in, dark slots black, four at most', () => {
    const colours = pipeColours([
      { red: 1, green: 0.5, blue: 0, white: 0 },
      null,
      { red: 0, green: 0.2, blue: 0.4, white: 0.3 },
      { red: 0, green: 0, blue: 0, white: 1 },
      { red: 1, green: 1, blue: 1, white: 0 },
    ]);
    expect(colours).toHaveLength(4);
    expect(colours[1]).toEqual({ red: 0, green: 0, blue: 0 });
    expect(colours[2]).toEqual({ red: 0.3, green: 0.5, blue: 0.7 });
    expect(colours[3]).toEqual({ red: 1, green: 1, blue: 1 });
  });
});

describe('a piece of a long pipe', () => {
  // Three LEDs per pipe: LED n is [n, n, n] / 255 so that the order can be read off the bytes.
  const long = new Float32Array(
    Array.from({ length: 12 }, (_, led) => led / 255).flatMap((v) => [v, v, v]),
  );
  const bytes = (offset: number, leds: number, reverse: boolean, level = 1) => {
    const into = new Uint8Array(leds * 3);
    segmentBytes(long, offset, leds, reverse, level, into);
    return Array.from({ length: leds }, (_, i) => into[i * 3]);
  };

  it('is the LEDs from the offset on', () => {
    expect(bytes(0, 4, false)).toEqual([0, 1, 2, 3]);
    expect(bytes(4, 4, false)).toEqual([4, 5, 6, 7]);
    expect(bytes(8, 4, false)).toEqual([8, 9, 10, 11]);
  });

  it('is given back to front for a pipe that is mounted the other way round', () => {
    expect(bytes(4, 4, true)).toEqual([7, 6, 5, 4]);
  });

  it('is scaled by the level like a whole picture', () => {
    expect(bytes(8, 4, false, 0)).toEqual([0, 0, 0, 0]);
    expect(bytes(0, 4, false, 0.5)).toEqual([0, 1, 1, 2].map((_, i) => Math.round(i * 0.5)));
  });

  it('is the same as toBytes for the whole of it', () => {
    const whole = new Uint8Array(long.length);
    toBytes(long, 0.7, whole);
    const piece = new Uint8Array(long.length);
    segmentBytes(long, 0, 12, false, 0.7, piece);
    expect(Array.from(piece)).toEqual(Array.from(whole));
  });
});
