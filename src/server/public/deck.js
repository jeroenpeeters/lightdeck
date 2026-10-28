// The deck: the groups of the show with what can be set on them. Plain browser JavaScript, no
// build step. The design is `design/` (mockups 07 and 08), the markup is that of lightdeck.css and
// the shared parts of ui.js and tabletKit.js.
//
// The page is three columns under the top bar of the shell (Live, tempo, master, master speed,
// Blackout: the masters are there, not here):
//
//   nav     the groups of the show (a group is a set of fixtures, with the number of scenes and looks
//           it holds), and under them the lanes: Looks, Lights, Colour, Motion, Zone.
//   main    the keys of the chosen group and lane, in pages of twenty, with the pager above them
//           and the key that darkens the group at the foot. A look sets a scene of lights, a palette,
//           a scene of motion and a scene of zone together; a lane it does not name is left alone.
//           Lights, Motion and Zone are the scenes of the group, a scene being a part of what the
//           fixtures do, of that type only. Colour is the palettes of the show, the same in every
//           group, made on the Palettes page; a group whose fixtures have colours of their own (the
//           laser) takes no palettes, and says so. Off darkens the fixtures and leaves their colours
//           and their motion as they are. A zone says how far the motion effects reach.
//   side    the sequences of the show (written in the file by hand): which one, Start or Stop, Next,
//           where it is, and its steps as a list (the step that is on lit, the next one dashed).
//           A sequence changes the looks of the groups by itself, a step after the other, on the
//           bars of the tempo; starting one stops the one that runs; Stop leaves the fixtures as
//           they are. A press by hand stands until the next step that changes that group. The list is
//           not pressable: the server has no jump to a step, only Next. In Program the side also holds
//           what stores and changes the show (see below).
//
// One thing per lane is on, so several are on at once, each for its own fixtures and its own
// properties: a palette is pressed under a chase and the chase goes on in the new colours. A look
// that is on is lit, and it shows Varied when a lane it set is not what it set any more. The look
// that the running sequence sets next in the group has a dashed edge and Next.
//
// The deck has two modes, and the address remembers which (#program), with the Show and Program
// keys in the head of the page:
//
//   Show      what the page opens in. A press sets what its key names on the fixtures of its
//             group, a press on Off darkens them. There is nothing to type and nothing that
//             deletes, and no key changes size or place when something goes on or off.
//   Program   blue. Storing, naming and deleting, of scenes, looks and groups. A press on a scene or a
//             look picks it (Picked), and the fixtures stay as they are. A palette key does nothing
//             there: the palettes are edited on their own page, which the Colour lane links to. The
//             side shows: Store what is on now (what to store: Lights, Motion, Zone or Look, which
//             follows the lane and the key that is picked; a field for the name; Store as new; Replace
//             picked; and Store the changes in the one that is on), the picked key (Rename, Delete
//             after two presses), the group (rename, delete after two presses) and a form for a new
//             group. The first empty place of the last page is "Store here", which is Store as new.
//
// Storing takes the properties of the chosen type from the fixtures of the group as they are
// now, so a scene is made on the pages of the fixtures and kept here. A look takes what is on
// in the group now: the scene of lights, the palette, the scene of motion and the scene of zone. The
// server refuses a look when nothing is on or a lane was changed by hand, and says so.
//
// The deck draws what the server says: the groups of the show, the palettes, which scene or
// palette is on in each lane of each group, which look, and whether its fixtures were changed
// by hand since. It asks for what the operator wants and waits for the answer to come by as an
// event. A press is asked once: when it does not reach lightdeck the deck says so and the
// operator presses again. The group and the lane that are chosen are kept in this browser.
//
// Notices lie over the foot of the screen (the one of the deck and the one of the shell, in one
// stack), so no key moves when one comes or goes.

import { start } from './shell.js';
import {
  chipColour,
  drawLook,
  fillStrip,
  makeLook,
  makeStrip,
  movesOf,
  stateOf,
  syncKeys,
} from './tabletKit.js';
import { nextLook, partPlace, splitNumber } from './tabletLogic.js';
import {
  $,
  button,
  element,
  makeDismissible,
  segmented,
  sentence,
  setNotice,
  speedName,
} from './ui.js';

/** How long a delete key waits for the second press. */
const SURE_MS = 3000;
/** What the address ends in while the deck is in Program. */
const PROGRAM = '#program';
/** Keys per page of the grid: five columns, four rows. */
const PAGE = 20;
const COLUMNS = 5;
/** What this browser remembers: the group and the lane that were chosen. */
const REMEMBERED = 'lightdeck.deck.view';
/** The lanes of the nav, in order. Colour holds palettes, Looks looks, the others scenes. */
const LANES = [
  { id: 'look', name: 'Looks', hint: 'Lights, colour, motion and zone together' },
  { id: 'lights', name: 'Lights', hint: 'What is on, and what it does' },
  { id: 'colour', name: 'Colour', hint: 'The palette: the colours the effects use' },
  { id: 'motion', name: 'Motion', hint: 'How the bars and the beam move' },
  { id: 'zone', name: 'Zone', hint: 'How far the motion effects reach: the window of each bar' },
];
/** What Program can store: a scene of lights, of motion or of zone, or a look. No colour. */
const STORABLE = [
  { id: 'lights', name: 'Lights' },
  { id: 'motion', name: 'Motion' },
  { id: 'zone', name: 'Zone' },
  { id: 'look', name: 'Look' },
];
const laneName = (id) => LANES.find((lane) => lane.id === id)?.name ?? id;
const NO_PALETTES = "This group's fixtures have colours of their own. Set them on their page.";
const EMPTY = {
  look: 'No looks yet.',
  lights: 'No lights scenes yet.',
  colour: 'No palettes yet. Make them on the Palettes page.',
  motion: 'No motion scenes yet.',
  zone: 'No zone scenes yet. Set a zone on the spider page, then store it here.',
};

