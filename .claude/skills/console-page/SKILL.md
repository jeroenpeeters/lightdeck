---
name: console-page
description: Build or change a page of the lightdeck console, the plain HTML, CSS and browser JavaScript in `src/server/public/`. Use this whenever work touches the deck, a fixture page, the shell, the status bar, faders, keys, notices or the styles, when Jeroen says something in the console looks wrong, jumps, lags, is hard to hit or hard to read, and when a new page or control is needed. Use it too when a server change adds something the pages have to show, such as a new event or a new field in the state.
---

# A page of the console

The console is used on a tablet, in the dark, by someone who is doing something else.
Read the skill `lighting-operator` for what that asks of a design. This skill is how the
pages are built.

## How the pages are put together

Plain HTML, CSS and JavaScript modules. No framework and no build step, so what is in
`src/server/public/` is what the browser gets. Read the comment at the top of each file
before changing it; they describe the interface and are kept up to date.

| File | What it is |
|---|---|
| `shell.js` | What every page shares: the status bar, the links to the pages, tempo, blackout, the link lamps, the notice. It also does all the talking to the server. A page calls `start()` and gets back what it needs |
| `changes.js` | Keeps what the page changed until the event stream tells of it, so a fader is not set back under the finger |
| `ui.js` | What controls are built from: `slider`, `button`, `speedKeys`, `views`, `renderReadout` |
| `styles.css` | The shared styles and the tokens: colours, sizes, the touch size |
| `deck.*` | The deck: groups, scenes, the master, the master speed, in Show and Program |
| `fixtures/<kind>.*` | One page per kind of fixture, with only what belongs to that fixture |

Where a thing belongs: what is about one fixture goes in its page; what is about no
fixture (tempo, blackout, the master, the links) goes in the shell; what the show is
about goes on the deck. A fixture never goes into the page of another fixture. Jeroen
asked for this split, and it is what lets fixtures be added without touching the others.

## A page says what changes and draws what it is told

The server holds the state. A page sends a change with `shell.send(patch)` or
`shell.ask(url, body)` and draws what comes back as an event. Do not keep a second copy
of the state in the page and do not `fetch` around the shell: the shell merges changes,
tries again after a failure, skips the page's own echo, and knows what is still on its
way.

Three things that were each found the hard way:

- **A fader must not jump back under the finger.** The answer to a request and the
  events come over different connections, so an older event can arrive after the answer.
  `changes.js` lays what is still on its way over the state that comes in. Anything new
  that the operator drags has to go through it.
- **A page holds its event stream only while it is on screen.** A browser has six
  connections per server for all its tabs together. With a stream per open tab, going
  from one page to another took half a minute. The shell closes the stream on
  `visibilitychange` and `pagehide` and opens it again. Do not add anything else that
  keeps a connection open.
- **While an effect runs, draw from the `frame` events**, which carry the bytes that are
  being sent. The picture then shows what the fixture gets, not what the page thinks.

## The look

Jeroen rejected a themed, decorative first design as too playful. The console looks
like a lighting console and nothing else:

- Graphite ground, flat panels, rectangular keys. The tokens are at the top of
  `styles.css`; use them and do not add colours beside them.
- **Amber is the one signal colour**: what is chosen or running. Green and red are for
  the links and the blackout. A second accent colour makes the first mean nothing.
- Barlow, self-hosted, so the tablet needs no internet. Large and plain.
- Touch targets of at least `--touch` (48 px).
- The status bar with the blackout stays on screen.
- Nothing decorative: no gradients, glows, icons for their own sake, or animation that
  does not show a state.

## Keys do not move

A key keeps its place and its size whatever happens. On the deck the notices sit in a
stack at the bottom of the screen that takes no room of its own, because a notice that
pushed the keys down turned a press on a scene into a press on another. Before adding
anything that appears and disappears (a notice, a hint, a second line of text in a key),
ask where the things below it go. Reserve the room or lay it over.

The same goes for text that changes length. A key whose label changes with its state
gets wider or narrower and moves its neighbours, unless it has a width that fits the
longest label. Check this for every key that says something else when pressed.

## Words

Short, in the operator's words, and they say what to do. "The bridge app does not answer.
Open Lightdeck LR512 Bridge on the phone and keep it on screen." Messages of the server
that reach the operator (`PatchError`) follow the same rule.

A control has a visible name, and a key that shows a state has `aria-pressed`. That is
for screen readers, and it is also what the styles and a check in the browser hold on
to.

## Checking a page

Static files are read once when the server starts. `pnpm dev` restarts on a change; a
server started another way has to be restarted.

A page that passes `pnpm check` has not been looked at. Look at it, with the skill
`verify-without-hardware`: start lightdeck against the stand-in bridge and take
screenshots at the size of a tablet, landscape and portrait. Then check by hand what a
screenshot cannot show:

- Drag a fader while something else changes the state. Does it stay under the finger?
- Open the page twice. Does the second follow the first?
- Stop the stand-in bridge. Does the page say what is wrong, and did any key move?
- Go from page to page with several tabs open. Is it quick?

`changes.js` has a test next to it and is written without anything of the browser so
that it can have one. Logic that is worth testing goes in a file like that; what touches
the document stays thin.

Say in the report what was looked at and how: a headless screenshot, desktop Chrome, or
the real tablet. Only Jeroen has the tablet.
