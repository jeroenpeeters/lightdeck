# Plan: fixtures through Home Assistant

Status: plan, nothing of this is built. Written 2026-09-29. Decisions marked "Jeroen" were
made by him on that date; the rest is a proposal.

## What it is for

Theme lighting in the room: lamps with colour (RGBW) and a dimmer, and plain on/off
switches. They are entities in Home Assistant and lightdeck sets them over its WebSocket
API. They have no movement, no strobe and no effects on the beat. They take part in
scenes and in the blackout like the spider and the laser do.

## Decisions

1. **A fixture is one entity in Home Assistant** (Jeroen). Whether that entity is one lamp
   or a group is up to Home Assistant; lightdeck does not know the difference.
2. **The blackout switches the lamps off** (Jeroen).
3. **The blackout leaves switches alone, unless a switch is set to follow it** (Jeroen).
   That is a setting per switch, off by default.
4. **Lamps and switches stay as they are when lightdeck stops** (Jeroen).
5. **All Home Assistant fixtures are on one page** (Jeroen), not a page per fixture. The
   spider and the laser keep their own pages.
6. **Home Assistant is reachable from the laptop** (Jeroen). The entity ids come later, so
   they are settings and nothing in the code names one.

Decided earlier and still true, see `CLAUDE.md`: at most about 1 command per lamp per
second, always with `transition`, about 10 commands per second in all, and on a scene
change the end look goes out once with the fade time as `transition`.

## What fits as it is

| Part | Why |
|---|---|
| The methods of `FixtureController`: `update`, `act`, `snapshot`, `check`, `recall`, `setBlackout`, `darken`, `close`, the `state` event | State and changes are `unknown`; the kind of fixture decides what they look like |
| `src/server/playback.ts`, `src/show/` | They know a fixture by its id and its controller only. Lamps land in scenes and in the show file without a change there |
| The API: `POST /api/fixtures/<id>/update`, `/api/blackout`, `/api/playback`, the scenes | By fixture id, with no knowledge of DMX |
| `src/model/fixture.ts` | `clamp01` and the attribute names are what a lamp needs. `blend` is for the crossfade later |
| `src/outputs/lr512/bridgeClient.ts` | Not reused, but the example to follow: Node's own `WebSocket`, a socket that tests replace, newest wins, reconnect |
| `src/server/tempo.ts` | Not needed by the lamps at first. Slow effects can take it later |

## What has to be refactored

These are changes to code that exists. None of them changes what the spider and the laser
do; their tests must stay green without edits to what they expect.

### 1. `src/server/fixture.ts`: split the interface

Now `FixtureController` demands `profile`, `universe`, `address`, `getDmx()` and the
`frame` event. Those belong to DMX.

```ts
/** What every fixture has. */
export interface FixtureController {
  getState(): unknown;
  describe(): Record<string, unknown>;
  update(patch: unknown, origin?: string): void;
  act(name: string, origin?: string): void;
  snapshot(): Record<string, unknown>;
  check(part: unknown): void;
  recall(part: unknown, origin?: string): void;
  setBlackout(blackout: boolean): void;
  darken(): void;
  close(): void;
  on(event: 'state', listener: (state: unknown, origin?: string) => void): unknown;
}

/** A fixture on a DMX universe. */
export interface DmxFixtureController extends FixtureController {
  readonly profile: FixtureProfile;
  readonly universe: number;
  readonly address: number;
  getDmx(): number[];
  on(event: 'state', listener: (state: unknown, origin?: string) => void): unknown;
  on(event: 'frame', listener: (dmx: number[], beat: number) => void): unknown;
}
```

`SpiderController` and `LaserController` change `implements FixtureController` into
`implements DmxFixtureController` and nothing else. The comment at `darken` names the
bridge; it becomes "a fixture that must not stay on goes dark here".

### 2. `src/server/kinds.ts`: a kind says which protocol it speaks

Now `FixtureKind` has a `profile` and `KindOptions` has `output`, `universe`, `address`.

