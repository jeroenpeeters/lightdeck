// The page of a spider. Plain browser JavaScript, no build step.
//
// The page is a setup page of the console (design mockups 09 and 10): the shell puts the top bar with the Live
// key above it, the page has a head (name, where it is patched, what is on now), a side navigation with five
// views selected by the URL hash (#effects, #colour, #movement, #zone, #fixture) and, at the right, the
// output: a lens monitor per bar with its tilt, a side view of the bars, and the brightness and the strobe.
//
// The page keeps a copy of the state of the fixture, changes it as the operator moves things, and hands the
// changes to the shell, which sends them. Changes made on another screen come back through the shell. While
// an effect runs, the server also sends the bytes that go to the fixture, and the lenses and tilts are drawn
// from those.
//
// Three things run on a spider, apart from each other. The light effect (`state.effect`) says how much of each
// colour of the palette every lens gets, and knows no colour. The palette (`state.colour.palette`, one of
// `shell.show.palettes`, which are made on the Palettes page) says what the colours are. The movement
// (`state.motion`) tilts the bars. The Effects view has the first two, the Movement view the third with the
// swing limit of each bar (kept in the show file), and the Zone view has the zone (`state.zone`: the window
// of each bar the movement works inside). Swing limit and zone are two handles on one rail per bar
// (`range` of ui.js): the limit is what the bar may never pass, the zone what the movement reaches. The
// Colour view is the colour of each lens by hand, a tool that no scene stores; a light effect sets the lenses
// while it runs. The Fixture view has the spider's own programs, the restart and the bytes being sent.
//
// Tempo, blackout, the master and the master speed are not the spider's: they are in the top bar. The master
// is set there too. Here it only dims the drawing of the lenses, which shows what goes out.
//
// Not on this page, because there is no way to do it from a fixture page: storing the zone as a scene (the
// deck does that, in Program).

import { start } from '../shell.js';
import { curveAt } from '../spiderPose.js';
import {
  $,
  button,
  element,
  fader,
  percent,
  range,
  renderReadout,
  sentence,
  slider,
  speedKeys,
  speedNote,
  views,
} from '../ui.js';

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
const VIEWS = ['effects', 'colour', 'movement', 'zone', 'fixture'];
const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
const RESET_HOLD_MS = 1000;
/** The least percent between where a bar may start and where it must stop. */
const SWING_GAP = 5;
/** How long a swing limit is sent after the last move of a handle. */
const SWING_SEND_MS = 300;
/** How long what was set stays on the handles after the server answered, for the show to catch up. */
const SWING_SETTLE_MS = 1000;
const SVG = 'http://www.w3.org/2000/svg';
/** The side view: where the bars hang (x of the pivot, in the viewBox), how long a beam is. */
const SIDE_PIVOT_Y = 22;
const SIDE_BEAM = 92;
const SIDE_X = { back: 70, front: 130 };

let shell;
let fixture;
let effects = [];
let motionEffects = [];
/** Show which speed of the light effect, of the movement and of the palette is chosen. */
let showSpeed = () => {};
let showMotionSpeed = () => {};
let showPaceSpeed = () => {};
/** The palettes of the show as the keys were built, to build them again only when they change. */
let paletteSignature = '';
/** Bars as the page names them: 1-based lens numbers and the tilt control of the bar. */
let bars = [];
let colours = [];
let allCells = [];
let state;
let dmx = [];
const selected = new Set();
/** The views of the page, and which of them is on screen. */
let pages;
/** Faders and sliders to read again after a change. */
const rows = [];
/** The keys that choose lenses, with the cells each chooses. */
const picks = [];
/** The tilt of each bar as it is drawn now, in percent (not rounded: it marks the rail). */
let tilts = [];
/** The swing limit per bar, in percent of the tilt, as the handles have it. */
let swing = [];
/** The two-handle rails of the swing limit and of the zone, and the words above each. */
const swingRails = [];
const zoneRails = [];
const reachWords = [];
let swingTimer;
/** Until then the handles keep what the operator set, whatever the show says. */
let swingHeld = 0;
let swingProblem = '';
/** The tilt faders move both bars together. */
let linkBars = true;
/** The beams of the side view, one per bar. */
let beams = [];
/** Set the live text under the effect keys, their speed, the movement keys and their speed. */
let setEffectHint = () => {};
let setSpeedHint = () => {};
let setMotionHint = () => {};
let setMotionSpeedHint = () => {};

