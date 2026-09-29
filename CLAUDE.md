# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

As of 2026-09-29 the DMX path works on real hardware: engine-side code sends universes over a WebSocket to an Android bridge app, which drives the LR512 through the vendor library, and a spider fixture responds. The repo has the normalized fixture model, DMX fixture profiles, the LR512 output client, a CLI to drive the spider by channel name, a web page to control one spider by hand, and ten beat-synced effects that the page can start. The effects have only run against a local stand-in bridge, not on the real spider. There are no scenes or crossfades and no Home Assistant adapter yet. `HANDOFF.md` (Dutch) holds the requirements and early research; where it disagrees with this file or `docs/`, the newer documents win.

## Commands

Node 22, pnpm (version pinned in `package.json`, `corepack enable` picks it up). ESM throughout: relative imports use the `.js` extension even in `.ts` files.

```bash
pnpm install          # esbuild's postinstall is pre-approved in pnpm-workspace.yaml
pnpm dev --bridge ws://<phone-ip>:9010   # spider page on http://localhost:8080, reloads on change
pnpm check            # typecheck + lint + test, run before committing
pnpm typecheck        # tsc --noEmit
pnpm lint             # biome check .   (pnpm lint:fix to auto-format/fix)
pnpm test             # vitest run
pnpm test:watch
pnpm build            # tsc -> dist/, then copies src/server/public to dist/server/public
pnpm start            # node dist/index.js, needs LR512_BRIDGE_URL or --bridge
pnpm spider <phone-ip> dimmer=100 red=100   # drive the spider via the bridge; --list shows channels
```

Settings for `pnpm dev` and `pnpm start`, as flag or environment variable: `--bridge` / `LR512_BRIDGE_URL` (required), `--universe` / `SPIDER_UNIVERSE` (0-based, default 0), `--address` / `SPIDER_ADDRESS` (default 1), `--port` / `PORT` (default 8080), `--host` / `HOST` (default 0.0.0.0).

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
- `src/fixtures/` — DMX fixture profiles. `profile.ts` defines controls (level, 16-bit level, strobe, function) and encodes normalized values into DMX bytes at a start address. `spider.ts` is the spider's 43-channel mode, taken from `docs/spider-dmx-channels.pdf`. Function channels (effects, reset) rest at 0 and only change through an explicit raw value. `SPIDER_LAYOUT` says which cells sit on which bar; LEDs 1 to 4 on bar 1 and 5 to 8 on bar 2 is an assumption, the manual does not say.
- `src/outputs/lr512/` — WebSocket client for the Android bridge. Latest-wins per universe, holds frames back when the socket backs up, reconnects and replays state.
- `src/cli/` — command-line tools that use the above (`spider.ts`).
- `src/server/` — the spider page. `controller.ts` holds the state of one spider, validates changes and pushes encoded universes to the output. `http.ts` serves the page and a small API on Node's own `http` module: browsers POST changes to `/api/update` and hear everyone's changes over server-sent events on `/api/events`. There is no WebSocket server and no login; it is meant for the home network. While an effect is chosen the controller renders it every 25 ms: the effect sets the cell colours, and the tilt when it moves, while brightness, strobe, motor speed and blackout stay with the operator. `/api/update` takes `effect: { id, bpm, rate, colourA, colourB, sync }`; `/api/state` lists the effects and the tempo range; the event stream carries `frame` events (bytes and beat) about 20 times per second while an effect runs.
- `src/server/public/` — the page itself: plain HTML, CSS and browser JavaScript, no build step and no framework. Fonts are self-hosted so the tablet needs no internet. Static files are read once at startup, so restart after editing them unless `pnpm dev` is running. The page takes the bar and lens arrangement from `fixture.layout` in `/api/state`. While an effect runs it draws the lenses from the bytes in the `frame` events, so the drawing shows what is being sent.
- `src/index.ts` — entry point: wires bridge client, controller and HTTP server.
- `src/engine/effects.ts` — ten effects for house and techno: kick, chase, bounce, bar swap, wave, spectrum, sparkle, build-up, strobe burst, scissor. Each is a pure function from beat, tempo and two colours to a colour per cell and an optional tilt per bar, with no timers or state, so they are tested frame by frame. Flashing is limited to `MAX_FLASH_HZ` (10 per second): effects that flash on subdivisions of the beat use `flashesPerBeat` and fall back to a coarser subdivision at high tempo. Keep that limit for any new effect. Scenes, crossfades and holds do not exist yet.
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
- Runs as a container on an existing Kubernetes homelab.
- Operated from a web UI on a tablet.
- Reuse the LR512 if feasible, driven directly without Daslight.
- Kubernetes manifests must **not** set `metadata.namespace`; they are applied into the target namespace.
- Not in scope unless asked: MIDI controller, automatic timeline, exposing entities to Home Assistant.

## Architecture decisions already made

- **One normalized fixture model** for both worlds: attributes 0..1 (dimmer, red, green, blue, white, pan, tilt, strobe), Kelvin absolute. Each protocol gets its own **output adapter**, so the DMX backend (LR512, Art-Net, sACN) is swappable without touching the show.
- **Two speeds.** DMX runs ~40 fps (movement, chases, strobe). Zigbee is the slow ambience layer: at most ~1 command per lamp per second, always with `transition`, global budget ~10 commands/s. On a scene change send the end look once with `transition` equal to the fade time and send nothing during the fade.
- **Scenes are complete looks** with crossfade; effects keep running during fades. Plus hold buttons (flash/strobe while pressed), a master and a blackout.
- **Show as YAML in git** with hot reload. An invalid config must never interrupt the running show.
- **Kubernetes:** `hostNetwork: true` (LAN UDP broadcast/multicast), `replicas: 1`, `strategy: Recreate` (two engines would fight over the DMX universe), pinned to a node on the same LAN.

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

- The number of spiders and their DMX start addresses. The channel layout is known: 43-channel mode, `src/fixtures/spider.ts`. The direction of the motor speed channel (which end is fast) is not in the manual.
- Zigbee `entity_id`s and whether ZHA groups are used.
- Which node/VLAN the container runs on and how HA is reachable from there.

## Milestones

1. Hardware proof: one DMX channel of a spider moves, from Linux. **Done 2026-09-29**, through the Android bridge.
2. Zigbee proof: throttled fade via HA WebSocket with 5+ lamps without saturating the mesh.
3. Engine: scenes, crossfade, effects (breathe, wave, chase, fire flicker, colour transition), holds, master, blackout. Ten party effects exist in `src/engine/effects.ts`; the slow ambience effects, scenes and holds do not.
4. Tablet UI with phases and live output status. A first page exists for manual control of one spider; phases and scenes wait for the engine.
5. Container + manifests, homelab deploy, full dress rehearsal well before 7 November.
