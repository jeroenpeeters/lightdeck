/**
 * The rig: every fixture on the console, and what they share.
 *
 * The rig owns the patch, so it is the one place where universes are put together:
 * each fixture controller encodes its own channels, and the rig hands the whole
 * universe to the output. It also holds what belongs to no single fixture: the tempo,
 * the blackout, the grand master, the playback of the show and the state of the link to
 * the LR512.
 *
 * Events: `fixture` (id, state, dmx, origin), `frame` (id, dmx, beat),
 * `tempo` (state, beat, origin), `blackout` (blackout, origin), `master` (level, origin),
 * `status` (status), `show` (summary), `playback` (state), `audio` (what is heard),
 * `output` (how often and how far ahead of the beat the output is made).
 */

import { EventEmitter } from 'node:events';
import { BrowserMicSource } from '../inputs/audio/browserMic.js';
import { type AudioState, Follower } from '../inputs/audio/follower.js';
import { FeedRecorder } from '../inputs/audio/recorder.js';
import type { AudioSettings } from '../inputs/audio/settings.js';
import type { BridgeStatus } from '../outputs/lr512/bridgeClient.js';
import { Patch, type UniverseOutput } from '../outputs/patch.js';
import { DEFAULT_MAX_FPS, Engine, isAnimated, readMaxFps } from './engine.js';
import { type FixtureController, PatchError, readObject } from './fixture.js';
import { FIXTURE_KINDS, type FixtureKind } from './kinds.js';
import { Playback, type PlaybackState, type ShowSummary } from './playback.js';
import { readLead, Tempo, type TempoSource, type TempoState } from './tempo.js';

export interface FixtureDefinition {
  /** Names the fixture in addresses of pages and of the API: `spider`, `spider-2`. */
  id: string;
  /** Which kind of fixture it is, a key of the kinds. */
  kind: string;
  /** What the operator calls it. */
  label: string;
  /** 0-based universe index on the bridge. */
  universe: number;
  /** 1-based DMX start address. */
  address: number;
}

export interface RigFixture extends FixtureDefinition {
  controller: FixtureController;
}

export interface LinkStatus {
  /** The server has a connection to the bridge app. */
  bridge: boolean;
  /** What the bridge says about the LR512. Unknown until it has reported. */
  device: 'open' | 'lost' | 'unknown';
  universes: number;
  /** Licensed channels per universe as reported by the bridge; empty when unknown. */
  channels: number[];
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
  /** Where the sound the console hears is written to, as WAV files. Off without it. */
  audioRecordDir?: string;
  /** Who sets the tempo at the start. Default `manual`. */
  tempoSource?: TempoSource;
  /** Settings of the listening that differ from the defaults. */
  audioSettings?: Partial<AudioSettings>;
  /** For the one-line messages of the recorder. */
  log?: (message: string) => void;
}

const ID = /^[a-z0-9][a-z0-9-]*$/;

export class Rig extends EventEmitter {
  readonly tempo: Tempo;
  /** The one clock that makes the frames of the fixtures that animate. */
  readonly engine: Engine;
  private readonly output: UniverseOutput;
  /** The microphone of the browser on the laptop. The listen page posts its sound to it. */
  readonly mic: BrowserMicSource;
  /** What is heard through the microphone, and what the tempo does with it. */
  readonly audio: Follower;
  readonly fixtures: readonly RigFixture[];
  readonly playback: Playback;

  private blackout = false;
  /** The grand master. It starts at full every time, and the show file does not keep it. */
  private master = 1;
  private link: LinkStatus = { bridge: false, device: 'unknown', universes: 0, channels: [] };
  private readonly recorder: FeedRecorder | undefined;

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
    try {
      for (const definition of options.fixtures) {
        const { id, label, universe, address } = definition;
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
        const output = patch.claim(label, universe, address, kind.profile.footprint);
        const controller = kind.create({ output, tempo: this.tempo, universe, address });
        fixtures.push({ ...definition, controller });
      }
    } catch (error) {
      for (const made of fixtures) made.controller.close();
      throw error;
    }
    this.fixtures = fixtures;

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

    this.mic = new BrowserMicSource(options.now ? { now: options.now } : {});
    this.mic.start();
    this.audio = new Follower({
      tempo: this.tempo,
      source: this.mic,
      ...(options.audioSettings ? { settings: options.audioSettings } : {}),
    });
    this.audio.on('audio', (state: AudioState) => this.emit('audio', state));
    if (options.tempoSource) this.tempo.update({ source: options.tempoSource });
    if (options.audioRecordDir !== undefined) {
      this.recorder = new FeedRecorder({
        directory: options.audioRecordDir,
        ...(options.log ? { log: options.log } : {}),
      });
      this.recorder.attach(this.mic);
    }

    for (const { id, controller } of fixtures) {
      controller.on('state', (state: unknown, origin?: string) => {
        this.emit('fixture', id, state, controller.getDmx(), origin);
      });
      controller.on('frame', (dmx: number[], beat: number) => {
        this.emit('frame', id, dmx, beat);
      });
    }
    this.tempo.on('tempo', (state: TempoState, origin?: string) => {
      this.emit('tempo', state, this.tempo.getBeat(), origin);
    });

    this.playback = new Playback({
      fixtures,
      ...(options.show === undefined ? {} : { path: options.show }),
    });
    this.playback.on('show', (show: ShowSummary) => this.emit('show', show));
    this.playback.on('playback', (state: PlaybackState) => this.emit('playback', state));
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
      : { bridge: false, device: 'unknown', universes: 0, channels: [] };
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
    this.playback.close();
    for (const { controller } of this.fixtures) controller.close();
    this.recorder?.detach();
    this.audio.close();
    this.mic.stop();
    this.mic.removeAllListeners();
    this.tempo.removeAllListeners();
    this.removeAllListeners();
  }
}
