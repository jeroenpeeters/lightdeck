// The shell of every page of the console. Plain browser JavaScript, no build step.
//
// A page is about one fixture, or about the show, as the deck is. Around it the shell
// puts what belongs to no fixture: the top bar (topbar.js: a Live key back to the live page, the tempo, the
// master, the master speed and the blackout), the notice, and the state of the link to the LR512. It also
// does the talking to the server, so that a page only has to say what changes and to draw
// what it is told.
//
// The top bar is the same on every page and is put first in the element with the class `app` (the body when
// there is none). Where the tempo comes from (By hand, Rekordbox, Idle in breakdown), its nudge keys and
// what rekordbox says are in the menu sheet of the tablet page (menu.js); a page that wants them asks the
// shell for them below. A `bare` page (the tablet page) mounts the top bar itself with its own key, `menu`,
// and gets nothing from the shell on screen but the notice.
//
// The notice lies over the foot of the screen, in the element `#notices` (a `.notices-stack`) when the page
// has one, else in one that the shell makes. A click on it clears it, and it stays away while it says the same.
//
// The master is shown here and set on the deck. It is shown on every page, because on
// the page of a fixture it is why less goes out than what is set. The same goes for the
// master speed: it multiplies with the speed of every effect, so on the page of a
// fixture it is why an effect runs faster or slower than it is set to.
//
// A page starts the shell and gets back what it needs:
//
//   const shell = await start();          null when the page cannot be shown
//   const shell = await start({ page: 'deck' });        for a page about no fixture, such as
//                                          the deck, the palettes or the video wall
//   const shell = await start({ page: 'tablet', bare: true });   a page that mounts its own top bar
//                                          (`mountTopBar(shell, { left: 'menu' })`): the shell then
//                                          shows no bar, and a page asks for what it needs below
//   shell.fixture                          the fixture as /api/state describes it
//   shell.fixtures                         every fixture of the console
//   shell.show                             the show: its file, what is wrong with it, and
//                                          the groups with their scenes
//   shell.playback                         per group which scene is on, and whether its
//                                          fixtures were changed by hand since
//   shell.sequence                         which sequence runs and where: { running, step, steps,
//                                          barsLeft, paused, problem }
//   shell.ask(url, body)                   ask the server for something once; gives
//                                          { ok, error } and what the server answered,
//                                          with `lost` when the server was not reached
//   shell.on('show', (show) => ...)        the groups or their scenes changed
//   shell.on('playback', (playback) => ...)             another scene, off, or changed by hand
//   shell.on('sequence', (sequence) => ...)             a sequence started, stopped or stepped on
//   shell.send(patch)                      change the fixture
//   shell.pending()                        what of that the server has not told of yet
//   shell.act('reset')                     let the fixture do something by name
//   shell.on('fixture', ({ state, dmx, own }) => ...)   the fixture changed; `state` is
//                                          what the server says with what is pending
//                                          over it, so a page can take it as it is
//   shell.stateOf(id)                      the state the server last told of ANY fixture, for a page
//                                          that shows something of a fixture that is not its own
//   shell.on('fixtures', (id) => ...)      the state of some fixture changed (every page hears it)
//   shell.dmxOf(id)                        the bytes ANY DMX fixture was last sent, as an array
//   shell.on('frames', (id) => ...)        a fixture that animates sent a frame (every page hears it)
//   shell.on('frame', ({ dmx, beat }) => ...)           what is being sent, while it animates
//   shell.rkbx                             what rekordbox says through rkbx_link: { status,
//                                          following, bpm, beats, port, breakdown: { enabled,
//                                          phrase, active } }
//   shell.on('rkbx', (rkbx) => ...)        what rekordbox says changed
//   shell.videowall                        the video wall: { settings, track, preview, shown, last }, the settings
//                                          without the PIN (`pinSet` says whether there is one)
//   shell.on('videowall', (videowall) => ...)           the settings or what is on the wall changed
//   shell.on('change', () => ...)          blackout, master or tempo changed
//   shell.notes(() => [{ text, level, urgent }])        what the page has to say
//   shell.refresh()                        show the notes again
//   shell.blackout, shell.tempo, shell.beat()
//   shell.speed(own)                       what an effect with the speed `own` runs at:
//                                          { given, held }. `given` is its own speed
//                                          times the master speed, halved until
//                                          it stays within the changes per second that
//                                          are allowed, and `held` says that it was halved
//   shell.master                           the master, 0 to 1
//   shell.setMaster(level)                 move the master, for every fixture
//   shell.rates                            the speeds the master speed can have
//   shell.tempo.rate                       the master speed
//   shell.setRate(rate)                    set the master speed, for every effect
//   shell.tap()                            a tap on the beat, as the Tap key of the bar makes it
//   shell.setBpm(bpm)                      the tempo by hand (takes the tempo back from Rekordbox)
//   shell.nudgeTempo(step)                 the tempo by hand, one bpm up or down (so, 1 or -1)
//   shell.tempoLimits                      { min, max } of the bpm
//   shell.setSource('manual' | 'rekordbox')   who sets the tempo
//   shell.setBreakdown(on)                 whether the effects idle while rekordbox is in a breakdown
//   shell.rkbxLine                         what rekordbox says in a line, { text, state }: state is
//                                          off, down, silent, music or beat
//   shell.setBlackout(on)                  switch the blackout, for every fixture
//   shell.links                            the state of the link lamps: { bridge, device, hass }, each
//                                          { state: 'ok' | 'down' | 'unknown' | 'simulated', text }.
//                                          `hass` is there only when a fixture is driven by
//                                          Home Assistant
//   shell.on('status', () => ...)          the bridge or the LR512 came or went
//   shell.bar                              the top bar of the page ({ root, key, ... }, see topbar.js), or
//                                          null for a bare page, which mounts its own
//
// And for a page that shows the master:
//
//   masterPercent(level)                   the master in percent, as the bar shows it

