// The deck: the groups of the show with what can be set on them. Plain browser JavaScript, no
// build step.
//
// A group is a set of fixtures. Every group has a row here with a row of looks and a lane per
// type: Lights, Colour and Motion.
//
//   Lights, Motion   the scenes of the group, a key per scene. A scene is a part of what the
//                    fixtures of its group do, of that type only. The lane of the lights has
//                    the key for off, which darkens the fixtures and leaves their colours and
//                    their motion as they are.
//   Colour           the palettes of the show, a key per palette, the same in every group. A
//                    palette belongs to no group and is made on the Palettes page. A group
//                    whose fixtures have colours of their own (the laser) takes no palettes,
//                    and its lane says so.
//   Looks            a look of the group sets a scene of lights, a palette and a scene of
//                    motion together; a lane it does not name is left alone.
//
// One thing per lane is on, so several are on at once, each for its own fixtures and its own
// properties: a palette is pressed under a chase and the chase goes on in the new colours. A
// look that is on shows it as well, and it shows as changed when a lane it set is not what it
// set any more.
//
// Sequences (when the show has any, written in the show file by hand): a sequence changes the
// looks of the groups by itself, a step after the other, on the bars of the tempo, so that the
// spider can go through its looks while the room keeps its own. A press on its key starts it
// (and stops the one that runs); a press on it again stops it and leaves the fixtures as they
// are. A press by hand on a look or a scene stands until the next step that changes that group.
// Its steps are drawn as a row of chips, the one that is on marked, and a line below says where
// it is. That line is always there, so that nothing moves when a sequence starts or stops.
//
// The deck has two modes, and the address remembers which (#program):
//
//   Show      what the page opens in. A press sets what its key names on the fixtures of its
//             group, a press on Off darkens them. There is nothing to type and nothing that
//             deletes, and no key changes size or place when something goes on or off.
//   Program   storing, naming and deleting, of scenes, looks and groups. A press on a scene or
//             a look chooses it, and the fixtures stay as they are. A palette key does
//             nothing there: the palettes are edited on their own page, which Program links to.
//
// Storing takes the properties of the chosen type from the fixtures of the group as they are
// now, so a scene is made on the pages of the fixtures and kept here. A look takes what is on
// in the group now: the scene of lights, the palette and the scene of motion. The server
// refuses a look when nothing is on or a lane was changed by hand, and says so.
//
// The deck draws what the server says: the groups of the show, the palettes, which scene or
// palette is on in each lane of each group, which look, and whether its fixtures were changed
// by hand since. It asks for what the operator wants and waits for the answer to come by as an
// event. A press is asked once: when it does not reach lightdeck the deck says so and the
// operator presses again.
//
// The deck also has the fader of the master, in Show and in Program. The master is for
// the whole console and no part of a scene: moving it changes no scene, and a scene
// does not move it. The shell keeps it and sends it, and shows its level on every page.
// Next to it are the keys of the master speed, which works the same way for the speed
// of the effects: every effect runs at its own speed times the master speed.
//
// Tempo and blackout are in the shell. Its notice is kept at the bottom of the
// screen here, with the one of the deck, so that no key moves when it comes or goes.

import { masterPercent, start } from './shell.js';
import { $, button, element, sentence, slider, speedKeys, speedName } from './ui.js';

/** How long a delete key waits for the second press. */
const SURE_MS = 3000;
/** What the address ends in while the deck is in Program. */
const PROGRAM = '#program';
const NAME_LENGTH = 40;
/** The types of the lanes of a row, in order. Colour holds palettes, the others scenes. */
const TYPES = [
  { id: 'lights', name: 'Lights', hint: 'What is on, and what it does' },
  { id: 'colour', name: 'Colour', hint: 'The palette: the colours the effects use' },
  { id: 'motion', name: 'Motion', hint: 'How the bars and the beam move' },
];
/** The looks come before the lanes of the types, in a lane of their own. */
const LOOKS = { id: 'look', name: 'Looks', hint: 'Lights, colour and motion together' };
/** What Program can store: a scene of lights, a scene of motion, or a look. No colour. */
const STORABLE = [TYPES[0], TYPES[2], { ...LOOKS, name: 'Look' }];
const typeName = (id) => TYPES.find((type) => type.id === id)?.name ?? id;
const NO_PALETTES = "This group's fixtures have colours of their own. Set them on their page.";

