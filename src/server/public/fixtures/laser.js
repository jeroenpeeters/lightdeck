// The page of a laser. Plain browser JavaScript, no build step.
//
// Every channel of the laser is a byte divided into ranges. The profile that the
// server sends says which ranges there are, what they are called and what the place
// within a range sets. This file draws keys and faders from that, and turns what the
// operator does into bytes. It knows nothing about one laser in particular.
//
// The server also says which effects there are and which channels each of them drives.
// While an effect shows, the server sends the bytes it renders, and the blocks of the
// driven channels show those instead of what the operator set.
//
// Blackout and tempo are not the laser's: they are in the shell.

import { start } from '../shell.js';
import { $, button, element, renderReadout } from '../ui.js';

let shell;
let fixture;
let controls = [];
/** The control that opens and closes the laser. */
let gate;
let state;
let dmx = [];
let blocks = [];
let effects = [];
/** Key of the range of the gate in which effects count. */
let effectsIn = null;
/** The last byte the operator had in a range, to come back to. */
const remembered = new Map();

// ---- ranges and bytes ----

const title = (control) => control.title ?? control.label;
const holds = (range, byte) => byte >= range.from && byte <= range.to;

/** The effect the operator chose, whether it shows or not. */
const chosenEffect = () => effects.find((effect) => effect.id === state.effect?.id);

/** The chosen effect, when the laser is in the mode in which effects count. */
function showingEffect() {
  const effect = chosenEffect();
  if (!effect || !gate) return undefined;
  const byte = state.raw[gate.name] ?? gate.idle;
  const mode = gate.ranges.find((range) => holds(range, byte));
  return mode?.key === effectsIn ? effect : undefined;
}

/** True while an effect sets this control instead of the operator. */
const isDriven = (control) => Boolean(showingEffect()?.drives.includes(control.name));

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

/** Closed by the operator. A blackout closes the laser as well, whatever this says. */
const isOff = () => !gate || holds(currentRange(gate) ?? {}, gate.idle);

function setEffect(id) {
  state.effect = { ...state.effect, id };
  shell.send({ effect: { id } });
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

  const driven = element('p', 'hint');
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
    driven.hidden = !taken;
    if (taken) {
      driven.textContent = `${showingEffect().name} sets this now. What you set comes back when you stop the effect.`;
    }
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

/** The keys of the effects. Without effects the section stays away. */
function buildEffects() {
  $('laser-effects').hidden = effects.length === 0;
  for (const effect of effects) {
    const made = button('effect', effect.name, () => setEffect(effect.id));
    made.dataset.effect = effect.id;
    $('effect-list').append(made);
  }
  $('effect-stop').addEventListener('click', () => setEffect(null));
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
  const closed = shell.blackout || isOff();
  $('laser-tile').dataset.on = String(!closed);
  $('laser-state').textContent = shell.blackout
    ? 'Closed by blackout'
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
  const waiting = chosenEffect() && !showingEffect() ? chosenEffect() : undefined;
  let text = '';
  if (shell.blackout) {
    text =
      'Blackout is on, so the laser is closed. What you set here is kept and shows when you lift the blackout.';
  } else if (waiting) {
    text = `${waiting.name} is chosen and waits: effects show in ${effectsMode()} mode. Choose ${effectsMode()} to see it.`;
  } else if (isOff() && open.length > 1) {
    text = `The laser is closed. Choose ${open.slice(0, -1).join(', ')} or ${open[open.length - 1]} to open it.`;
  }
  $('laser-hint').textContent = text;
  $('laser-hint').hidden = text === '';
}

function renderEffects() {
  const chosen = chosenEffect();
  const showing = showingEffect();
  for (const made of document.querySelectorAll('.effect')) {
    made.setAttribute('aria-pressed', String(made.dataset.effect === chosen?.id));
  }
  $('effect-stop').disabled = !chosen;
  $('running').dataset.on = String(Boolean(showing) && !shell.blackout);
  $('running').textContent = chosen
    ? showing
      ? chosen.name
      : `${chosen.name}, waiting`
    : 'No effect';
  $('effect-hint').textContent = chosen
    ? chosen.description
    : `Choose an effect. It moves in time with the music and shows in ${effectsMode()} mode. It never opens the laser: that stays with you.`;
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
  renderReadout($('readout'), dmx, fixture.controls);
  shell.refresh();
}

async function main() {
  shell = await start();
  if (!shell) return;
  fixture = shell.fixture;
  controls = fixture.controls.filter((control) => control.kind === 'function');
  gate = controls.find((control) => control.name === fixture.details.gate);
  effects = fixture.details.effects ?? [];
  effectsIn = fixture.details.effectsIn ?? null;
  state = fixture.state;
  dmx = fixture.dmx;

  blocks = controls.map(block);
  // The keys that open the laser stand apart, next to the effects.
  $('laser-gate').append(...blocks.filter((each) => each.control === gate));
  $('laser-blocks').append(...blocks.filter((each) => each.control !== gate));
  buildEffects();

  shell.on('fixture', (message) => {
    dmx = message.dmx;
    if (message.own) {
      renderFrame();
      return;
    }
    // What is still on its way to the server is newer than what the server tells.
    const pending = shell.pending();
    state = {
      ...message.state,
      raw: { ...message.state.raw, ...(pending?.raw ?? {}) },
      effect: { ...message.state.effect, ...(pending?.effect ?? {}) },
    };
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
