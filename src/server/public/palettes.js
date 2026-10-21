// The palettes page: the colours of the show, apart from the effects. Plain browser
// JavaScript, no build step.
//
// A palette is a list of one to eight entries, slot 1 first. An entry is a colour (red,
// green and blue, and a white level for the white LED of the spider) or off. A light effect
// says how much of slot 1, 2 and 3 each lens gets, and the palette says what those are. A
// palette is static, or it cycles: the list shifts by one slot per step, as a hard cut or
// as a fade, at one of the speeds ÷4 to ×4 (×1 is one step per beat, ÷4 one per bar).
// Palettes belong to the whole show. A group gets one set on the deck.
//
// The page draws what the server says: `shell.show.palettes`. A press is asked once with
// `shell.ask`, and a colour or a level is sent when it is let go, not on every pixel of a
// drag. What the operator is editing is kept in the page and drawn from there, so that
// nothing jumps back: after a change of its own a palette ignores what the event stream
// says for a moment (the answer and the events come over different connections, so an older
// event can still be on its way) and is then drawn from the show as it is by then. A palette
// whose input has the focus, or is being dragged, keeps that input as it is while the rest
// is brought up to date, and no panel is ever rebuilt over an input.
//
// Its notice is kept at the bottom of the screen, with the one of the shell, so that no
// key moves when it comes or goes.

import { start } from './shell.js';
import { $, button, element, sentence, slider, speedKeys } from './ui.js';

/** How long a delete key waits for the second press. */
const SURE_MS = 3000;
/** How long a palette ignores the event stream after a change of its own. */
const SETTLE_MS = 1500;
const MAX_COLOURS = 8;
const NAME_LENGTH = 40;
const ROLES = ['Main', 'Second', 'Third'];
/** A colour that is added. */
const FRESH = { off: false, rgb: '#ff0000', ww: 0 };
/** What an entry that was off from the start gets when it is switched on: the white LED. */
const WHITE = { rgb: '#000000', ww: 255 };
const MODES = [
  { id: 'static', name: 'Static' },
  { id: 'cycle', name: 'Cycle' },
];
const CHANGES = [
  { id: 'step', name: 'Hard step' },
  { id: 'fade', name: 'Fade' },
];

const page = {
  where: $('where'),
  palettes: $('palettes'),
  make: $('make-palette'),
  name: $('palette-name'),
  notices: $('notices'),
  notice: $('palettes-notice'),
};

let shell;
/** What the server answered to what could not be done. */
let failure = '';
/** True when the last press did not reach lightdeck. It is not sent again. */
let lost = false;
/** By the id of a palette, the panel that was built for it. */
const cards = new Map();
/** The palettes whose editor is open. */
const opened = new Set();
/** The palette a delete key was pressed for once. */
let sure = null;
let sureTimer;

const count = (number, word) => (number === 1 ? `1 ${word}` : `${number} ${word}s`);

// ---- entries ----

const hex = (byte) => byte.toString(16).padStart(2, '0');

/** '#rrggbb', '#rrggbbww' or 'off' as an entry. A colour that is off keeps no colour. */
function parseEntry(text) {
  if (text === 'off') return { off: true, rgb: WHITE.rgb, ww: WHITE.ww };
  const found = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(text);
  if (!found) return { off: true, rgb: WHITE.rgb, ww: WHITE.ww };
  return {
    off: false,
    rgb: `#${found[1].toLowerCase()}`,
    ww: found[2] ? Number.parseInt(found[2], 16) : 0,
  };
}

/** An entry as the server takes it. */
function formatEntry({ off, rgb, ww }) {
  if (off) return 'off';
  return ww > 0 ? `${rgb}${hex(ww)}` : rgb;
}

/** The colour a lens would show, red, green and blue with the white LED mixed in. */
function mix({ rgb, ww }) {
  const level = ww / 255;
  const part = (from, white) =>
    Math.min(255, Math.round(Number.parseInt(rgb.slice(from, from + 2), 16) + white * level * 255));
  return `rgb(${part(1, 1)} ${part(3, 0.94)} ${part(5, 0.82)})`;
}

const whitePercent = (ww) => Math.round((ww / 255) * 100);

/** What a palette that steps at this speed does, in words. */
function paceOf(speed) {
  if (speed === 0.25) return 'one step per bar';
  if (speed === 0.5) return 'one step per 2 beats';
  if (speed === 1) return 'one step per beat';
  return speed === 2 ? 'two steps per beat' : 'four steps per beat';
}