let shell;
/** While true, a press on a scene or a look picks it and the fixtures stay as they are. */
let programming = false;
/** The group and the lane that are shown. */
let groupId = null;
let lane = 'look';
/** By group and lane, the page of the grid that is shown (from 0). */
const pages = new Map();
/** The scene or look that is picked in Program, as { group, kind: 'scene' | 'look', id }. */
let chosen = null;
/** What is stored in Program: lights, motion, zone or look. It follows the lane and what is picked. */
let storeType = 'look';
/** What a delete key was pressed for once, as { group, kind: 'scene' | 'look' | 'group', id }. */
let sure = null;
let sureTimer;
/** What the server answered to what could not be done. */
let failure = '';
/** True when the last press did not reach lightdeck. It is not sent again. */
let lost = false;
/** The sequence whose steps are listed, and the one that was running last (the list follows it). */
let viewedSequence = null;
let lastRunning = null;
/** What the field for the name was filled for, so that it follows a pick and not a keystroke. */
let nameFor = null;
/** Shows which of Show and Program is chosen. */
let showMode = () => {};

/** What the page has from the start, found once. */
const page = {
  app: $('app'),
  prog: $('prog'),
  programTag: $('program-tag'),
  where: $('where'),
  nav: $('nav'),
  main: $('main'),
  label: $('d-where'),
  pager: $('d-pager'),
  prev: $('d-prev'),
  next: $('d-next'),
  none: $('d-none'),
  grid: $('d-grid'),
  off: $('d-off'),
  notice: $('deck-notice'),
  program: $('d-program'),
  storeTypes: $('store-types'),
  keeps: $('store-keeps'),
  storeForm: $('store-form'),
  itemName: $('item-name'),
  storeNew: $('store-new'),
  storeReplace: $('store-replace'),
  storeChanges: $('store-changes'),
  pickedTitle: $('picked-title'),
  itemRename: $('item-rename'),
  itemDelete: $('item-delete'),
  itemSure: $('item-sure'),
  groupTitle: $('group-title'),
  groupForm: $('group-form'),
  groupRename: $('group-rename'),
  groupDelete: $('group-delete'),
  groupSure: $('group-sure'),
  makeGroup: $('make-group'),
  groupName: $('group-name'),
  groupFixtures: $('group-fixtures'),
  sequenceTabs: $('sequence-tabs'),
  sequenceState: $('sequence-state'),
  sequenceToggle: $('sequence-toggle'),
  sequenceNext: $('sequence-next'),
  sequenceStatus: $('sequence-status'),
  sequenceSteps: $('sequence-steps'),
  sequenceNone: $('sequence-none'),
};

const groupOf = (id) => shell.show.groups.find((group) => group.id === id);
const sceneOf = (group, id) => groupOf(group)?.scenes.find((scene) => scene.id === id);
const lookOf = (group, id) => groupOf(group)?.looks.find((look) => look.id === id);
const palettes = () => shell.show.palettes ?? [];
const paletteOf = (id) => palettes().find((palette) => palette.id === id);
const labelOf = (id) => shell.fixtures.find((fixture) => fixture.id === id)?.label ?? id;
const same = (one, other) =>
  one !== null && one.group === other.group && one.kind === other.kind && one.id === other.id;
const count = (number, word) => (number === 1 ? `1 ${word}` : `${number} ${word}s`);
const current = () => groupOf(groupId);
/** The scene or look that is picked, when it is still there. */
const chosenItem = () =>
  chosen &&
  (chosen.kind === 'look' ? lookOf(chosen.group, chosen.id) : sceneOf(chosen.group, chosen.id));

/**
 * What is on in a lane of a group. Right after the show changed the server may not have
 * said yet, and then nothing is on. In the lane of the colour that is a palette of the show.
 */
function onIn(group, type) {
  const on = shell.playback.groups?.[group.id]?.[type];
  const item =
    type === 'colour'
      ? group.palettes === false
        ? undefined
        : paletteOf(on?.scene)
      : group.scenes.find((each) => each.id === on?.scene && each.type === type);
  return { item, changed: Boolean(item && on.changed) };
}

/** The look that is on in a group, and whether a lane it set was changed since. */
function onLook(group) {
  const on = shell.playback.groups?.[group.id]?.look;
  const item = group.looks.find((each) => each.id === on?.look);
  return { item, changed: Boolean(item && on.changed) };
}

