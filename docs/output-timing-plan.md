# Plan: the output path, on the beat and only when something changes

Status: built on 2026-10-07, except the fail-safe, which is not decided. The lightdeck side
has run against a stand-in bridge. The phone side builds and has not run on the phone. See
"What was built". Written 2026-10-06; decisions marked "Jeroen" were made by him on that
date or the next; the rest is a proposal. The measurements were made on the laptop with the
real rig code against a stand-in bridge. Nothing was measured on the phone, the LR512 or a
fixture.

## What it is for

The lights land on the beat, and land the same way on every beat. The LR512 gets the
frames it needs and no more, because nobody knows how many it can take. And lightdeck
notices when the phone has stopped listening.

Today a change reaches the bridge 3 to 41 ms after the beat, with 25 ms of jitter, and the
phone adds up to 25 ms more. The LR512 gets 40 frames per second, whether they differ or
not. If the connection to the phone dies without a word, the console says "connected" and
the lights stay as they were.

## Terms

| Term | Meaning here |
|---|---|
| Polling | Waking up on a timer to ask whether something changed. A change then waits for the next wake-up, which is latency and jitter |
| Sampling | Evaluating a function of time at a rate, because it has no moment of change: a decay, a wave. A clock, not polling, and needed |
| Push (streaming) | The one who has the change hands it on at once, as a message or a wake-up |
| Heartbeat | A small message at intervals, so the other side can tell quiet from gone. Needed wherever a sender may go quiet |
| Stepped effect | Changes only on beats: the chase, bounce, and on the laser patterns, colours and twist |
| Continuous effect | Changes all the time: seven of the ten spider effects, and the laser's pulse and sweep |
| Grid | The beats of the tempo, and the points between them at which a frame is made |
| Lead | Milliseconds by which a frame is made ahead of the beat, to make up for the time the path takes |

## Decisions

1. **Only frames that changed are sent** (Jeroen, 2026-10-06). My reading: a frame equal to
   the one before is not sent to make an animation. A slow repeat of the last frame stays,
   for the device and for knowing the other side is alive, see "Open".
2. **Optimise for performance where possible** (Jeroen, 2026-10-06). The thing to protect
   is the LR512: its capacity is not known.
3. **Push instead of polling where possible** (Jeroen, 2026-10-06).
4. **The bridge is part of this** (Jeroen, 2026-10-06): what it receives, and what it sends
   on to the device.
5. **The effects run entirely on the server** (Jeroen, 2026-10-06). They already do: a page
   only draws the bytes it is sent.
6. **Nothing is built before he says so** (Jeroen, 2026-10-06). On 2026-10-07 he said to
   build the rest of the plan.
7. **The frame rate is capped at 25 per second, as the original app does, and the cap is
   configurable** (Jeroen, 2026-10-07). He did not want to measure the rig first, so the
   rate is the proven one. The lead stays at 0 for the same reason.

Decided earlier and still true, see `CLAUDE.md`: an effect is a pure function of the beat,
at speed 1 it changes once per beat at most, and it is limited by `limitSpeed`; an effect
never opens the laser; only universe index 0 of the LR512 has channels; the bridge holds
the last frame when lightdeck goes away (whether that stays is open, below).

## What was found

Measured, with the real rig, tempo and controllers and real timers, 30 s per run:

| What | Result |
|---|---|
| Frame cadence of a controller | 25.1 ms with a spread of 0.5 ms, 39.9 per second |
| A beat to the first frame that shows it, at the controller | 0 to 25 ms, mean 12 |
| The same at the bridge, through the real client, in another process | 3 to 41 ms, mean 15 to 22 depending on the run |
| What the client and the socket add | mean 5.5 ms, at most 13 |
| The first frame of a kick flash | 89% of full on average, 78% at worst. In 10 to 56% of beats under 90%, depending on where the timer happens to lie against the beat |
| Frames that equal the one before | chase, bounce 95%; build 72%; sparkle, burst 16 to 28%; kick, swap, wave, spectrum, scissor none; laser patterns, colours, twist 95 to 99%; laser pulse, sweep none |
| Channels that change in a frame | 6 to 19 of 43 on the spider, exactly 1 on the laser |
| CPU of a tick | 36 µs, of which the effect is 0.9 µs. 0.14% of a core at 40 per second |
| The listening running on the same event loop | +1.5% CPU, the cadence unchanged, worst delay of the loop 10 ms against 3 ms. In 150-second runs of the new engine the worst delay was 8 to 31 ms against 4.6 ms without the listening, and the longest garbage collection 2 ms. The listening does stall the loop now and then; it has not moved a beat (see "A flash held back by the cap") |
| Simulation, effects rendered for exact grid points | first frame within ±3 ms of the beat, kick flash 255 of 255 on every beat but one in 60. That one was not a late timer: see "What was built" |

