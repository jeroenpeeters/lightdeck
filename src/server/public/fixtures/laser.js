// The page of a laser. Plain browser JavaScript, no build step.
//
// Every channel of the laser is a byte divided into ranges. The profile that the
// server sends says which ranges there are, what they are called and what the place
// within a range sets. This file draws keys and faders from that, and turns what the
// operator does into bytes. It knows nothing about one laser in particular.
//
// Blackout is not the laser's: it is in the shell.

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
/** The last byte the operator had in a range, to come back to. */
const remembered = new Map();

// ---- ranges and bytes ----

const title = (control) => control.title ?? control.label;
const byteOf = (control) => state.raw[control.name] ?? control.idle;
const holds = (range, byte) => byte >= range.from && byte <= range.to;

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
  section.append(choice, idle, stepper);

  section.refresh = () => {
    const active = activeRanges(control);
    const range = currentRange(control);
    idle.hidden = active.length > 0;
    // One range leaves nothing to choose: the fader says it all.
    choice.hidden = active.length === 1;
    for (const each of keys) {
      each.key.hidden = !active.includes(each.range);
      each.key.setAttribute('aria-pressed', String(each.range === range));
    }

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
    down.disabled = number <= min;
    up.disabled = number >= max;
    input.min = String(min);
    input.max = String(max);
    input.value = String(number);
    value.textContent = String(number);
    fader.style.setProperty('--fill', `${((number - min) / (max - min)) * 100}%`);
    note.textContent = `${range.meaning}.`;
  };
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

function renderHint() {
  const open = gate
    ? gate.ranges.filter((range) => range.key && !holds(range, gate.idle)).map((r) => r.name)
    : [];
  let text = '';
  if (shell.blackout) {
    text =
      'Blackout is on, so the laser is closed. What you set here is kept and shows when you lift the blackout.';
  } else if (isOff() && open.length > 1) {
    text = `The laser is closed. Choose ${open.slice(0, -1).join(', ')} or ${open[open.length - 1]} to open it.`;
  }
  $('laser-hint').textContent = text;
  $('laser-hint').hidden = text === '';
}

function render() {
  for (const each of blocks) each.refresh();
  renderTile();
  renderHint();
  renderReadout($('readout'), dmx, fixture.controls);
  shell.refresh();
}

async function main() {
  shell = await start();
  if (!shell) return;
  fixture = shell.fixture;
  controls = fixture.controls.filter((control) => control.kind === 'function');
  gate = controls.find((control) => control.name === fixture.details.gate);
  state = fixture.state;
  dmx = fixture.dmx;

  blocks = controls.map(block);
  $('laser-blocks').append(...blocks);

  shell.on('fixture', (message) => {
    dmx = message.dmx;
    if (message.own) {
      renderReadout($('readout'), dmx, fixture.controls);
      return;
    }
    // What is still on its way to the server is newer than what the server tells.
    state = { ...message.state, raw: { ...message.state.raw, ...(shell.pending()?.raw ?? {}) } };
    render();
  });
  shell.on('change', render);
  render();
}

main();
