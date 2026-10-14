// The page of a laser. Plain browser JavaScript, no build step.
//
// Every channel of the laser is a byte divided into ranges. The profile that the
// server sends says which ranges there are, what they are called and what the place
// within a range sets. This file draws keys and faders from that, and turns what the
// operator does into bytes. It knows nothing about one laser in particular.
//
// The server also says which effects there are and which channels each of them drives.
// They are of two kinds that are chosen apart and run together: an Effect of the lights
// (`details.effects`, state `effect`) and a Motion (`details.motionEffects`, state
// `motion`), each with its own Stop key and its own speed. While one shows, the server
// sends the bytes it renders, and the blocks of the channels that either of the two
// drives show those instead of what the operator set.
//
// The laser has colours of its own, up to three, which its colour chase steps through
// (`state.colours`, bytes of the range `details.colourSetting` names). It does not follow
// the palettes of the show. The manual does not name the seven colours, so the keys of a
// slot are numbered 1 to 7, and the page spreads them over the range evenly, the way the
// server does.
//
// Blackout, master and tempo are not the laser's: they are in the shell. The laser has
// no dimmer, so the master at 0 holds it closed the way the blackout does, and the page
// says which of the two it is.

import { start } from '../shell.js';
import { $, button, element, renderReadout, speedKeys, speedNote } from '../ui.js';

let shell;
let fixture;
let controls = [];
/** The control that opens and closes the laser. */
let gate;
let state;
let dmx = [];
let blocks = [];
/** The two kinds of effect, each with its keys: see `buildGroup`. */
let groups = [];
/** The slots of the colour setting, each with its keys: see `buildColours`. */
const slots = [];
/** The colour setting as the server describes it, or null. */
let colourSetting = null;
/** Key of the range of the gate in which effects count. */
let effectsIn = null;
/** The last byte the operator had in a range, to come back to. */
const remembered = new Map();

// ---- ranges and bytes ----

const title = (control) => control.title ?? control.label;
const holds = (range, byte) => byte >= range.from && byte <= range.to;

/** The effect of a group that the operator chose, whether it shows or not. */
const chosenIn = (group) => group.list.find((effect) => effect.id === state[group.key]?.id);

/** True when the laser is in the mode in which effects count. */
function inEffectsMode() {
  if (!gate) return false;
  const byte = state.raw[gate.name] ?? gate.idle;
  return gate.ranges.find((range) => holds(range, byte))?.key === effectsIn;
}

/** The chosen effect of a group, when it counts: right mode, and the tempo runs. */
const showingIn = (group) => {
  const effect = chosenIn(group);
  return effect && inEffectsMode() && shell.tempo.running ? effect : undefined;
};

/** The effects that are chosen, in the order of the groups. */
const chosenEffects = () => groups.map(chosenIn).filter(Boolean);

/** The effects that show now. */
const showingEffects = () => groups.map(showingIn).filter(Boolean);

/** The effect that sets this control now, if there is one. */
const drivenBy = (control) =>
  showingEffects().find((effect) => effect.drives.includes(control.name));

/** True while an effect sets this control instead of the operator. */
const isDriven = (control) => drivenBy(control) !== undefined;

/** The byte of a control as it is being sent: the effect's when it drives the control. */
function byteOf(control) {
  const sent = dmx[control.channel - 1];
  if (sent !== undefined && isDriven(control)) return sent;
  return state.raw[control.name] ?? control.idle;
}

/** The ranges that count now: some depend on the range another control is in. */
function activeRanges(control) {
  return control.ranges.filter((range) => {
    if (!range.when) return true;
    const other = controls.find((c) => c.name === range.when.control);
    return other !== undefined && currentRange(other)?.key === range.when.key;
  });
}

function currentRange(control) {
  return activeRanges(control).find((range) => holds(range, byteOf(control)));
}

const stepWidth = (range) => Math.floor((range.to - range.from + 1) / range.steps);

