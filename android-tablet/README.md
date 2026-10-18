# Lightdeck tablet app

An Android app that is only a window on the tablet page of lightdeck: one activity, one WebView,
full screen. It exists because Chrome on Android installs a page as an app only on https (or on an
address it was told to trust), and the page of lightdeck is plain `http://<laptop>:8080` on the local
network: the home screen then only gets a shortcut that keeps the bar of the browser. A WebView has
no bar and no such rule.

What the app does:

- Opens `http://<laptop>:8080/tablet` full screen, in landscape or portrait as the tablet is held.
  The bars of Android are hidden and come back for a moment on a swipe from the edge.
- Keeps the screen on while it is open.
- The back key goes back in the page. At the first page it does nothing, so a stray touch cannot
  leave the page.
- When the page cannot be loaded (lightdeck is not running, the address is wrong, no Wi-Fi) a plain
  screen says so, tries again every four seconds by itself, and has keys **Try again** and **Change
  address**. The address is kept on the tablet.
- The page knows it is in the app (`LightdeckTablet/1` in the user agent) and has no Fullscreen key.

It holds no state of its own except the address: what is shown comes from lightdeck, and the page
keeps its own connection.

## Build and install

Needs the JDK (17 or newer), `zip` and the Android SDK (build-tools and a platform), the same as
`../android-bridge/`. No Gradle.

```bash
cd android-tablet
./build.sh                                  # opens http://192.168.68.183:8080/tablet until changed in the app
./build.sh http://192.168.68.50:8080/tablet # or give the address of the laptop
adb install -r lightdeck-tablet.apk         # tablet with USB debugging, or `adb connect <ip>:5555`
```

Without `adb`, copy `lightdeck-tablet.apk` to the tablet and open it (allow installing from that app
when Android asks). The key for signing is made once and kept in `debug.keystore`, so that a new build
installs over the old one; it is not committed. The result is a debug-signed app for your own tablet.

The address of the laptop should not change: give it a fixed address in the router. If it does, **Change
address** in the app is enough, no new build.

## Not verified

The app builds and is a valid, signed APK with the right permissions (internet), plain-http traffic
allowed and a launcher activity. It has not run on a tablet: how the full screen and the swipe feel,
whether the touch targets and the layout fill the tablet, how the page behaves in the WebView of this
tablet (it is the Chrome engine, so the page should work as in Chrome), and the screen of an error.
The page can be looked at from a computer with `chrome://inspect` (debugging of the WebView is on).
