#!/usr/bin/env bash
#
# Set up Waydroid (containerised Android) on this Linux host so the LR512 gate
# APK can run. Idempotent: safe to re-run.
#
# Run as your normal user (NOT root); the script uses sudo only for the steps
# that need it. Debian/Ubuntu (apt) assumed for package install.
#
# IMPORTANT networking note: by default Waydroid NATs Android behind its own
# bridge (192.168.240.0/24). The gate finds the LR512 by UDP *broadcast*
# discovery, which does NOT cross that NAT, and the vendor library exposes no
# "connect by IP" on the Java side. So with default networking the gate will
# find no device. To fix, bridge Android onto the LR512's LAN with
# ./waydroid-lan-bridge.sh <wired-iface> (wired only), or run the gate on a
# phone / bridged VM instead. See README.md.
#
set -euo pipefail
log(){ printf '\n=== %s\n' "$*"; }
die(){ printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "Run as your normal user, not root (the script sudo's what it needs)."
command -v sudo >/dev/null || die "sudo is required."
command -v apt-get >/dev/null || die "This script assumes Debian/Ubuntu (apt). Install Waydroid manually otherwise: https://docs.waydro.id"

# --- 1. binder kernel module / binderfs ---
log "1/6 binder"
# On modern kernels binder is exposed via binderfs; the /dev/binder nodes do not
# exist until something mounts it (Waydroid does at startup). So "available"
# means any of: a node exists, the binder filesystem is registered, or the
# module is loaded/loadable.
have_binder(){
  [ -e /dev/binder ] || [ -e /dev/binderfs ] \
    || grep -qw binder /proc/filesystems 2>/dev/null \
    || lsmod 2>/dev/null | grep -qE '^binder' \
    || modinfo binder_linux >/dev/null 2>&1
}
# Try to load it (harmless if built-in or already loaded).
sudo modprobe binder_linux devices=binder,hwbinder,vndbinder 2>/dev/null \
  || sudo modprobe binder_linux 2>/dev/null || true
if have_binder; then
  echo "  binder available (node/binderfs/module present)."
else
  echo "  WARNING: could not positively detect binder. Continuing anyway —"
  echo "  Waydroid mounts binderfs itself and will report clearly if it is truly"
  echo "  missing. If a later step fails on binder, install/load it:"
  echo "    sudo apt-get install -y linux-modules-extra-\$(uname -r)"
  echo "    sudo modprobe binder_linux"
  echo "    grep binder /proc/filesystems   # should list 'binder'"
  echo "  (Kernels without it need the DKMS: https://github.com/choff/anbox-modules)"
fi

# --- 2. install Waydroid ---
log "2/6 install Waydroid"
if ! command -v waydroid >/dev/null; then
  echo "  adding Waydroid apt repo"
  curl -fsSL https://repo.waydro.id | sudo bash
  sudo apt-get install -y waydroid
else
  echo "  waydroid already installed"
fi

# --- 3. headless Wayland compositor (needed by the session on a server) ---
log "3/6 Wayland compositor"
WD_RUNTIME="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export XDG_RUNTIME_DIR="$WD_RUNTIME"
mkdir -p "$XDG_RUNTIME_DIR" 2>/dev/null || true
if [ -n "${WAYLAND_DISPLAY:-}" ] && [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]; then
  echo "  using existing Wayland display: $WAYLAND_DISPLAY"
else
  command -v weston >/dev/null || sudo apt-get install -y weston
  if [ ! -S "$XDG_RUNTIME_DIR/wayland-wd" ]; then
    echo "  starting headless weston (wayland-wd)"
    ( weston --backend=headless-backend.so --socket=wayland-wd --idle-time=0 \
        >/tmp/weston-wd.log 2>&1 & \
      sleep 3; \
      [ -S "$XDG_RUNTIME_DIR/wayland-wd" ] || \
      weston --backend=headless --socket=wayland-wd --idle-time=0 >/tmp/weston-wd.log 2>&1 & ) || true
    sleep 4
  fi
  [ -S "$XDG_RUNTIME_DIR/wayland-wd" ] || die "could not start headless weston; see /tmp/weston-wd.log. On a desktop, just log into a Wayland session and re-run."
  export WAYLAND_DISPLAY=wayland-wd
  echo "  WAYLAND_DISPLAY=wayland-wd"
fi

# --- 4. init Waydroid image (VANILLA = no Google apps; we don't need them) ---
log "4/6 waydroid init (downloads the Android image on first run)"
if [ ! -f /var/lib/waydroid/waydroid.cfg ]; then
  sudo waydroid init -s VANILLA
else
  echo "  already initialised"
fi

# --- 5. container service ---
log "5/6 waydroid-container service"
sudo systemctl enable --now waydroid-container

# --- 6. start the session and wait for Android to finish booting ---
log "6/6 start session + wait for boot"
if ! waydroid status 2>/dev/null | grep -qi 'Session:.*RUNNING'; then
  ( waydroid session start >/tmp/waydroid-session.log 2>&1 & )
fi
echo "  waiting for boot_completed (up to ~120s)..."
for i in $(seq 1 60); do
  if [ "$(waydroid shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
    echo "  Android booted."; break
  fi
  sleep 2
done
waydroid status || true

cat <<EOF

=== Waydroid is up.
Next:
  ./deploy-bridge.sh          # installs bridge-gate.apk, runs the gate, tails logcat

If the gate reports "No device discovered", it is the NAT issue described at the
top of this script. Fix with:
  ./waydroid-lan-bridge.sh <wired-iface>   # e.g. eth0  (wired only)
or run the gate on a physical phone / bridged VM instead.

To see the Android UI (optional): WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-wayland-wd} waydroid show-full-ui
EOF
