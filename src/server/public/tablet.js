// The page for a tablet: choosing a look by its mood, the parts of the evening, and the video wall.
// Plain browser JavaScript, no build step. (Jeroen, 2026-10-20; it is the only page for a tablet since
// 2026-10-23, and has the design of the console (`design/`, mockups 01 and 02) since 2026-10-26.)
//
//   top bar    always there (topbar.js, the same bar as every setup page has): a Menu key that opens the
//              menu sheet (menu.js: the way to every other page, the tempo source and the links with
//              their words, full screen; the key has a dot for each link), the bpm with where the tempo
//              comes from and the beat lamps, Tap, the master with the keys of the master speed, and
//              Blackout
//   rail       a tile per group that has something to play (the spider, the laser, the room) and last
//              the video wall, each with what it shows right now: the lenses of the spider, whether the
//              laser is open, the rails of the room, whether the track text is on
//   moods      the moods of the chosen group and All: which looks are shown. It follows the look that is
//              on, until one is chosen, and a press on a part (the sequence called like a mood, Begin
//              ...) chooses the mood of that name
//   looks      the looks of the chosen mood (`moods:` of the group in the show file; a look says which
//              one it is in with `mood:`) with the colours of its palette; with All every look, mood by
//              mood. The look that is on is lit, Varied once a lane was changed, and the one that the
//              sequence that runs sets next says Next and in how many bars
//   lanes      under the looks, what each lane of the group does right now (lights, colour, motion,
//              zone), and "by hand" when it is not what the look sets
//   tray       at the side (under the looks when the screen is upright), always there: what goes with
//              the mood of the look that is on, as colours, effects, movements and zones, to vary the
//              look with. A press sets that lane of the group and the look shows Varied; the chip of what
//              the look itself sets is dashed. All puts the look back as it was stored, Off darkens the
//              group. Nothing opens over the looks for this
//   parts      at the foot, a key per sequence of the show (Begin, Midden, Techno ...) with a bar per bar
//              of the step that is on: a press starts it and the looks of the spider change by
//              themselves on the bars. Next skips to the next step, Hold stops the sequence and leaves
//              the lights as they are. The room and the laser are not in these sequences: by hand
//   room       on the tab of the room, the dimmer of the lamps and a switch per rail above the looks
//   video wall the tile replaces the looks and the tray by the controls of the video wall
//              (videowallPanel.js, which /videowall has too): what plays, a Blackout key, the library
//              of the player as keys with a preview, the text of the track (On, Test, Clear, Send current
//              track) and, as the fifth tab of the library, Text settings: the address and PIN of the
//              player, the time, lines, filter, colour, size and place of the text. It reads the
//              picture of the wall only while the tab is on screen; the tile in the rail only says
//              whether the track text is on
//
// The page draws what the server says and asks for what the operator wants. A state only swaps classes:
// keys have a fixed size and place whatever state they are in, and notices lie over the foot of the
// screen without taking room, so that nothing moves under a finger. The keys and the lamps of the room
// are made in `tabletParts.js`, `tabletKit.js` and `tabletRail.js`, and what is worked out from the state
// without the browser is in `tabletLogic.js`.
//
// It is an installable app (the manifest and the icons, `manifest.webmanifest` and `icons/`, and
// `sw.js` that keeps the page so that it opens when lightdeck cannot be reached): on the home
// screen of the tablet it opens full screen. See the end of this file for the service worker.

import { mountMenu } from './menu.js';
import { start } from './shell.js';
import { syncKeys } from './tabletKit.js';
import {
  laserOpen,
  nextLook,
  partBars,
  partInfo,
  partPlace,
  roomRails,
  spiderLenses,
  splitNumber,
} from './tabletLogic.js';
import {
  ask,
  buildRoom,
  chipItems,
  clearFailure,
  init,
  laneWords,
  lookItems,
  onIn,
  onLook,
  refreshDimmer,
  registerWorker,
  renderNotice,
  renderRails,
  roomFixture,
  roomGroup,
} from './tabletParts.js';
import { drawTile, makeTile } from './tabletRail.js';
import { mountTopBar } from './topbar.js';
import { $, element } from './ui.js';
import { mountVideoWall } from './videowallPanel.js';

