// The page of a spider. Plain browser JavaScript, no build step.
//
// The page keeps a copy of the state of the fixture, changes it as the operator moves
// things, and hands the changes to the shell, which sends them. Changes made on
// another screen come back through the shell. While an effect runs, the server also
// sends the bytes that go to the fixture, and the lenses are drawn from those.
//
// Tempo, speed, blackout and the master are not the spider's: they are in the shell.
// The master is set on the deck. Here it only dims the drawing of the lenses, which
// shows what goes out.

import { start } from '../shell.js';
import { $, button, element, percent, renderReadout, slider, views } from '../ui.js';

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
const VIEWS = ['effects', 'colour', 'movement', 'fixture'];
const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
const RESET_HOLD_MS = 1000;

let shell;
let fixture;
let effects = [];
/** Bars as the page names them: 1-based lens numbers and the tilt control of the bar. */
let bars = [];
let colours = [];
let allCells = [];
let state;
let dmx = [];
const selected = new Set();
/** The views of the page, and which of them is on screen. */
let pages;
const rows = [];

// ---- building the page ----

/** Where a bar is tilted: the number, and a mark on a short track. */
function tiltMeter() {
  const meter = element('div', 'tilt');
  const track = element('span', 'tilt-track');
  track.setAttribute('aria-hidden', 'true');
  meter.append(element('span', 'tilt-label', 'Tilt'), element('span', 'tilt-value'), track);
  return meter;
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

function swatchButton(swatch, onClick) {
  const made = button('swatch', swatch.name, onClick);
  made.style.setProperty('--chip', css(mix(swatch), 1));
  return made;
}

function countWord(count) {
  return COUNT_WORDS[count] ?? String(count);
}

function build() {
  const layout = fixture.details.layout;
  colours = [...layout.colours];
  bars = layout.bars.map((cells, i) => ({
    name: `Bar ${i + 1}`,
    tilt: layout.tilt[i],
    cells: cells.map((cell) => cell + 1),
  }));
  allCells = Array.from({ length: layout.cells }, (_, i) => i + 1);
  for (const cell of allCells) selected.add(cell);

  // The output strip.
  const drawing = $('strip');
  for (const bar of bars) {
    const row = element('div', 'bar-row');
    row.dataset.tilt = bar.tilt;
    const body = element('div', 'bar');
    for (const cell of bar.cells) {
      const lens = button('lens', String(cell), () => {
        if (pages.current !== 'colour') {
          // Outside the colour view a tap means: I want to colour this one.
          selected.clear();
          selected.add(cell);
          pages.show('colour', true);
        } else if (selected.has(cell)) selected.delete(cell);
        else selected.add(cell);
        render();
      });
      lens.dataset.cell = String(cell);
      body.append(lens);
    }
    row.append(element('span', 'bar-name', bar.name), body, tiltMeter());
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
        shell.send({ raw: { [control.name]: number } });
      },
      meaning: (number) => {
        const range = control.ranges.find((r) => number >= r.from && number <= r.to);
        return range ? range.meaning : control.label;
      },
    });
    $('program-sliders').append(row);
    rows.push(row);
  }

  buildReset();
  pages = views(VIEWS, (view) => {
    $('console').dataset.view = view;
    if (view === 'fixture') renderReadout($('readout'), dmx, fixture.controls);
  });
}

function buildEffects() {
  for (const effect of effects) {
    const made = button('effect', effect.name, () => setEffect({ id: effect.id }));
    made.dataset.effect = effect.id;
    $('effect-list').append(made);
  }
  $('effect-stop').addEventListener('click', () => setEffect({ id: null }));

  for (const [id, key] of [
    ['colour-a', 'colourA'],
    ['colour-b', 'colourB'],
  ]) {
    for (const swatch of SWATCHES) {
      if (swatch.name === 'Off') continue;
      const { name, ...colour } = swatch;
      // Colour only, to keep the palette on one row. The name is there for screen readers.
      const made = swatchButton(swatch, () => setEffect({ [key]: colour }));
      made.classList.add('chip');
      made.textContent = '';
      made.setAttribute('aria-label', name);
      made.dataset.swatch = name;
      $(id).append(made);
    }
  }
}