Read in the code, not run:

- **The original Light Rider app sends every universe every 40 ms, changed or not**
  (`z2/c.java`, `f9934e = 40`). 25 per second is the rate this device is known to take.
  Lightdeck sends up to 40 per second and has not been tried above what the original does.
- **The vendor `sendDmx` does not throttle, compare or wait for an answer.** It builds one
  encrypted UDP datagram with a sequence number and sends it, and closes the device only on
  a network error. Whatever it is given goes out, so the only protection the LR512 has is
  what lightdeck and the bridge choose to send.
- **The phone has a third 25 ms timer.** `BridgeServer.java:52` and `:181`: the pump sleeps
  until the next 25 ms, and every frame that arrived counts as changed, whatever is in it.
  Every one of them costs 512 JNI calls and one datagram. The vendor buffer also has a
  bulk `copyBuffer(int[])` and an `isEqual`; whether they fit is for the Java work.
- **A DMX frame of 512 channels takes about 23 ms on the wire**, so a fixture cannot show
  more than about 44 frames per second whatever is sent.
- The library names an ESP82xx Wi-Fi module for this device (`XHL_WifiEsp82xx`). That is
  inferred from names, not read off the hardware, but a small module decrypting every frame
  is the reason to be careful.

## What was built

Everything of "What has to be refactored" and "New parts" exists, except the fail-safe and
what the plan says about the stand-in beyond the heartbeat. What differs from the plan, and
why:

| Plan | Built | Why |
|---|---|---|
| The engine calls `flush` after a render | The client looks at its universes at the end of the turn of the event loop (`setImmediate`), so there is no `flush` option on the engine | Several fixtures render in one tick. This sends them as one frame without the engine knowing the client, and it works for a change that comes from a press as well. `flush()` is left for the shutdown, which sends past the cap |
| `N = max(1, round(B / gap))` points per beat | `floor`, never `round` | The cap is a cap. At 200 bpm `round` would have sent 6.7% over it |
| A tick, and a frame on a change | A tap, `running` coming back and `running` going false each also make a frame at once, and a grid point that was just rendered is not made again | A tap makes this moment beat one, and waiting up to 43 ms for the next point was slower than the timer it replaced |
| One tempo clock | `Tempo.beatAt` rounds to a billionth of a beat | See below |
| The lead | `Tempo.leadMs` and `outputBeat`, set by `--lead-ms` or `POST /api/output`, and not kept | The same as the settings of the listening |
| Settings | `--max-fps` and `--lead-ms`, `POST /api/output`, and an `output` event. No page for them yet | The plan said flags and the API. A key on the deck would be the next thing |
| `Animated` has `wantsFrames`, `render` | It also emits `wants`, and a closed controller stops wanting frames | The engine has to be told when an effect is chosen, and must not drive a controller that was closed |
| The frame event after a render | Every frame that is made is told to the browsers, with the beat of its grid point, and it is the frame that was sent. The old 50 ms gate is gone | The grid already is at most 25 per second |
| `alive` and `limits` | As in the plan. The bridge also closes a connection from a new client that has been silent for six seconds, so the client's keep-alive starts when it connects and says its limits again while it has no frame to repeat | Its accept loop serves one client at a time, so a half-open connection would keep lightdeck out after it had found the silence. The fail-safe is not part of this: nothing changes in what the device is sent |
| A step that keeps its lens | The effect beat is the beat times the speed plus a whole number | The place within a step has to jump when the speed changes, but the steps stay on the grid of the beat, which a fraction would not keep |

