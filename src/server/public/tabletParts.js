// The parts of the tablet page (tablet.js) that are not its own: the notice, the controls of the lamps of
// the room, and the keys of looks and the chips of the tray (scenes and palettes). They draw into
// elements with the ids of `tablet.html`, in the classes of lightdeck.css. Plain browser JavaScript. (The
// top bar, with the tempo, the masters, the blackout and the link dots, is topbar.js, and the menu sheet
// is menu.js: both are shared with the other pages.)
//
// A page calls `init(shell)` once, builds what it uses, and calls the `render` functions when the
// shell says the state changed. A press is asked once through `ask`: when it does not reach
// lightdeck the page says so and the operator presses again.

import { drawChip, drawLook, fader, makeChip, makeLook, movesOf, stateOf } from './tabletKit.js';
import { chipMarks, splitNumber } from './tabletLogic.js';
import { $, element, makeDismissible, sentence, setNotice, speedName } from './ui.js';

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

// ---- the lamps of the room ----

/**
 * The group of the lamps of the room: the one called room, or else the first group whose fixtures
 * are all rooms (lamps driven by Home Assistant). Nothing when the rig has no such lamps.
 */
export function roomGroup() {
  const { groups } = shell.show;
  // The lamps of the room only: the switches of the decor are driven by Home Assistant too.
  const driven = (id) => shell.fixtures.find((fixture) => fixture.id === id)?.kind === 'room';
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

// ---- the sub dimmer: one fader, in the same place on every tab ----

/**
 * The control of a fixture that is its own master, by the kind of fixture (Jeroen, 2026-10-28: every
 * fixture has a sub dimmer in the same place). The laser has none: its fader is there and rests.
 */
const SUB_KEY = { spider: 'subDimmer', room: 'dimmer' };

/** The kinds of fixture that have a blackout of their own: all of them, the laser included. */
const DARK_KINDS = new Set(['spider', 'laser', 'room', 'decor']);

/** The fixtures of a group that have a blackout of their own. */
function darkFixtures(group) {
  if (!group) return [];
  return group.fixtures
    .map((id) => shell.fixtures.find((fixture) => fixture.id === id))
    .filter((fixture) => fixture && DARK_KINDS.has(fixture.kind));
}

/** Whether a group is in a blackout of its own (the blackout of the console is the page's). */
export function groupDark(group) {
  return darkFixtures(group).some((fixture) => shell.stateOf(fixture.id)?.blackout === true);
}

/** The fixtures of a group that have a sub dimmer. */
export function subFixtures(group) {
  if (!group) return [];
  return group.fixtures
    .map((id) => shell.fixtures.find((fixture) => fixture.id === id))
    .filter((fixture) => fixture && SUB_KEY[fixture.kind]);
}

const SUB_GAP_MS = 120;

/**
 * A fader that sets one level on the fixtures of the chosen group: the sub dimmer, and the strobe of the
 * spider. `fixtures(group)` lists the fixtures it sets, `current(fixture)` reads its level as a share
 * (0 to 1) and `body(fixture, share)` is what the update says. A finger that moves it is not overruled by
 * an older position from the stream until it has been away for 700 ms, and a request goes at most
 * every 120 ms, the last position always. With `plain` the bar says just `label`, not the group's name.
 */
function groupFader({ id, label, format, fixtures, current, body, noun, plain = false }) {
  let group;
  let off = true;
  let held = null;
  let holdTimer;
  let sentAt = 0;
  let lateTimer;
  const bar = fader({
    id,
    label,
    format: (number) => (off ? '–' : format(number)),
    read: () => {
      if (off) return null;
      const first = fixtures(group)[0];
      return held ?? Math.round(100 * current(first));
    },
    write: (number) => {
      held = number;
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => {
        held = null;
        bar.refresh();
      }, 700);
      const list = fixtures(group);
      if (list.length === 0) return;
      const send = () => {
        sentAt = performance.now();
        for (const fixture of list)
          ask(`/api/fixtures/${fixture.id}/update`, body(fixture, number / 100));
      };
      clearTimeout(lateTimer);
      const wait = SUB_GAP_MS - (performance.now() - sentAt);
      if (wait <= 0) send();
      else lateTimer = setTimeout(send, wait);
    },
  });
  /** Points the fader at a group: its name, and whether the group has anything to set. */
  bar.point = (next) => {
    if (group?.id !== next?.id) {
      held = null;
      clearTimeout(holdTimer);
      clearTimeout(lateTimer);
    }
    group = next;
    off = fixtures(next).length === 0;
    const name = next ? `${next.label} ${noun}` : label;
    // `plain` keeps the short name on the bar (it is narrow); a reader still hears the group.
    bar.querySelector('.fl').textContent = plain ? label : name;
    bar.input.setAttribute('aria-label', name);
    bar.title = off ? `${next?.label ?? 'This group'} has no ${noun}` : '';
    bar.refresh();
  };
  return bar;
}