// ---- talking to the server ----

async function ask(url, body) {
  failure = '';
  const answer = await shell.ask(url, body);
  lost = Boolean(answer.lost);
  failure = answer.ok || lost ? '' : sentence(answer.error);
  renderNotice();
  return answer;
}

const paletteOf = (id) => shell.show.palettes.find((each) => each.id === id);
const held = (card) => card.busy > 0 || Date.now() < card.until;

/** Sends a change of a palette. The panel keeps what was changed until the show has it. */
async function send(card, fields) {
  card.busy += 1;
  const answer = await ask(`/api/palettes/${card.id}/update`, fields);
  card.busy -= 1;
  clearTimeout(card.settle);
  if (answer.ok) {
    card.until = Date.now() + SETTLE_MS;
    card.settle = setTimeout(() => sync(card), SETTLE_MS);
  } else {
    // Refused, or not heard: the show is what is true.
    card.until = 0;
    sync(card);
  }
}

const sendColours = (card) => send(card, { colours: card.entries.map(formatEntry) });

async function make(event) {
  event.preventDefault();
  const answer = await ask('/api/palettes', { label: page.name.value });
  if (!answer.ok) return;
  if (answer.id) opened.add(answer.id);
  page.name.value = '';
  page.name.blur();
  render();
}

function unsure() {
  clearTimeout(sureTimer);
  sure = null;
}

/** The first press asks, the second one within a few seconds deletes. */
async function remove(card) {
  if (sure !== card.id) {
    unsure();
    sure = card.id;
    sureTimer = setTimeout(() => {
      unsure();
      render();
    }, SURE_MS);
    render();
    return;
  }
  unsure();
  await ask(`/api/palettes/${card.id}/delete`);
  render();
}

// ---- building ----

/** One row of the colours of a palette: the slot, the colour, the white level and the keys. */
function buildEntry(card, index) {
  const row = { index };
  row.section = element('div', 'entry');
  row.section.setAttribute('role', 'group');

  const slot = element('div', 'slot');
  row.number = element('span', 'slot-number', String(index + 1));
  row.role = element('span', 'slot-role');
  slot.append(row.number, row.role);

  const colour = element('div', 'colour');
  const name = element('label', '', 'Colour');
  row.picker = element('input', 'picker');
  row.picker.type = 'color';
  row.picker.id = `pal.${card.id}.${index}.colour`;
  name.htmlFor = row.picker.id;
  colour.append(name, row.picker);

  row.white = slider({
    id: `pal.${card.id}.${index}.white`,
    label: 'White',
    tone: 'white',
    read: () => whitePercent(card.entries[index]?.ww ?? 0),
    write: (number) => {
      const entry = card.entries[index];
      if (!entry) return;
      entry.ww = Math.round((number / 100) * 255);
      row.editing = true;
      drawStrip(card);
    },
  });
  row.whiteInput = row.white.querySelector('input');

  row.picker.addEventListener('input', () => {
    const entry = card.entries[index];
    if (!entry) return;
    entry.rgb = row.picker.value;
    row.editing = true;
    drawStrip(card);
  });
  // A colour and a level are sent when they are let go, not on every pixel of a drag.
  const done = () => {
    row.editing = false;
    sendColours(card);
  };
  row.picker.addEventListener('change', done);
  row.whiteInput.addEventListener('change', done);
  for (const input of [row.picker, row.whiteInput]) {
    input.addEventListener('blur', () => {
      row.editing = false;
    });
  }

  const keys = element('div', 'entry-keys');
  row.off = button('pick', 'Off', () => {
    const entry = card.entries[index];
    if (!entry) return;
    entry.off = !entry.off;
    draw(card);
    sendColours(card);
  });
  row.up = button('key', 'Up', () => move(card, index, -1));
  row.down = button('key', 'Down', () => move(card, index, 1));
  row.remove = button('key', 'Remove', () => {
    if (card.entries.length < 2) return;
    card.entries.splice(index, 1);
    draw(card);
    sendColours(card);
  });
  keys.append(row.off, row.up, row.down, row.remove);

  row.section.append(slot, colour, row.white, keys);
  return row;
}

function move(card, index, step) {
  const other = index + step;
  if (other < 0 || other >= card.entries.length) return;
  [card.entries[index], card.entries[other]] = [card.entries[other], card.entries[index]];
  draw(card);
  sendColours(card);
}

