// The palettes page: the colours of the show, apart from the effects (design mockup 11). Plain browser
// JavaScript, no build step.
//
// A palette is a list of one to eight entries, slot 1 first. An entry is a colour (red, green and blue,
// and a white level for the white LED of the spider) or off. A light effect says how much of slot 1, 2
// and 3 each lens gets, and the palette says what those are. A palette is static, or it cycles: the list
// shifts by one slot per step, as a hard cut or as a fade, at one of the speeds ÷4 to ×4 (×1 is one step
// per beat, ÷4 one per bar). Palettes belong to the whole show. A group gets one set on the deck, or
// here with a key per group that takes palettes (`POST /api/playback` with the palette).
//
// The page: a list of the palettes at the left (name, how it runs, a strip of its colours), the chosen
// palette in the middle (rename, duplicate, delete with a second press, its eight slots and the colour of
// the chosen slot as four sliders R G B W, a few quick colours, a dark slot, earlier, later, remove) and
// at the right how it runs (Static, Step or Fade, the pace, how many colours show at once) with the
// lenses as it would spread over them. A new palette is made from the key in the head of the page.
//
// The page draws what the server says: `shell.show.palettes`. A press is asked once with `shell.ask`, and
// a colour or a level is sent when it is let go, not on every step of a drag. What the operator is
// editing is kept in the page (a draft per palette) and drawn from there, so that nothing jumps back:
// after a change of its own a palette ignores what the event stream says for a moment (the answer and the
// events come over different connections, so an older event can still be on its way) and is then drawn
// from the show as it is by then. The chosen palette is kept in the hash of the address.
//
// Its notice is kept at the bottom of the screen, with the one of the shell, so that no key moves when it
// comes or goes.

import { start } from './shell.js';
import { $, button, choiceKeys, element, sentence, slider, speedKeys, speedName } from './ui.js';

/** How long the delete key waits for the second press. */
const SURE_MS = 3000;
/** How long a palette ignores the event stream after a change of its own. */
const SETTLE_MS = 1500;
const MAX_COLOURS = 8;
const NAME_LENGTH = 40;
/** What the first slots are for, in the words of the design. */
const ROLES = ['hits', 'backdrop', 'accent'];
/** A colour that is added. */
const FRESH = { off: false, r: 255, g: 0, b: 0, ww: 0 };
/** What an entry that was off from the start gets when it is switched on: the white LED. */
const WHITE = { r: 0, g: 0, b: 0, ww: 255 };
/** Quick colours for the chosen slot: content, shown as they are. */
const QUICK = [
  { name: 'Amber', r: 255, g: 149, b: 0, ww: 0 },
  { name: 'Copper', r: 255, g: 90, b: 31, ww: 0 },
  { name: 'Sepia', r: 240, g: 160, b: 96, ww: 0 },
  { name: 'Fire', r: 255, g: 42, b: 0, ww: 0 },
  { name: 'Blue', r: 0, g: 48, b: 255, ww: 0 },
  { name: 'Cyan', r: 0, g: 200, b: 255, ww: 0 },
  { name: 'White', ...WHITE },
];
const CHANNELS = [
  { key: 'r', label: 'R', tone: 'red', max: 255 },
  { key: 'g', label: 'G', tone: 'green', max: 255 },
  { key: 'b', label: 'B', tone: 'blue', max: 255 },
  { key: 'ww', label: 'W', tone: 'white', max: 255 },
];
const CHANGES = [
  { id: 'static', label: 'Static' },
  { id: 'step', label: 'Step' },
  { id: 'fade', label: 'Fade' },
];

const page = {
  meta: $('meta'),
  list: $('list'),
  main: $('main'),
  title: $('title'),
  uses: $('uses'),
  rename: $('rename'),
  renameKey: $('rename-key'),
  copyKey: $('copy-key'),
  deleteKey: $('delete-key'),
  slots: $('slots'),
  slotTitle: $('slot-title'),
  darkKey: $('dark-key'),
  channels: $('channels'),
  quick: $('quick'),
  earlierKey: $('earlier-key'),
  laterKey: $('later-key'),
  removeKey: $('remove-key'),
  room: $('room'),
  change: $('change'),
  pace: $('pace'),
  paceNote: $('pace-note'),
  shown: $('shown'),
  shownNote: $('shown-note'),
  lenses: $('lenses'),
  groups: $('groups'),
  groupsNote: $('groups-note'),
  newOpen: $('new-open'),
  newSheet: $('new-sheet'),
  newName: $('new-name'),
  newCancel: $('new-cancel'),
  notice: $('palettes-notice'),
};

