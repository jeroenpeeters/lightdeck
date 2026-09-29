#!/usr/bin/env bash
#
# Install the LR512 gate APK into a running Waydroid and run it.
#
# The APK auto-runs the gate on launch (scan -> auto-open first DasNet device),
# so no UI taps are needed; the result is read from logcat. Run after
# ./waydroid-setup.sh. Run as your normal user.
#
# Usage: ./deploy-bridge.sh [path-to-apk]   (default: ./bridge-gate.apk)
#
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APK="${1:-$HERE/bridge-gate.apk}"
PKG="com.lightingsoft.djapp"
ACT="nl.lightdeck.bridge.OpenGateActivity"
LOG="$HERE/lr512-gate.logcat.txt"

log(){ printf '\n=== %s\n' "$*"; }
die(){ printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ -f "$APK" ] || die "APK not found: $APK (run ./build.sh first)"
command -v waydroid >/dev/null || die "waydroid not found; run ./waydroid-setup.sh first."
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

waydroid status 2>/dev/null | grep -qi 'Session:.*RUNNING' \
  || die "Waydroid session not running. Run ./waydroid-setup.sh (or: waydroid session start)."

log "installing $APK"
waydroid app install "$APK"

log "clearing logcat and launching the gate"
waydroid logcat -c 2>/dev/null || true
waydroid shell am start -n "$PKG/$ACT" >/dev/null

log "capturing LR512GATE log for 30s -> $LOG"
: > "$LOG"
( waydroid logcat -s LR512GATE >> "$LOG" 2>&1 & echo $! > /tmp/lr512-logcat.pid ) || true
sleep 30
kill "$(cat /tmp/lr512-logcat.pid 2>/dev/null)" 2>/dev/null || true

echo
echo "----- LR512GATE log -----"
cat "$LOG" || true
echo "-------------------------"
if grep -q 'GATE PASSED' "$LOG"; then
  echo ">>> RESULT: PASSED. Record the device type/uid above; proceed to the DMX send path."
elif grep -q 'GATE FAILED' "$LOG"; then
  echo ">>> RESULT: FAILED. See the lastError line above."
elif grep -q 'No device discovered' "$LOG"; then
  echo ">>> RESULT: no device found — almost certainly Waydroid NAT. Run ./waydroid-lan-bridge.sh <wired-iface>, or use a phone / bridged VM."
else
  echo ">>> RESULT: inconclusive. Full log at $LOG; the gate may still be scanning (re-run, or increase the scan window)."
fi
