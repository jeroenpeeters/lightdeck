# LR512 protocol findings (from the Light Rider APK)

Analysis of `lightrider_classic.apk` (Light Rider 2, package family
`com.lightingsoft.*`), decompiled 2026-09-25. This supersedes the guesswork in
`HANDOFF.md` §6 for the parts covered below. Tools used: `jadx` on
`classes.dex`, plus `readelf`/`capstone` on the bundled native library.

## TL;DR

- The app does **not** speak a simple "put 512 DMX bytes on the wire" protocol.
  All device I/O goes through Nicolaudie's own hardware abstraction layer,
  **`libXHardwareLibrary.so`** ("XHL"), which is bundled in the APK.
- Live DMX to the modern devices (which the LR512 belongs to) travels over an
  **authenticated, AES-encrypted channel**: an ECC key exchange and a
  salt+challenge login on TCP 2431, after which DMX frames are sent as
  **encrypted datagrams** (opcode 25, `DatagramSendCryptDmx`) on UDP 2430.
- The `Stick_3A` STICK protocol described in `HANDOFF.md` is the **old, simple,
  unencrypted trigger protocol** for stored scenes. It is a different, lesser
  path, not the full live-DMX path. Confirmed: each net device announces itself
  with an 8-byte ASCII id (`Stick_3A`, `Siudi11A`, `Dina__1A`, ...).
- **The single most important finding:** the entire protocol + crypto is
  implemented in `libXHardwareLibrary.so`, which ships as a **native `.so` for
  `arm64-v8a`, `armeabi-v7a`, `x86`, and `x86_64`**, with a thin **JNI** Java
  wrapper. Calling the library directly is almost certainly faster and more
  robust than reimplementing its encrypted protocol from scratch — **but** (see
  below) even the x86_64 build is an **Android** binary, so it needs an Android
  runtime, not a bare Linux host.

## Correction: the x86_64 build is an Android binary, not a Linux one

Checked the linkage of `vendor/xhl/x86_64/libXHardwareLibrary.so`
(`readelf -d` / dynamic symbols):

- `NEEDED`: `liblog.so`, `libandroid.so`, `libz.so`, `libm.so`, `libdl.so`,
  `libc.so`. The `libc.so`/`libm.so` are Android **Bionic**, not glibc
  (glibc would be `libc.so.6`). `libandroid.so` and `liblog.so` are Android
  platform libraries.
- Undefined (imported) symbols include `AAssetManager_fromJava`, `AAsset_open`,
  `AAsset_read`, `AAsset_close`, `__android_log_print`,
  `android_set_abort_message`.

`AAssetManager_fromJava` means the library reads its bundled assets/firmware via
Android's asset manager, handed a Java `AssetManager`. So it **cannot simply be
`dlopen`'d on a normal Linux/glibc server.** To call it directly you need an
Android environment (real device, x86_64 emulator, or Waydroid), or you must
shim the Android platform symbols and load it against Bionic.

## What the app is built on

`classes.dex` is a thin UI over JNI. The real work is in the native library.

- `System.loadLibrary("XHardwareLibrary")` in `XHL.java`.
- Java classes `XHL`, `XHL_Device`, `XHL_DmxUniverse`, `XHL_DmxSecurisedBuffer`,
  and `Native*` (`NativeDmxUniverse.jsendDmx`, etc.) are JNI stubs.
- The live-DMX call chain in the app is literally:

  ```
  device.getInterface_DmxIo().getDmxUniverse(i).sendDmx(XHL_DmxSecurisedBuffer)
     -> NativeDmxUniverse.jsendDmx(ptr, bufferPtr)   // JNI into the .so
  ```

- `XHL_DmxSecurisedBuffer` is a 512-slot byte buffer (`new ...Buffer(512)`), one
  per universe. The app fills channel values with `setValue(chan, val)` and the
  native side ships and encrypts them.

The native library carries its build path in strings:
`/Users/DuarteCosta/Downloads/lsag-soft-xhardwarelibrary-dev/source/...`, so the
C++ source tree layout (class = file) is visible even though the binary is
stripped of debug info.

## Device families and identity

