# The words of the trade

What lighting people say, what it means, and what it is in lightdeck. Use lightdeck's
word in the console and in the code. When Jeroen uses another word, find it here before
assuming it is something new.

"Designed" means it is in `docs/show-design.md` and not built. Check `CLAUDE.md` for what
is built today; this list does not keep up with that.

## The rig

| They say | It means | In lightdeck |
|---|---|---|
| Fixture | One light, laser or other device | Fixture |
| Personality, profile, fixture file | Which channel does what, for one mode of one type | Profile, `src/fixtures/` |
| Mode | A fixture often has several channel layouts, chosen on the fixture | A profile describes one mode: the spider's 43-channel mode |
| Footprint | How many channels a fixture takes | `footprint` |
| Start address | The first channel of the fixture, set on the fixture | `address`, counted from 1 |
| Universe | One DMX line of 512 channels | `universe`, counted from 0. The LR512 has one that works |
| Patch | Which fixture is on which address | The patch, `src/outputs/patch.ts` |
| Coarse and fine | Two channels for one 16-bit value | `fineChannel` of a level control |
| Cell, pixel | One of several lights in a fixture | Cell. The spider has eight |
| Head | The moving part | The spider has two bars that tilt; it has no pan |
| Interface, node, dongle | The box that turns network or USB into DMX | The LR512, behind the Android bridge |

## Intensity

| They say | It means | In lightdeck |
|---|---|---|
| Intensity, dimmer | How bright | The control with attribute `dimmer` |
| Grand master, GM | One fader over everything | Master. Scales fixtures with a dimmer, closes the others at 0 |
| Submaster | A fader over part of the rig | Not there. Jeroen chose no faders per fixture on the deck |
| Blackout, DBO | Everything dark at once, state kept | Blackout |
| Shutter, gate | What lets the light out | For the laser, its mode channel: at rest it is closed |
| Strobe | Fast flashing by the fixture itself | The strobe control. Set by hand, and not limited by lightdeck |

## Programming

| They say | It means | In lightdeck |
|---|---|---|
| Look, cue, scene, preset | A stored state | Scene |
| Group | A set of fixtures chosen together | Group. Here a group also owns its scenes, and one scene per group is on, as in Daslight |
| Programmer | Where you build a look before storing it | The fixture pages. There is no separate layer: what you set is the state |
| Record, store | Keep the look | Store |
| Update | Store the changes into the cue that is on | Store over |
| Release, clear | Let go of what a cue holds | The off key of a group |
| Home, locate | A fixture to a known state | Rest: levels 0, function channels at their idle byte |
| Palette | A colour or position stored once and used by many cues | Not there, left out on purpose |
| Cue list, cue stack, chase | Cues in order | Sequence: steps of "these scenes for N bars" (designed) |
| Tracking | A cue stores only what changes, the rest carries on | A step of a sequence sets only what changes (designed) |
| HTP, LTP | Highest takes precedence, latest takes precedence | Latest: the last press wins. The master multiplies |
| Priority, layers | Which of several sources wins | Not there, on purpose: one state per fixture |
| Fade time, crossfade | How long a change takes | Crossfade (designed). For lamps: the `transition` sent to Home Assistant |
| Snap | A change without a fade | What every change is today |
| Park | Lock a channel at a value, whatever is recalled | Not there |
| Highlight, identify | Flash one fixture to find it | Not there |

## Playing the show

| They say | It means | In lightdeck |
|---|---|---|
| Busking | Running a show by hand, without a fixed order | Pressing scenes on the deck in Show |
| Playback | What runs stored cues | The playback, `src/server/playback.ts` |
| Go | Next cue | Not there; sequences count bars by themselves (designed) |
| Flash, bump | On while pressed | Hold (designed) |
| Tap tempo | Set the speed by tapping the beat | Tap. The last tap is beat one of the bar |
| Rate master, speed master | One control for the speed of all effects | Master speed: ÷4 to ×4, times the speed of each effect |
| Effect, FX, chase | Movement or colour that runs by itself | Effect: a pure function of the beat |
| Phase, bank, page | A set of buttons for a part of the night | Phases as banks (designed) |
| Sound to light | The fixture follows a microphone | The laser's sound mode. Lightdeck has no audio in |

## Safety

| They say | It means | In lightdeck |
|---|---|---|
| Interlock, e-stop | A physical way to kill a laser | Not software. Lightdeck closes the laser on blackout and when it stops, and cannot when it crashes |
| Audience scanning | A laser that reaches people's eyes | A matter of where the laser hangs, not of lightdeck |
| Flash rate | Flashes per second | Effects stay at or below 10, through `limitSpeed` |
