// Spider control surface. Plain browser JavaScript, no build step.
//
// The page keeps a copy of the fixture state, changes it as the operator moves
// things, and posts the changes to the server. Changes made on another screen
// arrive over the event stream. While an effect runs, the server also sends the
// bytes that go to the fixture, and the lenses are drawn from those.

const SWATCHES = [
  { name: 'Amber', red: 1, green: 0.58, blue: 0, white: 0 },
  { name: 'Copper', red: 1, green: 0.34, blue: 0.06, white: 0 },
  { name: 'Sepia', red: 0.8, green: 0.46, blue: 0.2, white: 0.15 },
  { name: 'Fire', red: 1, green: 0.14, blue: 0, white: 0 },
  { name: 'Blue', red: 0, green: 0.15, blue: 1, white: 0 },
  { name: 'Cyan', red: 0, green: 0.8, blue: 1, white: 0 },
  { name: 'White', red: 0, green: 0, blue: 0, white: 1 },
  { name: 'Off', red: 0, green: 0, blue: 0, white: 0 },
];
const RATE_NAMES = { 0.5: 'Half', 1: 'Normal', 2: 'Double' };
const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
const BEATS_PER_BAR = 4;
const RESET_HOLD_MS = 1000;
const RETRY_MS = 600;
/** Taps further apart than this start a new count. */
const TAP_GAP_MS = 2000;
const TAPS_KEPT = 8;

const clientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const $ = (id) => document.getElementById(id);

let fixture;
let config;
let effects = [];
let tempo = { min: 60, max: 200, rates: [1] };
/** Bars as the page names them: 1-based lens numbers and the tilt control of the bar. */
let bars = [];
let colours = [];
let allCells = [];
let state = {
  levels: {},
  raw: {},
  blackout: false,
  resetting: false,
  effect: { id: null, bpm: 126, rate: 1, colourA: SWATCHES[0], colourB: SWATCHES[4] },
};
let dmx = [];
let status = { bridge: false, device: 'unknown', universes: 0, channels: [] };
let streamUp = true;
let sendFailed = false;
const selected = new Set();
/** A beat number and the moment it was true, to count on from between messages. */
let beatBase = { beat: 0, at: performance.now() };

// ---- talking to the server ----

let pending = null;
let inFlight = false;

/** Two patches as one; where both set the same thing, the newer wins. */
function merge(older, newer) {
  const merged = {
    levels: { ...(older?.levels ?? {}), ...(newer?.levels ?? {}) },
    raw: { ...(older?.raw ?? {}), ...(newer?.raw ?? {}) },
  };
  const blackout = newer?.blackout ?? older?.blackout;
  if (blackout !== undefined) merged.blackout = blackout;
  if (older?.effect || newer?.effect) {
    merged.effect = { ...(older?.effect ?? {}), ...(newer?.effect ?? {}) };
  }
  return merged;
}

/** Collects changes and sends one request at a time, always with the newest values. */
function send(patch) {
  pending = merge(pending, patch);
  flush();
}

async function reload() {
  const initial = await (await fetch('/api/state')).json();
  state = initial.state;
  dmx = initial.dmx;
  setBeat(initial.beat);
  render();
}

async function flush() {
  if (inFlight || !pending) return;
  const body = { ...pending, client: clientId };
  const sent = pending;
  pending = null;
  inFlight = true;
  try {
    const response = await fetch('/api/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.status === 400) {
      // The server refused the change. Sending it again will not help: show what is real.
      await reload();
    } else if (!response.ok) {
      throw new Error(response.statusText);
    }
    sendFailed = false;
  } catch {
    // Keep the change and try again; anything newer wins over what failed.
    // A tap on the beat is only right at the moment it was made.
    if (sent.effect) delete sent.effect.sync;
    pending = merge(sent, pending);
    sendFailed = true;
    setTimeout(flush, RETRY_MS);
  } finally {
    inFlight = false;
    renderNotice();
  }
  if (!sendFailed) flush();
}