const EFFECT_NONE =
  'Choose an effect. It lights the lenses in time with the music, in the colours of the palette. Brightness, strobe and blackout stay with you.';
const EFFECT_SPEED_NONE = 'Speed counts when an effect runs.';
const MOTION_NONE = 'The bars stay where the tilt sliders below put them.';
const MOTION_SPEED_NONE = 'Speed counts when a movement runs.';

/** What the Movement view says about a movement that runs. */
function movementNote(motion) {
  let about = `${motion.name}: ${motion.description}`;
  if (motion.setsMotorSpeed) about += ' It sets the motor speed when it can.';
  about += ' What you set below comes back when you choose Hold.';
  return about;
}

// ---- small helpers ----

/** A key that says it is on: the class for the look, the attribute for a reader. */
function mark(made, on) {
  made.classList.toggle('is-on', on);
  made.setAttribute('aria-pressed', String(on));
}

/** A key that can be pressed, or rests (dashed) when there is nothing for it to do. */
function enable(made, on) {
  made.disabled = !on;
  made.classList.toggle('is-disabled', !on);
}

/**
 * Text that changes with a key, with its room kept: every text it can say lies in the same grid cell as
 * the live one, hidden, so the cell is as high as the longest whatever the width of the column. Gives
 * the function that sets the live text.
 */
function reservedText(holder, candidates) {
  holder.textContent = '';
  holder.classList.add('reserved');
  for (const text of new Set(candidates)) {
    const ghost = element('span', 'ghost', text);
    ghost.setAttribute('aria-hidden', 'true');
    holder.append(ghost);
  }
  const live = element('span', 'live');
  holder.append(live);
  return (text) => {
    live.textContent = text;
  };
}

/** Everything speedNote can say for the speeds of this fixture. */
function speedNotes() {
  const speeds = fixture.details.speeds ?? [1];
  const said = [];
  for (const own of speeds) {
    for (const given of speeds) {
      said.push(speedNote(own, { given, held: false }), speedNote(own, { given, held: true }));
    }
  }
  return said;
}

function countWord(count) {
  return COUNT_WORDS[count] ?? String(count);
}

function makeSvg(tag, attributes) {
  const made = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) made.setAttribute(name, String(value));
  return made;
}

// ---- building the page ----

