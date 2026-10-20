# The LR512 bridge in a container: redroid (Android in Docker) with bridge-gate.apk installed
# and started by Android's own init, so `docker run` is all it takes.
#
#   cd android-bridge && ./build.sh                       # makes bridge-gate.apk
#   docker build -f redroid/Dockerfile -t lightdeck-bridge .
#
# Run it on a docker host with a wired NIC, with a macvlan network so that the container is on
# the LAN of the LR512 (its discovery is a UDP broadcast): see redroid/README.md.
ARG REDROID_TAG=13.0.0-latest
FROM redroid/redroid:${REDROID_TAG}

# Android's init reads every .rc in /system/etc/init. This one starts the script below once
# the boot has finished.
COPY --chmod=0644 redroid/lightdeck-bridge.rc /system/etc/init/lightdeck-bridge.rc
COPY --chmod=0755 redroid/lightdeck-bridge.sh /system/bin/lightdeck-bridge.sh

# Not under /data: /data is the volume of the container and would hide it.
COPY --chmod=0644 bridge-gate.apk /system/lightdeck/bridge-gate.apk
