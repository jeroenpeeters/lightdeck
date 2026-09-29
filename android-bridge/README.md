# LR512 Android bridge

An Android app that lets the lightdeck engine drive the Light Rider LR512. It
loads Nicolaudie's own `libXHardwareLibrary.so`, opens the LR512 over Wi-Fi, and
exposes a WebSocket on port 9010. The engine streams DMX universes to that
socket; the vendor library does the login and encryption towards the device.

Background: `../docs/lr512-protocol-findings.md` and
`../docs/lr512-android-bridge-plan.md`.

**Verified on hardware (Pixel 9 Pro, 2026-09-29):** the app discovers and opens
the LR512 (`uid DAS:SIUDI10A:202457`, 2 DMX universes, no licensing refusal) and
a fixture responds to frames sent through the WebSocket. The automatic
reconnect described below builds and is unit-tested on the engine side, but has
not yet been seen recovering a real device drop.

## What the app does

- **Startup** mirrors the real Light Rider app: `libXHW()`, `setSoftware(
  XHL_SC_LightRider, "Light Rider", profile)`, `setAssetManager`,
  `initializeSushi()`, `addCallBackHotPlug`, `enumerateAsync()`. Skipping
  `setSoftware` makes discovery return nothing.
- **WebSocket server** starts right away and does not depend on the device. The
  engine can connect, and stay connected, while the LR512 is away.
- **Supervisor** keeps one device open. When the device leaves or is no longer
  open, it detaches, scans again and reopens. No restart of the app is needed.
  It scans the way the original app does: not while a scan is running, not
  while a device is open, and it opens only after the scan has finished.
- **A failed send is not a lost connection.** It is logged with the library's
  own reason, at most every 10 seconds per universe, and counted in the stats.
  The library closes the device itself when the network fails, and that is
  what the supervisor reacts to.
- **State is kept.** The bridge remembers the latest frame per universe and
  replays it after a reconnect.
- **Ports are set to output mode** on attach. Without it `sendDmx` is accepted
  and nothing leaves the DMX port.
- **The screen stays on** while the app is visible, and the app holds Wi-Fi and
  CPU wake locks.

The core lives in the process, not in the Activity. Rotating the phone or
reopening the screen does not start a second copy.

## Wire protocol

| Direction | Type | Content |
|---|---|---|
| engine to bridge | binary | `[universe: 1 byte][512 DMX bytes]`, 513 bytes |
| bridge to engine | text | `{"type":"status","device":"open"\|"lost","universes":N,"channels":[512,0]}` |

The universe byte is a 0-based index. The status message is sent on connect and
whenever the device is attached or detached. `channels` is how many channels
the device's licence allows per universe.

**Only universe 0 works on an LR512.** The device reports two universes, but it
is licensed for 512 channels and the vendor library hands those out in order:
512 to the first universe, 0 to the second. The library refuses every frame for
a universe with 0 channels. The bridge ignores such frames and says so in the
log, once.

**Throttling.** Receiving never waits for DMX. A frame overwrites the pending
frame of its universe. A pump sends the newest frame per universe at up to 40
per second, so a flood is reduced to the latest state and nothing queues up.

**Refresh.** A universe that has received data is sent again every 100 ms even
when it did not change. A universe that never received data is left alone, so
starting the bridge does not black out fixtures.

One engine connection at a time. A new connection replaces the old one.

## Build

Prerequisites:

- **JDK 17+** (`javac`, `keytool`). Built here with JDK 21.
- **Android SDK build-tools 35.0.0 or newer** and one platform `android.jar`:
  `sdkmanager "build-tools;35.0.0" "platforms;android-34"`. The `d8` in 34.0.0
  crashes on classes compiled by JDK 21. `build.sh` picks the newest installed
  build-tools. Point it at the SDK with `ANDROID_SDK_ROOT`, or set
  `BUILD_TOOLS` and `ANDROID_JAR`.
- **adb**, and a system `baksmali` (or set `BAKSMALI_JAR`).

`build.sh` downloads `apktool.jar` (2.11.1) and `dex2jar` into `./tools/` when
missing. The Debian `apktool` 2.7.0 cannot rebuild this APK.

