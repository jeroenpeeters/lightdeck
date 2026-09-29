# Lightdeck

A self-built lighting console for small parties. It drives DMX fixtures through a
Nicolaudie Light Rider LR512 interface, from a web page on a tablet, without Daslight or
the Light Rider app. Lamps and switches in Home Assistant are planned.

> **Early work in progress.** Lightdeck is built for one home event with one set of
> hardware. It works on that hardware and has been tested nowhere else. Settings, the API
> and the show file change without notice. Expect to read code.

## What works and what does not

| Part | State |
|---|---|
| Live DMX to the LR512, from Linux | Works on real hardware, through an Android phone as bridge |
| Fixture pages for manual control | Work, for the two fixtures below |
| Beat-synced effects, tap tempo, blackout | Work: ten effects for the spider, five for the laser |
| Scenes: store what the fixtures do, recall it | Built, not yet tested on the real fixtures |
| Sequences, grand master, crossfades, holds | Not built, see [docs/show-design.md](docs/show-design.md) |
| Home Assistant lamps and switches | Not built, see [docs/hass-fixtures-plan.md](docs/hass-fixtures-plan.md) |
| Art-Net, sACN | Not built |
| Running in a container | A `Dockerfile` is there, but this is not a supported way to run it yet |

Fixtures it knows:

- **Spider**: a moving head with 8 RGBW LEDs on two motorised bars, in its 43-channel
  mode.
- **Alien 500 mW RGB laser**, 10 channels.

