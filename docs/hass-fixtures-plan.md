# Plan: fixtures through Home Assistant

Status: built on 2026-10-18, run only against a stand-in Home Assistant (a small WebSocket
server) and in desktop Chrome; not against a real Home Assistant, real lamps or a tablet.
There is no token and no list of entities yet. Steps 1 to 5 and 7 (in a first form) of
"Order of building" are done; the soak (step 2) and the real fixtures (step 6) are to do.
Written 2026-09-29, rewritten the same day it was built after scene types, groups with
looks, palettes, the grand master and swing limits existed, and after Jeroen asked to treat
the lamps as one fixture with zones in it, the way the spider has two bars. Decisions marked
"Jeroen" were made by him on the date given; the rest is a proposal. Where the build differs
from what this plan first said, the text below says what was built, and "What changed in the
build" lists it.

## What it is for

Theme lighting in the room: lamps with colour (RGBW) and a dimmer, and plain on/off
switches. They are entities in Home Assistant and lightdeck sets them over its WebSocket
API. They take part in scenes, looks, the palettes, the grand master and the blackout like
the spider and the laser do. They also have slow scenery effects of their own.

## Decisions

1. **All the lamps and switches of the room are one fixture, "Room Lights", with a lamp
   for each entity in Home Assistant and zones of lamps in it** (Jeroen, 2026-10-18). It
   takes the place of "a fixture is one entity" (2026-09-29). A lamp is one entity;
   whether that entity is one bulb or a group of Home Assistant is up to Home Assistant,
   and lightdeck does not know the difference. More than one room fixture ("Bar",
   "Ceiling") is allowed if it is ever wanted.
2. **The blackout switches the lamps off** (Jeroen).
3. **The blackout leaves switches alone, unless a switch is set to follow it** (Jeroen).
   That is a setting per switch, off by default.
4. **Lamps and switches stay as they are when lightdeck stops** (Jeroen).
5. **All Home Assistant lamps are on one page** (Jeroen). With one fixture that is the
   page of its kind, like the spider and the laser have, and not a page of its own for the
   rig.
6. **Home Assistant is reachable from the laptop** (Jeroen). The entity ids come later, so
   they are settings and nothing in the code names one.
7. **A switch goes off when a scene does not name it** (Jeroen, 2026-10-18), like every
   other fixture, and so does a lamp. A switch has only Lights, so it is a scene of lights
   that switches it off. Something that must never drop is not a fixture of lightdeck.
8. **The lamps follow the palettes** (Jeroen agreed, 2026-10-18). How the colours of a
   palette are spread over the lamps is the scenery effect's business, see "Palettes".
9. **A switch follows the master at 0 like the blackout, when it is set to follow**
   (Jeroen, 2026-10-18).
10. **The lamps have scenery effects of their own, not the effects of the spider** (Jeroen,
    2026-10-18): the lamps support the spider and the laser, so nothing heavy, only static
    lighting that changes now and then. For example the colours of the palette spread over
    the lamps and, after about 20 beats, they change order. See "Scenery effects".

Decided earlier and still true, see `CLAUDE.md`: at most about 1 command per lamp per
second, always with `transition`, about 10 commands per second in all, and on a scene
change the end look goes out once with the fade time as `transition`.

## Since 2026-09-29

| Built or decided since | What it changes here |
|---|---|
| One fixture with zones (2026-10-18) | One kind `room` instead of `lamp` and `switch`. No page for the whole rig, no `shell.sendTo`, no watching several fixtures: that part of the refactor is gone. One throttle-facing controller owns all the lamps |
| Scene types (lights, motion; colour is the palettes), 2026-10-07 and 2026-10-14 | `snapshot`, `check` and `recall` take a `SceneType`. The room answers for lights; it has no motion |
| Palettes, looks, `takesPalettes` | The room takes palettes: a zone is a slot |
| Grand master (`setMaster`) | In the interface every controller has. Lamps are scaled by it |
| Swing limits (`readLimits`, `setLimits`) | Optional, the spider only |
| `EffectContext` has `cells` and `bars` | The scenery effects of the room use the same shape: the lights are the cells and the zones are the bars. See "Scenery effects" |
| `playback.ts` has grown (looks, palettes, `changed` per lane) | It still knows a fixture by id and controller only. Check this when step 3 is done: it calls `takesPalettes` on every controller |