function listen() {
  const events = new EventSource('/api/events');
  events.addEventListener('open', () => {
    streamUp = true;
    renderNotice();
  });
  events.addEventListener('error', () => {
    streamUp = false;
    renderNotice();
  });
  events.addEventListener('state', (event) => {
    const message = JSON.parse(event.data);
    dmx = message.dmx;
    if (message.origin === clientId) {
      renderReadout();
      return;
    }
    state = message.state;
    setBeat(message.beat);
    render();
  });
  events.addEventListener('frame', (event) => {
    const message = JSON.parse(event.data);
    dmx = message.dmx;
    setBeat(message.beat);
    renderFixture();
    if ($('programs').open) renderReadout();
  });
  events.addEventListener('status', (event) => {
    status = JSON.parse(event.data);
    renderLinks();
    renderNotice();
  });
}

// ---- the beat ----

function setBeat(beat) {
  if (typeof beat === 'number') beatBase = { beat, at: performance.now() };
}

function beatNow(now = performance.now()) {
  return beatBase.beat + ((now - beatBase.at) / 60_000) * state.effect.bpm;
}

let litBeat = -1;
function drawBeat() {
  const beat = Math.floor(beatNow());
  const index = ((beat % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR;
  if (index !== litBeat) {
    litBeat = index;
    [...$('beats').children].forEach((lamp, i) => {
      lamp.dataset.on = String(i === index);
    });
  }
  requestAnimationFrame(drawBeat);
}

const taps = [];
function tap() {
  const now = performance.now();
  if (taps.length > 0 && now - taps[taps.length - 1] > TAP_GAP_MS) taps.length = 0;
  taps.push(now);
  if (taps.length > TAPS_KEPT) taps.shift();

  const patch = { sync: true };
  if (taps.length >= 2) {
    const interval = (now - taps[0]) / (taps.length - 1);
    patch.bpm = Math.min(tempo.max, Math.max(tempo.min, Math.round(60_000 / interval)));
  }
  setEffect(patch);
}

// ---- building the page ----

function percent(level) {
  return Math.round(level * 100);
}

/** One labelled slider. `read` and `write` connect it to the state. */
function slider({ id, label, tone, min = 0, max = 100, read, write, meaning }) {
  const row = document.createElement('div');
  row.className = 'slider';
  if (tone) row.dataset.tone = tone;

  const name = document.createElement('label');
  name.htmlFor = id;
  name.textContent = label;

  const value = document.createElement('output');
  value.htmlFor = id;

  const input = document.createElement('input');
  input.type = 'range';
  input.id = id;
  input.min = String(min);
  input.max = String(max);
  input.step = '1';

  row.append(name, value, input);
  let note;
  if (meaning) {
    note = document.createElement('p');
    note.className = 'meaning';
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

/** A needle that leans the way the bar is tilted. The slider carries the value. */
function gauge() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 64 42');
  svg.setAttribute('class', 'gauge');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<path class="gauge-arc" d="M7.75 24 A28 28 0 0 1 56.25 24" />' +
    '<line class="gauge-needle" x1="32" y1="38" x2="32" y2="12" />' +
    '<circle class="gauge-pivot" cx="32" cy="38" r="3" />';
  return svg;
}

function levelSlider(container, name, label) {
  const row = slider({
    id: `s-${name}`,
    label,
    read: () => percent(state.levels[name] ?? 0),
    write: (number) => setLevels({ [name]: number / 100 }),
  });
  container.append(row);
  return row;
}

function button(className, text, onClick) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = text;
  element.addEventListener('click', onClick);
  return element;
}

function swatchButton(swatch, onClick) {
  const element = button('swatch', swatch.name, onClick);
  element.style.setProperty('--chip', css(mix(swatch), 1));
  return element;
}

function countWord(count) {
  return COUNT_WORDS[count] ?? String(count);
}

const rows = [];

function build() {
  const layout = fixture.layout;
  colours = [...layout.colours];
  bars = layout.bars.map((cells, i) => ({
    name: `Bar ${i + 1}`,
    tilt: layout.tilt[i],
    cells: cells.map((cell) => cell + 1),
  }));
  allCells = Array.from({ length: layout.cells }, (_, i) => i + 1);
  for (const cell of allCells) selected.add(cell);

  $('where').textContent =
    `Port ${config.universe + 1} of the LR512, address ${config.address}, ${fixture.footprint} channels`;

  // The fixture drawing.
  const drawing = $('fixture');
  for (const bar of bars) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    const label = document.createElement('span');
    label.className = 'bar-name';
    label.textContent = bar.name;
    row.dataset.tilt = bar.tilt;
    const body = document.createElement('div');
    body.className = 'bar';
    for (const cell of bar.cells) {
      const lens = button('lens', String(cell), () => {
        if (selected.has(cell)) selected.delete(cell);
        else selected.add(cell);
        render();
      });
      lens.dataset.cell = String(cell);
      body.append(lens);
    }
    row.append(label, body, gauge());
    drawing.append(row);
  }

  const pick = (label, cells) =>
    button('pick', label, () => {
      selected.clear();
      for (const cell of cells) selected.add(cell);
      render();
    });
  const all = countWord(allCells.length);
  $('picks').append(
    pick(`All ${all}`, allCells),
    ...bars.map((bar) => pick(bar.name, bar.cells)),
    pick('None', []),
  );

  // Colour mixer: works on the chosen lenses.
  for (const colour of colours) {
    const row = slider({
      id: `s-${colour}`,
      label: colour.charAt(0).toUpperCase() + colour.slice(1),
      tone: colour,
      read: () => {
        const first = [...selected].sort((a, b) => a - b)[0];
        return first === undefined ? null : percent(state.levels[`${colour}${first}`] ?? 0);
      },
      write: (number) => {
        const levels = {};
        for (const cell of selected) levels[`${colour}${cell}`] = number / 100;
        setLevels(levels);
      },
    });
    $('colour-sliders').append(row);
    rows.push(row);
  }

  for (const swatch of SWATCHES) {
    $('swatches').append(
      swatchButton(swatch, () => {
        const levels = {};
        for (const cell of selected) {
          for (const colour of colours) levels[`${colour}${cell}`] = swatch[colour];
        }
        setLevels(levels);
      }),
    );
  }

  buildEffects();

  rows.push(levelSlider($('master-sliders'), 'dimmer', 'Brightness'));
  rows.push(levelSlider($('master-sliders'), 'strobe', 'Strobe'));

  for (const bar of bars) {
    const row = slider({
      id: `s-${bar.tilt}`,
      label: `Tilt ${bar.name.toLowerCase()}`,
      read: () => percent(state.levels[bar.tilt] ?? 0),
      write: (number) => {
        const levels = { [bar.tilt]: number / 100 };
        if ($('link-bars').checked) for (const other of bars) levels[other.tilt] = number / 100;
        setLevels(levels);
      },
    });
    $('motion-sliders').append(row);
    rows.push(row);
  }
  rows.push(levelSlider($('motion-sliders'), 'motorSpeed', 'Motor speed'));

  // Built-in programs: the raw bytes, with the manual's meaning next to them.
  for (const control of fixture.controls) {
    if (control.kind !== 'function' || control.name === 'reset') continue;
    const row = slider({
      id: `s-${control.name}`,
      label: `Channel ${control.channel}`,
      max: 255,
      read: () => state.raw[control.name] ?? 0,
      write: (number) => {
        state.raw[control.name] = number;
        send({ raw: { [control.name]: number } });
      },
      meaning: (number) => {
        const range = control.ranges.find((r) => number >= r.from && number <= r.to);
        return range ? range.meaning : control.label;
      },
    });
    $('program-sliders').append(row);
    rows.push(row);
  }

  $('blackout').addEventListener('click', () => {
    state.blackout = !state.blackout;
    send({ blackout: state.blackout });
    render();
  });

  buildReset();
  // A link to #programs opens that section straight away.
  if (location.hash === '#programs') $('programs').open = true;
  $('programs').addEventListener('toggle', renderReadout);
  listen();
  requestAnimationFrame(drawBeat);
}

function buildEffects() {
  for (const effect of effects) {
    const element = button('effect', effect.name, () => setEffect({ id: effect.id }));
    element.dataset.effect = effect.id;
    $('effect-list').append(element);
  }
  $('effect-stop').addEventListener('click', () => setEffect({ id: null }));

  const row = slider({
    id: 's-bpm',
    label: 'Tempo, beats per minute',
    min: tempo.min,
    max: tempo.max,
    read: () => Math.round(state.effect.bpm),
    write: (number) => setEffect({ bpm: number }),
  });
  $('tempo-sliders').append(row);
  rows.push(row);

  // A tap counts when the finger lands, not when it lifts. The click covers the keyboard.
  const tapButton = $('tap');
  tapButton.addEventListener('pointerdown', (event) => {
    if (event.button === 0) tap();
  });
  tapButton.addEventListener('click', (event) => {
    if (event.detail === 0) tap();
  });

  for (const rate of tempo.rates) {
    const element = button('pick', RATE_NAMES[rate] ?? `${rate} times`, () => setEffect({ rate }));
    element.dataset.rate = String(rate);
    $('rates').append(element);
  }

  for (const [id, key] of [
    ['colour-a', 'colourA'],
    ['colour-b', 'colourB'],
  ]) {
    for (const swatch of SWATCHES) {
      if (swatch.name === 'Off') continue;
      const { name, ...colour } = swatch;
      const element = swatchButton(swatch, () => setEffect({ [key]: colour }));
      element.dataset.swatch = name;
      $(id).append(element);
    }
  }
}

function buildReset() {
  const resetButton = $('reset');
  const label = document.createElement('span');
  label.textContent = resetButton.textContent;
  resetButton.textContent = '';
  resetButton.append(label);
  let timer;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    resetButton.dataset.holding = 'false';
  };
  const begin = (event) => {
    if (state.resetting || timer) return;
    event.preventDefault();
    resetButton.dataset.holding = 'true';
    timer = setTimeout(async () => {
      cancel();
      try {
        const response = await fetch('/api/reset', { method: 'POST' });
        if (!response.ok) throw new Error();
      } catch {
        sendFailed = true;
        renderNotice();
      }
    }, RESET_HOLD_MS);
  };
  resetButton.addEventListener('pointerdown', begin);
  resetButton.addEventListener('pointerup', cancel);
  resetButton.addEventListener('pointerleave', cancel);
  resetButton.addEventListener('pointercancel', cancel);
  resetButton.addEventListener('keydown', (event) => {
    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) begin(event);
  });
  resetButton.addEventListener('keyup', cancel);
  resetButton.addEventListener('blur', cancel);
}