### The late frame that was not a late timer

In the simulation one beat in 60 lost its first frame, and in the first live runs at 170 bpm
13% of the flashes came out at 144 of 255, exactly one grid step late. The engine said it had
skipped nothing and no timer had run late. The frame at the beat was made on time, for a beat
position of 12.999999999999998: a point of the grid is worked out as a moment, and turning the
moment back into a beat is not exact. A flash on beat 13 then showed the end of beat 12. The
beat is now rounded to a billionth (less than a nanosecond), there is a test for the whole
range of tempos and origins, and a test through the controller that the flash is at full level
on every beat at seven tempos. Without the rounding the second one fails.

### A flash held back by the cap

In 150-second runs with the listening on, one flash in 321 showed 48 to 52 ms late, and the
first reading was a stall of the event loop. It was not. It was the first flash of every run,
and the frames show why: the controller handed it over on the beat, and the client sent it
47 ms later, with the received frames at 0, 40, 80 and 121 ms. The harness had sent the update
that chooses the effect a few milliseconds before, and the client holds a frame until 40 ms
after the last send, so the flash waited for the rest of the gap and the frame after it was
sent in its place. Without the listening the first flash did not happen to fall in that gap,
and the worst beat was 2.1 ms late.

That is what the cap does, and it costs once after a press: an operator who changes something
within 40 ms before a beat gets that one beat up to 40 ms late and its first frame replaced by
the next one. Nothing in a steady show has it, because the grid is 42 ms apart. If it ever shows
on the real fixtures, the way out is a short grace on the gap (a frame may go when it is 36 ms
after the last one) and not a faster cap.

### Verified

| Level | What |
|---|---|
| Tests | `pnpm check` |
| Against the stand-in bridge, with the whole of lightdeck | A static look sends 1 frame a second, the keep-alive and nothing else. A chase sends only its steps: 21 frames in 10 s, against about 400 before. A wave sends 232 in 10 s, which is the cap, against 400. Lowering the cap through the API arrives at the bridge as a `limits` message and holds (83 in 10 s at 10). A bridge that goes silent is dropped after four seconds and found again when it answers. A bridge that never says `alive` is left alone, and gets the cap again when lightdeck reconnects. Killing the stand-in and bringing it back is handled, as before |
| `pnpm perf`, the kick at the bridge in another process | At 90, 126 and 170 bpm a beat arrives within -2.2 and +1.9 ms of the ideal grid (the median is about 1 ms early), the flash is 255 of 255 on every beat, and the rate is 22.5 to 23.1 a second. The client and the socket add 0.3 ms on average and 1.8 at most. Before: 3 to 41 ms late, the flash at 89% of full on average and under 90% in 10 to 56% of the beats, 39 frames a second |
| Mutations | Without the grid the engine tests fail, without the change test or the cap the client tests fail, without the dead band three tests fail, without the rounding the controller test fails |
| The Java of the bridge | It builds. A test on a desktop JVM with the vendor classes stubbed passes, 28 checks of its own logic |

### Not verified

- **Everything on the phone.** The new Java has not run: not the wake-up, not the change test
  or the cap, not the `alive` message, not the idle close. A sheet for it is in
  `android-bridge/README.md`. It cannot be tried without the phone and the LR512.
- **Whether the LR512 takes 25 a second**, and anything above. It is what the original app does.
- **The lead.** It is 0, so what a beat adds between lightdeck and the light is not made up for.
- **Whether a fixture can tell 25 frames a second from 40.** A wave is sampled at 40 ms steps
  now.
- **The laser at 25 changes of one channel a second** (pulse, sweep).

## Where polling is, and whether it stays

