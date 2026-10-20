#!/usr/bin/env bash
#
# Build the camera app of the laser survey: a preview and an HTTP server that takes a photo or
# films a clip when lightdeck asks (`pnpm laser-survey`).
#
# No Gradle: javac against the platform android.jar, d8, aapt2, zipalign and apksigner, the same
# tools that android-tablet/build.sh uses. The result is android-camera/lightdeck-camera.apk.
#
# Prerequisites: JDK 17+ (javac, keytool), `zip`, and the Android SDK with build-tools and a
# platform (ANDROID_SDK_ROOT, default ~/Android/Sdk; or BUILD_TOOLS and ANDROID_JAR directly).
#
# Usage:  ./build.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/lightdeck-camera.apk"
BUILD="$HERE/build"

log(){ printf '\n=== %s\n' "$*"; }
die(){ printf 'ERROR: %s\n' "$*" >&2; exit 1; }
need(){ command -v "$1" >/dev/null 2>&1 || die "missing tool: $1 ($2)"; }
need javac "JDK 17 or newer"
need keytool "JDK"
need zip "apt install zip"

: "${ANDROID_SDK_ROOT:=${ANDROID_HOME:-$HOME/Android/Sdk}}"
if [ -z "${BUILD_TOOLS:-}" ]; then
  BUILD_TOOLS="$(ls -d "$ANDROID_SDK_ROOT"/build-tools/* 2>/dev/null | sort -V | tail -1 || true)"
fi
[ -n "${BUILD_TOOLS:-}" ] && [ -x "$BUILD_TOOLS/d8" ] || die "Android build-tools not found. Set BUILD_TOOLS=/path/to/build-tools/XX.Y.Z."
if [ -z "${ANDROID_JAR:-}" ]; then
  ANDROID_JAR="$(ls -d "$ANDROID_SDK_ROOT"/platforms/*/android.jar 2>/dev/null | sort -V | tail -1 || true)"
fi
[ -n "${ANDROID_JAR:-}" ] && [ -f "$ANDROID_JAR" ] || die "android.jar not found. Set ANDROID_JAR=/path/to/platforms/android-XX/android.jar."
log "build-tools: $BUILD_TOOLS"
log "android.jar: $ANDROID_JAR"

rm -rf "$BUILD"; mkdir -p "$BUILD/classes" "$BUILD/dex" "$BUILD/res-flat"

log "1/5 resources"
"$BUILD_TOOLS/aapt2" compile --dir "$HERE/res" -o "$BUILD/res-flat" >/dev/null
"$BUILD_TOOLS/aapt2" link -o "$BUILD/base.apk" -I "$ANDROID_JAR" \
  --manifest "$HERE/AndroidManifest.xml" \
  --min-sdk-version 24 --target-sdk-version 34 --version-code 1 --version-name 1.0 \
  "$BUILD"/res-flat/*.flat

log "2/5 javac"
javac -Xlint:-options --release 8 -classpath "$ANDROID_JAR" -d "$BUILD/classes" \
  "$HERE"/src/nl/lightdeck/camera/*.java

log "3/5 d8"
"$BUILD_TOOLS/d8" --min-api 24 --lib "$ANDROID_JAR" --output "$BUILD/dex" \
  $(find "$BUILD/classes" -name '*.class')
( cd "$BUILD/dex" && zip -q "$BUILD/base.apk" classes.dex )

log "4/5 zipalign"
"$BUILD_TOOLS/zipalign" -f -p 4 "$BUILD/base.apk" "$BUILD/aligned.apk"

log "5/5 sign"
KS="$HERE/debug.keystore"
if [ ! -f "$KS" ]; then
  log "creating a debug keystore (kept, so that an update installs over the old app)"
  keytool -genkeypair -keystore "$KS" -storepass android -keypass android \
    -alias lightdeck -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Lightdeck camera" >/dev/null 2>&1
fi
"$BUILD_TOOLS/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --out "$OUT" "$BUILD/aligned.apk"
"$BUILD_TOOLS/apksigner" verify "$OUT"

log "done: $OUT"
echo "Install it:  adb install -r $OUT"