import { changesOnTheWay, merge } from './changes.js';
import { mountTopBar } from './topbar.js';
import { $, element, makeDismissible, masterPercent, setNotice } from './ui.js';

export { masterPercent };

const RETRY_MS = 600;
/** Taps further apart than this start a new count. */
const TAP_GAP_MS = 2000;
const TAPS_KEPT = 8;

function alarm(text) {
  const notice = $('notice');
  notice.dataset.level = 'alarm';
  notice.textContent = text;
  notice.hidden = false;
}

/** The part of what the server says about the tempo that this page keeps. */
function readTempo(from) {
  return { bpm: from.bpm, rate: from.rate, source: from.source, running: from.running };
}

export async function start({ page = 'fixture', bare = false } = {}) {
  // The notice lies over the foot of the screen, in a stack of its own that a page may have made.
  const host = document.querySelector('.app') ?? document.body;
  let stack = $('notices');
  if (!stack) {
    stack = element('div', 'notices-stack');
    stack.id = 'notices';
    host.append(stack);
  }
  const notice = element('p', 'notice');
  notice.id = 'notice';
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  stack.prepend(notice);
  // Over the keys a notice has to be able to go: a click on it clears it.
  makeDismissible(notice);

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
  let sequence = initial.sequence;
  /** By the id of a fixture, the state the server told of it last. */
  const states = new Map(initial.fixtures.map((each) => [each.id, each.state]));
  // The bytes that ANY fixture is sent, as the last `fixture` or `frame` event said (DMX fixtures only).
  const dmxs = new Map(
    initial.fixtures.filter((each) => each.dmx).map((each) => [each.id, each.dmx]),
  );
  const limits = initial.tempo;
  let tempo = readTempo(initial.tempo);
  /** What rekordbox says through rkbx_link, and whether the tempo follows it. */
  let rkbx = initial.rkbx;
  /** The track that goes to the video wall, and what is on it. */
  let videowall = initial.videowall;
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
  const handlers = {
    fixture: [],
    frame: [],
    change: [],
    show: [],
    playback: [],
    sequence: [],
    fixtures: [],
    frames: [],
    rkbx: [],
    videowall: [],
    status: [],
  };
  const tell = (name, message) => {
    for (const handler of handlers[name]) handler(message);
  };

  if (page === 'fixture' && !fixture) {
    alarm(
      `There is no fixture called "${id}". Go back to the live page and choose one in the menu.`,
    );
    return null;
  }
  if (fixture) {
    document.title = `${fixture.label} · Lightdeck`;
    if ($('fixture-name')) $('fixture-name').textContent = fixture.label;
    if ($('where')) {
      $('where').textContent =
        fixture.protocol === 'hass'
          ? `Home Assistant, ${fixture.details.lamps.length} lamps and switches`
          : `Port ${fixture.universe + 1}, address ${fixture.address}, ${fixture.footprint} channels`;
    }
  }

  // ---- talking to the server ----

  async function reload() {
    const fresh = await (await fetch('/api/state')).json();
    tempo = readTempo(fresh.tempo);
    rkbx = fresh.rkbx;
    videowall = fresh.videowall;
    setBeat(fresh.tempo.beat);
    blackout = fresh.blackout;
    master = fresh.master;
    for (const each of fresh.fixtures) {
      states.set(each.id, each.state);
      if (each.dmx) dmxs.set(each.id, each.dmx);
    }
    tell('fixtures', null);
    const real = fresh.fixtures.find((each) => each.id === id);
    if (real) tell('fixture', { state: shownState(real.state), dmx: real.dmx, own: false });
    show = fresh.show;
    playback = fresh.playback;
    sequence = fresh.sequence;
    tell('show', show);
    tell('playback', playback);
    tell('sequence', sequence);
    render();
    tell('rkbx', rkbx);
    tell('videowall', videowall);
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
  const sendRkbx = sender('/api/rkbx');
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

  /**
   * The event stream, while this page is on screen. A browser has six connections to
   * lightdeck for all its tabs together, and a stream keeps one for as long as it is
   * open. With a stream per tab, a few tabs leave none to load a page with, and going
   * from one page to another takes half a minute. So a page that is not on screen gives
   * its stream back, and asks for it again when it is: the stream starts with what is
   * real, so nothing is missed.
   */
  let events;

  function hush() {
    events?.close();
    events = undefined;
  }

  function listen() {
    if (events) return;
    events = new EventSource('/api/events');
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
      states.set(message.id, message.state);
      if (message.dmx) dmxs.set(message.id, message.dmx);
      tell('fixtures', message.id);
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
      dmxs.set(message.id, message.dmx);
      tell('frames', message.id);
      if (message.id === id) tell('frame', { dmx: message.dmx, beat: message.beat });
    });
    on('tempo', (message) => {
      if (message.origin === clientId) return;
      tempo = readTempo(message);
      setBeat(message.beat);
      render();
      tell('change');
    });
    on('rkbx', (message) => {
      rkbx = message;
      render();
      tell('rkbx', rkbx);
    });
    on('videowall', (message) => {
      videowall = message;
      tell('videowall', videowall);
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
      renderNotice();
      tell('status');
    });
    on('show', (message) => {
      show = message;
      tell('show', show);
    });
    on('playback', (message) => {
      playback = message;
      tell('playback', playback);
    });
    on('sequence', (message) => {
      sequence = message;
      tell('sequence', sequence);
    });
  }

  // ---- the beat ----

  function setBeat(beat) {
    if (typeof beat === 'number') beatBase = { beat, at: performance.now() };
  }

  function beatNow(now = performance.now()) {
    return beatBase.beat + ((now - beatBase.at) / 60_000) * tempo.bpm;
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
    // By hand the effects always run.
    if (tempo.source === 'manual') tempo.running = true;
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
    // Rekordbox has the tempo: a tap only says where beat one is.
    if (taps.length >= 2 && tempo.source === 'manual') {
      const interval = (now - taps[0]) / (taps.length - 1);
      patch.bpm = Math.min(limits.max, Math.max(limits.min, Math.round(60_000 / interval)));
    }
    setTempo(patch);
  }

  function nudgeTempo(step) {
    const bpm = Math.round(tempo.bpm) + step;
    setTempo(byHand({ bpm: Math.min(limits.max, Math.max(limits.min, bpm)) }));
  }

  /** A tempo set by hand is the tempo, so it takes the tempo back from Rekordbox. */
  function byHand(patch) {
    return tempo.source === 'manual' ? patch : { ...patch, source: 'manual' };
  }

  /** Whether the effects are idle while rekordbox is in a breakdown. Off at every start. */
  function setBreakdown(on) {
    rkbx = { ...rkbx, breakdown: { ...rkbx.breakdown, enabled: on } };
    sendRkbx({ breakdown: on });
    render();
    tell('rkbx', rkbx);
  }

  function setMaster(level) {
    master = Math.min(1, Math.max(0, level));
    sendMaster({ master });
    render();
    tell('change');
  }

  // ---- the tempo: the bar and the menu ask for these ----

  function setBpm(bpm) {
    setTempo(byHand({ bpm: Math.min(limits.max, Math.max(limits.min, Math.round(bpm))) }));
  }

  function setSource(source) {
    if (tempo.source !== source) setTempo({ source });
  }

  /** The speed an effect runs at, counted the way the server does. */
  function speed(own = 1) {
    const wanted = own * tempo.rate;
    let given = wanted;
    while ((tempo.bpm / 60) * given > limits.changesPerSecond) given /= 2;
    return { given, held: given < wanted };
  }

  function setBlackout(on) {
    blackout = on;
    sendBlackout({ blackout });
    render();
    tell('change');
  }

  // ---- drawing ----

  /** The state of the links and the words for them, for the lamps of the bar and of a bare page. */
  function linkStates() {
    // Started without a bridge: nothing is wrong, the simulator is the output.
    const bridge = {
      state: !initial.bridgeUrl ? 'unknown' : status.bridge ? 'ok' : 'down',
      text: !initial.bridgeUrl
        ? 'No bridge'
        : status.bridge
          ? 'Bridge connected'
          : 'Bridge not connected',
    };
    const known = status.bridge && status.device !== 'unknown';
    const device = {
      state: !known ? 'unknown' : status.device === 'open' ? 'ok' : 'down',
      text: !known ? 'LR512' : status.device === 'open' ? 'LR512 connected' : 'LR512 not found',
    };
    // Home Assistant has a lamp only when a fixture is driven by it.
    if (status.hass === undefined) return { bridge, device };
    const hass =
      status.hass === 'simulated'
        ? { state: 'simulated', text: 'Home Assistant simulated' }
        : {
            state: status.hass === 'connected' ? 'ok' : 'down',
            text:
              status.hass === 'connected'
                ? 'Home Assistant'
                : status.hass === 'refused'
                  ? 'Token refused'
                  : 'Home Assistant down',
          };
    return { bridge, device, hass };
  }

  /** Why nothing reaches this fixture where it is patched, or nothing when it does. */
  function patchNote(each) {
    // Only a fixture on DMX is patched to a port of the LR512.
    if (each.protocol === 'hass') return '';
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

  /** Rekordbox has the tempo and something is missing: the tempo holds, and the operator has to do something. */
  function rkbxNote() {
    if (tempo.source !== 'rekordbox') return '';
    const bpm = Math.round(tempo.bpm);
    if (rkbx.port === undefined) {
      return `Rekordbox has the tempo, but lightdeck is not listening for rkbx_link (the port is off or taken). The tempo stays at ${bpm}.`;
    }
    if (rkbx.status === 'waiting') {
      return `Rekordbox has the tempo, but nothing has come from rkbx_link yet. The tempo stays at ${bpm}. Start rkbx_link and set osc.destination to this laptop, port ${rkbx.port}.`;
    }
    if (!rkbx.beats && tempo.running) {
      return `rkbx_link sends the bpm but no beats, so the beat is where it was. Turn on osc.msg.master/beat/trigger with 1 in its config.`;
    }
    if (rkbx.breakdown.enabled && rkbx.beats && rkbx.breakdown.phrase === undefined) {
      return 'Idle in breakdown is on, but no phrase is coming. Turn on osc.msg.master/phrase in rkbx_link, or this track has no phrase analysis.';
    }
    return '';
  }

  /** What rekordbox says, in a line, and whether it is something to look at. */
  function rkbxLine() {
    if (tempo.source !== 'rekordbox') return { text: '', state: 'off' };
    if (rkbx.port === undefined) return { text: 'Not listening for rkbx_link', state: 'down' };
    if (rkbx.status === 'waiting') return { text: 'Waiting for rkbx_link', state: 'down' };
    const bpm = rkbx.bpm === undefined ? '' : ` · ${rkbx.bpm.toFixed(1)} bpm`;
    // The phrase is shown whether idling for it is on or not: it is how to see whether it fits the music.
    const { phrase, active } = rkbx.breakdown;
    const named = phrase === undefined ? '' : ` · ${phrase}`;
    if (!rkbx.beats && !tempo.running)
      return { text: 'Rekordbox stopped · effects idle', state: 'silent' };
    if (active && !tempo.running)
      return { text: `Breakdown${named} · effects idle`, state: 'silent' };
    if (rkbx.beats) return { text: `Rekordbox${bpm}${named}`, state: 'beat' };
    return { text: `Rekordbox${bpm}, no beats`, state: 'music' };
  }

  function renderNotice() {
    const notes = pageNotes();
    const patch = watched.map(patchNote).find((note) => note !== '');
    // The room page says nothing about the phone, and the spider page nothing about Home Assistant.
    const usesBridge = watched.some((each) => each.protocol !== 'hass');
    const usesHass = watched.some((each) => each.protocol === 'hass');
    let text = '';
    // Alarm: something is wrong. Anything else only explains why the lights are dark.
    let level = 'alarm';
    if (!streamUp || failing.size > 0) {
      // Only what is kept is sent later. A press that was asked once is not.
      text =
        held.size > 0
          ? 'This page cannot reach lightdeck. It keeps trying; your last change is sent as soon as it is back.'
          : 'This page cannot reach lightdeck. It keeps trying.';
    } else if (usesBridge && initial.bridgeUrl && !status.bridge) {
      text = `The bridge app does not answer at ${initial.bridgeUrl}. Open Lightdeck LR512 Bridge on the phone and keep it on screen.`;
    } else if (usesBridge && status.device === 'lost') {
      text =
        'The bridge cannot find the LR512 and keeps searching. Check that the LR512 has power and is on the Wi-Fi.';
    } else if (usesHass && status.hass === 'refused') {
      text =
        'Home Assistant does not accept the token. Check HASS_TOKEN where lightdeck is started, and restart it.';
    } else if (usesHass && status.hass === 'down') {
      text =
        'Lightdeck cannot reach Home Assistant, so the lamps keep what they have. It keeps trying; what you set is sent when it is back.';
    } else if (rkbxNote()) {
      text = rkbxNote();
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
      // Nothing else to say: the room page still says that its lamps are made up.
      if (text === '' && usesHass && status.hass === 'simulated') {
        level = 'note';
        text = 'Home Assistant is simulated: no real lamp is touched by what you set here.';
      }
    }
    notice.dataset.level = level;
    setNotice(notice, text);
  }

  /** What the shell itself draws is the notice; the bar and the menu draw from the events. */
  function render() {
    renderNotice();
  }

  const api = {
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
    get sequence() {
      return sequence;
    },
    stateOf: (fixtureId) => states.get(fixtureId),
    dmxOf: (fixtureId) => dmxs.get(fixtureId),
    get rkbx() {
      return rkbx;
    },
    get videowall() {
      return videowall;
    },
    on: (name, handler) => handlers[name].push(handler),
    notes: (say) => {
      pageNotes = say;
      renderNotice();
    },
    refresh: renderNotice,
    beat: beatNow,
    speed,
    get blackout() {
      return blackout;
    },
    get master() {
      return master;
    },
    setMaster,
    tap,
    setBpm,
    nudgeTempo,
    tempoLimits: { min: limits.min, max: limits.max },
    setSource,
    setBreakdown,
    get rkbxLine() {
      return rkbxLine();
    },
    setBlackout,
    get links() {
      return linkStates();
    },
    rates: limits.rates,
    setRate: (rate) => setTempo({ rate }),
    get tempo() {
      return { ...tempo };
    },
    bar: null,
  };

  // Every page that is not bare has the top bar, with a key back to the live page.
  if (!bare) api.bar = mountTopBar(api, { left: 'live', host });

  render();
  if (!document.hidden) listen();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hush();
    else listen();
  });
  // A page that the browser keeps for the way back is not on screen either.
  window.addEventListener('pagehide', hush);
  window.addEventListener('pageshow', () => {
    if (!document.hidden) listen();
  });

  return api;
}