```ts
export type FixtureKind = DmxKind | HassKind;

export interface DmxKind {
  protocol: 'dmx';
  profile: FixtureProfile;
  create(options: DmxKindOptions): DmxFixtureController;   // what KindOptions is now
}

export interface HassKind {
  protocol: 'hass';
  /** The entity must be of this domain: `light` or `switch`. */
  domain: string;
  create(options: HassKindOptions): FixtureController;
}

export interface HassKindOptions {
  output: HassOutput;
  entity: string;
  /** Whether the fixture goes off in a blackout. */
  blackout: boolean;
  now?: () => number;
}
```

`spider` and `laser` get `protocol: 'dmx'`. New entries: `lamp` and `switch`.

### 3. `src/server/rig.ts`: definitions, patch, link status

- `FixtureDefinition` becomes a union. What is shared: `id`, `kind`, `label`. A DMX
  definition adds `universe` and `address`, as now. A Home Assistant definition adds
  `entity` and, for a switch, `blackout?: boolean`.
- The constructor now claims channels from the patch for every fixture (`rig.ts:92`,
  `kind.profile.footprint`). That moves inside `if (kind.protocol === 'dmx')`. For
  `hass` it checks that the entity id starts with the domain of the kind (`light.` for a
  lamp) and that the rig was given a `HassOutput`, and fails at startup otherwise, with
  a message that says which fixture.
- `RigOptions` gets `hass?: HassOutput`. `output` stays what it is.
- The `frame` event is wired for DMX fixtures only. The `fixture` event gives `dmx` for
  DMX fixtures and leaves it out for the others.
- `LinkStatus` gets `hass: 'none' | 'down' | 'refused' | 'connected'`. `none` is no Home
  Assistant fixtures, `refused` is a token that Home Assistant does not take. New method
  `setHassStatus`, next to `setBridgeConnected`.
- `RigFixture` follows the union. `playback.ts` uses `id` and `controller` only and does
  not change.

### 4. `src/server/http.ts`

- `describeFixture` (`http.ts:135`) reads `controller.profile` and `getDmx()`. It
  becomes: `id`, `kind`, `label`, `protocol`, `details`, `state` for every fixture; for
  DMX also `name`, `footprint`, `controls`, `universe`, `address`, `dmx` as now; for
  Home Assistant also `entity`.
- The `fixture` events, in the broadcast and in the first burst of `/api/events`, carry
  `dmx` for DMX fixtures only.
- New route `GET /room`, which serves `room.html`, like `/deck`.
- `GET /fixtures/<id>` for a Home Assistant fixture goes to `/room` with a 302, because
  there is no page per lamp.
- `describe` leaves out nothing; `status` has the new `hass` field through the rig.

### 5. `src/server/public/shell.js`

The shell ties a page to one fixture or to none. The room page is about several.

- `start({ page: 'room' })`. `watched` becomes the Home Assistant fixtures; for the deck
  it stays all fixtures, for a fixture page that fixture.
- The `fixture` handler now drops every message that is not for `id` (`shell.js:278`).
  It becomes: pass on what is for a watched fixture, with `id` in the message. The
  spider and laser pages do not read `id` and stay as they are. `reload()` tells every
  watched fixture, not one.
- New `shell.sendTo(id, patch)`: a `sender` per fixture, made when first used, with the
  same merging and retrying as `shell.send`. `shell.send` stays for the pages of one
  fixture.
- The list of pages (`shell.js:134`): the deck, one link per DMX fixture, and one link
  "Room" when there is a Home Assistant fixture.
- The line "Port, address, channels" (`shell.js:155`) is for DMX fixtures only.
- A third lamp in the status bar, "Home Assistant", not shown while `status.hass` is
  `none`.
- The notice (`renderNotice`) now reports a missing bridge on every page. It becomes:
  bridge and LR512 count when a DMX fixture is watched, Home Assistant counts when one
  of its fixtures is watched. `patchNote` is asked for DMX fixtures only. So the room
  page stays quiet about the phone, and the spider page about Home Assistant. The deck
  watches everything and reports both.
- The description of the interface at the top of the file gets the new parts.

### 6. `src/index.ts`

