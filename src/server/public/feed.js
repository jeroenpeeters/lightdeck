// What the listen page does with sound that has nothing of the browser in it, so that it
// is tested the way the server is. Plain JavaScript, no build step.

/** The most blocks kept while the server is slow: two seconds. Older ones are dropped. */
export const MAX_QUEUED = 20;

/** Loudness of the quietest level shown, in dBFS. Anything quieter reads as this. */
export const FLOOR_DB = -100;

/** The level of 16-bit samples in dBFS: the loudness (RMS) and the highest peak. */
export function measure(samples) {
  if (samples.length === 0) return { rms: FLOOR_DB, peak: FLOOR_DB };
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] / 32768;
    sum += value * value;
    peak = Math.max(peak, Math.abs(value));
  }
  const db = (amplitude) =>
    amplitude > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(amplitude)) : FLOOR_DB;
  return { rms: db(Math.sqrt(sum / samples.length)), peak: db(peak) };
}

/** Where a level lies on the meter, 0 to 1, between `low` and 0 dBFS. */
export function meterPosition(db, low = -60) {
  return Math.min(1, Math.max(0, (db - low) / -low));
}

/**
 * Blocks waiting to be sent. The newest sound matters most, so when more wait than
 * `max` the oldest are dropped. The server sees the jump in the positions.
 */
export class SendQueue {
  constructor(max = MAX_QUEUED) {
    this.max = max;
    this.items = [];
    this.dropped = 0;
  }

  get length() {
    return this.items.length;
  }

  push(block) {
    this.items.push(block);
    while (this.items.length > this.max) {
      this.items.shift();
      this.dropped += 1;
    }
  }

  next() {
    return this.items.shift();
  }
}

/** The headers of a post of sound, see `POST /api/audio`. */
export function postHeaders({ rate, index, feed }) {
  return {
    'content-type': 'application/octet-stream',
    'x-rate': String(rate),
    'x-index': String(index),
    'x-feed': feed,
  };
}

/** A name for a new feed: letters and digits, different every time the microphone is opened. */
export function feedName(now = Date.now(), random = Math.random) {
  return `${now.toString(36)}-${Math.floor(random() * 36 ** 6)
    .toString(36)
    .padStart(6, '0')}`;
}

/**
 * What to tell the operator when the microphone cannot be had, in words that say what to
 * do. `host` is where the page was opened from.
 */
export function explainMicrophone(error, host = 'localhost:8080') {
  switch (error?.name) {
    case 'NotSecure':
      return `The browser only gives a microphone to this page on the lightdeck laptop. Open it there as http://localhost:8080/listen. It does not work from ${host}.`;
    case 'NotAllowedError':
    case 'SecurityError':
      return 'The browser did not give the microphone. Allow it in the address bar, then press Start listening.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'There is no microphone to listen to. Check the input below, or plug one in.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone cannot be opened. Another program may be using it.';
    default:
      return 'The microphone could not be started. Reload the page and press Start listening.';
  }
}

/** What the browser did with the settings that were asked for: it may keep processing on. */
export function processingNote(settings) {
  const on = ['echoCancellation', 'noiseSuppression', 'autoGainControl'].filter(
    (name) => settings?.[name] === true,
  );
  if (on.length === 0) return '';
  return 'The browser kept sound processing on for this microphone. It flattens music and makes the beat harder to find. Choose another input, or turn it off in the sound settings of the laptop.';
}