/**
 * What the page has from the start. It is found once, by ids that no row can have: the
 * ids in a row are made with dots, which the id of a group cannot hold.
 */
const page = {
  where: $('where'),
  mode: $('mode'),
  hint: $('deck-hint'),
  master: $('grand-master'),
  speed: $('master-speed'),
  groups: $('groups'),
  sequencePanel: $('sequences'),
  sequences: $('sequence-list'),
  newGroup: $('new-group'),
  makeGroup: $('make-group'),
  groupName: $('group-name'),
  groupFixtures: $('group-fixtures'),
  notices: $('notices'),
  notice: $('deck-notice'),
};

let shell;
/** While true, a press on a scene or a look chooses it to edit and the fixtures stay as they are. */
let programming = false;
/** The scene or look chosen to edit, as { group, kind: 'scene' | 'look', id }. */
let chosen = null;
/** What a delete key was pressed for once, as { group, kind: 'scene' | 'look' | 'group', id }. */
let sure = null;
let sureTimer;
/** What the server answered to what could not be done. */
let failure = '';
/** True when the last press did not reach lightdeck. It is not sent again. */
let lost = false;
/** By the id of a group, the row that was built for it. */
const rows = new Map();
/** By the id of a sequence, the row that was built for it. */
const sequenceRows = new Map();
/** The fader of the master. */
let fader;
/** Shows which master speed is chosen. */
let showSpeed = () => {};

const groupOf = (id) => shell.show.groups.find((group) => group.id === id);
const sceneOf = (group, id) => groupOf(group)?.scenes.find((scene) => scene.id === id);
const lookOf = (group, id) => groupOf(group)?.looks.find((look) => look.id === id);
const paletteOf = (id) => palettes().find((palette) => palette.id === id);
const palettes = () => shell.show.palettes ?? [];
const labelOf = (id) => shell.fixtures.find((fixture) => fixture.id === id)?.label ?? id;
const same = (one, other) =>
  one !== null && one.group === other.group && one.kind === other.kind && one.id === other.id;
const count = (number, word) => (number === 1 ? `1 ${word}` : `${number} ${word}s`);
/** The scene or look that is chosen, when it is still there. */
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

/** What a scene sets, where that says more than the row does already. */
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
  return parts.join(' · ');
}

/** What a palette does besides showing its colours, in a few words. */
function movesOf(palette) {
  if (palette.mode !== 'cycle') return '';
  return palette.change === 'fade' ? 'Cycles, fades' : 'Cycles, steps';
}

/** A colour of a palette as CSS, or null for a dark slot. White is added to all three. */
function chipColour(value) {
  const parsed = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(value);
  if (!parsed) return null;
  const [red = 0, green = 0, blue = 0, white = 0] = parsed
    .slice(1)
    .map((part) => (part ? Number.parseInt(part, 16) : 0));
  const mix = (light) => Math.min(255, light + white);
  return `rgb(${mix(red)} ${mix(green)} ${mix(blue)})`;
}

async function ask(url, body) {
  const answer = await shell.ask(url, body);
  lost = Boolean(answer.lost);
  failure = answer.ok || lost ? '' : sentence(answer.error);
  renderNotice();
  return answer;
}

// ---- what the operator does ----

function pressScene(group, id) {
  if (programming)
    return choose(same(chosen, { group, kind: 'scene', id }) ? null : { group, kind: 'scene', id });
  ask('/api/playback', { group, scene: id });
}

function pressLook(group, id) {
  if (programming)
    return choose(same(chosen, { group, kind: 'look', id }) ? null : { group, kind: 'look', id });
  ask('/api/playback', { group, look: id });
}

/** Palettes are edited on their page. In Program their keys do nothing. */
function pressPalette(group, id) {
  if (!programming) ask('/api/playback', { group, palette: id });
}