Not changed: the protocol side (client, throttle, encode, `pnpm lamp`) and the Zigbee
proof. They depend on none of this, which is why steps 1 and 2 can start at once.

## What changed in the build

- **Scenery effects instead of the spider's effects on the lamps** (decision 10). The step
  of this plan that ran the spider's light effects across the zones, with a glide and a
  lower cap on the speed, is not built and is not needed: `roomEffects.ts` has four slow
  effects that change about once a minute, far under the limit of one command per second.
- **Without an effect every light shows the first colour of the palette**, not zone k slot
  k. Zones matter to the effects (`zones` gives each zone one colour) and to the page.
- **`LinkStatus.hass` is optional**: it is left out while no fixture is driven by Home
  Assistant, so the status of a rig without lamps is what it was.
- **The state has `shown`**, the colour each light is sent, for the swatches of the page,
  and the controller emits `state` when a step of an effect moves it.
- **The shell was changed less than planned**: with one fixture the room page is a fixture
  page, so there is no `shell.sendTo`, no watching of several fixtures and no `/room`.
- **`pnpm lamp --soak`** rotates a rainbow over the entities every 250 ms through the
  throttle and reports what was sent, accepted, refused and lost, the latency of the
  answers, and which entities became unavailable.
- **The fork between the plan and the throttle**: the 10 per second limit is a window, so
  ten commands can leave in the same millisecond and then none until the window opens.
  Nothing spaces them within it. Whether the mesh minds is for the soak.

## The fixture

One fixture of the kind `room`.

- **Lamp**: one entity of the domain `light` or `switch`, with an `id` of its own within
  the fixture, a label, and for a switch whether it follows the blackout. A light is
  RGBW, RGB, brightness-only or on/off, which the controller learns from the
  `supported_color_modes` that Home Assistant reports, and encodes accordingly. A switch
  is on or off.
- **Zone**: a named list of lights, like a bar of the spider. A light is in at most one
  zone; lights that are in none form one more zone at the end. Without `zones` all lights
  are one zone. A switch is in no zone, and no effect ever touches a switch, as no effect
  ever opens the laser. A zone is not a group of the playback: groups hold whole fixtures,
  so a scene cannot leave one zone alone and change another; it can switch the lamps it
  does not name off (decision 7). Two room fixtures are the way to get that if it is ever
  needed.
- **Cell**: what the scenery effects count. The cells are the lights in the order of the
  rig file, and `bars` of the effect context are the zones as lists of cell numbers, in
  order along the zone.

## What fits as it is

| Part | Why |
|---|---|
| The methods of `FixtureController`: `update`, `act`, `snapshot`, `check`, `recall`, `setBlackout`, `setMaster`, `darken`, `close`, the `state` event | State and changes are `unknown`; the kind of fixture decides what they look like |
| `src/server/playback.ts`, `src/show/` | They know a fixture by its id and its controller only. The room lands in scenes, looks and the show file without a change there (`takesPalettes`, `snapshot(type)` and `recall(type, part)` are what they ask of a controller) |
| The API: `POST /api/fixtures/<id>/update`, `/api/blackout`, `/api/master`, `/api/playback`, the scenes | By fixture id, with no knowledge of DMX |
| `GET /fixtures/<id>` serving the page of the kind | The room page is `public/fixtures/room.*` and needs no route of its own |
| `src/engine/effects.ts`, `palette.ts`, `effectClock.ts` | Pure, and written for cells and bars. The room feeds them zones. Not needed for the first build |
| `src/model/fixture.ts` | `clamp01` and the attribute names are what a lamp needs |
| `src/outputs/lr512/bridgeClient.ts` | Not reused, but the example to follow: Node's own `WebSocket`, a socket that tests replace, newest wins, reconnect |
| `src/server/tempo.ts`, `engine.ts` | The room asks the engine for frames while an effect runs or a palette cycles |

## What has to be refactored

These are changes to code that exists. None of them changes what the spider and the laser
do; their tests must stay green without edits to what they expect.

### 1. `src/server/fixture.ts`: split the interface

Now `FixtureController` demands `profile`, `universe`, `address`, `getDmx()` and the
`frame` event. Those belong to DMX.