const LANES = ['colour', 'lights', 'motion', 'zone'];
/** What a lane is called in the tray for each kind of fixture. */
const WORDS = {
  spider: { colour: 'Colour', lights: 'Effect', motion: 'Movement', zone: 'Zone' },
  laser: { colour: 'Colour', lights: 'Pattern', motion: 'Movement', zone: 'Zone' },
  room: { colour: 'Colour', lights: 'Scenery', motion: 'Movement', zone: 'Zone' },
};
/** What a lane is called in the strip under the looks. */
const STRIP = {
  spider: { colour: 'Colour', lights: 'Lights', motion: 'Motion', zone: 'Zone' },
  laser: { colour: 'Colour', lights: 'Pattern', motion: 'Motion', zone: 'Zone' },
  room: { colour: 'Colour', lights: 'Scenery', motion: 'Motion', zone: 'Zone' },
};
const REMEMBERED = 'lightdeck.moods.group';
/** What is remembered when the tile of the video wall was the one open. */
const WALL = 'videowall';

let shell;
/** The id of the group that is shown. */
let active = null;
/** Whether the tile of the video wall is the one shown, instead of a group. */
let wallOpen = false;
let wallTile;
let wallPanel;
/** By group, the mood chosen for the looks: its id or `all`. Without one it follows the look that is on. */
const viewChoice = new Map();
/** The tiles of the rail by the id of the group. */
const tiles = new Map();
/** The tabs of the moods by id. */
const moodTabs = new Map();
const looks = { grid: null, none: null, keys: new Map() };
let tray;

// ---- what is shown ----

/** The groups that have something to play: looks or scenes. */
const groupsShown = () =>
  shell.show.groups.filter((group) => group.looks.length > 0 || group.scenes.length > 0);

function remembered() {
  try {
    return localStorage.getItem(REMEMBERED);
  } catch {
    return null;
  }
}

function remember(id) {
  try {
    localStorage.setItem(REMEMBERED, id);
  } catch {
    // Private mode or blocked storage: the page works without.
  }
}

/** The chosen group, or the one to start with when none is or the chosen one is gone. */
function currentGroup() {
  const groups = groupsShown();
  const found =
    groups.find((group) => group.id === active) ??
    groups.find((group) => group.id === remembered()) ??
    groups.find((group) => group.id === 'spider') ??
    groups[0];
  active = found?.id ?? null;
  return found;
}

function kindOf(group) {
  const kinds = new Set(
    group.fixtures.map((id) => shell.fixtures.find((fixture) => fixture.id === id)?.kind),
  );
  return kinds.size === 1 ? [...kinds][0] : undefined;
}

const wordsOf = (group) => WORDS[kindOf(group)] ?? WORDS.spider;

/** Which lanes the group has anything for. */
function lanesOf(group) {
  const has = (type) => group.scenes.some((scene) => scene.type === type);
  return {
    colour: group.palettes !== false,
    lights: true,
    motion: has('motion') || group.moods.some((mood) => mood.motion.length > 0),
    zone: has('zone') || group.moods.some((mood) => mood.zone.length > 0),
  };
}

/** The mood of the look that is on in the group, if the look is in one. */
function moodOn(group) {
  const look = onLook(group).item;
  return look?.mood ? group.moods.find((mood) => mood.id === look.mood) : undefined;
}

/** The moods that have looks. */
const moodsWithLooks = (group) =>
  group.moods.filter((mood) => group.looks.some((look) => look.mood === mood.id));

/** Which mood's looks are shown: the chosen one, else that of the look that is on, else the first. */
function viewOf(group) {
  const moods = moodsWithLooks(group);
  if (moods.length < 2) return 'all';
  const chosen = viewChoice.get(group.id);
  if (chosen === 'all' || moods.some((mood) => mood.id === chosen)) return chosen;
  return moodOn(group)?.id ?? moods[0].id;
}

/** The mood that the tray offers the things of: that of the look that is on, else the one shown. */
function trayMood(group) {
  const on = moodOn(group);
  if (on) return on;
  const view = viewOf(group);
  return view === 'all' ? undefined : group.moods.find((mood) => mood.id === view);
}

