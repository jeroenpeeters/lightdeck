# Plan: light effects, motion effects and palettes, apart

Status: design only, nothing built (2026-10-14). The decisions marked "Jeroen" were made by
him on that date, in the order they are listed. The rest is a proposal. It builds on the
scene types of `docs/show-design.md` ("Scene types", built 2026-10-07) and changes what is
in two of them.

## What Jeroen wants

Light effects, motion effects and colours as three separate things that can be combined,
because they control independent properties. Colours are a template, not part of an
effect: a **palette**, a list of colours that an effect takes one or more from, and that a
scene can change easily. Palettes are managed once, as a setting of the app, and used per
scene.

## Why

- Today the three are mixed. A Colour scene holds two colours and works under a running
  effect, which is the part that already is as wanted. But tilt wave and the scissors are
  in the list of light effects, so they take the tilt from a Motion scene while they run,
  and `scissor-motor` sets the motor speed, the one effect that touches a property of
  another type (`setsMotorSpeed`). Light effects also decide how the colours mix.
- Split, a new light effect works with every palette, a new palette with every effect, and
  a sequence can change each at its own pace: the lights every 8 bars, the colours every
  32, the motion every 16.

## Terms

- **Light effect**: which lenses are on, when, and how strongly. Knows no colour. Type
  Lights.
- **Palette**: a named list of colours, with a way to move through it. Shared by the whole
  show. Type Colour.
- **Motion effect**: where the bars point over time, and the motor speed that goes with
  it. Type Motion.
- **Slot**: a place in the palette, counted from 1. Slot 1 is the main colour.
- **Look**: one key that sets a light scene, a palette and a motion scene of a group
  together. It refers to them and holds no copy. See "Looks".

## Decisions

1. **Tilt wave, scissor and scissor by motor speed leave the light effects and become
   motion effects** (Jeroen). Hold, fixed tilts and motor speed, is the plainest one and is
   what a Motion scene is today.
2. **A palette is a list that can grow** (Jeroen). Not three fixed colours.
3. **An empty slot is off** (Jeroen). A lens that an effect gives a slot the palette does
   not have, or has as off, is dark. This replaces the rule of 2026-10-07 that an empty
   second colour is the first colour dim (`REST_LEVEL`, 7%), and the proposed fallback of
   the third colour to the first.
4. **A palette is static or cycles by itself, and it is set per palette** (Jeroen). The
   cycle is a hard step or a fade, also per palette.
5. **Palettes are managed once in the app and used per scene** (Jeroen), on a page of their
   own in the shell, next to the others (Jeroen).
6. **Palettes take the place of Colour scenes** (Jeroen, for simplicity at this stage). The
   Colour lane of the deck shows the palettes, a press sets one on the group, and a step of
   a sequence names a palette per group. A group has one palette on. Lights and Motion stay
   scenes per group, because they depend on what the fixtures of that group can do, and a
   palette does not.
7. **Old scenes are dropped** (Jeroen), as in 2026-10-07. Nothing is migrated.
8. **No blending of two light effects for now** (Jeroen), documented below as an option.
9. **Per-lens colours by hand are left out for now, and nothing is cut that makes them hard
   to add later** (Jeroen). See "Left out, and what is kept for it".
10. **A palette that is in use cannot be deleted, for now** (Jeroen). The deck refuses and
    says what uses it.
11. **A palette has at most eight entries** (Jeroen), one per lens of the spider.
12. **The laser does not follow the palettes. It has a colour setting of its own** (Jeroen,
    2026-10-14, chose this over snapping palette entries to its seven colours): a first, a
    second and a third, which are colours the laser can make. A palette on the group "All"
    therefore colours the spider and not the laser. What else follows from it is in "Open".
13. **Every light effect starts with two slots, and a third slot is added to three of them**
    (Jeroen, agreed to the proposal): the kick (the first beat of the bar, instead of slot
    1), the chase (the lens that just left, as a trail) and the sparkle (an occasional spark
    in another colour). The others use slots 1 and 2 only. An effect that does not use a slot
    ignores it. The details are decided when each effect is ported.
14. **Looks are in the first version, and are called looks** (Jeroen). The name is a common
    word in lighting and not a fixed object: consoles say cue, scene, preset or memory, so
    the meaning here is the one below. The lanes stay independent: a look is a convenience
    on top of them, not instead of them.