```ts
/** What every fixture has. */
export interface FixtureController {
  /** True when the palettes of the show colour it. */
  readonly takesPalettes: boolean;
  getState(): unknown;
  describe(): Record<string, unknown>;
  update(patch: unknown, origin?: string): void;
  act(name: string, origin?: string): void;
  snapshot(type: SceneType): Record<string, unknown>;
  check(type: SceneType, part: unknown): void;
  recall(type: SceneType, part: unknown, origin?: string): void;
  readLimits?(limits: unknown): unknown;      // the spider only
  setLimits?(limits: unknown): void;
  setBlackout(blackout: boolean): void;
  setMaster(level: number): void;
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
bridge; it becomes "a fixture that must not stay on goes dark here". The comment at the
top of `fixture.ts` stays true for the room: what a scene keeps is up to the controller.

The engine asks a fixture for frames (`wantsFrames()`, `render(at)`, the `wants` event).
Today that is what the spider and the laser do, not part of the interface. The room does
the same, so when the engine's idea of a fixture that animates is written
down as an interface, it goes here and not in the DMX one.

### 2. `src/server/kinds.ts`: a kind says which protocol it speaks

Now `FixtureKind` has a `profile` and `KindOptions` has `output`, `universe`, `address`.

```ts
export type FixtureKind = DmxKind | HassKind;

export interface DmxKind {
  protocol: 'dmx';
  profile: FixtureProfile;
  create(options: DmxKindOptions): DmxFixtureController;   // what KindOptions is now:
                                                           // output, tempo, palettes, universe, address
}

export interface HassKind {
  protocol: 'hass';
  create(options: HassKindOptions): FixtureController;
}

