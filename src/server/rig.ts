/**
 * The rig: every fixture on the console, and what they share.
 *
 * The rig owns the patch, so it is the one place where universes are put together:
 * each fixture controller encodes its own channels, and the rig hands the whole
 * universe to the output. It also holds what belongs to no single fixture: the tempo,
 * the blackout, the grand master, the playback of the show and the state of the link to
 * the LR512.
 *
 * A fixture speaks DMX, and then it claims channels of a universe from the patch, or it speaks
 * to Home Assistant (the room, with its lamps), and then it gets the output for Home Assistant.
 * What the rig holds for every fixture does not depend on which.
 *
 * Events: `fixture` (id, state, dmx, origin; `dmx` is undefined for a fixture that is not
 * on DMX), `frame` (id, dmx, beat),
 * `tempo` (state, beat, origin), `blackout` (blackout, origin), `master` (level, origin),
 * `status` (status), `show` (summary), `playback` (state), `rkbx` (what rekordbox says),
 * `output` (how often and how far ahead of the beat the output is made), `videowall` (the settings
 * of the video wall and what is on it).
 */

import { EventEmitter } from 'node:events';
import { PaletteBook } from '../engine/palette.js';
import { RkbxFollower, type RkbxState } from '../inputs/rkbx/follower.js';
import { OscReceiver } from '../inputs/rkbx/receiver.js';
import type { HassOutput, HassStatus } from '../outputs/hass/types.js';
import type { BridgeStatus } from '../outputs/lr512/bridgeClient.js';
import { Patch, type UniverseOutput } from '../outputs/patch.js';
import { DEFAULT_MAX_FPS, Engine, isAnimated, readMaxFps } from './engine.js';
import {
  type DmxFixtureController,
  type FixtureController,
  PatchError,
  readObject,
} from './fixture.js';
import { FIXTURE_KINDS, type FixtureKind } from './kinds.js';
import { Playback, type PlaybackState, type ShowSummary } from './playback.js';
import type { LampDefinition, ZoneDefinition } from './roomController.js';
import { Sequencer, type SequenceState } from './sequencer.js';
import { readLead, Tempo, type TempoSource, type TempoState } from './tempo.js';
import { VideoWall, type VideoWallState } from './videoWall.js';

/** What every fixture is called, whatever it speaks. */
interface FixtureNaming {
  /** Names the fixture in addresses of pages and of the API: `spider`, `spider-2`. */
  id: string;
  /** Which kind of fixture it is, a key of the kinds. */
  kind: string;
  /** What the operator calls it. */
  label: string;
}

/** A fixture on a DMX universe. */
export interface DmxFixtureDefinition extends FixtureNaming {
  /** 0-based universe index on the bridge. */
  universe: number;
  /** 1-based DMX start address. */
  address: number;
}

/** A fixture that Home Assistant drives: the lamps and switches of the room. */
export interface HassFixtureDefinition extends FixtureNaming {
  lamps: LampDefinition[];
  zones?: ZoneDefinition[];
}

export type FixtureDefinition = DmxFixtureDefinition | HassFixtureDefinition;

export type RigFixture =
  | (DmxFixtureDefinition & { protocol: 'dmx'; controller: DmxFixtureController })
  | (HassFixtureDefinition & { protocol: 'hass'; controller: FixtureController });

export interface LinkStatus {
  /** The server has a connection to the bridge app. */
  bridge: boolean;
  /** What the bridge says about the LR512. Unknown until it has reported. */
  device: 'open' | 'lost' | 'unknown';
  universes: number;
  /** Licensed channels per universe as reported by the bridge; empty when unknown. */
  channels: number[];
  /**
   * The link to Home Assistant. Left out while no fixture is driven by it: then there is
   * nothing to be linked to.
   */
  hass?: HassStatus;
}

