/** What the tests of the server have in common. */

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