export interface HassKindOptions {
  output: HassOutput;
  tempo: Tempo;
  palettes: PaletteBook;
  lamps: LampDefinition[];
  zones: ZoneDefinition[];
  now?: () => number;
}
```

`spider` and `laser` get `protocol: 'dmx'`. The new entry is `room`.

### 3. `src/server/rig.ts`: definitions, patch, link status

- `FixtureDefinition` becomes a union. What is shared: `id`, `kind`, `label`. A DMX
  definition adds `universe` and `address`, as now. A Home Assistant definition adds
  `lamps` and `zones?`, see "Settings".
- The constructor claims channels from the patch for every fixture (`rig.ts:134`,
  `kind.profile.footprint`). That moves inside `if (kind.protocol === 'dmx')`. For
  `hass` it fails at startup, with a message that says which fixture, when: the rig was
  given no `HassOutput`; an entity is not of the domain `light` or `switch`; an entity
  or a lamp id is used twice (also across two room fixtures); a zone names a lamp that
  is not there, a switch, or a lamp that is in another zone.
- `RigOptions` gets `hass?: HassOutput`. `output` stays what it is.
- The `frame` event is wired for DMX fixtures only. The `fixture` event gives `dmx` for
  DMX fixtures and leaves it out for the others.
- `LinkStatus` gets `hass: 'none' | 'down' | 'refused' | 'connected'`. `none` is no Home
  Assistant fixtures, `refused` is a token that Home Assistant does not take. New method
  `setHassStatus`, next to `setBridgeConnected`.
- `RigFixture` follows the union. `playback.ts` uses `id` and `controller` only and does
  not change.

### 4. `src/server/http.ts`

- `describeFixture` (`http.ts:204`) reads `controller.profile` and `getDmx()`. It
  becomes: `id`, `kind`, `label`, `protocol`, `details`, `state` for every fixture; for
  DMX also `name`, `footprint`, `controls`, `universe`, `address`, `dmx` as now. A Home
  Assistant fixture has the lamps and zones in `details`, from `describe()`.
- The `fixture` events, in the broadcast and in the first burst of `/api/events`, carry
  `dmx` for DMX fixtures only.
- `status` has the new `hass` field through the rig.
- No new route: `/fixtures/<id>` serves the page of the kind, and the kind `room` gets
  `public/fixtures/room.html`.

### 5. `src/server/public/shell.js`

The shell ties a page to one fixture or to none, and the room is one fixture, so the
shell does not become a shell for several. What it needs:

- The list of pages (in `start`, `shell.js:153` on): one link per fixture, as now. Check
  against the links to the palettes, the simulator and the tablet page, which were added
  after the first version of this plan.
- The line "Port, address, channels" is for DMX fixtures only.
- A third lamp in the status bar, "Home Assistant", not shown while `status.hass` is
  `none`.
- The notice (`renderNotice`) now reports a missing bridge on every page. It becomes:
  bridge and LR512 count when a DMX fixture is watched, Home Assistant counts when a
  Home Assistant fixture is watched. `patchNote` is asked for DMX fixtures only. So the
  room page stays quiet about the phone, and the spider page about Home Assistant. The
  deck watches everything and reports both.
- The description of the interface at the top of the file gets the new parts.

### 6. `src/index.ts`

- Reads the new settings and the rig file, see "Settings" below.
- Makes the Home Assistant client when there is at least one such fixture, hands it to
  the rig, passes its status on with `rig.setHassStatus`, starts it next to
  `bridge.start()` and stops it in `shutdown`.
- The lines that log each fixture print address and universe; for a room fixture they
  print the number of lamps and zones.
- `shutdown` calls `rig.darken()`, which does nothing for the room.

### 7. Tests that are touched

`rig.test.ts` and `http.test.ts` build definitions with `universe` and `address`; those
stay valid. They get cases for a rig with both protocols. `src/server/testing.ts` gets a
`RecordingHass` next to `RecordingOutput`.

### Not touched

`src/fixtures/`, `src/outputs/patch.ts`, `src/outputs/lr512/`, `src/cli/` (apart from the
new `lamp.ts`), `src/show/`, `src/server/playback.ts`, the spider and laser pages,
`android-bridge/`. `src/engine/` gets `roomEffects.ts` and nothing else.

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

It fits this, which is what the controller gets:

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

- Light with brightness above 0: `light.turn_on` with `brightness` (1 to 255),
  the colour, and `transition` in seconds.
- Light with brightness 0, or with a colour that is all zeros: `light.turn_off` with
  `transition`.
- The colour follows what the entity reports in `supported_color_modes`: `rgbw` gets
  `rgbw_color`; `rgb`, `xy` and `hs` get `rgb_color` with the white mixed in;
  `brightness` gets no colour; `onoff` gets on or off. Until the entity has reported,
  `rgbw_color` is sent.
- Switch: `switch.turn_on` or `switch.turn_off`, without `transition`.

### `src/server/roomController.ts`, kind `room`

State, all of it set with `update`, in the shape of the spider's where it can be:

```ts
interface RoomState {
  /** Per lamp, 0..1; a switch is on above 0. At rest 0. Lights. */
  levels: Record<string, number>;
  /** Seconds a scene takes to come in. Default 2, 0 to 60. Lights. */
  fade: number;
  /** The scenery effect and its speed, or null. Lights. */
  effect: { id: string; speed: number } | null;
  /** The palette of the show and its pace; null palette is the colours by hand. No scene stores it. */
  colour: { palette: string | null; speed: number | null };
  /** Per light, red, green, blue, white 0..1. By hand, when no palette is set. Left out of scenes. */
  colours: Record<string, { red: number; green: number; blue: number; white: number }>;
  /** What Home Assistant says per lamp. Not part of a look, not set with `update`. */
  reported: Record<string, { available: boolean; on: boolean } | null>;
  /** Why the last command for a lamp did not arrive. */
  problems: Record<string, string | null>;
}
```

- `update` validates like the spider does: unknown keys and unknown lamps are refused,
  numbers are clamped, nothing is applied when a part is wrong. A level for a switch
  is 0 or above 0.
- A change by hand goes out with a fixed `transition` of 1 second, the same as the wait
  per lamp, so a fader that is dragged gives a lamp that glides. `fade` counts for
  `recall`.
- A recall sends the end look once, per lamp that changes, with `transition` equal to
  `fade`, and sends nothing during the fade. Only lamps whose command differs from the
  last one go out, so a scene change that leaves nine lamps alone costs three commands.
- `setBlackout(true)`: `turn_off` with `transition: 0` for every light, and for the
  switches that follow the blackout, urgent. `false`: the look again, with a transition
  of 1 second. The state is kept all the while.
- `setMaster(level)`: what goes out is the brightness of a light times the master, as the
  spider does. A master that is dragged goes out with the 1 second transition of a change
  by hand and the throttle keeps the newest, so it is one command per second per lamp
  and not one per step. A switch that follows the blackout is off while the master is at
  0, as in a blackout; the others do nothing. (A switch has no dimmer, so by the rule
  in `docs/show-design.md` it would otherwise be closed at 0 like the laser; this
  follows the blackout instead, so one setting covers both. Proposal, not decided.)
- `takesPalettes` is true, see "Palettes".
- `darken()`: nothing. `act`: nothing to do, every name is refused.
- A report from Home Assistant changes `reported` and gives a `state` event. It never
  changes `levels`: there is one state per fixture and lightdeck holds it. A lamp that
  somebody set from the Home Assistant app shows on the page as differing, and the next
  change or recall sets it again.
- `describe()` gives the lamps (id, label, entity, domain, colour modes once reported)
  and the zones, for the page.

### Scene types

The same rule as in `show-design.md`: every property belongs to exactly one type.

| Type | Room |
|---|---|
| Lights | `levels` per lamp, `fade`, and the `effect` with its speed |
| Colour | the palette and its pace (set by the playback, stored in no scene); `colours` by hand, left out of scenes like the lenses of the spider |
| Motion | none |

- `snapshot('lights')` gives the lamps whose level is above 0, and `fade` and `effect` when
  they are not at rest. A room with every lamp off gives `{}`. `snapshot('colour')` and
  `snapshot('motion')` are `{}`, and `check` refuses a part of those types that names
  anything.
- `recall('lights', part)` sets `levels` (a lamp the part does not name goes to 0),
  `fade` and `effect`. Without a part every lamp goes off, with the default fade. Colour
  stays as it is, which is what lets a palette be pressed under lamps that are already
  on.
- `recall('colour', ...)` is what the playback uses to set a palette on a group, as for
  the spider.
- A lamp that is off does not get its colour sent. Nothing is sent to it except its
  `turn_off`, so a palette pressed in a group does not light the lamps of that group.

### Palettes

The lamps follow the palettes of the show (decision 8), in the way the spider does:

- **Without an effect** every light shows the first colour of the palette. An empty first
  slot (off) is a light that is off, as it is a dark lens on the spider.
- **With a scenery effect** the effect gives each lamp a slot, and the palette says what the
  slot is, see "Scenery effects".
- **A static palette** sets the lamps once. **A cycling palette** shifts the slots one step at
  its pace, and a lamp moves to its next colour at that step, with a fade as long as the
  `fade` of the room. A lamp changes at most once a second (the throttle), so on a fast
  cycle the lamps skip steps. A palette that fades sends a command per lamp per second for
  as long as it runs: it is the heaviest thing the lamps do, and the soak will tell what the
  mesh makes of it.
- **With no palette** (`colour.palette` is null) the lights show the colours by hand, white
  to start with. A colour by hand is part of no scene.

A switch has no colour and is never in a zone.

### Scenery effects

`src/engine/roomEffects.ts`, in the shape of the light effects of the spider (a pure function
from beat to how much of each slot every cell gets), with the lights as the cells and the zones
as the bars, so that `paint` and the palettes work as they are. Every lamp has exactly one slot.
Every `PERIOD_BEATS` (128) beats, about a minute at 126 bpm (it was 20, until Jeroen said on 2026-10-18 that once a minute is fine and the lamps must not be flooded) at speed 1 the colours move: that is the one change, and the
speed scales it (÷2 is 40 beats, ×2 is 10).

| Effect | What the operator sees |
|---|---|
| `still` | The colours of the palette spread over the lamps: the first lamp the first colour, the next lamp the next, and round again. Nothing moves |
| `rotate` | The same, and every 128 beats each lamp takes the colour of the lamp next to it |
| `shuffle` | The same, and every 128 beats the colours are dealt out again in another order. The first lamp never has the same colour twice in a row |
| `zones` | Every zone has one colour, and every 128 beats the zones take the next colour of the palette |

While the music has stopped the room keeps the picture it had. An effect never touches a
switch.

### Where the fixtures come together

A group names fixtures of any protocol, and `playback.ts` does not look at the protocol:
a group "Room" with the room fixture, and "All" with spider, laser and room, work without
a change there. A look of the group "All" sets a scene of lights, a palette and a scene of
motion on every fixture of the group that has that type (the laser takes no palette, the
room no motion). That is the one press that puts spider, laser and lamps together; a
sequence (step 4 of `show-design.md`, not built) runs such presses on the beat, per group.
Zones are inside the room fixture and are what a scene of lights names its lamps in; they
are not groups.

### The page: `public/fixtures/room.html`, `.js`, `.css`

The page of the kind `room`, at `/fixtures/<id>`, in the style of the console and in the
way of the other fixture pages (the spider page is the model).

- A section per zone, with its lamps as rows in the order of the rig file. A lamp has its
  name, a swatch of what it is showing, a level slider, and a key that opens its colour
  by hand (red, green, blue and white sliders). A switch is a row with one on/off key,
  under the zones.
- The fade time, the palette keys (as on the spider page), and the pace of a cycling
  palette.
- A row shows when its entity is unavailable, unknown to Home Assistant, or differs from
  what lightdeck set.
- Keys for the whole room: all off, "copy this colour to all", and per zone the same.
- One lamp is open at a time, so the page stays short on a tablet with many lamps.
- The keys of the scenery effects, with their speed.
- It uses `shell.send` and the `fixture` events, and `slider` and `button` from `ui.js`.
  Whether the spider's colour controls can be shared is looked at when building; if so
  they move to `ui.js`.

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
  - id: room
    kind: room
    label: Room Lights
    lamps:
      - { id: bar, label: Bar, entity: light.bar }
      - { id: shelf, label: Shelf, entity: light.shelf }
      - { id: ceiling, label: Ceiling, entity: light.living_room }
      - { id: fog, label: Fog machine, entity: switch.fog, blackout: true }
    zones:
      - { id: low, label: Low, lamps: [bar, shelf] }
      - { id: high, label: High, lamps: [ceiling] }
```

