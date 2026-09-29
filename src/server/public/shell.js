// The shell of every page of the console. Plain browser JavaScript, no build step.
//
// A page is about one fixture, or about the show, as the deck is. Around it the shell
// puts what belongs to no fixture: the way to the other pages, the tempo and the speed,
// the blackout, the level of the master, and the state of the link to the LR512. It also
// does the talking to the server, so that a page only has to say what changes and to draw
// what it is told.
//
// The master is shown here and set on the deck. It is shown on every page, because on
// the page of a fixture it is why less goes out than what is set.
//
// A page starts the shell and gets back what it needs:
//
//   const shell = await start();          null when the page cannot be shown
//   const shell = await start({ page: 'deck' });        for a page about no fixture
//   shell.fixture                          the fixture as /api/state describes it
//   shell.fixtures                         every fixture of the console
//   shell.show                             the show: its file, what is wrong with it, and
//                                          the groups with their scenes
//   shell.playback                         per group which scene is on, and whether its
//                                          fixtures were changed by hand since
//   shell.ask(url, body)                   ask the server for something once; gives
//                                          { ok, error } and what the server answered,
//                                          with `lost` when the server was not reached
//   shell.on('show', (show) => ...)        the groups or their scenes changed
//   shell.on('playback', (playback) => ...)             another scene, off, or changed by hand
//   shell.send(patch)                      change the fixture
//   shell.pending()                        what of that the server has not told of yet
//   shell.act('reset')                     let the fixture do something by name
//   shell.on('fixture', ({ state, dmx, own }) => ...)   the fixture changed; `state` is
//                                          what the server says with what is pending
//                                          over it, so a page can take it as it is
//   shell.on('frame', ({ dmx, beat }) => ...)           what is being sent, while it animates
//   shell.on('change', () => ...)          blackout, master or tempo changed
//   shell.notes(() => [{ text, level, urgent }])        what the page has to say
//   shell.refresh()                        show the notes again
//   shell.blackout, shell.tempo, shell.beat()
//   shell.master                           the master, 0 to 1
//   shell.setMaster(level)                 move the master, for every fixture
//
// And for a page that shows the master:
//
//   masterPercent(level)                   the master in percent, as the shell shows it

import { changesOnTheWay, merge } from './changes.js';
import { $, button, element, percent, slider } from './ui.js';

const RATE_NAMES = { 0.5: 'Half', 1: 'Normal', 2: 'Double' };
const BEATS_PER_BAR = 4;
const RETRY_MS = 600;
/** Taps further apart than this start a new count. */
const TAP_GAP_MS = 2000;
const TAPS_KEPT = 8;

const FRAME = `
  <header class="topbar">
    <p class="brand">Lightdeck</p>
    <nav class="pages" id="pages" aria-label="Pages"></nav>
    <p class="master-level" id="master-level" data-full="true">
      <span class="master-name">Master</span>
      <span class="master-value" id="master-value"></span>
    </p>
    <ul class="links" id="links" aria-label="Connection">
      <li class="link" id="link-bridge" data-state="unknown">
        <span class="lamp" aria-hidden="true"></span><span class="link-text">Bridge</span>
      </li>
      <li class="link" id="link-device" data-state="unknown">
        <span class="lamp" aria-hidden="true"></span><span class="link-text">LR512</span>
      </li>
    </ul>
    <button type="button" class="blackout" id="blackout" aria-pressed="false">Blackout</button>
  </header>

  <section class="panel desk" aria-label="Tempo and speed">
    <div class="sliders" id="tempo-sliders"></div>
    <div class="desk-tap">
      <p class="hint">Your last tap is beat one of the bar.</p>
      <div class="tap-row">
        <button type="button" class="key nudge" id="tempo-down" aria-label="Tempo down by one">−1</button>
        <button type="button" class="key tap" id="tap">Tap the beat</button>
        <button type="button" class="key nudge" id="tempo-up" aria-label="Tempo up by one">+1</button>
        <ol class="beats" id="beats" aria-hidden="true">
          <li></li>
          <li></li>
          <li></li>
          <li></li>
        </ol>
      </div>
    </div>
    <fieldset class="choice" id="rates">
      <legend>Speed</legend>
    </fieldset>
  </section>

  <p class="notice" id="notice" role="status" hidden></p>
`;

