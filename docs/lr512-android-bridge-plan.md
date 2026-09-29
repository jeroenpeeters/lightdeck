# LR512 Android-bridge plan

Goal: drive the LR512 with full live per-channel DMX from the Linux homelab, by
reusing Nicolaudie's own `libXHardwareLibrary.so` inside a small Android runtime
instead of reimplementing its encrypted protocol. Background and the protocol
findings are in `lr512-protocol-findings.md`.

## Shape

```
 ┌─────────────────────────┐        UDP DMX frames         ┌──────────────────────────┐        DasNet (UDP 2430 /      ┌────────┐
 │  lightdeck engine        │   universe id + 512 bytes    │  bridge app (Android)      │        TCP 2431, encrypted)    │ LR512  │
 │  (TS, k8s container)     │ ───────────────────────────▶ │  libXHardwareLibrary.so    │ ─────────────────────────────▶ │ + DMX  │
 │  LR512 output adapter    │        ~40 fps, LAN          │  headless Service          │        auth + AES handled       │ fixtures│
 └─────────────────────────┘                              └──────────────────────────┘        by the vendor lib         └────────┘
```

The bridge is deliberately dumb: it does **no show logic**. It receives already
rendered 512-byte universe frames and calls the vendor library's `sendDmx`. All
scenes, effects, crossfades, master and blackout stay in the TypeScript engine.
The LR512's auth handshake and AES framing are done inside the library; the
bridge never touches the crypto.

## Component 1: the Android runtime host

Pick where the library runs. Ranked for a hard deadline:

1. **Dedicated physical Android device (recommended).** An old phone/tablet on
   the LAN running the bridge app, on power. Lowest risk: real Bionic, real
   asset manager, real networking, no kernel modules, no KVM. Decouples the
   fragile Android piece from the k8s engine, which stays a clean container that
   just sends UDP to the device's IP. Jeroen already runs tablets for the UI, so
   one more device is cheap.
2. **Waydroid on the Linux host.** Android in an LXC container. Needs a kernel
   with `binder`/`ashmem` (binder_linux module) and runs privileged; awkward but
   possible inside the homelab. Fits "everything in the cluster" but adds node
   requirements and statefulness that fight `strategy: Recreate` cleanliness.
3. **Android emulator (AVD, x86_64 headless).** Self-contained but needs
   KVM/nested virt and is heavy. `emulator -no-window -no-audio`.

Networking constraint for all three: the runtime must reach the LR512 on the
LAN. DasNet discovery uses UDP broadcast, which often does not cross NAT, so
either **bridge the runtime onto the LR512's L2 segment**, or skip discovery and
**add the device by IP** (the library supports a manual device reference — see
Component 2). A physical device on Wi-Fi is naturally on the right segment.

## Component 2: the bridge app

A minimal Android app that bundles the vendor pieces and adds a headless
entrypoint. Three parts must ship together or the library will not initialise:

- **`libXHardwareLibrary.so`** in `jniLibs/<abi>/` (already extracted to
  `vendor/xhl/`). Include at least the ABI of the chosen runtime (arm64 for a
  phone, x86_64 for an emulator).
- **The `com.lightingsoft.xhl` Java classes**, unchanged and with identical
  fully-qualified names. The `.so` exports `Java_com_lightingsoft_xhl_...` JNI
  entry points, so the `com.lightingsoft.xhl.declaration.Native*` classes and
  their method names/signatures must match exactly. Safest is to **reuse the
  original app's compiled classes** (keep its `classes.dex` / the `xhl`
  package), not recompile the jadx output, so JNI binding cannot drift.
- **The `assets/` payload** from the original APK (firmware blobs, `.ssl2`,
  presets, `xhl_properties.json`, ...). The library loads these via
  `AAssetManager_fromJava`, so the bundled `assets/` must be present; in a real
  Android app the `AssetManager` is provided automatically.

Our own added code is small: an `Application`/`Service` that runs the XHL call
sequence and a socket server. The call sequence, from the decompiled wrapper:

```
XHL x = XHL.libXHW();                       // loads the .so, installs callbacks
// license/profile — see risk #1
x.setSoftware(XHL_SoftwareCode.XHL_SC_LightRider, <key?>, <profile?>);

// avoid broadcast discovery: add the LR512 by IP
BusConfiguration cfg = x.getBusConfiguration(BusType.BT_DasNet);
cfg.addManualDevice(<LR512 ip>, <NetDeviceType>);   // ManualDeviceReference
x.enableBus(BusType.BT_DasNet);
x.enumerate();

// CallBackHotPlug.onDeviceArrival(device, supportState, busType, name, desc)
device.open();                              // wait for DeviceState.DSOpen
int n = device.getInterface_DmxIo().getUniversesCount();
XHL_DmxSecurisedBuffer[] buf = new XHL_DmxSecurisedBuffer[n]; // (512) each

// per incoming frame from the engine:
for (changed ch) buf[u].setValue(ch, value);
device.getInterface_DmxIo().getDmxUniverse(u).sendDmx(buf[u]);
```

Rate-limit sends to ~40 fps per universe. The bridge should re-open on device
drop (`onDeviceLeft`) and surface state so the engine can show an output
indicator.

## Component 3: engine ↔ bridge link

Keep it minimal and match the DMX framerate:

- **Transport:** raw UDP on the LAN. One datagram = 1-byte universe id + 512
  DMX bytes. Simple, lossy-tolerant (next frame supersedes), ~40 fps.
- The engine's **LR512 output adapter** emits these frames; the normalized
  fixture model and the rest of the engine are unchanged. Swapping to Art-Net
  later means swapping only this adapter, exactly as planned.
- Optional: a tiny status/heartbeat back from the bridge (device open? frames
  accepted?) on a second UDP port or the same socket.

## STATUS: gate PASSED (2026-09-28)

The open() gate passed on a Pixel 9 Pro: the vendor lib in the repackaged APK
discovered and opened the LR512 (uid DAS:SIUDI10A:202457, 2 DMX universes,
`[XHL] Success`) with no licensing refusal. The registration sequence
(setSoftware + initializeSushi + addCallBackHotPlug, then enumerateAsync) was
the fix. Next step is Component 3 below: the DMX send service + engine link.

## De-risking order (test the killers first)

1. **Licensing gate (biggest unknown).** Build the bridge, install it, and just
   try to `open()` the LR512. The app has license/activation logic
   (`XHL_SC_LightRider`, `setSoftware`, a "activate your interface" flow,
   Sushi `getLicenseType`). If the library refuses to open or to `sendDmx`
   without a valid/activated software profile, this whole route is blocked and
   we fall back to reverse-engineering or Art-Net. **Test this on day one.**
   A ready-to-build harness for exactly this test is in `../android-bridge/`
   (`OpenGateActivity` + `build.sh`); see its `README.md`. **Nothing past this
   gate is built until it passes.**
2. **Library loads headless.** Confirm no missing Android symbol and that the
   bundled `assets/` satisfy the asset manager (watch logcat for XHL init).
3. **Enumerate + open by IP.** Confirm `onDeviceArrival` fires for the LR512 and
   it reaches `DSOpen`. Determine its `NetDeviceType`/8-byte id here.
4. **One channel moves.** Static frame → one spider channel moves. This is
   `HANDOFF.md` milestone 1.
5. **40 fps stable.** Stream a moving effect, confirm no mesh/stream stalls,
   measure end-to-end latency (engine → bridge → fixture).
6. **Wire the engine adapter.** Point the LR512 output adapter at the bridge.

## Open questions to resolve while building

- Which `NetDeviceType` the physical LR512 reports: CONFIRMED (2026-09-28) =
  **SIUDI10A** (net-device-type 5, `DeviceTypeId` 57, 8-byte id `SIUDI10A`);
  network name `SIUDI10A 202457`. Note: there is no Java-side "add device by
  IP"; the gate relies on broadcast discovery, so the Android runtime must be on
  the LR512's LAN.
- Exact `setSoftware(...)` arguments and whether any license key/activation is
  required (step 1).
- Whether `open()` needs credentials (`device.setCredential(...)` exists) — i.e.
  a device password. The LR512 AP has a sticker password; a station-mode device
  may or may not require one for control.
- Runtime networking: bridged vs manual-IP, and whether TLS is forced
  (`setForceTls`, `getUsedTcpPort` seen in the bus config).

## Legal note

This reuses the vendor's own library to interoperate with Jeroen's own hardware,
on the LAN, for personal use. In the EU, reverse-engineering / interoperability
for one's own devices is generally permitted; this route does not even decode
the protocol, it calls the vendor code as shipped.
