#!/usr/bin/env bash
#
# Build the LR512 bridge APK by repackaging the original Light Rider APK.
#
# Why repackage instead of a fresh Gradle app: the native library binds to the
# exact JNI classes `com.lightingsoft.xhl.declaration.Native*`, and the library
# loads its firmware/assets through the Android asset manager. Repackaging keeps
# those vendor classes, the .so, and assets/ byte-identical (apktool round-trips
# the original smali), so a failing open() means the device/licensing refused it,
# not that we broke the bindings.
#
# We only ADD our own classes (nl.lightdeck.bridge.*) and make OpenGateActivity the
# launcher, shown on the phone as "Lightdeck LR512 Bridge". dex2jar is used ONLY to
# give javac a compile classpath; its output is never packaged.
#
# Prerequisites (install yourself):
#   - apktool            (https://apktool.org)               -> `apktool`
#   - JDK 17+            (javac, keytool)
#   - Android SDK build-tools (d8, zipalign, apksigner) and a platform android.jar
#         set ANDROID_SDK_ROOT, or BUILD_TOOLS + ANDROID_JAR directly
# Auto-downloaded into ./tools if missing:
#   - baksmali.jar, dex2jar
#
# Usage:
#   ./build.sh [path-to-apk]           (default: ../lightrider_classic.apk)
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APK="${1:-$HERE/../lightrider_classic.apk}"
WORK="$HERE/work"
TOOLS="$HERE/tools"
OUT="$HERE/bridge-gate.apk"
PKG_DIR="nl/lightdeck/bridge"
ACTIVITY="nl.lightdeck.bridge.OpenGateActivity"
LABEL="Lightdeck LR512 Bridge"

log(){ printf '\n=== %s\n' "$*"; }
die(){ printf 'ERROR: %s\n' "$*" >&2; exit 1; }
need(){ command -v "$1" >/dev/null 2>&1 || die "missing tool: $1 ($2)"; }

[ -f "$APK" ] || die "APK not found: $APK"
need java "JDK"
need javac "JDK"
need keytool "JDK"

# apktool: prefer a recent local jar (the Debian 2.7.0 package mis-handles this APK).
mkdir -p "$TOOLS"
APKTOOL_JAR="${APKTOOL_JAR:-$TOOLS/apktool.jar}"
if [ ! -f "$APKTOOL_JAR" ]; then
  echo "downloading apktool.jar"
  curl -fsSL -o "$APKTOOL_JAR" \
    "https://github.com/iBotPeaches/Apktool/releases/download/v2.11.1/apktool_2.11.1.jar" \
    || die "could not download apktool.jar; set APKTOOL_JAR to a local copy (>= 2.9)."
fi
apktool_cmd(){ java -jar "$APKTOOL_JAR" "$@"; }

# --- locate Android build-tools + android.jar ---
: "${ANDROID_SDK_ROOT:=${ANDROID_HOME:-$HOME/Android/Sdk}}"
if [ -z "${BUILD_TOOLS:-}" ]; then
  BUILD_TOOLS="$(ls -d "$ANDROID_SDK_ROOT"/build-tools/* 2>/dev/null | sort -V | tail -1 || true)"
fi
[ -n "${BUILD_TOOLS:-}" ] && [ -x "$BUILD_TOOLS/d8" ] || die "Android build-tools not found. Set BUILD_TOOLS=/path/to/build-tools/XX.Y.Z (needs d8, zipalign, apksigner)."
if [ -z "${ANDROID_JAR:-}" ]; then
  ANDROID_JAR="$(ls -d "$ANDROID_SDK_ROOT"/platforms/*/android.jar 2>/dev/null | sort -V | tail -1 || true)"
fi
[ -n "${ANDROID_JAR:-}" ] && [ -f "$ANDROID_JAR" ] || die "android.jar not found. Set ANDROID_JAR=/path/to/platforms/android-XX/android.jar."
log "build-tools: $BUILD_TOOLS"
log "android.jar:  $ANDROID_JAR"

