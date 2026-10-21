// The parts that the two pages for a tablet share (tablet.js and moods.js): the notice, the tempo,
// the masters, the blackout, the link lamps, the sequences and the controls of the lamps of the
// room. They draw into elements with the ids of `tablet.html`, so a page that wants them has those
// ids. Plain browser JavaScript.
//
// A page calls `init(shell)` once, builds what it uses, and calls the `render` functions when the
// shell says the state changed. A press is asked once through `ask`: when it does not reach
// lightdeck the page says so and the operator presses again.

import { masterPercent } from './shell.js';
import { drawKey, fillStrip, makeKey, makeStrip, movesOf, stateOf, syncKeys } from './tabletKit.js';
import {
  $,
  element,
  makeDismissible,
  sentence,
  setNotice,
  slider,
  speedKeys,
  speedName,
} from './ui.js';

const BEATS_PER_BAR = 4;

let shell;
/** What the server answered to what could not be done. */
let failure = '';
/** True when the last press did not reach lightdeck. It is not sent again. */
let lost = false;

export function init(started) {
  shell = started;
  // A notice lies over the keys: a click on it clears it.
  makeDismissible($('t-notice'));
}

// ---- asking, and the notice ----

/** What went wrong on this page. The notice of the shell lies with it, in the same stack. */
export function renderNotice() {
  const { problem } = shell.show;
  let text = '';
  if (lost) text = 'That press did not reach lightdeck. Press again.';
  else if (failure) text = failure;
  else if (problem) {
    text = `The show file has a mistake, so the show goes on as it was. ${sentence(problem)}`;
  }
  setNotice($('t-notice'), text);
}

export async function ask(url, body) {
  const answer = await shell.ask(url, body);
  lost = Boolean(answer.lost);
  failure = answer.ok || lost ? '' : sentence(answer.error);
  renderNotice();
  return answer;
}

/** What was refused was about the show as it was; a press that was lost still is. */
export function clearFailure() {
  failure = '';
}

// ---- the show: what is on, and keys for looks, scenes and palettes ----

export const palettes = () => shell.show.palettes ?? [];
export const paletteOf = (id) => palettes().find((palette) => palette.id === id);
export const labelOf = (id) => shell.fixtures.find((fixture) => fixture.id === id)?.label ?? id;

/**
 * What is on in a lane of a group. In the lane of the colour that is a palette of the show.
 * Right after the show changed the server may not have said yet, and then nothing is on.
 */
export function onIn(group, type) {
  const on = shell.playback.groups?.[group.id]?.[type];
  const item =
    type === 'colour'
      ? group.palettes === false
        ? undefined
        : paletteOf(on?.scene)
      : group.scenes.find((each) => each.id === on?.scene && each.type === type);
  return { item, changed: Boolean(item && on.changed) };
}