function pressSequence(id) {
  const { running } = shell.sequence ?? {};
  ask('/api/sequence', running === id ? { stop: true } : { start: id });
}
function pressOff(group) {
  if (!programming) ask('/api/playback', { group, off: true });
}

function choose(what) {
  chosen = what;
  unsure();
  render();
}

function setProgramming(on) {
  programming = on;
  failure = '';
  choose(null);
  renderNotice();
}

function switchMode() {
  const on = !programming;
  history.replaceState(null, '', on ? PROGRAM : location.pathname + location.search);
  setProgramming(on);
}

async function storeNew(group, field) {
  const type = rows.get(group)?.type ?? STORABLE[0].id;
  const answer =
    type === 'look'
      ? await ask(`/api/groups/${group}/looks`, { label: field.value })
      : await ask(`/api/groups/${group}/scenes`, { label: field.value, type });
  if (answer.ok) field.value = '';
  return answer.ok;
}

function storeOver(id) {
  const group = groupOf(id);
  const type = rows.get(id)?.type;
  if (!group || !type) return;
  const { item } = type === 'look' ? onLook(group) : onIn(group, type);
  if (!item) return;
  ask(`/api/groups/${id}/${type === 'look' ? 'looks' : 'scenes'}/${item.id}/store`);
}

/** The address of the chosen scene or look, on the server. */
function chosenUrl(group, action) {
  const kind = chosen.kind === 'look' ? 'looks' : 'scenes';
  return `/api/groups/${group}/${kind}/${chosen.id}/${action}`;
}

async function renameItem(group, label) {
  if (chosen?.group !== group) return false;
  return (await ask(chosenUrl(group, 'rename'), { label })).ok;
}

async function renameGroup(group, label) {
  return (await ask(`/api/groups/${group}/rename`, { label })).ok;
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

function removeItem(group) {
  if (chosen?.group !== group) return;
  remove({ ...chosen }, chosenUrl(group, 'delete'));
}

function removeGroup(group) {
  remove({ group, kind: 'group', id: group }, `/api/groups/${group}/delete`);
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

// ---- building ----

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
    // A field that follows a name shows it as it was stored.
    render();
  });
  return { form, field, submit, name };
}

function block(title, ...parts) {
  const made = element('section', 'block');
  const head = element('h3', '', title);
  made.append(head, ...parts);
  return { made, head };
}

/** The keys that say what is stored: a scene of lights, a scene of motion, or a look. */
function buildTypeKeys(row) {
  const fieldset = element('fieldset', 'choice type-choice');
  fieldset.append(element('legend', '', 'What to store'));
  row.typeKeys = STORABLE.map(({ id, name, hint }) => {
    const made = button('pick', name, () => {
      row.type = id;
      render();
    });
    made.title = hint;
    fieldset.append(made);
    return { id, made };
  });
  return fieldset;
}

/** What Program adds to the row of a group: storing, the chosen scene or look, the group itself. */
function buildProgram(row) {
  const { id } = row;
  row.storeNew = nameRow({
    id: `row.${id}.new`,
    label: 'Name of the new scene',
    key: 'Store',
    done: () => storeNew(id, row.storeNew.field),
  });
  row.storeOver = button('key wide', '', () => storeOver(id));
  const store = block(
    'Store what the fixtures do',
    buildTypeKeys(row),
    row.storeNew.form,
    row.storeOver,
  );

  row.rename = nameRow({
    id: `row.${id}.scene`,
    label: 'Name',
    key: 'Rename',
    done: (label) => renameItem(id, label),
  });
  row.remove = button('key wide delete', '', () => removeItem(id));
  const scene = block('Scene', row.rename.form, row.remove);
  row.sceneTitle = scene.head;

  row.renameGroup = nameRow({
    id: `row.${id}.name`,
    label: 'Name',
    key: 'Rename',
    done: (label) => renameGroup(id, label),
  });
  row.removeGroup = button('key wide delete', '', () => removeGroup(id));
  const group = block('Group', row.renameGroup.form, row.removeGroup);
  row.groupTitle = group.head;

  const program = element('div', 'group-program');
  program.append(store.made, scene.made, group.made);
  return program;
}

