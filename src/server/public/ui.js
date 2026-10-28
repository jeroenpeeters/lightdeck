// What the pages build their controls from. Plain browser JavaScript, no build step. The markup it makes
// is that of the console design (lightdeck.css and chrome.css): a state only swaps classes, never size.
//
//   $(id), element(tag, class, text), button(class, text, onClick)      small DOM helpers
//   sentence(text), percent(level), masterPercent(level)                  words and numbers
//   speedName(speed), speedInWords(speed), speedNote(own, speed)          the speed keys (÷4 ... ×4)
//   fader({ id, label, min, max, step, tone, read, write, format })       the console fader, a bar
//   slider({ ..., meaning })                                              the same with a note under it
//   range({ id, label, min, max, step, gap, kind, ticks, read, write })   two handles, with a window
//   speedPick(holder, names, speeds, choose), speedKeys(holder, speeds, choose)   the .spd keys
//   views(names, onShow)                                                  tabs that show one view
//   segmented(holder, items, choose), choiceKeys(holder, items, choose)   Show/Program, Static/Step/Fade
//   renderReadout(list, dmx, controls)                                    the bytes of a fixture
//   makeDismissible(notice), setNotice(notice, text)                      notices over the screen

export const $ = (id) => document.getElementById(id);

/** An answer of the server as a sentence: it starts with a capital and ends with a stop. */
export function sentence(text) {
  const made = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(made) ? made : `${made}.`;
}

export function percent(level) {
  return Math.round(level * 100);
}

/**
 * The master in percent. Only a master at 0 is shown as 0: anything above it lets the
 * fixtures show, however little.
 */
export function masterPercent(level) {
  return level > 0 ? Math.max(1, percent(level)) : 0;
}

/** A speed relative to the tempo, as a key says it: ÷4, ÷2, ×1, ×2, ×4. */
export function speedName(speed) {
  return speed >= 1 ? `×${speed}` : `÷${1 / speed}`;
}

/** The same in words, for who cannot see the key. */
export function speedInWords(speed) {
  if (speed === 1) return 'Normal speed';
  return speed > 1 ? `${speed} times as fast` : `${1 / speed} times as slow`;
}

/**
 * What the speed of an effect comes to. `own` is the speed chosen for the effect, and
 * `given` and `held` are what the shell says it gets, see `shell.speed`.
 */
export function speedNote(own, { given, held }) {
  const pace =
    given === 1
      ? 'A change on every beat.'
      : given > 1
        ? `${given} changes per beat.`
        : `A change every ${1 / given} beats.`;
  if (held) {
    return `${pace} That is ${speedName(given)}: at this tempo more would be over ten changes per second.`;
  }
  return given === own ? pace : `${pace} That is ${speedName(given)}, with the master speed.`;
}

/**
 * Keys to choose a speed from (÷4 ... ×4), in the element `holder` (a fieldset or a div), which becomes
 * a `.spd` row. `names` are the words on the keys, in the order of `speeds`. Gives what shows the
 * chosen one: call it with the speed that is on. The key that is on has the class `is-on`.
 */
