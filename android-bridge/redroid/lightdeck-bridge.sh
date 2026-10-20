#!/system/bin/sh
# Runs inside the redroid container, as root, after boot. Installs the bridge app and keeps it
# running. Read the output with: docker exec <container> logcat -s LIGHTDECK LR512GATE

PKG=com.lightingsoft.djapp
ACTIVITY=$PKG/nl.lightdeck.bridge.OpenGateActivity
APK=/system/lightdeck/bridge-gate.apk
STAMP=/data/local/lightdeck-installed

say() { /system/bin/log -t LIGHTDECK "$*"; }

until pm path android >/dev/null 2>&1; do sleep 2; done

# Install when the app is missing or the apk is another one than last time. /data survives a
# restart of the container if it is a volume, so the checksum says whether it has to be done.
SUM=$(md5sum "$APK" | cut -d' ' -f1)
if [ "$(cat "$STAMP" 2>/dev/null)" != "$SUM" ] || ! pm path "$PKG" >/dev/null 2>&1; then
  say "installing $APK"
  if ! pm install -r -g "$APK"; then
    # Signed with another key than the installed one: start over.
    say "install failed, removing the old app and trying again"
    pm uninstall "$PKG"
    pm install -g "$APK" || { say "install failed, giving up"; exit 1; }
  fi
  echo "$SUM" > "$STAMP"
fi

# A bridge behind a dark screen must not be put to sleep or kept from the network.
cmd deviceidle whitelist +"$PKG" >/dev/null 2>&1
cmd appops set "$PKG" RUN_ANY_IN_BACKGROUND allow >/dev/null 2>&1
svc power stayon true >/dev/null 2>&1

while true; do
  if ! pidof "$PKG" >/dev/null 2>&1; then
    say "starting $ACTIVITY"
    input keyevent KEYCODE_WAKEUP
    am start -n "$ACTIVITY"
    sleep 20
  fi
  sleep 5
done