/**
 * One lane of a row: the name of the lane, its keys, and what it says when it has none. The
 * lane of the lights has Off at its end, the lane of the colour the link to the palettes. The
 * place is there in every lane, so that the keys line up.
 */
function buildLane(row, type) {
  const lane = { type: type.id, keys: new Map() };
  lane.section = element('div', 'lane');
  lane.section.dataset.lane = type.id;
  lane.section.setAttribute('role', 'group');
  lane.name = element('span', 'lane-name', type.name);
  lane.name.title = type.hint;
  lane.grid = element('div', 'scene-grid');
  lane.none = element('p', 'hint');
  const keys = element('div', 'lane-scenes');
  keys.append(lane.none, lane.grid);
  lane.section.append(lane.name, keys);
  const end = element('div', 'lane-end');
  if (type.id === 'lights') {
    row.off = button('scene off', 'Off', () => pressOff(row.id));
    end.append(row.off);
  }
  if (type.id === 'colour') {
    lane.edit = element('a', 'edit-palettes', 'Edit palettes');
    lane.edit.href = '/palettes';
    end.append(lane.edit);
  }
  lane.section.append(end);
  return lane;
}

function buildRow(id) {
  const row = { id, label: null, edited: null, type: STORABLE[0].id, lanes: {} };
  row.section = element('section', 'panel group');
  row.name = element('h2', 'group-name');
  row.name.id = `row.${id}.title`;
  row.section.setAttribute('aria-labelledby', row.name.id);
  row.holds = element('p', 'where');
  const head = element('div', 'group-head');
  head.append(row.name, row.holds);

  const lanes = element('div', 'lanes');
  for (const type of [LOOKS, ...TYPES]) {
    row.lanes[type.id] = buildLane(row, type);
    lanes.append(row.lanes[type.id].section);
  }

  row.program = buildProgram(row);
  row.section.append(head, lanes, row.program);
  return row;
}

function buildMaster() {
  fader = slider({
    id: 'master',
    label: 'Master in percent',
    read: () => masterPercent(shell.master),
    write: (number) => shell.setMaster(number / 100),
  });
  page.master.append(fader);
  showSpeed = speedKeys(page.speed, shell.rates, shell.setRate);
}

/** The masters moved, here or on another screen. */
function renderMasters() {
  fader.refresh();
  showSpeed(shell.tempo.rate);
}

function buildTicks() {
  for (const fixture of shell.fixtures) {
    const tick = element('input');
    tick.type = 'checkbox';
    tick.value = fixture.id;
    const label = element('label', 'check');
    label.append(tick, fixture.label);
    page.groupFixtures.append(label);
  }
}

// ---- the sequences ----

/** What a step sets, in the words of the operator: `Spider: Drop · Room: Welcome`. */
function stepSets(step) {
  return Object.entries(step.looks)
    .map(([group, look]) => {
      const name = look === 'off' ? 'off' : (lookOf(group, look)?.label ?? look);
      return `${groupOf(group)?.label ?? group}: ${name}`;
    })
    .join(' · ');
}

function buildSequenceRow(sequence) {
  const section = element('div', 'sequence-row');
  const toggle = button('pick sequence-toggle', 'Start', () => pressSequence(sequence.id));
  const info = element('div', 'sequence-info');
  const name = element('h3', 'sequence-name');
  const steps = element('ol', 'sequence-steps');
  const status = element('p', 'sequence-status');
  info.append(name, steps, status);
  section.append(toggle, info);
  return { section, toggle, name, steps, status, made: '' };
}