function byteForStep(range, step) {
  const width = stepWidth(range);
  return Math.min(range.to, range.from + (step - 1) * width + Math.floor(width / 2));
}

function stepOfByte(range, byte) {
  const step = Math.floor((byte - range.from) / stepWidth(range)) + 1;
  return Math.min(range.steps, Math.max(1, step));
}

/** The byte to start a range with: where the operator left it, or its beginning. */
function byteToEnter(control, range) {
  const before = remembered.get(`${control.name}/${range.key}`);
  if (before !== undefined) return before;
  if (range.steps) return byteForStep(range, 1);
  if (range.scale) return range.from;
  if (holds(range, control.idle)) return control.idle;
  return Math.floor((range.from + range.to) / 2);
}

/**
 * Closed by the operator. The blackout and the master at 0 close the laser as well,
 * whatever this says.
 */
const isOff = () => !gate || holds(currentRange(gate) ?? {}, gate.idle);

/**
 * What of the console holds the laser closed, whatever is set here: 'blackout', 'master'
 * or nothing. The blackout comes first. The master counts as the server does: open only
 * when it is known to be above 0.
 */
function heldBy() {
  if (shell.blackout) return 'blackout';
  return shell.master > 0 ? null : 'master';
}

/** Chooses an effect of a group, or none with null. */
function setEffect(group, id) {
  state[group.key] = { ...state[group.key], id };
  shell.send({ [group.key]: { id } });
  render();
}

function setSpeed(group, speed) {
  state[group.key] = { ...state[group.key], speed };
  shell.send({ [group.key]: { speed } });
  render();
}

// ---- the colours of the colour chase ----

/** The colours the keys of a slot stand for. */
const COLOURS = 7;

/**
 * The byte of colour `number`, 1 to 7: the middle of its share of the range. The seven
 * share the range evenly, a share being a whole number of bytes (9 of the 64), which is
 * how the server counts the steps of a range.
 */
function colourByte(number) {
  const { from, to } = colourSetting;
  const width = Math.floor((to - from + 1) / COLOURS);
  return from + (number - 1) * width + Math.floor(width / 2);
}

/** Which of the seven a byte is, or 0 when it is none of them. */
const colourNumber = (byte) =>
  Array.from({ length: COLOURS }, (_, at) => at + 1).find((n) => colourByte(n) === byte) ?? 0;

/** Sets a slot to colour `number`, or empties it with null. The slots after an empty one are empty too. */
function setSlot(at, number) {
  const kept = state.colours.slice(0, at);
  const next =
    number === null ? kept : [...kept, colourByte(number), ...state.colours.slice(at + 1)];
  state.colours = next;
  shell.send({ colours: next });
  render();
}

function setByte(control, byte) {
  const range = activeRanges(control).find((r) => r.key && holds(r, byte));
  if (range) remembered.set(`${control.name}/${range.key}`, byte);
  state.raw[control.name] = byte;
  shell.send({ raw: { [control.name]: byte } });
  render();
}

// ---- building the page ----