/** A field for a name with its key. `done` gets the name and says whether it was taken. */
function nameRow({ id, label, key, done }) {
  const form = element('form', 'name-row');
  const name = element('label', '', label);
  name.htmlFor = id;
  const field = element('input', 'field');
  field.id = id;
  field.type = 'text';
  field.maxLength = NAME_LENGTH;
  field.autocomplete = 'off';
  const submit = element('button', 'key', key);
  submit.type = 'submit';
  form.append(name, field, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!(await done(field.value))) return;
    field.blur();
  });
  return { form, field, submit };
}

/** A fieldset of keys that choose one of several. */
function choice(title, keys, choose) {
  const fieldset = element('fieldset', 'choice');
  fieldset.append(element('legend', '', title));
  const made = keys.map(({ id, name }) => {
    const key = button('pick', name, () => choose(id));
    fieldset.append(key);
    return { id, key };
  });
  return {
    fieldset,
    show: (chosen) => {
      for (const { id, key } of made) key.setAttribute('aria-pressed', String(id === chosen));
    },
  };
}

/** Chooses how many of the first colours show. All is `undefined`, and is sent as null. */
function chooseShown(card, count) {
  card.visible = count;
  draw(card);
  send(card, { visible: count ?? null });
}

function buildCard(id) {
  const card = {
    id,
    label: '',
    entries: [],
    mode: 'static',
    change: 'step',
    speed: 0.25,
    visible: undefined,
    rows: [],
    busy: 0,
    until: 0,
    settle: 0,
  };

  card.section = element('section', 'panel palette');
  card.title = element('h2', 'palette-name');
  card.title.id = `pal.${id}.title`;
  card.section.setAttribute('aria-labelledby', card.title.id);
  card.mark = element('p', 'palette-mark');
  card.edit = button('pick edit', 'Edit', () => {
    if (opened.has(id)) opened.delete(id);
    else opened.add(id);
    draw(card);
  });
  card.edit.setAttribute('aria-controls', `pal.${id}.editor`);
  const head = element('div', 'palette-head');
  head.append(card.title, card.mark, card.edit);

  card.strip = element('div', 'strip');
  card.strip.setAttribute('role', 'img');
  card.uses = element('p', 'uses');

  // The editor.
  card.editor = element('div', 'editor');
  card.editor.id = `pal.${id}.editor`;

  const colours = element('fieldset', 'colours');
  colours.append(element('legend', '', 'Colours, slot 1 first'));
  card.list = element('div', 'entry-list');
  card.add = button('key', 'Add colour', () => {
    if (card.entries.length >= MAX_COLOURS) return;
    card.entries.push({ ...FRESH });
    draw(card);
    sendColours(card);
  });
  card.room = element('p', 'hint room');
  const addRow = element('div', 'add-row');
  addRow.append(card.add, card.room);
  colours.append(card.list, addRow);

  const settings = element('div', 'settings');
  const mode = choice('Mode', MODES, (chosen) => {
    card.mode = chosen;
    draw(card);
    send(card, { mode: chosen });
  });
  const change = choice('Change', CHANGES, (chosen) => {
    card.change = chosen;
    draw(card);
    send(card, { change: chosen });
  });
  const speed = element('fieldset', 'choice');
  speed.append(element('legend', '', 'Speed'));
  const showSpeed = speedKeys(speed, shell.rates, (chosen) => {
    card.speed = chosen;
    draw(card);
    send(card, { speed: chosen });
  });
  // How many of the first colours show; the others are the pool that a cycle draws from.
  const shown = element('fieldset', 'choice shown');
  shown.append(element('legend', '', 'Colours shown'));
  card.shownKeys = [
    { n: undefined, key: button('pick', 'All', () => chooseShown(card, undefined)) },
  ];
  for (let n = 1; n < MAX_COLOURS; n++) {
    card.shownKeys.push({ n, key: button('pick', String(n), () => chooseShown(card, n)) });
  }
  shown.append(...card.shownKeys.map(({ key }) => key));
  card.shownSet = shown;
  card.showMode = mode.show;
  card.showChange = change.show;
  card.showSpeed = showSpeed;
  card.changeSet = change.fieldset;
  card.speedSet = speed;
  card.pace = element('p', 'hint pace');
  settings.append(mode.fieldset, change.fieldset, speed, card.pace, shown);

  card.rename = nameRow({
    id: `pal.${id}.name`,
    label: 'Name',
    key: 'Rename',
    done: async (label) => {
      const answer = await ask(`/api/palettes/${id}/update`, { label });
      if (answer.ok) {
        card.label = label;
        draw(card);
      }
      return answer.ok;
    },
  });
  card.remove = button('key delete', '', () => remove(card));

  card.editor.append(colours, settings, card.rename.form, card.remove);
  card.section.append(head, card.strip, card.uses, card.editor);
  return card;
}