export function speedPick(holder, names, speeds, choose) {
  holder.classList.add('spd');
  const keys = speeds.map((speed, index) => {
    const made = element('button', '', names[index]);
    made.type = 'button';
    made.setAttribute('aria-label', speedInWords(speed));
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

/** The same with the names of the speeds: ÷4, ÷2, ×1, ×2, ×4. */
export function speedKeys(holder, speeds, choose) {
  return speedPick(holder, speeds.map(speedName), speeds, choose);
}

export function element(tag, className, text) {
  const made = document.createElement(tag);
  if (className) made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
}

export function button(className, text, onClick) {
  const made = element('button', className, text);
  made.type = 'button';
  made.addEventListener('click', onClick);
  return made;
}

// ---- faders ----

/**
 * The parts of a console fader, shared by `fader` and `slider`: a flat bar with a fill, a handle, its
 * name and its value. The pointer is taken by a range input that lies over it and cannot be seen, so
 * touch, drag and the keyboard work as they do for any slider. `read` gives the number to show, or
 * null when there is nothing to set (the fader then rests, dimmed, and cannot be moved).
 */
function makeFader({ id, label, min = 0, max = 100, step = 1, tone, read, write, format }, onShow) {
  const bar = element('div', 'fader');
  if (tone) bar.dataset.tone = tone;
  const fill = element('div', 'fill');
  const hand = element('div', 'hand');
  const name = element('span', 'fl', label);
  const value = element('span', 'fv');
  const input = element('input');
  input.type = 'range';
  input.id = id;
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.setAttribute('aria-label', label);
  bar.append(fill, name, value, hand, input);

  const show = (number) => {
    const share = (number - min) / (max - min);
    input.value = String(number);
    value.textContent = format ? format(number) : String(number);
    fill.style.width = `${share * 100}%`;
    // The handle stays inside the bar at both ends (it has a margin of -4px, and is 8px wide).
    hand.style.left = `calc(${share * 100}% + ${8 - share * 16}px)`;
    bar.style.setProperty('--fill', `${share * 100}%`);
    onShow?.(number);
  };
  input.addEventListener('input', () => {
    const number = Number(input.value);
    show(number);
    write(number);
  });
  bar.refresh = () => {
    const number = read();
    input.disabled = number === null;
    bar.classList.toggle('is-disabled', number === null);
    show(number ?? min);
  };
  bar.input = input;
  return bar;
}

/**
 * A fader in the console style: a flat bar with a fill, a handle, its name (inside, left) and its value
 * (inside, right). `read` and `write` connect it to the state; `read` gives null when there is nothing
 * to set. Call `refresh()` on the result to show the state again. `tone` (red, green, blue, white) makes
 * the bar a gradient of that colour, for a colour channel. `format` makes the words of the value
 * (default: the number). The result is the `.fader` element, which fills the width of its parent and
 * is 48 px high; `.input` is the range input.
 */
export function fader(options) {
  return makeFader(options);
}

/**
 * One labelled slider: the console `fader` and, when `meaning` is given (a function from the number to
 * a sentence), a note under it that says what the number means. The result is a `.fader-row` that holds
 * both; `refresh()` and `.input` work as for `fader`.
 */
export function slider({ meaning, ...options }) {
  const row = element('div', 'fader-row');
  let note;
  const bar = makeFader(options, (number) => {
    if (note) note.textContent = meaning(number);
  });
  row.append(bar);
  if (meaning) {
    note = element('p', 'meaning');
    row.append(note);
  }
  row.refresh = bar.refresh;
  row.input = bar.input;
  row.bar = bar;
  return row;
}

// ---- the range: two handles, and a window inside ----

/** Where, from the left of the bar, a share (0 to 1) lies: the handles stay inside the bar at both ends. */
const railAt = (share) => `calc(${share * 100}% + ${5 - share * 10}px)`;
/** The same, from the right. */
const railFromRight = (share) => `calc(${(1 - share) * 100}% + ${share * 10 - 5}px)`;

/**
 * Two handles on a rail, for the swing limit of a bar (design mockup 10): the handles say where a value may
 * start and where it must stop, a window inside can be drawn as well (the zone), and a mark shows where the
 * value is now. It is pointer and keyboard operable: a drag moves the handle nearest to where the finger
 * went down, by how far the finger moves (a press without a move changes nothing, and a vertical drag
 * scrolls the page); a handle that has focus moves with the arrow keys (one step; Shift or Page keys, ten
 * steps) and Home and End.
 *
 *   id, label     `label` names the handles for a reader: "<label> from" and "<label> to"
 *   min, max      the ends of the rail (default 0 and 100), step (default 1)
 *   gap           the least distance between the handles, in the units of min..max (5 on 0..100 is 5 percent)
 *   kind          which window the handles drive: 'limit' (default: the window between them is filled and
 *                 what lies outside it is hatched) or 'zone' (the window between them is a white outline);
 *                 `setKind(kind)` changes it, and `read` then says where the other window is
 *   ticks         true: a row of 0 25 50 75 100 (the values at the quarters of the rail) under the rail
 *   read          () => { low, high, window?, now? } or null when there is nothing to set. `low` and
 *                 `high` are where the handles are, `window` ({ low, high } or null) is the other
 *                 window, drawn but not moved (with kind 'limit' that is the zone, with kind 'zone' the
 *                 limit), and `now` is the value to mark, or null
 *   write         ({ low, high }) => void, called on every change by a drag or a key
 *
 * The result is a `.lim-box` with `refresh()`, `setKind(kind)` and `handles` ({ low, high }, the two
 * `role="slider"` elements). A `refresh` while a handle is being dragged does not move it.
 */
export function range({
  id,
  label,
  min = 0,
  max = 100,
  step = 1,
  gap = 0,
  kind = 'limit',
  ticks = false,
  read,
  write,
}) {
  const box = element('div', 'lim-box');
  if (id) box.id = id;
  const bar = element('div', 'lim');
  const ok = element('div', 'ok');
  const zone = element('div', 'zone');
  const pos = element('div', 'pos');
  pos.setAttribute('aria-hidden', 'true');
  const handles = {};
  for (const [which, word] of [
    ['low', 'from'],
    ['high', 'to'],
  ]) {
    const hand = element('div', 'h');
    hand.tabIndex = 0;
    hand.setAttribute('role', 'slider');
    hand.setAttribute('aria-label', `${label} ${word}`);
    hand.setAttribute('aria-orientation', 'horizontal');
    hand.setAttribute('aria-valuemin', String(min));
    hand.setAttribute('aria-valuemax', String(max));
    handles[which] = hand;
  }
  bar.append(ok, zone, pos, handles.low, handles.high);
  box.append(bar);
  if (ticks) {
    const row = element('div', 'ticks');
    row.setAttribute('aria-hidden', 'true');
    for (const share of [0, 0.25, 0.5, 0.75, 1]) {
      row.append(element('span', '', String(Math.round(min + share * (max - min)))));
    }
    box.append(row);
  }

  let what = kind;
  /** Where the handles are, as last drawn or moved. */
  let value = { low: min, high: max };
  let enabled = false;
  let dragging = null;
  let last = null;

  const shareOf = (number) => (max > min ? (number - min) / (max - min) : 0);
  const snap = (number) => {
    const snapped = Math.round((number - min) / step) * step + min;
    return Math.min(max, Math.max(min, Number(snapped.toFixed(6))));
  };

  /** Puts a window in the bar, or takes it out. */
  const place = (part, window) => {
    part.hidden = !window;
    if (!window) return;
    part.style.left = railAt(shareOf(window.low));
    part.style.right = railFromRight(shareOf(window.high));
  };

  const draw = (state) => {
    const { low, high, window = null, now = null } = state;
    for (const [which, number] of [
      ['low', low],
      ['high', high],
    ]) {
      const hand = handles[which];
      hand.style.left = railAt(shareOf(number));
      hand.setAttribute('aria-valuenow', String(number));
      hand.setAttribute('aria-valuetext', String(number));
      hand.setAttribute('aria-disabled', String(!enabled));
      hand.tabIndex = enabled ? 0 : -1;
    }
    bar.dataset.kind = what;
    bar.classList.toggle('is-disabled', !enabled);
    const own = { low, high };
    place(ok, what === 'limit' ? own : window);
    place(zone, what === 'limit' ? window : own);
    bar.classList.toggle('has-limit', !ok.hidden);
    pos.hidden = now === null;
    if (now !== null) pos.style.left = railAt(shareOf(now));
  };

  const move = (which, number) => {
    const next = { ...value };
    next[which] =
      which === 'low'
        ? Math.min(snap(number), Math.max(min, value.high - gap))
        : Math.max(snap(number), Math.min(max, value.low + gap));
    if (next[which] === value[which]) return;
    value = next;
    last = { ...last, low: value.low, high: value.high };
    draw(last);
    write({ low: value.low, high: value.high });
  };

  const valueAt = (clientX, rect) => {
    const share = (clientX - rect.left - 5) / Math.max(1, rect.width - 10);
    return min + Math.min(1, Math.max(0, share)) * (max - min);
  };

  bar.addEventListener('pointerdown', (event) => {
    if (!enabled || event.button > 0) return;
    const rect = bar.getBoundingClientRect();
    const at = valueAt(event.clientX, rect);
    // The handle nearest to the finger. With both on one spot, the side the finger is on decides.
    const near = Math.abs(at - value.low) <= Math.abs(at - value.high) ? 'low' : 'high';
    const chosen = value.low === value.high ? (at < value.low ? 'low' : 'high') : near;
    dragging = { which: chosen, from: at, start: value[chosen], rect };
    handles[chosen].classList.add('is-active');
    handles[chosen].focus({ preventScroll: true });
    bar.setPointerCapture(event.pointerId);
  });
  bar.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const at = valueAt(event.clientX, dragging.rect);
    move(dragging.which, dragging.start + (at - dragging.from));
  });
  const release = () => {
    if (!dragging) return;
    handles[dragging.which].classList.remove('is-active');
    dragging = null;
  };
  bar.addEventListener('pointerup', release);
  bar.addEventListener('pointercancel', release);

  for (const which of ['low', 'high']) {
    handles[which].addEventListener('keydown', (event) => {
      if (!enabled) return;
      const big = event.shiftKey || event.key === 'PageUp' || event.key === 'PageDown';
      const size = (big ? 10 : 1) * step;
      let target;
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'PageUp') {
        target = value[which] + size;
      } else if (
        event.key === 'ArrowLeft' ||
        event.key === 'ArrowDown' ||
        event.key === 'PageDown'
      ) {
        target = value[which] - size;
      } else if (event.key === 'Home') target = min;
      else if (event.key === 'End') target = max;
      else return;
      event.preventDefault();
      move(which, target);
    });
  }

  box.setKind = (next) => {
    what = next;
    if (last) draw(last);
  };
  box.refresh = () => {
    const state = read();
    enabled = state !== null;
    if (state === null) {
      last = { low: min, high: max };
    } else if (dragging) {
      // The finger is on a handle: it stays where the finger put it.
      last = { ...state, low: value.low, high: value.high };
    } else {
      last = state;
      value = { low: state.low, high: state.high };
    }
    draw(last);
  };
  box.handles = handles;
  return box;
}