The spider and the laser stay on their flags. The definitions in the file are of the same
type as theirs, so they can move into it later.

### `src/cli/lamp.ts`: `pnpm lamp`

By entity, not by lamp of the rig: it is the tool for the proof and for finding out what
the lamps are.

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
| A scene of lights names it | Fades to the level in `fade` seconds | On or off |
| A scene of lights does not name it | Goes off | Goes off (decision 7) |
| A palette is pressed | The zones take their slots | Nothing |
| A scene of motion is pressed | Nothing | Nothing |
| The master moves | Scaled, one command per second at most | Nothing, unless set to follow |
| Lightdeck stops | Stays | Stays |
| Home Assistant is away | State is kept, the page says so, the newest change goes out when it is back | The same |
| The entity is unavailable | The page says so, commands still go out | The same |

**A scene that does not name a lamp or a switch switches it off.** That follows from
"scenes are complete within their type" and is what the spider and the laser do, and
Jeroen confirmed it for switches on 2026-10-18. A scene stored from live holds every lamp
that is on, so it only matters for scenes written by hand and for scenes stored before
the room was added: those switch the room dark. The same goes for looks and for the Off
key of a group.

**Lamps are not on the beat.** A command takes a Zigbee hop and the throttle may hold it
for up to a second, so a scene of lights that the lamps are in lands late and with a fade.
The fade hides it. A sequence step that changes twelve lamps at once queues them through
the 10 per second limit; steps of a bar or more at normal tempo are slow enough, and a
step shorter than that is a matter for the lead and the thinning, not for this plan.

