# Prompt for Claude Design: Lightdeck console

Attach the screenshots in `screenshots/` (listed at the end) together with this text.

---

## Task

Redesign the UI of **Lightdeck**, a self-built lighting console that runs in a browser on an Android tablet. I am not happy with the current look and feel (screenshots attached) and want to work out the design here before it is built. I want it to feel like a **professional DMX lighting console** (think GrandMA3, Avolites Titan, ChamSys, Hog: dense, confident, colour-coded, built for live work), **without the limits of a traditional console**: no fixed rows of physical faders and executors, no 20-year-old menu trees. It is a touch screen, so the layout can follow the task and the moment instead of the hardware. Challenge my current structure if you see a better one.

## Context

- One operator (me, Jeroen, who is also the host and DJ) at a house party, Dreamscape IV on 7 November 2026. I stand at the side of the dance floor with the tablet in one hand, in a dark room, looking at the lights and the people, not at the screen. Presses must be quick and sure, with one thumb or a finger.
- The console drives: a **spider** moving head (8 RGBW lenses on two tilting bars, with beat-synced effects), a **500 mW laser** (dangerous: I operate it by hand, it is never started by an effect or a sequence), **14 Zigbee lamps in 3 rails** (slow scenery under the rest) and a **video wall** (Dreamscape Player, with playlists, videos, effects and a text overlay that shows the artist and track from rekordbox).
- The tempo is tapped or follows rekordbox (bpm and beat lamps are always visible). There is a grand master, a master speed (÷4 ÷2 ×1 ×2 ×4) and a blackout that must always be one press away and unmistakable.
- Main device: Android tablet, 10 to 11 inch, landscape 1280×800 most of the time, portrait 800×1280 sometimes. Touch only, no hover, no keyboard. The same pages also open on a laptop.
- The deadline is hard and there is no framework or build step: the result will be implemented in plain HTML, CSS and JavaScript, so design with CSS custom properties (tokens), flat shapes and simple components. Fonts must be self-hostable (no internet at the party). Currently Barlow; propose something else if it is better.

## Must haves

- **Dark mode only, readable in a dark room.** Black or near-black surfaces, no large bright areas, nothing that makes the operator or the dancers squint. High contrast for what matters, low for what does not. Check small text and disabled states: they are too faint now.
- **Colour-neutral chrome.** Palettes, look swatches and the lens colours are the content and must show truthfully, so the UI itself uses grey and one or two signal colours. Today amber means "chosen or running", red means blackout and danger, green and red are for link lamps. Keep a strict meaning per colour; improve it if you can (for example a distinct state for "on, but changed by hand since", which I call "Varied").
- **Touch.** Targets of at least 48 px, bigger for what is pressed live. **Keys never move** when something appears, changes or is pressed: no layout shifts, notices lie over the screen instead of pushing content.
- **Live feedback.** I want to see what the lights are doing: the beat, the bar, which look and step is on, what comes next and in how many bars, the master level, which fixtures are lit. Today there is almost none of that besides a few lamps.
- **The laser is special.** It must look and behave differently from everything else (it can hurt eyes), and must not be hit by accident.
- **Hierarchy.** What I press during the party (looks, moods, parts of the evening, master, blackout, video wall) is big and first. What I set up beforehand (storing scenes, editing palettes, calibrating, limits, rig details) is out of the way but still there.

## How Lightdeck is organised (use these names)

