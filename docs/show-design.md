# Show design: groups, scenes, sequences and the deck

Status: steps 1 to 3 are built (2026-09-29): the groups with their scenes, a deck to
store and recall them with one scene per group on, and the grand master. They ran
against a local server without a bridge and in desktop Chrome, not on the real fixtures
and not on a tablet. The other steps are design. Decisions marked
"Jeroen" were made by him on 2026-09-29; the rest is a proposal.

## What it is for

Lightdeck can set one spider and one laser by hand, with effects on a shared tempo. The
next step is programming: store looks, run them in sequences on the tempo, and mix them
at showtime from one page of buttons. Mixing means that several scenes are on at once,
each for its own part of the rig: a scene for the spider under a scene for the laser.

## Terms

- **Group**: a named set of fixtures, such as "Spider", "Laser" or "All". A fixture can
  be in more than one group.
- **Scene**: a named look for the fixtures of one group. For every fixture of its group
  it holds what that fixture should be doing: its effect, colours, levels and raw bytes.
- **Off**: what every group has besides its scenes. It darkens the fixtures of the group.
- **Sequence**: a list of steps that runs on the master tempo and loops. A step lasts a
  number of bars and names a scene for one or more groups.
- **Deck**: the page for showtime. The groups with their scenes, the sequences, the grand
  master, the master speed, blackout and tempo.
- **Hold**: a button that changes the output while pressed and gives it back on release,
  such as a strobe burst.

## Decisions

1. **One state per fixture** (Jeroen). Recalling a scene sets the fixtures through their
   controllers, the same way their pages do. The operator can adjust by hand afterwards;
   the deck then shows the scene as changed and offers to store it back. There are no
   layers and no priorities: a fixture is set by one scene at a time, and nothing is
   merged.
2. **What a scene holds is up to the kind of fixture**, like the state of a
   `FixtureController` already is. The normalized model in `src/model/` cannot express
   spider effects or laser ranges. It is meant for the Zigbee lamps.
3. **Scenes and sequences may open the laser, also unattended** (Jeroen). There is no arm
   switch. The rule that an effect never opens the laser stays: a scene sets the mode
   channel, an effect does not.
4. **Grand master** (Jeroen). It scales the dimmer of fixtures that have one: what goes
   out is the brightness of the scene times the grand master. A fixture without a dimmer,
   such as the laser, is closed while the master is at 0 and shows what it is set to
   above 0. The blackout stays, and is the same as the master at 0. The master is no
   part of a scene: moving it does not show a scene as changed, and a recall does not
   move it. There are no faders per fixture (Jeroen): the brightness of a fixture is
   what its scene holds.
5. **Tempo** is set by hand or by tapping. Ableton Link is parked (Jeroen), see below.
6. **Scenes belong to a group, and several groups are on at once** (Jeroen). This takes
   the place of the earlier rule that a scene is a complete look for the whole rig. See
   "Groups" below.
7. **A step of a sequence can set several groups, and only sets what changes** (Jeroen).
   See "Sequences" below.
8. **At normal speed an effect changes once per beat at most, and every effect has a
   speed of its own** (Jeroen, 2026-09-30): ÷4, ÷2, ×1, ×2 or ×4. It is part of the
   state of the fixture, so a scene holds it: a chase at ×1 on the spider under a laser
   that changes pattern once per bar. The master speed works like the grand master: it
   is set on the deck, with the same five speeds, it multiplies with the speed of every
   effect, its level shows in the status bar of every page, and it is no part of a
   scene. It has keys and no fader, because only halves and doubles keep an effect on
   the beat. Together the two speeds are held to ten changes per second.
9. **The show is one YAML file, written by the deck** (Jeroen) and still editable by
   hand. The server watches it, and a file that does not validate never replaces the
   running show. Getting it into git is a copy, not the way of working.
10. **Lightdeck runs on Jeroen's laptop for now** (Jeroen), with the bridge on a real
    Android device. The container and the homelab deploy are postponed.

## Groups

This is the way Daslight does it, per fixture. A professional console gets the same
result with partial cues on several playbacks, and needs priorities for it. Groups need
none.

- **One scene per group is on.** A press on another scene of the group takes its place.
- **A scene sets the fixtures of its group and no others.** Within its group it is a
  complete look: a fixture of the group that the scene does not name goes dark, or closed
  for the laser.