## Order of building

| Step | What | State |
|---|---|---|
| 1 | `src/outputs/hass/`: client, throttle, encode, and `pnpm lamp` | Built and tested, with a stand-in Home Assistant. Not against a real one |
| 2 | The Zigbee proof, milestone 2: `pnpm lamp --soak` | To do: needs the token and five or more real lamps. Done when none becomes unavailable and none lags behind for ten minutes |
| 3 | The refactor: `fixture.ts`, `kinds.ts`, `rig.ts`, `http.ts`, the small changes to `shell.js`, `index.ts` | Built. The tests of the spider and the laser are unchanged except for two lines of `rig.test.ts` that narrow a type |
| 4 | `roomController` (lamps, switches, zones, levels, fade, blackout, master, scene types, palettes, scenery effects), the rig file, the settings | Built |
| 5 | The room page and the lamp for Home Assistant in the status bar | Built; seen in desktop Chrome, not on a tablet |
| 6 | Scenes, looks and the master with the room, on the real fixtures | To do, with real lamps |
| 7 | `CLAUDE.md`: status, settings, layout, the unverified assumptions | Done |

`show-design.md` lists "Zigbee lamps in scenes" in its step 7, after sequences and
crossfades. Here the room is in scenes without crossfades, with a fade of its own; nothing in
the playback had to wait for sequences.

Step 2 carries the risk: if the mesh cannot take the commands, the numbers of the throttle
change. They are settings of the client (`minGapMs`, `perSecond`).

To start it for real: copy `rig.example.yaml` to `rig.yaml` with your own entities, put
`HASS_URL` and `HASS_TOKEN` in the environment, start lightdeck, and open `/fixtures/room`.
`pnpm lamp light.<name> --list` says what Home Assistant knows about an entity and which
colour modes it has.

