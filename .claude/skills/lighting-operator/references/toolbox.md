# The operator's toolbox

What an operator reaches for in each phase, and where lightdeck stands. The state column
was true on 2026-10-02. Check `CLAUDE.md` before relying on it.

Everything marked "idea" is a proposal to bring to Jeroen, with a reason and a guess of
the size. None of it is decided, and none of it should be built because it is listed
here. The date of the event decides what is worth it.

## Rig and patch

| Tool | Why an operator wants it | State |
|---|---|---|
| A patch list | To see which fixture has which address | In `/api/state` and on each fixture page. No overview page |
| Overlap check | Two fixtures on the same channels fight, and it looks like a broken fixture | Built: refused at startup |
| Addresses without editing code | A fixture gets moved on the day | Flags for the spider and the laser. A rig file is in the Home Assistant plan |
| Identify | "Which one is spider 2?" Flash one fixture, leave the rest | Idea. Small: an action on the controller that overrides the output for a moment |

## Test

| Tool | Why | State |
|---|---|---|
| Drive one fixture by channel name | The first minutes with a fixture are checking the manual against the thing | Built: `pnpm spider`, `pnpm laser`, and the fixture pages |
| Raw channels | When the profile itself is in doubt | Built: `tools/lr512-send.mjs` |
| Readout of what is sent | To tell "lightdeck sends the wrong byte" from "the fixture ignores it" | Built: the readout on the fixture pages |
| Reset | A moving fixture that lost its position | Built for the spider |
| Channel check | Walk through all channels of a fixture one by one, at full | Idea. Mostly useful for a new fixture; the CLI does it by hand |
| A test sheet per fixture | So that a hardware test checks every assumption once, not "it works" | Idea. See the skill `verify-without-hardware` for the form |

## Program

| Tool | Why | State |
|---|---|---|
| Store from live | Building a look is done by eye, on the fixture | Built |
| Store over, rename, delete | A scene is never right the first time | Built, in Program |
| "Changed by hand" | To know that what is on is no longer the scene | Built |
| Groups | To mix the scenes of fixtures freely | Built |
| A file to edit by hand | Bulk changes, copies, a backup | Built: the show file, with hot reload |
| Copy a scene | A variation starts from an existing look | Idea. Recall, change, store as new does it today |
| Order of scenes on the deck | The order of the night, left to right | Follows the file. Reordering from the deck is an idea |

## Rehearse

| Tool | Why | State |
|---|---|---|
| Tempo by tap, nudge | To get on the beat and stay there | Built |
| Tempo from the DJ software | A tapped tempo drifts over minutes | See `CLAUDE.md` for the state of Ableton Link |
| Sequences | The show has to run while the host is elsewhere | Designed, next in the order of building |
| Change on the next bar | A change in the middle of a bar looks like a mistake | Designed |
| Where a sequence is | Which step, how many bars to go | Belongs with sequences |

## Show

| Tool | Why | State |
|---|---|---|
| One key per scene, per group | One press per change | Built |
| Off per group | To take one fixture out without a blackout | Built |
| Master | To bring the whole room down and up by hand | Built |
| Master speed | To calm down or push every effect at once | Built |
| Blackout on every page | The one key that must never be searched for | Built |
| Holds | A burst while pressed, the scene back on release | Designed |
| Phases as banks | The night has parts; show the keys of this part only | Designed |
| A lock on Program | So a stray press at 23:00 cannot delete a scene | Idea. Show mode has no deleting; a lock would also keep Program away |
| A copy of the show before doors | The deck writes the file; one bad evening of editing should not cost the show | Idea. A dated copy at startup would do |

## When it goes wrong

| Tool | Why | State |
|---|---|---|
| Link lamps | To see at a glance whether the lights can be reached | Built: bridge and LR512 |
| A sentence that says what to do | Nobody debugs during a party | Built for the bridge, the LR512 and the show file |
| State kept and sent again | The lights come back as they were | Built in the bridge client and the bridge |
| The laser closed when lightdeck stops | Nobody at the controls | Built. Not covered: a crash, or a lost network, because the bridge holds the last frame |
| A timeout in the bridge | The gap above | Idea, in the Android app: close the laser after some seconds without lightdeck |
| A check before doors | Links up, every fixture answers, the show file reads, the tempo source is the one meant | Idea. One page, or one command |
