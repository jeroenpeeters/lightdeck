// The page of the room: the lamps and switches that Home Assistant drives. Plain browser
// JavaScript, no build step.
//
// The room is one fixture with a lamp for each entity of Home Assistant, in zones. The page keeps
// a copy of the state, changes it as the operator moves things, and hands the changes to the
// shell, which sends them. What Home Assistant says about the lamps comes back in the same state
// (`state.reported`, `state.problems`) and is only shown, never set back.
//
// The lamps are the slow layer under the spider and the laser (Jeroen, 2026-10-18): static scenery
// that changes now and then. Three things are chosen apart. The level of each lamp (the lights of
// the room, which a scene keeps), the palette of the show (the colours, set on this page and on
// the deck) and a scenery effect, which moves the colours of the palette over the lamps every
// 128 beats (about a minute). A colour set by hand per lamp shows only while there is no palette.
//
// Tempo, blackout, the master and the master speed are not the room's: they are in the shell.
//
// The look is the console's (design/, lightdeck.css, chrome.css): the lamps in the main column (the
// room dimmer, then a panel per zone with its Switch, On and Off keys and a fader and a Colour key per
// lamp, one colour editor open at a time), the scenery in the side panel (palette, pace, effect, speed,
// fade). A state only swaps classes, so no key changes size; the line under a lamp that says what Home
// Assistant reports keeps its height. The head has the effect that runs and the keys for the whole room.

import { start } from '../shell.js';
import { $, button, element, percent, sentence, slider, speedKeys, speedName } from '../ui.js';

const COLOUR_PARTS = [
  { key: 'red', label: 'Red', tone: 'red' },
  { key: 'green', label: 'Green', tone: 'green' },
  { key: 'blue', label: 'Blue', tone: 'blue' },
  { key: 'white', label: 'White', tone: 'white' },
];

let shell;
let fixture;
let state;
let lamps = [];
let zones = [];
/** What is on the page for each lamp, by id. */
const parts = new Map();
/** The lamp whose colour is open, or null. */
let open = null;
let showSpeed = () => {};
let showPaceSpeed = () => {};
/** The slider of the fade. */
let fadeRow;
/** The slider of the dimmer of the room. */
let dimmerRow;
/** The palettes of the show as the keys were built, to build them again only when they change. */
let paletteSignature = '';
/** Per lamp, since when Home Assistant has had it other than it was told to. */
const differing = new Map();
let settleTimer;
/** A lamp takes a moment to report what it was told, so a difference counts only after this long. */
const SETTLE_MS = 5000;

// ---- colours ----

/** The colour of a swatch for a colour of the room: white adds to every part. */
function css({ red, green, blue, white }, level = 1) {
  const part = (value) => Math.round(Math.min(1, value + white) * level * 255);
  return `rgb(${part(red)} ${part(green)} ${part(blue)})`;
}

/** An entry of a palette, '#rrggbb' or '#rrggbbww', as the colour of a chip. */
function chipColour(entry) {
  const part = (from) => Number.parseInt(entry.slice(from, from + 2), 16) / 255;
  return css({
    red: part(1),
    green: part(3),
    blue: part(5),
    white: entry.length >= 9 ? part(7) : 0,
  });
}

const lights = () => lamps.filter((lamp) => lamp.kind === 'light');
const switches = () => lamps.filter((lamp) => lamp.kind === 'switch');

// ---- changing the room ----

function setLevels(patch) {
  Object.assign(state.levels, patch);
  shell.send({ levels: patch });
  render();
}

/** Switches a zone on or off. No scene, look or effect changes it, so it stays as it was put. */
function setZone(id, on) {
  state.zones = { ...state.zones, [id]: on ? 1 : 0 };
  shell.send({ zones: { [id]: on ? 1 : 0 } });
  render();
}

function setColourOf(id, key, number) {
  state.colours[id] = { ...state.colours[id], [key]: number / 100 };
  shell.send({ colours: { [id]: { [key]: number / 100 } } });
  render();
}

function setEffect(change) {
  state.effect = { ...state.effect, ...change };
  shell.send({ effect: change });
  render();
}