/** The look that is on in a group, and whether a lane it set is not what it set any more. */
export function onLook(group) {
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

/**
 * Keys for the scenes of a type, or for those of `ids` in that order. A key is for a group and a
 * scene, so the id of the key says both and two groups can have keys in one grid in turn.
 */
export function sceneItems(group, type, ids) {
  const on = onIn(group, type);
  const scenes = group.scenes.filter((scene) => scene.type === type);
  const chosen = ids
    ? ids.map((id) => scenes.find((scene) => scene.id === id)).filter((scene) => scene)
    : scenes;
  return chosen.map((scene) => ({
    id: `${group.id}:${scene.id}`,
    make: () => makeKey('scene', () => ask('/api/playback', { group: group.id, scene: scene.id })),
    draw: (key) =>
      drawKey(key, { state: stateOf(on, scene), label: scene.label, sets: setsOf(scene, group) }),
  }));
}

/** Keys for the palettes of the show, or for those of `ids` in that order, with a strip of the colours. */
export function paletteItems(group, ids) {
  if (group.palettes === false) return [];
  const on = onIn(group, 'colour');
  const chosen = ids ? ids.map((id) => paletteOf(id)).filter((palette) => palette) : palettes();
  return chosen.map((palette) => ({
    id: `${group.id}:${palette.id}`,
    make: () => {
      const strip = makeStrip();
      const key = makeKey(
        'scene',
        () => ask('/api/playback', { group: group.id, palette: palette.id }),
        strip,
      );
      key.strip = strip;
      return key;
    },
    draw: (key) => {
      fillStrip(key.strip, palette.colours);
      drawKey(key, {
        state: stateOf(on, palette),
        label: palette.label,
        sets: movesOf(palette),
        title: `${palette.label}: ${palette.colours.length === 1 ? '1 colour' : `${palette.colours.length} colours`}`,
      });
    },
  }));
}

/**
 * Keys for looks (those of `chosen`, or all of the group's). With `strip` a look shows the colours of
 * its palette between its name and what it names, and `changedText` is what a look says once a lane
 * of it was changed.
 */
export function lookItems(group, { chosen = group.looks, strip = false, changedText } = {}) {
  const on = onLook(group);
  return chosen.map((look) => ({
    id: `${group.id}:${look.id}`,
    make: () => {
      const colours = strip ? makeStrip() : undefined;
      const key = makeKey(
        'scene look',
        () => ask('/api/playback', { group: group.id, look: look.id }),
        ...(colours ? [colours] : []),
      );
      key.strip = colours;
      return key;
    },
    draw: (key) => {
      const sets = namesOf(look, group);
      if (key.strip)
        fillStrip(key.strip, look.colour ? paletteOf(look.colour.palette)?.colours : undefined);
      drawKey(key, { state: stateOf(on, look), label: look.label, sets, title: sets }, changedText);
    },
  }));
}

// ---- the top row ----

/**
 * The lamps of the links stand in the menu, with their words, and the key of the menu has one dot
 * for all of them without words: green when nothing is wrong, red when a link is down. A link that
 * is not there (no bridge asked for) or made up (simulated) is not wrong.
 */
export function renderLinks() {
  const { bridge, device, hass } = shell.links;
  const links = [
    ['t-link-bridge', bridge],
    ['t-link-device', device],
  ];
  // Home Assistant has a lamp only when a fixture is driven by it.
  $('t-link-hass').hidden = hass === undefined;
  if (hass) links.push(['t-link-hass', hass]);
  for (const [id, link] of links) {
    $(id).dataset.state = link.state;
    $(id).querySelector('.link-text').textContent = link.text;
  }
  const wrong = links.some(([, link]) => link.state === 'down');
  $('t-dot').dataset.state = wrong ? 'down' : 'ok';
  $('t-menu-key').setAttribute(
    'aria-label',
    wrong ? 'Menu, something is not connected' : 'Menu, everything is connected',
  );
}

/**
 * The small menu in the top row: the way to the other pages, full screen and the lamps of the links.
 * It lies over the page and takes no room, so no key moves when it opens. A press outside it, on
 * one of its keys or on Escape closes it.
 */
export function buildMenu() {
  const key = $('t-menu-key');
  const menu = $('t-menu');
  const set = (open) => {
    menu.hidden = !open;
    key.setAttribute('aria-expanded', String(open));
  };
  key.addEventListener('click', () => set(menu.hidden));
  document.addEventListener('pointerdown', (event) => {
    if (!menu.hidden && !menu.contains(event.target) && !key.contains(event.target)) set(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') set(false);
  });
  // Full screen does its work on the press, and the menu may go.
  $('t-full').addEventListener('click', () => set(false));
}

/**
 * Full screen without the bar of the browser. A browser only installs a page as an app on https or
 * on localhost, so over `http://192.168...` the home screen only gets a shortcut that keeps the bar.
 * Full screen is allowed on any address, but only on a press: so the page has a key for it. It is
 * not there where the browser has none, and not when the page already is an app.
 */
export function buildFullscreen() {
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

// ---- the tempo, the masters and the blackout ----

let fader;
let showSpeed = () => {};

export function buildMaster() {
  fader = slider({
    id: 't-master-level',
    label: 'Master',
    read: () => masterPercent(shell.master),
    write: (number) => shell.setMaster(number / 100),
  });
  $('t-master').append(fader);
  showSpeed = speedKeys($('t-speed'), shell.rates, shell.setRate);
}

export function buildTempo() {
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

/** The masters, the tempo and the blackout moved, here or on another screen. */
export function renderChange() {
  fader.refresh();
  showSpeed(shell.tempo.rate);
  $('t-bpm').textContent = String(Math.round(shell.tempo.bpm));
  const on = shell.blackout;
  const key = $('t-blackout');
  key.setAttribute('aria-pressed', String(on));
  key.textContent = on ? 'Lift blackout' : 'Blackout';
}

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

export function startBeat() {
  requestAnimationFrame(drawBeat);
}

// ---- the sequences ----

const sequences = { grid: null, none: null, keys: new Map() };

/** A key for each sequence of the show, with its name and nothing else. It is lit while it runs. */
export function renderSequences() {
  sequences.grid ??= $('t-seq-grid');
  sequences.none ??= $('t-seq-none');
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

// ---- the lamps of the room ----

/**
 * The group of the lamps of the room: the one called room, or else the first group whose fixtures
 * are all driven by Home Assistant. Nothing when the rig has no such lamps.
 */
export function roomGroup() {
  const { groups } = shell.show;
  const driven = (id) => shell.fixtures.find((fixture) => fixture.id === id)?.protocol === 'hass';
  return (
    groups.find((group) => group.id === 'room' && group.fixtures.every(driven)) ??
    groups.find((group) => group.fixtures.length > 0 && group.fixtures.every(driven))
  );
}

/** The fixture of the lamps: the one of the room group that Home Assistant drives. */
export function roomFixture() {
  const group = roomGroup();
  return group ? shell.fixtures.find((fixture) => fixture.id === group.fixtures[0]) : undefined;
}

/** By the id of a zone, its switch. */
const rails = new Map();

/** A switch for each rail of the room, as keys that are lit while the rail is on. */
export function renderRails() {
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

/** The dimmer of the room: what the fader shows while a finger is on it, and how it is sent. */
let roomDimmer;
let dimmerHeld = null;
let dimmerHold;
let dimmerSent = 0;
let dimmerLate;
const DIMMER_GAP_MS = 120;
/** The group the Off key of the room is for. */
let roomOffGroup = null;

export function setRoomOff(id) {
  roomOffGroup = id;
}

export function refreshDimmer() {
  roomDimmer?.refresh();
}

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

export function buildRoom() {
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
  // The page may have no key of its own for it (the other page puts Off in its tray).
  $('t-room-off')?.addEventListener('click', () => {
    if (roomOffGroup) ask('/api/playback', { group: roomOffGroup, off: true });
  });
}

// The app can be installed (manifest.webmanifest). The service worker (sw.js) keeps the page itself,
// so that it opens when lightdeck cannot be reached. A browser only has one on https and on
// localhost, and without one everything else works as before.
export function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // No service worker: the page works without it.
    });
  });
}
