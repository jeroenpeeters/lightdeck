# Plan: the laser in the simulator

Status: parked, nothing built (2026-10-14). Written after Jeroen asked for the laser in the
simulator and proposed the first step himself: photograph every pattern of the laser and put
the pictures in the project. Decisions marked "Jeroen" are his; the rest is a proposal. No
photo has been taken yet, so everything about what the photos will show is expectation.

## What Jeroen wants

The Alien laser in the simulator at `/simulator`, drawn from the bytes lightdeck sends, the
way the spider is: with or without a bridge, and without the real laser at hand. What it
draws must follow the other channels too, not only the pattern: rotation, the two flips,
the position, the size, the colour and the drawing mode.

His way in (Jeroen, 2026-10-14): go through the 51 patterns by hand, make a picture of each,
put them in a folder in the project named after the pattern number (1 to 51), and let
Claude analyse them to build the simulation.

## Why it is worth doing

- It shows the effects in `src/engine/laserEffects.ts` without the laser in the room.
- The tests below settle guesses that are still open in `CLAUDE.md` and in
  `src/fixtures/laser.ts`: how the 51 patterns lie over channel 2, what position 0 on
  channel 6 means, how fast the rotation speeds are, what the two automatic colour ranges
  of channel 9 do, and whether "dots without lines" is what channel 10 does.

## What is known and what is not

The manual (`docs/alien-500mw-laser.html`) is short. It calls the laser "single head RGB
scanning + pattern, 2 in 1" (500 mW RGB scanning, and a pattern head with red 200 mW and
green 100 mW). It does not say which of the 51 patterns come from which head. Channels:

| Channel | Does | What the manual leaves open |
|---|---|---|
| 1 | mode: closed, manual, auto, sound | |
| 2 | manual: 51 patterns; auto and sound: 4 programs | how the 51 lie on 0..255 (assumed five bytes each) |
| 3 | rotation: angle (0..127), spin forward (128..191), spin back (192..255) | degrees per byte, where 0 is, degrees per second |
| 4, 5 | flip H, flip V: position (0..127), speed (128..255) | a mirror or a 3D flip that narrows the pattern |
| 6, 7 | position H, V: position (0..127), speed (128..255) | what the middle is, how far it goes |
| 8 | size: fixed (0..63, larger byte is smaller), grow, shrink, zoom | the size range, the speeds |
| 9 | colour: single, mix, single auto, auto | which colours, what the place in the range does |
| 10 | drawing: dots and lines, or dots only | |

## What a photo gives and what it does not

A photo of the pattern on a wall gives its shape and its colours, at one setting. It gives
nothing about how the channels act on the shape, and nothing about movement. So three kinds
of material are needed, not one:

1. **The shapes**: one photo per pattern, everything else fixed.
2. **The behaviour of the channels**: a few photos of one asymmetric pattern at several
   bytes per channel, and a few combinations (rotated, then moved) to learn the order in
   which they act.
3. **The speeds**: short videos, from which frames are taken with ffmpeg (`beat-eval`
   needs it already) and the angle or position measured over time.

Not drawn, as with the spider's own programs: the laser's auto and sound programs 1 to 4.
The simulator says so. A filmed clip of each could approximate them later; not planned.

## How to shoot

- Dark room, matte white wall, the laser square to the wall, the camera next to the laser.
- Measure the distance laser to wall and write it down. Put a ruler or a taped 1 m mark in
  the frame. With the distance and the width on the wall the angles can be worked out,
  which the simulator needs.
- Camera exposure by hand (Pro mode): low ISO, about 1/10 s, the same for every photo, so
  that the whole shape is drawn and the lines are not blown out to white.
- Everything else on the laser fixed and written down: mode manual, rotation, flips and
  position at the same byte every time, size at its largest if the pattern fits in the
  frame (else note the size byte), colour one fixed setting.
- Files named after the pattern number: `01.jpg` to `51.jpg`. Together with a list of the
  channel 2 byte sent for each (the key pressed on the laser page tells it).
- Safety: 500 mW is dangerous to eyes. No glass, mirrors or people in the beam, and not into
  the lens of the camera.

## Pilot (do this before the 51)

Goal: find out whether the method works before anyone shoots 51 pictures that turn out to
be unusable. About 15 pictures and one clip:

| What | Pictures |
|---|---|
| Shapes | three patterns, far apart: 1, one in the middle (26), 51 |
| Rotation angle | one asymmetric pattern (an arrow, or anything with an obvious top) at bytes 0, 32, 64, 96, 127 |
| Position H | the same pattern at 0, 64, 127 |
| Size | the same pattern at 0 and 63 |
| Flip H | the same pattern at 0 and 64 |
| Colour | the same pattern at two bytes of channel 9, one in the single range and one in the mix range |
| Spin | a clip of 10 seconds, rotation byte 160 (forward) |

Notes next to the pictures: the wall distance, the camera and its exposure, the bytes.

What Claude does with it, and what decides whether the method works:

- Can the shape be cut out as a clean mask (threshold, crop, scale from the ruler)? If the
  lines are blown out, too faint or smeared, say what to change in the camera settings.
- Can the angle of rotation be measured from the five pictures, and does it come out
  linear in the byte?
- Can the speed be got from the clip with ffmpeg?
- Does the pilot already say something about the flip (mirror or narrowing) and the
  middle of the position range?

The pilot ends with a short note in this file: what worked, what to shoot differently, and
the list of the full series that follows.

## The full series

After the pilot is accepted:

- The 51 shapes, and the channel 2 byte for each. An open question for the pilot is how
  to find the boundaries between patterns; options are a few boundary bytes (4/5, 9/10,
  254/255) or a video that steps the byte one value at a time, from which the whole map
  can be read.
- The behaviour series for channels 3 to 8, five bytes each, plus combinations.
- Speed clips for spin forward and back, flip speed, move speed, grow, shrink and zoom.
- Channel 9, a picture per range and a clip of the two automatic ranges.
- Channel 10, dots only on about five patterns, enough to see the rule.

## How the simulator would use it

Built after the pictures exist, in the shape the spider has:

- A module without a browser in it, like `spiderPose.js` (with a test and a `.d.ts`), that
  turns the bytes of the laser profile into what to show: pattern, colour, drawing mode,
  rotation, flips, position and size, and the motion for the speed ranges (a constant
  speed, like `stepToward`). Its numbers come from the series above.
- Processed textures in `src/server/public/` (small PNG masks, one per pattern), loaded by
  the simulator.
- The drawing: the pattern as a texture, added to the picture with additive blending, on a
  wall or a floor in the scene; and, if Jeroen wants it, the beams in the air as a fan
  from the laser to the points of the shape (what haze shows). The laser's place and
  direction are set like those of the spider (TransformControls).
- A mention in `CLAUDE.md` of what is calibrated and what is guessed, as for the spider.

## Open questions for Jeroen

1. Which phone or camera, and can it set the exposure by hand?
2. Do the 51 patterns come from both heads of the laser? (The photos will show, but he may
   know.)
3. How will the laser stand at the party: on a stand aiming at a wall, at the ceiling, at
   the audience? Will there be haze?
4. Only the pattern on a wall or floor plane, or the beams in the air too?
5. Where do the photos live? The raw ones are large (51 times several MB): in
   `docs/laser-photos/` outside git, or reduced, or in git as they are? The processed
   textures are small and belong in git.

## What this cannot give

Brightness, and how the beams look to the eye in a smoky room. The simulator would be right
about shape, colour and movement and nothing more. Everything it draws stays unverified
against the real laser until Jeroen has compared them side by side.