- Reads the new settings and the rig file, see "Settings" below.
- Makes the Home Assistant client when there is at least one such fixture, hands it to
  the rig, passes its status on with `rig.setHassStatus`, starts it next to
  `bridge.start()` and stops it in `shutdown`.
- The lines that log each fixture print address and universe; for a Home Assistant
  fixture they print the entity.
- `shutdown` calls `rig.darken()`, which does nothing for lamps and switches.

### 7. Tests that are touched

`rig.test.ts` and `http.test.ts` build definitions with `universe` and `address`; those
stay valid. They get cases for a rig with both protocols. `src/server/testing.ts` gets a
`RecordingHass` next to `RecordingOutput`.

### Not touched

`src/fixtures/`, `src/outputs/patch.ts`, `src/outputs/lr512/`, `src/engine/`, `src/cli/`,
`src/show/`, `src/server/playback.ts`, `src/server/tempo.ts`, the spider and laser pages,
`android-bridge/`.

## New parts

### `src/outputs/hass/client.ts`: the connection

A WebSocket client for `ws://<host>:8123/api/websocket`, on Node's own `WebSocket`, with
a `socketFactory` that tests replace, as in `bridgeClient.ts`. No new dependency.

- Logs in: Home Assistant says `auth_required`, the client answers with the token, and
  gets `auth_ok` or `auth_invalid`. After `auth_invalid` it does not keep trying every
  second; the status is `refused` and it tries again slowly.
- `call_service` with a number per message, and reads the `result` that comes back with
  that number. A refusal is logged and reaches the fixture as a problem.
- Asks `get_states` once after logging in and follows `state_changed` from then on, for
  the entities of the rig only. Should a busy Home Assistant send too much,
  `subscribe_trigger` with the entity ids filters on the server.
- Reconnects with a growing wait. After a reconnect it does **not** send every lamp
  again: the lamps kept their state, and sending all of them at once is what the budget
  is there to prevent. Only what was still waiting goes out.
- When Home Assistant cannot be reached at startup, lightdeck starts all the same. The
  DMX side must never wait for it.

It fits this, which is what the controllers get:

```ts
export interface HassCommand {
  domain: string;                       // light, switch
  service: 'turn_on' | 'turn_off';
  data?: Record<string, unknown>;       // brightness, rgbw_color, transition
}

export interface EntityReport {
  /** False while Home Assistant calls it unavailable or does not know it. */
  available: boolean;
  on: boolean;
  /** `supported_color_modes` of a light, empty for a switch. */
  colourModes: string[];
}

export interface HassOutput {
  /** The newest command for an entity. What was waiting for it is dropped. */
  setEntity(entity: string, command: HassCommand, options?: { urgent?: boolean }): void;
  watch(entity: string, listener: (report: EntityReport | undefined) => void): void;
}
```

### `src/outputs/hass/throttle.ts`: the budget

Pure, with a clock that is passed in, so that it is tested without waiting.

- One place per entity, newest wins.
- An entity gets its next command no sooner than 1000 ms after its last.
- No more than 10 commands per second in all. Who waited longest goes first.
- `urgent`, which the blackout uses, goes to the front and does not wait for the second
  of its entity. It still counts for the 10 per second, because that limit protects the
  mesh. Twelve lamps are dark in little over a second; a group is dark at once.
- Both numbers are settings of the throttle, not constants spread through the code.

### `src/outputs/hass/encode.ts`: from look to command

Pure functions, tested per case.

- Lamp with dimmer above 0: `light.turn_on` with `brightness` (1 to 255),
  the colour, and `transition` in seconds.
- Lamp with dimmer 0, or with a colour that is all zeros: `light.turn_off` with
  `transition`.
- The colour follows what the entity reports in `supported_color_modes`: `rgbw` gets
  `rgbw_color`; `rgb`, `xy` and `hs` get `rgb_color` with the white mixed in;
  `brightness` gets no colour; `onoff` gets on or off. Until the entity has reported,
  `rgbw_color` is sent.
- Switch: `switch.turn_on` or `switch.turn_off`, without `transition`.

### `src/server/lampController.ts`, kind `lamp`

State, all of it set with `update`:

