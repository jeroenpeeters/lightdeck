// What the two pages for a tablet (tablet.js and moods.js) draw their keys with. Plain browser
// JavaScript, nothing of the shell in it.
//
// A key has a fixed size and place whatever state it is in: its name, what it holds between (a strip
// of colours, say) and under it a line that says more. `syncKeys` makes the keys of a grid the ones
// that are asked for, in that order, and moves none that are already right.

import { element } from './ui.js';

/** A key: its name, what it holds between, and under it a line that says more. */
export function makeKey(className, onPress, ...between) {
  const key = element('button', className);
  key.type = 'button';
  key.addEventListener('click', onPress);
  key.append(element('span', 'scene-name'), ...between, element('span', 'scene-sets'));
  return key;
}

/**
 * Draws a key: `state` is idle, set (on as it was set) or changed (on, and changed by hand or varied
 * since), `changedText` is what the line under it says then.
 */
export function drawKey(key, { state, label, sets, title = '' }, changedText = 'Changed by hand') {
  key.dataset.state = state;
  key.setAttribute('aria-pressed', String(state !== 'idle'));
  key.firstElementChild.textContent = label;
  key.lastElementChild.textContent = state === 'changed' ? changedText : sets;
  key.title = title;
}

/** The state a key shows: on as it was set, on and changed by hand, or not on. */
export function stateOf(on, item) {
  if (!on.item || on.item !== item) return 'idle';
  return on.changed ? 'changed' : 'set';
}

/**
 * Makes the keys of a grid the ones in `items` ({ id, make, draw }), in that order. `lane` is
 * `{ grid, none, keys }`: the element, the line that says there are none, and the keys by id.
 */
export function syncKeys(lane, items) {
  const wanted = new Set(items.map((item) => item.id));
  for (const [id, key] of lane.keys) {
    if (wanted.has(id)) continue;
    key.remove();
    lane.keys.delete(id);
  }
  items.forEach((item, index) => {
    let key = lane.keys.get(item.id);
    if (!key) {
      key = item.make();
      lane.keys.set(item.id, key);
    }
    if (lane.grid.children[index] !== key) {
      lane.grid.insertBefore(key, lane.grid.children[index] ?? null);
    }
    item.draw(key);
  });
  if (lane.none) lane.none.hidden = items.length > 0;
}

/** What a palette does besides showing its colours, in a few words. */
export function movesOf(palette) {
  if (palette.mode !== 'cycle') return '';
  return palette.change === 'fade' ? 'Cycles, fades' : 'Cycles, steps';
}

/** A colour of a palette as CSS, or null for a dark slot. White is added to all three. */
export function chipColour(value) {
  const parsed = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(value);
  if (!parsed) return null;
  const [red = 0, green = 0, blue = 0, white = 0] = parsed
    .slice(1)
    .map((part) => (part ? Number.parseInt(part, 16) : 0));
  const mix = (light) => Math.min(255, light + white);
  return `rgb(${mix(red)} ${mix(green)} ${mix(blue)})`;
}

/** An empty strip for the colours of a palette; `fillStrip` puts them in. */
export function makeStrip() {
  const strip = element('span', 'chips');
  strip.setAttribute('aria-hidden', 'true');
  return strip;
}

/** Puts the colours of a palette (or none, with `undefined`) in a strip, when they are not there yet. */
export function fillStrip(strip, colours) {
  const wanted = colours ? colours.join(' ') : '';
  if (strip.dataset.colours === wanted) return;
  strip.dataset.colours = wanted;
  strip.replaceChildren(
    ...(colours ?? []).map((value) => {
      const chip = element('span', 'chip');
      const colour = chipColour(value);
      if (colour) chip.style.backgroundColor = colour;
      else chip.dataset.off = 'true';
      return chip;
    }),
  );
}