function setColour(change) {
  state.colour = { ...state.colour, ...change };
  shell.send({ colour: change });
  render();
}

function setFade(seconds) {
  state.fade = seconds;
  shell.send({ fade: seconds });
  render();
}

function setDimmer(percentage) {
  state.dimmer = percentage / 100;
  shell.send({ dimmer: state.dimmer });
  render();
}

/** Every lamp of these is set to the level: lights to a share, switches on or off. */
function setAll(which, level) {
  const patch = Object.fromEntries(which.map((lamp) => [lamp.id, level]));
  setLevels(patch);
}

// ---- building the page ----

function build() {
  lamps = fixture.details.lamps;
  zones = fixture.details.zones;

  const container = $('zones');
  for (const zone of zones) {
    const members = zone.lamps.map((id) => lamps.find((lamp) => lamp.id === id));
    container.append(buildZone(zone.label, members, zone.id));
  }
  const loose = switches();
  if (loose.length > 0) container.append(buildZone('Switches', loose, 'switches'));

  const whole = $('whole-room');
  whole.append(
    button('key c wide', 'All lamps on', () => setAll(lights(), 1)),
    button('key c wide', 'All off', () => setAll(lamps, 0)),
  );

  dimmerRow = slider({
    id: 's-dimmer',
    label: 'Room dimmer',
    read: () => percent(state.dimmer ?? 1),
    write: (number) => setDimmer(number),
  });
  $('dimmer-sliders').append(dimmerRow);

  buildEffects();
  buildPalettes();
  fadeRow = slider({
    id: 's-fade',
    label: 'Fade in seconds',
    min: 0,
    max: fixture.details.maxFade,
    read: () => Math.round(state.fade),
    write: (number) => setFade(number),
  });
  $('fade-sliders').append(fadeRow);
}

function buildZone(label, members, id) {
  const section = element('section', 'panel zone');
  section.dataset.zone = id;
  const head = element('div', 'zone-head');
  head.append(element('h3', '', label));
  const keys = element('div', 'zone-keys');
  const switchesOnly = members.every((lamp) => lamp.kind === 'switch');
  if (!switchesOnly) {
    // The switch of the zone: dimmer 0 or 1 for the lights in it, apart from every scene and look.
    const onOff = button('key c zone-switch', 'Switch', () =>
      setZone(id, (state.zones?.[id] ?? 1) <= 0),
    );
    onOff.title = 'Switch this zone on or off. A scene, a look or an effect does not change it.';
    onOff.setAttribute('aria-label', `${label} switch`);
    section.zoneSwitch = onOff;
    keys.append(onOff);
  }
  keys.append(
    button('key c', switchesOnly ? 'All on' : 'On', () => setAll(members, 1)),
    button('key c', 'Off', () => setAll(members, 0)),
  );
  head.append(keys);
  const list = element('ul', 'lamp-list');
  for (const lamp of members) list.append(buildLamp(lamp));
  section.append(head, list);
  return section;
}

function buildLamp(lamp) {
  const row = element('li', 'lamp-row');
  row.dataset.lamp = lamp.id;
  row.dataset.kind = lamp.kind;
  const swatch = element('span', 'lamp-swatch');
  swatch.setAttribute('aria-hidden', 'true');
  const note = element('p', 'lamp-note');
  note.dataset.level = 'none';
  const made = { row, swatch, note };

  if (lamp.kind === 'light') {
    made.level = slider({
      id: `s-level-${lamp.id}`,
      label: lamp.label,
      read: () => percent(state.levels[lamp.id] ?? 0),
      write: (number) => setLevels({ [lamp.id]: number / 100 }),
    });
    made.colourKey = button('key c colour-key', 'Colour', () => toggle(lamp.id));
    made.colourKey.setAttribute('aria-label', `Colour of ${lamp.label}`);
    made.colourKey.setAttribute('aria-expanded', 'false');
    row.append(swatch, made.level, made.colourKey, note, buildEditor(lamp, made));
  } else {
    // A switch is one key: its name, and On or Off under it.
    made.switchKey = button('key switch-key', '', () =>
      setLevels({ [lamp.id]: (state.levels[lamp.id] ?? 0) > 0 ? 0 : 1 }),
    );
    made.switchKey.setAttribute('aria-label', lamp.label);
    made.switchState = element('span', 'sub');
    made.switchKey.append(element('span', 'switch-name', lamp.label), made.switchState);
    made.follows = lamp.blackout ? ' · follows blackout' : '';
    row.append(made.switchKey, note);
  }
  parts.set(lamp.id, made);
  return row;
}