/** The keys and the fader of one control. */
function block(control) {
  const section = element('section', 'laser-block');
  const id = `l-${control.name}`;

  const choice = element('fieldset', 'choice');
  choice.append(element('legend', '', title(control)));
  const keys = control.ranges
    .filter((range) => range.key)
    .map((range) => {
      const made = button('pick', range.name ?? range.key, () => {
        if (currentRange(control) !== range) setByte(control, byteToEnter(control, range));
      });
      choice.append(made);
      return { range, key: made };
    });

  // A channel that an effect can drive keeps room for the line that says so, so that the
  // blocks below do not move when an effect is chosen or stopped.
  const reserved = [
    ...(fixture.details.effects ?? []),
    ...(fixture.details.motionEffects ?? []),
  ].some((effect) => effect.drives.includes(control.name));
  const driven = element('p', reserved ? 'hint reserved' : 'hint');
  const stepper = element('div', 'stepper');
  const fader = element('div', 'slider');
  const name = element('label');
  name.htmlFor = id;
  const value = element('output');
  value.htmlFor = id;
  const input = element('input');
  input.type = 'range';
  input.id = id;
  input.step = '1';
  const note = element('p', 'meaning');
  fader.append(name, value, input, note);

  /** What the fader stands on, to the byte for it. */
  const byteFor = (range, number) =>
    range.steps
      ? byteForStep(range, number)
      : range.from + Math.round(((range.to - range.from) * number) / 100);
  input.addEventListener('input', () => {
    const range = currentRange(control);
    if (range) setByte(control, byteFor(range, Number(input.value)));
  });
  const nudge = (by) => () => {
    const range = currentRange(control);
    if (!range?.steps) return;
    const step = stepOfByte(range, byteOf(control)) + by;
    if (step >= 1 && step <= range.steps) setByte(control, byteForStep(range, step));
  };
  const down = button('key nudge', '−1', nudge(-1));
  const up = button('key nudge', '+1', nudge(1));
  stepper.append(down, fader, up);
  // Stays in its place when there is nothing to choose, so the other blocks do not jump.
  const idle = element('p', 'hint', 'Nothing to choose in this mode.');
  section.append(choice, idle, stepper, driven);
  section.control = control;

  section.refresh = () => {
    const active = activeRanges(control);
    const range = currentRange(control);
    // An effect has this control: it shows what is sent and cannot be set.
    const taken = isDriven(control);
    section.dataset.driven = String(taken);
    driven.hidden = !taken && !reserved;
    driven.style.visibility = taken ? '' : 'hidden';
    driven.textContent = taken
      ? `${drivenBy(control).name} sets this now. What you set comes back when you stop it.`
      : '';
    idle.hidden = active.length > 0;
    // One range leaves nothing to choose: the fader says it all.
    choice.hidden = active.length === 1;
    for (const each of keys) {
      each.key.hidden = !active.includes(each.range);
      each.key.disabled = taken;
      each.key.setAttribute('aria-pressed', String(each.range === range));
    }
    input.disabled = taken;

    const steps = range?.steps;
    const sets = range && (steps || range.scale);
    stepper.hidden = !sets;
    stepper.dataset.steps = String(Boolean(steps));
    down.hidden = !steps;
    up.hidden = !steps;
    if (!sets) return;

    const byte = byteOf(control);
    const min = steps ? 1 : 0;
    const max = steps ?? 100;
    const number = steps
      ? stepOfByte(range, byte)
      : Math.round(((byte - range.from) / (range.to - range.from)) * 100);
    // Without keys above it the fader carries the name of the control.
    name.textContent = choice.hidden ? title(control) : range.scale;
    down.setAttribute('aria-label', `${range.scale ?? title(control)} down by one`);
    up.setAttribute('aria-label', `${range.scale ?? title(control)} up by one`);
    down.disabled = taken || number <= min;
    up.disabled = taken || number >= max;
    input.min = String(min);
    input.max = String(max);
    input.value = String(number);
    value.textContent = String(number);
    fader.style.setProperty('--fill', `${((number - min) / (max - min)) * 100}%`);
    note.textContent = `${range.meaning}.`;
  };
  return section;
}

/**
 * One kind of effect: its keys, a Stop key, a line about the chosen one and the keys of
 * its speed. Without effects of this kind the section stays away.
 */