```ts
interface LampState {
  dimmer: number;                                   // 0..1, at rest 0
  colour: { red: number; green: number; blue: number; white: number };   // 0..1
  /** Seconds a scene takes to come in on this lamp. */
  fade: number;                                     // default 2, 0 to 60
  /** What Home Assistant says. Not part of a look, not set with `update`. */
  reported: { available: boolean; on: boolean } | null;
  /** Why the last command did not arrive, or null. */
  problem: string | null;
}
```

- `update` validates like the spider does: unknown keys are refused, numbers are
  clamped, nothing is applied when a part is wrong.
- A change by hand goes out with a fixed `transition` of 1 second, the same as the wait
  per lamp, so a fader that is dragged gives a lamp that glides. `fade` counts for
  `recall`.
- `snapshot`: a lamp with dimmer 0 gives `{}`. Otherwise `dimmer`, `colour`, and `fade`
  when it is not the default.
- `recall`: starts from rest, sends the end look once with `transition` equal to `fade`,
  and sends nothing during the fade. Without a part the lamp goes off, with its default
  fade.
- `setBlackout(true)`: `turn_off` with `transition: 0`, urgent. `false`: the look again,
  with a transition of 1 second. The state is kept all the while.
- `darken()`: nothing.
- `act`: nothing to do, every name is refused.
- A report from Home Assistant changes `reported` and gives a `state` event. It never
  changes `dimmer` or `colour`: there is one state per fixture and lightdeck holds it.
  A lamp that somebody set from the Home Assistant app shows on the page as differing,
  and the next change or recall sets it again.

### `src/server/switchController.ts`, kind `switch`

- State: `on` (at rest false), `reported`, `problem`.
- `snapshot`: `{}` when off, `{ on: true }` when on.
- `setBlackout`: does nothing, unless the definition says `blackout: true`; then it is
  off during the blackout and as set after it.
- `darken()`: nothing.

### The page: `public/room.html`, `room.js`, `room.css`

One page at `/room` for every Home Assistant fixture, in the style of the console.

- A row per fixture, in the order of the rig file. A lamp has its name, a swatch of what
  it is set to, a dimmer, and a key that opens its colour: red, green, blue and white
  faders and the fade time. A switch has its name and one on/off key.
- One fixture is open at a time, so the page stays short on a tablet with many lamps.
- A row shows when the entity is unavailable, unknown to Home Assistant, or differs from
  what lightdeck set.
- Keys for all lamps at once: off, and "copy this colour to all".
- It uses `shell.sendTo` and the `fixture` events, and `slider` and `button` from
  `ui.js`. Whether the spider's colour controls can be shared is looked at when
  building; if so they move to `ui.js`.

### Settings

| Flag | Environment | What |
|---|---|---|
| `--hass` | `HASS_URL` | `ws://homeassistant.local:8123/api/websocket`. Needed when the rig file has fixtures |
| | `HASS_TOKEN` | A long-lived access token of Home Assistant. Environment only: a flag shows in the list of processes, and a file ends up in git |
| `--rig` | `RIG_FILE` | The rig file, default `rig.yaml` where lightdeck is started. No file means no Home Assistant fixtures |

The rig file is read once, at startup. It is not the show file: the show is what was
programmed, the rig is what hangs in the room.

```yaml
fixtures:
  - { id: bar, kind: lamp, label: Bar, entity: light.bar }
  - { id: ceiling, kind: lamp, label: Ceiling, entity: light.living_room }
  - { id: fog, kind: switch, label: Fog machine, entity: switch.fog, blackout: true }
```

The spider and the laser stay on their flags. The definitions in the file are of the same
type as theirs, so they can move into it later.

### `src/cli/lamp.ts`: `pnpm lamp`

```bash
pnpm lamp light.bar dimmer=50 red=100 fade=2
pnpm lamp light.bar --list                      # what Home Assistant says about the entity
pnpm lamp light.a light.b light.c light.d light.e --soak 10    # the Zigbee proof
```

`--soak` fades the entities through colours for that many minutes, through the throttle,
and reports what was sent, what was refused, how long the answers took, and which lamps
became unavailable.

## How it behaves