| Where | What it does | Verdict |
|---|---|---|
| Controller tickers, 25 ms: `spiderController.ts:429`, `laserController.ts:339` | Evaluate the effect at the moment the timer runs | Sampling, so it stays, but as one clock locked to the beat. Two free-running timers are what makes the beat land 0 to 25 ms late |
| Client pump, 25 ms: `bridgeClient.ts:157` | Asks every 25 ms whether a universe is dirty | Polling. Becomes push: send when the engine has made a frame, with a minimum spacing |
| Phone pump, 25 ms: `BridgeServer.java:165` | The same on the phone | Polling. Becomes a wake-up when a frame arrives |
| Idle refresh on the phone, 100 ms: `BridgeServer.java:53` | Sends the last frame again | Keep-alive for the device. Stays, probably slower, once it is measured |
| Reconnect backoff: `bridgeClient.ts` | Tries again for a bridge that is not there | Needed. There is nothing to push from something that is away |
| Microphone feed watchdog, 250 ms: `browserMic.ts:63` | Notices that sound stopped coming | Needed: it detects absence |
| Event stream keep-alive, 15 s: `http.ts:238` | Keeps the stream open | Needed |
| Phone supervisor, 500 ms: `BridgeCore.java` | Looks at the device state | Leave |
| Pages: events from the server, a POST per change | | Already push |
| Liveness of the phone, and of lightdeck | Nothing today | New: a heartbeat in both directions. Needed because sending only changes makes silence ambiguous |

So not all polling is bad. The render clock has to exist, because a decay has no moment to
wake up at. What costs is clocks that only ask "is there something?", one after the other.

## What fits as it is

| Part | Why |
|---|---|
| The effects in `src/engine/` | Pure functions of the beat, as they should be |
| `SpiderController` and `LaserController`: state, validation, `update`, `snapshot`, `recall`, the master and the blackout | Only the way a frame is asked for changes |
| `Patch` (`src/outputs/patch.ts`) | It already holds the one frame per universe that goes out, so it is where equal frames can be told |
| The WebSocket to the bridge | It is a stream already. What is wrong is the timers around it |
| The pages and the event stream | Push already. The `frame` event only needs to carry what was sent |
| The reconnect of the client | Built on 2026-10-06 |

## What has to be refactored

### 1. `src/server/tempo.ts`: the grid

Adds what the engine needs to put frames on the grid, and nothing about frames:

```ts
/** The moment, on `now()`, of the beat `beat` (a fraction), at the tempo as it is now. */
timeOfBeat(beat: number): number;
/** The beat at a moment on `now()`. `getBeat()` is this at `now()`. */
beatAt(time: number): number;
```

`beatOrigin` and the bpm already say everything. `follow()` moves the origin slowly, so
whoever schedules from the grid has to ask again after a `tempo` event.

### 2. `spiderController.ts` and `laserController.ts`: no timer of their own

`runTicker`, `tick` and `ticker` (`spiderController.ts:424-443`, `laserController.ts:334-353`)
go. What they keep is the part that renders and encodes:

```ts
interface Animated {
  /** True while an effect needs frames: one is chosen and the tempo runs. */
  wantsFrames(): boolean;
  /** Makes the frame for the moment `at` on the tempo's clock, and hands it to the patch. */
  render(at: number): void;
}
```

`update()` and `recall()` still call `render(now)` themselves, so a press shows at once. The
`frame` event for the pages takes the frame that was just made, instead of rendering and
encoding a second time in `getDmx()` (37 µs, and not exactly what was sent).

### 3. `src/server/rig.ts`: owns the clock

The rig builds the engine next to the tempo (`rig.ts:93`) and the controllers (`:111`) and
adds each controller to it. It also decides how the output is flushed after a render.

### 4. `src/outputs/lr512/bridgeClient.ts`: push, only changes, a cap, a heartbeat

`setInterval(tick)` (`:157`) and the dirty flags of `tick()` (`:177`) go. The client gets:

```ts
interface BridgeClientOptions {
  /** The most frames per second, per universe. Default 25, which is what the original app does. */
  maxFps?: number;
  /** The last frame is sent again after this long without a send. Default 1000. */
  keepAliveMs?: number;
}
```

- `setUniverse` compares with the last frame **sent** (`Buffer.compare`). Equal: nothing.
- A different frame is sent at once if `1000 / maxFps` has passed since the last send, else
  one timer is armed for the end of the gap, and what is sent then is the newest. That is
  push with a leading edge and a trailing edge: a press goes out at once, a fader that is
  dragged goes out at the cap.
- After `keepAliveMs` of silence the current frame is sent again.
- A reconnect sends everything again, as now.

