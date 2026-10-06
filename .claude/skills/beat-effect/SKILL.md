---
name: beat-effect
description: Write or change a beat-synced effect for a lightdeck fixture, or anything about how effects follow the tempo and the speed. Use this whenever Jeroen asks for a new effect, chase, pulse, strobe, wave, build-up or movement, says an effect is too fast, too slow, too busy, too bright or off the beat, or when work touches `src/engine/`, the speed of effects, the master speed or the flash limit. Use it for effects on any fixture, including ones that do not exist yet.
---

# Writing an effect

An effect in lightdeck is a pure function from a moment in the music to what a fixture
shows. Read `src/engine/effects.ts` (the spider: a colour per cell and a tilt per bar)
and `src/engine/laserEffects.ts` (the laser: bytes for the channels it drives) before
writing one. Their headers say what an effect gets and gives.

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

**An effect sets only what it says it sets.** For the spider: the colours of the cells,
and the tilt when `moves` is true. Brightness, the strobe channel and the motor speed
stay with the operator. For the laser: the controls in `drives`, and the rest stays with
the operator, so a colour set by hand goes together with an effect.

**An effect never opens the laser.** It may not drive the mode channel, the controller
refuses one that does, and effects count in manual mode only. A scene may open the
laser, an effect may not. Keep this for any fixture that can hurt: what opens or arms it
is never in `drives`.

**Calm is the default.** Most effects keep a dim floor instead of going to black between
flashes, and use the two colours of the operator instead of their own. Full white, full
strobe and black gaps are what make a room restless.

## Steps

1. **Say what the operator sees, in one sentence.** That sentence becomes `description`
   and is shown on the page. If it takes two sentences, it is two effects.
2. **Say what it does per beat and per bar** before writing code: "one lens per beat,
   the other way on the next bar". Check it against one change per beat.
3. **Write it as a function of `beat`.** `Math.floor(beat)` is the beat number, its
   fraction is the place within the beat, and four beats are a bar. Use the helpers that
   are in the file. Take the cells and bars from the context, never the number eight:
   the tests run every effect with other layouts.
4. **Add it to the list** (`EFFECTS` or `LASER_EFFECTS`) with an id, a name and the
   description. The page takes its effects from `details.effects`, so there is nothing
   to add in the page for a plain effect.
5. **Test it frame by frame**, next to the others in the `*.test.ts`: what it shows on
   the beat, between beats, at the bar, and that it comes back to its start. The tests
   for the whole set (valid colours at any tempo, the same picture for the same moment,
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
