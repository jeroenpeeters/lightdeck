# Plan: the tempo follows the music

Status: built on 2026-10-02, see "What was built" below for what differs from this plan and
what was verified. It has not run with a real microphone, real music or the real fixtures.
Decisions marked "Jeroen" were made by him on that date; the rest is a proposal.

## What it is for

Jeroen plays the music and the lights follow the beat. Today he sets the tempo by hand or
taps it, and a tapped tempo drifts (see `show-design.md`, "Tempo and Ableton Link").
With **Auto** on, lightdeck listens to the room through the microphone of the laptop and
sets the tempo and the place of the beat itself.

- Music with a beat: the effects follow it.
- The music stops: the effects go idle.
- Music without a beat, as in a breakdown: the tempo stays where it was and the effects
  keep running.

**By hand** stays one press away, and is what lightdeck starts in.

## Terms

| Term | Meaning |
|---|---|
| By hand, Auto | The two sources of the tempo. By hand is what exists today: slider, nudge, tap. Auto is the listening |
| Heard | What lightdeck hears: `silent`, `music` (sound without a pulse) or `beat` |
| Running | Whether the tempo is counting for the effects. Not running means the effects are idle |
| Idle | An effect that is idle does not drive the fixture. The fixture shows what is set by hand or by its scene. The effect stays chosen and drives again by itself when the tempo runs again |
| Source | Where sound comes from: first the microphone of the laptop, later something else |
| Feed, block | The stream of sound from a source, and a piece of it of about 100 ms |
| Tracker | The part that turns the feed into what is heard, the bpm and the place of the beat |
| Follower | The part that applies the settings to the tempo |

## Decisions

1. **The tempo can follow the music by listening** (Jeroen, 2026-10-02). He prefers
   listening to the music over getting the tempo from other software.
2. **The first source is the microphone of the lightdeck laptop, through the microphone
   API of the browser** (Jeroen, 2026-10-02).
3. **The microphone input is modular** (Jeroen, 2026-10-02). He may replace it with
   something else later, so the rest of the plan must not know where the sound comes from.
4. **No music: the light stops following the beat** (Jeroen, 2026-10-02), and **stop means
   idle** (Jeroen, 2026-10-02). My reading of "idle" is in the terms above: the effects
   stop driving the fixtures, which show what is set under them, and the effects come
   back by themselves. It is not a freeze of the last frame, and it is not the blackout.
5. **Music without a beat: the light keeps the current bpm** (Jeroen, 2026-10-02).
6. **All of this is configurable, with 4 and 5 as the defaults** (Jeroen, 2026-10-02).

Decided earlier and still true, see `CLAUDE.md`:

- At normal speed an effect changes once per beat at most, and whoever renders an effect
  limits it with `limitSpeed`.
- An effect never opens the laser.
- The blackout and the master are no part of a scene and are not touched by this.
- Lightdeck runs on Jeroen's laptop, so the browser that listens is on the same machine.

Ableton Link was built on 2026-09-30 and removed again by Jeroen on 2026-10-02 (Jeroen): it
did not do what he wanted and made beat matching useless. It is not coming back, and the
`source` field of the tempo is for the listening.

## How it hangs together

```
browser on the laptop                      lightdeck (Node)
  /listen ── mic ──► blocks ── POST /api/audio ──► BrowserMicSource ─┐
                                      (a later source) ──────────────┤  AudioSource
                                                                     ▼
                              features.ts ──► tracker.ts ──► follower.ts ──► Tempo ──► controllers
                              sound to onsets  heard, bpm,    the settings     bpm, beat,   effects
                                               place of beat  applied          running
```

The module is cut along the sound itself: mono samples with a sample rate and a position.
Everything after that is TypeScript on the server, in one place, where vitest reaches it.
A source only has to hand over samples. A file read by ffmpeg is a source too, which is how
the tracker gets tuned without a microphone.

## What fits as it is

