// The top bar of every page of the console: always there, in the same place, on the page for a tablet and on
// every setup page (design `design/mockups/01`, `06`, `07`). Plain browser JavaScript, no build step. One
// implementation draws it for all of them; a page does not make its own.
//
//   const bar = mountTopBar(shell, { left: 'menu' });   the tablet page: a Menu key
//   const bar = mountTopBar(shell, { left: 'live' });   a setup page: a Live key (the shell does this
//                                                       itself for every page that is not `bare`)
//
// `shell` is what `start()` of shell.js gives back. The bar is put first in `host` (default: the element
// with the class `app`, else the body) and draws itself from the shell: it listens to the shell's `change`
// and `status` events and counts the beat lamps by itself, so a page has nothing to call. What it holds,
// from the left:
//
//   key       `menu`: three bars, the three link dots (Bridge, LR512 and Home Assistant: green when it is
//             fine, red when it is down, hollow when it is made up or not asked for) and, while the
//             menu sheet is open, an X and the word Close in the same place. A press calls `bar.onMenu()`.
//             `live`: a link (`<a href="/tablet">`) with a chevron, the word Live and the same dots:
//             one press goes back to the live page.
//   tempo     the bpm and where the tempo comes from (By hand, Rekordbox), and the beat lamps
//   Tap       a tap counts when the finger lands; with Rekordbox it rests (the beat comes from rekordbox)
//   Master    the master fader
//   speed     the keys of the master speed (÷4 ... ×4)
//   Blackout  on the right: outlined in red, filled while the blackout is on
//
// It gives back `{ root, key, onMenu, setMenuOpen(open), renderChange(), renderLinks() }`. The menu sheet
// (menu.js) sets `bar.onMenu` and calls `setMenuOpen`. Which tempo source is on, the nudge keys and what
// rekordbox says live in the menu, not here.
//
// The ids of its parts are `top`, `tb-menu`, `tb-dot-bridge`, `tb-dot-device`, `tb-dot-hass`, `tb-bpm`,
// `tb-src`, `tb-beats`, `tb-tap`, `tb-master` (the holder; the fader itself is `tb-master-level`), `tb-speed`
// and `tb-blackout`. Its styles are in chrome.css (the classes `top`, `menu`, `tb-*`).

import { element, fader, masterPercent, speedName, speedPick } from './ui.js';

const BEATS_PER_BAR = 4;

const MENU_ICON =
  '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h14" /></svg>';
const CLOSE_ICON =
  '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 4l12 12M16 4L4 16" /></svg>';
const LIVE_ICON =
  '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 4l-6 6 6 6" /></svg>';

function dot(id) {
  const made = element('i');
  made.id = id;
  return made;
}

/** The class of a link dot: green (none) when fine, `lost` when down, `sim` when made up or not asked for. */
const dotClass = (link) => (link.state === 'down' ? 'lost' : link.state === 'ok' ? '' : 'sim');

