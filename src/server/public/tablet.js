// The tablet page: a few big controls for a tablet that stands next to the DJ, in the dark.
// Plain browser JavaScript, no build step.
//
// It has no bar: the shell is started bare, and the page draws what it needs of it.
//
//   top row   the way to the main view (the deck), a key for full screen, the link lamps (the bridge,
//             the LR512 and Home Assistant), the blackout
//   tempo     the bpm, the four beat lamps and a big Tap key. There is no slider: the tempo is
//             tapped. A tap counts when the finger lands. In Auto the shell takes a tap as
//             "this is beat one" only.
//   masters   the master (percent) and the keys of the master speed, as on the deck
//   sequences the sequences of the show, only their names: a press starts one (and stops the one
//             that runs), a press on the one that runs stops it, and it is lit while it runs.
//             Hidden when the show has none. They are on top of the looks
//   looks     the looks of the spider group, a key each. A press sets the look
//   room      the lamps of the room (the group of the Home Assistant fixture, `room`): its looks
//             as keys, the dimmer of the room as a fader, an Off key, and a switch per rail (zone of
//             the rig, when there are two or more): lit while the rail is on, a press switches it.
//             A switch is a dimmer of 0 or 1 for the lights of that rail and belongs to no scene,
//             so no look, scene or effect changes it. Hidden when the rig has no such lamps. What
//             the dimmer is comes from the state of the room fixture, which the shell keeps for
//             every fixture (`shell.stateOf`)
//   panel     "Spider: lights, colour and motion" (named after the group it is about), closed when
//             the page loads: the lanes of the same group as the spider looks, as on the deck: the
//             scenes of lights with Off, the palettes, the scenes of motion
//
// In every layout the order is the sequences, the spider looks and under them the room lamps. In
// landscape the tempo and the masters are a column on the left and those three one on the right.
//
// It is an installable app (the manifest and the icons, `manifest.webmanifest` and `icons/`, and
// `sw.js` that keeps the page so that it opens when lightdeck cannot be reached): on the home
// screen of the tablet it opens full screen. See the end of this file for the service worker.
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
const sequences = { grid: $('t-seq-grid'), none: $('t-seq-none'), keys: new Map() };
/** By the id of a zone, its switch. */
const rails = new Map();
const roomLooks = { grid: $('t-room-looks'), none: $('t-room-looks-none'), keys: new Map() };

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
 * The group of the lamps of the room: the one called room, or else the first group whose fixtures
 * are all driven by Home Assistant. Nothing when the rig has no such lamps.
 */
function roomGroup() {
  const { groups } = shell.show;
  const driven = (id) => shell.fixtures.find((fixture) => fixture.id === id)?.protocol === 'hass';
  return (
    groups.find((group) => group.id === 'room' && group.fixtures.every(driven)) ??
    groups.find((group) => group.fixtures.length > 0 && group.fixtures.every(driven))
  );
}

/** The fixture of the lamps: the one of the room group that Home Assistant drives. */
const roomFixture = () => {
  const group = roomGroup();
  return group ? shell.fixtures.find((fixture) => fixture.id === group.fixtures[0]) : undefined;
};

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

/** A key for each sequence of the show, with its name and nothing else. It is lit while it runs. */
function renderSequences() {
  const list = shell.show.sequences ?? [];
  $('t-seq').hidden = list.length === 0;
  const running = shell.sequence?.running ?? null;
  syncKeys(
    sequences,
    list.map((sequence) => ({
      id: sequence.id,
      make: () =>
        makeKey('scene seq', () =>
          ask(
            '/api/sequence',
            shell.sequence?.running === sequence.id ? { stop: true } : { start: sequence.id },
          ),
        ),
      draw: (key) =>
        drawKey(key, {
          state: running === sequence.id ? 'set' : 'idle',
          label: sequence.label,
          sets: '',
        }),
    })),
  );
}

let offGroup = null;
/** The group the Off key of the room is for. */
let roomOffGroup = null;

/** A switch for each rail of the room, as keys that are lit while the rail is on. */
function renderRails() {
  const fixture = roomFixture();
  const zones = fixture?.details?.zones ?? [];
  const holder = $('t-rails');
  // One zone is the whole room, and the Off key is for that.
  holder.hidden = zones.length < 2;
  if (holder.hidden) return;
  const current = shell.stateOf(fixture.id)?.zones ?? {};
  for (const zone of zones) {
    let key = rails.get(zone.id);
    if (!key) {
      key = element('button', 't-rail', zone.label);
      key.type = 'button';
      key.addEventListener('click', () => {
        const on = (shell.stateOf(fixture.id)?.zones?.[zone.id] ?? 1) > 0;
        ask(`/api/fixtures/${fixture.id}/update`, { zones: { [zone.id]: on ? 0 : 1 } });
      });
      rails.set(zone.id, key);
      holder.append(key);
    }
    key.textContent = zone.label;
    key.setAttribute('aria-pressed', String((current[zone.id] ?? 1) > 0));
  }
  for (const [id, key] of rails) {
    if (zones.some((zone) => zone.id === id)) continue;
    key.remove();
    rails.delete(id);
  }
}