/** Shows the bytes of a fixture in a list, with the names of its channels. */
export function renderReadout(list, dmx, controls) {
  if (list.children.length !== dmx.length) {
    list.textContent = '';
    const names = [];
    for (const control of controls) {
      names[control.channel - 1] = control.name;
      if (control.fineChannel) names[control.fineChannel - 1] = `${control.name} fine`;
    }
    dmx.forEach((_, i) => {
      const item = element('li');
      item.append(
        element('span', 'channel', `${i + 1} ${names[i] ?? ''}`),
        element('span', 'value'),
      );
      list.append(item);
    });
  }
  dmx.forEach((byte, i) => {
    const item = list.children[i];
    item.dataset.live = String(byte > 0);
    item.lastElementChild.textContent = String(byte);
  });
}

/**
 * The views of a page work as tabs: one on screen, arrow keys move between them, and
 * the address remembers which. Expects `tab-<name>` and `view-<name>` for every name (a tab is a
 * `.tab`, or a button of a `.snav`; a name without a view is only a tab). The chosen tab gets the class
 * `is-sel` and `aria-selected`. `onShow` is called with the name of the view that came on screen.
 */
export function views(names, onShow = () => {}) {
  let current = names[0];
  const show = (name, remember) => {
    current = names.includes(name) ? name : names[0];
    for (const each of names) {
      const tab = $(`tab-${each}`);
      tab.setAttribute('aria-selected', String(each === current));
      tab.classList.toggle('is-sel', each === current);
      tab.tabIndex = each === current ? 0 : -1;
      const view = $(`view-${each}`);
      if (view) view.hidden = each !== current;
    }
    if (remember) history.replaceState(null, '', `#${current}`);
    onShow(current);
  };
  names.forEach((name, i) => {
    const tab = $(`tab-${name}`);
    tab.addEventListener('click', () => show(name, true));
    tab.addEventListener('keydown', (event) => {
      const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
      const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
      if (!forward && !back) return;
      event.preventDefault();
      const next = names[(i + (forward ? 1 : -1) + names.length) % names.length];
      show(next, true);
      $(`tab-${next}`).focus();
    });
  });
  // A link to #colour and so on opens that view straight away.
  show(location.hash.slice(1), false);
  return {
    show,
    get current() {
      return current;
    },
  };
}