export function mountTopBar(shell, { left = 'live', host } = {}) {
  const root = element('header', 'top');
  root.id = 'top';

  // ---- the key on the left ----
  const live = left === 'live';
  const key = element(live ? 'a' : 'button', `menu ${live ? 'live' : 'menu-key'}`);
  key.id = 'tb-menu';
  const dots = element('span', 'dots');
  dots.setAttribute('aria-hidden', 'true');
  const dotBridge = dot('tb-dot-bridge');
  const dotDevice = dot('tb-dot-device');
  const dotHass = dot('tb-dot-hass');
  dotHass.hidden = true;
  dots.append(dotBridge, dotDevice, dotHass);
  const icon = element('span', 'ic');
  icon.innerHTML = live ? LIVE_ICON : MENU_ICON;
  const word = element('span', 'word', live ? 'Live' : 'Menu');
  key.append(icon, word, dots);
  if (live) {
    key.href = '/tablet';
  } else {
    key.type = 'button';
    key.setAttribute('aria-expanded', 'false');
  }

  // ---- the tempo ----
  const tempo = element('div', 'tempo tb-tempo');
  const bpm = element('span', 'bpm num');
  bpm.id = 'tb-bpm';
  const source = element('span', 'src');
  source.id = 'tb-src';
  const stack = element('div', 'col');
  stack.style.gap = '2px';
  stack.append(bpm, source);
  const beats = element('div', 'beats');
  beats.id = 'tb-beats';
  beats.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < BEATS_PER_BAR; i++) beats.append(element('i', i === 0 ? 'one' : ''));
  tempo.append(stack, beats);

  const tap = element('button', 'key c tb-tap', 'Tap');
  tap.id = 'tb-tap';
  tap.type = 'button';
  // A tap counts when the finger lands, not when it lifts. The click covers the keyboard.
  tap.addEventListener('pointerdown', (event) => {
    if (event.button === 0) shell.tap();
  });
  tap.addEventListener('click', (event) => {
    if (event.detail === 0) shell.tap();
  });

  const masterHolder = element('div', 'tb-master');
  masterHolder.id = 'tb-master';
  const master = fader({
    id: 'tb-master-level',
    label: 'Master',
    read: () => masterPercent(shell.master),
    write: (number) => shell.setMaster(number / 100),
  });
  masterHolder.append(master);

  const speed = element('fieldset', 'tb-speed');
  speed.id = 'tb-speed';
  speed.setAttribute('aria-label', 'Master speed');
  const showSpeed = speedPick(speed, shell.rates.map(speedName), shell.rates, shell.setRate);

  const blackout = element('button', 'bo tb-blackout', 'Blackout');
  blackout.id = 'tb-blackout';
  blackout.type = 'button';
  blackout.setAttribute('aria-pressed', 'false');
  blackout.addEventListener('click', () => shell.setBlackout(!shell.blackout));

  root.append(key, tempo, tap, masterHolder, speed, blackout);
  (host ?? document.querySelector('.app') ?? document.body).prepend(root);

  const bar = { root, key, onMenu: null, setMenuOpen, renderChange, renderLinks };

  function setMenuOpen(open) {
    if (live) return;
    key.setAttribute('aria-expanded', String(open));
    key.classList.toggle('is-open', open);
    icon.innerHTML = open ? CLOSE_ICON : MENU_ICON;
    word.textContent = open ? 'Close' : 'Menu';
    renderLinks();
  }

  if (!live) key.addEventListener('click', () => bar.onMenu?.());

  /** The links, as dots on the key: no words, the words are in the menu. */
  function renderLinks() {
    const { bridge, device, hass } = shell.links;
    const links = [
      [dotBridge, bridge],
      [dotDevice, device],
    ];
    // Home Assistant has a lamp only when a fixture is driven by it.
    dotHass.hidden = hass === undefined;
    if (hass) links.push([dotHass, hass]);
    for (const [made, link] of links) made.className = dotClass(link);
    const wrong = links.some(([, link]) => link.state === 'down');
    const state = wrong ? 'something is not connected' : 'everything is connected';
    const open = key.classList.contains('is-open');
    if (live) key.setAttribute('aria-label', `Back to the live page, ${state}`);
    else key.setAttribute('aria-label', open ? 'Close the menu' : `Menu, ${state}`);
  }

  /** The masters, the tempo and the blackout moved, here or on another screen. */
  function renderChange() {
    master.refresh();
    showSpeed(shell.tempo.rate);
    bpm.textContent = String(Math.round(shell.tempo.bpm));
    const rekordbox = shell.tempo.source === 'rekordbox';
    source.textContent = rekordbox ? 'Rekordbox' : 'By hand';
    // Rekordbox sends the beat, so there is nothing to tap. The key stays where it is, and rests.
    tap.disabled = rekordbox;
    tap.classList.toggle('is-disabled', rekordbox);
    const on = shell.blackout;
    blackout.setAttribute('aria-pressed', String(on));
    blackout.classList.toggle('is-on', on);
    blackout.textContent = on ? 'Lift blackout' : 'Blackout';
  }

  // A lamp for each beat of the bar; while the tempo does not run, the effects are idle and so is the beat.
  let lit = -1;
  function drawBeat() {
    const index = shell.tempo.running
      ? ((Math.floor(shell.beat()) % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR
      : -1;
    if (index !== lit) {
      lit = index;
      [...beats.children].forEach((lamp, i) => {
        lamp.classList.toggle('lit', i === index);
      });
    }
    requestAnimationFrame(drawBeat);
  }

  shell.on('change', renderChange);
  shell.on('status', renderLinks);
  renderChange();
  renderLinks();
  requestAnimationFrame(drawBeat);
  return bar;
}