| Part | Why |
|---|---|
| The effects in `src/engine/` | Pure functions of the beat. An idle effect is one that is not rendered, and they need no change |
| `limitSpeed` and `MAX_FLASH_HZ` | A bpm from Auto goes through them like a typed one. The tracker keeps to `bpmRange`, which lies inside `MIN_BPM`..`MAX_BPM` |
| The 25 ms tickers of `spiderController.ts:424` and `laserController.ts:334` | They run while an effect is chosen and read the tempo on every tick, so a change of `running` shows within 25 ms and needs no subscription |
| Scenes and `playback.ts` | The tempo is no part of a scene, and an effect that is idle is still the effect the scene chose |
| `Tempo.update`, which keeps the beat when the bpm changes (`tempo.ts:90`) | A bpm that moves a little every few seconds does not make the effects jump |
| The `tempo` event: rig, then `/api/events`, then the shell | One more field in what it carries is all it needs |
| The blackout and the master | They are applied last, and win over everything here |

## What has to be refactored

### 1. `src/server/tempo.ts`: a source and a running flag

`TempoState` (`:17`) is `{ bpm, rate }` now. It becomes:

```ts
export type TempoSource = 'manual' | 'audio';

export interface TempoState {
  bpm: number;
  rate: number;
  /** Who sets the bpm and the beat: the operator, or the listening. */
  source: TempoSource;
  /** False while the effects are to be idle. Always true when the source is manual. */
  running: boolean;
}
```

`update` (`:59`) takes `source` too. A new method is for the follower only and is not on
the API:

```ts
/**
 * What listening found. Ignored while the source is manual.
 * `beatAt` is a moment on `now()` at which a beat fell. The count of beats is kept: the
 * difference to the beat we are on is taken as a part of a beat, between minus a half and
 * a half, and the origin moves by a part of it, or all of it when `snap` is set.
 */
follow(change: { bpm?: number; beatAt?: number; running?: boolean; snap?: boolean }): void;
```

That is what makes Auto and the tap fit together: the listening moves the beat by less than
half a beat, so the bar one that the operator tapped stays bar one. `getBeat()` keeps
counting in real time while the tempo does not run, so nothing has to be stored or
restored. Going back to By hand sets `running` to true and keeps the bpm.

With the source `manual` and `running` true nothing behaves differently from today. That is
the refactor that can be committed by itself.

### 2. `spiderController.ts:387` and `laserController.ts:304`

`renderEffect()` of the spider and `showing()` of the laser return nothing while the tempo
is not running. The rest of the output is as it was: the levels or bytes the operator or
the scene set. For the laser that means it is neither opened nor closed by this. It shows
what it is set to, as with an effect that is switched off by hand. The blackout still
closes it.

### 3. `src/server/rig.ts`

The rig builds the tempo (`:76`), so it also owns the follower and the sources (new,
below). It emits an `audio` event with what is heard, and stops the sources in `close()`
(`:182`). A getter `getAudio()` gives the same picture for `/api/state`.

### 4. `src/server/http.ts`

- `POST /api/audio`: raw bytes, see "The wire". `readJson` (`:108`) reads JSON only and
  `MAX_BODY_BYTES` (`:59`) is 64 KB, so a `readBytes` goes beside it with a limit of 256 KB.
- `POST /api/audio/settings`: the settings below, validated like a tempo patch.
- `describeTempo` (`:161`) and `describe` (`:165`) add `source`, `running` and `audio`. The
  `/api/events` replay and the broadcasts get the `audio` event.
- `/listen` serves the page, like `/deck`. `POST /api/tempo` (`:270`) takes `source`.
- The comment at the top of the file and the API list in `CLAUDE.md` get the new routes.

### 5. `src/server/public/shell.js`

| Where | Change |
|---|---|
| The tempo panel (`:87`) | Two keys, By hand and Auto, and a line that says what is heard. Fixed width, so that no key moves when the text changes |
| `beatNow` (`:421`) and `drawBeat` | Do not count and do not light the beat while `running` is false |
| `setTempo` (`:438`), `tap` (`:453`), `nudgeTempo`, the slider (`:481`) | In Auto a tap only sets beat one. Moving the slider or nudging goes back to By hand with that bpm |
| Notices | The feed is lost; the microphone was refused |
| `visibilitychange` (`:616`) | Stays as it is, for the event stream. The feed of the listen page must not use it, see below |

### 6. `src/index.ts`

`--tempo` / `TEMPO_SOURCE` (`manual` or `audio`, default `manual`) sets what lightdeck
starts in, as the Link source would have. The settings come later, see "Open".

