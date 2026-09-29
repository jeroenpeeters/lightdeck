// What a page has changed and the event stream has not told of yet. Plain browser
// JavaScript, no build step, and nothing of the browser in it, so that it is tested the
// way the server is.
//
// A change is on its way from the moment the operator makes it until the event stream
// tells of it. That the request was answered is not enough: the answer comes over
// another connection than the events, so an event from before the change can arrive
// after the answer. Until the stream tells of a change it is newer than anything the
// server says, and it is laid over the state that comes in. Without that a master that
// is moved on another screen sets back the fader under the finger.

const isPlain = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Two changes as one; where both set the same thing, the newer wins. It goes one level
 * deep, the way the server applies a change, so a state with a change over it is the
 * state after that change.
 */
export function merge(older, newer) {
  const merged = { ...(older ?? {}) };
  for (const [key, value] of Object.entries(newer ?? {})) {
    const before = merged[key];
    merged[key] = isPlain(value) && isPlain(before) ? { ...before, ...value } : value;
  }
  return merged;
}

/**
 * Keeps the changes that have left for the server. Each leaves under a name of its own
 * that starts with `client`, and the server gives that name back as `origin` in the
 * event that tells of the change.
 */
export function changesOnTheWay(client) {
  let count = 0;
  let left = [];
  return {
    /** A change leaves. Gives the name to send it under. */
    leave(change) {
      count += 1;
      const name = `${client}/${count}`;
      left.push({ name, change });
      return name;
    },
    /** The request failed or was refused, so the stream will never tell of it. */
    drop(name) {
      left = left.filter((each) => each.name !== name);
    },
    /**
     * The stream told of the change with this name. It tells in the order of the server,
     * so what left before that change has been told of as well.
     */
    heard(origin) {
      const at = left.findIndex((each) => each.name === origin);
      if (at >= 0) left = left.slice(at + 1);
    },
    /** For when the stream starts again: it starts with what is real. */
    forget() {
      left = [];
    },
    /** True when the change that an event tells of was made by this page. */
    mine(origin) {
      return origin === client || (typeof origin === 'string' && origin.startsWith(`${client}/`));
    },
    /** What is on its way as one change, with `waiting` as the newest, or null. */
    all(waiting = null) {
      const changes = [...left.map((each) => each.change), ...(waiting ? [waiting] : [])];
      return changes.length > 0 ? changes.reduce(merge, {}) : null;
    },
  };
}