// ---- drawing ----

/** Takes what the show says into the panel, except in the inputs that are being edited. */
function adopt(card, palette) {
  card.label = palette.label;
  card.mode = palette.mode;
  card.change = palette.change;
  card.speed = palette.speed;
  card.visible = palette.visible;
  // An entry that is off keeps the colour it had, so that Off pressed again brings it back.
  card.entries = palette.colours.map((text, index) => {
    const entry = parseEntry(text);
    const before = card.entries[index];
    if (entry.off && before) return { off: true, rgb: before.rgb, ww: before.ww };
    return entry;
  });
}

function sync(card) {
  const palette = paletteOf(card.id);
  if (!palette || held(card)) return;
  adopt(card, palette);
  draw(card);
}

/** The big strip of the colours. An entry that is off is a dark chip that says so. */
function drawStrip(card) {
  const { strip } = card;
  while (strip.children.length > card.entries.length) strip.lastElementChild.remove();
  while (strip.children.length < card.entries.length) {
    const chip = element('div', 'chip');
    chip.append(element('span', 'chip-colour'), element('span', 'chip-slot'));
    strip.append(chip);
  }
  card.entries.forEach((entry, index) => {
    const chip = strip.children[index];
    chip.dataset.off = String(entry.off);
    // The colours after the ones that show are the pool a cycle draws from.
    chip.dataset.pool = String(index >= (card.visible ?? card.entries.length));
    chip.firstElementChild.style.background = entry.off ? '' : mix(entry);
    chip.firstElementChild.textContent = entry.off ? 'OFF' : '';
    chip.lastElementChild.textContent = String(index + 1);
  });
  card.strip.setAttribute(
    'aria-label',
    card.entries
      .map((entry, index) => `${index + 1} ${entry.off ? 'off' : formatEntry(entry)}`)
      .join(', '),
  );
}

function drawEntry(card, row, index) {
  const entry = card.entries[index];
  const group = `Slot ${index + 1}, ${ROLES[index]?.toLowerCase() ?? `number ${index + 1}`}`;
  row.section.setAttribute('aria-label', group);
  row.number.textContent = String(index + 1);
  row.role.textContent = ROLES[index] ?? '';
  row.section.dataset.off = String(entry.off);
  // An input being edited, or with the focus, keeps what it shows.
  if (document.activeElement !== row.picker && !row.editing) row.picker.value = entry.rgb;
  if (document.activeElement !== row.whiteInput && !row.editing) row.white.refresh();
  row.picker.disabled = entry.off;
  row.whiteInput.disabled = entry.off;
  row.off.setAttribute('aria-pressed', String(entry.off));
  row.up.disabled = index === 0;
  row.down.disabled = index === card.entries.length - 1;
  row.remove.disabled = card.entries.length < 2;
}

/** Which groups have this palette on, and which have a look that uses it. */
function usesOf(id) {
  const on = [];
  const looks = [];
  for (const group of shell.show.groups) {
    if (shell.playback.groups?.[group.id]?.colour?.scene === id) on.push(group.label);
    if (group.looks?.some((look) => look.colour?.palette === id)) looks.push(group.label);
  }
  return { on, looks };
}