15. **The laser's colour setting is the simplest one** (Jeroen): a static list of up to
    three colours the laser can make, kept with the laser, and the laser's Colour chase
    steps through them. Jeroen expects to use one or two. It does not cycle by itself; the
    laser can do that on the automatic ranges of channel 9.

## How it works

**A light effect gives a level per lens per slot.** Where it gave a colour per lens it
now says how much of slot 1, slot 2 and so on each lens gets, from 0 to 1. The colour of a
lens is the sum of the colours of the slots, each at its level, and the sum is made in one
place after the effect. An effect says which slots it uses, and the key on the deck can show
it (one, two or three dots). The effects keep following the beat as pure functions: same
clock, same `limitSpeed`, at most one change per beat at speed 1.

**Off is a slot.** A palette entry is a colour or off. `[red, off, blue]` is allowed, and
that is how colour gets gaps and rhythm. A slot beyond the end of the list is off in the
same way. A palette of one colour used by a kick is a lens that hits and goes dark.

**A palette moves through its list when it cycles.** The list shifts by one, so an effect
that uses slots 1 and 2 sees (1,2), then (2,3), then (3,1). The pace is a speed of its own,
the same ÷4 to ×4 as the effects, multiplied with the master speed, held to the flash limit
(a step that changes colour is a change like any other). A step is a hard cut or a fade,
chosen in the palette. It runs on the beat grid from beat one, like the effects, so a
cycle and an effect stay in time.

**The fixture turns slots into bytes.** The spider mixes RGB and white. The laser has seven
fixed colours on channel 9, so each entry becomes the nearest of them, and what it cannot
make (warm white, say) needs a rule (open). A Zigbee lamp, when there is one, takes a slot
as its colour.

**Rainbow becomes a palette.** The Spectrum effect ignores the colours today (`colours:
'none'`). A palette with many colours that cycles with fade is the same picture, and
Spectrum leaves the list of effects.

### The three lanes of a group

| Lane | One of | Holds | Stored as |
|---|---|---|---|
| Lights | scenes of the group | light effect and its speed, dimmer, strobe, the fixture's own programs, the laser's mode, pattern and drawing | a scene |
| Colour | palettes of the show | the colours, static or cycling, hard or fade, the speed | a palette |
| Motion | scenes of the group | motion effect and its speed, motor speed, fixed tilts; the laser's rotation, flips, position, size | a scene |

Off stays the Lights part. A new group, and a new show, starts with a palette that is a
single white, so that nothing is dark for no reason.

## Looks

A look belongs to a group, like a scene, because the light scene and the motion scene in
it are the group's. It holds:

- a light scene of the group, or none
- a palette, or none, with a speed that overrides the palette's own for this look, or none
- a motion scene of the group, or none

**A lane a look leaves out is left alone.** This is the rule of a sequence step too: it
only sets what it names. A look with only a palette is a colour change.

- **Pressing a look** sets the lanes it names, as three presses would, and the group shows
  it as on. Pressing a key in one lane afterwards changes that lane only, and the look is
  shown as changed, which is how "changed by hand" works per type already.
- **The palette's pace is the one place a look adds something.** The same palette can
  run slowly in one look and fast in another. The palette keeps a default pace, so a palette
  pressed on its own behaves as before.
- **Storing a look** takes what is on in the group now: the light scene, the palette with
  its speed, the motion scene. If a lane was changed by hand since its scene was recalled,
  there is no scene to point at, and the deck says to store that scene first (open).
- **A scene or a palette that a look uses cannot be deleted**, the same rule as for a
  palette in use (decision 10), and the deck says what uses it.
- **In a sequence** a step may name a look for a group, or lanes one by one as before. A
  look is a shorthand for up to three of them.
- **On the deck** a group gets a row of looks next to its three lanes. In Program mode they
  are stored, renamed and deleted like scenes.

A sketch, a proposal and not a fixed format:

```yaml
looks:
  - id: drop-1
    label: Drop
    group: spider
    lights: chase-fast
    colour: { palette: sunset, speed: 0.25 }
    motion: scissor-slow
```

## What changes in the parts

- **`effects.ts`**: `Effect` loses colours and gets levels per slot and a list of the slots
  it uses. The colour mixing and `palette()` with `REST_LEVEL` go. The three static light
  effects that replace per-lens colours are new: Solid (every lens slot 1), Bars (bar 1 slot
  1, bar 2 slot 2), Alternate. Tilt wave and the scissors move to a motion-effects list, with
  Hold.
