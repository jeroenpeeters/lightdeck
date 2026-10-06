---
name: lr512-bridge
description: Diagnose and change the path from lightdeck to the LR512, which is the Android bridge app in `android-bridge/`, Nicolaudie's vendor library, and the client in `src/outputs/lr512/`. Use this whenever Jeroen reports that the lights do not react, the bridge or the LR512 shows as not connected, the connection drops or keeps reconnecting, frames fail, the phone app misbehaves, or the APK will not build or install, and for any change to the bridge's Java code, its build, or the wire protocol. Use it before forming a theory about how the LR512 or the vendor library behaves.
---

# The LR512 and its bridge

```
lightdeck ──WebSocket :9010──▶ bridge app on the phone ──vendor library──▶ LR512 ──DMX──▶
```

The LR512 speaks an encrypted protocol that lives in Nicolaudie's native library. That
library exists for Android only, so it runs in an Android app that lightdeck talks to.
The facts that were found are in `CLAUDE.md` under "The LR512 protocol is the main
risk", in `android-bridge/README.md` and in `docs/lr512-protocol-findings.md`. Read
those first. This skill is how to work on this path without repeating what went wrong.

## Look it up, do not guess

The one rule that matters most. The vendor library is closed, and it is tempting to
explain a symptom with a plausible story and build on it. That was done once: "40 failed
sends in a row means the device is gone". The sends failed because they went to a
universe without channels, and the bridge reopened a healthy device every 13 seconds.
The answer was in the vendor's code the whole time.

`android-bridge/tools/re/` (not in git, on Jeroen's machine) has what is needed:

- `java-src/`: the Light Rider app decompiled with jadx. This is how the original app
  uses the library: what it calls, in what order, on which thread, and which return
  values it ignores. When the bridge has to do something, do it the way the original
  does.
- `xdis.py <symbol or 0xaddress> [max]`: annotated arm64 disassembly of one function of
  the library. Run it from that directory, with its `venv`. `syms.txt` and `dem.txt`
  list the functions by name. This is where to find why a call returns false.

Say in the answer what the code shows and what is still a guess. A reading of
disassembly is evidence about the library, not about Jeroen's device: what the device
answers is in the log of the bridge.

What is out of bounds: the limit on channels is a licence of the vendor. Finding out
that it exists and where it comes from explained a bug. Working around it is not what
this project does.

## Diagnosing "the lights do not react"

Go from lightdeck outwards, and ask for evidence at each step before moving on. Most of
it Jeroen has to read off for you, so ask for the exact thing.

1. **What do the lamps in the status bar say?** "Bridge" is lightdeck's connection to the
   app, "LR512" is what the app says about the device. The notice under it says what
   lightdeck thinks is wrong.
2. **Bridge not connected**: is the app open and on screen, is the address the one the
   app shows, are the laptop and the phone on the same network?
3. **LR512 not found**: does the device have power and Wi-Fi, and is the phone on the
   same Wi-Fi? Discovery is a UDP broadcast; the library has no way to connect by
   address.
4. **Both green, nothing happens**: which universe and address? Only universe index 0
   has channels. Is the fixture at the address lightdeck uses, and in the channel mode
   of the profile? Does the readout on the fixture page show bytes going out?
5. **Ask for the log of the bridge**: on the screen of the app, with
   `adb logcat -s LR512GATE`, or the file the README names. The lines to look for are in
   `android-bridge/README.md`: the device being opened, the channels per universe, the
   ports set to output, counts of frames received, sent and failed.
6. **Take lightdeck out of it**: `node tools/lr512-send.mjs <phone-ip> 0 set 6=255 7=255`
   sends raw channels. If that works, the problem is in lightdeck; if not, in the bridge
   or beyond.

Things that look like a fault and are not:

- A `sendDmx` that returns false. The original app ignores it. The library closes the
  device itself when the network fails: watch the state of the device.
- Universe 1 reporting 0 channels. That is the licence of an LR512.
- A drop while the app was in the background. Android freezes it, and the library's
  keep-alive stops. There is no foreground service yet.

## Changing the bridge

- **Mirror the original app.** Registration before the scan, no scan while one runs or
  while a device is open, open after the scan has finished, ports to output before
  sending. Each of these was missing once and cost a day.
- **The WebSocket does not depend on the device.** Lightdeck stays connected while the
  LR512 is away, and the bridge replays the last frame when it is back.
- **The bridge holds the last frame.** That keeps the lights on through a hiccup, and
  it keeps a laser on when lightdeck crashes. Any change here is a safety decision: ask
  Jeroen.
- **The wire protocol has two ends**: `BridgeServer.java` and
  `src/outputs/lr512/bridgeClient.ts`, and the stand-in in the skill
  `verify-without-hardware`. Change them together.
- **The build** is `android-bridge/build.sh` and needs the Light Rider APK, which is not
  in the repository. Its requirements and its three pitfalls (the dex numbering, the
  launcher entry, the versions of the tools) are in the README there.

## Verifying

The Java side has no tests and cannot run without the phone and the device. So: build
it, say that it builds, and say that it has not run. Then give Jeroen what to install,
what to do, and which lines of the log to send back. The client side has tests and runs
against the stand-in bridge.

Write what was found into `CLAUDE.md` when it is a fact about the device or the library
that cost time to find. That list is why the same mistake has not been made twice.