/** The colour of one lamp by hand: four sliders and the key that gives it to all the lights. */
function buildEditor(lamp, made) {
  const editor = element('div', 'colour-editor');
  editor.hidden = true;
  made.editor = editor;
  made.colourRows = [];
  const sliders = element('div', 'col');
  for (const { key, label, tone } of COLOUR_PARTS) {
    const row = slider({
      id: `s-${lamp.id}-${key}`,
      label,
      tone,
      read: () => percent(state.colours[lamp.id]?.[key] ?? 0),
      write: (number) => setColourOf(lamp.id, key, number),
    });
    made.colourRows.push(row);
    sliders.append(row);
  }
  const copy = button('key c', 'Give this colour to all lamps', () => {
    const colour = state.colours[lamp.id];
    const patch = Object.fromEntries(lights().map((each) => [each.id, { ...colour }]));
    state.colours = { ...state.colours, ...patch };
    shell.send({ colours: patch });
    render();
  });
  made.hint = element('p', 'hint');
  editor.append(sliders, copy, made.hint);
  return editor;
}

/** One colour editor is open at a time, so that the page stays short on a tablet. */
function toggle(id) {
  open = open === id ? null : id;
  render();
}

function buildEffects() {
  for (const effect of fixture.details.effects) {
    const made = button('chip', '', () => setEffect({ id: effect.id }));
    made.append(element('span', '', effect.name));
    made.dataset.effect = effect.id;
    $('effect-list').append(made);
  }
  const none = button('chip', '', () => setEffect({ id: null }));
  none.id = 'effect-stop';
  none.append(element('span', '', 'No effect'));
  $('effect-list').prepend(none);
  showSpeed = speedKeys($('effect-speed'), fixture.details.speeds, (speed) => setEffect({ speed }));
  // The pace of a cycling palette: one of the speeds, or its own.
  showPaceSpeed = speedKeys($('palette-speed'), fixture.details.speeds, (speed) =>
    setColour({ speed }),
  );
  const own = button('', 'Normal', () => setColour({ speed: null }));
  own.id = 'pace-own';
  $('palette-speed').append(own);
}

/** The palettes of the show, as keys. Built again when the show says they changed. */
function buildPalettes() {
  const palettes = shell.show?.palettes ?? [];
  const signature = JSON.stringify(palettes);
  if (signature === paletteSignature) return;
  paletteSignature = signature;

  const list = $('palette-list');
  for (const old of list.querySelectorAll('.palette-key')) old.remove();
  // No palette is the colours set by hand on each lamp.
  list.append(
    paletteKey(null, 'By hand', [], 'No palette, the colour of each lamp by hand', 'no palette'),
  );
  for (const palette of palettes) {
    const mark = palette.mode === 'cycle' ? (palette.change === 'fade' ? 'fades' : 'cycles') : '';
    list.append(paletteKey(palette, palette.label, palette.colours, undefined, mark));
  }
}

function paletteKey(palette, name, colours, label, mark = '') {
  const made = button('chip palette-key', '', () => setColour({ palette: palette?.id ?? null }));
  made.dataset.palette = palette?.id ?? '';
  const head = element('span', 'palette-head');
  head.append(element('span', 'palette-name', name));
  if (mark) head.append(element('span', 'sub', mark));
  // The same strip as everywhere: an entry that is off is a dark slot, a hatched one.
  const strip = element('span', 'strip');
  strip.setAttribute('aria-hidden', 'true');
  for (const entry of colours) {
    const chip = element('span', entry === 'off' ? 'dark' : '');
    if (entry !== 'off') chip.style.background = chipColour(entry);
    strip.append(chip);
  }
  made.append(head, strip);
  made.setAttribute(
    'aria-label',
    label ?? `${name}, ${mark === '' ? 'static' : mark === 'fades' ? 'cycles and fades' : mark}`,
  );
  return made;
}