let subGroup;
let sub;
let strobe;

/** The fixtures of a group that have a strobe to set: the spiders. */
export function strobeFixtures(group) {
  if (!group) return [];
  return group.fixtures
    .map((id) => shell.fixtures.find((fixture) => fixture.id === id))
    .filter((fixture) => fixture?.kind === 'spider');
}

/** The key of the blackout of the group: lit while it is on, Lift when pressed again. */
function drawDark() {
  const key = $('t-sub-dark');
  const fixtures = darkFixtures(subGroup);
  const on = groupDark(subGroup);
  key.disabled = fixtures.length === 0;
  key.classList.toggle('is-on', on);
  key.classList.toggle('is-disabled', fixtures.length === 0);
  key.setAttribute('aria-pressed', String(on));
  key.textContent = on ? 'Lift' : 'Blackout';
  key.setAttribute(
    'aria-label',
    `${subGroup?.label ?? 'Group'} ${on ? 'lift blackout' : 'blackout'}`,
  );
}

/** Shows the faders and the blackout key again from the state, for the group they belong to. */
export function refreshSub() {
  sub?.refresh();
  strobe?.refresh();
  drawDark();
}

/** Points the dimmer and the strobe at a group. The strobe is there for the spider only. */
export function renderSub(group) {
  subGroup = group;
  sub.point(group);
  // The decor has no dimmer of its own here: the UV lamps and the pipes have one each, in their rows (Jeroen:
  // they are not the same at all). The place of the fader stays, empty, so the blackout key does not move.
  const decorOnly =
    group !== undefined &&
    group.fixtures.length > 0 &&
    group.fixtures.every(
      (id) => shell.fixtures.find((fixture) => fixture.id === id)?.kind === 'decor',
    );
  $('t-sub-dimmer').style.visibility = decorOnly ? 'hidden' : '';
  strobe.point(group);
  $('t-sub-strobe').hidden = strobeFixtures(group).length === 0;
  drawDark();
}

export function buildSub() {
  sub = groupFader({
    id: 't-sub-level',
    label: 'Dimmer',
    noun: 'dimmer',
    format: String,
    fixtures: subFixtures,
    current: (fixture) => shell.stateOf(fixture.id)?.[SUB_KEY[fixture.kind]] ?? 1,
    body: (fixture, share) => ({ [SUB_KEY[fixture.kind]]: share }),
  });
  $('t-sub-dimmer').append(sub);
  // The strobe over whatever effect runs (Jeroen, 2026-10-30): 0 is off, more is faster flashes, within
  // the flash limit of the fixture. It is the lights' own strobe channel, so it goes with any effect.
  strobe = groupFader({
    id: 't-sub-strobe-level',
    label: 'Strobe',
    noun: 'strobe',
    plain: true,
    format: (number) => (number === 0 ? 'Off' : String(number)),
    fixtures: strobeFixtures,
    current: (fixture) => shell.stateOf(fixture.id)?.levels?.strobe ?? 0,
    body: (_fixture, share) => ({ levels: { strobe: share } }),
  });
  $('t-sub-strobe').append(strobe);
  // The blackout of this group alone: dark with everything kept, and a second press lifts it.
  $('t-sub-dark').addEventListener('click', () => {
    const on = groupDark(subGroup);
    for (const fixture of darkFixtures(subGroup)) {
      ask(`/api/fixtures/${fixture.id}/update`, { blackout: !on });
    }
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