/** How the output is made: how often, and how far ahead of the beat. */
export interface OutputSettings {
  /** The most frames per second, for the effects and for the output. */
  maxFps: number;
  /** Milliseconds by which the output is made ahead of the beat, to make up for the path to the light. */
  leadMs: number;
}

export interface RigOptions {
  output: UniverseOutput;
  /** Where the commands for Home Assistant go. Needed when a fixture is driven by it. */
  hass?: HassOutput;
  /** The most frames per second. Default 25, which is what the original Light Rider app sends. */
  maxFps?: number;
  /** Milliseconds by which the output is made ahead of the beat. Default 0. */
  leadMs?: number;
  fixtures: readonly FixtureDefinition[];
  kinds?: Readonly<Record<string, FixtureKind>>;
  /** Where the show file is. Without it the show is kept in memory only. */
  show?: string;
  /** Monotonic clock in milliseconds. Tests pass their own. */
  now?: () => number;
  /** Who sets the tempo at the start. Default `manual`. */
  tempoSource?: TempoSource;
  /** The UDP port to listen on for the OSC of rkbx_link. Without it nothing listens. */
  rkbxPort?: number;
  /** The file with the settings of the video wall. Without it they are kept in memory only. */
  videoWallFile?: string;
  /** How the video wall is called. Tests pass their own. */
  videoWallFetch?: typeof fetch;
  /** For the one-line messages about rekordbox. */
  log?: (message: string) => void;
}

const ID = /^[a-z0-9][a-z0-9-]*$/;

export class Rig extends EventEmitter {
  readonly tempo: Tempo;
  /** The one clock that makes the frames of the fixtures that animate. */
  readonly engine: Engine;
  private readonly output: UniverseOutput;
  /** The OSC that rkbx_link sends from the computer that runs rekordbox. */
  private readonly oscReceiver: OscReceiver;
  /** What rekordbox says, and what the tempo does with it. */
  readonly rkbx: RkbxFollower;
  /** The track that is playing, sent to the text overlay of the video wall. */
  readonly videoWall: VideoWall;
  readonly fixtures: readonly RigFixture[];
  readonly playback: Playback;
  /** Runs a sequence of the show: the looks of the groups changing on the bars. */
  readonly sequencer: Sequencer;
  /** The palettes of the show, where the fixtures look them up. The playback keeps them. */
  readonly palettes = new PaletteBook();

  private blackout = false;
  /** The grand master. It starts at full every time, and the show file does not keep it. */
  private master = 1;
  private link: LinkStatus;

