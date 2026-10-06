---
name: lighting-operator
description: Think like the lighting operator who has to run a show on lightdeck. Use this whenever you design, build or review anything the operator touches or sees (the deck, fixture pages, scenes, groups, sequences, holds, the master, effects, tempo, blackout, notices), whenever a feature for showtime is proposed, and whenever Jeroen asks what a light technician would want, which tool is missing, or how a real lighting console does something. Use it before proposing a design too, even when the request does not mention an operator.
---

# The lighting operator

Lightdeck is a tool for one person at a lighting console. Code that is correct can still
be wrong for that person: a key that moves, a scene that takes a fixture it should not,
an effect that is four times too fast. This skill is the operator's point of view. Take
it before designing and again before saying something is done.

## Who the operator is

Jeroen, at his own party. That shapes everything:

- **He is the host, and he plays the music** (rekordbox). The console is not what he
  looks at. The show has to run by itself for stretches and be changed with one press
  when he walks past.
- **One tablet, in a dark and loud room.** Large keys, readable at a glance, nothing
  that needs a keyboard at showtime.
- **His audience likes a slow build-up without overstimulation.** Calm is the default.
  Fast and bright is something the operator asks for.
- **He knows Daslight.** When he describes how something should work, he often means how
  Daslight does it. Ask, or look it up, before inventing something else.
- **The date is fixed.** A tool he can use next week is worth more than a better one in
  December.

## How to use this point of view

1. Find the phase of the work the change belongs to, in the list below. What the
   operator needs differs per phase, and most mistakes come from building a programming
   tool into a showtime screen or the other way round.
2. Walk through it as the operator: what do I see, what do I press, what happens on the
   fixtures, what do I see after? Do this for the plain case and for the case where
   something is wrong (link down, a fixture that does not answer, a wrong press).
3. Hold it against the principles. Where it breaks one, either change the design or say
   why it is worth it.
4. **Propose, do not decide.** How the console should behave is Jeroen's taste and his
   night. Write a proposal, mark it as one, and give the reason. This is not politeness:
   several things were built on a guess and had to be redone (effects on sixteenth
   notes, a fader per fixture on the deck, a laser view inside the spider page).

## The phases of the work

| Phase | The situation | What the operator needs |
|---|---|---|
| **Rig and patch** | Hanging fixtures, setting addresses | To know which address and how many channels each fixture has; a refusal at startup when two overlap; a way to tell which fixture is which |
| **Test** | Does every fixture answer, does every channel do what the manual says | One fixture at a time, by channel name; the bytes that go out; a reset |
| **Program** | Daylight, time, standing at the fixture | Set a look by hand, store it, name it, change it, throw it away. Typing is fine. Deleting is fine, with a second press |
| **Rehearse** | Running it on real music | To see that changes land on the beat, that nothing is too fast or too bright, and to correct a scene in seconds |
| **Show** | Dark, loud, distracted, no second chance | One press per change. Nothing to type, nothing that deletes, nothing that moves. Blackout within reach. What is on, visible at a glance |
| **When it goes wrong** | A link drops, a fixture hangs | To be told what is wrong and what to do, in one sentence. The lights keep what they had, and come back by themselves |

## Principles

Each of these comes from how consoles are used, and most were learned here the hard way.

**What the console shows is what is being sent.** An operator trusts the screen instead
of looking up. Draw from the bytes that go out, with the master and the blackout in
them, and say why when less goes out than what is set.

**A press does one thing, and the operator can say beforehand what.** A scene sets the
fixtures of its group and no others. A recall either sets every fixture of the group or
none: check first, then change.

**The last press wins.** There is one state per fixture and no hidden layers. What the
operator sets by hand stays until something sets it again, and the console shows that a
scene was changed by hand.

**Showtime and programming are different jobs.** The deck opens in Show, where nothing
deletes and nothing asks for a name. Program is a choice.

**Keys do not move under a finger.** A notice that pushes the keys down turns a press on
"scene 3" into a press on "off". Notices go where they take no room, and a key keeps its
size and place whatever state it is in.

**The master and the blackout are not part of a scene.** They belong to the operator's
hand at that moment. A scene never moves them, and they change no scene.

**The beat is the measure.** At normal speed an effect changes once per beat at most.
Faster and slower go in halves and doubles, because only those stay on the beat.

**Dark means dark, and off means off.** Blackout darkens everything that can hurt or
blind. An effect never opens the laser. Flashing stays at or below ten per second.
Software is not a safety device, so never present it as one.

**Fail visibly and keep the state.** When the bridge is gone, say so and say what to do
("open the bridge app on the phone"). Keep what was set and send it when the link is
back. A show file with a mistake never replaces the show that is running.

**Slow fixtures are another instrument.** Lamps over Zigbee fade; they do not chase.
Give them fades and few commands, not the tools of the DMX fixtures.

**One colour means "on".** Amber is what is chosen or running. Green and red are for the
links and the blackout. Anything decorative costs readability in the dark.

**Say it in the operator's words.** "The bridge app does not answer", not "WebSocket
closed". A message that says what is wrong also says what to do.

## Before calling it done

Ask these as the operator, and answer them honestly:

- Can I do this with one press, in the dark, without reading?
- Do I know what will happen before I press?
- After the press, can I see that it happened, and what is on now?
- Can a wrong press do damage? Does anything delete, open the laser, or go dark without
  being asked?
- Did anything on the screen move?
- What do I see when the link is down, and does it come back by itself?
- Is the default the calm one?
- Was it run on the real fixtures, or only on a stand-in? Say which.

## More

- `references/vocabulary.md`: the words of the trade and what they are called in
  lightdeck. Read it when Jeroen uses a term from Daslight or another console, or when
  naming something new.
- `references/toolbox.md`: the tools an operator relies on per phase, which of them
  lightdeck has, and which could be proposed. Read it when asked what is missing or
  what to build next.

The decisions that were made are in `CLAUDE.md` and `docs/show-design.md`. They win over
this skill where they differ: this is how operators work in general, those are what
Jeroen chose.