/** What a scene sets, where that says more than the group does already. */
function setsOf(scene, group) {
  if (scene.fixtures.length === 0) return scene.type === 'lights' ? 'Dark' : 'Nothing set';
  return group.fixtures.length > 1 ? scene.fixtures.map(labelOf).join(', ') : '';
}

/** What a look names, in the words of the keys it points to: "Chase · Sunset · Scissor". */
function namesOf(look, group) {
  const parts = [];
  const lights = group.scenes.find((scene) => scene.id === look.lights);
  if (lights) parts.push(lights.label);
  const palette = look.colour ? paletteOf(look.colour.palette) : undefined;
  if (palette) {
    parts.push(
      look.colour.speed ? `${palette.label} ${speedName(look.colour.speed)}` : palette.label,
    );
  }
  const motion = group.scenes.find((scene) => scene.id === look.motion);
  if (motion) parts.push(motion.label);
  const zone = group.scenes.find((scene) => scene.id === look.zone);
  if (zone) parts.push(zone.label);
  return parts.join(' · ');
}

async function ask(url, body) {
  const answer = await shell.ask(url, body);
  lost = Boolean(answer.lost);
  failure = answer.ok || lost ? '' : sentence(answer.error);
  renderNotice();
  return answer;
}

// ---- what is remembered ----

function remember() {
  try {
    localStorage.setItem(REMEMBERED, JSON.stringify({ group: groupId, lane }));
  } catch {
    // A browser that keeps nothing starts at the first group, as it always did.
  }
}

function recall() {
  try {
    const saved = JSON.parse(localStorage.getItem(REMEMBERED) ?? 'null');
    if (typeof saved?.group === 'string') groupId = saved.group;
    if (LANES.some((each) => each.id === saved?.lane)) lane = saved.lane;
  } catch {
    // Nothing remembered, or not readable: the defaults stand.
  }
}

// ---- what the operator does ----

function pressScene(group, id) {
  if (!programming) {
    ask('/api/playback', { group, scene: id });
    return;
  }
  const at = { group, kind: 'scene', id };
  choose(same(chosen, at) ? null : at);
}

function pressLook(group, id) {
  if (!programming) {
    ask('/api/playback', { group, look: id });
    return;
  }
  const at = { group, kind: 'look', id };
  choose(same(chosen, at) ? null : at);
}

/** Palettes are edited on their page. In Program their keys do nothing. */
function pressPalette(group, id) {
  if (!programming) ask('/api/playback', { group, palette: id });
}

function pressOff() {
  if (!programming && groupId) ask('/api/playback', { group: groupId, off: true });
}

function pressSequence() {
  const { running } = shell.sequence ?? {};
  if (!viewedSequence) return;
  ask('/api/sequence', running === viewedSequence ? { stop: true } : { start: viewedSequence });
}

function pressNext() {
  ask('/api/sequence', { next: true });
}

/** Picks a scene or a look to rename, replace or delete (or nothing), and what is stored follows it. */
function choose(what) {
  chosen = what;
  const item = chosenItem();
  if (item) storeType = what.kind === 'look' ? 'look' : item.type;
  unsure();
  render();
}

function setProgramming(on) {
  programming = on;
  failure = '';
  page.app.dataset.mode = on ? 'program' : 'show';
  page.prog.classList.toggle('prog', on);
  showMode(on ? 'program' : 'show');
  choose(null);
  renderNotice();
}

function switchMode(id) {
  const on = id === 'program';
  if (on === programming) return;
  history.replaceState(null, '', on ? PROGRAM : location.pathname + location.search);
  setProgramming(on);
}

function chooseGroup(id) {
  if (id === groupId) return;
  groupId = id;
  chosen = null;
  unsure();
  remember();
  render();
}

function chooseLane(id) {
  lane = id;
  if (id !== 'colour') storeType = id === 'look' ? 'look' : id;
  chosen = null;
  unsure();
  remember();
  render();
}

function turnPage(by) {
  const key = `${groupId}:${lane}`;
  pages.set(key, (pages.get(key) ?? 0) + by);
  render();
}

async function storeNew() {
  const group = current();
  if (!group) return false;
  const label = page.itemName.value;
  const answer =
    storeType === 'look'
      ? await ask(`/api/groups/${group.id}/looks`, { label })
      : await ask(`/api/groups/${group.id}/scenes`, { label, type: storeType });
  if (answer.ok) {
    page.itemName.value = '';
    nameFor = null;
  }
  return answer.ok;
}

/** Stores what the fixtures do now in a scene or look that is there already. */
function storeOver(kind, id) {
  const group = current();
  if (!group) return;
  ask(`/api/groups/${group.id}/${kind === 'look' ? 'looks' : 'scenes'}/${id}/store`);
}

/** The address of the picked scene or look, on the server. */
function chosenUrl(action) {
  const kind = chosen.kind === 'look' ? 'looks' : 'scenes';
  return `/api/groups/${chosen.group}/${kind}/${chosen.id}/${action}`;
}

async function renameItem() {
  if (!chosenItem()) return;
  const answer = await ask(chosenUrl('rename'), { label: page.itemName.value });
  if (answer.ok) nameFor = null;
}