### 7. Tests that are touched

`tempo.test.ts:15` and `:84` expect `{ bpm: 126, rate: 1 }` and `:50` the state in an event;
all three get the two new fields.

### Not touched

`playback.ts`, `src/show/` (until settings are kept in the show file, see "Open"),
`src/fixtures/`, `src/outputs/`, `src/engine/`.

## New parts

### `src/inputs/audio/source.ts`: the line the module is cut along

```ts
export interface AudioBlock {
  /** Mono samples, -1 to 1. */
  samples: Float32Array;
  /** Samples per second. */
  sampleRate: number;
  /** Where samples[0] lies in the feed, counted in samples from its start. A jump in the numbers is sound that was lost. */
  index: number;
}

export type SourceStatus = 'waiting' | 'live' | 'lost';

/** Emits 'block' (AudioBlock, arrivedAt) and 'status' (SourceStatus). */
export interface AudioSource extends EventEmitter {
  readonly id: string;     // 'browser-mic'
  readonly label: string;  // what the page calls it: "Microphone of the laptop"
  getStatus(): SourceStatus;
  start(): void;
  stop(): void;
}
```

Rules: a source gives samples and a status and knows nothing about beats. `arrivedAt` is
on the clock of `Tempo.now`. A source that has not been heard from for 1.5 seconds is
`lost`, which is not the same as silent.

### `src/inputs/audio/browserMic.ts`

The source for the browser. It does not open anything itself: the route `POST /api/audio`
hands it what arrives. It turns 16-bit samples into floats, notes gaps from the index, and
is `live` while blocks come.

**The wire.** The body is raw 16-bit little-endian mono samples, about 100 ms per request.
The rate and the index are in the headers `x-rate` and `x-index`, so the body can stay
raw. At 48 kHz that is about 96 KB per second, nothing on the same machine. There is no
WebSocket server (`CLAUDE.md`), and a POST every 100 ms does not need one.

### `src/inputs/audio/features.ts`: sound to onsets (pure)

From blocks to a frame every 10 ms, whatever the sample rate:

- `level`: loudness in dBFS, smoothed over about 50 ms.
- `low`: the strength of onsets in the band of the kick, about 30 to 150 Hz.
- `high`: the same above that, up to about 8 kHz, which is where hats and claps are.

Onset strength is the rise of the log spectrum from one frame to the next, with falls cut
off. Two bands, because house and techno have a kick to count on, but a pattern that drops
the kick must not make the beat disappear.

### `src/inputs/audio/tracker.ts`: heard, bpm, place of the beat (pure)

```ts
export type Heard = 'silent' | 'music' | 'beat';

export interface Hearing {
  heard: Heard;
  /** The tempo it holds. Stays what it was while nothing better is found. */
  bpm: number | undefined;
  /** 0 to 1: how much of the last beats landed on an onset. */
  confidence: number;
  /** A moment on the feed's own clock at which a beat fell, or undefined without a beat. */
  beatAt: number | undefined;
  level: number;
}
```

How it decides, in order. All numbers are the defaults of the settings, and are tuned on
real recordings in step 3, not before:

1. **Tempo.** Every half second, a bank of combs is held against the last 8 seconds of onset
   strength: for every tempo in `bpmMin` to `bpmMax` and every place of the first beat, the
   mean strength where the beats would fall. The best comb gives the tempo and the place of
   the beat. (The plan said autocorrelation. The comb bank does the same job and gives the
   phase with it.) A different tempo replaces the held one only when it has been the same
   for `lockAfter` beats and the held one has lost its support, which keeps a track at 126
   from becoming 63 or 252.
2. **Phase.** The held tempo is looked for again every half second, and the held beat moves
   gently towards what is found. That is a phase-locked loop at two updates a second.
3. **Beat or not.** How far the best comb stands out from all the combs tried, in standard
   deviations. A new tempo needs 7.5 to be taken, a held one keeps `beat` above 5.5 and
   fades below 4.5. It leaves `beat` only after `beatLostAfter` beats of not standing out,
   so a single missed kick does not end it. (The plan counted the share of predicted beats
   that found an onset. That fails in dense techno, where no single beat stands out and
   only the sum over many does. For the same reason what falls halfway between two beats
   is not held against a comb: dense techno has its bass there, and a 3-against-4 pattern
   then wins, which took 155 bpm for 103.) `confidence` is the same number: (z - 3) / 5
   between 0 and 1.