# --- baksmali: prefer a system install, else a local jar ---
mkdir -p "$TOOLS"
# baksmali_d <dex> <outdir>
baksmali_d(){
  if [ -n "${BAKSMALI_JAR:-}" ]; then java -jar "$BAKSMALI_JAR" d "$1" -o "$2"
  elif command -v baksmali >/dev/null 2>&1; then baksmali d "$1" -o "$2"
  elif [ -f "$TOOLS/baksmali.jar" ]; then java -jar "$TOOLS/baksmali.jar" d "$1" -o "$2"
  else die "no baksmali found. Install it (apt install baksmali) or set BAKSMALI_JAR=/path/to/baksmali.jar"; fi
}
DEX2JAR="${DEX2JAR:-$TOOLS/dex-tools/d2j-dex2jar.sh}"
if [ ! -x "$DEX2JAR" ]; then
  log "downloading dex2jar"
  curl -fsSL -o "$TOOLS/dex2jar.zip" \
    "https://github.com/pxb1988/dex2jar/releases/download/v2.4/dex-tools-v2.4.zip" \
    || die "could not download dex2jar; set DEX2JAR to a local d2j-dex2jar.sh."
  ( cd "$TOOLS" && rm -rf dex-tools && unzip -q dex2jar.zip && mv dex-tools-* dex-tools )
  chmod +x "$TOOLS"/dex-tools/*.sh
  DEX2JAR="$TOOLS/dex-tools/d2j-dex2jar.sh"
fi

rm -rf "$WORK"; mkdir -p "$WORK"

# --- 1. decode the APK to smali (keeps vendor classes, .so, assets intact) ---
log "1/7 apktool decode (slow, ~68 MB APK)"
apktool_cmd d -f "$APK" -o "$WORK/decoded" >/dev/null

# --- 2. dex2jar the original dex(es) -> compile classpath only ---
log "2/7 dex2jar (compile classpath only, not packaged)"
CP="$ANDROID_JAR"
i=0
# Pull the original dex(es) straight from the APK zip for the compile classpath.
mkdir -p "$WORK/dex"
( cd "$WORK/dex" && unzip -oq "$APK" 'classes*.dex' )
for dex in "$WORK"/dex/classes*.dex; do
  jar="$WORK/xhl-$i.jar"
  "$DEX2JAR" -f -o "$jar" "$dex" >/dev/null 2>&1 || true
  [ -f "$jar" ] && CP="$CP:$jar"
  i=$((i+1))
done
log "compile classpath: $CP"

# --- 3. compile our added classes ---
log "3/7 javac our classes"
mkdir -p "$WORK/classes"
javac -source 8 -target 8 -bootclasspath "$ANDROID_JAR" -cp "$CP" \
  -d "$WORK/classes" $(find "$HERE/src" -name '*.java') \
  || die "javac failed. If it is a signature mismatch against the vendor classes, adjust the source to match the compiler message (the vendor API is the source of truth)."

# --- 4. d8 our class -> a dex, then baksmali -> smali ---
log "4/7 d8 + baksmali our class"
mkdir -p "$WORK/mydex"
CLASSFILES=$(find "$WORK/classes" -name '*.class')
D8CP=""
for j in "$WORK"/xhl-*.jar; do [ -f "$j" ] && D8CP="$D8CP --classpath $j"; done
"$BUILD_TOOLS/d8" --min-api 21 --lib "$ANDROID_JAR" $D8CP --output "$WORK/mydex" $CLASSFILES
baksmali_d "$WORK/mydex/classes.dex" "$WORK/mysmali" >/dev/null

# --- 5. inject our smali as the NEXT contiguous dex dir ---
# ART auto-loads secondary dex only if numbered contiguously (classes.dex,
# classes2.dex, ...). apktool maps smali -> classes.dex, smali_classesN ->
# classesN.dex. So we must use max(existing)+1, not an arbitrary index, or our
# dex is skipped and the class is ClassNotFound at runtime.
log "5/7 inject smali"
maxidx=1
for d in "$WORK/decoded"/smali_classes*; do
  [ -d "$d" ] || continue
  n=${d##*smali_classes}
  case "$n" in ''|*[!0-9]*) continue;; esac
  [ "$n" -gt "$maxidx" ] && maxidx=$n
done
NEXT=$((maxidx + 1))
DEST="$WORK/decoded/smali_classes$NEXT"
echo "  injecting into smali_classes$NEXT (-> classes$NEXT.dex)"
mkdir -p "$DEST/$PKG_DIR"
cp -r "$WORK/mysmali/$PKG_DIR/." "$DEST/$PKG_DIR/"

# --- 6. patch the manifest: add our launcher activity ---
log "6/7 patch AndroidManifest"
python3 - "$WORK/decoded/AndroidManifest.xml" "$ACTIVITY" "$LABEL" <<'PY'
import sys, re
path, activity, label = sys.argv[1], sys.argv[2], sys.argv[3]
xml = open(path, encoding='utf-8').read()

# 0. Ensure WAKE_LOCK permission (the bridge holds a partial wake lock).
if 'android.permission.WAKE_LOCK' not in xml:
    xml = xml.replace('<application', '<uses-permission android:name="android.permission.WAKE_LOCK"/><application', 1)

# 1. Remove EVERY existing LAUNCHER category so the original Light Rider icon(s)
#    no longer appear. The enclosing intent-filter keeps its MAIN action, which
#    without LAUNCHER simply means "not shown in the launcher" — harmless.
before = xml.count('android.intent.category.LAUNCHER')
xml = re.sub(r'\s*<category android:name="android\.intent\.category\.LAUNCHER"\s*/>', '', xml)