/**
 * The master in percent. Only a master at 0 is shown as 0: anything above it lets the
 * fixtures show, however little.
 */
export function masterPercent(level) {
  return level > 0 ? Math.max(1, percent(level)) : 0;
}

function alarm(text) {
  const notice = $('notice');
  notice.dataset.level = 'alarm';
  notice.textContent = text;
  notice.hidden = false;
}

export async function start({ page = 'fixture' } = {}) {
  const frame = document.createElement('template');
  frame.innerHTML = FRAME;
  document.body.prepend(frame.content);

  const id =
    page === 'fixture'
      ? decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() ?? '')
      : null;
  let initial;
  try {
    initial = await (await fetch('/api/state')).json();
  } catch {
    alarm('This page cannot reach lightdeck. Check that it is running, then reload.');
    return null;
  }

  const clientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const fixture = initial.fixtures.find((each) => each.id === id);
  /** The fixtures this page is about: its own, or all of them. */
  const watched = fixture ? [fixture] : initial.fixtures;
  let show = initial.show;
  let playback = initial.playback;
  const limits = initial.tempo;
  let tempo = { bpm: initial.tempo.bpm, rate: initial.tempo.rate };
  let blackout = initial.blackout;
  let master = initial.master;
  /** How many changes of the master by this page the event stream has yet to tell of. */
  let unheard = 0;
  /** The changes of the fixture by this page that it has yet to tell of. */
  const onTheWay = changesOnTheWay(clientId);
  let status = initial.status;
  let streamUp = true;
  /** The places that could not be reached. */
  const failing = new Set();
  /** Those of them that a change is kept for, which is sent when they can be. */
  const held = new Set();
  let pageNotes = () => [];
  /** A beat number and the moment it was true, to count on from between messages. */
  let beatBase = { beat: initial.tempo.beat, at: performance.now() };
  const handlers = { fixture: [], frame: [], change: [], show: [], playback: [] };
  const tell = (name, message) => {
    for (const handler of handlers[name]) handler(message);
  };

  const pages = [
    { name: 'Deck', href: '/deck', here: page === 'deck' },
    ...initial.fixtures.map((each) => ({
      name: each.label,
      href: `/fixtures/${each.id}`,
      here: each.id === id,
    })),
  ];
  for (const each of pages) {
    const link = element('a', 'page-link', each.name);
    link.href = each.href;
    if (each.here) link.setAttribute('aria-current', 'page');
    $('pages').append(link);
  }
  if (page === 'fixture' && !fixture) {
    alarm(`There is no fixture called "${id}". Choose one above.`);
    return null;
  }
  if (fixture) {
    document.title = `${fixture.label} · Lightdeck`;
    if ($('fixture-name')) $('fixture-name').textContent = fixture.label;
    if ($('where')) {
      $('where').textContent =
        `Port ${fixture.universe + 1}, address ${fixture.address}, ${fixture.footprint} channels`;
    }
  }

  // ---- talking to the server ----

  async function reload() {
    const fresh = await (await fetch('/api/state')).json();
    tempo = { bpm: fresh.tempo.bpm, rate: fresh.tempo.rate };
    setBeat(fresh.tempo.beat);
    blackout = fresh.blackout;
    master = fresh.master;
    const real = fresh.fixtures.find((each) => each.id === id);
    if (real) tell('fixture', { state: shownState(real.state), dmx: real.dmx, own: false });
    show = fresh.show;
    playback = fresh.playback;
    tell('show', show);
    tell('playback', playback);
    render();
    tell('change');
  }

  /**
   * Collects changes for one place and sends one request at a time, always with the
   * newest values. `again` says what of a change is still worth sending after a failure.
   * `leave` and `drop` are for what the event stream has to tell of. `leave` hears of a
   * change that leaves and gives the name it goes under, which comes back as `origin` in
   * the event. `drop` hears of one that failed or was refused, which the stream never
   * tells of.
   */
  function sender(url, { again = (sent) => sent, leave = () => clientId, drop = () => {} } = {}) {
    let pending = null;
    let inFlight = false;
    const flush = async () => {
      if (inFlight || !pending) return;
      const sent = pending;
      pending = null;
      inFlight = true;
      const name = leave(sent);
      let failed = false;
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...sent, client: name }),
        });
        if (response.status === 400) {
          // The server refused the change. Sending it again will not help: show what is real.
          drop(name);
          await reload().catch(() => {});
        } else if (!response.ok) {
          throw new Error(response.statusText);
        }
      } catch {
        // Keep the change and try again; anything newer wins over what failed.
        drop(name);
        pending = merge(again(sent), pending);
        failed = true;
        setTimeout(flush, RETRY_MS);
      } finally {
        inFlight = false;
        if (failed) {
          failing.add(url);
          held.add(url);
        } else {
          failing.delete(url);
          held.delete(url);
        }
        renderNotice();
      }
      if (!failed) flush();
    };
    const send = (patch) => {
      pending = merge(pending, patch);
      flush();
    };
    send.pending = () => pending;
    return send;
  }

  const sendFixture = fixture
    ? sender(`/api/fixtures/${id}/update`, { leave: onTheWay.leave, drop: onTheWay.drop })
    : undefined;
  const sendBlackout = sender('/api/blackout');
  // A tap on the beat is only right at the moment it was made.
  const sendTempo = sender('/api/tempo', { again: ({ sync: _sync, ...kept }) => kept });
  const sendMaster = sender('/api/master', {
    leave: () => {
      unheard += 1;
      return clientId;
    },
    drop: () => {
      unheard = Math.max(0, unheard - 1);
    },
  });

  /** What this page changed of the fixture and the event stream has not told of yet. */
  const pendingFixture = () => onTheWay.all(sendFixture?.pending());

  /**
   * The state of the fixture to show: what the server says, with what is pending over
   * it. The server says what was true when it spoke, and that can be older than a change
   * of this page, also after the change was answered.
   */
  const shownState = (state) => merge(state, pendingFixture());

  async function act(name) {
    const url = `/api/fixtures/${id}/${name}`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client: clientId }),
      });
      if (!response.ok) throw new Error(response.statusText);
      failing.delete(url);
    } catch {
      failing.add(url);
      // Doing it later is not what was asked for, so this is not tried again.
      setTimeout(() => {
        failing.delete(url);
        renderNotice();
      }, 4 * RETRY_MS);
    }
    renderNotice();
  }

  /** Asks for something once. What cannot be done is answered, not tried again. */
  async function ask(url, body = {}) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, client: clientId }),
      });
      const answer = await response.json().catch(() => ({}));
      if (response.ok) return { ...answer, ok: true };
      return { ok: false, error: answer.error ?? response.statusText };
    } catch {
      return { ok: false, lost: true, error: 'This page cannot reach lightdeck.' };
    }
  }

  function listen() {
    const events = new EventSource('/api/events');
    const on = (name, handler) =>
      events.addEventListener(name, (event) => handler(JSON.parse(event.data)));
    events.addEventListener('open', () => {
      streamUp = true;
      // What the stream told while it was away is lost. It starts with what is real.
      unheard = 0;
      onTheWay.forget();
      renderNotice();
    });
    events.addEventListener('error', () => {
      streamUp = false;
      renderNotice();
    });
    on('fixture', (message) => {
      if (message.id !== id) return;
      onTheWay.heard(message.origin);
      tell('fixture', {
        state: shownState(message.state),
        dmx: message.dmx,
        own: onTheWay.mine(message.origin),
      });
    });
    on('frame', (message) => {
      setBeat(message.beat);
      if (message.id === id) tell('frame', { dmx: message.dmx, beat: message.beat });
    });
    on('tempo', (message) => {
      if (message.origin === clientId) return;
      tempo = { bpm: message.bpm, rate: message.rate };
      setBeat(message.beat);
      render();
      tell('change');
    });
    on('blackout', (message) => {
      if (message.origin === clientId) return;
      blackout = message.blackout;
      render();
      tell('change');
    });
    on('master', (message) => {
      if (message.origin === clientId && unheard > 0) unheard -= 1;
      // The stream tells in the order of the server. A change of this page that it has
      // not told of yet comes after this one, and wins.
      if (unheard > 0 || sendMaster.pending()) return;
      master = message.master;
      render();
      tell('change');
    });
    on('status', (message) => {
      status = message;
      renderLinks();
      renderNotice();
    });
    on('show', (message) => {
      show = message;
      tell('show', show);
    });
    on('playback', (message) => {
      playback = message;
      tell('playback', playback);
    });
  }

  // ---- the beat ----

  function setBeat(beat) {
    if (typeof beat === 'number') beatBase = { beat, at: performance.now() };
  }

  function beatNow(now = performance.now()) {
    return beatBase.beat + ((now - beatBase.at) / 60_000) * tempo.bpm;
  }

  let litBeat = -1;
  function drawBeat() {
    const beat = Math.floor(beatNow());
    const index = ((beat % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR;
    if (index !== litBeat) {
      litBeat = index;
      [...$('beats').children].forEach((lamp, i) => {
        lamp.dataset.on = String(i === index);
      });
    }
    requestAnimationFrame(drawBeat);
  }

  function setTempo(patch) {
    const now = performance.now();
    // Count on the way the server does: a tap restarts the bar, a new tempo keeps the beat.
    if (patch.sync) beatBase = { beat: 0, at: now };
    else if (patch.bpm !== undefined && patch.bpm !== tempo.bpm) {
      beatBase = { beat: beatNow(now), at: now };
    }
    const { sync: _sync, ...kept } = patch;
    tempo = { ...tempo, ...kept };
    sendTempo(patch);
    render();
    tell('change');
  }

  const taps = [];
  function tap() {
    const now = performance.now();
    if (taps.length > 0 && now - taps[taps.length - 1] > TAP_GAP_MS) taps.length = 0;
    taps.push(now);
    if (taps.length > TAPS_KEPT) taps.shift();

    const patch = { sync: true };
    if (taps.length >= 2) {
      const interval = (now - taps[0]) / (taps.length - 1);
      patch.bpm = Math.min(limits.max, Math.max(limits.min, Math.round(60_000 / interval)));
    }
    setTempo(patch);
  }

  function nudgeTempo(step) {
    const bpm = Math.round(tempo.bpm) + step;
    setTempo({ bpm: Math.min(limits.max, Math.max(limits.min, bpm)) });
  }

  function setMaster(level) {
    master = Math.min(1, Math.max(0, level));
    sendMaster({ master });
    render();
    tell('change');
  }

  // ---- building ----

  const tempoRow = slider({
    id: 's-bpm',
    label: 'Tempo in beats per minute',
    min: limits.min,
    max: limits.max,
    read: () => Math.round(tempo.bpm),
    write: (number) => setTempo({ bpm: number }),
  });
  $('tempo-sliders').append(tempoRow);

  // A tap counts when the finger lands, not when it lifts. The click covers the keyboard.
  $('tap').addEventListener('pointerdown', (event) => {
    if (event.button === 0) tap();
  });
  $('tap').addEventListener('click', (event) => {
    if (event.detail === 0) tap();
  });
  $('tempo-down').addEventListener('click', () => nudgeTempo(-1));
  $('tempo-up').addEventListener('click', () => nudgeTempo(1));

  for (const rate of limits.rates) {
    const made = button('pick', RATE_NAMES[rate] ?? `${rate} times`, () => setTempo({ rate }));
    made.dataset.rate = String(rate);
    $('rates').append(made);
  }

  $('blackout').addEventListener('click', () => {
    blackout = !blackout;
    sendBlackout({ blackout });
    render();
    tell('change');
  });

  // ---- drawing ----

  function renderLinks() {
    const bridge = $('link-bridge');
    bridge.dataset.state = status.bridge ? 'ok' : 'down';
    bridge.querySelector('.link-text').textContent = status.bridge
      ? 'Bridge connected'
      : 'Bridge not connected';

    const device = $('link-device');
    const known = status.bridge && status.device !== 'unknown';
    device.dataset.state = !known ? 'unknown' : status.device === 'open' ? 'ok' : 'down';
    device.querySelector('.link-text').textContent = !known
      ? 'LR512'
      : status.device === 'open'
        ? 'LR512 connected'
        : 'LR512 not found';
  }

  /** Why nothing reaches this fixture where it is patched, or nothing when it does. */
  function patchNote(each) {
    const name = `the ${each.label.toLowerCase()}`;
    const port = each.universe + 1;
    if (status.device !== 'open') return '';
    if (each.universe >= status.universes) {
      return `This LR512 has ${status.universes} ports and ${name} is set to port ${port}. Start lightdeck with a lower universe for ${name}.`;
    }
    if (status.channels[each.universe] === 0) {
      const usable = status.channels.flatMap((count, i) => (count > 0 ? [i] : []));
      return (
        `Port ${port} of this LR512 has no channels, so nothing reaches ${name}. ` +
        (usable.length > 0
          ? `Plug ${name} into port ${usable[0] + 1} and start lightdeck with universe ${usable[0]} for it.`
          : 'The LR512 reports no usable port.')
      );
    }
    return '';
  }

  /** Why every fixture is dark, or nothing when they show. The blackout comes first. */
  function darkNote() {
    if (blackout) {
      return { text: 'Blackout is on. Every fixture is dark, and what you set is kept.' };
    }
    if (master > 0) return undefined;
    const where = page === 'deck' ? 'the master' : 'the master on the deck';
    return {
      text: `The master is at 0. Every fixture is dark, and what you set is kept. Raise ${where} to see it.`,
    };
  }

  function renderNotice() {
    const notes = pageNotes();
    const patch = watched.map(patchNote).find((note) => note !== '');
    let text = '';
    // Alarm: something is wrong. Anything else only explains why the lights are dark.
    let level = 'alarm';
    if (!streamUp || failing.size > 0) {
      // Only what is kept is sent later. A press that was asked once is not.
      text =
        held.size > 0
          ? 'This page cannot reach lightdeck. It keeps trying; your last change is sent as soon as it is back.'
          : 'This page cannot reach lightdeck. It keeps trying.';
    } else if (!status.bridge) {
      text = `The bridge app does not answer at ${initial.bridgeUrl}. Open Lightdeck LR512 Bridge on the phone and keep it on screen.`;
    } else if (status.device === 'lost') {
      text =
        'The bridge cannot find the LR512 and keeps searching. Check that the LR512 has power and is on the Wi-Fi.';
    } else if (patch) {
      text = patch;
    } else {
      const note =
        notes.find((each) => each.level === 'alarm') ??
        notes.find((each) => each.urgent) ??
        darkNote() ??
        notes[0];
      level = note?.level ?? 'note';
      text = note?.text ?? '';
    }
    const notice = $('notice');
    notice.dataset.level = level;
    notice.textContent = text;
    notice.hidden = text === '';
  }

  function render() {
    tempoRow.refresh();
    for (const made of document.querySelectorAll('#rates .pick')) {
      made.setAttribute('aria-pressed', String(Number(made.dataset.rate) === tempo.rate));
    }
    $('blackout').setAttribute('aria-pressed', String(blackout));
    $('blackout').textContent = blackout ? 'Lift blackout' : 'Blackout';
    const level = masterPercent(master);
    $('master-level').dataset.full = String(level === 100);
    $('master-value').textContent = `${level}%`;
    renderLinks();
    renderNotice();
  }

  render();
  listen();
  requestAnimationFrame(drawBeat);

  return {
    fixture,
    fixtures: initial.fixtures,
    send: sendFixture,
    pending: pendingFixture,
    act,
    ask,
    get show() {
      return show;
    },
    get playback() {
      return playback;
    },
    on: (name, handler) => handlers[name].push(handler),
    notes: (say) => {
      pageNotes = say;
      renderNotice();
    },
    refresh: renderNotice,
    beat: beatNow,
    get blackout() {
      return blackout;
    },
    get master() {
      return master;
    },
    setMaster,
    get tempo() {
      return { ...tempo };
    },
  };
}