### 5. `android-bridge/.../BridgeServer.java`: one APK, all of it

Built and installed by Jeroen; it can be built here and not run (the bridge skill says so).

- The pump waits on a lock until a frame arrives or the next deadline is due, instead of
  `sleep(25)`. Deadlines: the refresh, the heartbeat, the fail-safe.
- A frame equal to the last one sent is not sent again, except as the refresh.
- A minimum spacing per universe, so no sender can overload the device whatever it does.
  `tools/lr512-send.mjs` today sends 40 per second whether it changed or not.
- `copyBuffer(int[])` or only the changed channels instead of 512 `setValue` calls, after
  reading what `copyBuffer` does.
- Says it is alive: a message at intervals, with the device state. And counts what arrives.
- Optional, and Jeroen's to decide: the fail-safe, see "Open".

### 6. `src/engine/`: an effect clock

A pure helper that gives an effect its beat from the beat of the tempo, the speed and an
offset, and keeps it continuous when the speed changes:

```ts
effectBeat = offset + beat * speed
// on a change of the speed: offset = oldEffectBeat - beat * newSpeed
```

`limitSpeed` gets a dead band: it goes down at once above the limit and comes up again only
when the tempo is 3% under it. The two together mean that pressing ×2 no longer moves the
chase to another lens, and a track at 150 bpm with ×4 does not flap between ×4 and ×2.

### 7. The stand-in bridge, `CLAUDE.md`, `http.ts`

The stand-in in the skill `verify-without-hardware` learns the heartbeat and counts frames.
`CLAUDE.md` gets the layout and the facts above.

### Not touched

The effects themselves, `playback.ts`, `src/show/`, the pages, the fixture profiles and the
audio. `tools/lr512-send.mjs` stays as it is: it sends 40 per second whether the frame
changed or not, which makes it a good way to try the cap of the bridge.

## New parts

### `src/server/engine.ts`: the one clock

```ts
export interface EngineOptions {
  tempo: Tempo;
  /** The most frames per second. The grid is made of whole divisions of a beat nearest to it. */
  maxFps?: number;
  /** Called after every render, so that what was made goes out at once. */
  flush: () => void;
}
export class Engine {
  add(animated: Animated): void;
  remove(animated: Animated): void;
  close(): void;
}
```

Rules:

- **No timer while nothing animates.** It runs while some controller `wantsFrames()`. A
  static look costs nothing, as today.
- **A tick lies on the grid.** With a beat of `B` ms the grid has `N = max(1, round(B /
  (1000 / maxFps)))` points per beat, so 12 at 126 bpm and 25 fps. Every beat boundary is a
  grid point, so the first frame of a beat is made for the beat and not a few ms after it.
- **Absolute time, no drift.** The next tick is `timeOfBeat(k / N)` for the next whole `k`,
  armed with `setTimeout(target - now - 1)`. A timer that runs up to 3 ms early or late
  does not move the next one. What is rendered is the grid point, not the moment the timer
  ran.
- **A `tempo` event re-anchors** the next point. This is what keeps the beat steady while
  Auto slides the origin, and when the bpm changes.
- **The lead** (below) is added when a frame is made: it is made for `target + lead`.
- It measures itself: how late each timer ran, and how many ticks were skipped. A skipped
  grid point is the one outlier of the simulation, and it should be seen, not guessed.

### The heartbeat and the fail-safe, on the wire

Additions only, so that the old APK still works:

| Direction | Message | |
|---|---|---|
| bridge to lightdeck | `{"type":"alive","device":"open","frames":N}` every second | Lightdeck takes the connection for dead after four seconds without any message. It starts doing so only after it has seen the first `alive`, so the old APK is left alone |
| lightdeck to bridge | The frames and the keep-alive are the sign of life | The bridge counts four seconds without anything from lightdeck |
| lightdeck to bridge | `{"type":"failsafe","universe":0,"frame":"<base64, 512 bytes>"}` | What the bridge plays after that silence. Lightdeck sends it whenever its picture changes. The bridge stays fixture-agnostic: it does not know what a laser is |

## How it behaves

