// The page of a laser. Plain browser JavaScript, no build step.
//
// Every channel of the laser is a byte divided into ranges. The profile that the
// server sends says which ranges there are, what they are called and what the place
// within a range sets. This file draws keys and faders from that, and turns what the
// operator does into bytes. It knows nothing about one laser in particular.
//
// The page is a setup page of the console (the top bar with the Live key is the shell's),
// with a red frame round the laser's own area, because red means laser. Three views, chosen
// in the side navigation and by the URL hash:
//   Effects   the mode (the control that opens and closes the laser), the control after it
//             (the pattern), the effect of the lights and the motion, each with its own speed
//   Colour    the colours of the colour chase and the colour channel
//   Channels  every other channel, a block of keys and a fader each
// The side panel always shows what the laser does (closed, or open and what it draws) and the
// bytes that are being sent.
//
// The server also says which effects there are and which channels each of them drives.
// They are of two kinds that are chosen apart and run together: an Effect of the lights
// (`details.effects`, state `effect`) and a Motion (`details.motionEffects`, state
// `motion`), each with its own Stop key and its own speed. While one shows, the server
// sends the bytes it renders, and the blocks of the channels that either of the two
// drives show those instead of what the operator set, and cannot be set.
//
// The laser has colours of its own, up to three, which its colour chase steps through
// (`state.colours`, bytes of the range `details.colourSetting` names). It does not follow
// the palettes of the show. The manual does not name the seven colours, so the keys of a
// slot are numbered 1 to 7, and the page spreads them over the range evenly, the way the
// server does.
//
// There is no arm key: a scene or a look may open the laser, an effect never does.
// Blackout, master and tempo are not the laser's: they are in the top bar. The laser has
// no dimmer, so the master at 0 holds it closed the way the blackout does, and the page
// says which of the two it is.

import { start } from '../shell.js';
import { $, button, element, renderReadout, slider, speedKeys, speedNote, views } from '../ui.js';

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

/** What a fader stands on, to the byte for it. */
const byteFor = (range, number) =>
  range.steps
    ? byteForStep(range, number)
    : range.from + Math.round(((range.to - range.from) * number) / 100);

/** The number a range's fader shows for the byte that is sent. */
function numberOf(control, range) {
  const byte = byteOf(control);
  return range.steps
    ? stepOfByte(range, byte)
    : Math.round(((byte - range.from) / (range.to - range.from)) * 100);
}

/**
 * The keys and the faders of one control, in a panel: a key per range that has a key, and for a
 * range that sets something by its place a fader (and keys of one step, when it has steps).
 */
