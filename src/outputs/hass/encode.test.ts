import { describe, expect, it } from 'vitest';
import {
  lightCommand,
  numberCommand,
  paletteCommand,
  sameCommand,
  speedCommand,
  stripCommand,
  switchCommand,
} from './encode.js';

const WHITE = { red: 0, green: 0, blue: 0, white: 1 };
const RED = { red: 1, green: 0, blue: 0, white: 0 };
const AMBER = { red: 1, green: 0.5, blue: 0, white: 0.2 };
const BLACK = { red: 0, green: 0, blue: 0, white: 0 };

describe('lightCommand', () => {
  it('turns a light on with brightness, colour and transition, as rgbw when it can', () => {
    expect(
      lightCommand({ brightness: 1, colour: AMBER, modes: ['rgbw', 'color_temp'], transition: 2 }),
    ).toEqual({
      domain: 'light',
      service: 'turn_on',
      data: { brightness: 255, rgbw_color: [255, 128, 0, 51], transition: 2 },
    });
  });

  it('scales the brightness to 1..255', () => {
    const at = (brightness: number) =>
      lightCommand({ brightness, colour: RED, modes: ['rgbw'], transition: 0 }).data?.brightness;
    expect(at(0.5)).toBe(128);
    expect(at(0.0001)).toBe(1);
    expect(at(2)).toBe(255);
  });

  it('writes rgb, xy and hs lights as rgb_color with the white mixed in', () => {
    for (const mode of ['rgb', 'xy', 'hs']) {
      const command = lightCommand({ brightness: 1, colour: AMBER, modes: [mode], transition: 1 });
      expect(command.data).toEqual({
        brightness: 255,
        rgb_color: [255, 179, 51],
        transition: 1,
      });
    }
    const white = lightCommand({ brightness: 1, colour: WHITE, modes: ['xy'], transition: 0 });
    expect(white.data?.rgb_color).toEqual([255, 255, 255]);
  });

  it('prefers rgbw to rgb when a light has both', () => {
    const command = lightCommand({
      brightness: 1,
      colour: RED,
      modes: ['rgb', 'rgbw'],
      transition: 0,
    });
    expect(command.data).toHaveProperty('rgbw_color');
    expect(command.data).not.toHaveProperty('rgb_color');
  });

  it('sends no colour to a light with brightness only or colour temperature only', () => {
    for (const modes of [['brightness'], ['color_temp'], ['white']]) {
      const command = lightCommand({ brightness: 0.5, colour: RED, modes, transition: 0 });
      expect(command.data).toEqual({ brightness: 128, transition: 0 });
    }
  });

  it('sends rgbw_color until the entity has reported', () => {
    for (const modes of [undefined, []]) {
      const command = lightCommand({ brightness: 1, colour: RED, modes, transition: 0 });
      expect(command.data?.rgbw_color).toEqual([255, 0, 0, 0]);
    }
  });

  it('turns a light that is on/off only on without brightness or transition', () => {
    expect(lightCommand({ brightness: 0.4, colour: RED, modes: ['onoff'], transition: 3 })).toEqual(
      {
        domain: 'light',
        service: 'turn_on',
      },
    );
    expect(lightCommand({ brightness: 0, colour: RED, modes: ['onoff'], transition: 3 })).toEqual({
      domain: 'light',
      service: 'turn_off',
    });
  });

  it('turns a light off, with the transition, at brightness 0 or for a black colour', () => {
    expect(lightCommand({ brightness: 0, colour: RED, modes: ['rgbw'], transition: 1.26 })).toEqual(
      {
        domain: 'light',
        service: 'turn_off',
        data: { transition: 1.3 },
      },
    );
    expect(lightCommand({ brightness: 1, colour: BLACK, modes: ['rgbw'], transition: 0 })).toEqual({
      domain: 'light',
      service: 'turn_off',
      data: { transition: 0 },
    });
  });

  it('keeps the transition within what makes sense', () => {
    const at = (transition: number) =>
      lightCommand({ brightness: 1, colour: RED, modes: ['rgbw'], transition }).data?.transition;
    expect(at(0.04)).toBe(0);
    expect(at(-5)).toBe(0);
    expect(at(Number.NaN)).toBe(0);
    expect(at(10_000)).toBe(300);
  });
});

