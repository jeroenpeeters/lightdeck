# Show design: groups, scenes, sequences and the deck

Status: step 1 is built (2026-09-29), the scenes with a first deck to store and recall
them. It ran against a local server without a bridge, not on the real fixtures. What is
built has no groups yet: every scene sets every fixture. The other steps are design.
Decisions marked "Jeroen" were made by him on 2026-09-29; the rest is a proposal.

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
  master, a fader per fixture that has a dimmer, blackout and tempo.
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
4. **Grand master** (Jeroen). It scales the dimmer of fixtures that have one. A fixture
   without a dimmer, such as the laser, is closed while the master is at 0 and shows what
   it is set to above 0. The blackout stays, and is the same as the master at 0.
5. **Tempo** is set by hand or by tapping. Ableton Link is parked (Jeroen), see below.
6. **Scenes belong to a group, and several groups are on at once** (Jeroen). This takes
   the place of the earlier rule that a scene is a complete look for the whole rig. See
   "Groups" below.
7. **A step of a sequence can set several groups, and only sets what changes** (Jeroen).
   See "Sequences" below.
8. **The show is one YAML file, written by the deck** (Jeroen) and still editable by
   hand. The server watches it, and a file that does not validate never replaces the
   running show. Getting it into git is a copy, not the way of working.
9. **Lightdeck runs on Jeroen's laptop for now** (Jeroen), with the bridge on a real
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

- **Do sequences follow the speed (0.5, 1, 2)?** Proposal: no. A sequence counts real
  bars; the speed only changes the effects within a step.

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
          spider: { levels: { dimmer: 1 }, effect: { id: strobe-burst } }
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
- A file from step 1, with `scenes:` at the top, is read as one group `all` with every
  fixture, so that nothing that was stored is lost.
- Laser bytes are to be written with the range keys of the profile, as `pnpm laser`
  takes them, so that the file can be read. For now the file has plain numbers, which are
  raw bytes: `raw: { mode: 95, program: 60 }`.
- What is at rest is left out of the file: levels at 0, function channels at their idle
  value, and the effect when none is chosen. A scene written by hand can do the same,
  because recalling starts from the fixture at rest.

## Order of building

| Step | What | Done when |
|---|---|---|
| 1 | Scenes: store from live, recall, rename, delete, saved to the show file. **Built**, without groups | A look set by hand on two fixture pages comes back with one press, also after a restart |
| 2 | Groups: a scene belongs to a group, one scene per group is on, off per group | A spider scene and a laser scene are on together, and each is changed without the other |
| 3 | Grand master and fixture faders on the deck | The evening can be run from one page |
| 4 | Sequences, one at a time | A loop runs by itself for an hour and stays on the bar, and a laser scene chosen by hand stays on under it |
| 5 | Switching on the beat: a pressed scene starts on the next bar | A change never lands in the middle of a bar, unless asked |
| 6 | Holds | Strobe burst while pressed, the scene is back on release |
| 7 | Two sequences at once, crossfade of levels, phases as banks, Zigbee lamps in scenes | |

Steps 1 to 4 come before the dress rehearsal, 5 to 7 after.

Left out on purpose: layers and priorities, splitting within a fixture, palettes, a
timeline, undo, a generic fixture library.

## Where it attaches

- `src/show/`: the types of the show file, validation, loading and saving (built for
  scenes without groups). Groups and sequences are added to what the file can hold.
  Which step of a sequence it is, is to be a pure function from beat to step, so it is
  tested frame by frame like the effects.
- `FixtureController`: `snapshot()` gives what a scene stores of this fixture, `check()`
  and `recall()` take it back (built). `recall` is not `update`: it starts from the
  fixture at rest, and shares the validation with `update`. Groups change nothing here:
  a recall without a part is what off is. `setMaster(level)` is to take the grand master.
- `src/server/playback.ts`: the playback, which the rig owns (built for one scene over
  every fixture). With groups it keeps per group which scene is on and whether it was
  changed by hand, and a recall sets the fixtures of the group only. With sequences it
  keeps what the sequence set last per group, which is what "only sets what changes"
  counts on, and applies the steps on the tempo.
- `http.ts`: built are `POST /api/scenes`, `POST /api/scenes/<id>/store`, `/rename`,
  `/delete`, `POST /api/playback`, and the events `show` and `playback`. With groups
  the scenes move under their group, `/api/groups/<group>/scenes/...`, and
  `POST /api/playback` takes `group` with `scene` or `off`, and later `sequence`.
  `POST /api/master` and the event `master` are to come.
- `public/deck.html`, `.js`, `.css`: the deck (built for one list of scenes). With
  groups it has a row per group, with the keys of its scenes, its off key and its place
  to store.

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
