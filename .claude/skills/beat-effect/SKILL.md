---
name: beat-effect
description: Write or change a beat-synced effect for a lightdeck fixture, or anything about how effects follow the tempo and the speed. Use this whenever Jeroen asks for a new effect, chase, pulse, strobe, wave, build-up or movement, says an effect is too fast, too slow, too busy, too bright or off the beat, or when work touches `src/engine/`, the speed of effects, the master speed or the flash limit. Use it for effects on any fixture, including ones that do not exist yet.
---

# Writing an effect

An effect in lightdeck is a pure function from a moment in the music to what a fixture
shows. There are two kinds on a spider and two on the laser, chosen apart and put together
(Jeroen, 2026-10-14, `docs/effects-split-plan.md`): a **light effect** says how much of each
slot of the palette every lens gets (`src/engine/effects.ts`), a **motion effect** tilts the
bars (`src/engine/motionEffects.ts`), and the colours are a **palette** of the show
(`src/engine/palette.ts`) that no effect knows. The laser has its effects of the lights and of
the motion in `src/engine/laserEffects.ts` (bytes for the channels they drive). Read the file
of the kind you write before writing one. Their headers say what an effect gets and gives.

## The rules, and why they are there

**No timers and no state.** The same beat gives the same picture. That is what makes an
effect testable frame by frame, lets two browsers draw the same thing, and lets a
fixture join in the middle of a bar. An effect that needs to remember something is
asking for the beat number instead.

**At speed 1, one change per beat at most.** A chase takes one step per beat, a flash
comes on the beat, and what moves smoothly takes a bar or more per cycle. The first set
of effects ran on sixteenth notes because that seemed right for techno. On the real
fixtures Jeroen found them "much faster than the bpm". His audience likes a slow
build-up, and an operator who wants more asks for it with the speed.

**Faster and slower is the speed, not the effect.** The speeds are ÷4, ÷2, ×1, ×2, ×4:
halves and doubles, because only those keep an effect on the beat. Each effect of a
fixture has a speed that is part of its state, so of a scene. It multiplies with the
master speed of the console. Do not build a fast variant of an effect; build the effect
at one change per beat and let the speed do it.

**Render through `limitSpeed`.** Whoever renders an effect passes the wanted speed
through it, and it halves the speed until a change per beat stays at or below
`MAX_FLASH_HZ`, ten per second. That limit is for the guests: fast flashing is
unpleasant for most and dangerous for some. An effect that flashes more than once per
beat at speed 1 breaks the limit without anyone noticing, which is the other reason for
the rule above.

**An effect sets only what it says it sets, and only what its type owns.** For the spider: a
light effect gives levels per slot and nothing else; a motion effect gives the tilts and the
motor speed (`setsMotorSpeed`), and the tilt is where the bars must END UP, changed once per leg
and not on every frame (Jeroen, 2026-10-20: a tilt that follows the beat makes the motor stutter).
The motor speed is worked out from `motion`, the calibration of the layout, so the move takes the
leg (`pathFrame` in `motionEffects.ts` does it for effects that go to and fro), and it is left
alone when the fixture gives no calibration. The tilts and the
motor speed are properties of the motion type of scene, so a motion effect reaches into no other
type. Brightness and the strobe channel stay with the operator. For the laser: the controls in
`drives`, and the rest stays with the operator, so a colour set by hand goes together with an
effect. A test checks that the controls an effect of the lights drives are of the lights part and
those of a motion effect of the motion part.

**An effect never opens the laser.** It may not drive the mode channel, the controller
refuses one that does, and effects count in manual mode only. A scene may open the
laser, an effect may not. Keep this for any fixture that can hurt: what opens or arms it
is never in `drives`.

**A light effect knows slots, not colours** (Jeroen, 2026-10-14). Slot 1 is what flashes,
hits or moves, slot 2 is what the rest of the lenses show, slot 3 is an accent. The effect
returns, per cell, how much of each slot it gets (`over(level)` is `[level, 1 - level]`,
slot 1 over slot 2), and `paint` in `palette.ts` makes the colours from the palette. A slot
the palette does not have, or has as off, is dark: with one colour a kick is a flash that falls
to dark, not to a dim first colour. An optional accent in slot 3 (the kick on the first beat
of a bar, the tail of the chase, now and then a spark) is used only when the palette has a
third colour (`slots` in the context), and then the effect looks as it does with two. An effect
says how many slots it uses (`slots`) so that the page can say so.

**Calm is the default.** The palette decides what the floor is: an operator who wants the
lenses to fall to a dim colour puts that colour in slot 2, and one who wants a flash on black
leaves it off. Full white, full strobe and black gaps are what make a room restless, so the
palette that a show starts with is a single white and a rainbow, and a new effect is tried with
one colour, with two and with three.

## Steps

1. **Say what the operator sees, in one sentence.** That sentence becomes `description`
   and is shown on the page. If it takes two sentences, it is two effects.
2. **Say what it does per beat and per bar** before writing code: "one lens per beat,
   the other way on the next bar". Check it against one change per beat.
3. **Write it as a function of `beat`.** `Math.floor(beat)` is the beat number, its
   fraction is the place within the beat, and four beats are a bar. Use the helpers that
   are in the file. Take the cells and bars from the context, never the number eight:
   the tests run every effect with other layouts.
4. **Add it to the list** (`EFFECTS`, `MOTION_EFFECTS`, `LASER_EFFECTS` or
   `LASER_MOTION_EFFECTS`) with an id, a name and the description. The pages take their
   effects from `details.effects` and `details.motionEffects`, so there is nothing to add in
   the page for a plain effect.
5. **Test it frame by frame**, next to the others in the `*.test.ts`: what it shows on
   the beat, between beats, at the bar, and that it comes back to its start. For a light
   effect do it through `paint` with one, two and three colours. The tests for the whole set
   (valid levels at any tempo and any palette length, the same picture for the same moment,
   never the mode for the laser, at most one change per beat) run over the new effect by
   themselves. One of them counts the effects, so that number changes.
6. **For the laser, take every byte from a range of the profile** with the helpers in
   `profile.ts`. A byte written as a number in an effect goes wrong when the profile is
   corrected.
7. **Say what was not verified.** An effect that passes its tests has not been seen. How
   it looks on the real LEDs, whether a motor keeps up, whether the laser follows a
   value that changes forty times per second: those go in the list of unverified
   assumptions until Jeroen has looked. See the skill `verify-without-hardware`.

## When Jeroen says an effect is wrong

"Too fast" and "too busy" are about changes per beat: count them. "Off the beat" is
about where beat one lies (the last tap is beat one of the bar) or about a tempo that
drifts. "Too bright" is the floor and the white. Ask which fixture and at what tempo he
saw it, because the limit on the speed makes ×4 at 160 bpm the same as ×2.