/** The looks of a group: those of the mood shown, or a column per mood and then the looks in no mood. */
function lookColumns(group) {
  const view = viewOf(group);
  if (view !== 'all') {
    return [{ id: view, label: '', looks: group.looks.filter((look) => look.mood === view) }];
  }
  const made = group.moods
    .map((mood) => ({
      id: mood.id,
      label: mood.label,
      looks: group.looks.filter((look) => look.mood === mood.id),
    }))
    .filter((column) => column.looks.length > 0);
  const others = group.looks.filter((look) => !look.mood);
  if (others.length > 0) {
    made.push({ id: '', label: made.length > 0 ? 'Other' : '', looks: others });
  }
  return made;
}

/** The sequence that runs, and where it is. */
function runningSequence() {
  const state = shell.sequence;
  const sequence = (shell.show.sequences ?? []).find((each) => each.id === state?.running);
  return { sequence, state };
}

// ---- the rail ----

/** What a tile of the rail shows for a group. */
function tileOf(group) {
  const look = onLook(group);
  const name = look.item ? splitNumber(look.item.label).name : '';
  const room = roomGroup();
  const base = {
    name: group.label,
    selected: !wallOpen && group.id === active,
    lit: Boolean(look.item),
  };
  if (room?.id === group.id) {
    const fixture = roomFixture();
    const dimmer = Math.round(100 * (shell.stateOf(fixture?.id ?? '')?.dimmer ?? 1));
    return {
      kind: 'rails',
      ...base,
      status: name ? `${name} · ${dimmer}` : `Dimmer ${dimmer}`,
      mini: { rails: roomRails(shell.stateOf(fixture?.id ?? ''), fixture?.details?.zones ?? []) },
    };
  }
  const kind = kindOf(group);
  const fixtureId = group.fixtures.find(
    (id) => shell.fixtures.find((fixture) => fixture.id === id)?.kind === kind,
  );
  const fixture = shell.fixtures.find((each) => each.id === fixtureId);
  if (kind === 'laser') {
    const open = fixture ? laserOpen(shell.dmxOf(fixture.id), fixture) : false;
    return {
      kind: 'laser',
      ...base,
      lit: open,
      status: open ? (name ? `Open · ${name}` : 'Open') : 'Closed',
      mini: { open },
    };
  }
  const status = name ? (look.changed ? `${name} ±` : name) : '';
  if (kind === 'spider' && fixture) {
    return {
      kind: 'lenses',
      ...base,
      status,
      mini: { colours: spiderLenses(shell.dmxOf(fixture.id), fixture) },
    };
  }
  return { kind: 'wall', ...base, status };
}

function tileFor(id, kind, onPress) {
  let tile = tiles.get(id);
  if (tile && tile.parts.kind !== kind) {
    tile.remove();
    tiles.delete(id);
    tile = undefined;
  }
  if (!tile) {
    tile = makeTile(kind, onPress);
    tiles.set(id, tile);
  }
  return tile;
}

/** `group` is the group that is shown, or nothing when the tile of the video wall is. */
function renderRail(groups) {
  const holder = $('m-tabs');
  const wanted = new Set(groups.map((each) => each.id));
  for (const [id, tile] of tiles) {
    if (wanted.has(id)) continue;
    tile.remove();
    tiles.delete(id);
  }
  const order = [];
  for (const each of groups) {
    const description = tileOf(each);
    const tile = tileFor(each.id, description.kind, () => choose(each.id));
    drawTile(tile, description);
    order.push(tile);
  }
  // The tile of the video wall is the last one: whether the track text is on is all it says.
  const { settings, shown } = shell.videowall;
  if (!wallTile) wallTile = makeTile('wall', chooseWall);
  drawTile(wallTile, {
    name: 'Video wall',
    status: shown ? 'Text on the wall' : settings.enabled ? 'Track text on' : 'Track text off',
    lit: Boolean(shown || settings.enabled),
    selected: wallOpen,
  });
  order.push(wallTile);
  order.forEach((tile, index) => {
    if (holder.children[index] !== tile) holder.insertBefore(tile, holder.children[index] ?? null);
  });
}

/** The mini outputs of the tiles move with the frames, and are drawn once per screen frame at most. */
let paintLate = false;
function schedulePaint() {
  if (paintLate) return;
  paintLate = true;
  requestAnimationFrame(() => {
    paintLate = false;
    const groups = groupsShown();
    for (const each of groups) {
      const tile = tiles.get(each.id);
      if (!tile) continue;
      const description = tileOf(each);
      if (description.kind !== tile.parts.kind) {
        renderRail(groups);
        return;
      }
      drawTile(tile, description);
    }
  });
}

