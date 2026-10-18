/**
 * A Home Assistant that lives in this process, for running the room without the real lamps
 * (`--hass-simulate`, Jeroen, 2026-10-18): rehearsing, programming looks and trying a change
 * must not touch the lights of the house.
 *
 * It is a socket and not a second output, so the real `HassClient` runs on it: the login, the
 * throttle that follows the answers, the encoding per colour mode, the states that come back
 * and the status. What the room does in the simulation is what it does for real, as far as a
 * made-up mesh can show.
 *
 * The lamps start off and say `xy` and `color_temp`, like the spots of the room do, so a
 * colour goes out as `rgb_color` and the white of a colour makes it paler. A command changes
 * the state of its lamp and Home Assistant reports it, as the real one does. The mesh takes
 * `SIMULATED_RATE` commands per second, one after the other, which is what the soak of
 * 2026-10-18 measured on the real lamps; a command is answered when its turn has come.
 */

import type { HassSocketFactory, HassSocketLike } from './client.js';

/** Commands per second that the simulated mesh answers: about what the real one took. */
export const SIMULATED_RATE = 4;

type Listener = (event: { data?: unknown }) => void;

interface SimulatedLamp {
  state: 'on' | 'off';
  attributes: Record<string, unknown>;
}

const OPEN = 1;
const CLOSED = 3;

/** A factory for sockets of one simulated Home Assistant, which keeps its lamps between them. */
export function simulatedHass(
  entities: readonly string[],
  options: { rate?: number } = {},
): HassSocketFactory {
  const rate = options.rate ?? SIMULATED_RATE;
  const lamps = new Map<string, SimulatedLamp>(
    entities.map((entity) => [
      entity,
      {
        state: 'off',
        attributes: entity.startsWith('light.')
          ? { supported_color_modes: ['xy', 'color_temp'] }
          : {},
      },
    ]),
  );
  /** When the mesh is free for the next command. */
  let freeAt = 0;

  const stateOf = (entity: string) => {
    const lamp = lamps.get(entity);
    return lamp && { entity_id: entity, state: lamp.state, attributes: lamp.attributes };
  };

  return () => new SimulatedSocket(lamps, stateOf, () => reserve());

  /** The moment the next command is done: one after the other, `rate` per second. */
  function reserve(): number {
    freeAt = Math.max(freeAt, Date.now()) + 1000 / rate;
    return freeAt;
  }
}

class SimulatedSocket implements HassSocketLike {
  readyState = 0;
  private readonly listeners = new Map<string, Listener[]>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly lamps: Map<string, SimulatedLamp>,
    private readonly stateOf: (entity: string) => Record<string, unknown> | undefined,
    private readonly reserve: () => number,
  ) {
    this.later(0, () => {
      this.readyState = OPEN;
      this.emit('open');
      this.say({ type: 'auth_required', ha_version: 'simulated' });
    });
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.emit('close');
  }

  send(data: string): void {
    if (this.readyState !== OPEN) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = message.id;
    switch (message.type) {
      case 'auth':
        this.say({ type: 'auth_ok', ha_version: 'simulated' });
        break;
      case 'get_states':
        this.say({
          id,
          type: 'result',
          success: true,
          result: [...this.lamps.keys()].map((entity) => this.stateOf(entity)),
        });
        break;
      case 'ping':
        this.say({ id, type: 'pong' });
        break;
      case 'call_service':
        this.later(Math.max(0, this.reserve() - Date.now()), () => this.callService(message));
        break;
      default:
        if (typeof id === 'number') this.say({ id, type: 'result', success: true, result: null });
    }
  }

  /** The mesh gets to a command: the lamp does what it says, and Home Assistant answers. */
  private callService(message: Record<string, unknown>): void {
    const data = (message.service_data ?? {}) as Record<string, unknown>;
    const entity = typeof data.entity_id === 'string' ? data.entity_id : '';
    const lamp = this.lamps.get(entity);
    if (!lamp) {
      this.say({
        id: message.id,
        type: 'result',
        success: false,
        error: { code: 'not_found', message: `Entity ${entity} not found` },
      });
      return;
    }
    const { entity_id: _entity, transition: _transition, ...rest } = data;
    if (message.service === 'turn_off') {
      lamp.state = 'off';
      lamp.attributes = withoutLight(lamp.attributes);
    } else {
      lamp.state = 'on';
      lamp.attributes = { ...withoutLight(lamp.attributes), ...rest };
    }
    this.say({ id: message.id, type: 'result', success: true, result: {} });
    this.say({
      type: 'event',
      event: {
        event_type: 'state_changed',
        data: { entity_id: entity, new_state: this.stateOf(entity) },
      },
    });
  }

  private say(message: Record<string, unknown>): void {
    if (this.readyState !== OPEN) return;
    this.emit('message', JSON.stringify(message));
  }

  private emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }

  private later(ms: number, then: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      then();
    }, ms);
    this.timers.add(timer);
  }
}

/** What a light says about its look is gone when it is turned off or set again. */
function withoutLight(attributes: Record<string, unknown>): Record<string, unknown> {
  const { brightness: _brightness, rgb_color: _rgb, rgbw_color: _rgbw, ...kept } = attributes;
  return kept;
}
