// The other page for a tablet: choosing a look by its mood. Plain browser JavaScript, no build step.
// (Jeroen, 2026-10-20.)
//
//   top row    a Menu key (a small menu over the page: the main view, the other tablet page, full
//              screen and the link lamps with their words; the key has one dot, green when all is
//              connected and red when a link is down), the bpm with the beat lamps and a Tap key, the master with the keys of the master speed,
//              and a small blackout key
//   parts      a key per sequence of the show (Begin, Midden, Techno ...): a press starts it and the
//              looks of the spider change by themselves on the bars. A line says which look is on and
//              which comes next and when. Next skips to the next step, Hold stops the sequence and leaves
//              the lights as they are. The room and the laser are not in these sequences: by hand
//   (tempo)    the Tap key is in the top row, as on the other page
//   tabs       a key per group that has something to play (the spider, the laser, the room), with the
//              look that is on in it
//   moods      a row of keys for the moods of the chosen group and All: which looks are shown. It follows
//              the look that is on, until one is chosen, and a press on a part (the sequence called
//              like a mood, Begin ...) chooses the mood of that name
//   looks      the looks of the chosen mood (`moods:` of the group in the show file; a look says which
//              one it is in with `mood:`), or with All a column per mood, each with the colours of its palette
//   tray       under the looks, always there: what goes with the mood of the look that is on, as
//              colours, effects and movements, to vary the look with. A press sets that lane of the
//              group and the look shows "Varied". Nothing opens over the looks for this
//   All        a sheet over the looks with every scene and palette of the group, for what no mood has
//   room       on the tab of the room, the dimmer of the lamps and a switch per rail in the tray
//
// The page draws what the server says and asks for what the operator wants. Keys have a fixed size
// and place whatever state they are in, and notices lie over the bottom of the screen without
// taking room, so that nothing moves under a finger. What it shares with the other page is in
// `tabletParts.js` and `tabletKit.js`.

import { start } from './shell.js';
import { drawKey, makeKey, syncKeys } from './tabletKit.js';
import {
  ask,
  buildFullscreen,
  buildMaster,
  buildMenu,
  buildRoom,
  buildTempo,
  clearFailure,
  init,
  lookItems,
  onLook,
  paletteItems,
  refreshDimmer,
  registerWorker,
  renderChange,
  renderLinks,
  renderNotice,
  renderRails,
  roomGroup,
  sceneItems,
  setRoomOff,
  startBeat,
} from './tabletParts.js';
import { $, element } from './ui.js';

const LANES = ['colour', 'lights', 'motion'];
/** What a lane is called for each kind of fixture. */
const WORDS = {
  spider: { colour: 'Colour', lights: 'Effect', motion: 'Movement' },
  laser: { colour: 'Colour', lights: 'Pattern', motion: 'Movement' },
  room: { colour: 'Colour', lights: 'Scenery', motion: 'Movement' },
};
/** What a look says once a lane of it was changed: here that is what the tray is for. */
const VARIED = 'Varied';
const REMEMBERED = 'lightdeck.moods.group';

let shell;
/** The id of the group that is shown. */
let active = null;
let sheetOpen = false;
/** By group, the mood chosen for the looks: its id or `all`. Without one it follows the look that is on. */
const viewChoice = new Map();
/** The tabs by the id of the group. */
const tabs = new Map();
/** The columns of looks, by group and mood. */
const columns = new Map();
const lane = (prefix, id) => ({
  grid: $(`${prefix}-${id}`),
  none: null,
  keys: new Map(),
});
let tray;
let sheet;

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
  };
}

/** The mood of the look that is on in the group, if the look is in one. */
function moodOn(group) {
  const look = onLook(group).item;
  return look?.mood ? group.moods.find((mood) => mood.id === look.mood) : undefined;
}