function draw(card) {
  const { id } = card;
  const open = opened.has(id);
  card.title.textContent = card.label;
  card.mark.textContent =
    card.mode === 'static'
      ? 'Static'
      : `Cycle · ${card.change === 'fade' ? 'Fade' : 'Hard step'} · ${speedText(card.speed)}`;
  if (card.visible !== undefined) {
    card.mark.textContent += ` · shows ${card.visible} of ${card.entries.length}`;
  }
  card.edit.setAttribute('aria-pressed', String(open));
  card.edit.setAttribute('aria-expanded', String(open));
  card.editor.hidden = !open;

  const { on, looks } = usesOf(id);
  const parts = [];
  if (on.length > 0) parts.push(`On in ${on.join(', ')}`);
  if (looks.length > 0) parts.push(`In a look of ${looks.join(', ')}`);
  card.uses.textContent = parts.length > 0 ? parts.join(' · ') : 'Not on in any group';
  card.section.dataset.on = String(on.length > 0);

  drawStrip(card);
  if (!open) return;

  while (card.rows.length > card.entries.length) card.rows.pop().section.remove();
  while (card.rows.length < card.entries.length) {
    const row = buildEntry(card, card.rows.length);
    card.rows.push(row);
    card.list.append(row.section);
  }
  card.rows.forEach((row, index) => {
    drawEntry(card, row, index);
  });

  const full = card.entries.length >= MAX_COLOURS;
  card.add.disabled = full;
  card.room.textContent = full
    ? `${card.entries.length} of ${MAX_COLOURS} colours. Remove one to add another.`
    : card.entries.length === 1
      ? `1 of ${MAX_COLOURS} colours. A palette keeps at least one.`
      : `${card.entries.length} of ${MAX_COLOURS} colours.`;

  const cycles = card.mode === 'cycle';
  card.showMode(card.mode);
  card.showChange(card.change);
  card.showSpeed(card.speed);
  card.changeSet.disabled = !cycles;
  card.speedSet.disabled = !cycles;
  card.shownSet.hidden = card.entries.length < 2;
  for (const { n, key } of card.shownKeys) {
    // Showing as many as the palette has is All.
    key.hidden = n !== undefined && n >= card.entries.length;
    key.setAttribute('aria-pressed', String(n === card.visible));
  }
  card.pace.textContent = cycles
    ? `${card.change === 'fade' ? 'Fades' : 'Cuts'} to the next colour, ${paceOf(card.speed)}.`
    : 'Static: the colours stay as they are. Change and speed are for a cycle.';

  card.rename.field.disabled = false;
  // A name that is being typed stays.
  if (
    document.activeElement !== card.rename.field &&
    card.rename.field.dataset.for !== card.label
  ) {
    card.rename.field.value = card.label;
    card.rename.field.dataset.for = card.label;
  }
  const isSure = sure === id;
  card.remove.dataset.sure = String(isSure);
  card.remove.textContent = isSure ? `Press again to delete "${card.label}"` : 'Delete palette';
}

function speedText(speed) {
  return speed >= 1 ? `×${speed}` : `÷${1 / speed}`;
}

function render() {
  const { palettes } = shell.show;
  if (sure && !palettes.some((palette) => palette.id === sure)) unsure();
  for (const [id, card] of cards) {
    if (palettes.some((palette) => palette.id === id)) continue;
    clearTimeout(card.settle);
    card.section.remove();
    cards.delete(id);
    opened.delete(id);
  }
  palettes.forEach((palette, index) => {
    let card = cards.get(palette.id);
    if (!card) {
      card = buildCard(palette.id);
      cards.set(palette.id, card);
      adopt(card, palette);
    } else if (!held(card)) {
      adopt(card, palette);
    }
    if (page.palettes.children[index] !== card.section) {
      page.palettes.insertBefore(card.section, page.palettes.children[index] ?? null);
    }
    draw(card);
  });

  const { file } = shell.show;
  page.where.textContent =
    `${count(palettes.length, 'palette')}` +
    (file ? `, kept in ${file.split(/[\\/]/).pop()}` : ', kept until lightdeck stops');
  page.where.title = file ?? '';
}

/** What went wrong on this page, with a place of its own beside the notice of the shell. */
function renderNotice() {
  const { problem } = shell.show;
  let text = '';
  if (lost) text = 'That press did not reach lightdeck, and it is not sent again. Press again.';
  else if (failure) text = failure;
  else if (problem) {
    text = `The show file has a mistake, so lightdeck goes on with the show it had. ${sentence(problem)}`;
  }
  page.notice.textContent = text;
  page.notice.hidden = text === '';
}

async function main() {
  shell = await start({ page: 'palettes' });
  if (!shell) return;
  document.title = 'Palettes · Lightdeck';

  // The notice of the shell joins the one of the page, where it takes no room from the keys.
  page.notices.prepend($('notice'));
  page.make.addEventListener('submit', make);
  shell.on('show', () => {
    failure = '';
    render();
    renderNotice();
  });
  // Which palette is on in which group is in the playback.
  shell.on('playback', render);
  render();
  renderNotice();
}

main();
