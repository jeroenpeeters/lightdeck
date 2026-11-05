// The types of tabletLogic.js, for its test. The pages do not read this file.

import type { SpiderControl, SpiderLayout } from './spiderPose.js';

export interface SequenceStep {
  bars: number;
  looks: Record<string, string>;
}
export interface Sequence {
  id: string;
  category?: string;
  steps: SequenceStep[];
}
export interface SequenceCategory {
  id: string;
  label: string;
  sequences: Sequence[];
}
/** One running sequence. */
export interface SequenceRun {
  id: string;
  /** True while the sequence is held. */
  held?: boolean;
  step: number;
  barsLeft: number;
}
export interface SequenceState {
  runs: SequenceRun[];
}
export interface RailFixture {
  controls?: (SpiderControl & { ranges?: { from: number; to: number; key?: string }[] })[];
  details?: { layout?: SpiderLayout };
}

export function splitNumber(label: string): { no: string; name: string };
export function partInfo(sequence: Sequence): string;
export function sequenceCategories(sequences: Sequence[]): SequenceCategory[];
export function categoryOfGroup(
  categories: SequenceCategory[],
  groupId: string,
): SequenceCategory | undefined;
export function runOf(state: SequenceState | undefined, id: string): SequenceRun | undefined;
export function runForGroup(
  state: SequenceState | undefined,
  sequences: Sequence[],
  groupId: string,
): SequenceRun | undefined;
export function partBars(sequence: Sequence, run: SequenceRun | undefined): string[];
export function partPlace(sequence: Sequence, run: SequenceRun): string;
export function nextLook(
  sequence: Sequence | undefined,
  run: SequenceRun | undefined,
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
export interface StripColour {
  red: number;
  green: number;
  blue: number;
}
export interface SwitchesState {
  on?: Record<string, boolean>;
  follows?: Record<string, boolean>;
  blackout?: boolean;
  reported?: Record<
    string,
    { available: boolean; on: boolean; effects?: string[]; effect?: string | null } | null
  >;
  effect?: Record<string, string | null>;
  colour?: Record<string, StripColour>;
  level?: Record<string, number>;
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

export interface StripView extends SwitchView {
  effect: string | null;
  effectName: string;
  colour: StripColour;
  css: string;
  level: number;
}
export const STRIP_COLOURS: { name: string; hex: string }[];
export const LIQUID_EFFECTS: string[];
export function hexColour(hex: string): StripColour;
export function colourCss(colour: StripColour): string;
export function sameColour(a: StripColour, b: StripColour): boolean;
export function targetIds(target: string, ids: string[]): string[];
export function commonValue<T>(values: T[], same?: (a: T, b: T) => boolean): T | undefined;
export function effectGroups(list: string[] | undefined): { liquid: string[]; rest: string[] };
export function stripView(
  state: SwitchesState | undefined,
  id: string,
  consoleDark: boolean,
  now?: number,
  since?: Record<string, number>,
): StripView;

export const PACES: { value: number; name: string }[];
export const COMMON_PALETTES: string[];
export function paletteGroups(list: string[] | undefined): { common: string[]; rest: string[] };
export interface PipeLook {
  id: string;
  label: string;
  effect: string | null;
  palette?: string;
  colour?: string;
  intensity?: number;
  pace?: number;
}
export function lookIsOn(
  look: PipeLook,
  states: {
    effect: string | null;
    palette: string | null;
    intensity: number | null;
    pace: number;
    colour: StripColour;
  }[],
): boolean;