`XHL_Device.XHL_DeviceTypeId` enumerates the whole Nicolaudie line. The ones
that have network ("...Net") and USB ("...Usb") implementations in the .so:
`Stick1B`, `Stick3A`, `Stick5A`, `Siudi7B`, `Siudi10A`, `Siudi11A/B/D`,
`Dina1A`, `Dina2A`.

Each networked device is identified on the wire by an 8-byte ASCII id
(`XHL_..Net::STICKID`), resolved from the binary:

| Device        | 8-byte id  |
|---------------|------------|
| Stick1B       | `Stick_U1` |
| Stick3A       | `Stick_3A` |
| Stick5A       | `Stick_5A` |
| Siudi7B       | `Siudi_7B` |
| Siudi10A      | `SIUDI10A` |
| Siudi11A      | `Siudi11A` |
| Siudi11B      | `Siudi11B` |
| Siudi11D      | `Siudi11D` |
| Dina1A        | `Dina__1A` |
| Dina2A        | `Dina__2A` |

There is a `NetDeviceType` -> `DeviceTypeId` map and a `NetDeviceTypeNames`
table (`ALL, STICK1, STICK3, SIUDI7B, STICK5A, SIUDI10A, DINA1, SIUDI11A,
SIUDI11B, SIUDI11D, DINA2`). The Wi-Fi module is an ESP82xx (`XHL_WifiEsp82xx`,
driven by AT commands; ESP8266 firmware blobs are in `assets/firmware/`).

**Confirmed (2026-09-28):** the physical LR512 reports on the network as
`SIUDI10A 202457`, i.e. internal type **SIUDI10A** (`DeviceTypeId` 57,
net-device-type 5, 8-byte id `SIUDI10A`), serial 202457. It therefore uses
`XHL_Siudi10ANet` and the encrypted `XHL_Siudi10CryptDmxUniverse` DMX path.

## Transport: "DasNet" (network) and "DasUsb" (USB)

- Network devices are driven by `XHL_DasNetDevice` / `XHL_DasNetBus` over
  **UDP 2430** (datagrams, discovery, DMX) and **TCP 2431** (connect, auth,
  config, file ops). This matches the ports in `HANDOFF.md`.
- USB devices are driven by `XHL_DasUsbDevice`. On Android the USB transfer
  class is `XHL_AndroidUsbTransfert` (uses the Java `UsbManager`); the .so also
  contains a generic `XHL_UsbTransfert` with `readVendorRequest`/
  `writeVendorRequest`/bulk endpoints, which is what a desktop/libusb backend
  would use.

## The live-DMX packet (encrypted)

Live DMX for modern devices goes through `XHL_DasNetCryptDmxUniverse::sendDmx`,
which builds a `XHL_DasNetConstant::DatagramSendCryptDmx`. Reconstructed field
layout from the constructor (offsets into the datagram struct):

| Offset | Size | Meaning                                                        |
|-------:|-----:|----------------------------------------------------------------|
| 0x00   | 8    | Header: 8-byte device id (the `STICKID` from the table above)  |
| 0x08   | 2    | OpCode = **25 (0x19)** = `DatagramSendCryptDmx`                 |
| 0x0a   | 8    | Stamp / device stamp (u64)                                     |
| 0x12   | 2    | Universe number (u16)                                          |
| 0x14   | 2    | Length, clamped to 512 (0x200)                                 |
| 0x16   | 1    | flag / mode byte                                               |
| 0x17   | 1    | Sequence counter, incremented on every send                    |
| 0x18   | 8    | (stamp/again)                                                  |
| 0x20   | ~544 | Encrypted block (0x220 bytes), zero-initialised then encrypted |
| 0x40   | 512  | DMX channel data, copied in then encrypted in place            |

The encryption is a virtual call into the device's crypto object
(`vtable+0x18` = `encryptBuffer`). So the 512 DMX bytes never appear in
plaintext on the wire.

The undecrypted header (device id + opcode + stamp + universe + length +
sequence) is in the clear; only the payload block is ciphertext.

## The crypto / auth handshake

Relevant opcodes/classes in `XHL_DasNetConstant` and the crypto tree:

- Handshake / login (TCP 2431): `TcpConnect`, `TcpGetSalt` / `TcpSaltReply`,
  `TcpEccKeyExchange`, `TcpAuthenticate` / `TcpAuthenticateReply`,
  `TcpActivateCrypto`, `TcpGetCryptoState`, and a `TinyTlsHandShake` path.
