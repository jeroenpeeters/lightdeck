/** What the tests of the server have in common. */

import type { EntityReport, HassCommand, HassOutput } from '../outputs/hass/types.js';

export class RecordingOutput {
  frames: { index: number; data: Uint8Array }[] = [];
  setUniverse(index: number, data: Uint8Array): void {
    this.frames.push({ index, data: data.slice() });
  }
  get last(): Uint8Array {
    return (this.frames[this.frames.length - 1] as { data: Uint8Array }).data;
  }
}

/** 1-based DMX channel in the last frame that was sent. */
export const ch = (output: RecordingOutput, channel: number) => output.last[channel - 1];

/** A stand-in for Home Assistant: records the commands and says what the test makes it say. */
export class RecordingHass implements HassOutput {
  commands: { entity: string; command: HassCommand; urgent: boolean }[] = [];
  private readonly watchers = new Map<string, Set<(report: EntityReport | undefined) => void>>();
  private readonly complainers = new Map<string, Set<(problem: string | null) => void>>();
  private readonly known = new Map<string, EntityReport>();

  setEntity(entity: string, command: HassCommand, options?: { urgent?: boolean }): void {
    this.commands.push({ entity, command, urgent: options?.urgent === true });
  }

  watch(entity: string, listener: (report: EntityReport | undefined) => void): () => void {
    const set = this.watchers.get(entity) ?? new Set();
    this.watchers.set(entity, set);
    set.add(listener);
    const report = this.known.get(entity);
    if (report) listener(report);
    return () => set.delete(listener);
  }

  problems(entity: string, listener: (problem: string | null) => void): () => void {
    const set = this.complainers.get(entity) ?? new Set();
    this.complainers.set(entity, set);
    set.add(listener);
    return () => set.delete(listener);
  }

  /** Home Assistant says something about an entity. */
  report(entity: string, report: EntityReport | undefined): void {
    if (report) this.known.set(entity, report);
    else this.known.delete(entity);
    for (const listener of this.watchers.get(entity) ?? []) listener(report);
  }

  /** Home Assistant refuses a command, or (null) takes the next one. */
  complain(entity: string, problem: string | null): void {
    for (const listener of this.complainers.get(entity) ?? []) listener(problem);
  }

  /** The commands for one entity, oldest first. */
  to(entity: string): HassCommand[] {
    return this.commands.filter((sent) => sent.entity === entity).map((sent) => sent.command);
  }
}
