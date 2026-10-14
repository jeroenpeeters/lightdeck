// The deck: the groups of the show with their scenes. Plain browser JavaScript, no build
// step.
//
// A group is a set of fixtures, and a scene is a part of what the fixtures of its group do.
// A scene is of one type: Lights (what is on, and what it does), Colour or Motion. Every
// group has a row here with a lane per type, and a lane has a key per scene of that type. One
// scene per lane is on, so several scenes are on at once, each for its own fixtures and its
// own properties: a colour scene is pressed under a chase and the chase goes on in the new
// colour. The lane of the lights has the key for off, which darkens the fixtures and leaves
// their colours and their motion as they are.
//
// The deck has two modes, and the address remembers which (#program):
//
//   Show      what the page opens in. A press on a scene sets its type of properties on the
//             fixtures of its group, a press on Off darkens them. There is nothing to type
//             and nothing that deletes, and no key changes size or place when a scene goes
//             on or off.
//   Program   storing, naming and deleting, of scenes and of groups. A press on a scene
//             chooses it, and the fixtures stay as they are.
//
// Storing takes the properties of the chosen type from the fixtures of the group as they are
// now, so a scene is made on the pages of the fixtures and kept here.
//
// The deck draws what the server says: the groups of the show, which scene is on in each lane
// of each, and whether its fixtures were changed by hand since. It asks for what the
// operator wants and waits for the answer to come by as an event. A press is asked once:
// when it does not reach lightdeck the deck says so and the operator presses again.
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
import { $, button, element, sentence, slider, speedKeys } from './ui.js';

/** How long a delete key waits for the second press. */
const SURE_MS = 3000;
/** What the address ends in while the deck is in Program. */
const PROGRAM = '#program';
const NAME_LENGTH = 40;
/** The types of scene, in the order of the lanes of a row. */
const TYPES = [
  { id: 'lights', name: 'Lights', hint: 'What is on, and what it does' },
  { id: 'colour', name: 'Colour', hint: 'The first and the second colour' },
  { id: 'motion', name: 'Motion', hint: 'How the bars and the beam move' },
];
const typeName = (id) => TYPES.find((type) => type.id === id)?.name ?? id;

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
  newGroup: $('new-group'),
  makeGroup: $('make-group'),
  groupName: $('group-name'),
  groupFixtures: $('group-fixtures'),
  notices: $('notices'),
  notice: $('deck-notice'),
};

let shell;
/** While true, a press on a scene chooses it to edit and the fixtures stay as they are. */
let programming = false;
/** The scene chosen to edit, as { group, scene }. */
let chosen = null;
/** What a delete key was pressed for once, as { group, scene }. A group has no scene. */
let sure = null;
let sureTimer;
/** What the server answered to what could not be done. */
let failure = '';
/** True when the last press did not reach lightdeck. It is not sent again. */
let lost = false;
/** By the id of a group, the row that was built for it. */
const rows = new Map();
/** The fader of the master. */
let fader;
/** Shows which master speed is chosen. */
let showSpeed = () => {};

const groupOf = (id) => shell.show.groups.find((group) => group.id === id);
const sceneOf = (group, id) => groupOf(group)?.scenes.find((scene) => scene.id === id);
const labelOf = (id) => shell.fixtures.find((fixture) => fixture.id === id)?.label ?? id;
const same = (one, other) => one !== null && one.group === other.group && one.scene === other.scene;
const count = (number, word) => (number === 1 ? `1 ${word}` : `${number} ${word}s`);

/**
 * What is on in a lane of a group. Right after the show changed the server may not have
 * said yet, and then no scene is on.
 */
function onIn(group, type) {
  const on = shell.playback.groups?.[group.id]?.[type];
  const scene = group.scenes.find((each) => each.id === on?.scene && each.type === type);
  return { scene, changed: Boolean(scene && on.changed) };
}

/** What a scene sets, where that says more than the row does already. */
function setsOf(scene, group) {
  if (scene.fixtures.length === 0) return scene.type === 'lights' ? 'Dark' : 'Nothing set';
  return group.fixtures.length > 1 ? scene.fixtures.map(labelOf).join(', ') : '';
}

