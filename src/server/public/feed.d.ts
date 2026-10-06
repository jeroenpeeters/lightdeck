// The types of feed.js, for its test. The pages do not read this file.

export const MAX_QUEUED: number;
export const FLOOR_DB: number;

export function measure(samples: ArrayLike<number>): { rms: number; peak: number };
export function meterPosition(db: number, low?: number): number;

export class SendQueue<T = unknown> {
  constructor(max?: number);
  readonly length: number;
  dropped: number;
  push(block: T): void;
  next(): T | undefined;
}

export function postHeaders(post: {
  rate: number;
  index: number;
  feed: string;
}): Record<string, string>;
export function feedName(now?: number, random?: () => number): string;
export function explainMicrophone(error: { name?: string } | undefined, host?: string): string;
export function processingNote(settings: Record<string, unknown> | undefined): string;