| When | Lamp | Switch |
|---|---|---|
| Blackout on | Off at once | Stays, or off when set to follow |
| Blackout off | Back to what it is set to, in 1 second | As set |
| A scene names it | Fades to the look in `fade` seconds | On or off |
| A scene does not name it | Goes off | Goes off |
| Lightdeck stops | Stays | Stays |
| Home Assistant is away | State is kept, the page says so, the newest change goes out when it is back | The same |
| The entity is unavailable | The page says so, commands still go out | The same |

**A scene that does not name a lamp switches it off.** That follows from "scenes are
complete looks" and is what the spider and the laser do. A scene stored from live holds
every lamp that is on, so it only matters for scenes written by hand and for scenes stored
before the lamps were added: those switch the room dark.

## Order of building

| Step | What | Done when |
|---|---|---|
| 1 | `src/outputs/hass/`: client, throttle, encode, and `pnpm lamp` | One real lamp takes a colour and a fade from the command line |
| 2 | The Zigbee proof, milestone 2: `pnpm lamp --soak` | Five or more lamps fade for ten minutes; none becomes unavailable and none lags behind |
| 3 | The refactor: `fixture.ts`, `kinds.ts`, `rig.ts`, `http.ts`, `shell.js`, `index.ts` | `pnpm check` is green, the spider and the laser work as before, and no test of theirs was changed |
| 4 | `lampController`, `switchController`, the rig file, the settings | A lamp and a switch are set with `POST /api/fixtures/<id>/update`, and the blackout does what the table says |
| 5 | The room page and the third link lamp | The room is set from the tablet |
| 6 | Scenes with lamps, on the real fixtures | A scene with spider, laser and lamps comes back with one press, the lamps fading in |
| 7 | `CLAUDE.md`: status, settings, layout, the unverified assumptions | |

Step 1 and 2 come first because they carry the risk: if the mesh cannot take it, the
numbers of the throttle change before anything is built on them. Step 3 changes no
behaviour and can be committed by itself.

## Tests

- `throttle.test.ts`: newest wins, the wait per entity, the limit in all, urgent first,
  with a clock of its own.
- `encode.test.ts`: every colour mode, dimmer 0, a black colour, the switch.
- `client.test.ts`: with a fake socket as in `bridgeClient.test.ts`: logging in, a
  refused token, a refused command, a reconnect that sends only what waited.
- `lampController.test.ts`, `switchController.test.ts`: validation, snapshot and recall
  there and back, the blackout, a report that does not change the look.
- `rig.test.ts`, `http.test.ts`: a rig with both protocols, a lamp entity on a switch
  kind fails at startup, `/room`, `/fixtures/<lamp>` goes to `/room`.
- `playback.test.ts`: a scene over spider, laser and a lamp.

## Open

- **The colour modes of the real lamps.** Many Zigbee lamps are `xy` with `color_temp`
  and have no white channel of their own. Then the white fader only makes the colour
  paler. `pnpm lamp --list` tells, in step 1.
- **Colour temperature.** The model has `kelvin`. It is left out at first, because the
  request is RGBW with a dimmer. It would be one more field in `LampState` and one more
  case in `encode.ts`.
- **The grand master**, when it is built. A lamp has a dimmer and is scaled. A switch has
  none; by the rule in `docs/show-design.md` it would go off with the master at 0.
  Proposal: a switch does at master 0 what it does in a blackout, so it follows only
  when set to.
- **The fade of a scene.** Here `fade` is kept per lamp. When scenes get a fade time of
  their own, step 6 of the show design, that time is passed with the recall and wins.
- **Does a switch go off when a scene does not name it?** This plan says yes, like every
  fixture. If a switch powers something that must never drop, it should not be a fixture
  of lightdeck at all.

## Left out on purpose

Effects for the lamps (breathe, wave, colour transition), which are milestone 3. Exposing
anything to Home Assistant. Finding entities by browsing Home Assistant from the console.
Groups made in lightdeck: a group is an entity in Home Assistant. The prototype
(`dreamscape-lumen.tar.gz`) has a Home Assistant client; nothing is taken from it, the
client is written new after `bridgeClient.ts`.
