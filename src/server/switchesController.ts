/**
 * The switches of the decor (Jeroen, 2026-10-30): the two UV lamps that light the symbols on the
 * cabinet, `switch.uv_lamp_1` and `switch.uv_lamp_2` in Home Assistant. They are a fixture of their
 * own, "Decor", and not lamps of the room, because they have none of what the room has: no
 * brightness, no colour, no palette and no effect, only on and off.
 *
 * Every switch is on or off (`on`), as the operator set it, apart or together. The decor is part
 * of no scene: a look, a recall, a step of a sequence or the Off of a group neither switches a
 * switch on nor off, as nothing but the operator switches the rails of the room, so a scene that
 * names one is refused. The blackout is not state, it changes what goes out and leaves what is set:
 * a switch goes off at once with the blackout of the console when it follows it (`follows`, which
 * the rig file gives at the start and the tablet changes while the show runs, Jeroen: "I want to be
 * able to set whether they take part in the general blackout"), and back on when it is lifted, if
 * it was set on. The blackout of the decor alone (`blackout` in the state) is the operator pressing
 * it on purpose, and switches every switch off whether it follows or not. The master is not
 * followed: a switch has no brightness.
 *
 * Every command is urgent (two switches, pressed by hand: they answer at once, not after the second
 * that a lamp waits between two commands).
 *
 * Lightdeck never touches a switch at startup: it stays as it is until something is set, and what
 * Home Assistant says is shown next to what is wanted (`reported`, `problems`) and never changes
 * it. The switches stay as they are when lightdeck stops, as the lamps of the room do.
 */

import { EventEmitter } from 'node:events';
import type { SceneType } from '../fixtures/profile.js';
import { switchCommand } from '../outputs/hass/encode.js';
import type { EntityReport, HassOutput } from '../outputs/hass/types.js';
import { type FixtureController, PatchError, readObject } from './fixture.js';

/** One switch of Home Assistant in the decor. */
export interface SwitchDefinition {
  /** Names the switch within the fixture: `uv1`. */
  id: string;
  /** What the operator calls it. */
  label: string;
  /** The entity in Home Assistant: `switch.uv_lamp_1`. */
  entity: string;
  /** Whether it goes off in the blackout of the console, at the start. Default false. */
  blackout?: boolean;
}

/** What Home Assistant says about a switch. */
export interface SwitchReport {
  available: boolean;
  on: boolean;
}

export interface SwitchesState {
  /** Per switch, whether it is set on. At rest off. */
  on: Record<string, boolean>;
  /** Per switch, whether it goes off with the blackout of the console. Not part of any scene. */
  follows: Record<string, boolean>;
  /** The blackout of the decor alone: every switch off, with what is set kept. */
  blackout: boolean;
  /** What Home Assistant says per switch. Not set with `update`. */
  reported: Record<string, SwitchReport | null>;
  /** Why the last command for a switch did not arrive, or null. */
  problems: Record<string, string | null>;
}

export interface SwitchesOptions {
  hass: HassOutput;
  switches: readonly SwitchDefinition[];
}

const ID = /^[a-z0-9][a-z0-9-]*$/;
const ENTITY = /^switch\.[a-z0-9_]+$/;
const UPDATE_KEYS = ['on', 'follows', 'blackout'];

export class SwitchesController extends EventEmitter implements FixtureController {
  readonly takesPalettes = false;

  private readonly hass: HassOutput;
  private readonly switches: SwitchDefinition[];
  private readonly stops: Array<() => void> = [];
  /** What each switch was last wanted to be, so that only a change is a command. */
  private readonly wanted = new Map<string, boolean>();
  private disposed = false;

  private state: SwitchesState;
  /** The blackout of the console. It is not part of the state of the fixture. */
  private blackout = false;

  /** Throws an `Error` that says what is wrong with the switches. */
  constructor(options: SwitchesOptions) {
    super();
    this.hass = options.hass;
    if (options.switches.length === 0) throw new Error('the decor needs at least one switch');
    const made: SwitchDefinition[] = [];
    for (const definition of options.switches) {
      const { id, entity } = definition;
      if (!ID.test(id)) {
        throw new Error(`"${id}" cannot name a switch: use small letters, digits and dashes`);
      }
      if (made.some((each) => each.id === id)) throw new Error(`two switches are called "${id}"`);
      if (!ENTITY.test(entity)) {
        throw new Error(
          `the switch "${id}" has the entity "${entity}", which is not a switch of Home Assistant (switch.name)`,
        );
      }
      const used = made.find((each) => each.entity === entity);
      if (used) {
        throw new Error(`the switches "${used.id}" and "${id}" are the same entity ${entity}`);
      }
      made.push({ ...definition });
    }
    this.switches = made;

    this.state = {
      on: Object.fromEntries(made.map(({ id }) => [id, false])),
      follows: Object.fromEntries(made.map(({ id, blackout }) => [id, blackout === true])),
      blackout: false,
      reported: Object.fromEntries(made.map(({ id }) => [id, null])),
      problems: Object.fromEntries(made.map(({ id }) => [id, null])),
    };
    // What the switches are wanted to be at the start, so that only a change is a command.
    for (const each of made) this.wanted.set(each.id, this.goal(each.id));

    for (const each of made) {
      this.stops.push(
        this.hass.watch(each.entity, (report) => this.heard(each, report)),
        this.hass.problems(each.entity, (problem) => this.complained(each, problem)),
      );
    }
  }