Other fixtures need a profile of their own, see [Adding a fixture](#adding-a-fixture).

## How it works

```
tablet ──HTTP──▶ Lightdeck ──WebSocket──▶ Android bridge ──Wi-Fi──▶ LR512 ──DMX──▶ fixtures
                 (Node)                   (phone)
```

The LR512 speaks a closed protocol: live DMX is authenticated and encrypted, and the code
for it lives in the vendor's native library, which exists for Android only. Lightdeck
does not reimplement it. A small Android app loads the vendor library, opens the LR512
and serves a WebSocket; lightdeck sends whole DMX universes to that socket. What was
found out about the protocol is in
[docs/lr512-protocol-findings.md](docs/lr512-protocol-findings.md).

## What you need

- A Light Rider **LR512**, on your Wi-Fi.
- An **Android phone** on the same Wi-Fi. Emulators and Waydroid sit behind NAT and do
  not find the LR512.
- The **Light Rider APK**, which you have to get yourself. It is Nicolaudie's software
  and is not part of this repository.
- A computer with **Node 22** and **pnpm**. Lightdeck is developed on Linux.
- To build the bridge: JDK 17 or newer, the Android SDK build-tools, `adb` and
  `baksmali`.

## Getting started

### 1. Build and install the bridge

Put the Light Rider APK in the root of the repository as `lightrider_classic.apk`, then:

```bash
cd android-bridge
./build.sh
adb install -r bridge-gate.apk
```

Open **Lightdeck LR512 Bridge** on the phone and keep it on screen. When the lamp
"LR512" is green the device is open. The log on the screen says where lightdeck has to
connect to, for example `ws://192.168.68.101:9010`.

The bridge uses the package name of the Light Rider app, so the two cannot be installed
next to each other. Details, the wire protocol and the known limits are in
[android-bridge/README.md](android-bridge/README.md).

### 2. Start lightdeck

```bash
git clone https://github.com/jeroenpeeters/lightdeck.git
cd lightdeck
corepack enable
pnpm install
pnpm dev --bridge ws://<phone-ip>:9010
```

### 3. Open the console

Go to `http://<computer-ip>:8080` on the tablet. The console has:

- **Deck**: the scenes. Set the fixtures on their pages, store that as a scene, and get
  it back with one press.
- **A page per fixture**, to set it by hand and to start an effect.
- On every page: the tempo with tap and nudge, the speed of the effects, the blackout,
  and lamps that show whether the bridge and the LR512 are connected.

## Settings

As a flag, or as an environment variable.

| Flag | Environment | Default | What |
|---|---|---|---|
| `--bridge` | `LR512_BRIDGE_URL` | none, required | Where the bridge is: `ws://<phone-ip>:9010` |
| `--universe` | `SPIDER_UNIVERSE` | `0` | Universe of the spider, counted from 0. An LR512 has one usable universe, which is 0 |
| `--address` | `SPIDER_ADDRESS` | `1` | DMX start address of the spider |
| `--laser-address` | `LASER_ADDRESS` | `44` | DMX start address of the laser, or `none` to run without it |
| `--laser-universe` | `LASER_UNIVERSE` | the spider's | Universe of the laser |
| `--show` | `SHOW_FILE` | `show.yaml` | The show file |
| `--port` | `PORT` | `8080` | Port of the console |
| `--host` | `HOST` | `0.0.0.0` | Address to listen on |

Which fixtures there are is set in `src/index.ts`. For now that is one spider and one
laser.

## From the command line

Without the console, to try a fixture or an address:

```bash
pnpm spider <phone-ip> dimmer=100 red=100
pnpm spider --list                                        # the channels by name
pnpm laser <phone-ip> mode=manual program=pattern:12
pnpm laser --list
node tools/lr512-send.mjs <phone-ip> 0 set 6=255 7=255    # raw channels
```

Each of these sends one fixture and zeros for the rest of the universe, so other
fixtures on it go dark.

## The show file

Scenes are kept in one YAML file, which the deck writes and which you can edit by hand.
Lightdeck watches the file. A file with a mistake never replaces the show that is
running: the deck says what is wrong and keeps the show as it was.

```yaml
scenes:
  amber-chase:
    label: Amber chase
    fixtures:
      spider:
        levels: { dimmer: 1 }
        effect:
          id: chase
          colourA: { red: 1, green: 0.58, blue: 0, white: 0 }
          colourB: { red: 0, green: 0.15, blue: 1, white: 0 }
      laser:
        raw: { mode: 95, program: 60 }
```

A scene is a complete look. A fixture that a scene does not name goes dark.

## Safety

- **Lasers can damage eyes.** Lightdeck keeps the laser closed during a blackout and
  closes it when it stops. It cannot do that when it crashes or loses the network: the
  bridge keeps sending the last frame it got. Software is not a safety device. Mount
  the laser so that it cannot reach eyes, and have a way to cut its power.
- **Flashing light.** Effects flash at most 10 times per second. The strobe of a fixture,
  set by hand, is not limited.
- **There is no login.** Anyone who can reach the port can control the lights. Run it on
  a network you trust and do not expose it to the internet.

## Development

```bash
pnpm check         # typecheck, lint and tests: run this before committing
pnpm test:watch
pnpm lint:fix      # Biome formats and fixes
pnpm build         # to dist/
pnpm start         # runs dist/, needs --bridge or LR512_BRIDGE_URL
```

TypeScript on Node 22, ESM, no framework. The pages are plain HTML, CSS and JavaScript
without a build step. Tests are next to the code as `*.test.ts`.

| Where | What |
|---|---|
| `src/model/` | The normalized fixture model: attributes from 0 to 1 |
| `src/fixtures/` | DMX fixture profiles, and the encoding into bytes |
| `src/engine/` | The effects, as pure functions of the beat |
| `src/outputs/` | The patch, and the client for the bridge |
| `src/server/` | The rig, a controller per fixture, the playback, the HTTP API |
| `src/server/public/` | The pages of the console |
| `src/show/` | The show file |
| `src/cli/`, `tools/` | Command-line tools |
| `android-bridge/` | The Android app, with a build of its own |
| `docs/` | Designs, plans and what was found out about the LR512 |

[CLAUDE.md](CLAUDE.md) has the complete and current overview of the code, the decisions
that were made and the assumptions that are not verified yet.

### Adding a fixture

A new kind of fixture is four things: a profile in `src/fixtures/` with its channels from
the manual, a controller in `src/server/` that fits `FixtureController`, an entry in
`src/server/kinds.ts`, and a page in `src/server/public/fixtures/`. One more fixture of a
kind that exists is one more definition in `src/index.ts`.

### Contributing

Issues and pull requests are welcome. The project has a fixed date to be ready for, so
changes that do not serve that may have to wait. Run `pnpm check` before you send
something.

## Built with Claude Code

Lightdeck is developed with [Claude Code](https://claude.com/claude-code), the AI coding
agent of Anthropic. Claude wrote most of the code, the tests and the documentation,
this file included. Jeroen Peeters sets the requirements, makes the decisions, reviews
the work and tests it on the real hardware.

`CLAUDE.md` is the file with instructions that the agent reads at the start of every
session. `HANDOFF.md`, in Dutch, holds the first requirements and research.

## Not affiliated

This is an independent project. It is not affiliated with or endorsed by Nicolaudie,
Anthropic or the makers of the fixtures. Light Rider, LR512 and Daslight are names of
Nicolaudie. The repository contains none of Nicolaudie's software; the bridge uses the
copy you supply.

## License

Copyright 2026 Jeroen Peeters. Licensed under the [Apache License, Version 2.0](LICENSE);
see also [NOTICE](NOTICE).

Two things in the repository are not under that licence:

- The Barlow fonts in `src/server/public/fonts/` are under the SIL Open Font License 1.1,
  see the `LICENSE.txt` next to them.
- The fixture manuals in `docs/` (`spider-dmx-channels.pdf`, `alien-500mw-laser.html`)
  belong to the makers of the fixtures. They are there as the source of the channel
  tables.