  /** Throws when a fixture is unknown, named twice, or does not fit where it is put. */
  constructor(options: RigOptions) {
    super();
    const kinds = options.kinds ?? FIXTURE_KINDS;
    this.tempo = new Tempo(options.now ? { now: options.now } : {});
    this.output = options.output;
    // Checked before anything is made, so that nothing has to be taken down again.
    const maxFps = readMaxFps(options.maxFps ?? DEFAULT_MAX_FPS);
    this.tempo.setLead(options.leadMs ?? 0);
    const patch = new Patch(options.output);

    const fixtures: RigFixture[] = [];
    const entities = new Set<string>();
    try {
      for (const definition of options.fixtures) {
        const { id, label } = definition;
        if (!ID.test(id)) {
          throw new Error(`"${id}" cannot name a fixture: use small letters, digits and dashes`);
        }
        if (fixtures.some((f) => f.id === id)) throw new Error(`two fixtures are called "${id}"`);
        const kind = kinds[definition.kind];
        if (!kind) {
          throw new Error(
            `"${id}" is a ${definition.kind}, which lightdeck does not know. It knows: ${Object.keys(kinds).join(', ')}`,
          );
        }
        if (kind.protocol === 'dmx') {
          const { universe, address } = definition as DmxFixtureDefinition;
          if (!Number.isInteger(universe) || !Number.isInteger(address)) {
            throw new Error(`"${id}" is on DMX and needs a universe and an address`);
          }
          const output = patch.claim(label, universe, address, kind.profile.footprint);
          const controller = kind.create({
            output,
            tempo: this.tempo,
            palettes: this.palettes,
            universe,
            address,
          });
          fixtures.push({ ...(definition as DmxFixtureDefinition), protocol: 'dmx', controller });
        } else {
          const { lamps, zones } = definition as HassFixtureDefinition;
          if (!Array.isArray(lamps)) throw new Error(`"${id}" needs a list of lamps`);
          if (!options.hass) {
            throw new Error(
              `"${id}" is driven by Home Assistant, and lightdeck was not given a connection to it`,
            );
          }
          for (const lamp of lamps) {
            if (entities.has(lamp.entity)) {
              throw new Error(`${lamp.entity} is a lamp of two fixtures, and may be of one only`);
            }
            entities.add(lamp.entity);
          }
          const controller = kind.create({
            hass: options.hass,
            tempo: this.tempo,
            palettes: this.palettes,
            lamps,
            zones: zones ?? [],
          });
          fixtures.push({ ...(definition as HassFixtureDefinition), protocol: 'hass', controller });
        }
      }
    } catch (error) {
      for (const made of fixtures) made.controller.close();
      throw error;
    }
    this.fixtures = fixtures;
    this.link = {
      bridge: false,
      device: 'unknown',
      universes: 0,
      channels: [],
      ...(fixtures.some((fixture) => fixture.protocol === 'hass') ? { hass: 'down' as const } : {}),
    };

    this.engine = new Engine({
      tempo: this.tempo,
      maxFps,
      ...(options.log
        ? {
            onError: (error) => options.log?.(`a fixture could not make a frame: ${String(error)}`),
          }
        : {}),
    });
    this.output.setMaxFps?.(maxFps);
    for (const { controller } of fixtures) {
      if (isAnimated(controller)) this.engine.add(controller);
    }

    this.oscReceiver = new OscReceiver({
      ...(options.rkbxPort === undefined ? {} : { port: options.rkbxPort }),
      ...(options.now ? { now: options.now } : {}),
    });
    this.rkbx = new RkbxFollower({ tempo: this.tempo, receiver: this.oscReceiver });
    this.rkbx.on('rkbx', (state: RkbxState) => this.emit('rkbx', state));
    this.videoWall = new VideoWall({
      source: this.rkbx,
      ...(options.videoWallFile ? { file: options.videoWallFile } : {}),
      ...(options.videoWallFetch ? { fetch: options.videoWallFetch } : {}),
      ...(options.log ? { log: options.log } : {}),
    });
    this.videoWall.on('videowall', (state: VideoWallState) => this.emit('videowall', state));
    if (options.rkbxPort !== undefined) {
      // Lightdeck runs without rekordbox: a port that is taken is said once, and not fatal.
      this.oscReceiver
        .start()
        .then(() => {
          options.log?.(`rekordbox: listening for rkbx_link on UDP ${this.oscReceiver.port}`);
          this.rkbx.refresh();
        })
        .catch((error: Error) =>
          options.log?.(`rekordbox: cannot listen on UDP ${options.rkbxPort}: ${error.message}`),
        );
    }
    if (options.tempoSource) this.tempo.update({ source: options.tempoSource });

    for (const fixture of fixtures) {
      const { id, controller } = fixture;
      controller.on('state', (state: unknown, origin?: string) => {
        this.emit(
          'fixture',
          id,
          state,
          fixture.protocol === 'dmx' ? fixture.controller.getDmx() : undefined,
          origin,
        );
      });
      if (fixture.protocol === 'dmx') {
        fixture.controller.on('frame', (dmx: number[], beat: number) => {
          this.emit('frame', id, dmx, beat);
        });
      }
    }
    this.tempo.on('tempo', (state: TempoState, origin?: string) => {
      this.emit('tempo', state, this.tempo.getBeat(), origin);
    });

    this.playback = new Playback({
      fixtures,
      palettes: this.palettes,
      ...(options.show === undefined ? {} : { path: options.show }),
    });
    this.playback.on('show', (show: ShowSummary) => this.emit('show', show));
    this.playback.on('playback', (state: PlaybackState) => this.emit('playback', state));
    this.sequencer = new Sequencer({
      tempo: this.tempo,
      playback: this.playback,
      ...(options.log ? { log: (message: string) => options.log?.(message) } : {}),
    });
    this.sequencer.on('sequence', (state: SequenceState) => this.emit('sequence', state));
  }