function renderRoom() {
  const group = roomGroup();
  $('t-room').hidden = !group;
  roomOffGroup = group?.id ?? null;
  if (!group) {
    syncKeys(roomLooks, []);
    return;
  }
  renderRails();
  roomLooks.none.textContent = 'No looks for the room yet. Store them on the deck, in Program.';
  syncKeys(roomLooks, lookItems(group));
  $('t-room-off').setAttribute('aria-label', `${group.label} lights off`);
  roomDimmer?.refresh();
}

function renderKeys() {
  const group = spiderGroup();
  offGroup = group?.id ?? null;
  $('t-off').disabled = !group;
  if (!group) {
    renderRoom();
    looks.none.textContent = 'There is no group for the spider in the show. Make one on the deck.';
    syncKeys(looks, []);
    looks.none.hidden = false;
    for (const { id } of LANES) {
      syncKeys(lanes[id], []);
      lanes[id].none.textContent = 'No group.';
    }
    return;
  }
  renderRoom();
  // The panel at the bottom is about the spider group, and says so.
  $('t-more-title').textContent = `${group.label}: lights, colour and motion`;
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
  const { bridge, device, hass } = shell.links;
  for (const [id, link] of [
    ['t-link-bridge', bridge],
    ['t-link-device', device],
  ]) {
    $(id).dataset.state = link.state;
    $(id).querySelector('.link-text').textContent = link.text;
  }
  // Home Assistant has a lamp only when a fixture is driven by it.
  $('t-link-hass').hidden = hass === undefined;
  if (hass) {
    $('t-link-hass').dataset.state = hass.state;
    $('t-link-hass').querySelector('.link-text').textContent = hass.text;
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

/** The dimmer of the room: what the fader shows while a finger is on it, and how it is sent. */
let roomDimmer;
let dimmerHeld = null;
let dimmerHold;
let dimmerSent = 0;
let dimmerLate;
const DIMMER_GAP_MS = 120;

function sendDimmer(percent) {
  const fixture = roomFixture();
  if (!fixture) return;
  const send = () => {
    dimmerSent = performance.now();
    ask(`/api/fixtures/${fixture.id}/update`, { dimmer: percent / 100 });
  };
  // At most one request in a gap, and the last position always goes.
  clearTimeout(dimmerLate);
  const wait = DIMMER_GAP_MS - (performance.now() - dimmerSent);
  if (wait <= 0) send();
  else dimmerLate = setTimeout(send, wait);
}

function buildRoom() {
  roomDimmer = slider({
    id: 't-room-dimmer-level',
    label: 'Room dimmer',
    read: () =>
      dimmerHeld ?? Math.round(100 * (shell.stateOf(roomFixture()?.id ?? '')?.dimmer ?? 1)),
    write: (number) => {
      // The stream tells of an older position after a newer one is sent: the fader stays where
      // the finger put it until the finger has been away for a moment.
      dimmerHeld = number;
      clearTimeout(dimmerHold);
      dimmerHold = setTimeout(() => {
        dimmerHeld = null;
        roomDimmer.refresh();
      }, 700);
      sendDimmer(number);
    },
  });
  $('t-room-dimmer').append(roomDimmer);
  $('t-room-off').addEventListener('click', () => {
    if (roomOffGroup) ask('/api/playback', { group: roomOffGroup, off: true });
  });
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

/**
 * Full screen without the bar of the browser. A browser only installs a page as an app on https or
 * on localhost, so over `http://192.168...` the home screen only gets a shortcut that keeps the bar.
 * Full screen is allowed on any address, but only on a press: so the page has a key for it. It is
 * not there where the browser has none, and not when the page already is an app.
 */
function buildFullscreen() {
  const key = $('t-full');
  const root = document.documentElement;
  const app =
    window.matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches ||
    // The tablet app of lightdeck (android-tablet/) is already full screen: it says so in its agent.
    navigator.userAgent.includes('LightdeckTablet');
  if (!root.requestFullscreen || app) return;
  key.hidden = false;
  const show = () => key.setAttribute('aria-pressed', String(document.fullscreenElement !== null));
  key.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else root.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  });
  document.addEventListener('fullscreenchange', show);
  show();
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
  buildRoom();
  buildTempo();
  buildFullscreen();

  shell.on('show', () => {
    // What was refused was about the show as it was. A press that was lost still is.
    failure = '';
    renderKeys();
    renderSequences();
    renderNotice();
  });
  shell.on('playback', renderKeys);
  shell.on('sequence', renderSequences);
  // The dimmer of the room is set from another screen too.
  shell.on('fixtures', () => {
    roomDimmer?.refresh();
    renderRails();
  });
  shell.on('change', renderChange);
  shell.on('status', renderLinks);
  renderChange();
  renderLinks();
  renderKeys();
  renderSequences();
  renderNotice();
  requestAnimationFrame(drawBeat);
}

main();

// The app can be installed (manifest.webmanifest). The service worker (sw.js) keeps the page itself,
// so that it opens when lightdeck cannot be reached. A browser only has one on https and on
// localhost, and without one everything else works as before.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // No service worker: the page works without it.
    });
  });
}