| Situation | What happens |
|---|---|
| A static look | Nothing animates, no clock runs. One frame goes out when it changes, then the keep-alive, once a second |
| A stepped effect | The clock runs at the grid. Only a frame that differs goes out: about 2 per second |
| A continuous effect | The same, and nearly every frame differs, so about 25 per second. The cap is what protects the device |
| A fader dragged by hand | The first change goes out at once, then at the cap, always the newest |
| The tempo changes, a tap, Auto sliding the beat | The next point is asked for again. No frame is lost and none doubled |
| `running` is false (the music stopped) | Effects want no frames, the clock stops, the keep-alive goes on |
| The speed is pressed | The effect goes on from the lens it is on |
| The bridge is slow | Frames are held back by the cap, always the newest, as today |
| The phone's Wi-Fi drops without a close | Four seconds without an `alive`: the console says so, and reconnects |
| Lightdeck crashes with the laser on | Today the bridge holds the last frame. With the fail-safe (if Jeroen wants it) it plays the registered one after four seconds |
| The old APK | Everything on the lightdeck side works. There is no heartbeat, so no detection of a silent drop, and the cap is only the client's |
| The device is behind on frames | The cap and the change test are the only brakes, so the cap is set from what was measured |

## Order by impact, and why

Two kinds of impact: what you can see and hear, and what keeps the show from going wrong.

| # | What | Why here | Effort | Phone |
|---|---|---|---|---|
| 0 | Measure the real rig | Every number below (the lead, the cap, the refresh) can only come from it. It costs an evening and needs no code | none | no |
| 1 | The engine clock and the send policy (1 to 4) | The most you can get without the phone. The beat lands within ±3 ms instead of 0 to 25, every kick flash is full, the device gets about 2 frames a second for stepped effects and 25 instead of 40 for the rest | medium | no |
| 2 | The lead | Takes out the part of the delay that is the same every time. Probably the largest single thing you can hear, and a few lines once the clock is on the grid. Worth as much as the measurement behind it | small | no |
| 3 | The phone side, as one APK (5) | Takes another 12 ms off the mean and 25 off the worst, protects the device from any sender, finds a silent drop. One build and one installation for all of it | medium | yes |
| 4 | The effect clock and the dead band (6) | A glitch on a key press, and a flap near 150 bpm. Small, and it touches the same call as 1, so it is done in the same pass | small | no |
| 5 | The small things | A frame event that is the frame that was sent | small | no |

After 1 and 3 the stages between the beat and the device wait about 3 ms instead of a mean
of about 30 and a worst of about 63 that was seen. The controller and the client were
measured; the phone's part is read from the code.

## Order of building

The risk first: the numbers that decide the rest. Each step ends with something that can be
seen or measured.

| Step | What | Done when |
|---|---|---|
| 0 | The experiments below on the real rig | The numbers are written in this document: the latency by eye and by video, the highest rate without a failure, how long the device holds a look without refresh, whether the connection needs traffic |
| 1 | The grid helpers in the tempo, the engine, the controllers without a timer, the effect clock, the dead band. Committed by itself | The harness (kept as `tools/perf`) shows, over five minutes at 90, 126 and 170 bpm, the first frame of every beat within ±3 ms and a kick flash of 255 on every beat, no skipped grid points, no timer while nothing animates, `pnpm check` |
| 2 | The client: push, the change test, the cap, the keep-alive, replay | At the bridge, a chase gives at most 3 frames a second and a wave at most the cap. A static look gives only the keep-alive. A fader drag stays under the cap and its last value always arrives. A reconnect sends everything. Against the stand-in |
| 3 | The lead | Jeroen says that with the lead from step 0 set the lights sit on the beat, on the real fixtures |
| 4 | The APK: the wake-up, the change test, the spacing, the alive message, the fail-safe if wanted | It builds. On the phone the log shows frames sent only on change, and the heartbeat. A drop of the phone's Wi-Fi is found within five seconds. Jeroen has run it |
| 5 | The small things | `pnpm check` |

### Experiments for step 0

On the real rig, with the phone on screen. The tools that exist send 40 per second only, so
`tools/lr512-load.mjs` is needed first: a rate, a pattern that differs every frame, and a
duration.

