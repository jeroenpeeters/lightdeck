// The controls of the video wall (Jeroen, 2026-10-23; the design of the console, mockup 05, since
// 2026-10-26), for the page /videowall and for the tab of the tablet page. Plain browser JavaScript, no
// build step. It builds its own elements, so a page only gives it a place:
//
//   const wall = mountVideoWall(root, { shell, ask });            the tab of the tablet page
//   const wall = mountVideoWall(root, { shell, ask, side });      the setup page /videowall
//   wall.render()                          draw again from the state of the shell
//   wall.activate() / wall.deactivate()    the panel is on screen or not: the picture of the wall is
//                                          read (every 2 s) only while it is
//
// Three parts, put together the way the page asks:
//
//   The library   the kinds of the player (Playlists, Videos, Effects, Texts) as tabs and the items as
//                 keys with a preview: a press plays it with the transition that is chosen (the
//                 player's own playback: `/api/videowall/play` and so on, nothing to do with the text)
//   The side      "On the wall": whether the player answers, a picture of what plays with the text that
//                 is on the wall, its time, the transition for the next one, the track text (On or
//                 off, Test, Clear, Send current track, and three lines about what was sent) and the
//                 player's own Wall blackout
//   The settings  the address and the PIN of the player, how long the text stays, one or two lines,
//                 the filter, the colour, the size and the place, with a sketch of the wall
//
// On the tablet page (no `side`) root holds the library and the side next to each other, as in the
// mockup, and the settings are a fifth tab of the library, Text settings, which takes the place of the
// keys while it is chosen (the operator changes the place or the time of the text during the show, and
// the mockup has no room for them beside the library). On the setup page root holds the settings and the
// library one under the other, and the side goes into the element given as `side` (the side panel of
// the page).
//
// The server does the work (`src/server/videoWall.ts`): this draws what it says (`shell.videowall`)
// and asks for a change through `ask(url, body)` (which answers `{ ok, error, lost }` and shows the
// problem to the operator). A setting is sent a moment after the last change as one request, and
// what was changed here is drawn from the page until the server has told of it, so that a slider or
// a field is not set back under the finger. The PIN is never given back: the page only knows that
// there is one. The library and the status are read with a plain GET: they change nothing.
//
// Keys keep their size and place whatever they say: a state swaps classes, the previews have a shape
// of their own, and the lines that change keep their height. The styles are in videowall.css.

import { button, choiceKeys, element, slider } from './ui.js';

/** How long after the last change a request is sent. */
const SEND_AFTER_MS = 250;
/** How long what this page changed is drawn from the page, once it is sent. */
const SETTLE_MS = 1500;
/** How often the picture of the wall is read while the panel is on screen. */
const POLL_MS = 2000;
/** How long a library is kept before the panel reads it again when it comes on screen. */
const LIBRARY_MS = 60_000;

const PRESETS = [
  { id: 10, label: '10 s' },
  { id: 30, label: '30 s' },
  { id: 60, label: '1 min' },
  { id: 0, label: 'Stay' },
];
const LINES = [
  { id: 'one', label: 'One line' },
  { id: 'two', label: 'Two lines' },
];
const VERTICALS = ['top', 'center', 'bottom'];
const HORIZONTALS = ['left', 'center', 'right'];
const TRANSITIONS = ['none', 'fade', 'zoom', 'slide', 'wipe'];
const KINDS = [
  { id: 'playlists', name: 'Playlists' },
  { id: 'videos', name: 'Videos' },
  { id: 'effects', name: 'Effects' },
  { id: 'texts', name: 'Texts' },
];
/** The tab of the tablet page that holds the settings of the track text instead of library keys. */
const SETTINGS = 'settings';

const trackText = ({ title, artist }) => (artist ? `${title} - ${artist}` : title);

