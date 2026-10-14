// The tablet page: a few big controls for a tablet that stands next to the DJ, in the dark.
// Plain browser JavaScript, no build step.
//
// It has no bar: the shell is started bare, and the page draws what it needs of it.
//
//   top row   the way to the main view (the deck), the two link lamps, the blackout
//   tempo     the bpm, the four beat lamps and a big Tap key. There is no slider: the tempo is
//             tapped. A tap counts when the finger lands. In Auto the shell takes a tap as
//             "this is beat one" only.
//   masters   the master (percent) and the keys of the master speed, as on the deck
//   looks     the looks of the spider group, a key each. A press sets the look
//   panel     "Lights, colour and motion", closed when the page loads: the lanes of the same
//             group, as on the deck: the scenes of lights with Off, the palettes, the scenes
//             of motion
//
// The page draws what the server says and asks for what the operator wants. A press is asked
// once; when it does not reach lightdeck the page says so and the operator presses again.
// Keys have a fixed size and place whatever state they are in, and notices lie over the bottom
// of the screen without taking room, so that nothing moves under a finger.

import { masterPercent, start } from './shell.js';
import { $, element, sentence, slider, speedKeys, speedName } from './ui.js';

const BEATS_PER_BAR = 4;
const LANES = [
  { id: 'lights', name: 'Lights' },
  { id: 'colour', name: 'Colour' },
  { id: 'motion', name: 'Motion' },
];
const NO_PALETTES = "This group's fixtures have colours of their own. Set them on their page.";

let shell;
/** What the server answered to what could not be done. */
let failure = '';
/** True when the last press did not reach lightdeck. It is not sent again. */
let lost = false;
let fader;
let showSpeed = () => {};
/** By the id of a lane, what was built for it: its grid, its line for "none" and its keys. */
const lanes = {};
const looks = { grid: $('t-looks'), none: $('t-looks-none'), keys: new Map() };

const palettes = () => shell.show.palettes ?? [];
const paletteOf = (id) => palettes().find((palette) => palette.id === id);
const labelOf = (id) => shell.fixtures.find((fixture) => fixture.id === id)?.label ?? id;

/** The group of the spider: the one called spider, or else the first with a spider in it. */
function spiderGroup() {
  const { groups } = shell.show;
  const kindOf = (id) => shell.fixtures.find((fixture) => fixture.id === id)?.kind;
  return (
    groups.find((group) => group.id === 'spider') ??
    groups.find((group) => group.fixtures.some((id) => kindOf(id) === 'spider'))
  );
}

/**
 * What is on in a lane of a group. In the lane of the colour that is a palette of the show.
 * Right after the show changed the server may not have said yet, and then nothing is on.
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

// ---- drawing ----

/** A key: its name, what it holds between, and under it a line that says more. */
function makeKey(className, onPress, ...between) {
  const key = element('button', className);
  key.type = 'button';
  key.addEventListener('click', onPress);
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

/** The state a key shows: on as it was set, on and changed by hand, or not on. */
function stateOf(on, item) {
  if (!on.item || on.item !== item) return 'idle';
  return on.changed ? 'changed' : 'set';
}

/** Makes the keys of a grid the ones in `items` ({ id, make, draw }), in that order. */
function syncKeys(lane, items) {
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
      make: () =>
        makeKey('scene', () => ask('/api/playback', { group: group.id, scene: scene.id })),
      draw: (key) =>
        drawKey(key, { state: stateOf(on, scene), label: scene.label, sets: setsOf(scene, group) }),
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
      const key = makeKey(
        'scene',
        () => ask('/api/playback', { group: group.id, palette: palette.id }),
        strip,
      );
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
      drawKey(key, {
        state: stateOf(on, palette),
        label: palette.label,
        sets: movesOf(palette),
        title: `${palette.label}: ${palette.colours.length === 1 ? '1 colour' : `${palette.colours.length} colours`}`,
      });
    },
  }));
}

function lookItems(group) {
  const on = onLook(group);
  return group.looks.map((look) => ({
    id: look.id,
    make: () =>
      makeKey('scene look', () => ask('/api/playback', { group: group.id, look: look.id })),
    draw: (key) => {
      const sets = namesOf(look, group);
      drawKey(key, { state: stateOf(on, look), label: look.label, sets, title: sets });
    },
  }));
}

let offGroup = null;