```
1. Latency by eye and ear. Spider, effect Kick, 120 bpm. Play a click at 120 bpm
   from the laptop and tap the tempo on the first click. Is the light      early / on / late
   Raise or lower the lead until it sits on the click. The value is        ___ ms
   Check it once with a phone filming at 240 frames per second:             ___ ms
2. Rate. The load tool at 10, 25, 40 and 60 frames per second, a minute each,
   with a pattern that changes every frame. Bridge log, per 10 s: sent / failed
   10 fps ___   25 fps ___   40 fps ___   60 fps ___    Any stutter on the fixture?
3. Hold. Set a look, then stop the bridge app on the phone. Does the fixture
   keep the look after 5 s / 30 s / 5 min?                                 yes / no
4. Quiet. With the refresh on the phone set to 1 s, then 5 s, then none (a test
   build): does the look hold, and does the first frame after a minute arrive?
```

## Tests

| File | What |
|---|---|
| `tempo.test.ts` | `timeOfBeat` and `beatAt` agree with `getBeat`, also after a bpm change and a `follow()` |
| `engine.test.ts` | Ticks lie on the grid with a fake clock and at several tempos; a tempo change moves the next point; no timer while nothing wants frames; a late timer does not move the next tick; a skipped point is counted |
| `spiderController.test.ts`, `laserController.test.ts` | No timer of their own; `render(at)` for a given moment gives the same bytes as before; the frame event carries what was sent |
| `bridgeClient.test.ts` | An equal frame is not sent; the first change goes at once; a burst gives the newest at the cap; the keep-alive; a reconnect sends all; no `alive` for four seconds ends the connection only after the first `alive` was seen; the old APK is left alone |
| `effectClock.test.ts` | A change of speed keeps the effect beat continuous; the dead band does not flap at 150 bpm |
| A harness in `tools/perf` | What was measured above, so that a change that costs timing is seen |

## Open

1. **The frame rate.** Decided: 25 per second, configurable (Jeroen, 2026-10-07). Does a wave
   at 40 ms steps look smooth on the fixtures? That is for the first time it is run on them.
2. **The refresh.** Built as proposed: the keep-alive of lightdeck at one second, and the
   refresh of the phone at 100 ms, which stays until it is known that the device holds its
   output.
3. **What the bridge does when lightdeck is silent** (a safety decision, so Jeroen's).
   Proposal: after four seconds it plays the fail-safe frame that lightdeck registered,
   which has the laser closed and everything else as it was. Today a crashed lightdeck
   leaves the laser on as it was. Without the fail-safe it stays as today.
4. **The lead: one for the console, or one per fixture.** One number is built, and it is 0.
   The laser's mirrors may need another than the spider's lenses.
5. **Where the settings are** (the cap, the lead). Built as proposed: flags and the API,
   changeable while rehearsing and not kept. A key on the deck is the next step if he wants
   to set the lead by eye at a rehearsal.
6. **Telling an equal frame by the effect or by the bytes.** Proposal: by the bytes. The
   effect does not have to say whether it is stepped, and a frame that happens to repeat in
   a decay is not sent either.
7. **The laser at 25 or 40 changes of a single channel per second** (pulse, sweep). Whether
   its mirrors follow is an assumption that was already listed. Proposal: look at it in
   step 3, and if it matters, give the laser a lower rate of its own.
8. **The late timer.** Explained: it was a rounding error at the beat, see "What was built".

## Left out on purpose

- **Frames with only the channels that changed.** The vendor sends a whole universe whatever
  we send it, so the device sees no difference. Only the phone's JNI calls would shrink,
  and `copyBuffer` does that.
- **Talking to the LR512 without the phone.** It stays closed and encrypted, see
  `CLAUDE.md`.
- **Rendering on the phone.** The effects stay on the server.
- **The audio analysis in another thread.** It adds 1.5% of a core and no beat was moved by it in 150-second runs, but it does stall the loop for up to 31 ms now and then (a single block of it costs 6 ms at most, so the rest is the post that carries the sound). A worker would be the answer if a beat is ever seen late for it.
- **A faster tick than the cap.** A fixture cannot show more than about 44 frames a second.