- **Off darkens the fixtures of the group**, and then no scene of the group is on.
- **Storing takes the fixtures of the group as they are.** The deck asks for the group
  by where the scene is stored: every group has its own place to store.
- **Changed by hand is kept per group.** A group shows its scene as changed when one of
  its fixtures is no longer what the scene made it.
- **When two groups share a fixture, the last press wins.** A scene of "All" sets the
  spider, so the scene that was on in "Spider" is not on any more. The other way round,
  a scene of "Spider" leaves the scene of "All" on and shows it as changed, because the
  laser still is what that scene made it.
- **A new show starts with a group for every fixture and one for all of them.** Groups
  are made, named and taken away on the deck in its edit mode, or in the file. Taking a
  group away takes its scenes away.

Left out on purpose: splitting within a fixture, so that the colours come from one scene
and the movement from another. That needs merging of state. It can be added later if it
is missed, for example for the tilt of the spider.

## Sequences

- **A step lasts a number of bars and names a scene, or off, for one or more groups.**
  A group that a step does not name is left alone by that step.
- **A step only sets what changes.** A group is set when the step names another scene
  for it than the sequence set last. The first step after the start sets every group it
  names. When the sequence starts again from its first step, the last step counts as the
  step before.
- **A press by hand wins at once, and the sequence goes on.** It takes the group back at
  the next step that changes that group. A sequence that never changes the laser after
  its first step leaves a laser scene that was chosen by hand on for as long as it runs.
- **A sequence that sets some groups leaves the others to the operator.** So a sequence
  for the spider runs under laser scenes that are chosen by hand.
- **Stopping a sequence leaves the fixtures as they are.**
- **One sequence runs at a time, at first.** Two at once, which share no fixture, come
  later. Until then, starting a sequence stops the one that runs.

## Open

- **Do sequences follow the master speed (÷4 to ×4)?** Proposal: no. A sequence
  counts real bars; the speed only changes the effects within a step.

## Show file

```yaml
groups:
  spider:
    label: Spider
    fixtures: [spider]
    scenes:
      amber-chase:
        label: Amber chase
        fixtures:
          spider:
            levels: { dimmer: 1 }
            effect:
              id: chase
              colourA: { red: 1, green: 0.58, blue: 0, white: 0 }
              colourB: { red: 0, green: 0.15, blue: 1, white: 0 }
      blue-wave:
        label: Blue wave
        fixtures:
          spider: { levels: { dimmer: 0.6 }, effect: { id: wave } }
      burst:
        label: Burst
        fixtures:
          spider: { levels: { dimmer: 1 }, effect: { id: burst } }
  laser:
    label: Laser
    fixtures: [laser]
    scenes:
      tunnel:
        label: Tunnel
        fixtures:
          laser: { raw: { mode: manual, program: "pattern:12" }, effect: { id: twist } }
  all:
    label: All
    fixtures: [spider, laser]
    scenes: {}

sequences:
  peak:
    label: Peak
    steps:
      - bars: 8
        scenes: { spider: amber-chase, laser: tunnel }
      - bars: 8
        scenes: { spider: blue-wave } # the laser stays on tunnel
      - bars: 1
        scenes: { spider: burst, laser: off }
```

- The id of a scene is its own within its group. `off` cannot be the id of a scene.
- In a step, `scenes` goes from the id of a group to the id of a scene of that group, or
  to `off`.
- An id has small letters, digits and dashes. It is what was typed: `12` and `true` are
  the ids "12" and "true", and the deck writes them back with quotes.
- A file from step 1, with `scenes:` at the top, is read as the groups a new show starts
  with, and its scenes are in the group of all fixtures, so that nothing that was stored
  is lost. Reading does not write: the first change from the deck writes the file with
  groups.
- `sequences` is not read yet: until step 4 it is a mistake in the file.
- Laser bytes are to be written with the range keys of the profile, as `pnpm laser`
  takes them, so that the file can be read. For now the file has plain numbers, which are
  raw bytes: `raw: { mode: 95, program: 60 }`.
- What is at rest is left out of the file: levels at 0, function channels at their idle
  value, and the effect when none is chosen. A scene written by hand can do the same,
  because recalling starts from the fixture at rest.

## Order of building