function unsure() {
  clearTimeout(sureTimer);
  sure = null;
}

/** The first press asks, the second one within a few seconds deletes. */
async function remove(what, url) {
  if (!same(sure, what)) {
    unsure();
    sure = what;
    sureTimer = setTimeout(() => {
      unsure();
      render();
    }, SURE_MS);
    render();
    return;
  }
  unsure();
  await ask(url);
  render();
}

function removeItem() {
  if (chosenItem()) remove({ ...chosen }, chosenUrl('delete'));
}

function removeGroup() {
  const group = current();
  if (group)
    remove({ group: group.id, kind: 'group', id: group.id }, `/api/groups/${group.id}/delete`);
}

async function renameGroup() {
  const group = current();
  if (!group) return;
  const answer = await ask(`/api/groups/${group.id}/rename`, { label: page.groupRename.value });
  if (answer.ok) page.groupRename.blur();
}

async function makeGroup(event) {
  event.preventDefault();
  const ticks = [...page.groupFixtures.querySelectorAll('input')];
  const fixtures = ticks.filter((tick) => tick.checked).map((tick) => tick.value);
  const answer = await ask('/api/groups', { label: page.groupName.value, fixtures });
  if (!answer.ok) return;
  page.groupName.value = '';
  page.groupName.blur();
  for (const tick of ticks) tick.checked = false;
}

// ---- building, once ----

/** The keys of the nav: the groups (a list that follows the show) and the five lanes. */
const nav = { groups: new Map(), lanes: new Map(), groupLabel: null };

function buildNav() {
  nav.groupLabel = element('span', 'lbl', 'Groups');
  const lanesLabel = element('span', 'lbl', 'Lane');
  nav.lanesLabel = lanesLabel;
  page.nav.append(nav.groupLabel);
  page.nav.append(lanesLabel);
  for (const { id, name, hint } of LANES) {
    const made = button('', '', () => chooseLane(id));
    made.title = hint;
    const label = element('span', '', name);
    const number = element('span', 'n');
    made.append(label, number);
    page.nav.append(made);
    nav.lanes.set(id, { made, number });
  }
}

function buildSide() {
  const types = STORABLE.map(({ id, name }) => {
    const made = button('key c', name, () => {
      storeType = id;
      render();
    });
    page.storeTypes.append(made);
    return { id, made };
  });
  page.storeTypes.typeKeys = types;

  page.keeps.append(element('span', 'lbl d-keeps-title'));
  page.keeps.rows = {};
  for (const id of ['lights', 'colour', 'motion', 'zone']) {
    const row = element('div', 'd-keep');
    const value = element('span', 'd-keep-value');
    row.append(element('span', 't2', laneName(id)), value);
    page.keeps.append(row);
    page.keeps.rows[id] = value;
  }
  page.keeps.hint = element('p', 'hint d-keeps-hint');
  page.keeps.append(page.keeps.hint);

  page.storeChangesText = element('span', 'd-ellipsis');
  page.storeChanges.append(page.storeChangesText);

  for (const fixture of shell.fixtures) {
    const label = element('label', 'tick');
    const tick = element('input');
    tick.type = 'checkbox';
    tick.value = fixture.id;
    label.append(tick, element('span', '', fixture.label));
    page.groupFixtures.append(label);
  }
}

// ---- keys ----

/**
 * A key of a scene or a palette: its name with a tag at the right, the colours of a palette (when it
 * has them) and a line under it that says more.
 */
function makeKey(onPress, { strip = false } = {}) {
  const key = element('button', 'key dk');
  key.type = 'button';
  key.addEventListener('click', onPress);
  const tag = element('span', 'tag');
  const head = element('div', 'hd');
  head.append(element('span', 'nm'), tag);
  key.parts = { name: head.firstElementChild, tag, strip: strip ? makeStrip() : null };
  key.append(head);
  if (strip) key.append(key.parts.strip);
  key.parts.sub = element('span', 'lbl');
  key.append(key.parts.sub);
  return key;
}

/** `state` is idle, set or changed; `picked` is the key that Program has chosen to edit. */
function drawKey(key, { state, picked = false, label, sub = '', colours, title = '' }) {
  const { parts } = key;
  key.classList.toggle('is-on', state === 'set' && !picked);
  key.classList.toggle('is-varied', state === 'changed' && !picked);
  key.classList.toggle('is-edit', picked);
  key.setAttribute('aria-pressed', String(picked || state !== 'idle'));
  parts.name.textContent = label;
  setTag(parts.tag, picked ? 'edit' : state === 'changed' ? 'var' : '');
  if (parts.strip) fillStrip(parts.strip, colours);
  parts.sub.textContent = sub;
  key.title = title;
}

function setTag(tag, kind) {
  tag.className = kind ? `tag ${kind}` : 'tag';
  tag.hidden = kind === '';
  tag.textContent = kind === 'edit' ? 'Picked' : kind === 'var' ? 'Varied' : '';
}

/** The running sequence, as the show says it. */
function runningSequence() {
  const id = shell.sequence?.running;
  return id ? (shell.show.sequences ?? []).find((sequence) => sequence.id === id) : undefined;
}