// ---- drawing ----

/** A key per mood that has looks, and All: which looks are shown. Not there for a group with one mood. */
function renderMoodbar(group) {
  const bar = $('m-moodbar');
  const moods = moodsWithLooks(group);
  bar.hidden = moods.length < 2;
  $('t-where').textContent = `${group.label} · looks`;
  const view = viewOf(group);
  const wanted = [
    ...moods.map((mood) => ({
      id: mood.id,
      label: mood.label,
      count: group.looks.filter((look) => look.mood === mood.id).length,
    })),
    { id: 'all', label: 'All', count: 0 },
  ];
  const ids = new Set(wanted.map(({ id }) => id));
  for (const [id, tab] of moodTabs) {
    if (ids.has(id)) continue;
    tab.remove();
    moodTabs.delete(id);
  }
  wanted.forEach(({ id, label, count }, index) => {
    let tab = moodTabs.get(id);
    if (!tab) {
      tab = element('button', 'tab');
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.append(element('span', 'name'), element('span', 'ct'));
      tab.addEventListener('click', () => {
        viewChoice.set(active, id);
        render();
      });
      moodTabs.set(id, tab);
    }
    if (bar.children[index] !== tab) bar.insertBefore(tab, bar.children[index] ?? null);
    tab.firstElementChild.textContent = label;
    tab.lastElementChild.textContent = count > 0 ? String(count) : '';
    tab.classList.toggle('is-sel', id === view);
    tab.setAttribute('aria-selected', String(id === view));
  });
}

function renderLooks(group) {
  const lookOn = onLook(group).item;
  const { sequence, state } = runningSequence();
  const next = nextLook(sequence, state, group.id, lookOn?.id);
  const items = [];
  for (const column of lookColumns(group)) {
    if (column.label) {
      items.push({
        id: `${group.id}:#${column.id}`,
        make: () => element('div', 'lbl t-grid-head'),
        draw: (head) => {
          head.textContent = column.label;
        },
      });
    }
    items.push(...lookItems(group, { chosen: column.looks, next }));
  }
  syncKeys(looks, items);
  looks.none.hidden = items.length > 0;
  looks.none.textContent = 'No looks yet. Store them on the deck, in Program.';
}

/** What each lane of the group does now; "by hand" when it is not what the look that is on sets. */
function renderLanes(group) {
  const present = lanesOf(group);
  const strip = STRIP[kindOf(group)] ?? STRIP.spider;
  const look = onLook(group).item;
  const own = (type) => (type === 'colour' ? look?.colour?.palette : look?.[type]);
  for (const id of LANES) {
    const cell = $(`t-cell-${id}`);
    cell.hidden = !present[id];
    if (!present[id]) continue;
    const { text, changed, colours } = laneWords(group, id);
    const on = onIn(group, id).item;
    const byHand = Boolean(on && ((look && own(id) !== undefined && own(id) !== on.id) || changed));
    cell.querySelector('[data-name]').textContent = byHand ? `${strip[id]} · by hand` : strip[id];
    const value = cell.querySelector('[data-value]');
    value.textContent = text || (id === 'zone' ? 'None · swing limit' : 'None');
    value.classList.toggle('is-on', Boolean(on));
    const swatches = cell.querySelector('[data-swatches]');
    if (swatches) {
      swatches.replaceChildren(
        ...(colours ?? []).slice(0, 4).map((colour) => {
          const part = element('i', 'sw');
          part.style.background = colour.length > 7 ? colour.slice(0, 7) : colour;
          return part;
        }),
      );
      swatches.hidden = !colours;
    }
  }
}

function renderTray(group) {
  const look = onLook(group).item;
  const mood = trayMood(group);
  const words = wordsOf(group);
  const present = lanesOf(group);
  $('m-tray-hint').textContent = look ? `with ${look.label}` : 'press a look';
  for (const id of LANES) {
    $(`m-lane-${id}`).hidden = !present[id];
    $(`m-name-${id}`).textContent = words[id];
    // A group whose look is in no mood, or with no mood at all, offers everything it has.
    syncKeys(tray[id], present[id] ? chipItems(group, id, mood?.[id]) : []);
  }
  $('m-all').disabled = !look;
  $('m-all').classList.toggle('is-disabled', !look);
  $('m-all').setAttribute('aria-label', look ? `Put ${look.label} back as it was stored` : 'All');
  $('m-off').setAttribute('aria-label', `${group.label} lights off`);
}