function renderKeys() {
  const group = spiderGroup();
  offGroup = group?.id ?? null;
  $('t-off').disabled = !group;
  if (!group) {
    looks.none.textContent = 'There is no group for the spider in the show. Make one on the deck.';
    syncKeys(looks, []);
    looks.none.hidden = false;
    for (const { id } of LANES) {
      syncKeys(lanes[id], []);
      lanes[id].none.textContent = 'No group.';
    }
    return;
  }
  looks.none.textContent = 'No looks yet. Store them on the deck, in Program.';
  syncKeys(looks, lookItems(group));
  syncKeys(lanes.lights, sceneItems(group, 'lights'));
  syncKeys(lanes.colour, paletteItems(group));
  syncKeys(lanes.motion, sceneItems(group, 'motion'));
  lanes.lights.none.textContent = 'No lights scenes yet.';
  lanes.colour.none.textContent =
    group.palettes === false ? NO_PALETTES : 'No palettes yet. Make them on the Palettes page.';
  lanes.motion.none.textContent = 'No motion scenes yet.';
  $('t-off').setAttribute('aria-label', `${group.label} lights off`);
}

/** The masters, the tempo and the blackout moved, here or on another screen. */
function renderChange() {
  fader.refresh();
  showSpeed(shell.tempo.rate);
  $('t-bpm').textContent = String(Math.round(shell.tempo.bpm));
  const on = shell.blackout;
  const key = $('t-blackout');
  key.setAttribute('aria-pressed', String(on));
  key.textContent = on ? 'Lift blackout' : 'Blackout';
}

function renderLinks() {
  const { bridge, device } = shell.links;
  for (const [id, link] of [
    ['t-link-bridge', bridge],
    ['t-link-device', device],
  ]) {
    $(id).dataset.state = link.state;
    $(id).querySelector('.link-text').textContent = link.text;
  }
}

/** What went wrong on this page. The notice of the shell lies with it, in the same stack. */
function renderNotice() {
  const { problem } = shell.show;
  let text = '';
  if (lost) text = 'That press did not reach lightdeck. Press again.';
  else if (failure) text = failure;
  else if (problem) {
    text = `The show file has a mistake, so the show goes on as it was. ${sentence(problem)}`;
  }
  const notice = $('t-notice');
  notice.textContent = text;
  notice.hidden = text === '';
}

// ---- the beat ----

let litBeat = -1;
/** A lamp for each beat of the bar, as the tempo desk of the shell does it. */
function drawBeat() {
  const { running } = shell.tempo;
  const index = running
    ? ((Math.floor(shell.beat()) % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR
    : -1;
  if (index !== litBeat) {
    litBeat = index;
    [...$('t-beats').children].forEach((lamp, i) => {
      lamp.dataset.on = String(i === index);
    });
    $('t-beats').dataset.idle = String(!running);
  }
  requestAnimationFrame(drawBeat);
}

// ---- building ----

function buildMaster() {
  fader = slider({
    id: 't-master-level',
    label: 'Master',
    read: () => masterPercent(shell.master),
    write: (number) => shell.setMaster(number / 100),
  });
  $('t-master').append(fader);
  showSpeed = speedKeys($('t-speed'), shell.rates, shell.setRate);
}

function buildLanes() {
  for (const { id } of LANES) {
    lanes[id] = { grid: $(`t-grid-${id}`), none: $(`t-none-${id}`), keys: new Map() };
  }
}

function buildPanel() {
  const head = $('t-more-head');
  head.addEventListener('click', () => {
    const open = head.getAttribute('aria-expanded') !== 'true';
    head.setAttribute('aria-expanded', String(open));
    $('t-more-body').hidden = !open;
  });
  $('t-off').addEventListener('click', () => {
    if (offGroup) ask('/api/playback', { group: offGroup, off: true });
  });
}

function buildTempo() {
  // A tap counts when the finger lands, not when it lifts. The click covers the keyboard.
  const pad = $('t-tap');
  pad.addEventListener('pointerdown', (event) => {
    if (event.button === 0) shell.tap();
  });
  pad.addEventListener('click', (event) => {
    if (event.detail === 0) shell.tap();
  });
  $('t-blackout').addEventListener('click', () => shell.setBlackout(!shell.blackout));
}

async function main() {
  shell = await start({ page: 'tablet', bare: true });
  if (!shell) return;
  // The notice of the shell joins the one of the page, where it takes no room from the keys.
  $('notices').prepend($('notice'));

  buildMaster();
  buildLanes();
  buildPanel();
  buildTempo();

  shell.on('show', () => {
    // What was refused was about the show as it was. A press that was lost still is.
    failure = '';
    renderKeys();
    renderNotice();
  });
  shell.on('playback', renderKeys);
  shell.on('change', renderChange);
  shell.on('status', renderLinks);
  renderChange();
  renderLinks();
  renderKeys();
  renderNotice();
  requestAnimationFrame(drawBeat);
}

main();