# 2. Name the app itself, so Settings and the app list do not say "Light Rider Classic".
xml, named = re.subn(r'(<application\b[^>]*?\sandroid:label=")[^"]*(")',
                     lambda m: m.group(1) + label + m.group(2), xml, count=1)
if not named:
    sys.exit("no android:label on <application>; the manifest is not what this script expects")

# 3. Add our activity as the sole launcher. The dark theme without action bar keeps
#    the screen from flashing white while the app starts.
snippet = (
  '<activity android:name="%s" android:exported="true" '
  'android:label="%s" '
  'android:theme="@android:style/Theme.Material.NoActionBar">'
  '<intent-filter>'
  '<action android:name="android.intent.action.MAIN"/>'
  '<category android:name="android.intent.category.LAUNCHER"/>'
  '</intent-filter>'
  '</activity>' % (activity, label)
)
if activity not in xml:
    xml = xml.replace('</application>', snippet + '</application>', 1)
open(path, 'w', encoding='utf-8').write(xml)
print("  removed %d original launcher entr(y/ies); added '%s' as the sole launcher" % (before, label))
PY

# --- 7. build, align, sign ---
log "7/7 apktool build + zipalign + sign"
apktool_cmd b "$WORK/decoded" -o "$WORK/unsigned.apk" >/dev/null
"$BUILD_TOOLS/zipalign" -f -p 4 "$WORK/unsigned.apk" "$WORK/aligned.apk"

KS="$HERE/tools/debug.keystore"
if [ ! -f "$KS" ]; then
  log "creating debug keystore"
  keytool -genkeypair -keystore "$KS" -storepass android -keypass android \
    -alias androiddebugkey -dname "CN=lightdeck-debug" -keyalg RSA -keysize 2048 -validity 10000 >/dev/null 2>&1
fi
"$BUILD_TOOLS/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --out "$OUT" "$WORK/aligned.apk"

# The phone shows the app only when the APK really carries a launcher entry.
LAUNCHER="$("$BUILD_TOOLS/aapt2" dump badging "$OUT" 2>/dev/null | grep '^launchable-activity' || true)"
case "$LAUNCHER" in
  *"name='$ACTIVITY'"*"label='$LABEL'"*) echo "  launcher entry: $LAUNCHER" ;;
  *) die "the built APK has no launcher entry '$LABEL' for $ACTIVITY (found: ${LAUNCHER:-none})" ;;
esac

log "DONE"
echo "Built: $OUT"
echo
echo "Install and run:"
echo "  adb install -r \"$OUT\""
echo "  adb logcat -c && adb logcat -s LR512GATE"
echo "On the device open '$LABEL'; it starts the bridge by itself"
echo "(scan -> open the first DasNet device). Read the on-screen log or logcat."
echo "Launch from a terminal instead:"
echo "  adb shell am start -n com.lightingsoft.djapp/nl.lightdeck.bridge.OpenGateActivity"
echo "Pull the log file (package is com.lightingsoft.djapp):"
echo "  adb pull /sdcard/Android/data/com.lightingsoft.djapp/files/lr512-gate.log"
