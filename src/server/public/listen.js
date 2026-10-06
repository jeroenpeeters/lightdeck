// The listen page: the microphone of this laptop, which lightdeck listens to for the beat.
// Plain browser JavaScript, no build step.
//
// The page opens the microphone, takes the sound in blocks of about 100 ms (see
// mic-worklet.js) and posts every block to `POST /api/audio`. Lightdeck does the rest.
// What is sent is raw 16-bit mono samples, so the page knows nothing about beats.
//
// The browser only gives a microphone to localhost or https. The tablet reaches lightdeck
// by its address on the network, so this page has to be opened on the laptop itself, and
// it says so when it is not.
//
// Sound processing of the browser (echo cancellation, noise suppression, automatic gain)
// is asked to be off. It is made for speech and flattens music. The page tells when the
// browser keeps it on anyway.
//
// The feed does not stop when the page is hidden, and it holds no connection open: every
// block is its own request. The only timers it uses are none, so a hidden page is not
// slowed down by the browser's throttling of timers. It asks the browser to keep the
// screen on while it listens, because a laptop that sleeps hears nothing.
//
// The key does not change size or place when it starts, and what there is to say is at
// the bottom of the screen with the notice of the shell, like on the deck.

import {
  explainMicrophone,
  feedName,
  measure,
  postHeaders,
  processingNote,
  SendQueue,
} from './feed.js';
import { start } from './shell.js';
import { $, button, sentence, slider } from './ui.js';

const DEVICE_KEY = 'lightdeck.listen.device';
/** A peak above this is the microphone clipping. */
const CLIP_DB = -1;
/** So many blocks of the last twenty clipping is worth saying. */
const CLIP_BLOCKS = 4;

const page = {
  key: $('listen'),
  device: $('device'),
  meter: $('meter'),
  level: $('fact-level'),
  sent: $('fact-sent'),
  dropped: $('fact-dropped'),
  rate: $('fact-rate'),
  notices: $('notices'),
  notice: $('listen-notice'),
};

/** What is open while listening. Undefined when not. */
let session;
let busy = false;
/** Why the microphone could not be had or has ended: the operator has to do something. */
let problem = '';
/** Why sending does not work now. It goes away by itself when it works again. */
let failure = '';
/** What the browser did with the processing that was asked to be off. */
let processing = '';
/** Why a setting was refused: what the server said. It goes when a setting is accepted. */
let refused = '';
/** The page the shell gave. */
let shell;