function lookItems(group) {
  const on = onLook(group);
  const next = nextLook(runningSequence(), shell.sequence, group.id, on.item?.id);
  return group.looks.map((look) => ({
    id: `${group.id}:look:${look.id}`,
    make: () => {
      const key = makeLook(() => pressLook(group.id, look.id));
      key.classList.add('dk');
      return key;
    },
    draw: (key) => {
      const picked = same(chosen, { group: group.id, kind: 'look', id: look.id });
      const meta = namesOf(look, group);
      const { no, name } = splitNumber(look.label);
      drawLook(key, {
        state: stateOf(on, look),
        number: no,
        name,
        colours: look.colour ? paletteOf(look.colour.palette)?.colours : undefined,
        meta,
        next: next?.look === look.id ? next : null,
        title: meta,
      });
      // Next is a number here: the dashed edge says the rest, and the title.
      const { tag } = key.parts;
      if (!tag.hidden && tag.classList.contains('next')) {
        tag.textContent = String(next.bars);
        tag.title = `Next in ${count(next.bars, 'bar')}`;
      } else {
        tag.removeAttribute('title');
      }
      key.classList.toggle('is-edit', picked);
      if (picked) {
        key.classList.remove('is-on', 'is-varied', 'is-next');
        setTag(key.parts.tag, 'edit');
      }
    },
  }));
}

function sceneItems(group, type) {
  const on = onIn(group, type);
  return group.scenes
    .filter((scene) => scene.type === type)
    .map((scene) => ({
      id: `${group.id}:scene:${scene.id}`,
      make: () => makeKey(() => pressScene(group.id, scene.id)),
      draw: (key) => {
        const picked = same(chosen, { group: group.id, kind: 'scene', id: scene.id });
        const sub = setsOf(scene, group);
        drawKey(key, { state: stateOf(on, scene), picked, label: scene.label, sub, title: sub });
      },
    }));
}

/** A palette has a strip of its colours between its name and the line under it. */
function paletteItems(group) {
  if (group.palettes === false) return [];
  const on = onIn(group, 'colour');
  return palettes().map((palette) => ({
    id: `${group.id}:palette:${palette.id}`,
    make: () => makeKey(() => pressPalette(group.id, palette.id), { strip: true }),
    draw: (key) => {
      drawKey(key, {
        state: stateOf(on, palette),
        label: palette.label,
        sub: movesOf(palette),
        colours: palette.colours,
        title: `${palette.label}: ${count(palette.colours.length, 'colour')}`,
      });
      // Palettes are edited on their own page, so in Program a press does nothing.
      key.disabled = programming;
    },
  }));
}

/** What Program adds at the end of the last page: Store here, and empty places to the end of the row. */
function programItems(group, shown) {
  if (lane === 'colour') {
    return group.palettes === false
      ? []
      : [
          {
            id: 'edit-palettes',
            make: () => {
              const link = element('a', 'key dk empty d-link', 'Edit palettes');
              link.href = '/palettes';
              return link;
            },
            draw: () => {},
          },
        ];
  }
  const items = [
    {
      id: 'store-here',
      make: () => button('key dk empty d-store', '+ Store here', storeHere),
      draw: () => {},
    },
  ];
  for (let index = 0; (shown + items.length) % COLUMNS !== 0; index += 1) {
    items.push({
      id: `empty-${index}`,
      make: () => {
        const place = element('div', 'key dk empty', 'Empty');
        place.setAttribute('aria-hidden', 'true');
        return place;
      },
      draw: () => {},
    });
  }
  return items;
}

/** "Store here" is Store as new; without a name the server says so. */
function storeHere() {
  if (page.itemName.value === '') page.itemName.focus();
  storeNew();
}

const gridLane = { grid: page.grid, none: null, keys: new Map() };

// ---- drawing ----

function allItems(group) {
  if (lane === 'look') return lookItems(group);
  if (lane === 'colour') return paletteItems(group);
  return sceneItems(group, lane);
}

function renderMain(group) {
  const all = group ? allItems(group) : [];
  // Program adds Store here after the last key, which may take a page of its own.
  const full = group && programming ? [...all, ...programItems(group, all.length)] : all;
  const pageCount = Math.max(1, Math.ceil(full.length / PAGE));
  const key = `${groupId}:${lane}`;
  const at = Math.min(pageCount - 1, Math.max(0, pages.get(key) ?? 0));
  pages.set(key, at);
  syncKeys(gridLane, full.slice(at * PAGE, (at + 1) * PAGE));

  const laneText = laneName(lane).toLowerCase();
  page.label.textContent = group
    ? `${group.label} · ${laneText} · ${pageCount > 1 ? `page ${at + 1} of ${pageCount}` : all.length}`
    : '';
  page.pager.classList.toggle('is-off', pageCount === 1);
  page.pager.setAttribute('aria-hidden', String(pageCount === 1));
  for (const [made, off] of [
    [page.prev, at === 0],
    [page.next, at === pageCount - 1],
  ]) {
    made.disabled = off || pageCount === 1;
    made.classList.toggle('is-disabled', off);
  }

  let none = '';
  if (!group) none = programming ? '' : 'There are no groups yet. Press Program to make one.';
  else if (lane === 'colour' && group.palettes === false) none = NO_PALETTES;
  else if (all.length === 0) none = EMPTY[lane] ?? '';
  page.none.textContent = none;
  page.none.hidden = none === '';

  page.off.textContent = group ? `${group.label} off` : 'Off';
  page.off.disabled = !group || programming;
  page.off.classList.toggle('is-disabled', !group || programming);
  page.off.setAttribute('aria-label', group ? `${group.label} lights off` : 'Lights off');
}