- Keep-alive: `TcpAlive`, `PingDatagram`.
- Crypto engines: **`XHL_DasEccAesCryptography`** and
  `XHL_DasNetEccAesCryptography` for the modern devices (ECC key agreement +
  AES); `XHL_DasDhRsaCryptography<512u/1024u>` for older ones (Siudi8/9,
  Stick2). AES primitives present: `xhl_aes256_encrypt_cbc`,
  `aes128_*_cbc`/`_ecb`. mbedTLS is bundled (`mbedtls_sha256_*`,
  `Curl_HMAC_SHA256`) and used by the TinyTLS path.
- There is a per-device OTP key (`getOtpKey`, `CapsensSecurityData`,
  `OtpDataDefault`), i.e. the device holds key material; the handshake is not a
  fixed shared secret you can just copy.

**Consequence:** reimplementing the live path from packet captures alone means
reproducing an ECC key exchange, a salted authentication, and AES framing keyed
by device-side material. That is a large, uncertain task by the 7 Nov deadline.

## Recommended path (revised)

Ranked by effort-to-payoff for "full live per-channel DMX from Linux":

1. **Drive `libXHardwareLibrary.so` directly, inside an Android runtime.** The
   library already implements discovery, auth, crypto, and `sendDmx`. Because it
   is an Android binary (Bionic + `libandroid`/`liblog` + asset manager, see the
   correction above), the realistic host is an Android environment, not bare
   Linux:
   - A headless **Android device or x86_64 Android environment** (emulator, or
     **Waydroid** on the Linux host) running a tiny app/service that uses the
     known Java API (`XHL.enumerate()`, `device.open()`,
     `getInterface_DmxIo().getDmxUniverse(i).sendDmx(buffer)`) and exposes DMX
     to the Kubernetes engine over the network. This is the "DMX bridge box"
     shape and reuses the library exactly as the app does.
   - Or **shim the Android symbols** (stub `liblog`, implement `AAssetManager_*`
     against the real filesystem, load against Bionic) to run it on Linux
     directly. Doable but fiddly and easy to get subtly wrong.
   - The USB path uses `XHL_AndroidUsbTransfert` (Android `UsbManager`); the
     **network** (DasNet) path uses plain sockets. Since the LR512 is used over
     Wi-Fi with Daslight, target the DasNet path.
2. **Capture + reimplement** only if calling the library is rejected. Then the
   captures must cover the TCP 2431 handshake (salt, ECC exchange, auth,
   activate-crypto) as well as the UDP 2430 DMX datagrams, and the crypto has to
   be reproduced. High risk.
3. **Art-Net / sACN node fallback**, unchanged from `HANDOFF.md`. Only the
   output adapter changes. Keep this alive with a hard cutoff before the dress
   rehearsal.

The TypeScript engine and normalized fixture model are unaffected: whichever of
the above wins, it sits behind the LR512 output adapter.

## No Linux build of the library exists (checked 2026-09-28)

Nicolaudie publishes the library only for Android (this APK), Windows (the old
`DasHard2006.dll` "SIUDI USB" developer kit, and Daslight 5), macOS (Daslight 5
/ a dylib) and iOS. No Linux `.so`, Linux SDK, or Linux driver is available, and
open-source stacks (OLA, QLC+) do not support these proprietary interfaces. So
there is no shortcut to a native Linux library; the Linux-native options are the
three ranked above (reverse-engineer, run the Android lib under Waydroid, or
Art-Net fallback). The desktop Windows DLL / macOS dylib are useful only as a
cleaner reverse-engineering reference (same protocol, no Android platform
noise), not as something usable under the Linux-only / no-Wine constraint.

## Open items to confirm on hardware

- Which `DeviceTypeId` / 8-byte id the physical LR512 reports (enumerate it).
- Whether Daslight 5 reaches the LR512 over USB or Wi-Fi in Jeroen's setup
  (still unconfirmed; drives which XHL bus we use).
- Whether the x86_64 `.so` loads and enumerates a DasNet device on a plain
  Linux host without Android runtime symbols.