- **Groups** of fixtures: Spider, Laser, Room, All. Each group has **lanes**: Lights (scenes: effects, strobe), Colour (palettes), Motion, Zone (how far the tilt effects reach). One thing per lane is on at a time, and a lane can be changed under a running one (press a palette while a chase runs).
- **Palettes**: up to 8 colours (or empty = dark), static or cycling (step or fade), shown as strips of swatches.
- **Looks**: one key that sets lights, colour, motion and zone together, with the colours of its palette on it. Looks are grouped in **moods** (Begin, Midden, Techno for the spider; Calm, On the beat, Moving for the laser; Warm and low, Colourful for the room). Under the looks of a mood a **tray** offers what goes with that mood to vary the look: palettes, effects, movements, zones.
- **Parts of the evening** = sequences that change the looks by themselves every N bars: The night, Begin, Midden, Techno, with Next and Hold and a line "Now … · next … in N bars".
- **Video wall**: a tab to play the player's playlists/videos/effects/texts (with preview pictures), its own blackout, a transition choice, and the track text settings.
- **Fixture pages** (spider, laser, room) for manual control and effect speed, a **deck** (Show mode for pressing, Program mode for storing/renaming/deleting), a **palette editor**, a **video wall page** and a **3D simulator** (see screenshots).

Real content to use in mockups: looks "Creeping in", "Candles low", "Heartbeat", "Bounce", "Pump", "Sparkle", "Alternate", "Rolling", "Heartbeat red", "Bounce witch"; palettes "Mid shift", "Halloween", "Witch", "Blood moon", "Void", "Lightning", "Dusk", "Sunset drift", "Techno pulse"; effects Kick, Chase, Bounce, Scan, Cross, Stab, Glow…; room switches Rail 1, Rail 2, Rail 3 and a room dimmer; 126 bpm.

## What I think is wrong with the current design (my reading, please challenge it)

- It looks like a web page made of identical grey rectangles. There is little difference between a look, an effect, a palette, a mode and a setting, so everything reads at the same weight.
- There is no sense of a console: no playback/executor feel, no encoders or fader banks, no overview of what is running right now.
- On the tablet page the looks are cut off by the tray at the bottom, three rows of tabs (parts, groups, moods) stack up, and the tray uses small, low-contrast text.
- The other pages use a generic top bar with eight links, long scrolling pages (the deck is 6000 px tall) and the same key for everything.
- The video wall tab and the room tab use a different layout from the spider tab.

## Deliverables

1. Two or three **directions** in short (mood, density, how a key looks, how state is shown), then a recommendation.
2. For the chosen direction a **design system**: colour tokens (surfaces, text levels, signal colours, state colours), type scale, spacing, and **component states**: key (idle, pressed, on, on-but-varied, disabled, warning), look key, scene key, palette chip/strip, fader (master, room dimmer), speed keys, tab, sequence/part strip with progress in bars, beat lamps, link lamps, tray, notice, blackout, laser-armed state.
3. **Screens** with the real content, landscape 1280×800 and portrait 800×1280 for the first:
   - the live tablet page, for Spider, Laser, Room and Video wall, plus the menu
   - the deck (Show and Program)
   - the spider fixture page (effects, colour, movement/zone)
   - the palette editor
   - something for the simulator toolbar if it falls out of the system
4. A **navigation model**: what is always on the screen, what is one press away and what is behind a menu. Say how I switch between the live page and the setup pages.
5. Short notes for implementation: what can be done in plain CSS, and anything that needs a new component.

## Screenshots (current state, 1280×800 unless noted, a simulated rig at 126 bpm with the part "Midden" running)

- `01-tablet-landscape.png`: the live tablet page, Spider group, mood Midden, with the tray
- `02-tablet-portrait.png`: the same in portrait, 800×1280
- `03-tablet-laser.png`: the Laser tab
- `04-tablet-room.png`: the Room tab with a dimmer and a switch per rail
- `05-tablet-videowall.png`: the Video wall tab (library, track text, settings)
- `07-deck-show.png`, `08-deck-program.png`: the deck, first 1500 px of a very long page
- `09-spider-effects.png`, `10-spider-movement.png`, `11-spider-colour.png`: the spider page, three views
- `12-laser.png`: the laser page
- `13-room.png`: the room page
- `14-palettes.png`: the palette editor
- `15-videowall.png`: the video wall page
- `16-simulator.png`: the 3D simulator

Those screenshots were made with a stand-in for the hardware, so the lamps and the lens previews are mostly dark and there is no real video wall library.