/** Which mood's looks are shown: the chosen one, else that of the look that is on, else the first. */
function viewOf(group) {
  const moods = group.moods.filter((mood) => group.looks.some((look) => look.mood === mood.id));
  if (moods.length < 2) return 'all';
  const chosen = viewChoice.get(group.id);
  if (chosen === 'all' || moods.some((mood) => mood.id === chosen)) return chosen;
  return moodOn(group)?.id ?? moods[0].id;
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

/** The keys of a lane for the group: of the ids a mood lists, or all when there is no list. */
function itemsOf(group, laneId, ids) {
  return laneId === 'colour' ? paletteItems(group, ids) : sceneItems(group, laneId, ids);
}

// ---- drawing ----

function renderTabs(groups, group) {
  const holder = $('m-tabs');
  const wanted = new Set(groups.map((each) => each.id));
  for (const [id, tab] of tabs) {
    if (wanted.has(id)) continue;
    tab.remove();
    tabs.delete(id);
  }
  groups.forEach((each, index) => {
    let tab = tabs.get(each.id);
    if (!tab) {
      tab = element('button', 'm-tab');
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.append(element('span', 'm-tab-name'), element('span', 'm-tab-look'));
      tab.addEventListener('click', () => choose(each.id));
      tabs.set(each.id, tab);
    }
    if (holder.children[index] !== tab) holder.insertBefore(tab, holder.children[index] ?? null);
    tab.firstElementChild.textContent = each.label;
    tab.lastElementChild.textContent = onLook(each).item?.label ?? '';
    tab.setAttribute('aria-selected', String(each.id === group.id));
  });
  holder.hidden = groups.length < 2;
}

/** A key per mood that has looks, and All: which looks are shown. Not there for a group with one mood. */
function renderMoodbar(group) {
  const bar = $('m-moodbar');
  const moods = group.moods.filter((mood) => group.looks.some((look) => look.mood === mood.id));
  bar.hidden = moods.length < 2;
  const view = viewOf(group);
  const wanted = [
    ...moods.map((mood) => ({ id: mood.id, label: mood.label })),
    { id: 'all', label: 'All' },
  ];
  bar.replaceChildren(
    ...wanted.map(({ id, label }) => {
      const key = element('button', 'm-mood-key', label);
      key.type = 'button';
      key.setAttribute('aria-pressed', String(id === view));
      key.addEventListener('click', () => {
        viewChoice.set(group.id, id);
        render();
      });
      return key;
    }),
  );
}

function renderLooks(group) {
  const holder = $('m-moods');
  holder.dataset.single = String(viewOf(group) !== 'all');
  const wanted = lookColumns(group);
  const ids = new Set(wanted.map((column) => `${group.id}:${column.id}`));
  for (const [id, column] of columns) {
    if (ids.has(id)) continue;
    column.section.remove();
    columns.delete(id);
  }
  const mood = moodOn(group);
  const lookOn = onLook(group).item;
  wanted.forEach((column, index) => {
    const id = `${group.id}:${column.id}`;
    let made = columns.get(id);
    if (!made) {
      const section = element('section', 'm-mood');
      const head = element('h3', 'm-mood-head');
      const grid = element('div', 'm-mood-looks');
      section.append(head, grid);
      made = { section, head, looks: { grid, none: null, keys: new Map() } };
      columns.set(id, made);
    }
    if (holder.children[index] !== made.section) {
      holder.insertBefore(made.section, holder.children[index] ?? null);
    }
    made.head.textContent = column.label;
    made.head.hidden = column.label === '';
    // The column of the look that is on is lit, whether it is in a mood or not.
    made.section.dataset.on = String(
      lookOn !== undefined && column.looks.some((look) => look.id === lookOn.id),
    );
    made.section.dataset.mood = String(mood?.id === column.id);
    syncKeys(
      made.looks,
      lookItems(group, { chosen: column.looks, strip: true, changedText: VARIED }),
    );
  });
  const none = $('m-looks-none');
  none.hidden = wanted.length > 0;
  none.textContent = 'No looks yet. Store them on the deck, in Program.';
}

function renderTray(group) {
  const look = onLook(group).item;
  const mood = moodOn(group);
  const words = wordsOf(group);
  const present = lanesOf(group);
  $('m-tray-title').textContent = mood ? mood.label : 'Vary';
  $('m-tray-hint').textContent = !look
    ? 'Press a look to see what goes with it.'
    : mood
      ? `Goes with ${look.label}.`
      : `${look.label} is in no mood. All has everything.`;
  for (const id of LANES) {
    $(`m-lane-${id}`).hidden = !present[id];
    $(`m-name-${id}`).textContent = words[id];
    syncKeys(tray[id], present[id] && mood ? itemsOf(group, id, mood[id]) : []);
  }
  $('m-off').setAttribute('aria-label', `${group.label} lights off`);
}

function renderSheet(group) {
  const present = lanesOf(group);
  $('m-sheet').hidden = !sheetOpen;
  $('m-all').setAttribute('aria-expanded', String(sheetOpen));
  $('m-sheet-title').textContent = `All of ${group.label}`;
  const words = wordsOf(group);
  for (const id of LANES) {
    $(`m-sheet-lane-${id}`).hidden = !present[id];
    $(`m-sheet-name-${id}`).textContent = words[id];
    syncKeys(sheet[id], sheetOpen && present[id] ? itemsOf(group, id) : []);
  }
}

/** The lamps of the room have a dimmer and switches per rail, on the tab of the room. */
function renderRoom(group) {
  const room = roomGroup();
  const here = room !== undefined && room.id === group.id;
  $('t-room').hidden = !here;
  setRoomOff(here ? room.id : null);
  if (here) {
    renderRails();
    refreshDimmer();
  }
}

function render() {
  const groups = groupsShown();
  const group = currentGroup();
  if (!group) {
    $('m-tabs').hidden = true;
    $('m-moods').replaceChildren();
    columns.clear();
    $('m-looks-none').hidden = false;
    $('m-looks-none').textContent =
      'There is nothing to play in the show yet. Make it on the deck.';
    $('m-tray').hidden = true;
    $('m-sheet').hidden = true;
    return;
  }
  $('m-tray').hidden = false;
  renderTabs(groups, group);
  renderMoodbar(group);
  renderLooks(group);
  renderTray(group);
  renderSheet(group);
  renderRoom(group);
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
    const name = look?.label ?? (lookId === 'off' ? 'Off' : lookId);
    parts.push(Object.keys(step.looks).length > 1 ? `${group?.label ?? groupId} ${name}` : name);
  }
  return parts.join(' · ');
}