4. **Silence.** Loudness is judged against the music itself, not against a fixed floor.
   `silent` is entered when the level has been `silenceDrop` dB below the recent loud
   level (the 90th percentile of the last minute) for `silenceAfter`, or is below
   `silenceFloor` outright. It is left when the level rises `wakeRise` dB above what it
   was in the silence, judged on a 0.3 s peak hold so that sparse kicks wake it.

I said in conversation that the silence level could be "the noise floor plus a margin".
That is wrong for a room: a quiet breakdown lies close to the lowest level seen in the last
minutes and would be called silence. The drop from the music is what tells a stop from a
quiet passage.

### `src/inputs/audio/follower.ts`: the settings applied to the tempo

It takes the source, runs the features and the tracker, and moves the tempo. It keeps one
offset to turn the feed's clock into `Tempo.now`: the smallest difference between arrival
and position over the last 30 seconds. Delays only add, so the smallest is the true one,
and it also follows the small difference in speed between the clock of the sound card and
the clock of the computer.

| Heard | `onSilence` / `onNoBeat` | What the follower does |
|---|---|---|
| `beat` | | `follow({ bpm, beatAt, running: true })`; phase corrected smoothly, or at once when `phase` is `snap` |
| `music` | `onNoBeat: hold` (default) | Nothing. The clock runs on at the held bpm and phase |
| `music` | `onNoBeat: stop` | `follow({ running: false })` |
| `silent` | `onSilence: stop` (default) | `follow({ running: false })`: the effects go idle |
| `silent` | `onSilence: hold` | Nothing |
| from `silent` back to `music` or `beat` | | `follow({ running: true })` as soon as sound has been there for half a second, at the held bpm |
| feed `lost` | | Not silence. Nothing changes and a notice says the feed is gone. The tempo runs on at its last bpm, which is as safe as By hand |

### `src/inputs/audio/settings.ts`

| Setting | Default | |
|---|---|---|
| `onSilence` | `stop` | `stop` or `hold`. Jeroen's default |
| `onNoBeat` | `hold` | `hold` or `stop`. Jeroen's default |
| `silenceAfter` | 2 s | How long quiet lasts before it is silence |
| `silenceDrop` | 20 dB | Below the recent loud level |
| `silenceFloor` | -70 dBFS | Below this it is silence whatever came before |
| `wakeRise` | 15 dB | How far above the silence counts as sound again |
| `beatLostAfter` | 8 beats | Below 0.35 for this long ends `beat` |
| `lockAfter` | 8 beats | A different tempo must hold this long to replace the held one |
| `bpmRange` | 80 to 180 | Inside 60 to 200, so that half and double time are not found |
| `phase` | `smooth` | Or `snap` |
| `latencyMs` | 0 | Added to the place of the beat, to be set by ear |

Settings are validated like any change: a wrong one throws a `PatchError` and nothing is
applied.

### `src/cli/beat-eval.ts`: `pnpm beat-eval <file>`

Decodes a file with ffmpeg (installed here), feeds it through the same follower as a
source, and prints a line per second: time, heard, bpm, confidence, level. With
`--tempo 126` it says how far off the bpm was. It is how the tracker is tuned on tracks
Jeroen owns, breakdowns included, without a microphone or a fixture.

### The page: `public/listen.html`, `listen.js`, `listen.css`, `mic-worklet.js`

What it does:

- One key, **Start listening**. A browser starts sound only after a press, so after every
  load of the page it has to be pressed once.
- It asks for the microphone with echo cancellation, noise suppression and automatic gain
  control **off**. They are made for speech and flatten music.
- An audio worklet (`mic-worklet.js`) turns the input into mono and hands blocks to the
  page, which posts them one after the other. When the server is slow it drops the oldest
  block; the jump in the index tells the server.
- It shows a level meter, the input device (chosen from `enumerateDevices`, remembered in
  `localStorage`) and what lightdeck hears.