/**
 * A segmented control (Show and Program, a mode): `.tab` buttons in a `.tabs.seg` group, one chosen,
 * which is white (where you are). `items` are `{ id, label, tone }`, `choose(id)` is called on a press, and
 * `holder` is the element to fill. An item with `tone: 'edit'` is blue when it is the chosen one (the
 * Program side of Show and Program: blue means that a press stores something). Gives what shows the
 * chosen one: call it with the id that is on.
 */
export function segmented(holder, items, choose) {
  holder.classList.add('tabs', 'seg');
  holder.setAttribute('role', 'group');
  const keys = items.map(({ id, label, tone }) => {
    const made = button('tab', label, () => choose(id));
    if (tone) made.dataset.tone = tone;
    holder.append(made);
    return { id, made };
  });
  return (chosen) => {
    for (const { id, made } of keys) {
      made.classList.toggle('is-sel', id === chosen);
      made.setAttribute('aria-pressed', String(id === chosen));
    }
  };
}

/**
 * Keys to choose one thing from (Static, Step, Fade; 1 to 4 colours): `.key.c` buttons side by side in
 * a `.keys` row, the chosen one on (`is-on`: amber bar and outline). `items` are `{ id, label }`.
 * Gives what shows the chosen one: call it with the id that is on (or nothing for none).
 */