function buildGroup(key, name, list) {
  const section = element('section', 'laser-effects');
  section.hidden = list.length === 0;
  const keys = element('fieldset', 'effect-list');
  keys.append(
    element('legend', 'visually-hidden', `Choose ${name === 'Motion' ? 'a motion' : 'an effect'}`),
  );
  const group = { key, name, list, section, keys: new Map() };
  for (const effect of list) {
    const made = button('effect', effect.name, () => setEffect(group, effect.id));
    group.keys.set(effect.id, made);
    keys.append(made);
  }
  group.stop = button('key stop', `Stop ${name.toLowerCase()}`, () => setEffect(group, null));
  group.hint = element('p', 'hint effect-hint');
  const speed = element('fieldset', 'choice');
  speed.append(element('legend', '', `Speed of ${name.toLowerCase()}`));
  group.speedHint = element('p', 'hint');
  section.append(element('h3', '', name), keys, group.stop, group.hint, speed, group.speedHint);
  group.showSpeed = speedKeys(speed, fixture.details.speeds ?? [1], (each) =>
    setSpeed(group, each),
  );
  return group;
}

/**
 * The slots of the colour setting: per slot a row of the seven colours and None. The
 * section stays away when the laser has no colour setting.
 */
function buildColours() {
  const section = element('section', 'laser-colours');
  section.hidden = colourSetting === null;
  if (!colourSetting) return section;
  section.append(
    element('h3', '', 'Colours for the colour chase'),
    element(
      'p',
      'hint',
      'The colour chase steps through these. With none set it goes through all seven. The manual does not name the colours, so they are numbered.',
    ),
  );
  const ordinals = ['First', 'Second', 'Third'];
  for (let at = 0; at < colourSetting.max; at++) {
    const row = element('fieldset', 'slot');
    const note = element('span', 'slot-note');
    const legend = element('legend', '', `${ordinals[at] ?? `Colour ${at + 1}`} colour`);
    legend.append(note);
    const none = button('pick none', 'None', () => setSlot(at, null));
    const grid = element('div', 'slot-keys');
    row.append(legend, grid);
    grid.append(none);
    const keys = [];
    for (let number = 1; number <= COLOURS; number++) {
      const made = button('pick', String(number), () => setSlot(at, number));
      made.setAttribute('aria-label', `Colour ${number}`);
      grid.append(made);
      keys.push(made);
    }
    slots.push({ row, note, none, keys });
    section.append(row);
  }
  return section;
}

// ---- drawing the state ----

/** What a control is set to, in a few words: "Pattern 12", "Program 2". */
function words(control) {
  const range = currentRange(control);
  if (!range) return '';
  if (range.steps) return `${range.scale ?? title(control)} ${stepOfByte(range, byteOf(control))}`;
  return range.name ?? range.meaning;
}

function renderTile() {
  const held = heldBy();
  const closed = held !== null || isOff();
  $('laser-tile').dataset.on = String(!closed);
  $('laser-state').textContent =
    held === 'blackout'
      ? 'Closed by blackout'
      : held === 'master'
        ? 'Closed by the master'
        : closed
          ? 'Closed'
          : words(gate);
  // What comes right after the gate says most: the pattern or the program.
  const next = controls[controls.indexOf(gate) + 1];
  $('laser-detail').textContent = closed || !next ? 'Nothing is drawn' : words(next);
}

/** The name of the mode in which effects count: "Manual". */
function effectsMode() {
  const range = gate?.ranges.find((each) => each.key === effectsIn);
  return range?.name ?? range?.key ?? '';
}

function renderHint() {
  const open = gate
    ? gate.ranges.filter((range) => range.key && !holds(range, gate.idle)).map((r) => r.name)
    : [];
  const chosen = chosenEffects();
  const waiting = chosen.length > 0 && showingEffects().length === 0;
  const held = heldBy();
  let text = '';
  if (held === 'blackout') {
    text =
      'Blackout is on, so the laser is closed. What you set here is kept and shows when you lift the blackout.';
  } else if (held === 'master') {
    text =
      'The master is at 0, so the laser is closed. What you set here is kept and shows when you raise the master on the deck.';
  } else if (waiting && !inEffectsMode()) {
    text = `${names(chosen)} is chosen and waits: effects show in ${effectsMode()} mode. Choose ${effectsMode()} to see it.`;
  } else if (waiting) {
    text = `${names(chosen)} is chosen and waits: the music has stopped.`;
  } else if (isOff() && open.length > 1) {
    text = `The laser is closed. Choose ${open.slice(0, -1).join(', ')} or ${open[open.length - 1]} to open it.`;
  }
  $('laser-hint').textContent = text;
  $('laser-hint').hidden = text === '';
}