- A microphone is only given to `localhost` or https. On `http://192.168.x.x`, which is
  how the tablet reaches lightdeck, the browser refuses it, so the page checks
  `isSecureContext` and says: "Open this page on the lightdeck laptop, as
  localhost:8080/listen."
- Its feed does not stop when the page is hidden. The shell drops its event stream then
  (`shell.js:616`) because of the six connections a browser has; the feed is one
  connection that posts and is not part of that.
- It is styled as the rest of the console. It starts the shell with
  `start({ page: 'listen' })`, so the blackout and the status bar are there.

## How it behaves

| Situation | What happens |
|---|---|
| By hand | As today. The microphone is not used and the listen page can be closed |
| Auto, music with a beat | The bpm and the place of the beat follow it. The line says "Beat 126" |
| Auto, the beat goes and music stays | The bpm is held and the clock runs on. The effects keep going. "Music, no beat" |
| The beat comes back | The phase moves smoothly to it; a new bpm is taken after `lockAfter` beats |
| The music stops | After `silenceAfter` the tempo stops running and every effect is idle. The fixtures show what is set under the effect. "Silent" |
| The music starts again | The effects run again after half a second of sound, at the held bpm, and the beat follows once it is found |
| A new track at another bpm | Followed after `lockAfter` beats of the new tempo |
| The listen page is closed, or the feed stops | Not read as silence. The tempo runs on at its last bpm and an alarm notice says: "The microphone page is not sending. Open localhost:8080/listen on the laptop and press Start listening." It recovers by itself when blocks arrive |
| The microphone is refused, or the page is opened from the tablet | The page says what to do. Nothing else changes |
| A tap in Auto | Beat one is set. The bpm and Auto stay |
| The slider or nudge in Auto | Back to By hand with the bpm that was set |
| The blackout | Unchanged and always first. What is heard goes on |
| The laser while the tempo is not running | Neither opened nor closed by the idle effect. It shows what it is set to |
| Lightdeck restarts | By hand at 126, unless started with `--tempo audio` |
| Operator walks past the tablet | The state is one line and two keys: it shows what is heard and whether Auto is on, and one press takes it away |

## What was built

Everything of the plan exists except what "Open" and "Left out" say. What differs, and why:

| Plan | Built | Why |
|---|---|---|
| `AudioBlock` has samples, rate and position | It has a `feed` number too | A reloaded listen page starts a new feed whose positions begin at 0, and the analysis has to start over. `BrowserMicSource` numbers the feeds |
| `Hearing` and `Heard` in `tracker.ts` | They are in `hearing.ts` | The follower, the tracker and the hearer all need them |
| `bpmRange` | `bpmMin` and `bpmMax` | Two flat numbers are simpler to send and to show as sliders |
| A `hearer.ts` was not in the plan | `hearer.ts` joins the features and the tracker, starts over for a new feed, and fills a short gap with silence | The follower should not know about either |
| In By hand "the microphone is not used" | The hearer runs whenever sound comes; only the tempo's source decides whether the tempo moves. In By hand the line says "Hears: ..." | A switch to Auto then finds the tempo at once, not after ten seconds of listening |
| A lost feed: "the tempo runs on at its last bpm" | The same, and a tempo that was idle because of silence runs again | Idle lights because a tab was closed are worse than lights at the last tempo |
| The idle gate in `showing()` of the laser | It is in `outputValues()` of the laser and in `renderEffect()` of the spider | The ticker of the laser stops when `showing()` is empty and only starts again on a change of state, so an effect that went idle would never have come back |
| Settings from flags first | Settings are changed on the listen page. Only `--tempo` and `--audio-record` are flags. Settings are not kept: they start at the defaults every time | Tuning is done while real music plays, and a page is quicker for that |
| `--audio-record` writes a WAV per feed | It also puts the true size in the header every second and ends the file when the feed is lost | A file that is only valid after lightdeck stops cannot be played while it grows |
| A body over the limit resets the connection | It is read and thrown away, then answered with 400 | The listen page then sees what is wrong instead of a network error |
| Links to the pages | A Listen link next to the Deck and the fixtures | |
| `.notices` and `.field` lived in `deck.css` | They are in `styles.css`; `sentence` moved to `ui.js` | The listen page needs the same |

