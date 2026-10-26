// The controls of the video wall (Jeroen, 2026-10-23), for the page /videowall and for the tab of
// the tablet page. Plain browser JavaScript, no build step. It builds its own elements, so a page
// only gives it a place:
//
//   const wall = mountVideoWall(root, { shell, ask });
//   wall.activate() / wall.deactivate()   the panel is on screen or not: the picture of the wall is
//                                         read (every 2 s) only while it is
//
// Three panels:
//
//   The video wall  what the player is doing, a Blackout key, the transition, and its library as
//                   keys with a preview (playlists, videos, effects, texts): a press plays it. This
//                   is the player's own playback (`/api/videowall/play` and so on) and has nothing
//                   to do with the track text
//   Track text      whether the track that plays in rekordbox is sent to the wall as text, what is on
//                   the wall, and Send current track / Test text / Clear now
//   Where and how   the address and the PIN of the player, how long the text stays, one or two lines,
//                   the filter, the colour, the size and the place, with a sketch of the wall
//
// The server does the work (`src/server/videoWall.ts`): this draws what it says (`shell.videowall`)
// and asks for a change through `ask(url, body)` (which answers `{ ok, error, lost }` and shows the
// problem to the operator). A setting is sent a moment after the last change as one request, and
// what was changed here is drawn from the page until the server has told of it, so that a slider or
// a field is not set back under the finger. The PIN is never given back: the page only knows that
// there is one. The library and the status are read with a plain GET: they change nothing.
//
// Keys keep their size and place whatever they say: the previews have a shape of their own, and the
// lines that change keep their height.

import { button, element, slider } from './ui.js';

/** How long after the last change a request is sent. */
const SEND_AFTER_MS = 250;
/** How long what this page changed is drawn from the page, once it is sent. */
const SETTLE_MS = 1500;
/** How often the picture of the wall is read while the panel is on screen. */
const POLL_MS = 2000;
/** How long a library is kept before the panel reads it again when it comes on screen. */
const LIBRARY_MS = 60_000;