| Step | What | Done when |
|---|---|---|
| 1 | Scenes: store from live, recall, rename, delete, saved to the show file. **Built** | A look set by hand on two fixture pages comes back with one press, also after a restart |
| 2 | Groups: a scene belongs to a group, one scene per group is on, off per group. **Built** | A spider scene and a laser scene are on together, and each is changed without the other |
| 3 | Grand master on the deck. **Built** | The evening can be run from one page |
| 4 | Sequences, one at a time | A loop runs by itself for an hour and stays on the bar, and a laser scene chosen by hand stays on under it |
| 5 | Switching on the beat: a pressed scene starts on the next bar | A change never lands in the middle of a bar, unless asked |
| 6 | Holds | Strobe burst while pressed, the scene is back on release |
| 7 | Two sequences at once, crossfade of levels, phases as banks, Zigbee lamps in scenes | |

Steps 1 to 4 come before the dress rehearsal, 5 to 7 after.

Left out on purpose: layers and priorities, splitting within a fixture, palettes, a
timeline, undo, a generic fixture library.

## Where it attaches

- `src/show/`: the types of the show file, validation, loading and saving (built for
  groups and their scenes). Sequences are added to what the file can hold. Which step
  of a sequence it is, is to be a pure function from beat to step, so it is tested frame
  by frame like the effects.
- `FixtureController`: `snapshot()` gives what a scene stores of this fixture, `check()`
  and `recall()` take it back (built). `recall` is not `update`: it starts from the
  fixture at rest, and shares the validation with `update`. A recall without a part is
  what off is. `setMaster(level)` takes the grand master (built): it is kept outside the
  state, next to the blackout, and put into what goes out. `darken()` of the laser is
  final: after it nothing opens the laser again, whatever is set or recalled.
- `src/server/playback.ts`: the playback, which the rig owns (built). It keeps per group
  which scene is on and whether it was changed by hand, and a recall sets the fixtures
  of the group only. `changed` is about what the scene made of the fixtures when it was
  recalled: a scene that is on and gets another look in the file is not shown as
  changed. With sequences it is to keep what the sequence set last per group, which is
  what "only sets what changes" counts on, and to apply the steps on the tempo.
- `http.ts`: built are `POST /api/playback`, which takes `group` with `scene` or with
  `off`, `POST /api/groups`, `POST /api/groups/<group>/rename` and `/delete`,
  `POST /api/groups/<group>/scenes`, `POST /api/groups/<group>/scenes/<scene>/store`,
  `/rename` and `/delete`, and the events `show` and `playback`. The endpoints under
  `/api/scenes` of step 1 are gone. `POST /api/master` and the event `master` are built,
  and `GET /api/state` has `master`. `sequence` in `POST /api/playback` is to come.
- `public/deck.html`, `.js`, `.css`: the deck (built). It has a row per group, with the
  keys of its scenes and its off key. Show is the mode it opens in, where a press
  recalls and nothing moves under a finger. Program adds storing, naming and deleting,
  of scenes and of groups, and the off keys wait there, so that a slip does not throw
  away a look that is not stored yet. A press is asked once: one that does not reach
  lightdeck is not sent later, the deck says so and the operator presses again. The
  fader of the master is on the deck in both modes (built). It is not kept on screen
  when the deck scrolls.
- `public/shell.js`: shows the level of the master in the status bar of every page
  (built), and says in its notice when the master is at 0. `public/changes.js` keeps
  what a page has changed until the event stream tells of it, so that an event about
  something else, such as the master, does not set a fader back under the finger.

The controllers keep their own 25 ms tickers. Fixtures stay together because they count
on one beat, not because they share a loop.

## Tempo and Ableton Link (parked)

A tapped tempo that is 0.5 bpm off drifts half a beat per minute, so a sequence that runs
for long needs a nudge now and then. Ableton Link would take the tempo and the beat from
the DJ software.

Jeroen plays with rekordbox. It supports Ableton Link in Performance mode, which is
playing from the laptop, and not in Export mode, which is playing from USB sticks on
standalone players. For Node there are bindings to the Link SDK, such as
`@ktamas77/abletonlink`. They are native addons that compile on install. Link finds its
peers by multicast on the LAN, so the laptop with rekordbox and the one with lightdeck
must be on the same network, or be the same laptop.

It would attach to `Tempo` as a second source of bpm and beat origin. Nothing else has to
know.