- **`spiderController.ts`**: state becomes `effect: {id, speed}` and `motion: {id, speed}`;
  the palette is not part of its state but is handed to it by the rig, and the colour in
  the bytes is made from palette and levels. The exception of `setsMotorSpeed` goes, because
  the motion effect owns the motor speed. The controller still refuses nothing new: the
  laser rule stays, an effect never opens the laser.
- **`playback.ts` and `show.ts`**: a group has a palette on, not a Colour scene. The show
  file gets a `palettes:` section. A palette in use cannot be deleted, or the deck says what
  uses it (open).
- **Deck**: the Colour lane shows palettes, and Program edits nothing there. The palette
  page is new and lives in the shell with the other pages. It follows the console style: a
  colour entry per slot, an off entry, add and remove, mode, step or fade, speed. Keys do not
  move under a finger.
- **Simulator**: draws bytes, so it needs no change.
- **Skills and `CLAUDE.md`**: the exception for motor speed in `beat-effect`, the roles of
  the first and second colour, and the 7% dim background are replaced.

A sketch of the file, a proposal and not a format that is fixed:

```yaml
palettes:
  - id: sunset
    label: Sunset
    colours: ['#ff4a00', 'off', '#ffb000']
    mode: cycle        # static | cycle
    change: fade       # step | fade
    speed: 1           # ÷4 .. ×4
```

## The laser

The same split carries over, except that the laser does not use the palettes (decision 12).
Pattern chase is Lights, Sweep and Twist are Motion, and Pulse (size) is probably Motion.
Colour chase steps through the laser's own colours (decision 15). Done after the spider.

## Left out, and what is kept for it

- **Blending two light effects**, such as a chase with sparkle over it. It needs a rule for
  how the levels of two effects combine (add, or the higher, or the second on top) and
  where the second is stored. Not for now (Jeroen). Kept possible: a light effect is a
  function from beat to levels per lens and slot, and a sum or a maximum of two of them is
  a function of the same kind, so nothing in the design has to change for it.
- **Per-lens colours by hand.** Not for now (Jeroen). Kept possible: the controls for the
  colours of each lens stay in the profile with `part: 'colour'`, the controller keeps
  accepting `levels` for them, the spider page keeps its lens view, and the colour of a
  lens in the output is still made per lens. A later "lens colours" source would be one more
  way to give a lens a colour next to the palette.
- **A palette per group** next to the shared ones, if a colour is wanted for one group only.
  A palette in the group "All" already colours the spider and the laser in one press.

## Order of building

Each step leaves the repo working and with passing tests.

1. **The palette on its own**: model, resolving a slot (empty is off), cycling with step and
   fade, the `palettes:` section in the show file, tests. Nothing uses it yet.
2. **Light effects**: levels per slot, the compositor, the ten effects ported, the static
   ones added, Spectrum becomes a palette. The spider takes its palette from the rig.
3. **Motion effects**: tilt wave and the scissors out of the light list, Hold, the motor
   speed in Motion, `setsMotorSpeed` removed.
4. **Playback and show**: a palette on per group, old scenes dropped, sequences name a
   palette per group.
5. **Deck and palette page.**
6. **Looks**: the model and the show file, pressing and the changed state, sequences that
   name a look, the row on the deck, storing in Program mode.
7. **The laser**: its own colour setting, and the same split of its effects.

Run against the stand-in bridge and the simulator after each step; nothing here is seen on
the real fixtures until Jeroen has tried it.

## Open

- Where the laser's colours (decisions 12 and 15) are kept so that a scene or look does or
  does not include them: with the laser's own state, in its Colour property, which a
  look cannot name because it names a palette. Proposal: they are not part of a look, and
  the laser's colour is set on its page, as the colours of the lenses were.
- Stepping per beat or per bar is only the speed (÷4 to ×4) of the palette: one step per beat
  is ×1 and one per bar is ÷4.
- Storing a look when a lane was changed by hand since its scene was recalled (see
  "Looks"): refuse, or store a scene first as part of it. The rule of one
  change per beat at speed 1 allows both. Proposal: per bar.
- How a cycle that fades looks at the flash limit.

## Unverified

Everything above. In particular: that a dark background after the hits reads well on the
real spider (it is harder than the 7% dim), and that the nearest-colour snapping on the laser
looks right.