  getState(): SwitchesState {
    return {
      on: { ...this.state.on },
      follows: { ...this.state.follows },
      blackout: this.state.blackout,
      reported: Object.fromEntries(
        Object.entries(this.state.reported).map(([id, report]) => [id, report && { ...report }]),
      ),
      problems: { ...this.state.problems },
    };
  }

  describe(): Record<string, unknown> {
    return {
      switches: this.switches.map(({ id, label, entity }) => ({ id, label, entity })),
    };
  }

  update(change: unknown, origin?: string): void {
    const patch = readObject(change, 'a change of the decor', UPDATE_KEYS);
    const on = { ...this.state.on };
    const follows = { ...this.state.follows };
    for (const [key, target] of [
      ['on', on],
      ['follows', follows],
    ] as const) {
      const given = patch[key];
      if (given === undefined) continue;
      const map = readObject(given, `"${key}" of the decor`);
      for (const [id, value] of Object.entries(map)) {
        if (!this.switches.some((each) => each.id === id)) {
          throw new PatchError(`there is no switch called "${id}"`);
        }
        if (typeof value !== 'boolean') {
          throw new PatchError(`"${key}" of "${id}" must be true or false`);
        }
        target[id] = value;
      }
    }
    if (patch.blackout !== undefined && typeof patch.blackout !== 'boolean') {
      throw new PatchError('the blackout must be true or false');
    }
    const blackout = (patch.blackout as boolean | undefined) ?? this.state.blackout;
    // Dark at once, as the blackout of the console is, and back at once too: a switch has no glide.
    this.state = { ...this.state, on, follows, blackout };
    this.sync();
    this.emit('state', this.getState(), origin);
  }

  /** The decor is part of no scene: there is nothing to keep. */
  snapshot(_type: SceneType): Record<string, unknown> {
    return {};
  }

  /** A part that names anything is refused, because nothing of the decor is in a scene. */
  check(_type: SceneType, part: unknown): void {
    if (part === undefined || part === null) return;
    const named = Object.keys(readObject(part, 'the decor in a scene'));
    if (named.length > 0) {
      throw new PatchError(
        `the decor is part of no scene, so a scene cannot name "${named[0]}": the switches are set by hand`,
      );
    }
  }

  /** Leaves the switches as they are, whatever the type: a look or the Off of a group is not for them. */
  recall(type: SceneType, part: unknown): void {
    this.check(type, part);
  }

  act(name: string): void {
    throw new PatchError(`the decor has nothing called "${name}"`);
  }

  setBlackout(blackout: boolean): void {
    if (blackout === this.blackout) return;
    this.blackout = blackout;
    this.sync();
  }

  /** A switch has no brightness: the master does nothing here. */
  setMaster(_level: number): void {}

  /** The switches stay as they are when lightdeck stops. */
  darken(): void {}

  close(): void {
    this.disposed = true;
    for (const stop of this.stops) stop();
    this.stops.length = 0;
    this.removeAllListeners();
  }

  // --- what goes out ----------------------------------------------------------------------

  /** What a switch should be now: set on, and not blacked out by its own blackout or the console's. */
  private goal(id: string): boolean {
    if (!this.state.on[id]) return false;
    if (this.state.blackout) return false;
    return !(this.blackout && this.state.follows[id]);
  }

  /** Sends a command to every switch that is to be something else than it was last wanted to be. */
  private sync(): void {
    if (this.disposed) return;
    for (const each of this.switches) {
      const on = this.goal(each.id);
      if (on === this.wanted.get(each.id)) continue;
      this.wanted.set(each.id, on);
      // Always urgent: a switch is two at most and pressed by hand, and it should answer at once, not
      // after the second that a lamp gets between two commands (the 10 per second still counts).
      this.hass.setEntity(each.entity, switchCommand(on), { urgent: true });
    }
  }

  // --- what Home Assistant says -----------------------------------------------------------

  private heard(each: SwitchDefinition, report: EntityReport | undefined): void {
    if (this.disposed) return;
    const before = this.state.reported[each.id];
    const after: SwitchReport | null = report
      ? { available: report.available, on: report.on }
      : null;
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    this.state = { ...this.state, reported: { ...this.state.reported, [each.id]: after } };
    this.emit('state', this.getState());
  }

  private complained(each: SwitchDefinition, problem: string | null): void {
    if (this.disposed || this.state.problems[each.id] === problem) return;
    this.state = { ...this.state, problems: { ...this.state.problems, [each.id]: problem } };
    this.emit('state', this.getState());
  }
}