// ---- drawing ----

/** The palette that is chosen, or undefined for the colours by hand. */
function chosenPalette() {
  const id = state.colour.palette;
  return id === null ? undefined : (shell.show?.palettes ?? []).find((each) => each.id === id);
}

function runningEffect() {
  return fixture.details.effects.find((each) => each.id === state.effect.id);
}

/**
 * What the page says about a lamp under its fader: why Home Assistant does not do what was asked,
 * or nothing. The line keeps its height, so nothing moves when it fills.
 */
function noteOf(lamp) {
  const problem = state.problems[lamp.id];
  if (problem) return { text: `Home Assistant refused: ${sentence(problem)}`, level: 'alarm' };
  const link = shell.links.hass?.state;
  const reported = state.reported[lamp.id];
  if (reported === null) {
    // Until it is connected there is nothing to know.
    return link === 'ok'
      ? { text: `Home Assistant does not know ${lamp.entity}.`, level: 'alarm' }
      : { text: '', level: 'none' };
  }
  if (!reported.available) return { text: 'Unavailable in Home Assistant.', level: 'alarm' };
  // The blackout and the master move every lamp: then they all differ, and that is no news.
  if (shell.blackout || shell.master === 0) return { text: '', level: 'none' };
  const wanted = (state.levels[lamp.id] ?? 0) > 0;
  if (wanted === reported.on) {
    differing.delete(lamp.id);
    return { text: '', level: 'none' };
  }
  const key = `${wanted}/${reported.on}`;
  if (differing.get(lamp.id)?.key !== key) differing.set(lamp.id, { key, since: Date.now() });
  const waited = Date.now() - differing.get(lamp.id).since;
  if (waited < Math.max(SETTLE_MS, (state.fade + 2) * 1000)) {
    // Not yet: the lamp may still be doing what it was told. Look again when it has had time.
    clearTimeout(settleTimer);
    settleTimer = setTimeout(render, Math.max(SETTLE_MS, (state.fade + 2) * 1000) - waited + 50);
    return { text: '', level: 'none' };
  }
  return {
    text: `Home Assistant has it ${reported.on ? 'on' : 'off'}. The next scene sets it again.`,
    level: 'note',
  };
}

function renderZones() {
  for (const section of document.querySelectorAll('.zone')) {
    const switchKey = section.zoneSwitch;
    if (!switchKey) continue;
    const on = (state.zones?.[section.dataset.zone] ?? 1) > 0;
    switchKey.classList.toggle('is-on', on);
    switchKey.setAttribute('aria-pressed', String(on));
    section.dataset.off = String(!on);
  }
}

function renderLamps() {
  renderZones();
  for (const lamp of lamps) {
    const made = parts.get(lamp.id);
    const level = state.levels[lamp.id] ?? 0;
    made.row.dataset.on = String(level > 0);
    if (lamp.kind === 'light') {
      made.level.refresh();
      const shown = state.shown[lamp.id] ?? state.colours[lamp.id];
      made.swatch.style.setProperty('--chip', css(shown, level > 0 ? 0.35 + 0.65 * level : 0));
      const isOpen = open === lamp.id;
      made.editor.hidden = !isOpen;
      made.colourKey.setAttribute('aria-expanded', String(isOpen));
      made.colourKey.setAttribute('aria-pressed', String(isOpen));
      if (isOpen) {
        for (const row of made.colourRows) row.refresh();
        const byHand = chosenPalette() === undefined && !runningEffect();
        made.hint.textContent = byHand
          ? 'This colour shows while no palette is chosen.'
          : 'A palette is chosen, so this colour is not used. Choose By hand to use it.';
      }
    } else {
      made.switchState.textContent = `${level > 0 ? 'On' : 'Off'}${made.follows}`;
      made.switchKey.classList.toggle('is-on', level > 0);
      made.switchKey.setAttribute('aria-pressed', String(level > 0));
    }
    const { text, level: tone } = noteOf(lamp);
    made.note.textContent = text;
    made.note.dataset.level = tone;
    made.row.dataset.state = tone;
  }
}