/** Names of effects in one line: "Pattern chase · Pulse". */
const names = (list) => list.map((effect) => effect.name).join(' · ');

function renderGroup(group) {
  const chosen = chosenIn(group);
  for (const [id, made] of group.keys) made.setAttribute('aria-pressed', String(id === chosen?.id));
  group.stop.disabled = !chosen;
  group.hint.textContent = chosen
    ? chosen.description
    : `Choose ${group.key === 'motion' ? 'a motion' : 'an effect'}. It follows the music and shows in ${effectsMode()} mode. It never opens the laser: that stays with you.`;
  const speed = state[group.key]?.speed ?? 1;
  group.showSpeed(speed);
  group.speedHint.textContent = speedNote(speed, shell.speed(speed));
}

function renderEffects() {
  for (const group of groups) renderGroup(group);
  const chosen = chosenEffects();
  const showing = showingEffects();
  $('running').dataset.on = String(showing.length > 0 && heldBy() === null);
  $('running').textContent =
    chosen.length === 0
      ? 'No effect'
      : showing.length === 0
        ? `${names(chosen)}, waiting`
        : names(chosen);
}

function renderColours() {
  const list = state.colours ?? [];
  slots.forEach((slot, at) => {
    const byte = list[at];
    const number = byte === undefined ? 0 : colourNumber(byte);
    // A slot after an empty one has nothing to be after: the list is the filled slots in order.
    const open = at <= list.length;
    slot.none.setAttribute('aria-pressed', String(byte === undefined));
    slot.keys.forEach((made, index) => {
      made.setAttribute('aria-pressed', String(index + 1 === number));
      made.disabled = !open;
    });
    slot.note.textContent = byte !== undefined && number === 0 ? `Other (byte ${byte})` : '';
  });
}

/** What changes while an effect runs. The rest of the page stays as it is. */
function renderFrame() {
  for (const each of blocks) if (isDriven(each.control)) each.refresh();
  renderTile();
  renderReadout($('readout'), dmx, fixture.controls);
}

function render() {
  for (const each of blocks) each.refresh();
  renderTile();
  renderHint();
  renderEffects();
  renderColours();
  renderReadout($('readout'), dmx, fixture.controls);
  shell.refresh();
}

async function main() {
  shell = await start();
  if (!shell) return;
  fixture = shell.fixture;
  controls = fixture.controls.filter((control) => control.kind === 'function');
  gate = controls.find((control) => control.name === fixture.details.gate);
  colourSetting = fixture.details.colourSetting ?? null;
  effectsIn = fixture.details.effectsIn ?? null;
  state = fixture.state;
  dmx = fixture.dmx;

  blocks = controls.map(block);
  // The keys that open the laser stand apart, next to the effects.
  $('laser-gate').append(...blocks.filter((each) => each.control === gate));
  $('laser-blocks').append(...blocks.filter((each) => each.control !== gate));
  groups = [
    buildGroup('effect', 'Effect', fixture.details.effects ?? []),
    buildGroup('motion', 'Motion', fixture.details.motionEffects ?? []),
  ];
  // The keys that open the laser, the two kinds of effect and the colours share one grid.
  $('laser-lead').append(...groups.map((group) => group.section), buildColours());

  shell.on('fixture', (message) => {
    // The shell has laid what is still on its way over the state, so nothing is set back.
    state = message.state;
    dmx = message.dmx;
    render();
  });
  shell.on('frame', (message) => {
    dmx = message.dmx;
    renderFrame();
  });
  shell.on('change', render);
  render();
}

main();