function renderSequence(row, sequence) {
  row.name.textContent = sequence.label;
  // The chips are made again only when the sequence or the names in it changed.
  const made = JSON.stringify([sequence, sequence.steps.map(stepSets)]);
  if (made !== row.made) {
    row.made = made;
    row.steps.replaceChildren(
      ...sequence.steps.map((step) => {
        const chip = element('li', 'sequence-step');
        chip.append(element('span', 'step-bars', count(step.bars, 'bar')));
        chip.append(element('span', 'step-sets', stepSets(step)));
        return chip;
      }),
    );
  }
  const now = shell.sequence ?? { running: null };
  const running = now.running === sequence.id;
  row.toggle.textContent = running ? 'Stop' : 'Start';
  row.toggle.setAttribute('aria-pressed', String(running));
  row.toggle.setAttribute('aria-label', `${running ? 'Stop' : 'Start'} ${sequence.label}`);
  [...row.steps.children].forEach((chip, index) => {
    chip.dataset.state = running && index === now.step ? 'on' : 'idle';
  });
  let status = '';
  if (running) {
    status = now.paused
      ? `Step ${now.step + 1} of ${now.steps}. Waiting: the music has stopped.`
      : `Step ${now.step + 1} of ${now.steps}, ${count(now.barsLeft, 'bar')} to go.`;
    if (now.problem) status += ` ${sentence(now.problem)}`;
  }
  row.status.textContent = status;
  row.status.dataset.level = running && now.problem ? 'alarm' : 'note';
}

function renderSequences() {
  const list = shell.show.sequences ?? [];
  for (const [id, row] of sequenceRows) {
    if (list.some((sequence) => sequence.id === id)) continue;
    row.section.remove();
    sequenceRows.delete(id);
  }
  list.forEach((sequence, index) => {
    let row = sequenceRows.get(sequence.id);
    if (!row) {
      row = buildSequenceRow(sequence);
      sequenceRows.set(sequence.id, row);
    }
    if (page.sequences.children[index] !== row.section) {
      page.sequences.insertBefore(row.section, page.sequences.children[index] ?? null);
    }
    renderSequence(row, sequence);
  });
  page.sequencePanel.hidden = list.length === 0;
}

// ---- drawing ----

/** A key of a lane: its name, and under it a line that says more. */
function makeKey(onPress, ...between) {
  const key = button('scene', undefined, onPress);
  key.append(element('span', 'scene-name'), ...between, element('span', 'scene-sets'));
  return key;
}

function drawKey(key, { state, label, sets, title = '' }) {
  key.dataset.state = state;
  key.setAttribute('aria-pressed', String(state !== 'idle'));
  key.firstElementChild.textContent = label;
  key.lastElementChild.textContent = state === 'changed' ? 'Changed by hand' : sets;
  key.title = title;
}

/** The state a key shows: chosen to edit, or on as it was set, or on and changed by hand. */
function stateOf(chosenHere, on, item) {
  if (chosenHere) return 'chosen';
  if (!item || on.item !== item) return 'idle';
  return on.changed ? 'changed' : 'set';
}

/** Makes the keys of a lane the ones in `items` ({ id, make, draw }), in that order. */
function syncLane(lane, items) {
  const wanted = new Set(items.map((item) => item.id));
  for (const [id, key] of lane.keys) {
    if (wanted.has(id)) continue;
    key.remove();
    lane.keys.delete(id);
  }
  items.forEach((item, index) => {
    let key = lane.keys.get(item.id);
    if (!key) {
      key = item.make();
      lane.keys.set(item.id, key);
    }
    if (lane.grid.children[index] !== key) {
      lane.grid.insertBefore(key, lane.grid.children[index] ?? null);
    }
    item.draw(key);
  });
  lane.none.hidden = items.length > 0;
}

function sceneItems(group, type) {
  const on = onIn(group, type);
  return group.scenes
    .filter((scene) => scene.type === type)
    .map((scene) => ({
      id: scene.id,
      make: () => makeKey(() => pressScene(group.id, scene.id)),
      draw: (key) => {
        const here = same(chosen, { group: group.id, kind: 'scene', id: scene.id });
        drawKey(key, {
          state: stateOf(programming && here, on, scene),
          label: scene.label,
          sets: setsOf(scene, group),
        });
      },
    }));
}

