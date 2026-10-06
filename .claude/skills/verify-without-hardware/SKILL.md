---
name: verify-without-hardware
description: Run and check lightdeck without the phone, the LR512 and the fixtures, and hand over what only the real hardware can show. Use this after any change to what lightdeck sends or shows (a controller, an effect, a profile, the rig, the playback, a page of the console), before saying that something works, when Jeroen asks to test, try, run, check or demo something, and when writing down what was and was not verified. Use it also to prepare a test on the real fixtures.
---

# Verifying without the hardware

The fixtures are at Jeroen's place and the bridge runs on his phone. Nothing built here
has been seen on a real light by the one who built it. That makes two things matter:
check as far as a machine can, and say exactly where that stops.

## The three levels, and what each proves

| Level | How | What it proves | What it does not |
|---|---|---|---|
| Tests | `pnpm check` | The logic: bytes for values, an effect per beat, refusals, the show file | That the pieces work together, or that a page can be used |
| Stand-in | lightdeck against `scripts/standin-bridge.mjs` | The whole path up to the bytes of the universe, and the pages in a browser | That the bytes mean on the fixture what the manual says |
| Hardware | Jeroen, with the fixtures | Everything else: the look, the speed, the motors, the laser, the tablet | |

Do the first two for every change to what is sent or shown. Never report the third from
the first two.

## The stand-in bridge

`scripts/standin-bridge.mjs` in this skill speaks the wire protocol of the Android
bridge: it takes the frames, sends the status a real bridge sends, prints what changed,
and writes what is being "sent" to a file. It has no dependencies.

```bash
SKILL=.claude/skills/verify-without-hardware
node $SKILL/scripts/standin-bridge.mjs --port 9019 --dump <scratch>/out.json &

pnpm tsx src/index.ts --bridge ws://127.0.0.1:9019 --port 8099 --host 127.0.0.1 \
  --show <scratch>/show.yaml &
```

Three things to get right, each of which has bitten:

- **A spare port for both**, not 9010 and 8080. Jeroen may have `pnpm dev` running, and
  a second console on his port either fails or confuses.
- **A show file in a scratch directory**, with `--show`. The deck writes the show file.
  Without the flag a test writes into the `show.yaml` he is programming.
- **Stop what was started**, by the pids. Do not `pkill` on a pattern: the pattern is in
  the command line of the shell that runs it, and it kills that too.

Then drive it and read what goes out:

```bash
curl -s localhost:8099/api/state                       # what the pages get
curl -s -X POST localhost:8099/api/fixtures/spider/update \
  -H 'content-type: application/json' -d '{"levels":{"dimmer":1,"blue3":0.5}}'
cat <scratch>/out.json     # {"universes":{"0":{"6":255,"17":128}}}: channel 6 and 17
```

`out.json` has the channels that are not 0, by channel number from 1, per universe.
Compare them with the manual's table, not with what the code says they should be: the
question is whether the fixture would do the right thing.

The API is described at the top of `src/server/http.ts`. The command-line tools work
against the stand-in too: `pnpm spider 127.0.0.1 -p 9019 dimmer=100 --once`.

**A lost LR512**: `kill -USR1 <pid of the stand-in>` switches the device between open and
lost. Stopping the stand-in is a bridge that does not answer. Check what the console
says in both cases, and that it comes back by itself.

**A bridge that goes quiet**: `kill -USR2 <pid>` switches the stand-in to silent and back.
Silent is a half-open connection: TCP stays up, but no alive message, no status, no
handshake is sent, and what arrives is queued until silent ends. Use it to check that
lightdeck notices after a few seconds without a word and reconnects. `--no-alive` is the
APK from before the alive message: the stand-in never sends it, and lightdeck must leave
that connection alone. `--client-idle <ms>` makes the stand-in do what the real bridge
does with a client that has sent `limits` and then goes quiet (the real one waits 6000):
it closes that connection. Default off.

**What the stand-in records**: it sends the alive message (`{"type":"alive","device",
"frames"}`) every second and takes the client's `{"type":"limits","maxFps":N}`. The dump
file has `limits` (as it came, `null` when none), `capFps` (what a real bridge applies:
clamped to 1..60, 25 without a message), `silent`, and the frames received and the frames
that differ from the one before, per universe. Every 5 seconds it prints the rates. The
stand-in does not cap or skip anything itself: it shows what the client sends.

**An LR512 has one usable universe.** The stand-in reports `[512, 0]` like the real one
and says so when a frame goes to a universe without channels. If you see that line, the
real device would have refused every frame.

## Looking at a page

```bash
timeout 40 google-chrome --headless=new --disable-gpu --hide-scrollbars \
  --user-data-dir=<scratch>/chrome --no-first-run \
  --window-size=1280,800 --timeout=4000 \
  --screenshot=<scratch>/deck.png http://127.0.0.1:8099/deck
```

- `--user-data-dir` is needed: without it Chrome takes Jeroen's own profile, which his
  running browser has locked, and it hangs.
- `--timeout` is needed: a page keeps its event stream open and never finishes loading.
- Take a tablet in both directions: `1280,800` and `800,1280`.
- Then read the image. A screenshot nobody looked at checks nothing.

A screenshot shows a page at rest. For what happens on a press or a drag, use the
browser tools when they are available, or say that it was not tried.

## What only the hardware shows

Write these down while building, not after. For every change, ask what you assumed
about the real thing:

- That a byte means what the manual says, and what the manual does not say at all.
- How it looks: brightness, colour, how fast is fast.
- Whether a motor or a laser follows a value that changes forty times per second.
- Whether it works on the tablet: touch, size, the browser of the tablet.
- Whether it holds for an hour: the link, the phone, the tempo.

They go in "Unverified assumptions" in `CLAUDE.md`, so that the next session does not
take them for facts.

## The report

Say what was done at which level, in these words or close to them:

- "Tests pass" with the number.
- "Ran against the stand-in bridge: ..." with what was sent and what came out.
- "Looked at in headless Chrome at tablet size" or "in desktop Chrome", per page.
- "Not run on the real fixtures", and the list of what that leaves open.

Do not write "works" for something only the first two levels have seen. Jeroen plans a
party on what this says.

## A test sheet for the real fixtures

When Jeroen is going to try something, give him a short sheet instead of "let me know if
it works". "It works" after a first try leaves every single assumption as open as it
was, and that has happened: the fixtures ran, and the list of assumptions stayed.

One line per thing to look at, each answerable with yes, no, or a word:

```
Spider, effect "chase", 126 bpm, speed ×1
1. One lens per beat, not faster?                          yes / no
2. Lenses 1 to 4 on the left bar, 5 to 8 on the right?     yes / no, which
3. At ×4: still pleasant, or too much?                     
4. Blackout: dark at once, and the same look after?        yes / no
```

Put the command or the presses above it, and ask for the log of the bridge when
something is off. When the answers come, move what is confirmed out of the unverified
assumptions and correct what is not.
