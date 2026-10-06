---
name: add-fixture
description: Add a DMX fixture to lightdeck from its manual, or add another unit or another channel mode of a fixture it already knows. Use this whenever Jeroen brings a new light, laser, moving head, strobe, par or other DMX device, uploads or mentions a fixture manual or channel table, asks to "implement" or "support" a fixture, or wants a second spider or a different start address. Use it for the whole job, from reading the manual to the page in the console, even when he only asks for the profile.
---

# Adding a DMX fixture

A fixture enters lightdeck through its manual. The manual is the only source there is
until Jeroen stands next to the fixture, so the work is: copy the manual exactly, keep a
list of what it does not say, and build the rest so that a wrong guess is cheap to fix.

For a lamp or switch in Home Assistant this is the wrong skill: follow
`docs/hass-fixtures-plan.md`.

## One more unit of a known kind

One more definition in `src/index.ts`, with an id of its own (`spider-2`), and settings
for its address if Jeroen has to be able to change it. The patch refuses overlapping
addresses at startup, so choose a default that is free: a spider at 1 takes 1 to 43.
Check what the console does with two of a kind (the list of pages, the groups of a show
without a file) and say what you checked.

## A new kind: the steps

### 1. Put the manual in `docs/` and read all of it

The channel table is the obvious part. Also look for: the channel modes and how one is
chosen on the fixture, how the address is set, what a channel does at 0, anything that
needs a value held for some time (a reset), and warnings.

### 2. Write down what the manual does not say

Before any code. These are the assumptions, and they go in two places: the header of the
profile file, and "Unverified assumptions" in `CLAUDE.md`. Examples from the fixtures
that exist: which end of a speed channel is fast, how patterns lie on a channel, which
LED sits on which bar.

They are listed so that a hardware test can go through them one by one. "It works" from
a first try does not confirm them, and an assumption that is not written down gets built
on.

### 3. The profile, in `src/fixtures/<name>.ts`

Read `profile.ts` for the kinds of control, and `spider.ts` and `laser.ts` as the two
examples: one mostly levels, one only ranges.

- **Labels and byte ranges are the manual's own words.** Names and titles for the page
  are ours. That keeps the manual and the code comparable line by line.
- **A level** is anything continuous: dimmer, a colour, a position. Give it
  `fineChannel` when the manual has a second channel for fine tuning.
- **A function channel** is anything that chooses a mode, a program or a trigger. It
  rests at `idle` and changes only through an explicit byte. This is the rule that keeps
  a scene or an effect from starting a built-in program or a reset by accident, so when
  in doubt, make it a function channel.
- **Ranges** get a `key` when something has to choose them by name, `scale` or `steps`
  when the place within the range sets something, and `when` if they count only while
  another channel is in some range.
- **`attribute: 'dimmer'`** on the control that is the fixture's master brightness. The
  grand master scales that control and nothing else. A fixture without it is treated as
  having no dimmer.

Tests next to it, as for the others: the footprint, every channel used once, the bytes
of a few values, ranges that do not overlap.

### 4. Decide what "dark" and "safe" are for this fixture

Answer these before the controller, and ask Jeroen where the answer is about people or
about his taste:

| Question | Why it matters |
|---|---|
| What is the fixture at rest? | Rest is what a scene that does not name it gives, and where recall starts from |
| What does the blackout do? | It must be dark, and keep its state for when the blackout lifts |
| Does it have a dimmer for the master? | Without one it is closed at master 0 and shown as set above 0 |
| May it stay on when lightdeck stops? | The bridge holds the last frame. A spider may stay; a laser may not, so `darken` closes it for good |
| What may an effect drive? | An effect never opens a laser. Whatever opens or arms a fixture stays with the operator and with scenes |
| Is there something that must be held or timed? | A reset byte held for seconds is an action, not a state |

### 5. The controller, in `src/server/`

It has to fit `FixtureController` in `fixture.ts`. Read `spiderController.ts` and
`laserController.ts` first; a new kind is often one of them with another profile, and
then `kinds.ts` is all it needs.

What every controller has to get right, because the playback and the deck count on it:

- `update` applies all of a change or none of it, and refuses a key it does not know.
- `snapshot` leaves out what is at rest, so a dark fixture gives `{}`.
- `recall` starts from rest, not from the current state. `check` refuses what `recall`
  would refuse, and changes nothing.
- Blackout and master are kept outside the state and put into what goes out.

### 6. Wire it up

An entry in `src/server/kinds.ts`, a definition in `src/index.ts`, and settings for the
address when it can differ. The LR512 has one usable universe, index 0.

### 7. A page of its own

`src/server/public/fixtures/<kind>.html`, `.js` and `.css`. A fixture never goes into the
page of another fixture: that was built once and rejected. Build the page from the
profile where that works, the way the laser page makes its keys from the ranges, so the
page does not have to change when the profile is corrected. Use the skill
`console-page` for the style and the shell.

### 8. A command for the first hardware test

`src/cli/<name>.ts` with a script in `package.json`, like `pnpm spider`. The first test
of a fixture is one channel at a time, and that is easier from a terminal than from a
page. It sends this fixture only, so the others on the universe go dark: say so in its
help text.

### 9. Verify, hand over, write down

Use the skill `verify-without-hardware`: run it against the stand-in bridge, and give
Jeroen a test sheet with the assumptions from step 2. Then update `CLAUDE.md` (the
layout, the settings, the assumptions) and the table of fixtures in `README.md`.

## What went wrong before

- **A default universe chosen on a guess.** Index 1 looked right and has no channels on
  an LR512. Every frame was refused, and the bridge reopened a healthy device every 13
  seconds.
- **A fixture built into another fixture's page.** Rejected: fixtures stay separate
  units, because scenes are programmed over them later.
- **Things decided on Jeroen's behalf**: that the blackout closes the laser, that
  lightdeck closes it on stopping. They turned out right, and they were his to decide.
  Build the safe choice, and tell him that you chose.