function renderNav() {
  const { groups } = shell.show;
  // The group keys follow the show, in its order; the keys that are there stay where they are.
  for (const [id, entry] of nav.groups) {
    if (groups.some((group) => group.id === id)) continue;
    entry.made.remove();
    nav.groups.delete(id);
  }
  groups.forEach((group, index) => {
    let entry = nav.groups.get(group.id);
    if (!entry) {
      const made = button('', '', () => chooseGroup(group.id));
      entry = { made, name: element('span'), number: element('span', 'n') };
      made.append(entry.name, entry.number);
      nav.groups.set(group.id, entry);
    }
    const before = page.nav.children[1 + index];
    if (before !== entry.made) page.nav.insertBefore(entry.made, before ?? nav.lanesLabel);
    entry.name.textContent = group.label;
    entry.number.textContent = String(group.scenes.length + group.looks.length);
    const here = group.id === groupId;
    entry.made.classList.toggle('is-sel', here);
    entry.made.setAttribute('aria-current', String(here));
  });

  const group = current();
  const counts = {
    look: group?.looks.length,
    lights: group?.scenes.filter((scene) => scene.type === 'lights').length,
    colour: group && group.palettes !== false ? palettes().length : undefined,
    motion: group?.scenes.filter((scene) => scene.type === 'motion').length,
    zone: group?.scenes.filter((scene) => scene.type === 'zone').length,
  };
  for (const [id, entry] of nav.lanes) {
    entry.number.textContent = counts[id] === undefined ? '' : String(counts[id]);
    entry.made.classList.toggle('is-sel', id === lane);
    entry.made.setAttribute('aria-current', String(id === lane));
  }
}

/** The four rows of "what is kept", for the type that is stored. */
function renderKeeps(group) {
  const isLook = storeType === 'look';
  page.keeps.firstElementChild.textContent = isLook
    ? 'A look keeps'
    : `A ${laneName(storeType).toLowerCase()} scene keeps`;
  for (const id of ['lights', 'colour', 'motion', 'zone']) {
    const value = page.keeps.rows[id];
    const kept = isLook || id === storeType;
    const { item } = group ? onIn(group, id) : {};
    value.classList.toggle('t3', !kept);
    value.replaceChildren();
    if (!kept) {
      value.textContent = 'Not kept';
      continue;
    }
    if (id === 'colour' && item) {
      const swatches = element('span', 'sws');
      swatches.setAttribute('aria-hidden', 'true');
      for (const colour of item.colours) {
        const swatch = element('i', 'sw');
        const css = chipColour(colour);
        if (css) swatch.style.backgroundColor = css;
        else swatch.classList.add('dark');
        swatches.append(swatch);
      }
      value.append(swatches);
    }
    value.append(document.createTextNode(item?.label ?? 'None'));
  }
  page.keeps.hint.textContent = isLook
    ? 'Replace keeps the name and the mood of the look.'
    : 'A scene keeps only the properties of its type.';
}

function renderProgram(group) {
  for (const { id, made } of page.storeTypes.typeKeys) {
    made.classList.toggle('is-edit', storeType === id);
    made.setAttribute('aria-pressed', String(storeType === id));
  }
  renderKeeps(group);

  const edited = chosenItem();
  const kind = chosen?.kind === 'look' ? 'look' : 'scene';
  // The field gets the name when a key is picked. After that it is the operator's.
  const editedKey = edited ? `${kind}:${chosen.group}:${edited.id}` : null;
  if (nameFor !== editedKey) {
    nameFor = editedKey;
    page.itemName.value = edited?.label ?? '';
  }

  const isLook = storeType === 'look';
  const { item: running, changed } = group
    ? isLook
      ? onLook(group)
      : onIn(group, storeType)
    : { item: undefined, changed: false };
  const noun = isLook ? 'look' : `${laneName(storeType).toLowerCase()} scene`;
  page.storeNew.disabled = !group;
  page.storeReplace.disabled = !edited;
  page.storeReplace.classList.toggle('is-disabled', !edited);
  page.storeChanges.disabled = !changed;
  page.storeChanges.classList.toggle('is-disabled', !changed);
  page.storeChangesText.textContent = !running
    ? `No ${noun} is on`
    : changed
      ? `Store the changes in "${running.label}"`
      : `"${running.label}" is as it was stored`;

  page.pickedTitle.textContent = edited ? `Picked: ${edited.label}` : 'Nothing picked';
  page.itemRename.disabled = !edited;
  page.itemRename.classList.toggle('is-disabled', !edited);
  page.itemDelete.disabled = !edited;
  page.itemDelete.classList.toggle('is-disabled', !edited);
  const sureOfItem = Boolean(edited) && same(sure, chosen);
  page.itemDelete.classList.toggle('is-warn', sureOfItem);
  page.itemDelete.textContent = sureOfItem ? 'Press again' : 'Delete…';
  page.itemSure.textContent = sureOfItem
    ? `Press again to delete the ${kind} "${edited.label}".`
    : '';

  page.groupTitle.textContent = group ? `Group: ${group.label}` : 'Group';
  // A name that is being typed stays. Otherwise the field follows the name of the group.
  if (document.activeElement !== page.groupRename) page.groupRename.value = group?.label ?? '';
  page.groupRename.disabled = !group;
  page.groupDelete.disabled = !group;
  page.groupDelete.classList.toggle('is-disabled', !group);
  page.groupForm.querySelector('button[type="submit"]').disabled = !group;
  const sureOfGroup =
    Boolean(group) && same(sure, { group: group.id, kind: 'group', id: group.id });
  page.groupDelete.classList.toggle('is-warn', sureOfGroup);
  page.groupDelete.textContent = sureOfGroup ? 'Press again' : 'Delete group';
  if (sureOfGroup) {
    const holds = [
      group.scenes.length > 0 && count(group.scenes.length, 'scene'),
      group.looks.length > 0 && count(group.looks.length, 'look'),
    ].filter(Boolean);
    page.groupSure.textContent = `Press again to delete "${group.label}"${
      holds.length > 0 ? ` and its ${holds.join(' and ')}` : ''
    }.`;
  } else {
    page.groupSure.textContent = '';
  }
}

