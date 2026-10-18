/**
 * The kinds of fixture lightdeck knows. A kind couples a fixture to the controller that
 * drives it, and says which protocol it speaks: a DMX kind has a profile, the channels it
 * claims on a universe, and a controller that fits `DmxFixtureController`; a Home Assistant
 * kind has the lamps of the rig and a controller that fits `FixtureController`. The page of a
 * kind is `public/fixtures/<kind>.html`.
 *
 * To add a kind: write its profile in `src/fixtures/` (DMX), a controller, an entry here, and
 * its page.
 */

import {
  LASER_COLOUR_SETTING,
  LASER_EFFECTS,
  LASER_EFFECTS_MODE,
  LASER_MOTION_EFFECTS,
} from '../engine/laserEffects.js';
import type { PaletteBook } from '../engine/palette.js';
import { ALIEN_LASER_10CH, LASER_GATE } from '../fixtures/laser.js';
import type { FixtureProfile } from '../fixtures/profile.js';
import { SPIDER_43CH, SPIDER_LAYOUT } from '../fixtures/spider.js';
import type { HassOutput } from '../outputs/hass/types.js';
import type { UniverseOutput } from '../outputs/patch.js';
import type { DmxFixtureController, FixtureController } from './fixture.js';
import { LaserController } from './laserController.js';
import { type LampDefinition, RoomController, type ZoneDefinition } from './roomController.js';
import { SpiderController } from './spiderController.js';
import type { Tempo } from './tempo.js';

export interface DmxKindOptions {
  /** Takes whole universes and keeps the channels of this fixture. */
  output: UniverseOutput;
  tempo: Tempo;
  /** The palettes of the show, for the kinds of fixture that are coloured by them. */
  palettes: PaletteBook;
  universe: number;
  address: number;
}

/** What a fixture on a DMX universe is made of. */
export interface DmxKind {
  protocol: 'dmx';
  profile: FixtureProfile;
  create(options: DmxKindOptions): DmxFixtureController;
}

export interface HassKindOptions {
  /** Where the commands for Home Assistant go, and what it says comes from. */
  hass: HassOutput;
  tempo: Tempo;
  palettes: PaletteBook;
  lamps: LampDefinition[];
  zones: ZoneDefinition[];
}

/** What a fixture that Home Assistant drives is made of. */
export interface HassKind {
  protocol: 'hass';
  create(options: HassKindOptions): FixtureController;
}

export type FixtureKind = DmxKind | HassKind;

export const FIXTURE_KINDS: Readonly<Record<string, FixtureKind>> = {
  spider: {
    protocol: 'dmx',
    profile: SPIDER_43CH,
    create: (options) =>
      new SpiderController({ profile: SPIDER_43CH, layout: SPIDER_LAYOUT, ...options }),
  },
  laser: {
    protocol: 'dmx',
    profile: ALIEN_LASER_10CH,
    create: ({ palettes: _palettes, ...options }) =>
      new LaserController({
        profile: ALIEN_LASER_10CH,
        gate: LASER_GATE,
        effects: { list: LASER_EFFECTS, motion: LASER_MOTION_EFFECTS, mode: LASER_EFFECTS_MODE },
        colourSetting: { control: 'colour', range: 'single', max: LASER_COLOUR_SETTING },
        ...options,
      }),
  },
  room: {
    protocol: 'hass',
    create: (options) => new RoomController(options),
  },
};