function chosenDevice() {
  try {
    return localStorage.getItem(DEVICE_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberDevice(id) {
  try {
    localStorage.setItem(DEVICE_KEY, id);
  } catch {
    // Not remembered: it is only a convenience.
  }
}

function renderNotice() {
  let text = '';
  let level = 'alarm';
  const clipping = session && session.clipped >= CLIP_BLOCKS;
  if (problem) text = problem;
  else if (failure) text = failure;
  else if (refused) text = refused;
  else if (clipping) {
    text =
      'The microphone is clipping. Turn the input level down in the sound settings of the laptop.';
  } else if (processing) {
    text = processing;
    level = 'note';
  }
  page.notice.dataset.level = level;
  page.notice.textContent = text;
  page.notice.hidden = text === '';
}

function render() {
  const listening = session !== undefined;
  page.key.setAttribute('aria-pressed', String(listening));
  page.key.textContent = listening ? 'Stop listening' : 'Start listening';
  page.key.disabled = busy || !window.isSecureContext;
  if (!listening) {
    page.meter.value = -60;
    for (const fact of [page.level, page.sent, page.dropped, page.rate]) fact.textContent = '–';
  }
  renderNotice();
}

async function fillDevices() {
  const chosen = chosenDevice();
  let inputs = [];
  try {
    inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
      (each) => each.kind === 'audioinput',
    );
  } catch {
    // Without a list the default input is all there is.
  }
  const options = [new Option('Default input', '')];
  inputs.forEach((each, i) => {
    options.push(new Option(each.label || `Input ${i + 1}`, each.deviceId));
  });
  page.device.replaceChildren(...options);
  page.device.value = options.some((each) => each.value === chosen) ? chosen : '';
}

async function holdScreen() {
  if (!session || session.wake || !navigator.wakeLock) return;
  try {
    session.wake = await navigator.wakeLock.request('screen');
    session.wake.addEventListener('release', () => {
      if (session) session.wake = null;
    });
  } catch {
    // The screen may go to sleep. Nothing to tell: the notice would only be noise.
  }
}

/** Sends what waits, one request at a time, so that blocks arrive in order. */
async function pump(open) {
  if (open.sending) return;
  open.sending = true;
  while (open.queue.length > 0 && session === open) {
    const block = open.queue.next();
    try {
      const response = await fetch('/api/audio', {
        method: 'POST',
        headers: postHeaders({
          rate: open.context.sampleRate,
          index: block.index,
          feed: open.feed,
        }),
        body: block.samples,
      });
      if (response.ok) {
        open.sentSamples += block.samples.length;
        failure = '';
      } else {
        const said = await response.json().catch(() => ({}));
        failure = `Lightdeck did not take the sound. ${said.error ?? `It answered ${response.status}.`}`;
      }
    } catch {
      failure = 'Lightdeck does not answer, so the sound is not getting there. It keeps trying.';
    }
  }
  open.sending = false;
  if (session === open) renderFacts(open);
}

function renderFacts(open) {
  page.sent.textContent = `${Math.round(open.sentSamples / open.context.sampleRate)} s`;
  page.dropped.textContent = String(open.queue.dropped);
  page.rate.textContent = `${open.context.sampleRate / 1000} kHz`;
  renderNotice();
}

function onBlock(open, block) {
  const { rms, peak } = measure(block.samples);
  open.clipped = Math.max(0, open.clipped + (peak > CLIP_DB ? 1 : -0.25));
  page.meter.value = rms;
  page.level.textContent = `${Math.round(rms)} dB`;
  open.queue.push(block);
  pump(open);
}

async function begin() {
  if (session || busy) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    problem = explainMicrophone({ name: 'NotSecure' }, location.host);
    render();
    return;
  }
  busy = true;
  problem = '';
  failure = '';
  render();
  let stream;
  let context;
  try {
    const deviceId = chosenDevice();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    context = new AudioContext({ latencyHint: 'interactive' });
    await context.audioWorklet.addModule('/mic-worklet.js');
    await context.resume();
    const node = new AudioWorkletNode(context, 'lightdeck-mic', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    context.createMediaStreamSource(stream).connect(node);
    // The worklet writes no output, so this is silence: it only keeps the node running.
    node.connect(context.destination);

    const open = {
      stream,
      context,
      node,
      feed: feedName(),
      queue: new SendQueue(),
      sending: false,
      sentSamples: 0,
      clipped: 0,
      wake: null,
    };
    const track = stream.getAudioTracks()[0];
    processing = processingNote(track?.getSettings());
    track?.addEventListener('ended', () => {
      if (session !== open) return;
      problem =
        'The microphone stopped. It was unplugged or another program took it. Press Start listening.';
      end();
    });
    node.port.onmessage = (event) => {
      if (session === open) onBlock(open, event.data);
    };
    session = open;
    holdScreen();
    // Names of the inputs are only given once the microphone is allowed.
    fillDevices();
  } catch (error) {
    problem = explainMicrophone(error);
    for (const track of stream?.getTracks() ?? []) track.stop();
    context?.close().catch(() => {});
  } finally {
    busy = false;
    render();
  }
}

/** Closes the microphone and everything that goes with it. */
function end() {
  const open = session;
  session = undefined;
  if (open) {
    open.node.port.onmessage = null;
    open.node.disconnect();
    for (const track of open.stream.getTracks()) track.stop();
    open.context.close().catch(() => {});
    open.wake?.release().catch(() => {});
  }
  failure = '';
  processing = '';
  render();
}

// ---- what the tempo does ----

/** How long a drag of a slider rests before it is sent. */
const SETTLE_MS = 300;
/** What has been changed and is not sent yet, and whether a request is out. */
let queued = {};
let sending = false;
let timer;
/** Everything that shows the settings, so that it can show them again. */
const shown = [];

const SILENCE = [
  ['stop', 'Effects idle'],
  ['hold', 'Tempo keeps running'],
];
const NO_BEAT = [
  ['hold', 'Tempo keeps running'],
  ['stop', 'Effects idle'],
];
const PHASE = [
  ['smooth', 'Move to it gently'],
  ['snap', 'Jump to it'],
];

const settings = () => shell.audio.settings;

/** A change is on its way: the sliders are not set back under a finger before it has arrived. */
const changing = () => sending || timer !== undefined || Object.keys(queued).length > 0;

function refreshSettings() {
  if (changing()) return;
  for (const refresh of shown) refresh();
}

async function sendSettings() {
  timer = undefined;
  if (sending) return;
  const patch = queued;
  queued = {};
  sending = true;
  const answer = await shell.ask('/api/audio/settings', patch);
  sending = false;
  refused = answer.ok ? '' : sentence(answer.error);
  // Something that was changed meanwhile goes out next; otherwise show what is real.
  if (Object.keys(queued).length > 0) timer = setTimeout(sendSettings, SETTLE_MS);
  else refreshSettings();
  renderNotice();
}

function change(patch) {
  queued = { ...queued, ...patch };
  clearTimeout(timer);
  timer = setTimeout(sendSettings, SETTLE_MS);
}

function choices(fieldset, name, options) {
  const keys = options.map(([value, label]) => ({
    value,
    made: button('pick', label, () => {
      // A key sends at once: there is nothing to drag.
      queued = { ...queued, [name]: value };
      clearTimeout(timer);
      timer = undefined;
      sendSettings();
      for (const each of keys) each.made.setAttribute('aria-pressed', String(each.value === value));
    }),
  }));
  for (const { made } of keys) fieldset.append(made);
  shown.push(() => {
    for (const each of keys) {
      each.made.setAttribute('aria-pressed', String(each.value === settings()[name]));
    }
  });
}

function numbers(container, rows) {
  for (const row of rows) {
    const made = slider({
      id: `s-${row.name}`,
      label: row.label,
      min: row.min,
      max: row.max,
      read: () => settings()[row.name],
      write: (number) => change({ [row.name]: number }),
      meaning: row.meaning,
    });
    container.append(made);
    shown.push(() => made.refresh());
  }
}

function buildSettings() {
  choices($('choice-silence'), 'onSilence', SILENCE);
  choices($('choice-nobeat'), 'onNoBeat', NO_BEAT);
  choices($('choice-phase'), 'phase', PHASE);
  numbers($('behaviour-sliders'), [
    {
      name: 'silenceAfter',
      label: 'Silent after, in seconds',
      min: 1,
      max: 15,
      meaning: (n) => `Quiet for ${n} ${n === 1 ? 'second' : 'seconds'} counts as silence.`,
    },
    {
      name: 'silenceDrop',
      label: 'Quiet means this far below the music, in dB',
      min: 6,
      max: 40,
      meaning: (n) => `A drop of ${n} dB from how loud the music was counts as quiet.`,
    },
    {
      name: 'beatLostAfter',
      label: 'No beat after, in beats',
      min: 2,
      max: 32,
      meaning: (n) => `${n} beats without a pulse and it is music without a beat.`,
    },
    {
      name: 'lockAfter',
      label: 'A new tempo is taken after, in beats',
      min: 2,
      max: 32,
      meaning: (n) => `A different tempo has to hold for ${n} beats to replace the one it has.`,
    },
    {
      name: 'bpmMin',
      label: 'Slowest tempo it looks for',
      min: 60,
      max: 180,
      meaning: () => 'Keeps half time from being taken for the tempo.',
    },
    {
      name: 'bpmMax',
      label: 'Fastest tempo it looks for',
      min: 80,
      max: 200,
      meaning: () => 'Keeps double time from being taken for the tempo.',
    },
    {
      name: 'latencyMs',
      label: 'Latency, in milliseconds',
      min: -100,
      max: 300,
      meaning: (n) =>
        n === 0
          ? 'The lights come after the beat: lower it. They come before: raise it.'
          : `Beats are put ${Math.abs(n)} ms ${n > 0 ? 'later' : 'earlier'}.`,
    },
  ]);
  refreshSettings();
}

async function main() {
  shell = await start({ page: 'listen' });
  if (!shell) return;
  document.title = 'Listen · Lightdeck';

  // The notice of the shell joins the one of this page, where it takes no room from the key.
  page.notices.prepend($('notice'));

  if (!window.isSecureContext) problem = explainMicrophone({ name: 'NotSecure' }, location.host);
  page.key.addEventListener('click', () => (session ? end() : begin()));
  page.device.addEventListener('change', () => {
    rememberDevice(page.device.value);
    // Another input is another feed: the microphone is opened again.
    if (session) {
      end();
      begin();
    }
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', fillDevices);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) holdScreen();
  });
  window.addEventListener('pagehide', () => {
    if (session) end();
  });
  buildSettings();
  shell.on('audio', refreshSettings);
  fillDevices();
  render();
}

main();