// ---- changing the state ----

function setLevels(levels) {
  Object.assign(state.levels, levels);
  send({ levels });
  render();
}

function setEffect(patch) {
  const now = performance.now();
  // Count on the way the server does: a tap restarts the bar, a new tempo keeps the beat.
  if (patch.sync) beatBase = { beat: 0, at: now };
  else if (patch.bpm !== undefined && patch.bpm !== state.effect.bpm) {
    beatBase = { beat: beatNow(now), at: now };
  }
  const { sync: _sync, ...kept } = patch;
  Object.assign(state.effect, kept);
  send({ effect: patch });
  render();
}

function runningEffect() {
  return effects.find((effect) => effect.id === state.effect.id);
}

// ---- drawing the state ----

/** RGBW levels to the colour a lens would show, as 0..255 per channel. */
function mix({ red, green, blue, white }) {
  return [
    Math.min(255, Math.round((red + white) * 255)),
    Math.min(255, Math.round((green + white * 0.94) * 255)),
    Math.min(255, Math.round((blue + white * 0.82) * 255)),
  ];
}

function css([r, g, b], brightness) {
  return `rgb(${Math.round(r * brightness)} ${Math.round(g * brightness)} ${Math.round(b * brightness)})`;
}

/**
 * The colours and tilts to draw. An effect decides those itself, so while one runs
 * they are read back from the bytes being sent.
 */