function buildReset() {
  const resetButton = $('reset');
  const label = element('span', '', resetButton.textContent);
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
    timer = setTimeout(() => {
      cancel();
      shell.act('reset');
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
  shell.send({ levels });
  render();
}

function setEffect(patch) {
  Object.assign(state.effect, patch);
  shell.send({ effect: patch });
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
  // What goes out: the brightness that is set times the master, and nothing in a blackout.
  const brightness = shell.blackout ? 0 : (state.levels.dimmer ?? 0) * shell.master;
  for (const row of document.querySelectorAll('.bar-row')) {
    const tilt = levels[row.dataset.tilt] ?? 0;
    row.style.setProperty('--tilt', String(tilt));
    row.querySelector('.tilt-value').textContent = String(percent(tilt));
  }
  for (const lens of document.querySelectorAll('.lens')) {
    const cell = Number(lens.dataset.cell);
    const colour = mix(Object.fromEntries(colours.map((c) => [c, levels[`${c}${cell}`] ?? 0])));
    const luminance = (0.299 * colour[0] + 0.587 * colour[1] + 0.114 * colour[2]) / 255;
    lens.style.setProperty('--lit', css(colour, brightness));
    lens.style.setProperty('--mix', css(colour, 1));
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
    hint = 'No lens is chosen. Tap a lens in the output strip to colour it.';
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
  for (const made of document.querySelectorAll('.effect')) {
    made.setAttribute('aria-pressed', String(made.dataset.effect === state.effect.id));
  }
  $('effect-stop').disabled = !effect;
  $('running').dataset.on = String(Boolean(effect));
  $('running').textContent = effect ? effect.name : 'No effect';
  $('effect-hint').textContent = effect
    ? effect.description
    : 'Choose an effect. It sets the colours in time with the music. Brightness, strobe and blackout stay with you.';

  for (const [id, key] of [
    ['colour-a', 'colourA'],
    ['colour-b', 'colourB'],
  ]) {
    for (const made of $(id).querySelectorAll('.swatch')) {
      const swatch = SWATCHES.find((s) => s.name === made.dataset.swatch);
      made.setAttribute('aria-pressed', String(sameColour(swatch, state.effect[key])));
    }
  }
  const uses = effect?.colours ?? 'both';
  $('colour-a').disabled = uses === 'none';
  $('colour-b').disabled = uses !== 'both';
  const note = uses === 'both' ? '' : `${effect.name} brings its own colours.`;
  $('palette-hint').textContent = note;
  $('palette-hint').hidden = note === '';
}

/** What the spider has to say in the notice of the shell. */
function notes() {
  const said = [];
  if (state.resetting) said.push({ text: 'The spider is restarting.', urgent: true });
  const effect = runningEffect();
  if (effect && (state.levels.dimmer ?? 0) === 0) {
    said.push({
      text: `${effect.name} is running, but brightness is at 0. Raise the brightness to see it.`,
    });
  }
  return said;
}

function render() {
  renderFixture();
  renderMixer();
  renderEffects();
  for (const row of rows) row.refresh();
  $('reset').disabled = state.resetting;
  renderReadout($('readout'), dmx, fixture.controls);
  shell.refresh();
}

async function main() {
  shell = await start();
  if (!shell) return;
  fixture = shell.fixture;
  effects = fixture.details.effects;
  state = fixture.state;
  dmx = fixture.dmx;

  build();
  shell.notes(notes);
  shell.on('fixture', (message) => {
    // The shell has laid what is still on its way over the state, so nothing is set back.
    state = message.state;
    dmx = message.dmx;
    render();
  });
  shell.on('frame', (message) => {
    dmx = message.dmx;
    renderFixture();
    if (pages.current === 'fixture') renderReadout($('readout'), dmx, fixture.controls);
  });
  shell.on('change', render);
  render();
}

main();
