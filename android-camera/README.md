# Lightdeck camera app

An Android app for the laser survey (`docs/laser-simulator-plan.md`, `pnpm laser-survey`). It shows
the camera and serves a few HTTP requests: lightdeck sets the laser, asks for a photo, and saves the
photo with the bytes it sent. The phone stands beside the laser and looks at the wall.

What the app does:

- Shows the preview (automatic exposure, to aim with) and the address to give to lightdeck, for
  example `http://192.168.68.102:9020`, on the same wifi as the laptop and the LR512.
- Takes a photo or a clip with the exposure, ISO and focus **fixed by hand** to what lightdeck asks
  (default 100 ms, ISO 100, focus at infinity), so that every shot of a survey is comparable. The
  white balance is fixed to daylight. What the camera reports it used goes with each shot.
- Keeps the screen on. The camera is closed when the app goes behind another one; requests then
  get a 503 that says so. Keep it on the screen.

HTTP (port 9020, no login: the home network is trusted):

| Request | Answer |
|---|---|
| `GET /status` | JSON: ready, manual exposure possible, iso, exposure, focus, the ranges the phone accepts, sizes |
| `POST /settings?iso=&exposureMs=&focus=&width=` | sets any of them, answers like `/status` |
| `POST /photo` | a JPEG; the header `x-lightdeck-settings` has what was used |
| `POST /clip?seconds=` | an MP4 (1 to 120 s); the exposure is held to 1/30 s for a clip |

## Build and install

Needs the JDK (17 or newer), `zip` and the Android SDK, the same as `../android-tablet/`. No Gradle.

```bash
cd android-camera
./build.sh
adb install -r lightdeck-camera.apk     # or copy the apk to the phone and open it
```

Allow the camera when the app asks. The key for signing is made once and kept in `debug.keystore`
(not committed).

## Using it

```bash
pnpm laser-survey status --camera 192.168.68.102                    # is the phone reachable, what can it do
pnpm laser-survey shot --camera 192.168.68.102 --bridge 192.168.68.101 --name aim program=pattern:26
pnpm laser-survey pilot --camera 192.168.68.102 --bridge 192.168.68.101 --pattern 26 --distance 3
pnpm laser-survey sweep program --step 1 --camera ... --bridge ... moveH=64 moveV=64
```

`--help` lists everything. Shots go to `docs/laser-photos/` (not in git), a `.jpg` or `.mp4` with a
`.json` next to it that has the ten bytes sent, the camera settings, the distance and a note. A run
that stopped is continued by running the same command again.

## Not verified

It builds and is a valid signed APK. It has **not run on a phone**: the Camera2 code (the manual
exposure, the session for clips, the JPEG orientation, the preview transform) is written from the
API and untested, and a phone without `MANUAL_SENSOR` ignores the exposure (the app and
`pnpm laser-survey` say so). Check the first photos with `shot`, and look at the preview for
orientation, before running a sweep. `.claude/skills/verify-without-hardware/scripts/standin-camera.mjs`
is a stand-in that speaks the same HTTP, for testing the lightdeck side.