function shownLevels() {
  if (!runningEffect() || dmx.length === 0) return state.levels;
  const levels = { ...state.levels };
  const tilts = new Set(bars.map((bar) => bar.tilt));
  for (const control of fixture.controls) {
    if (control.kind !== 'level') continue;
    if (control.cell === undefined && !tilts.has(control.name)) continue;
    levels[control.name] = (dmx[control.channel - 1] ?? 0) / 255;
  }
  return levels;
}

function renderFixture() {
  const levels = shownLevels();
  const brightness = state.blackout ? 0 : (state.levels.dimmer ?? 0);
  for (const row of document.querySelectorAll('.bar-row')) {
    row.style.setProperty('--tilt', String(levels[row.dataset.tilt] ?? 0));
  }
  for (const lens of document.querySelectorAll('.lens')) {
    const cell = Number(lens.dataset.cell);
    const colour = mix(Object.fromEntries(colours.map((c) => [c, levels[`${c}${cell}`] ?? 0])));
    const peak = Math.max(...colour) / 255;
    const luminance = (0.299 * colour[0] + 0.587 * colour[1] + 0.114 * colour[2]) / 255;
    lens.style.setProperty('--lit', css(colour, brightness));
    lens.style.setProperty('--mix', css(colour, 1));
    lens.style.setProperty('--out', String(brightness * peak));
    lens.dataset.bright = String(luminance * brightness > 0.55);
    lens.setAttribute('aria-pressed', String(selected.has(cell)));
    lens.setAttribute('aria-label', `Lens ${cell}${selected.has(cell) ? ', chosen' : ''}`);
  }
}