## Tests

- `throttle.test.ts`: newest wins, the wait per entity, the limit in all, urgent first,
  with a clock of its own.
- `encode.test.ts`: every colour mode, brightness 0, a black colour, the switch.
- `client.test.ts`: with a fake socket as in `bridgeClient.test.ts`: logging in, a
  refused token, a refused command, a reconnect that sends only what waited.
- `roomController.test.ts`: validation, snapshot and recall per type there and back, a
  part of another type refused, the zones and their slots, a lamp that is not named goes
  off, only changed lamps get a command, the blackout, the master, a report that does not
  change the look.
- `rig.test.ts`, `http.test.ts`: a rig with both protocols; an entity of the wrong
  domain, an entity or a lamp id used twice, a zone with an unknown lamp, a switch or a
  lamp of another zone all fail at startup; `/fixtures/<room>` serves the page.
- `playback.test.ts`: a scene of lights over spider, laser and room (a switch off when
  not named), a palette in a group with the room, a look of "All".
- `roomEffects.test.ts`: each effect frame by frame, that every lamp has one slot, that nothing changes inside a period, that `shuffle` never repeats the first lamp's colour.

## Open

- **The colour modes of the real lamps.** Many Zigbee lamps are `xy` with `color_temp` and
  have no white channel of their own. Then the white fader only makes the colour paler.
  `pnpm lamp --list` tells.
- **Colour temperature.** The model has `kelvin`. It is left out, because the request is
  RGBW with a dimmer. It would be one more field per lamp and one more case in `encode.ts`.
- **The fade of a scene.** Here `fade` is kept in the state of the room. When scenes get a
  fade time of their own (crossfades, step 7 of the show design), that time is passed with
  the recall and wins.
- **How the scenery looks.** Whether 128 beats (about a minute) is the pace, and whether `still`, `rotate`,
  `shuffle` and `zones` are the right four, is for the room to say. So is whether a cycling
  palette that fades is wanted on the lamps at all, given what it costs the mesh.
- **A zone to choose from in a scene.** A scene of lights names lamps, not zones. Zones are
  for the effects and the page. If a scene should be able to say "the low lamps", that is a
  new feature.
- **The engine ticks as fast as `maxFps` for the room** while an effect or a cycling palette
  runs, and the room ignores nearly all of those ticks. If that costs anything, a per-fixture
  gap goes into `engine.ts`.

Decided on 2026-10-18 and no longer open: a switch goes off when a scene does not name it
(decision 7), and a switch that follows the blackout follows the master at 0 (decision 9).

## Left out on purpose

Effects for the lamps that are not the scenery effects (breathe, fire flicker, colour
transition as in the milestone list): the scenery effects and palettes cover what the
spider does, the rest waits. Exposing anything to Home Assistant. Finding entities by
browsing Home Assistant from the console. Groups of lamps made in lightdeck beyond the
zones of the fixture: a group of entities is an entity in Home Assistant and can be one
lamp. The prototype (`dreamscape-lumen.tar.gz`) has a Home Assistant client; nothing is
taken from it, the client is written new after `bridgeClient.ts`.

## Added on 2026-10-18, after the first soak and Jeroen's answer

- **The soak showed the budget was wrong.** 14 lamps at 10 commands per second: Home Assistant
  answered about 4 per second, 26 s late on average and 172 s at the end. The throttle now
  follows the answers (one command per lamp on the way, 4 in all, 10 s timeout; the newest wins
  and what the mesh cannot take is dropped), see `src/outputs/hass/throttle.ts`.
- **Calm scenery.** The lamps give atmosphere and a colour change about once a minute is
  enough (Jeroen). The scenery period is 128 beats (`PERIOD_BEATS`), and a cycling palette in the
  room steps once per period as a hard step, whatever it says about fading. A lamp glides to its
  next colour over `fade`.
- **Dimmer of the room.** `dimmer`, 0 to 1, is a second master for the lights of the room, in the
  state but in no scene (a scene does not move it, one that names it is refused). Switches are
  left alone. Brightness = colour × level × dimmer × master.
- **Not decided yet:** a ZHA group (`light.rail1`, `light.rails`) could take one command for a
  whole rail when its lamps want the same thing, which is what a dimmer or a single colour is. It
  would cut the commands by up to five, but lightdeck would have to know which entity is a group
  of which lamps, and a lamp that differs must be left out.
