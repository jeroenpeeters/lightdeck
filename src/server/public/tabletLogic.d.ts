// The types of tabletLogic.js, for its test. The pages do not read this file.

import type { SpiderControl, SpiderLayout } from './spiderPose.js';

export interface SequenceStep {
  bars: number;
  looks: Record<string, string>;
}
export interface Sequence {
  id: string;
  steps: SequenceStep[];
}
export interface SequenceState {
  running: string | null;
  /** True while the sequence is held. */
  held?: boolean;
  step: number;
  barsLeft: number;
}
export interface RailFixture {
  controls?: (SpiderControl & { ranges?: { from: number; to: number; key?: string }[] })[];
  details?: { layout?: SpiderLayout };
}

export function splitNumber(label: string): { no: string; name: string };
export function partInfo(sequence: Sequence): string;
export function partBars(sequence: Sequence, state: SequenceState | undefined): string[];
export function partPlace(sequence: Sequence, state: SequenceState): string;
export function nextLook(
  sequence: Sequence | undefined,
  state: SequenceState | undefined,
  groupId: string,
  lookOn: string | undefined,
): { look: string; bars: number } | null;
export function chipMarks(
  id: string,
  onId: string | undefined,
  ownId: string | undefined,
): { on: boolean; own: boolean };
export function spiderLenses(dmx: ArrayLike<number> | undefined, fixture: RailFixture): string[];
export function laserOpen(dmx: ArrayLike<number> | undefined, fixture: RailFixture): boolean;
export function roomRails(
  state:
    | {
        levels?: Record<string, number>;
        shown?: Record<string, { red: number; green: number; blue: number; white?: number }>;
        dimmer?: number;
        zones?: Record<string, number>;
      }
    | undefined,
  zones: { id: string; lamps: string[] }[],
): { id: string; level: number; colour: string }[];

export interface DecorFixture {
  id: string;
  kind: string;
}
export interface DecorGroup {
  fixtures: string[];
}
export interface SwitchesState {
  on?: Record<string, boolean>;
  follows?: Record<string, boolean>;
  blackout?: boolean;
  reported?: Record<string, { available: boolean; on: boolean } | null>;
  problems?: Record<string, string | null>;
}
export interface SwitchView {
  set: boolean;
  follows: boolean;
  on: boolean;
  dark: boolean;
  word: string;
  note: string;
  warn: boolean;
  differs: boolean;
}
export const DIFFERS_MS: number;
export function decorOf<F extends DecorFixture>(
  fixtures: readonly F[],
  group: DecorGroup | undefined,
): F[];
export function isDecorGroup(
  fixtures: readonly DecorFixture[],
  group: DecorGroup | undefined,
): boolean;
export function switchView(
  state: SwitchesState | undefined,
  id: string,
  consoleDark: boolean,
  now?: number,
  since?: Record<string, number>,
): SwitchView;
