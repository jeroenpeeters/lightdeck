#!/usr/bin/env bash
#
# EXPERIMENTAL: put Waydroid's Android onto the physical LAN so the gate's UDP
# broadcast discovery can reach the LR512. Default Waydroid NAT hides the LAN;
# this reconfigures the container to use a macvlan on a WIRED interface, so
# Android gets its own LAN IP by DHCP and sees and is seen by the LR512.
#
# Constraints and caveats (read before running):
#   - WIRED only. macvlan does not work over Wi-Fi (APs drop the extra MACs).
#   - With macvlan, the HOST cannot talk to the Android container directly (a
#     macvlan limitation); that's fine here because the LR512 traffic is what
#     matters and `waydroid shell/app/logcat` still work over the container API.
#   - Your LAN/DHCP must be willing to hand out an extra lease.
#   - This edits Waydroid's LXC config; a backup is made and --revert restores it.
#
# Usage:
#   ./waydroid-lan-bridge.sh <wired-iface>     # e.g. eth0, enp3s0
#   ./waydroid-lan-bridge.sh --revert
#
set -euo pipefail
CFG=/var/lib/waydroid/lxc/waydroid/config
BAK="$CFG.lightdeck.bak"
die(){ printf 'ERROR: %s\n' "$*" >&2; exit 1; }

command -v sudo >/dev/null || die "sudo required."
[ -f "$CFG" ] || die "Waydroid LXC config not found ($CFG). Run ./waydroid-setup.sh first."

if [ "${1:-}" = "--revert" ]; then
  [ -f "$BAK" ] || die "no backup to revert ($BAK)."
  sudo cp "$BAK" "$CFG"
  echo "Reverted $CFG. Restart the session: waydroid session stop && waydroid session start"
  exit 0
fi

IFACE="${1:-}"
[ -n "$IFACE" ] || die "give the wired interface, e.g. ./waydroid-lan-bridge.sh eth0"
ip link show "$IFACE" >/dev/null 2>&1 || die "interface not found: $IFACE"
case "$(cat /sys/class/net/"$IFACE"/type 2>/dev/null)" in
  1) ;; *) echo "WARNING: $IFACE may not be plain Ethernet; macvlan needs a wired NIC." ;;
esac

[ -f "$BAK" ] || sudo cp "$CFG" "$BAK"

# Append a macvlan NIC bound to the physical interface. Android's DHCP client
# (dhcpcd/ip) will pick up a LAN address on this extra interface.
if grep -q 'lightdeck-macvlan' "$CFG"; then
  echo "macvlan entry already present in $CFG"
else
  sudo tee -a "$CFG" >/dev/null <<EOF

# lightdeck-macvlan: give Android a real LAN IP for DasNet broadcast discovery
lxc.net.1.type = macvlan
lxc.net.1.macvlan.mode = bridge
lxc.net.1.link = $IFACE
lxc.net.1.flags = up
EOF
  echo "Added macvlan on $IFACE to $CFG."
fi

cat <<EOF

Next:
  waydroid session stop 2>/dev/null || true
  waydroid session start
  # then confirm Android has a LAN IP:
  waydroid shell ip addr
  # and re-run the gate:
  ./deploy-bridge.sh

If Android does not get a LAN address, your DHCP may not lease to the macvlan,
or the NIC is wireless. In that case use a physical phone or a bridged VM
(Genymotion / Android-x86) for the gate instead. Revert with:
  ./waydroid-lan-bridge.sh --revert
EOF
