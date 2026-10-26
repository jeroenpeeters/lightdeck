// What the page for a tablet (tablet.js) draws its keys with. Plain browser JavaScript, nothing of
// the shell in it. The classes are those of lightdeck.css (the design of the console, `design/`).
//
// A key has a fixed size and place whatever state it is in: a state only swaps classes, never size,
// padding or border width, and what may or may not be there (a tag, say) has its room kept.
// `syncKeys` makes the keys of a grid the ones that are asked for, in that order, and moves none that
// are already right.

import { element } from './ui.js';

/** The state a key shows: on as it was set, on and changed by hand, or not on. */
export function stateOf(on, item) {
  if (!on.item || on.item !== item) return 'idle';
  return on.changed ? 'changed' : 'set';
}

// ---- strips of colour ----

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
  const strip = element('div', 'strip');
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
      const part = element('span');
      const colour = chipColour(value);
      if (colour) part.style.backgroundColor = colour;
      else part.className = 'dark';
      return part;
    }),
  );
}

/** What a palette does besides showing its colours, in a few words. */
export function movesOf(palette) {
  if (palette.mode !== 'cycle') return '';
  return palette.change === 'fade' ? 'Cycles, fades' : 'Cycles, steps';
}

// ---- the keys ----

/**
 * The key of a look: a name with its number, a tag when it is varied or next, a strip with the
 * colours of its palette and under it what it names.
 */
export function makeLook(onPress) {
  const key = element('button', 'key look');
  key.type = 'button';
  key.addEventListener('click', onPress);
  const no = element('span', 'no');
  const name = element('span', 'name');
  const tag = element('span', 'tag');
  const strip = makeStrip();
  const meta = element('span', 'meta');
  const head = element('div', 'hd');
  head.append(element('span', 'nm', ''), tag);
  head.firstElementChild.append(no, name);
  key.append(head, strip, meta);
  key.parts = { no, name, tag, strip, meta };
  return key;
}

/**
 * Draws a look. `state` is idle, set (on as it was set) or changed (on, and varied since), `next` is
 * `{ bars }` when the sequence that runs sets it next, `number` and `name` are its label split.
 */
export function drawLook(key, { state, number, name, colours, meta, next, title = '' }) {
  const { parts } = key;
  key.classList.toggle('is-on', state === 'set');
  key.classList.toggle('is-varied', state === 'changed');
  key.classList.toggle('is-next', state === 'idle' && Boolean(next));
  key.setAttribute('aria-pressed', String(state !== 'idle'));
  parts.no.textContent = number;
  parts.no.hidden = number === '';
  parts.name.textContent = name;
  const tag = state === 'changed' ? 'var' : state === 'idle' && next ? 'next' : '';
  parts.tag.className = tag ? `tag ${tag}` : 'tag';
  parts.tag.hidden = tag === '';
  parts.tag.textContent = tag === 'var' ? 'Varied' : tag === 'next' ? `Next · ${next.bars}` : '';
  fillStrip(parts.strip, colours);
  parts.meta.textContent = meta;
  key.title = title;
}

/** A chip of the tray: a name, and with `strip` the colours of a palette under it. */
export function makeChip(onPress, { strip = false } = {}) {
  const chip = element('button', 'chip');
  chip.type = 'button';
  chip.addEventListener('click', onPress);
  chip.append(element('span', 'name'));
  if (strip) {
    chip.strip = makeStrip();
    chip.append(chip.strip);
  }
  return chip;
}

/** `on` is what the lane has on now, `own` what the look that is on sets there (dashed). */
export function drawChip(chip, { label, on, own, colours, title = '' }) {
  chip.firstElementChild.textContent = label;
  chip.classList.toggle('is-on', on);
  chip.classList.toggle('is-look', own);
  chip.setAttribute('aria-pressed', String(on));
  if (chip.strip) fillStrip(chip.strip, colours);
  chip.title = title;
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

// ---- the faders and the speed keys ----

/**
 * A fader in the console style: a flat bar with a fill, a handle, its name and its value. The
 * pointer is taken by a range input that lies over it and cannot be seen, so touch, drag and the
 * keyboard work as they do for any slider. `read` and `write` connect it to the state, as for
 * `slider` of ui.js; `read` gives null when there is nothing to set. Call `refresh` to show the
 * state again.
 */
export function fader({ id, label, min = 0, max = 100, read, write }) {
  const bar = element('div', 'fader');
  const fill = element('div', 'fill');
  const hand = element('div', 'hand');
  const name = element('span', 'fl', label);
  const value = element('span', 'fv');
  const input = element('input');
  input.type = 'range';
  input.id = id;
  input.min = String(min);
  input.max = String(max);
  input.step = '1';
  input.setAttribute('aria-label', label);
  bar.append(fill, name, value, hand, input);

  const show = (number) => {
    const share = (number - min) / (max - min);
    input.value = String(number);
    value.textContent = String(number);
    fill.style.width = `${share * 100}%`;
    // The handle stays inside the bar at both ends (it has a margin of -4px, and is 8px wide).
    hand.style.left = `calc(${share * 100}% + ${8 - share * 16}px)`;
  };
  input.addEventListener('input', () => {
    const number = Number(input.value);
    show(number);
    write(number);
  });
  bar.refresh = () => {
    const number = read();
    input.disabled = number === null;
    show(number ?? min);
  };
  return bar;
}

/** Keys to choose a speed from (÷4 ... ×4). Gives what shows the chosen one. */
export function speedPick(holder, names, speeds, choose) {
  const keys = speeds.map((speed, index) => {
    const made = element('button', '', names[index]);
    made.type = 'button';
    made.addEventListener('click', () => choose(speed));
    holder.append(made);
    return { speed, made };
  });
  return (chosen) => {
    for (const { speed, made } of keys) {
      const on = speed === chosen;
      made.classList.toggle('is-on', on);
      made.setAttribute('aria-pressed', String(on));
    }
  };
}