let shell;
/** What the server answered to what could not be done. */
let failure = '';
/** True when the last press did not reach lightdeck. It is not sent again. */
let lost = false;
/** By the id of a palette, what the operator has made of it (see the top of the file). */
const drafts = new Map();
/** By the id of a palette, the key in the list. */
const items = new Map();
/** The id of the palette that is wanted: it may not have come from the server yet. */
let wanted = decodeURIComponent(location.hash.slice(1));
/** The slot that is chosen, from 0. */
let slot = 0;
/** True while the name of the palette is being typed. */
let renaming = false;
/** True when the delete key was pressed once. */
let sure = false;
let sureTimer;

const count = (number, word) => (number === 1 ? `1 ${word}` : `${number} ${word}s`);

// ---- entries ----

const hex = (byte) => byte.toString(16).padStart(2, '0');

/** '#rrggbb', '#rrggbbww' or 'off' as an entry. A colour that is off keeps the white LED for later. */
function parseEntry(text) {
  const found = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(text);
  if (text === 'off' || !found) return { off: true, ...WHITE };
  return {
    off: false,
    r: Number.parseInt(found[1], 16),
    g: Number.parseInt(found[2], 16),
    b: Number.parseInt(found[3], 16),
    ww: found[4] ? Number.parseInt(found[4], 16) : 0,
  };
}

/** An entry as the server takes it. */
function formatEntry({ off, r, g, b, ww }) {
  if (off) return 'off';
  return `#${hex(r)}${hex(g)}${hex(b)}${ww > 0 ? hex(ww) : ''}`;
}

/** The colour a lens would show: red, green and blue with the white LED mixed in. */
function mix({ r, g, b, ww }) {
  const level = ww / 255;
  const part = (value, white) => Math.min(255, Math.round(value + white * level * 255));
  return `rgb(${part(r, 1)} ${part(g, 0.94)} ${part(b, 0.82)})`;
}

