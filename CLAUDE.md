# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

As of 2026-09-29 the DMX path works on real hardware: engine-side code sends universes over a WebSocket to an Android bridge app, which drives the LR512 through the vendor library, and a spider fixture responds. The repo has the normalized fixture model, DMX fixture profiles for the spider and the Alien laser, the LR512 output client, CLIs to drive the spider and the laser by channel name, a web console with one page per fixture to control the spider and the laser by hand, ten beat-synced effects for the spider and five for the laser, which their pages can start. On 2026-09-29 Jeroen ran the console, the effects and the laser on the real spider and the real laser, and it works. Steps 1 to 3 of the show design exist since 2026-09-29: scenes in groups of fixtures, which the deck stores in the show file and sets the fixtures to again, with one scene per group on, and a grand master. That has run against a local server without a bridge and in desktop Chrome, not on the real fixtures and not on a tablet. There are no sequences, no crossfades, no holds and no Home Assistant adapter yet; `docs/show-design.md` holds the design for them and the order of building, with the decisions Jeroen made. `HANDOFF.md` (Dutch) holds the requirements and early research; where it disagrees with this file or `docs/`, the newer documents win.

## Commands

Node 22, pnpm (version pinned in `package.json`, `corepack enable` picks it up). ESM throughout: relative imports use the `.js` extension even in `.ts` files.

```bash
pnpm install          # esbuild's postinstall is pre-approved in pnpm-workspace.yaml
pnpm dev --bridge ws://<phone-ip>:9010   # console on http://localhost:8080, the deck and one page per fixture, reloads on change
pnpm check            # typecheck + lint + test, run before committing
pnpm typecheck        # tsc --noEmit
pnpm lint             # biome check .   (pnpm lint:fix to auto-format/fix)
pnpm test             # vitest run
pnpm test:watch
pnpm build            # tsc -> dist/, then copies src/server/public to dist/server/public
pnpm start            # node dist/index.js, needs LR512_BRIDGE_URL or --bridge
pnpm spider <phone-ip> dimmer=100 red=100   # drive the spider via the bridge; --list shows channels
pnpm laser <phone-ip> mode=manual program=pattern:12   # same for the laser; --list shows channels and range keys
```

