# LR512 / Nicolaudie "DasNet" protocol notes

Source: static analysis of `lightrider_classic.apk` (native `libXHardwareLibrary.so`, Nicolaudie XHL,
plus the thin Java layer). Analysed 2026-09-25/28. Nothing here has been verified against real hardware.

## What the app does

- The Java app only fills a 512-byte buffer per universe and calls `XHL_DmxUniverse.sendDmx()`.
  All framing, discovery and encryption live in the native library.
- Two buses are used: `BT_DasUsb` (Android USB host) and `BT_DasNet` (wifi/LAN).
- The device's wifi module is an ESP8266/ESP8285 driven over AT commands by the interface's MCU.
  The app bundles ESP firmware and MCU firmware for the whole product family.

## Device family and identifiers

D