// ---- the sequences ----

/** The groups that the steps of a sequence name. With one, the steps do not name it. */
function groupsOfSequence(sequence) {
  return new Set(sequence.steps.flatMap((step) => Object.keys(step.looks)));
}

/** What a step sets, in the words of the operator: `Drop` or `Spider: Drop · Room: Welcome`. */
function stepSets(step, plain) {
  return Object.entries(step.looks)
    .map(([group, look]) => {
      const name = look === 'off' ? 'off' : (lookOf(group, look)?.label ?? look);
      return plain ? name : `${groupOf(group)?.label ?? group}: ${name}`;
    })
    .join(' · ');
}

const sequenceTabs = new Map();

function renderSequence() {
  const list = shell.show.sequences ?? [];
  const now = shell.sequence ?? { running: null };
  // The list follows a sequence that starts, here or elsewhere.
  if (now.running !== lastRunning) {
    lastRunning = now.running;
    if (now.running) viewedSequence = now.running;
  }
  if (!list.some((sequence) => sequence.id === viewedSequence)) {
    viewedSequence =
      list.find((sequence) => sequence.id === now.running)?.id ?? list[0]?.id ?? null;
  }
  const sequence = list.find((each) => each.id === viewedSequence);
  const running = Boolean(sequence) && now.running === sequence.id;

  for (const [id, made] of sequenceTabs) {
    if (list.some((each) => each.id === id)) continue;
    made.remove();
    sequenceTabs.delete(id);
  }
  list.forEach((each, index) => {
    let made = sequenceTabs.get(each.id);
    if (!made) {
      made = button('tab', '', () => {
        viewedSequence = each.id;
        renderSequence();
      });
      sequenceTabs.set(each.id, made);
    }
    if (page.sequenceTabs.children[index] !== made) {
      page.sequenceTabs.insertBefore(made, page.sequenceTabs.children[index] ?? null);
    }
    made.textContent = each.label;
    made.classList.toggle('is-sel', each.id === viewedSequence);
    made.classList.toggle('is-running', each.id === now.running);
    made.setAttribute('aria-pressed', String(each.id === viewedSequence));
  });

  page.sequenceNone.hidden = list.length > 0;
  page.sequenceToggle.hidden = list.length === 0;
  page.sequenceNext.hidden = list.length === 0;
  page.sequenceToggle.textContent = running ? 'Stop' : 'Start';
  page.sequenceToggle.classList.toggle('is-on', running);
  page.sequenceToggle.setAttribute('aria-pressed', String(running));
  if (sequence) {
    page.sequenceToggle.setAttribute(
      'aria-label',
      `${running ? 'Stop' : 'Start'} ${sequence.label}`,
    );
  }
  page.sequenceNext.disabled = !now.running;
  page.sequenceNext.classList.toggle('is-disabled', !now.running);

  let state = '';
  let status = '';
  if (sequence) {
    if (running) {
      state = now.paused ? 'waiting' : 'running';
      status = now.paused
        ? `Step ${now.step + 1} of ${now.steps}. Waiting: the music has stopped.`
        : `Step ${now.step + 1} of ${now.steps}, ${count(now.barsLeft, 'bar')} to go.`;
      if (now.problem) status += ` ${sentence(now.problem)}`;
    } else {
      state = now.running ? 'another runs' : 'stopped';
      status = now.running
        ? 'Another sequence runs. Start this one to take its place.'
        : `${sequence.label} is not running.`;
    }
  }
  page.sequenceState.textContent = state;
  page.sequenceStatus.textContent = status;
  // A problem the sequencer reports shows in red, as it did on the old deck.
  page.sequenceStatus.dataset.level = running && now.problem ? 'alarm' : 'note';

  const plain = sequence ? groupsOfSequence(sequence).size <= 1 : true;
  const steps = sequence?.steps ?? [];
  const wanted = JSON.stringify([
    sequence?.id,
    steps.map((step) => [step.bars, stepSets(step, plain)]),
  ]);
  if (page.sequenceSteps.dataset.made !== wanted) {
    page.sequenceSteps.dataset.made = wanted;
    page.sequenceSteps.replaceChildren(
      ...steps.map((step, index) => {
        const item = element('li', 'd-step');
        item.append(
          element('span', 'n', String(index + 1)),
          element('span', 'what', stepSets(step, plain)),
          element('span', 'b'),
        );
        item.title = stepSets(step, plain);
        return item;
      }),
    );
  }
  const place = running ? partPlace(sequence, now) : '';
  [...page.sequenceSteps.children].forEach((item, index) => {
    const isNow = running && index === now.step;
    const isNext = running && steps.length > 1 && index === (now.step + 1) % steps.length;
    item.classList.toggle('is-now', isNow);
    item.classList.toggle('is-next', isNext);
    if (isNow) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
    item.lastElementChild.textContent = isNow
      ? place.split('bar ')[1]
      : String(steps[index]?.bars ?? '');
  });
}

