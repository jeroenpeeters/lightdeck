// The page of a spider. Plain browser JavaScript, no build step.
//
// The page keeps a copy of the state of the fixture, changes it as the operator moves
// things, and hands the changes to the shell, which sends them. Changes made on
// another screen come back through the shell. While an effect runs, the server also
// sends the bytes that go to the fixture, and the lenses and tilts are drawn from those.
//
// Three things run on a spider, apart from each other. The light effect (`state.effect`)
// says how much of each colour of the palette every lens gets, and knows no colour. The
// palette (`state.colour.palette`, one of `shell.show.palettes`, which are made on the
// Palettes page) says what the colours are. The movement (`state.motion`) tilts the bars.
// The Effects view has the first two, the Movement view the third, with the zone (`state.zone`: how far it reaches) and the swing limit. The Colour view is the
// colour of each lens by hand; a light effect sets the lenses while it runs.
//
// Tempo, blackout, the master and the master speed are not the spider's: they are in the
// shell.
// The master is set on the deck. Here it only dims the drawing of the lenses, which
// shows what goes out.

import { start } from '../shell.js';
import {
  $,
  button,
  element,
  percent,
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
const VIEWS = ['effects', 'colour', 'movement', 'fixture'];
const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
const RESET_HOLD_MS = 1000;
/** The least percent between where a bar may start and where it must stop. */
const SWING_GAP = 5;
/** How long a swing limit is sent after the last move of a slider. */
const SWING_SEND_MS = 300;
/** How long what was set stays on the sliders after the server answered, for the show to catch up. */
const SWING_SETTLE_MS = 1000;

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
const rows = [];
/** The swing limit per bar, in percent of the tilt, as the sliders have it. */
let swing = [];
const swingRows = [];
/** The sliders of the zone, one pair per bar. */
const zoneRows = [];
let swingTimer;
/** Until then the sliders keep what the operator set, whatever the show says. */
let swingHeld = 0;
let swingProblem = '';

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
  buildMotion();

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
  buildSwing();
  buildZone();

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

/** What an effect says about its colours: dots for the colours it uses, hollow for an extra. */
function costOf(effect) {
  const cost = element('span', 'cost');
  if (effect.slots > 3) {
    cost.textContent = 'All colours';
    return cost;
  }
  // Three means two, and a third that the effect only uses when the palette has one.
  const required = effect.slots === 3 ? 2 : effect.slots;
  for (let i = 0; i < effect.slots; i++) {
    const dot = element('span', 'cost-dot');
    dot.dataset.optional = String(i >= required);
    cost.append(dot);
  }
  cost.setAttribute('role', 'img');
  cost.setAttribute('aria-label', costWords(effect));
  return cost;
}

function costWords(effect) {
  if (effect.slots > 3) return 'uses all colours of the palette';
  if (effect.slots === 3) return 'uses two colours, and a third when the palette has one';
  return `uses ${countWord(effect.slots)} ${effect.slots === 1 ? 'colour' : 'colours'}`;
}

function buildEffects() {
  for (const effect of effects) {
    const made = button('effect', '', () => setEffect({ id: effect.id }));
    made.append(element('span', 'effect-name', effect.name), costOf(effect));
    made.setAttribute('aria-label', `${effect.name}, ${costWords(effect)}`);
    made.dataset.effect = effect.id;
    $('effect-list').append(made);
  }
  $('effect-stop').addEventListener('click', () => setEffect({ id: null }));
  showSpeed = speedKeys($('effect-speed'), fixture.details.speeds ?? [1], (speed) =>
    setEffect({ speed }),
  );

  // The pace of the palette: one of the speeds, or its own.
  showPaceSpeed = speedKeys($('palette-speed'), fixture.details.speeds ?? [1], (speed) =>
    setColour({ speed }),
  );
  const own = button('pick', 'Own', () => setColour({ speed: null }));
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
  for (const old of list.querySelectorAll('.palette-key')) old.remove();

  // No palette is a single white.
  list.append(paletteKey(null, 'None', ['#ffffff00'], 'No palette, a single white'));
  for (const palette of palettes) {
    const mark = palette.mode === 'cycle' ? (palette.change === 'fade' ? 'fades' : 'cycles') : '';
    list.append(paletteKey(palette, palette.label, palette.colours, undefined, mark));
  }
}

function paletteKey(palette, name, colours, label, mark = '') {
  const made = button('key palette-key', '', () => setColour({ palette: palette?.id ?? null }));
  made.dataset.palette = palette?.id ?? '';
  const chips = element('span', 'palette-chips');
  chips.setAttribute('aria-hidden', 'true');
  for (const entry of colours) {
    const chip = element('span', 'palette-chip');
    if (entry === 'off') chip.dataset.off = 'true';
    else chip.style.setProperty('--chip', paletteChipColour(entry));
    chips.append(chip);
  }
  const text = element('span', 'palette-label');
  text.append(element('span', 'palette-name', name));
  if (mark) text.append(element('span', 'palette-mark', mark));
  made.append(chips, text);
  made.setAttribute(
    'aria-label',
    label ?? `${name}, ${mark === '' ? 'static' : mark === 'fades' ? 'cycles and fades' : mark}`,
  );
  return made;
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
  const hold = button('effect', 'Hold', () => setMotion({ id: null }));
  hold.dataset.motion = 'hold';
  $('motion-list').append(hold);
  for (const effect of motionEffects) {
    const made = button('effect', effect.name, () => setMotion({ id: effect.id }));
    made.dataset.motion = effect.id;
    $('motion-list').append(made);
  }
  showMotionSpeed = speedKeys($('motion-speed'), fixture.details.speeds ?? [1], (speed) =>
    setMotion({ speed }),
  );
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
    hint = `${effect.name} sets the colours while it runs. What you mix here comes back when it stops.`;
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
}

/** What the movement view says about the sliders while a movement runs. */
function renderMovement() {
  const motion = runningMotion();
  for (const made of document.querySelectorAll('[data-motion]')) {
    const id = made.dataset.motion === 'hold' ? null : made.dataset.motion;
    made.setAttribute('aria-pressed', String(id === state.motion.id));
  }
  let about = 'The bars stay where the tilt sliders below put them.';
  if (motion) {
    about = motion.description;
    if (motion.setsMotorSpeed) about += ' It sets the motor speed when it can.';
  }
  $('motion-effect-hint').textContent = about;
  const speed = state.motion.speed ?? 1;
  showMotionSpeed(speed);
  $('motion-speed-hint').textContent = motion
    ? speedNote(speed, shell.speed(speed))
    : 'Speed counts when a movement runs.';
  $('motion-hint').textContent = motion
    ? `${motion.name} moves the bars now${motion.setsMotorSpeed ? ' and sets the motor speed when it can' : ''}. What you set below comes back when you choose Hold.`
    : '';
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
  const motion = runningMotion();
  for (const made of document.querySelectorAll('.effect[data-effect]')) {
    made.setAttribute('aria-pressed', String(made.dataset.effect === state.effect.id));
  }
  $('effect-stop').disabled = !effect;
  const running = [effect?.name, motion?.name].filter(Boolean);
  $('running').dataset.on = String(running.length > 0);
  $('running').textContent = running.length > 0 ? running.join(' · ') : 'No effect';
  $('effect-hint').textContent = effect
    ? effect.description
    : 'Choose an effect. It lights the lenses in time with the music, in the colours of the palette. Brightness, strobe and blackout stay with you.';
  const speed = state.effect.speed ?? 1;
  showSpeed(speed);
  $('speed-hint').textContent = speedNote(speed, shell.speed(speed));

  const palette = chosenPalette();
  for (const made of document.querySelectorAll('.palette-key')) {
    made.setAttribute('aria-pressed', String(made.dataset.palette === (palette?.id ?? '')));
  }
  const cycles = palette?.mode === 'cycle' && palette.colours.length > 1;
  const pace = state.colour.speed;
  showPaceSpeed(pace);
  $('pace-own').setAttribute('aria-pressed', String(pace === null));
  $('palette-speed').disabled = !cycles;
  if (cycles) {
    const own = pace ?? palette.speed;
    $('pace-hint').textContent =
      `${pace === null ? 'Own pace of the palette. ' : ''}${speedNote(own, shell.speed(own))}`;
  } else {
    $('pace-hint').textContent = palette
      ? 'This palette does not cycle, so a pace does nothing.'
      : 'No palette: a single white, and no pace.';
  }
  $('palette-hint').textContent = paletteNote(effect, palette);
}

// ---- the swing limit ----

/** The limits of the show for this spider, per bar, in percent. A bar without one is free. */
function swingOfShow() {
  const limits = shell.show?.limits?.[fixture.id]?.tilt ?? [];
  return bars.map((_, i) => ({
    min: Math.round((limits[i]?.min ?? 0) * 100),
    max: Math.round((limits[i]?.max ?? 1) * 100),
  }));
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

function setSwing(bar, edge, percentValue) {
  const mine = swing[bar];
  if (!mine) return;
  if (edge === 'min') mine.min = Math.min(percentValue, mine.max - SWING_GAP);
  else mine.max = Math.max(percentValue, mine.min + SWING_GAP);
  renderSwing();
  sendSwing();
}

function buildSwing() {
  swing = swingOfShow();
  bars.forEach((bar, i) => {
    for (const edge of ['min', 'max']) {
      const row = slider({
        id: `swing-${edge}-${i}`,
        label: `${bar.name} ${edge === 'min' ? 'from' : 'to'}`,
        min: edge === 'min' ? 0 : SWING_GAP,
        max: edge === 'min' ? 100 - SWING_GAP : 100,
        read: () => swing[i]?.[edge] ?? (edge === 'min' ? 0 : 100),
        write: (number) => setSwing(i, edge, number),
      });
      $('swing-sliders').append(row);
      swingRows.push(row);
    }
  });
  $('swing-reset').addEventListener('click', () => {
    swing = bars.map(() => ({ min: 0, max: 100 }));
    renderSwing();
    sendSwing();
  });
}

function renderSwing() {
  for (const row of swingRows) row.refresh();
  const limited = swing
    .map((each, i) => ({ ...each, name: bars[i]?.name ?? '' }))
    .filter((each) => each.min > 0 || each.max < 100);
  $('swing-hint').textContent =
    limited.length === 0
      ? 'No limit: the bars may tilt over their whole range.'
      : `${limited.map((each) => `${each.name} stays between ${each.min} and ${each.max}`).join(', ')}.`;
  $('swing-reset').disabled = limited.length === 0;
}

// ---- the zone ----

/** The zone of the state per bar, in percent. A bar without a window has the whole range. */
function zoneOfState() {
  const windows = state.zone?.tilt ?? [];
  return bars.map((_, i) => ({
    min: Math.round((windows[i]?.min ?? 0) * 100),
    max: Math.round((windows[i]?.max ?? 1) * 100),
  }));
}

/** Moves one end of the window of a bar. The zone is sent whole: every bar with its window. */
function setZone(bar, edge, percentValue) {
  const windows = zoneOfState();
  const mine = windows[bar];
  if (!mine) return;
  if (edge === 'min') mine.min = Math.min(percentValue, mine.max - SWING_GAP);
  else mine.max = Math.max(percentValue, mine.min + SWING_GAP);
  const zone = { tilt: windows.map(({ min, max }) => ({ min: min / 100, max: max / 100 })) };
  state.zone = zone;
  shell.send({ zone });
  render();
}

function buildZone() {
  bars.forEach((bar, i) => {
    for (const edge of ['min', 'max']) {
      const row = slider({
        id: `zone-${edge}-${i}`,
        label: `${bar.name} ${edge === 'min' ? 'from' : 'to'}`,
        min: edge === 'min' ? 0 : SWING_GAP,
        max: edge === 'min' ? 100 - SWING_GAP : 100,
        read: () => zoneOfState()[i]?.[edge] ?? (edge === 'min' ? 0 : 100),
        write: (number) => setZone(i, edge, number),
      });
      $('zone-sliders').append(row);
      zoneRows.push(row);
    }
  });
  $('zone-reset').addEventListener('click', () => {
    state.zone = null;
    shell.send({ zone: null });
    render();
  });
}

function renderZone() {
  for (const row of zoneRows) row.refresh();
  const on = state.zone != null;
  $('zone-hint').textContent = on
    ? `${zoneOfState()
        .map((each, i) => `${bars[i]?.name ?? ''} reaches from ${each.min} to ${each.max}`)
        .join(', ')}.`
    : 'No zone: the movement works inside the swing limit.';
  $('zone-reset').disabled = !on;
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
  renderMixer();
  renderEffects();
  renderMovement();
  renderSwing();
  renderZone();
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
  motionEffects = fixture.details.motionEffects ?? [];
  state = fixture.state;
  dmx = fixture.dmx;

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