/** A palette has a strip of its colours between its name and the line under it. */
function paletteItems(group) {
  if (group.palettes === false) return [];
  const on = onIn(group, 'colour');
  return palettes().map((palette) => ({
    id: palette.id,
    make: () => {
      const strip = element('span', 'chips');
      strip.setAttribute('aria-hidden', 'true');
      const key = makeKey(() => pressPalette(group.id, palette.id), strip);
      key.strip = strip;
      return key;
    },
    draw: (key) => {
      const colours = palette.colours.join(' ');
      if (key.colours !== colours) {
        key.colours = colours;
        key.strip.replaceChildren(
          ...palette.colours.map((value) => {
            const chip = element('span', 'chip');
            const colour = chipColour(value);
            if (colour) chip.style.backgroundColor = colour;
            else chip.dataset.off = 'true';
            return chip;
          }),
        );
      }
      const sets = movesOf(palette);
      drawKey(key, { state: stateOf(false, on, palette), label: palette.label, sets });
      key.title = `${palette.label}: ${palette.colours.length === 1 ? '1 colour' : `${palette.colours.length} colours`}`;
      // Palettes are edited on their own page, so in Program a press does nothing.
      key.disabled = programming;
    },
  }));
}

function lookItems(group) {
  const on = onLook(group);
  return group.looks.map((look) => ({
    id: look.id,
    make: () => makeKey(() => pressLook(group.id, look.id)),
    draw: (key) => {
      const here = same(chosen, { group: group.id, kind: 'look', id: look.id });
      const sets = namesOf(look, group);
      drawKey(key, {
        state: stateOf(programming && here, on, look),
        label: look.label,
        sets,
        title: sets,
      });
    },
  }));
}

function renderKeys(row, group) {
  syncLane(row.lanes[LOOKS.id], lookItems(group));
  syncLane(row.lanes.lights, sceneItems(group, 'lights'));
  syncLane(row.lanes.colour, paletteItems(group));
  syncLane(row.lanes.motion, sceneItems(group, 'motion'));

  const empty = {
    look: 'No looks yet.',
    lights: 'No lights scenes yet.',
    colour:
      group.palettes === false ? NO_PALETTES : 'No palettes yet. Make them on the Palettes page.',
    motion: 'No motion scenes yet.',
  };
  for (const { id, name } of [LOOKS, ...TYPES]) {
    const lane = row.lanes[id];
    lane.none.textContent = empty[id] ?? '';
    lane.section.setAttribute('aria-label', `${group.label} ${name}`);
  }
  row.lanes.colour.edit.hidden = !programming;
}

function renderProgram(row, group) {
  const isLook = row.type === 'look';
  for (const { id, made } of row.typeKeys) {
    made.setAttribute('aria-pressed', String(row.type === id));
  }
  row.storeNew.name.textContent = isLook ? 'Name of the new look' : 'Name of the new scene';
  const { item: running, changed } = isLook ? onLook(group) : onIn(group, row.type);
  const kind = isLook ? 'look' : `${typeName(row.type).toLowerCase()} scene`;
  row.storeOver.disabled = !changed;
  row.storeOver.textContent = !running
    ? `No ${kind} is on`
    : changed
      ? `Store the changes in "${running.label}"`
      : `"${running.label}" is as it was stored`;

  const edited = chosenItem();
  const kindEdited = chosen?.kind === 'look' ? 'look' : 'scene';
  row.sceneTitle.textContent = !edited
    ? 'No scene or look chosen'
    : kindEdited === 'look'
      ? `Look "${edited.label}"`
      : `Scene "${edited.label}", ${typeName(edited.type).toLowerCase()}`;
  // The field gets the name when the scene is chosen. After that it is the operator's.
  const editedKey = edited ? `${kindEdited}:${edited.id}` : null;
  if (row.edited !== editedKey) {
    row.edited = editedKey;
    row.rename.field.value = edited?.label ?? '';
  }
  row.rename.field.disabled = !edited;
  row.rename.submit.disabled = !edited;
  row.remove.disabled = !edited;
  const sureOfItem = Boolean(edited) && same(sure, chosen);
  row.remove.dataset.sure = String(sureOfItem);
  row.remove.textContent = sureOfItem
    ? `Press again to delete "${edited.label}"`
    : `Delete ${edited ? kindEdited : 'scene or look'}`;

  row.groupTitle.textContent = `Group "${group.label}"`;
  // A name that is being typed stays. Otherwise the field follows the name of the group.
  if (row.label !== group.label && document.activeElement !== row.renameGroup.field) {
    row.renameGroup.field.value = group.label;
    row.label = group.label;
  }
  const sureOfGroup = same(sure, { group: group.id, kind: 'group', id: group.id });
  row.removeGroup.dataset.sure = String(sureOfGroup);
  const holds = [
    group.scenes.length > 0 && count(group.scenes.length, 'scene'),
    group.looks.length > 0 && count(group.looks.length, 'look'),
  ].filter(Boolean);
  row.removeGroup.textContent = !sureOfGroup
    ? 'Delete group'
    : holds.length === 0
      ? `Press again to delete "${group.label}"`
      : `Press again to delete "${group.label}" and its ${holds.join(' and ')}`;
}