function render() {
  const { show } = shell;
  // What was picked, or asked about, may be gone from the show.
  if (chosen && !chosenItem()) chosen = null;
  if (
    sure &&
    !(sure.kind === 'group'
      ? groupOf(sure.group)
      : sure.kind === 'look'
        ? lookOf(sure.group, sure.id)
        : sceneOf(sure.group, sure.id))
  ) {
    unsure();
  }
  if (!groupOf(groupId)) groupId = show.groups[0]?.id ?? null;
  const group = current();

  const scenes = show.groups.reduce((sum, each) => sum + each.scenes.length, 0);
  const looks = show.groups.reduce((sum, each) => sum + each.looks.length, 0);
  page.where.textContent = programming
    ? 'A press picks a key. Nothing changes on the rig until you store.'
    : [
        count(show.groups.length, 'group'),
        count(scenes, 'scene'),
        count(looks, 'look'),
        show.file ? show.file.split(/[\\/]/).pop() : 'kept until lightdeck stops',
      ].join(' · ');
  page.where.title = show.file ?? '';
  page.programTag.hidden = !programming;
  page.program.hidden = !programming;

  renderNav();
  renderMain(group);
  if (programming) renderProgram(group);
  renderSequence();
}

/**
 * What went wrong on the deck. It has a place of its own, so that it shows whatever the
 * shell has to say about the link to the fixtures.
 */
function renderNotice() {
  const { problem } = shell.show;
  let text = '';
  if (lost) text = 'That press did not reach lightdeck, and it is not sent again. Press again.';
  else if (failure) text = failure;
  else if (problem) {
    text = `The show file has a mistake, so the deck goes on with the show it had. ${sentence(problem)}`;
  }
  setNotice(page.notice, text);
}

async function main() {
  shell = await start({ page: 'deck' });
  if (!shell) return;
  document.title = 'Deck · Lightdeck';

  makeDismissible(page.notice);
  showMode = segmented(
    $('mode'),
    [
      { id: 'show', label: 'Show' },
      { id: 'program', label: 'Program', tone: 'edit' },
    ],
    switchMode,
  );
  recall();
  buildNav();
  buildSide();
  page.prev.addEventListener('click', () => turnPage(-1));
  page.next.addEventListener('click', () => turnPage(1));
  page.off.addEventListener('click', pressOff);
  page.sequenceToggle.addEventListener('click', pressSequence);
  page.sequenceNext.addEventListener('click', pressNext);
  page.storeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    storeNew();
  });
  page.storeReplace.addEventListener('click', () => {
    if (chosen) storeOver(chosen.kind, chosen.id);
  });
  page.storeChanges.addEventListener('click', () => {
    const group = current();
    if (!group) return;
    const { item } = storeType === 'look' ? onLook(group) : onIn(group, storeType);
    if (item) storeOver(storeType === 'look' ? 'look' : 'scene', item.id);
  });
  page.itemRename.addEventListener('click', renameItem);
  page.itemDelete.addEventListener('click', removeItem);
  page.groupForm.addEventListener('submit', (event) => {
    event.preventDefault();
    renameGroup();
  });
  page.groupDelete.addEventListener('click', removeGroup);
  page.makeGroup.addEventListener('submit', makeGroup);
  // The address can also be changed by hand, or by going back.
  window.addEventListener('hashchange', () => {
    if ((location.hash === PROGRAM) !== programming) setProgramming(location.hash === PROGRAM);
  });

  shell.on('show', () => {
    // What was refused was about the show as it was. A press that was lost still is.
    failure = '';
    render();
    renderNotice();
  });
  shell.on('playback', render);
  shell.on('sequence', render);
  programming = location.hash === PROGRAM;
  page.app.dataset.mode = programming ? 'program' : 'show';
  page.prog.classList.toggle('prog', programming);
  showMode(programming ? 'program' : 'show');
  render();
  renderNotice();
}

main();