export function choiceKeys(holder, items, choose) {
  holder.classList.add('keys');
  const keys = items.map(({ id, label }) => {
    const made = button('key c', label, () => choose(id));
    holder.append(made);
    return { id, made };
  });
  return (chosen) => {
    for (const { id, made } of keys) {
      made.classList.toggle('is-on', id === chosen);
      made.setAttribute('aria-pressed', String(id === chosen));
    }
  };
}

// ---- notices that can be clicked away ----

/** By notice, the words the operator clicked away. */
const clickedAway = new WeakMap();

/**
 * Lets the operator click a notice away (tablet pages: a notice lies over the keys and would stay
 * as long as its cause does). It stays away while it says the same, and comes back when it says
 * something else, and when it has been silent and speaks again.
 */
export function makeDismissible(notice) {
  notice.dataset.dismissible = 'true';
  notice.tabIndex = 0;
  const away = () => {
    clickedAway.set(notice, notice.textContent);
    notice.hidden = true;
  };
  notice.addEventListener('click', away);
  notice.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      away();
    }
  });
}

/** Puts words in a notice, or hides it when there are none or the operator clicked those away. */
export function setNotice(notice, text) {
  if (text === '') clickedAway.delete(notice);
  notice.textContent = text;
  notice.hidden = text === '' || clickedAway.get(notice) === text;
}
