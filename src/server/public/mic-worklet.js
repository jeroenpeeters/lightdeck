// Takes the sound of the microphone on the audio thread and hands it to the listen page
// in blocks of about 100 ms. Plain browser JavaScript, no build step.
//
// The page connects the microphone to this as one channel. A block is 16-bit samples,
// and comes with where its first sample lies, counted in samples since the microphone was
// opened. That position is taken from the clock of the audio thread, so when the browser
// skips sound the position jumps instead of the sound being squeezed together.

class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate / 10);
    this.block = new Int16Array(this.size);
    this.filled = 0;
    this.start = undefined;
    this.blockStart = 0;
    this.expected = 0;
  }

  flush() {
    if (this.filled === 0) return;
    const samples = this.filled === this.size ? this.block : this.block.slice(0, this.filled);
    this.port.postMessage({ samples, index: this.blockStart }, [samples.buffer]);
    this.block = new Int16Array(this.size);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    if (this.start === undefined) this.start = currentFrame;
    // A quantum that did not come ends the block, so that a block is one run of sound.
    if (currentFrame !== this.expected) this.flush();
    this.expected = currentFrame + channel.length;

    for (let i = 0; i < channel.length; i++) {
      if (this.filled === 0) this.blockStart = currentFrame + i - this.start;
      const clipped = Math.max(-1, Math.min(1, channel[i]));
      this.block[this.filled++] = Math.round(clipped * 32767);
      if (this.filled === this.size) this.flush();
    }
    return true;
  }
}

registerProcessor('lightdeck-mic', MicProcessor);