function renderScenery() {
  const effect = runningEffect();
  for (const made of document.querySelectorAll('#effect-list .chip[data-effect]')) {
    const on = made.dataset.effect === state.effect.id;
    made.classList.toggle('is-on', on);
    made.setAttribute('aria-pressed', String(on));
  }
  $('effect-stop').classList.toggle('is-on', !effect);
  $('effect-stop').setAttribute('aria-pressed', String(!effect));
  $('running').dataset.on = String(Boolean(effect));
  $('running').className = effect ? 'tag on' : 'tag mute';
  $('running').textContent = effect ? effect.name : 'No effect';
  $('effect-hint').textContent = effect
    ? effect.description
    : 'No effect: every lamp shows the first colour of the palette, or its own colour when there is no palette.';

  const speed = state.effect.speed ?? 1;
  showSpeed(speed);
  $('effect-speed').disabled = !effect;
  const period = fixture.details.periodBeats;
  const given = shell.speed(speed).given;
  $('speed-hint').textContent = effect
    ? `The colours move on every ${period / given} beats${given === speed ? '' : `, ${speedName(given)} with the master speed`}.`
    : 'The speed counts once an effect is chosen.';

  const palette = chosenPalette();
  for (const made of document.querySelectorAll('.palette-key')) {
    const on = made.dataset.palette === (palette?.id ?? '');
    made.classList.toggle('is-on', on);
    made.setAttribute('aria-pressed', String(on));
  }
  const cycles = palette?.mode === 'cycle' && palette.colours.length > 1;
  const pace = state.colour.speed;
  showPaceSpeed(pace);
  $('pace-own').classList.toggle('is-on', pace === null);
  $('pace-own').setAttribute('aria-pressed', String(pace === null));
  $('palette-speed').disabled = !cycles;
  if (cycles) {
    const own = pace ?? 1;
    $('pace-hint').textContent =
      `The palette takes a step every ${fixture.details.periodBeats / shell.speed(own).given} beats, all at once, and never fades step by step. A lamp glides to its next colour in ${Math.round(state.fade)} s.`;
  } else {
    $('pace-hint').textContent = palette
      ? 'This palette does not cycle, so a pace does nothing.'
      : 'No palette: the colours are the ones set on each lamp.';
  }
  $('palette-hint').textContent = !palette
    ? 'Choose a palette to colour every lamp. The palettes are made on the Palettes page.'
    : effect
      ? `${effect.name} gives the lamps the colours of ${palette.label}${palette.colours.length === 1 ? ', which has a single colour' : ''}.`
      : `Every lamp shows the first colour of ${palette.label}. Choose an effect to spread the others.`;
  dimmerRow.refresh();
  $('dimmer-hint').textContent =
    'All lights of the room together, on top of the grand master. A scene does not move it. Switches are left alone.';
  fadeRow.refresh();
  $('fade-hint').textContent =
    `A scene, a palette and a step of an effect take ${Math.round(state.fade)} seconds to come in. A change by hand takes one.`;
}

function notes() {
  const said = [];
  const effect = runningEffect();
  const litLights = lights().some((lamp) => (state.levels[lamp.id] ?? 0) > 0);
  if (effect && !litLights) {
    said.push({ text: `${effect.name} is chosen, but no lamp is on. Raise a lamp to see it.` });
  }
  if (effect && !shell.tempo.running) {
    said.push({ text: 'The music has stopped, so the colours stay where they are.' });
  }
  return said;
}

function render() {
  renderLamps();
  renderScenery();
  shell.refresh();
}

async function main() {
  shell = await start();
  if (!shell) return;
  fixture = shell.fixture;
  state = fixture.state;
  build();
  shell.notes(notes);
  shell.on('show', () => {
    buildPalettes();
    render();
  });
  shell.on('fixture', (message) => {
    // The shell has laid what is still on its way over the state, so nothing is set back.
    state = message.state;
    render();
  });
  shell.on('change', render);
  shell.on('status', render);
  render();
}

main();
