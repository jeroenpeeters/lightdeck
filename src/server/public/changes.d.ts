// The types of changes.js, for its test. The pages do not read this file.

type Change = Record<string, unknown>;

export function merge(older: Change | null | undefined, newer: Change | null | undefined): Change;

export function changesOnTheWay(client: string): {
  leave(change: Change): string;
  drop(name: string): void;
  heard(origin: unknown): void;
  forget(): void;
  mine(origin: unknown): boolean;
  all(waiting?: Change | null): Change | null;
};