/** The lamps of the room have a dimmer and switches per rail, on the tab of the room. */
function renderRoom(group) {
  const room = roomGroup();
  const here = room !== undefined && room.id === group.id;
  $('t-room').hidden = !here;
  if (here) {
    renderRails();
    refreshDimmer();
  }
}

/** The video wall takes the place of the looks and the tray: the page has two states. */
function setWallShown(open) {
  $('t-main').hidden = open;
  $('m-tray').hidden = open;
  $('m-wall').hidden = !open;
  $('t-body').dataset.wall = String(open);
}

function render() {
  const groups = groupsShown();
  const group = currentGroup();
  renderRail(groups);
  renderWall();
  if (wallOpen) {
    setWallShown(true);
    return;
  }
  setWallShown(false);
  if (!group) {
    for (const key of looks.keys.values()) key.remove();
    looks.keys.clear();
    $('m-moodbar').hidden = true;
    $('t-where').textContent = '';
    looks.none.hidden = false;
    looks.none.textContent = 'There is nothing to play in the show yet. Make it on the deck.';
    $('t-lanes').hidden = true;
    $('t-room').hidden = true;
    $('m-tray').hidden = true;
    return;
  }
  $('t-lanes').hidden = false;
  renderMoodbar(group);
  renderLooks(group);
  renderLanes(group);
  renderTray(group);
  renderRoom(group);
}

/** The controls of the video wall are made the first time the tile is shown. */
function renderWall() {
  if (wallOpen) {
    wallPanel ??= mountVideoWall($('m-wall'), { shell, ask });
    wallPanel.activate();
  } else {
    wallPanel?.deactivate();
  }
}

// ---- the parts of the evening ----

const phases = { grid: null, none: null, keys: new Map() };

/** The label of the look that a step sets in a group, or what the step says when it is not one. */
function stepWords(step) {
  const parts = [];
  for (const [groupId, lookId] of Object.entries(step?.looks ?? {})) {
    const group = shell.show.groups.find((each) => each.id === groupId);
    const look = group?.looks.find((each) => each.id === lookId);
    // The group is named only when the step sets several.
    const name = look ? splitNumber(look.label).name : lookId === 'off' ? 'Off' : lookId;
    parts.push(Object.keys(step.looks).length > 1 ? `${group?.label ?? groupId} ${name}` : name);
  }
  return parts.join(' · ');
}

/**
 * Shows what a part does: the tile of the group its first step sets, with the looks of the mood that
 * has the id of the sequence (Begin, Midden, Techno), when there is one.
 */
function showPart(sequence) {
  const groupId = Object.keys(sequence.steps[0]?.looks ?? {})[0];
  const group = shell.show.groups.find((each) => each.id === groupId);
  if (!group || !groupsShown().includes(group)) return;
  if (group.moods.some((mood) => mood.id === sequence.id)) viewChoice.set(group.id, sequence.id);
  if (active !== group.id || wallOpen) {
    active = group.id;
    wallOpen = false;
    remember(group.id);
  }
  render();
}

/** The key of a part: its name and where it is, what is on and what comes, and a bar per bar. */
function makePart(sequence) {
  const key = element('button', 'part');
  key.type = 'button';
  const name = element('span', 'nm', sequence.label);
  const place = element('span', 'num place');
  const info = element('span', 'info');
  const bars = element('div', 'bars');
  const head = element('div', 'row');
  head.style.justifyContent = 'space-between';
  head.append(name, place);
  key.append(head, info, bars);
  key.parts = { place, info, bars };
  key.addEventListener('click', () => {
    // A press on the part that runs does nothing: stopping is what Hold is for.
    if (shell.sequence?.running !== sequence.id) ask('/api/sequence', { start: sequence.id });
    showPart(sequence);
  });
  return key;
}