function block(control, lead = false) {
  const section = element('section', lead ? 'panel lz-block is-lead' : 'panel lz-block');
  const head = element('div', 'sh');
  head.append(element('h3', '', title(control)));

  const choice = element('div', 'lz-keys');
  choice.setAttribute('role', 'group');
  choice.setAttribute('aria-label', title(control));
  const keys = control.ranges
    .filter((range) => range.key)
    .map((range) => {
      const made = button('key c lz-pick', range.name ?? range.key, () => {
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
  const driven = element('p', 'hint lz-driven');

  // One fader per range that sets something by its place; only the range that counts shows.
  const faders = element('div', 'lz-faders');
  const rows = new Map();
  control.ranges.forEach((range, index) => {
    if (!range.steps && !range.scale) return;
    const row = slider({
      id: `l-${control.name}-${range.key ?? index}`,
      label: range.scale ?? title(control),
      min: range.steps ? 1 : 0,
      max: range.steps ?? 100,
      read: () => numberOf(control, range),
      write: (number) => {
        if (currentRange(control) === range) setByte(control, byteFor(range, number));
      },
      meaning: () => `${range.meaning}.`,
    });
    row.classList.add('lz-away');
    rows.set(range, row);
    faders.append(row);
  });
  const nudge = (by) => () => {
    const range = currentRange(control);
    if (!range?.steps) return;
    const step = stepOfByte(range, byteOf(control)) + by;
    if (step >= 1 && step <= range.steps) setByte(control, byteForStep(range, step));
  };
  const down = button('key c lz-nudge', '−1', nudge(-1));
  const up = button('key c lz-nudge', '+1', nudge(1));
  const stepper = element('div', 'lz-set');
  stepper.append(down, faders, up);
  // Stays in its place when there is nothing to choose, so the other blocks do not jump.
  const idle = element('p', 'hint', 'Nothing to choose in this mode.');
  section.append(head, idle, choice, stepper, driven);
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
    choice.hidden = active.length <= 1;
    for (const each of keys) {
      const here = each.range === range;
      each.key.hidden = !active.includes(each.range);
      each.key.disabled = taken;
      each.key.classList.toggle('is-disabled', taken);
      // A range of rest (closed, fixed) is where you are, white; any other is what the laser does, amber.
      each.key.classList.toggle('is-on', here && !holds(each.range, control.idle));
      each.key.classList.toggle('is-here', here && holds(each.range, control.idle));
      each.key.setAttribute('aria-pressed', String(here));
    }

    const row = range ? rows.get(range) : undefined;
    stepper.hidden = !row;
    // The faders lie over each other in one cell, so the block keeps the room of the longest line.
    for (const [other, each] of rows) each.classList.toggle('lz-away', other !== range);
    if (!row) return;
    const steps = range.steps;
    stepper.dataset.steps = String(Boolean(steps));
    down.hidden = !steps;
    up.hidden = !steps;
    // Without keys above it the fader carries the name of the control.
    const label = choice.hidden ? title(control) : range.scale;
    row.querySelector('.fl').textContent = label;
    row.input.setAttribute('aria-label', label);
    const number = numberOf(control, range);
    down.setAttribute('aria-label', `${range.scale ?? title(control)} down by one`);
    up.setAttribute('aria-label', `${range.scale ?? title(control)} up by one`);
    down.disabled = taken || number <= 1;
    up.disabled = taken || number >= (steps ?? 100);
    down.classList.toggle('is-disabled', down.disabled);
    up.classList.toggle('is-disabled', up.disabled);
    row.refresh();
    row.input.disabled = taken;
    row.bar.classList.toggle('is-disabled', taken);
  };
  return section;
}

/** The titles of the channels an effect sets: "Pattern", "Horizontal position". */
const drivesWords = (effect) =>
  effect.drives
    .map((name) => controls.find((control) => control.name === name))
    .filter(Boolean)
    .map((control) => title(control))
    .join(', ');

/**
 * One kind of effect, in a panel: its keys, a Stop key, a line about the chosen one and the keys
 * of its speed. Without effects of this kind the panel stays away.
 */
function buildGroup(key, name, list) {
  const section = element('section', 'panel lz-group');
  section.hidden = list.length === 0;
  const keys = element('div', 'lz-effect-keys');
  keys.setAttribute('role', 'group');
  keys.setAttribute('aria-label', name === 'Motion' ? 'Choose a motion' : 'Choose an effect');
  // One column per key, three at the most: the Stop key has the row under them.
  keys.style.setProperty('--n', String(Math.min(Math.max(list.length, 1), 3)));
  const group = { key, name, list, section, keys: new Map() };
  for (const effect of list) {
    const made = button('key lz-effect', '', () => setEffect(group, effect.id));
    made.append(
      element('span', 'nm', effect.name),
      element('span', 'sub', `Sets ${drivesWords(effect)}`),
    );
    group.keys.set(effect.id, made);
    keys.append(made);
  }
  // The last key of the row: it puts the effect away and leaves the laser as the operator set it.
  group.stop = button('key c lz-stop', 'Stop', () => setEffect(group, null));
  group.stop.setAttribute('aria-label', `Stop ${name.toLowerCase()}`);
  keys.append(group.stop);
  group.hint = element('p', 'hint lz-effect-hint');
  const speedHead = element('div', 'sh');
  speedHead.append(element('h3', '', `Speed of ${name.toLowerCase()}`));
  const speed = element('div', 'lz-speed');
  group.speedHint = element('p', 'hint lz-speed-hint');
  const heading = element('div', 'sh');
  heading.append(element('h3', '', name));
  section.append(heading, keys, speedHead, speed, group.speedHint, group.hint);
  group.showSpeed = speedKeys(speed, fixture.details.speeds ?? [1], (each) =>
    setSpeed(group, each),
  );
  return group;
}

/**
 * The slots of the colour setting: per slot a row of None and the seven colours. The section
 * stays away when the laser has no colour setting.
 */
function buildColours(holder) {
  const panel = element('section', 'panel lz-slots');
  const head = element('div', 'sh');
  head.append(element('h3', '', 'Colours for the colour chase'));
  panel.append(
    head,
    element(
      'p',
      'hint',
      'The colour chase steps through these. With none set it goes through all seven. The manual does not name the colours, so they are numbered.',
    ),
  );
  const ordinals = ['First', 'Second', 'Third'];
  for (let at = 0; at < colourSetting.max; at++) {
    const row = element('div', 'lz-slot');
    row.setAttribute('role', 'group');
    const label = `${ordinals[at] ?? `Colour ${at + 1}`} colour`;
    row.setAttribute('aria-label', label);
    const top = element('div', 'sh');
    const note = element('span', 't2 lz-slot-note');
    top.append(element('h3', '', label), note);
    const none = button('key c lz-pick', 'None', () => setSlot(at, null));
    const grid = element('div', 'lz-slot-keys');
    grid.append(none);
    const keys = [];
    for (let number = 1; number <= COLOURS; number++) {
      const made = button('key c lz-pick lz-colour', String(number), () => setSlot(at, number));
      made.setAttribute('aria-label', `Colour ${number}`);
      grid.append(made);
      keys.push(made);
    }
    slots.push({ row, note, none, keys });
    row.append(top, grid);
    panel.append(row);
  }
  holder.append(panel);
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
  // Hazard stripes in full colour while the laser draws, dimmed while it is closed.
  $('laser-strip').classList.toggle('hazard', !closed);
  $('laser-strip').classList.toggle('hazard-dim', closed);
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

/** What the laser is waiting for, in one line, or the standing line that says who opens it. */
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
      'The master is at 0, so the laser is closed. What you set here is kept and shows when you raise the master.';
  } else if (waiting && !inEffectsMode()) {
    text = `${names(chosen)} is chosen and waits: effects show in ${effectsMode()} mode. Choose ${effectsMode()} to see it.`;
  } else if (waiting) {
    text = `${names(chosen)} is chosen and waits: the music has stopped.`;
  } else if (isOff() && open.length > 1) {
    text = `The laser is closed. Choose ${open.slice(0, -1).join(', ')} or ${open[open.length - 1]} to open it.`;
  }
  const note = $('laser-note');
  note.dataset.urgent = String(text !== '');
  $('laser-hint').textContent =
    text ||
    'An effect never opens the laser: that stays with you. Scenes, looks and sequences can open it. Blackout closes it.';
}

/** Names of effects in one line: "Pattern chase · Pulse". */
const names = (list) => list.map((effect) => effect.name).join(' · ');

function renderGroup(group) {
  const chosen = chosenIn(group);
  for (const [id, made] of group.keys) {
    made.classList.toggle('is-on', id === chosen?.id);
    made.setAttribute('aria-pressed', String(id === chosen?.id));
  }
  group.stop.disabled = !chosen;
  group.stop.classList.toggle('is-disabled', !chosen);
  group.hint.textContent = chosen
    ? chosen.description
    : `Choose ${group.key === 'motion' ? 'a motion' : 'an effect'}. It follows the music and shows in ${effectsMode()} mode. It never opens the laser: that stays with you.`;
  const speed = state[group.key]?.speed ?? 1;
  group.showSpeed(speed);
  group.speedHint.textContent = speedNote(speed, shell.speed(speed));
}

/** The tags in the head: whether the laser draws, and the effects that are chosen. */
function renderNow() {
  const chosen = chosenEffects();
  const showing = showingEffects();
  const held = heldBy();
  const closed = held !== null || isOff();
  const tags = $('now-tags');
  tags.textContent = '';
  const status = element(
    'span',
    closed ? 'tag mute' : 'tag danger',
    held === 'blackout'
      ? 'Closed by blackout'
      : held === 'master'
        ? 'Closed by master'
        : closed
          ? 'Closed'
          : 'Open',
  );
  tags.append(status);
  if (chosen.length === 0) {
    tags.append(element('span', 't3 lz-none', 'No effect'));
    return;
  }
  for (const effect of chosen) {
    const going = showing.includes(effect) && held === null;
    // Dashed while it waits for the mode or the music.
    tags.append(element('span', going ? 'tag on' : 'tag var', effect.name));
  }
}

/** The counts at the right of the keys of the side navigation. */
function renderNav() {
  const chosen = chosenEffects().length;
  $('n-effects').textContent = chosen > 0 ? String(chosen) : '';
  const set = state.colours?.length ?? 0;
  if ($('n-colour')) $('n-colour').textContent = set > 0 ? String(set) : '';
}

function renderEffects() {
  for (const group of groups) renderGroup(group);
  renderNow();
  renderNav();
}

function renderColours() {
  const list = state.colours ?? [];
  slots.forEach((slot, at) => {
    const byte = list[at];
    const number = byte === undefined ? 0 : colourNumber(byte);
    // A slot after an empty one has nothing to be after: the list is the filled slots in order.
    const open = at <= list.length;
    slot.none.classList.toggle('is-here', byte === undefined);
    slot.none.setAttribute('aria-pressed', String(byte === undefined));
    slot.keys.forEach((made, index) => {
      made.classList.toggle('is-on', index + 1 === number);
      made.classList.toggle('is-disabled', !open);
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
  if (colourSetting) renderColours();
  renderReadout($('readout'), dmx, fixture.controls);
  shell.refresh();
}

async function main() {
  shell = await start({ page: 'fixture' });
  if (!shell) return;
  fixture = shell.fixture;
  controls = fixture.controls.filter((control) => control.kind === 'function');
  gate = controls.find((control) => control.name === fixture.details.gate);
  colourSetting = fixture.details.colourSetting ?? null;
  effectsIn = fixture.details.effectsIn ?? null;
  state = fixture.state;
  dmx = fixture.dmx;

  // The mode and the control after it are the lead; the colour channel goes with the colours.
  const lead = [gate, controls[controls.indexOf(gate) + 1]].filter(Boolean);
  const colourControl = colourSetting
    ? controls.find((control) => control.name === colourSetting.control)
    : undefined;
  blocks = controls.map((control) => block(control, lead.includes(control)));
  const blockOf = (control) => blocks.find((each) => each.control === control);
  $('laser-lead').append(...lead.map(blockOf));
  const others = blocks.filter(
    (each) => !lead.includes(each.control) && each.control !== colourControl,
  );
  $('laser-blocks').append(...others);
  $('n-channels').textContent = String(controls.length);

  groups = [
    buildGroup('effect', 'Effect', fixture.details.effects ?? []),
    buildGroup('motion', 'Motion', fixture.details.motionEffects ?? []),
  ];
  $('laser-effects').append(...groups.map((group) => group.section));

  const names_ = ['effects'];
  if (colourSetting) {
    buildColours($('laser-colours'));
    if (colourControl) $('laser-colours').append(blockOf(colourControl));
    names_.push('colour');
  } else {
    $('tab-colour').remove();
    $('view-colour').remove();
  }
  names_.push('channels');
  if (others.length === 0) {
    $('tab-channels').remove();
    $('view-channels').remove();
    names_.pop();
  }
  views(names_);

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
