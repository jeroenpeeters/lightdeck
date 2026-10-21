// The tablet page: a few big controls for a tablet that stands next to the DJ, in the dark.
// Plain browser JavaScript, no build step.
//
// It has no bar: the shell is started bare, and the page draws what it needs of it.
//
//   top row   a Menu key (a small menu over the page with the ways to the other pages, the key for
//             full screen and the link lamps with their words; the key has one dot, green when
//             all is connected and red when a link is down), the bpm with the beat lamps and a Tap key, the master and the keys of the master
//             speed, and a small blackout key
//   tempo     the Tap key of the top row. There is no slider: the tempo is
//             tapped. A tap counts when the finger lands. With Rekordbox the shell takes a tap as
//             "this is beat one" only.
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
// In every layout the order is the sequences, the spider looks and under them the room lamps, in
// one column.
//
// What it shares with the other page for a tablet (`moods.js`) is in `tabletParts.js`, and the keys are
// drawn with `tabletKit.js`.
//
// It is an installable app (the manifest and the icons, `manifest.webmanifest` and `icons/`, and
// `sw.js` that keeps the page so that it opens when lightdeck cannot be reached): on the home
// screen of the tablet it opens full screen. See the end of this file for the service worker.
//
// The page draws what the server says and asks for what the operator wants. A press is asked
// once; when it does not reach lightdeck the page says so and the operator presses again.
// Keys have a fixed size and place whatever state they are in, and notices lie over the bottom
// of the screen without taking room, so that nothing moves under a finger. A click on a notice
// clears it (it comes back when it says something else).

import { start } from './shell.js';
import { syncKeys } from './tabletKit.js';
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
  paletteItems,
  refreshDimmer,
  registerWorker,
  renderChange,
  renderLinks,
  renderNotice,
  renderRails,
  renderSequences,
  roomGroup,
  sceneItems,
  setRoomOff,
  startBeat,
} from './tabletParts.js';
import { $ } from './ui.js';

const LANES = [
  { id: 'lights', name: 'Lights' },
  { id: 'colour', name: 'Colour' },
  { id: 'motion', name: 'Motion' },
];
const NO_PALETTES = "This group's fixtures have colours of their own. Set them on their page.";

let shell;
/** The group the Off key of the panel is for. */
let offGroup = null;
/** By the id of a lane, what was built for it: its grid, its line for "none" and its keys. */
const lanes = {};
const looks = { grid: $('t-looks'), none: $('t-looks-none'), keys: new Map() };
const roomLooks = { grid: $('t-room-looks'), none: $('t-room-looks-none'), keys: new Map() };

/** The group of the spider: the one called spider, or else the first with a spider in it. */
function spiderGroup() {
  const { groups } = shell.show;
  const kindOf = (id) => shell.fixtures.find((fixture) => fixture.id === id)?.kind;
  return (
    groups.find((group) => group.id === 'spider') ??
    groups.find((group) => group.fixtures.some((id) => kindOf(id) === 'spider'))
  );
}

function renderRoom() {
  const group = roomGroup();
  $('t-room').hidden = !group;
  setRoomOff(group?.id ?? null);
  if (!group) {
    syncKeys(roomLooks, []);
    return;
  }
  renderRails();
  roomLooks.none.textContent = 'No looks for the room yet. Store them on the deck, in Program.';
  syncKeys(roomLooks, lookItems(group));
  $('t-room-off').setAttribute('aria-label', `${group.label} lights off`);
  refreshDimmer();
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

async function main() {
  shell = await start({ page: 'tablet', bare: true });
  if (!shell) return;
  init(shell);
  // The notice of the shell joins the one of the page, where it takes no room from the keys.
  $('notices').prepend($('notice'));

  buildMaster();
  buildLanes();
  buildPanel();
  buildRoom();
  buildTempo();
  buildFullscreen();
  buildMenu();

  shell.on('show', () => {
    // What was refused was about the show as it was. A press that was lost still is.
    clearFailure();
    renderKeys();
    renderSequences();
    renderNotice();
  });
  shell.on('playback', renderKeys);
  shell.on('sequence', renderSequences);
  // The dimmer of the room is set from another screen too.
  shell.on('fixtures', () => {
    refreshDimmer();
    renderRails();
  });
  shell.on('change', renderChange);
  shell.on('status', renderLinks);
  renderChange();
  renderLinks();
  renderKeys();
  renderSequences();
  renderNotice();
  startBeat();
}

main();

registerWorker();