const barsText = (bars) => (bars === 1 ? '1 bar' : `${bars} bars`);

/**
 * Shows what a part does: the tab of the group its first step sets, with the looks of the mood that
 * has the id of the sequence (Begin, Midden, Techno), when there is one.
 */
function showPart(sequence) {
  const groupId = Object.keys(sequence.steps[0]?.looks ?? {})[0];
  const group = shell.show.groups.find((each) => each.id === groupId);
  if (!group || !groupsShown().includes(group)) return;
  if (group.moods.some((mood) => mood.id === sequence.id)) viewChoice.set(group.id, sequence.id);
  if (active !== group.id) {
    active = group.id;
    remember(group.id);
    sheetOpen = false;
  }
  render();
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
      make: () =>
        makeKey('scene phase', () => {
          // A press on the part that runs does nothing: stopping is what Hold is for.
          if (shell.sequence?.running !== sequence.id) {
            ask('/api/sequence', { start: sequence.id });
          }
          showPart(sequence);
        }),
      draw: (key) => {
        const on = state.running === sequence.id;
        drawKey(key, {
          state: on ? 'set' : 'idle',
          label: sequence.label,
          sets: on ? `Step ${state.step + 1} of ${state.steps}` : `${sequence.steps.length} steps`,
        });
      },
    })),
  );
  $('m-next').disabled = !running;
  $('m-hold').disabled = !running;
  let text = 'Press a part, and the looks change by themselves.';
  if (running) {
    const next = running.steps[(state.step + 1) % running.steps.length];
    const now = stepWords(running.steps[state.step]);
    text = `Now ${now} · next ${stepWords(next)} in ${barsText(state.barsLeft)}`;
    if (state.paused) text += ' · waiting for the music';
    if (state.problem) text += ` · ${state.problem}`;
  }
  $('m-phase-status').textContent = text;
}

// ---- pressing ----

function choose(id) {
  if (id === active) return;
  active = id;
  remember(id);
  sheetOpen = false;
  render();
}

function build() {
  tray = Object.fromEntries(LANES.map((id) => [id, lane('m-keys', id)]));
  sheet = Object.fromEntries(LANES.map((id) => [id, lane('m-sheet-keys', id)]));
  $('m-off').addEventListener('click', () => {
    if (active) ask('/api/playback', { group: active, off: true });
  });
  const toggle = (open) => {
    sheetOpen = open;
    render();
  };
  $('m-next').addEventListener('click', () => ask('/api/sequence', { next: true }));
  $('m-hold').addEventListener('click', () => ask('/api/sequence', { stop: true }));
  $('m-all').addEventListener('click', () => toggle(!sheetOpen));
  $('m-close').addEventListener('click', () => toggle(false));
}

async function main() {
  shell = await start({ page: 'moods', bare: true });
  if (!shell) return;
  init(shell);
  // The notice of the shell joins the one of the page, where it takes no room from the keys.
  $('notices').prepend($('notice'));

  buildMaster();
  buildRoom();
  buildTempo();
  buildFullscreen();
  buildMenu();
  build();

  shell.on('show', () => {
    clearFailure();
    render();
    renderPhases();
    renderNotice();
  });
  shell.on('playback', render);
  shell.on('sequence', renderPhases);
  // The dimmer of the room is set from another screen too.
  shell.on('fixtures', () => {
    refreshDimmer();
    renderRails();
  });
  shell.on('change', renderChange);
  shell.on('status', renderLinks);
  renderChange();
  renderLinks();
  render();
  renderPhases();
  renderNotice();
  startBeat();
}

main();
registerWorker();