/** What a palette that steps at this speed does, in words. */
function paceOf(speed) {
  if (speed === 0.25) return 'a step every 4 beats';
  if (speed === 0.5) return 'a step every 2 beats';
  if (speed === 1) return 'a step every beat';
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
const held = (draft) => draft.busy > 0 || Date.now() < draft.until;

/** Keeps what the draft says over what the show says, until the change is sent and the show has it. */
function hold(draft) {
  draft.until = Date.now() + SETTLE_MS;
}

/** The palette that is chosen: the one that is wanted, or else the first. */
function current() {
  const { palettes } = shell.show;
  const draft = drafts.get(wanted) ?? drafts.get(palettes[0]?.id);
  return draft ?? null;
}

/** Sends a change of a palette. The draft keeps what was changed until the show has it. */
async function send(draft, fields) {
  draft.busy += 1;
  const answer = await ask(`/api/palettes/${draft.id}/update`, fields);
  draft.busy -= 1;
  clearTimeout(draft.settle);
  if (answer.ok) {
    draft.until = Date.now() + SETTLE_MS;
    draft.settle = setTimeout(() => sync(draft), SETTLE_MS);
  } else {
    // Refused, or not heard: the show is what is true.
    draft.until = 0;
    sync(draft);
  }
}

const sendColours = (draft) => send(draft, { colours: draft.entries.map(formatEntry) });

function choose(id) {
  if (wanted === id) return;
  wanted = id;
  slot = 0;
  stopRenaming();
  unsure();
  history.replaceState(null, '', `#${encodeURIComponent(id)}`);
  render();
  items.get(id)?.button.scrollIntoView({ block: 'nearest' });
}

// ---- the actions of the head ----

function stopRenaming() {
  renaming = false;
}

async function saveName(draft) {
  const label = page.rename.value;
  const answer = await ask(`/api/palettes/${draft.id}/update`, { label });
  if (!answer.ok) return;
  draft.label = label;
  renaming = false;
  render();
}

function pressRename() {
  const draft = current();
  if (!draft) return;
  if (!renaming) {
    renaming = true;
    page.rename.value = draft.label;
    render();
    page.rename.focus();
    page.rename.select();
    return;
  }
  saveName(draft);
}

/** A copy is a new palette with the same colours and the same way of running. */
async function duplicate() {
  const draft = current();
  if (!draft) return;
  const label = `Copy of ${draft.label}`.slice(0, NAME_LENGTH);
  const fields = {
    label,
    colours: draft.entries.map(formatEntry),
    mode: draft.mode,
    change: draft.change,
    speed: draft.speed,
  };
  if (draft.visible !== undefined) fields.visible = draft.visible;
  const answer = await ask('/api/palettes', fields);
  if (answer.ok && answer.id) {
    wanted = answer.id;
    slot = 0;
    history.replaceState(null, '', `#${encodeURIComponent(answer.id)}`);
  }
  render();
}

function unsure() {
  clearTimeout(sureTimer);
  sure = false;
}

/** The first press asks, the second one within a few seconds deletes. */
async function remove() {
  const draft = current();
  if (!draft) return;
  if (!sure) {
    sure = true;
    sureTimer = setTimeout(() => {
      unsure();
      render();
    }, SURE_MS);
    render();
    return;
  }
  unsure();
  const { palettes } = shell.show;
  const at = palettes.findIndex((each) => each.id === draft.id);
  const answer = await ask(`/api/palettes/${draft.id}/delete`);
  if (answer.ok) {
    wanted = (palettes[at + 1] ?? palettes[at - 1])?.id ?? '';
    slot = 0;
  }
  render();
}

function openNew(open) {
  page.newSheet.hidden = !open;
  page.newOpen.setAttribute('aria-expanded', String(open));
  page.newOpen.classList.toggle('is-open', open);
  if (open) page.newName.focus();
}

async function make(event) {
  event.preventDefault();
  const answer = await ask('/api/palettes', { label: page.newName.value });
  if (!answer.ok) return;
  if (answer.id) {
    wanted = answer.id;
    slot = 0;
    history.replaceState(null, '', `#${encodeURIComponent(answer.id)}`);
  }
  page.newName.value = '';
  page.newName.blur();
  openNew(false);
  render();
}

// ---- editing the slots ----

/** Runs `change` on the entries of the chosen palette, draws, and sends the colours. */
function edit(change) {
  const draft = current();
  if (!draft) return;
  change(draft);
  slot = Math.max(0, Math.min(slot, draft.entries.length - 1));
  hold(draft);
  render();
  sendColours(draft);
}

function setEntry(index, values) {
  edit((draft) => {
    Object.assign(draft.entries[index], { off: false }, values);
  });
}

function move(step) {
  edit((draft) => {
    const other = slot + step;
    if (other < 0 || other >= draft.entries.length) return;
    [draft.entries[slot], draft.entries[other]] = [draft.entries[other], draft.entries[slot]];
    slot = other;
  });
}

function addSlot() {
  edit((draft) => {
    if (draft.entries.length >= MAX_COLOURS) return;
    draft.entries.push({ ...FRESH });
    slot = draft.entries.length - 1;
  });
}

function removeSlot() {
  edit((draft) => {
    if (draft.entries.length < 2) return;
    draft.entries.splice(slot, 1);
  });
}

function toggleDark() {
  edit((draft) => {
    const entry = draft.entries[slot];
    if (entry) entry.off = !entry.off;
  });
}

/** Chooses how many of the first colours show. As many as the palette has is all, and is sent as null. */
function chooseShown(count) {
  const draft = current();
  if (!draft) return;
  const visible = count >= draft.entries.length ? undefined : count;
  draft.visible = visible;
  hold(draft);
  render();
  send(draft, { visible: visible ?? null });
}

function chooseChange(id) {
  const draft = current();
  if (!draft) return;
  if (id === 'static') {
    draft.mode = 'static';
    hold(draft);
    render();
    send(draft, { mode: 'static' });
    return;
  }
  draft.mode = 'cycle';
  draft.change = id;
  hold(draft);
  render();
  send(draft, { mode: 'cycle', change: id });
}

function chooseSpeed(speed) {
  const draft = current();
  if (draft?.mode !== 'cycle') return;
  draft.speed = speed;
  hold(draft);
  render();
  send(draft, { speed });
}

/** Sets the palette on a group, as the deck does. The look of the group turns Varied. */
async function setOnGroup(group) {
  const draft = current();
  if (!draft) return;
  await ask('/api/playback', { group: group.id, palette: draft.id });
}

// ---- building the parts that stay ----

const sliders = [];
let showChange;
let showSpeed;
const shownKeys = [];
const slotKeys = [];
const lensCells = [];
const groupKeys = new Map();

function buildSlots() {
  for (let index = 0; index < MAX_COLOURS; index++) {
    const made = element('button', 'slot');
    made.type = 'button';
    const swatch = element('span', 'c');
    const name = element('span', 'k');
    name.append(element('b', '', String(index + 1)), element('small'));
    made.append(swatch, name);
    made.addEventListener('click', () => {
      const draft = current();
      if (!draft) return;
      if (index < draft.entries.length) {
        slot = index;
        render();
      } else if (index === draft.entries.length) {
        addSlot();
      }
    });
    page.slots.append(made);
    slotKeys.push({ made, swatch, small: name.lastElementChild });
  }
}

function buildChannels() {
  for (const { key, label, tone, max } of CHANNELS) {
    const made = slider({
      id: `pal-${key}`,
      label,
      tone,
      min: 0,
      max,
      read: () => {
        const entry = current()?.entries[slot];
        return !entry || entry.off ? null : entry[key];
      },
      write: (number) => {
        const draft = current();
        const entry = draft?.entries[slot];
        if (!entry || entry.off) return;
        entry[key] = number;
        // Held until it is let go and sent: an event about something else does not undo the drag.
        hold(draft);
        drawLive();
      },
    });
    // A colour and a level are sent when they are let go, not on every step of a drag.
    made.input.addEventListener('change', () => {
      const draft = current();
      if (draft) sendColours(draft);
    });
    page.channels.append(made);
    sliders.push(made);
  }
}

function buildQuick() {
  for (const preset of QUICK) {
    const made = element('button', 'rc');
    made.type = 'button';
    const dot = element('i');
    dot.style.background = mix(preset);
    made.append(dot, preset.name);
    made.addEventListener('click', () => {
      const { r, g, b, ww } = preset;
      setEntry(slot, { r, g, b, ww });
    });
    page.quick.append(made);
  }
}

function buildSide() {
  showChange = choiceKeys(page.change, CHANGES, chooseChange);
  showSpeed = speedKeys(page.pace, shell.rates, chooseSpeed);
  page.pace.classList.add('pace-keys');
  for (let n = 1; n <= MAX_COLOURS; n++) {
    const made = button('key c', String(n), () => chooseShown(n));
    page.shown.append(made);
    shownKeys.push({ n, made });
  }
  for (let index = 0; index < MAX_COLOURS; index++) {
    const cell = element('i');
    page.lenses.append(cell);
    lensCells.push(cell);
  }
}

function buildItem(id) {
  const made = element('button', 'pl');
  made.type = 'button';
  const name = element('span', 'n');
  const meta = element('span', 'm');
  const strip = element('div', 'strip');
  made.append(name, meta, strip);
  made.addEventListener('click', () => choose(id));
  const item = { button: made, name, meta, strip };
  items.set(id, item);
  return item;
}

// ---- drawing ----

/** Takes what the show says into the draft. */
function adopt(draft, palette) {
  draft.label = palette.label;
  draft.mode = palette.mode;
  draft.change = palette.change;
  draft.speed = palette.speed;
  draft.visible = palette.visible;
  // An entry that is off keeps the colour it had, so that Dark slot pressed again brings it back.
  draft.entries = palette.colours.map((text, index) => {
    const entry = parseEntry(text);
    const before = draft.entries[index];
    if (entry.off && before)
      return { off: true, r: before.r, g: before.g, b: before.b, ww: before.ww };
    return entry;
  });
}

function sync(draft) {
  const palette = paletteOf(draft.id);
  if (!palette || held(draft)) return;
  adopt(draft, palette);
  render();
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

/** Fills a strip with a span per entry. An entry that is off is a hatched dark one. */
function fillStrip(strip, draft) {
  while (strip.children.length > draft.entries.length) strip.lastElementChild.remove();
  while (strip.children.length < draft.entries.length) strip.append(element('span'));
  draft.entries.forEach((entry, index) => {
    const span = strip.children[index];
    span.classList.toggle('dark', entry.off);
    span.style.background = entry.off ? '' : mix(entry);
  });
}

/** How a palette runs, in two or three characters of the list: Static, Step ÷4, Fade ×1. */
function runsAs(draft) {
  if (draft.mode === 'static') return 'Static';
  return `${draft.change === 'fade' ? 'Fade' : 'Step'} ${speedName(draft.speed)}`;
}

function drawList() {
  const { palettes } = shell.show;
  const chosen = current();
  palettes.forEach((palette, index) => {
    const draft = drafts.get(palette.id);
    const item = items.get(palette.id) ?? buildItem(palette.id);
    const { on } = usesOf(palette.id);
    item.name.textContent = draft.label;
    item.meta.textContent = on.length > 0 ? `On in ${on.join(', ')}` : runsAs(draft);
    item.button.classList.toggle('is-on', on.length > 0);
    item.button.classList.toggle('is-sel', draft === chosen);
    item.button.setAttribute('aria-current', String(draft === chosen));
    fillStrip(item.strip, draft);
    if (page.list.children[index] !== item.button) {
      page.list.insertBefore(item.button, page.list.children[index] ?? null);
    }
  });
}

/** The lenses as the palette would spread over them: lens n takes the slot n of those that show. */
function drawLenses(draft) {
  const shown = Math.max(1, Math.min(draft.visible ?? draft.entries.length, draft.entries.length));
  lensCells.forEach((cell, index) => {
    const entry = draft.entries[index % shown];
    cell.className = entry.off ? 'dark' : '';
    cell.style.background = entry.off ? '' : mix(entry);
  });
}

function drawSlots(draft) {
  const shown = draft.visible ?? draft.entries.length;
  slotKeys.forEach(({ made, swatch, small }, index) => {
    const entry = draft.entries[index];
    const real = index < draft.entries.length;
    const add = index === draft.entries.length && index < MAX_COLOURS;
    made.disabled = !real && !add;
    made.classList.toggle('is-sel', real && index === slot);
    made.classList.toggle('is-add', add);
    made.classList.toggle('is-empty', !real && !add);
    made.classList.toggle('is-pool', real && index >= shown);
    made.setAttribute('aria-pressed', String(real && index === slot));
    made.setAttribute(
      'aria-label',
      real
        ? `Slot ${index + 1}${ROLES[index] ? `, ${ROLES[index]}` : ''}, ${entry.off ? 'off' : formatEntry(entry)}`
        : add
          ? 'Add a colour'
          : `Slot ${index + 1}, empty`,
    );
    swatch.classList.toggle('dark', real && entry.off);
    swatch.style.background = real && !entry.off ? mix(entry) : '';
    swatch.textContent = add ? '+' : real && entry.off ? 'OFF' : '';
    small.textContent = real ? (ROLES[index] ?? '') : '';
  });
}

function drawSlotEditor(draft) {
  const entry = draft.entries[slot];
  page.slotTitle.textContent = `Slot ${slot + 1} · ${entry.off ? 'dark' : 'RGBW'}`;
  page.darkKey.classList.toggle('is-sel', entry.off);
  page.darkKey.setAttribute('aria-pressed', String(entry.off));
  for (const made of sliders) made.refresh();
  for (const made of page.quick.children) made.disabled = false;
  page.earlierKey.disabled = slot === 0;
  page.laterKey.disabled = slot === draft.entries.length - 1;
  page.removeKey.disabled = draft.entries.length < 2;
  page.room.textContent =
    draft.entries.length >= MAX_COLOURS
      ? `${draft.entries.length} of ${MAX_COLOURS} colours`
      : draft.entries.length === 1
        ? `1 of ${MAX_COLOURS} colours, a palette keeps one`
        : `${draft.entries.length} of ${MAX_COLOURS} colours`;
}

function drawSide(draft) {
  const cycles = draft.mode === 'cycle';
  showChange(cycles ? draft.change : 'static');
  showSpeed(draft.speed);
  page.pace.disabled = !cycles;
  page.paceNote.textContent = cycles
    ? `${draft.change === 'fade' ? 'Fades' : 'Cuts'} to the next colour: ${paceOf(draft.speed)}`
    : 'Static: the colours stay as they are';
  const shown = draft.visible ?? draft.entries.length;
  for (const { n, made } of shownKeys) {
    made.classList.toggle('is-on', n === shown);
    made.classList.toggle('is-disabled', n > draft.entries.length);
    made.disabled = n > draft.entries.length;
    made.setAttribute('aria-pressed', String(n === shown));
  }
  page.shownNote.textContent =
    shown < draft.entries.length
      ? `The other ${count(draft.entries.length - shown, 'colour')} are what a cycle draws from`
      : 'All the colours show';
  drawLenses(draft);

  const takers = shell.show.groups.filter((group) => group.palettes);
  for (const group of takers) {
    if (groupKeys.has(group.id)) continue;
    const made = button('key c', '', () => setOnGroup(group));
    groupKeys.set(group.id, made);
    page.groups.append(made);
  }
  for (const [id, made] of groupKeys) {
    const group = takers.find((each) => each.id === id);
    made.hidden = !group;
    if (group) {
      const on = shell.playback.groups?.[id]?.colour?.scene === draft.id;
      made.textContent = `Set on ${group.label}`;
      made.classList.toggle('is-on', on);
    }
  }
  page.groupsNote.textContent =
    takers.length > 0
      ? 'Sets this palette on the group now. Its look turns Varied.'
      : 'No group takes palettes.';
}

/** What changes while a slider is dragged: the colours, not the sliders themselves. */
function drawLive() {
  const draft = current();
  if (!draft) return;
  drawList();
  drawSlots(draft);
  drawLenses(draft);
}

function render() {
  const { palettes } = shell.show;
  for (const [id, draft] of drafts) {
    if (palettes.some((palette) => palette.id === id)) continue;
    clearTimeout(draft.settle);
    drafts.delete(id);
    items.get(id)?.button.remove();
    items.delete(id);
  }
  for (const palette of palettes) {
    let draft = drafts.get(palette.id);
    if (!draft) {
      draft = {
        id: palette.id,
        label: '',
        entries: [],
        mode: 'static',
        change: 'step',
        speed: 0.25,
        visible: undefined,
        busy: 0,
        until: 0,
        settle: 0,
      };
      drafts.set(palette.id, draft);
      adopt(draft, palette);
    } else if (!held(draft)) {
      adopt(draft, palette);
    }
  }

  const file = shell.show.file;
  page.meta.textContent = `${count(palettes.length, 'palette')} · ${file ? file.split(/[\\/]/).pop() : 'kept until lightdeck stops'}`;
  page.meta.title = file ?? '';

  const draft = current();
  page.main.hidden = !draft;
  for (const area of document.querySelectorAll('.setup-side > *')) area.hidden = !draft;
  if (!draft) {
    drawList();
    return;
  }
  slot = Math.max(0, Math.min(slot, draft.entries.length - 1));
  if (sure && !paletteOf(draft.id)) unsure();

  drawList();
  page.title.textContent = draft.label;
  page.title.hidden = renaming;
  page.uses.hidden = renaming;
  page.rename.hidden = !renaming;
  page.renameKey.textContent = renaming ? 'Save' : 'Rename';
  page.deleteKey.textContent = sure ? 'Delete?' : 'Delete…';
  page.deleteKey.classList.toggle('is-warn', sure);
  const { on, looks } = usesOf(draft.id);
  const parts = [];
  if (on.length > 0) parts.push(`on in ${on.join(', ')}`);
  if (looks.length > 0) parts.push(`in a look of ${looks.join(', ')}`);
  page.uses.textContent = parts.length > 0 ? parts.join(' · ') : 'not on in any group';
  page.uses.title = page.uses.textContent;

  drawSlots(draft);
  drawSlotEditor(draft);
  drawSide(draft);
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

  buildSlots();
  buildChannels();
  buildQuick();
  buildSide();

  page.renameKey.addEventListener('click', pressRename);
  page.rename.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') pressRename();
    if (event.key === 'Escape') {
      stopRenaming();
      render();
    }
  });
  page.copyKey.addEventListener('click', duplicate);
  page.deleteKey.addEventListener('click', remove);
  page.darkKey.addEventListener('click', toggleDark);
  page.earlierKey.addEventListener('click', () => move(-1));
  page.laterKey.addEventListener('click', () => move(1));
  page.removeKey.addEventListener('click', removeSlot);

  page.newOpen.addEventListener('click', () => openNew(page.newSheet.hidden));
  page.newCancel.addEventListener('click', () => openNew(false));
  page.newSheet.addEventListener('submit', make);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !page.newSheet.hidden) openNew(false);
  });
  // A press outside the sheet closes it.
  document.addEventListener('pointerdown', (event) => {
    if (page.newSheet.hidden) return;
    if (page.newSheet.contains(event.target) || page.newOpen.contains(event.target)) return;
    openNew(false);
  });

  shell.on('show', () => {
    failure = '';
    render();
    renderNotice();
  });
  // Which palette is on in which group is in the playback.
  shell.on('playback', render);
  render();
  renderNotice();
  items.get(current()?.id)?.button.scrollIntoView({ block: 'nearest' });
}

main();