function describeSelection() {
  const cells = [...selected].sort((a, b) => a - b);
  if (cells.length === 0) return null;
  if (cells.length === allCells.length) return `all ${countWord(cells.length)} lenses`;
  for (const bar of bars) {
    if (cells.length === bar.cells.length && bar.cells.every((c) => selected.has(c))) {
      return bar.name.toLowerCase();
    }
  }
  if (cells.length === 1) return `lens ${cells[0]}`;
  return `lenses ${cells.slice(0, -1).join(', ')} and ${cells[cells.length - 1]}`;
}

function renderMixer() {
  const selection = describeSelection();
  $('mixer-title').textContent = selection ? `Colour for ${selection}` : 'Colour';
  const cells = [...selected];
  const differ = colours.some((colour) => {
    const values = cells.map((cell) => percent(state.levels[`${colour}${cell}`] ?? 0));
    return new Set(values).size > 1;
  });
  const effect = runningEffect();
  let hint = '';
  if (effect) {
    hint = `${effect.name} sets the colours now. What you mix here is kept and comes back when you stop the effect.`;
  } else if (!selection) {
    hint = 'No lens is chosen. Tap a lens on the left to colour it.';
  } else if (differ) {
    hint = 'These lenses have different colours. Moving a slider gives them all the same value.';
  }
  $('mixer-hint').textContent = hint;
  $('mixer-hint').hidden = hint === '';
  for (const swatch of document.querySelectorAll('#swatches .swatch')) {
    swatch.disabled = !selection;
  }

  const moving = effect?.moves
    ? `${effect.name} moves the bars now. The tilt you set here comes back when you stop the effect.`
    : '';
  $('motion-hint').textContent = moving;
  $('motion-hint').hidden = moving === '';
}

function sameColour(a, b) {
  return colours.every((c) => Math.abs((a[c] ?? 0) - (b[c] ?? 0)) < 0.005);
}

function renderEffects() {
  const effect = runningEffect();
  for (const element of document.querySelectorAll('.effect')) {
    element.setAttribute('aria-pressed', String(element.dataset.effect === state.effect.id));
  }
  $('effect-stop').disabled = !effect;
  $('effect-hint').textContent = effect
    ? effect.description
    : 'Choose an effect. It sets the colours in time with the music. Brightness, strobe and blackout stay with you.';

  for (const element of document.querySelectorAll('#rates .pick')) {
    element.setAttribute(
      'aria-pressed',
      String(Number(element.dataset.rate) === state.effect.rate),
    );
  }
  for (const [id, key] of [
    ['colour-a', 'colourA'],
    ['colour-b', 'colourB'],
  ]) {
    for (const element of $(id).querySelectorAll('.swatch')) {
      const swatch = SWATCHES.find((s) => s.name === element.dataset.swatch);
      element.setAttribute('aria-pressed', String(sameColour(swatch, state.effect[key])));
    }
  }
  const uses = effect?.colours ?? 'both';
  $('colour-a').disabled = uses === 'none';
  $('colour-b').disabled = uses !== 'both';
  const note = uses === 'both' ? '' : `${effect.name} brings its own colours.`;
  $('palette-hint').textContent = note;
  $('palette-hint').hidden = note === '';
}