describe('switchCommand', () => {
  it('turns a switch on or off, with nothing else', () => {
    expect(switchCommand(true)).toEqual({ domain: 'switch', service: 'turn_on' });
    expect(switchCommand(false)).toEqual({ domain: 'switch', service: 'turn_off' });
  });
});

describe('sameCommand', () => {
  it('compares by content, whatever the order of the keys', () => {
    const a = lightCommand({ brightness: 1, colour: RED, modes: ['rgbw'], transition: 1 });
    const b = {
      domain: 'light' as const,
      service: 'turn_on' as const,
      data: { transition: 1, rgbw_color: [255, 0, 0, 0], brightness: 255 },
    };
    expect(sameCommand(a, b)).toBe(true);
  });

  it('tells commands apart', () => {
    const a = lightCommand({ brightness: 1, colour: RED, modes: ['rgbw'], transition: 1 });
    expect(
      sameCommand(
        a,
        lightCommand({ brightness: 0.5, colour: RED, modes: ['rgbw'], transition: 1 }),
      ),
    ).toBe(false);
    expect(sameCommand(a, switchCommand(true))).toBe(false);
    expect(sameCommand(a, undefined)).toBe(false);
    expect(sameCommand(undefined, undefined)).toBe(true);
  });
});

describe('stripCommand', () => {
  const look = {
    brightness: 0.5,
    colour: { red: 0, green: 0.5, blue: 1 },
    effect: 'Flow',
    transition: 0.4,
  };

  it('turns a strip on with its colour as a direction, its brightness, its effect and a transition', () => {
    expect(stripCommand(look)).toEqual({
      domain: 'light',
      service: 'turn_on',
      data: { brightness: 128, rgb_color: [0, 128, 255], effect: 'Flow', transition: 0.4 },
    });
  });

  it('asks for the solid colour without an effect, because a light keeps the effect it had', () => {
    expect(stripCommand({ ...look, effect: null }).data?.effect).toBe('Solid');
  });

  it('never sends 0 for a strip that is on, and turns it off at 0', () => {
    expect(stripCommand({ ...look, brightness: 0.0001 }).data?.brightness).toBe(1);
    expect(stripCommand({ ...look, brightness: 0, transition: 0 })).toEqual({
      domain: 'light',
      service: 'turn_off',
      data: { transition: 0 },
    });
  });

  it('keeps a black colour from dividing by nothing', () => {
    expect(
      stripCommand({ ...look, colour: { red: 0, green: 0, blue: 0 } }).data?.rgb_color,
    ).toEqual([0, 0, 0]);
  });
});

describe('speedCommand', () => {
  it('sets the value of a number entity, whole and from 0 to 255', () => {
    expect(speedCommand(126.4)).toEqual({
      domain: 'number',
      service: 'set_value',
      data: { value: 126 },
    });
    expect(speedCommand(900).data?.value).toBe(255);
    expect(speedCommand(-4).data?.value).toBe(0);
    expect(speedCommand(Number.NaN).data?.value).toBe(0);
  });
});

describe('paletteCommand and numberCommand', () => {
  it('selects a palette of a WLED strip by name', () => {
    expect(paletteCommand('Orange & Teal')).toEqual({
      domain: 'select',
      service: 'select_option',
      data: { option: 'Orange & Teal' },
    });
  });

  it('sets a number entity whole, between 0 and 255; the speed is one of them', () => {
    expect(numberCommand(40.6).data?.value).toBe(41);
    expect(numberCommand(300).data?.value).toBe(255);
    expect(speedCommand(10)).toEqual(numberCommand(10));
  });
});
