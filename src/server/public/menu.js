// The menu sheet of the tablet page (design `design/mockups/06-menu.html`): a full-screen sheet that the
// Menu key of the top bar opens, and a Close key, in the same place, closes. Plain browser JavaScript, no
// build step. The top bar stays on screen above it, so the blackout and the master are one press away
// while the menu is open.
//
//   const menu = mountMenu(shell, bar);     `bar` is what `mountTopBar` of topbar.js gave back
//   menu.open(), menu.close(), menu.isOpen
//
// It holds, left: the Live page card (you are here) and a card for each setup page: Deck, Palettes, a
// page per fixture of the rig (Spider, Laser, Room ...), Video wall and Simulator, with a few words about
// what is there (the number of palettes, of lamps and rails) worked out from the shell. The Laser card
// has a red edge. Right: the tempo source (By hand, Rekordbox, Idle in breakdown, what rekordbox says,
// the keys that nudge the tempo by one bpm and a fader for the tempo by hand), the links (Bridge,
// LR512, Home Assistant, each with its state in words) and the Fullscreen key, which is only there where
// the browser has full screen and the page is not an app already. Last, the show file with its counts.
//
// It sets `bar.onMenu`, and a press outside is not needed: Close, the Live card, Escape and a press on a
// card (which goes to that page) all leave it. It draws from the shell's events (`change`, `rkbx`, `status`
// and `show`) and takes no room from the page under it. Its styles are in chrome.css (`menu-sheet`).

import { element, fader } from './ui.js';

/** The words that go with a setup page, by the kind of fixture. */
const KIND_WORDS = {
  spider: 'Effects, colour, movement',
  laser: 'Modes, channels',
};

/** A card of the sheet: a link with a name and a few words under it. */
function makeCard(href, title, sub) {
  const card = element('a', 'key nav-card');
  card.href = href;
  const name = element('span', 'nc-title', title);
  const words = element('span', 'sub', sub);
  card.append(name, words);
  card.words = words;
  return card;
}

const LINK_NAMES = [
  ['bridge', 'Bridge'],
  ['device', 'LR512'],
  ['hass', 'Home Assistant'],
];

/** What a link says in words, without its name: "connected", "not found", "simulated". */
function linkWords(name, link) {
  const text = link.text;
  if (link.state === 'unknown' && text === 'No bridge') return 'not used';
  if (link.state === 'unknown') return 'waiting';
  if (text === name) return 'connected';
  if (text.toLowerCase().startsWith(name.toLowerCase())) {
    return text.slice(name.length).trim().toLowerCase();
  }
  return text.toLowerCase();
}