function renderReadout() {
  const list = $('readout');
  if (list.children.length !== dmx.length) {
    list.textContent = '';
    const names = [];
    for (const control of fixture.controls) {
      names[control.channel - 1] = control.name;
      if (control.fineChannel) names[control.fineChannel - 1] = `${control.name} fine`;
    }
    dmx.forEach((_, i) => {
      const item = document.createElement('li');
      const channel = document.createElement('span');
      channel.className = 'channel';
      channel.textContent = `${i + 1} ${names[i] ?? ''}`;
      const value = document.createElement('span');
      value.className = 'value';
      item.append(channel, value);
      list.append(item);
    });
  }
  dmx.forEach((byte, i) => {
    const item = list.children[i];
    item.dataset.live = String(byte > 0);
    item.lastElementChild.textContent = String(byte);
  });
}

function renderLinks() {
  const bridge = $('link-bridge');
  bridge.dataset.state = status.bridge ? 'ok' : 'down';
  bridge.querySelector('.link-text').textContent = status.bridge
    ? 'Bridge connected'
    : 'Bridge not connected';

  const device = $('link-device');
  const known = status.bridge && status.device !== 'unknown';
  device.dataset.state = !known ? 'unknown' : status.device === 'open' ? 'ok' : 'down';
  device.querySelector('.link-text').textContent = !known
    ? 'LR512'
    : status.device === 'open'
      ? 'LR512 connected'
      : 'LR512 not found';
}

function renderNotice() {
  let text = '';
  if (!streamUp || sendFailed) {
    text =
      'This page cannot reach lightdeck. It keeps trying; your last change is sent as soon as it is back.';
  } else if (!status.bridge) {
    text = `The bridge app does not answer at ${config.bridgeUrl}. Open LR512 Gate on the phone and keep it on screen.`;
  } else if (status.device === 'lost') {
    text =
      'The bridge cannot find the LR512 and keeps searching. Check that the LR512 has power and is on the Wi-Fi.';
  } else if (status.device === 'open' && config.universe >= status.universes) {
    text = `This LR512 has ${status.universes} ports and the spider is set to port ${config.universe + 1}. Start lightdeck with a lower SPIDER_UNIVERSE.`;
  } else if (status.device === 'open' && status.channels[config.universe] === 0) {
    const usable = status.channels.flatMap((count, i) => (count > 0 ? [i] : []));
    text =
      `Port ${config.universe + 1} of this LR512 has no channels, so nothing reaches the spider. ` +
      (usable.length > 0
        ? `Plug the spider into port ${usable[0] + 1} and start lightdeck with SPIDER_UNIVERSE=${usable[0]}.`
        : 'The LR512 reports no usable port.');
  } else if (state.resetting) {
    text = 'The spider is restarting.';
  } else if (state.blackout) {
    text = 'Blackout is on. The lights are dark and your colours are kept.';
  } else if (runningEffect() && (state.levels.dimmer ?? 0) === 0) {
    text = `${runningEffect().name} is running, but brightness is at 0. Raise the brightness to see it.`;
  }
  const notice = $('notice');
  notice.textContent = text;
  notice.hidden = text === '';
}

function render() {
  renderFixture();
  renderMixer();
  renderEffects();
  for (const row of rows) row.refresh();
  const blackout = $('blackout');
  blackout.setAttribute('aria-pressed', String(state.blackout));
  blackout.textContent = state.blackout ? 'Lift blackout' : 'Blackout';
  $('reset').disabled = state.resetting;
  renderReadout();
  renderLinks();
  renderNotice();
}

async function start() {
  try {
    const response = await fetch('/api/state');
    const initial = await response.json();
    fixture = initial.fixture;
    config = initial.config;
    effects = initial.effects;
    tempo = initial.tempo;
    state = initial.state;
    dmx = initial.dmx;
    status = initial.status;
    setBeat(initial.beat);
    build();
    render();
  } catch {
    const notice = $('notice');
    notice.textContent = 'This page cannot reach lightdeck. Check that it is running, then reload.';
    notice.hidden = false;
  }
}

start();
