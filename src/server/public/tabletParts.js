// The parts of the tablet page (tablet.js) that are not its own: the notice, the tempo, the masters,
// the blackout, the link dots and the controls of the lamps of the room, and the keys of looks and
// the chips of the tray (scenes and palettes). They draw into elements with the ids of `tablet.html`,
// in the classes of lightdeck.css. Plain browser JavaScript.
//
// A page calls `init(shell)` once, builds what it uses, and calls the `render` functions when the
// shell says the state changed. A press is asked once through `ask`: when it does not reach
// lightdeck the page says so and the operator presses again.

import { masterPercent } from './shell.js';
import {
  drawChip,
  drawLook,
  fader,
  makeChip,
  makeLook,
  movesOf,
  speedPick,
  stateOf,
} from './tabletKit.js';
import { chipMarks, splitNumber } from './tabletLogic.js';
import { $, element, makeDismissible, sentence, setNotice, speedName } from './ui.js';

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

/** The id that the look that is on sets in a lane (a scene, or for the colour a palette), if any. */
function ownOf(group, type) {
  const look = onLook(group).item;
  if (!look) return undefined;
  return type === 'colour' ? look.colour?.palette : look[type];
}

/**
 * Chips for a lane of the tray: the scenes of a type, or the palettes, or those of `ids` in that order.
 * A chip is on when the lane has it on and dashed when the look that is on sets it. A chip is for a
 * group and a scene, so the id of the chip says both.
 */
export function chipItems(group, type, ids) {
  const colour = type === 'colour';
  if (colour && group.palettes === false) return [];
  const on = onIn(group, type).item?.id;
  const own = ownOf(group, type);
  const all = colour ? palettes() : group.scenes.filter((scene) => scene.type === type);
  const chosen = ids ? ids.map((id) => all.find((each) => each.id === id)).filter(Boolean) : all;
  return chosen.map((item) => ({
    id: `${group.id}:${item.id}`,
    make: () =>
      makeChip(
        () => ask('/api/playback', { group: group.id, [colour ? 'palette' : 'scene']: item.id }),
        { strip: colour },
      ),
    draw: (chip) => {
      const marks = chipMarks(item.id, on, own);
      drawChip(chip, {
        label: item.label,
        ...marks,
        colours: colour ? item.colours : undefined,
        title: colour ? `${item.label} · ${movesOf(item) || 'static'}` : item.label,
      });
    },
  }));
}

/**
 * Keys for the looks of `chosen` (or all of the group's): the number and the name, a tag when varied
 * or next, the colours of its palette and what it names. `next` is `{ look, bars }` for the look that
 * the sequence that runs sets next in this group, or null.
 */
export function lookItems(group, { chosen = group.looks, next = null } = {}) {
  const on = onLook(group);
  return chosen.map((look) => ({
    id: `${group.id}:${look.id}`,
    make: () => makeLook(() => ask('/api/playback', { group: group.id, look: look.id })),
    draw: (key) => {
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
    },
  }));
}

/** What a lane has on in the group, in words, and whether it is not what it was set to. */
export function laneWords(group, type) {
  const { item, changed } = onIn(group, type);
  return {
    text: item?.label ?? '',
    changed,
    colours: type === 'colour' ? item?.colours : undefined,
  };
}

// ---- the top row ----

/**
 * The links stand in the menu, with their words, and the key of the menu has a dot for each of them
 * without words: green when it is fine, red when it is down, hollow when it is made up (simulated) or
 * not asked for. A link that is not there (no bridge asked for) or made up is not wrong.
 */
export function renderLinks() {
  const { bridge, device, hass } = shell.links;
  const links = [
    ['t-link-bridge', 't-dot-bridge', bridge],
    ['t-link-device', 't-dot-device', device],
  ];
  // Home Assistant has a lamp only when a fixture is driven by it.
  $('t-link-hass').hidden = hass === undefined;
  $('t-dot-hass').hidden = hass === undefined;
  if (hass) links.push(['t-link-hass', 't-dot-hass', hass]);
  for (const [id, dot, link] of links) {
    $(id).dataset.state = link.state;
    $(id).querySelector('.link-text').textContent = link.text;
    $(dot).className = link.state === 'down' ? 'lost' : link.state === 'ok' ? '' : 'sim';
  }
  const wrong = links.some(([, , link]) => link.state === 'down');
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

let master;
let showSpeed = () => {};

export function buildMaster() {
  master = fader({
    id: 't-master-level',
    label: 'Master',
    read: () => masterPercent(shell.master),
    write: (number) => shell.setMaster(number / 100),
  });
  $('t-master').append(master);
  showSpeed = speedPick($('t-speed'), shell.rates.map(speedName), shell.rates, shell.setRate);
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
  master.refresh();
  showSpeed(shell.tempo.rate);
  $('t-bpm').textContent = String(Math.round(shell.tempo.bpm));
  const rekordbox = shell.tempo.source === 'rekordbox';
  $('t-src').textContent = rekordbox ? 'Rekordbox' : 'By hand';
  // Rekordbox sends the beat, so there is nothing to tap. The key stays where it is, and rests.
  const tap = $('t-tap');
  tap.disabled = rekordbox;
  tap.classList.toggle('is-disabled', rekordbox);
  const on = shell.blackout;
  const key = $('t-blackout');
  key.setAttribute('aria-pressed', String(on));
  key.classList.toggle('is-on', on);
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
      lamp.classList.toggle('lit', i === index);
    });
  }
  requestAnimationFrame(drawBeat);
}

export function startBeat() {
  requestAnimationFrame(drawBeat);
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
      key = element('button', 'key c t-rail', zone.label);
      key.type = 'button';
      key.addEventListener('click', () => {
        const on = (shell.stateOf(fixture.id)?.zones?.[zone.id] ?? 1) > 0;
        ask(`/api/fixtures/${fixture.id}/update`, { zones: { [zone.id]: on ? 0 : 1 } });
      });
      rails.set(zone.id, key);
      holder.append(key);
    }
    key.textContent = zone.label;
    const on = (current[zone.id] ?? 1) > 0;
    key.classList.toggle('is-on', on);
    key.setAttribute('aria-pressed', String(on));
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
  roomDimmer = fader({
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