Settings for `pnpm dev` and `pnpm start`, as flag or environment variable: `--bridge` / `LR512_BRIDGE_URL` (required), `--universe` / `SPIDER_UNIVERSE` (0-based, default 0), `--address` / `SPIDER_ADDRESS` (default 1), `--laser-address` / `LASER_ADDRESS` (default 44, or `none` to run without the laser), `--laser-universe` / `LASER_UNIVERSE` (default: the spider's), `--show` / `SHOW_FILE` (the show file, default `show.yaml` where lightdeck is started), `--port` / `PORT` (default 8080), `--host` / `HOST` (default 0.0.0.0).

The Android bridge has its own build, see `android-bridge/README.md`:

```bash
cd android-bridge && ./build.sh             # repackages ../lightrider_classic.apk into bridge-gate.apk
```

Run a single test file or test name:

```bash
pnpm vitest run src/model/fixture.test.ts
pnpm vitest run -t "interpolates linearly"
```

Tests live next to the code as `*.test.ts`. Biome handles both lint and formatting; there is no ESLint or Prettier. The `Dockerfile` is a two-stage build producing `node dist/index.js` on `node:22-alpine`.

## Layout

- `src/model/` — the normalized fixture model (0..1 attributes, absolute Kelvin), look application and crossfade blending. Everything else builds on this.
- `src/fixtures/` — DMX fixture profiles. `profile.ts` defines controls (level, 16-bit level, strobe, function) and encodes normalized values into DMX bytes at a start address. `spider.ts` is the spider's 43-channel mode, taken from `docs/spider-dmx-channels.pdf`. Function channels (effects, reset) rest at 0 and only change through an explicit raw value. A byte range of a function channel can have a `key` to choose it by, a `name` for the page, a `scale` or `steps` when the place within the range sets something, and `when` if it only counts while another channel is in a given range; `byteInRange`, `byteForStep` and `rangeAt` turn those into bytes and back. `laser.ts` is the Alien 500 mW RGB laser, 10 channels, taken from `docs/alien-500mw-laser.html`. All its channels are function channels, and channel 1 at rest is "closed light", so the laser is dark until a mode is chosen. `SPIDER_LAYOUT` says which cells sit on which bar; LEDs 1 to 4 on bar 1 and 5 to 8 on bar 2 is an assumption, the manual does not say.
- `src/outputs/patch.ts` — the patch: each fixture claims its channels of a universe and gets an output of its own, so that several controllers can share one universe. Overlapping claims fail at startup.
- `src/outputs/lr512/` — WebSocket client for the Android bridge. Latest-wins per universe, holds frames back when the socket backs up, reconnects and replays state.
- `src/cli/` — command-line tools that use the above (`spider.ts`, `laser.ts`, and `shared.ts` for what they have in common). Each sends its own fixture only, so the other fixture on that universe goes dark.
- `src/server/` — the backend of the console. `rig.ts` is the rig: the list of fixtures and what they share, which is the tempo (`tempo.ts`: bpm, speed of effects, where beat one lies), the blackout and the state of the link to the LR512. The rig owns the patch, so it is the one place where whole universes are put together and handed to the output. Every fixture has a controller that fits `FixtureController` in `fixture.ts`: it holds the state of one fixture, validates changes and encodes its channels. What a state or a change looks like is up to the kind of fixture. `spiderController.ts` takes `levels`, `raw` and `effect: { id, colourA, colourB, speed }`, and while an effect is chosen renders it every 25 ms on the beat of the tempo: the effect sets the cell colours, and the tilt when it moves, while brightness, strobe and motor speed stay with the operator. `laserController.ts` takes `raw: { name: byte }` and `effect: { id, speed }`, is held closed during a blackout, and closes when lightdeck stops, because the bridge keeps holding the last frame. While an effect is chosen and the laser is in manual mode it renders the effect every 25 ms: the effect sets the channels it drives, the others stay with the operator. An effect never opens the laser, and the controller refuses one that names the mode channel; keep that. For scenes every controller has `snapshot` (what a scene keeps of the fixture, without what is at rest), `check` and `recall` (sets the fixture to its part of a scene; what the part does not name goes to rest, and without a part the fixture goes dark). `setMaster` takes the grand master, which like the blackout is kept outside the state and put into what goes out: the spider scales its control with attribute `dimmer` and nothing else, the laser is closed while the master is at 0. `darken` of the laser is final: after it nothing opens the laser again. `playback.ts` is the playback, which the rig owns: it keeps per group which scene is on and whether the fixtures of the group were changed by hand since, and stores, renames, deletes and recalls scenes and makes, renames and deletes groups. A recall sets the fixtures of its group only, and checks every one of them before it changes one. After a recall or off in a group, a scene of another group whose fixtures are all in that group is no longer on; one that shares only some of them stays on and shows as changed. The rig holds the master (`getMaster`, `setMaster`), which starts at 1 every time and is not kept in the show file. `kinds.ts` couples each kind of fixture to its profile and controller. `http.ts` serves the pages and a small API on Node's own `http` module: `GET /api/state`, `POST /api/fixtures/<id>/update`, `POST /api/fixtures/<id>/<action>` (the spider has `reset`), `POST /api/tempo` (`bpm`, `rate`, `sync`), `POST /api/blackout`, `POST /api/master` (`master`, 0 to 1), `POST /api/playback` (`group` with `scene` or with `off: true`), `POST /api/groups` (`label`, `fixtures`), `POST /api/groups/<group>/rename` and `/delete`, `POST /api/groups/<group>/scenes` (`label`, stores the fixtures of the group as they are), `POST /api/groups/<group>/scenes/<scene>/store`, `/rename` and `/delete`, and server-sent events on `/api/events` (`fixture`, `frame`, `tempo`, `blackout`, `master`, `status`, `show`, `playback`). `/` goes to the deck at `/deck`, `/fixtures/<id>` serves the page of that fixture's kind. There is no WebSocket server and no login; it is meant for the home network. To add a kind of fixture: a profile in `src/fixtures/`, a controller, an entry in `kinds.ts`, and a page in `public/fixtures/`. To add a fixture of a known kind: one more definition in `src/index.ts`. Sequences do not exist yet; the playback and the tempo are where they are meant to attach.
- `src/show/` — the show. `show.ts` has what a group and a scene are and reads the data of the file as a show, strictly: a key it does not know is a mistake, and `off` cannot be the id of a scene. A show without a file starts with a group per fixture and one for all of them. A file of step 1, with `scenes:` at the top, is read as those groups with its scenes in the group of all fixtures, and is written in the new form at the first change from the deck. Reading never writes. `file.ts` is the show file: YAML, written by the deck through the document as it was read, so comments and order of a file edited by hand stay. It is watched, and read again before every write. A file with a mistake never replaces the show that runs, and nothing is written to it until it is mended. Laser bytes are plain numbers in the file for now, not the range keys the design asks for.
- `src/server/public/` — the pages: plain HTML, CSS and browser JavaScript, no build step and no framework. There is one page per fixture, and a page holds only what belongs to that fixture: `fixtures/<kind>.html`, `.js` and `.css`. `deck.html`, `.js` and `.css` are the deck: the fader of the master, the keys of the master speed next to it, and a row per group with a key per scene and an off key. It has two modes that the URL hash selects. Show is what it opens in: a press sets the group to the scene, and there is nothing to type and nothing that deletes. Program adds storing, renaming and deleting of scenes and groups, and the off keys wait there. Keys must not move under a finger: notices of the deck and of the shell are in a stack at the bottom of the screen that takes no room of its own. Keep that for anything new on the deck. It starts the shell with `start({ page: 'deck' })`. `changes.js` keeps what a page has changed until the event stream tells of it, and the shell lays that over the state that comes in, so that an event about something else does not set a fader back under the finger; it has a test next to it. `shell.js` is what every page shares and what belongs to no fixture: the links to the other pages, the level of the master, the level of the master speed, the tempo with tap and nudge, the blackout, the link lamps and the notice. It also does the talking to the server, so a page only says what changes and draws what it is told; its interface is described at the top of the file. A page only holds its event stream while it is on screen (`visibilitychange`, `pagehide`): a browser has six connections per server for all its tabs together, and with a stream per open tab going from one page to another took half a minute. Keep that for anything else that holds a connection open. `ui.js` has the sliders, keys, tabs and the channel readout, `styles.css` the shared styles. Jeroen asked for this split on 2026-09-29: fixture pages separate, tempo and speed outside of them. The console is styled as a lighting console, at Jeroen's request: dark graphite, flat panels and keys, one amber signal colour for what is chosen or running, large plain type (Barlow), touch targets of at least 48 px, and nothing decorative. The status bar with the blackout stays on screen. The spider page has an output strip, a section for brightness and strobe and four views (Effects, Colour, Movement, Fixture) that the URL hash selects; it takes the bar and lens arrangement from `details.layout` of its fixture, and while an effect runs it draws the lenses from the bytes in the `frame` events, so the drawing shows what is being sent. The laser page builds its keys and faders from the ranges in the laser profile and has no knowledge of this laser in particular. It shows the mode keys next to the effects from `details.effects`, and while an effect shows, the blocks of the channels it drives show the bytes from the `frame` events and cannot be set. Keep new controls in the console style. Fonts are self-hosted so the tablet needs no internet. Static files are read once at startup, so restart after editing them unless `pnpm dev` is running.
- `src/index.ts` — entry point: reads the settings, lists the fixtures, and wires bridge client, rig and HTTP server.
- `src/engine/effects.ts` — ten effects for house and techno: kick, chase, bounce, bar swap, wave, spectrum, sparkle, build-up, strobe burst, scissor. Each is a pure function from beat, tempo and two colours to a colour per cell and an optional tilt per bar, with no timers or state, so they are tested frame by frame. At speed 1 an effect changes once per beat at most (Jeroen, 2026-09-30, who found the earlier sixteenth notes much too fast): a chase takes one step per beat, a flash comes on the beat, and what moves smoothly takes a bar or more per cycle. So the build-up takes eight bars and the strobe burst four. Faster and slower is a matter of the speed, one of `SPEEDS` (÷4, ÷2, ×1, ×2, ×4), which scales the beat an effect is given. Every effect of a fixture has a speed of its own, which is part of the state and so of a scene, and it multiplies with the master speed (`rate` of the tempo, the same five), which works like the grand master: set on the deck, shown in the status bar of every page, no part of a scene. Whoever renders an effect limits the product with `limitSpeed`, which halves it until a change per beat stays at or below `MAX_FLASH_HZ` (10 per second); that is what keeps the flashing within the limit. Keep both for any new effect: no more than one change per beat at speed 1, and rendered through `limitSpeed`. Crossfades and holds do not exist yet.
- `src/engine/laserEffects.ts` — five effects for the laser: pattern chase, colour chase, pulse, sweep, twist. Each is a pure function from beat, tempo and what the operator set to the bytes of the channels it drives (`drives`), taken from the ranges of the laser profile. They count in manual mode only and change at most once per beat at speed 1. They have a speed per effect and the limit on it like the effects of the spider.
- `src/outputs/` for other protocols (Art-Net, sACN, Home Assistant) does not exist yet.
- `android-bridge/` — the Android app (Java) and its repackaging build. Not part of the pnpm build.
- `tools/` — plain Node scripts for hardware poking: `lr512-send.mjs` (raw channels through the bridge), `lr512-probe.mjs` (DasNet packets straight to the device).

A ~2,000-line TypeScript prototype (`dreamscape-lumen.tar.gz`) exists outside this repo. Jeroen explicitly does **not** want it implemented as-is; use it only as a reference for isolated parts (Art-Net/sACN packet builders, HA WebSocket client, pcap reader) and ask before adopting anything from it.

## What this is

"Lightdeck": a self-built replacement for Daslight 5 that drives two kinds of lighting from one programmable interface, for a home micro-festival (Dreamscape IV, 7 November 2026, deadline is hard):

- **DMX party fixtures** via the Nicolaudie **Light Rider LR512** interface (USB-C + wifi, ports 2430 UDP / 2431 TCP, closed protocol).
- **Zigbee lamps** via **Home Assistant (ZHA)** over the HA WebSocket API.

## Hard constraints (from Jeroen)

- Linux only. No Windows DLLs, Wine or Mac-only tools.
- TypeScript / Node.
- Runs as a container on an existing Kubernetes homelab. **Postponed (Jeroen, 2026-09-29):** for now lightdeck runs on his laptop, with the bridge on a real Android device. Do not work on the container, the manifests or the deploy until he asks.
- Operated from a web UI on a tablet.
- Reuse the LR512 if feasible, driven directly without Daslight.
- Kubernetes manifests must **not** set `metadata.namespace`; they are applied into the target namespace.
- Not in scope unless asked: MIDI controller, automatic timeline, exposing entities to Home Assistant.

## Architecture decisions already made

- **One normalized fixture model** for both worlds: attributes 0..1 (dimmer, red, green, blue, white, pan, tilt, strobe), Kelvin absolute. Each protocol gets its own **output adapter**, so the DMX backend (LR512, Art-Net, sACN) is swappable without touching the show.
- **Two speeds.** DMX runs ~40 fps (movement, chases, strobe). Zigbee is the slow ambience layer: at most ~1 command per lamp per second, always with `transition`, global budget ~10 commands/s. On a scene change send the end look once with `transition` equal to the fade time and send nothing during the fade.
- **Scenes belong to a group of fixtures, and several groups are on at once** (Jeroen, 2026-09-29): one scene per group, a scene sets the fixtures of its group only and is a complete look within it, every group has an off. This takes the place of the earlier rule that a scene is a complete look for the whole rig. A step of a sequence can name scenes of several groups and only sets what changes, so a press by hand wins until the sequence changes that group again. Groups are built, sequences are designed in `docs/show-design.md` and not built. Crossfades, with effects that keep running during them, hold buttons (flash/strobe while pressed), a master and a blackout belong to the design too.
- **One state per fixture** (2026-09-29). A scene sets the fixtures through their controllers, and the operator can still adjust by hand afterwards. There are no layers or priorities.
- **Scenes and sequences may open the laser**, also unattended, and there is no arm switch (Jeroen, 2026-09-29). An effect still never opens it.
- **Grand master:** it scales fixtures that have a dimmer, so what goes out is the brightness of the scene times the master. A fixture without one, such as the laser, is closed at 0 and shows what it is set to above 0. There are no faders per fixture on the deck (Jeroen, 2026-09-29). Built.
- **Tempo** is set by hand or tap. Ableton Link is parked; Jeroen plays with rekordbox, which supports it in Performance mode.
- **The show is one YAML file** that the deck writes and that can still be edited by hand, with hot reload (Jeroen, 2026-09-29). An invalid file must never replace or interrupt the running show. Getting it into git is a copy, not the way of working.
- **Kubernetes** (postponed, see the hard constraints)**:** `hostNetwork: true` (LAN UDP broadcast/multicast), `replicas: 1`, `strategy: Recreate` (two engines would fight over the DMX universe), pinned to a node on the same LAN.

## The LR512 protocol is the main risk

Decision (2026-09-22): reverse-engineer the LR512 protocol rather than buy an Art-Net node. The target is **full live per-channel DMX output**, the way Daslight 5 drives it. Triggering scenes stored on the device (the handoff's "plan A-min" via the STICK UDP protocol) is explicitly **not** acceptable as an end state; at most it is a diagnostic.

Jeroen drives the LR512 with **Daslight 5 on a laptop**, not the Light Rider mobile app. Transport (USB vs wifi) is still unconfirmed. Keep the Art-Net/ESP32 fallback open until the LR512 demonstrably works; only the output adapter should change.

**Resolved (2026-09-29): the LR512 is driven through an Android bridge.** The Light Rider APK was decompiled (`docs/lr512-protocol-findings.md`). The protocol lives in Nicolaudie's native library `libXHardwareLibrary.so`, and live DMX is authenticated and AES-encrypted, so it was not reimplemented. The library is Android-only, including its x86_64 build (Bionic, `libandroid`, asset manager), and no Linux build exists. So it runs where it was built to run: `android-bridge/` repackages the APK with our own classes, which open the device and serve a WebSocket on port 9010. `HANDOFF.md` §6 is superseded.

Facts that cost time to find, keep them in mind when touching the bridge:

- The LR512 identifies as **SIUDI10A** (`uid DAS:SIUDI10A:202457`), sits at 192.168.68.150 and reports **2 universes**, but only the first is usable. The vendor library gives universe `i` `min(512, licensed − i × 512)` channels (`XHL_Siudi10A::buildDongleInfo`), and an LR512 is licensed for 512. Universe index 1 therefore has 0 channels and every `sendDmx` on it returns false with `XHL_DongleLimitation`. Use index 0.
- A `sendDmx` that returns false is not a sign of a lost connection. The original app ignores the return value. The library closes the device itself when the network fails; watch the device state, not the send result.
- Scan like the original: check `enumerateAsyncIsRunning()` before `enumerateAsync()`, never scan while a device is open, open only after the scan has finished. The original sends every universe every 40 ms, changed or not.
- The vendor library must be registered with `setSoftware(XHL_SC_LightRider, "Light Rider", profile)` before `enumerateAsync()`, or discovery returns nothing.
- Discovery is UDP broadcast and the Java API has no connect-by-IP, so the Android runtime must be on the LR512's Wi-Fi. A phone works; Waydroid and emulators sit behind NAT.
- DMX ports must be set to `XHL_Output` before `sendDmx` has any effect.
- Frames are whole universes: 512 bytes, up to 40 per second.

Open: the bridge must stay in the foreground (no foreground service yet). One device drop (`onDeviceLeft`) was seen on 2026-09-29 with unknown cause; the reconnect loop seen later that day was our own bug, see the two points above. See "Known limits" in `android-bridge/README.md`.

`android-bridge/tools/re/` (ignored by git) holds the decompiled Java (`java-src/`, made with jadx) and `xdis.py`, an annotated arm64 disassembler for the vendor library. Use them before guessing how the library behaves.

## Unverified assumptions (confirm with Jeroen before building on them)

Jeroen ran both fixtures on 2026-09-29 and reported that it works. He did not go through the points below one by one, so they stay listed until he confirms or corrects them.

- The number of spiders and their DMX start addresses. The channel layout is known: 43-channel mode, `src/fixtures/spider.ts`. The direction of the motor speed channel (which end is fast) is not in the manual.
- The laser's DMX start address (44 is our default, the fixture itself is set on its display, `A001`-`A512`). Not in its manual and assumed in `src/fixtures/laser.ts`: that the 51 patterns lie evenly on channel 2, five bytes each; what the place within the two automatic colour ranges of channel 9 does; whether channels 3 to 10 count in auto and sound mode; that the second half of channel 10 means dots without lines. Assumed by the laser effects in `src/engine/laserEffects.ts`: that the laser follows a position or size that changes 40 times per second, that channel 9 has seven single colours spread evenly, that position 0 on channel 6 may mean centred, and how fast the rotation speeds are.
- Zigbee `entity_id`s and whether ZHA groups are used.
- Which node/VLAN the container runs on and how HA is reachable from there.

## Milestones

1. Hardware proof: one DMX channel of a spider moves, from Linux. **Done 2026-09-29**, through the Android bridge.
2. Zigbee proof: throttled fade via HA WebSocket with 5+ lamps without saturating the mesh.
3. Engine: scenes, crossfade, effects (breathe, wave, chase, fire flicker, colour transition), holds, master, blackout. Ten party effects for the spider exist in `src/engine/effects.ts` and five for the laser in `src/engine/laserEffects.ts`, and scenes in groups that are stored and recalled, and the grand master; sequences, crossfades, holds and the slow ambience effects do not. The order is in `docs/show-design.md`.
4. Tablet UI with phases and live output status. Pages exist for manual control of one spider and one laser, with tempo, speed and blackout shared, and a deck with the groups, their scenes and the grand master; phases do not.
5. Full dress rehearsal well before 7 November, run from the laptop. Container, manifests and homelab deploy are postponed.
