---
name: design-doc
description: Write a design or an implementation plan for lightdeck as a document in `docs/`, and keep Jeroen's decisions apart from proposals. Use this whenever Jeroen asks for a plan, a design, a direction, "how would you", "come up with", "check whether the architecture fits", or says not to build or change anything yet, and whenever a feature is large enough that building it on a guess would be expensive, such as a new protocol, a new kind of fixture, or a change to scenes, sequences, the show file or the deck. Use it also to record a decision he just made.
---

# A design or a plan

Jeroen thinks in designs first. He asks for a plan, reads it, corrects the parts that
are his to decide, and says when to build. The documents in `docs/` are where that
happens: `show-design.md` and `hass-fixtures-plan.md` are the examples to follow.

## Do not build when asked for a plan

"Come up with a plan", "do not change any code", "do not build anything" mean that. A
plan that he accepted is still not the word to build: once, work started after he agreed
with a proposal for the show file, and he had not asked for it. Wait for him to say so.

Reading code, running the tests and trying something in a scratch directory to find out
whether an idea holds are fine, and often needed. Leave the working tree as it was.

## Read before writing

A plan is worth what it knows about the code. Read the files it will touch, and name
them with line numbers where a change lands. The question behind most plans is "does
this fit what is there", and the honest answer usually has two halves: what fits as it
is, and where an assumption is baked in. Find the second half by looking for it: which
types, which constructor, which page assumes the old world.

Read `CLAUDE.md` for the decisions that already bind the design, and the memory for what
was decided in earlier sessions.

## Decisions and proposals

The most useful thing in a design document is that a reader can tell what Jeroen decided
from what was filled in for him.

- A **decision** is something he said. Mark it "(Jeroen)" with the date, in his meaning
  and without stretching it. "No arm switch for the laser" does not decide what a hold
  button does.
- A **proposal** is everything else, and it is marked as one. Give the reason, so he can
  disagree with the reason instead of the conclusion.
- An **open point** is a question the design cannot answer. Put a proposal with it:
  "Do sequences follow the speed? Proposal: no, because a sequence counts real bars."

When a design needs something decided that is his to decide (how the console behaves at
showtime, what is safe, what a word means to him), ask, with a recommendation and what
each choice leads to. When it is a detail with an obvious default, choose, and list it
under what was filled in. The list of what was filled in goes in the reply too, because
that is where he corrects it.

Misreadings have cost more than missing features here. "Controlled faders for fixtures
that have them" was read as a fader per fixture; he meant the dimmers the master works
on. When a sentence of his can be read two ways, say which way it was read.

## What goes in

Take the shape from the two documents that exist. Not every plan needs every part.

| Part | What it holds |
|---|---|
| Status | One line: plan or built, the date, and that decisions marked "Jeroen" are his |
| What it is for | The purpose in the operator's terms, in a few sentences |
| Terms | The words the design uses, when they are new or mean something specific here |
| Decisions | Numbered, each marked as his or as decided earlier |
| What fits as it is | A table: the part, and why it needs no change |
| What has to be refactored | Per file: what it assumes now, what it becomes. With the types where the shape matters |
| New parts | Per file or module: what it does, its interface, the rules it keeps |
| How it behaves | A table of situations: blackout, a scene that does not name it, lightdeck stops, the link is gone |
| Order of building | A table of steps, each with "done when": something that can be seen or measured |
| Tests | What gets tested, per file |
| Open | The questions, each with a proposal |
| Left out on purpose | What a reader might expect and will not find, so it is not taken for forgotten |

Two parts earn their place every time:

- **"Done when"** per step. "Five lamps fade for ten minutes and none lags behind" can be
  checked; "the Zigbee part works" cannot.
- **The risk first.** Order the steps so that what could sink the plan is tried before
  anything is built on it, and so that a refactor that changes no behaviour can be
  committed by itself.

## How it is written

Plain words and short sentences, like the documents that exist: "A scene that does not
name a lamp switches it off." Say what the thing does for the operator before how the
code does it. Tables for anything with more than two attributes; code blocks for types,
file formats and commands. No headings that only announce, and no closing summary.

Write the consequences a reader would not see by himself. "Scenes are complete looks" is
a decision; "so scenes stored before the lamps existed switch the room dark" is what he
needs to hear.

## After it is written

- Tell him where the file is, the changes it asks of existing code, and the list of what
  was filled in for him.
- Save his decisions to memory, with the date and the reason. The next session starts
  without this conversation.
- When he decides something later, put it in the document as a decision, and in
  `CLAUDE.md` when it binds more than this design. Where an older document disagrees,
  the newer one wins; say so in the older one or correct it.
- When a step is built, mark it in the document with what it was verified on. "Built" and
  "ran on the real fixtures" are different states.
