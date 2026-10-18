/**
 * What the lamps of the room and the connection to Home Assistant agree on.
 *
 * A controller says what it wants an entity to be (`HassCommand`) and hears what Home
 * Assistant says about it (`EntityReport`). Everything between, the budget, the login and
 * the reconnecting, is the output's business: see `client.ts` and `throttle.ts`.
 */

/** The link to Home Assistant, as the rig shows it. */
export type HassStatus = 'down' | 'refused' | 'connected';

/** A service call for one entity. The entity itself is given beside it. */
export interface HassCommand {
  /** The domain of the entity: `light` or `switch`. */
  domain: 'light' | 'switch';
  service: 'turn_on' | 'turn_off';
  /** The service data besides the entity: `brightness`, `rgbw_color`, `transition`. */
  data?: Record<string, unknown>;
}

/** What Home Assistant says about an entity. */
export interface EntityReport {
  /** False while Home Assistant calls the entity unavailable or does not know it. */
  available: boolean;
  on: boolean;
  /** `supported_color_modes` of a light, empty for a switch. */
  colourModes: string[];
}

export interface HassOutput {
  /**
   * The newest command for an entity. What was still waiting for it is dropped. `urgent`
   * goes before the rest and does not wait for the second of its entity (the blackout).
   */
  setEntity(entity: string, command: HassCommand, options?: { urgent?: boolean }): void;
  /**
   * Hears about an entity: what Home Assistant says of it, `undefined` while it does not
   * know it or the link is down. The listener is told at once if the report is known.
   * Returns a function that stops listening.
   */
  watch(entity: string, listener: (report: EntityReport | undefined) => void): () => void;
  /**
   * Hears why a command for an entity was refused or lost, or `null` when the next one
   * arrived. Returns a function that stops listening.
   */
  problems(entity: string, listener: (problem: string | null) => void): () => void;
}
