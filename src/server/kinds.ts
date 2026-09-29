/**
 * The kinds of fixture lightdeck knows. A kind couples a fixture profile to the
 * controller that drives it. The page of a kind is `public/fixtures/<kind>.html`.
 *
 * To add a kind: write its profile in `src/fixtures/`, a controller that fits
 * `FixtureController`, an entry here, and its page.
 */

import { LASER_EFFECTS, LASER_EFFECTS_MODE } from '../engine/laserEffects.js';
import { ALIEN_LASER_10CH, LASER_GATE } from '../fixtures/laser.js';
import type { FixtureProfile } from '../fixtures/profile.js';
import { SPIDER_43CH, SPIDER_LAYOUT } from '../fixtures/spider.js';
import type { UniverseOutput } from '../outputs/patch.js';
import type { FixtureController } from './fixture.js';
import { LaserController } from './laserController.js';
import { SpiderController } from './spiderController.js';
import type { Tempo } from './tempo.js';

export interface KindOptions {
  /** Takes whole universes and keeps the channels of this fixture. */
  output: UniverseOutput;
  tempo: Tempo;
  universe: number;
  address: number;
}

export interface FixtureKind {
  profile: FixtureProfile;
  create(options: KindOptions): FixtureController;
}

export const FIXTURE_KINDS: Readonly<Record<string, FixtureKind>> = {
  spider: {
    profile: SPIDER_43CH,
    create: (options) =>
      new SpiderController({ profile: SPIDER_43CH, layout: SPIDER_LAYOUT, ...options }),
  },
  laser: {
    profile: ALIEN_LASER_10CH,
    create: (options) =>
      new LaserController({
        profile: ALIEN_LASER_10CH,
        gate: LASER_GATE,
        effects: { list: LASER_EFFECTS, mode: LASER_EFFECTS_MODE },
        ...options,
      }),
  },
};