const clock = (seconds) => {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

/** A name over one control: `<label class="fld">`. */
function field(name, control, ...more) {
  const made = element('label', 'fld');
  made.append(element('span', 'lbl', name), control, ...more);
  return made;
}

/** A name over a set of controls: a fieldset with the name as its legend. */
function group(name, ...content) {
  const made = element('fieldset', 'fld');
  made.append(element('legend', 'lbl', name), ...content);
  return made;
}

/** A panel with a header (`.sh`): a name and, at the right, a word about it. */
function panel(name, aside) {
  const made = element('section', 'panel wl-panel');
  const head = element('div', 'sh');
  head.append(element('h3', '', name));
  if (aside) head.append(aside);
  made.append(head);
  return made;
}

/** Puts the text of a sketch where the settings say: the sketch is a box with a `--wall-size`. */
function placeText(text, current) {
  text.style.setProperty('--wall-size', String(current.size));
  text.style.color = current.color;
  text.style.top = current.vertical === 'top' ? '0' : current.vertical === 'center' ? '50%' : '';
  text.style.bottom = current.vertical === 'bottom' ? '0' : '';
  text.style.left =
    current.horizontal === 'left' ? '0' : current.horizontal === 'center' ? '50%' : '';
  text.style.right = current.horizontal === 'right' ? '0' : '';
  text.style.textAlign = current.horizontal;
  const shift = [
    current.horizontal === 'center' ? '-50%' : '0',
    current.vertical === 'center' ? '-50%' : '0',
  ];
  text.style.transform = `translate(${shift[0]}, ${shift[1]})`;
}

export function mountVideoWall(root, { shell, ask, side: sideHost }) {
  const setup = sideHost !== undefined;
  root.classList.add('wl', setup ? 'wl-setup' : 'wl-live');

  // ---- what is drawn, and the state of the panel ----

  /** What this page changed and the server has not told of yet, drawn over the settings. */
  let draft = {};
  let pending = {};
  let sendTimer;
  let settleTimer;
  let sizeSlider;
  let active = false;
  let pollTimer;
  /** The kind of library that is shown. */
  let kind = 'playlists';
  let library = null;
  let libraryAt = 0;
  let libraryFor = '';
  let libraryError = '';
  let reading = false;
  let status = null;
  let statusError = '';
  /** The transition the operator chose for what is played next; without one the player's own. */
  let transition = null;
  /** The picture drawn for what plays, so that the image is only asked for when it changes. */
  let drawnPicture = null;

  const settings = () => ({ ...shell.videowall.settings, ...draft });

  const els = {};

  // ---- the library ----

  const libraryBox = element('section', 'wl-library');
  libraryBox.setAttribute('aria-label', 'Library of the player');
  const libraryHead = element('div', 'wl-head');
  els.kinds = element('div', 'tabs');
  els.kinds.setAttribute('role', 'tablist');
  els.kinds.setAttribute('aria-label', 'Kind of item');
  els.kindKeys = KINDS.map(({ id, name }) => {
    const key = button('tab', name, () => {
      kind = id;
      renderLibrary();
    });
    key.setAttribute('role', 'tab');
    const count = element('span', 'ct');
    key.append(count);
    els.kinds.append(key);
    return { id, key, count, name };
  });
  if (!setup) {
    els.settingsKey = button('tab wl-settings-tab', 'Text settings', () => {
      kind = SETTINGS;
      renderLibrary();
    });
    els.settingsKey.setAttribute('role', 'tab');
    els.kinds.append(els.settingsKey);
  }
  els.refresh = button('key c wl-refresh', 'Refresh', () => readLibrary(true));
  libraryHead.append(els.kinds, els.refresh);
  els.items = element('div', 'wl-items');
  // The foot says how a press works (and, on the tablet page, where the settings are). It keeps its room
  // all the time, and says what went wrong with the library instead while something did.
  els.foot = element('p', 'hint wl-foot');
  els.footHint = element('span');
  els.footHint.textContent = setup
    ? 'A press plays it on the wall with the transition chosen under On the wall. Playing does not change the track text.'
    : 'A press plays it on the wall with the transition chosen next to it. Playing does not change the track text; its place, size and time are under Text settings.';
  els.footError = element('span', 'wl-error');
  els.footError.hidden = true;
  els.foot.append(els.footHint, els.footError);
  libraryBox.append(libraryHead, els.items, els.foot);

  // ---- the side: on the wall ----

  const side = element('aside', 'wl-side');
  side.setAttribute('aria-label', 'On the wall');

  els.connection = element('span', 'wl-conn');
  els.dot = element('i', 'ldot');
  els.dot.dataset.state = 'unknown';
  els.connectionText = element('span', '', 'Reading');
  els.connection.append(els.dot, els.connectionText);
  const wallHead = element('div', 'sh');
  wallHead.append(element('h3', '', 'On the wall'), els.connection);

  els.picture = element('div', 'wl-picture');
  els.picture.setAttribute('aria-hidden', 'true');
  els.pictureText = element('span', 'wl-sketch-text');
  els.picture.append(els.pictureText);

  els.playing = element('span', 'wl-title');
  els.time = element('span', 'num t2 wl-time');
  const nowRow = element('div', 'wl-now-row');
  nowRow.append(els.playing, els.time);
  els.progress = element('i');
  const bar = element('div', 'wl-bar');
  bar.append(els.progress);
  els.playingSub = element('span', 't3 wl-sub');
  const now = element('div', 'wl-now');
  now.append(nowRow, bar, els.playingSub);
  const wallBlock = element('div', 'wl-block wl-wall');
  wallBlock.append(wallHead, els.picture, now);

  // The transition for the next one.
  els.transitions = element('div', 'wl-trans');
  els.transitionKeys = TRANSITIONS.map((name) => {
    const key = button('chip', name[0].toUpperCase() + name.slice(1), () => {
      transition = name;
      renderPlayer();
    });
    els.transitions.append(key);
    return { name, key };
  });
  const transitionBlock = element('div', 'wl-block wl-transition');
  const transitionHead = element('div', 'sh');
  transitionHead.append(element('h3', '', 'Transition for the next one'));
  transitionBlock.append(transitionHead, els.transitions);

  // The track text.
  els.track = element('span', 't2 wl-track');
  const textHead = element('div', 'sh');
  textHead.append(element('h3', '', 'Track text'), els.track);
  els.enabled = button('key c wl-switch', 'Text off', () =>
    change({ enabled: !settings().enabled }),
  );
  els.enabled.setAttribute('aria-pressed', 'false');
  const test = button('key c', 'Test', () => ask('/api/videowall/test'));
  test.setAttribute('aria-label', 'Test text');
  const clear = button('key c', 'Clear', () => ask('/api/videowall/clear'));
  clear.setAttribute('aria-label', 'Clear now');
  const textKeys = element('div', 'wl-text-keys');
  textKeys.append(els.enabled, test, clear);
  els.send = button('key c', 'Send current track', () => ask('/api/videowall/send'));
  els.shown = element('span', 'wl-line');
  els.last = element('span', 'wl-line');
  const lines = element('div', 'wl-lines');
  lines.append(els.shown, els.last);
  const textBlock = element('div', 'wl-block wl-text');
  textBlock.append(textHead, textKeys, els.send, lines);

  els.blackout = button('bo wl-blackout', 'Wall blackout', () => blackout());
  els.blackout.setAttribute('aria-pressed', 'false');

  side.append(wallBlock, transitionBlock, textBlock, els.blackout);

  // ---- the settings (the setup page only) ----

  function buildSettings() {
    els.url = element('input', 'field');
    Object.assign(els.url, {
      id: 'wall-url',
      type: 'text',
      autocomplete: 'off',
      spellcheck: false,
    });
    els.url.inputMode = 'url';
    els.url.addEventListener('change', () => change({ url: els.url.value }));

    els.pin = element('input', 'field');
    Object.assign(els.pin, {
      id: 'wall-pin',
      type: 'password',
      autocomplete: 'off',
      maxLength: 40,
    });
    els.pin.addEventListener('change', () => {
      if (els.pin.value === '') return;
      change({ pin: els.pin.value });
      els.pin.value = '';
    });
    els.pinClear = button('key c', 'Remove PIN', () => change({ pin: '' }));
    els.pinClear.id = 'wall-pin-clear';
    const pinRow = element('div', 'wl-pin');
    pinRow.append(els.pin, els.pinClear);

    const player = panel('Player');
    const where = element('div', 'wl-fields');
    where.append(
      field('Address of the player', els.url),
      group('PIN of the player, if it has one', pinRow),
    );
    player.append(where);

    els.seconds = element('input', 'field');
    Object.assign(els.seconds, { id: 'wall-seconds', type: 'number', min: 0, max: 3600, step: 1 });
    els.seconds.inputMode = 'numeric';
    els.seconds.setAttribute('aria-label', 'Seconds the text stays');
    els.seconds.addEventListener('change', () => {
      const seconds = Number(els.seconds.value);
      if (els.seconds.value !== '' && Number.isFinite(seconds))
        change({ durationSeconds: seconds });
    });
    const presetHolder = element('div');
    els.showPreset = choiceKeys(presetHolder, PRESETS, (seconds) =>
      change({ durationSeconds: seconds }),
    );
    const secondsRow = element('div', 'wl-seconds');
    secondsRow.append(els.seconds, element('span', 't2', 'seconds'), presetHolder);

    const lineHolder = element('div');
    els.showLines = choiceKeys(lineHolder, LINES, (lines) => change({ lines }));

    els.filter = element('input', 'field');
    Object.assign(els.filter, {
      id: 'wall-filter',
      type: 'text',
      autocomplete: 'off',
      spellcheck: false,
      maxLength: 200,
    });
    els.filter.addEventListener('change', () => change({ titleFilter: els.filter.value }));
    els.result = element('span', 'wl-result');

    els.colour = element('input', 'wl-colour');
    Object.assign(els.colour, { id: 'wall-colour', type: 'color' });
    els.colour.addEventListener('change', () => change({ color: els.colour.value }));

    sizeSlider = slider({
      id: 'wall-size',
      label: 'Text size',
      min: 1,
      max: 50,
      read: () => settings().size,
      write: (size) => change({ size }),
      meaning: (size) => `${size}% of the height of the screen`,
    });

    const text = panel('Text');
    const fields = element('div', 'wl-fields');
    fields.append(
      group(
        'How long the text stays',
        secondsRow,
        element('span', 'hint', '0 leaves it up until the next track replaces it.'),
      ),
      group('Lines', lineHolder),
      field(
        'Cut this out of the title (regular expression)',
        els.filter,
        element(
          'span',
          'hint',
          'Case does not count, every match goes. Empty cuts nothing. The default takes (Original Mix), [Extended Mix] and - Radio Edit off the end.',
        ),
        els.result,
      ),
      field('Colour', els.colour),
      sizeSlider,
    );
    text.append(fields);

    els.cells = [];
    const grid = element('div', 'wl-grid');
    for (const vertical of VERTICALS) {
      for (const horizontal of HORIZONTALS) {
        const key = button(
          'key c',
          `${vertical} ${horizontal}`.replace('center center', 'middle'),
          () => change({ vertical, horizontal }),
        );
        key.setAttribute('aria-label', `${vertical}, ${horizontal}`);
        grid.append(key);
        els.cells.push({ vertical, horizontal, key });
      }
    }
    els.sketch = element('div', 'wl-picture wl-sketch');
    els.sketch.setAttribute('aria-hidden', 'true');
    els.sketchText = element('span', 'wl-sketch-text');
    els.sketch.append(els.sketchText);
    const place = panel('Position');
    const placeBody = element('div', 'wl-fields');
    placeBody.append(
      grid,
      els.sketch,
      element(
        'p',
        'hint',
        'A sketch of the wall. The player makes a text that is too wide for the screen smaller.',
      ),
    );
    place.append(placeBody);

    const left = element('div', 'wl-col');
    // The address and the PIN are set once: on the tablet they come after what is changed during a show.
    if (setup) left.append(player, text);
    else left.append(text, player);
    const right = element('div', 'wl-col');
    right.append(place);
    const both = element('div', 'wl-settings');
    both.append(left, right);
    return both;
  }

  els.settings = buildSettings();
  if (setup) {
    root.append(els.settings, libraryBox);
    sideHost.append(side);
  } else {
    // The settings take the place of the keys of the library while their tab is chosen.
    els.settings.hidden = true;
    libraryBox.insertBefore(els.settings, els.foot);
    root.append(libraryBox, side);
  }

  // ---- changing a setting ----

  /** Changes a setting: drawn at once, sent a moment after the last change. */
  function change(patch) {
    const { pin, ...visible } = patch;
    draft = { ...draft, ...visible };
    pending = { ...pending, ...patch };
    clearTimeout(sendTimer);
    clearTimeout(settleTimer);
    sendTimer = setTimeout(flush, SEND_AFTER_MS);
    render();
  }

  async function flush() {
    const body = pending;
    pending = {};
    if (Object.keys(body).length === 0) return;
    const answer = await ask('/api/videowall', body);
    // What the server refused is drawn as it is again, once the server has said so.
    settleTimer = setTimeout(
      () => {
        draft = {};
        render();
      },
      answer.ok ? SETTLE_MS : 0,
    );
    if (answer.ok && ('url' in body || 'pin' in body)) readLibrary(true);
  }

  // ---- the player: reading it and pressing on it ----

  async function get(url) {
    const response = await fetch(url, { cache: 'no-store' });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(answer.error ?? response.statusText);
    return answer;
  }

  async function readStatus() {
    try {
      status = await get('/api/videowall/status');
      statusError = '';
    } catch (error) {
      status = null;
      statusError =
        error instanceof TypeError ? 'This page cannot reach lightdeck.' : error.message;
    }
    renderPlayer();
  }

  async function readLibrary(force = false) {
    const wanted = settings().url;
    if (reading) return;
    if (!force && library && libraryFor === wanted && Date.now() - libraryAt < LIBRARY_MS) return;
    reading = true;
    els.refresh.disabled = true;
    try {
      library = await get('/api/videowall/library');
      libraryError = '';
    } catch (error) {
      libraryError =
        error instanceof TypeError ? 'This page cannot reach lightdeck.' : error.message;
    }
    libraryAt = Date.now();
    libraryFor = wanted;
    reading = false;
    els.refresh.disabled = false;
    renderLibrary();
  }

  async function play(item) {
    const url = item.playlist ? '/api/videowall/playlist' : '/api/videowall/play';
    const answer = await ask(url, { id: item.id, ...(transition ? { transition } : {}) });
    if (answer.ok) readStatus();
  }

  async function blackout() {
    const answer = await ask('/api/videowall/blackout', { value: !status?.blackout });
    if (answer.ok) readStatus();
  }

  // ---- drawing ----

  function secondsLeft(hideAt) {
    return Math.max(0, Math.ceil((hideAt - Date.now()) / 1000));
  }

  /** The lines about the text: they count down, so they are drawn on their own as well. */
  function renderLines() {
    const { track, shown, last } = shell.videowall;
    els.track.textContent = track ? trackText(track) : 'Waiting for rekordbox';
    els.track.title = els.track.textContent;
    const text = shown?.text.replace(/\n/g, ' / ');
    if (!shown) els.shown.textContent = 'On the wall: nothing';
    else if (shown.hideAt === null)
      els.shown.textContent = `On the wall: ${text} · until the next track`;
    else els.shown.textContent = `On the wall: ${text} · goes in ${secondsLeft(shown.hideAt)} s`;
    const bad = last !== null && !last.ok;
    els.last.dataset.bad = String(bad);
    if (!last) els.last.textContent = 'Last call: none yet';
    else if (bad) els.last.textContent = `Last call: ${last.error}`;
    else
      els.last.textContent =
        last.action === 'show' ? 'Last call: text shown' : 'Last call: text taken away';
    els.shown.title = els.shown.textContent;
    els.last.title = els.last.textContent;
  }

  /** The preview of what plays: the player's own picture of the item, when the library has one. */
  function thumbOf(media) {
    if (!media || !library) return null;
    for (const list of [library.videos, library.effects, library.texts]) {
      const found = list.find((item) => item.id === media.id);
      if (found) return found.thumb;
    }
    return null;
  }

  function drawPicture(thumb) {
    if (thumb === drawnPicture) return;
    drawnPicture = thumb;
    els.picture.querySelector('img')?.remove();
    if (!thumb) return;
    const image = element('img');
    image.alt = '';
    image.decoding = 'async';
    image.src = `/api/videowall/image?path=${encodeURIComponent(thumb)}`;
    els.picture.prepend(image);
  }

  function renderPlayer() {
    const media = status?.media;
    let title = 'Nothing yet';
    let sub = '';
    if (status) {
      if (!media) title = 'Stopped';
      else {
        title = media.title;
        if (status.playlist) {
          sub = `Playlist ${status.playlist.title} · ${status.playlist.index + 1}/${status.playlist.length}`;
        }
      }
    }
    els.playing.textContent = title;
    els.playing.title = title;
    els.playingSub.textContent = sub;
    const timed = status !== null && media && status.duration > 0;
    els.time.textContent = timed ? `${clock(status.currentTime)} / ${clock(status.duration)}` : '';
    els.progress.style.width = timed
      ? `${Math.min(100, Math.max(0, (status.currentTime / status.duration) * 100))}%`
      : '0%';
    drawPicture(thumbOf(media));

    els.dot.dataset.state = statusError ? 'down' : status ? 'ok' : 'unknown';
    els.connectionText.textContent = statusError
      ? 'Player not reached'
      : status
        ? status.blackout
          ? 'Wall is black'
          : 'Player connected'
        : 'Reading';
    els.connection.title = statusError;
    els.blackout.classList.toggle('is-on', status?.blackout === true);
    els.blackout.textContent = status?.blackout ? 'Lift wall blackout' : 'Wall blackout';
    els.blackout.setAttribute('aria-pressed', String(status?.blackout === true));
    els.blackout.disabled = status === null;
    const chosen = transition ?? status?.transition;
    for (const { name, key } of els.transitionKeys) {
      key.classList.toggle('is-on', name === chosen);
      key.setAttribute('aria-pressed', String(name === chosen));
    }
    renderPlaying();
  }

  /** A playlist has no picture of its own: it shows the one of its first item, when that has one. */
  function playlistThumb(playlist) {
    const first = playlist.items?.[0];
    if (!first) return null;
    for (const list of [library.videos, library.effects, library.texts]) {
      const found = list.find((item) => item.id === first.id);
      if (found) return found.thumb;
    }
    return null;
  }

  /** The keys of the library, one per item. */
  function itemsOf() {
    if (!library) return [];
    if (kind === 'playlists') {
      return library.playlists.map((each) => ({
        id: each.id,
        title: each.title,
        detail: `Playlist · ${each.count} items`,
        thumb: playlistThumb(each),
        playlist: true,
      }));
    }
    return library[kind] ?? [];
  }

  let drawnItems = '';
  function renderLibrary() {
    for (const { id, key, count, name } of els.kindKeys) {
      key.classList.toggle('is-sel', id === kind);
      key.setAttribute('aria-selected', String(id === kind));
      count.textContent = library ? String(library[id].length) : '';
      key.setAttribute('aria-label', library ? `${name}, ${library[id].length}` : name);
    }
    if (els.settingsKey) {
      const chosen = kind === SETTINGS;
      els.settingsKey.classList.toggle('is-sel', chosen);
      els.settingsKey.setAttribute('aria-selected', String(chosen));
      els.settings.hidden = !chosen;
      els.items.hidden = chosen;
      // Refresh keeps its room, and does nothing while the settings are shown.
      els.refresh.style.visibility = chosen ? 'hidden' : '';
    }
    const items = kind === SETTINGS ? [] : itemsOf();
    // Nothing to show is said where the keys would be; a failed read of a library that is on screen is
    // said in the foot, so that no key moves.
    const message = libraryError
      ? libraryError
      : !library
        ? 'Reading the library of the video wall ...'
        : items.length === 0 && kind !== SETTINGS
          ? `The video wall has no ${kind}.`
          : '';
    const inFoot = libraryError !== '' && items.length > 0;
    els.footHint.hidden = inFoot;
    els.footError.hidden = !inFoot;
    els.footError.textContent = inFoot ? libraryError : '';
    const signature = `${kind}|${libraryAt}|${items.map((item) => item.id).join(',')}|${items.length === 0 ? message : ''}`;
    if (signature !== drawnItems) {
      drawnItems = signature;
      if (items.length === 0) {
        els.items.replaceChildren(element('p', 'hint wl-empty', message));
      } else {
        els.items.replaceChildren(...items.map(makeItem));
      }
    }
    renderPlayer();
  }

  function makeItem(item) {
    const key = button('key wl-item', '', () => play(item));
    key.dataset.id = item.id;
    key.dataset.playlist = String(item.playlist === true);
    const picture = element('span', 'wl-thumb');
    if (item.thumb) {
      const image = element('img');
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.src = `/api/videowall/image?path=${encodeURIComponent(item.thumb)}`;
      picture.append(image);
    } else {
      picture.append(element('span', 'wl-kind', item.playlist ? 'Playlist' : (item.type ?? '')));
    }
    const head = element('span', 'hd');
    head.append(element('span', 'wl-name', item.title), element('span', 'tag on', 'On'));
    key.append(picture, head, element('span', 'sub', item.detail));
    return key;
  }

  /** The key of what plays is lit. */
  function renderPlaying() {
    for (const key of els.items.children) {
      const playlist = key.dataset.playlist === 'true';
      const on = Boolean(
        playlist ? status?.playlist?.id === key.dataset.id : status?.media?.id === key.dataset.id,
      );
      key.classList.toggle('is-on', on);
      key.setAttribute('aria-pressed', String(on));
    }
  }

  function render() {
    const current = settings();
    els.enabled.classList.toggle('is-on', current.enabled);
    els.enabled.textContent = current.enabled ? 'Text on' : 'Text off';
    els.enabled.setAttribute('aria-pressed', String(current.enabled));
    renderLines();
    els.send.disabled = !shell.videowall.track;
    drawOverlay(current);

    setIfIdle(els.url, current.url);
    els.pin.placeholder = current.pinSet ? 'A PIN is set' : 'No PIN';
    els.pinClear.disabled = !current.pinSet;
    setIfIdle(els.seconds, String(current.durationSeconds));
    els.showPreset(current.durationSeconds);
    els.showLines(current.lines);
    setIfIdle(els.filter, current.titleFilter);
    els.result.textContent = `On the wall: ${shell.videowall.preview.replace(/\n/g, ' / ')}`;
    setIfIdle(
      els.colour,
      current.color.startsWith('#') && current.color.length === 7 ? current.color : '#ffffff',
    );
    sizeSlider.refresh();
    for (const { vertical, horizontal, key } of els.cells) {
      const on = vertical === current.vertical && horizontal === current.horizontal;
      key.classList.toggle('is-on', on);
      key.setAttribute('aria-pressed', String(on));
    }
    els.sketchText.textContent = shell.videowall.preview;
    placeText(els.sketchText, current);
  }

  /** The text that is on the wall now, drawn on the picture where the settings put it. */
  function drawOverlay(current) {
    const { shown } = shell.videowall;
    els.pictureText.textContent = shown ? shown.text : '';
    els.pictureText.hidden = !shown;
    placeText(els.pictureText, current);
  }

  /** A field that is being typed in keeps what is typed. */
  function setIfIdle(input, value) {
    if (document.activeElement !== input) input.value = value;
  }

  // ---- on screen or not ----

  function poll() {
    if (active && !document.hidden) readStatus();
  }

  // The seconds left on the wall count down.
  setInterval(() => {
    if (active && !document.hidden) renderLines();
  }, 1000);
  document.addEventListener('visibilitychange', poll);
  shell.on('videowall', () => {
    render();
    // Another page moved the player: the library is the one of the old address until it is read again.
    if (active && settings().url !== libraryFor) readLibrary(true);
  });

  render();
  renderPlayer();
  renderLibrary();

  return {
    render,
    /** The panel came on screen: read the wall and keep reading it. */
    activate() {
      if (active) return;
      active = true;
      render();
      readStatus();
      readLibrary();
      pollTimer = setInterval(poll, POLL_MS);
    },
    deactivate() {
      active = false;
      clearInterval(pollTimer);
    },
  };
}