```bash
cd android-bridge
./build.sh                      # uses ../lightrider_classic.apk
```

Output: `bridge-gate.apk`, debug-signed, about 69 MB.

### How the build works

The original Light Rider APK is repackaged with our classes added. That keeps
the vendor's JNI classes `com.lightingsoft.xhl.*`, the `.so` and the firmware
in `assets/` byte-identical. dex2jar only provides a compile classpath; its
output is never packaged.

Three things the build has to get right:

- Our classes go into the **next contiguous dex** (`classes2.dex`). Android
  skips a dex that leaves a gap in the numbering, and the class is then missing
  at runtime.
- The original launcher is removed, so the app shows one icon, **LR512 Gate**.
- `WAKE_LOCK` is added to the manifest.

The package name stays `com.lightingsoft.djapp`, so the app cannot be installed
next to the official Light Rider app. Uninstall one first.

## Run

The phone has to be on the same Wi-Fi as the LR512. Discovery is a UDP
broadcast and the vendor's Java API has no way to connect by IP.

```bash
adb install -r bridge-gate.apk
adb shell am start -n com.lightingsoft.djapp/nl.lightdeck.bridge.OpenGateActivity
adb logcat -s LR512GATE
```

Lines to look for:

```
>>> Bridge up. Point the engine at  ws://192.168.68.101:9010
Opening: name=LR512 2022-2026 type=SIUDI10A bus=BT_DasNet uid=DAS:SIUDI10A:202457
Bridge: universe 0: 512 channels licensed, ioMode was ..., setIoMode(Output)=true, now XHL_Output
Bridge: universe 1: 0 channels licensed, ioMode was ..., setIoMode(Output)=true, now XHL_Output
>>> Device open and attached. DMX is live.
```

After a drop:

```
onDeviceLeft: LR512 2022-2026 (bus reported as ...)
>>> Device lost: device left. Reconnecting automatically...
Searching for the LR512 (DasNet)...
>>> Device open and attached. DMX is live.
```

Every 10 seconds with traffic the bridge logs received, sent and failed frame
counts. The same log is on screen and in
`/sdcard/Android/data/com.lightingsoft.djapp/files/lr512-gate.log`.

Send from the engine side, in the repository root:

```bash
pnpm spider 192.168.68.101 dimmer=100 red=100      # named channels, see --list
node tools/lr512-send.mjs 192.168.68.101 0 set 6=255 7=255   # raw channels
```

## Known limits

- **The app has to stay in the foreground.** Android freezes background apps,
  which stops the vendor library's keep-alive and the device drops the
  connection. The reconnect recovers once the app is visible again. Running
  with the screen off or behind another app needs a foreground service, which
  is not built yet.
- **Why the device once left is not established.** On 2026-09-29 the log showed
  `onDeviceLeft` some time after opening. Whether the cause was the app being
  backgrounded, an idle timeout or Wi-Fi power saving is unknown.
- **History: the reconnect loop of 2026-09-29.** An earlier build treated 40
  failed sends in a row as a lost device. Frames were being sent to universe 1,
  which has no channels, so every send failed and the bridge reopened a healthy
  device every 13 seconds. Send results no longer influence the connection.
- The bus name in `onDeviceLeft` is unreliable. The vendor wrapper indexes the
  enum by position there.

## Waydroid

`waydroid-setup.sh`, `deploy-bridge.sh` and `waydroid-lan-bridge.sh` set up
Waydroid on a Linux host and install the app. They are untested. Waydroid puts
Android behind NAT, where broadcast discovery cannot reach the LR512, so it
needs the macvlan script and a wired interface. A phone on the Wi-Fi is the
path that is known to work.

## Files

- `src/nl/lightdeck/bridge/BridgeCore.java`: vendor startup, supervisor,
  reconnect, logging.
- `src/nl/lightdeck/bridge/BridgeServer.java`: WebSocket server and DMX pump.
- `src/nl/lightdeck/bridge/OpenGateActivity.java`: the screen with the log.
- `build.sh`: repackaging pipeline.
- `tools/`, `work/`: downloaded tools and build scratch, both ignored by git.