const PRESETS = [
  { seconds: 10, name: '10 s' },
  { seconds: 30, name: '30 s' },
  { seconds: 60, name: '1 min' },
  { seconds: 0, name: 'Stay' },
];
const LINES = [
  { id: 'one', name: 'One line' },
  { id: 'two', name: 'Two lines' },
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

const trackText = ({ title, artist }) => (artist ? `${title} - ${artist}` : title);

const clock = (seconds) => {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

/** A labelled block: `<label>` with a name above whatever is in it. */
function row(tag, name, ...content) {
  const made = element(tag, 'wall-row');
  if (tag === 'fieldset') made.append(element('legend', '', name));
  else made.append(element('span', '', name));
  made.append(...content);
  return made;
}

export function mountVideoWall(root, { shell, ask }) {
  root.classList.add('wall-root');

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

  const settings = () => ({ ...shell.videowall.settings, ...draft });

  // ---- the panel of the player ----

  const els = {};
  const player = element('section', 'panel');
  player.setAttribute('aria-labelledby', 'wall-player-title');
  player.append(element('h2', '', 'Video wall'));
  player.firstElementChild.id = 'wall-player-title';

  const playerLines = element('dl', 'wall-lines');
  els.playing = element('dd');
  els.connection = element('dd');
  playerLines.append(
    element('dt', '', 'Playing'),
    els.playing,
    element('dt', '', 'Player'),
    els.connection,
  );

  els.blackout = button('key wall-blackout', 'Blackout', () => blackout());
  els.blackout.setAttribute('aria-pressed', 'false');
  els.transitions = element('span', 'wall-choice');
  els.transitionKeys = TRANSITIONS.map((name) => {
    const key = button('pick', name[0].toUpperCase() + name.slice(1), () => {
      transition = name;
      renderPlayer();
    });
    els.transitions.append(key);
    return { name, key };
  });
  const playerControls = element('div', 'wall-player-controls');
  playerControls.append(els.blackout, row('div', 'Transition for the next one', els.transitions));

  els.kinds = element('span', 'wall-choice wall-kinds');
  els.kindKeys = KINDS.map(({ id, name }) => {
    const key = button('pick', name, () => {
      kind = id;
      renderLibrary();
    });
    els.kinds.append(key);
    return { id, key };
  });
  els.refresh = button('key wall-refresh', 'Refresh', () => readLibrary(true));
  const libraryHead = element('div', 'wall-library-head');
  libraryHead.append(els.kinds, els.refresh);
  els.libraryNote = element('p', 'hint wall-library-note');
  els.items = element('div', 'wall-items');
  player.append(playerLines, playerControls, libraryHead, els.libraryNote, els.items);

  // ---- the panel of the track text ----

  const now = element('section', 'panel');
  now.setAttribute('aria-labelledby', 'wall-now-title');
  const nowTitle = element('h2', '', 'Track text');
  nowTitle.id = 'wall-now-title';
  els.enabled = element('button', 'wall-switch');
  els.enabled.type = 'button';
  els.enabled.setAttribute('aria-pressed', 'false');
  els.enabledText = element('span', '', 'Off');
  els.enabled.append('Send the track to the video wall: ', els.enabledText);
  els.enabled.addEventListener('click', () => change({ enabled: !settings().enabled }));

  const nowLines = element('dl', 'wall-lines');
  els.track = element('dd');
  els.shown = element('dd');
  els.last = element('dd');
  nowLines.append(
    element('dt', '', 'Playing'),
    els.track,
    element('dt', '', 'On the wall'),
    els.shown,
    element('dt', '', 'Last call'),
    els.last,
  );
  els.send = button('key', 'Send current track', () => ask('/api/videowall/send'));
  const actions = element('div', 'wall-actions');
  actions.append(
    els.send,
    button('key', 'Test text', () => ask('/api/videowall/test')),
    button('key', 'Clear now', () => ask('/api/videowall/clear')),
  );
  now.append(nowTitle, els.enabled, nowLines, actions);

  // ---- the panel of the settings ----

  const form = element('section', 'panel');
  form.setAttribute('aria-labelledby', 'wall-settings-title');
  const formTitle = element('h2', '', 'Where and how');
  formTitle.id = 'wall-settings-title';

  els.url = element('input', 'field');
  Object.assign(els.url, { id: 'wall-url', type: 'text', autocomplete: 'off', spellcheck: false });
  els.url.inputMode = 'url';
  els.url.addEventListener('change', () => change({ url: els.url.value }));

  els.pin = element('input', 'field');
  Object.assign(els.pin, { id: 'wall-pin', type: 'password', autocomplete: 'off', maxLength: 40 });
  els.pin.addEventListener('change', () => {
    if (els.pin.value === '') return;
    change({ pin: els.pin.value });
    els.pin.value = '';
  });
  els.pinClear = button('key', 'Remove PIN', () => change({ pin: '' }));
  els.pinClear.id = 'wall-pin-clear';
  const pinRow = element('span', 'wall-pin');
  pinRow.append(els.pin, els.pinClear);

  els.seconds = element('input', 'field');
  Object.assign(els.seconds, { id: 'wall-seconds', type: 'number', min: 0, max: 3600, step: 1 });
  els.seconds.inputMode = 'numeric';
  els.seconds.setAttribute('aria-label', 'Seconds the text stays');
  els.seconds.addEventListener('change', () => {
    const seconds = Number(els.seconds.value);
    if (els.seconds.value !== '' && Number.isFinite(seconds)) change({ durationSeconds: seconds });
  });
  els.presetKeys = PRESETS.map(({ seconds, name }) => ({
    seconds,
    key: button('pick', name, () => change({ durationSeconds: seconds })),
  }));
  const presets = element('span', 'wall-presets');
  presets.append(...els.presetKeys.map(({ key }) => key));
  const duration = element('span', 'wall-duration');
  duration.append(els.seconds, element('span', '', 'seconds'), presets);

  els.lineKeys = LINES.map(({ id, name }) => ({
    id,
    key: button('pick', name, () => change({ lines: id })),
  }));
  const lineChoice = element('span', 'wall-choice');
  lineChoice.append(...els.lineKeys.map(({ key }) => key));

  els.filter = element('input', 'field');
  Object.assign(els.filter, {
    id: 'wall-filter',
    type: 'text',
    autocomplete: 'off',
    spellcheck: false,
    maxLength: 200,
  });
  els.filter.addEventListener('change', () => change({ titleFilter: els.filter.value }));
  els.result = element('span', 'wall-result');

  els.colour = element('input', 'wall-colour');
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
  const sizeRow = element('div', 'wall-row');
  sizeRow.append(sizeSlider);

  els.cells = [];
  const grid = element('span', 'wall-grid');
  for (const vertical of VERTICALS) {
    for (const horizontal of HORIZONTALS) {
      const key = button(
        'pick',
        `${vertical} ${horizontal}`.replace('center center', 'middle'),
        () => change({ vertical, horizontal }),
      );
      key.setAttribute('aria-label', `${vertical}, ${horizontal}`);
      grid.append(key);
      els.cells.push({ vertical, horizontal, key });
    }
  }
  els.previewText = element('span', 'wall-preview-text');
  const preview = element('div', 'wall-preview');
  preview.setAttribute('aria-hidden', 'true');
  preview.append(els.previewText);

  const filterHint = element(
    'span',
    'hint',
    'Case does not count, every match goes. Empty cuts nothing. The default takes (Original Mix), [Extended Mix] and - Radio Edit off the end.',
  );
  const left = element('div', 'wall-form');
  left.append(
    row('label', 'Address of the player', els.url),
    row('label', 'PIN of the player, if it has one', pinRow),
    row(
      'fieldset',
      'How long the text stays',
      duration,
      element('span', 'hint', '0 leaves it up until the next track replaces it.'),
    ),
    row('fieldset', 'Text', lineChoice),
    row(
      'label',
      'Cut this out of the title (regular expression)',
      els.filter,
      filterHint,
      els.result,
    ),
    row('label', 'Colour', els.colour),
    sizeRow,
  );
  const right = element('div', 'wall-where');
  right.append(
    row('fieldset', 'Position', grid),
    preview,
    element(
      'p',
      'hint',
      'A sketch of the wall. The player makes a text that is too wide for the screen smaller.',
    ),
  );
  const settingsBox = element('div', 'wall-settings');
  settingsBox.append(left, right);
  form.append(formTitle, settingsBox);

  root.append(player, now, form);

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
    els.track.textContent = track ? trackText(track) : 'Waiting for a track from rekordbox';
    const text = shown?.text.replace(/\n/g, ' / ');
    if (!shown) els.shown.textContent = 'Nothing';
    else if (shown.hideAt === null) els.shown.textContent = `${text} · until the next track`;
    else els.shown.textContent = `${text} · goes in ${secondsLeft(shown.hideAt)} s`;
    const bad = last !== null && !last.ok;
    els.last.dataset.bad = String(bad);
    if (!last) els.last.textContent = 'None yet';
    else if (bad) els.last.textContent = last.error;
    else els.last.textContent = last.action === 'show' ? 'Text shown' : 'Text taken away';
  }

  function renderPlayer() {
    const media = status?.media;
    let playing = 'Nothing yet';
    if (status) {
      if (!media) playing = 'Stopped';
      else {
        const list = status.playlist
          ? ` · ${status.playlist.title} ${status.playlist.index + 1}/${status.playlist.length}`
          : '';
        const time =
          status.duration > 0 ? ` · ${clock(status.currentTime)} / ${clock(status.duration)}` : '';
        playing = `${media.title}${list}${time}`;
      }
    }
    els.playing.textContent = playing;
    els.connection.dataset.bad = String(statusError !== '');
    els.connection.textContent =
      statusError || (status ? (status.blackout ? 'Black' : 'Connected') : 'Reading');
    els.blackout.setAttribute('aria-pressed', String(status?.blackout === true));
    els.blackout.disabled = status === null;
    const chosen = transition ?? status?.transition;
    for (const { name, key } of els.transitionKeys) {
      key.setAttribute('aria-pressed', String(name === chosen));
    }
    renderPlaying();
  }

  /** The keys of the library, one per item. */
  function itemsOf() {
    if (!library) return [];
    if (kind === 'playlists') {
      return library.playlists.map((each) => ({
        id: each.id,
        title: each.title,
        detail: `${each.count} items`,
        thumb: null,
        playlist: true,
      }));
    }
    return library[kind] ?? [];
  }

  let drawnItems = '';
  function renderLibrary() {
    for (const { id, key } of els.kindKeys) key.setAttribute('aria-pressed', String(id === kind));
    const items = itemsOf();
    if (libraryError) els.libraryNote.textContent = libraryError;
    else if (!library) els.libraryNote.textContent = 'Reading the library of the video wall ...';
    else if (items.length === 0) els.libraryNote.textContent = `The video wall has no ${kind}.`;
    else els.libraryNote.textContent = '';
    els.libraryNote.hidden = els.libraryNote.textContent === '';
    const signature = `${kind}|${items.map((item) => item.id).join(',')}`;
    if (signature !== drawnItems) {
      drawnItems = signature;
      els.items.replaceChildren(...items.map(makeItem));
    }
    renderPlaying();
  }

  function makeItem(item) {
    const key = element('button', 'wall-item');
    key.type = 'button';
    key.dataset.id = item.id;
    key.dataset.playlist = String(item.playlist === true);
    const picture = element('span', 'wall-item-picture');
    if (item.thumb) {
      const image = element('img');
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.src = `/api/videowall/image?path=${encodeURIComponent(item.thumb)}`;
      picture.append(image);
    } else {
      picture.append(
        element('span', 'wall-item-kind', item.playlist ? 'Playlist' : (item.type ?? '')),
      );
    }
    key.append(
      picture,
      element('span', 'wall-item-name', item.title),
      element('span', 'wall-item-detail', item.detail),
    );
    key.addEventListener('click', () => play(item));
    return key;
  }

  /** The key of what plays is lit. */
  function renderPlaying() {
    for (const key of els.items.children) {
      const playlist = key.dataset.playlist === 'true';
      const on = playlist
        ? status?.playlist?.id === key.dataset.id
        : status?.media?.id === key.dataset.id;
      key.setAttribute('aria-pressed', String(Boolean(on)));
    }
  }

  function render() {
    const current = settings();
    els.enabled.setAttribute('aria-pressed', String(current.enabled));
    els.enabledText.textContent = current.enabled ? 'On' : 'Off';
    renderLines();
    els.send.disabled = !shell.videowall.track;

    setIfIdle(els.url, current.url);
    els.pin.placeholder = current.pinSet ? 'A PIN is set' : 'No PIN';
    els.pinClear.disabled = !current.pinSet;
    setIfIdle(els.seconds, String(current.durationSeconds));
    for (const { seconds, key } of els.presetKeys) {
      key.setAttribute('aria-pressed', String(seconds === current.durationSeconds));
    }
    for (const { id, key } of els.lineKeys)
      key.setAttribute('aria-pressed', String(id === current.lines));
    setIfIdle(els.filter, current.titleFilter);
    els.result.textContent = `On the wall: ${shell.videowall.preview.replace(/\n/g, ' / ')}`;
    setIfIdle(
      els.colour,
      current.color.startsWith('#') && current.color.length === 7 ? current.color : '#ffffff',
    );
    sizeSlider.refresh();
    for (const { vertical, horizontal, key } of els.cells) {
      key.setAttribute(
        'aria-pressed',
        String(vertical === current.vertical && horizontal === current.horizontal),
      );
    }
    renderPreview(current);
  }

  /** A field that is being typed in keeps what is typed. */
  function setIfIdle(input, value) {
    if (document.activeElement !== input) input.value = value;
  }

  function renderPreview(current) {
    const text = els.previewText;
    text.textContent = shell.videowall.preview;
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

  // ---- on screen or not ----

  function poll() {
    if (active && !document.hidden) readStatus();
  }

  // The seconds left on the wall count down.
  setInterval(() => {
    if (active && !document.hidden) renderLines();
  }, 1000);
  document.addEventListener('visibilitychange', poll);
  shell.on('videowall', () => render());

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