async function ask(url, body) {
  const answer = await shell.ask(url, body);
  lost = Boolean(answer.lost);
  failure = answer.ok || lost ? '' : sentence(answer.error);
  renderNotice();
  return answer;
}

// ---- what the operator does ----

function press(group, scene) {
  if (programming) {
    const here = { group, scene };
    choose(same(chosen, here) ? null : here);
    return;
  }
  ask('/api/playback', { group, scene });
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
  const type = rows.get(group)?.type ?? TYPES[0].id;
  const answer = await ask(`/api/groups/${group}/scenes`, { label: field.value, type });
  if (answer.ok) field.value = '';
  return answer.ok;
}

function storeOver(id) {
  const group = groupOf(id);
  const type = rows.get(id)?.type;
  const { scene } = group && type ? onIn(group, type) : {};
  if (scene) ask(`/api/groups/${id}/scenes/${scene.id}/store`);
}

async function renameScene(group, label) {
  if (chosen?.group !== group) return false;
  return (await ask(`/api/groups/${group}/scenes/${chosen.scene}/rename`, { label })).ok;
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

function removeScene(group) {
  if (chosen?.group !== group) return;
  remove({ ...chosen }, `/api/groups/${group}/scenes/${chosen.scene}/delete`);
}

function removeGroup(group) {
  remove({ group, scene: null }, `/api/groups/${group}/delete`);
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
  return { form, field, submit };
}

function block(title, ...parts) {
  const made = element('section', 'block');
  const head = element('h3', '', title);
  made.append(head, ...parts);
  return { made, head };
}

/** The keys that say which type of scene is stored. */
function buildTypeKeys(row) {
  const fieldset = element('fieldset', 'choice type-choice');
  fieldset.append(element('legend', '', 'Type of scene'));
  row.typeKeys = TYPES.map(({ id, name, hint }) => {
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

/** What Program adds to the row of a group: storing, the chosen scene, the group itself. */
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
    done: (label) => renameScene(id, label),
  });
  row.remove = button('key wide delete', '', () => removeScene(id));
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

/** One lane of a row: the name of the type, the keys of its scenes, and for lights Off. */
function buildLane(row, type) {
  const lane = { type: type.id };
  lane.section = element('div', 'lane');
  lane.section.setAttribute('role', 'group');
  lane.name = element('span', 'lane-name', type.name);
  lane.name.title = type.hint;
  lane.grid = element('div', 'scene-grid');
  lane.none = element('p', 'hint', `No ${type.name.toLowerCase()} scenes yet.`);
  const scenes = element('div', 'lane-scenes');
  scenes.append(lane.none, lane.grid);
  lane.section.append(lane.name, scenes);
  // Off has a place of its own at the end of the lane of the lights, the same in every
  // group. The other lanes keep the place free, so that the keys line up.
  const end = element('div', 'lane-end');
  if (type.id === 'lights') {
    row.off = button('scene off', 'Off', () => pressOff(row.id));
    end.append(row.off);
  }
  lane.section.append(end);
  return lane;
}

function buildRow(id) {
  const row = { id, keys: new Map(), label: null, edited: null, type: TYPES[0].id, lanes: {} };
  row.section = element('section', 'panel group');
  row.name = element('h2', 'group-name');
  row.name.id = `row.${id}.title`;
  row.section.setAttribute('aria-labelledby', row.name.id);
  row.holds = element('p', 'where');
  const head = element('div', 'group-head');
  head.append(row.name, row.holds);

  const lanes = element('div', 'lanes');
  for (const type of TYPES) {
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

// ---- drawing ----

function stateOf(group, scene) {
  if (programming && same(chosen, { group: group.id, scene: scene.id })) return 'chosen';
  const on = onIn(group, scene.type);
  if (on.scene !== scene) return 'idle';
  return on.changed ? 'changed' : 'set';
}

function renderKeys(row, group) {
  for (const [id, key] of row.keys) {
    if (group.scenes.some((scene) => scene.id === id)) continue;
    key.remove();
    row.keys.delete(id);
  }
  for (const { id: type } of TYPES) {
    const lane = row.lanes[type];
    const scenes = group.scenes.filter((scene) => scene.type === type);
    scenes.forEach((scene, index) => {
      let key = row.keys.get(scene.id);
      if (!key) {
        key = button('scene', undefined, () => press(group.id, scene.id));
        key.append(element('span', 'scene-name'), element('span', 'scene-sets'));
        row.keys.set(scene.id, key);
      }
      // Putting a key in a lane also takes it out of the lane it was in, which is how a scene
      // that got another type in the file moves.
      if (lane.grid.children[index] !== key) {
        lane.grid.insertBefore(key, lane.grid.children[index] ?? null);
      }
      const state = stateOf(group, scene);
      key.dataset.state = state;
      key.setAttribute('aria-pressed', String(state !== 'idle'));
      key.firstElementChild.textContent = scene.label;
      key.lastElementChild.textContent =
        state === 'changed' ? 'Changed by hand' : setsOf(scene, group);
    });
    lane.none.hidden = scenes.length > 0;
    lane.section.setAttribute('aria-label', `${group.label} ${typeName(type)}`);
  }
}

function renderProgram(row, group) {
  for (const { id, made } of row.typeKeys)
    made.setAttribute('aria-pressed', String(row.type === id));
  const { scene: running, changed } = onIn(group, row.type);
  const kind = typeName(row.type).toLowerCase();
  row.storeOver.disabled = !changed;
  row.storeOver.textContent = !running
    ? `No ${kind} scene is on`
    : changed
      ? `Store the changes in "${running.label}"`
      : `"${running.label}" is as it was stored`;

  const edited = chosen?.group === group.id ? sceneOf(group.id, chosen.scene) : undefined;
  row.sceneTitle.textContent = edited
    ? `Scene "${edited.label}", ${typeName(edited.type).toLowerCase()}`
    : 'No scene chosen';
  // The field gets the name when the scene is chosen. After that it is the operator's.
  if (row.edited !== (edited?.id ?? null)) {
    row.edited = edited?.id ?? null;
    row.rename.field.value = edited?.label ?? '';
  }
  row.rename.field.disabled = !edited;
  row.rename.submit.disabled = !edited;
  row.remove.disabled = !edited;
  const sureOfScene = Boolean(edited) && same(sure, chosen);
  row.remove.dataset.sure = String(sureOfScene);
  row.remove.textContent = sureOfScene ? `Press again to delete "${edited.label}"` : 'Delete scene';

  row.groupTitle.textContent = `Group "${group.label}"`;
  // A name that is being typed stays. Otherwise the field follows the name of the group.
  if (row.label !== group.label && document.activeElement !== row.renameGroup.field) {
    row.renameGroup.field.value = group.label;
    row.label = group.label;
  }
  const sureOfGroup = same(sure, { group: group.id, scene: null });
  row.removeGroup.dataset.sure = String(sureOfGroup);
  row.removeGroup.textContent = !sureOfGroup
    ? 'Delete group'
    : group.scenes.length === 0
      ? `Press again to delete "${group.label}"`
      : `Press again to delete "${group.label}" and its ${count(group.scenes.length, 'scene')}`;
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
  if (chosen && !sceneOf(chosen.group, chosen.scene)) chosen = null;
  if (sure && !(sure.scene === null ? groupOf(sure.group) : sceneOf(sure.group, sure.scene))) {
    unsure();
  }

  const scenes = show.groups.reduce((sum, group) => sum + group.scenes.length, 0);
  page.where.textContent =
    `${count(show.groups.length, 'group')}, ${count(scenes, 'scene')}` +
    (show.file ? `, kept in ${show.file.split(/[\\/]/).pop()}` : ', kept until lightdeck stops');
  page.where.title = show.file ?? '';
  page.mode.setAttribute('aria-pressed', String(programming));

  const { hint } = page;
  hint.textContent = programming
    ? 'Program is on. Set the fixtures on their pages, then store what they do in a group: pick the type, Lights, Colour or Motion, and a scene keeps only that. A press on a scene chooses it, to rename or delete it. The fixtures stay as they are, and Off waits. Press Program again for the show.'
    : 'There are no groups yet. Press Program to make one.';
  hint.hidden = !programming && show.groups.length > 0;

  renderGroups();
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
  // The groups have nothing to do with the masters.
  shell.on('change', renderMasters);
  programming = location.hash === PROGRAM;
  renderMasters();
  render();
  renderNotice();
}

main();