export function mountMenu(shell, bar, { host } = {}) {
  const sheet = element('section', 'menu-sheet');
  sheet.id = 'menu-sheet';
  sheet.hidden = true;
  sheet.setAttribute('aria-label', 'Menu');

  // ---- the pages ----
  const main = element('div', 'ms-main');
  const group = (name) => {
    const holder = element('div', 'ms-group');
    holder.append(element('span', 'lbl', name));
    return holder;
  };

  const liveGroup = group('Live');
  const liveCard = element('a', 'key nav-card is-here');
  liveCard.href = '/tablet';
  const liveText = element('span', 'col');
  liveText.style.gap = '4px';
  liveText.append(
    element('span', 'nc-title big', 'Live page'),
    element('span', 'sub', 'Looks, moods, parts, video wall'),
  );
  liveCard.append(liveText, element('span', 'tag next', 'You came from here'));
  // You are here: the card only closes the sheet.
  liveCard.addEventListener('click', (event) => {
    event.preventDefault();
    close();
  });
  liveGroup.append(liveCard);

  const setupGroup = group('Setup');
  const grid = element('div', 'ms-cards');
  const palettesCard = makeCard('/palettes', 'Palettes', '');
  const cards = [
    makeCard('/deck', 'Deck', 'Store, rename, sequences'),
    palettesCard,
    ...shell.fixtures.map((fixture) => {
      const card = makeCard(`/fixtures/${fixture.id}`, fixture.label, '');
      card.fixture = fixture;
      // A laser is the one thing in the rig that can hurt: its card has a red edge and a red name.
      if (fixture.kind === 'laser') card.classList.add('is-laser');
      return card;
    }),
    makeCard('/videowall', 'Video wall', 'Player, track text'),
    makeCard('/simulator', 'Simulator', '3D view of the rig'),
  ];
  grid.append(...cards);
  setupGroup.append(grid);
  main.append(liveGroup, setupGroup);

  // ---- the tempo source ----
  const aside = element('aside', 'ms-aside');
  const tempoPanel = element('section', 'panel ms-panel');
  tempoPanel.setAttribute('aria-label', 'Tempo source');
  tempoPanel.append(element('span', 'lbl', 'Tempo source'));
  const sourceKeys = element('div', 'ms-source');
  const makeKey = (text, onPress, className = 'key c') => {
    const key = element('button', className, text);
    key.type = 'button';
    key.addEventListener('click', onPress);
    return key;
  };
  const byHand = makeKey('By hand', () => shell.setSource('manual'));
  const rekordbox = makeKey('Rekordbox', () => shell.setSource('rekordbox'));
  const breakdown = makeKey('Idle in breakdown', () =>
    shell.setBreakdown(!shell.rkbx.breakdown.enabled),
  );
  sourceKeys.append(byHand, rekordbox, breakdown);
  const heard = element('p', 'ms-heard');
  const caption = element('p', 'ms-caption');
  const nudge = element('div', 'ms-nudge');
  nudge.append(
    makeKey('−1 bpm', () => shell.nudgeTempo(-1), 'key c num'),
    makeKey('+1 bpm', () => shell.nudgeTempo(1), 'key c num'),
  );
  nudge.firstElementChild.setAttribute('aria-label', 'Tempo down by one');
  nudge.lastElementChild.setAttribute('aria-label', 'Tempo up by one');
  const tempoFader = fader({
    id: 'menu-tempo',
    label: 'Tempo in bpm',
    min: shell.tempoLimits.min,
    max: shell.tempoLimits.max,
    read: () => Math.round(shell.tempo.bpm),
    write: (number) => shell.setBpm(number),
  });
  tempoPanel.append(sourceKeys, heard, caption, nudge, tempoFader);

  // ---- the links ----
  const linksPanel = element('section', 'panel ms-panel');
  linksPanel.setAttribute('aria-label', 'Links');
  linksPanel.append(element('span', 'lbl', 'Links'));
  const linkRows = LINK_NAMES.map(([id, name]) => {
    const row = element('div', 'ms-link');
    const left = element('span', 'row');
    left.style.gap = '10px';
    const lamp = element('i', 'ldot');
    left.append(lamp, name);
    const words = element('span', 't2');
    row.append(left, words);
    linksPanel.append(row);
    return { id, name, row, lamp, words };
  });

  aside.append(tempoPanel, linksPanel);

  // ---- full screen ----
  const root = document.documentElement;
  const app =
    window.matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches ||
    // The tablet app of lightdeck (android-tablet/) is already full screen: it says so in its agent.
    navigator.userAgent.includes('LightdeckTablet');
  if (root.requestFullscreen && !app) {
    const screenPanel = element('section', 'panel ms-panel');
    screenPanel.setAttribute('aria-label', 'Screen');
    screenPanel.append(element('span', 'lbl', 'Screen'));
    // Full screen without the bar of the browser. A browser only installs a page as an app on https or
    // on localhost, so over `http://192.168...` the home screen only gets a shortcut that keeps the bar.
    // Full screen is allowed on any address, but only on a press.
    const full = makeKey('Fullscreen', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else root.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    });
    full.id = 'menu-full';
    full.setAttribute('aria-pressed', 'false');
    const showFull = () => {
      const on = document.fullscreenElement !== null;
      full.setAttribute('aria-pressed', String(on));
      full.classList.toggle('is-on', on);
    };
    document.addEventListener('fullscreenchange', showFull);
    showFull();
    screenPanel.append(full);
    aside.append(screenPanel);
  }

  const foot = element('p', 'ms-foot t3');
  sheet.append(main, aside, foot);
  (host ?? document.querySelector('.app') ?? document.body).append(sheet);

  // ---- drawing ----

  function drawCards() {
    const { show } = shell;
    const palettes = show.palettes?.length ?? 0;
    palettesCard.words.textContent = `${palettes} ${palettes === 1 ? 'palette' : 'palettes'}`;
    for (const card of cards) {
      const { fixture } = card;
      if (!fixture) continue;
      const lamps = fixture.details?.lamps;
      const zones = fixture.details?.zones ?? [];
      card.words.textContent = lamps
        ? `${lamps.length} lamps${zones.length > 0 ? `, ${zones.length} rails` : ''}`
        : (KIND_WORDS[fixture.kind] ?? 'Controls');
    }
    const groups = show.groups ?? [];
    const scenes = groups.reduce((sum, each) => sum + each.scenes.length, 0);
    const looks = groups.reduce((sum, each) => sum + each.looks.length, 0);
    const file = show.file ? show.file.split('/').pop() : 'kept in memory only';
    foot.textContent = `Show file: ${file} · ${groups.length} groups · ${scenes} scenes · ${looks} looks`;
  }

  function drawTempo() {
    const { source } = shell.tempo;
    const { enabled } = shell.rkbx.breakdown;
    for (const [key, on] of [
      [byHand, source === 'manual'],
      [rekordbox, source === 'rekordbox'],
      [breakdown, enabled],
    ]) {
      key.classList.toggle('is-on', on);
      key.setAttribute('aria-pressed', String(on));
    }
    const { text, state } = shell.rkbxLine;
    heard.textContent = text;
    heard.dataset.state = state;
    caption.textContent =
      source === 'rekordbox'
        ? 'Rekordbox sets the tempo. A tap sets beat one; a nudge takes the tempo back.'
        : 'Your last tap is beat one of the bar. Nudge the tempo:';
    tempoFader.refresh();
  }

  function drawLinks() {
    const links = shell.links;
    for (const { id, name, row, lamp, words } of linkRows) {
      const link = links[id];
      row.hidden = link === undefined;
      if (!link) continue;
      lamp.dataset.state = link.state;
      words.textContent = linkWords(name, link);
      row.dataset.state = link.state;
    }
  }

  function drawAll() {
    drawCards();
    drawTempo();
    drawLinks();
  }

  // ---- opening and closing ----

  const place = () => sheet.style.setProperty('--top-h', `${bar.root.offsetHeight}px`);

  const page = sheet.parentElement;

  function open() {
    place();
    drawAll();
    sheet.hidden = false;
    page.classList.add('menu-open');
    bar.setMenuOpen(true);
  }

  function close() {
    sheet.hidden = true;
    page.classList.remove('menu-open');
    bar.setMenuOpen(false);
  }

  bar.onMenu = () => (sheet.hidden ? open() : close());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !sheet.hidden) close();
  });
  window.addEventListener('resize', () => {
    if (!sheet.hidden) place();
  });
  // A page that the browser keeps for the way back comes back closed.
  window.addEventListener('pageshow', () => {
    if (!sheet.hidden) close();
  });

  const whileOpen = (draw) => () => {
    if (!sheet.hidden) draw();
  };
  shell.on('change', whileOpen(drawTempo));
  shell.on('rkbx', whileOpen(drawTempo));
  shell.on('status', whileOpen(drawLinks));
  shell.on('show', whileOpen(drawCards));
  drawAll();

  return {
    open,
    close,
    get isOpen() {
      return !sheet.hidden;
    },
  };
}