### Verified

| Level | What |
|---|---|
| Tests | `pnpm check` |
| Headless Chrome with a fake microphone (a WAV played into `getUserMedia`) and the stand-in bridge | The listen page starts and stops the microphone, posts the sound, and the recording on the server is the sound that was played (same peak and loudness, kicks 0.4762 s apart, which is 126 bpm). A scripted room of drums, then a melody without beat, then room noise: with Auto on, lightdeck settled on 139.9 bpm for 140 bpm drums, went to "music, no beat" with the bpm held, then to "silent" with `running` false, and never read silence as a lost feed |
| The same, at the bytes of the spider | With a chase on the spider, the lit lens walks on the beat; during silence every cell is what is set under the effect; with drums again the chase comes back by itself and was chosen the whole time |
| Headless Chrome, the page | The By hand and Auto keys, the line that says what is heard, tap and nudge and slider in Auto, the notice when no microphone page sends, the settings (a slider after it settles, a key at once, a refused value snapping back), the deck and a fixture page after the changes, at 1280 by 800 and 800 by 1280 |

| The tracker on real tracks (the fork's work, with `pnpm beat-eval`) | Seven tracks from `~/Downloads` with BPM tags (126, 147, 124, 124, 155, 129, 144) sit at the tag for 97 to 99% of their length, and every stretch labelled `beat` was at the right tempo. Synthetic click tracks from 90 to 170 bpm at 16 and 48 kHz: bpm within 0.1 and the beat within 3 ms, locked after 5 to 6.5 s. Melody and noise (30 runs of 150 s): a false lock in 2 runs, about 41 s of `beat` in 4500 s. About 1% of a core at 48 kHz. Nothing of those tracks is kept in the repository |
| An abrupt stop with room noise after it | `silent` two seconds after the music stops, while `beat` was still held |

### What the tracker does that may surprise

- **Locking takes about 9 s** from the first sound of a track.
- **Leaving `beat` is slow:** about 11 to 12 s after the kicks stop it says "music, no beat".
  The default `onNoBeat: hold` makes that invisible, since the tempo runs on either way.
  With `onNoBeat: stop` the effects go idle that much later. Silence does not wait for it.
- **A quiet noisy room from the start of a feed reads as `music`, never `silent`,** until
  music has played, because silence is judged against the music's own level. Auto then
  keeps the tempo at the bpm it has. After the first track a stop is heard.
- **A change of tempo lags:** a ramp of 10 bpm over 40 s was followed about 1.6 bpm behind,
  and a step from 126 to 132 after about 10 s. Both were tried on synthetic sound only.

### Not verified

- A real microphone in a real room with music, and whether the browser keeps its sound
  processing off for it. The page tells when it does not.
- A listen window behind another window or minimised, and a laptop on battery or going to
  sleep. The page asks the browser to keep the screen on.
- The tracker through a microphone: the real tracks were clean files. Breakdowns and
  changes of track in a room. Every number in the settings was tuned on those files and on
  synthetic sound.
- Latency: there is no right default.
- The tablet, and the real fixtures.

## Order of building

The risk is not the algorithm but the path: whether a browser microphone, with the tab
where it is, hears a room full of music well enough and keeps hearing it. So that comes
first, and the recording it gives is what the tracker is tuned on.

| Step | What | Done when |
|---|---|---|
| 1 | The microphone path alone: `/listen`, `POST /api/audio`, `BrowserMicSource`, and `--audio-record <dir>`, which writes the feed to a WAV file | Ten minutes of music from the speakers, heard by the laptop's own microphone, play back clean and without pumping, so the processing is really off. Blocks arrive ten per second and no more than one gap per minute with the window in front. The same is written down for the window behind another one, for a minimised one and for the laptop on battery |
| 2 | The refactor: `source` and `running` in the tempo, the idle gate in both controllers, the shell stops the beat when not running. Committed by itself | `pnpm check` passes, By hand behaves as before, and a test shows the spider effect stop within 25 ms of `running: false` and the laser neither opened nor closed |
| 3 | `features.ts`, `tracker.ts` and `beat-eval` | On synthetic click tracks of 90 to 170 bpm the bpm is within 1 bpm and the beat within 30 ms after 10 seconds. A melody without a beat gives `music` and keeps the bpm. A stop gives `silent` within `silenceAfter` plus half a second. On the recordings of step 1 there is a table of what it said per section next to what Jeroen hears, and he says whether it is right |
| 4 | The follower, the keys and the line in the tempo panel, the notices | In the room, with music from the speakers, the bpm settles within 15 seconds and follows a change of 4 bpm. A stop makes the effects idle and the music coming back makes them run. A breakdown holds the bpm |
| 5 | Settings: the flags, and a place on the listen page to change them. Latency by ear | The beat lamps and a visible effect sit on the beat to Jeroen's eye with `latencyMs` set |
| 6 | A rehearsal on the real fixtures with real music | Jeroen says it follows well enough to leave on |

Steps 2 to 4 can be checked without the phone and the fixtures. Step 1 needs the real
microphone, and 6 the real lights; each is marked as such in this document when done.

## Tests

| File | What |
|---|---|
| `tempo.test.ts` | The new state, `follow` keeps the bar and wraps the phase, `running`, a manual source is not touched by `follow` |
| `spiderController.test.ts`, `laserController.test.ts` | An effect is idle while not running and comes back; the laser's mode channel is not changed by it |
| `features.test.ts` | The level of a sine, an onset of a click, the same result at 16, 44.1 and 48 kHz |
| `tracker.test.ts` | Click tracks, a tempo ramp, half and double time, melody only, silence, silence then music, a quiet breakdown that is not silence |
| `follower.test.ts` | Every row of the table above, a lost feed that is not silence, the clock offset with jitter on the arrival times |
| `browserMic.test.ts` | Bytes to blocks, a gap, `lost` after 1.5 s |
| `http.test.ts` | `POST /api/audio` accepted, too large, no rate; the state has `audio`, `source` and `running` |

The page is checked by hand. Test sound is made in the tests; no music is committed.

## Open

1. **Bar one after a silence.** (Still open.) After a stop a track usually starts at bar one, but the
   beat is only found some beats later, and nothing says whether that is a bar line.
   Proposal: no automatic bar one. The tap stays "this is beat one", as it is now.
2. **Where the settings live.** Built as a place on the listen page, and not kept: they
   start at the defaults every time. Proposal: keep them in the show file once the numbers
   have been tuned and Jeroen wants them to stay. That means a new `audio:` section, and
   `readShow` rejects keys it does not know (`show.ts:258`), so `show.ts` and `file.ts`
   change.
3. **A fade when the effects go idle.** Proposal: none. They stop at once, because there
   are no crossfades yet. It comes with them.
4. **The slider and the nudge in Auto go back to By hand.** Proposal, because the last
   press wins and a bpm set while the listening overwrites it a second later would snap
   back under the finger.
5. **A lost feed holds the bpm and keeps running.** Proposal, because the tab is closed
   by accident more often than the music stops, and idle lights during a party are worse
   than lights at the last tempo.
6. **A press after every load of the listen page.** The browser decides this. Built that
   way: the key says Start listening, and the notice on every page says so when Auto is on
   and nothing is sending.
7. **A hidden window may be throttled.** Step 1 finds out. If it is a problem, the answer
   is to keep the listen window visible on the laptop, or to use another source. That is
   what the module is for.

## Left out on purpose

- **Finding bar one** from the audio.
- **Any source other than the browser microphone.** PipeWire's `pw-record` or `parec`
  (both installed here) and a line-in from the mixer would each be one more `AudioSource`.
- **The microphone of the tablet.** A browser only gives a microphone to `localhost` or
  https, and the tablet reaches lightdeck over the network.
- **Beat libraries.** aubio is GPL-3 and Essentia AGPL-3, and lightdeck is Apache-2.0. A
  Python tracker such as madmom or BeatNet would follow breakdowns better, and is
  an upgrade only if the tracker here fails on his tracks; none of it is installed.
- **Keeping the sound.** The feed is analysed and thrown away. Only the recording option
  of step 1 writes a file, and only where it is told to.
- **A login on `POST /api/audio`.** Lightdeck has none anywhere, it is for the home
  network. Someone on that network could feed it sound.
- **Switching Auto on or off by itself.** It is a press.
