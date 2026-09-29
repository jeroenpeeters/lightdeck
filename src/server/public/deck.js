// The deck: the scenes of the show. Plain browser JavaScript, no build step.
//
// A scene is what every fixture does at once. A press on its key sets the fixtures to
// it. Storing takes the fixtures as they are now, so a scene is made on the pages of
// the fixtures and kept here.
//
// The deck draws what the server says: the scenes of the show, which of them the
// fixtures are set to, and whether they were changed by hand since. It asks for what
// the operator wants and waits for the answer to come by as an event.
//
// Tempo, speed and blackout are in the shell.

import { start } from './shell.js';
import { $, element } from './ui.js';

/** How long the delete key waits for the second press. */
const SURE_MS = 3000;

let shell;
/** While true, a press on a scene chooses it to edit and the fixtures stay as they are. */
let editing = false;
/** Id of the scene chosen to edit. */
let chosen = null;
/** What the server answered to what could not be done. */
let failure = '';
let sureTimer;
const keys = new Map();

const sceneOf = (id) => shell.show.scenes.find((scene) => scene.id === id);

function fixturesOf(scene) {
  const names = scene.fixtures.map(
    (id) => shell.fixtures.find((fixture) => fixture.id === id)?.label ?? id,
  );
  return names.length > 0 ? names.join(', ') : 'Everything dark';
}

/** An answer of the server as a sentence. */
function sentence(text) {
  const made = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(made) ? made : `${made}.`;
}

async function ask(url, body) {
  const answer = await shell.ask(url, body);
  failure = answer.ok ? '' : sentence(answer.error);
  renderNotice();
  return answer;
}

// ---- what the operator does ----

function press(id) {
  if (editing) {
    choose(chosen === id ? null : id);
    return;
  }
  ask('/api/playback', { scene: id });
}

function choose(id) {
  chosen = id;
  unsure();
  $('edit-name').value = sceneOf(id)?.label ?? '';
  render();
}

function setEditing(on) {
  editing = on;
  choose(null);
}

async function storeNew(event) {
  event.preventDefault();
  const field = $('new-name');
  const answer = await ask('/api/scenes', { label: field.value });
  if (!answer.ok) return;
  field.value = '';
  field.blur();
}

function storeOver() {
  const id = shell.playback.scene;
  if (id !== null) ask(`/api/scenes/${id}/store`);
}

async function rename(event) {
  event.preventDefault();
  if (chosen === null) return;
  const answer = await ask(`/api/scenes/${chosen}/rename`, { label: $('edit-name').value });
  if (answer.ok) $('edit-name').blur();
}

function unsure() {
  clearTimeout(sureTimer);
  $('delete').dataset.sure = 'false';
}

/** The first press asks, the second one within a few seconds deletes. */
async function remove() {
  if (chosen === null) return;
  if ($('delete').dataset.sure !== 'true') {
    $('delete').dataset.sure = 'true';
    sureTimer = setTimeout(() => {
      unsure();
      render();
    }, SURE_MS);
    render();
    return;
  }
  const answer = await ask(`/api/scenes/${chosen}/delete`);
  if (answer.ok) choose(null);
}

// ---- drawing ----

function stateOf(scene) {
  if (editing) return scene.id === chosen ? 'chosen' : 'idle';
  if (scene.id !== shell.playback.scene) return 'idle';
  return shell.playback.changed ? 'changed' : 'set';
}

function renderScenes() {
  const grid = $('scenes');
  const { scenes } = shell.show;
  for (const [id, key] of keys) {
    if (scenes.some((scene) => scene.id === id)) continue;
    key.remove();
    keys.delete(id);
  }
  scenes.forEach((scene, index) => {
    let key = keys.get(scene.id);
    if (!key) {
      key = element('button', 'scene');
      key.type = 'button';
      key.append(element('span', 'scene-name'), element('span', 'scene-sets'));
      key.addEventListener('click', () => press(scene.id));
      keys.set(scene.id, key);
    }
    if (grid.children[index] !== key) grid.insertBefore(key, grid.children[index] ?? null);

    const state = stateOf(scene);
    key.dataset.state = state;
    key.setAttribute('aria-pressed', String(state !== 'idle'));
    key.firstElementChild.textContent = scene.label;
    key.lastElementChild.textContent = state === 'changed' ? 'Changed by hand' : fixturesOf(scene);
  });
}

function render() {
  const { show, playback } = shell;
  const count = show.scenes.length;
  const running = sceneOf(playback.scene);
  if (chosen !== null && !sceneOf(chosen)) chosen = null;
  const edited = sceneOf(chosen);

  $('where').textContent =
    (count === 1 ? '1 scene' : `${count} scenes`) +
    (show.file ? `, kept in ${show.file.split(/[\\/]/).pop()}` : ', kept until lightdeck stops');
  $('where').title = show.file ?? '';
  $('running').dataset.on = String(Boolean(running));
  $('running').textContent = !running
    ? 'No scene'
    : playback.changed
      ? `${running.label}, changed by hand`
      : running.label;

  renderScenes();
  const hint = $('scenes-hint');
  hint.textContent = editing
    ? 'Choose a scene to rename or delete it. The fixtures stay as they are.'
    : 'There are no scenes yet.';
  hint.hidden = !editing && count > 0;

  $('edit').setAttribute('aria-pressed', String(editing));
  $('edit').textContent = editing ? 'Done editing' : 'Edit scenes';
  $('edit').disabled = !editing && count === 0;

  $('edit-panel').hidden = !editing;
  $('edit-title').textContent = edited ? `Edit "${edited.label}"` : 'Edit scene';
  $('edit-name').disabled = !edited;
  $('rename-key').disabled = !edited;
  $('delete').disabled = !edited;
  $('delete').textContent =
    $('delete').dataset.sure === 'true' && edited
      ? `Press again to delete "${edited.label}"`
      : 'Delete';

  const over = $('store-over');
  over.hidden = !running;
  over.disabled = !playback.changed;
  if (running) {
    over.textContent = playback.changed
      ? `Store the changes in "${running.label}"`
      : `"${running.label}" is as it was stored`;
  }
}

/**
 * What went wrong on the deck. It has a place of its own, so that it shows whatever the
 * shell has to say about the link to the fixtures.
 */
function renderNotice() {
  const { problem } = shell.show;
  const text =
    failure ||
    (problem
      ? `The show file has a mistake, so the deck goes on with the scenes it had. ${sentence(problem)}`
      : '');
  $('deck-notice').textContent = text;
  $('deck-notice').hidden = text === '';
}

async function main() {
  shell = await start({ page: 'deck' });
  if (!shell) return;
  document.title = 'Deck · Lightdeck';

  $('edit').addEventListener('click', () => setEditing(!editing));
  $('store-new').addEventListener('submit', storeNew);
  $('store-over').addEventListener('click', storeOver);
  $('rename').addEventListener('submit', rename);
  $('delete').addEventListener('click', remove);

  shell.on('show', () => {
    render();
    renderNotice();
  });
  shell.on('playback', render);
  render();
  renderNotice();
}

main();