function buildMonitor() {
  const monitor = $('strip');
  for (const bar of bars) {
    const block = element('div', 'bar-mon col');
    block.dataset.tilt = bar.tilt;
    const head = element('div', 'row between');
    head.append(
      element('span', 'lbl', `${bar.name} · ${bar.cells.join(' ')}`),
      element('span', 'num t2 tilt-value'),
    );
    const lenses = element('div', 'lenses big');
    for (const cell of bar.cells) {
      const lens = button('lens', '', () => {
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
      lens.append(element('span', 'lens-no', String(cell)));
      lenses.append(lens);
    }
    const track = element('div', 'tilt-track');
    track.setAttribute('aria-hidden', 'true');
    track.append(element('i'));
    block.append(head, lenses, track);
    monitor.append(block);
  }
}

/** The side view: a beam per bar, hung where the bar is (back at the left, front at the right). */
function buildSideView() {
  const svg = $('side-view');
  const sides = fixture.details.layout.side ?? [];
  beams = bars.map((_bar, i) => {
    const x = SIDE_X[sides[i]] ?? 40 + (120 * (i + 1)) / (bars.length + 1);
    const beam = makeSvg('line', {
      class: 'sv-beam',
      x1: x,
      y1: SIDE_PIVOT_Y,
      x2: x,
      y2: SIDE_PIVOT_Y + SIDE_BEAM,
    });
    const pivot = makeSvg('circle', { class: 'sv-pivot', cx: x, cy: SIDE_PIVOT_Y, r: 3.5 });
    svg.append(beam, pivot);
    return { beam, x };
  });
}

function buildColour() {
  const pick = (label, cells) => {
    const made = button('key c', label, () => {
      selected.clear();
      for (const cell of cells) selected.add(cell);
      render();
    });
    picks.push({ made, cells });
    return made;
  };
  $('picks').append(
    pick(`All ${countWord(allCells.length)}`, allCells),
    ...bars.map((bar) => pick(bar.name, bar.cells)),
    pick('None', []),
  );

  // The mixer works on the chosen lenses.
  for (const colour of colours) {
    const made = fader({
      id: `s-${colour}`,
      label: colour.charAt(0).toUpperCase() + colour.slice(1),
      tone: ['red', 'green', 'blue', 'white'].includes(colour) ? colour : undefined,
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
    $('colour-sliders').append(made);
    rows.push(made);
  }

  for (const swatch of SWATCHES) {
    const made = button('key swatch', '', () => {
      const levels = {};
      for (const cell of selected) {
        for (const colour of colours) levels[`${colour}${cell}`] = swatch[colour];
      }
      setLevels(levels);
    });
    const chip = element('span', 'sw');
    chip.style.background = css(mix(swatch), 1);
    made.append(chip, element('span', '', swatch.name));
    made.dataset.swatch = swatch.name;
    $('swatches').append(made);
  }
}

/** What an effect says about its colours: dots for the colours it uses, hollow for an extra. */
function costOf(effect) {
  if (effect.slots > 3) return element('span', 'sub', 'All colours');
  const cost = element('span', 'd');
  // Three means two, and a third that the effect only uses when the palette has one.
  const required = effect.slots === 3 ? 2 : effect.slots;
  for (let i = 0; i < effect.slots; i++) {
    const dot = element('i');
    if (i >= required) dot.className = 'o';
    cost.append(dot);
  }
  return cost;
}

function costWords(effect) {
  if (effect.slots > 3) return 'uses all colours of the palette';
  if (effect.slots === 3) return 'uses two colours, and a third when the palette has one';
  return `uses ${countWord(effect.slots)} ${effect.slots === 1 ? 'colour' : 'colours'}`;
}

function buildEffects() {
  const list = $('effect-list');
  const stop = $('effect-stop');
  for (const effect of effects) {
    const made = button('key fx', '', () => setEffect({ id: effect.id }));
    made.append(element('span', 'fx-name', effect.name), costOf(effect));
    made.setAttribute('aria-label', `${effect.name}, ${costWords(effect)}`);
    made.dataset.effect = effect.id;
    list.insertBefore(made, stop);
  }
  stop.addEventListener('click', () => setEffect({ id: null }));
  showSpeed = speedKeys($('effect-speed'), fixture.details.speeds ?? [1], (speed) =>
    setEffect({ speed }),
  );

  // The pace of the palette: one of the speeds, or its own.
  showPaceSpeed = speedKeys($('palette-speed'), fixture.details.speeds ?? [1], (speed) =>
    setColour({ speed }),
  );
  const own = button('', 'Own', () => setColour({ speed: null }));
  own.id = 'pace-own';
  $('palette-speed').append(own);

  buildPalettes();
}

/** The palettes of the show, as keys. Built again when the show says they changed. */
function buildPalettes() {
  const palettes = shell.show?.palettes ?? [];
  const signature = JSON.stringify(palettes);
  if (signature === paletteSignature) return;
  paletteSignature = signature;

  const list = $('palette-list');
  list.textContent = '';
  // No palette is a single white.
  list.append(paletteKey(null, 'None', ['#ffffff'], 'single white', 'No palette, a single white'));
  for (const palette of palettes) {
    const mark = palette.mode === 'cycle' ? (palette.change === 'fade' ? 'fades' : 'cycles') : '';
    list.append(paletteKey(palette, palette.label, palette.colours, mark));
  }
}

function paletteKey(palette, name, entries, note = '', label) {
  const made = button('chip palette-key', '', () => setColour({ palette: palette?.id ?? null }));
  made.dataset.palette = palette?.id ?? '';
  const head = element('span', 'pk-head');
  head.append(element('span', 'pk-name', name));
  if (note) head.append(element('span', 'sub', note));
  made.append(head, paletteStrip(palette, entries));
  made.setAttribute(
    'aria-label',
    label ?? `${name}, ${note === '' ? 'static' : note === 'fades' ? 'cycles and fades' : note}`,
  );
  return made;
}

/** The colours of a palette as a strip; a palette that fades is drawn as the fade, an empty slot as dark. */
function paletteStrip(palette, entries) {
  const strip = element('span', 'strip');
  strip.setAttribute('aria-hidden', 'true');
  const fades =
    palette?.mode === 'cycle' &&
    palette.change === 'fade' &&
    entries.length > 1 &&
    !entries.includes('off');
  if (fades) {
    const span = element('span');
    span.style.background = `linear-gradient(90deg, ${entries.map(paletteChipColour).join(', ')})`;
    strip.append(span);
    return strip;
  }
  for (const entry of entries) {
    const span = element('span', entry === 'off' ? 'dark' : '');
    if (entry !== 'off') span.style.background = paletteChipColour(entry);
    strip.append(span);
  }
  return strip;
}

/** An entry of a palette, '#rrggbb' or '#rrggbbww', as the colour of a chip. */
function paletteChipColour(entry) {
  const part = (from) => Number.parseInt(entry.slice(from, from + 2), 16) / 255;
  return css(
    mix({ red: part(1), green: part(3), blue: part(5), white: entry.length >= 9 ? part(7) : 0 }),
    1,
  );
}

function buildMotion() {
  const list = $('motion-list');
  const hold = button('key c', 'Hold', () => setMotion({ id: null }));
  hold.dataset.motion = 'hold';
  list.append(hold);
  for (const effect of motionEffects) {
    const made = button('key c', effect.name, () => setMotion({ id: effect.id }));
    made.dataset.motion = effect.id;
    list.append(made);
  }
  showMotionSpeed = speedKeys($('motion-speed'), fixture.details.speeds ?? [1], (speed) =>
    setMotion({ speed }),
  );

  // The tilts by hand, and the motor speed.
  const keyOfLink = $('link-bars');
  for (const bar of bars) {
    const made = fader({
      id: `s-${bar.tilt}`,
      label: `Tilt ${bar.name.toLowerCase()}`,
      read: () => percent(state.levels[bar.tilt] ?? 0),
      write: (number) => {
        const levels = { [bar.tilt]: number / 100 };
        if (linkBars) for (const other of bars) levels[other.tilt] = number / 100;
        setLevels(levels);
      },
    });
    $('motion-sliders').insertBefore(made, keyOfLink);
    rows.push(made);
  }
  const motor = levelFader('motorSpeed', 'Motor speed');
  $('motion-sliders').insertBefore(motor, keyOfLink);
  keyOfLink.addEventListener('click', () => {
    linkBars = !linkBars;
    mark(keyOfLink, linkBars);
  });
  mark(keyOfLink, linkBars);
}

function levelFader(name, label) {
  const made = fader({
    id: `s-${name}`,
    label,
    read: () => percent(state.levels[name] ?? 0),
    write: (number) => setLevels({ [name]: number / 100 }),
  });
  rows.push(made);
  return made;
}

/** The two rails per bar of a view, and the words above each. `which` is 'limit' or 'zone'. */
function buildRails(holder, which, rails, write) {
  bars.forEach((bar, i) => {
    const block = element('div', 'col rail-block');
    const head = element('div', 'row between');
    const words = element('span', 'num t2 rail-words');
    head.append(element('span', 'rail-name', bar.name), words);
    reachWords.push({ words, i });
    const made = range({
      id: `${which}-${i}`,
      label: bar.name,
      gap: SWING_GAP,
      kind: which,
      ticks: i === bars.length - 1,
      read: () => railState(i, which),
      write: ({ low, high }) => write(i, low, high),
    });
    rails.push(made);
    block.append(head, made);
    holder.append(block);
  });
}

function buildReach() {
  swing = swingOfShow();
  buildRails($('swing-bars'), 'limit', swingRails, setSwing);
  buildRails($('zone-bars'), 'zone', zoneRails, setZone);
  $('swing-reset').addEventListener('click', () => {
    swing = bars.map(() => ({ min: 0, max: 100 }));
    renderSwing();
    sendSwing();
  });
  $('zone-reset').addEventListener('click', () => {
    state.zone = null;
    shell.send({ zone: null });
    render();
  });
  $('to-zone').addEventListener('click', () => pages.show('zone', true));
  $('to-swing').addEventListener('click', () => pages.show('movement', true));
}

function buildFixtureView() {
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
}

/** The texts under the keys keep the room of the longest they can say, so no key below them moves. */
function reserveHints() {
  const notes = speedNotes();
  const effectTexts = effects.map((effect) => `${effect.name}: ${effect.description}`);
  setEffectHint = reservedText($('effect-hint'), [EFFECT_NONE, ...effectTexts]);
  setSpeedHint = reservedText($('speed-hint'), [EFFECT_SPEED_NONE, ...notes]);
  const motionTexts = motionEffects.flatMap((motion) => {
    const said = `${motion.name}: ${motion.description}`;
    return [movementNote(motion), said];
  });
  setMotionHint = reservedText($('motion-effect-hint'), [MOTION_NONE, ...motionTexts]);
  setMotionSpeedHint = reservedText($('motion-speed-hint'), [MOTION_SPEED_NONE, ...notes]);
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
  tilts = bars.map(() => 0);
  for (const cell of allCells) selected.add(cell);

  buildMonitor();
  buildSideView();
  buildColour();
  buildEffects();
  buildMotion();
  reserveHints();
  $('master-sliders').append(levelFader('dimmer', 'Brightness'), levelFader('strobe', 'Strobe'));
  buildReach();
  buildFixtureView();

  pages = views(VIEWS, (view) => {
    $('app').dataset.view = view;
    if (view === 'fixture') renderReadout($('readout'), dmx, fixture.controls);
    if (view === 'movement' || view === 'zone') renderReach();
  });
}

function buildReset() {
  const resetButton = $('reset');
  const label = element('span', 'reset-label', resetButton.textContent);
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

function setMotion(patch) {
  Object.assign(state.motion, patch);
  shell.send({ motion: patch });
  render();
}

function setColour(patch) {
  Object.assign(state.colour, patch);
  shell.send({ colour: patch });
  render();
}

/** The light effect that is chosen, if it is one the fixture knows. */
function runningEffect() {
  return effects.find((effect) => effect.id === state.effect.id);
}

/** The movement that is chosen. Hold is none. */
function runningMotion() {
  return motionEffects.find((effect) => effect.id === state.motion.id);
}

/** The palette that is chosen, or undefined for a single white. */
function chosenPalette() {
  const id = state.colour.palette;
  return id === null ? undefined : (shell.show?.palettes ?? []).find((each) => each.id === id);
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
 * The colours and tilts to draw. A light effect decides the colours itself and a movement
 * the tilts, so while either runs they are read back from the bytes being sent.
 */
function shownLevels() {
  if ((!runningEffect() && !runningMotion()) || dmx.length === 0) return state.levels;
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
  bars.forEach((bar, i) => {
    tilts[i] = (levels[bar.tilt] ?? 0) * 100;
  });
  for (const block of document.querySelectorAll('.bar-mon')) {
    const tilt = levels[block.dataset.tilt] ?? 0;
    block.style.setProperty('--tilt', String(tilt));
    block.querySelector('.tilt-value').textContent = `tilt ${percent(tilt)}`;
  }
  const lit = new Map();
  for (const lens of document.querySelectorAll('.lens')) {
    const cell = Number(lens.dataset.cell);
    const colour = mix(Object.fromEntries(colours.map((c) => [c, levels[`${c}${cell}`] ?? 0])));
    const luminance = (0.299 * colour[0] + 0.587 * colour[1] + 0.114 * colour[2]) / 255;
    lens.style.setProperty('--lit', css(colour, brightness));
    lens.style.setProperty('--mix', css(colour, 1));
    lens.dataset.bright = String(luminance * brightness > 0.55);
    lens.setAttribute('aria-pressed', String(selected.has(cell)));
    lens.setAttribute('aria-label', `Lens ${cell}${selected.has(cell) ? ', chosen' : ''}`);
    lit.set(cell, { colour, luminance: luminance * brightness, brightness });
  }
  renderSideView(levels, lit);
  renderReach();
}

/** The bars as seen from the side, turned as far as their tilt says (the calibration of the fixture). */
function renderSideView(levels, lit) {
  const curves = fixture.details.layout.tiltCurve ?? [];
  bars.forEach((bar, i) => {
    const tilt = levels[bar.tilt] ?? 0;
    const degrees = curves[i] ? curveAt(tilt, curves[i]) : (tilt - 0.5) * 180;
    const angle = (degrees * Math.PI) / 180;
    const { beam, x } = beams[i];
    beam.setAttribute('x2', (x + SIDE_BEAM * Math.sin(angle)).toFixed(1));
    beam.setAttribute('y2', (SIDE_PIVOT_Y + SIDE_BEAM * Math.cos(angle)).toFixed(1));
    // The beam has the colour of the brightest lens of its bar, and rests grey when the bar is dark.
    let best;
    for (const cell of bar.cells) {
      const here = lit.get(cell);
      if (here && (!best || here.luminance > best.luminance)) best = here;
    }
    if (best && best.luminance > 0.02) beam.style.stroke = css(best.colour, best.brightness);
    else beam.style.removeProperty('stroke');
  });
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
    hint = `${effect.name} sets the colours while it runs. What you mix here comes back when it stops.`;
  } else if (!selection) {
    hint = 'No lens is chosen. Tap a lens in the output at the side to colour it.';
  } else if (differ) {
    hint = 'These lenses have different colours. Moving a slider gives them all the same value.';
  }
  $('mixer-hint').textContent = hint;
  for (const { made, cells: own } of picks) {
    const same = own.length === selected.size && own.every((cell) => selected.has(cell));
    made.classList.toggle('is-picked', same);
    made.setAttribute('aria-pressed', String(same));
  }
  for (const swatch of document.querySelectorAll('#swatches .swatch')) {
    enable(swatch, Boolean(selection));
  }
}

/** What the movement view says about the sliders while a movement runs. */
function renderMovement() {
  const motion = runningMotion();
  for (const made of document.querySelectorAll('[data-motion]')) {
    const id = made.dataset.motion === 'hold' ? null : made.dataset.motion;
    mark(made, id === state.motion.id);
  }
  setMotionHint(motion ? movementNote(motion) : MOTION_NONE);
  const speed = state.motion.speed ?? 1;
  showMotionSpeed(speed);
  setMotionSpeedHint(motion ? speedNote(speed, shell.speed(speed)) : MOTION_SPEED_NONE);
}

/** The words for the palette under the keys: what the effect does with the colours. */
const DARK_BETWEEN = {
  kick: 'it falls to dark between the hits',
  chase: 'the lenses the chase has not reached are dark',
  bounce: 'the lenses the bounce has not reached are dark',
  swap: 'the bar that is not lit is dark',
  wave: 'the trough of the wave is dark',
  sparkle: 'the lenses between the sparks are dark',
  bars: 'the second bar is dark',
  alternate: 'the bar that is not lit is dark',
  cross: 'the beam of the second colour is dark',
  ticktock: 'the right side is dark',
  scan: 'the way back is dark',
  pairs: 'the inside pair is dark',
  stab: 'the second stab is dark',
  fade: 'it fades to dark and back',
  strobe: 'every other flash is dark',
  seesaw: 'the bar that is fading out is dark',
  glow: 'the lenses the pool of light is not at are dark',
};
const COLOUR_ROLES = ['what hits', 'the backdrop', 'the accent'];
/** The effects whose colours are not a hit over a backdrop. */
const OTHER_ROLES = {
  bars: ['the first bar', 'the second bar'],
  alternate: ['every other lens', 'the lenses between'],
  cross: ['the beam going along', 'the beam coming the other way'],
  ticktock: ['the left side', 'the right side'],
  scan: ['the way along', 'the way back'],
  pairs: ['the outside pair', 'the inside pair'],
  stab: ['the first stab', 'the second stab'],
  fade: ['the colour it fades from', 'the colour it fades to'],
  strobe: ['the first flash', 'the next flash'],
  seesaw: ['the bar that glows first', 'the colour it fades to'],
  glow: ['the heart of the pool', 'the edge of the pool'],
};

function paletteNote(effect, palette) {
  if (!effect) return 'The palette colours the lenses while a light effect runs.';
  const entries = palette?.colours ?? ['#ffffff'];
  const count = entries.length;
  const cycles = palette?.mode === 'cycle' && count > 1;
  const required = effect.slots === 3 ? 2 : effect.slots;
  const said = [];
  if (effect.slots > 3) {
    said.push(
      count === 1
        ? `${effect.name} gives the lenses the colours of the palette, and this one has a single colour.`
        : `${effect.name} gives the lenses the colours of the palette, one after the other.`,
    );
  } else if (effect.slots === 1) {
    said.push('Every lens shows the first colour of the palette.');
  } else {
    const roles = (OTHER_ROLES[effect.id] ?? COLOUR_ROLES)
      .slice(0, Math.min(count, effect.slots))
      .map((role, i) => `colour ${i + 1} is ${role}`);
    said.push(sentence(roles.join(', ')));
    if (count < required) {
      const dark = DARK_BETWEEN[effect.id] ?? 'the second colour is dark';
      said.push(
        `${palette ? 'This palette has one colour' : 'With no palette the colour is white'}, so ${dark}.`,
      );
    } else if (effect.slots === 3 && count === 2) {
      said.push(
        `With two colours ${effect.name} runs without the third. A palette with three colours looks different.`,
      );
    }
  }
  const used = effect.slots > 3 ? count : Math.min(count, effect.slots);
  if (entries.slice(0, used).includes('off')) said.push('A colour that is off is dark.');
  if (cycles) said.push('Every step shifts the colours one place.');
  else if (effect.slots <= 3 && count > effect.slots) {
    said.push(`Only the first ${countWord(effect.slots)} colours are used.`);
  }
  return said.join(' ');
}

function renderEffects() {
  const effect = runningEffect();
  for (const made of document.querySelectorAll('.fx[data-effect]')) {
    mark(made, made.dataset.effect === state.effect.id);
  }
  enable($('effect-stop'), Boolean(effect));
  setEffectHint(effect ? `${effect.name}: ${effect.description}` : EFFECT_NONE);
  const speed = state.effect.speed ?? 1;
  showSpeed(speed);
  setSpeedHint(effect ? speedNote(speed, shell.speed(speed)) : EFFECT_SPEED_NONE);

  const palette = chosenPalette();
  for (const made of document.querySelectorAll('.palette-key')) {
    mark(made, made.dataset.palette === (palette?.id ?? ''));
  }
  const cycles = palette?.mode === 'cycle' && palette.colours.length > 1;
  const pace = state.colour.speed;
  showPaceSpeed(pace);
  mark($('pace-own'), pace === null && cycles);
  $('palette-speed').disabled = !cycles;
  if (cycles) {
    const own = pace ?? palette.speed;
    $('pace-hint').textContent =
      `${pace === null ? `Own pace of ${palette.label}. ` : ''}${speedNote(own, shell.speed(own))}`;
  } else {
    $('pace-hint').textContent = palette
      ? 'This palette does not cycle, so a pace does nothing.'
      : 'No palette: a single white, and no pace.';
  }
  $('palette-hint').textContent = paletteNote(effect, palette);
}

/** The head of the page and the side navigation say what is on now: the effect, the palette, the movement. */
function renderNow() {
  const effect = runningEffect();
  const motion = runningMotion();
  const palette = chosenPalette();
  const tags = [effect?.name, palette?.label, motion?.name, state.zone != null ? 'Zone' : null];
  const now = $('now');
  now.textContent = '';
  const said = tags.filter(Boolean);
  if (said.length === 0) now.append(element('span', 'tag mute', 'Nothing'));
  for (const text of said) now.append(element('span', 'tag on', text));
  for (const [id, text] of [
    ['nav-effect', effect?.name],
    ['nav-motion', motion?.name],
  ]) {
    $(id).hidden = !text;
    $(id).textContent = text ?? '';
  }
  $('nav-zone').hidden = state.zone == null;
}

// ---- the swing limit and the zone ----

/** The limits of the show for this spider, per bar, in percent. A bar without one is free. */
function swingOfShow() {
  const limits = shell.show?.limits?.[fixture.id]?.tilt ?? [];
  return bars.map((_, i) => ({
    min: Math.round((limits[i]?.min ?? 0) * 100),
    max: Math.round((limits[i]?.max ?? 1) * 100),
  }));
}

/** The zone of the state per bar, in percent. A bar without a window has the whole range. */
function zoneOfState() {
  const windows = state.zone?.tilt ?? [];
  return bars.map((_, i) => ({
    min: Math.round((windows[i]?.min ?? 0) * 100),
    max: Math.round((windows[i]?.max ?? 1) * 100),
  }));
}

/** What a rail of a bar draws: its own window under the handles, the other one beside it, and the tilt now. */
function railState(i, which) {
  const limit = swing[i] ?? { min: 0, max: 100 };
  const limited = limit.min > 0 || limit.max < 100;
  const zone = state.zone == null ? null : zoneOfState()[i];
  const now = tilts[i] ?? null;
  if (which === 'zone') {
    return {
      low: zone?.min ?? 0,
      high: zone?.max ?? 100,
      window: limited ? { low: limit.min, high: limit.max } : null,
      now,
    };
  }
  return {
    low: limit.min,
    high: limit.max,
    window: zone ? { low: zone.min, high: zone.max } : null,
    now,
  };
}

/** The words above a bar: where its limit and its zone are, and the tilt now. */
function reachWordsOf(i) {
  const limit = swing[i] ?? { min: 0, max: 100 };
  const zone = state.zone == null ? null : zoneOfState()[i];
  const limited = limit.min > 0 || limit.max < 100;
  return [
    limited ? `limit ${limit.min}–${limit.max}` : 'no limit',
    zone ? `zone ${zone.min}–${zone.max}` : 'no zone',
    `tilt ${Math.round(tilts[i] ?? 0)}`,
  ].join(' · ');
}

/** Draws the rails of the view that is on screen (the others are drawn when they come on screen). */
function renderReach() {
  if (!pages) return;
  for (const { words, i } of reachWords) {
    const text = reachWordsOf(i);
    if (words.textContent !== text) words.textContent = text;
  }
  if (pages.current === 'movement') for (const made of swingRails) made.refresh();
  if (pages.current === 'zone') for (const made of zoneRails) made.refresh();
}

/** Sends the limits a moment after the last move, so that a drag is one request, not fifty. */
function sendSwing() {
  clearTimeout(swingTimer);
  swingHeld = Number.POSITIVE_INFINITY;
  swingTimer = setTimeout(async () => {
    const sent = JSON.stringify(swing);
    const answer = await shell.ask(`/api/fixtures/${fixture.id}/limits`, {
      tilt: swing.map(({ min, max }) => ({ min: min / 100, max: max / 100 })),
    });
    swingProblem = answer.ok || answer.lost ? '' : sentence(answer.error);
    if (swingProblem !== '') {
      // Refused: the show is what is true.
      swing = swingOfShow();
      swingHeld = 0;
    } else if (JSON.stringify(swing) === sent) {
      swingHeld = Date.now() + SWING_SETTLE_MS;
    } else {
      // Moved again while this was on its way: that move sends its own.
      swingHeld = Number.POSITIVE_INFINITY;
    }
    renderSwing();
    shell.refresh();
  }, SWING_SEND_MS);
}

function setSwing(bar, low, high) {
  if (!swing[bar]) return;
  swing[bar] = { min: low, max: high };
  renderSwing();
  sendSwing();
}

function renderSwing() {
  renderReach();
  const limited = swing.some((each) => each.min > 0 || each.max < 100);
  enable($('swing-reset'), limited);
}

/** Moves the window of a bar. The zone is sent whole: every bar with its window. */
function setZone(bar, low, high) {
  const windows = zoneOfState();
  if (!windows[bar]) return;
  windows[bar] = { min: low, max: high };
  const zone = { tilt: windows.map(({ min, max }) => ({ min: min / 100, max: max / 100 })) };
  state.zone = zone;
  shell.send({ zone });
  render();
}

function renderZone() {
  const on = state.zone != null;
  $('zone-hint').textContent = on
    ? `${zoneOfState()
        .map((each, i) => `${bars[i]?.name ?? ''} reaches from ${each.min} to ${each.max}`)
        .join(', ')}.`
    : 'No zone: the movement works inside the swing limit.';
  enable($('zone-reset'), on);
}

/** What the spider has to say in the notice of the shell. */
function notes() {
  const said = [];
  if (swingProblem !== '') said.push({ text: swingProblem, urgent: true });
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
  renderNow();
  renderMixer();
  renderEffects();
  renderMovement();
  renderSwing();
  renderZone();
  for (const row of rows) row.refresh();
  enable($('reset'), !state.resetting);
  renderReadout($('readout'), dmx, fixture.controls);
  shell.refresh();
}

async function main() {
  shell = await start();
  if (!shell) return;
  fixture = shell.fixture;
  effects = fixture.details.effects;
  motionEffects = fixture.details.motionEffects ?? [];
  state = fixture.state;
  dmx = fixture.dmx;
  $('where').textContent =
    `Port ${fixture.universe + 1} · address ${fixture.address} · ${fixture.footprint} channels`;

  build();
  shell.notes(notes);
  shell.on('show', () => {
    buildPalettes();
    if (Date.now() >= swingHeld) swing = swingOfShow();
    renderSwing();
    render();
  });
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