function renderRow(row, group) {
  const names = group.fixtures.map(labelOf).join(', ');
  row.name.textContent = group.label;
  // A group of one fixture is mostly called after it, and then the name says it.
  row.holds.textContent = names === group.label ? '' : names;

  renderKeys(row, group);
  row.off.disabled = programming;
  row.off.setAttribute('aria-label', `${group.label} lights off`);
  row.program.hidden = !programming;
  if (programming) renderProgram(row, group);
}

function renderGroups() {
  const list = page.groups;
  const { groups } = shell.show;
  for (const [id, row] of rows) {
    if (groups.some((group) => group.id === id)) continue;
    row.section.remove();
    rows.delete(id);
  }
  groups.forEach((group, index) => {
    let row = rows.get(group.id);
    if (!row) {
      row = buildRow(group.id);
      rows.set(group.id, row);
    }
    if (list.children[index] !== row.section) {
      list.insertBefore(row.section, list.children[index] ?? null);
    }
    renderRow(row, group);
  });
  list.hidden = groups.length === 0;
}

function render() {
  const { show } = shell;
  // What was chosen, or asked about, may be gone from the show.
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

  const scenes = show.groups.reduce((sum, group) => sum + group.scenes.length, 0);
  const looks = show.groups.reduce((sum, group) => sum + group.looks.length, 0);
  page.where.textContent =
    `${count(show.groups.length, 'group')}, ${count(scenes, 'scene')}, ${count(looks, 'look')}` +
    (show.file ? `, kept in ${show.file.split(/[\\/]/).pop()}` : ', kept until lightdeck stops');
  page.where.title = show.file ?? '';
  page.mode.setAttribute('aria-pressed', String(programming));

  const { hint } = page;
  hint.textContent = programming
    ? 'Program is on. Set the fixtures on their pages, then store what they do in a group: pick Lights or Motion and a scene keeps only that, or pick Look and the look keeps the scene of lights, the palette and the scene of motion that are on now. Colours are palettes, made on the Palettes page. A press on a scene or a look chooses it, to rename or delete it. The fixtures stay as they are, and Off waits. Press Program again for the show.'
    : 'There are no groups yet. Press Program to make one.';
  hint.hidden = !programming && show.groups.length > 0;

  renderGroups();
  renderSequences();
  page.newGroup.hidden = !programming;
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
  page.notice.textContent = text;
  page.notice.hidden = text === '';
}

async function main() {
  shell = await start({ page: 'deck' });
  if (!shell) return;
  document.title = 'Deck · Lightdeck';

  // The notice of the shell joins the one of the deck, where it takes no room from the keys.
  page.notices.prepend($('notice'));
  buildMaster();
  buildTicks();
  page.mode.addEventListener('click', switchMode);
  page.makeGroup.addEventListener('submit', makeGroup);
  // The address can also be changed by hand, or by going back.
  window.addEventListener('hashchange', () => setProgramming(location.hash === PROGRAM));

  shell.on('show', () => {
    // What was refused was about the show as it was. A press that was lost still is.
    failure = '';
    render();
    renderNotice();
  });
  shell.on('playback', render);
  shell.on('sequence', renderSequences);
  // The groups have nothing to do with the masters.
  shell.on('change', renderMasters);
  programming = location.hash === PROGRAM;
  renderMasters();
  render();
  renderNotice();
}

main();