function drawPart(key, sequence, state) {
  const on = state.running === sequence.id;
  const { place, info, bars } = key.parts;
  key.classList.toggle('is-on', on);
  key.setAttribute('aria-pressed', String(on));
  place.textContent = on ? partPlace(sequence, state) : '';
  if (on) {
    const next = sequence.steps[(state.step + 1) % sequence.steps.length];
    const soon = `${stepWords(next)} in ${state.barsLeft}`;
    const extra = state.paused
      ? ' · waiting for the music'
      : state.problem
        ? ` · ${state.problem}`
        : '';
    // The wide key says what is on and what comes; the narrow one (a tablet upright) says where it is.
    const wide = element('span', 'wide');
    wide.append(`Now ${stepWords(sequence.steps[state.step])} → `, element('b', '', soon), extra);
    const narrow = element('span', 'narrow');
    narrow.append(`${state.step + 1}/${sequence.steps.length} · `, element('b', '', soon));
    info.replaceChildren(wide, narrow);
  } else {
    const wide = element('span', 'wide', partInfo(sequence));
    const narrow = element('span', 'narrow', `${sequence.steps.length} steps`);
    info.replaceChildren(wide, narrow);
  }
  const wanted = partBars(sequence, state);
  const signature = wanted.join(',');
  if (bars.dataset.signature === signature) return;
  bars.dataset.signature = signature;
  if (bars.children.length !== wanted.length) {
    bars.replaceChildren(...wanted.map(() => element('i')));
  }
  wanted.forEach((mark, index) => {
    bars.children[index].className = mark;
  });
}

/** A key per sequence, what is on and what comes, and Next and Hold. */
function renderPhases() {
  phases.grid ??= $('m-phase-keys');
  const list = shell.show.sequences ?? [];
  $('m-phases').hidden = list.length === 0;
  const state = shell.sequence ?? { running: null };
  const running = list.find((sequence) => sequence.id === state.running);
  syncKeys(
    phases,
    list.map((sequence) => ({
      id: sequence.id,
      make: () => makePart(sequence),
      draw: (key) => drawPart(key, sequence, state),
    })),
  );
  for (const id of ['m-next', 'm-hold']) {
    $(id).disabled = !running;
    $(id).classList.toggle('is-disabled', !running);
  }
  // What a look says is Next follows the sequence, so the looks are drawn again.
  const group = currentGroup();
  if (group && !wallOpen) renderLooks(group);
}

// ---- pressing ----

function choose(id) {
  if (id === active && !wallOpen) return;
  active = id;
  wallOpen = false;
  remember(id);
  render();
}

function chooseWall() {
  if (wallOpen) return;
  wallOpen = true;
  remember(WALL);
  render();
}

function build() {
  looks.grid = $('m-grid');
  looks.none = $('m-looks-none');
  tray = Object.fromEntries(
    LANES.map((id) => [id, { grid: $(`m-keys-${id}`), none: null, keys: new Map() }]),
  );
  $('m-off').addEventListener('click', () => {
    if (active) ask('/api/playback', { group: active, off: true });
  });
  // All puts the look back as it was stored: pressing it again sets every lane it names.
  $('m-all').addEventListener('click', () => {
    const group = currentGroup();
    const look = group ? onLook(group).item : undefined;
    if (group && look) ask('/api/playback', { group: group.id, look: look.id });
  });
  $('m-next').addEventListener('click', () => ask('/api/sequence', { next: true }));
  $('m-hold').addEventListener('click', () => ask('/api/sequence', { stop: true }));
}

async function main() {
  shell = await start({ page: 'tablet', bare: true });
  if (!shell) return;
  init(shell);
  wallOpen = remembered() === WALL;

  // The top bar, with a Menu key that opens the menu sheet over the page (the same bar that every setup
  // page has, with a Live key). The notice of the shell is in the stack of the page, over the keys.
  const bar = mountTopBar(shell, { left: 'menu' });
  mountMenu(shell, bar);
  buildRoom();
  build();

  shell.on('show', () => {
    clearFailure();
    render();
    renderPhases();
    renderNotice();
  });
  shell.on('playback', render);
  // The tile of the video wall says whether the text is on.
  shell.on('videowall', () => renderRail(groupsShown()));
  shell.on('sequence', renderPhases);
  // The dimmer of the room is set from another screen too, and the lenses and the rails move on.
  shell.on('fixtures', () => {
    refreshDimmer();
    renderRails();
    schedulePaint();
  });
  shell.on('frames', schedulePaint);
  render();
  renderPhases();
  renderNotice();
}

main();
registerWorker();
