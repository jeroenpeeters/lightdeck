// What the pages build their controls from. Plain browser JavaScript, no build step.

export const $ = (id) => document.getElementById(id);

export function percent(level) {
  return Math.round(level * 100);
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

/** Keys to choose a speed from, in a fieldset. Gives what shows the chosen one. */
export function speedKeys(fieldset, speeds, choose) {
  const keys = speeds.map((speed) => {
    const made = button('pick', speedName(speed), () => choose(speed));
    made.setAttribute('aria-label', speedInWords(speed));
    fieldset.append(made);
    return { speed, made };
  });
  return (chosen) => {
    for (const { speed, made } of keys) {
      made.setAttribute('aria-pressed', String(speed === chosen));
    }
  };
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

/**
 * One labelled slider. `read` and `write` connect it to the state; `read` gives null
 * when there is nothing to set. Call `refresh` on the row to show the state again.
 */
export function slider({ id, label, tone, min = 0, max = 100, read, write, meaning }) {
  const row = element('div', 'slider');
  if (tone) row.dataset.tone = tone;

  const name = element('label', '', label);
  name.htmlFor = id;

  const value = element('output');
  value.htmlFor = id;

  const input = element('input');
  input.type = 'range';
  input.id = id;
  input.min = String(min);
  input.max = String(max);
  input.step = '1';

  row.append(name, value, input);
  let note;
  if (meaning) {
    note = element('p', 'meaning');
    row.append(note);
  }

  const show = (number) => {
    input.value = String(number);
    value.textContent = String(number);
    row.style.setProperty('--fill', `${((number - min) / (max - min)) * 100}%`);
    if (note) note.textContent = meaning(number);
  };
  input.addEventListener('input', () => {
    const number = Number(input.value);
    show(number);
    write(number);
  });
  row.refresh = () => {
    const number = read();
    input.disabled = number === null;
    show(number ?? min);
  };
  return row;
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
 * the address remembers which. Expects `tab-<name>` and `view-<name>` for every name.
 * `onShow` is called with the name of the view that came on screen.
 */
export function views(names, onShow = () => {}) {
  let current = names[0];
  const show = (name, remember) => {
    current = names.includes(name) ? name : names[0];
    for (const each of names) {
      const tab = $(`tab-${each}`);
      tab.setAttribute('aria-selected', String(each === current));
      tab.tabIndex = each === current ? 0 : -1;
      $(`view-${each}`).hidden = each !== current;
    }
    if (remember) history.replaceState(null, '', `#${current}`);
    onShow(current);
  };
  names.forEach((name, i) => {
    const tab = $(`tab-${name}`);
    tab.addEventListener('click', () => show(name, true));
    tab.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (step === 0) return;
      event.preventDefault();
      const next = names[(i + step + names.length) % names.length];
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