  find(id: string): RigFixture | undefined {
    return this.fixtures.find((fixture) => fixture.id === id);
  }

  getOutput(): OutputSettings {
    return { maxFps: this.engine.getMaxFps(), leadMs: this.tempo.leadMs };
  }

  /**
   * Changes how the output is made. Throws a `PatchError`, and changes nothing, when any part
   * of it is wrong.
   */
  setOutput(patch: unknown): OutputSettings {
    const given = readObject(patch, 'the output settings', ['maxFps', 'leadMs']);
    const maxFps = given.maxFps === undefined ? this.engine.getMaxFps() : readMaxFps(given.maxFps);
    const leadMs = given.leadMs === undefined ? this.tempo.leadMs : readLead(given.leadMs);
    this.engine.setMaxFps(maxFps);
    this.output.setMaxFps?.(maxFps);
    this.tempo.setLead(leadMs);
    const settings = this.getOutput();
    this.emit('output', settings);
    return settings;
  }

  getBlackout(): boolean {
    return this.blackout;
  }

  /** Darkens every fixture, or lets them show again what they are set to. */
  setBlackout(blackout: unknown, origin?: string): void {
    if (typeof blackout !== 'boolean') throw new PatchError('blackout must be true or false');
    this.blackout = blackout;
    for (const { controller } of this.fixtures) controller.setBlackout(blackout);
    this.emit('blackout', blackout, origin);
  }

  getMaster(): number {
    return this.master;
  }

  /**
   * Sets the grand master, 0 to 1. Every fixture sends its brightness times the master;
   * what the fixtures are set to stays what it is.
   */
  setMaster(level: unknown, origin?: string): void {
    if (typeof level !== 'number' || !Number.isFinite(level) || level < 0 || level > 1) {
      throw new PatchError('the master must be a number between 0 and 1');
    }
    this.master = level;
    for (const { controller } of this.fixtures) controller.setMaster(level);
    this.emit('master', level, origin);
  }

  getStatus(): LinkStatus {
    return { ...this.link, channels: [...this.link.channels] };
  }

  setBridgeConnected(connected: boolean): void {
    this.link = connected
      ? { ...this.link, bridge: true }
      : { ...this.link, bridge: false, device: 'unknown', universes: 0, channels: [] };
    this.emit('status', this.getStatus());
  }

  /** What the link to Home Assistant is. Without a fixture that it drives it is not shown. */
  setHassStatus(status: HassStatus): void {
    if (this.link.hass === undefined || this.link.hass === status) return;
    this.link = { ...this.link, hass: status };
    this.emit('status', this.getStatus());
  }

  setDeviceStatus(status: BridgeStatus): void {
    this.link = {
      ...this.link,
      device: status.device,
      universes: status.universes,
      channels: [...status.channels],
    };
    this.emit('status', this.getStatus());
  }

  /** For when lightdeck stops: fixtures that must not stay on go dark. */
  darken(): void {
    for (const { controller } of this.fixtures) controller.darken();
  }

  close(): void {
    this.engine.close();
    this.sequencer.close();
    this.playback.close();
    for (const { controller } of this.fixtures) controller.close();
    this.videoWall.close();
    this.rkbx.close();
    this.oscReceiver.stop();
    this.tempo.removeAllListeners();
    this.removeAllListeners();
  }
}
